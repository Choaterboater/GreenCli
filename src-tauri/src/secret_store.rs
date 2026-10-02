// AI keys and MCP logins in the system password store.
//
// 2.0 keeps them in macOS Keychain, Windows Credential Manager or the Linux
// Secret Service (the "OS store"), each under the service name of the app's
// identifier and an account of `ai-key:<provider>` or `mcp-creds:<server>`.
// Windows ignores case in an item's target name, so there the target spells
// capitals and other characters as `%xx` (see windows_target).
//
// Where they are kept is decided once per start:
// - `secret_store.json` (the marker) exists: the OS store, with no probe. A
//   failing call gives the "can't reach" text; nothing ever falls back to a
//   file once keys may have moved into the OS store.
// - No marker: a probe (save, read back, delete `greencli-probe`) runs with a
//   3 s limit. When it passes the marker is written at once and the OS store
//   is used. When it fails, this start uses the 1.9 files (`ai_keys.json`,
//   `mcp_creds.json`) in their 1.9 format, so 1.9 can still read them, and
//   the next start probes again.
//
// With the OS store, old 1.9 files are moved in at every start while they
// exist: each entry is saved, read back and compared byte for byte, and only
// when every entry checks out is the file deleted. A file that can't be read
// is left alone, and Settings names it.
//
// A move that stops partway is tried again at the next start. The marker
// keeps the files being moved (`moving`) and the accounts already done
// (`done`): those moved, and those the user saved or removed since. A retry
// skips them, so it never puts an old 1.9 value back over a 2.0 change.
//
// Windows Credential Manager holds at most 2560 bytes per item, so a longer
// value is split: the item itself holds the header `GCS1 N S LEN\n` and the
// parts are in `part1S:<account>` … `partNS:<account>`, where the slot S is
// `a` or `b` and LEN is the length of the whole value. A save writes its parts
// to the slot the saved value doesn't use, then the header, so the header
// write alone switches to the new value: a save that stops partway leaves the
// old value whole, and the new parts it wrote are deleted. Once the header is
// written, the old slot's parts go, along with any a save that stopped
// earlier left behind. Early 2.0 builds wrote `GCS1 N\n` with parts in
// `part1:<account>` … `partN:<account>`; that still reads.

use crate::private_fs;
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex};
use std::time::Duration;
use zeroize::Zeroizing;

#[cfg(not(any(target_os = "macos", target_os = "windows", target_os = "linux")))]
compile_error!("GreenCLI keeps keys in macOS Keychain, Windows Credential Manager or the Linux Secret Service; this system has none of them.");

/// Account prefix for AI provider keys.
pub const AI_KEY_PREFIX: &str = "ai-key:";
/// Account prefix for the content of an MCP server's credentials file.
pub const MCP_CREDS_PREFIX: &str = "mcp-creds:";
/// The 1.9 files, used as they are when there is no OS store.
pub const AI_KEYS_FILE: &str = "ai_keys.json";
pub const MCP_CREDS_FILE: &str = "mcp_creds.json";
/// Written the first time the OS store works; from then on it is always used.
const MARKER_FILE: &str = "secret_store.json";
/// Marker fields: the 1.9 files a move has started on, and the accounts
/// already done for them.
const MOVING: &str = "moving";
const DONE: &str = "done";
const PROBE_ACCOUNT: &str = "greencli-probe";
const PROBE_TIMEOUT: Duration = Duration::from_secs(3);
const CHUNK_MAGIC: &str = "GCS1 ";
/// A part must hold more than the header does.
const MIN_PART: usize = 64;
/// The most parts a header can name (six digits).
const MAX_PARTS: usize = 999_999;

/// The error for any failed call to the OS store (the cause goes to the log).
pub const UNAVAILABLE: &str =
    "Can't reach the system password store. Your keys are still there. Try again after you log in to the desktop.";

/// Which store holds the keys.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum StoreKind {
    Keychain,
    CredentialManager,
    SecretService,
    File,
}

/// One place secrets can be read from and written to. Values are bytes; a
/// missing account reads as `None` and deletes as `Ok`.
pub trait SecretBackend: Send + Sync {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String>;
    fn set(&self, account: &str, value: &[u8]) -> Result<(), String>;
    fn delete(&self, account: &str) -> Result<(), String>;
    /// The longest value one item can hold (`usize::MAX`: no limit).
    fn max_blob(&self) -> usize;
    fn kind(&self) -> StoreKind;
}

// ─── The OS store ───

/// macOS Keychain, Windows Credential Manager or the Secret Service, through
/// the keyring crate. A new Entry for every call, so a read back after a save
/// really asks the store again.
pub struct KeyringBackend {
    service: String,
}

impl KeyringBackend {
    pub fn new(service: &str) -> Self {
        Self {
            service: service.to_string(),
        }
    }

    fn entry(&self, account: &str) -> Result<keyring::Entry, String> {
        #[cfg(windows)]
        let entry = keyring::Entry::new_with_target(&windows_target(&self.service, account), &self.service, account);
        #[cfg(not(windows))]
        let entry = keyring::Entry::new(&self.service, account);
        entry.map_err(|e| e.to_string())
    }
}

/// The Credential Manager target name for `account`. Windows compares target
/// names without regard to case, but server names that differ only in case
/// are different servers, so keyring's default `<account>.<service>` would
/// let "Central" and "central" share one item. The username field still
/// holds the account as it is, which is what Credential Manager shows.
#[cfg_attr(not(windows), allow(dead_code))]
fn windows_target(service: &str, account: &str) -> String {
    format!("{}.{}", win_target(account), service)
}

/// `account` with no capital letters, one to one: `a-z`, `0-9` and `-_.: `
/// stay as they are (so `ai-key:anthropic` still reads), and every other
/// UTF-8 byte, `%` and capitals included, becomes `%` and two lowercase hex
/// digits. Two different accounts never match even when case is ignored.
#[cfg_attr(not(windows), allow(dead_code))]
fn win_target(account: &str) -> String {
    use std::fmt::Write;
    let mut out = String::with_capacity(account.len());
    for b in account.bytes() {
        if matches!(b, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b':' | b' ') {
            out.push(b as char);
        } else {
            let _ = write!(out, "%{:02x}", b);
        }
    }
    out
}

impl SecretBackend for KeyringBackend {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        match self.entry(account)?.get_secret() {
            Ok(v) => Ok(Some(Zeroizing::new(v))),
            Err(keyring::Error::NoEntry) => Ok(None),
            Err(e) => Err(e.to_string()),
        }
    }

    fn set(&self, account: &str, value: &[u8]) -> Result<(), String> {
        self.entry(account)?
            .set_secret(value)
            .map_err(|e| e.to_string())
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        match self.entry(account)?.delete_credential() {
            Ok(()) | Err(keyring::Error::NoEntry) => Ok(()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn max_blob(&self) -> usize {
        // CRED_MAX_CREDENTIAL_BLOB_SIZE. Keychain and the Secret Service take
        // much more; 32 KiB parts keep each item a sensible size.
        if cfg!(windows) {
            2560
        } else {
            32 * 1024
        }
    }

    fn kind(&self) -> StoreKind {
        if cfg!(target_os = "macos") {
            StoreKind::Keychain
        } else if cfg!(windows) {
            StoreKind::CredentialManager
        } else {
            StoreKind::SecretService
        }
    }
}

// ─── The 1.9 files ───

/// One 1.9 key file: `{ "<name>": "<value>" }` with plain strings, owner-only,
/// written with `private_fs::write_key_file`. Account `<prefix><name>` is key
/// `<name>`. Read like 1.9 did: a file that can't be read is an empty map.
pub struct FileBackend {
    path: PathBuf,
    prefix: &'static str,
    lock: Mutex<()>,
}

impl FileBackend {
    pub fn new(path: PathBuf, prefix: &'static str) -> Self {
        Self {
            path,
            prefix,
            lock: Mutex::new(()),
        }
    }

    fn name<'a>(&self, account: &'a str) -> Result<&'a str, String> {
        account
            .strip_prefix(self.prefix)
            .ok_or_else(|| format!("'{}' is not kept in {}", account, self.path.display()))
    }

    fn load(&self) -> HashMap<String, String> {
        fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save(&self, m: &HashMap<String, String>) -> Result<(), String> {
        let bytes = serde_json::to_vec(m).map_err(|e| e.to_string())?;
        private_fs::write_key_file(&self.path, &bytes).map_err(|e| e.to_string())
    }
}

impl SecretBackend for FileBackend {
    fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        let name = self.name(account)?;
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        Ok(self
            .load()
            .remove(name)
            .map(|v| Zeroizing::new(v.into_bytes())))
    }

    fn set(&self, account: &str, value: &[u8]) -> Result<(), String> {
        let name = self.name(account)?;
        let text = std::str::from_utf8(value).map_err(|_| "A key must be text.".to_string())?;
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut m = self.load();
        m.insert(name.to_string(), text.to_string());
        self.save(&m)
    }

    fn delete(&self, account: &str) -> Result<(), String> {
        let name = self.name(account)?;
        let _g = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut m = self.load();
        // Nothing to remove: leave the file (or its absence) as it is.
        if m.remove(name).is_none() {
            return Ok(());
        }
        self.save(&m)
    }

    fn max_blob(&self) -> usize {
        usize::MAX
    }

    fn kind(&self) -> StoreKind {
        StoreKind::File
    }
}

