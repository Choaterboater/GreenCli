//! Live show commands: the one place this server talks to anything. It
//! connects to GreenCLI's own channel and nowhere else (tests/source_scan.rs
//! checks this):
//! - macOS and Linux: `mcp-live.sock` in GreenCLI's data folder;
//! - Windows: the named pipe on this computer whose name GreenCLI writes in
//!   that same file (`greencli-live-` and 32 hex digits, a new one each time
//!   the channel opens). The data folder is yours alone, so another user
//!   can't learn the name and take the pipe first.
//!
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
use crate::{LIVE_CLIENT_WAIT, MAX_LIVE_REQUEST};
use serde_json::{json, Map, Value};
use std::io::{BufRead, BufReader, ErrorKind, Write};
#[cfg(unix)]
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
    ask_live_with_wait(data_dir, request, LIVE_CLIENT_WAIT).map_err(ToolFail::Error)
}

fn didnt_answer(wait: Duration) -> String {
    format!(
        "GreenCLI didn't answer within {} seconds. The line may have run; check in \
GreenCLI before asking again.",
        wait.as_secs().max(1)
    )
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
    let bytes = exchange(data_dir, line, wait)?;
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

/// GreenCLI's one answer line, read after the request went out.
fn read_answer<R: BufRead>(reader: &mut R, wait: Duration) -> Result<Vec<u8>, String> {
    match transport::read_line(reader, MAX_REPLY) {
        Ok(Line::Text(bytes)) => Ok(bytes),
        Ok(Line::TooLong) => Err("GreenCLI's answer was too long.".into()),
        Ok(Line::Eof) => Err("GreenCLI closed the request without an answer.".into()),
        Err(e) if matches!(e.kind(), ErrorKind::WouldBlock | ErrorKind::TimedOut) => {
            Err(didnt_answer(wait))
        }
        Err(_) => Err("GreenCLI closed the request without an answer.".into()),
    }
}

/// macOS and Linux: send `line` over <data dir>/mcp-live.sock, read the answer.
#[cfg(unix)]
fn exchange(data_dir: &Path, line: Vec<u8>, wait: Duration) -> Result<Vec<u8>, String> {
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
    stream
        .set_read_timeout(Some(wait))
        .and_then(|()| stream.set_write_timeout(Some(Duration::from_secs(5))))
        .and_then(|()| stream.write_all(&line))
        .and_then(|()| stream.flush())
        .map_err(|_| NOT_OPEN.to_string())?;
    read_answer(&mut BufReader::new(stream), wait)
}

/// Windows: send `line` over GreenCLI's pipe, read the answer. A pipe has no
/// read timeout, so the call runs on its own thread and this one waits at
/// most `wait`. If that runs out, the thread ends when GreenCLI closes the
/// pipe (its own wait is shorter).
#[cfg(windows)]
fn exchange(data_dir: &Path, line: Vec<u8>, wait: Duration) -> Result<Vec<u8>, String> {
    let mut pipe = connect_pipe(data_dir)?;
    let (tx, rx) = std::sync::mpsc::channel();
    std::thread::spawn(move || {
        let answer = match pipe.write_all(&line).and_then(|()| pipe.flush()) {
            Ok(()) => read_answer(&mut BufReader::new(pipe), wait),
            Err(_) => Err(NOT_OPEN.to_string()),
        };
        let _ = tx.send(answer);
    });
    match rx.recv_timeout(wait) {
        Ok(answer) => answer,
        Err(std::sync::mpsc::RecvTimeoutError::Timeout) => Err(didnt_answer(wait)),
        Err(std::sync::mpsc::RecvTimeoutError::Disconnected) => {
            Err("GreenCLI closed the request without an answer.".into())
        }
    }
}

/// The pipe's name, from <data dir>/mcp-live.sock: `greencli-live-` and 32
/// lowercase hex digits, nothing else (so never a path or another computer).
#[cfg(windows)]
fn pipe_name(data_dir: &Path) -> Option<String> {
    use std::io::Read;
    let mut text = String::new();
    std::fs::File::open(data_dir.join("mcp-live.sock"))
        .ok()?
        .take(64)
        .read_to_string(&mut text)
        .ok()?;
    let hex = text.strip_prefix("greencli-live-")?;
    let ok = hex.len() == 32 && hex.bytes().all(|b| matches!(b, b'0'..=b'9' | b'a'..=b'f'));
    ok.then_some(text)
}

/// Open GreenCLI's pipe for one call. All its doors busy for a moment (another
/// call just came in) is waited out, briefly.
#[cfg(windows)]
fn connect_pipe(data_dir: &Path) -> Result<std::fs::File, String> {
    use std::os::windows::fs::OpenOptionsExt;
    /// GreenCLI's end may not act as this program.
    const SECURITY_ANONYMOUS: u32 = 0;
    const ERROR_PIPE_BUSY: i32 = 231;
    let Some(name) = pipe_name(data_dir) else {
        return Err(NOT_OPEN.into());
    };
    let pipe = format!(r"\\.\pipe\{name}");
    let start = std::time::Instant::now();
    loop {
        match std::fs::OpenOptions::new()
            .read(true)
            .write(true)
            .security_qos_flags(SECURITY_ANONYMOUS)
            .open(&pipe)
        {
            Ok(file) => return Ok(file),
            Err(e)
                if e.raw_os_error() == Some(ERROR_PIPE_BUSY)
                    && start.elapsed() < Duration::from_secs(2) =>
            {
                std::thread::sleep(Duration::from_millis(20));
            }
            Err(_) => return Err(NOT_OPEN.into()),
        }
    }
}
