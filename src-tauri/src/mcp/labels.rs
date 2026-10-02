// Safety labels for MCP tools, and the router and skipped-check helpers.
//
// Ported from casper src/capabilities/labels.ts and the router, confirm and
// preview-switch parts of src/capabilities/approval.ts (lines 59-169)
// @ ad678b6 (MIT, Choaterboater). The word lists are partly from the actlint
// vocabulary (actlint 0.3.0, vocabulary 0.5.0, by Formael, Apache-2.0,
// https://github.com/formael/actlint); see THIRD_PARTY_NOTICES.txt.
//
// GreenCLI is stricter than Casper (the TS side, mcpApproval.ts and
// mcpGate.ts, matches):
// - A router is found by its name words (callTool, tool_call, use_tool,
//   proxy_tool) and by its shape, not only by invoke/dispatch/call_tool/
//   run_tool. The shape is a tool-name key (name, tool, tool_name, toolName,
//   tool_id, method, function) next to an arguments key (arguments, args,
//   params, parameters, input), in its input schema (through $ref, anyOf,
//   oneOf, allOf, properties, items, prefixItems and additionalProperties)
//   or in the call, at any depth down to MAX_DEPTH: in an object, in a batch
//   list (calls, requests, items, steps, or any list of such objects, also
//   inside an object or another list), or in a list entry ({tool_calls:
//   [{function: {name, arguments}}]}). Under calls, requests, items or steps
//   an entry that only names a tool counts too. Every call found is judged
//   and the strictest wins.
// - Two arguments keys in one call ({args: {}, params: {...}}) make it
//   unclear: the server may read either.
// - Every key that may hold the routed tool's name counts, in any spelling.
//   Two different names make the call unclear, and so does a batch entry
//   GreenCLI can't read or a routed tool that is a router itself.
// - Any confirm value but false or null counts as the AI saying yes.
// - read_named and writes off look for a change word anywhere in the name
//   (names_a_change), so get_and_apply_config is not a read for them.
//
// The TypeScript side (src/utils/mcpLabels.ts, mcpApproval.ts, mcpGate.ts)
// must give the same answers. testdata/*.json holds cases both test suites
// check, so a drift fails both.
//
// Rule: a label only ever gets stricter. Nothing here can make a tool
// read-only except the server's own readOnlyHint, and only when the name
// agrees. There is no regex crate, so each pattern is written out by hand.

use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::collections::HashSet;

/// Least to most strict. The declaration order is the rank.
#[derive(Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SafetyLabel {
    Read,
    Diagnostic,
    ExternalAction,
    Write,
    Exec,
    Destructive,
}

/// The strictest of the given labels; Read when none are given.
pub fn strictest(labels: &[SafetyLabel]) -> SafetyLabel {
    labels.iter().copied().max().unwrap_or(SafetyLabel::Read)
}

/// labels.ts isSafetyLabel: one of the six label strings.
pub fn parse_label(v: &Value) -> Option<SafetyLabel> {
    match v.as_str()? {
        "read" => Some(SafetyLabel::Read),
        "diagnostic" => Some(SafetyLabel::Diagnostic),
        "external-action" => Some(SafetyLabel::ExternalAction),
        "write" => Some(SafetyLabel::Write),
        "exec" => Some(SafetyLabel::Exec),
        "destructive" => Some(SafetyLabel::Destructive),
        _ => None,
    }
}

/// Words that change or break something on a device or in a product.
#[rustfmt::skip]
pub const DESTRUCTIVE_WORDS: &[&str] = &[
    // Casper 0.2.14 and network actions.
    "delete", "destroy", "remove", "reset", "reboot", "wipe", "bounce", "reload", "restart", "halt",
    "shutdown", "disconnect", "deauth", "deauthenticate", "rollback", "erase", "zeroize", "purge",
    "factory", "kick", "upgrade", "downgrade", "powercycle", "flush",
    // actlint verb.delete.
    "drop", "truncate", "clear", "revoke", "terminate", "uninstall",
];
/// Words that run commands.
#[rustfmt::skip]
pub const EXEC_WORDS: &[&str] = &[
    "exec", "execute", "shell", "run", "command", "cli",
    // actlint verb.execute (without invoke, deploy, apply and compile).
    "eval", "spawn",
];
/// Words that make a change, unless the name starts with a read word or ends with a read noun.
#[rustfmt::skip]
pub const WRITE_WORDS: &[&str] = &[
    "create", "update", "set", "write", "deploy", "commit", "apply", "push", "provision", "assign",
    "unassign", "add", "enable", "disable", "rename", "move", "archive", "acknowledge", "rotate",
    "trigger", "save", "install", "modify", "edit", "change", "replace", "configure", "manage",
    "build", "migrate", "register", "unregister", "claim", "unclaim", "block", "unblock",
    "quarantine",
    // actlint verb.create, verb.mutate and verb.send.
    "insert", "append", "upload", "submit", "import", "ingest", "clone", "copy", "duplicate",
    "patch", "put", "toggle", "approve", "cancel", "overwrite", "upsert", "sync", "synchronize",
    "persist", "restore", "merge", "activate", "deactivate", "send", "post", "publish", "notify",
    "share", "broadcast", "transfer",
];
/// Words that only look at something.
#[rustfmt::skip]
pub const READ_WORDS: &[&str] = &[
    "get", "list", "show", "find", "search", "describe", "read", "fetch", "query", "lookup",
    "check", "verify", "preview", "plan", "inspect", "locate", "status",
    // actlint verb.read.
    "view", "retrieve", "count", "exists",
];
/// A change word just before one of these endings names what is read
/// (glp_write_status reads the write status).
pub const READ_NOUN_ENDINGS: &[&str] = &["status", "state", "diff", "preview", "history", "count"];

/// Exact tool names where a listed word is a noun, not an action.
pub const NOUN_USES: &[(&str, &[&str])] = &[
    ("aos8_get_migration_run", &["run"]),
    ("aos8_preview_migration_run", &["run"]),
    ("aos8_verify_migration_run", &["run"]),
    ("aos8_plan_migration_rollback", &["rollback"]),
    ("get_config_rollback_status", &["rollback"]),
    ("get_glp_block_storage_volume", &["block"]),
    ("get_glp_block_storage_volumes", &["block"]),
    ("get_glp_block_storage_hosts", &["block"]),
    ("get_glp_service_provision", &["provision"]),
    ("get_glp_service_manager_provision", &["provision"]),
];

