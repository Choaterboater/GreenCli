// Trust-on-first-use (TOFU) host-key store.
//
// Replaces the previous behaviour where `check_server_key` accepted ANY server
// key (silent MITM exposure). On first connection to a host we record its key
// fingerprint; on later connections a mismatch is rejected.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// Process-wide lock serializing the read-modify-write of the known_hosts file.
/// `check_server_key` callbacks run concurrently for parallel connects, and each
/// call builds a fresh `KnownHosts`, so a per-instance lock wouldn't help.
static WRITE_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

/// JSON map of "host:port" -> { key-algorithm -> SHA256 key fingerprint },
/// persisted in the app dir. Keeping one fingerprint per key algorithm (like
/// OpenSSH) lets a host legitimately offer several key types — or change which
/// type it negotiates after a firmware/preference change — without a spurious
/// MITM alarm; only a changed fingerprint under the SAME algorithm is rejected.
pub struct KnownHosts {
    path: PathBuf,
}

/// Inner value for one host: normalized key algorithm ("ssh-rsa",
/// "ssh-ed25519", "ecdsa-sha2-nistp256", …) -> SHA256 fingerprint.
type HostKeys = HashMap<String, String>;

/// On-disk value for a host. The current format is a `Multi` map of
/// algorithm -> fingerprint; the untagged `Legacy` arm transparently reads the
/// original single-fingerprint-string format so existing trust stores survive
/// the upgrade instead of being wiped (which would re-prompt TOFU on every host).
#[derive(serde::Deserialize)]
#[serde(untagged)]
enum StoredEntry {
    Multi(HostKeys),
    Legacy(String),
}

/// Slot a migrated legacy fingerprint is parked under until the next connect
/// reveals its real algorithm. Chosen so it can never collide with a value
/// returned by `key::PublicKey::name()`.
const LEGACY_SLOT: &str = "legacy";

/// Fold russh's per-signature-hash RSA algorithm names (`rsa-sha2-256`,
/// `rsa-sha2-512`) back to the `ssh-rsa` key family, so the same RSA key is
/// stored under one slot regardless of which signature variant was negotiated.
/// (An RSA server key's fingerprint is stable across these variants, so this
/// only keeps the store tidy and the same-type mismatch check meaningful.)
fn normalize_key_type(key_type: &str) -> &str {
    match key_type {
        "rsa-sha2-256" | "rsa-sha2-512" => "ssh-rsa",
        other => other,
    }
}

impl KnownHosts {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn load(&self) -> HashMap<String, HostKeys> {
        let raw: HashMap<String, StoredEntry> = fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default();
        raw.into_iter()
            .map(|(host, entry)| {
                let keys = match entry {
                    StoredEntry::Multi(keys) => keys,
                    // Migrate a legacy flat record: park its fingerprint under a
                    // placeholder slot. Accept-any-match re-accepts the returning
                    // host and re-files it under the real algorithm on next connect.
                    StoredEntry::Legacy(fp) => {
                        let mut keys = HostKeys::new();
                        keys.insert(LEGACY_SLOT.to_string(), fp);
                        keys
                    }
                };
                (host, keys)
            })
            .collect()
    }

    fn save(&self, map: &HashMap<String, HostKeys>) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(map) {
            // Atomic: write a temp file then rename, so a concurrent reader never
            // sees a torn file and a crash can't truncate the trust store.
            let tmp = self.path.with_extension("json.tmp");
            if fs::write(&tmp, bytes).is_ok() {
                let _ = fs::rename(&tmp, &self.path);
            }
        }
    }

    /// List all trusted entries as (host:port, key-algorithm, fingerprint),
    /// one row per stored key type, sorted by host then algorithm.
    pub fn list(&self) -> Vec<(String, String, String)> {
        let mut v: Vec<(String, String, String)> = self
            .load()
            .into_iter()
            .flat_map(|(host, keys)| {
                keys.into_iter()
                    .map(move |(key_type, fp)| (host.clone(), key_type, fp))
            })
            .collect();
        v.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        v
    }

    /// Remove a trusted entry so the host is re-trusted (TOFU) on next connect.
    pub fn remove(&self, host_port: &str) {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.load();
        if map.remove(host_port).is_some() {
            self.save(&map);
        }
    }

    /// Verify a fingerprint for `host:port` presented under key algorithm
    /// `key_type`. Returns `Ok(true)` to accept, `Err(reason)` to reject.
    ///
    /// The fingerprint is accepted if it matches ANY key already trusted for the
    /// host (a host may legitimately offer several key types, and RSA signature
    /// variants share one fingerprint); a NEW algorithm for a known host is
    /// recorded (TOFU); only a changed fingerprint under the SAME algorithm is
    /// treated as a possible MITM. Unknown hosts are recorded and accepted.
    pub fn verify_or_record(
        &self,
        host_port: &str,
        key_type: &str,
        fingerprint: &str,
    ) -> Result<bool, String> {
        // Hold the lock across the whole read-modify-write so two parallel first-time
        // connects can't each load the same snapshot and clobber each other's record.
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let mut map = self.load();
        let key_type = normalize_key_type(key_type);

        // Snapshot the read-only decisions about this host's current record so the
        // borrow ends before we mutate `map`.
        let (matches_any, same_type_stored, legacy_matches) = match map.get(host_port) {
            Some(keys) => (
                keys.values().any(|fp| fp == fingerprint),
                keys.get(key_type).cloned(),
                keys.get(LEGACY_SLOT).map(String::as_str) == Some(fingerprint),
            ),
            None => (false, None, false),
        };

        // Already trusted under some algorithm — covers extra key types, RSA
        // signature-hash variance, and migrated legacy records → accept.
        if matches_any {
            // File it under its real algorithm if it isn't already, upgrading a
            // resolved legacy placeholder so a later same-type change stays
            // detectable. Never drop an unrelated stored key.
            if same_type_stored.as_deref() != Some(fingerprint) {
                let keys = map.entry(host_port.to_string()).or_default();
                if legacy_matches {
                    keys.remove(LEGACY_SLOT);
                }
                keys.insert(key_type.to_string(), fingerprint.to_string());
                self.save(&map);
            }
            return Ok(true);
        }

        // Same algorithm on record but a different fingerprint (matches_any was
        // false, so it cannot equal this one) → genuine key change / MITM.
        if let Some(stored) = same_type_stored {
            return Err(format!(
                "Host key mismatch for {host_port} ({key_type}): stored {stored}, got \
                 {fingerprint}. Possible MITM — remove the entry from known_hosts.json to \
                 re-trust."
            ));
        }

        // Unknown host, or a new key algorithm for a known host → record (TOFU).
        map.entry(host_port.to_string())
            .or_default()
            .insert(key_type.to_string(), fingerprint.to_string());
        self.save(&map);
        Ok(true)
    }
}

/// Convenience for callers that only have a path.
pub fn verify_or_record(
    path: &Path,
    host_port: &str,
    key_type: &str,
    fingerprint: &str,
) -> Result<bool, String> {
    KnownHosts::new(path.to_path_buf()).verify_or_record(host_port, key_type, fingerprint)
}
