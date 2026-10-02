// The `casper/access-check v1` contract. Ported from casper
// src/mcp/access.ts @ ad678b6 (MIT, Choaterboater).
//
// A server may offer a read-only tool named `access_check` that asks each
// product it talks to what the current login may do:
//
//   {"contract": "casper/access-check v1",
//    "products": [{"product": "central", "access": "read-only" | "read-write" | "unknown",
//                  "identity"?: string, "role"?: string,
//                  "server_gate"?: {"env_var": string, "state": string}}]}
//
// Only this answer can make GreenCLI call a login read-only, and only when
// every product says so. Anything else, including no answer, a malformed
// answer or an error, is "unknown". The result only ever restricts:
// "read-write" unlocks nothing. GreenCLI runs it once per connection and never
// sends its text to the AI.

use super::client::McpToolInfo;
use super::labels::{tool_label, SafetyLabel};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const ACCESS_CONTRACT: &str = "casper/access-check v1";
pub const ACCESS_TOOL: &str = "access_check";
const MAX_RESULT_BYTES: usize = 64 * 1024;
const MAX_PRODUCTS: usize = 32;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AccessState {
    ReadOnly,
    ReadWrite,
    Unknown,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AccessProduct {
    /// Lowercase.
    pub product: String,
    pub access: AccessState,
    /// Kept only when short and plain.
    pub identity: Option<String>,
    pub role: Option<String>,
    /// The server's own write gate for this product: (env var, off).
    pub gate: Option<(String, bool)>,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct AccessCheck {
    pub state: AccessState,
    pub products: Vec<AccessProduct>,
}

impl AccessCheck {
    pub fn unknown() -> Self {
        AccessCheck {
            state: AccessState::Unknown,
            products: Vec::new(),
        }
    }
}

/// /^[a-z0-9][a-z0-9_.-]{0,31}$/i
fn product_name_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_alphanumeric()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_alphanumeric() || matches!(c, b'_' | b'.' | b'-'))
}

/// /^[A-Za-z0-9 _.@:/+-]{1,64}$/
fn plain(v: Option<&Value>) -> Option<String> {
    let s = v?.as_str()?;
    let ok = (1..=64).contains(&s.len())
        && s.bytes().all(|c| {
            c.is_ascii_alphanumeric()
                || matches!(c, b' ' | b'_' | b'.' | b'@' | b':' | b'/' | b'+' | b'-')
        });
    ok.then(|| s.to_string())
}

/// /^[A-Z][A-Z0-9_]{0,63}$/
fn env_name_ok(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && b[0].is_ascii_uppercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_uppercase() || c.is_ascii_digit() || *c == b'_')
}

/// The JSON body of a tool result: structuredContent first, else the only text block.
fn body(result: &Value) -> Option<Value> {
    let obj = result.as_object()?;
    if obj.get("isError") == Some(&Value::Bool(true)) {
        return None;
    }
    if let Some(sc) = obj.get("structuredContent").filter(|v| v.is_object()) {
        return Some(sc.clone());
    }
    let texts: Vec<&str> = obj
        .get("content")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter(|i| i.get("type").and_then(Value::as_str) == Some("text"))
                .filter_map(|i| i.get("text").and_then(Value::as_str))
                .collect()
        })
        .unwrap_or_default();
    if texts.len() != 1 || texts[0].len() > MAX_RESULT_BYTES {
        return None;
    }
    serde_json::from_str(texts[0]).ok()
}

/// Parse an access_check tool result. Never fails; anything unexpected is Unknown.
pub fn parse_access_check(result: &Value) -> AccessCheck {
    parse(result).unwrap_or_else(AccessCheck::unknown)
}

fn parse(result: &Value) -> Option<AccessCheck> {
    let doc = body(result)?;
    let doc = doc.as_object()?;
    if doc.get("contract").and_then(Value::as_str) != Some(ACCESS_CONTRACT) {
        return None;
    }
    let items = doc.get("products")?.as_array()?;
    if items.is_empty() || items.len() > MAX_PRODUCTS {
        return None;
    }
    let mut products: Vec<AccessProduct> = Vec::new();
    for item in items {
        let item = item.as_object()?;
        let name = item
            .get("product")
            .and_then(Value::as_str)
            .filter(|n| product_name_ok(n))?
            .to_lowercase();
        if products.iter().any(|p| p.product == name) {
            return None;
        }
        let access = match item.get("access").and_then(Value::as_str) {
            Some("read-only") => AccessState::ReadOnly,
            Some("read-write") => AccessState::ReadWrite,
            _ => AccessState::Unknown,
        };
        let gate = item
            .get("server_gate")
            .and_then(Value::as_object)
            .and_then(|g| {
                let var = g
                    .get("env_var")
                    .and_then(Value::as_str)
                    .filter(|v| env_name_ok(v))?;
                let state = g.get("state").and_then(Value::as_str)?.to_lowercase();
                Some((var.to_string(), state == "disabled" || state == "off"))
            });
        products.push(AccessProduct {
            product: name,
            access,
            identity: plain(item.get("identity")),
            role: plain(item.get("role")),
            gate,
        });
    }
    let state = if products.iter().all(|p| p.access == AccessState::ReadOnly) {
        AccessState::ReadOnly
    } else if products.iter().any(|p| p.access == AccessState::ReadWrite) {
        AccessState::ReadWrite
    } else {
        AccessState::Unknown
    };
    Some(AccessCheck { state, products })
}

