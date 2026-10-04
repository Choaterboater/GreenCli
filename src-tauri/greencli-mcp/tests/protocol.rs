// Protocol conformance: one JSON line per request, notifications get no
// answer, errors use the JSON-RPC codes, and the tool list matches the
// golden file.

mod common;

use common::*;
use serde_json::{json, Value};

fn req(id: i64, method: &str, params: Value) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "method": method, "params": params})
}

#[test]
fn initialize_answers_with_a_supported_version() {
    let dir = temp_dir("init");
    let out = run(
        &dir,
        &[
            req(
                1,
                "initialize",
                json!({"protocolVersion": "2099-01-01", "capabilities": {}}),
            ),
            req(2, "initialize", json!({"protocolVersion": "2025-03-26"})),
            req(3, "initialize", json!({})),
        ],
    );
    assert_eq!(out.len(), 3);
    assert_eq!(out[0]["id"], 1);
    assert_eq!(out[0]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(out[1]["result"]["protocolVersion"], "2025-03-26");
    assert_eq!(out[2]["result"]["protocolVersion"], "2025-06-18");
    assert_eq!(out[0]["result"]["serverInfo"]["name"], "greencli-mcp");
    assert_eq!(
        out[0]["result"]["serverInfo"]["version"],
        greencli_mcp::VERSION
    );
    assert!(out[0]["result"]["capabilities"]["tools"].is_object());
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn an_initialize_line_prints_exactly_one_line() {
    let dir = temp_dir("oneline");
    let lines = run_raw(
        &dir,
        "{\"jsonrpc\":\"2.0\",\"id\":0,\"method\":\"initialize\",\"params\":{\"protocolVersion\":\"2025-06-18\"}}\n",
    );
    assert_eq!(lines.len(), 1);
    let v: Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(v["id"], 0);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn notifications_and_responses_get_no_answer() {
    let dir = temp_dir("notify");
    let out = run(
        &dir,
        &[
            json!({"jsonrpc": "2.0", "method": "notifications/initialized"}),
            json!({"jsonrpc": "2.0", "method": "notifications/cancelled", "params": {"requestId": 1}}),
            json!({"jsonrpc": "2.0", "id": 7, "result": {}}),
            req(8, "ping", json!({})),
        ],
    );
    assert_eq!(out.len(), 1);
    assert_eq!(out[0], json!({"jsonrpc": "2.0", "id": 8, "result": {}}));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn error_codes() {
    let dir = temp_dir("errors");
    let lines = run_raw(
        &dir,
        concat!(
            "not json\n",
            "[]\n",
            "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"resources/list\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":3,\"method\":\"tools/call\",\"params\":{\"name\":\"nope\"}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":4,\"method\":\"tools/call\",\"params\":{\"name\":\"access_check\",\"arguments\":{\"x\":1}}}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":5,\"method\":\"tools/call\",\"params\":{\"name\":\"access_check\",\"arguments\":[1]}}\n",
            "{\"jsonrpc\":\"1.0\",\"id\":6,\"method\":\"ping\"}\n",
            "{\"jsonrpc\":\"2.0\",\"id\":{\"a\":1},\"method\":\"ping\"}\n",
            "\n",
            "{\"jsonrpc\":\"2.0\",\"id\":9,\"method\":\"tools/call\"}\n",
        ),
    );
    let out: Vec<Value> = lines
        .iter()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    let codes: Vec<i64> = out
        .iter()
        .map(|v| v["error"]["code"].as_i64().unwrap())
        .collect();
    assert_eq!(
        codes,
        [-32700, -32600, -32601, -32602, -32602, -32602, -32600, -32600, -32602]
    );
    assert_eq!(out[0]["id"], Value::Null);
    assert_eq!(out[2]["id"], 2);
    std::fs::remove_dir_all(dir).ok();
}

// Protocol 2025-03-26 says a server must take JSON-RPC batches.
#[test]
fn batches_are_answered() {
    let dir = temp_dir("batch");
    let lines = run_raw(
        &dir,
        &[
            req(1, "initialize", json!({"protocolVersion": "2025-03-26"})).to_string(),
            json!([
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                req(2, "tools/list", json!({})),
            ])
            .to_string(),
            // Only notifications and responses: nothing comes back.
            json!([
                {"jsonrpc": "2.0", "method": "notifications/initialized"},
                {"jsonrpc": "2.0", "id": 7, "result": {}},
            ])
            .to_string(),
            json!([req(3, "ping", json!({})), 5, [req(4, "ping", json!({}))]]).to_string(),
            "[]".to_string(),
            req(5, "ping", json!({})).to_string(),
        ]
        .map(|line| line + "\n")
        .concat(),
    );
    let out: Vec<Value> = lines
        .iter()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect();
    assert_eq!(out.len(), 5, "{lines:?}");
    assert_eq!(out[0]["result"]["protocolVersion"], "2025-03-26");
    let batch = out[1].as_array().unwrap();
    assert_eq!(batch.len(), 1);
    assert_eq!(batch[0]["id"], 2);
    assert_eq!(
        batch[0]["result"]["tools"],
        run(&dir, &[req(1, "tools/list", json!({}))])[0]["result"]["tools"]
    );
    // Each item is answered on its own; one that is not a request object
    // (a number, an array) gets its own -32600.
    assert_eq!(
        out[2],
        json!([
            {"jsonrpc": "2.0", "id": 3, "result": {}},
            {"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "The request must be a JSON object."}},
            {"jsonrpc": "2.0", "id": null, "error": {"code": -32600, "message": "The request must be a JSON object."}},
        ])
    );
    // An empty batch is one error, not an array.
    assert_eq!(out[3]["error"]["code"], -32600);
    assert_eq!(out[3]["id"], Value::Null);
    assert_eq!(out[4], json!({"jsonrpc": "2.0", "id": 5, "result": {}}));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn an_over_long_line_is_refused_and_the_next_one_works() {
    let dir = temp_dir("long");
    let mut input = "x".repeat(2 * 1024 * 1024);
    input.push('\n');
    input.push_str("{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"ping\"}\n");
    let lines = run_raw(&dir, &input);
    assert_eq!(lines.len(), 2);
    let first: Value = serde_json::from_str(&lines[0]).unwrap();
    assert_eq!(first["error"]["code"], -32600);
    let second: Value = serde_json::from_str(&lines[1]).unwrap();
    assert_eq!(second["result"], json!({}));
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn tools_list_matches_the_golden_file() {
    let dir = temp_dir("list");
    let out = run(&dir, &[req(1, "tools/list", json!({}))]);
    let tools = &out[0]["result"]["tools"];
    let golden: Value = serde_json::from_str(include_str!("../testdata/tools_list.json")).unwrap();
    assert_eq!(
        tools,
        &golden,
        "tools/list changed. If that is on purpose, update testdata/tools_list.json to:\n{}",
        serde_json::to_string_pretty(tools).unwrap()
    );
    std::fs::remove_dir_all(dir).ok();
}

/// The live tools: list_connected_devices only reads; device_show runs a show
/// line on a connected device, so it is marked diagnostic (Casper and
/// GreenCLI ask first) and talks to the outside world.
const LIVE_TOOLS: [&str; 2] = ["list_connected_devices", "device_show"];

#[test]
fn every_tool_is_marked_read_only() {
    let dir = temp_dir("marks");
    let out = run(&dir, &[req(1, "tools/list", json!({}))]);
    let tools = out[0]["result"]["tools"].as_array().unwrap();
    assert!(!tools.is_empty());
    for tool in tools {
        let a = &tool["annotations"];
        assert_eq!(a["readOnlyHint"], true, "{tool}");
        assert_eq!(a["destructiveHint"], false, "{tool}");
        assert_eq!(tool["inputSchema"]["additionalProperties"], false, "{tool}");
        assert_eq!(tool["inputSchema"]["type"], "object", "{tool}");
        let name = tool["name"].as_str().unwrap();
        // No run, command, cli, exec or shell word: those read as exec.
        for word in ["run", "command", "cli", "exec", "shell"] {
            assert!(!name.contains(word), "{name}");
        }
        if name == "device_show" {
            assert_eq!(a["idempotentHint"], false, "{tool}");
            assert_eq!(a["openWorldHint"], true, "{tool}");
            assert_eq!(
                tool["_meta"],
                json!({"casper/safety": "diagnostic"}),
                "{tool}"
            );
        } else {
            assert_eq!(a["idempotentHint"], true, "{tool}");
            assert_eq!(a["openWorldHint"], false, "{tool}");
            assert_eq!(tool["_meta"], json!({"casper/safety": "read"}), "{tool}");
        }
    }
    let names: Vec<&str> = tools.iter().map(|t| t["name"].as_str().unwrap()).collect();
    for live in LIVE_TOOLS {
        assert!(names.contains(&live), "{live} is listed on every OS");
    }
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn access_check_matches_the_golden_file() {
    let dir = temp_dir("access");
    let (is_error, body, _) = call(&dir, "access_check", json!({}));
    assert!(!is_error);
    let golden =
        include_str!("../testdata/access_check.json").replace("{version}", greencli_mcp::VERSION);
    let golden: Value = serde_json::from_str(&golden).unwrap();
    assert_eq!(body, golden);
    // No arguments at all works too.
    let out = run(
        &dir,
        &[
            json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": {"name": "access_check"}}),
        ],
    );
    assert_eq!(out[0]["result"]["isError"], false);
    std::fs::remove_dir_all(dir).ok();
}

#[test]
fn the_server_stops_at_end_of_input() {
    let dir = temp_dir("eof");
    assert!(run_raw(&dir, "").is_empty());
    std::fs::remove_dir_all(dir).ok();
}
