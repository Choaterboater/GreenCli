import { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import Editor, { BeforeMount, DiffEditor, OnMount } from '@monaco-editor/react';
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
  ListTree,
  AlertTriangle,
  Plus,
  RefreshCw,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { open as openDialog, save as saveDialog } from '@tauri-apps/api/dialog';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { sleep, stripAnsi as stripAnsiUtil, hasAnsi, sendAndCapture } from '../utils/terminal';
import { useResizablePanel } from '../hooks/useResizablePanel';
import { askConfirm, askPrompt } from '../store/dialogStore';
import { generateId } from '../utils';
import { profileForSession } from '../utils/deviceProfiles';
import { ArubaHighlighter } from '../syntax';
import { useTheme } from '../hooks/useTheme';

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

// Same vendor detection the terminal uses, so pasting a device config into a
// blank editor lights up with CLI-style colors without picking a language.
const DEVICE_DETECTOR = ArubaHighlighter.forDeviceType('generic');
function detectConfigLanguage(text: string): string | null {
  if (text.length < 40) return null;
  const detected = DEVICE_DETECTOR.detectDeviceType(text.slice(0, 16_000));
  return detected === 'generic' ? null : detected;
}

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
  'AOS-S: VLAN + tagged uplink': `! Aruba AOS-S / ProVision
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
  'Mist/Junos: access switch baseline': `/* Mist-managed Junos switch baseline */
set system host-name <switch-name>
set system services ssh
set vlans USERS vlan-id 20
set interfaces ge-0/0/3 unit 0 family ethernet-switching interface-mode access
set interfaces ge-0/0/3 unit 0 family ethernet-switching vlan members USERS
commit confirmed 5 comment "GreenCLI staged access baseline"
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

const DANGEROUS_COMMANDS = [
  /\berase\b/i,
  /\bdelete\s+configuration\b/i,
  /\bdelete\s+system\b/i,
  /\bwrite\s+erase\b/i,
  /\breload\b/i,
  /\breboot\b/i,
  /\bshutdown\b/i,
  /\bno\s+interface\b/i,
  /\bcommit\b/i,
  /\bcopy\s+.*startup/i,
];

const EDITOR_SNIPPETS: Record<string, string> = {
  'Common: hostname': 'hostname ${hostname}\n',
  'Common: syslog + NTP': `logging \${syslog_server}
ntp server \${ntp_server}
`,
  'AOS-CX: access port': `interface \${interface}
    description \${description}
    no shutdown
    vlan access \${vlan_id}
`,
  'AOS-S: access port': `vlan \${vlan_id}
   name "\${vlan_name}"
   untagged \${port}
   exit
`,
  'Junos: access port': `set vlans \${vlan_name} vlan-id \${vlan_id}
set interfaces \${interface} unit 0 family ethernet-switching interface-mode access
set interfaces \${interface} unit 0 family ethernet-switching vlan members \${vlan_name}
`,
  'Junos/Mist: commit confirmed': 'commit confirmed 5 comment "GreenCLI change"\n',
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

interface OutlineItem {
  line: number;
  label: string;
}

function buildOutline(text: string): OutlineItem[] {
  const patterns = [
    /^\s*(interface\s+\S+)/i,
    /^\s*(vlan\s+\S+)/i,
    /^\s*(router\s+\S+(?:\s+\S+)?)/i,
    /^\s*(wlan\s+\S+(?:\s+\S+)?)/i,
    /^\s*(aaa\s+\S+)/i,
    /^\s*(set\s+(?:system|interfaces|vlans|protocols|routing-options|class-of-service)\b.*)/i,
  ];
  const items: OutlineItem[] = [];
  text.split('\n').forEach((line, index) => {
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match?.[1]) {
        items.push({ line: index + 1, label: match[1].trim() });
        break;
      }
    }
  });
  return items.slice(0, 100);
}

function buildDiagnostics(text: string, language: string): string[] {
  const diagnostics: string[] = [];
  if (hasAnsi(text)) diagnostics.push('Terminal escape/control codes found.');
  const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);
  const risky = lines.filter((line) => DANGEROUS_COMMANDS.some((pattern) => pattern.test(line)));
  if (risky.length) diagnostics.push(`${risky.length} risky command${risky.length === 1 ? '' : 's'} detected.`);
  if (/juniper|mist/.test(language) && lines.some((line) => /^(set|delete|replace)\b/i.test(line)) && !lines.some((line) => /^commit\b/i.test(line))) {
    diagnostics.push('Junos-style edits do not include a commit line.');
  }
  if (/\$\{[^}]+\}|<replace-me>|<[^>\n]{2,}>/.test(text)) {
    diagnostics.push('Template placeholders still need values.');
  }
  return diagnostics;
}

