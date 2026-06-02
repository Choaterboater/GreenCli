import { useState, useRef, useEffect, useCallback } from 'react';
import Editor, { DiffEditor, OnMount } from '@monaco-editor/react';
import type { editor as MonacoEditor } from 'monaco-editor';
import {
  X,
  FileCode,
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
  Maximize2,
  Minimize2,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { open as openDialog, save as saveDialog } from '@tauri-apps/api/dialog';
import { useSessionStore } from '../store/sessionStore';
import { sleep, stripAnsi as stripAnsiUtil, hasAnsi, sendAndCapture } from '../utils/terminal';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { askConfirm } from '../store/dialogStore';

// ─── Tauri / browser file I/O ───

const isTauri = typeof window !== 'undefined' && '__TAURI__' in window;

async function tauriOpen(): Promise<string | null> {
  const result = await openDialog({
    title: 'Open File',
    filters: [{ name: 'All Files', extensions: ['*'] }],
    multiple: false,
  });
  return typeof result === 'string' ? result : null;
}

async function tauriSave(defaultName: string): Promise<string | null> {
  const result = await saveDialog({
    title: 'Save File',
    defaultPath: defaultName,
    filters: [{ name: 'All Files', extensions: ['*'] }],
  });
  return result ?? null;
}

// Read/write via Rust commands rather than the webview `fs` API, which is
// scope-limited (it refuses arbitrary paths like ~/Downloads/...) and chokes on
// non-UTF8 bytes common in terminal-capture logs.
async function tauriReadText(path: string): Promise<string> {
  return invoke<string>('read_file_text', { path });
}

async function tauriWriteText(path: string, data: string): Promise<void> {
  await invoke('write_file_text', { path, contents: data });
}

// Strip terminal/ANSI control sequences so captured logs (PuTTY/`show tech`,
// shared utils
const stripTerminalSequences = stripAnsiUtil;
const looksLikeTerminalCapture = hasAnsi;

function browserOpen(): Promise<{ name: string; content: string } | null> {
  return new Promise((resolve) => {
    const input = document.createElement('input');
    input.type = 'file';
    // accept everything
    input.onchange = () => {
      const file = input.files?.[0];
      if (!file) { resolve(null); return; }
      const reader = new FileReader();
      reader.onload = (e) => resolve({ name: file.name, content: e.target?.result as string ?? '' });
      reader.onerror = () => resolve(null);
      reader.readAsText(file);
    };
    input.oncancel = () => resolve(null);
    input.click();
  });
}

function browserSave(content: string, filename: string) {
  const blob = new Blob([content], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

function basename(path: string): string {
  return path.replace(/\\/g, '/').split('/').pop() || path;
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

const LANGUAGE_LIST = [
  { id: 'aruba-cx',         label: 'Aruba CX' },
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
vlan 10
  name MGMT
vlan 20
  name USERS
vlan 30
  name GUEST
vlan 100
  name VOICE
`,
  'Aruba: Trunk port': `! Uplink trunk port
interface 1/1/1
  no shutdown
  description Uplink-Core
  vlan trunk native 10
  vlan trunk allowed 10,20,30,100
`,
  'Aruba: Access port': `! Access port (users)
interface 1/1/3-1/1/48
  no shutdown
  vlan access 20
`,
  'Aruba: BGP peer': `! BGP configuration
router bgp 65001
  bgp router-id 10.0.0.1
  neighbor 10.0.0.2 remote-as 65002
  neighbor 10.0.0.2 description Core-Peer
  address-family ipv4 unicast
    neighbor 10.0.0.2 activate
`,
  'Aruba: OSPF': `! OSPF configuration
router ospf 1
  router-id 10.0.0.1
  area 0.0.0.0
interface vlan 10
  ip ospf 1 area 0.0.0.0
  ip ospf network point-to-point
`,
  'Aruba: AAA / RADIUS': `! RADIUS / AAA
radius-server host 10.0.0.100
  key plaintext MySecret123
  authentication port 1812
  accounting port 1813
aaa authentication login default group radius local
aaa authorization commands default group radius local
`,
  'Junos: VLANs': `/* Juniper Junos — VLANs (set-style) */
set vlans MGMT vlan-id 10
set vlans USERS vlan-id 20
set vlans GUEST vlan-id 30
set vlans VOICE vlan-id 100
`,
  'Junos: Trunk port': `/* Junos — trunk uplink */
set interfaces ge-0/0/0 description Uplink-Core
set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode trunk
set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members [ MGMT USERS GUEST VOICE ]
set interfaces ge-0/0/0 native-vlan-id 10
`,
  'Junos: Access port': `/* Junos — access port */
set interfaces ge-0/0/3 unit 0 family ethernet-switching interface-mode access
set interfaces ge-0/0/3 unit 0 family ethernet-switching vlan members USERS
`,
  'Junos: BGP peer': `/* Junos — BGP */
set routing-options autonomous-system 65001
set protocols bgp group EBGP type external
set protocols bgp group EBGP neighbor 10.0.0.2 peer-as 65002
set protocols bgp group EBGP neighbor 10.0.0.2 description Core-Peer
`,
  'Junos: OSPF': `/* Junos — OSPF */
set protocols ospf area 0.0.0.0 interface ge-0/0/0.0 interface-type p2p
set protocols ospf area 0.0.0.0 interface irb.10
`,
  'Apstra configlet: NTP': `/* Apstra configlet (Junos) — NTP. Paste the body into an Apstra
   configlet (style "junos", section "system"); assign by role/tag. */
set system ntp server 10.0.0.1 prefer
set system ntp server 10.0.0.2
set system time-zone UTC
`,
  'Apstra configlet: SNMPv3': `/* Apstra configlet (Junos) — SNMPv3 */
set snmp v3 usm local-engine user netops authentication-sha authentication-key "<sha>"
set snmp v3 usm local-engine user netops privacy-aes128 privacy-key "<aes>"
set snmp v3 vacm security-to-group security-model usm security-name netops group ro
set snmp v3 vacm access group ro default-context-prefix security-model usm security-level privacy read-view all
set snmp view all oid .1
`,
  'Apstra configlet: Syslog': `/* Apstra configlet (Junos) — remote syslog */
set system syslog host 10.0.0.10 any info
set system syslog host 10.0.0.10 source-address 10.10.10.1
`,

  // ─── Juniper Validated Design starters (Junos) — edit ids/addresses ───
  'JVD: EVPN-VXLAN leaf (ERB)': `/* JVD EVPN-VXLAN — leaf (edge-routed bridging). Replace ASNs/IPs/VNIs. */
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
`,

  'JVD: EVPN-VXLAN spine (route-reflector)': `/* JVD EVPN-VXLAN — spine (underlay + EVPN route-reflector). */
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
`,

  'JVD: AI fabric RoCE QoS (PFC+ECN)': `/* JVD AI/GPU fabric — lossless RoCEv2: PFC on priority 3, ECN marking. */
set class-of-service classifiers dscp ROCE forwarding-class NO-LOSS loss-priority low code-points 011010
set class-of-service forwarding-classes class NO-LOSS queue-num 3 no-loss
set class-of-service congestion-notification-profile ECN input ieee-802.1 code-point 011 pfc
set class-of-service interfaces et-0/0/0 congestion-notification-profile ECN
set class-of-service interfaces et-0/0/0 unit 0 classifiers dscp ROCE
set class-of-service drop-profiles ECN-DP interpolate fill-level 30 drop-probability 0
set class-of-service drop-profiles ECN-DP interpolate fill-level 100 drop-probability 100
set class-of-service forwarding-classes class NO-LOSS explicit-congestion-notification
`,

  'JVD: EVPN campus access (EX)': `/* JVD EVPN campus — access switch VLAN/VNI + uplink. */
set interfaces ge-0/0/0 unit 0 family ethernet-switching interface-mode access vlan members V100
set interfaces ae0 unit 0 family ethernet-switching interface-mode trunk vlan members all
set vlans V100 vlan-id 100
set vlans V100 vxlan vni 10100
set switch-options vtep-source-interface lo0.0
set protocols evpn encapsulation vxlan
set protocols evpn extended-vni-list all
`,
};

const ARUBA_KEYWORDS = [
  // Aruba AOS-CX / AOS-S
  'show', 'configure', 'interface', 'vlan', 'router', 'ip', 'aaa',
  'ntp', 'snmp', 'logging', 'spanning-tree', 'lacp', 'bgp', 'ospf',
  'no', 'shutdown', 'description', 'access', 'trunk', 'native',
  'allowed', 'remote-as', 'neighbor', 'area', 'network', 'exit',
  'write', 'copy', 'ping', 'traceroute', 'end', 'hostname', 'username',
  'password', 'enable', 'disable', 'default', 'address-family',
  'unicast', 'activate', 'route-map', 'prefix-list', 'permit', 'deny',
  // Juniper Junos (set-style + hierarchy)
  'set', 'delete', 'commit', 'rollback', 'family', 'ethernet-switching',
  'interface-mode', 'members', 'vlan-id', 'vlans', 'protocols',
  'routing-options', 'autonomous-system', 'group', 'peer-as', 'unit',
  'inet', 'native-vlan-id', 'irb', 'p2p',
];

// ─── Component ───

export default function ConfigEditor() {
  const { showConfigEditor, toggleConfigEditor, activeSessionId, sessions } =
    useSessionStore();

  const { width: panelWidth, onDragStart: handleDragStart, handleClass: dragHandleClass } =
    useResizablePanel(520, 300, 900);
  const [maximized, setMaximized] = useState(false);

  const [content, setContent] = useState<string>(
    '! Aruba CX Configuration\n! Start typing, open a file, or pick a template\n\n'
  );
  const contentRef = useRef(content);

  const [language, setLanguage] = useState('aruba-cx');
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [isDirty, setIsDirty] = useState(false);

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

  const [showTemplates, setShowTemplates] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [langSearch, setLangSearch] = useState('');

  const [sending, setSending] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);

  // Holds the original (uncleaned) text when an opened file had terminal escapes,
  // so the user can toggle back to the raw capture.
  const rawCaptureRef = useRef<string | null>(null);
  const [viewingRaw, setViewingRaw] = useState(false);

  // Diff mode: compare current editor content against a loaded baseline.
  const [diffMode, setDiffMode] = useState(false);
  const [diffOriginal, setDiffOriginal] = useState('');

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const saveFileRef = useRef<(forcePicker?: boolean) => Promise<void>>();
  const openFileRef = useRef<() => Promise<void>>();

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);

  useEffect(() => { contentRef.current = content; }, [content]);

  const showStatus = (msg: string) => {
    setStatusMsg(msg);
    setTimeout(() => setStatusMsg(null), 3000);
  };

  // ─── File open ───

  // Apply terminal-capture cleaning if needed; returns the text to display.
  const ingest = (name: string, text: string) => {
    if (looksLikeTerminalCapture(text)) {
      rawCaptureRef.current = text;
      setViewingRaw(false);
      const cleaned = stripTerminalSequences(text);
      setContent(cleaned);
      showStatus(`Opened ${name} — cleaned terminal escapes (toggle Raw to see original)`);
    } else {
      rawCaptureRef.current = null;
      setViewingRaw(false);
      setContent(text);
      showStatus(`Opened ${name}`);
    }
  };

  const openFile = useCallback(async () => {
    if (!(await confirmDiscard())) return;
    try {
      if (isTauri) {
        const path = await tauriOpen();
        if (!path) return;
        const text = await tauriReadText(path);
        setLanguage(detectLanguage(path));
        setCurrentFilePath(path);
        setIsDirty(false);
        ingest(basename(path), text);
      } else {
        const result = await browserOpen();
        if (!result) return;
        setLanguage(detectLanguage(result.name));
        setCurrentFilePath(result.name);
        setIsDirty(false);
        ingest(result.name, result.content);
      }
    } catch (e) {
      showStatus(`Open failed: ${e}`);
    }
  }, []);

  // Toggle between the cleaned view and the raw capture.
  const toggleRaw = useCallback(() => {
    const raw = rawCaptureRef.current;
    if (raw == null) return;
    if (viewingRaw) {
      setContent(stripTerminalSequences(raw));
      setViewingRaw(false);
    } else {
      setContent(raw);
      setViewingRaw(true);
    }
  }, [viewingRaw]);

  // Manually strip escapes from whatever is currently in the editor.
  const cleanCurrent = useCallback(() => {
    setContent((c) => stripTerminalSequences(c));
    setIsDirty(true);
    showStatus('Stripped terminal escapes');
  }, []);

  // Pull the active device's running-config into the editor (terminal read-back).
  const pullRunningConfig = useCallback(async () => {
    if (!activeSession?.connected) {
      showStatus('Connect a session first');
      return;
    }
    if (!(await confirmDiscard())) return;
    const sid = activeSession.sessionId;
    showStatus('Pulling running-config…');
    try {
      // Per-vendor paging control + running-config command. AOS-CX/AOS-S use
      // `no page` (NOT `no paging`); ArubaOS controllers use `no paging`; Junos
      // pipes `| no-more`. Paging is restored afterward so the live session
      // isn't left changed.
      const PAGING: Record<string, { disable?: string; restore?: string; show: string }> = {
        'aruba-cx': { disable: 'no page', restore: 'page', show: 'show running-config' },
        'aruba-aos-s': { disable: 'no page', restore: 'page', show: 'show running-config' },
        'aruba-controller': { disable: 'no paging', restore: 'paging', show: 'show running-config' },
        'aruba-ap': { show: 'show running-config' },
        'juniper-junos': { show: 'show configuration | no-more' },
        mist: { show: 'show configuration | no-more' },
        generic: { show: 'show running-config' },
      };
      const vp = PAGING[activeSession.config.deviceType] ?? PAGING.generic;
      if (vp.disable) {
        await invoke('send_data', { sessionId: sid, data: vp.disable + '\r' });
        await sleep(300);
      }
      const out = await sendAndCapture(sid, vp.show);
      if (vp.restore) {
        await invoke('send_data', { sessionId: sid, data: vp.restore + '\r' });
        await sleep(150);
      }
      if (!out) {
        showStatus('No output captured');
        return;
      }
      rawCaptureRef.current = null;
      setViewingRaw(false);
      setContent(out);
      setLanguage('aruba-cx');
      setCurrentFilePath(null);
      setIsDirty(true);
      showStatus('Running-config pulled');
    } catch (e) {
      showStatus(`Pull failed: ${e}`);
    }
  }, [activeSession]);

  // Open a baseline file and diff it against the current editor content.
  const openDiffAgainst = useCallback(async () => {
    try {
      let text: string | null = null;
      if (isTauri) {
        const p = await tauriOpen();
        if (!p) return;
        text = await tauriReadText(p);
      } else {
        const r = await browserOpen();
        if (!r) return;
        text = r.content;
      }
      if (text == null) return;
      setDiffOriginal(looksLikeTerminalCapture(text) ? stripTerminalSequences(text) : text);
      setDiffMode(true);
      showStatus('Diff: left = baseline file, right = editor');
    } catch (e) {
      showStatus(`Diff open failed: ${e}`);
    }
  }, []);

  // ─── File save ───

  const saveFile = useCallback(async (forcePicker = false) => {
    const text = contentRef.current;
    try {
      if (isTauri) {
        let path = currentFilePath && !forcePicker ? currentFilePath : null;
        if (!path) {
          const defaultName = currentFilePath ? basename(currentFilePath) : 'untitled.txt';
          path = await tauriSave(defaultName);
        }
        if (!path) return;
        await tauriWriteText(path, text);
        setCurrentFilePath(path);
        setLanguage(detectLanguage(path));
        setIsDirty(false);
        showStatus(`Saved ${basename(path)}`);
      } else {
        const name = currentFilePath ? basename(currentFilePath) : 'untitled.txt';
        browserSave(text, name);
        setIsDirty(false);
        showStatus(`Downloaded ${name}`);
      }
    } catch (e) {
      showStatus(`Save failed: ${e}`);
    }
  }, [currentFilePath]);

  useEffect(() => { saveFileRef.current = saveFile; }, [saveFile]);
  useEffect(() => { openFileRef.current = openFile; }, [openFile]);

  // ─── Monaco mount ───

  const handleEditorMount: OnMount = (ed, monaco) => {
    editorRef.current = ed;

    // Register custom Aruba CX language
    monaco.languages.register({ id: 'aruba-cx' });
    monaco.languages.setMonarchTokensProvider('aruba-cx', {
      keywords: ARUBA_KEYWORDS,
      tokenizer: {
        root: [
          [/^!.*$/, 'comment'],
          [/\b(?:\d{1,3}\.){3}\d{1,3}(?:\/\d{1,2})?\b/, 'number.float'],
          [/\b\d+\/\d+\/\d+\b/, 'type'],
          [/\bvlan\s+\d+\b/, 'keyword'],
          [/\b\d+\b/, 'number'],
          [
            /\b(?:show|configure|interface|vlan|router|ip|aaa|ntp|snmp|bgp|ospf|no|shutdown|description|access|trunk|native|allowed|exit|write|ping|end|hostname|username|password|enable|disable|neighbor|area|network|route-map|prefix-list|permit|deny|address-family|unicast|activate)\b/,
            'keyword',
          ],
          [/".*?"/, 'string'],
          [/'.*?'/, 'string'],
        ],
      },
    } as Parameters<typeof monaco.languages.setMonarchTokensProvider>[1]);

    monaco.editor.defineTheme('aruba-dark', {
      base: 'vs-dark',
      inherit: true,
      rules: [
        { token: 'comment', foreground: '6a737d', fontStyle: 'italic' },
        { token: 'keyword', foreground: 'e06c75' },
        { token: 'number', foreground: '56b6c2' },
        { token: 'number.float', foreground: '98c379' },
        { token: 'type', foreground: 'e5c07b' },
        { token: 'string', foreground: 'abb2bf' },
      ],
      colors: {
        'editor.background': '#0d1117',
        'editor.foreground': '#c9d1d9',
        'editor.lineHighlightBackground': '#161b2240',
        'editor.selectionBackground': '#264f7880',
        'editorLineNumber.foreground': '#484f58',
        'editorLineNumber.activeForeground': '#8b949e',
        'editorCursor.foreground': '#58a6ff',
        'editorWhitespace.foreground': '#30363d',
        'editorIndentGuide.background': '#21262d',
        'editorIndentGuide.activeBackground': '#30363d',
        'scrollbarSlider.background': '#21262d80',
        'scrollbarSlider.hoverBackground': '#30363d',
      },
    });
    monaco.editor.setTheme('aruba-dark');

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
  };

  // ─── Send to terminal ───

  const sendToTerminal = async () => {
    if (!activeSession || !content.trim()) return;
    if (!activeSession.connected) {
      showStatus('Not connected — connect the session first');
      return;
    }
    setSending(true);

    const lines = content
      .split('\n')
      .map((l) => l.trim())
      // Strip INLINE Junos block comments /* ... */ rather than dropping the whole
      // line — "/* uplink */ set interfaces ..." must keep its `set` command.
      .map((l) => l.replace(/\/\*.*?\*\//g, '').trim())
      // Drop pure comment lines for every supported vendor: Aruba/Cisco '!' '#',
      // now-empty comment-only lines, and lone Junos block delimiters.
      .filter((l) => l && !l.startsWith('!') && !l.startsWith('#') && !l.startsWith('/*') && !l.startsWith('*/'));

    try {
      for (const line of lines) {
        await invoke('send_data', { sessionId: activeSession.sessionId, data: line + '\r' });
        await new Promise((r) => setTimeout(r, 80));
      }
      showStatus(`Sent ${lines.length} lines`);
    } catch {
      showStatus('Send failed — is a session connected?');
    } finally {
      setSending(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(content).catch(() => {});
    showStatus('Copied');
  };

  const loadTemplate = async (name: string) => {
    if (!(await confirmDiscard())) return;
    setContent(TEMPLATES[name]);
    setLanguage('aruba-cx');
    setCurrentFilePath(null);
    setIsDirty(false);
    setShowTemplates(false);
  };


  if (!showConfigEditor) return null;

  const displayName = currentFilePath ? basename(currentFilePath) : null;
  const currentLangLabel = LANGUAGE_LIST.find((l) => l.id === language)?.label || language;
  const filteredLangs = LANGUAGE_LIST.filter((l) =>
    l.label.toLowerCase().includes(langSearch.toLowerCase()) ||
    l.id.toLowerCase().includes(langSearch.toLowerCase())
  );

  return (
    <div
      className={
        maximized
          ? 'fixed left-0 right-0 bottom-0 top-11 z-40 flex flex-col bg-[var(--bg-primary)] overflow-hidden animate-fade-in'
          : 'flex-shrink-0 flex flex-col bg-[var(--bg-primary)] border-l border-[var(--bg-tertiary)] overflow-hidden relative'
      }
      style={maximized ? undefined : { width: panelWidth }}
    >
      {/* Drag handle (hidden when maximized) */}
      {!maximized && <div className={dragHandleClass} onMouseDown={handleDragStart} />}

      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 pl-4 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode size={14} className="text-[var(--accent-warning)] flex-shrink-0" />
          <span className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider flex-shrink-0">
            Editor
          </span>
          {displayName ? (
            <span className="text-[10px] text-[var(--text-secondary)] truncate max-w-[160px]" title={currentFilePath ?? ''}>
              {isDirty && <span className="text-[var(--accent-warning)]">● </span>}{displayName}
            </span>
          ) : (
            <span className="text-[10px] text-[var(--text-muted)]">untitled</span>
          )}
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={copyToClipboard} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="Copy all">
            <Copy size={13} />
          </button>
          <button onClick={async () => { if (!(await confirmDiscard())) return; setContent(''); setCurrentFilePath(null); setIsDirty(false); }} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent-danger)]" title="Clear">
            <FileX size={13} />
          </button>
          <button
            onClick={() => setMaximized((m) => !m)}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title={maximized ? 'Restore to side panel' : 'Maximize editor'}
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button onClick={async () => { if (!(await confirmDiscard())) return; toggleConfigEditor(); }} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent-danger)]" title="Close">
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Toolbar */}
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">

        {/* File actions — icon-only group with tooltips */}
        <div className="flex items-center gap-0.5">
          <button
            onClick={openFile}
            className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Open file (Ctrl+O)"
          >
            <FolderOpen size={13} />
          </button>
          <button
            onClick={() => saveFile(false)}
            className={`p-1.5 rounded transition-colors ${
              isDirty ? 'text-[var(--accent-warning)] hover:bg-[#e5c07b20]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
            }`}
            title={currentFilePath ? 'Save (Ctrl+S)' : 'Save As… (Ctrl+S)'}
          >
            <Download size={13} />
          </button>
          <button
            onClick={cleanCurrent}
            className="p-1.5 rounded text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] transition-colors"
            title="Strip ANSI / terminal control codes"
          >
            <Eraser size={13} />
          </button>
          {rawCaptureRef.current != null && (
            <button
              onClick={toggleRaw}
              className={`px-1.5 py-1 text-[10px] rounded transition-colors ${
                viewingRaw ? 'text-[var(--accent-warning)] bg-[#e5c07b20]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
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
            onClick={() => { setShowLangPicker(!showLangPicker); setLangSearch(''); setShowTemplates(false); }}
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
                      onClick={() => { setLanguage(l.id); setShowLangPicker(false); }}
                      className={`flex items-center w-full px-3 py-1.5 text-xs text-left transition-colors ${
                        language === l.id
                          ? 'text-[var(--accent)] bg-[#58a6ff15]'
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
            onClick={() => { setShowTemplates(!showTemplates); setShowLangPicker(false); }}
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

        <div className="w-px h-4 bg-[var(--border)] mx-0.5" />

        {/* Pull running-config from the active device */}
        <button
          onClick={pullRunningConfig}
          disabled={!activeSession?.connected}
          className="flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors disabled:opacity-40 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
          title="Pull running-config from the active device"
        >
          <DownloadCloud size={12} />
          Pull
        </button>

        {/* Diff against a baseline file */}
        <button
          onClick={() => (diffMode ? setDiffMode(false) : openDiffAgainst())}
          className={`flex items-center gap-1.5 px-2 py-1 text-xs rounded transition-colors ${
            diffMode ? 'text-[var(--accent)] bg-[#58a6ff20]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]'
          }`}
          title="Compare the editor against a file"
        >
          <GitCompare size={12} />
          {diffMode ? 'Exit Diff' : 'Diff'}
        </button>

        <div className="flex-1" />

        {statusMsg && <span className="text-[10px] text-[var(--text-secondary)] mr-1">{statusMsg}</span>}

        {/* Send to terminal — only shown for aruba-cx */}
        {language === 'aruba-cx' && (
          <button
            onClick={sendToTerminal}
            disabled={sending || !activeSession?.connected}
            className="flex items-center gap-1.5 px-2.5 py-1 text-xs bg-[var(--accent)] hover:bg-[var(--accent-hover)] disabled:opacity-40 text-white rounded transition-colors"
            title={activeSession ? 'Send lines to terminal' : 'No active session'}
          >
            <Send size={12} />
            {sending ? 'Sending…' : 'Send'}
          </button>
        )}
      </div>

      {/* Monaco Editor */}
      <div className="flex-1 overflow-hidden">
        {diffMode ? (
          <DiffEditor
            original={diffOriginal}
            modified={content}
            language={language}
            theme="aruba-dark"
            options={{
              readOnly: true,
              fontSize: 13,
              fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
              minimap: { enabled: false },
              scrollBeyondLastLine: false,
              renderSideBySide: true,
            }}
          />
        ) : (
        <Editor
          language={language}
          value={content}
          onChange={(v) => { setContent(v ?? ''); setIsDirty(true); }}
          onMount={handleEditorMount}
          options={{
            fontSize: 13,
            fontFamily: 'JetBrains Mono, Consolas, "Courier New", monospace',
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'on',
            tabSize: 2,
            renderLineHighlight: 'gutter',
            cursorBlinking: 'smooth',
            smoothScrolling: true,
            padding: { top: 12, bottom: 12 },
            overviewRulerLanes: 0,
            hideCursorInOverviewRuler: true,
            renderWhitespace: 'none',
            folding: true,
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
  );
}
