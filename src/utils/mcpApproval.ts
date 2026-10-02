// Partly copied from casper src/capabilities/approval.ts @ ad678b6 (MIT). Kept: router, confirm and preview-switch checks. Keep in step by hand.
// Changed here: the imports point at ./mcpLabels and ./mcpTypes, ApprovalPlan has no `hint` and
// says whether the tool is a router, and MAX_DEPTH is exported (mcpGate.ts refuses arguments nested
// deeper than walk() looks).
// GreenCLI is stricter than Casper in three places (the Rust side, src-tauri/src/mcp/labels.rs, matches):
// - A router is found by its name words (callTool, call-tool, tool_call, use_tool, proxy_tool) and by
//   its shape, not only by /invoke|dispatch|call_tool|run_tool/. The shape is a tool-name key (name,
//   tool, tool_name, toolName, tool_id, method, function) next to an arguments key (arguments, args,
//   params, parameters, input), in its input schema (through $ref, anyOf, oneOf and allOf too) or in
//   the call, at the top level, in an object one level down, or in a batch list (calls, requests,
//   items, steps, or any list of such objects). Under calls, requests, items or steps an entry that
//   only names a tool counts too.
// - Two arguments keys in one call ({args: {}, params: {...}}) make it unclear: the server may read either.
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

/** An object shaped like a router call. */
function routerShaped(value: unknown): boolean {
  return isRecord(value) && routerKeys(Object.keys(value));
}

/** A batch entry that names a tool (a tool-name key), with or without an arguments key. */
function namesATool(value: unknown): boolean {
  return isRecord(value) && Object.keys(value).some((key) => INNER_NAME_WORDS.has(keyWord(key)));
}

/** How deep schemaNodes follows $ref, anyOf, oneOf and allOf. */
const SCHEMA_DEPTH = 32;

/** A local $ref ("#/$defs/Call", "#/definitions/Call", any "#/a/b" path through objects). */
function resolveRef(root: unknown, ref: string): unknown {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let node: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    const key = part.replace(/~1/g, "/").replace(/~0/g, "~");
    if (!isRecord(node) || !Object.prototype.hasOwnProperty.call(node, key)) return undefined;
    node = node[key];
  }
  return node;
}

/** The schema and every schema it stands for: its $ref target and its anyOf, oneOf and allOf
 *  branches, followed again. pydantic and FastMCP write nested models as $ref into $defs, and an
 *  Optional field as anyOf: [{...}, {type: "null"}]. Each schema object is read once. */
function schemaNodes(schema: unknown, root: unknown, seen = new Set<object>(), depth = 0): Record<string, unknown>[] {
  if (depth > SCHEMA_DEPTH || !isRecord(schema) || seen.has(schema)) return [];
  seen.add(schema);
  const nodes = [schema];
  if (typeof schema.$ref === "string") nodes.push(...schemaNodes(resolveRef(root, schema.$ref), root, seen, depth + 1));
  for (const key of ["anyOf", "oneOf", "allOf"]) {
    const branches = schema[key];
    if (Array.isArray(branches)) for (const branch of branches) nodes.push(...schemaNodes(branch, root, seen, depth + 1));
  }
  return nodes;
}

/** Every property schema the schema gives a key, by key, through $ref and anyOf/oneOf/allOf. */
function schemaProperties(schema: unknown, root: unknown): Map<string, unknown[]> {
  const properties = new Map<string, unknown[]>();
  for (const node of schemaNodes(schema, root)) {
    if (!isRecord(node.properties)) continue;
    for (const [key, value] of Object.entries(node.properties)) properties.set(key, [...(properties.get(key) ?? []), value]);
  }
  return properties;
}

/** A schema for an object shaped like a router call. */
function schemaRouterShaped(schema: unknown, root: unknown): boolean {
  return routerKeys([...schemaProperties(schema, root).keys()]);
}

/** The schema properties that are a router-shaped object (request: {method, params}) or a list of
 *  them (calls: [{name, arguments}]), also through $ref and anyOf/oneOf/allOf. */
