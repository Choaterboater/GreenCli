// Runs one AI-issued MCP tool call: check it, ask the user when the gate says
// so, check the tool again after the answer, then call it. No Tauri or store
// imports; the real wiring is in mcpRunDeps.ts, so tests use fakes.
//
// Every early return is a refusal the model reads (rawErr). A refusal that
// starts with "Not run:" never ran; "Stopped." means the user pressed Stop.

import { decideMcpCall, toolFingerprint, type McpAnswer } from './mcpGate';
import type { CapabilitySafety } from './mcpLabels';
import { argsSize, showArgs, showName, showText } from './mcpShow';
import type { McpToolInfo } from './mcpTypes';
import { hiddenSecretGate } from './secrets/gate';
import { rawErr, rawJson, type RawToolOutcome } from './secrets/forAi';

export const MAX_MCP_ARGUMENT_BYTES = 16_384;

export const SAID_NO = "Not run: the user said no. Don't try this call again unless the user asks.";
export const STOPPED = 'Stopped. Nothing ran.';
export const STOPPED_IN_FLIGHT =
  'Stopped. GreenCLI asked the server to cancel the call, but it may have finished already.';
export const GONE = (server: string, tool: string) =>
  `Not run: ${server} no longer offers ${tool}. It may have disconnected or changed its tools.`;
export const CHANGED = (server: string, tool: string) =>
  `Not run: ${tool} on ${server} changed while the user was deciding. Ask again if it is still needed.`;
export const TOO_LONG = 'Not run: the arguments are too long to show the user in full (over 16 KB).';

/** What the approval box shows. All display text is already cleaned (mcpShow.ts). */
export interface McpAskRequest {
  server: string;
  tool: string;
  label: CapabilitySafety;
  notes: string[];
  argsText: string;
  argsSummary: string;
  choices: McpAnswer[];
  danger: boolean;
}

export interface McpRunDeps {
  toolInfo(server: string, tool: string): Promise<McpToolInfo | null>;
  call(server: string, tool: string, args: Record<string, unknown>, callId: string, readOnly: boolean): Promise<string>;
  /** null: closed, Escape, or Stop. */
  ask(request: McpAskRequest): Promise<McpAnswer | null>;
  isAllowed(server: string, tool: string, fingerprint: string): boolean;
  allow(server: string, tool: string, fingerprint: string): void;
  newCallId(): string;
  /** Returns untrack. */
  trackCall(callId: string): () => void;
}

export interface McpRunContext {
  readOnlyAgent: boolean;
  shouldCancel: () => boolean;
}

/** The live tool, or a refusal when it is gone or blocked. */
async function liveTool(
  deps: McpRunDeps,
  server: string,
  tool: string
): Promise<{ tool: McpToolInfo } | { refusal: string }> {
  let live: McpToolInfo | null;
  try {
    live = await deps.toolInfo(server, tool);
  } catch {
    live = null;
  }
  if (!live) return { refusal: GONE(server, tool) };
  if (live.blocked) return { refusal: `Not run: ${live.blocked}` };
  return { tool: live };
}

export async function runMcpTool(
  server: string,
  tool: string,
  args: Record<string, unknown>,
  ctx: McpRunContext,
  deps: McpRunDeps
): Promise<RawToolOutcome> {
  // 1. A hidden-secret marker in the arguments: refuse before any dialog or lookup.
  const secretRefusal = hiddenSecretGate(args);
  if (secretRefusal) return rawErr(secretRefusal);
  // 2. The user must be able to read every argument they approve.
  if (new TextEncoder().encode(JSON.stringify(args) ?? '').length > MAX_MCP_ARGUMENT_BYTES) {
    return rawErr(TOO_LONG);
  }
  // 3.
  if (ctx.shouldCancel()) return rawErr(STOPPED);
  // 4. The tool as the server offers it now (not the AI's cached list).
  const first = await liveTool(deps, server, tool);
  if ('refusal' in first) return rawErr(first.refusal);
  const live = first.tool;
  // 5-6.
  const fingerprint = toolFingerprint(live);
  const decision = decideMcpCall({
    tool: live,
    args,
    allowedForSession: deps.isAllowed(server, tool, fingerprint),
    readOnlyAgent: ctx.readOnlyAgent,
  });
  if (decision.kind === 'refuse') return rawErr(decision.text);
  // 7. Ask, then check again: the tool, the server or Stop may have changed while the box was open.
  if (decision.kind === 'ask') {
    const answer = await deps.ask({
      server: showName(server),
      tool: showName(tool),
      label: decision.label,
      notes: decision.notes.map(showText),
      argsText: showArgs(args),
      argsSummary: argsSize(args),
      choices: decision.choices,
      danger: decision.danger,
    });
    if (ctx.shouldCancel()) return rawErr(STOPPED);
    if (answer !== 'once' && answer !== 'session') return rawErr(SAID_NO);
    const second = await liveTool(deps, server, tool);
    if ('refusal' in second) return rawErr(second.refusal);
    if (toolFingerprint(second.tool) !== fingerprint) return rawErr(CHANGED(server, tool));
    const again = decideMcpCall({
      tool: second.tool,
      args,
      allowedForSession: false,
      readOnlyAgent: ctx.readOnlyAgent,
    });
    if (again.kind === 'refuse') return rawErr(again.text);
    if (answer === 'session' && decision.choices.includes('session')) deps.allow(server, tool, fingerprint);
  }
  // 8.
  if (ctx.shouldCancel()) return rawErr(STOPPED);
  // 9. Call it, stoppable by id.
  const callId = deps.newCallId();
  const untrack = deps.trackCall(callId);
  try {
    return rawJson(await deps.call(server, tool, args, callId, ctx.readOnlyAgent));
  } catch (e) {
    const msg = String(e);
    // GreenCLI's own refusals and Stop texts from Rust pass through as they are, so a call that
    // was never sent is never reported as "may have finished".
    if (msg.startsWith('Not run: ') || msg.startsWith('Stopped.')) return rawErr(msg);
    return rawErr(ctx.shouldCancel() ? STOPPED_IN_FLIGHT : `MCP tool ${server}/${tool} failed: ${msg}`);
  } finally {
    untrack();
  }
}
