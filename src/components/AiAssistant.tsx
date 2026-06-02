import { useState, useRef, useEffect, useCallback } from 'react';
import {
  X,
  Send,
  Bot,
  User,
  TerminalSquare,
  Sparkles,
  Loader2,
  ChevronDown,
  ChevronRight,
  Clock,
  Settings,
  Terminal,
  AlertCircle,
  CheckCircle2,
  Maximize2,
  Minimize2,
  Square,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { ChatMessage, Session, AiProvider, AI_PROVIDERS } from '../types';
import { sleep, stripAnsi, sendAndCapture } from '../utils/terminal';
import { Intent, evaluateAll, summarize } from '../utils/intent';
import { useResizablePanel } from '../hooks/useResizablePanel';

// ─── Anthropic API types (local) ───

interface AnthropicTextBlock {
  type: 'text';
  text: string;
}

interface AnthropicToolUseBlock {
  type: 'tool_use';
  id: string;
  name: string;
  input: Record<string, unknown>;
}

interface AnthropicToolResultBlock {
  type: 'tool_result';
  tool_use_id: string;
  content: string;
}

type AnthropicContentBlock = AnthropicTextBlock | AnthropicToolUseBlock | AnthropicToolResultBlock;

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | AnthropicContentBlock[];
}

interface ToolExecution {
  name: string;
  args: Record<string, unknown>;
  result: string;
}

interface DisplayMessage extends ChatMessage {
  toolExecutions?: ToolExecution[];
  isError?: boolean;
}

// ─── Multi-vendor CLI Knowledge Base (Aruba · Juniper · Mist) ───

const NET_KNOWLEDGE = `
## Aruba AOS-CX (switches)
- show interface brief | show vlan | show ip route | show lldp neighbors
- show spanning-tree | show mac-address-table | show running-config
- configure → interface 1/1/1 / vlan access <id> / no shutdown
- Trunk: vlan trunk native <id> / vlan trunk allowed <list>
- SVI: interface vlan <id> / ip address <ip>/<prefix>
- Save: write memory   ·   Diagnostics: show tech-support

## Aruba AOS-S (ProVision switches)
- show interfaces brief | show vlans | show running-config
- conf t → vlan <id> / name <n> / tagged <ports> / untagged <ports>
- Disable paging: no page

## Juniper Junos (EX/QFX/SRX/MX)
- Operational: show interfaces terse | show route | show vlans | show lldp neighbors
  show chassis hardware | show configuration | show system uptime
- Config (set-style): configure → set interfaces ge-0/0/0 unit 0 family ethernet-switching vlan members <v>
  set vlans <name> vlan-id <id> · commit / commit confirmed · rollback
- Pipes: | match <re> · | display set · | no-more
- SRX security: show security zones | show security policies

## Juniper Mist (cloud-managed)
- Mist is API/cloud-first; Mist-managed EX/QFX still expose a Junos CLI over SSH.
- Cloud config/telemetry is via the Mist API (api.mist.com) — use the API Explorer for org/site/device data.

## Common
- ping <ip> / traceroute <ip>
- AAA: RADIUS/TACACS+ servers, local fallback, idle timeout, login banner
- Always disable paging before capturing long output
`;

const SYSTEM_PROMPT = (deviceContext: string, references: string) => `You are GreenCLI, an expert network engineering assistant covering Aruba, Juniper, and Mist: **Aruba** (AOS-CX, AOS-S, InstantOS APs, ArubaOS controllers), **Juniper** (Junos: EX/QFX/SRX/MX), and **Juniper Mist** (cloud-managed wired/wireless). You help engineers configure, troubleshoot, and automate across all of them.

${deviceContext}

Adapt your CLI syntax to the connected device's vendor/OS (Aruba CX vs AOS-S vs Junos are different — e.g. Junos uses \`set\`-style config and \`commit\`). If unsure of the OS, run a harmless identifying command first (\`show version\` / \`show system uptime\`).

${NET_KNOWLEDGE}
${references && references.trim()
  ? `\n## Reference standards (authoritative — apply these and cite them when auditing)\n${references.trim()}\n`
  : ''}