// ─── Long values in parts (OS store only) ───

/// Where the parts of a long value are kept (see the top of this file).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Slot {
    A,
    B,
    /// `part<i>:<account>`, from early 2.0 builds: read and cleared, never written.
    Legacy,
}

const SLOTS: [Slot; 3] = [Slot::A, Slot::B, Slot::Legacy];

impl Slot {
    fn tag(self) -> &'static str {
        match self {
            Slot::A => "a",
            Slot::B => "b",
            Slot::Legacy => "",
        }
    }

    /// The slot the next save of a value kept in this one writes to.
    fn next(self) -> Slot {
        match self {
            Slot::A => Slot::B,
            Slot::B | Slot::Legacy => Slot::A,
        }
    }
}

fn part_account(account: &str, slot: Slot, i: usize) -> String {
    format!("part{}{}:{}", i, slot.tag(), account)
}

/// A parsed header: the value is in `n` parts in `slot`, `len` bytes in all
/// (no length in the legacy header).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct Head {
    n: usize,
    slot: Slot,
    len: Option<usize>,
}

fn header(n: usize, slot: Slot, len: usize) -> String {
    format!("{}{} {} {}\n", CHUNK_MAGIC, n, slot.tag(), len)
}

/// The header when `head` is one: `GCS1 N S LEN\n`, or the legacy `GCS1 N\n`.
fn parse_head(head: &[u8]) -> Option<Head> {
    let s = std::str::from_utf8(head).ok()?;
    let rest = s.strip_prefix(CHUNK_MAGIC)?.strip_suffix('\n')?;
    let number = |t: &str, max_digits: usize| -> Option<usize> {
        if t.is_empty() || t.len() > max_digits || !t.bytes().all(|b| b.is_ascii_digit()) {
            return None;
        }
        t.parse().ok()
    };
    let fields: Vec<&str> = rest.split(' ').collect();
    let (n, slot, len) = match fields.as_slice() {
        [n] => (number(n, 6)?, Slot::Legacy, None),
        [n, slot, len] => {
            let slot = match *slot {
                "a" => Slot::A,
                "b" => Slot::B,
                _ => return None,
            };
            (number(n, 6)?, slot, Some(number(len, 15)?))
        }
        _ => return None,
    };
    (n >= 1).then_some(Head { n, slot, len })
}

fn read_parts(b: &dyn SecretBackend, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
    let Some(head) = b.get(account)? else {
        return Ok(None);
    };
    let Some(h) = parse_head(&head) else {
        return Ok(Some(head));
    };
    let mut out = Zeroizing::new(Vec::new());
    for i in 1..=h.n {
        match b.get(&part_account(account, h.slot, i))? {
            Some(part) => out.extend_from_slice(&part),
            None => return Err(format!("part {} of {} is missing", i, h.n)),
        }
    }
    // Two copies of the app saving at once can mix their parts.
    if let Some(len) = h.len.filter(|len| *len != out.len()) {
        return Err(format!("the parts hold {} bytes, not {}", out.len(), len));
    }
    Ok(Some(out))
}

fn read_head(b: &dyn SecretBackend, account: &str) -> Result<Option<Head>, String> {
    Ok(b.get(account)?.and_then(|h| parse_head(&h)))
}

/// Delete parts `first..` of `account` in `slot`: `first..=known` are known
/// to be there, and any after them are found by reading until one is
/// missing. Last first, so a delete that fails leaves no gap, and a later
/// sweep still finds the rest. Best effort: failures go to the log.
fn clear_parts(b: &dyn SecretBackend, account: &str, slot: Slot, first: usize, known: usize) {
    let mut last = known.max(first - 1);
    while last < MAX_PARTS {
        match b.get(&part_account(account, slot, last + 1)) {
            Ok(Some(_)) => last += 1,
            Ok(None) => break,
            Err(e) => {
                log::warn!("Couldn't look for old parts of {}: {}", account, e);
                break;
            }
        }
    }
    for i in (first..=last).rev() {
        if let Err(e) = b.delete(&part_account(account, slot, i)) {
            log::warn!("Couldn't delete an old part of {}: {}", account, e);
            return;
        }
    }
}

fn write_parts(b: &dyn SecretBackend, account: &str, value: &[u8]) -> Result<(), String> {
    let old = read_head(b, account)?;
    let max = b.max_blob().max(MIN_PART);
    // A value that starts like a header is always split, so a head is never
    // mistaken for one.
    let new = if value.len() > max || value.starts_with(CHUNK_MAGIC.as_bytes()) {
        // The slot the saved value doesn't use: until the header is written,
        // the old value and its parts stay as they were.
        let slot = old.map_or(Slot::A, |h| h.slot.next());
        let parts: Vec<&[u8]> = value.chunks(max).collect();
        let mut written = 0;
        let mut result = Ok(());
        for part in &parts {
            result = b.set(&part_account(account, slot, written + 1), part);
            if result.is_err() {
                break;
            }
            written += 1;
        }
        if result.is_ok() {
            result = b.set(account, header(parts.len(), slot, value.len()).as_bytes());
        }
        if let Err(e) = result {
            clear_parts(b, account, slot, 1, written);
            return Err(e);
        }
        Some((slot, parts.len()))
    } else {
        b.set(account, value)?;
        None
    };
    // The old value's parts, and any a save that stopped earlier left.
    for slot in SLOTS {
        match (new, old) {
            (Some((s, n)), _) if s == slot => clear_parts(b, account, slot, n + 1, n),
            (_, Some(h)) if h.slot == slot => clear_parts(b, account, slot, 1, h.n),
            _ => clear_parts(b, account, slot, 1, 0),
        }
    }
    Ok(())
}

fn delete_parts(b: &dyn SecretBackend, account: &str) -> Result<(), String> {
    let old = read_head(b, account)?;
    b.delete(account)?;
    // Every slot, so parts left by a save that stopped go too, even when the
    // header is plain or gone.
    for slot in SLOTS {
        let known = old.filter(|h| h.slot == slot).map_or(0, |h| h.n);
        clear_parts(b, account, slot, 1, known);
    }
    Ok(())
}

// ─── The store ───

enum Mode {
    Os(Arc<dyn SecretBackend>),
    File(Vec<FileBackend>),
}

/// What `secret_store_status` reports.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StoreStatus {
    /// `keychain`, `credential-manager`, `secret-service`, `file` or `unavailable`.
    pub kind: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
    /// Old 1.9 key files that couldn't be read. They are left in place and
    /// may still hold keys.
    pub leftover_files: Vec<String>,
    /// Some keys in an old 1.9 file didn't move; the next start tries again.
    pub move_pending: bool,
}

/// The result of moving one old file into the OS store.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MoveOutcome {
    /// No file, or not in OS mode.
    Nothing,
    /// Every entry checked out and the file is gone.
    Moved(usize),
    /// The file can't be read; it is left alone.
    Corrupt,
    /// An entry didn't save or read back the same; the file is left alone and
    /// the next start tries again.
    Failed,
}

