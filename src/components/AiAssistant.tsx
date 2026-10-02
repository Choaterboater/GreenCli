import { useState, useRef, useEffect, useCallback, useMemo, memo } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
// PrismLight + per-language registration instead of the full Prism bundle:
// `Prism` pulls in ~600KB of language grammars; chat code fences only ever
// carry shell/CLI, JSON, and the odd script.
import { PrismLight as SyntaxHighlighter } from 'react-syntax-highlighter';
import bash from 'react-syntax-highlighter/dist/esm/languages/prism/bash';
import json from 'react-syntax-highlighter/dist/esm/languages/prism/json';
import yaml from 'react-syntax-highlighter/dist/esm/languages/prism/yaml';
import python from 'react-syntax-highlighter/dist/esm/languages/prism/python';
import javascript from 'react-syntax-highlighter/dist/esm/languages/prism/javascript';
import typescript from 'react-syntax-highlighter/dist/esm/languages/prism/typescript';
import { vscDarkPlus } from 'react-syntax-highlighter/dist/esm/styles/prism';

SyntaxHighlighter.registerLanguage('bash', bash);
SyntaxHighlighter.registerLanguage('shell', bash);
SyntaxHighlighter.registerLanguage('sh', bash);
SyntaxHighlighter.registerLanguage('json', json);
SyntaxHighlighter.registerLanguage('yaml', yaml);
SyntaxHighlighter.registerLanguage('python', python);
SyntaxHighlighter.registerLanguage('javascript', javascript);
SyntaxHighlighter.registerLanguage('js', javascript);
SyntaxHighlighter.registerLanguage('typescript', typescript);
SyntaxHighlighter.registerLanguage('ts', typescript);
import {
  Send,
  Bot,
  User,
  TerminalSquare,
  Loader2,
  ChevronDown,
  ChevronRight,
  Clock,
  Settings,
  Terminal,
  AlertCircle,
  CheckCircle2,
  EyeOff,
  FileDiff,
  Square,
} from 'lucide-react';
import { invoke } from '@tauri-apps/api/tauri';
import { listen } from '@tauri-apps/api/event';
import { useSessionStore } from '../store/sessionStore';
import { useSettingsStore } from '../store/settingsStore';
import { askConfirm, cancelDialogs } from '../store/dialogStore';
import { ChatMessage, Session, AiProvider, AI_PROVIDERS } from '../types';
import { sleep, stripAnsi, sendAndCapture } from '../utils/terminal';
import {
  aiIsWriteCommand,
  auditorAllowsCommand,
  AI_DANGER_CMD,
  AUDITOR_REFUSAL,
  CONTROL_CHARS,
  isReadOnlyAgent,
  normalizeLineBreaks,
} from '../utils/aiGating';
import { pickAiSession } from '../utils/aiSession';
import { hiddenSecretGate } from '../utils/secrets/gate';
import { visibleToReadOnlyAgent } from '../utils/mcpGate';
import { runMcpTool } from '../utils/mcpRun';
import { cancelActiveMcpCalls, defaultMcpDeps } from '../utils/mcpRunDeps';
import type { McpToolInfo } from '../utils/mcpTypes';
import {
  prepareToolResult,
  rawErr,
  rawJson,
  rawOk,
  rawTerminal,
  type RawToolOutcome,
} from '../utils/secrets/forAi';
import { Intent, evaluateAll, summarize } from '../utils/intent';
import { savedHostId } from '../utils/tabs';
import { useSidePanelStore } from '../store/sidePanelStore';
import { resolveSshLogin } from '../utils/connect';
import { loginChoiceFor } from '../utils/logins';
import { backendVault } from '../utils/vaultAccess';
import { useAiBridge, type AiEditTarget } from '../store/aiBridgeStore';

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
  is_error?: boolean;
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
  isError?: boolean;
  /** "2 secrets hidden before the AI saw this …", or why output was withheld. */
  note?: string;
}

interface DisplayMessage extends ChatMessage {
  /** Stable id for React keys + memoization (assigned at creation). */
  id: string;
  toolExecutions?: ToolExecution[];
  isError?: boolean;
}

