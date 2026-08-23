// Config archive / golden-config store.
//
// Per-device, versioned history of configuration snapshots (running-config
// captures) under `app_dir/config_archive/<device>/<ts>.json` plus a single
// `index.json` mapping device -> entries. One snapshot per device may be marked
// golden (the compliant baseline); the frontend diffs current vs golden and
// current vs previous. Snapshot content is device output only — connection
// credentials/vault secrets never reach this store (they live in `vault.enc`
// and the in-memory session map, and are wiped per BH-2).

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

    /// Atomic write: serialize to a sibling temp file then rename over the
    /// target (rename is atomic on the same filesystem).
    fn write_atomic(path: &Path, bytes: &[u8]) -> Result<(), AppError> {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(AppError::from)?;
        }
        let tmp = path.with_extension("json.tmp");
        fs::write(&tmp, bytes).map_err(AppError::from)?;
        fs::rename(&tmp, path).map_err(AppError::from)?;
        Ok(())
    }

    /// Append a snapshot for `device`. Dedupes an EXACT repeat of the most
    /// recent snapshot (a reconnect with no config change adds no history).
    /// Returns the snapshot ts, or `None` when the content was identical to the
    /// latest snapshot (nothing stored).
    pub fn capture(
        &self,
        device: &str,
        source: &str,
        content: &str,
    ) -> Result<Option<u64>, AppError> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut index = self.read_index();
        let entries = index.devices.entry(device.to_string()).or_default();
        // Strictly-increasing ts per device — captures in the same millisecond
        // can't collide on the payload file name or dedupe wrong.
        let ts = now_millis().max(entries.first().map(|e| e.ts + 1).unwrap_or(0));

        // Exact-repeat guard: identical content to the newest snapshot is a
        // no-op, so a flapping reconnect never piles up duplicate history.
        if let Some(latest) = entries.first() {
            if let Ok(existing) = self.read_snapshot(device, latest.ts) {
                if existing == content {
                    return Ok(None);
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

        entries.insert(
            0,
            ArchiveEntry {
                ts,
                source: source.to_string(),
                golden: false,
            },
        );
        // Bound per-device history: drop the oldest index row AND its payload
        // file so pruned entries can't resurrect via a stale file listing.
        while entries.len() > MAX_SNAPSHOTS_PER_DEVICE {
            if let Some(evicted) = entries.pop() {
                let _ = fs::remove_file(self.payload_path(device, evicted.ts));
            }
        }
        Self::write_atomic(
            &self.index_path,
            &serde_json::to_vec_pretty(&index).map_err(AppError::from)?,
        )?;
        Ok(Some(ts))
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
        let t1 = store
            .capture("sw-core-01", "manual", "hostname sw-core-01\n")
            .unwrap();
        assert!(t1.is_some());
        let t2 = store
            .capture(
                "sw-core-01",
                "connect",
                "hostname sw-core-01\ninterface 1/1/1\n",
            )
            .unwrap();
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
        store.capture("sw-1", "connect", "same").unwrap();
        assert!(store.capture("sw-1", "connect", "same").unwrap().is_none());
        assert_eq!(store.list("sw-1").unwrap().len(), 1);
        // A changed capture still lands after a deduped one.
        assert!(store
            .capture("sw-1", "manual", "different")
            .unwrap()
            .is_some());
        assert_eq!(store.list("sw-1").unwrap().len(), 2);
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn golden_is_exclusive_per_device() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        let t1 = store.capture("sw-1", "manual", "a").unwrap().unwrap();
        let t2 = store.capture("sw-1", "manual", "b").unwrap().unwrap();
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
        store.capture("sw-1", "connect", "c").unwrap();
        // Truncate the index mid-way (simulated torn write).
        let index = store.index_path.clone();
        let bytes = fs::read(&index).unwrap();
        fs::write(&index, &bytes[..bytes.len() / 2]).unwrap();

        let store2 = ConfigArchiveStore::new(dir.clone());
        assert!(store2.devices().unwrap().is_empty());
        assert!(store2.index_path.with_extension("json.corrupt").exists());
        // A fresh capture on the recovered store still works.
        assert!(store2.capture("sw-1", "connect", "new").unwrap().is_some());
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn history_is_capped_and_prunes_files() {
        let dir = temp_dir();
        let store = ConfigArchiveStore::new(dir.clone());
        // MAX + 5 captures with unique content.
        let mut first_ts = 0u64;
        for i in 0..MAX_SNAPSHOTS_PER_DEVICE + 5 {
            let ts = store
                .capture("sw-1", "manual", &format!("cfg-{i}"))
                .unwrap()
                .unwrap();
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
}
