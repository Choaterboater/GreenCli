export type Protocol = 'ssh' | 'telnet' | 'serial' | 'local';

// ── Multi-vendor model (HPE Networking: Aruba · Juniper · Mist) ──
export type Vendor = 'aruba' | 'juniper' | 'mist' | 'hpe' | 'generic';

export type DeviceType =
  | 'aruba-cx'        // Aruba AOS-CX switches
  | 'aruba-aos-s'     // Aruba AOS-S (ProVision / 2930/5400 etc.)
  | 'aruba-ap'        // Aruba InstantOS access points
  | 'aruba-controller'// ArubaOS Mobility Controller / Conductor
  | 'juniper-junos'   // Juniper Junos (EX/QFX/SRX/MX/ACX)
  | 'mist'            // Juniper Mist (cloud-managed switches/APs)
  | 'generic';

export interface VendorMeta {
  label: string;
  /** CSS custom property holding the vendor accent colour. */
  colorVar: string;
}

export const VENDOR_META: Record<Vendor, VendorMeta> = {
  hpe: { label: 'HPE', colorVar: 'var(--vendor-hpe)' },
  aruba: { label: 'Aruba', colorVar: 'var(--vendor-aruba)' },
  juniper: { label: 'Juniper', colorVar: 'var(--vendor-juniper)' },
  mist: { label: 'Mist', colorVar: 'var(--vendor-mist)' },
  generic: { label: 'Generic', colorVar: 'var(--vendor-generic)' },
};

export interface ConnectionConfig {
  id: string;
  name: string;
  protocol: Protocol;
  host?: string;
  port?: number;
  username?: string;
  authType?: 'password' | 'key' | 'agent';
  password?: string;
  privateKey?: string;
  keyPassphrase?: string;
  serialPort?: string;
  baudRate?: number;
  /** Serial line settings (defaults 8 / none / 1). */
  dataBits?: number;
  parity?: string;
  stopBits?: number;
  deviceType: DeviceType;
  /** Free-form labels for filtering the host list (e.g. site, role). */
  tags?: string[];
  /** Commands sent automatically right after the session connects. */
  startupCommands?: string;
  // For protocol 'local': command to run in the PTY (undefined => default shell)
  command?: string;
  args?: string[];
  cwd?: string;
  // Jump host / bastion (ProxyJump) for SSH
  jumpHost?: string;
  jumpPort?: number;
  jumpUsername?: string;
  jumpPassword?: string;
}

export interface Session {
  config: ConnectionConfig;
  connected: boolean;
  sessionId: string;
  lastActivity?: number;
}

export interface SessionFolder {
  id: string;
  name: string;
  items: ConnectionConfig[];
  expanded: boolean;
}

export interface TerminalSettings {
  theme: 'dark' | 'light';
  fontSize: number;
  fontFamily: string;
  bell: boolean;
  scrollback: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  autoReconnect: boolean;
  keepAliveInterval: number;
  syntaxHighlighting: boolean;
  wordWrap: boolean;
  anthropicApiKey: string;
  aiModel: string;
  aiProvider: AiProvider;
  ollamaUrl: string;
  ollamaModel: string;
  openrouterModel: string;
  moonshotModel: string;
  localCliCommand: string;
  /** References / standards injected into the AI context (lightweight RAG). */
  aiReferences: string;
  // Which tool sources the AI assistant may use (opt-in beyond plain CLI).
  /** Let the AI run CLI commands on the active device (default on). */
  aiUseTerminal: boolean;
  /** Let the AI query the connected AOS-CX switch's on-box REST API. */
  aiUseCxRest: boolean;
  /** Offer tools from connected MCP servers (e.g. centralmcp) to the AI. */
  aiUseMcp: boolean;
  /** Let the AI query a configured Juniper Apstra fabric controller. */
  aiUseApstra: boolean;
  /** Verify TLS certificates when talking to on-prem device REST APIs
   *  (AOS-CX/AOS-8/AOS-S/Apstra). Default off because field gear usually ships a
   *  self-signed cert; turn on to enforce verification (reject untrusted certs). */
  verifyDeviceTls: boolean;
  // Juniper Apstra (intent-based DC fabric) controller config.
  apstraHost: string;
  apstraUsername: string;
  apstraPassword: string;
  // Aruba Central (cloud) API — active account.
  centralBaseUrl: string;
  centralClientId: string;
  centralClientSecret: string;
  /** 'creds' = OAuth client-credentials; 'token' = pasted access token (SSO). */
  centralAuthMode: 'creds' | 'token';
  centralToken: string;
  /** Saved Central accounts/workspaces to switch between. */
  centralAccounts: CentralAccount[];
}