pub struct SecretStore {
    mode: Mode,
    /// Last known value per account (None: known to be absent).
    cache: Mutex<HashMap<String, Option<Zeroizing<String>>>>,
    /// Held across every backend call that changes or fills the cache, so a
    /// read never puts back a value a save just replaced.
    ops: Mutex<()>,
    /// `secret_store.json` (OS store only; None in some tests).
    marker: Option<PathBuf>,
    leftover: Mutex<Vec<PathBuf>>,
    move_pending: AtomicBool,
    #[cfg(test)]
    crash_before_delete: AtomicBool,
}

impl SecretStore {
    /// Open the store for `app_dir`: the system password store under
    /// `service`, or the 1.9 files when there is none (see the top of this file).
    pub fn open(app_dir: &Path, service: &str) -> Self {
        Self::open_with(app_dir, Arc::new(KeyringBackend::new(service)), PROBE_TIMEOUT)
    }

    pub(crate) fn open_with(app_dir: &Path, os: Arc<dyn SecretBackend>, timeout: Duration) -> Self {
        let marker = app_dir.join(MARKER_FILE);
        // Any marker, even one that can't be read, means keys may be in the
        // OS store: never go back to the files.
        if fs::symlink_metadata(&marker).is_ok() {
            return Self::with_mode(Mode::Os(os), Some(marker));
        }
        match probe_with_timeout(os.clone(), timeout) {
            Ok(()) => {
                let since = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map(|d| d.as_secs())
                    .unwrap_or(0);
                let body = serde_json::json!({ "store": "os", "since": since }).to_string();
                match private_fs::write_private_atomic(&marker, body.as_bytes()) {
                    Ok(()) => Self::with_mode(Mode::Os(os), Some(marker)),
                    Err(e) => {
                        log::warn!("Couldn't write {}: {}; keys stay in files this time", MARKER_FILE, e);
                        Self::files(app_dir)
                    }
                }
            }
            Err(e) => {
                log::warn!("No system password store ({}); keys stay in private files", e);
                Self::files(app_dir)
            }
        }
    }

    /// The 1.9 files.
    pub(crate) fn files(app_dir: &Path) -> Self {
        Self::with_mode(
            Mode::File(vec![
                FileBackend::new(app_dir.join(AI_KEYS_FILE), AI_KEY_PREFIX),
                FileBackend::new(app_dir.join(MCP_CREDS_FILE), MCP_CREDS_PREFIX),
            ]),
            None,
        )
    }

    fn with_mode(mode: Mode, marker: Option<PathBuf>) -> Self {
        Self {
            mode,
            cache: Mutex::new(HashMap::new()),
            ops: Mutex::new(()),
            marker,
            leftover: Mutex::new(Vec::new()),
            move_pending: AtomicBool::new(false),
            #[cfg(test)]
            crash_before_delete: AtomicBool::new(false),
        }
    }

    /// The OS store with no probe and no marker (tests).
    #[cfg(test)]
    pub(crate) fn os_for_tests(os: Arc<dyn SecretBackend>) -> Self {
        Self::with_mode(Mode::Os(os), None)
    }

    pub fn kind(&self) -> StoreKind {
        match &self.mode {
            Mode::Os(b) => b.kind(),
            Mode::File(_) => StoreKind::File,
        }
    }

    /// Where the keys are, for Settings. With the OS store this asks it once
    /// (a read of an account that doesn't exist), so a locked or missing
    /// store shows as unavailable.
    pub fn status(&self) -> StoreStatus {
        let leftover_files: Vec<String> = self
            .leftover
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .iter()
            .map(|p| p.display().to_string())
            .collect();
        let move_pending = self.move_pending.load(Ordering::Relaxed);
        if let Mode::Os(b) = &self.mode {
            if let Err(e) = b.get(PROBE_ACCOUNT) {
                log::warn!("System password store: {}", e);
                return StoreStatus {
                    kind: "unavailable".into(),
                    reason: Some(UNAVAILABLE.into()),
                    leftover_files,
                    move_pending,
                };
            }
        }
        StoreStatus {
            kind: serde_json::to_value(self.kind())
                .ok()
                .and_then(|v| v.as_str().map(str::to_string))
                .unwrap_or_default(),
            reason: None,
            leftover_files,
            move_pending,
        }
    }

    /// Change the marker (OS store only).
    fn update_marker(&self, f: impl FnOnce(&mut serde_json::Map<String, serde_json::Value>)) -> Result<(), String> {
        let Some(path) = &self.marker else {
            return Ok(());
        };
        let mut m = read_marker(path);
        f(&mut m);
        let body = serde_json::to_vec(&serde_json::Value::Object(m)).map_err(|e| e.to_string())?;
        private_fs::write_private_atomic(path, &body).map_err(|e| e.to_string())
    }

    /// While an old file waits to move, a key the user saves or removes is
    /// marked done, so the next try never puts the old value back.
    fn note_user_change(&self, account: &str) {
        if !matches!(self.mode, Mode::Os(_)) || !self.move_pending.load(Ordering::Relaxed) {
            return;
        }
        if let Err(e) = self.update_marker(|m| add_to_list(m, DONE, account)) {
            log::warn!("Couldn't note {} in {}: {}", account, MARKER_FILE, e);
        }
    }

    fn move_failed(&self) -> MoveOutcome {
        self.move_pending.store(true, Ordering::Relaxed);
        MoveOutcome::Failed
    }

    fn lock_ops(&self) -> std::sync::MutexGuard<'_, ()> {
        self.ops.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn cache(&self) -> std::sync::MutexGuard<'_, HashMap<String, Option<Zeroizing<String>>>> {
        self.cache.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// The backend error as the user sees it. OS store errors all read the
    /// same; the cause goes to the log.
    fn user_error(&self, account: &str, e: String) -> String {
        match self.mode {
            Mode::Os(_) => {
                log::warn!("System password store, {}: {}", account, e);
                UNAVAILABLE.to_string()
            }
            Mode::File(_) => e,
        }
    }

    fn read_backend(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
        match &self.mode {
            Mode::Os(b) => read_parts(b.as_ref(), account),
            Mode::File(files) => file_for(files, account)?.get(account),
        }
    }

    fn write_backend(&self, account: &str, value: &[u8]) -> Result<(), String> {
        match &self.mode {
            Mode::Os(b) => write_parts(b.as_ref(), account, value),
            Mode::File(files) => file_for(files, account)?.set(account, value),
        }
    }

    fn delete_backend(&self, account: &str) -> Result<(), String> {
        match &self.mode {
            Mode::Os(b) => delete_parts(b.as_ref(), account),
            Mode::File(files) => file_for(files, account)?.delete(account),
        }
    }

    /// The value saved for `account`, or None.
    pub fn get(&self, account: &str) -> Result<Option<Zeroizing<String>>, String> {
        if let Some(hit) = self.cache().get(account) {
            return Ok(hit.clone());
        }
        let _ops = self.lock_ops();
        if let Some(hit) = self.cache().get(account) {
            return Ok(hit.clone());
        }
        let bytes = self
            .read_backend(account)
            .map_err(|e| self.user_error(account, e))?;
        let value = match bytes {
            None => None,
            Some(b) => Some(Zeroizing::new(
                String::from_utf8(b.to_vec()).map_err(|_| "A saved key isn't text.".to_string())?,
            )),
        };
        self.cache().insert(account.to_string(), value.clone());
        Ok(value)
    }

    /// True when a non-empty value is saved. Answered from the cache after
    /// the first read.
    pub fn has(&self, account: &str) -> Result<bool, String> {
        Ok(self.get(account)?.is_some_and(|v| !v.is_empty()))
    }

    /// Save `value` for `account`; an empty value deletes it.
    pub fn set(&self, account: &str, value: &str) -> Result<(), String> {
        if value.is_empty() {
            return self.delete(account);
        }
        let _ops = self.lock_ops();
        match self.write_backend(account, value.as_bytes()) {
            Ok(()) => {
                self.cache()
                    .insert(account.to_string(), Some(Zeroizing::new(value.to_string())));
                self.note_user_change(account);
                Ok(())
            }
            Err(e) => {
                // Unknown now: read it again next time.
                self.cache().remove(account);
                Err(self.user_error(account, e))
            }
        }
    }

