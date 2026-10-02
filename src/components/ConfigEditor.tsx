import { useState, useRef, useEffect, useCallback, useMemo, useDeferredValue } from 'react';
import Editor, { DiffEditor, OnMount } from '@monaco-editor/react';
import ConfigArchive from './ConfigArchive';
import ProblemsPanel from './ProblemsPanel';
import FolderPane from './FolderPane';
import EditorStatusBar from './EditorStatusBar';
import { copyText } from '../utils/clipboard';
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  X,
  Copy,
  Send,
  ChevronDown,
  FolderOpen,
  Download,
  BookOpen,
  FileX,
  Code2,
  Eraser,
  DownloadCloud,
  GitCompare,
  History,
  ListTree,
  AlertTriangle,
  Plus,
  RefreshCw,
  Square,
  XCircle,
  Info,
  EyeOff,
  Sparkles,
  FolderTree,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { useEditorInbox } from '../store/editorInboxStore';
import { sleep, stripAnsi as stripAnsiUtil, hasAnsi, sendAndCapture } from '../utils/terminal';
import { useSidePanelStore } from '../store/sidePanelStore';
import { askConfirm, askPrompt } from '../store/dialogStore';
import { generateId } from '../utils';
import { profileForSession } from '../utils/deviceProfiles';
import { setupMonaco } from '../editor/setup';
import { detectConfigLanguage, wordSeparatorsFor } from '../editor/networkLanguages';
import { CONFIG_SNIPPETS, toMonacoSnippet } from '../editor/snippets';
import {
  MAX_PROBLEMS,
  NETWORK_LANGUAGES,
  buildProblems,
  problemSummary,
  rejectedLineProblem,
  sendProblemNote,
  type ConfigProblem,
} from '../utils/configProblems';
import { vendorMismatch } from '../utils/editorStatus';
import { tabLabel } from '../utils/tabs';
import { SEND_MARK_TEXT, sendMarkCounts, sendMarkSummary, sendMarks, type SendMark, type SendMarkState } from '../utils/sendMarks';
import { linesInSpan, selectedLines, spanText, type LineSpan } from '../utils/sendSelection';
import { jobBlockFromEditor, vendorSteps } from '../utils/changeJobs';
import { askMenu, buildAskPrompt, secretLinePairs, type AskKind } from '../utils/askAi';
import { hideSecretsForCopy, hideSecretsInText } from '../utils/secrets/forCopy';
import { useAiBridge } from '../store/aiBridgeStore';
import { fenceDeviceLanguage, isOtherVendor, locateTarget, restoreSecrets, withSuggestion } from '../utils/aiReview';
import { showSidePanel } from './sidePanelActions';
import { timeAgo } from '../store/recentStore';
import { useTheme } from '../hooks/useTheme';
import { isTauri, tauriOpen, tauriOpenFolder, tauriListFolder, tauriSave, tauriReadText, tauriWriteText, browserOpen, browserSave } from '../utils/fileSystem';
import { cannotOpen, joinPath, relativeTo, type FolderEntry, type FolderListing } from '../utils/folderTree';
import {
  prepareSendLines,
  runConfigSend,
  watchSessionOutput,
  describeSendBaseline,
  deviceKey,
  type Baseline,
} from '../utils/configSafety';

// Strip terminal/ANSI control sequences so captured logs (PuTTY/`show tech`,
// shared utils
const stripTerminalSequences = stripAnsiUtil;
const looksLikeTerminalCapture = hasAnsi;

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
}

// ─── Editor buffers (tabs) ───

interface EditorBuffer {
  id: string;
  name: string;
  content: string;
  language: string;
  filePath: string | null;
  dirty: boolean;
  /** True once the user picked a language by hand — suppresses auto-detect. */
  langExplicit: boolean;
}

function makeBuffer(name: string, overrides: Partial<EditorBuffer> = {}): EditorBuffer {
  return {
    id: generateId(),
    name,
    content: '',
    language: 'plaintext',
    filePath: null,
    dirty: false,
    langExplicit: false,
    ...overrides,
  };
}

// "untitled", then "untitled 2", … skipping names already taken by open tabs.
function untitledName(buffers: EditorBuffer[]): string {
  const names = new Set(buffers.map((b) => b.name));
  if (!names.has('untitled')) return 'untitled';
  let n = 2;
  while (names.has(`untitled ${n}`)) n += 1;
  return `untitled ${n}`;
}

// ─── Language detection ───

const EXT_TO_LANG: Record<string, string> = {
  // Aruba / network
  cfg: 'aruba-cx', conf: 'aruba-cx', cli: 'aruba-cx', arubaconfig: 'aruba-cx',
  // Web
  js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  jsx: 'javascript',
  ts: 'typescript', tsx: 'typescript',
  html: 'html', htm: 'html',
  css: 'css', scss: 'scss', less: 'less',
  // Data / config
  json: 'json', jsonc: 'json',
  yaml: 'yaml', yml: 'yaml',
  xml: 'xml', svg: 'xml', xhtml: 'xml',
  toml: 'ini', ini: 'ini',
  // Scripts
  sh: 'shell', bash: 'shell', zsh: 'shell', fish: 'shell',
  ps1: 'powershell', psm1: 'powershell',
  py: 'python', pyw: 'python',
  rb: 'ruby',
  pl: 'perl', pm: 'perl',
  php: 'php',
  lua: 'lua',
  tcl: 'tcl',
  // Systems / compiled
  rs: 'rust',
  go: 'go',
  java: 'java',
  cs: 'csharp',
  cpp: 'cpp', cc: 'cpp', cxx: 'cpp',
  c: 'c',
  h: 'cpp', hpp: 'cpp',
  swift: 'swift',
  kt: 'kotlin', kts: 'kotlin',
  scala: 'scala',
  // Markup / docs
  md: 'markdown', mdx: 'markdown',
  rst: 'restructuredtext',
  tex: 'latex',
  // DB / query
  sql: 'sql', pgsql: 'pgsql', mysql: 'mysql',
  // Infrastructure
  dockerfile: 'dockerfile',
  tf: 'hcl', hcl: 'hcl',
  proto: 'proto',
  // Misc
  r: 'r', R: 'r',
  log: 'plaintext', txt: 'plaintext', text: 'plaintext',
  csv: 'plaintext', tsv: 'plaintext',
};

function detectLanguage(filePath: string): string {
  const name = basename(filePath).toLowerCase();
  // Special filenames
  if (name === 'dockerfile') return 'dockerfile';
  if (name === 'makefile' || name === 'gnumakefile') return 'makefile';
  if (name === '.env' || name.startsWith('.env.')) return 'ini';
  if (name === 'gemfile' || name === 'rakefile') return 'ruby';
  if (name === 'cmakelists.txt') return 'cmake';
  // Extension
  const ext = name.split('.').pop() || '';
  return EXT_TO_LANG[ext] || 'plaintext';
}

// ─── Language list for picker ───

/** localStorage: the folder the folder view showed last. */
const FOLDER_KEY = 'greencli.editor.folder';

const LANGUAGE_LIST = [
  { id: 'aruba-cx',         label: 'Aruba CX' },
  { id: 'aruba-aos-s',      label: 'Aruba AOS-S' },
  { id: 'aruba-ap',         label: 'Aruba AP' },
  { id: 'aruba-controller', label: 'Aruba AOS 8 / Controller' },
  { id: 'juniper-junos',    label: 'Juniper Junos' },
  { id: 'mist',             label: 'Juniper Mist / Junos' },
  { id: 'generic',          label: 'Normal Device' },
  { id: 'plaintext',        label: 'Plain Text' },
  { id: 'shell',            label: 'Shell / Bash' },
  { id: 'python',           label: 'Python' },
  { id: 'javascript',       label: 'JavaScript' },
  { id: 'typescript',       label: 'TypeScript' },
  { id: 'json',             label: 'JSON' },
  { id: 'yaml',             label: 'YAML' },
  { id: 'xml',              label: 'XML' },
  { id: 'html',             label: 'HTML' },
  { id: 'css',              label: 'CSS' },
  { id: 'markdown',         label: 'Markdown' },
  { id: 'sql',              label: 'SQL' },
  { id: 'rust',             label: 'Rust' },
  { id: 'go',               label: 'Go' },
  { id: 'java',             label: 'Java' },
  { id: 'cpp',              label: 'C / C++' },
  { id: 'csharp',           label: 'C#' },
  { id: 'php',              label: 'PHP' },
  { id: 'ruby',             label: 'Ruby' },
  { id: 'swift',            label: 'Swift' },
  { id: 'kotlin',           label: 'Kotlin' },
  { id: 'powershell',       label: 'PowerShell' },
  { id: 'dockerfile',       label: 'Dockerfile' },
  { id: 'hcl',              label: 'HCL / Terraform' },
  { id: 'ini',              label: 'INI / TOML / .env' },
  { id: 'proto',            label: 'Protobuf' },
];

// ─── Config templates (multi-vendor: Aruba AOS-CX + Juniper Junos) ───