// Monotonic id for chat bubbles — stable keys let React.memo skip unchanged
// bubbles, so only the streaming message re-renders as tokens arrive.
let msgSeq = 0;
const nextMsgId = () => `m${++msgSeq}`;

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
- For configuration changes, always confirm with the user before executing — ask "Shall I apply this?" This applies to EVERY tool that can write or change state, not just send_terminal_command — including MCP tools. Some MCP servers name their write/destructive tool explicitly (e.g. a router-pattern server exposing invoke_read_tool for reads and a separate invoke_tool for writes) — treat that naming as a hard signal, not a suggestion, and always confirm before using the write path.
- GreenCLI checks every MCP call itself: it asks the user before calls that might change something, and refuses some. A result that starts with "Not run:" did not run. Tell the user; don't retry it another way.
- Format configs in code blocks for easy copying to the Config Editor panel
- You can execute show/diagnostic commands freely; be cautious with config changes
- GreenCLI hides device secrets (passwords, hashes, keys, SNMP communities, private keys) before you see any tool output: each value shows as \`<secret hidden>\`, and a whole line as \`<line hidden: secret>\`. Never put either marker in a command, REST body or tool argument: GreenCLI refuses the call, because it would write the marker over the real secret. To change a line that holds a hidden secret, leave that line alone or ask the user to make the change. If a result says its output is not shown, the tool ran but GreenCLI could not check the output for secrets on this system`;

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
      'NTP + timezone, syslog/logging configured, how passwords and secrets are stored ' +
      '(values arrive hidden, so judge by type: plaintext vs hashed or ciphertext, Cisco type 7 vs type 8/9, SNMP v1/v2c vs v3), ' +
      'and any default/unsecured services. Report findings as a prioritized list ' +
      '(Critical / Warning / Info), each with the offending config line and the recommended fix command.',
  },
  { label: 'Interface status', prompt: 'Show me all interfaces — which are up/down, speeds, and descriptions.' },
  { label: 'VLAN config', prompt: 'Show the current VLAN configuration including names and port assignments.' },
  {
    label: '🚑 Outage triage',
    prompt:
      'Run a safe, read-only outage triage for the connected device. Identify the OS, then gather version/uptime, interface status, logs/events, LLDP neighbors, routes/default gateway, and any vendor-specific health commands. Summarize likely causes, impacted interfaces/VLANs/sites, and next safe checks. Do not run any config-changing commands.',
  },
  {
    label: '🔍 Config drift check',
    prompt:
      'Compare the current running configuration against expected network hygiene. Pull read-only config/output, then report drift candidates: hostname/site naming, VLAN/interface descriptions, trunk/native VLANs, AAA, NTP, syslog, SNMP, spanning-tree protections, and Junos commit status when applicable. Provide findings and suggested commands only; do not apply changes.',
  },
  {
    label: '🧪 Pre-change check',
    prompt:
      'Prepare a pre-change validation checklist for this connected device. Run only safe show/read commands to capture current state: version, uptime, interface summary, neighbors, routes, VLANs, logs, and any pending/uncommitted config. Return a concise go/no-go assessment and rollback checkpoints.',
  },
  {
    label: '✅ Post-change validation',
    prompt:
      'Run a post-change validation using only safe read/show commands. Verify interface state, neighbors, routes, VLAN/client health, error counters, logs, and vendor-specific commit/deploy state. Summarize pass/fail items and any follow-up commands.',
  },
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
// (inline password, the host's shared login, else its saved vault password —
// the same resolver the SSH connect uses). `loginCmd` is the platform login
// command (api_login / aos8_login / aoss_login). Returns true on success.
async function tryDeviceLogin(session: Session, loginCmd: string): Promise<boolean> {
  const host = session.config.host;
  if (!host) return false;
  const { loginProfileId, folderLoginProfileId } = loginChoiceFor(
    useSessionStore.getState().folders,
    session.config
  );
  const resolved = await resolveSshLogin(
    // REST logins are always username + password, even for a key-auth SSH session.
    {
      ...session.config,
      protocol: 'ssh',
      authType: 'password',
      username: session.config.username || undefined,
      loginProfileId,
    },
    { profiles: useSettingsStore.getState().loginProfiles ?? [], folderLoginProfileId },
    backendVault
  );
  const username = resolved.username || 'admin';
  const password = resolved.password;
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

/** One MCP tool as mcp_all_tools lists it, plus its provider-safe name. */
type McpToolDef = McpToolInfo & {
  /** Unique, provider-safe tool name, assigned once (handles collisions). */
  safeName?: string;
};

type McpResolve = Map<string, { server: string; tool: string }>;

// Provider-safe tool name (Anthropic/OpenAI allow [a-zA-Z0-9_-], <=64 chars).
function mcpSafeName(server: string, tool: string): string {
  return `mcp__${server}__${tool}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64);
}

// ─── Execute a tool ───

/** A tool call's outcome: the text fed back to the model, plus whether it was a
 * failure — so the UI can stop painting errors with a green success check —
 * and a note when secrets were hidden or the output was withheld. */
interface ToolOutcome {
  text: string;
  isError: boolean;
  note?: string;
}

// Write-confirmation gate for AI-issued device actions lives in
// src/utils/aiGating.ts (imported above) so it is unit-testable.

/** Every tool result leaves through here: a call that sends a hidden-secret
 *  marker back is refused before any dialog or device contact, and every
 *  result (errors too) has its secrets hidden, then is capped, before the
 *  model sees it (src/utils/secrets/forAi.ts). */
async function executeTool(
  name: string,
  args: Record<string, unknown>,
  activeSession: Session | undefined,
  mcpResolve: McpResolve,
  shouldCancel: () => boolean,
  readOnlyAgent: boolean
): Promise<ToolOutcome> {
  const refusal = hiddenSecretGate(args);
  if (refusal) return { text: refusal, isError: true };
  return prepareToolResult(
    await executeToolRaw(name, args, activeSession, mcpResolve, shouldCancel, readOnlyAgent)
  );
}

/** Runs one tool and returns its raw, uncapped output. Only executeTool may call this. */
async function executeToolRaw(
  name: string,
  args: Record<string, unknown>,
  activeSession: Session | undefined,
  mcpResolve: McpResolve,
  shouldCancel: () => boolean,
  readOnlyAgent: boolean
): Promise<RawToolOutcome> {
  // Re-resolve the live session: a multi-step run can outlast the user switching
  // tabs or the device disconnecting, and the value captured at send time would
  // otherwise keep targeting a stale/dead session id.
  if (activeSession) {
    activeSession =
      useSessionStore.getState().sessions.find((s) => s.sessionId === activeSession!.sessionId) ??
      activeSession;
  }
  // Route MCP tools to the connected server, through the approval gate
  // (utils/mcpRun.ts). executeTool caps the result like every builtin tool —
  // a 145-tool cloud server can return megabytes of JSON.
  const mcp = mcpResolve.get(name);
  if (mcp) return runMcpTool(mcp.server, mcp.tool, args, { readOnlyAgent, shouldCancel }, defaultMcpDeps());
  // Aruba AOS-CX on-box REST (no Central). Auto-logs-in with the SSH creds.
  if (name === 'aruba_cx_rest') {
    const host = activeSession?.config.host;
    if (!host) return rawErr('Error: the active session has no host to query.');
    const method = (args.method as string) || 'GET';
    const path = (args.path as string) || '';
    const body = (args.body as string) || undefined;
    if (method.toUpperCase() !== 'GET') {
      // The Read-only Auditor never changes a device: refuse before any dialog.
      if (readOnlyAgent) return rawErr(AUDITOR_REFUSAL);
      const ok = await askConfirm({
        title: `Run ${method.toUpperCase()} ${path} on ${host}?`,
        message: body || 'This request may change switch state.',
        confirmLabel: 'Run request',
        danger: method.toUpperCase() === 'DELETE',
        group: 'ai',
      });
      if (!ok) return rawErr('User declined this write request.');
    }
    const doReq = () => invoke('api_request', { host, method, path, body });
    try {
      return rawJson(await doReq());
    } catch (e) {
      // Probably not logged into the REST API yet — try once with SSH creds.
      if (activeSession && (await tryDeviceLogin(activeSession, 'api_login'))) {
        try {
          return rawJson(await doReq());
        } catch (e2) {
          return rawErr(`Aruba CX REST error: ${e2}`);
        }
      }
      return rawErr(`Could not reach the switch REST API on ${host} (${e}). It may need REST enabled (\`https-server rest access-mode read-write\`) or a login in the API panel.`);
    }
  }
  // ArubaOS 8 controller/conductor — show command as JSON (no Central).
  if (name === 'aruba_aos8_show') {
    const host = activeSession?.config.host;
    if (!host) return rawErr('Error: the active session has no host to query.');
    const command = (args.command as string) || '';
    const doReq = () => invoke('aos8_show', { host, command });
    try {
      return rawJson(await doReq());
    } catch (e) {
      if (activeSession && (await tryDeviceLogin(activeSession, 'aos8_login'))) {
        try {
          return rawJson(await doReq());
        } catch (e2) {
          return rawErr(`AOS-8 REST error: ${e2}`);
        }
      }
      return rawErr(`Could not reach the AOS-8 controller API on ${host}:4343 (${e}).`);
    }
  }
  // Aruba AOS-S switch on-box REST (no Central).
  if (name === 'aruba_aoss_rest') {
    const host = activeSession?.config.host;
    if (!host) return rawErr('Error: the active session has no host to query.');
    const method = (args.method as string) || 'GET';
    const path = (args.path as string) || '';
    const body = (args.body as string) || undefined;
    if (method.toUpperCase() !== 'GET') {
      // The Read-only Auditor never changes a device: refuse before any dialog.
      if (readOnlyAgent) return rawErr(AUDITOR_REFUSAL);
      const ok = await askConfirm({
        title: `Run ${method.toUpperCase()} ${path} on ${host}?`,
        message: body || 'This request may change switch state.',
        confirmLabel: 'Run request',
        danger: method.toUpperCase() === 'DELETE',
        group: 'ai',
      });
      if (!ok) return rawErr('User declined this write request.');
    }
    const doReq = () => invoke('aoss_request', { host, method, path, body });
    try {
      return rawJson(await doReq());
    } catch (e) {
      if (activeSession && (await tryDeviceLogin(activeSession, 'aoss_login'))) {
        try {
          return rawJson(await doReq());
        } catch (e2) {
          return rawErr(`AOS-S REST error: ${e2}`);
        }
      }
      return rawErr(`Could not reach the AOS-S REST API on ${host} (${e}). It may need \`rest-interface\` enabled.`);
    }
  }
  // Evaluate desired-state intents against the live network.
  if (name === 'evaluate_network_intents') {
    try {
      const intents = await invoke<Intent[]>('intent_list');
      if (!intents.length) return rawErr('No network intents are defined yet (add them in the Intent panel — the Target icon).');
      const sessions = useSessionStore.getState().sessions;
      const updated = await evaluateAll(intents, sessions, shouldCancel);
      if (shouldCancel?.()) return rawErr('Intent evaluation cancelled.');
      return rawOk(summarize(updated));
    } catch (e) {
      return rawErr(`Intent evaluation failed: ${e}`);
    }
  }
  if (name === 'send_terminal_command') {
    const raw = (args.command as string) || '';
    // A dialog can't show a backspace or Ctrl-Z, and the device acts on them,
    // so the line the user approves may not be the line that runs: refuse.
    if (CONTROL_CHARS.test(raw)) {
      return rawErr(
        'Not run: the command contains control characters (such as backspace, Tab, Ctrl-Z or ESC). ' +
          'The device would act on them, so GreenCLI only sends plain text lines.'
      );
    }
    // Every line break as \n, so the confirm dialog shows each line the device runs.
    const command = normalizeLineBreaks(raw);
    // The Read-only Auditor never changes a device: anything but a plain read (no file-writing
    // pipes or redirects) is refused before any dialog.
    if (readOnlyAgent && !auditorAllowsCommand(command)) return rawErr(AUDITOR_REFUSAL);
    if (!activeSession) {
      return rawErr('Error: No active terminal session. Please connect to a device first.');
    }
    if (!activeSession.connected) {
      return rawErr('Error: Terminal session exists but device is not connected.');
    }
    if (aiIsWriteCommand(command)) {
      const ok = await askConfirm({
        title: `Run on ${activeSession.config.name || activeSession.config.host || 'device'}?`,
        message: command,
        confirmLabel: 'Run command',
        danger: AI_DANGER_CMD.test(command),
        group: 'ai',
      });
      if (!ok) return rawErr('User declined to run this command.');
    }
    try {
      const { output: cleaned, truncated } = await sendAndCapture(activeSession.sessionId, command);
      // executeTool keeps the tail (most relevant) when it caps this.
      return rawTerminal(cleaned, command, truncated);
    } catch (e) {
      return rawErr(`Failed to run command: ${e}`);
    }
  }
  return rawErr(`Unknown tool: ${name}`);
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
  onDelta: (text: string) => void,
  readOnlyAgent: boolean
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
    // Separate each tool-loop round's prose with a paragraph break, so a round-1
    // preamble ("Let me check…") isn't glued onto the round-2 summary. Guarding
    // on text avoids leaving a dangling separator when a round only calls a tool.
    const prefix = fullText + (fullText ? '\n\n' : '');
    const round = await streamAnthropicOnce(
      // Anthropic rejects an empty tools array once tool blocks appear in the
      // conversation — and an empty list has nothing to offer anyway.
      { model, max_tokens: 2048, system: systemPrompt, messages, ...(allTools.length ? { tools: allTools } : {}) },
      (t) => onDelta(t ? prefix + t : fullText)
    );
    if (round.text) fullText = prefix + round.text;

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
      const outcome = await executeTool(tu.name, tu.input, activeSession, mcpResolve, shouldCancel, readOnlyAgent);
      onToolCall({ name: tu.name, args: tu.input, result: outcome.text, isError: outcome.isError, note: outcome.note });
      toolResults.push({
        type: 'tool_result',
        tool_use_id: tu.id,
        content: outcome.text,
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: toolResults });
  }

  // Budget exhausted — one final streamed pass with tool use disabled so the
  // model summarises rather than discarding everything gathered. `tools` must
  // still be sent: the API rejects a conversation containing tool_use /
  // tool_result blocks when the request omits it (so dropping it made this
  // wrap-up 400 and silently fall through to the generic message below).
  const wrapPrefix = fullText + (fullText ? '\n\n' : '');
  const wrap = await streamAnthropicOnce(
    {
      model,
      max_tokens: 2048,
      system: systemPrompt,
      messages,
      ...(allTools.length ? { tools: allTools, tool_choice: { type: 'none' } } : {}),
    },
    (t) => onDelta(t ? wrapPrefix + t : fullText)
  ).catch(() => null);
  if (wrap?.text) fullText = wrapPrefix + wrap.text;
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
  onDelta: (text: string) => void,
  readOnlyAgent: boolean
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
    // Paragraph-break between rounds (see the Anthropic path for rationale).
    const prefix = fullText + (fullText ? '\n\n' : '');
    const round = await streamOpenAiOnce(
      provider,
      baseUrl,
      // Several OpenAI-compatible backends 400 on an empty tools array — omit it.
      { model, messages, ...(tools.length ? { tools } : {}) },
      (t) => onDelta(t ? prefix + t : fullText)
    );
    if (round.content) fullText = prefix + round.content;

    // Execute whenever tool calls were parsed, regardless of the reported
    // finish_reason: several OpenAI-compatible backends (notably Ollama) stream
    // populated tool_calls but report finish_reason 'stop', which the old
    // `finishReason !== 'tool_calls'` guard silently dropped. The iter cap and
    // the tool_choice:'none' wrap-up below still bound the loop.
    if (round.toolCalls.length === 0) {
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
      const outcome = await executeTool(tc.name, args, activeSession, mcpResolve, shouldCancel, readOnlyAgent);
      onToolCall({ name: tc.name, args, result: outcome.text, isError: outcome.isError, note: outcome.note });
      messages.push({ role: 'tool', tool_call_id: tc.id, content: outcome.text });
    }
  }

  // Final pass with tool use disabled so the model summarises what it gathered
  // instead of trying to call tools it can no longer use.
  const wrapPrefix = fullText + (fullText ? '\n\n' : '');
  const wrap = await streamOpenAiOnce(
    provider,
    baseUrl,
    { model, messages, ...(tools.length ? { tools, tool_choice: 'none' } : {}) },
    (t) => onDelta(t ? wrapPrefix + t : fullText)
  ).catch(() => null);
  if (wrap?.content) fullText = wrapPrefix + wrap.content;
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

