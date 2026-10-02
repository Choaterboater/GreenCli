// Config archive / golden-config store.
//
// Per-device, versioned history of configuration snapshots (running-config
// captures) under `app_dir/config_archive/<device>/<ts>.json` plus a single
// `index.json` mapping device -> entries. One snapshot per device may be marked
// golden (the compliant baseline); the frontend diffs current vs golden and
// current vs previous. Snapshot content is device output only — connection
// credentials/vault secrets never reach this store (they live in `vault.enc`
// and the in-memory session map, and are wiped per BH-2).
//
// Hidden copies (2.0): next to each raw `<ts>.json`, `<ts>.hidden.json` holds
// the same config with secrets hidden by the frontend's secret filter (the one
// the AI uses), stamped with the filter version. greencli-mcp serves only
// these copies, and only when the version is `greencli_mcp::HIDDEN_COPY_FILTER`.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

/// Number of snapshots kept per device; the oldest are pruned past this so a
/// long-running fleet can't grow the archive without bound.
const MAX_SNAPSHOTS_PER_DEVICE: usize = 100;

/// One history row for a device (metadata lives in the index; the snapshot
/// payload file holds the config content).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveEntry {
    /// Snapshot id — the epoch-ms timestamp used as the payload file name.
    pub ts: u64,
    /// "connect" | "manual"
    pub source: String,
    /// True if marked as the golden / compliant baseline (at most one per device).
    #[serde(default)]
    pub golden: bool,
    /// Secret filter version of this snapshot's hidden copy; None when it has
    /// none. Serde default so index files from before 2.0 load.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub hidden_filter: Option<u32>,
}

#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ArchiveIndex {
    /// device id -> entries, newest first.
    #[serde(default)]
    pub devices: HashMap<String, Vec<ArchiveEntry>>,
}

#[derive(Serialize, Deserialize)]
struct SnapshotPayload {
    ts: u64,
    device: String,
    source: String,
    content: String,
}

/// `<ts>.hidden.json`: the snapshot with secrets hidden, for greencli-mcp.
#[derive(Serialize)]
struct HiddenPayload<'a> {
    ts: u64,
    device: &'a str,
    source: &'a str,
    content: &'a str,
    filter: u32,
    /// "capture" (written with the snapshot) or "backfill" (made later).
    made: &'a str,
}

/// The secret filter version greencli-mcp accepts.
pub const HIDDEN_COPY_FILTER: u32 = greencli_mcp::HIDDEN_COPY_FILTER;

/// What a capture stored.
#[derive(Clone, Debug, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Captured {
    /// Snapshot ts, or None when identical to the newest one (nothing stored).
    pub ts: Option<u64>,
    /// Set when the hidden copy was not saved.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
}

/// One snapshot that needs a (new) hidden copy.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct HiddenTodo {
    pub device: String,
    pub ts: u64,
}

/// How many snapshots have a current hidden copy, an old one, or none.
#[derive(Clone, Debug, Default, Serialize)]
pub struct HiddenStatus {
    pub missing: usize,
    pub stale: usize,
    pub current: usize,
    /// The missing and stale ones, newest first per device.
    pub todo: Vec<HiddenTodo>,
}

fn stale_filter_text(filter: u32) -> String {
    format!(
        "The hidden copy was made by secret filter version {filter}, but this GreenCLI needs version {HIDDEN_COPY_FILTER}. It was not saved."
    )
}

/// Durable per-device config history. All mutations are read-modify-write of
/// the index under a mutex (Tauri dispatches synchronous commands on its
/// worker pool, so two invokes can run concurrently); payload files are
/// written atomically (tmp sibling + rename) like `IntentStore`.
pub struct ConfigArchiveStore {
    root: PathBuf,
    index_path: PathBuf,
    lock: Mutex<()>,
}

impl ConfigArchiveStore {
    pub fn new(app_dir: PathBuf) -> Self {
        let root = app_dir.join("config_archive");
        Self {
            index_path: root.join("index.json"),
            root,
            lock: Mutex::new(()),
        }
    }

