//! Live show commands (macOS and Linux only): the one place this server talks
//! to anything. It connects to GreenCLI's own channel, `mcp-live.sock` in
//! GreenCLI's data folder, and nowhere else (tests/source_scan.rs checks this).
//! The running app makes that channel only while "show commands" is on in MCP
//! Servers, lets in only programs of the same user, and asks you in a box
//! with three buttons (No, Yes this once, Yes, show commands on <device>
//! until GreenCLI closes; the last stops asking for that device).
//!
//! One JSON line each way per call, then the connection closes:
//! - `{"v":1,"op":"sessions"}` →
//!   `{"ok":true,"devices":[{"tabId","name","type"}]}`
//! - `{"v":1,"op":"show","tab"|"device":…,"show":…}` →
//!   `{"ok":true,"output":"…","truncated":false}`
//! - a refusal or failure → `{"ok":false,"error":"plain words"}`

use crate::protocol::MAX_RESULT_BYTES;
use crate::tools::ToolFail;
use crate::transport::{self, Line};
use crate::{LIVE_WAIT, MAX_LIVE_REQUEST};
use serde_json::{json, Map, Value};
use std::io::{BufReader, ErrorKind, Write};
use std::os::unix::net::UnixStream;
use std::path::Path;
use std::time::Duration;

/// The longest answer read from GreenCLI. Its output is already cut to 16 KB;
/// this leaves room for JSON escapes.
const MAX_REPLY: usize = 256 * 1024;

const NOT_OPEN: &str = "GreenCLI isn't open, or show commands are off in its MCP Servers \
settings. Open GreenCLI, connect to the device, then try again.";

/// Run list_connected_devices or device_show (arguments already checked).
pub fn call(data_dir: &Path, name: &str, args: &Map<String, Value>) -> Result<Value, ToolFail> {
    if name == "device_show" {
        device_show(data_dir, args)
    } else {
        list_connected_devices(data_dir)
    }
}

/// list_connected_devices: the tabs connected right now.
pub fn list_connected_devices(data_dir: &Path) -> Result<Value, ToolFail> {
    let reply = ask(data_dir, &json!({"v": 1, "op": "sessions"}))?;
    let Some(devices) = reply.get("devices").and_then(Value::as_array) else {
        return Err(bad_answer());
    };
    let mut out = Vec::new();
    for d in devices.iter().take(200) {
        let field = |k: &str| d.get(k).and_then(Value::as_str).map(str::to_string);
        let (Some(tab), Some(name), Some(kind)) = (field("tabId"), field("name"), field("type"))
        else {
            return Err(bad_answer());
        };
        out.push(json!({"tabId": tab, "name": name, "type": kind}));
    }
    Ok(json!({ "devices": out }))
}

/// device_show: one plain show line on one connected tab, after GreenCLI asks.
pub fn device_show(data_dir: &Path, args: &Map<String, Value>) -> Result<Value, ToolFail> {
    let text = |k: &str| args.get(k).and_then(Value::as_str);
    let show = text("show").unwrap_or_default();
    if !crate::is_plain_show(show) {
        return Err(ToolFail::Error(
            "Only a plain show line can run: one line that starts with show, with only \
include, exclude, begin, section, match, except, count or similar filters after |."
                .into(),
        ));
    }
    let (key, target) = match (text("tab"), text("device")) {
        (Some(tab), None) => ("tab", tab),
        (None, Some(device)) => ("device", device),
        _ => {
            return Err(ToolFail::BadParams(
                "device_show needs tab or device, not both.".into(),
            ))
        }
    };
    let mut request = json!({"v": 1, "op": "show", "show": show});
    request[key] = json!(target);
    let reply = ask(data_dir, &request)?;
    let (Some(output), Some(truncated)) = (
        reply.get("output").and_then(Value::as_str),
        reply.get("truncated").and_then(Value::as_bool),
    ) else {
        return Err(bad_answer());
    };
    let mut answer = json!({ "show": show, "output": output, "truncated": truncated });
    answer[key] = json!(target);
    fit(&mut answer, output);
    Ok(answer)
}

/// Cut `output` until the whole answer fits in one tool result.
fn fit(answer: &mut Value, output: &str) {
    let limit = MAX_RESULT_BYTES - 64;
    let mut keep = output.len();
    loop {
        let size = answer.to_string().len();
        if size <= limit {
            return;
        }
        keep = keep.saturating_sub(size - limit + 16);
        while !output.is_char_boundary(keep) {
            keep -= 1;
        }
        answer["output"] = json!(&output[..keep]);
        answer["truncated"] = json!(true);
    }
}

fn bad_answer() -> ToolFail {
    ToolFail::Error("GreenCLI's answer didn't make sense. Update GreenCLI and try again.".into())
}

/// Send one request to GreenCLI and read its answer.
fn ask(data_dir: &Path, request: &Value) -> Result<Value, ToolFail> {
    ask_live_with_wait(data_dir, request, LIVE_WAIT).map_err(ToolFail::Error)
}

/// One call to GreenCLI, waiting at most `wait` for its answer. `Ok` holds
/// the answer of an `"ok":true` reply; any other outcome is plain words.
pub fn ask_live_with_wait(
    data_dir: &Path,
    request: &Value,
    wait: Duration,
) -> Result<Value, String> {
    let mut line = request.to_string().into_bytes();
    if line.len() > MAX_LIVE_REQUEST {
        return Err("The request is too long.".into());
    }
    line.push(b'\n');
    let mut stream = match UnixStream::connect(data_dir.join("mcp-live.sock")) {
        Ok(s) => s,
        Err(e) if e.kind() == ErrorKind::InvalidInput => {
            return Err(format!(
                "GreenCLI's data folder path is too long for show commands: {}",
                data_dir.display()
            ))
        }
        Err(_) => return Err(NOT_OPEN.into()),
    };
    let didnt_answer = || {
        format!(
            "GreenCLI didn't answer within {} seconds. If its box is still open, answer it \
and ask again.",
            wait.as_secs().max(1)
        )
    };
    stream
        .set_read_timeout(Some(wait))
        .and_then(|()| stream.set_write_timeout(Some(Duration::from_secs(5))))
        .and_then(|()| stream.write_all(&line))
        .and_then(|()| stream.flush())
        .map_err(|_| NOT_OPEN.to_string())?;
    let mut reader = BufReader::new(stream);
    let bytes = match transport::read_line(&mut reader, MAX_REPLY) {
        Ok(Line::Text(bytes)) => bytes,
        Ok(Line::TooLong) => return Err("GreenCLI's answer was too long.".into()),
        Ok(Line::Eof) => return Err("GreenCLI closed the request without an answer.".into()),
        Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
            return Err(didnt_answer())
        }
        Err(_) => return Err("GreenCLI closed the request without an answer.".into()),
    };
    let reply: Value = serde_json::from_slice(&bytes)
        .map_err(|_| "GreenCLI's answer didn't make sense. Update GreenCLI and try again.")?;
    match reply.get("ok").and_then(Value::as_bool) {
        Some(true) => Ok(reply),
        Some(false) => {
            let text = reply
                .get("error")
                .and_then(Value::as_str)
                .unwrap_or("GreenCLI said no.");
            Err(text.chars().take(500).collect())
        }
        None => Err("GreenCLI's answer didn't make sense. Update GreenCLI and try again.".into()),
    }
}