export interface CentralAccount {
  id: string;
  name: string;
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  token: string;
  mode: 'creds' | 'token';
}

// Aruba Central regional API base URLs.
export const CENTRAL_REGIONS = [
  'https://internal.api.central.arubanetworks.com',
  'https://us1.api.central.arubanetworks.com',
  'https://us2.api.central.arubanetworks.com',
  'https://us4.api.central.arubanetworks.com',
  'https://eu1.api.central.arubanetworks.com',
  'https://apac1.api.central.arubanetworks.com',
];

export type AiProvider = 'anthropic' | 'openrouter' | 'moonshot' | 'ollama' | 'local-cli';

// `needsKey` providers are HTTP APIs that require an API key. The CLI/local
// providers drive a locally-installed tool that handles its own auth/login, so
// they must never prompt for a key.
export const AI_PROVIDERS: { value: AiProvider; label: string; needsKey: boolean }[] = [
  { value: 'anthropic', label: 'Anthropic API', needsKey: true },
  { value: 'openrouter', label: 'OpenRouter API', needsKey: true },
  { value: 'moonshot', label: 'Moonshot API (Kimi)', needsKey: true },
  { value: 'ollama', label: 'Ollama (local)', needsKey: false },
  { value: 'local-cli', label: 'Local CLI (no key)', needsKey: false },
];

// Quick presets for the Local CLI provider — locally-installed agent CLIs that
// authenticate themselves (no API key needed).
export const AI_CLI_PRESETS: { label: string; command: string }[] = [
  { label: 'Claude', command: 'claude -p' },
  { label: 'Kimi', command: 'kimi --quiet' },
  { label: 'Copilot', command: 'copilot -p' },
];

export const DEFAULT_SETTINGS: TerminalSettings = {
  theme: 'dark',
  fontSize: 14,
  fontFamily: 'JetBrains Mono, Consolas, monospace',
  bell: false,
  scrollback: 10000,
  cursorStyle: 'block',
  cursorBlink: true,
  autoReconnect: true,
  keepAliveInterval: 30,
  syntaxHighlighting: true,
  wordWrap: false,
  anthropicApiKey: '',
  aiModel: 'claude-sonnet-4-6',
  aiProvider: 'ollama',
  ollamaUrl: 'http://localhost:11434',
  ollamaModel: 'llama3.2',
  openrouterModel: 'anthropic/claude-3.5-sonnet',
  moonshotModel: 'kimi-k2-0905-preview',
  localCliCommand: 'claude -p',
  aiUseTerminal: true,
  aiUseCxRest: false,
  aiUseMcp: false,
  aiUseApstra: false,
  verifyDeviceTls: false,
  apstraHost: '',
  apstraUsername: '',
  apstraPassword: '',
  aiReferences: `# Best-practice references the AI should apply (edit/extend freely)
# Add your org's standards, golden-config rules, or doc links here.

- Aruba AOS-CX Hardening: secure mgmt plane (AAA + local fallback, exec timeout,
  login banner), disable unused services, SSHv2 only.
- SNMP: no v1/v2c with public/private communities; prefer SNMPv3 auth+priv.
- Spanning tree: bpdu-guard + (root-guard or loop-protect) and admin-edge on
  access/edge ports; never run edge ports without a guard.
- Trunks: set an unused native VLAN; prune allowed VLANs explicitly.
- Park unused/shutdown ports in an isolated/black-hole VLAN.
- NTP configured + correct timezone; remote syslog/logging enabled.
- Strong secrets; no plaintext community/keys in config where avoidable.
`,
  centralBaseUrl: '',
  centralClientId: '',
  centralClientSecret: '',
  centralAuthMode: 'creds',
  centralToken: '',
  centralAccounts: [],
};

