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

/// The name a pin is stored under. Like OpenSSH, a host name is matched
/// without regard to letter case (and a trailing dot is dropped), so
/// `Router1` and `router1.` share one pin. IP addresses are kept as typed.
fn normalize_host_port(host_port: &str) -> String {
    let (host, port) = match host_port.rsplit_once(':') {
        Some((h, p)) if !p.is_empty() && p.bytes().all(|b| b.is_ascii_digit()) => (h, Some(p)),
        _ => (host_port, None),
    };
    let bare = host.trim_start_matches('[').trim_end_matches(']');
    if bare.parse::<std::net::IpAddr>().is_ok() {
        return host_port.to_string();
    }
    let host = host.strip_suffix('.').unwrap_or(host).to_ascii_lowercase();
    match port {
        Some(p) => format!("{host}:{p}"),
        None => host,
    }
}

/// Every stored name that is the same host as `key` (case variants written
/// before names were lowercased), with `key` itself first.
fn variants_of(map: &HashMap<String, HostKeys>, key: &str) -> Vec<String> {
    let mut v: Vec<String> = map
        .keys()
        .filter(|k| normalize_host_port(k) == key)
        .cloned()
        .collect();
    v.sort_by(|a, b| {
        (b.as_str() == key)
            .cmp(&(a.as_str() == key))
            .then_with(|| a.cmp(b))
    });
    v
}

