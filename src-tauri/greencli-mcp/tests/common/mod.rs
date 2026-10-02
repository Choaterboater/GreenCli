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

/// The app's ConfigArchiveStore::dir_for (testdata/dir_for.json pins it).
pub fn dir_for(device: &str) -> String {
    let sanitized: String = device
        .chars()
        .map(|c| {
            if c.is_ascii_alphanumeric() || matches!(c, '-' | '_' | '.' | '~') {
                c
            } else {
                '_'
            }
        })
        .collect();
    let mut hash: u32 = 0x811c_9dc5;
    for b in device.bytes() {
        hash ^= u32::from(b);
        hash = hash.wrapping_mul(0x0100_0193);
    }
    format!("{sanitized}-{hash:08x}")
}

/// One snapshot for `write_archive`. `hidden`: None = no hidden copy;
/// Some((content, filter)) with filter None = a copy with no filter field.
pub struct Snap {
    pub ts: u64,
    pub source: &'static str,
    pub golden: bool,
    pub raw: String,
    pub hidden: Option<(String, Option<u32>)>,
}

/// Write a config archive the way GreenCLI does: index.json, the raw
/// `<ts>.json` and the hidden copies. `snaps` newest first.
pub fn write_archive(dir: &Path, device: &str, snaps: &[Snap]) {
    let root = dir.join("config_archive");
    let folder = root.join(dir_for(device));
    std::fs::create_dir_all(&folder).unwrap();
    let index_path = root.join("index.json");
    let mut index: Value = std::fs::read(&index_path)
        .ok()
        .map(|b| serde_json::from_slice(&b).unwrap())
        .unwrap_or_else(|| json!({"devices": {}}));
    let mut entries = Vec::new();
    for s in snaps {
        std::fs::write(
            folder.join(format!("{}.json", s.ts)),
            json!({"ts": s.ts, "device": device, "source": s.source, "content": s.raw}).to_string(),
        )
        .unwrap();
        let mut entry = json!({"ts": s.ts, "source": s.source, "golden": s.golden});
        if let Some((content, filter)) = &s.hidden {
            let mut copy = json!({"ts": s.ts, "device": device, "source": s.source,
                                  "content": content, "made": "capture"});
            if let Some(f) = filter {
                copy["filter"] = json!(f);
                entry["hiddenFilter"] = json!(f);
            }
            std::fs::write(
                folder.join(format!("{}.hidden.json", s.ts)),
                copy.to_string(),
            )
            .unwrap();
        }
        entries.push(entry);
    }
    index["devices"][device] = Value::Array(entries);
    std::fs::write(&index_path, serde_json::to_vec_pretty(&index).unwrap()).unwrap();
}

pub fn snap(ts: u64, raw: &str, hidden: Option<(&str, Option<u32>)>) -> Snap {
    Snap {
        ts,
        source: "connect",
        golden: false,
        raw: raw.to_string(),
        hidden: hidden.map(|(c, f)| (c.to_string(), f)),
    }
}