export interface Token {
  text: string;
  className: string;
  startPos: number;
  endPos: number;
}

export interface Grammar {
  name: string;
  commands: string[];
  subcommands: string[];
  keywords: string[];
  operators: string[];
  flags: string[];
  values: {
    ipAddress: RegExp;
    macAddress: RegExp;
    vlanId: RegExp;
    interfaceName: RegExp;
    number: RegExp;
  };
  promptPattern: RegExp;
}

export interface TerminalTheme {
  foreground: string;
  background: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

export const DARK_TERMINAL_THEME: TerminalTheme = {
  foreground: '#e6edf3',
  background: '#0a0e14',
  cursor: '#01a982',
  cursorAccent: '#0a0e14',
  selectionBackground: 'rgba(1,169,130,0.30)',
  black: '#0a0e14',
  red: '#ff7b72',
  green: '#3fb950',
  yellow: '#d29922',
  blue: '#58a6ff',
  magenta: '#d2a8ff',
  cyan: '#56d4dd',
  white: '#c9d1d9',
  brightBlack: '#484f58',
  brightRed: '#ffa198',
  brightGreen: '#56d364',
  brightYellow: '#e3b341',
  brightBlue: '#79c0ff',
  brightMagenta: '#e2c5ff',
  brightCyan: '#b3f0ff',
  brightWhite: '#ffffff',
};

export const LIGHT_TERMINAL_THEME: TerminalTheme = {
  foreground: '#1f2328',
  background: '#ffffff',
  cursor: '#0969da',
  cursorAccent: '#ffffff',
  selectionBackground: '#b3d8ff',
  black: '#24292f',
  red: '#cf222e',
  green: '#1a7f37',
  yellow: '#9a6700',
  blue: '#0969da',
  magenta: '#8250df',
  cyan: '#1b7c83',
  white: '#6e7781',
  brightBlack: '#57606a',
  brightRed: '#a40e26',
  brightGreen: '#2da44e',
  brightYellow: '#bf8700',
  brightBlue: '#218bff',
  brightMagenta: '#a475f9',
  brightCyan: '#3192aa',
  brightWhite: '#8c959f',
};

export interface DeviceTypeOption {
  value: DeviceType;
  label: string;
  /** Short status-bar code (CX, AOS-S, AP, MC, JUNOS, MIST, GEN). */
  short: string;
  vendor: Vendor;
  /** lucide-react icon name. */
  icon: string;
}

export const DEVICE_TYPES: DeviceTypeOption[] = [
  { value: 'aruba-cx',         label: 'Aruba AOS-CX Switch',        short: 'CX',    vendor: 'aruba',    icon: 'Network' },
  { value: 'aruba-aos-s',      label: 'Aruba AOS-S Switch',          short: 'AOS-S', vendor: 'aruba',    icon: 'Network' },
  { value: 'aruba-ap',         label: 'Aruba Access Point',          short: 'AP',    vendor: 'aruba',    icon: 'Wifi' },
  { value: 'aruba-controller', label: 'Aruba Mobility Controller',   short: 'MC',    vendor: 'aruba',    icon: 'RadioTower' },
  { value: 'juniper-junos',    label: 'Juniper Junos (EX/QFX/SRX/MX)', short: 'JUNOS', vendor: 'juniper', icon: 'Server' },
  { value: 'mist',             label: 'Juniper Mist (cloud)',        short: 'MIST',  vendor: 'mist',     icon: 'Cloud' },
  { value: 'generic',          label: 'Generic Device',              short: 'GEN',   vendor: 'generic',  icon: 'Monitor' },
];

export const DEVICE_META: Record<DeviceType, DeviceTypeOption> = DEVICE_TYPES.reduce(
  (acc, d) => {
    acc[d.value] = d;
    return acc;
  },
  {} as Record<DeviceType, DeviceTypeOption>
);

export function deviceMeta(deviceType: string): DeviceTypeOption {
  return DEVICE_META[deviceType as DeviceType] ?? DEVICE_META.generic;
}

export function vendorColor(deviceType: string): string {
  return VENDOR_META[deviceMeta(deviceType).vendor].colorVar;
}

export const PROTOCOLS: { value: Protocol; label: string }[] = [
  { value: 'ssh', label: 'SSH' },
  { value: 'telnet', label: 'Telnet' },
  { value: 'serial', label: 'Serial' },
  { value: 'local', label: 'Local Shell' },
];

// One-click presets for launching local CLI tools inside a PTY tab.
// `command` undefined => the user's default login shell.
export interface LocalCliPreset {
  id: string;
  label: string;
  command?: string;
  args?: string[];
}

export const LOCAL_CLI_PRESETS: LocalCliPreset[] = [
  { id: 'shell', label: 'Default Shell' },
  { id: 'claude', label: 'Claude CLI', command: 'claude' },
  { id: 'kimi', label: 'Kimi CLI', command: 'kimi' },
  { id: 'copilot', label: 'Copilot CLI', command: 'copilot' },
];

// ============================
// API Explorer Types
// ============================

export interface ApiEndpoint {
  name: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  path: string;
  description: string;
  body?: object;
  category: 'System' | 'Interfaces' | 'VLANs' | 'LLDP' | 'Configuration' | 'CLI'
    | 'Monitoring' | 'Clients' | 'Sites' | 'Config Groups' | 'Firmware' | 'Alerts'
    | 'Blueprints' | 'Fabric' | 'Design' | 'Resources'
    | 'Ports' | 'MAC' | 'Show';
}

/** Which on-box device REST flavour a connection speaks. */
export type DeviceApiKind = 'cx' | 'aoss' | 'aos8';

export interface ApiConnection {
  id: string;
  name: string;
  host: string;
  username: string;
  password?: string;
  cookie?: string;
  baseUrl: string;
  connected: boolean;
  /** Device REST flavour — routes requests to the right backend client. */
  kind?: DeviceApiKind;
}

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  duration: number;
}

