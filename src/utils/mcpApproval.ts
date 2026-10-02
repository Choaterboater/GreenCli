// Partly copied from casper src/capabilities/approval.ts @ ad678b6 (MIT). Kept: router, confirm and preview-switch checks. Keep in step by hand.
// Changed here: the imports point at ./mcpLabels and ./mcpTypes, ApprovalPlan has no `hint` and
// says whether the tool is a router, and MAX_DEPTH is exported (mcpGate.ts refuses arguments nested
// deeper than walk() looks).
// GreenCLI is stricter than Casper in three places (the Rust side, src-tauri/src/mcp/labels.rs, matches):
// - A router is found by its name words (callTool, call-tool, tool_call, use_tool, proxy_tool) and by
//   its shape, not only by /invoke|dispatch|call_tool|run_tool/. The shape is a tool-name key (name,
//   tool, tool_name, toolName, tool_id, method, function) next to an arguments key (arguments, args,
//   params, parameters, input), in its input schema or in the call, at the top level or in a batch
//   list (calls, requests, items, steps, or any list of such objects).
// - Every key that may hold the tool's name counts, in any spelling. Two different names make the
//   call unclear, and so does a batch entry GreenCLI can't read or a routed tool that is a router.
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
  /** The tool is a router: by its name, or by a tool-name key next to an arguments key (also in a batch list). */
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
/** Keys (after keyWord) that may hold the arguments for that tool. */
const ARGS_KEY_WORDS = new Set(["arguments", "args", "params", "parameters", "input"]);
/** List keys (after keyWord) that hold a batch of calls in a router call. */
const BATCH_KEY_WORDS = new Set(["calls", "requests", "items", "steps"]);

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

/** Keys shaped like a router call: a tool-name key next to an arguments key ({tool, args},
 *  {name, arguments}, {method, params}, {function, arguments}, ...). */
function routerKeys(keys: string[]): boolean {
  const words = keys.map(keyWord);
  return words.some((word) => INNER_NAME_WORDS.has(word)) && words.some((word) => ARGS_KEY_WORDS.has(word));
}

function schemaProperties(schema: unknown): Record<string, unknown> {
  return isRecord(schema) && isRecord(schema.properties) ? schema.properties : {};
}

/** A schema property that is a list of router-shaped objects (calls: [{name, arguments}]). */
function schemaBatchKey(schema: unknown, key: string): boolean {
  const property = schemaProperties(schema)[key];
  return isRecord(property) && routerKeys(Object.keys(schemaProperties(property.items)));
}

/** The lists in a router call that hold a batch of calls: calls, requests, items or steps, a list
 *  the schema says holds router-shaped objects, or any list with a router-shaped object in it. */
function batchLists(args: Record<string, unknown>, schema?: unknown): unknown[][] {
  return Object.entries(args)
    .filter(([key, value]) => Array.isArray(value) && (BATCH_KEY_WORDS.has(keyWord(key))
      || schemaBatchKey(schema, key)
      || value.some((entry) => isRecord(entry) && routerKeys(Object.keys(entry)))))
    .map(([, value]) => value as unknown[]);
}

/** A router by its name, or by its shape in the input schema or in the call's arguments, at the top
 *  level or inside a list (a batch: calls: [{name, arguments}, ...]). */
export function isRouter(tool: string, schema?: unknown, args?: Record<string, unknown>): boolean {
  if (isRouterName(tool)) return true;
  const properties = schemaProperties(schema);
  if (routerKeys(Object.keys(properties)) || Object.keys(properties).some((key) => schemaBatchKey(schema, key))) return true;
  if (!isRecord(args)) return false;
  return routerKeys(Object.keys(args))
    || Object.values(args).some((value) => Array.isArray(value)
      && value.some((entry) => isRecord(entry) && routerKeys(Object.keys(entry))));
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
  const argsKey = Object.keys(value).find((key) => ARGS_KEY_WORDS.has(keyWord(key)) && isRecord(value[key]));
  return { name: names[0]!, arguments: argsKey ? value[argsKey] as Record<string, unknown> : {} };
}

/** The real tools a router call runs: {name, arguments}, and every entry of a batch list. */
export function routedCalls(tool: string, args: Record<string, unknown>, schema?: unknown): RoutedCall[] {
  if (!isRouter(tool, schema, args)) return [];
  const calls: RoutedCall[] = [];
  const single = innerCall(args);
  if (single) calls.push(single);
  for (const list of batchLists(args, schema)) for (const entry of list) {
    const call = innerCall(entry);
    if (call) calls.push(call);
  }
  return calls;
}

/**
 * The router call can't be judged: it names no tool, or two different ones; a batch entry names
 * none or two; or a tool it runs is itself a router (invoke_tool running invoke_tools_batch).
 */
function routerUnclear(args: Record<string, unknown>, schema: unknown, routed: RoutedCall[]): boolean {
  return routed.length === 0 || namesClash(args)
    || batchLists(args, schema).some((list) => list.some((entry) => !innerCall(entry)))
    || routed.some((call) => isRouter(call.name, undefined, call.arguments));
}

export function buildPlan(input: {
  server: string; tool: string; label: CapabilitySafety; schema: MCPTool["inputSchema"];
  arguments: Record<string, unknown>;
}): ApprovalPlan {
  const router = isRouter(input.tool, input.schema, input.arguments);
  const routed = routedCalls(input.tool, input.arguments, input.schema);
  return { ...input, router, routed, routerUnclear: router && routerUnclear(input.arguments, input.schema, routed) };
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
