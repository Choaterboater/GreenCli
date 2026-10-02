// Safety labels for MCP tools, and the router and skipped-check helpers.
//
// Ported from casper src/capabilities/labels.ts and the router, confirm and
// preview-switch parts of src/capabilities/approval.ts (lines 59-169)
// @ ad678b6 (MIT, Choaterboater). The word lists are partly from the actlint
// vocabulary (actlint 0.3.0, vocabulary 0.5.0, by Formael, Apache-2.0,
// https://github.com/formael/actlint); see THIRD_PARTY_NOTICES.txt.
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

/// "Clearly reads by its name": not a router, the first action word is a read
/// word, and nothing in the name says otherwise. Same rule as TS readNamed.
pub fn read_named(name: &str) -> bool {
    if is_router_name(name) {
        return false;
    }
    let words = action_words(name);
    first_action(&words).is_some_and(|w| has(READ_WORDS, w))
        && name_label(name) == SafetyLabel::Read
}

// ─── Router calls (approval.ts:75-121) ───

/// `/invoke|dispatch|call_tool|run_tool/i`
pub fn is_router_name(tool: &str) -> bool {
    let lower = tool.to_ascii_lowercase();
    ["invoke", "dispatch", "call_tool", "run_tool"]
        .iter()
        .any(|needle| lower.contains(needle))
}

const INNER_NAME_KEYS: [&str; 3] = ["name", "tool", "tool_name"];
const INNER_ARGS_KEYS: [&str; 3] = ["arguments", "args", "params"];

fn inner_call(value: &Value) -> Option<(String, Value)> {
    let obj = value.as_object()?;
    let name = INNER_NAME_KEYS.iter().find_map(|k| {
        obj.get(*k)
            .and_then(Value::as_str)
            .filter(|s| !s.is_empty())
    })?;
    let args = INNER_ARGS_KEYS
        .iter()
        .find_map(|k| obj.get(*k).filter(|v| v.is_object()))
        .cloned()
        .unwrap_or_else(|| Value::Object(Map::new()));
    Some((name.to_string(), args))
}

/// The real tools a router-shaped call runs: {name, arguments} or calls[] of the same.
pub fn routed_calls(tool: &str, args: &Value) -> Vec<(String, Value)> {
    if !is_router_name(tool) {
        return Vec::new();
    }
    let mut calls: Vec<(String, Value)> = inner_call(args).into_iter().collect();
    if let Some(batch) = args.get("calls").and_then(Value::as_array) {
        calls.extend(batch.iter().filter_map(inner_call));
    }
    calls
}

/// The tool looks like a router, but GreenCLI can't tell every tool it runs.
pub fn router_unclear(tool: &str, args: &Value) -> bool {
    if !is_router_name(tool) {
        return false;
    }
    let routed = routed_calls(tool, args).len();
    let batch = args
        .get("calls")
        .and_then(Value::as_array)
        .map_or(0, Vec::len);
    let single = usize::from(inner_call(args).is_some());
    routed == 0 || (batch > 0 && routed != batch + single)
}

/// The label a call is judged by: the tool's own, the real tools' names, and
/// "not read" for an unclear router.
pub fn plan_label(base: SafetyLabel, tool: &str, args: &Value) -> SafetyLabel {
    let mut labels = vec![base];
    labels.extend(
        routed_calls(tool, args)
            .iter()
            .map(|(name, _)| name_label(name)),
    );
    if router_unclear(tool, args) {
        labels.push(SafetyLabel::ExternalAction);
    }
    strictest(&labels)
}

/// plan_label, raised to at least ExternalAction for each routed name that is
/// not read_named (= TS callLabel).
pub fn call_label(base: SafetyLabel, tool: &str, args: &Value) -> SafetyLabel {
    let label = plan_label(base, tool, args);
    if routed_calls(tool, args)
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

/// String.prototype.trim: JS white space and line ends, which include U+FEFF
/// but not U+0085.
fn js_trim(s: &str) -> &str {
    s.trim_matches(|c: char| c != '\u{85}' && (c.is_whitespace() || c == '\u{feff}'))
}

/// A confirm value a server may read as yes.
fn says_yes(value: &Value) -> bool {
    match value {
        Value::Bool(b) => *b,
        Value::Number(n) => n.as_f64() == Some(1.0),
        Value::String(s) => matches!(
            js_trim(s).to_lowercase().as_str(),
            "true" | "1" | "yes" | "y" | "on"
        ),
        _ => false,
    }
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
        let args = json!({ "name": "delete_site" });
        assert_eq!(
            plan_label(SafetyLabel::Read, "invoke_read_tool", &args),
            SafetyLabel::Destructive
        );
        assert_eq!(
            call_label(
                SafetyLabel::Read,
                "invoke_read_tool",
                &json!({ "name": "cycle_port" })
            ),
            SafetyLabel::ExternalAction
        );
        assert_eq!(
            call_label(
                SafetyLabel::Read,
                "invoke_read_tool",
                &json!({ "name": "get_device" })
            ),
            SafetyLabel::Read
        );
        assert!(router_unclear("invoke_tool", &json!({})));
        assert!(!router_unclear("get_device", &json!({})));
        assert!(router_unclear(
            "invoke_read_tool",
            &json!({ "tool_id": "x" })
        ));
        let batch = json!({ "calls": [{ "name": "get_a" }, { "nope": 1 }] });
        assert_eq!(routed_calls("invoke_tools_batch", &batch).len(), 1);
        assert!(router_unclear("invoke_tools_batch", &batch));
        let shapes = json!({ "tool": "port_bounce", "args": { "serial_number": "SG1" } });
        let routed = routed_calls("Invoke_Tool", &shapes);
        assert_eq!(
            routed,
            vec![("port_bounce".to_string(), json!({ "serial_number": "SG1" }))]
        );
        assert!(routed_calls("get_device", &shapes).is_empty());
        assert!(is_router_name("my_dispatcher"));
        assert!(is_router_name("RUN_TOOL"));
    }

    #[test]
    fn read_named_rule() {
        assert!(read_named("get_device"));
        assert!(read_named("list_sites"));
        assert!(!read_named("cycle_port"));
        assert!(!read_named("get_and_delete_site"));
        assert!(!read_named("invoke_read_tool_x"));
        assert!(!read_named("glp_write_status"));
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
        assert!(!skipped_check(&json!({ "Confirm": "yes\u{85}" })));
        assert!(skipped_check(&json!({ "force": 1.0 })));
        assert!(!skipped_check(&json!({ "force": 2 })));
        assert!(skipped_check(&json!({ "DryRun": 0 })));
        assert!(!skipped_check(&json!({ "dry_run": null })));
        assert!(skipped_check(
            &json!({ "calls": [{ "arguments": { "validate-only": false } }] })
        ));
    }
}