export const DEFAULT_ENDPOINTS: ApiEndpoint[] = [
  { name: 'System Info', method: 'GET', path: '/system', description: 'Get system information', category: 'System' },
  { name: 'System Status', method: 'GET', path: '/system/status', description: 'Get system status', category: 'System' },
  { name: 'System CPU', method: 'GET', path: '/system/status/cpu', description: 'Get CPU utilization', category: 'System' },
  { name: 'System Memory', method: 'GET', path: '/system/status/mem', description: 'Get memory utilization', category: 'System' },
  { name: 'Interfaces', method: 'GET', path: '/system/interfaces', description: 'List all interfaces', category: 'Interfaces' },
  { name: 'Interface Stats', method: 'GET', path: '/system/interfaces/{interface}/stats', description: 'Get interface statistics', category: 'Interfaces' },
  { name: 'VLANs', method: 'GET', path: '/system/vlans', description: 'List all VLANs', category: 'VLANs' },
  { name: 'VLAN Detail', method: 'GET', path: '/system/vlans/{vlan_id}', description: 'Get VLAN details', category: 'VLANs' },
  { name: 'LLDP Neighbors', method: 'GET', path: '/system/interfaces/{interface}/lldp_neighbors', description: 'LLDP neighbors per interface', category: 'LLDP' },
  { name: 'LLDP Neighbors (All)', method: 'GET', path: '/system/interfaces/*/lldp_neighbors', description: 'LLDP neighbors all interfaces', category: 'LLDP' },
  { name: 'Configuration', method: 'GET', path: '/system/fullconfigs', description: 'Get running configuration', category: 'Configuration' },
  { name: 'Execute CLI', method: 'POST', path: '/cli', description: 'Execute CLI command', body: { command: [] }, category: 'CLI' },
  { name: 'Show CLI Command', method: 'POST', path: '/cli', description: 'Run show command', body: { command: ['show running-config'] }, category: 'CLI' },
];