## Guidelines
- Be concise and technical — your users are network engineers
- The send_terminal_command tool RETURNS the device's output to you — run a show command, read the result, then explain or act on it
- Send commands one at a time and interpret each result before the next
- For configuration changes, always confirm with the user before executing — ask "Shall I apply this?"
- Format configs in code blocks for easy copying to the Config Editor panel
- You can execute show/diagnostic commands freely; be cautious with config changes`;

// ─── Prebuilt prompts ───

const PREBUILT_PROMPTS = [
  {
    label: '🛡️ Best-practices audit',
    prompt:
      'Identify the device OS first, then pull its running configuration and audit it against vendor best practices. ' +
      'Check at least: management/console security (AAA, local fallback, idle timeout, banner), ' +
      'SNMP (no v1/v2c public/private community, prefer v3), ' +
      'spanning-tree protections (bpdu-guard/root-guard/loop-protect on edge ports, admin-edge), ' +
      'unused/shutdown ports parked in an isolated VLAN, native-VLAN hygiene on trunks, ' +
      'NTP + timezone, syslog/logging configured, password/secret strength, ' +
      'and any default/unsecured services. Report findings as a prioritized list ' +
      '(Critical / Warning / Info), each with the offending config line and the recommended fix command.',
  },
  { label: 'Interface status', prompt: 'Show me all interfaces — which are up/down, speeds, and descriptions.' },
  { label: 'VLAN config', prompt: 'Show the current VLAN configuration including names and port assignments.' },
  { label: 'Troubleshoot connectivity', prompt: 'Walk me through troubleshooting a connectivity issue step by step. Run diagnostic commands on the device.' },
  { label: 'BGP / routing status', prompt: 'Check the routing table and BGP/OSPF neighbor status if configured.' },
];

// ─── Tool definitions ───

const TOOLS = [
  {
    name: 'send_terminal_command',
    description: 'Execute a CLI command on the currently connected network device (Aruba CX/AOS-S, Juniper Junos, etc.) AND return its captured output back to you. Use freely for show/diagnostic commands to gather information, then analyse the returned output. Always ask the user before running config-changing commands. Tip: disable paging first (e.g. "no page" on AOS-S, "| no-more" on Junos) or the device may paginate long output.',
    input_schema: {
      type: 'object',
      properties: {
        command: {
          type: 'string',
          description: 'The exact CLI command to execute (e.g., "show interface brief")',
        },
      },
      required: ['command'],
    },
  },
];

// Built-in tool offered only when the active device is an Aruba AOS-CX switch:
// hits the switch's own REST API (no Central) for structured data.
const CX_REST_TOOL = {
  name: 'aruba_cx_rest',
  description:
    "Query the connected Aruba AOS-CX switch's on-box REST API (no Aruba Central needed) and return JSON — cleaner than scraping CLI output. method defaults to GET. path is relative to the REST base /rest/v10.09, e.g. '/system?depth=1', '/system/interfaces?depth=2', '/system/vlans?depth=2'. Reads are safe; ALWAYS confirm with the user before any PUT/POST/DELETE write.",
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: "REST path, e.g. '/system/interfaces?depth=2'" },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH'], description: 'HTTP method (default GET)' },
      body: { type: 'string', description: 'JSON request body for write methods' },
    },
    required: ['path'],
  },
};

// ArubaOS 8 Mobility Controller/Conductor — show commands as JSON (no Central).
const AOS8_SHOW_TOOL = {
  name: 'aruba_aos8_show',
  description:
    "Run a `show` command on the connected ArubaOS 8 Mobility Controller/Conductor via its REST API (no Aruba Central) and return JSON — better than scraping CLI. e.g. 'show ap database', 'show ap active', 'show user-table', 'show switches', 'show datapath session'. Read-only.",
  input_schema: {
    type: 'object',
    properties: { command: { type: 'string', description: "e.g. 'show ap database'" } },
    required: ['command'],
  },
};

// Aruba AOS-S (AOS-Switch / ProVision) on-box REST (no Central).
const AOSS_REST_TOOL = {
  name: 'aruba_aoss_rest',
  description:
    "Query the connected Aruba AOS-S (AOS-Switch/ProVision) switch REST API (no Aruba Central) and return JSON. path is relative to /rest/v7, e.g. '/system', '/vlans', '/ports', '/lldp/remote-device', '/system/status/switch'. method defaults to GET. Reads are safe; confirm before any write.",
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: "e.g. '/vlans'" },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'DELETE'] },
      body: { type: 'string' },
    },
    required: ['path'],
  },
};

// Juniper Apstra (intent-based DC fabric) — AOS REST.
const APSTRA_TOOL = {
  name: 'juniper_apstra',
  description:
    "Query the configured Juniper Apstra fabric controller (AOS REST) and return JSON. path is relative to /api. Common reads: '/blueprints' (fabrics), '/blueprints/<id>/anomalies' (health), '/blueprints/<id>/nodes?node_type=system' (switches), '/blueprints/<id>/security-zones' (VRFs), '/blueprints/<id>/virtual-networks', '/blueprints/<id>/racks', '/blueprints/<id>/configlets', '/systems' (managed devices), '/design/templates', '/design/rack-types', '/resources/asn-pools'. Get a blueprint id from '/blueprints' first. method defaults to GET. Reads are safe; ALWAYS confirm before any write.",
  input_schema: {
    type: 'object',
    properties: {
      path: { type: 'string', description: "e.g. '/blueprints'" },
      method: { type: 'string', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      body: { type: 'string' },
    },
    required: ['path'],
  },
};

// Evaluate the saved network intents (desired state) against live devices.
const INTENT_TOOL = {
  name: 'evaluate_network_intents',
  description:
    "Evaluate the operator's saved network INTENTS (desired-state rules — config that must be present, and operational expectations like links up / BGP established / reachability) against the connected devices, and return a compliance/anomaly report. Use when asked to check the network against intent, find drift, or report violations. Then explain the violations and suggest fixes.",
  input_schema: { type: 'object', properties: {}, required: [] },
};

interface BuiltinTool {
  name: string;
  description: string;
  input_schema: { type: string; properties: Record<string, unknown>; required?: string[] };
}

// Best-effort login to a device REST API using the SSH session's credentials
// (inline password, else a saved vault credential). `loginCmd` is the platform
// login command (api_login / aos8_login / aoss_login). Returns true on success.
async function tryDeviceLogin(session: Session, loginCmd: string): Promise<boolean> {
  const host = session.config.host;
  if (!host) return false;
  const username = session.config.username || 'admin';
  let password = session.config.password;
  if (!password) {
    const key = `cred:${host}:${session.config.port ?? 22}:${username}`;
    password = await invoke<string | null>('vault_retrieve', { key })
      .then((v) => v ?? undefined)
      .catch(() => undefined);
  }
  if (!password) return false;
  try {
    await invoke(loginCmd, {
      request: {
        host,
        username,
        password,
        // Honour the global "Verify device TLS" setting (read live — this is a
        // module function, not a hook).
        accept_invalid_certs: !useSettingsStore.getState().verifyDeviceTls,
      },
    });
    return true;
  } catch {
    return false;
  }
}

// ─── MCP tool plumbing (provider-neutral) ───

interface McpToolDef {
  server: string;
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** Unique, provider-safe tool name, assigned once (handles collisions). */
  safeName?: string;
}

type McpResolve = Map<string, { server: string; tool: string }>;

// Provider-safe tool name (Anthropic/OpenAI allow [a-zA-Z0-9_-], <=64 chars).
function mcpSafeName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ─── Execute a tool ───

// Cap a tool result and mark when it was truncated, so the model knows data was
// cut rather than treating a sliced (now-invalid) JSON document as complete.
function capToolResult(s: string, max = 12000): string {
  return s.length > max ? `${s.slice(0, max)}\n…(truncated ${s.length - max} more chars)` : s;
}

async function executeTool(
  name: string,
  args: Record<string, unknown>,
  activeSession: Session | undefined,
  mcpResolve?: McpResolve,
  shouldCancel?: () => boolean
): Promise<string> {
  // Re-resolve the live session: a multi-step run can outlast the user switching
  // tabs or the device disconnecting, and the value captured at send time would
  // otherwise keep targeting a stale/dead session id.
  if (activeSession) {
    activeSession =
      useSessionStore.getState().sessions.find((s) => s.sessionId === activeSession!.sessionId) ??
      activeSession;
  }
  // Route MCP tools to the connected server.
  const mcp = mcpResolve?.get(name);
  if (mcp) {
    try {
      return await invoke<string>('mcp_call', { server: mcp.server, tool: mcp.tool, args });
    } catch (e) {
      return `MCP tool ${mcp.server}/${mcp.tool} failed: ${e}`;
    }
  }
  // Aruba AOS-CX on-box REST (no Central). Auto-logs-in with the SSH creds.
  if (name === 'aruba_cx_rest') {
    const host = activeSession?.config.host;
    if (!host) return 'Error: the active session has no host to query.';
    const method = (args.method as string) || 'GET';
    const path = (args.path as string) || '';
    const body = (args.body as string) || undefined;
    const doReq = () => invoke('api_request', { host, method, path, body });
    try {
      return capToolResult(JSON.stringify(await doReq(), null, 2));
    } catch (e) {
      // Probably not logged into the REST API yet — try once with SSH creds.
      if (activeSession && (await tryDeviceLogin(activeSession, 'api_login'))) {
        try {
          return capToolResult(JSON.stringify(await doReq(), null, 2));
        } catch (e2) {
          return `Aruba CX REST error: ${e2}`;
        }
      }
      return `Could not reach the switch REST API on ${host} (${e}). It may need REST enabled (\`https-server rest access-mode read-write\`) or a login in the API panel.`;
    }
  }
  // ArubaOS 8 controller/conductor — show command as JSON (no Central).
  if (name === 'aruba_aos8_show') {
    const host = activeSession?.config.host;
    if (!host) return 'Error: the active session has no host to query.';
    const command = (args.command as string) || '';
    const doReq = () => invoke('aos8_show', { host, command });
    try {
      return capToolResult(JSON.stringify(await doReq(), null, 2));
    } catch (e) {
      if (activeSession && (await tryDeviceLogin(activeSession, 'aos8_login'))) {
        try {
          return capToolResult(JSON.stringify(await doReq(), null, 2));
        } catch (e2) {
          return `AOS-8 REST error: ${e2}`;
        }
      }
      return `Could not reach the AOS-8 controller API on ${host}:4343 (${e}).`;
    }
  }
  // Aruba AOS-S switch on-box REST (no Central).
  if (name === 'aruba_aoss_rest') {
    const host = activeSession?.config.host;
    if (!host) return 'Error: the active session has no host to query.';
    const method = (args.method as string) || 'GET';
    const path = (args.path as string) || '';
    const body = (args.body as string) || undefined;
    const doReq = () => invoke('aoss_request', { host, method, path, body });
    try {
      return capToolResult(JSON.stringify(await doReq(), null, 2));
    } catch (e) {
      if (activeSession && (await tryDeviceLogin(activeSession, 'aoss_login'))) {
        try {
          return capToolResult(JSON.stringify(await doReq(), null, 2));
        } catch (e2) {
          return `AOS-S REST error: ${e2}`;
        }
      }
      return `Could not reach the AOS-S REST API on ${host} (${e}). It may need \`rest-interface\` enabled.`;
    }
  }
  // Juniper Apstra fabric controller (configured in Settings, not session-bound).
  if (name === 'juniper_apstra') {
    const method = (args.method as string) || 'GET';
    const path = (args.path as string) || '';
    const body = (args.body as string) || undefined;
    try {
      return capToolResult(JSON.stringify(await invoke('apstra_request', { method, path, body }), null, 2));
    } catch (e) {
      return `Apstra error: ${e}. Configure the controller in Settings → Juniper Apstra.`;
    }
  }
  // Evaluate desired-state intents against the live network.
  if (name === 'evaluate_network_intents') {
    try {
      const intents = await invoke<Intent[]>('intent_list');
      if (!intents.length) return 'No network intents are defined yet (add them in the Intent panel — the Target icon).';
      const sessions = useSessionStore.getState().sessions;
      const updated = await evaluateAll(intents, sessions, shouldCancel);
      if (shouldCancel?.()) return 'Intent evaluation cancelled.';
      return summarize(updated);
    } catch (e) {
      return `Intent evaluation failed: ${e}`;
    }
  }
  if (name === 'send_terminal_command') {
    const command = (args.command as string) || '';
    if (!activeSession) {
      return 'Error: No active terminal session. Please connect to a device first.';
    }
    if (!activeSession.connected) {
      return 'Error: Terminal session exists but device is not connected.';
    }
    try {
      const cleaned = await sendAndCapture(activeSession.sessionId, command);
      if (!cleaned) {
        return `Command \`${command}\` sent — no output captured (may be interactive, paged, or still running).`;
      }
      // Cap to keep token usage sane; keep the tail (most relevant).
      return cleaned.length > 12000 ? '…(truncated)…\n' + cleaned.slice(-12000) : cleaned;
    } catch (e) {
      return `Failed to run command: ${e}`;
    }
  }
  return `Unknown tool: ${name}`;
}