function summarizeLineDiff(original: string, next: string): string {
  if (!original.trim()) return 'No baseline loaded; review the command preview before sending.';
  const oldLines = original.split('\n').map((line) => line.trim()).filter(Boolean);
  const newLines = next.split('\n').map((line) => line.trim()).filter(Boolean);
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);
  const added = newLines.filter((line) => !oldSet.has(line));
  const removed = oldLines.filter((line) => !newSet.has(line));
  const examples = [
    ...added.slice(0, 3).map((line) => `+ ${line}`),
    ...removed.slice(0, 3).map((line) => `- ${line}`),
  ];
  return `Diff vs baseline: +${added.length} / -${removed.length}${examples.length ? `\n${examples.join('\n')}` : ''}`;
}

// ─── Editor themes ───
// Defined via beforeMount on both <Editor> and <DiffEditor> so the prop-driven
// theme (which follows the app's light/dark setting) always resolves.

const defineEditorThemes: BeforeMount = (monaco) => {
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
  monaco.editor.defineTheme('aruba-light', {
    base: 'vs',
    inherit: true,
    rules: [
      { token: 'comment', foreground: '6e7781', fontStyle: 'italic' },
      { token: 'keyword', foreground: 'cf222e' },
      { token: 'number', foreground: '0e7490' },
      { token: 'number.float', foreground: '1a7f37' },
      { token: 'type', foreground: '9a6700' },
      { token: 'string', foreground: '57606a' },
    ],
    colors: {
      'editor.background': '#ffffff',
      'editor.foreground': '#1f2328',
      'editor.lineHighlightBackground': '#f4f7f980',
      'editor.selectionBackground': '#add6ff80',
      'editorLineNumber.foreground': '#8c959f',
      'editorLineNumber.activeForeground': '#57606a',
      'editorCursor.foreground': '#0969da',
      'editorWhitespace.foreground': '#d0d7de',
      'editorIndentGuide.background': '#eaeef2',
      'editorIndentGuide.activeBackground': '#d0d7de',
      'scrollbarSlider.background': '#d0d7de80',
      'scrollbarSlider.hoverBackground': '#afb8c1',
    },
  });
};

// ─── Component ───