/// Generic dispatchers that can run any tool. Judged as destructive, as in 0.2.14.
pub const GENERIC_DISPATCHERS: &[&str] = &["invoke_tool", "invoke_tools_batch"];

/// Deeper argument nesting than this is not checked (approval.ts MAX_DEPTH).
pub const MAX_DEPTH: usize = 32;

fn has(list: &[&str], word: &str) -> bool {
    list.contains(&word)
}

fn noun_uses(name: &str) -> &'static [&'static str] {
    NOUN_USES
        .iter()
        .find(|(n, _)| *n == name)
        .map(|(_, words)| *words)
        .unwrap_or(&[])
}

/// Whole lowercase words: snake_case, kebab-case, dots, spaces and camelCase
/// (rebootDevice -> reboot, device; getHTTPStatus -> get, http, status).
pub fn tool_words(name: &str) -> Vec<String> {
    let chars: Vec<char> = name.chars().collect();
    // /([a-z0-9])([A-Z])/g -> "$1 $2"
    let mut step1: Vec<char> = Vec::with_capacity(chars.len() * 2);
    for (i, &c) in chars.iter().enumerate() {
        if i > 0
            && c.is_ascii_uppercase()
            && (chars[i - 1].is_ascii_lowercase() || chars[i - 1].is_ascii_digit())
        {
            step1.push(' ');
        }
        step1.push(c);
    }
    // /([A-Z]+)([A-Z][a-z])/g -> "$1 $2": a space before an upper-case letter
    // that follows another and comes before a lower-case one.
    let mut step2 = String::with_capacity(step1.len() * 2);
    for (i, &c) in step1.iter().enumerate() {
        if i > 0
            && c.is_ascii_uppercase()
            && step1[i - 1].is_ascii_uppercase()
            && step1.get(i + 1).is_some_and(|n| n.is_ascii_lowercase())
        {
            step2.push(' ');
        }
        step2.push(c);
    }
    // .toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    step2
        .to_lowercase()
        .split(|c: char| !(c.is_ascii_lowercase() || c.is_ascii_digit()))
        .filter(|w| !w.is_empty())
        .map(str::to_string)
        .collect()
}

/// The words of a name, without the ones NOUN_USES skips for that exact name.
fn action_words(name: &str) -> Vec<String> {
    let skipped = noun_uses(name);
    tool_words(name)
        .into_iter()
        .filter(|w| !skipped.contains(&w.as_str()))
        .collect()
}

/// The first word that is a read or a change word.
fn first_action(words: &[String]) -> Option<&str> {
    words
        .iter()
        .map(String::as_str)
        .find(|w| has(READ_WORDS, w) || has(WRITE_WORDS, w))
}

/// What the words in a tool name say, judged by the word lists alone.
pub fn word_label(name: &str) -> SafetyLabel {
    let words = action_words(name);
    if words.iter().any(|w| has(DESTRUCTIVE_WORDS, w)) {
        return SafetyLabel::Destructive;
    }
    if words.iter().any(|w| has(EXEC_WORDS, w)) {
        return SafetyLabel::Exec;
    }
    let read_first = first_action(&words).is_some_and(|w| has(READ_WORDS, w));
    let describing = match words.last() {
        Some(last) if words.len() >= 3 && has(READ_NOUN_ENDINGS, last) => Some(words.len() - 2),
        _ => None,
    };
    if !read_first
        && words
            .iter()
            .enumerate()
            .any(|(i, w)| Some(i) != describing && has(WRITE_WORDS, w))
    {
        return SafetyLabel::Write;
    }
    SafetyLabel::Read
}

/// The 0.2.14 name check: `\b(word|...)\b` on the name with "_" as a space,
/// case-sensitive. A word is a maximal run of ASCII letters and digits.
fn legacy_words_label(name: &str) -> SafetyLabel {
    let spaced = name.replace('_', " ");
    let words: Vec<&str> = spaced
        .split(|c: char| !c.is_ascii_alphanumeric())
        .filter(|w| !w.is_empty())
        .collect();
    let any = |list: &[&str]| words.iter().any(|w| list.contains(w));
    if any(&["delete", "destroy", "remove", "reset", "reboot", "wipe"]) {
        SafetyLabel::Destructive
    } else if any(&["exec", "execute", "shell", "run"]) {
        SafetyLabel::Exec
    } else if any(&["create", "update", "set", "write", "deploy"]) {
        SafetyLabel::Write
    } else {
        SafetyLabel::Read
    }
}

/// The name words Casper 0.2.14 acted on.
pub fn legacy_name_label(name: &str) -> SafetyLabel {
    if has(GENERIC_DISPATCHERS, name) {
        return SafetyLabel::Destructive;
    }
    legacy_words_label(name)
}

/// The label a tool name forces, whatever the server says.
pub fn name_label(name: &str) -> SafetyLabel {
    strictest(&[word_label(name), legacy_name_label(name)])
}

fn hint(annotations: Option<&Value>, key: &str) -> bool {
    annotations.and_then(|a| a.get(key)) == Some(&Value::Bool(true))
}

fn declared(meta: Option<&Value>) -> Option<&Value> {
    meta.and_then(|m| m.get("casper/safety"))
}

/// Casper 0.2.14's broker.ts safety(), unchanged.
pub fn legacy_label(name: &str, annotations: Option<&Value>, meta: Option<&Value>) -> SafetyLabel {
    if has(GENERIC_DISPATCHERS, name) || hint(annotations, "destructiveHint") {
        return SafetyLabel::Destructive;
    }
    let by_name = legacy_words_label(name);
    if by_name != SafetyLabel::Read {
        return by_name;
    }
    if let Some(label) = declared(meta)
        .filter(|v| v.is_string())
        .and_then(parse_label)
        .filter(|l| *l != SafetyLabel::Read)
    {
        return label;
    }
    if hint(annotations, "readOnlyHint") {
        SafetyLabel::Read
    } else {
        SafetyLabel::ExternalAction
    }
}

