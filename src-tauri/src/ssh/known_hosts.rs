// Trust-on-first-use (TOFU) host-key store.
//
// Replaces the previous behaviour where `check_server_key` accepted ANY server
// key (silent MITM exposure). On first connection to a host we record its key
// fingerprint; on later connections a mismatch is rejected.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

/// JSON map of "host:port" -> SHA256 key fingerprint, persisted in the app dir.
pub struct KnownHosts {
    path: PathBuf,
}

impl KnownHosts {
    pub fn new(path: PathBuf) -> Self {
        Self { path }
    }

    fn load(&self) -> HashMap<String, String> {
        fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save(&self, map: &HashMap<String, String>) {
        if let Some(parent) = self.path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if let Ok(bytes) = serde_json::to_vec_pretty(map) {
            let _ = fs::write(&self.path, bytes);
        }
    }

    /// List all trusted entries as (host:port, fingerprint), sorted by host.
    pub fn list(&self) -> Vec<(String, String)> {
        let mut v: Vec<(String, String)> = self.load().into_iter().collect();
        v.sort_by(|a, b| a.0.cmp(&b.0));
        v
    }

    /// Remove a trusted entry so the host is re-trusted (TOFU) on next connect.
    pub fn remove(&self, host_port: &str) {
        let mut map = self.load();
        if map.remove(host_port).is_some() {
            self.save(&map);
        }
    }

    /// Verify a fingerprint for `host:port`.
    /// Returns `Ok(true)` to accept, `Err(reason)` to reject on mismatch.
    /// Unknown hosts are recorded (TOFU) and accepted.
    pub fn verify_or_record(&self, host_port: &str, fingerprint: &str) -> Result<bool, String> {
        let mut map = self.load();
        match map.get(host_port) {
            Some(stored) if stored == fingerprint => Ok(true),
            Some(stored) => Err(format!(
                "Host key mismatch for {host_port}: stored {stored}, got {fingerprint}. \
                 Possible MITM — remove the entry from known_hosts.json to re-trust."
            )),
            None => {
                map.insert(host_port.to_string(), fingerprint.to_string());
                self.save(&map);
                Ok(true)
            }
        }
    }
}

/// Convenience for callers that only have a path.
pub fn verify_or_record(path: &Path, host_port: &str, fingerprint: &str) -> Result<bool, String> {
    KnownHosts::new(path.to_path_buf()).verify_or_record(host_port, fingerprint)
}
