//! The config archive: history, configs and diffs, from hidden copies only.
//!
//! GreenCLI keeps `config_archive/index.json` and, per device folder,
//! `<ts>.json` (the raw config) and `<ts>.hidden.json` (the same config with
//! secrets hidden, stamped with the secret filter version). This module
//! reads the index and the hidden copies. It never opens a raw snapshot: a
//! missing or out-of-date hidden copy is an error.

use crate::files::{is_plain_file, read_capped, ReadFile};
use crate::page::{self, line_at, make_cursor, read_cursor, take_items, take_text, PAGE_BUDGET};
use crate::tools::ToolFail;
use crate::HIDDEN_COPY_FILTER;
use serde::Deserialize;
use serde_json::{json, Value};
use similar::algorithms::{diff_deadline, Capture, Replace};
use similar::Algorithm;
use std::collections::HashMap;
use std::hash::{DefaultHasher, Hash, Hasher};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const MAX_INDEX: u64 = 16 * 1024 * 1024;
const MAX_COPY: u64 = 32 * 1024 * 1024;

// Each names the Config Archive panel and how to open it: the "Config
// archive" part of Settings has no Make hidden copies button.
pub const NO_COPY: &str = "No hidden copy for this snapshot. In GreenCLI, open Config Archive \
(activity bar or command palette) and click Make hidden copies.";
pub const STALE_COPY: &str =
    "This snapshot's hidden copy is out of date. In GreenCLI, open Config \
Archive (activity bar or command palette) and click Make hidden copies.";
const BAD_COPY: &str = "This snapshot's hidden copy couldn't be read. In GreenCLI, open Config \
Archive (activity bar or command palette) and click Make hidden copies.";
const NO_HISTORY: &str = "GreenCLI has no config history under this name. Use archiveKey from \
list_devices or list_archive_devices (a device renamed or deleted in GreenCLI keeps its history \
under its old name).";
const NO_SNAPSHOT: &str = "This device has no snapshot with that ts. Use list_config_history.";
const TOO_MANY_CHANGES: &str =
    "These two snapshots differ in too many places to show as a diff. Use get_config on each one instead.";

