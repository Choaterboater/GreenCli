export type Protocol = 'ssh' | 'telnet' | 'serial' | 'local';

// ── Multi-vendor model (Aruba · Juniper · Mist) ──
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
  /** Path to a private-key file on disk (e.g. an imported ssh_config IdentityFile). */
  keyPath?: string;
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
  /** Built-in or custom profile id used for mapping/highlighting/editor behavior. */
  deviceProfileId?: string;
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
  connectionStatus?: 'connected' | 'disconnected' | 'connecting' | 'reconnecting';
  sessionId: string;
  lastActivity?: number;
}

export interface SessionFolder {
  id: string;
  name: string;
  items: ConnectionConfig[];
  expanded: boolean;
}

/**
 * A saved AI assistant persona. Attach one to a session (in the sidebar) to give
 * that session its own instructions / provider / model. The agent's `instructions`
 * are appended to the system prompt for that session; `provider`/`model` override
 * the global AI settings when set.
 */
export interface AiAgent {
  id: string;
  name: string;
  /** Persona / extra instructions appended to the system prompt for this session. */
  instructions: string;
  /** Optional provider override (empty = use the global provider). */
  provider?: AiProvider | '';
  /** Optional model override for that provider (empty = provider default). */
  model?: string;
  /** Accent colour for the sidebar chip. */
  color: string;
}

