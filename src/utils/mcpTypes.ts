// Shapes shared by the Rust MCP commands and the TypeScript side.
// Rust: src-tauri/src/mcp/client.rs (McpServerDef, McpToolInfo, status()).
// Fields marked [A3] come from the "writes off" pass; until then they are
// never set.

/** Least to most strict (see SAFETY_RANK in mcpLabels.ts). */
export type CapabilitySafety = 'read' | 'diagnostic' | 'external-action' | 'write' | 'destructive' | 'exec';

/** The tool shape Casper's labels.ts expects (Pick<MCPTool, "name" | "annotations" | "_meta">). */
export interface MCPTool {
  name: string;
  description?: string;
  inputSchema: { type: 'object'; [key: string]: unknown };
  annotations?: { readOnlyHint?: boolean; destructiveHint?: boolean; [key: string]: unknown };
  _meta?: Record<string, unknown>;
}

export type McpPresetId =
  | 'hpe-networking-mcp'
  | 'centralmcp'
  | 'central-mcp-server'
  | 'junos-mcp-server'
  | 'mist-hosted'
  | 'netbox'
  | 'netmiko-mcp'
  | 'oxidized-librenms'
  | 'grafana'
  | 'clearpass-mcp';

export type McpWrites = 'off' | 'on';
export type McpAccess = 'read-only' | 'read-write' | 'unknown';

/** One tool, as mcp_all_tools and mcp_tool_info return it. */
export interface McpToolInfo {
  server: string;
  name: string;
  description: string;
  inputSchema: MCPTool['inputSchema'];
  annotations?: MCPTool['annotations'];
  _meta?: Record<string, unknown>;
  preset?: McpPresetId;
  showOptIn?: boolean;
  /** [A3] */
  writes?: McpWrites;
  /** [A3] */
  access?: McpAccess;
  /** [A3] GreenCLI's Rust label. It can only make a tool stricter. */
  label?: CapabilitySafety;
  /** [A3] Why the backend refuses this tool right now. */
  blocked?: string;
}

export interface McpServerDef {
  name: string;
  transport: 'stdio' | 'http';
  command: string;
  args: string[];
  env: Record<string, string>;
  // Rust Option<String>: these arrive as null when unset.
  cwd?: string | null;
  url?: string | null;
  credentialsEnvVar?: string | null;
  /** Rust always sends an object; optional only because the add/edit form leaves it undefined when empty. */
  headers?: Record<string, string>;
  enabled: boolean;
  /** [A3] */
  writes?: McpWrites;
  /** Junos only: plain show commands run without asking. Set by mcp_set_show_opt_in only. */
  showOptIn?: boolean;
}

/** [A3] */
export type McpPins =
  | { kind: 'none' }
  | { kind: 'pinned'; shown: string[]; confirmed: boolean }
  | { kind: 'cannot-pin'; reason: string };

/** What mcp_export_pins returns for one server whose writes are off: the read-only settings
 *  GreenCLI adds when it starts the server (Rust presets.rs PinPlan). */
export type McpExportPins =
  | { kind: 'none' }
  | { kind: 'pinned'; args: string[]; env: [string, string][]; shown: string[] }
  | { kind: 'cannot-pin'; reason: string };

/** One mcp_status item. */
export interface McpStatus {
  name: string;
  enabled: boolean;
  connected: boolean;
  toolCount: number;
  preset?: { id: McpPresetId; label: string } | null;
  presetBy?: 'definition' | 'tools';
  presetMismatch?: boolean;
  /** [A3] */
  hiddenToolCount?: number;
  /** [A3] */
  writes?: McpWrites;
  /** [A3] */
  writesSet?: boolean;
  /** [A3] */
  pins?: McpPins;
  /** [A3] */
  access?: McpAccess;
  /** [A3] */
  restartNeeded?: boolean;
}