    pub fn delete(&self, account: &str) -> Result<(), String> {
        let _ops = self.lock_ops();
        match self.delete_backend(account) {
            Ok(()) => {
                self.cache().insert(account.to_string(), None);
                self.note_user_change(account);
                Ok(())
            }
            Err(e) => {
                self.cache().remove(account);
                Err(self.user_error(account, e))
            }
        }
    }

    /// Copy `from` to `to` and check the copy reads back the same, through a
    /// new read. Ok(false) when `from` has nothing saved; `to` is left as it
    /// is then. `from` always stays; a copy that doesn't check out is removed.
    pub fn copy(&self, from: &str, to: &str) -> Result<bool, String> {
        let Some(value) = self.get(from)? else {
            return Ok(false);
        };
        self.set(to, &value)?;
        let back = {
            let _ops = self.lock_ops();
            self.cache().remove(to);
            self.read_backend(to).map_err(|e| self.user_error(to, e))
        };
        let same = matches!(&back, Ok(Some(b)) if b.as_slice() == value.as_bytes());
        if !same {
            let _ = self.delete(to);
            back?;
            return Err("The saved copy didn't read back the same.".into());
        }
        Ok(true)
    }

    /// Move an old 1.9 file (`{name: value}`) into the OS store under
    /// `<prefix><name>`. Only with the OS store. The file is deleted only when
    /// every entry saved and read back byte for byte; a file that can't be
    /// read, or holds anything but strings, is left alone. A retry skips the
    /// accounts the marker has as done (see the top of this file).
    pub fn move_file(&self, path: &Path, prefix: &str) -> MoveOutcome {
        let Mode::Os(b) = &self.mode else {
            return MoveOutcome::Nothing;
        };
        let bytes = match fs::read(path) {
            Ok(bytes) => Zeroizing::new(bytes),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return MoveOutcome::Nothing,
            Err(e) => {
                log::warn!("Couldn't read {}: {}; left in place", path.display(), e);
                return self.move_failed();
            }
        };
        let map: HashMap<String, String> = match serde_json::from_slice(&bytes) {
            Ok(m) => m,
            Err(_) => {
                log::warn!("{} can't be read as keys; left in place", path.display());
                self.leftover
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(path.to_path_buf());
                return MoveOutcome::Corrupt;
            }
        };
        let map: HashMap<String, Zeroizing<String>> =
            map.into_iter().map(|(k, v)| (k, Zeroizing::new(v))).collect();
        let file = path
            .file_name()
            .map(|n| n.to_string_lossy().to_string())
            .unwrap_or_default();
        let _ops = self.lock_ops();
        let marker = self.marker.as_deref().map(read_marker).unwrap_or_default();
        let done: HashSet<String> = if list_of(&marker, MOVING).contains(&file) {
            list_of(&marker, DONE).into_iter().collect()
        } else {
            // A first try: note it before anything is written.
            if let Err(e) = self.update_marker(|m| {
                remove_from_list(m, DONE, |a| a.starts_with(prefix));
                add_to_list(m, MOVING, &file);
            }) {
                log::warn!("Couldn't write {}: {}; {} left in place", MARKER_FILE, e, path.display());
                return self.move_failed();
            }
            HashSet::new()
        };
        for (name, value) in &map {
            if value.is_empty() {
                continue;
            }
            let account = format!("{}{}", prefix, name);
            if done.contains(&account) {
                continue;
            }
            self.cache().remove(&account);
            let checked = match write_parts(b.as_ref(), &account, value.as_bytes()) {
                Err(e) => {
                    log::warn!("Moving {} into the system password store failed: {}", account, e);
                    false
                }
                Ok(()) => match read_parts(b.as_ref(), &account) {
                    Ok(Some(back)) if back.as_slice() == value.as_bytes() => true,
                    Ok(_) => {
                        log::warn!("{} didn't read back the same; {} left in place", account, path.display());
                        false
                    }
                    Err(e) => {
                        log::warn!("Reading back {} failed: {}", account, e);
                        false
                    }
                },
            };
            if !checked {
                // Leave no half-written value; the next start writes it again.
                if let Err(e) = delete_parts(b.as_ref(), &account) {
                    log::warn!("Couldn't clear {} after a failed move: {}", account, e);
                }
                return self.move_failed();
            }
            if let Err(e) = self.update_marker(|m| add_to_list(m, DONE, &account)) {
                log::warn!("Couldn't write {}: {}; {} left in place", MARKER_FILE, e, path.display());
                return self.move_failed();
            }
        }
        #[cfg(test)]
        if self.crash_before_delete.load(Ordering::Relaxed) {
            return self.move_failed();
        }
        if let Err(e) = fs::remove_file(path) {
            log::warn!("Couldn't delete {} after moving it: {}", path.display(), e);
            return self.move_failed();
        }
        let _ = fs::remove_file(private_fs::key_file_tmp(path));
        if let Err(e) = self.update_marker(|m| {
            remove_from_list(m, MOVING, |f| f == file);
            remove_from_list(m, DONE, |a| a.starts_with(prefix));
        }) {
            log::warn!("Couldn't write {}: {}", MARKER_FILE, e);
        }
        MoveOutcome::Moved(map.values().filter(|v| !v.is_empty()).count())
    }
}

/// The marker as an object; one that can't be read starts over (it still
/// means the OS store, since it exists).
fn read_marker(path: &Path) -> serde_json::Map<String, serde_json::Value> {
    match fs::read(path)
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
    {
        Some(serde_json::Value::Object(m)) => m,
        _ => {
            let mut m = serde_json::Map::new();
            m.insert("store".into(), "os".into());
            m
        }
    }
}

fn list_of(m: &serde_json::Map<String, serde_json::Value>, key: &str) -> Vec<String> {
    m.get(key)
        .and_then(|v| v.as_array())
        .map(|a| a.iter().filter_map(|v| v.as_str().map(str::to_string)).collect())
        .unwrap_or_default()
}

fn add_to_list(m: &mut serde_json::Map<String, serde_json::Value>, key: &str, item: &str) {
    let mut list = list_of(m, key);
    if !list.iter().any(|x| x == item) {
        list.push(item.to_string());
    }
    m.insert(key.into(), list.into());
}

fn remove_from_list(m: &mut serde_json::Map<String, serde_json::Value>, key: &str, drop: impl Fn(&str) -> bool) {
    let list: Vec<String> = list_of(m, key).into_iter().filter(|x| !drop(x)).collect();
    if list.is_empty() {
        m.remove(key);
    } else {
        m.insert(key.into(), list.into());
    }
}

fn file_for<'a>(files: &'a [FileBackend], account: &str) -> Result<&'a FileBackend, String> {
    files
        .iter()
        .find(|f| account.starts_with(f.prefix))
        .ok_or_else(|| format!("No key file for '{}'", account))
}

/// Save, read back through a new call, and delete a throwaway value.
fn probe(b: &dyn SecretBackend) -> Result<(), String> {
    let value = format!("probe-{:016x}", rand::random::<u64>());
    b.set(PROBE_ACCOUNT, value.as_bytes())?;
    let back = b.get(PROBE_ACCOUNT);
    let deleted = b.delete(PROBE_ACCOUNT);
    match back? {
        Some(v) if v.as_slice() == value.as_bytes() => {}
        _ => return Err("the probe didn't read back the same".into()),
    }
    deleted
}

/// The probe on its own thread, so a store that hangs (a locked Secret
/// Service waiting for a prompt) can't hold up the start for long.
fn probe_with_timeout(b: Arc<dyn SecretBackend>, timeout: Duration) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    std::thread::Builder::new()
        .name("secret-store-probe".into())
        .spawn(move || {
            let _ = tx.send(probe(b.as_ref()));
        })
        .map_err(|e| e.to_string())?;
    rx.recv_timeout(timeout)
        .unwrap_or_else(|_| Err("the probe took too long".into()))
}

/// Run a store call off the async runtime.
pub async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tokio::task::spawn_blocking(f)
        .await
        .map_err(|e| e.to_string())?
}

#[cfg(test)]
pub(crate) mod mem {
    use super::*;
    use std::sync::atomic::{AtomicU64, AtomicUsize};

