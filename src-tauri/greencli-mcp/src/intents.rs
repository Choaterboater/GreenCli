//! list_intents: each intent's name, kind, severity and last result.
//!
//! `intents.json` is read into structs without the command, matcher,
//! description or result details, so those are never even parsed.

use crate::files::{read_capped, ReadError, ReadFile};
use crate::page::{self, clip, make_cursor, read_cursor, take_items, PAGE_BUDGET};
use crate::tools::ToolFail;
use serde::Deserialize;
use serde_json::{json, Value};
use std::path::Path;

const MAX_FILE: u64 = 16 * 1024 * 1024;
/// Per-device results shown for one intent; the rest are counted.
const MAX_DEVICES: usize = 50;
const TOOL: &str = "list_intents";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DeviceResult {
    #[serde(default)]
    device: String,
    #[serde(default)]
    status: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IntentResult {
    #[serde(default)]
    status: String,
    #[serde(default)]
    at: u64,
    #[serde(default)]
    per_device: Vec<DeviceResult>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Intent {
    #[serde(default)]
    id: String,
    #[serde(default)]
    name: String,
    #[serde(default)]
    kind: String,
    #[serde(default)]
    severity: String,
    #[serde(default)]
    last_result: Option<IntentResult>,
}

fn read_intents(data_dir: &Path) -> Result<Vec<Intent>, ToolFail> {
    let fail = |what: &str| ToolFail::Error(format!("GreenCLI's intents file {what}."));
    let bytes = match read_capped(&data_dir.join("intents.json"), MAX_FILE) {
        Ok(ReadFile::Missing) => return Ok(Vec::new()),
        Ok(ReadFile::Bytes(b)) => b,
        Err(ReadError::TooBig) => return Err(fail("is too big to read")),
        Err(ReadError::NotPlain) => return Err(fail("couldn't be read")),
    };
    if bytes.iter().all(u8::is_ascii_whitespace) {
        return Ok(Vec::new());
    }
    serde_json::from_slice(&bytes).map_err(|_| fail("couldn't be read"))
}

fn intent_json(i: &Intent) -> Value {
    let (last, devices, more) = match &i.last_result {
        None => (Value::Null, Vec::new(), 0),
        Some(r) => {
            let devices: Vec<Value> = r
                .per_device
                .iter()
                .take(MAX_DEVICES)
                .map(|d| json!({ "device": clip(&d.device, 64), "status": clip(&d.status, 16) }))
                .collect();
            let more = r.per_device.len().saturating_sub(MAX_DEVICES);
            (
                json!({ "status": clip(&r.status, 16), "at": r.at }),
                devices,
                more,
            )
        }
    };
    let mut out = json!({
        "id": clip(&i.id, 64),
        "name": clip(&i.name, 128),
        "kind": clip(&i.kind, 32),
        "severity": clip(&i.severity, 16),
        "lastResult": last,
        "devices": devices,
    });
    if more > 0 {
        out["moreDevices"] = json!(more);
    }
    out
}

pub fn list_intents(data_dir: &Path, cursor: Option<&str>) -> Result<Value, ToolFail> {
    let start = match cursor {
        None => 0,
        Some(c) => read_cursor(TOOL, c)
            .filter(|c| c.key.is_null())
            .map(|c| c.offset)
            .ok_or_else(|| ToolFail::Error(page::BAD_CURSOR.into()))?,
    };
    let all: Vec<Value> = read_intents(data_dir)?.iter().map(intent_json).collect();
    if start > all.len() {
        return Err(ToolFail::Error(page::BAD_CURSOR.into()));
    }
    let (intents, next) = take_items(&all, start, PAGE_BUDGET);
    Ok(json!({
        "total": all.len(),
        "intents": intents,
        "nextCursor": next.map(|n| make_cursor(TOOL, &Value::Null, n)),
    }))
}