function schemaRouterKeys(schema: unknown): Set<string> {
  const keys = new Set<string>();
  for (const [key, properties] of schemaProperties(schema, schema)) {
    if (properties.some((property) => schemaRouterShaped(property, schema)
      || schemaNodes(property, schema).some((node) => schemaRouterShaped(node.items, schema)))) keys.add(key);
  }
  return keys;
}

/** The lists in a router call that hold a batch of calls: calls, requests, items or steps, a list
 *  the schema says holds router-shaped objects, or any list with a router-shaped object in it. */
function batchLists(args: Record<string, unknown>, schema?: unknown): unknown[][] {
  const schemaKeys = schemaRouterKeys(schema);
  return Object.entries(args)
    .filter(([key, value]) => Array.isArray(value) && (BATCH_KEY_WORDS.has(keyWord(key))
      || schemaKeys.has(key)
      || value.some(routerShaped)))
    .map(([, value]) => value as unknown[]);
}

/** Objects in a router call that hold one call (request: {method, params}): router-shaped, or
 *  router-shaped by the schema. */
function nestedCalls(args: Record<string, unknown>, schema?: unknown): Record<string, unknown>[] {
  const schemaKeys = schemaRouterKeys(schema);
  return Object.entries(args)
    .filter(([key, value]) => isRecord(value) && (routerShaped(value) || schemaKeys.has(key)))
    .map(([, value]) => value as Record<string, unknown>);
}

/** A router by its name, or by its shape: in the input schema (also through $ref, anyOf, oneOf and
 *  allOf) or in the call's arguments, at the top level, in an object one level down
 *  ({request: {method, params}}), or inside a list (a batch: calls: [{name, arguments}, ...]). A list
 *  under calls, requests, items or steps counts as a batch when an entry names a tool, even with no
 *  arguments key. */
export function isRouter(tool: string, schema?: unknown, args?: Record<string, unknown>): boolean {
  if (isRouterName(tool)) return true;
  if (schemaRouterShaped(schema, schema) || schemaRouterKeys(schema).size > 0) return true;
  if (!isRecord(args)) return false;
  return routerKeys(Object.keys(args))
    || Object.entries(args).some(([key, value]) => routerShaped(value) || (Array.isArray(value)
      && value.some((entry) => routerShaped(entry) || (BATCH_KEY_WORDS.has(keyWord(key)) && namesATool(entry)))));
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

/** The keys that may hold the routed tool's arguments and are set (not null). */
function argsKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => ARGS_KEY_WORDS.has(keyWord(key)) && value[key] !== undefined && value[key] !== null);
}

/**
 * The call a router argument object names; none when it names no tool or two different ones, or
 * sets two arguments keys ({args: {}, params: {...}}): the server may read either one.
 */
function innerCall(value: unknown): RoutedCall | undefined {
  if (!isRecord(value)) return undefined;
  const names = innerNames(value);
  const keys = argsKeys(value);
  if (names.length !== 1 || keys.length > 1) return undefined;
  const argsValue = keys.length === 1 ? value[keys[0]!] : undefined;
  return { name: names[0]!, arguments: isRecord(argsValue) ? argsValue : {} };
}

/** The real tools a router call runs: {name, arguments}, a router-shaped object one level down,
 *  and every entry of a batch list. */
export function routedCalls(tool: string, args: Record<string, unknown>, schema?: unknown): RoutedCall[] {
  if (!isRouter(tool, schema, args)) return [];
  const calls: RoutedCall[] = [];
  const single = innerCall(args);
  if (single) calls.push(single);
  for (const value of nestedCalls(args, schema)) {
    const call = innerCall(value);
    if (call) calls.push(call);
  }
  for (const list of batchLists(args, schema)) for (const entry of list) {
    const call = innerCall(entry);
    if (call) calls.push(call);
  }
  return calls;
}

/**
 * The router call can't be judged: it names no tool, or two different ones, or sets two arguments
 * keys; a nested call or a batch entry is like that; or a tool it runs is itself a router
 * (invoke_tool running invoke_tools_batch).
 */
function routerUnclear(args: Record<string, unknown>, schema: unknown, routed: RoutedCall[]): boolean {
  return routed.length === 0 || namesClash(args)
    || (innerNames(args).length > 0 && !innerCall(args))
    || nestedCalls(args, schema).some((value) => !innerCall(value))
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