/// What the server's annotations claim. Only readOnlyHint: true can give Read.
pub fn annotation_label(annotations: Option<&Value>) -> SafetyLabel {
    if hint(annotations, "destructiveHint") {
        SafetyLabel::Destructive
    } else if hint(annotations, "readOnlyHint") {
        SafetyLabel::Read
    } else {
        SafetyLabel::ExternalAction
    }
}

/// The label for a tool: the strictest of the server's annotations, the name
/// words, `_meta["casper/safety"]` and the 0.2.14 label. `_meta` may relax one
/// thing only: an unannotated tool marked diagnostic is diagnostic.
pub fn tool_label(name: &str, annotations: Option<&Value>, meta: Option<&Value>) -> SafetyLabel {
    let meta_label = declared(meta)
        .and_then(parse_label)
        .filter(|l| *l != SafetyLabel::Read);
    let mut labels = vec![
        annotation_label(annotations),
        name_label(name),
        legacy_label(name, annotations, meta),
    ];
    labels.extend(meta_label);
    let label = strictest(&labels);
    if label == SafetyLabel::ExternalAction && meta_label == Some(SafetyLabel::Diagnostic) {
        return SafetyLabel::Diagnostic;
    }
    label
}

/// A delete word, a run word (when `with_run`) or a change word anywhere in
/// the name, apart from the NOUN_USES words for that exact name and a change
/// word just before a read noun ending (get_write_status).
fn has_action_word(name: &str, with_run: bool) -> bool {
    let words = action_words(name);
    let describing = match words.last() {
        Some(last) if words.len() >= 3 && has(READ_NOUN_ENDINGS, last) => Some(words.len() - 2),
        _ => None,
    };
    words.iter().enumerate().any(|(i, w)| {
        has(DESTRUCTIVE_WORDS, w)
            || (with_run && has(EXEC_WORDS, w))
            || (Some(i) != describing && has(WRITE_WORDS, w))
    })
}

/// A change, run or delete word anywhere in the name. Same as TS namesAChange.
pub fn names_a_change(name: &str) -> bool {
    has_action_word(name, true)
}

/// A change or delete word anywhere in the name; a run word alone
/// (execute_command) doesn't count. Same as TS namesAWrite.
pub fn names_a_write(name: &str) -> bool {
    has_action_word(name, false)
}

/// "Clearly reads by its name": not a router, the first action word is a read
/// word, and nothing in the name says otherwise (no change word later either:
/// get_and_apply_config doesn't count). Same rule as TS readNamed.
pub fn read_named(name: &str) -> bool {
    if is_router_name(name) {
        return false;
    }
    let words = action_words(name);
    first_action(&words).is_some_and(|w| has(READ_WORDS, w))
        && name_label(name) == SafetyLabel::Read
        && !names_a_change(name)
}

/// With writes off: a write or destructive label, an unmarked tool
/// (ExternalAction) whose name has a change word, or a tool that runs
/// commands (Exec) whose name also has a change or delete word
/// (push_cli_config, apply_config_command). A tool that only runs commands
/// (execute_command) stays and asks every time. Same as TS writesOffHides.
pub fn writes_off_hides(label: SafetyLabel, name: &str) -> bool {
    matches!(label, SafetyLabel::Write | SafetyLabel::Destructive)
        || (label == SafetyLabel::ExternalAction && names_a_change(name))
        || (label == SafetyLabel::Exec && names_a_write(name))
}

// ─── Router calls (approval.ts:75-121) ───

/// A tool whose name says it runs other tools: `/invoke|dispatch|call_tool|run_tool/i`,
/// a word invoke or dispatch, or "tool" with call, run, use, execute, exec or
/// proxy (callTool, tool_call, use_tool, proxy_tool, call_read_tool).
pub fn is_router_name(tool: &str) -> bool {
    let lower = tool.to_ascii_lowercase();
    if ["invoke", "dispatch", "call_tool", "run_tool"]
        .iter()
        .any(|needle| lower.contains(needle))
    {
        return true;
    }
    let words = tool_words(tool);
    let any = |list: &[&str]| words.iter().any(|w| list.contains(&w.as_str()));
    any(&["invoke", "dispatch"])
        || (any(&["tool", "tools"]) && any(&["call", "run", "use", "execute", "exec", "proxy"]))
}

/// Keys (after key_word) that may hold the name of the tool a router runs.
const INNER_NAME_WORDS: [&str; 6] = ["name", "tool", "toolname", "toolid", "method", "function"];
/// Keys (after key_word) that may hold the arguments for that tool.
const ARGS_KEY_WORDS: [&str; 5] = ["arguments", "args", "params", "parameters", "input"];
/// List keys (after key_word) that hold a batch of calls in a router call.
const BATCH_KEY_WORDS: [&str; 4] = ["calls", "requests", "items", "steps"];

/// Keys shaped like a router call: a tool-name key next to an arguments key
/// ({tool, args}, {name, arguments}, {method, params}, {function, arguments}).
fn router_keys<'a>(keys: impl Iterator<Item = &'a String>) -> bool {
    let words: Vec<String> = keys.map(|k| key_word(k)).collect();
    words.iter().any(|w| INNER_NAME_WORDS.contains(&w.as_str()))
        && words.iter().any(|w| ARGS_KEY_WORDS.contains(&w.as_str()))
}

fn router_shaped(value: &Value) -> bool {
    value.as_object().is_some_and(|o| router_keys(o.keys()))
}

/// A batch entry that names a tool (a tool-name key), with or without an
/// arguments key. Same as TS namesATool.
fn names_a_tool(value: &Value) -> bool {
    value.as_object().is_some_and(|o| {
        o.keys()
            .any(|k| INNER_NAME_WORDS.contains(&key_word(k).as_str()))
    })
}

/// How deep schema_nodes follows $ref, anyOf, oneOf and allOf.
const SCHEMA_DEPTH: usize = 32;

