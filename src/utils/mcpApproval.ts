// Partly copied from casper src/capabilities/approval.ts @ ad678b6 (MIT). Kept: router, confirm and preview-switch checks. Keep in step by hand.
// Changed here: the imports point at ./mcpLabels and ./mcpTypes, ApprovalPlan has no `hint` and
// says whether the tool is a router, and MAX_DEPTH is exported (mcpGate.ts refuses arguments nested
// deeper than walk() looks).
// GreenCLI is stricter than Casper in three places (the Rust side, src-tauri/src/mcp/labels.rs, matches):
// - A router is found by its name words (callTool, call-tool, tool_call, use_tool, proxy_tool) and by
//   its shape, not only by /invoke|dispatch|call_tool|run_tool/. The shape is a tool-name key (name,
//   tool, tool_name, toolName, tool_id, method, function) next to an arguments key (arguments, args,
//   params, parameters, input), in its input schema (through $ref, anyOf, oneOf, allOf, properties,
//   items, prefixItems and additionalProperties) or in the call, at any depth down to MAX_DEPTH: in
//   an object ({request: {method, params}}), in a batch list (calls, requests, items, steps, or any
//   list of such objects, also inside an object or another list), or in a list entry
//   ({tool_calls: [{function: {name, arguments}}]}). Under calls, requests, items or steps an entry
//   that only names a tool counts too. Every call found is judged and the strictest wins.
// - Every string that starts with { or [ and parses as JSON is searched as if the JSON were there in
//   place (FastMCP json.loads's any non-str parameter sent as a string). One that doesn't parse makes
//   a router call unclear.
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

function anySchemaRouterShaped(schemas: unknown[], root: unknown): boolean {
  return schemas.some((schema) => schemaRouterShaped(schema, root));
}

/** The schemas for one key of an object: its property schema, or additionalProperties (a map). */
function propertySchemas(schemas: unknown[], key: string, root: unknown): unknown[] {
  const out: unknown[] = [];
  for (const schema of schemas) for (const node of schemaNodes(schema, root)) {
    if (isRecord(node.properties) && Object.prototype.hasOwnProperty.call(node.properties, key)) out.push(node.properties[key]);
    else if (isRecord(node.additionalProperties)) out.push(node.additionalProperties);
  }
  return out;
}

/** The schemas for one entry of a list: prefixItems, a tuple items list, or items. */
function itemSchemas(schemas: unknown[], index: number, root: unknown): unknown[] {
  const out: unknown[] = [];
  for (const schema of schemas) for (const node of schemaNodes(schema, root)) {
    if (Array.isArray(node.prefixItems) && index < node.prefixItems.length) out.push(node.prefixItems[index]);
    else if (Array.isArray(node.items)) { if (index < node.items.length) out.push(node.items[index]); }
    else if (isRecord(node.items)) out.push(node.items);
  }
  return out;
}

/** The schemas one level down: properties, additionalProperties, items and prefixItems. */
function schemaChildren(schema: unknown, root: unknown): unknown[] {
  const out: unknown[] = [];
  for (const node of schemaNodes(schema, root)) {
    if (isRecord(node.properties)) out.push(...Object.values(node.properties));
    if (isRecord(node.additionalProperties)) out.push(node.additionalProperties);
    if (Array.isArray(node.items)) out.push(...node.items);
    else if (isRecord(node.items)) out.push(node.items);
    if (Array.isArray(node.prefixItems)) out.push(...node.prefixItems);
  }
  return out;
}

/** The schema has a router-shaped object anywhere down to MAX_DEPTH: at the top, in a property,
 *  in a list's items or a map's additionalProperties, also through $ref and anyOf/oneOf/allOf.
 *  FastMCP writes `run_batch(request: BatchRequest)` as request -> $ref BatchRequest -> calls ->
 *  items -> $ref Call {name, arguments}. */