/// The tool GreenCLI may call on its own once per connection: named
/// access_check, marked read-only and not destructive by the server, labelled
/// Read, and needing no arguments.
pub fn access_check_tool(tools: &[McpToolInfo]) -> Option<&McpToolInfo> {
    let tool = tools.iter().find(|t| t.name == ACCESS_TOOL)?;
    let annotations = tool.annotations.as_ref();
    let hint = |k: &str| annotations.and_then(|a| a.get(k)) == Some(&Value::Bool(true));
    if !hint("readOnlyHint") || hint("destructiveHint") {
        return None;
    }
    if tool_label(&tool.name, annotations, tool.meta.as_ref()) != SafetyLabel::Read {
        return None;
    }
    let required = tool.input_schema.get("required").and_then(Value::as_array);
    if required.is_some_and(|r| !r.is_empty()) {
        return None;
    }
    Some(tool)
}

/// Whether the server itself reports every product's write gate as off: the pins took hold.
pub fn gates_confirmed_off(check: Option<&AccessCheck>) -> bool {
    check.is_some_and(|c| {
        !c.products.is_empty()
            && c.products
                .iter()
                .all(|p| p.gate.as_ref().is_some_and(|g| g.1))
    })
}

/// Reasons inside "Not run: ..." refusals.
pub fn read_only_login_reason(server: &str) -> String {
    format!("{server} login is read-only.")
}

pub fn writes_off_reason(server: &str) -> String {
    format!("{server} writes are off. Only the user can turn them on, in Settings → MCP Servers.")
}

