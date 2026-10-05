//! MCP over newline-delimited JSON-RPC 2.0: initialize, ping, tools/list and
//! tools/call. Notifications get no answer. Batches are taken, as protocol
//! 2025-03-26 requires: the server keeps nothing between messages, so each
//! one in a batch is answered as if it came on its own line.

use crate::tools::{self, ToolFail};
use crate::transport::{self, Line, MAX_LINE};
use serde_json::{json, Map, Value};
use std::io::{self, BufRead, Write};
use std::path::Path;

/// The newest protocol version this server speaks, and the older ones it
/// echoes back when a client asks for them.
pub const PROTOCOL_VERSION: &str = "2025-06-18";
const SUPPORTED_VERSIONS: [&str; 3] = ["2025-06-18", "2025-03-26", "2024-11-05"];

/// The most text one tool result may carry.
pub const MAX_RESULT_BYTES: usize = 16 * 1024;

const PARSE_ERROR: i64 = -32700;
const INVALID_REQUEST: i64 = -32600;
const METHOD_NOT_FOUND: i64 = -32601;
const INVALID_PARAMS: i64 = -32602;

pub fn serve<R: BufRead, W: Write>(
    data_dir: &Path,
    mut reader: R,
    mut writer: W,
) -> io::Result<()> {
    loop {
        let reply = match transport::read_line(&mut reader, MAX_LINE)? {
            Line::Eof => return Ok(()),
            Line::TooLong => Some(error(
                Value::Null,
                INVALID_REQUEST,
                "The request is too long.",
            )),
            Line::Text(bytes) => {
                if bytes.iter().all(u8::is_ascii_whitespace) {
                    None
                } else {
                    handle_bytes(data_dir, &bytes)
                }
            }
        };
        if let Some(reply) = reply {
            transport::write_message(&mut writer, &reply)?;
        }
    }
}

fn handle_bytes(data_dir: &Path, bytes: &[u8]) -> Option<Value> {
    match serde_json::from_slice::<Value>(bytes) {
        Ok(message) => handle(data_dir, message),
        Err(_) => Some(error(
            Value::Null,
            PARSE_ERROR,
            "The request is not valid JSON.",
        )),
    }
}

/// Answer one line: a message or a batch of them. None: nothing to send
/// (only notifications or responses).
pub fn handle(data_dir: &Path, message: Value) -> Option<Value> {
    let Value::Array(items) = message else {
        return handle_one(data_dir, message);
    };
    if items.is_empty() {
        return Some(error(Value::Null, INVALID_REQUEST, "The batch is empty."));
    }
    // An array inside a batch is not a request: handle_one refuses it.
    let replies: Vec<Value> = items
        .into_iter()
        .filter_map(|m| handle_one(data_dir, m))
        .collect();
    (!replies.is_empty()).then_some(Value::Array(replies))
}

/// Answer one message. None: nothing to send (a notification or a response).
fn handle_one(data_dir: &Path, message: Value) -> Option<Value> {
    let Value::Object(message) = message else {
        return Some(error(
            Value::Null,
            INVALID_REQUEST,
            "The request must be a JSON object.",
        ));
    };
    let id = match message.get("id") {
        None => None,
        Some(id @ (Value::String(_) | Value::Number(_))) => Some(id.clone()),
        Some(_) => {
            return Some(error(
                Value::Null,
                INVALID_REQUEST,
                "The request id must be a string or a number.",
            ))
        }
    };
    let method = message.get("method").and_then(Value::as_str);
    let Some(id) = id else {
        // A notification (or a stray message with no id): never answered.
        return None;
    };
    if message.get("jsonrpc").and_then(Value::as_str) != Some("2.0") {
        return Some(error(id, INVALID_REQUEST, "jsonrpc must be \"2.0\"."));
    }
    let Some(method) = method else {
        // A response to something we never sent.
        if message.contains_key("result") || message.contains_key("error") {
            return None;
        }
        return Some(error(id, INVALID_REQUEST, "The request has no method."));
    };
    let params = message.get("params").cloned().unwrap_or(Value::Null);
    if !(params.is_null() || params.is_object()) {
        return Some(error(id, INVALID_PARAMS, "params must be an object."));
    }
    let params = match params {
        Value::Object(map) => map,
        _ => Map::new(),
    };
    let answer = match method {
        "initialize" => Ok(initialize(&params)),
        "ping" => Ok(json!({})),
        "tools/list" => Ok(json!({ "tools": tools::list() })),
        "tools/call" => call(data_dir, &params),
        _ => Err((
            METHOD_NOT_FOUND,
            format!("Unknown method: {}", clip(method)),
        )),
    };
    Some(match answer {
        Ok(result) => json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        Err((code, text)) => error(id, code, &text),
    })
}

fn initialize(params: &Map<String, Value>) -> Value {
    let asked = params.get("protocolVersion").and_then(Value::as_str);
    let version = asked
        .filter(|v| SUPPORTED_VERSIONS.contains(v))
        .unwrap_or(PROTOCOL_VERSION);
    json!({
        "protocolVersion": version,
        "capabilities": { "tools": { "listChanged": false } },
        "serverInfo": {
            "name": "greencli-mcp",
            "title": "GreenCLI (read-only)",
            "version": crate::VERSION
        },
        "instructions": "Read-only access to GreenCLI data on this computer: saved devices, \
    config history and diffs (with secrets hidden), and intent results. \
    device_show runs one show line on a device tab already connected in GreenCLI, after GreenCLI \
    asks you. Nothing here can change a device or GreenCLI."
    })
}

fn call(data_dir: &Path, params: &Map<String, Value>) -> Result<Value, (i64, String)> {
    let Some(name) = params.get("name").and_then(Value::as_str) else {
        return Err((INVALID_PARAMS, "tools/call needs a tool name.".into()));
    };
    let args = match params.get("arguments") {
        None | Some(Value::Null) => Map::new(),
        Some(Value::Object(map)) => map.clone(),
        Some(_) => return Err((INVALID_PARAMS, "arguments must be an object.".into())),
    };
    match tools::call(data_dir, name, &args) {
        Ok(value) => {
            let text = value.to_string();
            if text.len() > MAX_RESULT_BYTES {
                return Ok(tool_error("The answer was too big to send."));
            }
            Ok(json!({ "content": [{ "type": "text", "text": text }], "isError": false }))
        }
        Err(ToolFail::Error(text)) => Ok(tool_error(&text)),
        Err(ToolFail::BadParams(text)) => Err((INVALID_PARAMS, text)),
    }
}

fn tool_error(text: &str) -> Value {
    let body = json!({ "error": text }).to_string();
    json!({ "content": [{ "type": "text", "text": body }], "isError": true })
}

fn error(id: Value, code: i64, message: &str) -> Value {
    json!({ "jsonrpc": "2.0", "id": id, "error": { "code": code, "message": message } })
}

/// Echo at most 64 characters of something the client sent.
fn clip(text: &str) -> String {
    text.chars().take(64).collect()
}