const TEMPLATES: Record<string, string> = {
  'Aruba: VLANs': `! VLAN Configuration
configure terminal
vlan 10
  name MGMT
vlan 20
  name USERS
vlan 30
  name GUEST
vlan 100
  name VOICE
end
! Save once it looks right: write memory
`,
  'Aruba: Trunk port': `! Uplink trunk port
configure terminal
interface 1/1/1
  no shutdown
  description Uplink-Core
  vlan trunk native 10
  vlan trunk allowed 10,20,30,100
end
! Save once it looks right: write memory
`,
  'Aruba: Access port': `! Access port (users)
configure terminal
interface 1/1/3-1/1/48
  no shutdown
  vlan access 20
end
! Save once it looks right: write memory
`,
  'Aruba: BGP peer': `! BGP configuration
configure terminal
router bgp 65001
  bgp router-id 10.0.0.1
  neighbor 10.0.0.2 remote-as 65002
  neighbor 10.0.0.2 description Core-Peer
  address-family ipv4 unicast
    neighbor 10.0.0.2 activate
end
! Save once it looks right: write memory
`,
  'Aruba: OSPF': `! OSPF configuration
configure terminal
router ospf 1
  router-id 10.0.0.1
  area 0.0.0.0
interface vlan 10
  ip ospf 1 area 0.0.0.0
  ip ospf network point-to-point
end
! Save once it looks right: write memory
`,
  'Aruba: AAA / RADIUS': `! RADIUS / AAA
configure terminal
radius-server host 10.0.0.100
  key plaintext MySecret123
  authentication port 1812
  accounting port 1813
aaa authentication login default group radius local
aaa authorization commands default group radius local
end
! Save once it looks right: write memory
`,
  'AOS-S: VLAN + tagged uplink': `! Aruba AOS-S / ProVision
configure terminal
vlan 10
   name "MGMT"
   tagged 1
   ip address 10.0.10.2 255.255.255.0
   exit
vlan 20
   name "USERS"
   tagged 1
   untagged 3-48
   exit
write memory
`,
  'Aruba AP: WLAN basics': `! Aruba Instant AP / VC
configure terminal
wlan ssid-profile Example-SSID
  enable
  essid Example-SSID
  opmode wpa2-psk-aes
  wpa-passphrase <replace-me>
exit
commit apply
`,
  'AOS8: AP group WLAN': `! ArubaOS 8 Controller / Conductor
configure terminal
wlan ssid-profile Example-SSID
  essid Example-SSID
  opmode wpa2-psk-aes
exit
wlan virtual-ap Example-VAP
  ssid-profile Example-SSID
exit
write memory
`,
  'Junos: VLANs': `/* Juniper Junos — VLANs (set-style) */
configure
set vlans MGMT vlan-id 10
set vlans USERS vlan-id 20
set vlans GUEST vlan-id 30
set vlans VOICE vlan-id 100
/* Review with: show | compare — then apply with: commit confirmed 5 */
`,
  'Junos: Trunk port': `/* Junos — trunk uplink */
configure
set interfaces ge-0/0/0 description Uplink-Core
set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode trunk
set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members [ MGMT USERS GUEST VOICE ]
set interfaces ge-0/0/0 native-vlan-id 10
/* Review with: show | compare — then apply with: commit confirmed 5 */
`,
  'Junos: Access port': `/* Junos — access port */
configure
set interfaces ge-0/0/3 unit 0 family ethernet-switching interface-mode access
set interfaces ge-0/0/3 unit 0 family ethernet-switching vlan members USERS
/* Review with: show | compare — then apply with: commit confirmed 5 */
`,
  'Junos: BGP peer': `/* Junos — BGP */
configure
set routing-options autonomous-system 65001
set protocols bgp group EBGP type external
set protocols bgp group EBGP neighbor 10.0.0.2 peer-as 65002
set protocols bgp group EBGP neighbor 10.0.0.2 description Core-Peer
/* Review with: show | compare — then apply with: commit confirmed 5 */
`,
  'Junos: OSPF': `/* Junos — OSPF */
configure
set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 interface-type p2p
set protocols ospf area 0.0.0.0 interface irb.10
/* Review with: show | compare — then apply with: commit confirmed 5 */
`,
  'Mist/Junos: access switch baseline': `/* Mist-managed Junos switch baseline */
configure
set system host-name <switch-name>
set system services ssh
set vlans USERS vlan-id 20
set interfaces ge-0/0/3 unit 0 family ethernet-switching interface-mode access
set interfaces ge-0/0/3 unit 0 family ethernet-switching vlan members USERS
commit confirmed 5 comment "GreenCLI staged access baseline"
`,

  // ─── Juniper Validated Design starters (Junos) — edit ids/addresses ───
  'JVD: EVPN-VXLAN leaf (ERB)': `/* JVD EVPN-VXLAN — leaf (edge-routed bridging). Replace ASNs/IPs/VNIs. */
configure
set chassis aggregated-devices ethernet device-count 2
set interfaces lo0 unit 0 family inet address 10.1.1.1/32
/* Underlay: eBGP to spines */
set protocols bgp group UNDERLAY type external
set protocols bgp group UNDERLAY local-as 65001
set protocols bgp group UNDERLAY family inet unicast
set protocols bgp group UNDERLAY export LO0
set protocols bgp group UNDERLAY neighbor 10.0.0.0 peer-as 65000
/* Overlay: eBGP EVPN to spines (loopback) */
set protocols bgp group OVERLAY type external
set protocols bgp group OVERLAY multihop ttl 2
set protocols bgp group OVERLAY local-address 10.1.1.1
set protocols bgp group OVERLAY family evpn signaling
set protocols bgp group OVERLAY neighbor 10.2.2.2 peer-as 65000
/* EVPN-VXLAN */
set protocols evpn encapsulation vxlan
set protocols evpn default-gateway no-gateway-community
set switch-options vtep-source-interface lo0.0
set switch-options route-distinguisher 10.1.1.1:1
set switch-options vrf-target target:65000:1
set vlans V100 vlan-id 100
set vlans V100 vxlan vni 10100
/* Review with: show | compare — then apply with: commit confirmed 5 */
`,

  'JVD: EVPN-VXLAN spine (route-reflector)': `/* JVD EVPN-VXLAN — spine (underlay + EVPN route-reflector). */
configure
set interfaces lo0 unit 0 family inet address 10.2.2.2/32
set protocols bgp group UNDERLAY type external
set protocols bgp group UNDERLAY local-as 65000
set protocols bgp group UNDERLAY family inet unicast
set protocols bgp group UNDERLAY neighbor 10.0.0.1 peer-as 65001
set protocols bgp group OVERLAY type external
set protocols bgp group OVERLAY multihop ttl 2
set protocols bgp group OVERLAY local-address 10.2.2.2
set protocols bgp group OVERLAY family evpn signaling
set protocols bgp group OVERLAY cluster 10.2.2.2
set protocols bgp group OVERLAY neighbor 10.1.1.1 peer-as 65001
/* Review with: show | compare — then apply with: commit confirmed 5 */
`,

  'JVD: AI fabric RoCE QoS (PFC+ECN)': `/* JVD AI/GPU fabric — lossless RoCEv2: PFC on priority 3, ECN marking. */
configure
set class-of-service classifiers dscp ROCE forwarding-class NO-LOSS loss-priority low code-points 011010
set class-of-service forwarding-classes class NO-LOSS queue-num 3 no-loss
set class-of-service congestion-notification-profile ECN input ieee-802.1 code-point 011 pfc
set class-of-service interfaces et-0/0/0 congestion-notification-profile ECN
set class-of-service interfaces et-0/0/0 unit 0 classifiers dscp ROCE
set class-of-service drop-profiles ECN-DP interpolate fill-level 30 drop-probability 0
set class-of-service drop-profiles ECN-DP interpolate fill-level 100 drop-probability 100
set class-of-service forwarding-classes class NO-LOSS explicit-congestion-notification
/* Review with: show | compare — then apply with: commit confirmed 5 */
`,

  'JVD: EVPN campus access (EX)': `/* JVD EVPN campus — access switch VLAN/VNI + uplink. */
configure
set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode access vlan members V100
set interfaces ae0 unit 0 family ethernet-switching interface-mode trunk vlan members all
set vlans V100 vlan-id 100
set vlans V100 vxlan vni 10100
set switch-options vtep-source-interface lo0.0
set protocols evpn encapsulation vxlan
set protocols evpn extended-vni-list all
/* Review with: show | compare — then apply with: commit confirmed 5 */
`,
};

// ─── Pull menu (per device type) ───

// Per-vendor paging control + running-config command. AOS-CX/AOS-S use
// `no page` (NOT `no paging`); ArubaOS controllers use `no paging`; Junos
// pipes `| no-more`. Paging is restored afterward so the live session
// isn't left changed.
const VENDOR_PAGING: Record<string, { disable?: string; restore?: string; show: string }> = {
  'aruba-cx': { disable: 'no page', restore: 'page', show: 'show running-config' },
  'aruba-aos-s': { disable: 'no page', restore: 'page', show: 'show running-config' },
  'aruba-controller': { disable: 'no paging', restore: 'paging', show: 'show running-config' },
  'aruba-ap': { show: 'show running-config' },
  'juniper-junos': { show: 'show configuration | no-more' },
  mist: { show: 'show configuration | no-more' },
  generic: { show: 'show running-config' },
};

// `command: null` = the vendor's running-config pull (the split button's default
// action — honors per-profile overrides and records the diff baseline).
interface PullMenuItem {
  label: string;
  command: string | null;
}

const JUNOS_PULL_MENU: PullMenuItem[] = [
  { label: 'Configuration (set)', command: 'show configuration | display set' },
  { label: 'Configuration', command: 'show configuration' },
  { label: 'Version', command: 'show version' },
  { label: 'Interfaces', command: 'show interfaces terse' },
];

const PULL_MENU: Record<string, PullMenuItem[]> = {
  'aruba-cx': [
    { label: 'Running config', command: null },
    { label: 'Startup config', command: 'show startup-config' },
    { label: 'Version', command: 'show version' },
    { label: 'Interfaces', command: 'show interface brief' },
    { label: 'LLDP neighbors', command: 'show lldp neighbor-info' },
    { label: 'VSX status', command: 'show vsx status' },
  ],
  'aruba-aos-s': [
    { label: 'Running config', command: null },
    { label: 'Startup config', command: 'show config' },
    { label: 'Version', command: 'show version' },
    { label: 'Interfaces', command: 'show interfaces brief' },
  ],
  'aruba-controller': [
    { label: 'Running config', command: null },
    { label: 'Version', command: 'show version' },
    { label: 'AP database', command: 'show ap database' },
  ],
  'aruba-ap': [
    { label: 'Running config', command: null },
    { label: 'Version', command: 'show version' },
  ],
  'juniper-junos': JUNOS_PULL_MENU,
  mist: JUNOS_PULL_MENU,
  generic: [{ label: 'Running config', command: null }],
};

/** Why a send stopped early — shown over the buffer it came from. */
interface SendReport {
  bufferId: string;
  lineNumber: number;
  title: string;
  line: string;
  detail: string;
  deviceText: string;
}

/** The bar colors (the same as the .send-mark-* classes in index.css). */
const SEND_MARK_COLOR: Record<SendMarkState, string> = {
  ok: 'var(--accent-success)',
  rejected: 'var(--accent-danger)',
  question: 'var(--accent-warning)',
  'after-error': 'var(--accent-warning)',
  'not-sent': 'var(--text-muted)',
};

// ─── Component ───

