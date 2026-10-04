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

/// What `read_store` found.
#[derive(Default)]
struct Store {
    map: HashMap<String, HostKeys>,
    damage: Option<Damage>,
}

#[derive(Clone, Copy)]
enum Damage {
    /// The file exists but could not be read (permissions, I/O error).
    Unreadable,
    /// The file was read but is not a valid store.
    Unparseable,
}

fn migrate(raw: HashMap<String, StoredEntry>) -> HashMap<String, HostKeys> {
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

/// Keep what can be kept from a damaged store: every host entry of the right
/// shape in a valid JSON object, or, when the JSON itself is cut off or broken,
/// the longest leading part that closes into a valid object.
fn salvage(text: &str) -> HashMap<String, HostKeys> {
    fn entries(obj: serde_json::Map<String, serde_json::Value>) -> HashMap<String, HostKeys> {
        migrate(
            obj.into_iter()
                .filter_map(|(h, v)| {
                    serde_json::from_value::<StoredEntry>(v)
                        .ok()
                        .map(|e| (h, e))
                })
                .collect(),
        )
    }
    if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str(text) {
        return entries(obj);
    }
    // Try each cut point (after a complete value, i.e. at a comma), last first.
    let cuts: Vec<usize> = text.match_indices(',').map(|(i, _)| i).collect();
    for &cut in cuts.iter().rev().take(10_000) {
        for close in ["}", "}}"] {
            let candidate = format!("{}{close}", &text[..cut]);
            if let Ok(serde_json::Value::Object(obj)) = serde_json::from_str(&candidate) {
                return entries(obj);
            }
        }
    }
    HashMap::new()
}

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

    /// Read the store without changing anything on disk. A missing file is the
    /// normal empty case. A damaged file keeps every entry that still parses
    /// (and, for a cut-off file, the entries before the cut) and reports what
    /// went wrong in `damage`, so a write path can move the file aside first.
    fn read_store(&self) -> Store {
        let bytes = match fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Store::default(),
            Err(_) => {
                return Store {
                    map: HashMap::new(),
                    damage: Some(Damage::Unreadable),
                }
            }
        };
        let text = String::from_utf8_lossy(&bytes);
        if text.trim().is_empty() {
            return Store::default();
        }
        if let Ok(raw) = serde_json::from_slice::<HashMap<String, StoredEntry>>(&bytes) {
            return Store {
                map: migrate(raw),
                damage: None,
            };
        }
        Store {
            map: salvage(&text),
            damage: Some(Damage::Unparseable),
        }
    }

    /// The trusted map, read-only (used by the list view).
    fn load(&self) -> HashMap<String, HostKeys> {
        self.read_store().map
    }

    /// Load for a read-modify-write. A damaged file is moved aside to
    /// `known_hosts.json.corrupt` (never deleted, never overwritten in place)
    /// and the entries that still parse are written back, so pins are not
    /// lost without a word. Returns the map, a plain notice for the user, and
    /// whether saving is safe (false only if a damaged file could not be moved).
    fn load_for_write(&self) -> (HashMap<String, HostKeys>, Option<String>, bool) {
        let Store { map, damage } = self.read_store();
        let Some(damage) = damage else {
            return (map, None, true);
        };
        let what = match damage {
            Damage::Unreadable => "Your saved host keys file couldn't be read".to_string(),
            Damage::Unparseable => format!(
                "Your saved host keys file was damaged. Kept {} host{}",
                map.len(),
                if map.len() == 1 { "" } else { "s" }
            ),
        };
        match self.move_aside() {
            Some(backup) => {
                let name = backup
                    .file_name()
                    .map(|n| n.to_string_lossy().into_owned())
                    .unwrap_or_default();
                let notice = format!(
                    "{what}; the old file was saved as {name}. Hosts not kept are trusted \
                     again on next connect."
                );
                log::warn!("{notice}");
                self.save(&map);
                (map, Some(notice), true)
            }
            None => {
                let notice = format!(
                    "{what} and couldn't be moved aside, so new host keys aren't being saved."
                );
                log::warn!("{notice}");
                (map, Some(notice), false)
            }
        }
    }

    /// Rename the store to the first free `known_hosts.json.corrupt[.N]` name,
    /// so an earlier backup is never overwritten.
    fn move_aside(&self) -> Option<PathBuf> {
        let base = self.path.with_extension("json.corrupt");
        let mut target = base.clone();
        let mut n = 1;
        while target.exists() {
            target = PathBuf::from(format!("{}.{n}", base.display()));
            n += 1;
        }
        fs::rename(&self.path, &target).ok().map(|_| target)
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
        let (mut map, _notice, can_save) = self.load_for_write();
        if map.remove(host_port).is_some() && can_save {
            self.save(&map);
        }
    }

    /// Verify a fingerprint for `host:port` presented under key algorithm
    /// `key_type`. Returns `Ok(outcome)` to accept, `Err(reason)` to reject.
    ///
    /// The fingerprint is accepted if it matches ANY key already trusted for the
    /// host (a host may legitimately offer several key types, and RSA signature
    /// variants share one fingerprint); a NEW algorithm for a known host is
    /// recorded (TOFU) and reported as `NewAlgorithm` so the caller can warn the
    /// user; only a changed fingerprint under the SAME algorithm is treated as a
    /// possible MITM. Unknown hosts are recorded and accepted (`FirstSeen`).
    pub fn verify_or_record(
        &self,
        host_port: &str,
        key_type: &str,
        fingerprint: &str,
    ) -> Result<Verified, String> {
        // Hold the lock across the whole read-modify-write so two parallel first-time
        // connects can't each load the same snapshot and clobber each other's record.
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (mut map, notice, can_save) = self.load_for_write();
        let key_type = normalize_key_type(key_type);
        let save = |map: &HashMap<String, HostKeys>| {
            if can_save {
                self.save(map);
            }
        };
        let done = |outcome| {
            Ok(Verified {
                outcome,
                notice: notice.clone(),
            })
        };

        // Snapshot the read-only decisions about this host's current record so the
        // borrow ends before we mutate `map`.
        let (known_host, matches_any, same_type_stored, legacy_matches) = match map.get(host_port) {
            Some(keys) => (
                true,
                keys.values().any(|fp| fp == fingerprint),
                keys.get(key_type).cloned(),
                keys.get(LEGACY_SLOT).map(String::as_str) == Some(fingerprint),
            ),
            None => (false, false, None, false),
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
                save(&map);
            }
            return done(KeyVerifyResult::Trusted);
        }

        // Same algorithm on record but a different fingerprint (matches_any was
        // false, so it cannot equal this one) → genuine key change / MITM.
        if let Some(stored) = same_type_stored {
            let mut reason = format!(
                "Host key mismatch for {host_port} ({key_type}): stored {stored}, got \
                 {fingerprint}. Possible MITM — remove the entry from known_hosts.json to \
                 re-trust."
            );
            if let Some(n) = &notice {
                reason.push(' ');
                reason.push_str(n);
            }
            return Err(reason);
        }

        // Unknown host, or a new key algorithm for a known host → record (TOFU).
        map.entry(host_port.to_string())
            .or_default()
            .insert(key_type.to_string(), fingerprint.to_string());
        save(&map);
        // A NEW algorithm on an already-known host is accepted but worth
        // surfacing: an unexpected algorithm can indicate a downgrade attempt.
        if known_host {
            done(KeyVerifyResult::NewAlgorithm)
        } else {
            done(KeyVerifyResult::FirstSeen)
        }
    }
}