/// Move every case variant of `key` into the one `key` entry. A key type
/// already under `key` wins; otherwise the first variant's is kept.
fn fold<'a>(
    map: &'a mut HashMap<String, HostKeys>,
    key: &str,
    variants: &[String],
) -> &'a mut HostKeys {
    let mut merged = map.remove(key).unwrap_or_default();
    for v in variants.iter().filter(|v| v.as_str() != key) {
        if let Some(keys) = map.remove(v) {
            for (alg, fp) in keys {
                merged.entry(alg).or_insert(fp);
            }
        }
    }
    map.entry(key.to_string()).or_insert(merged)
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
                if let Err(e) = self.save(&map) {
                    log::warn!("Couldn't write the kept host keys back: {e}");
                }
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

    fn save(&self, map: &HashMap<String, HostKeys>) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            fs::create_dir_all(parent)?;
        }
        let bytes = serde_json::to_vec_pretty(map)?;
        // Atomic: write a temp file then rename, so a concurrent reader never
        // sees a torn file and a crash can't truncate the trust store.
        let tmp = self.path.with_extension("json.tmp");
        fs::write(&tmp, bytes)?;
        fs::rename(&tmp, &self.path).inspect_err(|_| {
            let _ = fs::remove_file(&tmp);
        })
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
    /// A failed save comes back as a plain error.
    pub fn remove(&self, host_port: &str) -> Result<(), String> {
        let _guard = WRITE_LOCK.lock().unwrap_or_else(|e| e.into_inner());
        let (mut map, _notice, can_save) = self.load_for_write();
        let key = normalize_host_port(host_port);
        let mut removed = false;
        for v in variants_of(&map, &key) {
            removed |= map.remove(&v).is_some();
        }
        if removed && can_save {
            self.save(&map).map_err(|e| {
                log::warn!("Couldn't save host keys after forgetting {host_port}: {e}");
                format!("Couldn't forget {host_port}: the host keys file couldn't be saved.")
            })?;
        }
        Ok(())
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
        let notice = std::cell::RefCell::new(notice);
        let key_type = normalize_key_type(key_type);
        // A failed save never blocks the connection: it adds one plain
        // warning line instead (like OpenSSH's "Failed to add the host").
        let save = |map: &HashMap<String, HostKeys>| {
            if !can_save {
                return;
            }
            if let Err(e) = self.save(map) {
                log::warn!("Couldn't save the host key for {host_port}: {e}");
                let line = "Couldn't save the host key, so it isn't pinned; it will be \
                            trusted again on next connect.";
                let mut n = notice.borrow_mut();
                *n = Some(match n.take() {
                    Some(prev) => format!("{prev} {line}"),
                    None => line.to_string(),
                });
            }
        };
        let done = |outcome| {
            Ok(Verified {
                outcome,
                notice: notice.borrow().clone(),
            })
        };

        // Snapshot the read-only decisions about this host's current record so the
        // borrow ends before we mutate `map`. Case variants of the name are the
        // same host.
        let key = normalize_host_port(host_port);
        let variants = variants_of(&map, &key);
        let known_host = !variants.is_empty();
        let matches_any = variants
            .iter()
            .any(|v| map[v].values().any(|fp| fp == fingerprint));
        let already_filed = variants.len() == 1
            && variants[0] == key
            && map[&key].get(key_type).map(String::as_str) == Some(fingerprint);
        let same_type_stored = variants
            .iter()
            .find_map(|v| map[v].get(key_type).map(|fp| (v.clone(), fp.clone())));

        // Already trusted under some algorithm — covers extra key types, RSA
        // signature-hash variance, and migrated legacy records → accept.
        if matches_any {
            // File it under its real algorithm if it isn't already, upgrading a
            // resolved legacy placeholder so a later same-type change stays
            // detectable. Never drop an unrelated stored key.
            if !already_filed {
                let keys = fold(&mut map, &key, &variants);
                if keys.get(LEGACY_SLOT).map(String::as_str) == Some(fingerprint) {
                    keys.remove(LEGACY_SLOT);
                }
                keys.insert(key_type.to_string(), fingerprint.to_string());
                save(&map);
            }
            return done(KeyVerifyResult::Trusted);
        }

        // Same algorithm on record but a different fingerprint (matches_any was
        // false, so it cannot equal this one) → genuine key change / MITM.
        if let Some((name, stored)) = same_type_stored {
            let mut reason = format!(
                "Host key mismatch for {name} ({key_type}): stored {stored}, got \
                 {fingerprint}. Possible MITM. If the device was replaced or re-keyed, \
                 click Forget next to {name} in Settings > Host keys and connect again."
            );
            if let Some(n) = notice.borrow().as_ref() {
                reason.push(' ');
                reason.push_str(n);
            }
            return Err(reason);
        }

        // Unknown host, or a new key algorithm for a known host → record (TOFU).
        fold(&mut map, &key, &variants).insert(key_type.to_string(), fingerprint.to_string());
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

    /// Make `dir` read-only so nothing can be written in it. Returns false
    /// when running as root (writes still succeed), so the test can skip.
    #[cfg(unix)]
    fn lock_dir(dir: &Path) -> bool {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o555)).unwrap();
        let probe = dir.join("probe");
        if fs::write(&probe, b"x").is_ok() {
            let _ = fs::remove_file(&probe);
            return false;
        }
        true
    }

    #[cfg(unix)]
    fn unlock_dir(dir: &Path) {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(dir, fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_save_still_connects_and_says_so() {
        let dir = TempDir::new("nosave");
        if !lock_dir(&dir.0) {
            unlock_dir(&dir.0);
            return;
        }
        let v = verify_or_record(&dir.store(), "r1:22", "ssh-ed25519", "SHA256:aaa");
        unlock_dir(&dir.0);
        let v = v.expect("connecting goes ahead");
        assert_eq!(v.outcome, KeyVerifyResult::FirstSeen);
        let notice = v.notice.expect("one plain warning line");
        assert!(notice.contains("Couldn't save"), "{notice}");
        assert!(!dir.store().exists());
    }

    #[cfg(unix)]
    #[test]
    fn save_returns_the_error() {
        let dir = TempDir::new("saveerr");
        if !lock_dir(&dir.0) {
            unlock_dir(&dir.0);
            return;
        }
        let r = KnownHosts::new(dir.store()).save(&HashMap::new());
        unlock_dir(&dir.0);
        assert!(r.is_err());
    }

    #[cfg(unix)]
    #[test]
    fn a_failed_forget_returns_the_error() {
        let dir = TempDir::new("noforget");
        verify_or_record(&dir.store(), "r1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        if !lock_dir(&dir.0) {
            unlock_dir(&dir.0);
            return;
        }
        let r = KnownHosts::new(dir.store()).remove("r1:22");
        unlock_dir(&dir.0);
        assert!(r.is_err());
    }

    #[test]
    fn host_names_match_without_regard_to_case_or_a_trailing_dot() {
        let dir = TempDir::new("case");
        verify_or_record(&dir.store(), "Router1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        for name in ["router1:22", "ROUTER1:22", "router1.:22"] {
            let v = verify_or_record(&dir.store(), name, "ssh-ed25519", "SHA256:aaa").unwrap();
            assert_eq!(v.outcome, KeyVerifyResult::Trusted, "{name}");
        }
        let err =
            verify_or_record(&dir.store(), "ROUTER1:22", "ssh-ed25519", "SHA256:evil").unwrap_err();
        assert!(err.contains("mismatch"), "{err}");
        // One pin, stored under the lowercase name.
        let list = KnownHosts::new(dir.store()).list();
        assert_eq!(
            list,
            vec![(
                "router1:22".into(),
                "ssh-ed25519".into(),
                "SHA256:aaa".into()
            )]
        );
    }

    #[test]
    fn ip_addresses_are_kept_as_typed() {
        let dir = TempDir::new("ip");
        verify_or_record(&dir.store(), "FE80::1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        verify_or_record(&dir.store(), "10.0.0.1:22", "ssh-ed25519", "SHA256:bbb").unwrap();
        let hosts: Vec<String> = KnownHosts::new(dir.store())
            .list()
            .into_iter()
            .map(|r| r.0)
            .collect();
        assert_eq!(
            hosts,
            vec!["10.0.0.1:22".to_string(), "FE80::1:22".to_string()]
        );
        assert_eq!(normalize_host_port("FE80::1:22"), "FE80::1:22");
        assert_eq!(normalize_host_port("[FE80::1]:22"), "[FE80::1]:22");
        assert_eq!(
            normalize_host_port("Core-SW.Example.COM.:2222"),
            "core-sw.example.com:2222"
        );
    }

    #[test]
    fn an_old_mixed_case_pin_is_still_honoured() {
        let dir = TempDir::new("oldcase");
        // Written by an earlier version, before names were lowercased.
        fs::write(
            dir.store(),
            br#"{"Router1:22":{"ssh-ed25519":"SHA256:aaa"}}"#,
        )
        .unwrap();
        let err =
            verify_or_record(&dir.store(), "router1:22", "ssh-ed25519", "SHA256:evil").unwrap_err();
        assert!(err.contains("mismatch"), "{err}");
        // The normal key-changed message names the pin as listed and points
        // to the Forget button, never to editing a file.
        assert!(err.contains("Router1:22"), "{err}");
        assert!(err.contains("Forget"), "{err}");
        assert!(err.contains("Settings > Host keys"), "{err}");
        assert!(!err.contains("known_hosts.json"), "{err}");
        // The right key is trusted, and the pin moves to the lowercase name.
        let v = verify_or_record(&dir.store(), "router1:22", "ssh-ed25519", "SHA256:aaa").unwrap();
        assert_eq!(v.outcome, KeyVerifyResult::Trusted);
        let list = KnownHosts::new(dir.store()).list();
        assert_eq!(
            list,
            vec![(
                "router1:22".into(),
                "ssh-ed25519".into(),
                "SHA256:aaa".into()
            )]
        );
    }

    #[test]
    fn a_new_key_type_folds_old_case_variants_into_one_pin() {
        let dir = TempDir::new("fold");
        fs::write(
            dir.store(),
            br#"{"Router1:22":{"ssh-ed25519":"SHA256:aaa"}}"#,
        )
        .unwrap();
        let v = verify_or_record(&dir.store(), "router1:22", "ssh-rsa", "SHA256:rsa").unwrap();
        assert_eq!(v.outcome, KeyVerifyResult::NewAlgorithm);
        let list = KnownHosts::new(dir.store()).list();
        assert_eq!(
            list,
            vec![
                (
                    "router1:22".into(),
                    "ssh-ed25519".into(),
                    "SHA256:aaa".into()
                ),
                ("router1:22".into(), "ssh-rsa".into(), "SHA256:rsa".into()),
            ]
        );
    }

    #[test]
    fn forget_removes_every_case_variant() {
        let dir = TempDir::new("forgetcase");
        fs::write(
            dir.store(),
            br#"{"Router1:22":{"ssh-ed25519":"SHA256:aaa"},"router1:22":{"ssh-rsa":"SHA256:b"},"other:22":{"ssh-rsa":"SHA256:c"}}"#,
        )
        .unwrap();
        KnownHosts::new(dir.store()).remove("Router1:22").unwrap();
        let hosts: Vec<String> = KnownHosts::new(dir.store())
            .list()
            .into_iter()
            .map(|r| r.0)
            .collect();
        assert_eq!(hosts, vec!["other:22".to_string()]);
        // Re-trusted on next connect.
        let v = verify_or_record(&dir.store(), "router1:22", "ssh-ed25519", "SHA256:new").unwrap();
        assert_eq!(v.outcome, KeyVerifyResult::FirstSeen);
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