/// A local $ref ("#/$defs/Call", "#/definitions/Call", any "#/a/b" path
/// through objects). Same as TS resolveRef.
fn resolve_ref<'a>(root: &'a Value, reference: &str) -> Option<&'a Value> {
    if reference == "#" {
        return Some(root);
    }
    let path = reference.strip_prefix("#/")?;
    let mut node = root;
    for part in path.split('/') {
        let key = part.replace("~1", "/").replace("~0", "~");
        node = node.as_object()?.get(&key)?;
    }
    Some(node)
}

/// The schema and every schema it stands for: its $ref target and its
/// anyOf, oneOf and allOf branches, followed again. pydantic and FastMCP
/// write nested models as $ref into $defs, and an Optional field as
/// anyOf: [{...}, {type: "null"}]. Each schema object is read once. Same as
/// TS schemaNodes.
fn schema_nodes<'a>(schema: &'a Value, root: &'a Value) -> Vec<&'a Map<String, Value>> {
    fn visit<'a>(
        schema: &'a Value,
        root: &'a Value,
        seen: &mut Vec<*const Value>,
        depth: usize,
        out: &mut Vec<&'a Map<String, Value>>,
    ) {
        let Some(node) = schema.as_object() else {
            return;
        };
        let ptr: *const Value = schema;
        if depth > SCHEMA_DEPTH || seen.contains(&ptr) {
            return;
        }
        seen.push(ptr);
        out.push(node);
        if let Some(target) = node
            .get("$ref")
            .and_then(Value::as_str)
            .and_then(|r| resolve_ref(root, r))
        {
            visit(target, root, seen, depth + 1, out);
        }
        for key in ["anyOf", "oneOf", "allOf"] {
            if let Some(branches) = node.get(key).and_then(Value::as_array) {
                for branch in branches {
                    visit(branch, root, seen, depth + 1, out);
                }
            }
        }
    }
    let mut out = Vec::new();
    visit(schema, root, &mut Vec::new(), 0, &mut out);
    out
}

/// Every property schema the schema gives a key, by key, through $ref and
/// anyOf/oneOf/allOf. Same as TS schemaProperties.
fn schema_properties<'a>(schema: &'a Value, root: &'a Value) -> Vec<(&'a String, &'a Value)> {
    schema_nodes(schema, root)
        .into_iter()
        .filter_map(|node| node.get("properties").and_then(Value::as_object))
        .flat_map(|props| props.iter())
        .collect()
}

/// A schema for an object shaped like a router call.
fn schema_router_shaped(schema: &Value, root: &Value) -> bool {
    router_keys(schema_properties(schema, root).into_iter().map(|(k, _)| k))
}

fn any_schema_router_shaped(schemas: &[&Value], root: &Value) -> bool {
    schemas
        .iter()
        .any(|schema| schema_router_shaped(schema, root))
}

/// The schemas for one key of an object: its property schema, or
/// additionalProperties (a map). Same as TS propertySchemas.
fn property_schemas<'s>(schemas: &[&'s Value], key: &str, root: &'s Value) -> Vec<&'s Value> {
    let mut out = Vec::new();
    for schema in schemas {
        for node in schema_nodes(schema, root) {
            match node
                .get("properties")
                .and_then(Value::as_object)
                .and_then(|props| props.get(key))
            {
                Some(property) => out.push(property),
                None => {
                    if let Some(extra) = node.get("additionalProperties").filter(|v| v.is_object())
                    {
                        out.push(extra);
                    }
                }
            }
        }
    }
    out
}

/// The schemas for one entry of a list: prefixItems, a tuple items list, or
/// items. Same as TS itemSchemas.
fn item_schemas<'s>(schemas: &[&'s Value], index: usize, root: &'s Value) -> Vec<&'s Value> {
    let mut out = Vec::new();
    for schema in schemas {
        for node in schema_nodes(schema, root) {
            if let Some(prefix) = node
                .get("prefixItems")
                .and_then(Value::as_array)
                .and_then(|list| list.get(index))
            {
                out.push(prefix);
            } else if let Some(tuple) = node.get("items").and_then(Value::as_array) {
                if let Some(item) = tuple.get(index) {
                    out.push(item);
                }
            } else if let Some(items) = node.get("items").filter(|v| v.is_object()) {
                out.push(items);
            }
        }
    }
    out
}

/// The schemas one level down: properties, additionalProperties, items and
/// prefixItems. Same as TS schemaChildren.
fn schema_children<'s>(schema: &'s Value, root: &'s Value) -> Vec<&'s Value> {
    let mut out = Vec::new();
    for node in schema_nodes(schema, root) {
        if let Some(props) = node.get("properties").and_then(Value::as_object) {
            out.extend(props.values());
        }
        if let Some(extra) = node.get("additionalProperties").filter(|v| v.is_object()) {
            out.push(extra);
        }
        match node.get("items") {
            Some(Value::Array(list)) => out.extend(list.iter()),
            Some(items @ Value::Object(_)) => out.push(items),
            _ => {}
        }
        if let Some(prefix) = node.get("prefixItems").and_then(Value::as_array) {
            out.extend(prefix.iter());
        }
    }
    out
}

/// The schema has a router-shaped object anywhere down to MAX_DEPTH: at the
/// top, in a property, in a list's items or a map's additionalProperties,
/// also through $ref and anyOf/oneOf/allOf. FastMCP writes
/// `run_batch(request: BatchRequest)` as request -> $ref BatchRequest ->
/// calls -> items -> $ref Call {name, arguments}. Same as TS schemaHasRouter.
fn schema_has_router(schema: &Value) -> bool {
    fn visit(node: &Value, root: &Value, depth: usize, seen: &mut HashSet<*const Value>) -> bool {
        if depth > MAX_DEPTH || !node.is_object() || !seen.insert(node as *const Value) {
            return false;
        }
        schema_router_shaped(node, root)
            || schema_children(node, root)
                .into_iter()
                .any(|child| visit(child, root, depth + 1, seen))
    }
    visit(schema, schema, 0, &mut HashSet::new())
}

/// What a search of a call's arguments found: router shapes, and every value
/// that holds one call. Same as TS CallSearch.
struct CallSearch<'a> {
    shaped: bool,
    sites: Vec<&'a Value>,
}