// ─── Streaming (token-by-token via Tauri events) ───

let streamCounter = 0;
const nextStreamId = () => `aistream-${++streamCounter}`;

// Stream ids currently in flight, so Stop can actually abort the backend egress
// (ai_cancel_stream), which then emits ai_done and lets each stream clean up its
// listeners. Without this, Stop only stopped the UI from reading while Rust kept
// generating (and being billed) and the event listeners leaked.
const activeStreamIds = new Set<string>();
function cancelActiveAiStreams() {
  for (const id of activeStreamIds) {
    invoke('ai_cancel_stream', { streamId: id }).catch(() => {});
  }
}

interface AnthropicStreamResult {
  text: string;
  toolUses: { id: string; name: string; input: Record<string, unknown> }[];
  stopReason: string;
}

// One streamed Anthropic Messages call. onText receives the cumulative text as
// it streams. Resolves with the final text + any tool_use blocks.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function streamAnthropicOnce(body: any, onText: (t: string) => void): Promise<AnthropicStreamResult> {
  const streamId = nextStreamId();
  activeStreamIds.add(streamId);
  const blocks: Record<number, { type: string; text: string; id?: string; name?: string; json: string }> = {};
  let stopReason = 'end_turn';
  let textSoFar = '';
  const unlisteners: Array<() => void> = [];
  const cleanup = () => {
    activeStreamIds.delete(streamId);
    unlisteners.forEach((u) => u());
  };

  const finish = (): AnthropicStreamResult => {
    const text = Object.values(blocks).filter((b) => b.type === 'text').map((b) => b.text).join('');
    const toolUses = Object.values(blocks)
      .filter((b) => b.type === 'tool_use')
      .map((b) => {
        let input: Record<string, unknown> = {};
        try {
          input = b.json ? JSON.parse(b.json) : {};
        } catch {
          /* keep empty on malformed partial json */
        }
        return { id: b.id || '', name: b.name || '', input };
      });
    return { text, toolUses, stopReason };
  };

  return new Promise<AnthropicStreamResult>((resolve, reject) => {
    Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listen<any>('ai_chunk', (e) => {
        if (e.payload.streamId !== streamId) return;
        let ev: { type?: string; index?: number; delta?: Record<string, unknown>; content_block?: Record<string, unknown> };
        try {
          ev = JSON.parse(e.payload.data);
        } catch {
          return;
        }
        if (ev.type === 'content_block_start' && ev.index != null) {
          blocks[ev.index] = {
            type: (ev.content_block?.type as string) || 'text',
            text: '',
            id: ev.content_block?.id as string | undefined,
            name: ev.content_block?.name as string | undefined,
            json: '',
          };
        } else if (ev.type === 'content_block_delta' && ev.index != null) {
          const b = blocks[ev.index];
          if (!b) return;
          if (ev.delta?.type === 'text_delta') {
            b.text += (ev.delta.text as string) || '';
            textSoFar += (ev.delta.text as string) || '';
            onText(textSoFar);
          } else if (ev.delta?.type === 'input_json_delta') {
            b.json += (ev.delta.partial_json as string) || '';
          }
        } else if (ev.type === 'message_delta') {
          const sr = (ev.delta?.stop_reason as string) || '';
          if (sr) stopReason = sr;
        }
      }),
      listen<{ streamId: string }>('ai_done', (e) => {
        if (e.payload.streamId !== streamId) return;
        cleanup();
        resolve(finish());
      }),
      listen<{ streamId: string; error: string }>('ai_error', (e) => {
        if (e.payload.streamId !== streamId) return;
        cleanup();
        reject(new Error(e.payload.error || 'stream error'));
      }),
    ]).then((uns) => {
      uns.forEach((u) => unlisteners.push(u));
      invoke('ai_chat_stream', { request: { provider: 'anthropic', body: { ...body, stream: true } }, streamId }).catch(
        (err) => {
          cleanup();
          reject(err instanceof Error ? err : new Error(String(err)));
        }
      );
    });
  });
}