function schemaHasRouter(schema: unknown): boolean {
  const seen = new Set<object>();
  const visit = (node: unknown, depth: number): boolean => {
    if (depth > MAX_DEPTH || !isRecord(node) || seen.has(node)) return false;
    seen.add(node);
    return schemaRouterShaped(node, schema) || schemaChildren(node, schema).some((child) => visit(child, depth + 1));
  };
  return visit(schema, 0);
}

/** What a search of a call's arguments found: router shapes, every object that holds one call, and
 *  whether a JSON text in them could not be read. */
interface CallSearch { shaped: boolean; sites: unknown[]; unreadable: boolean }

/** A string a server may read as JSON: after JSON whitespace it starts with { or [. */
function looksLikeJson(text: string): boolean {
  const start = text.replace(/^[ \t\n\r]+/, "")[0];
  return start === "{" || start === "[";
}

/**
 * The call's arguments with every JSON text read in place, at any depth, top-level parameters too.
 * FastMCP runs json.loads on any argument sent as a string when the parameter is not a str, so
 * {calls: '[{"name": "delete_vlan"}]'} runs delete_vlan. A string counts when it starts with { or [
 * (after JSON whitespace) and parses; the JSON it holds is read the same way, down to MAX_DEPTH.
 * unreadable: such a string did not parse, or its JSON goes deeper than MAX_DEPTH, so the search
 * can't see everything the server might read. Same as Rust read_json_text.
 */
function readJsonText(args: Record<string, unknown>): { value: Record<string, unknown>; unreadable: boolean } {
  let unreadable = false;
  const read = (value: unknown, depth: number, fromText: boolean): unknown => {
    if (typeof value === "string") {
      if (!looksLikeJson(value)) return value;
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        unreadable = true;
        return value;
      }
      return read(parsed, depth, true);
    }
    if (typeof value !== "object" || value === null) return value;
    if (depth > MAX_DEPTH) {
      // Real objects this deep are refused before the call (mcpGate argsDepth); JSON text is not.
      if (fromText) unreadable = true;
      return value;
    }
    if (Array.isArray(value)) return value.map((item) => read(item, depth + 1, fromText));
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, read(item, depth + 1, fromText)]));
  };
  return { value: read(args, 1, false) as Record<string, unknown>, unreadable };
}

/**
 * Every place in a call's arguments that holds one routed call, down to MAX_DEPTH (JSON text read
 * in place, see readJsonText):
 * - the arguments themselves when they name a tool;
 * - any object shaped like a router call ({method, params}), or that the schema says is one;
 * - every entry of a batch list: a list with a router-shaped entry, a list whose items the schema
 *   says are router calls, a list under calls, requests, items or steps (at the top always, deeper
 *   when an entry names a tool), and a list inside a batch list ([[{name, arguments}]]).
 * Every object is searched further down too ({request: {calls: [...]}}, {tool_calls: [{function:
 * {name, arguments}}]}, {batch: {calls: [...]}}).
 */
function searchCalls(callArgs: Record<string, unknown>, schema: unknown): CallSearch {
  const { value: args, unreadable } = readJsonText(callArgs);
  const found: CallSearch = { shaped: routerKeys(Object.keys(args)), sites: [], unreadable };
  if (innerNames(args).length > 0) found.sites.push(args);
  searchChildren(args, [schema], schema, true, 1, found);
  return found;
}

function searchChildren(
  value: Record<string, unknown>, schemas: unknown[], root: unknown, top: boolean, depth: number, found: CallSearch
): void {
  if (depth > MAX_DEPTH) return;
  for (const [key, child] of Object.entries(value)) {
    const childSchemas = propertySchemas(schemas, key, root);
    if (Array.isArray(child)) {
      const batchWord = BATCH_KEY_WORDS.has(keyWord(key));
      searchList(child, childSchemas, root, batchWord && (top || child.some(namesATool)), depth + 1, found);
    } else searchEntry(child, childSchemas, root, false, depth + 1, found);
  }
}