/// Every place in a call's arguments that holds one routed call, down to
/// MAX_DEPTH: the arguments themselves when they name a tool; any object
/// shaped like a router call, or that the schema says is one; and every
/// entry of a batch list (a list with a router-shaped entry, a list under
/// calls, requests, items or steps (at the top always, deeper when an entry
/// names a tool), and a list inside a batch list). Every object is searched
/// further down too. Same as TS searchCalls.
fn search_calls<'a>(args: &'a Value, schema: &Value) -> CallSearch<'a> {
    let mut found = CallSearch {
        shaped: false,
        sites: Vec::new(),
    };
    if let Some(obj) = args.as_object() {
        found.shaped = router_keys(obj.keys());
        if !inner_names(obj).is_empty() {
            found.sites.push(args);
        }
        search_children(obj, &[schema], schema, true, 1, &mut found);
    }
    found
}

fn search_children<'a>(
    obj: &'a Map<String, Value>,
    schemas: &[&Value],
    root: &Value,
    top: bool,
    depth: usize,
    found: &mut CallSearch<'a>,
) {
    if depth > MAX_DEPTH {
        return;
    }
    for (key, child) in obj {
        let child_schemas = property_schemas(schemas, key, root);
        if let Some(list) = child.as_array() {
            let batch_word = BATCH_KEY_WORDS.contains(&key_word(key).as_str());
            let batch = batch_word && (top || list.iter().any(names_a_tool));
            search_list(list, &child_schemas, root, batch, depth + 1, found);
        } else {
            search_entry(child, &child_schemas, root, false, depth + 1, found);
        }
    }
}

/// A list: a batch when told so (a batch word, or a list inside a batch) or
/// when an entry is router-shaped. Same as TS searchList.
fn search_list<'a>(
    list: &'a [Value],
    schemas: &[&Value],
    root: &Value,
    batch: bool,
    depth: usize,
    found: &mut CallSearch<'a>,
) {
    if depth > MAX_DEPTH {
        return;
    }
    let is_batch = batch || list.iter().any(router_shaped);
    for (index, entry) in list.iter().enumerate() {
        let entry_schemas = item_schemas(schemas, index, root);
        if let Some(inner) = entry.as_array() {
            search_list(inner, &entry_schemas, root, is_batch, depth + 1, found);
        } else {
            search_entry(entry, &entry_schemas, root, is_batch, depth + 1, found);
        }
    }
}

/// One value: it holds a call when it is router-shaped, the schema says it
/// is one (and it is set), or it is a batch entry. Objects are searched
/// further down. Same as TS searchEntry.
fn search_entry<'a>(
    value: &'a Value,
    schemas: &[&Value],
    root: &Value,
    in_batch: bool,
    depth: usize,
    found: &mut CallSearch<'a>,
) {
    let by_shape =
        router_shaped(value) || (!value.is_null() && any_schema_router_shaped(schemas, root));
    if in_batch || by_shape {
        if by_shape || names_a_tool(value) {
            found.shaped = true;
        }
        found.sites.push(value);
    }
    if let Some(obj) = value.as_object() {
        search_children(obj, schemas, root, false, depth, found);
    }
}

/// A router by its name, or by its shape anywhere down to MAX_DEPTH: in the
/// input schema (also through $ref, anyOf, oneOf and allOf, properties,
/// items and additionalProperties) or in the call's arguments (see
/// search_calls). Same as TS isRouter.
pub fn is_router(tool: &str, schema: &Value, args: &Value) -> bool {
    is_router_name(tool) || schema_has_router(schema) || search_calls(args, schema).shaped
}

/// The different non-empty tool names in every key that may hold one.
fn inner_names(obj: &Map<String, Value>) -> Vec<&str> {
    let mut names: Vec<&str> = Vec::new();
    for name in obj
        .iter()
        .filter(|(k, _)| INNER_NAME_WORDS.contains(&key_word(k).as_str()))
        .filter_map(|(_, v)| v.as_str())
    {
        if !name.is_empty() && !names.contains(&name) {
            names.push(name);
        }
    }
    names
}

/// The values of the keys that may hold the routed tool's arguments and are
/// set (not null).
fn args_values(obj: &Map<String, Value>) -> Vec<&Value> {
    obj.iter()
        .filter(|(k, v)| ARGS_KEY_WORDS.contains(&key_word(k).as_str()) && !v.is_null())
        .map(|(_, v)| v)
        .collect()
}

/// Arguments sent as a JSON text (OpenAI tool_calls: arguments:
/// '{"vlan": 10}') are read as the object they hold. Same as TS argsObject.
fn args_object(value: &Value) -> Value {
    match value {
        Value::Object(_) => value.clone(),
        Value::String(text) => match serde_json::from_str::<Value>(text) {
            Ok(parsed @ Value::Object(_)) => parsed,
            _ => Value::Object(Map::new()),
        },
        _ => Value::Object(Map::new()),
    }
}

/// The call a router argument object names; none when it names no tool or
/// two different ones, or sets two arguments keys ({args: {}, params:
/// {...}}): the server may read either one. Same as TS innerCall.
fn inner_call(value: &Value) -> Option<(String, Value)> {
    let obj = value.as_object()?;
    let name = match inner_names(obj).as_slice() {
        [only] => *only,
        _ => return None,
    };
    let args = match args_values(obj).as_slice() {
        [] => Value::Object(Map::new()),
        [only] => args_object(only),
        _ => return None,
    };
    Some((name.to_string(), args))
}

/// The real tools a router call runs: every place search_calls finds that
/// names one tool. Same as TS routedCalls.
pub fn routed_calls(tool: &str, schema: &Value, args: &Value) -> Vec<(String, Value)> {
    if !is_router(tool, schema, args) {
        return Vec::new();
    }
    search_calls(args, schema)
        .sites
        .into_iter()
        .filter_map(inner_call)
        .collect()
}

