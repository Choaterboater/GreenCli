// Partly copied from casper src/capabilities/approval.ts @ ad678b6 (MIT). Kept: router, confirm and preview-switch checks. Keep in step by hand.
// Changed here: the imports point at ./mcpLabels and ./mcpTypes, ApprovalPlan has no `hint` and
// says whether the tool is a router, and MAX_DEPTH is exported (mcpGate.ts refuses arguments nested
// deeper than walk() looks).
// GreenCLI is stricter than Casper in three places (the Rust side, src-tauri/src/mcp/labels.rs, matches):
// - A router is found by its name words (callTool, call-tool, tool_call, use_tool, proxy_tool) and by
//   its shape (a tool-name key next to an arguments key, in its input schema or in the call), not only
//   by /invoke|dispatch|call_tool|run_tool/.
// - Every key that may hold the tool's name counts, in any spelling (name, tool, tool_name, toolName,
//   tool_id, method, function). Two different names make the call unclear.
// - Any confirm value but false or null counts as the AI saying yes: servers that read confirm or
//   force loosely (JS `if (args.force)`) treat 2, "no" or {} as yes.
// Left out: the call modes, the preview, secret masking and box formatting (approval.ts:171-437);
// GreenCLI cleans the box text itself (mcpShow.ts).
import type { MCPTool } from "./mcpTypes";
import { nameLabel, strictest, toolWords, type CapabilitySafety } from "./mcpLabels";

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
  /** The tool is a router: by its name, or by a tool-name key next to an arguments key. */
  router: boolean;
  /** The tool looks like a router, but GreenCLI could not tell which tool it runs. */
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
/** A name with one of these words is a router (invokeTool, tool-dispatch). */
const ROUTER_WORDS = new Set(["invoke", "dispatch"]);
/** "tool" plus one of these words is a router too (callTool, call-tool, tool_call, use_tool, proxy_tool, call_read_tool). */
const TOOL_WORDS = new Set(["tool", "tools"]);
const ROUTER_VERBS = new Set(["call", "run", "use", "execute", "exec", "proxy"]);
/** Keys (after keyWord) that may hold the name of the tool a router runs. */
const INNER_NAME_WORDS = new Set(["name", "tool", "toolname", "toolid", "method", "function"]);
/** Keys (after keyWord) that only a router has: a tool-name key next to an arguments key. */
const TOOL_KEY_WORDS = new Set(["tool", "toolname", "toolid"]);
const ARGS_KEY_WORDS = new Set(["arguments", "args", "params"]);
const INNER_ARGS_KEYS = ["arguments", "args", "params"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** A tool whose name says it runs other tools. */
export function isRouterName(tool: string): boolean {
  if (ROUTER_NAME.test(tool)) return true;
  const words = toolWords(tool);
  return words.some((word) => ROUTER_WORDS.has(word))
    || (words.some((word) => TOOL_WORDS.has(word)) && words.some((word) => ROUTER_VERBS.has(word)));
}

/** Keys shaped like a router call: a tool-name key next to an arguments key ({tool, args}),
 *  or the MCP call shape itself ({name, arguments}). */
function routerKeys(keys: string[]): boolean {
  const words = new Set(keys.map(keyWord));
  if (![...ARGS_KEY_WORDS].some((word) => words.has(word))) return false;
  return [...TOOL_KEY_WORDS].some((word) => words.has(word)) || (words.has("name") && words.has("arguments"));
}

/** A router by its name, or by its shape in the input schema or in the call's arguments. */
export function isRouter(tool: string, schema?: unknown, args?: Record<string, unknown>): boolean {
  if (isRouterName(tool)) return true;
  const properties = isRecord(schema) && isRecord(schema.properties) ? Object.keys(schema.properties) : [];
  return routerKeys(properties) || (isRecord(args) && routerKeys(Object.keys(args)));
}

/** The different non-empty tool names in every key that may hold one (name, tool, tool_name, toolName, tool_id, ...). */
function innerNames(value: Record<string, unknown>): string[] {
  const names = Object.entries(value)
    .filter(([key]) => INNER_NAME_WORDS.has(keyWord(key)))
    .map(([, name]) => name)
    .filter((name): name is string => typeof name === "string" && name !== "");
  return [...new Set(names)];
}

/** Two different names (name: "get_status", tool_name: "delete_vlan"): the server may run either one. */
function namesClash(value: unknown): boolean {
  return isRecord(value) && innerNames(value).length > 1;
}

/** The call a router argument object names; none when it names no tool or two different ones. */
function innerCall(value: unknown): RoutedCall | undefined {
  if (!isRecord(value)) return undefined;
  const names = innerNames(value);
  if (names.length !== 1) return undefined;
  const argsKey = INNER_ARGS_KEYS.find((key) => isRecord(value[key]));
  return { name: names[0]!, arguments: argsKey ? value[argsKey] as Record<string, unknown> : {} };
}

/** The real tools a router call runs: {name, arguments} or calls[] of the same. */
export function routedCalls(tool: string, args: Record<string, unknown>, schema?: unknown): RoutedCall[] {
  if (!isRouter(tool, schema, args)) return [];
  const calls: RoutedCall[] = [];
  const single = innerCall(args);
  if (single) calls.push(single);
  if (Array.isArray(args.calls)) for (const entry of args.calls) {
    const call = innerCall(entry);
    if (call) calls.push(call);
  }
  return calls;
}

export function buildPlan(input: {
  server: string; tool: string; label: CapabilitySafety; schema: MCPTool["inputSchema"];
  arguments: Record<string, unknown>;
}): ApprovalPlan {
  const router = isRouter(input.tool, input.schema, input.arguments);
  const routed = routedCalls(input.tool, input.arguments, input.schema);
  const batch = Array.isArray(input.arguments.calls) ? input.arguments.calls.length : 0;
  const routerUnclear = router
    && (routed.length === 0 || namesClash(input.arguments)
      || (batch > 0 && routed.length !== batch + (innerCall(input.arguments) ? 1 : 0)));
  return { ...input, router, routed, routerUnclear };
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
 * A confirm value that a server may read as yes: anything but a plain false or null. pydantic v2
 * reads "t", "yes" or 1 as true, and a server that checks `if (args.force)` reads 2, "no" or {} as
 * true, so only false and null are safe to ignore.
 */
function saysYes(value: unknown): boolean {
  return value !== undefined && value !== null && value !== false;
}

/** A preview switch that is set, but not to a plain true or false: servers read "false" or 0 differently. */
function unclearSwitch(value: unknown): boolean {
  return value !== undefined && value !== null && typeof value !== "boolean";
}

/** Paths where confirm, confirmed or force is set to anything but false or null, anywhere in the arguments (router inner arguments too). */
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
 * (confirm/confirmed/force set, or a preview switch set to false). A read label never overrides that.
 */
export function needsApproval(plan: ApprovalPlan): boolean {
  return planLabel(plan) !== "read" || aiConfirm(plan.arguments).length > 0 || previewSwitchedOff(plan.arguments).length > 0;
}
