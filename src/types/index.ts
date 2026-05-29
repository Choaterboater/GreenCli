export type Protocol = 'ssh' | 'telnet' | 'serial' | 'local';

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
  deviceType: 'aruba-cx' | 'aruba-ap' | 'aruba-controller' | 'generic';
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
}

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
  { label: 'Kimi', command: 'kimi' },
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
  foreground: '#c9d1d9',
  background: '#0d1117',
  cursor: '#58a6ff',
  cursorAccent: '#0d1117',
  selectionBackground: '#264f78',
  black: '#0d1117',
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
  value: 'aruba-cx' | 'aruba-ap' | 'aruba-controller' | 'generic';
  label: string;
  icon: string;
}

export const DEVICE_TYPES: DeviceTypeOption[] = [
  { value: 'aruba-cx', label: 'Aruba CX Switch', icon: 'Switch' },
  { value: 'aruba-ap', label: 'Aruba Wireless AP', icon: 'Wifi' },
  { value: 'aruba-controller', label: 'Aruba Mobility Controller', icon: 'Router' },
  { value: 'generic', label: 'Generic Device', icon: 'Monitor' },
];

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
  category: 'System' | 'Interfaces' | 'VLANs' | 'LLDP' | 'Configuration' | 'CLI';
}

export interface ApiConnection {
  id: string;
  name: string;
  host: string;
  username: string;
  password?: string;
  cookie?: string;
  baseUrl: string;
  connected: boolean;
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