export default function ConfigEditor() {
  // Narrow per-field selectors — whole-store subscriptions re-rendered the
  // editor (and re-created its callbacks) on every unrelated store change.
  const showConfigEditor = useSessionStore((s) => s.showConfigEditor);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const fontSize = useSettingsStore((s) => s.fontSize);
  const customDeviceProfiles = useSettingsStore((s) => s.customDeviceProfiles);
  const { isDark } = useTheme();
  const editorTheme = isDark ? 'aruba-dark' : 'aruba-light';

  // Editor buffers (tabs). Each starts blank in Plain Text — no vendor assumed
  // until the user picks a language/template (or opens a file, which infers it
  // from the extension). Typed/pasted device config still auto-detects (see
  // onChange) unless the user explicitly chose a language from the picker
  // (per-buffer `langExplicit`). The original single-buffer names —
  // content/language/currentFilePath/isDirty and their setters — are kept as
  // derived views of the ACTIVE buffer so the existing call sites stay unchanged.
  const [buffers, setBuffers] = useState<EditorBuffer[]>(() => [makeBuffer('untitled')]);
  const [activeId, setActiveId] = useState<string>(() => buffers[0].id);
  const active = buffers.find((b) => b.id === activeId) ?? buffers[0];
  const content = active.content;
  const language = active.language;
  const currentFilePath = active.filePath;
  const isDirty = active.dirty;

  const buffersRef = useRef(buffers);
  useEffect(() => { buffersRef.current = buffers; }, [buffers]);
  const activeIdRef = useRef(active.id);
  useEffect(() => { activeIdRef.current = active.id; }, [active.id]);
  // If the active id ever dangles (its tab was closed), snap to the first buffer.
  useEffect(() => {
    if (!buffers.some((b) => b.id === activeId)) setActiveId(buffers[0].id);
  }, [buffers, activeId]);
  // Unsaved edits get a dot on the side panel's Editor tab and the activity
  // bar, so they stay visible while another tab (or no panel) is showing.
  const anyDirty = buffers.some((b) => b.dirty);
  useEffect(() => {
    useSidePanelStore.getState().setStatus('editor', anyDirty ? 'dirty' : null);
  }, [anyDirty]);

  const contentRef = useRef(content);

  // Patch the ACTIVE buffer. The memoized handlers below resolve the target id
  // through a ref so they never write into a stale tab.
  const patchActive = useCallback(
    (patch: Partial<EditorBuffer> | ((b: EditorBuffer) => Partial<EditorBuffer>)) => {
      setBuffers((prev) =>
        prev.map((b) =>
          b.id === activeIdRef.current
            ? { ...b, ...(typeof patch === 'function' ? patch(b) : patch) }
            : b
        )
      );
    },
    []
  );
  const setContent = useCallback(
    (next: string | ((prev: string) => string)) =>
      patchActive((b) => ({ content: typeof next === 'function' ? next(b.content) : next })),
    [patchActive]
  );
  const setLanguage = useCallback((lang: string) => patchActive({ language: lang }), [patchActive]);
  const setIsDirty = useCallback((dirty: boolean) => patchActive({ dirty }), [patchActive]);
  const setCurrentFilePath = useCallback(
    (filePath: string | null) =>
      patchActive((b) => ({ filePath, name: filePath ? basename(filePath) : b.name })),
    [patchActive]
  );

  // Guard any action that replaces the editor contents — this tool authors device
  // config, so silently discarding unsaved edits is real data loss. Read isDirty via
  // a ref so the useCallback-memoized handlers don't see a stale value.
  const isDirtyRef = useRef(false);
  useEffect(() => {
    isDirtyRef.current = isDirty;
  }, [isDirty]);
  const confirmDiscard = async (): Promise<boolean> =>
    !isDirtyRef.current ||
    (await askConfirm({
      title: 'Discard unsaved changes?',
      message: 'You have unsaved edits in the editor. They will be lost.',
      confirmLabel: 'Discard',
      danger: true,
    }));

  // Per-tab variant for closing a specific (possibly background) buffer.
  const confirmDiscardBuf = async (buf: EditorBuffer): Promise<boolean> =>
    !buf.dirty ||
    (await askConfirm({
      title: 'Discard unsaved changes?',
      message: `"${buf.name}" has unsaved edits. They will be lost.`,
      confirmLabel: 'Discard',
      danger: true,
    }));

  const [showTemplates, setShowTemplates] = useState(false);
  const [showSnippets, setShowSnippets] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [showPullMenu, setShowPullMenu] = useState(false);
  const [showProblems, setShowProblems] = useState(false);
  const [showCompareMenu, setShowCompareMenu] = useState(false);
  const [langSearch, setLangSearch] = useState('');

  const [sending, setSending] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const sendingRef = useRef(false);
  // Set by the Cancel button; the send loop checks it between lines.
  const cancelSendRef = useRef(false);

  // Holds the original (uncleaned) text per buffer when an opened file had
  // terminal escapes, so the user can toggle back to the raw capture.
  const rawCapturesRef = useRef<Map<string, string>>(new Map());
  const [viewingRawIds, setViewingRawIds] = useState<Record<string, boolean>>({});
  const viewingRaw = !!viewingRawIds[active.id];

  // Diff mode: compare current editor content against a loaded baseline.
  const [diffMode, setDiffMode] = useState(false);
  const [diffOriginal, setDiffOriginal] = useState('');
  // What the diff's left side is, and the device it came from (null = a file).
  const [diffSource, setDiffSource] = useState<{ label: string; device: string | null } | null>(null);
  // The Diff view's text models. The React wrapper disposes them before
  // Monaco lets go of them, which throws; so it keeps them and they are
  // disposed here a moment after each Diff view closes.
  const diffModelsRef = useRef<MonacoEditor.ITextModel[]>([]);
  const disposeDiffModels = useCallback(() => {
    const models = diffModelsRef.current.splice(0);
    if (models.length) setTimeout(() => models.forEach((m) => !m.isDisposed() && m.dispose()), 0);
  }, []);
  // An AI suggestion under review (Review in Editor in the AI panel): your tab
  // on the left, the suggestion on the right. Nothing changes until Apply.
  const [aiReview, setAiReview] = useState<{
    bufferId: string;
    proposed: string;
    where: string;
    restored: number;
    markersLeft: number;
  } | null>(null);
  const reviewRightRef = useRef<MonacoEditor.ICodeEditor | null>(null);
  // An applied suggestion waits for the editor to come back, then goes in as
  // an edit (so Ctrl+Z undoes it) instead of replacing the text outright.
  const pendingApplyRef = useRef<{ bufferId: string; text: string } | null>(null);
  useEffect(() => {
    if (!diffMode && !aiReview) disposeDiffModels();
  }, [diffMode, aiReview, disposeDiffModels]);
  // Running-configs pulled per device (deviceKey). The send preview only ever
  // diffs against the device it is sending to — one global baseline from
  // whichever switch was pulled last compared against the wrong box.
  const baselinesRef = useRef(new Map<string, Baseline>());
  const lastBaselineRef = useRef<Baseline | undefined>(undefined);
  const [sendReport, setSendReport] = useState<SendReport | null>(null);
  // How far each line of the last send got: bars beside the line numbers.
  const [lastSend, setLastSend] = useState<{ bufferId: string; target: string; at: number; marks: SendMark[] } | null>(null);
  const sendMarkIdsRef = useRef(new Map<string, string[]>());
  const [sendProgress, setSendProgress] = useState<{ sent: number; total: number } | null>(null);
  // The whole lines the editor selection covers (Send selected lines, Ask AI).
  const [selection, setSelection] = useState<LineSpan | null>(null);
  const [showSendMenu, setShowSendMenu] = useState(false);
  const [showAskMenu, setShowAskMenu] = useState(false);
  // Config archive panel (NW-16): store-lifted so Tools / palette can open it.
  const showArchive = useSessionStore((s) => s.showArchive);
  const setShowArchive = useSessionStore((s) => s.setShowArchive);

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  // Bumped on every editor mount (the editor remounts after a Diff), so the
  // problem markers are put back on the new editor's model.
  const [editorEpoch, setEditorEpoch] = useState(0);
  const saveFileRef = useRef<(forcePicker?: boolean) => Promise<void>>();
  // Monaco actions are added once per mount; they call the latest handlers through this.
  const editorCommandsRef = useRef<{ sendSelection: () => void; sendSafely: () => void; askAi: (kind: AskKind) => void }>({
    sendSelection: () => {},
    sendSafely: () => {},
    askAi: () => {},
  });
  const openFileRef = useRef<() => Promise<void>>();

  // path={buffer.id} gives each tab its own Monaco model, but the library never
  // disposes detached models — without this, every closed tab's full text stays
  // in monaco's global registry for the app's lifetime.
  const modelForBuffer = useCallback((id: string) => {
    const monaco = monacoRef.current;
    if (!monaco) return null;
    return (
      monaco.editor.getModel(monaco.Uri.parse(id)) ??
      monaco.editor.getModels().find((m) => m.uri.path === `/${id}` || m.uri.toString() === id) ??
      null
    );
  }, []);
  const disposeBufferModel = useCallback(
    (id: string) => {
      try {
        modelForBuffer(id)?.dispose();
      } catch {
        // best effort — a leaked model is preferable to a crash on close
      }
    },
    [modelForBuffer]
  );

  // Draw the last send's bars on the model of the tab it came from (models
  // outlive tab switches and the Diff view, so the bars do too). A new send,
  // or Clear, removes them.
  useEffect(() => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    for (const [id, ids] of sendMarkIdsRef.current) modelForBuffer(id)?.deltaDecorations(ids, []);
    sendMarkIdsRef.current.clear();
    const model = lastSend ? modelForBuffer(lastSend.bufferId) : null;
    if (!lastSend || !model) return;
    const ids = model.deltaDecorations(
      [],
      lastSend.marks
        .filter((mark) => mark.lineNumber <= model.getLineCount())
        .map((mark) => ({
          range: new monaco.Range(mark.lineNumber, 1, mark.lineNumber, 1),
          options: {
            linesDecorationsClassName: `send-mark send-mark-${mark.state}`,
            linesDecorationsTooltip: SEND_MARK_TEXT[mark.state],
            stickiness: monaco.editor.TrackedRangeStickiness.NeverGrowsWhenTypingAtEdges,
          },
        }))
    );
    sendMarkIdsRef.current.set(lastSend.bufferId, ids);
  }, [lastSend, modelForBuffer]);

  // Panel close unmounts the component; Monaco only disposes the attached
  // model, so sweep the rest here.
  useEffect(
    () => () => {
      for (const b of buffersRef.current) disposeBufferModel(b.id);
    },
    [disposeBufferModel]
  );

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  // Recompute the problems against a DEFERRED copy of the content so the
  // full-buffer reparse (buildProblems scans every line) runs at low
  // priority instead of on the keystroke path. Monaco's value={content} below still
  // updates synchronously, so typing stays responsive on multi-thousand-line configs.
  const deferredContent = useDeferredValue(content);
  const lineCount = useMemo(() => deferredContent.split('\n').length, [deferredContent]);
  const baseProblems = useMemo(() => buildProblems(deferredContent, language), [deferredContent, language]);
  // The line the switch rejected on the last Send joins the list (red), quoting the switch.
  const problems = useMemo(() => {
    if (!sendReport || sendReport.bufferId !== active.id) return baseProblems;
    const rejected = rejectedLineProblem(deferredContent, sendReport.lineNumber, sendReport.deviceText);
    if (!rejected) return baseProblems;
    return [rejected, ...baseProblems].sort((a, b) => a.lineNumber - b.lineNumber || a.startColumn - b.startColumn);
  }, [baseProblems, sendReport, active.id, deferredContent]);
  const problemCounts = useMemo(
    () => ({
      error: problems.filter((p) => p.severity === 'error').length,
      warning: problems.filter((p) => p.severity === 'warning').length,
      info: problems.filter((p) => p.severity === 'info').length,
    }),
    [problems]
  );

  // Problems as Monaco markers: squiggles, hover text, scrollbar marks, and
  // F8 / Shift+F8 to step through them. Skipped while the deferred copy lags
  // the editor (mid-typing or just after a tab switch) so markers are never
  // computed from another buffer's text; Monaco moves the old ones with edits.
  useEffect(() => {
    const monaco = monacoRef.current;
    const model = editorRef.current?.getModel();
    if (!monaco || !model || diffMode || deferredContent !== content) return;
    const severity = {
      error: monaco.MarkerSeverity.Error,
      warning: monaco.MarkerSeverity.Warning,
      info: monaco.MarkerSeverity.Info,
    };
    monaco.editor.setModelMarkers(
      model,
      'greencli-config',
      problems.map((p) => ({
        startLineNumber: p.lineNumber,
        endLineNumber: p.lineNumber,
        startColumn: p.startColumn,
        endColumn: Math.max(p.endColumn, p.startColumn + 1),
        severity: severity[p.severity],
        message: p.message,
        source: 'GreenCLI',
        code: p.code,
      }))
    );
  }, [problems, editorEpoch, diffMode, deferredContent, content]);

  useEffect(() => { contentRef.current = content; }, [content]);

  // Auto-detect the device language from typed/pasted config, debounced so the scan
  // fires at most once per idle window instead of on every keystroke. Only runs while
  // the buffer is still plaintext and the user hasn't explicitly picked a language.
  useEffect(() => {
    if (language !== 'plaintext' || active.langExplicit) return;
    const id = setTimeout(() => {
      const detected = detectConfigLanguage(contentRef.current);
      if (detected) setLanguage(detected);
    }, 300);
    return () => clearTimeout(id);
  }, [content, language, active.langExplicit, setLanguage]);

  const showStatus = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(null), 3000);
  };

  // ─── Buffer (tab) operations ───

  const openInNewTab = useCallback((buf: Omit<EditorBuffer, 'id'>) => {
    const next: EditorBuffer = { id: generateId(), ...buf };
    setBuffers((prev) => [...prev, next]);
    setActiveId(next.id);
    return next;
  }, []);

  // Text handed over from elsewhere (a session's right-click "Open in Editor")
  // opens in new tabs. dirty: the text exists nowhere else, so closing it asks.
  const inbox = useEditorInbox((s) => s.pending);
  useEffect(() => {
    if (!inbox.length) return;
    for (const draft of useEditorInbox.getState().take()) {
      openInNewTab({ ...draft, filePath: null, dirty: true, langExplicit: false });
    }
  }, [inbox, openInNewTab]);

  // Review in Editor: the suggestion as a diff against the lines you asked
  // about, with the real secrets put back. It opens in a new tab instead when
  // there is nothing to compare with: no question from the editor, the tab is
  // closed, the lines changed since, or it is another vendor's config (Convert).
  const pendingReview = useAiBridge((s) => s.pendingReview);
  useEffect(() => {
    if (!pendingReview) return;
    const review = useAiBridge.getState().takeReview();
    if (!review) return;
    showSidePanel('editor');
    const target = review.target;
    const buffer = target ? buffersRef.current.find((b) => b.id === target.bufferId) : undefined;
    const openAlone = (why: string) => {
      const restoredCode = target ? restoreSecrets(review.code, target.secretLines).text : review.code;
      const lang = fenceDeviceLanguage(review.language) ?? target?.language ?? 'plaintext';
      openInNewTab({ name: 'AI suggestion', content: restoredCode, language: lang, filePath: null, dirty: true, langExplicit: lang !== 'plaintext' });
      showStatus(why);
    };
    if (!target || !buffer) {
      openAlone(target ? 'The tab you asked about is closed: the suggestion opened in a new tab' : 'The suggestion opened in a new tab');
      return;
    }
    if (isOtherVendor(review.language, target.language)) {
      openAlone('The converted config opened in a new tab');
      return;
    }
    const span = locateTarget(buffer.content, target.original, target.span);
    if (!span) {
      openAlone('Those lines changed since you asked: the suggestion opened in a new tab');
      return;
    }
    const { text, restored, markersLeft } = restoreSecrets(review.code, target.secretLines);
    setDiffMode(false);
    setActiveId(buffer.id);
    setAiReview({
      bufferId: buffer.id,
      proposed: withSuggestion(buffer.content, span, text),
      where: target.span ? (span.start === span.end ? `line ${span.start}` : `lines ${span.start}–${span.end}`) : 'the whole tab',
      restored,
      markersLeft,
    });
  }, [pendingReview, openInNewTab]);

  const applyAiReview = () => {
    if (!aiReview) return;
    const next = reviewRightRef.current?.getValue() ?? aiReview.proposed;
    if (next !== content) pendingApplyRef.current = { bufferId: aiReview.bufferId, text: next };
    setAiReview(null);
    reviewRightRef.current = null;
    showStatus(next !== content ? 'Applied the AI suggestion (Ctrl+Z undoes it)' : 'Nothing to apply: no changes left');
  };
  const discardAiReview = () => {
    setAiReview(null);
    reviewRightRef.current = null;
    showStatus('Discarded the AI suggestion');
  };
  const reviewing = !!aiReview && aiReview.bufferId === active.id;

  const newTab = useCallback(() => {
    openInNewTab({
      name: untitledName(buffersRef.current),
      content: '',
      language: 'plaintext',
      filePath: null,
      dirty: false,
      langExplicit: false,
    });
    // Move focus into the editor so the user can type immediately — leaving it
    // on the + button means Space/Enter keeps spawning tabs.
    setTimeout(() => editorRef.current?.focus(), 0);
  }, [openInNewTab]);

  const closeTab = useCallback(async (id: string) => {
    const buf = buffersRef.current.find((b) => b.id === id);
    if (!buf) return;
    if (!(await confirmDiscardBuf(buf))) return;
    disposeBufferModel(id);
    rawCapturesRef.current.delete(id);
    setViewingRawIds((prev) => {
      if (!(id in prev)) return prev;
      const { [id]: _closed, ...rest } = prev;
      return rest;
    });
    const bufs = buffersRef.current;
    const idx = bufs.findIndex((b) => b.id === id);
    if (idx === -1) return;
    let next = bufs.filter((b) => b.id !== id);
    // Closing the last tab leaves a fresh blank one instead of an empty strip.
    if (next.length === 0) next = [makeBuffer('untitled')];
    setBuffers(next);
    if (activeIdRef.current === id) setActiveId(next[Math.min(idx, next.length - 1)].id);
  }, []);

  // ─── File open ───

  // Load opened text into the active buffer if it's blank and clean, otherwise
  // into a new tab. Applies terminal-capture cleaning if needed.
  // `preferredId` pins the target buffer: the native file picker in openFile is
  // awaited, and the user can switch tabs while it's open — without the pin the
  // file would land in whichever buffer became active in the meantime.
  const ingest = useCallback((name: string, filePath: string | null, text: string, preferredId?: string) => {
    const isCapture = looksLikeTerminalCapture(text);
    const patch = {
      name,
      filePath,
      content: isCapture ? stripTerminalSequences(text) : text,
      language: detectLanguage(name),
      dirty: false,
      langExplicit: false,
    };
    const activeBuf = buffersRef.current.find((b) => b.id === (preferredId ?? activeIdRef.current));
    let targetId: string;
    if (activeBuf && !activeBuf.dirty && activeBuf.content === '' && !activeBuf.filePath) {
      targetId = activeBuf.id;
      setBuffers((prev) => prev.map((b) => (b.id === targetId ? { ...b, ...patch } : b)));
    } else {
      targetId = openInNewTab(patch).id;
    }
    setViewingRawIds((prev) => (prev[targetId] ? { ...prev, [targetId]: false } : prev));
    if (isCapture) {
      rawCapturesRef.current.set(targetId, text);
      showStatus(`Opened ${name} — cleaned terminal escapes (toggle Raw to see original)`);
    } else {
      rawCapturesRef.current.delete(targetId);
      showStatus(`Opened ${name}`);
    }
  }, [openInNewTab]);

  const openFile = useCallback(async () => {
    // Pin the target tab before awaiting the pickers — the active tab can
    // change while a picker is open, and the file must not land in it.
    const targetAtOpen = activeIdRef.current;
    try {
      if (isTauri) {
        const path = await tauriOpen();
        if (!path) return;
        const text = await tauriReadText(path);
        ingest(basename(path), path, text, targetAtOpen);
      } else {
        const result = await browserOpen();
        if (!result) return;
        ingest(result.name, result.name, result.content, targetAtOpen);
      }
    } catch (e) {
      showStatus(`Open failed: ${e}`);
    }
  }, [ingest]);

  // ─── Folder view ───
  // A folder's files as a tree beside the editor (desktop app only). The last
  // folder is remembered and listed again the next time the view opens.
  const [folder, setFolder] = useState<FolderListing | null>(null);
  const [showFolder, setShowFolder] = useState(false);
  const [folderLoading, setFolderLoading] = useState(false);
  const loadFolder = useCallback(async (root: string) => {
    setFolderLoading(true);
    try {
      setFolder(await tauriListFolder(root));
      setShowFolder(true);
      try {
        localStorage.setItem(FOLDER_KEY, root);
      } catch {
        /* storage blocked: just not remembered */
      }
    } catch (e) {
      showStatus(`Folder: ${e}`);
    } finally {
      setFolderLoading(false);
    }
  }, []);
  const pickFolder = useCallback(async () => {
    const root = await tauriOpenFolder().catch(() => null);
    if (root) await loadFolder(root);
  }, [loadFolder]);
  const toggleFolder = () => {
    if (!isTauri) {
      showStatus('The folder view needs the desktop app');
      return;
    }
    if (showFolder) {
      setShowFolder(false);
      return;
    }
    if (folder) {
      setShowFolder(true);
      return;
    }
    let remembered: string | null = null;
    try {
      remembered = localStorage.getItem(FOLDER_KEY);
    } catch {
      /* storage blocked */
    }
    void (remembered ? loadFolder(remembered) : pickFolder());
  };
  // A click in the tree: go to the file's tab, or open it in a new one.
  const openFromFolder = useCallback(
    async (entry: FolderEntry) => {
      if (!folder) return;
      const why = cannotOpen(entry);
      if (why) {
        showStatus(why);
        return;
      }
      const path = joinPath(folder.root, entry.path);
      const existing = buffersRef.current.find((b) => b.filePath === path);
      if (existing) {
        setActiveId(existing.id);
        return;
      }
      try {
        ingest(basename(path), path, await tauriReadText(path));
      } catch (e) {
        showStatus(`Open failed: ${e}`);
      }
    },
    [folder, ingest]
  );

  // Toggle the active buffer between the cleaned view and the raw capture.
  const toggleRaw = () => {
    const raw = rawCapturesRef.current.get(active.id);
    if (raw == null) return;
    if (viewingRaw) {
      setContent(stripTerminalSequences(raw));
      setViewingRawIds((prev) => ({ ...prev, [active.id]: false }));
    } else {
      setContent(raw);
      setViewingRawIds((prev) => ({ ...prev, [active.id]: true }));
    }
  };

  // Manually strip escapes from whatever is currently in the editor.
  const cleanCurrent = useCallback(() => {
    setContent((c) => stripTerminalSequences(c));
    setIsDirty(true);
    showStatus('Stripped terminal escapes');
  }, []);

  // Insert a snippet from the menu. Through Monaco's snippet controller its
  // blanks become Tab stops (Tab to the next, Esc when done), like typing its prefix.
  const insertSnippet = useCallback((label: string) => {
    const snippet = CONFIG_SNIPPETS.find((item) => item.label === label);
    setShowSnippets(false);
    if (!snippet) return;
    const editor = editorRef.current;
    if (!editor || !editor.getModel()) {
      setContent((prev) => `${prev}${prev.endsWith('\n') || !prev ? '' : '\n'}${snippet.body}`);
      setIsDirty(true);
      return;
    }
    const controller = editor.getContribution('snippetController2') as unknown as { insert(template: string): void } | null;
    editor.focus();
    if (controller) controller.insert(toMonacoSnippet(snippet.body));
    else editor.trigger('greencli-snippet', 'type', { text: snippet.body });
    showStatus(`Inserted ${label} — Tab moves to the next blank`);
  }, []);

  // Select a problem's text and show it (from the Problems panel, which stays open).
  const jumpToProblem = useCallback((problem: ConfigProblem) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || problem.lineNumber > model.getLineCount()) return;
    editor.revealLineInCenter(problem.lineNumber);
    editor.setSelection({
      startLineNumber: problem.lineNumber,
      startColumn: problem.startColumn,
      endLineNumber: problem.lineNumber,
      endColumn: problem.endColumn,
    });
    editor.focus();
  }, []);


  // Pull a command's output from the active device into a NEW editor tab
  // (terminal read-back, paging disabled/restored around the capture).
  // `command == null` pulls the vendor running-config — honoring per-profile
  // overrides — and records it as the diff baseline, like the old Pull button.
  const pullCommand = useCallback(async (label: string, command: string | null) => {
    if (!activeSession?.connected) {
      showStatus('Connect a session first');
      return;
    }
    const sid = activeSession.sessionId;
    showStatus(`Pulling ${label}…`);
    setPulling(true);
    try {
      const profile = profileForSession(activeSession.config, customDeviceProfiles);
      const base = VENDOR_PAGING[profile.deviceType] ?? VENDOR_PAGING.generic;
      const disable = profile.pagingDisableCommand ?? base.disable;
      const restore = profile.pagingRestoreCommand ?? base.restore;
      let show = command ?? (profile.runningConfigCommand || base.show);
      // Junos has no session paging toggle here — pipe `| no-more` like the
      // built-in running-config pull does so long output isn't paged.
      if (
        command &&
        (profile.deviceType === 'juniper-junos' || profile.deviceType === 'mist') &&
        /^show\b/i.test(command) &&
        !/\|\s*no-more\b/i.test(command)
      ) {
        show = `${command} | no-more`;
      }
      if (disable) {
        await invoke('send_data', { sessionId: sid, data: disable + '\r' });
        await sleep(300);
      }
      const { output: out, truncated } = await sendAndCapture(sid, show);
      if (restore) {
        await invoke('send_data', { sessionId: sid, data: restore + '\r' });
        await sleep(150);
      }
      if (!out) {
        showStatus(truncated ? 'No output captured (capture may be truncated)' : 'No output captured');
        return;
      }
      // Device grammars highlight show output fine (same as the terminal), so
      // show-command tabs get the session's device language too. dirty:true —
      // the capture exists nowhere else, so closing/clearing it must confirm
      // (same protection the old single-buffer pull had).
      // Do not inject a truncation banner into the buffer — it could be sent
      // back to the device; label the tab + status instead.
      const tabName = (command ?? show).replace(/\s*\|\s*no-more\s*$/i, '').trim() || label;
      openInNewTab({
        name: truncated ? `${tabName} [truncated]` : tabName,
        content: out,
        language: profile.deviceType === 'generic' ? 'plaintext' : profile.deviceType,
        filePath: null,
        dirty: true,
        langExplicit: false,
      });
      if (command == null) {
        const baseline: Baseline = {
          text: out,
          label: activeSession.config.name || activeSession.config.host || 'device',
          pulledAt: Date.now(),
          truncated,
        };
        const device = deviceKey(activeSession.config);
        baselinesRef.current.set(device, baseline);
        lastBaselineRef.current = baseline;
        showStatus(
          truncated
            ? 'Running-config pulled; baseline may be truncated'
            : 'Running-config pulled; baseline saved'
        );
      } else {
        showStatus(truncated ? `Pulled ${label} (capture may be truncated)` : `Pulled ${label}`);
      }
    } catch (e) {
      showStatus(`Pull failed: ${e}`);
    } finally {
      setPulling(false);
    }
  }, [activeSession, customDeviceProfiles, openInNewTab]);

  const pullCustom = useCallback(async () => {
    const cmd = (await askPrompt({
      title: 'Pull custom command',
      message: 'The command output is captured into a new editor tab.',
      placeholder: 'show …',
      confirmLabel: 'Pull',
    }))?.trim();
    if (!cmd) return;
    await pullCommand(cmd, cmd);
  }, [pullCommand]);

  // Diff the editor against a running-config pulled earlier (kept per device).
  const compareWithPulled = useCallback((device: string) => {
    setShowCompareMenu(false);
    const baseline = baselinesRef.current.get(device);
    if (!baseline) return;
    setDiffOriginal(baseline.text);
    setDiffSource({ label: `running-config from ${baseline.label}, pulled ${timeAgo(baseline.pulledAt)}`, device });
    setDiffMode(true);
    showStatus('Diff: left = what you pulled, right = editor');
  }, []);

  // Open a baseline file and diff it against the current editor content.
  const openDiffAgainst = useCallback(async () => {
    setShowCompareMenu(false);
    try {
      let text: string | null = null;
      let name = '';
      if (isTauri) {
        const p = await tauriOpen();
        if (!p) return;
        text = await tauriReadText(p);
        name = basename(p);
      } else {
        const r = await browserOpen();
        if (!r) return;
        text = r.content;
        name = r.name;
      }
      if (text == null) return;
      setDiffOriginal(looksLikeTerminalCapture(text) ? stripTerminalSequences(text) : text);
      setDiffSource({ label: `file ${name}`, device: null });
      setDiffMode(true);
      showStatus('Diff: left = baseline file, right = editor');
    } catch (e) {
      showStatus(`Diff open failed: ${e}`);
    }
  }, []);

  // ─── File save ───

  const saveFile = useCallback(async (forcePicker = false) => {
    // Capture the buffer being saved up front: the save dialog + IPC write are
    // async, and the user may switch tabs mid-save — patch by id, not "active".
    const targetId = activeIdRef.current;
    const text = contentRef.current;
    const targetBuf = buffersRef.current.find((b) => b.id === targetId);
    const curPath = targetBuf?.filePath ?? null;
    const patchTarget = (patch: Partial<EditorBuffer>) =>
      setBuffers((prev) => prev.map((b) => (b.id === targetId ? { ...b, ...patch } : b)));
    try {
      if (isTauri) {
        let path = curPath && !forcePicker ? curPath : null;
        if (!path) {
          const defaultName = curPath ? basename(curPath) : 'untitled.txt';
          path = await tauriSave(defaultName);
        }
        if (!path) return;
        await tauriWriteText(path, text);
        patchTarget({
          filePath: path,
          name: basename(path),
          // A hand-picked language survives the save — only auto-detected
          // buffers re-detect from the (possibly new) extension.
          ...(targetBuf?.langExplicit ? {} : { language: detectLanguage(path) }),
          dirty: false,
        });
        showStatus(`Saved ${basename(path)}`);
      } else {
        const name = curPath ? basename(curPath) : 'untitled.txt';
        browserSave(text, name);
        patchTarget({ dirty: false });
        showStatus(`Downloaded ${name}`);
      }
    } catch (e) {
      showStatus(`Save failed: ${e}`);
    }
  }, []);

  useEffect(() => { saveFileRef.current = saveFile; }, [saveFile]);
  useEffect(() => { openFileRef.current = openFile; }, [openFile]);

  // ─── Monaco mount ───

  const handleEditorMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;
    monacoRef.current = monaco;

    // Device languages, themes and snippets are registered once in
    // setupMonaco (beforeMount) — this runs again after every Diff toggle.
    setEditorEpoch((n) => n + 1);

    // An AI suggestion applied in the review: one undoable edit (onChange
    // then saves it to the tab and marks it unsaved).
    const apply = pendingApplyRef.current;
    const model = ed.getModel();
    if (apply && model && apply.bufferId === activeIdRef.current) {
      pendingApplyRef.current = null;
      ed.pushUndoStop();
      ed.executeEdits('ai-suggestion', [{ range: model.getFullModelRange(), text: apply.text, forceMoveMarkers: true }]);
      ed.pushUndoStop();
    }

    // Keybindings
    ed.addAction({
      id: 'save-file',
      label: 'Save File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS],
      run: () => saveFileRef.current?.(),
    });
    ed.addAction({
      id: 'save-file-as',
      label: 'Save File As…',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyS],
      run: () => saveFileRef.current?.(true),
    });
    ed.addAction({
      id: 'open-file',
      label: 'Open File',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO],
      run: () => openFileRef.current?.(),
    });
    ed.addAction({
      id: 'toggle-problems',
      label: 'Show or Hide Problems',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.KeyM],
      run: () => setShowProblems((open) => !open),
    });
    // Right-click menu: the device commands, in their own group at the top.
    ed.addAction({
      id: 'greencli-send-selection',
      label: 'Send Selected Lines to Device',
      contextMenuGroupId: '0_greencli',
      contextMenuOrder: 1,
      run: () => editorCommandsRef.current.sendSelection(),
    });
    ed.addAction({
      id: 'greencli-send-safely',
      label: 'Send Safely as a Change Job…',
      contextMenuGroupId: '0_greencli',
      contextMenuOrder: 2,
      run: () => editorCommandsRef.current.sendSafely(),
    });

    ed.addAction({
      id: 'greencli-ask-explain',
      label: 'Ask AI: Explain These Lines',
      contextMenuGroupId: '0_greencli',
      contextMenuOrder: 3,
      run: () => editorCommandsRef.current.askAi('explain'),
    });
    ed.addAction({
      id: 'greencli-ask-custom',
      label: 'Ask AI About These Lines…',
      contextMenuGroupId: '0_greencli',
      contextMenuOrder: 4,
      run: () => editorCommandsRef.current.askAi('custom'),
    });

    setSelection(selectedLines(ed.getSelection()));
    ed.onDidChangeCursorSelection((e) => setSelection(selectedLines(e.selection)));
    ed.onDidChangeModel(() => setSelection(selectedLines(ed.getSelection())));
  };

  // ─── Send to terminal ───

  /** Send the tab, or with `span` only the selected lines (Send selected lines). */
  const sendToTerminal = async (span?: LineSpan) => {
    if (sendingRef.current) return;
    if (pulling) {
      showStatus('Pull in progress — wait for it to finish');
      return;
    }
    if (!activeSession || !content.trim()) return;
    if (!activeSession.connected) {
      showStatus('Not connected — connect the session first');
      return;
    }
    const allPrepared = prepareSendLines(content);
    const prepared = span ? linesInSpan(allPrepared, span) : allPrepared;
    const lines = prepared.map((l) => l.text);
    if (lines.length === 0) {
      showStatus(span ? 'Nothing to send in the selected lines' : 'Nothing to send');
      return;
    }

    // The name on its terminal tab, so the dialog and the status line match it.
    const target = tabLabel(activeSession);
    // From the live text, not the deferred copy the panel uses: a blank typed a
    // moment ago still counts. A code-language tab still gets the device checks,
    // since it is going to a device.
    // Setting a password in plain text is what a send is for, so that tip stays out of the dialog.
    const sendProblems = buildProblems(content, NETWORK_LANGUAGES.has(language) ? language : 'generic').filter(
      (p) => p.code !== 'plaintext-secret' && (!span || (p.lineNumber >= span.start && p.lineNumber <= span.end))
    );
    const risky = sendProblems.some((p) => p.severity === 'error' || p.code === 'danger');
    const mismatch = vendorMismatch(
      language,
      profileForSession(activeSession.config, customDeviceProfiles).deviceType,
      target
    );
    // The compare with what you pulled is about the whole tab.
    const diffSummary = span
      ? `Only the selected lines ${span.start === span.end ? span.start : `${span.start}–${span.end}`} are sent.`
      : describeSendBaseline(
          content,
          target,
          baselinesRef.current.get(deviceKey(activeSession.config)),
          lastBaselineRef.current
        );
    const preview = lines.slice(0, 12).join('\n');
    const sid = activeSession.sessionId;
    const bufferId = active.id;
    sendingRef.current = true;
    setSending(true);
    let watcher: Awaited<ReturnType<typeof watchSessionOutput>> | null = null;

    try {
      const ok = await askConfirm({
        title: `Send ${lines.length}${span ? ' selected' : ''} line${lines.length === 1 ? '' : 's'} to ${target}?`,
        message: [
          mismatch,
          sendProblemNote(sendProblems),
          diffSummary,
          'Sending stops at the first error the device reports.',
          `Preview:\n${preview}${lines.length > 12 ? '\n…' : ''}`,
        ]
          .filter(Boolean)
          .join('\n\n'),
        confirmLabel: 'Send',
        danger: risky || mismatch !== undefined,
      });
      if (!ok) return;

      // One line at a time, each waiting for the device's answer; the Cancel
      // button sets a flag the loop checks while it waits. A stop part-way
      // leaves a PARTIAL config on the device, so every outcome says exactly
      // how far it got.
      setSendReport(null);
      setLastSend(null);
      cancelSendRef.current = false;
      watcher = await watchSessionOutput(sid);
      setSendProgress({ sent: 0, total: lines.length });
      const result = await runConfigSend(prepared, {
        send: (data) => invoke('send_data', { sessionId: sid, data }),
        output: watcher.output,
        sleep,
        cancelled: () => cancelSendRef.current,
        now: () => Date.now(),
        onProgress: (sent) => setSendProgress({ sent, total: lines.length }),
      });
      setLastSend({ bufferId, target, at: Date.now(), marks: sendMarks(prepared, result) });
      const plural = (n: number) => `${n} line${n === 1 ? '' : 's'}`;
      if (result.kind === 'done') {
        showStatus(`Sent ${plural(lines.length)}`);
      } else if (result.kind === 'cancelled') {
        showStatus(`Send cancelled — sent ${result.sent} of ${lines.length} lines`);
      } else if (result.kind === 'send-failed') {
        showStatus(`Send failed — sent ${result.sent} of ${lines.length} lines (is the session still connected?)`);
      } else {
        const failed = prepared[result.failedIndex];
        const alreadyOut = result.sent - (result.failedIndex + 1);
        const notSent = lines.length - result.sent;
        setSendReport({
          bufferId,
          lineNumber: failed.lineNumber,
          title:
            result.kind === 'question'
              ? `Stopped at line ${failed.lineNumber} — the device is asking a question. Answer it in the terminal.`
              : `Stopped at line ${failed.lineNumber} — the device rejected it.`,
          line: failed.text,
          detail: [
            `${plural(result.failedIndex)} before it went through.`,
            alreadyOut > 0 ? `${plural(alreadyOut)} after it had already gone out before the error came back.` : '',
            notSent > 0 ? `The remaining ${plural(notSent)} were not sent.` : '',
          ]
            .filter(Boolean)
            .join(' '),
          deviceText: result.deviceText,
        });
      }
    } catch (e) {
      showStatus(`Send failed: ${e}`);
    } finally {
      watcher?.dispose();
      sendingRef.current = false;
      setSending(false);
      setSendProgress(null);
      cancelSendRef.current = false;
    }
  };

  /** Send safely: hand the tab (or the selected lines) to Change Jobs with this
   *  device ticked, so it goes out under the vendor's rollback timer after a
   *  dry run. Nothing is sent from here. */
  const sendSafely = (span?: LineSpan | null) => {
    if (!activeSession) {
      showStatus('Open a device tab first');
      return;
    }
    const text = span ? spanText(content, span) : content;
    const { deviceType } = profileForSession(activeSession.config, customDeviceProfiles);
    const { block, removed } = jobBlockFromEditor(text, deviceType);
    if (!prepareSendLines(block).length) {
      showStatus(span ? 'Nothing to send in the selected lines' : 'Nothing to send');
      return;
    }
    useSessionStore.getState().openChangeJobWith({ block, sessionId: activeSession.sessionId, removed });
  };

  /** Ask AI about the selected lines (or the whole tab). Secrets are hidden
   *  first (nothing goes if that can't run); the editor keeps the real lines
   *  so an answer can come back as a diff to review. */
  const askAi = async (kind: AskKind) => {
    setShowAskMenu(false);
    const span = selectedLines(editorRef.current?.getSelection());
    const text = span ? spanText(content, span) : content;
    if (!text.trim()) {
      showStatus('Nothing to ask about');
      return;
    }
    let question: string | undefined;
    if (kind === 'custom') {
      question = (
        await askPrompt({
          title: span ? 'Ask the AI about these lines' : 'Ask the AI about this tab',
          placeholder: 'What does this do? What is missing?',
          confirmLabel: 'Ask',
        })
      )?.trim();
      if (!question) return;
    }
    const hidden = await hideSecretsInText(text);
    if (!hidden.ok) {
      showStatus(
        hidden.reason === 'too-big'
          ? 'Not sent to the AI: too big to check for secrets (over 1 MB)'
          : 'Not sent to the AI: GreenCLI could not check it for secrets on this system'
      );
      return;
    }
    const inSpan = (n: number) => !span || (n >= span.start && n <= span.end);
    const found =
      kind === 'fix' || kind === 'check'
        ? buildProblems(content, language)
            .filter((p) => p.severity !== 'info' && inSpan(p.lineNumber))
            .map((p) => ({ lineNumber: p.lineNumber, message: p.message }))
        : undefined;
    const prompt = buildAskPrompt({
      kind,
      question,
      text: hidden.text,
      language,
      languageName: LANGUAGE_LIST.find((l) => l.id === language)?.label,
      tabName: active.name,
      span,
      hidden: hidden.hidden,
      problems: found,
    });
    useAiBridge.getState().ask(prompt, {
      bufferId: active.id,
      tabName: active.name,
      language,
      span,
      original: text,
      secretLines: secretLinePairs(text, hidden.text),
    });
    showSidePanel('ai');
  };

  // After each render, like saveFileRef: the right-click items reach the latest handlers.
  useEffect(() => {
    editorCommandsRef.current = {
      askAi: (kind) => void askAi(kind),
      sendSelection: () => {
        const span = selectedLines(editorRef.current?.getSelection());
        if (span) void sendToTerminal(span);
        else showStatus('Select the lines to send first');
      },
      sendSafely: () => sendSafely(selectedLines(editorRef.current?.getSelection())),
    };
  });

  // Select a line in the editor (from the send-error banner).
  const jumpToLine = (lineNumber: number) => {
    const editor = editorRef.current;
    const model = editor?.getModel();
    if (!editor || !model || lineNumber > model.getLineCount()) return;
    editor.revealLineInCenter(lineNumber);
    editor.setSelection({
      startLineNumber: lineNumber,
      startColumn: 1,
      endLineNumber: lineNumber,
      endColumn: model.getLineMaxColumn(lineNumber),
    });
    editor.focus();
  };

  const copyToClipboard = () => {
    copyText(content).then((ok) => showStatus(ok ? 'Copied' : 'Copy failed'));
  };

  // The same secret filter the AI gets, for pasting a config into a ticket or
  // chat. Nothing is copied if the filter can't run.
  const copyWithSecretsHidden = async () => {
    const result = await hideSecretsForCopy(content);
    if (!result.ok) {
      showStatus(result.message);
      return;
    }
    showStatus((await copyText(result.text)) ? result.message : 'Copy failed');
  };

  const loadTemplate = async (name: string) => {
    setShowTemplates(false);
    const buf = {
      name,
      content: TEMPLATES[name],
      language:
        name.startsWith('Junos') || name.startsWith('JVD')
          ? 'juniper-junos'
          : name.startsWith('Mist')
            ? 'mist'
            : name.startsWith('AOS-S')
              ? 'aruba-aos-s'
              : name.startsWith('Aruba AP')
                ? 'aruba-ap'
                : name.startsWith('AOS8')
                  ? 'aruba-controller'
                  : 'aruba-cx',
      filePath: null,
      dirty: false,
      langExplicit: false,
    };
    // Don't clobber a tab with content or a file identity — open the template
    // in its own tab. Only a blank scratch tab is reused in place.
    if (active.content.trim() !== '' || active.filePath) {
      openInNewTab(buf);
      return;
    }
    if (!(await confirmDiscard())) return; // dirty-but-blank still counts as edits
    rawCapturesRef.current.delete(active.id);
    setViewingRawIds((prev) => {
      const { [active.id]: _, ...rest } = prev;
      return rest;
    });
    patchActive(buf);
  };


  // App keeps this panel MOUNTED across open/close (editor buffers, undo
  // history, and Monaco view state survive); "closed" hides the root via CSS.
  // Monaco can't measure a display:none container, so force a relayout when
  // the panel becomes visible again (mirrors the terminal refit-on-unhide).
  useEffect(() => {
    if (!showConfigEditor) return;
    const t = setTimeout(() => editorRef.current?.layout(), 50);
    return () => clearTimeout(t);
  }, [showConfigEditor]);

  const pullMenuItems = activeSession
    ? PULL_MENU[profileForSession(activeSession.config, customDeviceProfiles).deviceType] ??
      PULL_MENU.generic
    : PULL_MENU.generic;
  const currentLangLabel = LANGUAGE_LIST.find((l) => l.id === language)?.label || language;
  // Where Send goes, for the status line under the editor.
  const sendTarget = activeSession
    ? {
        name: tabLabel(activeSession),
        connected: activeSession.connected,
        configMode: !!activeSession.configMode,
        deviceType: profileForSession(activeSession.config, customDeviceProfiles).deviceType,
      }
    : null;
  // What "Send safely" protects the change with, for this device.
  const safeVendor = sendTarget ? vendorSteps(sendTarget.deviceType) : null;
  const safeSendHint = !safeVendor
    ? ''
    : safeVendor.wrapper === 'checkpoint'
      ? 'Dry run, then checkpoint auto: the switch rolls back unless you confirm.'
      : safeVendor.wrapper === 'commit-confirmed'
        ? 'Dry run, then commit confirmed: Junos rolls back unless you confirm.'
        : `${safeVendor.label} has no rollback timer, but you get a dry run and checks.`;
  const pulledForTarget = activeSession ? baselinesRef.current.get(deviceKey(activeSession.config)) : undefined;
  const sendTargetPull = pulledForTarget ? { at: pulledForTarget.pulledAt, truncated: pulledForTarget.truncated } : undefined;
  const filteredLangs = LANGUAGE_LIST.filter((l) =>
    l.label.toLowerCase().includes(langSearch.toLowerCase()) ||
    l.id.toLowerCase().includes(langSearch.toLowerCase())
  );

  return (
    // A tab of the side panel (SidePanel owns the frame: width, drag handle,
    // maximize and close). The file name lives on the buffer tabs below.
    <div
      id="side-panel-editor"
      role="tabpanel"
      aria-labelledby="side-tab-editor"
      className={`${showConfigEditor ? '' : 'hidden '}absolute inset-0 flex flex-col bg-[var(--bg-primary)] overflow-hidden`}
      aria-hidden={!showConfigEditor}
      onKeyDown={(e) => {
        // Ctrl+Shift+M anywhere in the panel. Monaco handles it itself (and
        // stops it) when the text has focus.
        if (!e.defaultPrevented && (e.ctrlKey || e.metaKey) && e.shiftKey && e.key.toLowerCase() === 'm') {
          e.preventDefault();
          setShowProblems((open) => !open);
        }
      }}
    >
      {/* Buffer tabs */}
      <div
        className="flex items-center h-8 px-1.5 gap-1 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)] overflow-x-auto scrollbar-none flex-shrink-0"
        onWheel={(e) => {
          // The scrollbar is hidden and a vertical wheel doesn't scroll a
          // horizontal strip — translate it so overflowed tabs stay reachable.
          if (e.deltaY !== 0) e.currentTarget.scrollLeft += e.deltaY;
        }}
      >
        {buffers.map((buf) => {
          const isActiveTab = buf.id === active.id;
          return (
            <div
              key={buf.id}
              ref={isActiveTab ? (el) => el?.scrollIntoView({ inline: 'nearest', block: 'nearest' }) : undefined}
              onClick={() => {
                setActiveId(buf.id);
                setTimeout(() => editorRef.current?.focus(), 0);
              }}
              onAuxClick={(e) => {
                // Middle-click close, like browser/terminal tabs.
                if (e.button === 1) { e.preventDefault(); closeTab(buf.id); }
              }}
              title={buf.filePath ?? buf.name}
              className={`group flex items-center gap-1.5 pl-2.5 pr-1 h-6 rounded-md cursor-pointer select-none flex-shrink-0 transition-all ${
                isActiveTab
                  ? 'bg-[var(--bg-tertiary)]'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-tertiary)] hover:text-[var(--text-primary)]'
              }`}
              style={isActiveTab ? { boxShadow: 'inset 0 0 0 1px var(--border-strong)' } : undefined}
            >
              <span className={`text-[11px] truncate max-w-[18ch] ${isActiveTab ? 'text-[var(--accent)]' : ''}`}>
                {buf.name}
              </span>
              {buf.dirty && (
                <span
                  className="w-1.5 h-1.5 rounded-full bg-[var(--accent-warning)] flex-shrink-0"
                  title="Unsaved changes"
                />
              )}
              <button
                onClick={(e) => { e.stopPropagation(); closeTab(buf.id); }}
                className="opacity-0 group-hover:opacity-100 p-0.5 rounded hover:bg-[var(--border-strong)] transition-all flex-shrink-0"
                title="Close tab"
                aria-label="Close tab"
              >
                <X size={11} />
              </button>
            </div>
          );
        })}
        <button
          onClick={newTab}
          className="flex items-center justify-center w-6 h-6 rounded-md hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors flex-shrink-0"
          title="New tab"
          aria-label="New tab"
        >
          <Plus size={13} />
        </button>
      </div>

      {/* Toolbar — wraps rather than clipping: at side-panel widths the
          Pull / Diff / Archive / Send buttons used to fall off the end. */}
      <div className="flex flex-wrap items-center gap-x-1 gap-y-0.5 px-2 py-1 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">

        {/* File actions — icon-only group with tooltips */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={toggleFolder}
            className={`p-1.5 rounded transition-colors ${
              showFolder ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title={showFolder ? 'Hide the folder' : 'Open a folder (its files as a tree)'}
            aria-label={showFolder ? 'Hide the folder' : 'Open a folder'}
            aria-pressed={showFolder}
          >
            <FolderTree size={13} />
          </button>
          <button
            onClick={openFile}
            className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Open file (Ctrl+O)"
            aria-label="Open file"
          >
            <FolderOpen size={13} />
          </button>
          <button
            onClick={() => saveFile(false)}
            className={`p-1.5 rounded transition-colors ${
              isDirty ? 'text-[var(--accent-warning)] hover:bg-[var(--accent-warning-soft)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title={currentFilePath ? 'Save (Ctrl+S)' : 'Save As… (Ctrl+S)'}
            aria-label={currentFilePath ? 'Save' : 'Save As'}
          >
            <Download size={13} />
          </button>
          <button
            onClick={cleanCurrent}
            className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Strip ANSI / terminal control codes"
            aria-label="Strip ANSI / terminal control codes"
          >
            <Eraser size={13} />
          </button>
          <button
            onClick={copyToClipboard}
            className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Copy all"
            aria-label="Copy all"
          >
            <Copy size={13} />
          </button>
          <button
            onClick={copyWithSecretsHidden}
            className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Copy with secrets hidden: passwords, keys and SNMP communities become <secret hidden>, safe to paste in a ticket or chat"
            aria-label="Copy with secrets hidden"
          >
            <EyeOff size={13} />
          </button>
          <button
            onClick={async () => {
              if (!(await confirmDiscard())) return;
              rawCapturesRef.current.delete(active.id);
              setViewingRawIds((prev) => (prev[active.id] ? { ...prev, [active.id]: false } : prev));
              patchActive({
                content: '',
                filePath: null,
                dirty: false,
                name: untitledName(buffersRef.current.filter((b) => b.id !== active.id)),
              });
            }}
            className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--accent-danger)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Clear this tab"
            aria-label="Clear editor contents"
          >
            <FileX size={13} />
          </button>
          {rawCapturesRef.current.has(active.id) && (
            <button
              onClick={toggleRaw}
              className={`px-1.5 py-1 text-[10px] rounded transition-colors ${
                viewingRaw ? 'text-[var(--accent-warning)] bg-[var(--accent-warning-soft)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
              }`}
              title="Toggle cleaned / raw capture"
            >
              {viewingRaw ? 'Raw' : 'Clean'}
            </button>
          )}
        </div>

        <div className="w-px h-4 bg-[var(--border)] mx-1" />

        {/* Language picker */}
        <div className="relative">
          <button
            onClick={() => { setShowLangPicker(!showLangPicker); setLangSearch(''); setShowTemplates(false); setShowSnippets(false); setShowPullMenu(false); }}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
            title="Change language mode"
          >
            <Code2 size={12} />
            <span className="max-w-[80px] truncate">{currentLangLabel}</span>
            <ChevronDown size={10} />
          </button>
          {showLangPicker && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowLangPicker(false)} />
              <div className="absolute top-full left-0 mt-1 z-30 w-48 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl flex flex-col">
                <div className="p-1.5 border-b border-[var(--bg-tertiary)]">
                  <input
                    autoFocus
                    value={langSearch}
                    onChange={(e) => setLangSearch(e.target.value)}
                    placeholder="Filter…"
                    className="w-full text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded px-2 py-1 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)]"
                  />
                </div>
                <div className="overflow-y-auto max-h-56 py-1">
                  {filteredLangs.map((l) => (
                    <button
                      key={l.id}
                      onClick={() => { patchActive({ language: l.id, langExplicit: true }); setShowLangPicker(false); }}
                      className={`flex items-center w-full px-3 py-1.5 text-xs text-left transition-colors ${
                        language === l.id
                          ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
                          : 'text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
                      }`}
                    >
                      {l.label}
                    </button>
                  ))}
                  {filteredLangs.length === 0 && (
                    <p className="px-3 py-2 text-xs text-[var(--text-muted)]">No match</p>
                  )}
                </div>
              </div>
            </>
          )}
        </div>

        <div className="w-px h-4 bg-[var(--border)] mx-0.5" />

        {/* Templates (Aruba + Junos) */}
        <div className="relative">
          <button
            onClick={() => { setShowTemplates(!showTemplates); setShowLangPicker(false); setShowSnippets(false); setShowPullMenu(false); }}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
          >
            <BookOpen size={12} />
            Templates
            <ChevronDown size={10} />
          </button>
          {showTemplates && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowTemplates(false)} />
              <div className="absolute top-full left-0 mt-1 z-30 min-w-[160px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl py-1">
                {Object.keys(TEMPLATES).map((name) => (
                  <button
                    key={name}
                    onClick={() => loadTemplate(name)}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] text-left"
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Snippets */}
        <div className="relative">
          <button
            onClick={() => { setShowSnippets(!showSnippets); setShowTemplates(false); setShowLangPicker(false); setShowPullMenu(false); }}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
            title="Insert common network config snippets"
          >
            <Code2 size={12} />
            Snippets
            <ChevronDown size={10} />
          </button>
          {showSnippets && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowSnippets(false)} />
              <div className="absolute top-full left-0 mt-1 z-30 min-w-[260px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl py-1">
                {CONFIG_SNIPPETS.map((snippet) => (
                  <button
                    key={snippet.label}
                    onClick={() => insertSnippet(snippet.label)}
                    className="grid grid-cols-[1fr_auto] gap-3 w-full px-3 py-1.5 text-xs text-left hover:bg-[var(--bg-tertiary)]"
                    title={snippet.description}
                  >
                    <span className="text-[var(--text-primary)]">{snippet.label}</span>
                    <code className="text-[10px] text-[var(--text-muted)]">{snippet.prefix}</code>
                  </button>
                ))}
                <p className="px-3 pt-1.5 mt-1 border-t border-[var(--border)] text-[10px] text-[var(--text-muted)]">
                  Or type the word on the right at the start of a line. Tab moves to the next blank.
                </p>
              </div>
            </>
          )}
        </div>

        {/* Outline: Monaco's Go to Symbol box (Ctrl+Shift+O) — type to jump to an
            interface, VLAN or section. Code files use Monaco's own symbols. */}
        <button
          onClick={() => {
            const editor = editorRef.current;
            if (!editor || diffMode) return;
            editor.focus();
            void editor.getAction('editor.action.quickOutline')?.run();
          }}
          disabled={diffMode}
          className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 rounded transition-colors"
          title="Go to Symbol: type to jump to an interface, VLAN or section (Ctrl+Shift+O)"
        >
          <ListTree size={12} />
          Outline
        </button>

        <div className="w-px h-4 bg-[var(--border)] mx-0.5" />

        {/* Pull from the active device — default click pulls the running-config;
            the chevron opens per-vendor show commands. Output lands in a new tab. */}
        <div className="relative flex items-stretch">
          <button
            onClick={() => pullCommand('Running config', null)}
            disabled={!activeSession?.connected || pulling}
            className="flex items-center gap-1.5 pl-2 pr-1.5 py-1 text-xs rounded-l transition-colors disabled:opacity-40 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            title="Pull running-config from the active device"
          >
            {pulling ? <RefreshCw size={12} className="animate-spin" /> : <DownloadCloud size={12} />}
            Pull
          </button>
          <button
            onClick={() => { setShowPullMenu(!showPullMenu); setShowTemplates(false); setShowLangPicker(false); setShowSnippets(false); }}
            disabled={!activeSession?.connected || pulling}
            className="flex items-center px-0.5 rounded-r transition-colors disabled:opacity-40 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            title="Pull other command output"
            aria-label="Pull other command output"
          >
            <ChevronDown size={10} />
          </button>
          {showPullMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowPullMenu(false)} />
              <div className="absolute top-full left-0 mt-1 z-30 min-w-[210px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl py-1">
                {pullMenuItems.map((item) => (
                  <button
                    key={item.label}
                    onClick={() => { setShowPullMenu(false); pullCommand(item.label, item.command); }}
                    className="grid grid-cols-[1fr_auto] items-center gap-3 w-full px-3 py-1.5 text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    <span>{item.label}</span>
                    <span className="text-[10px] text-[var(--text-muted)] font-mono truncate max-w-[150px]">
                      {item.command ?? ''}
                    </span>
                  </button>
                ))}
                <div className="my-1 border-t border-[var(--bg-tertiary)]" />
                <button
                  onClick={() => { setShowPullMenu(false); pullCustom(); }}
                  className="flex items-center w-full px-3 py-1.5 text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                >
                  Custom command…
                </button>
              </div>
            </>
          )}
        </div>

        {/* Compare: with a running-config you pulled (kept per device) or a file.
            Picking a file no longer replaces what you pulled. */}
        <div className="relative">
          <button
            onClick={() => {
              if (diffMode) {
                setDiffMode(false);
                return;
              }
              setShowCompareMenu(!showCompareMenu);
            }}
            disabled={reviewing}
            className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors disabled:opacity-40 ${
              diffMode ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title="Compare the editor with what you pulled, or with a file"
          >
            <GitCompare size={12} />
            {diffMode ? 'Exit Diff' : 'Diff'}
            {!diffMode && <ChevronDown size={10} />}
          </button>
          {showCompareMenu && !diffMode && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowCompareMenu(false)} />
              <div className="absolute top-full left-0 mt-1 z-30 w-72 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl py-1">
                {(() => {
                  const activeDevice = activeSession ? deviceKey(activeSession.config) : null;
                  const pulled = [...baselinesRef.current.entries()].sort(
                    ([a], [b]) => Number(b === activeDevice) - Number(a === activeDevice)
                  );
                  if (!pulled.length) {
                    return (
                      <p className="px-3 py-1.5 text-xs text-[var(--text-muted)]">
                        Nothing pulled yet. Pull the running-config to compare with it.
                      </p>
                    );
                  }
                  return pulled.map(([device, baseline]) => (
                    <button
                      key={device}
                      onClick={() => compareWithPulled(device)}
                      className="block w-full px-3 py-1.5 text-left hover:bg-[var(--bg-tertiary)]"
                    >
                      <span className="block text-xs text-[var(--text-primary)] truncate">
                        Running-config from {baseline.label}
                        {device === activeDevice ? ' (this session)' : ''}
                      </span>
                      <span className="block text-[10px] text-[var(--text-muted)]">
                        pulled {timeAgo(baseline.pulledAt)}
                        {baseline.truncated ? ' · may be cut off' : ''}
                      </span>
                    </button>
                  ));
                })()}
                <div className="my-1 border-t border-[var(--border)]" />
                <button
                  onClick={openDiffAgainst}
                  className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] text-left"
                >
                  <FolderOpen size={12} />
                  A file…
                </button>
              </div>
            </>
          )}
        </div>

        {/* Ask AI about the selected lines (or the tab): secrets hidden first. */}
        <div className="relative">
          <button
            onClick={() => setShowAskMenu((open) => !open)}
            disabled={!content.trim()}
            className="flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors disabled:opacity-40 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            title={selection ? 'Ask the AI about the selected lines' : 'Ask the AI about this tab'}
          >
            <Sparkles size={12} />
            Ask AI
            <ChevronDown size={10} />
          </button>
          {showAskMenu && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowAskMenu(false)} />
              <div className="absolute top-full left-0 mt-1 z-30 w-60 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl py-1">
                <p className="px-3 py-1 text-[10px] text-[var(--text-muted)]">
                  {selection
                    ? `About ${selection.start === selection.end ? `line ${selection.start}` : `lines ${selection.start}–${selection.end}`}. Secrets are hidden first.`
                    : 'About the whole tab (select lines to narrow it). Secrets are hidden first.'}
                </p>
                {askMenu(language, problemCounts.error + problemCounts.warning > 0).map((item) => (
                  <button
                    key={item.kind}
                    onClick={() => void askAi(item.kind)}
                    className="flex items-center w-full px-3 py-1.5 text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    {item.label}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Config archive history + golden diff */}
        <button
          onClick={() => setShowArchive(!showArchive)}
          className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
            showArchive ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
          }`}
          title="Per-device config history + golden-config diff"
        >
          <History size={12} />
          {showArchive ? 'Close Archive' : 'Archive'}
        </button>

        <div className="flex-1" />

        {/* Problems: counts by kind; opens the Problems panel (Ctrl+Shift+M). F8 steps through them in the editor. */}
        {problems.length > 0 && (
          <button
            onClick={() => setShowProblems(!showProblems)}
            aria-pressed={showProblems}
            className={`flex items-center gap-2 mr-1 px-1.5 py-0.5 text-[10px] rounded hover:bg-[var(--bg-tertiary)] ${
              showProblems ? 'bg-[var(--bg-tertiary)]' : ''
            }`}
            title={`${problemSummary(problems)}. Click for the Problems panel (Ctrl+Shift+M), F8 for the next one`}
            aria-label={`Problems: ${problemSummary(problems)}`}
          >
            {problemCounts.error > 0 && (
              <span className="flex items-center gap-0.5 text-[var(--accent-danger)]">
                <XCircle size={11} />
                {problemCounts.error}
              </span>
            )}
            {problemCounts.warning > 0 && (
              <span className="flex items-center gap-0.5 text-[var(--accent-warning)]">
                <AlertTriangle size={11} />
                {problemCounts.warning}
              </span>
            )}
            {problemCounts.info > 0 && (
              <span className="flex items-center gap-0.5 text-[var(--accent-info)]">
                <Info size={11} />
                {problemCounts.info}
              </span>
            )}
          </button>
        )}
        {statusMsg && <span className="text-[10px] text-[var(--text-secondary)] mr-1">{statusMsg}</span>}

        {/* Send to terminal — confirmed before every send; cancellable mid-send
            (a stopped send leaves a partial config on the device). */}
        {activeSession && sending && (
          <button
            onClick={() => {
              cancelSendRef.current = true;
            }}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-[var(--danger-solid)] hover:brightness-110 text-[var(--danger-solid-fg)] rounded transition-colors"
            title="Stop sending lines"
            aria-label="Cancel send"
          >
            <Square size={12} />
            Cancel
          </button>
        )}
        {activeSession && (
          <div className="relative flex items-stretch">
            <button
              onClick={() => void sendToTerminal()}
              disabled={sending || pulling || !activeSession?.connected}
              className="flex items-center gap-1.5 pl-2.5 pr-2 py-1 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-[var(--accent-fg)] rounded-l transition-colors"
              title={activeSession ? 'Send lines to terminal' : 'No active session'}
            >
              <Send size={12} />
              {sending
                ? sendProgress
                  ? `Sending ${sendProgress.sent}/${sendProgress.total}…`
                  : 'Sending…'
                : 'Send'}
            </button>
            <button
              onClick={() => setShowSendMenu((open) => !open)}
              disabled={sending || pulling}
              className="flex items-center px-1 border-l border-black/20 bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-[var(--accent-fg)] rounded-r transition-colors"
              title="Send selected lines, or send safely as a Change Job"
              aria-label="More ways to send"
            >
              <ChevronDown size={11} />
            </button>
            {showSendMenu && (
              <>
                <div className="fixed inset-0 z-20" onClick={() => setShowSendMenu(false)} />
                <div className="absolute top-full right-0 mt-1 z-30 w-72 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl py-1">
                  <button
                    onClick={() => {
                      setShowSendMenu(false);
                      if (selection) void sendToTerminal(selection);
                    }}
                    disabled={!selection || !activeSession.connected}
                    className="flex flex-col w-full px-3 py-1.5 text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] disabled:opacity-40 disabled:hover:bg-transparent"
                  >
                    <span>
                      Send selected lines
                      {selection ? ` (${selection.start === selection.end ? `line ${selection.start}` : `lines ${selection.start}–${selection.end}`})` : ''}
                    </span>
                    <span className="text-[10px] text-[var(--text-muted)]">
                      {selection ? 'Only these lines go out, one at a time.' : 'Select some lines in the editor first.'}
                    </span>
                  </button>
                  <button
                    onClick={() => {
                      setShowSendMenu(false);
                      sendSafely(selection);
                    }}
                    className="flex flex-col w-full px-3 py-1.5 text-xs text-left text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
                  >
                    <span>Send safely as a Change Job…{selection ? ' (selected lines)' : ''}</span>
                    <span className="text-[10px] text-[var(--text-muted)]">{safeSendHint}</span>
                  </button>
                </div>
              </>
            )}
          </div>
        )}
      </div>

      {/* Why the last send stopped early (tied to the buffer it came from). */}
      {sendReport && sendReport.bufferId === active.id && (
        <div
          role="alert"
          className="flex items-start gap-2 px-3 py-2 border-b border-[var(--bg-tertiary)] bg-[var(--accent-danger-soft)] text-xs flex-shrink-0"
        >
          <AlertTriangle size={13} className="text-[var(--accent-danger)] mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0">
            <div className="text-[var(--text-primary)] font-medium">{sendReport.title}</div>
            <div className="font-mono text-[11px] text-[var(--text-secondary)] truncate" title={sendReport.line}>
              {sendReport.line}
            </div>
            {sendReport.deviceText && (
              <pre className="mt-1 max-h-24 overflow-auto whitespace-pre-wrap break-words font-mono text-[11px] text-[var(--accent-danger)]">
                {sendReport.deviceText}
              </pre>
            )}
            <div className="mt-1 text-[var(--text-muted)]">{sendReport.detail}</div>
          </div>
          {!diffMode && (
            <button
              onClick={() => jumpToLine(sendReport.lineNumber)}
              className="px-2 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] flex-shrink-0"
            >
              Go to line
            </button>
          )}
          <button
            onClick={() => setSendReport(null)}
            className="p-1 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] flex-shrink-0"
            title="Dismiss"
            aria-label="Dismiss send report"
          >
            <X size={12} />
          </button>
        </div>
      )}

      {/* How far the last send got, matching the bars beside the line numbers. */}
      {lastSend && lastSend.bufferId === active.id && (
        <div
          className="flex items-center gap-2 px-3 py-1 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)] text-[10px] flex-shrink-0"
          title={sendMarkSummary(lastSend.marks)}
        >
          <span className="text-[var(--text-muted)] flex-shrink-0">
            Last send to {lastSend.target},{' '}
            {new Date(lastSend.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}:
          </span>
          <span className="flex items-center gap-2 min-w-0 flex-wrap">
            {sendMarkCounts(lastSend.marks).map(({ state, count, words }) => (
              <span key={state} className="flex items-center gap-1 text-[var(--text-secondary)]">
                <span className="inline-block w-[3px] h-2.5 rounded-sm" style={{ background: SEND_MARK_COLOR[state] }} />
                {count} {words}
              </span>
            ))}
          </span>
          <span className="flex-1" />
          <button
            onClick={() => setLastSend(null)}
            className="px-1.5 py-0.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] flex-shrink-0"
            title="Remove the bars beside the line numbers"
          >
            Clear marks
          </button>
        </div>
      )}

      {/* Reviewing an AI suggestion: what it covers, and Apply / Discard. */}
      {reviewing && (
        <div className="flex items-start gap-2 px-3 py-2 border-b border-[var(--bg-tertiary)] bg-[var(--accent-violet-soft)] text-xs flex-shrink-0">
          <Sparkles size={13} className="text-[var(--accent-violet)] mt-0.5 flex-shrink-0" />
          <div className="flex-1 min-w-0 text-[var(--text-primary)]">
            <div className="font-medium">AI suggestion for {aiReview!.where}</div>
            <div className="text-[11px] text-[var(--text-secondary)]">
              Left: your tab · Right: the suggestion. The arrow beside a change drops it; you can also edit the right side.
              {aiReview!.restored > 0 &&
                ` ${aiReview!.restored} secret ${aiReview!.restored === 1 ? 'line was' : 'lines were'} put back from your tab.`}
            </div>
            {aiReview!.markersLeft > 0 && (
              <div className="flex items-center gap-1 mt-0.5 text-[11px] text-[var(--accent-warning)]">
                <AlertTriangle size={11} className="flex-shrink-0" />
                {aiReview!.markersLeft} {aiReview!.markersLeft === 1 ? 'line still says' : 'lines still say'} &lt;secret hidden&gt;: put
                the real value in before sending.
              </div>
            )}
          </div>
          <button
            onClick={applyAiReview}
            className="px-2.5 py-1 text-xs rounded bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-[var(--accent-fg)] flex-shrink-0"
          >
            Apply
          </button>
          <button
            onClick={discardAiReview}
            className="px-2.5 py-1 text-xs rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] flex-shrink-0"
          >
            Discard
          </button>
        </div>
      )}

      {/* What the diff compares against — and a warning when a pulled
          baseline is from a different device than the active session. */}
      {diffMode && diffSource && (
        <div className="flex items-center gap-3 px-3 py-1 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)] text-[10px] text-[var(--text-muted)] flex-shrink-0">
          <span className="truncate">
            Left: {diffSource.label} · Right: this tab (edit it here; the arrow beside a change takes the left side)
          </span>
          {diffSource.device && activeSession && diffSource.device !== deviceKey(activeSession.config) && (
            <span className="flex items-center gap-1 text-[var(--accent-warning)] flex-shrink-0">
              <AlertTriangle size={10} />
              Not from the active session ({activeSession.config.name || activeSession.config.host})
            </span>
          )}
        </div>
      )}

      {/* Monaco Editor, with the folder tree on its left */}
      <div className="flex-1 flex min-h-0">
      {showFolder && folder && (
        <FolderPane
          listing={folder}
          activePath={relativeTo(folder.root, active.filePath)}
          loading={folderLoading}
          onOpen={(entry) => void openFromFolder(entry)}
          onPickFolder={() => void pickFolder()}
          onRefresh={() => void loadFolder(folder.root)}
          onClose={() => setShowFolder(false)}
        />
      )}
      <div className="flex-1 overflow-hidden min-w-0">
        {reviewing ? (
          <DiffEditor
            key={`review-${active.id}`}
            original={content}
            modified={aiReview!.proposed}
            language={language}
            theme={editorTheme}
            beforeMount={setupMonaco}
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            onMount={(diffEditor) => {
              disposeDiffModels();
              const { original: leftModel, modified: rightModel } = diffEditor.getModel() ?? {};
              if (leftModel && rightModel) diffModelsRef.current.push(leftModel, rightModel);
              reviewRightRef.current = diffEditor.getModifiedEditor();
            }}
            options={{
              readOnly: false,
              originalEditable: false,
              renderMarginRevertIcon: true,
              fixedOverflowWidgets: true,
              fontSize: fontSize,
              fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
              lineHeight: Math.round(fontSize * 1.5),
              mouseWheelZoom: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderSideBySide: true,
            }}
          />
        ) : diffMode ? (
          <DiffEditor
            // One per tab, so a tab switch never feeds one tab's text into another.
            key={active.id}
            original={diffOriginal}
            modified={content}
            language={language}
            theme={editorTheme}
            beforeMount={setupMonaco}
            // The right side is the tab itself: edits there land in the tab,
            // and the arrow beside a change takes the left side's lines.
            keepCurrentOriginalModel
            keepCurrentModifiedModel
            onMount={(diffEditor) => {
              disposeDiffModels(); // the view this one replaced (a tab switch)
              const { original: leftModel, modified: rightModel } = diffEditor.getModel() ?? {};
              if (leftModel && rightModel) diffModelsRef.current.push(leftModel, rightModel);
              const bufferId = active.id;
              const right = diffEditor.getModifiedEditor();
              right.onDidChangeModelContent(() => {
                const next = right.getValue();
                setBuffers((prev) =>
                  prev.map((b) => (b.id === bufferId && b.content !== next ? { ...b, content: next, dirty: true } : b))
                );
              });
            }}
            options={{
              readOnly: false,
              originalEditable: false,
              renderMarginRevertIcon: true,
              fixedOverflowWidgets: true,
              fontSize: fontSize,
              fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
              lineHeight: Math.round(fontSize * 1.5),
              mouseWheelZoom: true,
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderSideBySide: true,
            }}
          />
        ) : (
        <Editor
          // One Monaco model per buffer — keeps undo history and view state per tab.
          path={active.id}
          language={language}
          value={content}
          theme={editorTheme}
          onChange={(v) => {
            const next = v ?? '';
            setContent(next);
            setIsDirty(true);
            // Language auto-detect runs from a debounced effect (see above) so it
            // isn't re-scanned on every keystroke.
          }}
          beforeMount={setupMonaco}
          onMount={handleEditorMount}
          options={{
            // Follow the persisted terminal font size (W2-11): Ctrl+= / Ctrl+-
            // / Ctrl+0 and pinch-zoom land in setFontSize via App.tsx and flow
            // here through the settings store — so editor zoom matches the
            // terminals and survives restarts. mouseWheelZoom gives native
            // Ctrl+wheel zoom inside the editor.
            fontSize: fontSize,
            fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
            lineHeight: Math.round(fontSize * 1.5),
            mouseWheelZoom: true,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            renderLineHighlight: 'gutter',
            cursorBlinking: 'smooth',
            smoothScrolling: true,
            padding: { top: 12, bottom: 12 },
            // Problem marks in the scrollbar, like VS Code.
            hideCursorInOverviewRuler: true,
            // Hover cards and suggestions float over the panel edges instead
            // of being cut off by the side panel (a card above line 4 lost its top).
            fixedOverflowWidgets: true,
            renderWhitespace: 'none',
            folding: true,
            // A double-click picks 1/1/5 or ge-0/0/0.100 whole in device configs.
            wordSeparators: wordSeparatorsFor(language),
            // The block you're in (interface 1/1/1, vlan 10, a Junos { }) stays on top as you scroll.
            stickyScroll: { enabled: true, defaultModel: 'indentationModel' },
            lineNumbersMinChars: 3,
            contextmenu: true,
            quickSuggestions: true,
            suggestOnTriggerCharacters: true,
            acceptSuggestionOnEnter: 'smart',
            bracketPairColorization: { enabled: true },
            guides: { bracketPairs: true },
          }}
        />
        )}
      </div>
      </div>
      {showProblems && (
        <ProblemsPanel
          problems={problems}
          capped={baseProblems.length >= MAX_PROBLEMS}
          disabled={diffMode}
          onJump={jumpToProblem}
          onClose={() => setShowProblems(false)}
        />
      )}
      <EditorStatusBar
        session={sendTarget}
        pulled={sendTargetPull}
        editorLanguage={language}
        lineCount={lineCount}
      />
      {/* Config archive modal (NW-16) — history, golden mark, current/golden +
          current/previous diffs via the same Monaco DiffEditor as the panel */}
      {showArchive && (
        <ConfigArchive
          onOpenSnapshot={(name, content, language) =>
            openInNewTab({
              name,
              content,
              language,
              filePath: null,
              dirty: false,
              langExplicit: false,
            })
          }
          onClose={() => setShowArchive(false)}
        />
      )}
    </div>
  );
}
