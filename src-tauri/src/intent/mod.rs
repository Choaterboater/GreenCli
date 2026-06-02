// Network intent / desired-state layer.
//
// Persists the operator's desired state of the network — both *config* intents
// (configuration that should/should-not be present) and *operational* intents
// (expected live state: links up, BGP established, reachability, …) — plus the
// latest evaluation result. The evaluation itself runs in the frontend (it has
// the live terminal/REST channels); this module is the durable store of truth.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use std::fs;
use std::path::PathBuf;
use std::sync::Mutex;

/// How an intent's command output is judged.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Matcher {
    /// "contains" | "notContains" | "regex" | "regexAbsent"
    pub kind: String,
    pub value: String,
}

/// Which devices an intent applies to.
#[derive(Clone, Debug, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Scope {
    #[serde(default)]
    pub all: bool,
    #[serde(default)]
    pub tags: Vec<String>,
    #[serde(default)]
    pub device_types: Vec<String>,
}

/// Per-device evaluation outcome.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceResult {
    pub device: String,
    /// "ok" | "violation" | "unknown"
    pub status: String,
    pub detail: String,
}

/// Latest evaluation of an intent.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct IntentResult {
    /// Worst per-device status: "ok" | "violation" | "unknown".
    pub status: String,
    pub detail: String,
    /// Epoch millis of the evaluation (set by the frontend).
    pub at: u64,
    #[serde(default)]
    pub per_device: Vec<DeviceResult>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Intent {
    pub id: String,
    pub name: String,
    /// "config" | "operational"
    pub kind: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub description: Option<String>,
    /// Command run on the device to gather evidence.
    pub command: String,
    pub matcher: Matcher,
    /// "critical" | "warning" | "info"
    pub severity: String,
    #[serde(default)]
    pub scope: Scope,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub last_result: Option<IntentResult>,
}

/// Durable JSON store of intents (desired state + last result).
///
/// Every mutation is a read-modify-write of the whole file. Tauri dispatches the
/// (synchronous) intent commands on its worker-thread pool, so two invokes can run
/// concurrently — and the AI tool's `evaluate_network_intents` sweep writes results
/// while the user may be adding/deleting in the panel. The `lock` serializes the
/// whole read-modify-write so writers can't lose each other's changes.
pub struct IntentStore {
    path: PathBuf,
    lock: Mutex<()>,
}

impl IntentStore {
    pub fn new(app_dir: PathBuf) -> Self {
        Self {
            path: app_dir.join("intents.json"),
            lock: Mutex::new(()),
        }
    }

    /// Read + parse the store. Caller must hold `lock`. A missing file is the normal
    /// empty case; a *present but unparseable* file is backed up to
    /// `intents.json.corrupt` (rather than silently returning [] and letting the next
    /// write launder the corruption into permanent total loss) before returning empty.
    fn read_locked(&self) -> Vec<Intent> {
        let bytes = match fs::read(&self.path) {
            Ok(b) => b,
            Err(_) => return Vec::new(), // missing / unreadable -> empty (normal)
        };
        if bytes.is_empty() {
            return Vec::new();
        }
        match serde_json::from_slice::<Vec<Intent>>(&bytes) {
            Ok(v) => v,
            Err(_) => {
                // Preserve the unparseable bytes for recovery instead of dropping them.
                let backup = self.path.with_extension("json.corrupt");
                let _ = fs::write(&backup, &bytes);
                Vec::new()
            }
        }
    }

    pub fn load(&self) -> Vec<Intent> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.read_locked()
    }

    /// Atomic write: serialize to a sibling temp file then rename over the target.
    /// Rename is atomic on the same filesystem, so a reader never sees a torn file and
    /// a crash mid-write leaves the previous good file intact. Caller must hold `lock`.
    fn save_locked(&self, intents: &[Intent]) -> Result<(), AppError> {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, serde_json::to_vec_pretty(intents)?).map_err(AppError::from)?;
        fs::rename(&tmp, &self.path).map_err(AppError::from)?;
        Ok(())
    }

    pub fn upsert(&self, intent: Intent) -> Result<(), AppError> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = self.read_locked();
        if let Some(existing) = all.iter_mut().find(|i| i.id == intent.id) {
            let mut incoming = intent;
            // An edit from the panel omits last_result; keep the stored evaluation
            // so saving (e.g.) a renamed intent doesn't wipe its fresh result.
            if incoming.last_result.is_none() {
                incoming.last_result = existing.last_result.clone();
            }
            *existing = incoming;
        } else {
            all.push(intent);
        }
        self.save_locked(&all)
    }

    pub fn remove(&self, id: &str) -> Result<(), AppError> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = self.read_locked();
        all.retain(|i| i.id != id);
        self.save_locked(&all)
    }

    /// Attach an evaluation result to an intent.
    pub fn set_result(&self, id: &str, result: IntentResult) -> Result<(), AppError> {
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut all = self.read_locked();
        if let Some(i) = all.iter_mut().find(|i| i.id == id) {
            i.last_result = Some(result);
        }
        self.save_locked(&all)
    }
}