pub fn no_definition_reason(server: &str) -> String {
    format!("{server} has no saved settings. Reconnect it in Settings → MCP Servers.")
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn text(doc: Value) -> Value {
        json!({ "content": [{ "type": "text", "text": doc.to_string() }] })
    }

    fn doc(products: Value) -> Value {
        json!({ "contract": ACCESS_CONTRACT, "products": products })
    }

    fn tool(name: &str, annotations: Value, schema: Value) -> McpToolInfo {
        crate::mcp::client::tool_from_json(
            "s",
            &json!({ "name": name, "annotations": annotations, "inputSchema": schema }),
        )
        .unwrap()
    }

    #[test]
    fn contract_mismatch_is_unknown() {
        let r = text(
            json!({ "contract": "other v1", "products": [{ "product": "central", "access": "read-only" }] }),
        );
        assert_eq!(parse_access_check(&r), AccessCheck::unknown());
        assert_eq!(
            parse_access_check(&json!("nope")).state,
            AccessState::Unknown
        );
        assert_eq!(
            parse_access_check(&text(doc(json!([])))).state,
            AccessState::Unknown
        );
    }

    #[test]
    fn all_read_only_and_mixed() {
        let ro = text(doc(json!([
            { "product": "Central", "access": "read-only", "identity": "me@x.com", "role": "Observer" },
            { "product": "glp", "access": "read-only", "identity": "bad\nname" }
        ])));
        let c = parse_access_check(&ro);
        assert_eq!(c.state, AccessState::ReadOnly);
        assert_eq!(c.products[0].product, "central");
        assert_eq!(c.products[0].identity.as_deref(), Some("me@x.com"));
        assert_eq!(c.products[0].role.as_deref(), Some("Observer"));
        assert_eq!(c.products[1].identity, None);
        let mixed = text(doc(json!([
            { "product": "central", "access": "read-only" },
            { "product": "glp", "access": "read-write" }
        ])));
        assert_eq!(parse_access_check(&mixed).state, AccessState::ReadWrite);
        let unsure = text(doc(json!([
            { "product": "central", "access": "read-only" },
            { "product": "glp", "access": "maybe" }
        ])));
        assert_eq!(parse_access_check(&unsure).state, AccessState::Unknown);
    }

    #[test]
    fn bad_products_are_unknown() {
        let dup = text(doc(json!([
            { "product": "central", "access": "read-only" },
            { "product": "CENTRAL", "access": "read-only" }
        ])));
        assert_eq!(parse_access_check(&dup).state, AccessState::Unknown);
        let bad = text(doc(
            json!([{ "product": "-central", "access": "read-only" }]),
        ));
        assert_eq!(parse_access_check(&bad).state, AccessState::Unknown);
        let long = text(doc(
            json!([{ "product": "a".repeat(33), "access": "read-only" }]),
        ));
        assert_eq!(parse_access_check(&long).state, AccessState::Unknown);
        let many: Vec<Value> = (0..33)
            .map(|i| json!({ "product": format!("p{i}"), "access": "read-only" }))
            .collect();
        assert_eq!(
            parse_access_check(&text(doc(json!(many)))).state,
            AccessState::Unknown
        );
    }

    #[test]
    fn server_gate_states() {
        let r = text(doc(json!([
            { "product": "central", "access": "read-only",
              "server_gate": { "env_var": "HPE_MCP_CENTRAL_WRITES", "state": "Disabled" } },
            { "product": "glp", "access": "read-only",
              "server_gate": { "env_var": "HPE_MCP_GLP_WRITES", "state": "off" } }
        ])));
        let c = parse_access_check(&r);
        assert_eq!(
            c.products[0].gate,
            Some(("HPE_MCP_CENTRAL_WRITES".into(), true))
        );
        assert!(gates_confirmed_off(Some(&c)));
        let on = text(doc(json!([
            { "product": "central", "access": "read-only",
              "server_gate": { "env_var": "HPE_MCP_CENTRAL_WRITES", "state": "enabled" } },
            { "product": "glp", "access": "read-only",
              "server_gate": { "env_var": "lower_case", "state": "off" } }
        ])));
        let c = parse_access_check(&on);
        assert_eq!(
            c.products[0].gate,
            Some(("HPE_MCP_CENTRAL_WRITES".into(), false))
        );
        assert_eq!(c.products[1].gate, None);
        assert!(!gates_confirmed_off(Some(&c)));
        assert!(!gates_confirmed_off(None));
        assert!(!gates_confirmed_off(Some(&AccessCheck::unknown())));
    }

    #[test]
    fn result_shapes() {
        let products = json!([{ "product": "central", "access": "read-only" }]);
        let structured = json!({ "structuredContent": doc(products.clone()), "content": [] });
        assert_eq!(parse_access_check(&structured).state, AccessState::ReadOnly);
        let mut err = text(doc(products.clone()));
        err["isError"] = json!(true);
        assert_eq!(parse_access_check(&err).state, AccessState::Unknown);
        let two = json!({ "content": [
            { "type": "text", "text": doc(products.clone()).to_string() },
            { "type": "text", "text": "{}" }
        ] });
        assert_eq!(parse_access_check(&two).state, AccessState::Unknown);
        let mut big = doc(products);
        big["padding"] = json!("x".repeat(64 * 1024));
        assert_eq!(parse_access_check(&text(big)).state, AccessState::Unknown);
        let not_json = json!({ "content": [{ "type": "text", "text": "read-only" }] });
        assert_eq!(parse_access_check(&not_json).state, AccessState::Unknown);
    }

    #[test]
    fn which_tool_may_run() {
        let ok = tool(ACCESS_TOOL, json!({ "readOnlyHint": true }), json!({}));
        let tools = vec![ok];
        assert!(access_check_tool(&tools).is_some());
        let unmarked = vec![tool(ACCESS_TOOL, json!({}), json!({}))];
        assert!(access_check_tool(&unmarked).is_none());
        let args = vec![tool(
            ACCESS_TOOL,
            json!({ "readOnlyHint": true }),
            json!({ "required": ["product"] }),
        )];
        assert!(access_check_tool(&args).is_none());
        let destructive = vec![tool(
            ACCESS_TOOL,
            json!({ "readOnlyHint": true, "destructiveHint": true }),
            json!({}),
        )];
        assert!(access_check_tool(&destructive).is_none());
        let other = vec![tool(
            "get_access",
            json!({ "readOnlyHint": true }),
            json!({}),
        )];
        assert!(access_check_tool(&other).is_none());
    }

    #[test]
    fn reasons() {
        assert_eq!(read_only_login_reason("c"), "c login is read-only.");
        assert_eq!(
            writes_off_reason("c"),
            "c writes are off. Only the user can turn them on, in Settings → MCP Servers."
        );
        assert_eq!(
            no_definition_reason("c"),
            "c has no saved settings. Reconnect it in Settings → MCP Servers."
        );
    }
}