/// Outcome of a successful host-key verification (rejections come back as
/// `Err(reason)` with an actionable message).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum KeyVerifyResult {
    /// First time this host:port was seen — the key was recorded (TOFU).
    FirstSeen,
    /// The presented key matched an already-trusted fingerprint.
    Trusted,
    /// A NEW key algorithm was recorded for an already-known host. Accepted,
    /// but the caller should surface it to the user — an unexpected new
    /// algorithm can indicate a downgrade attempt.
    NewAlgorithm,
}

/// An accepted host key: how it matched, plus a plain notice for the user when
/// the saved host keys file was damaged and had to be moved aside.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Verified {
    pub outcome: KeyVerifyResult,
    pub notice: Option<String>,
}

/// Convenience for callers that only have a path.
pub fn verify_or_record(
    path: &Path,
    host_port: &str,
    key_type: &str,
    fingerprint: &str,
) -> Result<Verified, String> {
    KnownHosts::new(path.to_path_buf()).verify_or_record(host_port, key_type, fingerprint)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A fresh, empty folder per test, removed on drop.
    struct TempDir(PathBuf);
    impl TempDir {
        fn new(tag: &str) -> Self {
            let p = std::env::temp_dir().join(format!(
                "greencli-kh-{tag}-{}-{}",
                std::process::id(),
                std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .unwrap()
                    .as_nanos()
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
        fn store(&self) -> PathBuf {
            self.0.join("known_hosts.json")
        }
        fn corrupt(&self) -> PathBuf {
            self.0.join("known_hosts.json.corrupt")
        }
    }
    impl Drop for TempDir {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }

    #[test]
    fn missing_file_is_empty_with_no_notice() {
        let dir = TempDir::new("missing");
        let v = verify_or_record(&dir.store(), "r1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        assert_eq!(v.outcome, KeyVerifyResult::FirstSeen);
        assert_eq!(v.notice, None);
        assert!(!dir.corrupt().exists());
    }

    #[test]
    fn garbage_file_is_moved_aside_and_connect_still_works() {
        let dir = TempDir::new("garbage");
        fs::write(dir.store(), b"\x00\xffnot json at all").unwrap();
        let v = verify_or_record(&dir.store(), "r1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        assert_eq!(v.outcome, KeyVerifyResult::FirstSeen);
        let notice = v.notice.expect("a plain notice for the user");
        assert!(notice.contains("known_hosts.json.corrupt"), "{notice}");
        // The damaged bytes are kept, never deleted.
        assert_eq!(fs::read(dir.corrupt()).unwrap(), b"\x00\xffnot json at all");
        // The store is valid again and holds the new pin.
        let list = KnownHosts::new(dir.store()).list();
        assert_eq!(
            list,
            vec![("r1:22".into(), "ssh-ed25519".into(), "SHA256:aaa".into())]
        );
    }

    #[test]
    fn entries_that_still_parse_are_kept() {
        let dir = TempDir::new("partial");
        // One good host, one legacy host, one entry of the wrong shape.
        fs::write(
            dir.store(),
            br#"{"good:22":{"ssh-ed25519":"SHA256:good"},"old:22":"SHA256:old","bad:22":42}"#,
        )
        .unwrap();
        // The good host's pin survived: a changed key is still caught.
        let err =
            verify_or_record(&dir.store(), "good:22", "ssh-ed25519", "SHA256:evil").unwrap_err();
        assert!(err.contains("mismatch"), "{err}");
        assert!(dir.corrupt().exists());
        let hosts: Vec<String> = KnownHosts::new(dir.store())
            .list()
            .into_iter()
            .map(|r| r.0)
            .collect();
        assert!(hosts.contains(&"good:22".to_string()));
        assert!(hosts.contains(&"old:22".to_string()));
        assert!(!hosts.contains(&"bad:22".to_string()));
    }

    #[test]
    fn truncated_file_keeps_the_entries_before_the_cut() {
        let dir = TempDir::new("truncated");
        let mut map: HashMap<String, HostKeys> = HashMap::new();
        for h in ["a:22", "b:22", "c:22"] {
            let mut k = HostKeys::new();
            k.insert("ssh-ed25519".into(), format!("SHA256:{h}"));
            map.insert(h.into(), k);
        }
        let full = serde_json::to_string_pretty(&map).unwrap();
        // Cut inside the last entry, as a torn write would.
        let cut = &full[..full.len() - 10];
        fs::write(dir.store(), cut).unwrap();
        let v = verify_or_record(&dir.store(), "new:22", "ssh-ed25519", "SHA256:new").unwrap();
        let notice = v.notice.expect("notice");
        assert!(notice.contains("Kept 2"), "{notice}");
        assert_eq!(fs::read_to_string(dir.corrupt()).unwrap(), cut);
        assert_eq!(KnownHosts::new(dir.store()).list().len(), 3);
    }

    #[test]
    fn a_second_damage_does_not_overwrite_the_first_backup() {
        let dir = TempDir::new("twice");
        fs::write(dir.store(), b"first damage").unwrap();
        verify_or_record(&dir.store(), "r1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        fs::write(dir.store(), b"second damage").unwrap();
        let v = verify_or_record(&dir.store(), "r1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        assert_eq!(fs::read(dir.corrupt()).unwrap(), b"first damage");
        let second = dir.0.join("known_hosts.json.corrupt.1");
        assert_eq!(fs::read(&second).unwrap(), b"second damage");
        assert!(v.notice.unwrap().contains("known_hosts.json.corrupt.1"));
    }

    #[test]
    fn listing_a_damaged_file_does_not_move_it() {
        let dir = TempDir::new("list");
        fs::write(
            dir.store(),
            br#"{"good:22":{"ssh-ed25519":"SHA256:good"},"bad:22":42}"#,
        )
        .unwrap();
        let list = KnownHosts::new(dir.store()).list();
        assert_eq!(list.len(), 1);
        assert!(!dir.corrupt().exists());
    }

    #[test]
    fn healthy_file_has_no_notice() {
        let dir = TempDir::new("healthy");
        verify_or_record(&dir.store(), "r1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        let v = verify_or_record(&dir.store(), "r1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        assert_eq!(v.outcome, KeyVerifyResult::Trusted);
        assert_eq!(v.notice, None);
        assert!(!dir.corrupt().exists());
    }

    #[cfg(unix)]
    #[test]
    fn unreadable_file_is_moved_aside_not_overwritten() {
        use std::os::unix::fs::PermissionsExt;
        let dir = TempDir::new("unreadable");
        fs::write(dir.store(), br#"{"a:22":{"ssh-ed25519":"SHA256:a"}}"#).unwrap();
        fs::set_permissions(dir.store(), fs::Permissions::from_mode(0o000)).unwrap();
        if fs::read(dir.store()).is_ok() {
            return; // running as root: the file is still readable
        }
        let v = verify_or_record(&dir.store(), "r1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        assert!(v.notice.is_some());
        let c = dir.corrupt();
        fs::set_permissions(&c, fs::Permissions::from_mode(0o600)).unwrap();
        assert_eq!(
            fs::read(&c).unwrap(),
            br#"{"a:22":{"ssh-ed25519":"SHA256:a"}}"#
        );
    }
}