// 'claude-sonnet-4-6' → 'sonnet 4.6', 'claude-haiku-4-5-20251001' → 'haiku 4.5'
// (the old split('-').slice(1, 3) dropped the minor version: 'sonnet 4').
function prettyClaudeModel(m: string): string {
  const s = m.replace(/^claude-/, '').replace(/-\d{8}$/, '');
  const vm = s.match(/^(.*?)-(\d+)-(\d+)$/);
  if (vm) return `${vm[1].replace(/-/g, ' ')} ${vm[2]}.${vm[3]}`;
  return s.replace(/-/g, ' ');
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


// One chat bubble, memoized. During streaming only the LAST message object is
// replaced (updateLast), so every other bubble keeps its identity and React.memo
// skips it — markdown is re-parsed (useMemo) only when this message's content
// changes. Tool-expansion state is local, so toggling one message's tool output
// never re-renders the rest of the conversation.
const MessageItem = memo(function MessageItem({ msg, editTarget }: { msg: DisplayMessage; editTarget: AiEditTarget | null }) {
  const [openTools, setOpenTools] = useState<Set<number>>(new Set());

  if (msg.role === 'user') {
    return (
      <div className="flex items-start gap-2 flex-row-reverse">
        <div className="flex-shrink-0 w-6 h-6 rounded-full bg-[var(--accent-soft)] flex items-center justify-center">
          <User size={12} className="text-[var(--accent)]" />
        </div>
        <div className="max-w-[88%] px-3 py-2 rounded-lg bg-[var(--accent-soft)] border border-[var(--accent-soft)] text-[var(--text-primary)]">
          <p className="text-[11px] leading-relaxed whitespace-pre-wrap">{msg.content}</p>
          <div className="text-[9px] text-[var(--text-muted)] mt-1 flex items-center gap-1 justify-end">
            <Clock size={7} />
            {new Date(msg.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    );
  }

  // The streaming assistant message starts blank; don't render an empty bubble
  // until it has content or a tool panel — the "Thinking…" pill covers that gap.
  if (!msg.content && !(msg.toolExecutions && msg.toolExecutions.length > 0) && !msg.isError) {
    return null;
  }

  return (
    <div className="flex items-start gap-2">
      <div className={`flex-shrink-0 w-6 h-6 rounded-full flex items-center justify-center ${msg.isError ? 'bg-[var(--accent-danger-soft)]' : 'bg-[var(--accent-violet-soft)]'}`}>
        {msg.isError ? (
          <AlertCircle size={12} className="text-[var(--accent-danger)]" />
        ) : (
          <Bot size={12} className="text-[var(--accent-violet)]" />
        )}
      </div>
      <div className="flex-1 min-w-0">
        {/* Tool executions */}
        {msg.toolExecutions && msg.toolExecutions.length > 0 && (
          <div className="mb-2 space-y-1">
            {msg.toolExecutions.map((te, ti) => {
              const open = openTools.has(ti);
              return (
                <div key={ti} className="border border-[var(--border)] rounded-lg overflow-hidden">
                  <button
                    onClick={() =>
                      setOpenTools((prev) => {
                        const next = new Set(prev);
                        if (next.has(ti)) next.delete(ti);
                        else next.add(ti);
                        return next;
                      })
                    }
                    className="w-full flex items-center gap-2 px-2.5 py-1.5 bg-[var(--bg-secondary)] hover:bg-[var(--bg-tertiary)] text-left transition-colors"
                  >
                    <Terminal size={10} className="text-[var(--accent-info)]" />
                    <code className="text-[10px] text-[var(--accent-info)] font-mono flex-1 truncate">
                      {(te.args.command as string) || te.name}
                    </code>
                    {te.note && (
                      <span title={te.note} aria-label={te.note} className="flex-shrink-0 flex">
                        <EyeOff size={9} className="text-[var(--text-muted)]" />
                      </span>
                    )}
                    {te.isError ? (
                      <AlertCircle size={9} className="text-[var(--accent-danger)] flex-shrink-0" />
                    ) : (
                      <CheckCircle2 size={9} className="text-[var(--accent-success)] flex-shrink-0" />
                    )}
                    {open ? (
                      <ChevronDown size={9} className="text-[var(--text-muted)]" />
                    ) : (
                      <ChevronRight size={9} className="text-[var(--text-muted)]" />
                    )}
                  </button>
                  {open && (
                    <div className="px-2.5 py-2 bg-[var(--bg-primary)] border-t border-[var(--border)] max-h-64 overflow-auto">
                      {te.note && (
                        <p className="mb-1.5 flex items-center gap-1 text-[10px] text-[var(--text-muted)]">
                          <EyeOff size={9} className="flex-shrink-0" />
                          {te.note}
                        </p>
                      )}
                      <pre className="text-[10px] text-[var(--text-secondary)] font-mono whitespace-pre-wrap break-words">{te.result}</pre>
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}

        {/* Message content */}
        <div className={`px-3 py-2 rounded-lg ${msg.isError ? 'bg-[var(--accent-danger-soft)] border border-[var(--accent-danger-border)] text-[var(--accent-danger)]' : 'bg-[var(--bg-secondary)] border border-[var(--border)] text-[var(--text-primary)]'}`}>
          <div className="space-y-0.5 text-[11px] leading-relaxed markdown-body">
            <ReactMarkdown
              remarkPlugins={[remarkGfm]}
              components={{
                code(props) {
                  const { children, className, node, ...rest } = props;
                  const match = /language-([\w-]+)/.exec(className || '');
                  const code = String(children).replace(/\n$/, '');
                  // A fenced block (with or without a language) gets Review in Editor.
                  return match || code.includes('\n') ? (
                    <div className="relative">
                      <SyntaxHighlighter
                        {...(rest as any)}
                        PreTag="div"
                        children={code}
                        language={match?.[1] ?? 'text'}
                        style={vscDarkPlus}
                        customStyle={{ margin: '8px 0', borderRadius: '8px', fontSize: '11px', padding: '12px', paddingTop: '28px' }}
                      />
                      <button
                        onClick={() => useAiBridge.getState().review({ code, target: editTarget, language: match?.[1] })}
                        className="absolute top-1.5 right-1.5 flex items-center gap-1 px-1.5 py-0.5 text-[10px] rounded bg-[var(--bg-tertiary)] hover:bg-[var(--border-strong)] border border-[var(--border)] text-[var(--text-primary)]"
                        title={
                          editTarget
                            ? `Compare with the lines you asked about in ${editTarget.tabName}, then Apply or Discard`
                            : 'Open this in a new editor tab'
                        }
                      >
                        <FileDiff size={10} />
                        {editTarget ? 'Review in Editor' : 'Open in Editor'}
                      </button>
                    </div>
                  ) : (
                    <code {...rest} className="px-1 py-0.5 bg-[var(--bg-primary)] border border-[var(--border)] rounded text-[var(--accent-warning)] text-[10px] font-mono">
                      {children}
                    </code>
                  );
                }
              }}
            >
              {msg.content}
            </ReactMarkdown>
          </div>
          <div className="text-[9px] text-[var(--text-muted)] mt-1.5 flex items-center gap-1">
            <Clock size={7} />
            {new Date(msg.timestamp).toLocaleTimeString()}
          </div>
        </div>
      </div>
    </div>
  );
});

// ─── Component ───

export default function AiAssistant() {
  // Narrow per-field selectors — whole-store subscriptions re-rendered the
  // panel on every unrelated session/settings change.
  const showAiAssistant = useSessionStore((s) => s.showAiAssistant);
  const activeSessionId = useSessionStore((s) => s.activeSessionId);
  const sessions = useSessionStore((s) => s.sessions);
  const settings = {
    aiProvider: useSettingsStore((s) => s.aiProvider),
    aiAgents: useSettingsStore((s) => s.aiAgents),
    sessionAgents: useSettingsStore((s) => s.sessionAgents),
    aiReferences: useSettingsStore((s) => s.aiReferences),
    aiUseTerminal: useSettingsStore((s) => s.aiUseTerminal),
    aiUseCxRest: useSettingsStore((s) => s.aiUseCxRest),
    aiUseMcp: useSettingsStore((s) => s.aiUseMcp),
    aiModel: useSettingsStore((s) => s.aiModel),
    localCliCommand: useSettingsStore((s) => s.localCliCommand),
    ollamaUrl: useSettingsStore((s) => s.ollamaUrl),
    ollamaModel: useSettingsStore((s) => s.ollamaModel),
    openrouterModel: useSettingsStore((s) => s.openrouterModel),
    moonshotModel: useSettingsStore((s) => s.moonshotModel),
  };

  const [messages, setMessages] = useState<DisplayMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  // "Thinking" shows on the side panel's AI tab and the activity bar, so a
  // long answer can run while you work in another tab.
  useEffect(() => {
    useSidePanelStore.getState().setStatus('ai', isLoading ? 'busy' : null);
  }, [isLoading]);
  const [hasKey, setHasKey] = useState(false);
  const [mcpToolCount, setMcpToolCount] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Lets us abandon an in-flight request (the underlying invoke still resolves
  // in the background, but its result is ignored).
  const requestSeq = useRef(0);
  // Coalesce streaming deltas to one DOM update per animation frame instead of
  // one per token (providers emit dozens/sec). The cumulative text is parked in a
  // ref and flushed at ~60fps max, so the streaming bubble repaints smoothly
  // without flooding React's render loop.
  const pendingTextRef = useRef<string | null>(null);
  const rafRef = useRef<number>(0);
  // Cache of MCP tool definitions so sends don't pay an IPC round-trip to refetch
  // them every time (the data is already in-memory in the backend).
  const mcpToolsRef = useRef<McpToolDef[]>([]);

  // The device the AI's tools act on. Never a local tab (shell or AI CLI):
  // see utils/aiSession.ts.
  const activeSession = pickAiSession(sessions, activeSessionId);

  // Per-session AI agent: the persona attached to this session in the sidebar.
  // Its instructions extend the system prompt; its provider/model override the
  // global AI settings for this session only.
  // Agents are attached to the saved HOST, so every tab of it shares one.
  const activeAgent = (settings.aiAgents ?? []).find(
    (a) => a.id === (activeSession ? settings.sessionAgents?.[savedHostId(activeSession.config)] : undefined)
  );

  // Autoscroll only while the user is pinned to the bottom — yanking the view
  // down on every streamed token makes scrollback unreadable mid-response.
  const pinnedRef = useRef(true);
  const onChatScroll = () => {
    const el = scrollRef.current;
    if (el) pinnedRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48;
  };
  useEffect(() => {
    if (scrollRef.current && pinnedRef.current) {
      scrollRef.current.scrollTop = scrollRef.current.scrollHeight;
    }
  }, [messages, isLoading]);

  // Track whether the selected provider has a key stored in the Rust key store.
  // Re-check on provider change AND when the Settings modal closes (a key may
  // have just been added there).
  const showSettings = useSessionStore((s) => s.showSettings);
  useEffect(() => {
    // Honour an agent's provider override so the header readiness reflects the
    // key the next send will actually use.
    const provider = activeAgent?.provider || settings.aiProvider || 'ollama';
    invoke<boolean>('ai_has_key', { provider })
      .then(setHasKey)
      .catch(() => setHasKey(false));
  }, [settings.aiProvider, activeAgent?.provider, showSettings]);

  // Count tools from connected MCP servers (refresh when Settings closes, since
  // servers may have just been connected there).
  useEffect(() => {
    invoke<{ connected: boolean; toolCount: number }[]>('mcp_status')
      .then((st) =>
        setMcpToolCount((st || []).filter((s) => s.connected).reduce((a, s) => a + (s.toolCount || 0), 0))
      )
      .catch(() => setMcpToolCount(0));
  }, [showSettings, showAiAssistant]);

  // Pre-fetch the full MCP tool list into a ref so sendMessage doesn't await it on
  // the hot path. Refreshes when the panel opens, Settings close, or MCP is
  // toggled — the same moments a server could have (dis)connected.
  useEffect(() => {
    if (!settings.aiUseMcp) {
      mcpToolsRef.current = [];
      return;
    }
    invoke<McpToolDef[]>('mcp_all_tools')
      .then((t) => {
        mcpToolsRef.current = t || [];
      })
      .catch(() => {
        /* keep the last known list */
      });
  }, [settings.aiUseMcp, showSettings, showAiAssistant]);

  /** `target`: the editor lines this question is about (Ask AI), so a code
   *  block in the answer can be reviewed as a diff against them. */
  const sendMessage = useCallback(async (content: string, target?: AiEditTarget) => {
    if (!content.trim() || isLoading) return;

    const userMsg: DisplayMessage = { id: nextMsgId(), role: 'user', content: content.trim(), timestamp: Date.now() };
    if (target) useAiBridge.getState().setTarget(userMsg.id, target);
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);
    pinnedRef.current = true; // sending re-pins the view to follow the reply
    const myReq = ++requestSeq.current; // token to detect cancellation/supersede

    // The assistant talks to providers from the Rust backend. In a plain browser
    // tab there is no Tauri IPC, so fail with a clear message instead of a cryptic
    // "window.__TAURI_IPC__ is not a function".
    if (!('__TAURI_IPC__' in window)) {
      setMessages((prev) => [
        ...prev,
        {
          id: nextMsgId(),
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

    // The attached agent may override the provider for this session.
    const provider: AiProvider = (activeAgent?.provider || settings.aiProvider || 'ollama') as AiProvider;
    const providerMeta = AI_PROVIDERS.find((p) => p.value === provider);

    // Guard: key-based providers need a key in the Rust key store. Fast path: trust
    // the cached `hasKey` (kept fresh by the effect on provider/agent change and
    // when Settings close) so a send with a configured key costs ZERO pre-stream
    // IPC. Only pay the round-trip when we think there's no key — the one case
    // where a stale cache could wrongly block (a key just added in Settings).
    if (providerMeta?.needsKey) {
      let keyPresent = hasKey;
      if (!keyPresent) {
        keyPresent = await invoke<boolean>('ai_has_key', { provider }).catch(() => false);
        setHasKey(keyPresent);
      }
      if (!keyPresent) {
        setMessages((prev) => [
          ...prev,
          {
            id: nextMsgId(),
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
    let systemPrompt = SYSTEM_PROMPT(deviceContext, settings.aiReferences || '');
    if (activeAgent?.instructions?.trim()) {
      systemPrompt +=
        `\n\n## Active agent: ${activeAgent.name}\n` +
        `The user attached this agent persona to the current session — follow it carefully:\n` +
        activeAgent.instructions.trim();
    }
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

    // MCP tools — only when enabled — available to EVERY provider (Anthropic
    // and the OpenAI-compatible ones alike), not just Claude.
    let mcpTools: McpToolDef[] = [];
    if (settings.aiUseMcp) {
      // Use the pre-fetched cache; only hit the backend if it's somehow empty.
      mcpTools = mcpToolsRef.current;
      if (mcpTools.length === 0) {
        try {
          mcpTools = (await invoke<McpToolDef[]>('mcp_all_tools')) || [];
          mcpToolsRef.current = mcpTools;
        } catch {
          mcpTools = [];
        }
      }
    }
    // The Read-only Auditor only sees tools the server marks read-only (and the
    // Junos show tools); GreenCLI refuses its other calls in any case.
    const readOnlyAgent = isReadOnlyAgent(activeAgent);
    if (readOnlyAgent) mcpTools = mcpTools.filter(visibleToReadOnlyAgent);
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
      // eslint-disable-next-line react-hooks/immutability
      t.safeName = nm;
      mcpResolve.set(nm, { server: t.server, tool: t.name });
    }

    const shouldCancel = () => requestSeq.current !== myReq;

    // Live streaming bubble: append an empty assistant message and update it as
    // tokens arrive (the last message is always the in-progress one).
    setMessages((prev) => [...prev, { id: nextMsgId(), role: 'assistant', content: '', timestamp: Date.now() }]);
    const updateLast = (patch: Partial<DisplayMessage>) =>
      setMessages((prev) => {
        const copy = [...prev];
        const i = copy.length - 1;
        if (i >= 0 && copy[i].role === 'assistant') copy[i] = { ...copy[i], ...patch };
        return copy;
      });
    // Cancel any scheduled flush and drop the parked text (used before writing the
    // final/complete text, and on cancel, so a late frame can't overwrite it).
    const stopFlush = () => {
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      pendingTextRef.current = null;
    };
    // onText hands us the CUMULATIVE text each delta, so we just park the latest
    // value and repaint once per frame — dropping intermediate frames is lossless.
    const onDelta = (t: string) => {
      pendingTextRef.current = t;
      if (!rafRef.current) {
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0;
          const pending = pendingTextRef.current;
          pendingTextRef.current = null;
          if (pending != null && requestSeq.current === myReq) updateLast({ content: pending });
        });
      }
    };
    // Surface each tool execution the moment it completes (rather than only when
    // the whole response finishes), so the tool panel appears live and a Stop
    // mid-run keeps the partial tool output already gathered.
    const onToolCall = (tool: ToolExecution) => {
      collectedTools.push(tool);
      if (requestSeq.current === myReq) updateLast({ toolExecutions: [...collectedTools] });
    };

    try {
      let text = '';

      if (provider === 'anthropic') {
        text = await callAnthropicWithTools(
          apiMessages,
          activeAgent?.model || settings.aiModel || 'claude-sonnet-4-6',
          systemPrompt,
          activeSession,
          onToolCall,
          mcpTools,
          mcpResolve,
          builtinTools,
          shouldCancel,
          onDelta,
          readOnlyAgent
        );
      } else if (provider === 'local-cli') {
        // One-shot CLI — no token streaming. An agent may override the CLI command.
        text = await callLocalCli(
          activeAgent?.model || settings.localCliCommand || 'claude -p',
          apiMessages,
          systemPrompt,
          activeSession
        );
      } else {
        // OpenAI-compatible: openrouter | moonshot | ollama — each has its own model.
        const model =
          activeAgent?.model ||
          (provider === 'ollama'
            ? settings.ollamaModel || 'llama3.2'
            : provider === 'openrouter'
              ? settings.openrouterModel || 'anthropic/claude-3.5-sonnet'
              : settings.moonshotModel || 'kimi-k2-0905-preview');
        text = await callOpenAiCompatWithTools(
          provider,
          settings.ollamaUrl || 'http://localhost:11434',
          model,
          apiMessages,
          systemPrompt,
          activeSession,
          onToolCall,
          mcpTools,
          mcpResolve,
          builtinTools,
          shouldCancel,
          onDelta,
          readOnlyAgent
        );
      }

      if (requestSeq.current !== myReq) return; // superseded or cancelled
      stopFlush(); // beat any pending frame so it can't overwrite the final text
      updateLast({
        content: text,
        toolExecutions: collectedTools.length > 0 ? [...collectedTools] : undefined,
      });
    } catch (e: unknown) {
      if (requestSeq.current !== myReq) return; // cancelled — keep the partial bubble
      stopFlush();
      const errMsg = e instanceof Error ? e.message : String(e);
      updateLast({
        content: `**AI Error:** ${errMsg}`,
        isError: true,
        toolExecutions: collectedTools.length > 0 ? [...collectedTools] : undefined,
      });
    } finally {
      if (requestSeq.current === myReq) setIsLoading(false);
    }
  }, [messages, isLoading, settings, activeSession, activeAgent, hasKey]);

  // A question from the Config Editor (Ask AI): sent as soon as the panel is free.
  const editTargets = useAiBridge((s) => s.targets);
  // An answer's code goes back to the lines the conversation's latest Ask AI
  // question was about.
  const answerTargets = useMemo(() => {
    const out = new Map<string, AiEditTarget>();
    let target: AiEditTarget | undefined;
    for (const msg of messages) {
      if (msg.role === 'user') target = editTargets.get(msg.id) ?? target;
      else if (target) out.set(msg.id, target);
    }
    return out;
  }, [messages, editTargets]);
  const pendingAsk = useAiBridge((s) => s.pendingAsk);
  useEffect(() => {
    if (!pendingAsk || isLoading) return;
    const ask = useAiBridge.getState().takeAsk();
    if (ask) void sendMessage(ask.prompt, ask.target);
  }, [pendingAsk, isLoading, sendMessage]);

  // Abandon the in-flight request: bump the guard, abort the backend stream(s) so
  // the provider stops generating, and drop a trailing empty assistant bubble left
  // by a Stop pressed before any token streamed in.
  const cancelRequest = useCallback(() => {
    requestSeq.current++;
    if (rafRef.current) {
      cancelAnimationFrame(rafRef.current);
      rafRef.current = 0;
    }
    pendingTextRef.current = null;
    setIsLoading(false);
    cancelActiveAiStreams();
    // Settle any approval box the run left open (as No) and cancel MCP calls in flight.
    cancelDialogs('ai');
    cancelActiveMcpCalls();
    setMessages((prev) =>
      prev.length && prev[prev.length - 1].role === 'assistant' && !prev[prev.length - 1].content
        ? prev.slice(0, -1)
        : prev
    );
  }, []);

  // On a REAL unmount (window close — App now keeps the panel mounted across
  // open/close so chat history survives), abandon any in-flight request:
  // without this the tool loop keeps running commands on the live device with
  // no UI attached (shouldCancel reads requestSeq, which nothing would bump).
  // Mirrors cancelRequest, minus the state updates that are meaningless on an
  // unmounted component.
  useEffect(
    () => () => {
      requestSeq.current++;
      if (rafRef.current) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = 0;
      }
      pendingTextRef.current = null;
      cancelActiveAiStreams();
      cancelDialogs('ai');
      cancelActiveMcpCalls();
    },
    []
  );

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendMessage(input);
    }
  };

  // App keeps this panel MOUNTED across open/close (chat history survives);
  // "closed" just hides the root via CSS below.

  // Effective provider/model for the header — an attached agent may override both.
  const provider = (activeAgent?.provider || settings.aiProvider || 'ollama') as AiProvider;
  const providerMeta = AI_PROVIDERS.find((p) => p.value === provider);
  const isLocalProvider = provider === 'ollama' || provider === 'local-cli';
  const isReady = !providerMeta?.needsKey || hasKey;
  const providerLabel =
    activeAgent?.model ||
    (provider === 'ollama'
      ? settings.ollamaModel || 'llama3.2'
      : provider === 'local-cli'
        ? settings.localCliCommand || 'CLI'
        : provider === 'anthropic'
          ? (settings.aiModel ? prettyClaudeModel(settings.aiModel) : 'Claude')
          : provider === 'openrouter'
            ? settings.openrouterModel || providerMeta?.label || provider
            : settings.moonshotModel || providerMeta?.label || provider);

  const openAiSettings = () => {
    const s = useSessionStore.getState();
    s.setSettingsFocus('ai');
    s.setShowSettings(true);
  };

  return (
    // A tab of the side panel (SidePanel owns the frame: width, drag handle,
    // maximize and close). App keeps it mounted, so the chat survives closing.
    <div
      id="side-panel-ai"
      role="tabpanel"
      aria-labelledby="side-tab-ai"
      className={`${showAiAssistant ? '' : 'hidden '}absolute inset-0 flex flex-col bg-[var(--bg-primary)] overflow-hidden`}
      aria-hidden={!showAiAssistant}
    >
      {/* Context bar: the device the assistant acts on (left), and the model
          answering plus MCP tools (right). The model chip opens AI settings —
          it replaces the panel's old header row now that the side panel's
          tab strip names the panel. */}
      <div className="flex items-center gap-2 h-9 px-3 border-b border-[var(--border)] bg-[var(--bg-secondary)] flex-shrink-0">
        <Terminal
          size={11}
          className="flex-shrink-0"
          style={{ color: activeSession?.connected ? 'var(--accent-success)' : 'var(--text-muted)' }}
        />
        {activeSession ? (
          <span className="min-w-0 truncate text-[11px] text-[var(--text-secondary)]">
            <span className="text-[var(--text-primary)]">{activeSession.config.name}</span>
            <span className="mx-1 text-[var(--text-muted)]">·</span>
            {activeSession.config.deviceType}
            <span className="mx-1 text-[var(--text-muted)]">·</span>
            <span style={{ color: activeSession.connected ? 'var(--accent-success)' : 'var(--text-muted)' }}>
              {activeSession.connected ? 'connected' : 'disconnected'}
            </span>
          </span>
        ) : (
          <span className="min-w-0 truncate text-[11px] text-[var(--text-muted)]">No active session</span>
        )}
        {activeAgent && (
          <button
            onClick={() => {
              const s = useSessionStore.getState();
              s.setSettingsFocus('agents');
              s.setShowSettings(true);
            }}
            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0"
            style={{ color: activeAgent.color, background: `${activeAgent.color}1f` }}
            title={
              isReadOnlyAgent(activeAgent)
                ? `AI agent "${activeAgent.name}" is active for this session. It can't change devices. It only uses MCP tools the server marks as read-only or as checks (checks ask first), plus Junos show commands. Click to manage.`
                : `AI agent "${activeAgent.name}" is active for this session — click to manage`
            }
          >
            <Bot size={10} />
            {activeAgent.name}
          </button>
        )}
        <span className="flex-1" />
        {mcpToolCount > 0 && (
          <span
            className="flex items-center gap-1 text-[10px] px-1.5 py-0.5 rounded-full flex-shrink-0 whitespace-nowrap"
            style={{ color: 'var(--accent)', background: 'var(--accent-soft)' }}
            title="Tools available from connected MCP servers"
          >
            <span className="w-1.5 h-1.5 rounded-full" style={{ background: 'var(--accent)' }} />
            {mcpToolCount} MCP tools
          </span>
        )}
        <button
          onClick={openAiSettings}
          className="flex items-center gap-1 max-w-[45%] text-[10px] pl-1.5 pr-1 py-0.5 rounded-full flex-shrink-0 transition-[filter] hover:brightness-110"
          style={{
            color: isLocalProvider ? 'var(--accent-info)' : 'var(--accent-success)',
            background: `color-mix(in srgb, ${isLocalProvider ? 'var(--accent-info)' : 'var(--accent-success)'} 14%, transparent)`,
          }}
          title={`Answering with ${providerLabel} — click to change the AI provider or model`}
          aria-label={`AI model: ${providerLabel}. Open AI settings`}
        >
          <span className="truncate">
            {isLocalProvider ? '⬡ ' : '✦ '}
            {providerLabel}
          </span>
          <Settings size={10} className="flex-shrink-0 opacity-80" />
        </button>
      </div>

      {/* Warning when not ready */}
      {!isReady && (
        <div className="mx-3 mt-3 px-3 py-2 bg-[var(--accent-warning-soft)] border border-[var(--accent-warning-border)] rounded-lg flex items-start gap-2">
          <AlertCircle size={12} className="text-[var(--accent-warning)] flex-shrink-0 mt-0.5" />
          <div className="text-[10px] text-[var(--accent-warning)] leading-relaxed">
            Add an API key for <strong>{providerMeta?.label}</strong> in <strong>Settings → AI &amp; MCP</strong>, or switch to a local provider (Ollama / Local CLI).
          </div>
        </div>
      )}

      {/* Chat */}
      <div ref={scrollRef} onScroll={onChatScroll} className="flex-1 overflow-y-auto px-3 py-3 space-y-3">
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
                <ChevronRight size={10} className="text-[var(--accent-violet)]" />
                {p.label}
              </button>
            ))}
          </div>
        )}

        {/* Messages */}
        {messages.map((msg) => (
          <MessageItem key={msg.id} msg={msg} editTarget={answerTargets.get(msg.id) ?? null} />
        ))}

        {/* Loading — only the standalone "Thinking…" pill until the assistant
            bubble has actual content or a tool panel to show, so we don't render
            an empty bubble and a "Thinking…" indicator at the same time. */}
        {isLoading &&
          (() => {
            const last = messages[messages.length - 1];
            const streaming =
              last?.role === 'assistant' &&
              (!!last.content || (last.toolExecutions?.length ?? 0) > 0);
            return !streaming;
          })() && (
            <div className="flex items-center gap-2">
              <div className="w-6 h-6 rounded-full bg-[var(--accent-violet-soft)] flex items-center justify-center flex-shrink-0">
                <Bot size={12} className="text-[var(--accent-violet)]" />
              </div>
              <div className="flex items-center gap-1.5 px-3 py-2 bg-[var(--bg-secondary)] border border-[var(--border)] rounded-lg text-[11px] text-[var(--text-secondary)]">
                <Loader2 size={11} className="animate-spin text-[var(--accent-violet)]" />
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
            className="flex-1 text-xs bg-[var(--bg-primary)] border border-[var(--border)] rounded-lg px-3 py-2 text-[var(--text-primary)] placeholder-[var(--text-muted)] focus:outline-none focus:border-[var(--accent)] resize-none max-h-28 disabled:opacity-50"
            style={{ minHeight: '36px' }}
          />
          {isLoading ? (
            <button
              type="button"
              onClick={cancelRequest}
              title="Stop"
              className="flex items-center justify-center w-9 h-9 bg-[var(--danger-solid)] hover:brightness-110 text-[var(--danger-solid-fg)] rounded-lg transition-colors flex-shrink-0"
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
// ─── Message bubble ───