interface OpenAiStreamResult {
  content: string;
  toolCalls: { id: string; name: string; args: string }[];
  finishReason: string;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function streamOpenAiOnce(provider: string, baseUrl: string | undefined, body: any, onText: (t: string) => void): Promise<OpenAiStreamResult> {
  const streamId = nextStreamId();
  activeStreamIds.add(streamId);
  let content = '';
  let finishReason = 'stop';
  const toolCalls: Record<number, { id: string; name: string; args: string }> = {};
  const unlisteners: Array<() => void> = [];
  const cleanup = () => {
    activeStreamIds.delete(streamId);
    unlisteners.forEach((u) => u());
  };

  return new Promise<OpenAiStreamResult>((resolve, reject) => {
    Promise.all([
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      listen<any>('ai_chunk', (e) => {
        if (e.payload.streamId !== streamId) return;
        let ev: { choices?: Array<{ delta?: { content?: string; tool_calls?: Array<{ index: number; id?: string; function?: { name?: string; arguments?: string } }> }; finish_reason?: string }> };
        try {
          ev = JSON.parse(e.payload.data);
        } catch {
          return;
        }
        const ch = ev.choices?.[0];
        if (!ch) return;
        if (ch.delta?.content) {
          content += ch.delta.content;
          onText(content);
        }
        if (ch.delta?.tool_calls) {
          for (const tc of ch.delta.tool_calls) {
            const i = tc.index ?? 0;
            if (!toolCalls[i]) toolCalls[i] = { id: '', name: '', args: '' };
            if (tc.id) toolCalls[i].id = tc.id;
            if (tc.function?.name) toolCalls[i].name = tc.function.name;
            if (tc.function?.arguments) toolCalls[i].args += tc.function.arguments;
          }
        }
        if (ch.finish_reason) finishReason = ch.finish_reason;
      }),
      listen<{ streamId: string }>('ai_done', (e) => {
        if (e.payload.streamId !== streamId) return;
        cleanup();
        // Some OpenAI-compatible backends (Ollama, some OpenRouter models) stream
        // tool calls with no `id`. Synthesize a stable one so the follow-up
        // assistant tool_calls[].id and the tool result tool_call_id still match
        // (an empty id is rejected as a malformed/unmatched tool call).
        resolve({
          content,
          toolCalls: Object.values(toolCalls).map((tc, i) => ({ ...tc, id: tc.id || `call_${i}` })),
          finishReason,
        });
      }),
      listen<{ streamId: string; error: string }>('ai_error', (e) => {
        if (e.payload.streamId !== streamId) return;
        cleanup();
        reject(new Error(e.payload.error || 'stream error'));
      }),
    ]).then((uns) => {
      uns.forEach((u) => unlisteners.push(u));
      invoke('ai_chat_stream', {
        request: { provider, base_url: provider === 'ollama' ? baseUrl : undefined, body: { ...body, stream: true } },
        streamId,
      }).catch((err) => {
        cleanup();
        reject(err instanceof Error ? err : new Error(String(err)));
      });
    });
  });
}

// All provider network egress goes through the Rust `ai_chat` command so API
// keys never live in the webview. The request body is provider-shaped here; the
// Rust side only adds the base URL + auth header (key pulled from its key store).

// ─── Anthropic (Claude Messages API) with tool-use loop ───

async function callAnthropicWithTools(
  conversationHistory: AnthropicMessage[],
  model: string,
  systemPrompt: string,
  activeSession: Session | undefined,
  onToolCall: (tool: ToolExecution) => void,
  mcpTools: McpToolDef[],
  mcpResolve: McpResolve,
  builtinTools: BuiltinTool[],
  shouldCancel: () => boolean,
  onDelta: (text: string) => void
): Promise<string> {
  const messages = [...conversationHistory];

  const allTools = [
    ...builtinTools,
    ...mcpTools.map((t) => ({
      name: t.safeName || mcpSafeName(t.server, t.name),
      description: `[${t.server}] ${t.description}`.slice(0, 1024),
      input_schema: t.inputSchema,
    })),
  ];

  let fullText = '';
  for (let iter = 0; iter < 8; iter++) {
    if (shouldCancel()) throw new Error('cancelled');
    const round = await streamAnthropicOnce(
      { model, max_tokens: 2048, system: systemPrompt, messages, tools: allTools },
      (t) => onDelta(fullText + t)
    );
    fullText += round.text;

    if (round.stopReason !== 'tool_use') return fullText;

    const content: AnthropicContentBlock[] = [];
    if (round.text) content.push({ type: 'text', text: round.text });
    for (const tu of round.toolUses) {
      content.push({ type: 'tool_use', id: tu.id, name: tu.name, input: tu.input });
    }
    messages.push({ role: 'assistant', content });

    const toolResults: AnthropicToolResultBlock[] = [];
    for (const tu of round.toolUses) {
      if (shouldCancel()) throw new Error('cancelled');
      const result = await executeTool(tu.name, tu.input, activeSession, mcpResolve, shouldCancel);
      onToolCall({ name: tu.name, args: tu.input, result });
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: result });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Budget exhausted — one final streamed pass without tools so the model
  // summarises rather than discarding everything gathered.
  const wrap = await streamAnthropicOnce(
    { model, max_tokens: 2048, system: systemPrompt, messages },
    (t) => onDelta(fullText + t)
  ).catch(() => null);
  if (wrap) fullText += wrap.text;
  return fullText || 'Reached the tool-call limit — see the command output above for what was gathered.';
}

// ─── OpenAI-compatible providers (OpenRouter / Moonshot-Kimi / Ollama) ───

async function callOpenAiCompatWithTools(
  provider: 'openrouter' | 'moonshot' | 'ollama',
  baseUrl: string | undefined,
  model: string,
  conversationHistory: AnthropicMessage[],
  systemPrompt: string,
  activeSession: Session | undefined,
  onToolCall: (tool: ToolExecution) => void,
  mcpTools: McpToolDef[],
  mcpResolve: McpResolve,
  builtinTools: BuiltinTool[],
  shouldCancel: () => boolean,
  onDelta: (text: string) => void
): Promise<string> {
  const toOpenAi = (m: AnthropicMessage) => ({
    role: m.role,
    content:
      typeof m.content === 'string'
        ? m.content
        : (m.content as AnthropicContentBlock[])
            .filter((b): b is AnthropicTextBlock => b.type === 'text')
            .map((b) => b.text)
            .join('\n') || '',
  });

  const messages: unknown[] = [
    { role: 'system', content: systemPrompt },
    ...conversationHistory.map(toOpenAi),
  ];

  const tools = [
    ...builtinTools.map((t) => ({
      type: 'function',
      function: { name: t.name, description: t.description, parameters: t.input_schema },
    })),
    ...mcpTools.map((t) => ({
      type: 'function',
      function: {
        name: t.safeName || mcpSafeName(t.server, t.name),
        description: `[${t.server}] ${t.description}`.slice(0, 1024),
        parameters: t.inputSchema,
      },
    })),
  ];

  let fullText = '';
  for (let iter = 0; iter < 8; iter++) {
    if (shouldCancel()) throw new Error('cancelled');
    const round = await streamOpenAiOnce(provider, baseUrl, { model, messages, tools }, (t) =>
      onDelta(fullText + t)
    );
    fullText += round.content;

    if (round.finishReason !== 'tool_calls' || round.toolCalls.length === 0) {
      return fullText;
    }

    messages.push({
      role: 'assistant',
      content: round.content || null,
      tool_calls: round.toolCalls.map((tc) => ({
        id: tc.id,
        type: 'function',
        function: { name: tc.name, arguments: tc.args },
      })),
    });

    for (const tc of round.toolCalls) {
      if (shouldCancel()) throw new Error('cancelled');
      let args: Record<string, unknown> = {};
      try {
        args = JSON.parse(tc.args);
      } catch {
        /* ignore malformed args */
      }
      const result = await executeTool(tc.name, args, activeSession, mcpResolve, shouldCancel);
      onToolCall({ name: tc.name, args, result });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: result });
    }
  }

  const wrap = await streamOpenAiOnce(provider, baseUrl, { model, messages }, (t) =>
    onDelta(fullText + t)
  ).catch(() => null);
  if (wrap) fullText += wrap.content;
  return fullText || 'Reached the tool-call limit — see the command output above for what was gathered.';
}

