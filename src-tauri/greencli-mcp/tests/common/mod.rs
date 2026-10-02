// Helpers shared by the integration tests.
#![allow(dead_code)]

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// A fresh, empty folder for one test.
pub fn temp_dir(tag: &str) -> PathBuf {
    use std::time::{SystemTime, UNIX_EPOCH};
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_nanos();
    let dir =
        std::env::temp_dir().join(format!("greencli-mcp-{tag}-{}-{nanos}", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

/// Send `input` (raw text) to the server and return each output line.
pub fn run_raw(dir: &Path, input: &str) -> Vec<String> {
    let mut out = Vec::new();
    greencli_mcp::serve(dir, input.as_bytes(), &mut out).unwrap();
    let text = String::from_utf8(out).unwrap();
    text.lines().map(str::to_string).collect()
}

/// Send each message on its own line; parse each answer.
pub fn run(dir: &Path, messages: &[Value]) -> Vec<Value> {
    let input: String = messages.iter().map(|m| format!("{m}\n")).collect();
    run_raw(dir, &input)
        .iter()
        .map(|l| serde_json::from_str(l).unwrap())
        .collect()
}

/// Call one tool; returns (isError, the parsed JSON text, the raw text).
pub fn call(dir: &Path, name: &str, args: Value) -> (bool, Value, String) {
    let answers = run(
        dir,
        &[json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                  "params": {"name": name, "arguments": args}})],
    );
    assert_eq!(answers.len(), 1);
    let result = &answers[0]["result"];
    assert!(result.is_object(), "no result: {}", answers[0]);
    let content = result["content"].as_array().unwrap();
    assert_eq!(content.len(), 1);
    assert_eq!(content[0]["type"], "text");
    let text = content[0]["text"].as_str().unwrap().to_string();
    assert!(text.len() <= 16 * 1024, "answer is {} bytes", text.len());
    let body = serde_json::from_str(&text).unwrap();
    (result["isError"] == json!(true), body, text)
}

/// The JSON-RPC error code of a call that should fail as a protocol error.
pub fn call_error_code(dir: &Path, name: &str, args: Value) -> i64 {
    let answers = run(
        dir,
        &[json!({"jsonrpc": "2.0", "id": 1, "method": "tools/call",
                  "params": {"name": name, "arguments": args}})],
    );
    answers[0]["error"]["code"].as_i64().unwrap()
}

pub fn manifest_dir() -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
}