    fn payload_path(&self, device: &str, ts: u64) -> PathBuf {
        self.root
            .join(Self::dir_for(device))
            .join(format!("{ts}.json"))
    }

    fn hidden_path(&self, device: &str, ts: u64) -> PathBuf {
        self.root
            .join(Self::dir_for(device))
            .join(format!("{ts}.hidden.json"))
    }

    /// Whether the entry's hidden copy is one greencli-mcp serves: the index
    /// says this filter, and the file passes greencli-mcp's own checks (a
    /// plain file it can read, made by this filter, for this snapshot). A
    /// damaged copy counts as missing, so Make hidden copies makes it again.
    fn hidden_ok(&self, device: &str, entry: &ArchiveEntry) -> bool {
        entry.hidden_filter == Some(HIDDEN_COPY_FILTER)
            && greencli_mcp::hidden_copy_usable(
                &self.hidden_path(device, entry.ts),
                device,
                entry.ts,
            )
    }

    /// Write the hidden copy of snapshot `ts`. Caller holds `lock`.
    fn write_hidden(
        &self,
        device: &str,
        ts: u64,
        source: &str,
        content: &str,
        made: &str,
    ) -> Result<(), AppError> {
        let payload = HiddenPayload {
            ts,
            device,
            source,
            content,
            filter: HIDDEN_COPY_FILTER,
            made,
        };
        Self::write_atomic(
            &self.hidden_path(device, ts),
            &serde_json::to_vec_pretty(&payload).map_err(AppError::from)?,
        )
    }

    /// Directory name for a device: sanitized id + a short content hash suffix,
    /// so two different ids can't collide onto one directory (e.g. ids differing
    /// only in characters that aren't path-safe).
    fn dir_for(device: &str) -> String {
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
        // FNV-1a 32-bit, lowercase hex — enough to disambiguate sanitize collisions.
        let mut hash: u32 = 0x811c_9dc5;
        for b in device.bytes() {
            hash ^= u32::from(b);
            hash = hash.wrapping_mul(0x0100_0193);
        }
        format!("{}-{:08x}", sanitized, hash)
    }

    /// Read + parse the index. Caller must hold `lock`. A missing file is the
    /// normal empty case; a present-but-unparseable file is backed up to
    /// `index.json.corrupt` before returning empty (mirrors `IntentStore`), so
    /// a torn write can't silently launder every device's history away.
    fn read_index(&self) -> ArchiveIndex {
        let bytes = match fs::read(&self.index_path) {
            Ok(b) => b,
            Err(_) => return ArchiveIndex::default(),
        };
        if bytes.is_empty() {
            self.backup_corrupt_index();
            return ArchiveIndex::default();
        }
        match serde_json::from_slice::<ArchiveIndex>(&bytes) {
            Ok(idx) => idx,
            Err(_) => {
                self.backup_corrupt_index();
                ArchiveIndex::default()
            }
        }
    }

    fn backup_corrupt_index(&self) {
        if let Some(parent) = self.index_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let backup = self.index_path.with_extension("json.corrupt");
        let _ = fs::copy(&self.index_path, &backup);
    }