// Aruba AOS-S (AOS-Switch / ProVision) on-box REST — resources under /rest/v7.
export const AOSS_ENDPOINTS: ApiEndpoint[] = [
  { name: 'System Info', method: 'GET', path: '/system', description: 'System info', category: 'System' },
  { name: 'System Status', method: 'GET', path: '/system/status', description: 'System status', category: 'System' },
  { name: 'Switch Status', method: 'GET', path: '/system/status/switch', description: 'Switch hardware status', category: 'System' },
  { name: 'VLANs', method: 'GET', path: '/vlans', description: 'List VLANs', category: 'VLANs' },
  { name: 'VLAN Detail', method: 'GET', path: '/vlans/{vlan_id}', description: 'VLAN by id', category: 'VLANs' },
  { name: 'VLAN-Port Membership', method: 'GET', path: '/vlans-ports', description: 'VLAN ↔ port membership', category: 'VLANs' },
  { name: 'Ports', method: 'GET', path: '/ports', description: 'List ports', category: 'Ports' },
  { name: 'Port Detail', method: 'GET', path: '/ports/{port_id}', description: 'Port by id', category: 'Ports' },
  { name: 'Port Statistics', method: 'GET', path: '/port-statistics', description: 'Per-port counters', category: 'Ports' },
  { name: 'PoE Ports', method: 'GET', path: '/poe/ports', description: 'PoE status per port', category: 'Ports' },
  { name: 'LLDP Neighbors', method: 'GET', path: '/lldp/remote-device', description: 'LLDP remote devices', category: 'LLDP' },
  { name: 'MAC Table', method: 'GET', path: '/mac-table', description: 'MAC address table', category: 'MAC' },
  { name: 'Run CLI', method: 'POST', path: '/cli', description: 'Run a CLI/show command', body: { cmd: 'show running-config' }, category: 'CLI' },
];

// Aruba AOS-8 (Mobility Conductor/Controller) — showcommand-based. The `path`
// holds the CLI show command, executed via the aos8_show backend command.
export const AOS8_ENDPOINTS: ApiEndpoint[] = [
  { name: 'show version', method: 'GET', path: 'show version', description: 'Controller version', category: 'Show' },
  { name: 'show running-config', method: 'GET', path: 'show running-config', description: 'Running configuration', category: 'Configuration' },
  { name: 'show switches', method: 'GET', path: 'show switches', description: 'Managed devices', category: 'Show' },
  { name: 'show ap database', method: 'GET', path: 'show ap database', description: 'AP database', category: 'Show' },
  { name: 'show ap active', method: 'GET', path: 'show ap active', description: 'Active APs', category: 'Show' },
  { name: 'show user-table', method: 'GET', path: 'show user-table', description: 'Associated clients', category: 'Clients' },
  { name: 'show vlan', method: 'GET', path: 'show vlan', description: 'VLANs', category: 'VLANs' },
  { name: 'show ip interface brief', method: 'GET', path: 'show ip interface brief', description: 'L3 interfaces', category: 'Interfaces' },
  { name: 'show datapath session', method: 'GET', path: 'show datapath session table', description: 'Datapath sessions', category: 'Show' },
  { name: 'show log all', method: 'GET', path: 'show log all 50', description: 'Recent log lines', category: 'Show' },
];