export interface TerminalSettings {
  theme: 'dark' | 'light';
  /** Terminal color scheme; 'greencli' follows the app theme (dark/light). */
  colorScheme: TerminalColorScheme;
  fontSize: number;
  fontFamily: string;
  bell: boolean;
  scrollback: number;
  cursorStyle: 'block' | 'underline' | 'bar';
  cursorBlink: boolean;
  autoReconnect: boolean;
  keepAliveInterval: number;
  syntaxHighlighting: boolean;
  pasteGuardEnabled: boolean;
  pasteGuardLineThreshold: number;
  pasteHistoryEnabled: boolean;
  /** Copy the terminal selection to the clipboard as soon as the mouse drag ends (PuTTY-style). */
  copyOnSelect: boolean;
  /** Middle-click pastes the clipboard into the terminal (X11 / SecureCRT convention). Off by default (W2-12). */
  middleClickPaste: boolean;
  /** Right-click in the terminal: show a context menu, paste directly (PuTTY), or copy-selection-else-paste (Windows Terminal). */
  rightClickBehavior: 'menu' | 'paste' | 'copyPaste';
  smartTerminalLinks: boolean;
  terminalActivityNotifications: boolean;
  terminalSilenceNotifications: boolean;
  terminalSilenceThresholdSeconds: number;
  /** Width of the left session sidebar in px (drag the divider to resize). */
  sidebarWidth: number;
  /** Scheduled intent evaluation (NW-15): re-run the eval sweep on an
   *  interval and alert on new-violation transitions (toast + webhook). */
  intentScheduling: boolean;
  /** Minutes between scheduled intent-evaluation sweeps. */
  intentScheduleMinutes: number;
  /** Optional webhook URL POSTed on new-violation transitions (drift alerts). */
  intentWebhookUrl: string;
  /** Auto-capture the device running-config once on ssh/telnet connect (NW-16).
   *  Off by default (W2-6) — the manual "Capture now" button always works. */
  captureOnConnect: boolean;
  /** Last selected device type/profile base used by Quick Connect. */
  lastUsedDeviceType: DeviceType;
  /** Last selected built-in/custom profile used by Quick Connect. */
  lastUsedDeviceProfileId?: string;
  /** User-authored device profiles for custom mapping/highlighting workflows. */
  customDeviceProfiles: DeviceProfile[];
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
  /** Verify TLS certificates when talking to on-prem device REST APIs
   *  (AOS-CX/AOS-8/AOS-S). Default off because field gear usually ships a
   *  self-signed cert; turn on to enforce verification (reject untrusted certs). */
  verifyDeviceTls: boolean;
  // Juniper Mist cloud — region API base + API token.
  mistBaseUrl: string;
  mistToken: string;
  // Aruba Central (cloud) API — active account.
  centralBaseUrl: string;
  centralClientId: string;
  centralClientSecret: string;
  /** 'creds' = OAuth client-credentials; 'token' = pasted access token (SSO). */
  centralAuthMode: 'creds' | 'token';
  centralToken: string;
  /** Saved Central accounts/workspaces to switch between. */
  centralAccounts: CentralAccount[];
  /** Saved AI agent personas the user can attach to sessions. */
  aiAgents: AiAgent[];
  /** Map of saved-session id → attached agent id. */
  sessionAgents: Record<string, string>;
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

export interface DeviceProfile {
  id: string;
  name: string;
  deviceType: DeviceType;
  short: string;
  color: string;
  description?: string;
  promptPatterns: string[];
  fingerprints: string[];
  commands: string[];
  keywords: string[];
  startupCommands?: string;
  runningConfigCommand?: string;
  pagingDisableCommand?: string;
  pagingRestoreCommand?: string;
}

// Aruba Central API Gateway base URLs, one per geographical cluster. These are
// the *classic* Central gateways used by the OAuth2 client-credentials flow
// (POST {base}/oauth2/token) the backend implements. The previous values
// (us1/us2/us4.api.central…) did not exist and broke every Central request.
// Source: aruba/pycentral constants.py (the official Central Python SDK).
export const CENTRAL_REGIONS = [
  'https://app1-apigw.central.arubanetworks.com',     // US-1 (US West / Oregon)
  'https://apigw-prod2.central.arubanetworks.com',    // US-2
  'https://apigw-us-east-1.central.arubanetworks.com',// US-East-1
  'https://apigw-uswest4.central.arubanetworks.com',  // US-West-4
  'https://eu-apigw.central.arubanetworks.com',       // EU-1 (Frankfurt)
  'https://apigw-eucentral2.central.arubanetworks.com', // EU-Central-2
  'https://apigw-eucentral3.central.arubanetworks.com', // EU-Central-3
  'https://apigw-ca.central.arubanetworks.com',       // Canada-1
  'https://api-ap.central.arubanetworks.com',         // APAC-1 (Mumbai)
  'https://apigw-apaceast.central.arubanetworks.com', // APAC-East-1
  'https://apigw-apacsouth.central.arubanetworks.com',// APAC-South-1
  'https://apigw-uaenorth1.central.arubanetworks.com',// UAE-North-1
  'https://apigw.central.arubanetworks.com.cn',       // China-1
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
  // NB: GitHub Copilot CLI isn't offered here — its `-p` takes the prompt as an
  // inline arg (not stdin) and non-interactive mode requires --allow-all-tools,
  // which makes it an autonomous agent. Not a safe one-shot default.
];

/**
 * Starter AI agents shipped with the app. Stable ids so a session→agent mapping
 * survives across restarts. Users can edit/delete these or add their own.
 */
export const BUILTIN_AGENTS: AiAgent[] = [
  {
    id: 'agent-auditor',
    name: 'Read-only Auditor',
    instructions:
      'You are in STRICT READ-ONLY mode. Only run show/diagnostic commands — never configuration, write, or state-changing commands. ' +
      'If a change is needed, output the exact commands for the user to review but DO NOT execute them. ' +
      'Prioritise security and best-practice findings, reported as Critical / Warning / Info.',
    color: '#F59E0B',
  },
  {
    id: 'agent-junos',
    name: 'Junos Expert',
    instructions:
      'Assume the device runs Juniper Junos unless proven otherwise. Use set-style configuration, commit / commit confirmed / rollback, ' +
      'and Junos operational commands (e.g. show interfaces terse, show route, "| display set", "| no-more"). Prefer Junos idioms over Aruba.',
    color: '#3B82F6',
  },
  {
    id: 'agent-cx',
    name: 'Aruba CX Expert',
    instructions:
      'Assume the device is an Aruba AOS-CX switch. Use AOS-CX syntax (interface 1/1/1, vlan access/trunk, "write memory") ' +
      'and prefer the on-box REST API (/rest/v10.09) over scraping CLI output when it is enabled.',
    color: '#22C55E',
  },
];

export const DEFAULT_SETTINGS: TerminalSettings = {
  theme: 'dark',
  colorScheme: 'greencli',
  fontSize: 14,
  fontFamily: 'JetBrains Mono, Consolas, monospace',
  bell: false,
  scrollback: 10000,
  cursorStyle: 'block',
  cursorBlink: true,
  autoReconnect: true,
  keepAliveInterval: 30,
  syntaxHighlighting: true,
  pasteGuardEnabled: true,
  pasteGuardLineThreshold: 2,
  pasteHistoryEnabled: true,
  copyOnSelect: false,
  middleClickPaste: false,
  rightClickBehavior: 'menu',
  smartTerminalLinks: true,
  terminalActivityNotifications: true,
  terminalSilenceNotifications: false,
  terminalSilenceThresholdSeconds: 60,
  sidebarWidth: 256,
  intentScheduling: false,
  intentScheduleMinutes: 30,
  intentWebhookUrl: '',
  captureOnConnect: false,
  lastUsedDeviceType: 'generic',
  lastUsedDeviceProfileId: 'builtin-generic',
  customDeviceProfiles: [],
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
  verifyDeviceTls: true