export default function ConfigEditor() {
  const { showConfigEditor, toggleConfigEditor, activeSessionId, sessions } =
    useSessionStore();
  const settings = useSettingsStore();
  const { isDark } = useTheme();
  const editorTheme = isDark ? 'aruba-dark' : 'aruba-light';

  const { width: panelWidth, onDragStart: handleDragStart, handleClass: dragHandleClass } =
    useResizablePanel(520, 300, 900);
  const [maximized, setMaximized] = useState(false);
  // With no sessions open, fill the whole area so it works as a plain text editor.
  const fullWidth = sessions.length === 0;

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
  const [showOutline, setShowOutline] = useState(false);
  const [showLangPicker, setShowLangPicker] = useState(false);
  const [showPullMenu, setShowPullMenu] = useState(false);
  const [langSearch, setLangSearch] = useState('');

  const [sending, setSending] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [statusMsg, setStatusMsg] = useState<string | null>(null);
  const sendingRef = useRef(false);

  // Holds the original (uncleaned) text per buffer when an opened file had
  // terminal escapes, so the user can toggle back to the raw capture.
  const rawCapturesRef = useRef<Map<string, string>>(new Map());
  const [viewingRawIds, setViewingRawIds] = useState<Record<string, boolean>>({});
  const viewingRaw = !!viewingRawIds[active.id];

  // Diff mode: compare current editor content against a loaded baseline.
  const [diffMode, setDiffMode] = useState(false);
  const [diffOriginal, setDiffOriginal] = useState('');

  const editorRef = useRef<MonacoEditor.IStandaloneCodeEditor | null>(null);
  const monacoRef = useRef<typeof import('monaco-editor') | null>(null);
  const saveFileRef = useRef<(forcePicker?: boolean) => Promise<void>>();
  const openFileRef = useRef<() => Promise<void>>();

  // path={buffer.id} gives each tab its own Monaco model, but the library never
  // disposes detached models — without this, every closed tab's full text stays
  // in monaco's global registry for the app's lifetime.
  const disposeBufferModel = useCallback((id: string) => {
    const monaco = monacoRef.current;
    if (!monaco) return;
    try {
      const model =
        monaco.editor.getModel(monaco.Uri.parse(id)) ??
        monaco.editor.getModels().find((m) => m.uri.path === `/${id}` || m.uri.toString() === id) ??
        null;
      model?.dispose();
    } catch {
      // best effort — a leaked model is preferable to a crash on close
    }
  }, []);

  // Panel close unmounts the component; Monaco only disposes the attached
  // model, so sweep the rest here.
  useEffect(
    () => () => {
      for (const b of buffersRef.current) disposeBufferModel(b.id);
    },
    [disposeBufferModel]
  );

  const activeSession = sessions.find((s) => s.sessionId === activeSessionId);
  const outlineItems = useMemo(() => buildOutline(content), [content]);
  const diagnostics = useMemo(() => buildDiagnostics(content, language), [content, language]);

  useEffect(() => { contentRef.current = content; }, [content]);

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
  const ingest = useCallback((name: string, filePath: string | null, text: string) => {
    const isCapture = looksLikeTerminalCapture(text);
    const patch = {
      name,
      filePath,
      content: isCapture ? stripTerminalSequences(text) : text,
      language: detectLanguage(name),
      dirty: false,
      langExplicit: false,
    };
    const activeBuf = buffersRef.current.find((b) => b.id === activeIdRef.current);
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
    try {
      if (isTauri) {
        const path = await tauriOpen();
        if (!path) return;
        const text = await tauriReadText(path);
        ingest(basename(path), path, text);
      } else {
        const result = await browserOpen();
        if (!result) return;
        ingest(result.name, result.name, result.content);
      }
    } catch (e) {
      showStatus(`Open failed: ${e}`);
    }
  }, [ingest]);

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

  const insertSnippet = useCallback((name: string) => {
    const snippet = EDITOR_SNIPPETS[name];
    if (!snippet) return;
    const editor = editorRef.current;
    if (!editor) {
      setContent((prev) => `${prev}${prev.endsWith('\n') ? '' : '\n'}${snippet}`);
      setIsDirty(true);
      return;
    }
    const model = editor.getModel();
    if (!model) return;
    const selection = editor.getSelection();
    editor.executeEdits('greencli-snippet', [
      {
        range: selection ?? model.getFullModelRange(),
        text: snippet,
        forceMoveMarkers: true,
      },
    ]);
    editor.focus();
    const next = editor.getValue();
    setContent(next);
    setIsDirty(true);
    setShowSnippets(false);
    showStatus(`Inserted ${name}`);
  }, []);

  const jumpToOutlineItem = useCallback((item: OutlineItem) => {
    const editor = editorRef.current;
    if (!editor) return;
    editor.revealLineInCenter(item.line);
    editor.setPosition({ lineNumber: item.line, column: 1 });
    editor.focus();
    setShowOutline(false);
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
      const profile = profileForSession(activeSession.config, settings.customDeviceProfiles);
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
      const out = await sendAndCapture(sid, show);
      if (restore) {
        await invoke('send_data', { sessionId: sid, data: restore + '\r' });
        await sleep(150);
      }
      if (!out) {
        showStatus('No output captured');
        return;
      }
      // Device grammars highlight show output fine (same as the terminal), so
      // show-command tabs get the session's device language too. dirty:true —
      // the capture exists nowhere else, so closing/clearing it must confirm
      // (same protection the old single-buffer pull had).
      openInNewTab({
        name: (command ?? show).replace(/\s*\|\s*no-more\s*$/i, '').trim() || label,
        content: out,
        language: profile.deviceType === 'generic' ? 'plaintext' : profile.deviceType,
        filePath: null,
        dirty: true,
        langExplicit: false,
      });
      if (command == null) {
        setDiffOriginal(out);
        showStatus('Running-config pulled; baseline saved');
      } else {
        showStatus(`Pulled ${label}`);
      }
    } catch (e) {
      showStatus(`Pull failed: ${e}`);
    } finally {
      setPulling(false);
    }
  }, [activeSession, settings.customDeviceProfiles, openInNewTab]);

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
    // Capture the buffer being saved up front: the save dialog + IPC write are
    // async, and the user may switch tabs mid-save — patch by id, not "active".
    const targetId = activeIdRef.current;
    const text = contentRef.current;
    const curPath = buffersRef.current.find((b) => b.id === targetId)?.filePath ?? null;
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
        patchTarget({ filePath: path, name: basename(path), language: detectLanguage(path), dirty: false });
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

    // Register network config languages. They share the same first-pass tokenizer;
    // profile-specific keywords/templates drive the safer workflows around it.
    const networkLanguageIds = ['aruba-cx', 'aruba-aos-s', 'aruba-ap', 'aruba-controller', 'juniper-junos', 'mist', 'generic'];
    networkLanguageIds.forEach((id) => monaco.languages.register({ id }));
    const networkTokenizer = {
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
    } as Parameters<typeof monaco.languages.setMonarchTokensProvider>[1];
    networkLanguageIds.forEach((id) => monaco.languages.setMonarchTokensProvider(id, networkTokenizer));

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
    const lines = content
      .split('\n')
      .map((l) => l.trim())
      // Strip INLINE Junos block comments /* ... */ rather than dropping the whole
      // line — "/* uplink */ set interfaces ..." must keep its `set` command.
      .map((l) => l.replace(/\/\*.*?\*\//g, '').trim())
      // Drop pure comment lines for every supported vendor: Aruba/Cisco '!' '#',
      // now-empty comment-only lines, and lone Junos block delimiters.
      .filter((l) => l && !l.startsWith('!') && !l.startsWith('#') && !l.startsWith('/*') && !l.startsWith('*/'));
    if (lines.length === 0) {
      showStatus('Nothing to send');
      return;
    }

    const risky = lines.filter((line) => DANGEROUS_COMMANDS.some((pattern) => pattern.test(line)));
    const diffSummary = summarizeLineDiff(diffOriginal, content);
    const preview = lines.slice(0, 12).join('\n');
    sendingRef.current = true;
    setSending(true);

    try {
      const ok = await askConfirm({
        title: `Send ${lines.length} line${lines.length === 1 ? '' : 's'} to ${activeSession.config.name || activeSession.config.host || 'device'}?`,
        message:
          `${risky.length ? `Potentially dangerous lines detected: ${risky.slice(0, 5).join(' | ')}\n\n` : ''}` +
          `${diffSummary}\n\n` +
          `Preview:\n${preview}${lines.length > 12 ? '\n…' : ''}`,
        confirmLabel: 'Send',
        danger: risky.length > 0,
      });
      if (!ok) return;

      for (const line of lines) {
        await invoke('send_data', { sessionId: activeSession.sessionId, data: line + '\r' });
        await new Promise((r) => setTimeout(r, 80));
      }
      showStatus(`Sent ${lines.length} lines`);
    } catch {
      showStatus('Send failed — is a session connected?');
    } finally {
      sendingRef.current = false;
      setSending(false);
    }
  };

  const copyToClipboard = () => {
    navigator.clipboard.writeText(content).catch(() => {});
    showStatus('Copied');
  };

  const loadTemplate = async (name: string) => {
    setShowTemplates(false);
    const buf = {
      name,
      content: TEMPLATES[name],
      language:
        name.startsWith('Junos') || name.startsWith('JVD') || name.startsWith('Apstra')
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


  if (!showConfigEditor) return null;

  const pullMenuItems = activeSession
    ? PULL_MENU[profileForSession(activeSession.config, settings.customDeviceProfiles).deviceType] ??
      PULL_MENU.generic
    : PULL_MENU.generic;
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
          : fullWidth
          ? 'flex-1 min-w-0 flex flex-col bg-[var(--bg-primary)] overflow-hidden relative'
          : 'flex-shrink-0 flex flex-col bg-[var(--bg-primary)] border-l border-[var(--bg-tertiary)] overflow-hidden relative'
      }
      style={maximized || fullWidth ? undefined : { width: panelWidth }}
    >
      {/* Drag handle (hidden when maximized or filling the area) */}
      {!maximized && !fullWidth && <div className={dragHandleClass} onMouseDown={handleDragStart} />}

      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 pl-4 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2 min-w-0">
          <FileCode size={14} className="text-[var(--accent-warning)] flex-shrink-0" />
          <span className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider flex-shrink-0">
            Editor
          </span>
          <span
            className={`text-[10px] truncate max-w-[160px] ${
              currentFilePath ? 'text-[var(--text-secondary)]' : 'text-[var(--text-muted)]'
            }`}
            title={currentFilePath ?? active.name}
          >
            {isDirty && <span className="text-[var(--accent-warning)]">● </span>}{active.name}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button onClick={copyToClipboard} className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]" title="Copy all">
            <Copy size={13} />
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
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent-danger)]"
            title="Clear"
          >
            <FileX size={13} />
          </button>
          <button
            onClick={() => setMaximized((m) => !m)}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title={maximized ? 'Restore to side panel' : 'Maximize editor'}
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            onClick={async () => {
              // Closing the panel drops ALL buffers — confirm if any tab is dirty.
              const dirtyCount = buffers.filter((b) => b.dirty).length;
              if (
                dirtyCount > 0 &&
                !(await askConfirm({
                  title: 'Discard unsaved changes?',
                  message: `${dirtyCount} editor tab${dirtyCount === 1 ? ' has' : 's have'} unsaved edits. They will be lost.`,
                  confirmLabel: 'Discard',
                  danger: true,
                }))
              )
                return;
              toggleConfigEditor();
            }}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--accent-danger)]"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

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
        >
          <Plus size={13} />
        </button>
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
          {rawCapturesRef.current.has(active.id) && (
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
            onClick={() => { setShowLangPicker(!showLangPicker); setLangSearch(''); setShowTemplates(false); setShowSnippets(false); setShowOutline(false); setShowPullMenu(false); }}
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
            onClick={() => { setShowTemplates(!showTemplates); setShowLangPicker(false); setShowSnippets(false); setShowOutline(false); setShowPullMenu(false); }}
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
            onClick={() => { setShowSnippets(!showSnippets); setShowTemplates(false); setShowLangPicker(false); setShowOutline(false); setShowPullMenu(false); }}
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
              <div className="absolute top-full left-0 mt-1 z-30 min-w-[220px] bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl py-1">
                {Object.keys(EDITOR_SNIPPETS).map((name) => (
                  <button
                    key={name}
                    onClick={() => insertSnippet(name)}
                    className="flex items-center gap-2 w-full px-3 py-1.5 text-xs text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] text-left"
                  >
                    {name}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        {/* Outline */}
        <div className="relative">
          <button
            onClick={() => { setShowOutline(!showOutline); setShowTemplates(false); setShowLangPicker(false); setShowSnippets(false); setShowPullMenu(false); }}
            className="flex items-center gap-1.5 px-2 py-1 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)] rounded transition-colors"
            title="Jump to interfaces, VLANs, routing sections, or Junos set blocks"
          >
            <ListTree size={12} />
            Outline
            <ChevronDown size={10} />
          </button>
          {showOutline && (
            <>
              <div className="fixed inset-0 z-20" onClick={() => setShowOutline(false)} />
              <div className="absolute top-full left-0 mt-1 z-30 w-72 max-h-64 overflow-y-auto bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg shadow-xl py-1">
                {outlineItems.length === 0 ? (
                  <p className="px-3 py-2 text-xs text-[var(--text-muted)]">No config sections found.</p>
                ) : (
                  outlineItems.map((item) => (
                    <button
                      key={`${item.line}-${item.label}`}
                      onClick={() => jumpToOutlineItem(item)}
                      className="grid grid-cols-[2.75rem_1fr] w-full px-3 py-1.5 text-xs text-left hover:bg-[var(--bg-tertiary)]"
                    >
                      <span className="text-[var(--text-muted)]">L{item.line}</span>
                      <span className="truncate text-[var(--text-primary)]">{item.label}</span>
                    </button>
                  ))
                )}
              </div>
            </>
          )}
        </div>

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
            onClick={() => { setShowPullMenu(!showPullMenu); setShowTemplates(false); setShowLangPicker(false); setShowSnippets(false); setShowOutline(false); }}
            disabled={!activeSession?.connected || pulling}
            className="flex items-center px-0.5 rounded-r transition-colors disabled:opacity-40 text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-tertiary)]"
            title="Pull other command output"
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

        {diagnostics.length > 0 && (
          <span
            className="flex items-center gap-1 text-[10px] text-[var(--accent-warning)] mr-1"
            title={diagnostics.join('\n')}
          >
            <AlertTriangle size={11} />
            {diagnostics.length}
          </span>
        )}
        {statusMsg && <span className="text-[10px] text-[var(--text-secondary)] mr-1">{statusMsg}</span>}

        {/* Send to terminal — confirmed before every send */}
        {activeSession && (
          <button
            onClick={sendToTerminal}
            disabled={sending || pulling || !activeSession?.connected}
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
            theme={editorTheme}
            beforeMount={defineEditorThemes}
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
          // One Monaco model per buffer — keeps undo history and view state per tab.
          path={active.id}
          language={language}
          value={content}
          theme={editorTheme}
          onChange={(v) => {
            const next = v ?? '';
            setContent(next);
            setIsDirty(true);
            if (language === 'plaintext' && !active.langExplicit) {
              const detected = detectConfigLanguage(next);
              if (detected) setLanguage(detected);
            }
          }}
          beforeMount={defineEditorThemes}
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
