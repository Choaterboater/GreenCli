// GreenCLI's own MCP checks agree with greencli-mcp: every tool it lists is
// labelled Read except device_show (Diagnostic: it runs a show line on a
// connected tab), none is a router, and its access check reads as read-only.

use super::access::{access_check_tool, parse_access_check, AccessState};
use super::client::tool_from_json;
use super::labels::{is_router_name, tool_label, writes_off_hides, SafetyLabel};
use serde_json::{json, Value};

fn ask(messages: &[Value]) -> Vec<Value> {
    let input: String = messages.iter().map(|m| format!("{m}\n")).collect();
    let mut out = Vec::new();
    let dir = std::env::temp_dir().join(format!("greencli-mcp-app-{}", rand::random::<u64>()));
    greencli_mcp::serve(&dir, input.as_bytes(), &mut out).unwrap();
    String::from_utf8(out)
        .unwrap()
        .lines()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

fn listed_tools() -> Vec<Value> {
    let out = ask(&[json!({"jsonrpc": "2.0", "id": 1, "method": "tools/list"})]);
    out[0]["result"]["tools"].as_array().unwrap().clone()
}

#[test]
fn every_greencli_mcp_tool_is_read_but_device_show() {
    let tools = listed_tools();
    let golden: Value =
        serde_json::from_str(include_str!("../../greencli-mcp/testdata/tools_list.json")).unwrap();
    assert_eq!(Value::Array(tools.clone()), golden);
    let mut names = Vec::new();
    for raw in &tools {
        let tool = tool_from_json("greencli", raw).unwrap();
        let label = tool_label(&tool.name, tool.annotations.as_ref(), tool.meta.as_ref());
        let want = if tool.name == "device_show" {
            SafetyLabel::Diagnostic
        } else {
            SafetyLabel::Read
        };
        assert_eq!(label, want, "{}", tool.name);
        assert!(!is_router_name(&tool.name), "{}", tool.name);
        assert!(!writes_off_hides(label, &tool.name), "{}", tool.name);
        names.push(tool.name);
    }
    assert!(names.iter().any(|n| n == "list_connected_devices"));
    assert!(names.iter().any(|n| n == "device_show"));
}

#[test]
fn greencli_mcp_access_check_reads_as_read_only() {
    let infos: Vec<_> = listed_tools()
        .iter()
        .map(|t| tool_from_json("greencli", t).unwrap())
        .collect();
    let tool = access_check_tool(&infos).expect("GreenCLI calls access_check on its own");
    let out = ask(&[json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                           "params": {"name": tool.name, "arguments": {}}})]);
    let check = parse_access_check(&out[0]["result"]);
    assert_eq!(check.state, AccessState::ReadOnly);
    assert_eq!(check.products.len(), 1);
    assert_eq!(check.products[0].product, "greencli");
    assert_eq!(
        check.products[0].identity.as_deref(),
        Some(format!("greencli-mcp {}", greencli_mcp::VERSION).as_str())
    );
}