/** A list: a batch when told so (a batch word, or a list inside a batch) or when an entry is router-shaped. */
function searchList(list: unknown[], schemas: unknown[], root: unknown, batch: boolean, depth: number, found: CallSearch): void {
  if (depth > MAX_DEPTH) return;
  const isBatch = batch || list.some(routerShaped);
  list.forEach((entry, index) => {
    const entrySchemas = itemSchemas(schemas, index, root);
    if (Array.isArray(entry)) searchList(entry, entrySchemas, root, isBatch, depth + 1, found);
    else searchEntry(entry, entrySchemas, root, isBatch, depth + 1, found);
  });
}

/** One value: it holds a call when it is router-shaped, the schema says it is one (and it is set),
 *  or it is a batch entry. Objects are searched further down. */
function searchEntry(value: unknown, schemas: unknown[], root: unknown, inBatch: boolean, depth: number, found: CallSearch): void {
  const byShape = routerShaped(value) || (value !== null && value !== undefined && anySchemaRouterShaped(schemas, root));
  if (inBatch || byShape) {
    if (byShape || namesATool(value)) found.shaped = true;
    found.sites.push(value);
  }
  if (isRecord(value)) searchChildren(value, schemas, root, false, depth, found);
}

/** A router by its name, or by its shape anywhere down to MAX_DEPTH: in the input schema (also
 *  through $ref, anyOf, oneOf and allOf, properties, items and additionalProperties) or in the
 *  call's arguments (see searchCalls). */
export function isRouter(tool: string, schema?: unknown, args?: Record<string, unknown>): boolean {
  if (isRouterName(tool) || schemaHasRouter(schema)) return true;
  return isRecord(args) && searchCalls(args, schema).shaped;
}

/** The different non-empty tool names in every key that may hold one (name, tool, tool_name, toolName, tool_id, ...). */
function innerNames(value: Record<string, unknown>): string[] {
  const names = Object.entries(value)
    .filter(([key]) => INNER_NAME_WORDS.has(keyWord(key)))
    .map(([, name]) => name)
    .filter((name): name is string => typeof name === "string" && name !== "");
  return [...new Set(names)];
}

/** The keys that may hold the routed tool's arguments and are set (not null). */
function argsKeys(value: Record<string, unknown>): string[] {
  return Object.keys(value).filter((key) => ARGS_KEY_WORDS.has(keyWord(key)) && value[key] !== undefined && value[key] !== null);
}

/** Arguments sent as a JSON text (OpenAI tool_calls: arguments: '{"vlan": 10}') are read as the object they hold. */
function argsObject(value: unknown): Record<string, unknown> {
  if (isRecord(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      if (isRecord(parsed)) return parsed;
    } catch {
      // Not JSON: no arguments GreenCLI can read.
    }
  }
  return {};
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
  return { name: names[0]!, arguments: keys.length === 1 ? argsObject(value[keys[0]!]) : {} };
}

/** The real tools a router call runs: every place searchCalls finds that names one tool. */
export function routedCalls(tool: string, args: Record<string, unknown>, schema?: unknown): RoutedCall[] {
  if (!isRouter(tool, schema, args)) return [];
  return searchCalls(args, schema).sites.map(innerCall).filter((call): call is RoutedCall => call !== undefined);
}

/**
 * The router call can't be judged: it runs no tool GreenCLI can name; a place that holds a call
 * (the arguments, a nested call, a batch entry) names no tool or two different ones, or sets two
 * arguments keys; a tool it runs is itself a router (invoke_tool running invoke_tools_batch); or a
 * string in the arguments starts with { or [ but GreenCLI can't read it as JSON (fails closed: the
 * server may read it some other way).
 */
function routerUnclear(args: Record<string, unknown>, schema: unknown, routed: RoutedCall[]): boolean {
  const found = searchCalls(args, schema);
  return routed.length === 0
    || found.unreadable
    || found.sites.some((site) => !innerCall(site))
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