/// The tool looks like a router, but GreenCLI can't tell every tool it runs:
/// it runs no tool GreenCLI can name; a place that holds a call names no
/// tool or two different ones, or sets two arguments keys; or a tool it runs
/// is itself a router. Same as TS routerUnclear.
pub fn router_unclear(tool: &str, schema: &Value, args: &Value) -> bool {
    if !is_router(tool, schema, args) {
        return false;
    }
    let routed = routed_calls(tool, schema, args);
    routed.is_empty()
        || search_calls(args, schema)
            .sites
            .into_iter()
            .any(|site| inner_call(site).is_none())
        || routed
            .iter()
            .any(|(name, inner)| is_router(name, &Value::Null, inner))
}

/// The label a call is judged by: the tool's own, the real tools' names, and
/// "not read" for an unclear router.
pub fn plan_label(base: SafetyLabel, tool: &str, schema: &Value, args: &Value) -> SafetyLabel {
    let mut labels = vec![base];
    labels.extend(
        routed_calls(tool, schema, args)
            .iter()
            .map(|(name, _)| name_label(name)),
    );
    if router_unclear(tool, schema, args) {
        labels.push(SafetyLabel::ExternalAction);
    }
    strictest(&labels)
}

/// plan_label, raised to at least ExternalAction for each routed name that is
/// not read_named (= TS callLabel).
pub fn call_label(base: SafetyLabel, tool: &str, schema: &Value, args: &Value) -> SafetyLabel {
    let label = plan_label(base, tool, schema, args);
    if routed_calls(tool, schema, args)
        .iter()
        .any(|(name, _)| !read_named(name))
    {
        return strictest(&[label, SafetyLabel::ExternalAction]);
    }
    label
}

// ─── Skipped checks (approval.ts:123-161) ───

/// Deepest nesting of arrays and objects (the top-level object is 1). Walks
/// with a stack, so a very deep value can't overflow it. Same as TS argsDepth.
pub fn args_depth(args: &Value) -> usize {
    let mut deepest = 0;
    let mut stack: Vec<(&Value, usize)> = vec![(args, 1)];
    while let Some((value, depth)) = stack.pop() {
        let children: Box<dyn Iterator<Item = &Value>> = match value {
            Value::Array(a) => Box::new(a.iter()),
            Value::Object(o) => Box::new(o.values()),
            _ => continue,
        };
        deepest = deepest.max(depth);
        stack.extend(
            children
                .filter(|v| v.is_array() || v.is_object())
                .map(|v| (v, depth + 1)),
        );
    }
    deepest
}

/// Nested deeper than MAX_DEPTH: too deep to check.
pub fn too_deep(args: &Value) -> bool {
    args_depth(args) > MAX_DEPTH
}

/// approval.ts keyWord: lowercase, then only [a-z0-9].
fn key_word(key: &str) -> String {
    key.to_lowercase()
        .chars()
        .filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit())
        .collect()
}

fn is_confirm_key(key: &str) -> bool {
    matches!(
        key_word(key).as_str(),
        "confirm" | "confirmed" | "confirmation" | "force"
    )
}

fn is_preview_key(key: &str) -> bool {
    matches!(
        key_word(key).as_str(),
        "dryrun" | "preview" | "checkonly" | "validateonly"
    )
}

/// A confirm value a server may read as yes: anything but false or null
/// (`if (args.force)` reads 2, "no" or {} as yes).
fn says_yes(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(false))
}

/// A preview switch set to something that is not plain true or false.
fn unclear_switch(value: &Value) -> bool {
    !matches!(value, Value::Null | Value::Bool(_))
}

fn walk_skipped(value: &Value, depth: usize) -> bool {
    if depth > MAX_DEPTH {
        return false;
    }
    match value {
        Value::Array(items) => items.iter().any(|v| walk_skipped(v, depth + 1)),
        Value::Object(map) => map.iter().any(|(key, item)| {
            (is_confirm_key(key) && says_yes(item))
                || (is_preview_key(key) && (*item == Value::Bool(false) || unclear_switch(item)))
                || walk_skipped(item, depth + 1)
        }),
        _ => false,
    }
}