// Aruba Central API endpoint catalog.
// Reference:
//   https://developer.arubanetworks.com/new-central/reference/
//   https://developer.arubanetworks.com/new-central-config/reference/
//   https://developer.arubanetworks.com/new-central/docs/about
export const CENTRAL_ENDPOINTS: ApiEndpoint[] = [
  // Monitoring — devices
  { name: 'List All APs',          method: 'GET', path: '/monitoring/v2/aps',           description: 'List all access points with status/stats', category: 'Monitoring' },
  { name: 'AP Details',            method: 'GET', path: '/monitoring/v1/aps/{serial}',  description: 'Get a single AP by serial number', category: 'Monitoring' },
  { name: 'List Switches',         method: 'GET', path: '/monitoring/v2/switches',      description: 'List all switches (AOS-S / AOS-CX)', category: 'Monitoring' },
  { name: 'Switch Details',        method: 'GET', path: '/monitoring/v1/switches/{serial}', description: 'Single switch details', category: 'Monitoring' },
  { name: 'List Gateways',         method: 'GET', path: '/monitoring/v2/gateways',      description: 'List all gateways / controllers', category: 'Monitoring' },
  { name: 'Gateway Details',       method: 'GET', path: '/monitoring/v1/gateways/{serial}', description: 'Single gateway details', category: 'Monitoring' },
  { name: 'Device Stats',          method: 'GET', path: '/monitoring/v1/devices/{serial}/stats', description: 'CPU/memory/uptime for a device', category: 'Monitoring' },
  // Monitoring — clients
  { name: 'List Clients',          method: 'GET', path: '/monitoring/v2/clients',        description: 'All connected clients', category: 'Clients' },
  { name: 'Wired Clients',         method: 'GET', path: '/monitoring/v1/clients/wired',  description: 'Wired client list', category: 'Clients' },
  { name: 'Wireless Clients',      method: 'GET', path: '/monitoring/v1/clients/wireless', description: 'Wireless client list', category: 'Clients' },
  { name: 'Client Details',        method: 'GET', path: '/monitoring/v1/clients/{macaddr}', description: 'Details for one client by MAC', category: 'Clients' },
  // Sites
  { name: 'List Sites',            method: 'GET', path: '/central/v2/sites',             description: 'All configured sites', category: 'Sites' },
  { name: 'Site Details',          method: 'GET', path: '/central/v2/sites/{site_id}',   description: 'Single site details + devices', category: 'Sites' },
  // Configuration groups (New Central Config API)
  { name: 'List Groups',           method: 'GET', path: '/configuration/v2/groups',      description: 'All config groups', category: 'Config Groups' },
  { name: 'Group Config',          method: 'GET', path: '/configuration/v2/groups/{group}', description: 'Group-level config', category: 'Config Groups' },
  { name: 'Device Config',         method: 'GET', path: '/configuration/v1/devices/{serial}/config', description: 'Device effective config (AOS-CX)', category: 'Config Groups' },
  { name: 'Template List',         method: 'GET', path: '/configuration/v1/groups/{group}/templates', description: 'Config templates in a group', category: 'Config Groups' },
  { name: 'AP Settings',           method: 'GET', path: '/configuration/v2/ap_settings', description: 'AP radio/SSID settings', category: 'Config Groups' },
  { name: 'WLAN List',             method: 'GET', path: '/configuration/v2/wlan_ssids',  description: 'All configured SSIDs', category: 'Config Groups' },
  // Firmware
  { name: 'Firmware Status',       method: 'GET', path: '/firmware/v1/status',            description: 'Firmware compliance for all devices', category: 'Firmware' },
  { name: 'Firmware Upgrades',     method: 'GET', path: '/firmware/v2/upgrades',           description: 'Pending/in-progress firmware upgrades', category: 'Firmware' },
  { name: 'Available Versions',    method: 'GET', path: '/firmware/v1/versions',           description: 'Available firmware versions', category: 'Firmware' },
  // Alerts
  { name: 'Active Alerts',         method: 'GET', path: '/central/v1/alerts',              description: 'Current unresolved alerts', category: 'Alerts' },
  { name: 'Alert Count',           method: 'GET', path: '/central/v1/alerts/count',        description: 'Count of active alerts by severity', category: 'Alerts' },
];