    /// Atomic, owner-only write (snapshots are raw running-configs, secrets
    /// included): a sibling temp file renamed over the target, inside a folder
    /// only this user can open.
    fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
        if let Some(parent) = path.parent() {
            crate::private_fs::private_dir(parent)?;
        }
        crate::private_fs::write_private_atomic(path, bytes)
    }

    /// Append a snapshot for `device`. Dedupes an EXACT repeat of the most
    /// recent snapshot (a reconnect with no config change adds no history).
    /// Returns the snapshot ts, or `None` when the content was identical to the
    /// latest snapshot (nothing stored).
    ///
    /// `hidden`: the same config with secrets hidden, and the secret filter
    /// version that made it. It is saved as `<ts>.hidden.json` after the raw
    /// snapshot and before the index. A version other than
    /// HIDDEN_COPY_FILTER is not saved (a warning says so); the raw capture
    /// still succeeds.
    pub fn capture(
        &self,
        device: &str,
        source: &str,
        content: &str,
        hidden: Option<(&str, u32)>,
    ) -> Result<Captured, AppError> {
        let mut warning = None;
        let hidden = match hidden {
            Some((_, filter)) if filter != HIDDEN_COPY_FILTER => {
                warning = Some(stale_filter_text(filter));
                None
            }
            other => other.map(|(text, _)| text),
        };
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut index = self.read_index();
        let latest = index.devices.get(device).and_then(|e| e.first()).cloned();
        // Strictly-increasing ts per device — captures in the same millisecond
        // can't collide on the payload file name or dedupe wrong.
        let ts = now_millis().max(latest.as_ref().map(|e| e.ts + 1).unwrap_or(0));

        // Exact-repeat guard: identical content to the newest snapshot is a
        // no-op, so a flapping reconnect never piles up duplicate history.
        // It still fills in the newest snapshot's hidden copy when that one
        // has none or an old one.
        if let Some(latest) = latest {
            if let Ok(existing) = self.read_snapshot(device, latest.ts) {
                if existing == content {
                    let needs_copy = !self.hidden_ok(device, &latest);
                    if let (Some(text), true) = (hidden, needs_copy) {
                        match self.write_hidden(device, latest.ts, &latest.source, text, "capture")
                        {
                            Ok(()) => {
                                if let Some(e) =
                                    index.devices.get_mut(device).and_then(|v| v.first_mut())
                                {
                                    e.hidden_filter = Some(HIDDEN_COPY_FILTER);
                                }
                                Self::write_atomic(
                                    &self.index_path,
                                    &serde_json::to_vec_pretty(&index).map_err(AppError::from)?,
                                )?;
                            }
                            Err(e) => warning = Some(format!("The hidden copy was not saved: {e}")),
                        }
                    }
                    return Ok(Captured { ts: None, warning });
                }
            }
        }

        let payload = SnapshotPayload {
            ts,
            device: device.to_string(),
            source: source.to_string(),
            content: content.to_string(),
        };
        Self::write_atomic(
            &self.payload_path(device, ts),
            &serde_json::to_vec_pretty(&payload).map_err(AppError::from)?,
        )?;

        // The hidden copy goes after the raw snapshot and before the index.
        // Without one, any old file at that name goes, so a copy never
        // belongs to other content.
        let mut hidden_filter = None;
        match hidden {
            Some(text) => match self.write_hidden(device, ts, source, text, "capture") {
                Ok(()) => hidden_filter = Some(HIDDEN_COPY_FILTER),
                Err(e) => warning = Some(format!("The hidden copy was not saved: {e}")),
            },
            None => {
                let _ = fs::remove_file(self.hidden_path(device, ts));
            }
        }

        let entries = index.devices.entry(device.to_string()).or_default();
        entries.insert(
            0,
            ArchiveEntry {
                ts,
                source: source.to_string(),
                golden: false,
                hidden_filter,
            },
        );
        // Bound per-device history: drop the oldest index row AND its payload
        // files so pruned entries can't resurrect via a stale file listing.
        while entries.len() > MAX_SNAPSHOTS_PER_DEVICE {
            if let Some(evicted) = entries.pop() {
                let _ = fs::remove_file(self.payload_path(device, evicted.ts));
                let _ = fs::remove_file(self.hidden_path(device, evicted.ts));
            }
        }
        Self::write_atomic(
            &self.index_path,
            &serde_json::to_vec_pretty(&index).map_err(AppError::from)?,
        )?;
        Ok(Captured {
            ts: Some(ts),
            warning,
        })
    }

    /// Save a hidden copy made later (the "Make hidden copies" button, or the
    /// background refresh after a filter change) for a snapshot in the index.
    pub fn set_hidden(
        &self,
        device: &str,
        ts: u64,
        hidden: &str,
        filter: u32,
    ) -> Result<(), AppError> {
        if filter != HIDDEN_COPY_FILTER {
            return Err(AppError::ConfigError(stale_filter_text(filter)));
        }
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut index = self.read_index();
        let entry = index
            .devices
            .get_mut(device)
            .and_then(|entries| entries.iter_mut().find(|e| e.ts == ts))
            .ok_or_else(|| {
                AppError::ConfigError(format!("Snapshot {ts} not found for device '{device}'"))
            })?;
        let source = entry.source.clone();
        self.write_hidden(device, ts, &source, hidden, "backfill")?;
        entry.hidden_filter = Some(HIDDEN_COPY_FILTER);
        Self::write_atomic(
            &self.index_path,
            &serde_json::to_vec_pretty(&index).map_err(AppError::from)?,
        )
    }

    /// Count snapshots by hidden copy: current, stale (an older filter) or
    /// missing (none, or one greencli-mcp can't use), and list the ones that
    /// need a new copy. Reads each copy, as greencli-mcp would.
    pub fn hidden_status(&self) -> HiddenStatus {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let index = self.read_index();
        let mut status = HiddenStatus::default();
        let mut devices: Vec<_> = index.devices.iter().collect();
        devices.sort_by(|a, b| a.0.cmp(b.0));
        for (device, entries) in devices {
            for e in entries {
                if self.hidden_ok(device, e) {
                    status.current += 1;
                    continue;
                }
                match e.hidden_filter {
                    Some(f) if f != HIDDEN_COPY_FILTER => status.stale += 1,
                    _ => status.missing += 1,
                }
                status.todo.push(HiddenTodo {
                    device: device.clone(),
                    ts: e.ts,
                });
            }
        }
        status
    }

    fn read_snapshot(&self, device: &str, ts: u64) -> Result<String, AppError> {
        let bytes = fs::read(self.payload_path(device, ts)).map_err(AppError::from)?;
        let payload: SnapshotPayload = serde_json::from_slice(&bytes).map_err(AppError::from)?;
        Ok(payload.content)
    }

    /// Entries newest-first for a device.
    pub fn list(&self, device: &str) -> Result<Vec<ArchiveEntry>, AppError> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Ok(self
            .read_index()
            .devices
            .get(device)
            .cloned()
            .unwrap_or_default())
    }

    /// Devices that have at least one snapshot.
    pub fn devices(&self) -> Result<Vec<String>, AppError> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Ok(self.read_index().devices.keys().cloned().collect())
    }

    /// Snapshot content by device + ts.
    pub fn get(&self, device: &str, ts: u64) -> Result<String, AppError> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.read_snapshot(device, ts)
    }

    /// Mark `ts` as the device's golden baseline (unsetting any previous one).
    pub fn set_golden(&self, device: &str, ts: u64) -> Result<(), AppError> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut index = self.read_index();
        let entries = index
            .devices
            .get_mut(device)
            .ok_or_else(|| AppError::ConfigError(format!("No history for device '{device}'")))?;
        if !entries.iter().any(|e| e.ts == ts) {
            return Err(AppError::ConfigError(format!(
                "Snapshot {ts} not found for device '{device}'"
            )));
        }
        for e in entries.iter_mut() {
            e.golden = e.ts == ts;
        }
        Self::write_atomic(
            &self.index_path,
            &serde_json::to_vec_pretty(&index).map_err(AppError::from)?,
        )
    }
}