    /// An in-memory store with switchable failures.
    pub struct MemBackend {
        pub data: Mutex<HashMap<String, Vec<u8>>>,
        pub fail_all: AtomicBool,
        pub fail_set: AtomicBool,
        /// Saves of this one account fail.
        pub fail_account: Mutex<Option<String>>,
        /// Reads give other bytes than were saved.
        pub wrong_read: AtomicBool,
        pub fail_probe: AtomicBool,
        pub max_blob: AtomicUsize,
        pub get_delay_ms: AtomicU64,
        pub gets: AtomicUsize,
    }

    impl MemBackend {
        pub fn new() -> Arc<Self> {
            Arc::new(Self {
                data: Mutex::new(HashMap::new()),
                fail_all: AtomicBool::new(false),
                fail_set: AtomicBool::new(false),
                fail_account: Mutex::new(None),
                wrong_read: AtomicBool::new(false),
                fail_probe: AtomicBool::new(false),
                max_blob: AtomicUsize::new(usize::MAX),
                get_delay_ms: AtomicU64::new(0),
                gets: AtomicUsize::new(0),
            })
        }

        fn check(&self, account: &str) -> Result<(), String> {
            if self.fail_all.load(Ordering::Relaxed) {
                return Err("store is locked".into());
            }
            if account == PROBE_ACCOUNT && self.fail_probe.load(Ordering::Relaxed) {
                return Err("probe refused".into());
            }
            Ok(())
        }

        pub fn raw(&self, account: &str) -> Option<Vec<u8>> {
            self.data.lock().unwrap().get(account).cloned()
        }

        pub fn accounts(&self) -> Vec<String> {
            let mut v: Vec<String> = self.data.lock().unwrap().keys().cloned().collect();
            v.sort();
            v
        }
    }

    impl SecretBackend for MemBackend {
        fn get(&self, account: &str) -> Result<Option<Zeroizing<Vec<u8>>>, String> {
            self.gets.fetch_add(1, Ordering::Relaxed);
            let delay = self.get_delay_ms.load(Ordering::Relaxed);
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
            self.check(account)?;
            let v = self.data.lock().unwrap().get(account).cloned();
            if self.wrong_read.load(Ordering::Relaxed) {
                return Ok(v.map(|mut b| {
                    b.push(b'!');
                    Zeroizing::new(b)
                }));
            }
            Ok(v.map(Zeroizing::new))
        }

        fn set(&self, account: &str, value: &[u8]) -> Result<(), String> {
            self.check(account)?;
            if self.fail_set.load(Ordering::Relaxed)
                || self.fail_account.lock().unwrap().as_deref() == Some(account)
            {
                return Err("set refused".into());
            }
            if value.len() > self.max_blob.load(Ordering::Relaxed) {
                return Err("too long".into());
            }
            self.data
                .lock()
                .unwrap()
                .insert(account.to_string(), value.to_vec());
            Ok(())
        }

        fn delete(&self, account: &str) -> Result<(), String> {
            self.check(account)?;
            self.data.lock().unwrap().remove(account);
            Ok(())
        }

        fn max_blob(&self) -> usize {
            self.max_blob.load(Ordering::Relaxed)
        }

        fn kind(&self) -> StoreKind {
            StoreKind::Keychain
        }
    }
}

#[cfg(test)]
mod tests {
    use super::mem::MemBackend;
    use super::*;

    /// Real 1.9 key shapes: an Anthropic key, and an alphanumeric key whose
    /// length is a multiple of 4 (valid base64, so any decoding would change it).
    const ANTHROPIC: &str =
        "sk-ant-api03-Zx9_q-W1abcDEF2ghiJKL3mnoPQR4stuVWX5yz-ABCdef6GHIjkl7MNOpqr8STU-vwxYZ01AA";
    const B64_LIKE: &str = "AbCd1234EfGh5678IjKl9012MnOp";

    fn temp_dir() -> PathBuf {
        let p = std::env::temp_dir().join(format!("greencli-secret-store-{}", rand::random::<u64>()));
        fs::create_dir_all(&p).unwrap();
        p
    }

    fn os_store(dir: &Path, mem: &Arc<MemBackend>) -> SecretStore {
        SecretStore::open_with(dir, mem.clone(), Duration::from_secs(3))
    }