/// Time limit for working out a diff.
const DIFF_TIMEOUT: Duration = Duration::from_secs(2);
/// A diff with more parts than this is refused. Tidying the diff (which the
/// time limit does not cover) gets slow when there are many parts.
const MAX_DIFF_OPS: usize = 20_000;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Entry {
    ts: u64,
    #[serde(default)]
    source: String,
    #[serde(default)]
    golden: bool,
    /// The filter version of the snapshot's hidden copy, as the app saved it.
    #[serde(default)]
    hidden_filter: Option<u32>,
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

/// Every name the archive has history under, sorted, with how many snapshots
/// and the newest ts. The app files snapshots under the device's name at
/// capture time and never moves them, so a device renamed or deleted in
/// GreenCLI, or a Quick Connect that was never saved, has history here under
/// a name list_devices doesn't give. savedDevice says whether a saved device
/// still has that archiveKey (null when the saved sessions can't be read).
pub fn list_archive_devices(data_dir: &Path, cursor: Option<&str>) -> Result<Value, ToolFail> {
    const TOOL: &str = "list_archive_devices";
    let start = match cursor {
        None => 0,
        Some(c) => read_cursor(TOOL, c)
            .filter(|c| c.key.is_null())
            .map(|c| c.offset)
            .ok_or_else(bad_cursor)?,
    };
    let index = read_index(data_dir)?;
    let saved = crate::devices::saved_archive_keys(data_dir).ok();
    let mut keys: Vec<(&String, &Vec<Entry>)> = index
        .devices
        .iter()
        .filter(|(_, entries)| !entries.is_empty())
        .collect();
    keys.sort_by(|a, b| a.0.cmp(b.0));
    if start > keys.len() {
        return Err(bad_cursor());
    }
    let rows: Vec<Value> = keys
        .iter()
        .map(|(key, entries)| {
            json!({
                "archiveKey": page::clip(key, 255),
                "snapshots": entries.len(),
                "newestTs": entries[0].ts,
                "savedDevice": saved.as_ref().map(|s| s.contains(key.as_str())),
            })
        })
        .collect();
    let (rows, next) = take_items(&rows, start, PAGE_BUDGET);
    Ok(json!({
        "total": keys.len(),
        "devices": rows,
        "nextCursor": next.map(|n| make_cursor(TOOL, &Value::Null, n)),
    }))
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
    // Rows are small. hasHiddenCopy is a quick check (the index says the copy
    // is from this filter, and the file is there) that doesn't read the copy;
    // get_config and get_config_diff still check each copy in full.
    let rows: Vec<Value> = entries
        .iter()
        .map(|e| json!({ "ts": e.ts, "source": page::clip(&e.source, 32), "golden": e.golden }))
        .collect();
    let (mut rows, next) = take_items(&rows, start, PAGE_BUDGET - 2048);
    for (row, entry) in rows.iter_mut().zip(&entries[start..]) {
        let has_copy = entry.hidden_filter == Some(HIDDEN_COPY_FILTER)
            && is_plain_file(&hidden_path(data_dir, device, entry.ts), MAX_COPY);
        row["hasHiddenCopy"] = json!(has_copy);
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
    let diff = cached_diff(data_dir, device, from_ts, to_ts, &old, &new)
        .ok_or_else(|| ToolFail::Error(TOO_MANY_CHANGES.into()))?;
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

/// The last diff worked out, so paging through it doesn't redo the work.
struct LastDiff {
    data_dir: PathBuf,
    device: String,
    from_ts: u64,
    to_ts: u64,
    old: (usize, u64),
    new: (usize, u64),
    /// None: too many changes.
    diff: Option<Arc<str>>,
}

static LAST_DIFF: Mutex<Option<LastDiff>> = Mutex::new(None);

/// Length and hash of a text, to tell whether a hidden copy changed.
fn fingerprint(text: &str) -> (usize, u64) {
    let mut h = DefaultHasher::new();
    text.hash(&mut h);
    (text.len(), h.finish())
}

fn cached_diff(
    data_dir: &Path,
    device: &str,
    from_ts: u64,
    to_ts: u64,
    old: &str,
    new: &str,
) -> Option<Arc<str>> {
    let (old_fp, new_fp) = (fingerprint(old), fingerprint(new));
    let mut last = LAST_DIFF.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(l) = last.as_ref() {
        if l.data_dir == data_dir
            && l.device == device
            && l.from_ts == from_ts
            && l.to_ts == to_ts
            && l.old == old_fp
            && l.new == new_fp
        {
            return l.diff.clone();
        }
    }
    let diff = unified_diff(old, new, from_ts, to_ts).map(Arc::from);
    *last = Some(LastDiff {
        data_dir: data_dir.to_path_buf(),
        device: device.to_string(),
        from_ts,
        to_ts,
        old: old_fp,
        new: new_fp,
        diff: diff.clone(),
    });
    diff
}

/// A unified diff of two configs, or None when they differ in too many places.
/// Work is bounded: the diff itself by DIFF_TIMEOUT, and the tidy-up after it
/// by refusing diffs with more than MAX_DIFF_OPS parts.
fn unified_diff(old: &str, new: &str, from_ts: u64, to_ts: u64) -> Option<String> {
    if old == new {
        return Some(String::new());
    }
    let deadline = Instant::now() + DIFF_TIMEOUT;
    // First count the parts, without the tidy-up.
    let old_lines: Vec<&str> = old.split_inclusive('\n').collect();
    let new_lines: Vec<&str> = new.split_inclusive('\n').collect();
    let mut parts = Replace::new(Capture::new());
    diff_deadline(
        Algorithm::Myers,
        &mut parts,
        &old_lines,
        0..old_lines.len(),
        &new_lines,
        0..new_lines.len(),
        Some(deadline),
    )
    .unwrap_or_else(|never| match never {});
    if parts.into_inner().into_ops().len() > MAX_DIFF_OPS {
        return None;
    }
    Some(
        similar::TextDiff::configure()
            .algorithm(Algorithm::Myers)
            .deadline(deadline)
            .diff_lines(old, new)
            .unified_diff()
            .context_radius(3)
            .header(&from_ts.to_string(), &to_ts.to_string())
            .to_string(),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Lines drawn at random from a few words: slow to tidy up as a diff.
    fn few_words(n: usize, mut seed: u64) -> String {
        const WORDS: [&str; 8] = [
            "interface 1/1/1",
            " no shutdown",
            " vlan access 10",
            "!",
            " description x",
            "exit",
            " mtu 9198",
            " lag 1",
        ];
        (0..n)
            .map(|_| {
                seed ^= seed << 13;
                seed ^= seed >> 7;
                seed ^= seed << 17;
                format!("{}\n", WORDS[(seed % 8) as usize])
            })
            .collect()
    }

    #[test]
    fn a_diff_with_too_many_parts_is_refused() {
        let old: String = (0..30_000).map(|i| format!("line {i}\n")).collect();
        let new: String = (0..30_000)
            .map(|i| {
                if i % 2 == 0 {
                    format!("line {i}\n")
                } else {
                    format!("changed {i}\n")
                }
            })
            .collect();
        assert!(unified_diff(&old, &new, 1, 2).is_none());
        // A normal change is shown.
        let small = old.replace("line 7\n", "line seven\n");
        let diff = unified_diff(&old, &small, 1, 2).unwrap();
        assert!(diff.contains("-line 7\n+line seven\n"), "{diff}");
        assert_eq!(unified_diff(&old, &old, 1, 2).as_deref(), Some(""));
    }

    #[test]
    fn a_slow_diff_is_cut_short() {
        // These took about 7 s each before (the tidy-up has no time limit).
        let old = few_words(60_000, 1);
        let new = few_words(60_000, 7);
        let started = Instant::now();
        let diff = unified_diff(&old, &new, 1, 2);
        let took = started.elapsed();
        // Debug builds are slower; allow for that, but well under the old time.
        let limit = if cfg!(debug_assertions) { 20 } else { 5 };
        assert!(took < Duration::from_secs(limit), "took {took:?}");
        if !cfg!(debug_assertions) {
            assert!(diff.is_none());
        }
    }

    #[test]
    fn pages_reuse_the_last_diff() {
        let dir = std::env::temp_dir().join("greencli-mcp-cache-unit");
        let old: String = (0..2_000).map(|i| format!("line {i}\n")).collect();
        let new = old.replace("line 9\n", "line nine\n");
        let first = cached_diff(&dir, "sw1", 1, 2, &old, &new).unwrap();
        let again = cached_diff(&dir, "sw1", 1, 2, &old, &new).unwrap();
        assert!(Arc::ptr_eq(&first, &again));
        // A changed copy, or another pair, is worked out again.
        let newer = new.replace("line 10\n", "line ten\n");
        let other = cached_diff(&dir, "sw1", 1, 2, &old, &newer).unwrap();
        assert!(!Arc::ptr_eq(&first, &other));
        assert!(other.contains("+line ten\n"));
        let swapped = cached_diff(&dir, "sw1", 2, 1, &newer, &old).unwrap();
        assert!(swapped.contains("-line ten\n"));
    }

    #[test]
    fn dir_for_matches_the_app() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../testdata/dir_for.json")).unwrap();
        for v in vectors.as_array().unwrap() {
            assert_eq!(
                dir_for(v["device"].as_str().unwrap()),
                v["dir"].as_str().unwrap(),
                "{v}"
            );
        }
    }
}