// Juniper Apstra (AOS) endpoint catalog — paths relative to /api.
// Modeled on the Apstra resource set (terraform-provider-apstra / apstra-go-sdk).
export const APSTRA_ENDPOINTS: ApiEndpoint[] = [
  { name: 'Version',              method: 'GET', path: '/api/version',                                       description: 'Apstra controller version', category: 'System' },
  { name: 'Blueprints',           method: 'GET', path: '/api/blueprints',                                    description: 'All blueprints (fabrics)', category: 'Blueprints' },
  { name: 'Blueprint',            method: 'GET', path: '/api/blueprints/{blueprint_id}',                     description: 'Single blueprint detail', category: 'Blueprints' },
  { name: 'Anomalies',            method: 'GET', path: '/api/blueprints/{blueprint_id}/anomalies',           description: 'Blueprint anomalies (health/intent deviations)', category: 'Blueprints' },
  { name: 'Deploy status',        method: 'GET', path: '/api/blueprints/{blueprint_id}/deploy',              description: 'Staged vs deployed status', category: 'Blueprints' },
  { name: 'Nodes — systems',      method: 'GET', path: '/api/blueprints/{blueprint_id}/nodes?node_type=system', description: 'Graph nodes filtered to systems (switches)', category: 'Fabric' },
  { name: 'Security Zones (VRFs)',method: 'GET', path: '/api/blueprints/{blueprint_id}/security-zones',      description: 'Routing zones / VRFs', category: 'Fabric' },
  { name: 'Virtual Networks',     method: 'GET', path: '/api/blueprints/{blueprint_id}/virtual-networks',    description: 'Virtual networks (VLAN/VXLAN)', category: 'Fabric' },
  { name: 'Racks',                method: 'GET', path: '/api/blueprints/{blueprint_id}/racks',               description: 'Racks in the blueprint', category: 'Fabric' },
  { name: 'Blueprint configlets', method: 'GET', path: '/api/blueprints/{blueprint_id}/configlets',          description: 'Configlets applied to this blueprint', category: 'Fabric' },
  { name: 'Managed devices',      method: 'GET', path: '/api/systems',                                       description: 'Managed device system-agents', category: 'Resources' },
  { name: 'ASN pools',            method: 'GET', path: '/api/resources/asn-pools',                           description: 'ASN resource pools', category: 'Resources' },
  { name: 'IPv4 pools',           method: 'GET', path: '/api/resources/ip-pools',                            description: 'IPv4 resource pools', category: 'Resources' },
  { name: 'VNI pools',            method: 'GET', path: '/api/resources/vni-pools',                           description: 'VNI pools', category: 'Resources' },
  { name: 'Templates',            method: 'GET', path: '/api/design/templates',                             description: 'Pod / rack-based templates', category: 'Design' },
  { name: 'Rack types',           method: 'GET', path: '/api/design/rack-types',                            description: 'Rack types', category: 'Design' },
  { name: 'Logical devices',      method: 'GET', path: '/api/design/logical-devices',                       description: 'Logical devices', category: 'Design' },
  { name: 'Interface maps',       method: 'GET', path: '/api/design/interface-maps',                        description: 'Interface maps', category: 'Design' },
  { name: 'Design configlets',    method: 'GET', path: '/api/design/configlets',                            description: 'Global configlet catalog', category: 'Design' },
  { name: 'Property sets',        method: 'GET', path: '/api/property-sets',                                description: 'Property sets', category: 'Design' },
];

export const CENTRAL_DOCS = [
  { label: 'Central Monitoring API', url: 'https://developer.arubanetworks.com/new-central/reference/' },
  { label: 'Central Config API',     url: 'https://developer.arubanetworks.com/new-central-config/reference/' },
  { label: 'Getting Started',        url: 'https://developer.arubanetworks.com/new-central/docs/about' },
];

// ============================
// AI Assistant / MCP Types
// ============================

export interface McpToolCall {
  name: string;
  arguments: Record<string, unknown>;
}

export interface ToolCall {
  name: string;
  args: Record<string, unknown>;
  result?: string;
  error?: string;
}

export interface ChatMessage {
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: number;
  toolCalls?: McpToolCall[];
}

export interface McpServerConfig {
  name: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties: Record<string, unknown>;
    required?: string[];
  };
}