    /// 1.9's own reader for both files (ai::AiKeyStore::load_locked and
    /// mcp::McpSecretStore::load in 1.9).
    fn read_like_19(path: &Path) -> HashMap<String, String> {
        fs::read(path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    #[test]
    fn b64_fixture_is_valid_base64() {
        assert_eq!(B64_LIKE.len() % 4, 0);
        assert!(B64_LIKE.chars().all(|c| c.is_ascii_alphanumeric()));
    }

    #[test]
    fn file_mode_reads_and_writes_the_19_files_unchanged() {
        let dir = temp_dir();
        let ai = format!(r#"{{"anthropic":"{}","moonshot":"{}"}}"#, ANTHROPIC, B64_LIKE);
        fs::write(dir.join(AI_KEYS_FILE), &ai).unwrap();
        let creds = "client_id: abc\nclient_secret: \"s3cr3t==\"\n";
        let mcp = serde_json::json!({ "central mcp": creds }).to_string();
        fs::write(dir.join(MCP_CREDS_FILE), &mcp).unwrap();

        let store = SecretStore::files(&dir);
        assert_eq!(store.kind(), StoreKind::File);
        assert_eq!(store.get("ai-key:anthropic").unwrap().unwrap().as_str(), ANTHROPIC);
        assert_eq!(store.get("ai-key:moonshot").unwrap().unwrap().as_str(), B64_LIKE);
        assert_eq!(store.get("mcp-creds:central mcp").unwrap().unwrap().as_str(), creds);

        store.set("ai-key:openrouter", B64_LIKE).unwrap();
        store.set("mcp-creds:other", "token: x").unwrap();
        let back = read_like_19(&dir.join(AI_KEYS_FILE));
        assert_eq!(back.get("anthropic").map(String::as_str), Some(ANTHROPIC));
        assert_eq!(back.get("openrouter").map(String::as_str), Some(B64_LIKE));
        assert_eq!(back.len(), 3);
        let back = read_like_19(&dir.join(MCP_CREDS_FILE));
        assert_eq!(back.get("central mcp").map(String::as_str), Some(creds));
        assert_eq!(back.get("other").map(String::as_str), Some("token: x"));

        store.set("ai-key:moonshot", "").unwrap();
        assert!(!read_like_19(&dir.join(AI_KEYS_FILE)).contains_key("moonshot"));
        assert!(!dir.join("ai_keys.json.tmp").exists());
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mode = fs::metadata(dir.join(AI_KEYS_FILE)).unwrap().permissions().mode() & 0o777;
            assert_eq!(mode, 0o600);
        }
    }

    #[test]
    fn file_mode_delete_of_a_missing_key_creates_no_file() {
        let dir = temp_dir();
        let store = SecretStore::files(&dir);
        store.delete("ai-key:anthropic").unwrap();
        assert!(!dir.join(AI_KEYS_FILE).exists());
        assert!(store.get("ai-key:anthropic").unwrap().is_none());
    }

    #[test]
    fn a_passing_probe_writes_the_marker_even_with_nothing_to_move() {
        let dir = temp_dir();
        let mem = MemBackend::new();
        let store = os_store(&dir, &mem);
        assert_eq!(store.kind(), StoreKind::Keychain);
        let marker: serde_json::Value =
            serde_json::from_slice(&fs::read(dir.join(MARKER_FILE)).unwrap()).unwrap();
        assert_eq!(marker["store"], "os");
        assert!(marker["since"].as_u64().is_some());
        // The probe cleaned up after itself.
        assert!(mem.accounts().is_empty());
    }

    #[test]
    fn a_failing_probe_uses_the_files_and_writes_no_marker() {
        let dir = temp_dir();
        let mem = MemBackend::new();
        mem.fail_probe.store(true, Ordering::Relaxed);
        let store = os_store(&dir, &mem);
        assert_eq!(store.kind(), StoreKind::File);
        assert!(!dir.join(MARKER_FILE).exists());
        assert_eq!(store.status().kind, "file");
    }

    #[test]
    fn a_probe_that_hangs_times_out_to_the_files() {
        let dir = temp_dir();
        let mem = MemBackend::new();
        mem.get_delay_ms.store(2_000, Ordering::Relaxed);
        let started = std::time::Instant::now();
        let store = SecretStore::open_with(&dir, mem.clone(), Duration::from_millis(200));
        assert!(started.elapsed() < Duration::from_millis(1_500));
        assert_eq!(store.kind(), StoreKind::File);
        assert!(!dir.join(MARKER_FILE).exists());
    }

    #[test]
    fn after_the_marker_a_failing_store_is_unavailable_never_the_files() {
        let dir = temp_dir();
        let mem = MemBackend::new();
        drop(os_store(&dir, &mem));
        assert!(dir.join(MARKER_FILE).exists());

        // Next start: the store fails (probe included).
        mem.fail_all.store(true, Ordering::Relaxed);
        let store = os_store(&dir, &mem);
        assert_eq!(store.kind(), StoreKind::Keychain);
        let status = store.status();
        assert_eq!(status.kind, "unavailable");
        assert_eq!(status.reason.as_deref(), Some(UNAVAILABLE));
        assert_eq!(store.set("ai-key:anthropic", ANTHROPIC).unwrap_err(), UNAVAILABLE);
        assert_eq!(store.get("ai-key:anthropic").unwrap_err(), UNAVAILABLE);
        assert!(!dir.join(AI_KEYS_FILE).exists());
        assert!(!dir.join(MCP_CREDS_FILE).exists());

        mem.fail_all.store(false, Ordering::Relaxed);
        assert_eq!(store.status().kind, "keychain");
    }

    #[test]
    fn a_marker_that_cant_be_read_still_means_the_os_store() {
        let dir = temp_dir();
        fs::write(dir.join(MARKER_FILE), b"{not json").unwrap();
        let mem = MemBackend::new();
        mem.fail_probe.store(true, Ordering::Relaxed);
        assert_eq!(os_store(&dir, &mem).kind(), StoreKind::Keychain);
    }

    #[test]
    fn moving_the_19_files_keeps_every_byte_and_deletes_them() {
        let dir = temp_dir();
        let ai_path = dir.join(AI_KEYS_FILE);
        let mcp_path = dir.join(MCP_CREDS_FILE);
        let ai = format!(
            r#"{{"anthropic":"{}","moonshot":"{}","someday-provider":"k"}}"#,
            ANTHROPIC, B64_LIKE
        );
        fs::write(&ai_path, &ai).unwrap();
        fs::write(dir.join("ai_keys.json.tmp"), &ai).unwrap();
        let creds = "a: 1\nb: \"two\"\n";
        fs::write(&mcp_path, serde_json::json!({ "central": creds }).to_string()).unwrap();

        let mem = MemBackend::new();
        let store = os_store(&dir, &mem);
        assert_eq!(store.move_file(&ai_path, AI_KEY_PREFIX), MoveOutcome::Moved(3));
        assert_eq!(store.move_file(&mcp_path, MCP_CREDS_PREFIX), MoveOutcome::Moved(1));

        assert_eq!(mem.raw("ai-key:anthropic").unwrap(), ANTHROPIC.as_bytes());
        assert_eq!(mem.raw("ai-key:moonshot").unwrap(), B64_LIKE.as_bytes());
        assert_eq!(mem.raw("ai-key:someday-provider").unwrap(), b"k");
        assert_eq!(mem.raw("mcp-creds:central").unwrap(), creds.as_bytes());
        assert_eq!(store.get("ai-key:anthropic").unwrap().unwrap().as_str(), ANTHROPIC);
        assert!(!ai_path.exists());
        assert!(!dir.join("ai_keys.json.tmp").exists());
        assert!(!mcp_path.exists());
        assert_eq!(store.move_file(&ai_path, AI_KEY_PREFIX), MoveOutcome::Nothing);
        let status = store.status();
        assert!(status.leftover_files.is_empty());
        assert!(!status.move_pending);
        // The marker forgets the move once it is done.
        let marker = read_marker(&dir.join(MARKER_FILE));
        assert!(marker.get(MOVING).is_none() && marker.get(DONE).is_none());
        assert_eq!(marker["store"], "os");
    }

    #[test]
    fn the_files_are_never_moved_without_the_os_store() {
        let dir = temp_dir();
        let path = dir.join(AI_KEYS_FILE);
        fs::write(&path, format!(r#"{{"anthropic":"{}"}}"#, ANTHROPIC)).unwrap();
        let store = SecretStore::files(&dir);
        assert_eq!(store.move_file(&path, AI_KEY_PREFIX), MoveOutcome::Nothing);
        assert!(path.exists());
    }

    fn assert_move_leaves_the_file(setup: impl Fn(&MemBackend, &SecretStore)) {
        let dir = temp_dir();
        let path = dir.join(AI_KEYS_FILE);
        let body = format!(r#"{{"anthropic":"{}","moonshot":"{}"}}"#, ANTHROPIC, B64_LIKE);
        fs::write(&path, &body).unwrap();
        let mem = MemBackend::new();
        let store = os_store(&dir, &mem);
        setup(&mem, &store);
        assert_eq!(store.move_file(&path, AI_KEY_PREFIX), MoveOutcome::Failed);
        assert_eq!(fs::read(&path).unwrap(), body.as_bytes());
        // Settings says some keys didn't move yet.
        assert!(store.status().move_pending);
        assert!(store.status().leftover_files.is_empty());
    }

    #[test]
    fn a_failed_save_leaves_the_file_byte_for_byte() {
        assert_move_leaves_the_file(|mem, _| mem.fail_set.store(true, Ordering::Relaxed));
    }

    #[test]
    fn a_wrong_read_back_leaves_the_file_byte_for_byte() {
        assert_move_leaves_the_file(|mem, _| mem.wrong_read.store(true, Ordering::Relaxed));
    }

    #[test]
    fn a_crash_just_before_the_delete_leaves_the_file_byte_for_byte() {
        assert_move_leaves_the_file(|_, store| {
            store.crash_before_delete.store(true, Ordering::Relaxed)
        });
    }

    #[test]
    fn a_corrupt_file_or_a_non_string_value_is_never_deleted() {
        for body in [&b"{\"anthropic\": \"sk-"[..], br#"{"anthropic": 42}"#, b"[\"x\"]"] {
            let dir = temp_dir();
            let path = dir.join(AI_KEYS_FILE);
            fs::write(&path, body).unwrap();
            let mem = MemBackend::new();
            let store = os_store(&dir, &mem);
            assert_eq!(store.move_file(&path, AI_KEY_PREFIX), MoveOutcome::Corrupt);
            assert_eq!(fs::read(&path).unwrap(), body);
            // Settings names the file, so the user can find and delete it.
            assert_eq!(store.status().leftover_files, vec![path.display().to_string()]);
            assert!(!store.status().move_pending);
            assert!(mem.accounts().is_empty());
        }
    }

    #[test]
    fn a_retry_never_puts_back_a_key_the_user_changed_or_removed() {
        let dir = temp_dir();
        let path = dir.join(AI_KEYS_FILE);
        let body = r#"{"anthropic":"A1","openai":"O1","moonshot":"M1","openrouter":"R1"}"#;
        fs::write(&path, body).unwrap();
        let mem = MemBackend::new();
        // First 2.0 start: the openai save fails, so the file stays.
        *mem.fail_account.lock().unwrap() = Some("ai-key:openai".into());
        let first = os_store(&dir, &mem);
        assert_eq!(first.move_file(&path, AI_KEY_PREFIX), MoveOutcome::Failed);
        assert_eq!(fs::read(&path).unwrap(), body.as_bytes());
        assert!(mem.raw("ai-key:openai").is_none(), "no half-moved value is left");
        assert!(first.status().move_pending);
        // The user enters openai again, changes anthropic and removes moonshot.
        *mem.fail_account.lock().unwrap() = None;
        first.set("ai-key:openai", "O2").unwrap();
        first.set("ai-key:anthropic", "A2").unwrap();
        first.delete("ai-key:moonshot").unwrap();
        drop(first);

        // Next start: the rest moves, and none of the user's changes is undone.
        let next = os_store(&dir, &mem);
        assert_eq!(next.move_file(&path, AI_KEY_PREFIX), MoveOutcome::Moved(4));
        assert!(!path.exists());
        assert_eq!(mem.raw("ai-key:anthropic").unwrap(), b"A2");
        assert_eq!(mem.raw("ai-key:openai").unwrap(), b"O2");
        assert!(mem.raw("ai-key:moonshot").is_none());
        assert_eq!(mem.raw("ai-key:openrouter").unwrap(), b"R1");
        assert!(!next.status().move_pending);
        let marker = read_marker(&dir.join(MARKER_FILE));
        assert!(marker.get(MOVING).is_none() && marker.get(DONE).is_none());
    }

    #[test]
    fn a_first_try_writes_over_an_older_value_in_the_store() {
        // 2.0, back to 1.9 (a key typed there), then 2.0 again: the file is newer.
        let dir = temp_dir();
        let mem = MemBackend::new();
        let store = os_store(&dir, &mem);
        store.set("ai-key:anthropic", "old").unwrap();
        let path = dir.join(AI_KEYS_FILE);
        fs::write(&path, r#"{"anthropic":"new"}"#).unwrap();
        assert_eq!(store.move_file(&path, AI_KEY_PREFIX), MoveOutcome::Moved(1));
        assert_eq!(mem.raw("ai-key:anthropic").unwrap(), b"new");
    }

    #[test]
    fn a_long_value_is_split_into_parts_and_shrinks_cleanly() {
        let mem = MemBackend::new();
        mem.max_blob.store(2560, Ordering::Relaxed);
        let store = SecretStore::os_for_tests(mem.clone());
        let long: String = (0..10_240).map(|i| (b'a' + (i % 26) as u8) as char).collect();
        store.set("mcp-creds:big", &long).unwrap();
        assert_eq!(mem.raw("mcp-creds:big").unwrap(), b"GCS1 4 a 10240\n");
        assert_eq!(mem.raw("part4a:mcp-creds:big").unwrap().len(), 10_240 - 3 * 2560);

        // A fresh store (no cache) reads the parts back.
        let fresh = SecretStore::os_for_tests(mem.clone());
        assert_eq!(fresh.get("mcp-creds:big").unwrap().unwrap().as_str(), long);

        // The next save goes to the other slot, and the old slot's parts go.
        let medium = &long[..3_000];
        fresh.set("mcp-creds:big", medium).unwrap();
        assert_eq!(mem.raw("mcp-creds:big").unwrap(), b"GCS1 2 b 3000\n");
        assert_eq!(
            mem.accounts(),
            vec!["mcp-creds:big", "part1b:mcp-creds:big", "part2b:mcp-creds:big"]
        );
        fresh.set("mcp-creds:big", "short").unwrap();
        assert_eq!(mem.accounts(), vec!["mcp-creds:big".to_string()]);
        let again = SecretStore::os_for_tests(mem.clone());
        assert_eq!(again.get("mcp-creds:big").unwrap().unwrap().as_str(), "short");

        fresh.set("mcp-creds:big", &long).unwrap();
        fresh.delete("mcp-creds:big").unwrap();
        assert!(mem.accounts().is_empty());
    }

    #[test]
    fn a_value_that_looks_like_a_header_is_kept_as_is() {
        let mem = MemBackend::new();
        let store = SecretStore::os_for_tests(mem.clone());
        store.set("ai-key:odd", "GCS1 2\n").unwrap();
        let fresh = SecretStore::os_for_tests(mem.clone());
        assert_eq!(fresh.get("ai-key:odd").unwrap().unwrap().as_str(), "GCS1 2\n");
    }

    #[test]
    fn a_missing_head_reads_as_absent_and_a_missing_part_is_an_error() {
        let mem = MemBackend::new();
        mem.max_blob.store(100, Ordering::Relaxed);
        mem.data
            .lock()
            .unwrap()
            .insert("part1:ai-key:orphan".into(), b"left over".to_vec());
        let store = SecretStore::os_for_tests(mem.clone());
        assert!(store.get("ai-key:orphan").unwrap().is_none());

        store.set("ai-key:long", &"x".repeat(250)).unwrap();
        mem.data.lock().unwrap().remove("part2a:ai-key:long");
        let fresh = SecretStore::os_for_tests(mem.clone());
        assert_eq!(fresh.get("ai-key:long").unwrap_err(), UNAVAILABLE);
    }

    /// `n` bytes that differ for each `seed`.
    fn long_value(n: usize, seed: u8) -> String {
        (0..n).map(|i| (b'a' + ((i + seed as usize) % 26) as u8) as char).collect()
    }

    fn put(mem: &MemBackend, account: &str, value: &[u8]) {
        mem.data.lock().unwrap().insert(account.into(), value.to_vec());
    }

    #[test]
    fn a_save_that_stops_partway_keeps_the_old_value_whole() {
        let mem = MemBackend::new();
        mem.max_blob.store(2560, Ordering::Relaxed);
        let store = SecretStore::os_for_tests(mem.clone());
        let old = long_value(6_000, 0);
        let new = long_value(6_000, 7);
        store.set("mcp-creds:x", &old).unwrap();
        let saved = vec![
            "mcp-creds:x".to_string(),
            "part1a:mcp-creds:x".into(),
            "part2a:mcp-creds:x".into(),
            "part3a:mcp-creds:x".into(),
        ];
        assert_eq!(mem.accounts(), saved);

        // A part of the new value, then the header, fails to save.
        for failing in ["part2b:mcp-creds:x", "mcp-creds:x"] {
            *mem.fail_account.lock().unwrap() = Some(failing.into());
            assert_eq!(store.set("mcp-creds:x", &new).unwrap_err(), UNAVAILABLE);
            let fresh = SecretStore::os_for_tests(mem.clone());
            assert_eq!(fresh.get("mcp-creds:x").unwrap().unwrap().as_str(), old, "{}", failing);
            assert_eq!(store.get("mcp-creds:x").unwrap().unwrap().as_str(), old);
            // No part of the new value is left behind.
            assert_eq!(mem.accounts(), saved, "{}", failing);
        }

        // Saving again works and switches to the other slot.
        *mem.fail_account.lock().unwrap() = None;
        store.set("mcp-creds:x", &new).unwrap();
        assert_eq!(
            mem.accounts(),
            vec!["mcp-creds:x", "part1b:mcp-creds:x", "part2b:mcp-creds:x", "part3b:mcp-creds:x"]
        );
        let fresh = SecretStore::os_for_tests(mem.clone());
        assert_eq!(fresh.get("mcp-creds:x").unwrap().unwrap().as_str(), new);
    }

    #[test]
    fn a_plain_value_stays_when_a_long_save_fails_at_the_header() {
        let mem = MemBackend::new();
        mem.max_blob.store(2560, Ordering::Relaxed);
        let store = SecretStore::os_for_tests(mem.clone());
        store.set("mcp-creds:edge", "short login").unwrap();
        *mem.fail_account.lock().unwrap() = Some("mcp-creds:edge".into());
        assert!(store.set("mcp-creds:edge", &long_value(6_000, 3)).is_err());
        // No part holding the new login is left over.
        assert_eq!(mem.accounts(), vec!["mcp-creds:edge".to_string()]);
        assert_eq!(mem.raw("mcp-creds:edge").unwrap(), b"short login");
    }

    #[test]
    fn delete_and_save_clear_parts_left_in_any_slot() {
        let leftovers = [
            "part1a:mcp-creds:x",
            "part2a:mcp-creds:x",
            "part1b:mcp-creds:x",
            "part1:mcp-creds:x",
            "part2:mcp-creds:x",
        ];
        // Removing the login, with a plain header or none at all.
        for head in [Some(&b"plain login"[..]), None] {
            let mem = MemBackend::new();
            for a in leftovers {
                put(&mem, a, b"left over");
            }
            if let Some(head) = head {
                put(&mem, "mcp-creds:x", head);
            }
            let store = SecretStore::os_for_tests(mem.clone());
            store.delete("mcp-creds:x").unwrap();
            assert!(mem.accounts().is_empty(), "{:?}", mem.accounts());
        }

        // A save that works sweeps them too, in the slot it uses as well.
        let mem = MemBackend::new();
        mem.max_blob.store(2560, Ordering::Relaxed);
        for a in leftovers.iter().chain(&["part4a:mcp-creds:x", "part3a:mcp-creds:x"]) {
            put(&mem, a, b"left over");
        }
        let store = SecretStore::os_for_tests(mem.clone());
        store.set("mcp-creds:x", "plain").unwrap();
        assert_eq!(mem.accounts(), vec!["mcp-creds:x".to_string()]);
        for a in leftovers {
            put(&mem, a, b"left over");
        }
        put(&mem, "part3a:mcp-creds:x", b"left over");
        let value = long_value(3_000, 1);
        store.set("mcp-creds:x", &value).unwrap();
        assert_eq!(
            mem.accounts(),
            vec!["mcp-creds:x", "part1a:mcp-creds:x", "part2a:mcp-creds:x"]
        );
        let fresh = SecretStore::os_for_tests(mem.clone());
        assert_eq!(fresh.get("mcp-creds:x").unwrap().unwrap().as_str(), value);
    }

    #[test]
    fn a_copy_that_fails_partway_leaves_nothing_under_the_new_name() {
        let mem = MemBackend::new();
        mem.max_blob.store(2560, Ordering::Relaxed);
        let store = SecretStore::os_for_tests(mem.clone());
        let value = long_value(6_000, 5);
        store.set("mcp-creds:from", &value).unwrap();
        let before = mem.accounts();
        *mem.fail_account.lock().unwrap() = Some("part2a:mcp-creds:to".into());
        assert!(store.copy("mcp-creds:from", "mcp-creds:to").is_err());
        assert_eq!(mem.accounts(), before);
        assert_eq!(store.get("mcp-creds:from").unwrap().unwrap().as_str(), value);
    }

    #[test]
    fn a_value_saved_by_an_early_20_build_still_reads_and_moves_to_a_slot() {
        let mem = MemBackend::new();
        mem.max_blob.store(100, Ordering::Relaxed);
        let value = long_value(250, 2);
        put(&mem, "ai-key:long", b"GCS1 3\n");
        put(&mem, "part1:ai-key:long", &value.as_bytes()[..100]);
        put(&mem, "part2:ai-key:long", &value.as_bytes()[100..200]);
        put(&mem, "part3:ai-key:long", &value.as_bytes()[200..]);
        let store = SecretStore::os_for_tests(mem.clone());
        assert_eq!(store.get("ai-key:long").unwrap().unwrap().as_str(), value);

        let next = long_value(150, 9);
        store.set("ai-key:long", &next).unwrap();
        assert_eq!(
            mem.accounts(),
            vec!["ai-key:long", "part1a:ai-key:long", "part2a:ai-key:long"]
        );
        let fresh = SecretStore::os_for_tests(mem.clone());
        assert_eq!(fresh.get("ai-key:long").unwrap().unwrap().as_str(), next);
    }

    #[test]
    fn parts_that_dont_add_up_to_the_saved_length_are_an_error() {
        let mem = MemBackend::new();
        mem.max_blob.store(100, Ordering::Relaxed);
        let store = SecretStore::os_for_tests(mem.clone());
        store.set("ai-key:long", &long_value(250, 4)).unwrap();
        // Another copy of the app wrote a shorter part 3 into the same slot.
        put(&mem, "part3a:ai-key:long", b"short");
        let fresh = SecretStore::os_for_tests(mem.clone());
        assert_eq!(fresh.get("ai-key:long").unwrap_err(), UNAVAILABLE);
    }

    #[test]
    fn windows_target_names_never_match_when_case_is_ignored() {
        const SERVICE: &str = "com.choatelabs.greencli";
        // Credential Manager compares target names without regard to case.
        let same_item = |a: &str, b: &str| {
            windows_target(SERVICE, a).to_lowercase() == windows_target(SERVICE, b).to_lowercase()
        };
        for (a, b) in [
            ("mcp-creds:Central", "mcp-creds:central"),
            ("part1a:mcp-creds:Central", "part1a:mcp-creds:central"),
            ("mcp-creds:\u{c9}", "mcp-creds:\u{e9}"),
            ("mcp-creds:%41", "mcp-creds:A"),
            ("mcp-creds:%41", "mcp-creds:a"),
            ("mcp-creds:\u{212a}", "mcp-creds:k"),
        ] {
            assert!(!same_item(a, b), "{} and {} share one item", a, b);
        }
        for account in ["mcp-creds:Central", "mcp-creds:\u{c9}t\u{e9} 2", "ai-key:A%B"] {
            let t = windows_target(SERVICE, account);
            assert!(t.is_ascii() && !t.bytes().any(|b| b.is_ascii_uppercase()), "{}", t);
        }
        // Lower-case names stay readable in Credential Manager.
        assert_eq!(windows_target(SERVICE, "ai-key:anthropic"), "ai-key:anthropic.com.choatelabs.greencli");
        assert_eq!(win_target("mcp-creds:my server_2.x"), "mcp-creds:my server_2.x");
        assert_eq!(win_target("mcp-creds:Central"), "mcp-creds:%43entral");
        assert_eq!(win_target("100%"), "100%25");
    }

    #[test]
    fn headers_parse_strictly() {
        let h = |s: &str| parse_head(s.as_bytes());
        assert_eq!(h("GCS1 3\n"), Some(Head { n: 3, slot: Slot::Legacy, len: None }));
        assert_eq!(h("GCS1 2 b 300\n"), Some(Head { n: 2, slot: Slot::B, len: Some(300) }));
        for bad in ["GCS1 0\n", "GCS1 3", "GCS1 3 c 9\n", "GCS1 3 a\n", "GCS1 x a 9\n", "GCS1 3 a 9 \n", "GCS1 1234567\n"] {
            assert_eq!(h(bad), None, "{:?}", bad);
        }
    }

    #[test]
    fn has_is_answered_from_the_cache() {
        let mem = MemBackend::new();
        let store = SecretStore::os_for_tests(mem.clone());
        store.set("ai-key:anthropic", ANTHROPIC).unwrap();
        let before = mem.gets.load(Ordering::Relaxed);
        for _ in 0..5 {
            assert!(store.has("ai-key:anthropic").unwrap());
            assert!(!store.has("ai-key:moonshot").unwrap());
        }
        // One read for the key never saved; none for the saved one.
        assert_eq!(mem.gets.load(Ordering::Relaxed) - before, 1);
    }

    #[test]
    fn copy_checks_the_copy_and_keeps_the_original() {
        let mem = MemBackend::new();
        let store = SecretStore::os_for_tests(mem.clone());
        store.set("mcp-creds:a", "content").unwrap();
        assert!(store.copy("mcp-creds:a", "mcp-creds:b").unwrap());
        assert_eq!(mem.raw("mcp-creds:b").unwrap(), b"content");
        assert_eq!(mem.raw("mcp-creds:a").unwrap(), b"content");
        // Nothing to copy: the target is left alone.
        assert!(!store.copy("mcp-creds:none", "mcp-creds:b").unwrap());
        assert_eq!(mem.raw("mcp-creds:b").unwrap(), b"content");
        // A copy that reads back wrong is an error and is removed.
        mem.wrong_read.store(true, Ordering::Relaxed);
        assert!(store.copy("mcp-creds:a", "mcp-creds:c").is_err());
        assert!(mem.raw("mcp-creds:c").is_none());
        assert_eq!(mem.raw("mcp-creds:a").unwrap(), b"content");
    }

    /// For the owner, against the real store:
    /// `cargo test -- --ignored keyring_smoke`.
    #[test]
    #[ignore]
    fn keyring_smoke() {
        let os: Arc<dyn SecretBackend> = Arc::new(KeyringBackend::new("com.choatelabs.greencli.test"));
        probe(os.as_ref()).expect("probe");
        let store = SecretStore::os_for_tests(os.clone());
        let long = "k".repeat(10_000);
        store.set("ai-key:smoke", &long).unwrap();
        let fresh = SecretStore::os_for_tests(os);
        assert_eq!(fresh.get("ai-key:smoke").unwrap().unwrap().as_str(), long);
        fresh.delete("ai-key:smoke").unwrap();
        assert!(SecretStore::os_for_tests(Arc::new(KeyringBackend::new("com.choatelabs.greencli.test")))
            .get("ai-key:smoke")
            .unwrap()
            .is_none());
    }
}
