// The real wiring for runMcpTool (mcpRun.ts): Tauri commands, the approval
// box, the session allowances, and the ids Stop uses to cancel calls.
import { invoke } from '@tauri-apps/api/tauri';
import { askChoice, type DialogChoice } from '../store/dialogStore';
import { useMcpApprovalStore } from '../store/mcpApprovalStore';
import type { McpAnswer } from './mcpGate';
import type { McpAskRequest, McpRunDeps } from './mcpRun';
import { showName } from './mcpShow';
import type { McpToolInfo } from './mcpTypes';

/** Ids of the MCP calls in flight, so Stop can cancel them. */
const activeMcpCalls = new Set<string>();
let seq = 0;

/** Stop: ask the backend to cancel every MCP call in flight. */
export function cancelActiveMcpCalls(): void {
  for (const id of activeMcpCalls) {
    invoke('mcp_cancel_call', { callId: id }).catch(() => {});
  }
}

/** The approval box buttons, in the order the gate gives them. */
export function mcpChoices(request: McpAskRequest): DialogChoice[] {
  const all: Record<McpAnswer, DialogChoice> = {
    no: { value: 'no', label: 'No', detail: 'Nothing runs', tone: 'plain' },
    once: {
      value: 'once',
      label: 'Yes, this once',
      detail: 'Runs this call only',
      tone: request.danger ? 'danger' : 'accent',
    },
    session: {
      value: 'session',
      label: 'Yes, for this session',
      detail: `${showName(request.tool)} on ${showName(request.server)} won't ask again until GreenCLI closes or the tool or server changes`,
      tone: 'accent',
    },
  };
  return request.choices.map((choice) => all[choice]);
}

async function askUser(request: McpAskRequest): Promise<McpAnswer | null> {
  const value = await askChoice({
    group: 'ai',
    title: `Run ${showName(request.tool)} on ${showName(request.server)}?`,
    notes: request.notes,
    details: request.argsText,
    detailsLabel: `Arguments (${request.argsSummary})`,
    choices: mcpChoices(request),
  });
  return value === 'no' || value === 'once' || value === 'session' ? value : null;
}

export function defaultMcpDeps(): McpRunDeps {
  return {
    toolInfo: (server, tool) => invoke<McpToolInfo | null>('mcp_tool_info', { server, tool }),
    call: (server, tool, args, callId, readOnly) =>
      invoke<string>('mcp_call', { server, tool, args, callId, readOnly }),
    ask: askUser,
    isAllowed: (server, tool, fingerprint) => useMcpApprovalStore.getState().isAllowed(server, tool, fingerprint),
    allow: (server, tool, fingerprint) => useMcpApprovalStore.getState().allow(server, tool, fingerprint),
    newCallId: () => `mcp-${Date.now().toString(36)}-${++seq}`,
    trackCall: (callId) => {
      activeMcpCalls.add(callId);
      return () => {
        activeMcpCalls.delete(callId);
      };
    },
  };
}
