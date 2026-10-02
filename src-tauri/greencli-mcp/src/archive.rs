//! The config archive: history, configs and diffs, from hidden copies only.
//!
//! GreenCLI keeps `config_archive/index.json` and, per device folder,
//! `<ts>.json` (the raw config) and `<ts>.hidden.json` (the same config with
//! secrets hidden, stamped with the secret filter version). This module
//! reads the index and the hidden copies. It never opens a raw snapshot: a
//! missing or out-of-date hidden copy is an error.

use crate::files::{read_capped, ReadFile};
use crate::page::{self, line_at, make_cursor, read_cursor, take_items, take_text, PAGE_BUDGET};
use crate::tools::ToolFail;
use crate::HIDDEN_COPY_FILTER;
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::path::{Path, PathBuf};
use std::time::Duration;

const MAX_INDEX: u64 = 16 * 1024 * 1024;
const MAX_COPY: u64 = 32 * 1024 * 1024;

pub const NO_COPY: &str =
    "No hidden copy for this snapshot. In GreenCLI, open Config archive and click Make hidden copies.";
pub const STALE_COPY: &str = "This snapshot's hidden copy is out of date. In GreenCLI, open Config archive and click Make hidden copies.";
const BAD_COPY: &str = "This snapshot's hidden copy couldn't be read. In GreenCLI, open Config archive and click Make hidden copies.";
const NO_HISTORY: &str =
    "GreenCLI has no config history for this device. Use archiveKey from list_devices.";
const NO_SNAPSHOT: &str = "This device has no snapshot with that ts. Use list_config_history.";

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    ts: u64,
    #[serde(default)]
    source: String,
    #[serde(default)]
    golden: bool,
}

#[derive(Deserialize, Default)]
struct Index {
    #[serde(default)]
    devices: HashMap<String, Vec<Entry>>,
}

#[derive(Deserialize)]
struct HiddenCopy {
    ts: u64,
    device: String,
    content: String,
    #[serde(default)]
    filter: Option<u32>,
}

/// The device's folder name: the same rule as the app's
/// ConfigArchiveStore::dir_for (testdata/dir_for.json checks both).
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
    format!("{}-{:08x}", sanitized, hash)
}

fn archive_root(data_dir: &Path) -> PathBuf {
    data_dir.join("config_archive")
}

fn hidden_path(data_dir: &Path, device: &str, ts: u64) -> PathBuf {
    archive_root(data_dir)
        .join(dir_for(device))
        .join(format!("{}.hidden.json", ts))
}

fn read_index(data_dir: &Path) -> Result<Index, ToolFail> {
    let fail = || ToolFail::Error("GreenCLI's config archive index couldn't be read.".into());
    match read_capped(&archive_root(data_dir).join("index.json"), MAX_INDEX) {
        Ok(ReadFile::Missing) => Ok(Index::default()),
        Ok(ReadFile::Bytes(bytes)) => serde_json::from_slice(&bytes).map_err(|_| fail()),
        Err(_) => Err(fail()),
    }
}

/// The device's entries, newest first.
fn entries<'a>(index: &'a Index, device: &str) -> Result<&'a [Entry], ToolFail> {
    match index.devices.get(device) {
        Some(e) if !e.is_empty() => Ok(e),
        _ => Err(ToolFail::Error(NO_HISTORY.into())),
    }
}

fn find(entries: &[Entry], ts: u64) -> Result<&Entry, ToolFail> {
    entries
        .iter()
        .find(|e| e.ts == ts)
        .ok_or_else(|| ToolFail::Error(NO_SNAPSHOT.into()))
}

/// The hidden copy of a snapshot that is in the index. Refused when missing,
/// unreadable, made by another filter version, or not this snapshot's.
fn load_hidden(data_dir: &Path, device: &str, ts: u64) -> Result<String, ToolFail> {
    let bytes = match read_capped(&hidden_path(data_dir, device, ts), MAX_COPY) {
        Ok(ReadFile::Missing) => return Err(ToolFail::Error(NO_COPY.into())),
        Ok(ReadFile::Bytes(b)) => b,
        Err(_) => return Err(ToolFail::Error(BAD_COPY.into())),
    };
    let copy: HiddenCopy =
        serde_json::from_slice(&bytes).map_err(|_| ToolFail::Error(BAD_COPY.into()))?;
    if copy.filter != Some(HIDDEN_COPY_FILTER) {
        return Err(ToolFail::Error(STALE_COPY.into()));
    }
    if copy.device != device || copy.ts != ts {
        return Err(ToolFail::Error(BAD_COPY.into()));
    }
    Ok(copy.content)
}

fn bad_cursor() -> ToolFail {
    ToolFail::Error(page::BAD_CURSOR.into())
}

pub fn list_config_history(
    data_dir: &Path,
    device: &str,
    cursor: Option<&str>,
) -> Result<Value, ToolFail> {
    const TOOL: &str = "list_config_history";
    let start = match cursor {
        None => 0,
        Some(c) => read_cursor(TOOL, c)
            .filter(|c| c.key == json!(device))
            .map(|c| c.offset)
            .ok_or_else(bad_cursor)?,
    };
    let index = read_index(data_dir)?;
    let entries = entries(&index, device)?;
    if start > entries.len() {
        return Err(bad_cursor());
    }
    // Rows are small; check hidden copies only for the rows on this page.
    let rows: Vec<Value> = entries
        .iter()
        .map(|e| json!({ "ts": e.ts, "source": page::clip(&e.source, 32), "golden": e.golden }))
        .collect();
    let (mut rows, next) = take_items(&rows, start, PAGE_BUDGET - 2048);
    for (row, entry) in rows.iter_mut().zip(&entries[start..]) {
        row["hasHiddenCopy"] = json!(load_hidden(data_dir, device, entry.ts).is_ok());
    }
    Ok(json!({
        "device": device,
        "total": entries.len(),
        "snapshots": rows,
        "nextCursor": next.map(|n| make_cursor(TOOL, &json!(device), n)),
    }))
}