// ─── Local CLI passthrough with auto-command execution ───

async function callLocalCli(
  command: string,
  conversationHistory: AnthropicMessage[],
  _systemPrompt: string,
  activeSession?: Session
): Promise<string> {
  // Only the last user message matters for a one-shot CLI call
  const lastUser = [...conversationHistory]
    .reverse()
    .find((m) => m.role === 'user');
  const question = lastUser
    ? typeof lastUser.content === 'string'
      ? lastUser.content
      : (lastUser.content as AnthropicContentBlock[])
          .filter((b): b is AnthropicTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
    : '';

  const device = activeSession
    ? `Connected to: ${activeSession.config.name} (${activeSession.config.host}, ${activeSession.config.deviceType})`
    : 'No device connected.';

  // Keep it minimal for local CLIs — large terminal output floods their stdin
  const prompt = `${device}\n${question}`;

  return await invoke<string>('ai_cli', { command, prompt });
}

// ─── Build device context string ───

function buildDeviceContext(activeSession: Session | undefined): string {
  if (!activeSession) return 'No device currently connected.';
  return [
    `Active Device: ${activeSession.config.name}`,
    `Host: ${activeSession.config.host || 'N/A'}`,
    `Type: ${activeSession.config.deviceType}`,
    `Status: ${activeSession.connected ? 'Connected' : 'Disconnected'}`,
  ].join(' | ');
}

// ─── Simple markdown renderer ───

function renderMarkdown(text: string) {
  const lines = text.split('\n');
  const result: JSX.Element[] = [];
  let i = 0;
  let key = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Code fence
    if (line.startsWith('```')) {
      const lang = line.slice(3).trim();
      const codeLines: string[] = [];
      i++;
      while (i < lines.length && !lines[i].startsWith('```')) {
        codeLines.push(lines[i]);
        i++;
      }
      result.push(
        <pre key={key++} className="my-2 p-3 bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg overflow-x-auto">
          <code className="text-[11px] text-[var(--text-primary)] font-mono whitespace-pre">
            {codeLines.join('\n')}
          </code>
        </pre>
      );
      i++;
      continue;
    }

    // Heading
    if (line.startsWith('## ')) {
      result.push(<h4 key={key++} className="text-xs font-bold text-[var(--text-primary)] mt-2 mb-1">{line.slice(3)}</h4>);
      i++;
      continue;
    }
    if (line.startsWith('# ')) {
      result.push(<h3 key={key++} className="text-sm font-bold text-white mt-2 mb-1">{line.slice(2)}</h3>);
      i++;
      continue;
    }

    // Horizontal rule
    if (line.match(/^---+$/)) {
      result.push(<hr key={key++} className="border-[var(--border)] my-2" />);
      i++;
      continue;
    }

    // Empty line
    if (line.trim() === '') {
      result.push(<div key={key++} className="h-1" />);
      i++;
      continue;
    }

    // Normal text with inline formatting
    result.push(<p key={key++} className="text-[11px] leading-relaxed">{renderInline(line)}</p>);
    i++;
  }

  return result;
}