/// aiConfirm and previewSwitchedOff in one walk: true when a confirm-like key
/// says yes, or a preview-like key is false or not a plain bool, anywhere in
/// the arguments. Nesting deeper than MAX_DEPTH also returns true.
pub fn skipped_check(args: &Value) -> bool {
    too_deep(args) || walk_skipped(args, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn opt(v: &Value, key: &str) -> Option<Value> {
        v.get(key).cloned()
    }

    #[test]
    fn label_fixture_matches() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("testdata/label_cases.json")).unwrap();
        assert!(cases.len() >= 60, "only {} label cases", cases.len());
        for case in &cases {
            let name = case["name"].as_str().unwrap();
            let annotations = opt(case, "annotations");
            let meta = opt(case, "_meta");
            let want = parse_label(&case["label"]).unwrap();
            let got = tool_label(name, annotations.as_ref(), meta.as_ref());
            assert_eq!(got, want, "label of {}", case);
            assert_eq!(
                read_named(name),
                case["readNamed"].as_bool().unwrap(),
                "readNamed of {}",
                name
            );
        }
    }

    #[test]
    fn writes_off_fixture_matches() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("testdata/writes_off_cases.json")).unwrap();
        assert!(cases.len() >= 10);
        for case in &cases {
            let name = case["name"].as_str().unwrap();
            let annotations = opt(case, "annotations");
            let label = tool_label(name, annotations.as_ref(), None);
            assert_eq!(
                writes_off_hides(label, name),
                case["hides"].as_bool().unwrap(),
                "writes off hides {case}"
            );
        }
    }

    #[test]
    fn skip_fixture_matches() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("testdata/skip_cases.json")).unwrap();
        assert!(cases.len() >= 7);
        for case in &cases {
            assert_eq!(
                skipped_check(&case["args"]),
                case["skipped"].as_bool().unwrap(),
                "skipped of {}",
                case["args"]
            );
        }
    }

    #[test]
    fn router_fixture_matches() {
        let cases: Vec<Value> =
            serde_json::from_str(include_str!("testdata/router_cases.json")).unwrap();
        assert!(cases.len() >= 10);
        for case in &cases {
            let tool = case["tool"].as_str().unwrap();
            let schema = case.get("schema").cloned().unwrap_or(Value::Null);
            let names: Vec<String> = routed_calls(tool, &schema, &case["args"])
                .into_iter()
                .map(|(name, _)| name)
                .collect();
            let want: Vec<String> = case["routed"]
                .as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_str().unwrap().to_string())
                .collect();
            assert_eq!(names, want, "routed of {}", case);
            assert_eq!(
                router_unclear(tool, &schema, &case["args"]),
                case["unclear"].as_bool().unwrap(),
                "unclear of {}",
                case
            );
        }
    }

    #[test]
    fn camel_case_words() {
        assert_eq!(tool_words("getHTTPStatus"), vec!["get", "http", "status"]);
        assert_eq!(tool_words("rebootDevice"), vec!["reboot", "device"]);
        assert_eq!(
            tool_words("device.reload_now"),
            vec!["device", "reload", "now"]
        );
        assert_eq!(tool_words("ABCDef"), vec!["abc", "def"]);
        assert!(tool_words("__").is_empty());
    }

    #[test]
    fn legacy_name_label_is_case_sensitive() {
        assert_eq!(legacy_name_label("Delete_x"), SafetyLabel::Read);
        assert_eq!(word_label("Delete_x"), SafetyLabel::Destructive);
        assert_eq!(legacy_name_label("delete_x"), SafetyLabel::Destructive);
        assert_eq!(legacy_name_label("deleted_x"), SafetyLabel::Read);
        assert_eq!(legacy_name_label("invoke_tool"), SafetyLabel::Destructive);
        assert_eq!(legacy_name_label("port-run"), SafetyLabel::Exec);
    }

    #[test]
    fn rank_and_serde() {
        assert!(SafetyLabel::Destructive > SafetyLabel::Exec);
        assert!(SafetyLabel::Exec > SafetyLabel::Write);
        assert!(SafetyLabel::Diagnostic > SafetyLabel::Read);
        assert_eq!(strictest(&[]), SafetyLabel::Read);
        assert_eq!(
            serde_json::to_value(SafetyLabel::ExternalAction).unwrap(),
            "external-action"
        );
        assert_eq!(parse_label(&json!("exec")), Some(SafetyLabel::Exec));
        assert_eq!(parse_label(&json!("bogus")), None);
        assert_eq!(parse_label(&json!(3)), None);
    }

    #[test]
    fn hints_count_only_when_true() {
        let ro = json!({ "readOnlyHint": true });
        assert_eq!(tool_label("get_device", Some(&ro), None), SafetyLabel::Read);
        let ro_text = json!({ "readOnlyHint": "true" });
        assert_eq!(
            tool_label("get_device", Some(&ro_text), None),
            SafetyLabel::ExternalAction
        );
        let meta = json!({ "casper/safety": "diagnostic" });
        assert_eq!(
            tool_label("ap_ping", None, Some(&meta)),
            SafetyLabel::Diagnostic
        );
        assert_eq!(
            tool_label("reboot_x", None, Some(&meta)),
            SafetyLabel::Destructive
        );
    }

    #[test]
    fn routers() {
        let none = Value::Null;
        let args = json!({ "name": "delete_site" });
        assert_eq!(
            plan_label(SafetyLabel::Read, "invoke_read_tool", &none, &args),
            SafetyLabel::Destructive
        );
        assert_eq!(
            call_label(
                SafetyLabel::Read,
                "invoke_read_tool",
                &none,
                &json!({ "name": "cycle_port" })
            ),
            SafetyLabel::ExternalAction
        );
        assert_eq!(
            call_label(
                SafetyLabel::Read,
                "invoke_read_tool",
                &none,
                &json!({ "name": "get_device" })
            ),
            SafetyLabel::Read
        );
        assert!(router_unclear("invoke_tool", &none, &json!({})));
        assert!(!router_unclear("get_device", &none, &json!({})));
        assert!(router_unclear(
            "invoke_read_tool",
            &none,
            &json!({ "target": "x" })
        ));
        // tool_id holds a tool name too.
        assert_eq!(
            routed_calls(
                "invoke_read_tool",
                &none,
                &json!({ "tool_id": "update_site" })
            )
            .len(),
            1
        );
        let batch = json!({ "calls": [{ "name": "get_a" }, { "nope": 1 }] });
        assert_eq!(routed_calls("invoke_tools_batch", &none, &batch).len(), 1);
        assert!(router_unclear("invoke_tools_batch", &none, &batch));
        let shapes = json!({ "tool": "port_bounce", "args": { "serial_number": "SG1" } });
        let routed = routed_calls("Invoke_Tool", &none, &shapes);
        assert_eq!(
            routed,
            vec![("port_bounce".to_string(), json!({ "serial_number": "SG1" }))]
        );
        // A tool-name key next to an arguments key is a router, whatever the name.
        assert_eq!(routed_calls("get_device", &none, &shapes).len(), 1);
        assert!(routed_calls("get_device", &none, &json!({ "name": "core1" })).is_empty());
        assert!(is_router_name("my_dispatcher"));
        assert!(is_router_name("RUN_TOOL"));
        for name in [
            "call_read_tool",
            "callTool",
            "call-tool",
            "tool_call",
            "use_tool",
            "proxy_tool",
            "callReadTool",
        ] {
            assert!(is_router_name(name), "{name}");
        }
        for name in [
            "get_route",
            "get_proxy_config",
            "list_tools",
            "show_call_log",
        ] {
            assert!(!is_router_name(name), "{name}");
        }
        let schema = json!({ "properties": { "toolName": {}, "params": {} } });
        assert!(is_router("helper", &schema, &json!({})));
        assert!(is_router(
            "helper",
            &json!({ "properties": { "name": {}, "params": {} } }),
            &json!({})
        ));
        assert!(!is_router(
            "helper",
            &json!({ "properties": { "name": {}, "title": {} } }),
            &json!({})
        ));
    }

    #[test]
    fn batch_and_shaped_routers() {
        let none = Value::Null;
        // A read-only hint on the router never lowers what it runs.
        let batch = json!({ "calls": [
            { "name": "get_a", "arguments": {} },
            { "name": "delete_b", "arguments": {} }
        ] });
        assert_eq!(
            call_label(SafetyLabel::Read, "helper", &none, &batch),
            SafetyLabel::Destructive
        );
        assert!(!router_unclear("helper", &none, &batch));
        for args in [
            json!({ "method": "reboot_ap", "params": {} }),
            json!({ "name": "reboot_ap", "args": {} }),
            json!({ "function": "reboot_ap", "arguments": {} }),
            json!({ "tool": "reboot_ap", "input": {} }),
            json!({ "name": "reboot_ap", "parameters": {} }),
        ] {
            assert_eq!(
                call_label(SafetyLabel::Read, "helper", &none, &args),
                SafetyLabel::Destructive,
                "{args}"
            );
        }
        let unclear = json!({ "requests": [{ "method": "get_a", "params": {} }, { "op": "x" }] });
        assert!(router_unclear("helper", &none, &unclear));
        assert_eq!(
            call_label(SafetyLabel::Read, "helper", &none, &unclear),
            SafetyLabel::ExternalAction
        );
        let schema = json!({ "properties": { "ops": {
            "type": "array",
            "items": { "properties": { "tool": {}, "input": {} } }
        } } });
        assert!(is_router("helper", &schema, &json!({})));
        assert_eq!(
            routed_calls(
                "helper",
                &schema,
                &json!({ "ops": [{ "tool": "delete_x" }] })
            )
            .len(),
            1
        );
    }

    #[test]
    fn pydantic_nested_and_decoy_routers() {
        let none = Value::Null;
        // FastMCP/pydantic write the call model as $ref into $defs.
        let pydantic = json!({
            "type": "object",
            "properties": { "calls": { "type": "array", "items": { "$ref": "#/$defs/Call" } } },
            "$defs": { "Call": { "properties": { "name": {}, "arguments": {} } } }
        });
        let args = json!({ "calls": [{ "name": "delete_x" }] });
        assert!(is_router("helper", &pydantic, &args));
        assert_eq!(
            call_label(SafetyLabel::Read, "helper", &pydantic, &args),
            SafetyLabel::Destructive
        );
        // No schema: a batch word with an entry that names a tool is enough.
        assert_eq!(
            call_label(SafetyLabel::Read, "helper", &none, &args),
            SafetyLabel::Destructive
        );
        let any_of = json!({ "anyOf": [{ "properties": { "tool": {}, "args": {} } }] });
        assert_eq!(
            call_label(
                SafetyLabel::Read,
                "helper",
                &any_of,
                &json!({ "tool": "delete_x" })
            ),
            SafetyLabel::Destructive
        );
        let nested = json!({ "request": { "method": "delete_x", "params": {} } });
        assert_eq!(
            call_label(SafetyLabel::Read, "helper", &none, &nested),
            SafetyLabel::Destructive
        );
        // Two arguments keys: the server may read either one.
        let decoy = json!({ "name": "lookup", "args": {}, "params": { "name": "delete_x", "arguments": {} } });
        assert!(router_unclear("helper", &none, &decoy));
        assert_eq!(
            call_label(SafetyLabel::Read, "helper", &none, &decoy),
            SafetyLabel::Destructive
        );
        // A $ref loop ends.
        let looped = json!({
            "$ref": "#/$defs/Node",
            "$defs": { "Node": { "properties": { "child": { "$ref": "#/$defs/Node" } } } }
        });
        assert!(!is_router("get_tree", &looped, &json!({ "child": {} })));
        assert_eq!(resolve_ref(&looped, "#/$defs/Missing"), None);
        assert_eq!(resolve_ref(&looped, "other.json#/x"), None);
    }

    #[test]
    fn read_named_rule() {
        assert!(read_named("get_device"));
        assert!(read_named("list_sites"));
        assert!(read_named("get_sync_status"));
        assert!(!read_named("cycle_port"));
        assert!(!read_named("get_and_delete_site"));
        assert!(!read_named("invoke_read_tool_x"));
        assert!(!read_named("glp_write_status"));
        for name in [
            "get_and_apply_config",
            "list_and_disable_ports",
            "verify_and_commit",
            "get_or_add_vlan",
            "show_and_push_config",
            "fetch_and_sync_inventory",
            "check_then_enable_port",
        ] {
            assert!(!read_named(name), "{name}");
            assert!(names_a_change(name), "{name}");
            assert!(
                writes_off_hides(SafetyLabel::ExternalAction, name),
                "{name}"
            );
            assert!(!writes_off_hides(SafetyLabel::Read, name), "{name}");
        }
        assert!(!writes_off_hides(SafetyLabel::ExternalAction, "get_device"));
    }

    #[test]
    fn depth_and_skips() {
        assert_eq!(args_depth(&json!({})), 1);
        assert_eq!(args_depth(&json!({ "a": [{ "b": 1 }] })), 3);
        assert_eq!(args_depth(&json!("x")), 0);
        let mut deep = json!({ "confirm": true });
        for _ in 0..31 {
            deep = json!({ "a": deep });
        }
        assert_eq!(args_depth(&deep), 32);
        assert!(!too_deep(&deep));
        assert!(skipped_check(&deep));
        let mut deeper = json!({ "x": 1 });
        for _ in 0..32 {
            deeper = json!({ "a": deeper });
        }
        assert!(too_deep(&deeper));
        assert!(skipped_check(&deeper));
        assert!(skipped_check(&json!({ "Confirm": " YES\u{feff}" })));
        assert!(skipped_check(&json!({ "Confirm": "no" })));
        assert!(skipped_check(&json!({ "force": 1.0 })));
        assert!(skipped_check(&json!({ "force": 2 })));
        assert!(skipped_check(&json!({ "force": {} })));
        assert!(!skipped_check(&json!({ "force": false })));
        assert!(!skipped_check(&json!({ "confirm": null })));
        assert!(skipped_check(&json!({ "DryRun": 0 })));
        assert!(!skipped_check(&json!({ "dry_run": null })));
        assert!(skipped_check(
            &json!({ "calls": [{ "arguments": { "validate-only": false } }] })
        ));
    }
}