pub fn get_config(
    data_dir: &Path,
    device: &str,
    ts: Option<u64>,
    cursor: Option<&str>,
) -> Result<Value, ToolFail> {
    const TOOL: &str = "get_config";
    let index = read_index(data_dir)?;
    let entries = entries(&index, device)?;
    let (ts, start) = match cursor {
        Some(c) => {
            let c = read_cursor(TOOL, c).ok_or_else(bad_cursor)?;
            let key_device = c.key.get(0).and_then(Value::as_str);
            let key_ts = c
                .key
                .get(1)
                .and_then(Value::as_u64)
                .ok_or_else(bad_cursor)?;
            if key_device != Some(device) || ts.is_some_and(|t| t != key_ts) {
                return Err(bad_cursor());
            }
            (key_ts, c.offset)
        }
        None => (ts.unwrap_or(entries[0].ts), 0),
    };
    let entry = find(entries, ts)?;
    let content = load_hidden(data_dir, device, ts)?;
    let end = take_text(&content, start, PAGE_BUDGET).ok_or_else(bad_cursor)?;
    let total_lines = content.lines().count();
    let next = (end < content.len()).then(|| make_cursor(TOOL, &json!([device, ts]), end));
    Ok(json!({
        "device": device,
        "ts": ts,
        "source": page::clip(&entry.source, 32),
        "golden": entry.golden,
        "fromLine": if content.is_empty() { 0 } else { line_at(&content, start) },
        "toLine": if end == 0 { 0 } else { line_at(&content, end - 1) },
        "totalLines": total_lines,
        "text": &content[start..end],
        "nextCursor": next,
    }))
}

/// `from`: "previous" (the snapshot before `to`), "golden", or a ts.
pub enum DiffFrom {
    Previous,
    Golden,
    Ts(u64),
}

pub fn get_config_diff(
    data_dir: &Path,
    device: &str,
    from: Option<DiffFrom>,
    to: Option<u64>,
    cursor: Option<&str>,
) -> Result<Value, ToolFail> {
    const TOOL: &str = "get_config_diff";
    let index = read_index(data_dir)?;
    let entries = entries(&index, device)?;
    let (from_ts, to_ts, start) = match cursor {
        Some(c) => {
            let c = read_cursor(TOOL, c).ok_or_else(bad_cursor)?;
            let key_device = c.key.get(0).and_then(Value::as_str);
            let key_from = c
                .key
                .get(1)
                .and_then(Value::as_u64)
                .ok_or_else(bad_cursor)?;
            let key_to = c
                .key
                .get(2)
                .and_then(Value::as_u64)
                .ok_or_else(bad_cursor)?;
            let from_differs = matches!(from, Some(DiffFrom::Ts(t)) if t != key_from);
            if key_device != Some(device) || from_differs || to.is_some_and(|t| t != key_to) {
                return Err(bad_cursor());
            }
            (key_from, key_to, c.offset)
        }
        None => {
            let to_ts = to.unwrap_or(entries[0].ts);
            let to_at = entries
                .iter()
                .position(|e| e.ts == to_ts)
                .ok_or_else(|| ToolFail::Error(NO_SNAPSHOT.into()))?;
            let from_ts = match from.unwrap_or(DiffFrom::Previous) {
                DiffFrom::Previous => entries.get(to_at + 1).map(|e| e.ts).ok_or_else(|| {
                    ToolFail::Error("This snapshot has no earlier one to compare with.".into())
                })?,
                DiffFrom::Golden => entries
                    .iter()
                    .find(|e| e.golden)
                    .map(|e| e.ts)
                    .ok_or_else(|| ToolFail::Error("This device has no golden snapshot.".into()))?,
                DiffFrom::Ts(t) => t,
            };
            (from_ts, to_ts, 0)
        }
    };
    let from_entry = find(entries, from_ts)?;
    let to_entry = find(entries, to_ts)?;
    let old = load_hidden(data_dir, device, from_ts)?;
    let new = load_hidden(data_dir, device, to_ts)?;
    let diff = if old == new {
        String::new()
    } else {
        similar::TextDiff::configure()
            .timeout(Duration::from_secs(2))
            .diff_lines(&old, &new)
            .unified_diff()
            .context_radius(3)
            .header(&from_ts.to_string(), &to_ts.to_string())
            .to_string()
    };
    let end = take_text(&diff, start, PAGE_BUDGET).ok_or_else(bad_cursor)?;
    let next = (end < diff.len()).then(|| make_cursor(TOOL, &json!([device, from_ts, to_ts]), end));
    let about =
        |e: &Entry| json!({ "ts": e.ts, "source": page::clip(&e.source, 32), "golden": e.golden });
    Ok(json!({
        "device": device,
        "from": about(from_entry),
        "to": about(to_entry),
        "same": old == new,
        "fromLine": if diff.is_empty() { 0 } else { line_at(&diff, start) },
        "toLine": if end == 0 { 0 } else { line_at(&diff, end - 1) },
        "totalLines": diff.lines().count(),
        "diff": &diff[start..end],
        "nextCursor": next,
    }))
}

#[cfg(test)]
mod tests {
    #[test]
    fn dir_for_matches_the_app() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../testdata/dir_for.json")).unwrap();
        for v in vectors.as_array().unwrap() {
            assert_eq!(
                super::dir_for(v["device"].as_str().unwrap()),
                v["dir"].as_str().unwrap(),
                "{v}"
            );
        }
    }
}
