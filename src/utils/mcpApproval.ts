// Partly copied from casper src/capabilities/approval.ts @ ad678b6 (MIT). Kept: router, confirm and preview-switch checks. Keep in step by hand.
// Changed here: the imports point at ./mcpLabels and ./mcpTypes, ApprovalPlan has no `hint`, and
// MAX_DEPTH is exported (mcpGate.ts refuses arguments nested deeper than walk() looks).
// Left out: the call modes, the preview, secret masking and box formatting (approval.ts:171-437);
// GreenCLI cleans the box text itself (mcpShow.ts).
import type { MCPTool } from "./mcpTypes";
import { nameLabel, strictest, type CapabilitySafety } from "./mcpLabels";

export interface RoutedCall { name: string; arguments: Record<string, unknown> }

export interface ApprovalPlan {
  server: string;
  /** The MCP tool Casper calls (a router such as invoke_tool, or the tool itself). */
  tool: string;
  /** The tool's own label (toolLabel). */
  label: CapabilitySafety;
  schema: MCPTool["inputSchema"];
  arguments: Record<string, unknown>;
  /** The real tools behind a router call; empty for a direct call. */
  routed: RoutedCall[];
  /** The tool looks like a router, but Casper could not tell which tool it runs. */
  routerUnclear: boolean;
}

export const PREVIEW_KEYS = ["dry_run", "dryRun", "preview", "check_only", "validate_only"] as const;
export const CONFIRM_KEYS = ["confirm", "confirmed", "force"] as const;
/** Any spelling of a key a server may read as confirm or as a preview switch: case, "-" and "_"
 * don't matter (Confirm, CONFIRMED, dry-run, DryRun), and "confirmation" counts as confirm. */
const CONFIRM_WORDS = new Set(["confirm", "confirmed", "confirmation", "force"]);
const PREVIEW_WORDS = new Set(["dryrun", "preview", "checkonly", "validateonly"]);
function keyWord(key: string): string { return key.toLowerCase().replace(/[^a-z0-9]/g, ""); }
function isConfirmKey(key: string): boolean { return CONFIRM_WORDS.has(keyWord(key)); }
function isPreviewKey(key: string): boolean { return PREVIEW_WORDS.has(keyWord(key)); }
export const MAX_DEPTH = 32;

const ROUTER_NAME = /invoke|dispatch|call_tool|run_tool/i;
const INNER_NAME_KEYS = ["name", "tool", "tool_name"] as const;
const INNER_ARGS_KEYS = ["arguments", "args", "params"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function innerCall(value: unknown): RoutedCall | undefined {
  if (!isRecord(value)) return undefined;
  const nameKey = INNER_NAME_KEYS.find((key) => typeof value[key] === "string" && value[key] !== "");
  if (!nameKey) return undefined;
  const argsKey = INNER_ARGS_KEYS.find((key) => isRecord(value[key]));
  return { name: value[nameKey] as string, arguments: argsKey ? value[argsKey] as Record<string, unknown> : {} };
}

/** The real tools a router-shaped call runs: {name, arguments} or calls[] of the same. */
export function routedCalls(tool: string, args: Record<string, unknown>): RoutedCall[] {
  if (!ROUTER_NAME.test(tool)) return [];
  const calls: RoutedCall[] = [];
  const single = innerCall(args);
  if (single) calls.push(single);
  if (Array.isArray(args.calls)) for (const entry of args.calls) {
    const call = innerCall(entry);
    if (call) calls.push(call);
  }
  return calls;
}

export function isRouterName(tool: string): boolean { return ROUTER_NAME.test(tool); }

export function buildPlan(input: {
  server: string; tool: string; label: CapabilitySafety; schema: MCPTool["inputSchema"];
  arguments: Record<string, unknown>;
}): ApprovalPlan {
  const routed = routedCalls(input.tool, input.arguments);
  const batch = Array.isArray(input.arguments.calls) ? input.arguments.calls.length : 0;
  const routerUnclear = isRouterName(input.tool)
    && (routed.length === 0 || (batch > 0 && routed.length !== batch + (innerCall(input.arguments) ? 1 : 0)));
  return { ...input, routed, routerUnclear };
}

/** The label the call is judged by: the tool's own, the real tools' names, and "not read" for an unclear router. */
export function planLabel(plan: ApprovalPlan): CapabilitySafety {
  return strictest(plan.label, ...plan.routed.map((call) => nameLabel(call.name)),
    ...(plan.routerUnclear ? ["external-action" as const] : []));
}

function walk(value: unknown, visit: (key: string, value: unknown, path: string) => void, path = "", depth = 0): void {
  if (depth > MAX_DEPTH) return;
  if (Array.isArray(value)) value.forEach((item, index) => walk(item, visit, `${path}[${index}]`, depth + 1));
  else if (isRecord(value)) for (const [key, item] of Object.entries(value)) {
    const itemPath = path ? `${path}.${key}` : key;
    visit(key, item, itemPath);
    walk(item, visit, itemPath, depth + 1);
  }
}

/**
 * A confirm value that a server may read as yes. Many servers turn "true", "yes", "on" or 1 into
 * true (Python's pydantic does), so those count as the AI saying yes too.
 */
function saysYes(value: unknown): boolean {
  if (value === true || value === 1) return true;
  return typeof value === "string" && ["true", "1", "yes", "y", "on"].includes(value.trim().toLowerCase());
}

/** A preview switch that is set, but not to a plain true or false: servers read "false" or 0 differently. */
function unclearSwitch(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== "boolean";
}

/** Paths where confirm, confirmed or force says yes, anywhere in the arguments (router inner arguments too). */
export function aiConfirm(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  walk(args, (key, value, path) => { if (isConfirmKey(key) && saysYes(value)) paths.push(path); });
  return paths;
}

/** Paths where a preview switch is false, or set to something that is not plain true/false, anywhere in the arguments. */
export function previewSwitchedOff(args: Record<string, unknown>): string[] {
  const paths: string[] = [];
  walk(args, (key, value, path) => {
    if (isPreviewKey(key) && (value === false || unclearSwitch(value))) paths.push(path);
  });
  return paths;
}

/**
 * True when the user must say yes: the call is not read, or the AI tried to skip a check itself
 * (confirm/confirmed/force true, or a preview switch set to false). A read label never overrides that.
 */
export function needsApproval(plan: ApprovalPlan): boolean {
  return planLabel(plan) !== "read" || aiConfirm(plan.arguments).length > 0 || previewSwitchedOff(plan.arguments).length > 0;
}