fn now_millis() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A capture with no hidden copy: the stored ts, if any.
    fn cap(store: &ConfigArchiveStore, device: &str, source: &str, content: &str) -> Option<u64> {
        store.capture(device, source, content, None).unwrap().ts
    }

    fn temp_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("atp-config-archive-test-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    #[test]
    fn round_trip_and_history_order() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        let t1 = cap(&store, "sw-core-01", "manual", "hostname sw-core-01\n");
        assert!(t1.is_some());
        let t2 = cap(
            &store,
            "sw-core-01",
            "connect",
            "hostname sw-core-01\ninterface 1/1/1\n",
        );
        assert!(t2.is_some());

        let entries = store.list("sw-core-01").unwrap();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].ts, t2.unwrap()); // newest first
        assert_eq!(entries[0].source, "connect");
        assert!(!entries[0].golden);

        assert_eq!(
            store.get("sw-core-01", t1.unwrap()).unwrap(),
            "hostname sw-core-01\n"
        );
        // Unknown device -> empty list, not an error.
        assert!(store.list("other").unwrap().is_empty());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn identical_repeat_is_deduped() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        cap(&store, "sw-1", "connect", "same");
        assert!(cap(&store, "sw-1", "connect", "same").is_none());
        assert_eq!(store.list("sw-1").unwrap().len(), 1);
        // A changed capture still lands after a deduped one.
        assert!(cap(&store, "sw-1", "manual", "different").is_some());
        assert_eq!(store.list("sw-1").unwrap().len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn golden_is_exclusive_per_device() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        let t1 = cap(&store, "sw-1", "manual", "a").unwrap();
        let t2 = cap(&store, "sw-1", "manual", "b").unwrap();
        store.set_golden("sw-1", t1).unwrap();
        let entries = store.list("sw-1").unwrap();
        assert!(entries.iter().find(|e| e.ts == t1).unwrap().golden);
        assert!(!entries.iter().find(|e| e.ts == t2).unwrap().golden);
        // Marking a second snapshot moves the golden flag.
        store.set_golden("sw-1", t2).unwrap();
        let entries = store.list("sw-1").unwrap();
        assert!(!entries.iter().find(|e| e.ts == t1).unwrap().golden);
        assert!(entries.iter().find(|e| e.ts == t2).unwrap().golden);
        // Setting a nonexistent ts errors.
        assert!(store.set_golden("sw-1", 999_999).is_err());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn corrupt_index_is_backed_up_not_laundered() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        cap(&store, "sw-1", "connect", "c");
        // Truncate the index mid-way (simulated torn write).
        let index = store.index_path.clone();
        let bytes = fs::read(&index).unwrap();
        fs::write(&index, &bytes[..bytes.len() / 2]).unwrap();

        let store2 = ConfigArchiveStore::new(dir.clone());
        assert!(store2.devices().unwrap().is_empty());
        assert!(store2.index_path.with_extension("json.corrupt").exists());
        // A fresh capture on the recovered store still works.
        assert!(cap(&store2, "sw-1", "connect", "new").is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn history_is_capped_and_prunes_files() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        // MAX + 5 captures with unique content.
        let mut first_ts = 0u64;
        for i in 0..MAX_SNAPSHOTS_PER_DEVICE + 5 {
            let ts = cap(&store, "sw-1", "manual", &format!("cfg-{i}")).unwrap();
            if i == 0 {
                first_ts = ts;
            }
        }
        let entries = store.list("sw-1").unwrap();
        assert_eq!(entries.len(), MAX_SNAPSHOTS_PER_DEVICE);
        // The oldest snapshot's payload file was pruned.
        assert!(!store.payload_path("sw-1", first_ts).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    fn hidden_json(store: &ConfigArchiveStore, device: &str, ts: u64) -> serde_json::Value {
        let bytes = fs::read(store.hidden_path(device, ts)).unwrap();
        serde_json::from_slice(&bytes).unwrap()
    }

    #[test]
    fn capture_writes_the_hidden_copy_and_its_filter() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        let got = store
            .capture(
                "sw-1",
                "connect",
                "password secret1\n",
                Some(("password <hidden>\n", HIDDEN_COPY_FILTER)),
            )
            .unwrap();
        assert!(got.warning.is_none());
        let ts = got.ts.unwrap();
        let copy = hidden_json(&store, "sw-1", ts);
        assert_eq!(copy["ts"], ts);
        assert_eq!(copy["device"], "sw-1");
        assert_eq!(copy["source"], "connect");
        assert_eq!(copy["content"], "password <hidden>\n");
        assert_eq!(copy["filter"], HIDDEN_COPY_FILTER);
        assert_eq!(copy["made"], "capture");
        assert_eq!(
            store.list("sw-1").unwrap()[0].hidden_filter,
            Some(HIDDEN_COPY_FILTER)
        );
        // The raw snapshot is unchanged.
        assert_eq!(store.get("sw-1", ts).unwrap(), "password secret1\n");
        // The index says so too, in camelCase.
        let index = fs::read_to_string(&store.index_path).unwrap();
        assert!(index.contains("\"hiddenFilter\": 1"), "{index}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_wrong_filter_version_is_not_written() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        let got = store
            .capture("sw-1", "manual", "a", Some(("a", HIDDEN_COPY_FILTER + 1)))
            .unwrap();
        let ts = got.ts.unwrap();
        assert!(got.warning.unwrap().contains("not saved"));
        assert!(!store.hidden_path("sw-1", ts).exists());
        assert_eq!(store.list("sw-1").unwrap()[0].hidden_filter, None);
        // No copy at all is fine too.
        let got = store.capture("sw-1", "manual", "b", None).unwrap();
        assert!(got.warning.is_none());
        assert!(!store.hidden_path("sw-1", got.ts.unwrap()).exists());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_repeat_fills_in_the_newest_hidden_copy() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        let ts = cap(&store, "sw-1", "connect", "cfg").unwrap();
        assert_eq!(store.hidden_status().missing, 1);
        let again = store
            .capture(
                "sw-1",
                "connect",
                "cfg",
                Some(("cfg-hidden", HIDDEN_COPY_FILTER)),
            )
            .unwrap();
        assert_eq!(again.ts, None);
        assert_eq!(hidden_json(&store, "sw-1", ts)["content"], "cfg-hidden");
        assert_eq!(store.hidden_status().current, 1);
        assert_eq!(store.list("sw-1").unwrap().len(), 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn pruning_removes_hidden_copies() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        let mut first_ts = 0u64;
        for i in 0..MAX_SNAPSHOTS_PER_DEVICE + 2 {
            let content = format!("cfg-{i}");
            let ts = store
                .capture(
                    "sw-1",
                    "manual",
                    &content,
                    Some((&content, HIDDEN_COPY_FILTER)),
                )
                .unwrap()
                .ts
                .unwrap();
            if i == 0 {
                first_ts = ts;
            }
        }
        assert!(!store.payload_path("sw-1", first_ts).exists());
        assert!(!store.hidden_path("sw-1", first_ts).exists());
        let files = fs::read_dir(store.root.join(ConfigArchiveStore::dir_for("sw-1")))
            .unwrap()
            .count();
        assert_eq!(files, 2 * MAX_SNAPSHOTS_PER_DEVICE);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn set_hidden_checks_the_snapshot_and_the_filter() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        let ts = cap(&store, "sw-1", "connect", "secret").unwrap();
        assert!(store
            .set_hidden("sw-1", ts + 1, "x", HIDDEN_COPY_FILTER)
            .is_err());
        assert!(store
            .set_hidden("other", ts, "x", HIDDEN_COPY_FILTER)
            .is_err());
        assert!(store
            .set_hidden("sw-1", ts, "x", HIDDEN_COPY_FILTER - 1)
            .is_err());
        assert!(store
            .set_hidden("sw-1", ts, "x", HIDDEN_COPY_FILTER + 1)
            .is_err());
        assert!(!store.hidden_path("sw-1", ts).exists());
        store
            .set_hidden("sw-1", ts, "<hidden>", HIDDEN_COPY_FILTER)
            .unwrap();
        let copy = hidden_json(&store, "sw-1", ts);
        assert_eq!(copy["content"], "<hidden>");
        assert_eq!(copy["made"], "backfill");
        assert_eq!(copy["source"], "connect");
        assert_eq!(
            store.list("sw-1").unwrap()[0].hidden_filter,
            Some(HIDDEN_COPY_FILTER)
        );
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn index_files_from_before_hidden_copies_load() {
        let dir = temp_dir();
        let root = dir.join("config_archive");
        fs::create_dir_all(&root).unwrap();
        fs::write(
            root.join("index.json"),
            r#"{"devices":{"sw-1":[{"ts":5,"source":"connect","golden":true},{"ts":3,"source":"manual"}]}}"#,
        )
        .unwrap();
        let store = ConfigArchiveStore::new(dir.clone());
        let entries = store.list("sw-1").unwrap();
        assert_eq!(entries.len(), 2);
        assert!(entries.iter().all(|e| e.hidden_filter.is_none()));
        assert!(!root.join("index.json.corrupt").exists());
        let status = store.hidden_status();
        assert_eq!((status.missing, status.stale, status.current), (2, 0, 0));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn hidden_status_counts_missing_and_stale_apart() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        let t1 = cap(&store, "sw-1", "connect", "a").unwrap();
        let t2 = store
            .capture("sw-1", "connect", "b", Some(("b", HIDDEN_COPY_FILTER)))
            .unwrap()
            .ts
            .unwrap();
        let t3 = store
            .capture("sw-2", "connect", "c", Some(("c", HIDDEN_COPY_FILTER)))
            .unwrap()
            .ts
            .unwrap();
        // Make sw-2's copy look like an older filter's.
        {
            let _g = store.lock.lock().unwrap();
            let mut index = store.read_index();
            index.devices.get_mut("sw-2").unwrap()[0].hidden_filter = Some(HIDDEN_COPY_FILTER - 1);
            ConfigArchiveStore::write_atomic(
                &store.index_path,
                &serde_json::to_vec(&index).unwrap(),
            )
            .unwrap();
        }
        let status = store.hidden_status();
        assert_eq!((status.missing, status.stale, status.current), (1, 1, 1));
        assert_eq!(
            status.todo,
            vec![
                HiddenTodo {
                    device: "sw-1".into(),
                    ts: t1
                },
                HiddenTodo {
                    device: "sw-2".into(),
                    ts: t3
                },
            ]
        );
        // A current copy whose file is gone counts as missing.
        fs::remove_file(store.hidden_path("sw-1", t2)).unwrap();
        assert_eq!(store.hidden_status().missing, 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_copy_greencli_mcp_cant_use_counts_as_missing_and_is_made_again() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        let ts = store
            .capture("sw-1", "connect", "a", Some(("a", HIDDEN_COPY_FILTER)))
            .unwrap()
            .ts
            .unwrap();
        assert_eq!(store.hidden_status().current, 1);
        let path = store.hidden_path("sw-1", ts);
        let good = fs::read(&path).unwrap();
        let other_ts = String::from_utf8(good.clone())
            .unwrap()
            .replace(&format!("\"ts\": {ts}"), &format!("\"ts\": {}", ts + 1));
        let old_filter = String::from_utf8(good.clone()).unwrap().replace(
            &format!("\"filter\": {HIDDEN_COPY_FILTER}"),
            &format!("\"filter\": {}", HIDDEN_COPY_FILTER - 1),
        );
        // Cut short (a crash after the rename), empty, another snapshot's, or
        // stamped with an older filter while the index says this one: the
        // index still says this filter, but greencli-mcp refuses each.
        let broken: [&[u8]; 4] = [b"{", b"", other_ts.as_bytes(), old_filter.as_bytes()];
        for bytes in broken {
            fs::write(&path, bytes).unwrap();
            assert!(!greencli_mcp::hidden_copy_usable(&path, "sw-1", ts));
            assert_eq!(
                store.list("sw-1").unwrap()[0].hidden_filter,
                Some(HIDDEN_COPY_FILTER)
            );
            let status = store.hidden_status();
            assert_eq!((status.missing, status.stale, status.current), (1, 0, 0));
            assert_eq!(
                status.todo,
                vec![HiddenTodo {
                    device: "sw-1".into(),
                    ts
                }]
            );
            // Make hidden copies (set_hidden) puts it right.
            store
                .set_hidden("sw-1", ts, "a", HIDDEN_COPY_FILTER)
                .unwrap();
            assert_eq!(store.hidden_status().current, 1);
        }
        // A capture of the same config fills in a damaged newest copy too.
        fs::write(&path, b"{").unwrap();
        let again = store
            .capture("sw-1", "connect", "a", Some(("a", HIDDEN_COPY_FILTER)))
            .unwrap();
        assert_eq!(again.ts, None);
        assert_eq!(store.hidden_status().current, 1);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn dir_for_matches_greencli_mcp() {
        let vectors: serde_json::Value =
            serde_json::from_str(include_str!("../greencli-mcp/testdata/dir_for.json")).unwrap();
        for v in vectors.as_array().unwrap() {
            assert_eq!(
                ConfigArchiveStore::dir_for(v["device"].as_str().unwrap()),
                v["dir"].as_str().unwrap(),
                "{v}"
            );
        }
    }
}