function renderInline(text: string): (JSX.Element | string)[] {
  const parts: (JSX.Element | string)[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*]+\*)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = 0;

  while ((m = re.exec(text)) !== null) {
    if (m.index > last) parts.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith('**')) {
      parts.push(<strong key={k++} className="text-white font-semibold">{tok.slice(2, -2)}</strong>);
    } else if (tok.startsWith('`')) {
      parts.push(<code key={k++} className="px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-[#d29922] text-[10px] font-mono">{tok.slice(1, -1)}</code>);
    } else if (tok.startsWith('*')) {
      parts.push(<em key={k++} className="italic">{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
  }
  if (last < text.length) parts.push(text.slice(last));
  return parts;
}

// ─── Component ───

export default function AiAssistant() {
  const { showAiAssistant, toggleAiAssistant, activeSessionId, sessions } = useSessionStore();
  const settings = useSettingsStore();

  const { width: panelWidth, onDragStart: handleDragStart, handleClass: dragHandleClass } =
    useResizablePanel(420, 300, 800);

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [expandedTools, setExpandedTools] = useState<Set<string>>(new Set());
  const [hasKey, setHasKey] = useState(false);
  const [mcpToolCount, setMcpToolCount] = useState(0);
  const [maximized, setMaximized] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Lets us abandon an in-flight request (the underlying invoke still resolves
  // in the background, but its result is ignored).
  const requestSeq = useRef(0);

  // For AI tool execution, prefer an SSH session over the active tab (which
  // might be a local PTY like kimi/claude). Falls back to active if no SSH.
  const activeSession = (() => {
    const active = sessions.find((s) => s.sessionId === activeSessionId);
    if (active && active.config.protocol !== 'local' && active.connected) return active;
    // Find any connected SSH session
    const sshSession = sessions.find(
      (s) => s.config.protocol !== 'local' && s.connected
    );
    return sshSession || active;
  })();

  useEffect(() => {
    if (scrollRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  // Track whether the selected provider has a key stored in the Rust key store.
  // Re-check on provider change AND when the Settings modal closes (a key may
  // have just been added there).
  const showSettings = useSessionStore((s) => s.showSettings);
  useEffect(() => {
    const provider = settings.aiProvider || 'ollama';
    invoke<boolean>('ai_has_key', { provider })
      .then(setHasKey)
      .catch(() => setHasKey(false));
  }, [settings.aiProvider, showSettings]);

  // Count tools from connected MCP servers (refresh when Settings closes, since
  // servers may have just been connected there).
  useEffect(() => {
    invoke<{ connected: boolean; toolCount: number }[]>('mcp_status')
      .then((st) =>
        setMcpToolCount((st || []).filter((s) => s.connected).reduce((a, s) => a + (s.toolCount || 0), 0))
      )
      .catch(() => setMcpToolCount(0));
  }, [showSettings, showAiAssistant]);

  const sendMessage = useCallback(async (content: string) => {
    if (!content.trim() || isLoading) return;

    const userMsg: DisplayMessage = { role: 'user', content: content.trim(), timestamp: Date.now() };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);
    const myReq = ++requestSeq.current; // token to detect cancellation/supersede

    // The assistant talks to providers from the Rust backend. In a plain browser
    // tab there is no Tauri IPC, so fail with a clear message instead of a cryptic
    // "window.__TAURI_IPC__ is not a function".
    if (!('__TAURI_IPC__' in window)) {
      setMessages((prev) => [
        ...prev,
        {
          role: 'assistant',
          content:
            'The AI assistant runs through the desktop backend. Launch **GreenCLI** (the installed app, or `npm run tauri dev`) — it can\'t reach AI providers or the terminal from a regular browser tab.',
          timestamp: Date.now(),
          isError: true,
        },
      ]);
      setIsLoading(false);
      return;
    }

    const provider: AiProvider = settings.aiProvider || 'ollama';
    const providerMeta = AI_PROVIDERS.find((p) => p.value === provider);

    // Guard: key-based providers need a key in the Rust key store. Query it
    // FRESH (not the cached `hasKey`) — adding a key in Settings doesn't trigger
    // a re-render here, so a stale cache would wrongly block sending.
    if (providerMeta?.needsKey) {
      const keyPresent = await invoke<boolean>('ai_has_key', { provider }).catch(() => false);
      setHasKey(keyPresent);
      if (!keyPresent) {
        setMessages((prev) => [
          ...prev,
          {
            role: 'assistant',
            content: `No API key configured for **${providerMeta.label}**. Open **Settings** (Ctrl+,) → AI Assistant and add your key, or switch provider.`,
            timestamp: Date.now(),
            isError: true,
          },
        ]);
        setIsLoading(false);
        return;
      }
    }

    // Build conversation history for the API (user/assistant only; skip app-level error messages)
    const apiMessages: AnthropicMessage[] = [...messages, userMsg]
      .filter((m) => m.role === 'user' || (m.role === 'assistant' && !m.isError))
      // Drop empty assistant turns (e.g. a bubble left by an early Stop) — some
      // providers reject an assistant message with empty content.
      .filter((m) => m.role === 'user' || m.content.trim() !== '')
      .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }));

    const deviceContext = buildDeviceContext(activeSession);
    const systemPrompt = SYSTEM_PROMPT(deviceContext, settings.aiReferences || '');
    const collectedTools: ToolExecution[] = [];

    // Which tool sources the assistant may use this turn (all opt-in beyond
    // plain CLI; defaults: terminal on, CX-REST + MCP off).
    const builtinTools: BuiltinTool[] = [];
    if (settings.aiUseTerminal !== false) {
      builtinTools.push(...TOOLS);
      builtinTools.push(INTENT_TOOL); // intent eval uses the terminal to gather evidence
    }
    if (settings.aiUseCxRest) {
      const dt = activeSession?.config.deviceType;
      if (dt === 'aruba-cx') builtinTools.push(CX_REST_TOOL);
      else if (dt === 'aruba-aos-s') builtinTools.push(AOSS_REST_TOOL);
      else if (dt === 'aruba-controller') builtinTools.push(AOS8_SHOW_TOOL);
    }
    if (settings.aiUseApstra) builtinTools.push(APSTRA_TOOL);

    // MCP tools — only when enabled — available to EVERY provider (Anthropic
    // and the OpenAI-compatible ones alike), not just Claude.
    let mcpTools: McpToolDef[] = [];
    if (settings.aiUseMcp) {
      try {
        mcpTools = (await invoke<McpToolDef[]>('mcp_all_tools')) || [];
      } catch {
        mcpTools = [];
      }
    }
    // Assign each MCP tool a UNIQUE provider-safe name (two servers can sanitize
    // to the same string, or names can collide after the 64-char clamp).
    const mcpResolve: McpResolve = new Map();
    const usedNames = new Set(builtinTools.map((t) => t.name));
    for (const t of mcpTools) {
      let nm = mcpSafeName(t.server, t.name);
      if (usedNames.has(nm)) {
        let i = 2;
        const base = nm.slice(0, 60);
        while (usedNames.has(`${base}_${i}`)) i++;
        nm = `${base}_${i}`;
      }
      usedNames.add(nm);
      t.safeName = nm;
      mcpResolve.set(nm, { server: t.server, tool: t.name });
    }

    const shouldCancel = () => requestSeq.current !== myReq;

    // Live streaming bubble: append an empty assistant message and update it as
    // tokens arrive (the last message is always the in-progress one).
    setMessages((prev) => [...prev, { role: 'assistant', content: '', timestamp: Date.now() }]);
    const updateLast = (patch: Partial<DisplayMessage>) =>
      setMessages((prev) => {
        const copy = [...prev];
        const i = copy.length - 1;
        if (i >= 0 && copy[i].role === 'assistant') copy[i] = { ...copy[i], ...patch };
        return copy;
      });
    const onDelta = (t: string) => {
      if (requestSeq.current === myReq) updateLast({ content: t });
    };

    try {
      let text = '';

      if (provider === 'anthropic') {
        text = await callAnthropicWithTools(
          apiMessages,
          settings.aiModel || 'claude-sonnet-4-6',
          systemPrompt,
          activeSession,
          (tool) => collectedTools.push(tool),
          mcpTools,
          mcpResolve,
          builtinTools,
          shouldCancel,
          onDelta
        );
      } else if (provider === 'local-cli') {
        // One-shot CLI — no token streaming.
        text = await callLocalCli(
          settings.localCliCommand || 'claude -p',
          apiMessages,
          systemPrompt,
          activeSession
        );
      } else {
        // OpenAI-compatible: openrouter | moonshot | ollama — each has its own model.
        const model =
          provider === 'ollama'
            ? settings.ollamaModel || 'llama3.2'
            : provider === 'openrouter'
              ? settings.openrouterModel || 'anthropic/claude-3.5-sonnet'
              : settings.moonshotModel || 'kimi-k2-0905-preview';
        text = await callOpenAiCompatWithTools(
          provider,
          settings.ollamaUrl || 'http://localhost:11434',
          model,
          apiMessages,
          systemPrompt,
          activeSession,
          (tool) => collectedTools.push(tool),
          mcpTools,
          mcpResolve,
          builtinTools,
          shouldCancel,
          onDelta
        );
      }

      if (requestSeq.current !== myReq) return; // superseded or cancelled
      updateLast({
        content: text,
        toolExecutions: collectedTools.length > 0 ? [...collectedTools] : undefined,
      });
    } catch (e: unknown) {
      if (requestSeq.current !== myReq) return; // cancelled — keep the partial bubble
      const errMsg = e instanceof Error ? e.message : String(e);
      updateLast({
        content: `**AI Error:** ${errMsg}`,
        isError: true,
        toolExecutions: collectedTools.length > 0 ? [...collectedTools] : undefined,
      });
    } finally {
      if (requestSeq.current === myReq) setIsLoading(false);
    }
  }, [messages, isLoading, settings, activeSession]);

  // Abandon the in-flight request: bump the guard, abort the backend stream(s) so
  // the provider stops generating, and drop a trailing empty assistant bubble left
  // by a Stop pressed before any token streamed in.
  const cancelRequest = useCallback(() => {
    requestSeq.current++;
    setIsLoading(false);
    cancelActiveAiStreams();
    setMessages((prev) =>
      prev.length && prev[prev.length - 1].role === 'assistant' && !prev[prev.length - 1].content
        ? prev.slice(0, -1)
        : prev
    );
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  const toggleTool = (idx: string) => {
    setExpandedTools((prev) => {
      const next = new Set(prev);
      if (next.has(idx)) next.delete(idx);
      else next.add(idx);
      return next;
    });
  };


  if (!showAiAssistant) return null;

  const provider = settings.aiProvider || 'ollama';
  const providerMeta = AI_PROVIDERS.find((p) => p.value === provider);
  const isLocalProvider = provider === 'ollama' || provider === 'local-cli';
  const isReady = !providerMeta?.needsKey || hasKey;
  const providerLabel =
    provider === 'ollama'
      ? settings.ollamaModel || 'llama3.2'
      : provider === 'local-cli'
        ? settings.localCliCommand || 'CLI'
        : provider === 'anthropic'
          ? settings.aiModel?.split('-').slice(1, 3).join(' ') || 'Claude'
          : provider === 'openrouter'
            ? settings.openrouterModel || providerMeta?.label || provider
            : settings.moonshotModel || providerMeta?.label || provider;

  return (
    <div
      className={
        maximized
          ? 'fixed left-0 right-0 bottom-0 top-11 z-40 flex flex-col bg-[var(--bg-primary)] overflow-hidden animate-fade-in'
          : 'flex-shrink-0 flex flex-col bg-[var(--bg-primary)] border-l border-[var(--border)] overflow-hidden relative'
      }
      style={maximized ? undefined : { width: panelWidth }}
    >
      {/* Drag handle (hidden when maximized) */}
      {!maximized && <div className={dragHandleClass} onMouseDown={handleDragStart} />}

      {/* Header */}
      <div className="flex items-center justify-between h-10 px-3 pl-4 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <div className="flex items-center gap-2">
          <Sparkles size={14} className="text-[#d2a8ff]" />
          <span className="text-xs font-semibold text-[var(--text-primary)] uppercase tracking-wider">
            AI Assistant
          </span>
          <span className={`text-[10px] px-1.5 py-0.5 rounded ${
            isLocalProvider
              ? 'text-[#56d4dd] bg-[#56d4dd15]'
              : 'text-[#3fb950] bg-[#3fb95015]'
          }`}>
            {isLocalProvider ? '⬡ ' : '✦ '}{providerLabel}
          </span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => useSessionStore.getState().setShowSettings(true)}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title="Settings"
          >
            <Settings size={13} />
          </button>
          <button
            onClick={() => setMaximized((m) => !m)}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]"
            title={maximized ? 'Restore to side panel' : 'Maximize'}
          >
            {maximized ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
          </button>
          <button
            onClick={toggleAiAssistant}
            className="p-1 rounded hover:bg-[var(--bg-tertiary)] text-[var(--text-secondary)] hover:text-[#ff7b72]"
            title="Close"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      {/* Device context bar */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <Terminal size={11} className={activeSession?.connected ? 'text-[#3fb950]' : 'text-[var(--text-muted)]'} />
        {activeSession ? (
          <span className="text-[10px] text-[var(--text-secondary)]">
            <span className="text-[var(--text-primary)]">{activeSession.config.name}</span>
            <span className="mx-1 text-[var(--border)]">·</span>
            {activeSession.config.deviceType}
            <span className="mx-1 text-[var(--border)]">·</span>
            <span className={activeSession.connected ? 'text-[#3fb950]' : 'text-[var(--text-muted)]'}>
              {activeSession.connected ? 'connected' : 'disconnected'}
            </span>
          </span>
        ) : (
          <span className="text-[10px] text-[var(--text-muted)]">No active session</span>
        )}
        {mcpToolCount > 0 && (
          <span
            className="ml-auto flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full"
            style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}
            title="Tools available from connected MCP servers"
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            {mcpToolCount} MCP tools
          </span>
        )}
      </div>

      {/* Warning when not ready */}
      {!isReady && (
        <div className="mx-3 mt-3 px-3 py-2 bg-[#d2991520] border border-[#d2991540] rounded-lg flex items-start gap-2">
          <AlertCircle size={12} className="text-[#d29922] flex-shrink-0 mt-0.5" />
          <div className="text-[10px] text-[#d29922] leading-relaxed">
            Add an API key for <strong>{providerMeta?.label}</strong> in <strong>Settings → AI Assistant</strong>, or switch to a local provider (Ollama / Local CLI).
          </div>
        </div>
      )}

      {/* Chat */}
      <div ref={scrollRef} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
        {/* Prebuilt prompts when chat is empty */}
        {messages.length === 0 && (
          <div className="space-y-1.5">
            <p className="text-[10px] text-[var(--text-muted)] mb-2">Quick actions:</p>
            {PREBUILT_PROMPTS.map((p) => (
              <button
                key={p.label}
                onClick={() => sendMessage(p.prompt)}
                disabled={isLoading}
                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)] bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] border border-[var(--border)] hover:border-[var(--text-muted)] rounded-lg transition-all disabled:opacity-50"
              >
                <ChevronRight size={10} className="text-[#d2a8ff]" />
                {p.label}
              </button>
            ))}
          </div>
        )}

        {/* Messages */}
        {messages.map((msg, i) => (
          <div key={i}>
            {msg.role === 'user' ? (
              <div className="flex items-start gap-2 flex-row-reverse">
                <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[#58a6ff20] flex items-center justify-center">
                  <User size={12} className="text-[#58a6ff]" />
                </div>
                <div className="max-w-[88%] px-3 py-2 rounded-lg bg-[#58a6ff15] border border-[#58a6ff25] text-[var(--text-primary)]">
                  <p className="text-[11px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
                  <div className="text-[9px] text-[var(--text-muted)] mt-1 flex items-center gap-1 justify-end">
                    <Clock size={7} />
                    {new Date(msg.timestamp).toLocaleTimeString()}
                  </div>
                </div>
              </div>
            ) : (
              <div className="flex items-start gap-2">
                <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${msg.isError ? 'bg-[#ff7b7220]' : 'bg-[#d2a8ff20]'}`}>
                  {msg.isError ? (
                    <AlertCircle size={12} className="text-[#ff7b72]" />
                  ) : (
                    <Bot size={12} className="text-[#d2a8ff]" />
                  )}
                </div>
                <div className="flex-1 min-w-0">
                  {/* Tool executions */}
                  {msg.toolExecutions && msg.toolExecutions.length > 0 && (
                    <div className="mb-2 space-y-1">
                      {msg.toolExecutions.map((te, ti) => (
                        <div key={ti} className="border border-[var(--border)] rounded-lg overflow-hidden">
                          <button
                            onClick={() => toggleTool(`${i}:${ti}`)}
                            className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-left transition-colors"
                          >
                            <Terminal size={10} className="text-[#58a6ff]" />
                            <code className="text-[10px] text-[#58a6ff] font-mono flex-1 truncate">
                              {(te.args.command as string) || te.name}
                            </code>
                            <CheckCircle2 size={9} className="text-[#3fb950] flex-shrink-0" />
                            {expandedTools.has(`${i}:${ti}`) ? (
                              <ChevronDown size={9} className="text-[var(--text-muted)]" />
                            ) : (
                              <ChevronRight size={9} className="text-[var(--text-muted)]" />
                            )}
                          </button>
                          {expandedTools.has(`${i}:${ti}`) && (
                            <div className="px-2.5 py-2 bg-[var(--bg-primary)] border-t border-[var(--border)] max-h-64 overflow-auto">
                              <pre className="text-[10px] text-[var(--text-secondary)] font-mono whitespace-pre-wrap break-words">{te.result}</pre>
                            </div>
                          )}
                        </div>
                      ))}
                    </div>
                  )}

                  {/* Message content */}
                  <div className={`px-3 py-2 rounded-lg ${msg.isError ? 'bg-[#ff7b7210] border border-[#ff7b7225] text-[#ff7b72]' : 'bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)]'}`}>
                    <div className="space-y-0.5">{renderMarkdown(msg.content)}</div>
                    <div className="text-[9px] text-[var(--text-muted)] mt-1.5 flex items-center gap-1">
                      <Clock size={7} />
                      {new Date(msg.timestamp).toLocaleTimeString()}
                    </div>
                  </div>
                </div>
              </div>
            )}
          </div>
        ))}

        {/* Loading */}
        {isLoading && (
          <div className="flex items-center gap-2">
            <div className="w-6 h-6 rounded-full bg-[#d2a8ff20] flex items-center justify-center flex-shrink-0">
              <Bot size={12} className="text-[#d2a8ff]" />
            </div>
            <div className="flex items-center gap-1.5 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-[11px] text-[var(--text-secondary)]">
              <Loader2 size={11} className="animate-spin text-[#d2a8ff]" />
              Thinking…
            </div>
          </div>
        )}
      </div>

      {/* Input */}
      <div className="px-3 py-2 border-t border-[var(--bg-tertiary)] bg-[var(--bg-secondary)]">
        <div className="flex items-end gap-2">
          <textarea
            ref={inputRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder={isReady ? 'Ask about the device…' : 'Configure AI provider in Settings…'}
            rows={1}
            disabled={isLoading}
            className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[#58a6ff] resize-none max-h-28 disabled:opacity-50"
            style={{ minHeight: '36px' }}
          />
          {isLoading ? (
            <button
              type="button"
              onClick={cancelRequest}
              title="Stop"
              className="flex items-center justify-center w-9 h-9 bg-[var(--accent-danger)] hover:brightness-110 text-white rounded-lg transition-colors flex-shrink-0"
            >
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={() => sendMessage(input)}
              disabled={!input.trim()}
              className="btn-accent flex items-center justify-center w-9 h-9 disabled:opacity-40 flex-shrink-0"
            >
              <Send size={14} />
            </button>
          )}
        </div>
        <p className="text-[9px] text-[var(--text-muted)] mt-1 text-center">
          Shift+Enter for new line · Commands execute on active device
        </p>
      </div>
    </div>
  );
}
