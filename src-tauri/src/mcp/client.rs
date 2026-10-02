// MCP client — connects OUT to external MCP servers so the in-app AI
// assistant can use their tools (e.g. the user's `centralmcp` Aruba
// Central/GLP server, or a future Juniper/Mist one).
//
// Two transports:
//   - Stdio (default): newline-delimited JSON-RPC 2.0 over a spawned child
//     process's stdin/stdout, per the MCP stdio spec. A background reader
//     task correlates responses to pending requests by id.
//   - Streamable HTTP: JSON-RPC 2.0 POSTed to a single endpoint the server
//     already has running (e.g. centralmcp's `run_http_router.sh`), letting
//     one server process serve multiple clients/machines instead of being
//     spawned per app launch. Each POST's own response (JSON body, or an SSE
//     stream terminating in the matching response) IS that request's answer,
//     so no cross-request correlation is needed the way stdio needs it. An
//     optional standalone GET SSE stream carries server-initiated messages
//     (ping, notifications/tools/list_changed) outside any specific request —
//     mirrors the stdio reader task, but many servers don't implement it
//     (it's optional per spec), so its absence is tolerated, not an error.

use super::access::{self, AccessCheck, AccessState};
use super::cancel::{self, CallRegistry, Cancelled};
use super::env;
use super::labels::SafetyLabel;
use super::policy::{self, ServerPolicy};
use super::presets::{
    apply_pins, call_timeout_secs, match_preset, plan_pins, preset_label, PinPlan, PinView,
    PresetId,
};
use crate::error::AppError;
use crate::secret_store::{self, SecretStore, MCP_CREDS_PREFIX};
use futures::StreamExt;
use serde::{Deserialize, Deserializer, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::future::Future;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, AtomicU32, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWrite, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, ChildStdout, Command};
use tokio::sync::{mpsc, oneshot, Mutex};
use zeroize::Zeroizing;

fn default_true() -> bool {
    true
}

/// Only a JSON `true` is true. A hand-edited "yes" or 1 loads as false instead
/// of making the whole server list fail to parse.
fn lenient_bool<'de, D: Deserializer<'de>>(d: D) -> Result<bool, D::Error> {
    Ok(matches!(Value::deserialize(d)?, Value::Bool(true)))
}

/// Whether the AI may use a server's tools that change things. Off unless the
/// user turned it on in Settings → MCP Servers.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpWrites {
    Off,
    On,
}

/// "on" and "off" load as such; anything else (a hand edit, a future value)
/// loads as None, which counts as off, instead of making the whole server
/// list fail to parse.
fn lenient_writes<'de, D: Deserializer<'de>>(d: D) -> Result<Option<McpWrites>, D::Error> {
    Ok(match Value::deserialize(d)? {
        Value::String(s) if s == "on" => Some(McpWrites::On),
        Value::String(s) if s == "off" => Some(McpWrites::Off),
        _ => None,
    })
}

/// The MCP protocol version GreenCLI asks for.
pub const MCP_PROTOCOL_VERSION: &str = "2025-06-18";
/// Versions GreenCLI knows. Another one still works; it is only logged.
const KNOWN_PROTOCOL_VERSIONS: [&str; 3] = ["2024-11-05", "2025-03-26", MCP_PROTOCOL_VERSION];

/// Stop pressed while the call was with the server.
pub const MCP_STOPPED_IN_FLIGHT: &str =
    "Stopped. GreenCLI asked the server to cancel the call, but it may have finished already.";
/// Stop pressed before the call went out.
pub const MCP_STOPPED_NOT_SENT: &str = "Stopped. The call was not sent.";

/// The `initialize` request params — shared by the stdio/HTTP handshakes and
/// the HTTP session-expiry re-initialize path, so the advertised protocol
/// version and client identity live in exactly one place.
fn initialize_params() -> Value {
    json!({
        "protocolVersion": MCP_PROTOCOL_VERSION,
        "capabilities": {},
        "clientInfo": { "name": "greencli", "version": env!("CARGO_PKG_VERSION") }
    })
}

/// The protocol version to send after `initialize`: the server's own answer,
/// so GreenCLI only ever sends a version the server named. A server that
/// names none gets 2024-11-05 (what GreenCLI always assumed).
pub(crate) fn negotiated_version(init: &Value) -> String {
    match init.get("protocolVersion").and_then(|v| v.as_str()) {
        Some(v) if !v.is_empty() => {
            if !KNOWN_PROTOCOL_VERSIONS.contains(&v) {
                log::warn!(
                    "MCP: the server answered with protocol version '{}', which GreenCLI doesn't know",
                    v
                );
            }
            v.to_string()
        }
        _ => "2024-11-05".to_string(),
    }
}

/// How to reach an MCP server: spawn it (stdio) or connect to one already
/// running (Streamable HTTP).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum McpTransport {
    #[default]
    Stdio,
    Http,
}

/// A persisted MCP server definition (how to launch/reach it).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDef {
    pub name: String,
    #[serde(default)]
    pub transport: McpTransport,
    /// Stdio transport: the launch command.
    #[serde(default)]
    pub command: String,
    /// Stdio transport: launch args.
    #[serde(default)]
    pub args: Vec<String>,
    /// Stdio transport: launch env vars.
    #[serde(default)]
    pub env: HashMap<String, String>,
    /// Stdio transport: launch working dir.
    #[serde(default)]
    pub cwd: Option<String>,
    /// Http transport: the server's Streamable HTTP endpoint, e.g.
    /// `http://127.0.0.1:8010/mcp`.
    #[serde(default)]
    pub url: Option<String>,
    /// Stdio only: name of the env var the server reads for its credentials
    /// FILE path (default `CREDS_PATH`). The app writes the managed
    /// credentials content to a file and points this var at it on connect —
    /// meaningless for Http, where the app doesn't launch the process.
    #[serde(default)]
    pub credentials_env_var: Option<String>,
    /// Http transport only: extra HTTP headers sent on EVERY request to the
    /// server, e.g. `{ "Authorization": "Bearer <token>" }` for a protected
    /// MCP endpoint. Applied as reqwest client defaults at connect, so the
    /// initialize POST, per-request POSTs, notifications, and the SSE listener
    /// GET all carry them.
    #[serde(default)]
    pub headers: HashMap<String, String>,
    #[serde(default = "default_true")]
    pub enabled: bool,
    /// None: saved before 1.9, or an unreadable value. Counts as off; the UI
    /// shows the upgrade note until it is set. Only `mcp_set_writes` changes
    /// it; a save from the form keeps it or turns it off (see `upsert`).
    #[serde(
        default,
        deserialize_with = "lenient_writes",
        skip_serializing_if = "Option::is_none"
    )]
    pub writes: Option<McpWrites>,
    /// Junos only: plain `show` commands run without asking. A non-bool value
    /// loads as false. Only `mcp_set_show_opt_in` turns it on; a save from the
    /// form keeps the stored value (see `McpConfigStore::upsert`).
    #[serde(
        default,
        deserialize_with = "lenient_bool",
        skip_serializing_if = "std::ops::Not::not"
    )]
    pub show_opt_in: bool,
}

impl McpServerDef {
    pub fn writes_on(&self) -> bool {
        self.writes == Some(McpWrites::On)
    }
}

/// Same program: the same transport, and the same command, args and folder
/// (stdio) or URL (http). Only the chosen transport's fields count: the form
/// saves only those, so a field left over from the other transport in an
/// older save must not turn writes off. Env and headers are left out, so a
/// rotated token keeps the server's settings.
fn same_program(a: &McpServerDef, b: &McpServerDef) -> bool {
    fn trimmed(v: &Option<String>) -> &str {
        v.as_deref().map(str::trim).unwrap_or("")
    }
    a.transport == b.transport
        && match a.transport {
            McpTransport::Stdio => {
                a.command.trim() == b.command.trim()
                    && a.args == b.args
                    && trimmed(&a.cwd) == trimmed(&b.cwd)
            }
            McpTransport::Http => trimmed(&a.url) == trimmed(&b.url),
        }
}

/// A discovered tool exposed by a connected MCP server.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    /// Always a JSON object with "type":"object" (forced by tool_from_json).
    pub input_schema: Value,
    /// The server's raw annotations object (readOnlyHint, destructiveHint, ...).
    /// Kept only when it is a JSON object.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub annotations: Option<Value>,
    /// The server's raw _meta object. Kept only when it is a JSON object.
    #[serde(rename = "_meta", default, skip_serializing_if = "Option::is_none")]
    pub meta: Option<Value>,
    /// Preset id when the server matches one. Filled by the manager at listing
    /// time, never by the server.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub preset: Option<PresetId>,
    /// The server's Junos plain-show opt-in, copied from its definition at
    /// listing time.
    #[serde(default, skip_serializing_if = "std::ops::Not::not")]
    pub show_opt_in: bool,
    /// The effective writes setting. Always Some after policy::decorate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub writes: Option<McpWrites>,
    /// The login access from access_check. Always Some after policy::decorate.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub access: Option<AccessState>,
    /// GreenCLI's own label: labels::tool_label raised by the preset.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<SafetyLabel>,
    /// Why GreenCLI refuses this tool right now. Plain text, no "Not run:".
    /// mcp_all_tools never returns a blocked tool; mcp_tool_info does.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub blocked: Option<String>,
}

/// One entry of tools/list -> McpToolInfo. None when `name` is missing, not a
/// string, or empty.
pub(crate) fn tool_from_json(server: &str, t: &Value) -> Option<McpToolInfo> {
    let name = t
        .get("name")
        .and_then(|n| n.as_str())
        .filter(|n| !n.is_empty())?;
    let mut input_schema = match t.get("inputSchema") {
        Some(Value::Object(o)) => Value::Object(o.clone()),
        _ => json!({}),
    };
    // Providers reject a tool whose schema isn't an object schema.
    input_schema["type"] = json!("object");
    let object = |key: &str| t.get(key).filter(|v| v.is_object()).cloned();
    Some(McpToolInfo {
        server: server.to_string(),
        name: name.to_string(),
        description: t
            .get("description")
            .and_then(|d| d.as_str())
            .unwrap_or("")
            .to_string(),
        input_schema,
        annotations: object("annotations"),
        meta: object("_meta"),
        preset: None,
        show_opt_in: false,
        writes: None,
        access: None,
        label: None,
        blocked: None,
    })
}

/// Drops EVERY copy of a tool name the server lists more than once. Copies can
/// disagree (one says read-only, one doesn't) and GreenCLI can't tell which one
/// the server will really run, so it offers neither.
pub(crate) fn dedupe_tools(server: &str, tools: Vec<McpToolInfo>) -> Vec<McpToolInfo> {
    let mut counts: HashMap<String, usize> = HashMap::new();
    for t in &tools {
        *counts.entry(t.name.clone()).or_default() += 1;
    }
    let mut dupes: Vec<&String> = counts
        .iter()
        .filter(|(_, n)| **n > 1)
        .map(|(name, _)| name)
        .collect();
    dupes.sort();
    for name in dupes {
        log::warn!(
            "MCP '{}': tool '{}' is listed twice; GreenCLI hides it.",
            server,
            name
        );
    }
    tools
        .into_iter()
        .filter(|t| counts.get(&t.name) == Some(&1))
        .collect()
}

// ─── On-disk config store ───

pub struct McpConfigStore {
    path: PathBuf,
}

impl McpConfigStore {
    pub fn new(app_dir: PathBuf) -> Self {
        Self {
            path: app_dir.join("mcp_servers.json"),
        }
    }

    /// Lenient, for read-only callers: any read or parse error gives an empty
    /// list. Never use this before a save (see `load_checked`).
    pub fn load(&self) -> Vec<McpServerDef> {
        fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    /// For callers that save afterwards: a missing file is an empty list, but
    /// a file GreenCLI can't read or parse is an error, so a save never wipes
    /// the servers it couldn't read.
    pub fn load_checked(&self) -> Result<Vec<McpServerDef>, AppError> {
        const UNREADABLE: &str = "GreenCLI couldn't read mcp_servers.json, so it didn't change it. \
                                  Fix or remove the file, then try again.";
        let bytes = match fs::read(&self.path) {
            Ok(b) => b,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                log::warn!("MCP: reading {}: {}", self.path.display(), e);
                return Err(AppError::ConfigError(UNREADABLE.into()));
            }
        };
        serde_json::from_slice(&bytes).map_err(|e| {
            log::warn!("MCP: parsing {}: {}", self.path.display(), e);
            AppError::ConfigError(UNREADABLE.into())
        })
    }

    fn save(&self, defs: &[McpServerDef]) -> Result<(), AppError> {
        // Atomic write: serialize to a sibling temp file then rename over the
        // target (rename is atomic on the same filesystem), so a crash mid-write
        // can't truncate the server list and a concurrent reader never sees a
        // torn file (mirrors intent::IntentStore::save_locked).
        // Owner-only: env vars and headers can hold literal tokens.
        let bytes = serde_json::to_vec_pretty(defs)?;
        crate::private_fs::write_private_atomic(&self.path, &bytes)
    }

    /// Save a definition from the form. The form can't change the safety
    /// settings: an existing server keeps its writes setting and Junos opt-in
    /// only while it runs the same program (otherwise writes go off and the
    /// opt-in is cleared), and a new server starts with both off.
    pub fn upsert(&self, mut def: McpServerDef) -> Result<(), AppError> {
        let mut all = self.load_checked()?;
        if let Some(existing) = all.iter_mut().find(|d| d.name == def.name) {
            let same = same_program(existing, &def);
            def.show_opt_in = same && existing.show_opt_in;
            def.writes = if same {
                existing.writes
            } else {
                Some(McpWrites::Off)
            };
            *existing = def;
        } else {
            def.show_opt_in = false;
            def.writes = Some(McpWrites::Off);
            all.push(def);
        }
        self.save(&all)
    }

    /// Change one saved server in place and save. Returns the updated definition.
    pub fn update(
        &self,
        name: &str,
        f: impl FnOnce(&mut McpServerDef),
    ) -> Result<McpServerDef, AppError> {
        let mut all = self.load_checked()?;
        let def = all
            .iter_mut()
            .find(|d| d.name == name)
            .ok_or_else(|| AppError::ApiError(format!("No MCP server named '{}'", name)))?;
        f(def);
        let updated = def.clone();
        self.save(&all)?;
        Ok(updated)
    }

    pub fn remove(&self, name: &str) -> Result<(), AppError> {
        let mut all = self.load_checked()?;
        all.retain(|d| d.name != name);
        self.save(&all)
    }
}

// ─── Credentials store ───
//
// Holds the contents of each server's credentials file (e.g. centralmcp's
// `credentials.yaml`) in the system password store under `mcp-creds:<name>`
// (or, with no store, the 1.9 `mcp_creds.json`; see secret_store.rs). On
// connect the content is written to a file and the server's credentials env
// var (default `CREDS_PATH`) is pointed at it.
//
// Every call may block on the store, so commands run them in spawn_blocking
// and never while holding the MCP manager lock.

#[derive(Clone)]
pub struct McpCreds {
    store: Arc<SecretStore>,
}

impl McpCreds {
    pub fn new(store: Arc<SecretStore>) -> Self {
        Self { store }
    }

    fn account(name: &str) -> String {
        format!("{}{}", MCP_CREDS_PREFIX, name)
    }

    /// Save the content; empty content deletes it.
    pub fn set(&self, name: &str, content: &str) -> Result<(), String> {
        self.store.set(&Self::account(name), content)
    }

    pub fn get(&self, name: &str) -> Result<Option<Zeroizing<String>>, String> {
        self.store.get(&Self::account(name))
    }

    pub fn has(&self, name: &str) -> Result<bool, String> {
        self.store.has(&Self::account(name))
    }

    pub fn delete(&self, name: &str) -> Result<(), String> {
        self.store.delete(&Self::account(name))
    }

    /// Copy to a new name and check the copy (see SecretStore::copy).
    pub fn copy(&self, from: &str, to: &str) -> Result<bool, String> {
        self.store.copy(&Self::account(from), &Self::account(to))
    }
}

/// The folder for login files, inside the app data folder.
const CREDS_DIR: &str = "mcp_creds";
/// Each running copy of GreenCLI keeps its login files in its own
/// `mcp_creds/run-<id>/` folder, next to `run-<id>.lock`, which it holds
/// locked while it runs. The startup sweep deletes only folders whose lock
/// is free, so a second copy of the app never deletes the files of servers
/// the first copy still runs.
const RUN_PREFIX: &str = "run-";
const LOCK_SUFFIX: &str = ".lock";
/// Held while a run folder is made or the sweep runs, so the two never meet
/// halfway.
const SWEEP_LOCK: &str = ".sweep.lock";

/// This process's run folder per app data folder, with its held lock.
static RUN_DIRS: std::sync::Mutex<Vec<(PathBuf, PathBuf, fs::File)>> = std::sync::Mutex::new(Vec::new());

fn open_lock(path: &std::path::Path, create_new: bool) -> std::io::Result<fs::File> {
    let mut o = fs::OpenOptions::new();
    o.read(true).write(true);
    if create_new {
        o.create_new(true);
    } else {
        o.create(true).truncate(false);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        o.mode(0o600);
    }
    o.open(path)
}

/// A lock path must be a plain file: a link there is refused, never followed.
fn open_plain_lock(path: &std::path::Path) -> std::io::Result<fs::File> {
    if let Ok(m) = fs::symlink_metadata(path) {
        if !m.is_file() {
            return Err(std::io::Error::other("not a plain file"));
        }
    }
    open_lock(path, false)
}

/// The sweep lock of `base` (`mcp_creds`), held until the file is dropped.
fn hold_sweep_lock(base: &std::path::Path) -> std::io::Result<fs::File> {
    let f = open_plain_lock(&base.join(SWEEP_LOCK))?;
    f.lock()?;
    Ok(f)
}

/// This process's own login folder in `app_dir`, made (with its lock) the
/// first time it is needed.
fn run_dir(app_dir: &std::path::Path) -> Result<PathBuf, AppError> {
    let mut runs = RUN_DIRS.lock().unwrap_or_else(|e| e.into_inner());
    if let Some(i) = runs.iter().position(|(a, _, _)| a == app_dir) {
        if fs::symlink_metadata(&runs[i].1).map(|m| m.is_dir()).unwrap_or(false) {
            return Ok(runs[i].1.clone());
        }
        // Deleted under us: make a new one.
        runs.remove(i);
    }
    let base = app_dir.join(CREDS_DIR);
    crate::private_fs::private_dir(&base)?;
    let _sweep = hold_sweep_lock(&base)?;
    let id = format!("{}{:016x}", RUN_PREFIX, rand::random::<u64>());
    let lock = open_lock(&base.join(format!("{}{}", id, LOCK_SUFFIX)), true)?;
    lock.try_lock()
        .map_err(|e| AppError::ApiError(format!("Couldn't lock the MCP login folder: {}", e)))?;
    let dir = base.join(&id);
    crate::private_fs::private_dir(&dir)?;
    runs.push((app_dir.to_path_buf(), dir.clone(), lock));
    Ok(dir)
}

/// The login file of one running stdio server. It exists only while that
/// server runs: it is deleted when the server is shut down, when it exits by
/// itself (the stdio reader sees EOF), when the connect fails, and by the
/// startup sweep once this copy of the app is gone. Each connect writes a
/// new file, so a reconnect never deletes the file the new server is using.
pub struct CredsFile {
    path: PathBuf,
    removed: AtomicBool,
}

impl CredsFile {
    /// Write `content` to a new owner-only file for server `name` in this
    /// process's `<app_dir>/mcp_creds/run-<id>/` (the folders are owner-only too).
    fn write(app_dir: &std::path::Path, name: &str, content: &[u8]) -> Result<Self, AppError> {
        let dir = run_dir(app_dir)?;
        let path = dir.join(format!("{}-{:016x}", sanitize_filename(name), rand::random::<u64>()));
        let file = Self {
            path,
            removed: AtomicBool::new(false),
        };
        // On an error the guard is dropped, which deletes anything written.
        crate::private_fs::write_key_file(&file.path, content)?;
        Ok(file)
    }

    pub fn path(&self) -> &std::path::Path {
        &self.path
    }

    /// Delete the file (once; later calls do nothing).
    pub fn remove(&self) {
        if !self.removed.swap(true, Ordering::Relaxed) {
            let _ = fs::remove_file(&self.path);
            let _ = fs::remove_file(crate::private_fs::key_file_tmp(&self.path));
        }
    }
}

impl Drop for CredsFile {
    fn drop(&mut self) {
        self.remove();
    }
}

/// Startup sweep, before any server connects: login files left by a crash
/// or a forced quit are deleted. A run folder whose lock another running
/// copy of GreenCLI holds is left alone. Links are deleted, never followed.
pub fn sweep_creds_dir(app_dir: &std::path::Path) {
    let base = app_dir.join(CREDS_DIR);
    if !fs::symlink_metadata(&base).map(|m| m.is_dir()).unwrap_or(false) {
        return;
    }
    let _sweep = match hold_sweep_lock(&base) {
        Ok(f) => f,
        Err(e) => {
            log::warn!("Couldn't lock the MCP login folder, so it wasn't cleaned: {}", e);
            return;
        }
    };
    let Ok(entries) = fs::read_dir(&base) else {
        return;
    };
    for entry in entries.flatten() {
        let name = entry.file_name().to_string_lossy().to_string();
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if name == SWEEP_LOCK {
            continue;
        }
        let run_lock = name
            .strip_suffix(LOCK_SUFFIX)
            .filter(|id| id.starts_with(RUN_PREFIX));
        if let (Some(id), true) = (run_lock, kind.is_file()) {
            let free = match open_plain_lock(&entry.path()) {
                Ok(f) => f.try_lock().is_ok(),
                Err(_) => false,
            };
            if free {
                remove_run_dir(&base.join(id));
                let _ = fs::remove_file(entry.path());
            }
        } else if kind.is_dir() && name.starts_with(RUN_PREFIX) {
            // Its lock file is made first, so a folder without one is left over.
            if fs::symlink_metadata(base.join(format!("{}{}", name, LOCK_SUFFIX))).is_err() {
                remove_run_dir(&entry.path());
            }
        } else if kind.is_file() || kind.is_symlink() {
            // A 1.9 or 2.0-beta login file straight in mcp_creds.
            let _ = fs::remove_file(entry.path());
        }
    }
}

/// Delete a run folder: plain files and links in it, then the folder. A link
/// in place of the folder is deleted itself.
fn remove_run_dir(dir: &std::path::Path) {
    let Ok(meta) = fs::symlink_metadata(dir) else {
        return;
    };
    if !meta.is_dir() {
        let _ = fs::remove_file(dir);
        return;
    }
    if let Ok(entries) = fs::read_dir(dir) {
        for entry in entries.flatten() {
            if entry.file_type().map(|t| t.is_file() || t.is_symlink()).unwrap_or(false) {
                let _ = fs::remove_file(entry.path());
            }
        }
    }
    let _ = fs::remove_dir(dir);
}

// ─── Running client ───

type Pending = Arc<Mutex<HashMap<i64, oneshot::Sender<Result<Value, String>>>>>;

/// Transport-specific I/O a caller needs to perform a request/notify.
#[derive(Clone)]
enum ClientIo {
    Stdio {
        stdin: Arc<Mutex<ChildStdin>>,
    },
    Http {
        http: reqwest::Client,
        url: Arc<str>,
        /// Captured from the server's `Mcp-Session-Id` response header
        /// (typically on `initialize`) and echoed on every later request.
        session_id: Arc<Mutex<Option<String>>>,
        /// The MCP protocol version negotiated on `initialize`, sent as the
        /// `MCP-Protocol-Version` header on every post-initialize request (per
        /// the 2025-06-18 Streamable HTTP spec). `None` until the handshake
        /// completes, so the `initialize` POST itself omits the header.
        protocol_version: Arc<Mutex<Option<String>>>,
        /// Extra headers from the server definition (`Authorization: Bearer …`
        /// etc.), applied to every request.
        headers: Arc<HashMap<String, String>>,
    },
}

/// Cheap, clonable handle that can issue requests on a connected client.
/// Cloning it lets a caller release the manager mutex BEFORE awaiting a tool
/// round-trip, so one slow tool never serialises the whole MCP subsystem.
#[derive(Clone)]
pub struct McpCaller {
    /// Server name, for actionable error messages.
    server: Arc<str>,
    io: ClientIo,
    /// Correlates stdio responses to pending requests by id (background reader
    /// task resolves these). Unused for Http: each POST's own response IS
    /// that request's answer, read synchronously inline — no cross-task
    /// correlation needed.
    pending: Pending,
    next_id: Arc<Mutex<i64>>,
    /// Signalled on `notifications/tools/list_changed` — for stdio this is
    /// driven by the background reader task; for Http, `request()` itself
    /// watches for it (piggybacked in a POST's own SSE response stream), as
    /// does the optional standalone GET listener task.
    tools_changed_tx: mpsc::UnboundedSender<()>,
    /// Set when the server is known gone: for stdio, the child's stdout hit
    /// EOF/error; for Http, several consecutive connection-level POST failures
    /// (see `http_connect_failures`). Checked before every request so callers
    /// get a clear "server has exited" error instead of a raw I/O failure, and
    /// so the manager stops reporting the client as connected. HTTP health is
    /// judged purely per-request: the optional standalone SSE stream closing is
    /// benign (it re-establishes) and never flips this.
    dead: Arc<AtomicBool>,
    /// Http only: consecutive connection-level failures (refused/reset/DNS)
    /// seen by the per-request POST path. A handful in a row means the server
    /// is really down, so `dead` is set; any successful send resets it, so a
    /// lone transient blip never forces a manual reconnect. Zero for stdio.
    http_connect_failures: Arc<AtomicU32>,
    /// Http only: a session re-initialize started and hasn't finished (a Stop
    /// or a timeout cut it short, or it failed). The next request finishes it
    /// first, instead of going out with no session id forever.
    reinit_pending: Arc<AtomicBool>,
}

pub struct McpClient {
    /// The spawned child process, for stdio transport only — nothing to hold
    /// for Http (the app doesn't launch that server).
    child: Option<Child>,
    caller: McpCaller,
    /// std::sync::Mutex (not tokio's): only ever locked for a quick clone/replace,
    /// never held across an await, so a cheap sync lock is enough and lets
    /// `all_tools()`/`status()` stay non-async.
    pub tools: Arc<std::sync::Mutex<Vec<McpToolInfo>>>,
    /// Server name/version from the handshake (kept for future UI display).
    #[allow(dead_code)]
    pub server_info: Value,
    /// Stdio: the stdout line reader. Http: the optional standalone GET SSE
    /// listener, which re-establishes the stream if it drops (a no-op
    /// already-finished task if the server doesn't support it at all).
    reader: tokio::task::JoinHandle<()>,
    /// Refetches the tool list when the server sends `notifications/tools/list_changed`
    /// (e.g. centralmcp enabling a new capability mid-session) — without this the
    /// AI keeps using a stale tool list until the user manually reconnects.
    refresher: tokio::task::JoinHandle<()>,
    /// The read-only pins applied at connect (set by the caller from
    /// `ResolvedDef`). None while writes were on, or for no preset.
    pub pins: PinPlan,
    /// The writes setting this connection was started with. When the saved
    /// setting differs, status() asks for a restart so the pins match it.
    pub connected_writes_on: bool,
    /// The server's access_check answer, run once per connection. None when
    /// the server has no usable access_check tool. Never sent to the AI.
    pub access: Arc<std::sync::Mutex<Option<AccessCheck>>>,
    /// Stdio only: the login file this server was started with. Deleted at
    /// shutdown (and by the reader at EOF).
    creds_file: Option<Arc<CredsFile>>,
}

/// GUI apps inherit a minimal PATH; add the usual user/tool bin dirs so things
/// like `uv`, `uvx`, `python`, `node`, `fastmcp` resolve.
fn augment_path(cmd: &mut Command) {
    if cfg!(windows) {
        return;
    }
    if let Ok(home) = std::env::var("HOME") {
        let extra = [
            format!("{home}/.local/bin"),
            format!("{home}/.cargo/bin"),
            "/usr/local/bin".to_string(),
            "/opt/homebrew/bin".to_string(),
        ];
        let current = std::env::var("PATH").unwrap_or_default();
        let mut parts: Vec<String> = current.split(':').map(|s| s.to_string()).collect();
        for p in extra {
            if !parts.contains(&p) {
                parts.push(p);
            }
        }
        cmd.env("PATH", parts.join(":"));
    }
}

/// Validate a configured stdio MCP server command before spawning it. The
/// process is spawned directly (no shell), so metacharacters can't inject —
/// the risks this guards are (a) a shell interpreter named AS the server, which
/// would re-introduce shell interpretation via `-c` args, and (b) an absolute
/// path that doesn't exist, which should fail with a clear message. Bare
/// command names (`uvx`, `npx`, …) are resolved by the OS at spawn time.
fn validate_stdio_command(command: &str) -> Result<(), AppError> {
    let trimmed = command.trim();
    if trimmed.is_empty() {
        return Err(AppError::ApiError(
            "MCP server command is empty — configure the server binary to launch".into(),
        ));
    }
    let file_name = std::path::Path::new(trimmed)
        .file_name()
        .and_then(|f| f.to_str())
        .unwrap_or(trimmed)
        .to_ascii_lowercase();
    const SHELLS: [&str; 10] = [
        "sh", "bash", "zsh", "fish", "cmd", "cmd.exe", "powershell", "powershell.exe", "pwsh",
        "pwsh.exe",
    ];
    if SHELLS.contains(&file_name.as_str()) {
        return Err(AppError::ApiError(format!(
            "Refusing to launch shell interpreter '{}' as an MCP server (its args would be \
             shell-interpreted). Configure the server binary directly (e.g. `uvx`, `node`, \
             an absolute path) instead.",
            trimmed
        )));
    }
    if std::path::Path::new(trimmed).is_absolute() && !std::path::Path::new(trimmed).exists() {
        return Err(AppError::ApiError(format!(
            "MCP server binary '{}' does not exist",
            trimmed
        )));
    }
    Ok(())
}

/// Fetch every tool from a connected server, following `nextCursor` pagination
/// — a large server (e.g. centralmcp's router mode, or its hundreds of direct
/// tools in default mode) may page its list, and taking only the first page
/// would silently hide the rest from the AI.
async fn fetch_all_tools(caller: &McpCaller, server_name: &str) -> Result<Vec<McpToolInfo>, AppError> {
    let mut tools: Vec<McpToolInfo> = Vec::new();
    let mut cursor: Option<String> = None;
    for _page in 0..64 {
        let params = match &cursor {
            Some(c) => json!({ "cursor": c }),
            None => json!({}),
        };
        let tools_res = caller.request("tools/list", params).await?;
        tools.extend(
            tools_res
                .get("tools")
                .and_then(|t| t.as_array())
                .cloned()
                .unwrap_or_default()
                .iter()
                .filter_map(|t| tool_from_json(server_name, t)),
        );
        let next = tools_res
            .get("nextCursor")
            .and_then(|c| c.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string());
        match next {
            // A server echoing the same cursor forever would loop us — stop.
            Some(n) if Some(&n) != cursor.as_ref() => cursor = Some(n),
            _ => break,
        }
    }
    // After every page: a name can repeat across pages too.
    Ok(dedupe_tools(server_name, tools))
}

/// Flexibly parse a JSON-RPC id (integer / float / numeric-string — servers vary).
fn extract_id(v: &Value) -> Option<i64> {
    v.get("id").and_then(|i| {
        i.as_i64()
            .or_else(|| i.as_u64().map(|u| u as i64))
            .or_else(|| i.as_f64().map(|f| f as i64))
            .or_else(|| i.as_str().and_then(|s| s.parse::<i64>().ok()))
    })
}

/// Turn a JSON-RPC response body into our Result convention.
fn extract_result_or_error(v: Value) -> Result<Value, AppError> {
    // `error: null` alongside a valid `result` is a lenient success (some
    // non-conformant servers serialize both keys). `Value::get` returns
    // `Some(&Value::Null)` for a present-but-null key, so filter it out or the
    // error branch would fire on a successful response.
    if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
        let msg = err
            .get("message")
            .and_then(|m| m.as_str())
            .unwrap_or("MCP error")
            .to_string();
        Err(AppError::ApiError(msg))
    } else {
        Ok(v.get("result").cloned().unwrap_or(Value::Null))
    }
}

/// Handle one message pushed by the server over an HTTP SSE stream (either
/// piggybacked in a POST's own response stream, or from the standalone GET
/// listener). Answers `ping` (refuses anything else) and signals
/// `tools_changed_tx` on `notifications/tools/list_changed`, mirroring the
/// stdio reader's behaviour. If `awaiting_id` is Some and this message IS
/// that response (has a matching id plus `result`/`error`), returns it;
/// otherwise returns None so the caller keeps reading.
async fn handle_pushed_message(
    v: &Value,
    http: &reqwest::Client,
    url: &str,
    session_id: &Arc<Mutex<Option<String>>>,
    protocol_version: &Arc<Mutex<Option<String>>>,
    tools_changed_tx: &mpsc::UnboundedSender<()>,
    awaiting_id: Option<i64>,
) -> Option<Result<Value, AppError>> {
    if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
        if method == "notifications/tools/list_changed" {
            let _ = tools_changed_tx.send(());
        }
        if let Some(req_id) = v.get("id").cloned() {
            // Server REQUEST piggybacked in the stream — per the Streamable
            // HTTP spec, a client reply goes back as its own POST (not inline
            // on this stream). Same answer/refuse policy as stdio's reader.
            let resp = if method == "ping" {
                json!({ "jsonrpc": "2.0", "id": req_id, "result": {} })
            } else {
                json!({
                    "jsonrpc": "2.0",
                    "id": req_id,
                    "error": { "code": -32601, "message": format!("client does not support '{}'", method) }
                })
            };
            let sid = session_id.lock().await.clone();
            let mut rb = http
                .post(url)
                .header("Content-Type", "application/json")
                .header("Accept", "application/json, text/event-stream")
                .json(&resp);
            if let Some(sid) = sid {
                rb = rb.header("Mcp-Session-Id", sid);
            }
            if let Some(ver) = protocol_version.lock().await.as_deref() {
                rb = rb.header("MCP-Protocol-Version", ver);
            }
            // Bound so a stalled server can't park the standalone listener task
            // (on the per-request path the outer request timeout already covers
            // this send).
            let _ = tokio::time::timeout(Duration::from_secs(30), rb.send()).await;
        }
        return None;
    }
    if let (Some(id), Some(want)) = (extract_id(v), awaiting_id) {
        if id == want {
            return Some(extract_result_or_error(v.clone()));
        }
    }
    None
}

/// Read one SSE response stream, dispatching every message via
/// `handle_pushed_message`. With `awaiting_id: Some(id)`, returns as soon as
/// that response arrives (used for a POST's own response stream). With
/// `awaiting_id: None`, never returns except on stream end/error (used by the
/// standalone out-of-band listener, which just wants to keep dispatching
/// pushed messages forever).
async fn drain_sse(
    resp: reqwest::Response,
    http: &reqwest::Client,
    url: &str,
    session_id: &Arc<Mutex<Option<String>>>,
    protocol_version: &Arc<Mutex<Option<String>>>,
    tools_changed_tx: &mpsc::UnboundedSender<()>,
    awaiting_id: Option<i64>,
) -> Option<Result<Value, AppError>> {
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    // Idle cap for the STANDALONE listener (awaiting_id == None): a server that
    // accepts the GET and then stalls must not park the task forever. On expiry
    // we return as if the stream ended — the caller re-establishes with backoff.
    // (The awaiting_id case is already bounded by the caller's request timeout.)
    const SSE_IDLE_TIMEOUT: Duration = Duration::from_secs(300);
    loop {
        let next = if awaiting_id.is_none() {
            match tokio::time::timeout(SSE_IDLE_TIMEOUT, stream.next()).await {
                Ok(n) => n,
                Err(_) => {
                    log::warn!(
                        "MCP: SSE stream idle for {}s; re-establishing",
                        SSE_IDLE_TIMEOUT.as_secs()
                    );
                    return None;
                }
            }
        } else {
            stream.next().await
        };
        let Some(chunk) = next else { break };
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                return awaiting_id.map(|_| {
                    Err(AppError::ApiError(format!(
                        "MCP stream read error: {}",
                        e.without_url()
                    )))
                });
            }
        };
        buf.push_str(&String::from_utf8_lossy(&chunk));
        buf = buf.replace("\r\n", "\n");
        // SSE events are separated by a blank line.
        while let Some(pos) = buf.find("\n\n") {
            let event: String = buf.drain(..pos + 2).collect();
            // A `data:` field's value may be split across multiple `data:`
            // lines (joined by '\n' per the SSE spec); MCP servers emit one
            // JSON blob per event in practice, but handle both.
            let data_lines: Vec<&str> = event
                .lines()
                .filter_map(|l| l.strip_prefix("data:"))
                .map(|l| l.strip_prefix(' ').unwrap_or(l))
                .collect();
            if data_lines.is_empty() {
                continue; // comment / retry: / id: / blank — nothing to parse
            }
            let v: Value = match serde_json::from_str(&data_lines.join("\n")) {
                Ok(v) => v,
                Err(_) => continue,
            };
            if let Some(result) = handle_pushed_message(
                &v,
                http,
                url,
                session_id,
                protocol_version,
                tools_changed_tx,
                awaiting_id,
            )
            .await
            {
                return Some(result);
            }
        }
    }
    awaiting_id.map(|_| Err(AppError::ApiError("MCP stream ended without a response".into())))
}

/// Write and flush the whole line, then wait for `wait` or a Stop, whichever
/// comes first. The write is outside the select on purpose: a Stop that comes
/// during the write stays in the channel and takes effect right after it, so
/// the server never gets half a line. Outer Err: the write failed.
pub(crate) async fn send_then_wait<W: AsyncWrite + Unpin, T>(
    w: &Mutex<W>,
    line: &[u8],
    wait: impl Future<Output = T>,
    cancel: Option<oneshot::Receiver<()>>,
) -> std::io::Result<Result<T, Cancelled>> {
    {
        let mut w = w.lock().await;
        w.write_all(line).await?;
        w.flush().await?;
    }
    tokio::select! {
        // An answer that is already here wins over a Stop.
        biased;
        v = wait => Ok(Ok(v)),
        _ = cancel::stop_signal(cancel) => Ok(Err(Cancelled)),
    }
}

/// Run the server's own access_check once, when it offers a usable one
/// (access::access_check_tool). Any error counts as "unknown".
async fn check_access(caller: &McpCaller, tools: &[McpToolInfo]) -> Option<AccessCheck> {
    let tool = access::access_check_tool(tools)?;
    Some(
        match caller.call_tool_raw(&tool.name, json!({}), 15, None).await {
            Ok(result) => access::parse_access_check(&result),
            Err(e) => {
                log::warn!("MCP '{}': access_check failed: {}", caller.server, e);
                AccessCheck::unknown()
            }
        },
    )
}

/// Refetches the tool list on `notifications/tools/list_changed`, shared by
/// both transports. Debounced so a burst of notifications (a server flipping
/// several capabilities at once) triggers one refetch, not one per
/// notification. Ends on its own when the sender side of the channel drops
/// (stdio: reader task ends; Http: both the standalone listener and every
/// in-flight request hold a clone, so it only drops once the client itself
/// is gone).
fn spawn_refresher(
    caller: McpCaller,
    tools: Arc<std::sync::Mutex<Vec<McpToolInfo>>>,
    server_name: String,
    mut tools_changed_rx: mpsc::UnboundedReceiver<()>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        while tools_changed_rx.recv().await.is_some() {
            tokio::time::sleep(Duration::from_millis(300)).await;
            while tools_changed_rx.try_recv().is_ok() {}
            match fetch_all_tools(&caller, &server_name).await {
                Ok(new_tools) => {
                    if let Ok(mut guard) = tools.lock() {
                        *guard = new_tools;
                    }
                }
                Err(e) => log::warn!("MCP '{}': tools/list refresh failed: {}", server_name, e),
            }
        }
    })
}

// Reader task: dispatch responses to waiters; answer server-initiated
// requests (ping keep-alives especially) instead of leaving them hanging.
// A transient read error (e.g. a non-UTF8 banner byte) skips that line
// rather than killing the whole connection; only EOF ends the loop.
// At EOF the client is marked dead, waiters fail, and the server's login
// file (if any) is deleted: it is only kept while the server runs.
fn spawn_stdio_reader(
    stdout: ChildStdout,
    pending_r: Pending,
    dead_r: Arc<AtomicBool>,
    stdin_r: Arc<Mutex<ChildStdin>>,
    tools_changed_tx: mpsc::UnboundedSender<()>,
    creds_file: Option<Arc<CredsFile>>,
) -> tokio::task::JoinHandle<()> {
    tokio::spawn(async move {
        let mut lines = BufReader::new(stdout).lines();
        loop {
            let line = match lines.next_line().await {
                Ok(Some(l)) => l,
                Ok(None) => break, // EOF — process closed stdout
                // A non-UTF8 line is consumed, so skip it and keep reading. But a
                // real I/O error (broken pipe / reset) does NOT advance the stream:
                // returning the same error forever would busy-spin a core. Break.
                Err(e) if e.kind() == std::io::ErrorKind::InvalidData => continue,
                Err(_) => break,
            };
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            let v: Value = match serde_json::from_str(line) {
                Ok(v) => v,
                Err(_) => continue, // skip any non-JSON banner/log lines
            };
            // A message carrying a `method` is a REQUEST/notification FROM the
            // server (ping/sampling/roots/elicitation), not a response to us.
            // Never match it against pending waiters — ids restart at 1 each
            // reconnect so a server-request id can collide with one of ours.
            // A server REQUEST (method + id) must be answered or a strict server
            // can stall/tear down the session: reply to `ping`, politely refuse
            // the rest. Notifications (no id) need no reply.
            if let Some(method) = v.get("method").and_then(|m| m.as_str()) {
                if method == "notifications/tools/list_changed" {
                    let _ = tools_changed_tx.send(());
                }
                if let Some(req_id) = v.get("id") {
                    let resp = if method == "ping" {
                        json!({ "jsonrpc": "2.0", "id": req_id, "result": {} })
                    } else {
                        json!({
                            "jsonrpc": "2.0",
                            "id": req_id,
                            "error": { "code": -32601, "message": format!("client does not support '{}'", method) }
                        })
                    };
                    let line = format!("{}\n", resp);
                    let mut w = stdin_r.lock().await;
                    let _ = w.write_all(line.as_bytes()).await;
                    let _ = w.flush().await;
                }
                continue;
            }
            // Accept integer / float / numeric-string ids (servers vary).
            let id = v.get("id").and_then(|i| {
                i.as_i64()
                    .or_else(|| i.as_u64().map(|u| u as i64))
                    .or_else(|| i.as_f64().map(|f| f as i64))
                    .or_else(|| i.as_str().and_then(|s| s.parse::<i64>().ok()))
            });
            if let Some(id) = id {
                if let Some(tx) = pending_r.lock().await.remove(&id) {
                    // `error: null` with a valid `result` is a lenient
                    // success, not an error — `get` yields Some(&Null) for a
                    // present-but-null key, so filter null out here too.
                    if let Some(err) = v.get("error").filter(|e| !e.is_null()) {
                        let msg = err
                            .get("message")
                            .and_then(|m| m.as_str())
                            .unwrap_or("MCP error")
                            .to_string();
                        let _ = tx.send(Err(msg));
                    } else {
                        let _ = tx.send(Ok(v.get("result").cloned().unwrap_or(Value::Null)));
                    }
                }
            }
        }
        // Stream closed — mark the client dead FIRST (so new requests are
        // refused with an actionable error and status()/all_tools() stop
        // advertising it), then fail any outstanding requests.
        dead_r.store(true, Ordering::Relaxed);
        let mut p = pending_r.lock().await;
        for (_, tx) in p.drain() {
            let _ = tx.send(Err("MCP server process exited".into()));
        }
        drop(p);
        if let Some(file) = creds_file {
            file.remove();
        }
    })
}

impl McpClient {
    /// Connect to a server. `creds_file` is the login file `def` points at
    /// (stdio only); the client keeps it while the server runs.
    pub async fn connect(
        def: &McpServerDef,
        creds_file: Option<Arc<CredsFile>>,
    ) -> Result<McpClient, AppError> {
        match def.transport {
            McpTransport::Stdio => Self::connect_stdio(def, creds_file).await,
            McpTransport::Http => Self::connect_http(def).await,
        }
    }

    async fn connect_stdio(
        def: &McpServerDef,
        creds_file: Option<Arc<CredsFile>>,
    ) -> Result<McpClient, AppError> {
        validate_stdio_command(&def.command)?;
        let mut cmd = Command::new(&def.command);
        cmd.args(&def.args);
        // Only a short list of basic variables from GreenCLI's own environment
        // (see env.rs): API keys in the user's shell must not reach every
        // server. vars_os, because vars panics on a non-UTF-8 value.
        cmd.env_clear();
        for (k, v) in env::inherited_env(std::env::vars_os(), cfg!(windows)) {
            cmd.env(k, v);
        }
        augment_path(&mut cmd);
        // The server's own Env box (and the credentials file path) last, so
        // they win.
        for (k, v) in &def.env {
            cmd.env(k, v);
        }
        if let Some(cwd) = &def.cwd {
            if !cwd.trim().is_empty() {
                cmd.current_dir(cwd);
            }
        }
        cmd.stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true);

        let mut child = cmd.spawn().map_err(|e| {
            AppError::ApiError(format!("Failed to launch MCP server '{}': {}", def.name, e))
        })?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| AppError::ApiError("MCP server has no stdin".into()))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| AppError::ApiError("MCP server has no stdout".into()))?;

        // Collect the server's stderr (last ~50 lines) so a failed launch/handshake
        // can show WHY (Python tracebacks, missing creds, bad args) instead of a
        // bare timeout/EOF. The collector task ends by itself at stderr EOF.
        let stderr_buf: Arc<Mutex<VecDeque<String>>> = Arc::new(Mutex::new(VecDeque::new()));
        if let Some(err_pipe) = child.stderr.take() {
            let buf = stderr_buf.clone();
            tokio::spawn(async move {
                let mut lines = BufReader::new(err_pipe).lines();
                loop {
                    match lines.next_line().await {
                        Ok(Some(l)) => {
                            let mut b = buf.lock().await;
                            if b.len() >= 50 {
                                b.pop_front();
                            }
                            b.push_back(l);
                        }
                        Ok(None) => break,
                        Err(e) if e.kind() == std::io::ErrorKind::InvalidData => continue,
                        Err(_) => break,
                    }
                }
            });
        }

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let dead = Arc::new(AtomicBool::new(false));
        let stdin = Arc::new(Mutex::new(stdin));

        // Signalled by the reader on `notifications/tools/list_changed`; the
        // refresher task (spawned below, after the initial tools/list) drains
        // it and refetches. `McpCaller` also holds a clone (only meaningfully
        // used by the Http variant, but present on both for a uniform struct)
        // — the reader's own clone is what actually closes the channel here.
        let (tools_changed_tx, tools_changed_rx) = tokio::sync::mpsc::unbounded_channel::<()>();

        let reader = spawn_stdio_reader(
            stdout,
            pending.clone(),
            dead.clone(),
            stdin.clone(),
            tools_changed_tx.clone(),
            creds_file.clone(),
        );

        let caller = McpCaller {
            server: Arc::from(def.name.as_str()),
            io: ClientIo::Stdio { stdin },
            pending,
            next_id: Arc::new(Mutex::new(0)),
            tools_changed_tx: tools_changed_tx.clone(),
            dead,
            http_connect_failures: Arc::new(AtomicU32::new(0)),
            reinit_pending: Arc::new(AtomicBool::new(false)),
        };

        // Attach the server's stderr tail to a handshake error — that's where
        // the actual reason (traceback, missing module, bad creds path) lands.
        async fn with_stderr(e: AppError, buf: &Arc<Mutex<VecDeque<String>>>) -> AppError {
            // Give the collector a beat to drain what the dying process wrote.
            tokio::time::sleep(std::time::Duration::from_millis(150)).await;
            let b = buf.lock().await;
            if b.is_empty() {
                return e;
            }
            let tail: Vec<&str> = b.iter().rev().take(8).map(|s| s.as_str()).collect();
            let tail: Vec<&str> = tail.into_iter().rev().collect();
            AppError::ApiError(format!("{}\nServer stderr (tail):\n{}", e, tail.join("\n")))
        }

        // Handshake.
        let init = match caller.request("initialize", initialize_params()).await {
            Ok(v) => v,
            Err(e) => return Err(with_stderr(e, &stderr_buf).await),
        };
        let server_info = init.get("serverInfo").cloned().unwrap_or(Value::Null);
        caller.notify("notifications/initialized", json!({})).await?;

        // Discover tools (follows nextCursor pagination — see fetch_all_tools).
        let tools = match fetch_all_tools(&caller, &def.name).await {
            Ok(t) => t,
            Err(e) => return Err(with_stderr(e, &stderr_buf).await),
        };
        let access = check_access(&caller, &tools).await;
        let tools = Arc::new(std::sync::Mutex::new(tools));
        let refresher = spawn_refresher(caller.clone(), tools.clone(), def.name.clone(), tools_changed_rx);

        Ok(McpClient {
            child: Some(child),
            creds_file,
            caller,
            tools,
            server_info,
            reader,
            refresher,
            pins: PinPlan::None,
            connected_writes_on: false,
            access: Arc::new(std::sync::Mutex::new(access)),
        })
    }

    async fn connect_http(def: &McpServerDef) -> Result<McpClient, AppError> {
        let url: Arc<str> = def
            .url
            .as_deref()
            .map(str::trim)
            .filter(|s| !s.is_empty())
            .ok_or_else(|| {
                AppError::ApiError(format!("MCP server '{}' has no URL configured", def.name))
            })
            .map(Arc::from)?;
        if !url.starts_with("http://") && !url.starts_with("https://") {
            return Err(AppError::ApiError(format!(
                "MCP server '{}': URL must start with http:// or https:// (got '{}')",
                def.name, url
            )));
        }

        let http = reqwest::Client::builder()
            // Bound TCP+TLS establishment for every request (handshake,
            // per-request, notify, the standalone listener) WITHOUT a blanket
            // request timeout, which would abort the long-lived SSE streams.
            .connect_timeout(Duration::from_secs(10))
            .build()
            .map_err(|e| AppError::ApiError(format!("Failed to build HTTP client: {}", e)))?;
        let session_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let protocol_version: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let dead = Arc::new(AtomicBool::new(false));
        let (tools_changed_tx, tools_changed_rx) = mpsc::unbounded_channel::<()>();
        let headers: Arc<HashMap<String, String>> = Arc::new(def.headers.clone());

        let caller = McpCaller {
            server: Arc::from(def.name.as_str()),
            io: ClientIo::Http {
                http: http.clone(),
                url: url.clone(),
                session_id: session_id.clone(),
                protocol_version: protocol_version.clone(),
                headers: headers.clone(),
            },
            pending: Arc::new(Mutex::new(HashMap::new())), // unused for Http
            next_id: Arc::new(Mutex::new(0)),
            tools_changed_tx: tools_changed_tx.clone(),
            dead: dead.clone(),
            http_connect_failures: Arc::new(AtomicU32::new(0)),
            reinit_pending: Arc::new(AtomicBool::new(false)),
        };

        // Handshake — same JSON-RPC calls as stdio; McpCaller dispatches the
        // actual HTTP mechanics internally.
        let init = caller
            .request("initialize", initialize_params())
            .await
            .map_err(|e| {
                AppError::ApiError(format!(
                    "{} (is the server running in Streamable HTTP mode at this URL?)",
                    e
                ))
            })?;
        let server_info = init.get("serverInfo").cloned().unwrap_or(Value::Null);
        // Capture the negotiated protocol version BEFORE the initialized
        // notification, so that notification and every later request/notify
        // carry the `MCP-Protocol-Version` header. (The initialize POST above
        // ran while protocol_version was still None, so it correctly omitted
        // the header.)
        *protocol_version.lock().await = Some(negotiated_version(&init));
        caller.notify("notifications/initialized", json!({})).await?;

        let tools = fetch_all_tools(&caller, &def.name).await?;
        let access = check_access(&caller, &tools).await;
        let tools = Arc::new(std::sync::Mutex::new(tools));

        // Optional standalone GET SSE stream for out-of-band server pushes
        // (ping, spontaneous list_changed) not tied to any specific request —
        // the Http analogue of stdio's always-running reader task. Many
        // servers don't implement this (it's optional per the Streamable HTTP
        // spec), so a failed/refused GET is tolerated, not a connect error;
        // connection health then falls back to being judged per-request.
        let reader = {
            let http = http.clone();
            let url = url.clone();
            let session_id = session_id.clone();
            let protocol_version = protocol_version.clone();
            let headers = headers.clone();
            let tools_changed_tx = tools_changed_tx.clone();
            tokio::spawn(async move {
                // Unlike stdio's stdout (EOF == process gone), this is one of
                // many independent HTTP connections: proxies/LBs close idle
                // streams and, per the Streamable HTTP spec, the server MAY close
                // it at any time without the session ending. So on close we
                // re-establish rather than mark the client dead — real liveness
                // comes from per-POST failures (see request_cancellable).
                let mut err_backoff = Duration::from_secs(1);
                loop {
                    let sid = session_id.lock().await.clone();
                    let mut rb = http.get(url.as_ref()).header("Accept", "text/event-stream");
                    for (k, v) in headers.iter() {
                        rb = rb.header(k, v);
                    }
                    if let Some(sid) = &sid {
                        rb = rb.header("Mcp-Session-Id", sid);
                    }
                    if let Some(ver) = protocol_version.lock().await.as_deref() {
                        rb = rb.header("MCP-Protocol-Version", ver);
                    }
                    // Bound establishment: connect_timeout covers TCP/TLS, this
                    // also covers a server that connects then stalls before
                    // sending headers (slowloris), so the task can't park forever.
                    match tokio::time::timeout(Duration::from_secs(30), rb.send()).await {
                        Ok(Ok(resp)) => {
                            let is_stream = resp
                                .headers()
                                .get("content-type")
                                .and_then(|v| v.to_str().ok())
                                .map(|ct| ct.starts_with("text/event-stream"))
                                .unwrap_or(false);
                            if !resp.status().is_success() || !is_stream {
                                return; // standalone stream unsupported — optional, not dead
                            }
                            err_backoff = Duration::from_secs(1); // reset after a good connect
                            let _ = drain_sse(
                                resp,
                                &http,
                                &url,
                                &session_id,
                                &protocol_version,
                                &tools_changed_tx,
                                None,
                            )
                            .await;
                            // Established stream closed (benign per spec) — brief
                            // pause, then re-establish. The fixed pause prevents a
                            // busy loop if a server closes each stream immediately.
                            tokio::time::sleep(Duration::from_secs(1)).await;
                        }
                        // Couldn't connect (or stalled past the timeout) — leave
                        // `dead` false (per-request health decides that) and retry
                        // with capped backoff so a down server isn't hammered.
                        Ok(Err(_)) | Err(_) => {
                            tokio::time::sleep(err_backoff).await;
                            err_backoff = (err_backoff * 2).min(Duration::from_secs(30));
                        }
                    }
                }
            })
        };

        let refresher = spawn_refresher(caller.clone(), tools.clone(), def.name.clone(), tools_changed_rx);

        Ok(McpClient {
            child: None,
            creds_file: None,
            caller,
            tools,
            server_info,
            reader,
            refresher,
            pins: PinPlan::None,
            connected_writes_on: false,
            access: Arc::new(std::sync::Mutex::new(access)),
        })
    }

    /// A clonable handle for issuing tool calls without holding the manager lock.
    pub fn caller(&self) -> McpCaller {
        self.caller.clone()
    }

    /// The address a web (http) connection really talks to; None for stdio.
    pub fn web_url(&self) -> Option<String> {
        match &self.caller.io {
            ClientIo::Http { url, .. } => Some(url.to_string()),
            ClientIo::Stdio { .. } => None,
        }
    }

    /// The current tool list, cloned (no network call).
    fn tool_list(&self) -> Vec<McpToolInfo> {
        self.tools.lock().map(|g| g.clone()).unwrap_or_default()
    }

    /// The access_check answer for this connection, cloned.
    pub fn access_check(&self) -> Option<AccessCheck> {
        self.access.lock().ok().and_then(|g| g.clone())
    }

    /// True once the server is known gone (see the `dead` field doc on
    /// McpCaller for what that means per-transport). The client stays in the
    /// manager map until the user reconnects/removes it, but must no longer
    /// be reported as connected or advertise its tools.
    pub fn is_dead(&self) -> bool {
        self.caller.dead.load(Ordering::Relaxed)
    }

    pub async fn shutdown(mut self) {
        self.reader.abort();
        self.refresher.abort();
        if let Some(mut child) = self.child.take() {
            let _ = child.start_kill();
            let _ = child.wait().await;
        }
        // The server is gone: its login file goes too.
        if let Some(file) = self.creds_file.take() {
            file.remove();
        }
    }
}

impl McpCaller {
    /// Actionable error for a client whose server is known gone.
    fn exited_error(&self) -> AppError {
        AppError::ApiError(format!(
            "MCP server '{}' has exited — reconnect it in Settings → MCP Servers",
            self.server
        ))
    }

    async fn request(&self, method: &str, params: Value) -> Result<Value, AppError> {
        self.request_cancellable(method, params, 60, None).await
    }

    async fn next_request_id(&self) -> i64 {
        let mut n = self.next_id.lock().await;
        *n += 1;
        *n
    }

    /// Tell the server the user stopped request `id`. Runs as a detached task,
    /// so the Stop itself never waits on the server. Errors are ignored: the
    /// call may have finished already.
    fn send_cancelled(&self, id: i64) {
        let c = self.clone();
        tokio::spawn(async move {
            let params = json!({ "requestId": id, "reason": "The user pressed Stop in GreenCLI." });
            if matches!(c.io, ClientIo::Stdio { .. }) {
                // No timeout around a stdio write: dropping it part-way would
                // leave half a line on the server's stdin.
                let _ = c.notify("notifications/cancelled", params).await;
            } else {
                let _ = tokio::time::timeout(
                    Duration::from_secs(5),
                    c.notify("notifications/cancelled", params),
                )
                .await;
            }
        });
    }

    /// One JSON-RPC request. `cancel` is the Stop signal from the call
    /// registry (None: can't be stopped). A Stop before anything is sent sends
    /// nothing; a Stop after that sends `notifications/cancelled` and returns
    /// MCP_STOPPED_IN_FLIGHT. A stdio request line is always written in full
    /// first, so a Stop can never leave half a line on the server's stdin.
    async fn request_cancellable(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
        mut cancel: Option<oneshot::Receiver<()>>,
    ) -> Result<Value, AppError> {
        if self.dead.load(Ordering::Relaxed) {
            return Err(self.exited_error());
        }
        if let Some(rx) = cancel.as_mut() {
            if rx.try_recv().is_ok() {
                return Err(AppError::ApiError(MCP_STOPPED_NOT_SENT.into()));
            }
        }
        let id = self.next_request_id().await;

        match &self.io {
            ClientIo::Stdio { stdin } => {
                let (tx, rx) = oneshot::channel();
                self.pending.lock().await.insert(id, tx);

                let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
                let line = match serde_json::to_string(&msg) {
                    Ok(s) => format!("{}\n", s),
                    Err(e) => {
                        self.pending.lock().await.remove(&id);
                        return Err(e.into());
                    }
                };
                let wait = tokio::time::timeout(Duration::from_secs(timeout_secs), rx);
                let outcome = match send_then_wait(stdin, line.as_bytes(), wait, cancel).await {
                    Ok(outcome) => outcome,
                    Err(e) => {
                        // The request never reached the server, so no response will
                        // ever arrive — drop the waiter or it leaks in the pending map.
                        self.pending.lock().await.remove(&id);
                        return Err(if self.dead.load(Ordering::Relaxed) {
                            self.exited_error()
                        } else {
                            AppError::from(e)
                        });
                    }
                };

                match outcome {
                    Ok(Ok(Ok(Ok(v)))) => Ok(v),
                    Ok(Ok(Ok(Err(e)))) => {
                        Err(AppError::ApiError(format!("MCP '{}': {}", method, e)))
                    }
                    Ok(Ok(Err(_))) => Err(AppError::ApiError("MCP response channel dropped".into())),
                    Ok(Err(_)) => {
                        self.pending.lock().await.remove(&id);
                        Err(AppError::ApiError(format!(
                            "MCP '{}' timed out after {}s",
                            method, timeout_secs
                        )))
                    }
                    Err(Cancelled) => {
                        self.pending.lock().await.remove(&id);
                        self.send_cancelled(id);
                        Err(AppError::ApiError(MCP_STOPPED_IN_FLIGHT.into()))
                    }
                }
            }
            ClientIo::Http {
                http,
                url,
                session_id,
                protocol_version,
                headers,
            } => {
                let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
                let fut = async {
                    // At most one transparent retry: if the server reports the
                    // session expired (404 to a stale Mcp-Session-Id), start a
                    // fresh session and replay this request once.
                    let mut reinit_attempted = false;
                    loop {
                        if method != "initialize" && self.reinit_pending.load(Ordering::Relaxed) {
                            self.reinitialize().await?;
                        }
                        let sid = session_id.lock().await.clone();
                        let mut rb = http
                            .post(url.as_ref())
                            .header("Content-Type", "application/json")
                            .header("Accept", "application/json, text/event-stream")
                            .json(&msg);
                        for (k, v) in headers.iter() {
                            rb = rb.header(k, v);
                        }
                        if let Some(sid) = &sid {
                            rb = rb.header("Mcp-Session-Id", sid);
                        }
                        if let Some(ver) = protocol_version.lock().await.as_deref() {
                            rb = rb.header("MCP-Protocol-Version", ver);
                        }
                        let resp = match rb.send().await {
                            Ok(r) => {
                                // A request reached the server — clear any prior
                                // connect-failure streak.
                                self.http_connect_failures.store(0, Ordering::Relaxed);
                                r
                            }
                            Err(e) => {
                                // A connection-level failure (refused/reset/DNS —
                                // NOT a mid-body timeout, which is not is_connect)
                                // is real evidence the server is down. Tolerate a
                                // transient blip, but after a few in a row mark the
                                // client dead so status()/all_tools() stop
                                // advertising a server that isn't there.
                                if e.is_connect()
                                    && self.http_connect_failures.fetch_add(1, Ordering::Relaxed) + 1
                                        >= 3
                                {
                                    self.dead.store(true, Ordering::Relaxed);
                                }
                                return Err(AppError::ApiError(format!(
                                    "MCP '{}': HTTP request failed: {}",
                                    method,
                                    e.without_url()
                                )));
                            }
                        };

                        // The server typically mints this on `initialize`; once set,
                        // echo it on every later request on this connection.
                        if let Some(v) = resp
                            .headers()
                            .get("mcp-session-id")
                            .and_then(|h| h.to_str().ok())
                        {
                            *session_id.lock().await = Some(v.to_string());
                        }

                        let status = resp.status();
                        let content_type = resp
                            .headers()
                            .get("content-type")
                            .and_then(|v| v.to_str().ok())
                            .unwrap_or("")
                            .to_string();

                        if !status.is_success() {
                            // Session expired: per the Streamable HTTP spec a
                            // server MAY drop a session and MUST then 404 its stale
                            // id; the client MUST re-initialize WITHOUT a session id
                            // and retry. Do this exactly once (initialize itself is
                            // exempt, and clearing the id keeps re-init from
                            // 404-looping).
                            if status == reqwest::StatusCode::NOT_FOUND
                                && sid.is_some()
                                && method != "initialize"
                                && !reinit_attempted
                            {
                                reinit_attempted = true;
                                self.reinitialize().await?;
                                continue;
                            }
                            let body = resp.text().await.unwrap_or_default();
                            let snippet: String = body.chars().take(500).collect();
                            return Err(AppError::ApiError(format!(
                                "MCP '{}': HTTP {}: {}",
                                method,
                                status.as_u16(),
                                snippet
                            )));
                        }

                        return if content_type.starts_with("text/event-stream") {
                            drain_sse(
                                resp,
                                http,
                                url,
                                session_id,
                                protocol_version,
                                &self.tools_changed_tx,
                                Some(id),
                            )
                            .await
                            .unwrap_or_else(|| {
                                Err(AppError::ApiError(format!(
                                    "MCP '{}': stream closed without a response",
                                    method
                                )))
                            })
                        } else {
                            let body: Value = resp.json().await.map_err(|e| {
                                AppError::ApiError(format!(
                                    "MCP '{}': response parse: {}",
                                    method,
                                    e.without_url()
                                ))
                            })?;
                            extract_result_or_error(body)
                        };
                    }
                };
                // Dropping a reqwest future part-way is safe. If a Stop or the
                // timeout drops a re-initialize, reinit_pending stays set and the
                // next request finishes it before it is sent.
                let timed = tokio::time::timeout(Duration::from_secs(timeout_secs), fut);
                tokio::select! {
                    biased;
                    r = timed => match r {
                        Ok(r) => r,
                        Err(_) => Err(AppError::ApiError(format!(
                            "MCP '{}' timed out after {}s",
                            method, timeout_secs
                        ))),
                    },
                    _ = cancel::stop_signal(cancel) => {
                        self.send_cancelled(id);
                        Err(AppError::ApiError(MCP_STOPPED_IN_FLIGHT.into()))
                    }
                }
            }
        }
    }

    /// Start a fresh HTTP session: forget the old id, initialize, then send
    /// notifications/initialized. `reinit_pending` stays set until both went
    /// through, so a cut-short re-initialize is finished by the next request.
    async fn reinitialize(&self) -> Result<(), AppError> {
        let ClientIo::Http { session_id, .. } = &self.io else {
            return Ok(());
        };
        self.reinit_pending.store(true, Ordering::Relaxed);
        *session_id.lock().await = None;
        // Boxed: request -> request_cancellable -> this future would otherwise
        // be an infinitely-sized (recursive) async type.
        Box::pin(self.request("initialize", initialize_params())).await?;
        self.notify("notifications/initialized", json!({})).await?;
        self.reinit_pending.store(false, Ordering::Relaxed);
        Ok(())
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), AppError> {
        if self.dead.load(Ordering::Relaxed) {
            return Err(self.exited_error());
        }
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        match &self.io {
            ClientIo::Stdio { stdin } => {
                let line = format!("{}\n", serde_json::to_string(&msg)?);
                let mut stdin = stdin.lock().await;
                stdin.write_all(line.as_bytes()).await.map_err(AppError::from)?;
                stdin.flush().await.map_err(AppError::from)?;
                Ok(())
            }
            ClientIo::Http {
                http,
                url,
                session_id,
                protocol_version,
                headers,
            } => {
                let sid = session_id.lock().await.clone();
                let mut rb = http
                    .post(url.as_ref())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json, text/event-stream")
                    .json(&msg);
                for (k, v) in headers.iter() {
                    rb = rb.header(k, v);
                }
                if let Some(sid) = &sid {
                    rb = rb.header("Mcp-Session-Id", sid);
                }
                if let Some(ver) = protocol_version.lock().await.as_deref() {
                    rb = rb.header("MCP-Protocol-Version", ver);
                }
                let resp = rb
                    .send()
                    .await
                    .map_err(|e| {
                        AppError::ApiError(format!("MCP notify '{}': {}", method, e.without_url()))
                    })?;
                if !resp.status().is_success() {
                    return Err(AppError::ApiError(format!(
                        "MCP notify '{}': HTTP {}",
                        method,
                        resp.status().as_u16()
                    )));
                }
                Ok(())
            }
        }
    }

    /// Call a tool and return the raw `result` object.
    pub async fn call_tool_raw(
        &self,
        name: &str,
        args: Value,
        timeout_secs: u64,
        cancel: Option<oneshot::Receiver<()>>,
    ) -> Result<Value, AppError> {
        self.request_cancellable(
            "tools/call",
            json!({ "name": name, "arguments": args }),
            timeout_secs,
            cancel,
        )
        .await
    }

    /// Call a tool and return its text content. A tool-level failure is an MCP
    /// `result` with `isError: true` (NOT a JSON-RPC error), so we check that
    /// and surface it as an Err instead of feeding the error text back as a
    /// valid answer.
    ///
    /// Uses a longer timeout than the handshake/list requests (the caller
    /// passes it, from the server's preset): real tools proxy slow cloud APIs
    /// (Aruba Central reports, firmware queries) that legitimately run past
    /// 60s. `cancel` is the Stop signal (see `request_cancellable`).
    pub async fn call_tool(
        &self,
        name: &str,
        args: Value,
        timeout_secs: u64,
        cancel: Option<oneshot::Receiver<()>>,
    ) -> Result<String, AppError> {
        let res = self.call_tool_raw(name, args, timeout_secs, cancel).await?;
        // Extract text from content blocks: plain `text` blocks, embedded
        // resources carrying inline text, and placeholders for binary blocks
        // (dumping base64 image/audio at the model would burn its context).
        let text = res
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| {
                        if let Some(t) = b.get("text").and_then(|t| t.as_str()) {
                            return Some(t.to_string());
                        }
                        if let Some(t) = b
                            .get("resource")
                            .and_then(|r| r.get("text"))
                            .and_then(|t| t.as_str())
                        {
                            return Some(t.to_string());
                        }
                        match b.get("type").and_then(|t| t.as_str()) {
                            Some("image") => Some("[image content omitted]".to_string()),
                            Some("audio") => Some("[audio content omitted]".to_string()),
                            _ => None,
                        }
                    })
                    .collect::<Vec<_>>()
                    .join("\n")
            })
            .unwrap_or_default();

        if res.get("isError").and_then(|e| e.as_bool()).unwrap_or(false) {
            let msg = if text.trim().is_empty() {
                "tool reported an error".to_string()
            } else {
                text
            };
            return Err(AppError::ApiError(format!("tool '{}': {}", name, msg)));
        }

        if text.trim().is_empty() {
            // No text blocks — fall back to structuredContent (the 2025-06 spec's
            // machine-readable result), then to the raw result.
            let fallback = res.get("structuredContent").unwrap_or(&res);
            Ok(serde_json::to_string_pretty(fallback).unwrap_or_default())
        } else {
            Ok(text)
        }
    }
}

// ─── Manager (config store + running clients) ───

pub struct McpManager {
    store: McpConfigStore,
    creds: McpCreds,
    app_dir: PathBuf,
    clients: HashMap<String, McpClient>,
}

fn sanitize_filename(name: &str) -> String {
    use std::hash::{Hash, Hasher};
    let base: String = name
        .chars()
        .map(|c| if c.is_ascii_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    // Suffix a hash of the FULL name so distinct names that sanitize to the same
    // base (e.g. "central mcp" vs "central/mcp" -> "central_mcp") never share a
    // creds file. DefaultHasher uses fixed keys, so this is stable across runs.
    let mut h = std::collections::hash_map::DefaultHasher::new();
    name.hash(&mut h);
    format!("{}_{:016x}", base, h.finish())
}

impl McpManager {
    pub fn new(app_dir: PathBuf, creds: McpCreds) -> Self {
        Self {
            store: McpConfigStore::new(app_dir.clone()),
            creds,
            app_dir,
            clients: HashMap::new(),
        }
    }

    /// The credentials handle, to use AFTER the lock is released.
    pub fn creds(&self) -> McpCreds {
        self.creds.clone()
    }

    pub fn list_configs(&self) -> Vec<McpServerDef> {
        self.store.load()
    }

    /// Every web MCP server address GreenCLI knows, with the server's name:
    /// each saved http server's address, whatever its state (GreenCLI doesn't
    /// start web servers, so disconnecting one doesn't stop it), and the
    /// address each live http connection really uses (it differs after an edit
    /// that wasn't followed by a reconnect). A stdio server's leftover url
    /// doesn't count. Each comes as (name, url, connected): connected when a
    /// live connection uses that address.
    pub fn web_urls(&self) -> Vec<(String, String, bool)> {
        let live: Vec<(String, String)> = self
            .clients
            .iter()
            .filter_map(|(name, client)| client.web_url().map(|url| (name.clone(), url)))
            .collect();
        let mut urls: Vec<(String, String, bool)> = self
            .store
            .load()
            .into_iter()
            .filter(|d| d.transport == McpTransport::Http)
            .filter_map(|d| d.url.map(|url| (d.name, url)))
            .map(|(name, url)| {
                let connected = live.iter().any(|(n, u)| *n == name && *u == url);
                (name, url, connected)
            })
            .collect();
        for (name, url) in live {
            if !urls.iter().any(|(n, u, _)| *n == name && *u == url) {
                urls.push((name, url, true));
            }
        }
        urls
    }

    /// For the export: the read-only settings connect would add to each saved
    /// server whose writes are off (keyed by name). Servers with writes on are
    /// left out.
    pub fn export_pins(&self) -> HashMap<String, PinPlan> {
        self.store
            .load()
            .iter()
            .filter(|d| !d.writes_on())
            .map(|d| {
                let plan = match_preset(d, None).map_or(PinPlan::None, |m| plan_pins(d, m.id));
                (d.name.clone(), plan)
            })
            .collect()
    }

    pub fn save_config(&self, def: McpServerDef) -> Result<(), AppError> {
        self.store.upsert(def)
    }

    /// Why `from` can't be renamed to `to`, checked before anything moves.
    pub fn check_rename(&self, from: &str, to: &str) -> Result<(), AppError> {
        let all = self.store.load_checked()?;
        if all.iter().any(|d| d.name == to) {
            return Err(AppError::ApiError(format!(
                "An MCP server named '{}' already exists",
                to
            )));
        }
        if !all.iter().any(|d| d.name == from) {
            return Err(AppError::ApiError(format!("No MCP server named '{}'", from)));
        }
        Ok(())
    }

    /// Rename a server's config entry, the materialised creds file and any
    /// live client (so its tools stay routable without a reconnect). The
    /// stored credentials are moved by `rename_server` (the free function),
    /// outside the lock.
    pub fn rename_config(&mut self, from: &str, to: &str) -> Result<(), AppError> {
        if from == to {
            return Ok(());
        }
        self.check_rename(from, to)?;
        let mut all = self.store.load_checked()?;
        if let Some(def) = all.iter_mut().find(|d| d.name == from) {
            def.name = to.to_string();
        }
        self.store.save(&all)?;
        // A live client keeps its login file (deleted when it stops).
        if let Some(client) = self.clients.remove(from) {
            if let Ok(mut guard) = client.tools.lock() {
                for t in guard.iter_mut() {
                    t.server = to.to_string();
                }
            }
            self.clients.insert(to.to_string(), client);
        }
        Ok(())
    }

    /// Remove a server's config. The caller deletes its stored credentials
    /// first (outside the lock), takes the client and shuts it down outside
    /// the lock.
    pub fn remove_config_only(&self, name: &str) -> Result<(), AppError> {
        // Its login file goes with the client's shutdown.
        self.store.remove(name)
    }

    /// Load a server def and write its credentials (`creds`, read from the
    /// store before the lock) to a new 0600 login file (`CredsFile`, kept only
    /// while the server runs), injecting the credentials env var. With writes off, a recognised server also gets its preset's
    /// read-only pins. Cheap + non-blocking, so it runs under the (brief)
    /// manager lock; the spawn/handshake happens unlocked.
    pub fn resolve_connect_def(
        &self,
        name: &str,
        creds: Option<Zeroizing<String>>,
    ) -> Result<ResolvedDef, AppError> {
        let mut def = self
            .store
            .load()
            .into_iter()
            .find(|d| d.name == name)
            .ok_or_else(|| AppError::ApiError(format!("No MCP server named '{}'", name)))?;
        // Meaningless for Http: there's no process the app spawns to inject an
        // env var into — the server was already started separately.
        let mut creds_file = None;
        if def.transport == McpTransport::Stdio {
            if let Some(content) = creds.filter(|c| !c.is_empty()) {
                let file = CredsFile::write(&self.app_dir, name, content.as_bytes())?;
                let path = file.path().to_path_buf();
                creds_file = Some(Arc::new(file));
                let var = def
                    .credentials_env_var
                    .clone()
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or_else(|| "CREDS_PATH".to_string());
                def.env.insert(var, path.to_string_lossy().to_string());
            }
        }
        let writes_on = def.writes_on();
        let mut pins = PinPlan::None;
        if !writes_on {
            if let Some(found) = match_preset(&def, None) {
                pins = plan_pins(&def, found.id);
                apply_pins(&mut def, &pins);
            }
        }
        Ok(ResolvedDef {
            def,
            pins,
            writes_on,
            creds_file,
        })
    }

    /// Install a freshly-connected client, returning any displaced old one
    /// (shut it down OUTSIDE the lock). Connecting the new client first and
    /// swapping only on success means a failed reconnect leaves the old one up.
    pub fn install_client(&mut self, name: String, client: McpClient) -> Option<McpClient> {
        self.clients.insert(name, client)
    }

    /// Remove and return a live client (shut it down outside the lock).
    pub fn take_client(&mut self, name: &str) -> Option<McpClient> {
        self.clients.remove(name)
    }

    /// The names of the servers with a client now (live or dead), sorted.
    pub fn client_names(&self) -> Vec<String> {
        let mut names: Vec<String> = self.clients.keys().cloned().collect();
        names.sort();
        names
    }

    /// Detach every live client (for app-exit cleanup — shut them down outside
    /// the lock).
    pub fn take_all_clients(&mut self) -> Vec<McpClient> {
        self.clients.drain().map(|(_, c)| c).collect()
    }

    /// Every tool the AI may use, across every live server. Each is decorated
    /// by the policy (label, writes, access, preset); blocked tools are left
    /// out. `server` is always the clients-map key: a refresh after a rename
    /// rebuilds the tools with the old name (spawn_refresher keeps the name it
    /// was started with), so the key is the only reliable name.
    pub fn all_tools(&self) -> Vec<McpToolInfo> {
        let defs = self.store.load();
        let by_name: HashMap<&str, &McpServerDef> =
            defs.iter().map(|d| (d.name.as_str(), d)).collect();
        // Skip dead clients: advertising a crashed server's tools to the AI
        // just produces doomed tool calls.
        self.clients
            .iter()
            .filter(|(_, c)| !c.is_dead())
            .flat_map(|(key, c)| decorated_tools(key, by_name.get(key.as_str()).copied(), c))
            .filter(|t| t.blocked.is_none())
            .collect()
    }

    /// One tool of a live server, decorated like `all_tools` but returned even
    /// when blocked (with `blocked` set). No network call. None when the
    /// server isn't connected, its client is dead, or the tool isn't in its
    /// current list.
    pub fn tool_info(&self, server: &str, tool: &str) -> Option<McpToolInfo> {
        let client = self.clients.get(server).filter(|c| !c.is_dead())?;
        let defs = self.store.load();
        let def = defs.iter().find(|d| d.name == server);
        decorated_tools(server, def, client)
            .into_iter()
            .find(|t| t.name == tool)
    }

    /// How many of a server's tools the AI can use now.
    pub fn visible_tool_count(&self, server: &str) -> usize {
        self.all_tools().iter().filter(|t| t.server == server).count()
    }

    pub fn status(&self) -> Vec<Value> {
        self.store
            .load()
            .iter()
            .map(|d| {
                // A client whose process has exited is NOT connected, even if it
                // is still sitting in the map awaiting a reconnect.
                let live = self.clients.get(&d.name).filter(|c| !c.is_dead());
                let tools = live.map(|c| decorated_tools(&d.name, Some(d), c));
                let names: Option<Vec<&str>> = tools
                    .as_ref()
                    .map(|t| t.iter().map(|t| t.name.as_str()).collect());
                // Matches on the definition even while disconnected; once
                // connected the tool list is checked too.
                let found = match_preset(d, names.as_deref());
                let check = live.and_then(McpClient::access_check);
                let access = check.as_ref().map_or(AccessState::Unknown, |c| c.state);
                let hidden = tools
                    .as_ref()
                    .map_or(0, |t| t.iter().filter(|t| t.blocked.is_some()).count());
                let visible = tools.as_ref().map_or(0, |t| t.len()) - hidden;
                let pins = match live {
                    Some(c) => {
                        PinView::of(&c.pins, access::gates_confirmed_off(check.as_ref()))
                    }
                    None if !d.writes_on() => match match_preset(d, None) {
                        Some(m) => PinView::of(&plan_pins(d, m.id), false),
                        None => PinView::None,
                    },
                    None => PinView::None,
                };
                let writes = if d.writes_on() {
                    McpWrites::On
                } else {
                    McpWrites::Off
                };
                let mut item = json!({
                    "name": d.name,
                    "enabled": d.enabled,
                    "connected": live.is_some(),
                    "toolCount": visible,
                    "hiddenToolCount": hidden,
                    "preset": found.map(|m| json!({ "id": m.id, "label": preset_label(m.id) })),
                    "presetMismatch": found.is_some_and(|m| m.mismatch),
                    "writes": writes,
                    "writesSet": d.writes.is_some(),
                    "pins": pins,
                    "access": access,
                    "restartNeeded": live.is_some_and(|c| c.connected_writes_on != d.writes_on()),
                });
                if let Some(m) = found {
                    item["presetBy"] = json!(m.by);
                }
                item
            })
            .collect()
    }

    /// The caller handle and call timeout for a call GreenCLI allows, so the
    /// command can drop the manager lock before awaiting the tool round-trip.
    /// A refused call gets "Not run: " and the reason (policy::call_refusal).
    ///
    /// Dead clients are deliberately NOT filtered here: the caller's own dead
    /// check in `request()` yields the precise "server has exited — reconnect"
    /// error, which beats the generic "not connected" the command would emit.
    pub fn call_gate(
        &self,
        server: &str,
        tool: &str,
        args: &Value,
        read_only_agent: bool,
    ) -> Result<(McpCaller, u64), String> {
        let client = self
            .clients
            .get(server)
            .ok_or_else(|| format!("MCP server '{}' is not connected", server))?;
        let defs = self.store.load();
        let def = defs.iter().find(|d| d.name == server);
        let tools = client.tool_list();
        let p = client_policy(def, &tools, client);
        let found = tools.iter().find(|t| t.name == tool);
        if let Some(reason) = policy::call_refusal(&p, found, tool, args, read_only_agent, server) {
            return Err(format!("Not run: {}", reason));
        }
        Ok((client.caller(), call_timeout_secs(p.preset.map(|m| m.id))))
    }

    /// Turn writes on or off for a saved server. Takes effect at once for
    /// hiding and refusing (the policy reads the saved setting); the pins
    /// change on the next connect, which the settings page does right away.
    /// On is refused while the live login is read-only.
    pub fn set_writes(&self, name: &str, writes: McpWrites) -> Result<(), String> {
        let read_only = self
            .clients
            .get(name)
            .and_then(McpClient::access_check)
            .is_some_and(|c| c.state == AccessState::ReadOnly);
        if writes == McpWrites::On && read_only {
            return Err(format!(
                "Not run: {} login is read-only. Writes can't be turned on here.",
                name
            ));
        }
        self.store
            .update(name, |d| d.writes = Some(writes))
            .map(|_| ())
            .map_err(|e| e.to_string())
    }

    /// Turn the Junos plain-show opt-in on or off for a saved server.
    pub fn set_show_opt_in(&self, name: &str, on: bool) -> Result<(), AppError> {
        self.store.update(name, |d| d.show_opt_in = on).map(|_| ())
    }
}

/// A saved definition, ready to connect: credentials injected and, with
/// writes off, the preset's read-only pins applied.
pub struct ResolvedDef {
    pub def: McpServerDef,
    /// The pins applied (PinPlan::None when writes are on or there is no preset).
    pub pins: PinPlan,
    /// The writes setting the connection starts with.
    pub writes_on: bool,
    /// The login file the definition points at (stdio with a saved login).
    /// Dropping it deletes the file, so a failed connect leaves none behind.
    pub creds_file: Option<Arc<CredsFile>>,
}

/// The policy for one live client: its saved definition (None fails closed),
/// its tool names and its access_check answer.
fn client_policy(
    def: Option<&McpServerDef>,
    tools: &[McpToolInfo],
    client: &McpClient,
) -> ServerPolicy {
    let names: Vec<&str> = tools.iter().map(|t| t.name.as_str()).collect();
    policy::server_policy(def, &names, client.access_check().as_ref())
}

/// A client's tools, each decorated by the policy, with `server` set to `key`.
fn decorated_tools(key: &str, def: Option<&McpServerDef>, client: &McpClient) -> Vec<McpToolInfo> {
    let tools = client.tool_list();
    let p = client_policy(def, &tools, client);
    tools
        .into_iter()
        .map(|mut t| {
            t.server = key.to_string();
            policy::decorate(&p, t)
        })
        .collect()
}

/// The `mcp_connect` command without Tauri: resolve the definition under a
/// brief lock, connect unlocked, then swap the client in. Connecting the new
/// client first means a failed reconnect leaves the old one up. Returns how
/// many tools the AI can use.
///
/// `web_refused` says why a web (URL) server may not connect right now, or
/// None (GreenCLI: not while Casper answers). It is asked before connecting
/// and again under the manager lock before the client goes in, so one that
/// starts meanwhile is caught too.
pub async fn connect_server(
    manager: &Mutex<McpManager>,
    name: &str,
    web_refused: &(dyn Fn() -> Option<String> + Send + Sync),
) -> Result<usize, String> {
    // The stored credentials are read with the lock released: the store can
    // be slow or ask the user, and must not hold up every MCP command.
    let creds = manager.lock().await.creds();
    let owned = name.to_string();
    let stored = secret_store::blocking(move || creds.get(&owned)).await;
    let resolved = {
        let mgr = manager.lock().await;
        mgr.resolve_connect_def(name, stored.as_ref().ok().cloned().flatten())
            .map_err(|e| e.to_string())?
    };
    // Only a stdio server is given a credentials file, so only it needs the
    // store. Starting it without its login would fail in a less clear way.
    if resolved.def.transport == McpTransport::Stdio {
        stored?;
    }
    // Only an http server is a web server: a stdio server keeps a url the form
    // left behind, but GreenCLI starts it over pipes.
    let web = resolved.def.transport == McpTransport::Http;
    if web {
        if let Some(why) = web_refused() {
            return Err(why);
        }
    }
    let mut client = McpClient::connect(&resolved.def, resolved.creds_file.clone())
        .await
        .map_err(|e| {
            // Failed: the login file goes now, not when the reader sees EOF.
            if let Some(file) = &resolved.creds_file {
                file.remove();
            }
            e.to_string()
        })?;
    client.pins = resolved.pins;
    client.connected_writes_on = resolved.writes_on;
    let installed = {
        let mut mgr = manager.lock().await;
        let refused = if web { web_refused() } else { None };
        match refused {
            Some(why) => Err((why, client)),
            None => {
                let old = mgr.install_client(name.to_string(), client);
                Ok((old, mgr.visible_tool_count(name)))
            }
        }
    };
    let (old, count) = match installed {
        Ok(done) => done,
        Err((why, client)) => {
            client.shutdown().await;
            return Err(why);
        }
    };
    if let Some(old) = old {
        old.shutdown().await;
    }
    Ok(count)
}

/// The `mcp_rename_server` command without Tauri. The config is checked
/// first; the stored credentials are copied to the new name and read back
/// (outside the lock); then the config and live client are renamed under the
/// lock; only then is the old entry deleted. A failure on the way leaves the
/// old name with its credentials as it was.
pub async fn rename_server(manager: &Mutex<McpManager>, from: &str, to: &str) -> Result<(), String> {
    if from == to {
        return Ok(());
    }
    let creds = {
        let mgr = manager.lock().await;
        mgr.check_rename(from, to).map_err(|e| e.to_string())?;
        mgr.creds()
    };
    let (f, t, c) = (from.to_string(), to.to_string(), creds.clone());
    let copied = secret_store::blocking(move || c.copy(&f, &t)).await?;
    let renamed = {
        let mut mgr = manager.lock().await;
        mgr.rename_config(from, to).map_err(|e| e.to_string())
    };
    // Clean up the name the credentials no longer belong to: the old one
    // after a rename, the new copy after a failed one.
    let stale = match (&renamed, copied) {
        (Ok(()), true) => Some(from.to_string()),
        (Err(_), true) => Some(to.to_string()),
        // Nothing moved: a login left under the new name by a server deleted
        // long ago must not come back with this one.
        (Ok(()), false) => Some(to.to_string()),
        (Err(_), false) => None,
    };
    if let Some(stale) = stale {
        let c = creds.clone();
        let s2 = stale.clone();
        if let Err(e) = secret_store::blocking(move || c.delete(&s2)).await {
            log::warn!("Couldn't delete the MCP login saved as '{}': {}", stale, e);
        }
    }
    renamed
}

/// The `mcp_call` command without Tauri: check the call under a brief lock
/// (McpManager::call_gate), then run it unlocked, stoppable through `calls`
/// when the AI panel gave it an id. A Stop gives one of the two MCP_STOPPED_*
/// texts and a refusal "Not run: ...", both unprefixed, so the panel can tell
/// the model exactly what happened.
pub async fn run_call(
    manager: &Mutex<McpManager>,
    calls: &CallRegistry,
    server: &str,
    tool: &str,
    args: Value,
    call_id: Option<&str>,
    read_only_agent: bool,
) -> Result<String, String> {
    let (caller, timeout_secs) = {
        let mgr = manager.lock().await;
        mgr.call_gate(server, tool, &args, read_only_agent)?
    };
    let (rx, owned) = match call_id.map(|id| calls.register(id)) {
        None => (None, false),
        Some(Err(Cancelled)) => return Err(MCP_STOPPED_NOT_SENT.to_string()),
        Some(Ok(rx)) => {
            // Ok(None): the id was unusable or already live; this call runs
            // without Stop and must not finish() the other call's entry.
            let owned = rx.is_some();
            (rx, owned)
        }
    };
    let res = caller.call_tool(tool, args, timeout_secs, rx).await;
    if let (true, Some(id)) = (owned, call_id) {
        calls.finish(id);
    }
    res.map_err(|e| match e {
        AppError::ApiError(m) if m == MCP_STOPPED_IN_FLIGHT || m == MCP_STOPPED_NOT_SENT => m,
        other => other.to_string(),
    })
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    fn temp_dir() -> PathBuf {
        let mut p = std::env::temp_dir();
        p.push(format!("greencli-mcp-test-{}", rand::random::<u64>()));
        std::fs::create_dir_all(&p).unwrap();
        p
    }

    /// A manager on the 1.9 files in `dir` (no system password store).
    fn manager(dir: PathBuf) -> McpManager {
        let store = Arc::new(SecretStore::files(&dir));
        McpManager::new(dir, McpCreds::new(store))
    }

    /// A manager on an in-memory password store.
    fn mem_manager(mem: &Arc<crate::secret_store::mem::MemBackend>) -> McpManager {
        let store = Arc::new(SecretStore::os_for_tests(mem.clone()));
        McpManager::new(temp_dir(), McpCreds::new(store))
    }

    fn def(name: &str, command: &str, args: &[&str]) -> McpServerDef {
        McpServerDef {
            name: name.into(),
            transport: McpTransport::Stdio,
            command: command.into(),
            args: args.iter().map(|a| a.to_string()).collect(),
            env: HashMap::new(),
            cwd: None,
            url: None,
            credentials_env_var: None,
            headers: HashMap::new(),
            enabled: true,
            writes: None,
            show_opt_in: false,
        }
    }

    fn tool(server: &str, name: &str) -> McpToolInfo {
        tool_from_json(server, &json!({ "name": name })).unwrap()
    }

    fn read_tool(server: &str, name: &str) -> McpToolInfo {
        tool_from_json(
            server,
            &json!({ "name": name, "annotations": { "readOnlyHint": true } }),
        )
        .unwrap()
    }

    fn access(state: &str) -> AccessCheck {
        access::parse_access_check(&json!({ "structuredContent": {
            "contract": access::ACCESS_CONTRACT,
            "products": [{ "product": "central", "access": state }]
        } }))
    }

    /// A client with a fixed tool list and no server behind it.
    fn fake_client(server: &str, tools: Vec<McpToolInfo>) -> McpClient {
        let (tools_changed_tx, _rx) = mpsc::unbounded_channel();
        let caller = McpCaller {
            server: Arc::from(server),
            io: ClientIo::Http {
                http: reqwest::Client::new(),
                url: Arc::from("http://127.0.0.1:9/mcp"),
                session_id: Arc::new(Mutex::new(None)),
                protocol_version: Arc::new(Mutex::new(None)),
                headers: Arc::new(HashMap::new()),
            },
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(0)),
            tools_changed_tx,
            dead: Arc::new(AtomicBool::new(false)),
            http_connect_failures: Arc::new(AtomicU32::new(0)),
            reinit_pending: Arc::new(AtomicBool::new(false)),
        };
        McpClient {
            child: None,
            creds_file: None,
            caller,
            tools: Arc::new(std::sync::Mutex::new(tools)),
            server_info: Value::Null,
            reader: tokio::spawn(async {}),
            refresher: tokio::spawn(async {}),
            pins: PinPlan::None,
            connected_writes_on: false,
            access: Arc::new(std::sync::Mutex::new(None)),
        }
    }

    /// A stdio client with a real child process behind it (a shell that
    /// reads stdin into /dev/null until it closes) and no handshake: for
    /// tests of what happens to the child (shutdown, exit). See
    /// fake_child_pid.
    #[cfg(unix)]
    pub(crate) fn fake_stdio_client(server: &str) -> McpClient {
        let mut child = Command::new("sh")
            .args(["-c", "cat >/dev/null"])
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .kill_on_drop(true)
            .spawn()
            .expect("spawn sh");
        let stdin = child.stdin.take().expect("piped stdin");
        let mut client = fake_client(server, Vec::new());
        client.caller.io = ClientIo::Stdio {
            stdin: Arc::new(Mutex::new(stdin)),
        };
        client.child = Some(child);
        client
    }

    /// A fake_stdio_client that runs with a login file, with the real stdio
    /// reader on the child's stdout (so the child exiting is seen as EOF).
    #[cfg(unix)]
    pub(crate) fn fake_stdio_client_with_creds(server: &str, creds: Arc<CredsFile>) -> McpClient {
        let mut client = fake_stdio_client(server);
        let stdout = client
            .child
            .as_mut()
            .and_then(|c| c.stdout.take())
            .expect("piped stdout");
        let ClientIo::Stdio { stdin } = client.caller.io.clone() else {
            unreachable!("a stdio client");
        };
        client.reader = spawn_stdio_reader(
            stdout,
            client.caller.pending.clone(),
            client.caller.dead.clone(),
            stdin,
            client.caller.tools_changed_tx.clone(),
            Some(creds.clone()),
        );
        client.creds_file = Some(creds);
        client
    }

    /// A saved stdio server that really connects: a small Perl script (a
    /// shell is refused as an MCP command) that answers each request, with
    /// no tools.
    #[cfg(unix)]
    pub(crate) fn fake_mcp_server_def(name: &str) -> McpServerDef {
        const SERVER: &str = r#"$| = 1;
while (<STDIN>) {
  next unless /"id":(\d+)/;
  my $id = $1;
  my $r = '{}';
  $r = '{"protocolVersion":"2025-06-18","capabilities":{},"serverInfo":{"name":"fake","version":"1"}}' if /"method":"initialize"/;
  $r = '{"tools":[]}' if /"method":"tools\/list"/;
  print qq({"jsonrpc":"2.0","id":$id,"result":$r}\n);
}"#;
        def(name, "perl", &["-e", SERVER])
    }

    /// A login file for `name` in `app_dir`, as a connect writes it.
    #[cfg(unix)]
    pub(crate) fn test_creds_file(app_dir: &std::path::Path, name: &str) -> Arc<CredsFile> {
        Arc::new(CredsFile::write(app_dir, name, b"client_secret: s3cr3t").unwrap())
    }

    /// The child process id of a fake_stdio_client.
    #[cfg(unix)]
    pub(crate) fn fake_child_pid(client: &McpClient) -> u32 {
        client
            .child
            .as_ref()
            .and_then(|c| c.id())
            .expect("a running child")
    }

    /// A tiny MCP-over-HTTP server: answers every POST with a JSON result (and
    /// a fresh Mcp-Session-Id on initialize), 202 for notifications, and
    /// records "method sid" for each request.
    async fn tiny_http_server() -> (String, Arc<std::sync::Mutex<Vec<String>>>) {
        use tokio::io::{AsyncReadExt, AsyncWriteExt};
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let seen = Arc::new(std::sync::Mutex::new(Vec::new()));
        let log = seen.clone();
        tokio::spawn(async move {
            while let Ok((mut sock, _)) = listener.accept().await {
                let log = log.clone();
                tokio::spawn(async move {
                    let mut buf: Vec<u8> = Vec::new();
                    loop {
                        let head_end = loop {
                            if let Some(i) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                                break i + 4;
                            }
                            let mut chunk = [0u8; 4096];
                            match sock.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                            }
                        };
                        let head = String::from_utf8_lossy(&buf[..head_end]).to_lowercase();
                        let len: usize = head
                            .lines()
                            .find_map(|l| l.strip_prefix("content-length:"))
                            .and_then(|v| v.trim().parse().ok())
                            .unwrap_or(0);
                        let sid = head
                            .lines()
                            .find_map(|l| l.strip_prefix("mcp-session-id:"))
                            .map(|v| v.trim().to_string())
                            .unwrap_or_else(|| "-".into());
                        while buf.len() < head_end + len {
                            let mut chunk = [0u8; 4096];
                            match sock.read(&mut chunk).await {
                                Ok(0) | Err(_) => return,
                                Ok(n) => buf.extend_from_slice(&chunk[..n]),
                            }
                        }
                        let body: Value =
                            serde_json::from_slice(&buf[head_end..head_end + len]).unwrap_or(Value::Null);
                        buf.drain(..head_end + len);
                        let method = body["method"].as_str().unwrap_or("").to_string();
                        log.lock().unwrap().push(format!("{method} {sid}"));
                        let reply = if body.get("id").is_none() {
                            "HTTP/1.1 202 Accepted\r\nContent-Length: 0\r\n\r\n".to_string()
                        } else {
                            let result = if method == "initialize" {
                                json!({ "protocolVersion": MCP_PROTOCOL_VERSION, "capabilities": {} })
                            } else {
                                json!({ "tools": [] })
                            };
                            let text = json!({ "jsonrpc": "2.0", "id": body["id"], "result": result }).to_string();
                            let extra = if method == "initialize" { "Mcp-Session-Id: s2\r\n" } else { "" };
                            format!(
                                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\n{extra}Content-Length: {}\r\n\r\n{text}",
                                text.len()
                            )
                        };
                        if sock.write_all(reply.as_bytes()).await.is_err() {
                            return;
                        }
                    }
                });
            }
        });
        (url, seen)
    }

    #[tokio::test]
    async fn a_cut_short_reinitialize_is_finished_by_the_next_request() {
        let (url, seen) = tiny_http_server().await;
        let (tools_changed_tx, _rx) = mpsc::unbounded_channel();
        let caller = McpCaller {
            server: Arc::from("s"),
            io: ClientIo::Http {
                http: reqwest::Client::new(),
                url: Arc::from(url.as_str()),
                session_id: Arc::new(Mutex::new(None)),
                protocol_version: Arc::new(Mutex::new(None)),
                headers: Arc::new(HashMap::new()),
            },
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_id: Arc::new(Mutex::new(0)),
            tools_changed_tx,
            dead: Arc::new(AtomicBool::new(false)),
            http_connect_failures: Arc::new(AtomicU32::new(0)),
            // A Stop dropped the re-initialize after the old id was cleared.
            reinit_pending: Arc::new(AtomicBool::new(true)),
        };
        caller.request("tools/list", json!({})).await.unwrap();
        assert_eq!(
            *seen.lock().unwrap(),
            vec![
                "initialize -".to_string(),
                "notifications/initialized s2".to_string(),
                "tools/list s2".to_string(),
            ]
        );
        assert!(!caller.reinit_pending.load(Ordering::Relaxed));
        caller.request("tools/list", json!({})).await.unwrap();
        assert_eq!(seen.lock().unwrap().len(), 4);
    }

    // ─── tools/list parsing ───

    #[test]
    fn tool_from_json_keeps_annotations_and_meta() {
        let t = tool_from_json(
            "s",
            &json!({
                "name": "get_device",
                "description": "Get one device",
                "inputSchema": { "type": "object", "properties": { "serial": { "type": "string" } } },
                "annotations": { "readOnlyHint": true },
                "_meta": { "casper/safety": "diagnostic" }
            }),
        )
        .unwrap();
        assert_eq!(t.description, "Get one device");
        assert_eq!(t.annotations, Some(json!({ "readOnlyHint": true })));
        assert_eq!(t.meta, Some(json!({ "casper/safety": "diagnostic" })));
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["_meta"], json!({ "casper/safety": "diagnostic" }));
        assert!(v.get("meta").is_none());
    }

    #[test]
    fn tool_from_json_drops_non_object_hints() {
        let t = tool_from_json("s", &json!({ "name": "x", "annotations": true, "_meta": [1] }))
            .unwrap();
        assert!(t.annotations.is_none());
        assert!(t.meta.is_none());
    }

    #[test]
    fn tool_from_json_needs_a_name() {
        assert!(tool_from_json("s", &json!({ "description": "no name" })).is_none());
        assert!(tool_from_json("s", &json!({ "name": "" })).is_none());
        assert!(tool_from_json("s", &json!({ "name": 7 })).is_none());
    }

    #[test]
    fn tool_from_json_forces_an_object_schema() {
        assert_eq!(tool("s", "x").input_schema, json!({ "type": "object" }));
        let t = tool_from_json("s", &json!({ "name": "x", "inputSchema": { "properties": {} } }))
            .unwrap();
        assert_eq!(t.input_schema, json!({ "type": "object", "properties": {} }));
        let t = tool_from_json("s", &json!({ "name": "x", "inputSchema": { "type": "string" } }))
            .unwrap();
        assert_eq!(t.input_schema, json!({ "type": "object" }));
        let t = tool_from_json("s", &json!({ "name": "x", "inputSchema": "nope" })).unwrap();
        assert_eq!(t.input_schema, json!({ "type": "object" }));
    }

    #[test]
    fn dedupe_drops_every_copy_of_a_repeated_name() {
        let tools = vec![tool("s", "a"), tool("s", "b"), tool("s", "a"), tool("s", "c")];
        let names: Vec<String> = dedupe_tools("s", tools).into_iter().map(|t| t.name).collect();
        assert_eq!(names, vec!["b", "c"]);
    }

    #[test]
    fn tool_info_serialises_camel_case_without_empty_fields() {
        let v = serde_json::to_value(tool("s", "x")).unwrap();
        assert!(v.get("inputSchema").is_some());
        assert!(v.get("preset").is_none());
        assert!(v.get("showOptIn").is_none());
        assert!(v.get("annotations").is_none());
        let mut t = tool("s", "x");
        t.preset = Some(PresetId::JunosMcpServer);
        t.show_opt_in = true;
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["preset"], "junos-mcp-server");
        assert_eq!(v["showOptIn"], true);
        let back: McpToolInfo = serde_json::from_value(v).unwrap();
        assert_eq!(back.preset, Some(PresetId::JunosMcpServer));
    }

    // ─── protocol ───

    #[test]
    fn negotiated_version_echoes_the_server() {
        let v = |init: Value| negotiated_version(&init);
        assert_eq!(v(json!({ "protocolVersion": "2025-03-26" })), "2025-03-26");
        assert_eq!(v(json!({ "protocolVersion": "2099-01-01" })), "2099-01-01");
        assert_eq!(v(json!({})), "2024-11-05");
        assert_eq!(v(json!({ "protocolVersion": "" })), "2024-11-05");
        assert_eq!(v(json!({ "protocolVersion": 5 })), "2024-11-05");
    }

    #[test]
    fn initialize_asks_for_2025_06_18() {
        assert_eq!(initialize_params()["protocolVersion"], "2025-06-18");
    }

    // ─── Stop never cuts a stdio line ───

    #[tokio::test]
    async fn send_then_wait_writes_the_whole_line_before_a_stop() {
        use tokio::io::AsyncReadExt;
        let (writer, mut reader) = tokio::io::duplex(16);
        let writer = Arc::new(Mutex::new(writer));
        let mut line = vec![b'x'; 1023];
        line.push(b'\n');
        let (tx, rx) = oneshot::channel();
        let w = writer.clone();
        let sent = line.clone();
        let task = tokio::spawn(async move {
            send_then_wait(&w, &sent, std::future::pending::<()>(), Some(rx)).await
        });
        // Stop before the reader has drained anything: the write is stuck on
        // the 16-byte pipe, and must not give up part-way.
        tx.send(()).unwrap();
        tokio::time::sleep(Duration::from_millis(50)).await;
        assert!(!task.is_finished(), "returned before the line was written");
        let mut got = vec![0u8; line.len()];
        reader.read_exact(&mut got).await.unwrap();
        let out = task.await.unwrap().unwrap();
        assert_eq!(out, Err(Cancelled));
        assert_eq!(got, line);
        assert_eq!(got.last(), Some(&b'\n'));
        // Nothing more than the one line.
        drop(writer);
        let mut rest = Vec::new();
        reader.read_to_end(&mut rest).await.unwrap();
        assert!(rest.is_empty());
    }

    #[tokio::test]
    async fn send_then_wait_prefers_an_answer_that_is_already_here() {
        let (writer, _reader) = tokio::io::duplex(64);
        let writer = Mutex::new(writer);
        let (tx, rx) = oneshot::channel();
        tx.send(()).unwrap();
        let out = send_then_wait(&writer, b"{}\n", async { 7 }, Some(rx))
            .await
            .unwrap();
        assert_eq!(out, Ok(7));
    }

    // ─── config store ───

    #[test]
    fn upsert_keeps_the_opt_in_for_the_same_program() {
        let store = McpConfigStore::new(temp_dir());
        store.upsert(def("junos", "python3", &["jmcp.py"])).unwrap();
        store.update("junos", |d| d.show_opt_in = true).unwrap();
        // An env-only change (a rotated token) keeps it.
        let mut same = def("junos", "python3 ", &["jmcp.py"]);
        same.env.insert("TOKEN".into(), "new".into());
        store.upsert(same).unwrap();
        assert!(store.load()[0].show_opt_in);
        assert_eq!(store.load()[0].env["TOKEN"], "new");
    }

    #[test]
    fn upsert_resets_the_opt_in_when_the_program_changes() {
        type Change = Box<dyn Fn(&mut McpServerDef)>;
        let changes: Vec<Change> = vec![
            Box::new(|d| d.command = "python3.12".into()),
            Box::new(|d| d.args.push("--debug".into())),
            Box::new(|d| d.cwd = Some("/other".into())),
            Box::new(|d| d.transport = McpTransport::Http),
        ];
        for change in changes {
            let store = McpConfigStore::new(temp_dir());
            store.upsert(def("junos", "python3", &["jmcp.py"])).unwrap();
            store.update("junos", |d| d.show_opt_in = true).unwrap();
            let mut changed = def("junos", "python3", &["jmcp.py"]);
            change(&mut changed);
            changed.show_opt_in = true; // even if the caller sends true
            store.upsert(changed).unwrap();
            assert!(!store.load()[0].show_opt_in);
        }
    }

    #[test]
    fn a_leftover_field_of_the_other_transport_keeps_writes_on() {
        let store = McpConfigStore::new(temp_dir());
        // A stdio server saved earlier with a URL the form left behind.
        let mut old = def("junos", "python3", &["jmcp.py"]);
        old.url = Some("http://127.0.0.1:8010/mcp".into());
        store.upsert(old).unwrap();
        store
            .update("junos", |d| {
                d.writes = Some(McpWrites::On);
                d.show_opt_in = true;
            })
            .unwrap();
        // The form now saves only the stdio fields: an env edit keeps writes on.
        let mut edit = def("junos", "python3", &["jmcp.py"]);
        edit.env.insert("TOKEN".into(), "new".into());
        store.upsert(edit).unwrap();
        let saved = &store.load()[0];
        assert!(saved.writes_on());
        assert!(saved.show_opt_in);
        // The same for an http server with a leftover command.
        let store = McpConfigStore::new(temp_dir());
        let mut web = def("web", "uvx", &["old-server"]);
        web.transport = McpTransport::Http;
        web.url = Some("https://mcp.example.com/mcp".into());
        store.upsert(web.clone()).unwrap();
        store
            .update("web", |d| d.writes = Some(McpWrites::On))
            .unwrap();
        web.command = String::new();
        web.args.clear();
        web.headers.insert("Authorization".into(), "Bearer new".into());
        store.upsert(web.clone()).unwrap();
        assert!(store.load()[0].writes_on());
        // A new URL still turns writes off.
        web.url = Some("https://other.example.com/mcp".into());
        store.upsert(web).unwrap();
        assert!(!store.load()[0].writes_on());
    }

    #[test]
    fn same_program_trims_and_treats_none_as_empty() {
        let mut a = def("h", "", &[]);
        a.transport = McpTransport::Http;
        a.url = Some(" http://x/mcp ".into());
        let mut b = a.clone();
        b.url = Some("http://x/mcp".into());
        assert!(same_program(&a, &b));
        b.url = Some("http://y/mcp".into());
        assert!(!same_program(&a, &b));
        let mut c = def("c", "uvx", &[]);
        let mut d = c.clone();
        c.cwd = Some("  ".into());
        d.cwd = None;
        assert!(same_program(&c, &d));
        d.headers.insert("Authorization".into(), "Bearer new".into());
        assert!(same_program(&c, &d));
    }

    #[test]
    fn a_new_server_starts_with_the_opt_in_off() {
        let store = McpConfigStore::new(temp_dir());
        let mut d = def("new", "uvx", &["x"]);
        d.show_opt_in = true;
        store.upsert(d).unwrap();
        assert!(!store.load()[0].show_opt_in);
    }

    #[test]
    fn legacy_and_odd_opt_in_values_load_false() {
        let dir = temp_dir();
        std::fs::write(
            dir.join("mcp_servers.json"),
            r#"[{"name":"old","command":"uvx","args":[]},
                {"name":"odd","command":"uvx","args":[],"showOptIn":"yes"},
                {"name":"on","command":"uvx","args":[],"showOptIn":true}]"#,
        )
        .unwrap();
        let store = McpConfigStore::new(dir);
        let all = store.load_checked().unwrap();
        assert_eq!(all.len(), 3);
        assert!(!all[0].show_opt_in);
        assert!(!all[1].show_opt_in);
        assert!(all[2].show_opt_in);
        // false is not written out at all.
        let v = serde_json::to_value(&all[0]).unwrap();
        assert!(v.get("showOptIn").is_none());
    }

    #[test]
    fn update_errors_on_an_unknown_name() {
        let store = McpConfigStore::new(temp_dir());
        store.upsert(def("a", "uvx", &[])).unwrap();
        let err = store.update("nope", |d| d.show_opt_in = true).unwrap_err();
        assert!(err.to_string().contains("No MCP server named 'nope'"));
        let updated = store.update("a", |d| d.show_opt_in = true).unwrap();
        assert!(updated.show_opt_in);
    }

    #[test]
    fn a_corrupt_file_is_never_overwritten() {
        let dir = temp_dir();
        let path = dir.join("mcp_servers.json");
        let bytes = b"[{\"name\":\"a\",\"command\":\"uvx\"},".to_vec();
        std::fs::write(&path, &bytes).unwrap();
        let store = McpConfigStore::new(dir);
        let err = store.upsert(def("b", "uvx", &[])).unwrap_err();
        assert!(err.to_string().contains("couldn't read mcp_servers.json"));
        assert!(store.remove("a").is_err());
        assert!(store.update("a", |d| d.enabled = false).is_err());
        assert_eq!(std::fs::read(&path).unwrap(), bytes);
        // Read-only callers still get an empty list.
        assert!(store.load().is_empty());
    }

    #[test]
    fn a_missing_file_is_an_empty_list() {
        let store = McpConfigStore::new(temp_dir());
        assert!(store.load_checked().unwrap().is_empty());
    }

    // ─── manager ───

    #[tokio::test]
    async fn web_urls_cover_saved_and_live_web_servers_only() {
        let mut mgr = manager(temp_dir());
        let mut web = def("web", "", &[]);
        web.transport = McpTransport::Http;
        web.url = Some("https://mcp.example.com/mcp".into());
        mgr.save_config(web).unwrap();
        // A stdio server with a url the form left behind is not a web server.
        let mut left = def("left", "uvx", &["x"]);
        left.url = Some("http://127.0.0.1:8000/mcp".into());
        mgr.save_config(left).unwrap();
        assert_eq!(
            mgr.web_urls(),
            vec![(
                "web".to_string(),
                "https://mcp.example.com/mcp".to_string(),
                false
            )]
        );
        // "web" was edited to a remote address but is still connected to the old one.
        mgr.install_client("web".into(), fake_client("web", vec![]));
        assert_eq!(
            mgr.web_urls(),
            vec![
                (
                    "web".to_string(),
                    "https://mcp.example.com/mcp".to_string(),
                    false
                ),
                ("web".to_string(), "http://127.0.0.1:9/mcp".to_string(), true),
            ]
        );
        // Connected to the saved address: that one is marked connected.
        let mut web = def("web", "", &[]);
        web.transport = McpTransport::Http;
        web.url = Some("http://127.0.0.1:9/mcp".into());
        mgr.save_config(web).unwrap();
        assert_eq!(
            mgr.web_urls(),
            vec![("web".to_string(), "http://127.0.0.1:9/mcp".to_string(), true)]
        );
    }

    #[tokio::test]
    async fn all_tools_reports_the_map_key_after_a_rename() {
        let mut mgr = manager(temp_dir());
        mgr.save_config(def("old", "uvx", &["x"])).unwrap();
        mgr.install_client("old".into(), fake_client("old", vec![tool("old", "get_device")]));
        mgr.rename_config("old", "new").unwrap();
        // A tools/list_changed refresh rebuilds the list with the name the
        // refresher was started with.
        if let Some(c) = mgr.clients.get("new") {
            for t in c.tools.lock().unwrap().iter_mut() {
                t.server = "old".into();
            }
        }
        let all = mgr.all_tools();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].server, "new");
        assert_eq!(mgr.tool_info("new", "get_device").unwrap().server, "new");
        assert!(mgr.tool_info("old", "get_device").is_none());
        assert!(mgr.tool_info("new", "nope").is_none());
    }

    #[tokio::test]
    async fn a_client_without_a_definition_fails_closed() {
        let mut mgr = manager(temp_dir());
        let tools = vec![
            read_tool("ghost", "find_tool"),
            read_tool("ghost", "invoke_read_tool"),
            tool("ghost", "invoke_tool"),
        ];
        mgr.install_client("ghost".into(), fake_client("ghost", tools));
        // The preset still comes from the tools, but every tool is blocked.
        let t = mgr.tool_info("ghost", "find_tool").unwrap();
        assert_eq!(t.preset, Some(PresetId::HpeNetworkingMcp));
        assert!(!t.show_opt_in);
        assert_eq!(t.writes, Some(McpWrites::Off));
        assert_eq!(t.blocked, Some(access::no_definition_reason("ghost")));
        assert!(mgr.all_tools().is_empty());
        let err = mgr.call_gate("ghost", "find_tool", &json!({}), false).err().unwrap();
        assert_eq!(
            err,
            "Not run: ghost has no saved settings. Reconnect it in Settings → MCP Servers."
        );
        // Not saved, so not listed in status.
        assert!(mgr.status().is_empty());
    }

    #[tokio::test]
    async fn a_dead_client_offers_nothing() {
        let mut mgr = manager(temp_dir());
        mgr.save_config(def("s", "uvx", &[])).unwrap();
        let client = fake_client("s", vec![tool("s", "get_x")]);
        client.caller.dead.store(true, Ordering::Relaxed);
        mgr.install_client("s".into(), client);
        assert!(mgr.all_tools().is_empty());
        assert!(mgr.tool_info("s", "get_x").is_none());
        assert_eq!(mgr.status()[0]["connected"], false);
    }

    #[tokio::test]
    async fn listing_copies_the_opt_in_and_status_names_the_preset() {
        let mut mgr = manager(temp_dir());
        mgr.save_config(def("srx", "python3", &["jmcp.py"])).unwrap();
        mgr.set_show_opt_in("srx", true).unwrap();
        // Disconnected: matched by the definition.
        let st = mgr.status();
        assert_eq!(st[0]["preset"], json!({ "id": "junos-mcp-server", "label": "Junos" }));
        assert_eq!(st[0]["presetBy"], "definition");
        assert_eq!(st[0]["presetMismatch"], false);
        assert_eq!(st[0]["connected"], false);
        // Connected without the Junos signature tools: a mismatch.
        mgr.install_client("srx".into(), fake_client("srx", vec![tool("srx", "get_router_list")]));
        let st = mgr.status();
        assert_eq!(st[0]["presetMismatch"], true);
        assert_eq!(st[0]["toolCount"], 1);
        let t = mgr.tool_info("srx", "get_router_list").unwrap();
        assert_eq!(t.preset, Some(PresetId::JunosMcpServer));
        assert!(t.show_opt_in);
        let (_, timeout) = mgr.call_gate("srx", "get_router_list", &json!({}), false).unwrap();
        assert_eq!(timeout, 400);
        assert_eq!(
            mgr.call_gate("other", "x", &json!({}), false).err().unwrap(),
            "MCP server 'other' is not connected"
        );
        // A plain server has no preset.
        mgr.save_config(def("plain", "uvx", &["x"])).unwrap();
        let st = mgr.status();
        let plain = st.iter().find(|s| s["name"] == "plain").unwrap();
        assert!(plain["preset"].is_null());
        assert!(plain.get("presetBy").is_none());
        assert!(mgr.set_show_opt_in("missing", true).is_err());
    }

    #[tokio::test]
    async fn rename_keeps_every_field() {
        let mut mgr = manager(temp_dir());
        mgr.save_config(def("a", "python3", &["jmcp.py"])).unwrap();
        mgr.set_show_opt_in("a", true).unwrap();
        mgr.set_writes("a", McpWrites::On).unwrap();
        mgr.rename_config("a", "b").unwrap();
        let all = mgr.list_configs();
        assert_eq!(all.len(), 1);
        assert_eq!(all[0].name, "b");
        assert!(all[0].show_opt_in);
        assert_eq!(all[0].writes, Some(McpWrites::On));
    }

    #[tokio::test]
    async fn run_call_refuses_a_call_stopped_before_it_was_sent() {
        let mut mgr = manager(temp_dir());
        mgr.save_config(def("s", "uvx", &[])).unwrap();
        mgr.install_client("s".into(), fake_client("s", vec![tool("s", "get_x")]));
        let manager = Mutex::new(mgr);
        let calls = CallRegistry::new();
        calls.cancel("mcp-1");
        let r = run_call(&manager, &calls, "s", "get_x", json!({}), Some("mcp-1"), false).await;
        assert_eq!(r.unwrap_err(), MCP_STOPPED_NOT_SENT);
        let r = run_call(&manager, &calls, "nope", "get_x", json!({}), None, false).await;
        assert_eq!(r.unwrap_err(), "MCP server 'nope' is not connected");
    }

    // ─── writes off ───

    #[test]
    fn legacy_and_odd_writes_values_load_as_unset() {
        let dir = temp_dir();
        std::fs::write(
            dir.join("mcp_servers.json"),
            r#"[{"name":"old","command":"uvx","args":[]},
                {"name":"odd","command":"uvx","args":[],"writes":"ask"},
                {"name":"num","command":"uvx","args":[],"writes":1},
                {"name":"on","command":"uvx","args":[],"writes":"on"},
                {"name":"off","command":"uvx","args":[],"writes":"off"}]"#,
        )
        .unwrap();
        let store = McpConfigStore::new(dir);
        let all = store.load_checked().unwrap();
        assert_eq!(all.len(), 5);
        assert_eq!(all[0].writes, None);
        assert!(!all[0].writes_on());
        assert_eq!(all[1].writes, None);
        assert_eq!(all[2].writes, None);
        assert_eq!(all[3].writes, Some(McpWrites::On));
        assert!(all[3].writes_on());
        assert_eq!(all[4].writes, Some(McpWrites::Off));
        let v = serde_json::to_value(&all[0]).unwrap();
        assert!(v.get("writes").is_none());
        assert_eq!(serde_json::to_value(&all[3]).unwrap()["writes"], "on");
    }

    #[test]
    fn upsert_sets_writes_off_for_a_new_server() {
        let store = McpConfigStore::new(temp_dir());
        let mut d = def("new", "uvx", &["x"]);
        d.writes = Some(McpWrites::On);
        store.upsert(d).unwrap();
        assert_eq!(store.load()[0].writes, Some(McpWrites::Off));
    }

    #[test]
    fn upsert_keeps_writes_for_the_same_program_only() {
        let store = McpConfigStore::new(temp_dir());
        store.upsert(def("c", "uvx", &["centralmcp"])).unwrap();
        let updated = store.update("c", |d| d.writes = Some(McpWrites::On)).unwrap();
        assert_eq!(updated.writes, Some(McpWrites::On));
        // Env-only change (a rotated token): writes stay on.
        let mut same = def("c", "uvx", &["centralmcp"]);
        same.env.insert("TOKEN".into(), "new".into());
        same.writes = Some(McpWrites::Off); // the form can't change it either way
        store.upsert(same).unwrap();
        assert_eq!(store.load()[0].writes, Some(McpWrites::On));
        // A legacy (unset) entry keeps unset on a same-program save.
        let legacy = McpConfigStore::new(temp_dir());
        legacy.upsert(def("l", "uvx", &["x"])).unwrap();
        legacy.update("l", |d| d.writes = None).unwrap();
        legacy.upsert(def("l", "uvx", &["x"])).unwrap();
        assert_eq!(legacy.load()[0].writes, None);
        type Change = Box<dyn Fn(&mut McpServerDef)>;
        let changes: Vec<Change> = vec![
            Box::new(|d| d.command = "uv".into()),
            Box::new(|d| d.args.push("--debug".into())),
            Box::new(|d| d.cwd = Some("/other".into())),
            Box::new(|d| {
                d.transport = McpTransport::Http;
                d.url = Some("http://127.0.0.1:8010/mcp".into());
            }),
        ];
        for change in changes {
            let store = McpConfigStore::new(temp_dir());
            store.upsert(def("c", "uvx", &["centralmcp"])).unwrap();
            store.update("c", |d| d.writes = Some(McpWrites::On)).unwrap();
            let mut changed = def("c", "uvx", &["centralmcp"]);
            change(&mut changed);
            changed.writes = Some(McpWrites::On);
            store.upsert(changed).unwrap();
            assert_eq!(store.load()[0].writes, Some(McpWrites::Off));
        }
    }

    #[tokio::test]
    async fn set_writes_refuses_on_for_a_read_only_login() {
        let mut mgr = manager(temp_dir());
        mgr.save_config(def("c", "uvx", &["x"])).unwrap();
        let client = fake_client("c", vec![read_tool("c", "get_x")]);
        *client.access.lock().unwrap() = Some(access("read-only"));
        mgr.install_client("c".into(), client);
        let err = mgr.set_writes("c", McpWrites::On).unwrap_err();
        assert_eq!(err, "Not run: c login is read-only. Writes can't be turned on here.");
        assert_eq!(mgr.list_configs()[0].writes, Some(McpWrites::Off));
        mgr.set_writes("c", McpWrites::Off).unwrap();
        assert!(mgr.set_writes("missing", McpWrites::Off).is_err());
    }

    #[tokio::test]
    async fn writes_off_hides_and_refuses_at_once() {
        let mut mgr = manager(temp_dir());
        mgr.save_config(def("s", "uvx", &["x"])).unwrap();
        let tools = vec![read_tool("s", "get_device"), tool("s", "set_ssid"), tool("s", "execute_command")];
        mgr.install_client("s".into(), fake_client("s", tools));
        let names: Vec<String> = mgr.all_tools().into_iter().map(|t| t.name).collect();
        assert_eq!(names.len(), 2);
        assert!(!names.contains(&"set_ssid".to_string()));
        let blocked = mgr.tool_info("s", "set_ssid").unwrap();
        assert_eq!(blocked.blocked, Some(access::writes_off_reason("s")));
        assert_eq!(blocked.label, Some(SafetyLabel::Write));
        let err = mgr.call_gate("s", "set_ssid", &json!({}), false).err().unwrap();
        assert_eq!(
            err,
            "Not run: s writes are off. Only the user can turn them on, in Settings → MCP Servers."
        );
        assert!(mgr.call_gate("s", "get_device", &json!({}), false).is_ok());
        let err = mgr.call_gate("s", "get_device", &json!({}), true);
        assert!(err.is_ok(), "a read-only tool runs for the Auditor");
        let err = mgr.call_gate("s", "execute_command", &json!({}), true).err().unwrap();
        assert_eq!(err, format!("Not run: {}", policy::AUDITOR_REFUSAL));
        // Turning writes on shows it at once, before any reconnect.
        mgr.set_writes("s", McpWrites::On).unwrap();
        assert_eq!(mgr.all_tools().len(), 3);
        assert!(mgr.call_gate("s", "set_ssid", &json!({}), false).is_ok());
        let st = mgr.status();
        assert_eq!(st[0]["restartNeeded"], true);
        assert_eq!(st[0]["writes"], "on");
        assert_eq!(mgr.visible_tool_count("s"), 3);

        let manager = Mutex::new(mgr);
        let calls = CallRegistry::new();
        manager.lock().await.set_writes("s", McpWrites::Off).unwrap();
        let r = run_call(&manager, &calls, "s", "set_ssid", json!({}), Some("id-1"), false).await;
        assert!(r.unwrap_err().starts_with("Not run: s writes are off."));
        // A refused call never registered its id, so Stop can't leak an entry.
        assert!(!calls.cancel("id-1"));
    }

    #[tokio::test]
    async fn status_reports_the_writes_fields() {
        let dir = temp_dir();
        std::fs::write(
            dir.join("mcp_servers.json"),
            r#"[{"name":"legacy","command":"uv","args":["run","centralmcp"]},
                {"name":"plain","command":"uvx","args":["x"],"writes":"on"}]"#,
        )
        .unwrap();
        let mut mgr = manager(dir);
        let st = mgr.status();
        let legacy = &st[0];
        assert_eq!(legacy["writesSet"], false);
        assert_eq!(legacy["writes"], "off");
        assert_eq!(legacy["access"], "unknown");
        assert_eq!(legacy["restartNeeded"], false);
        assert_eq!(legacy["hiddenToolCount"], 0);
        assert_eq!(legacy["presetBy"], "definition");
        assert_eq!(legacy["presetMismatch"], false);
        // Disconnected with writes off: the pins it would send.
        assert_eq!(
            legacy["pins"],
            json!({ "kind": "pinned", "shown": ["CENTRALMCP_READONLY=1"], "confirmed": false })
        );
        let plain = &st[1];
        assert_eq!(plain["writesSet"], true);
        assert_eq!(plain["writes"], "on");
        assert_eq!(plain["pins"], json!({ "kind": "none" }));
        assert!(plain["preset"].is_null());

        // Connected: what was applied, the login, and the hidden count.
        let resolved = mgr.resolve_connect_def("legacy", None).unwrap();
        assert!(!resolved.writes_on);
        assert_eq!(resolved.def.env.get("CENTRALMCP_READONLY").map(String::as_str), Some("1"));
        let mut client = fake_client(
            "legacy",
            vec![read_tool("legacy", "get_x"), tool("legacy", "delete_x")],
        );
        client.pins = resolved.pins;
        client.connected_writes_on = resolved.writes_on;
        *client.access.lock().unwrap() = Some(access("read-write"));
        mgr.install_client("legacy".into(), client);
        let st = mgr.status();
        assert_eq!(st[0]["toolCount"], 1);
        assert_eq!(st[0]["hiddenToolCount"], 1);
        assert_eq!(st[0]["access"], "read-write");
        assert_eq!(st[0]["restartNeeded"], false);
        assert_eq!(st[0]["pins"]["kind"], "pinned");
        // Writes on while the pinned connection runs: restart needed.
        mgr.set_writes("legacy", McpWrites::On).unwrap();
        assert_eq!(mgr.status()[0]["restartNeeded"], true);
        assert_eq!(mgr.status()[0]["hiddenToolCount"], 0);
        // A writes-on connect sends no pins.
        let resolved = mgr.resolve_connect_def("legacy", None).unwrap();
        assert!(resolved.writes_on);
        assert_eq!(resolved.pins, PinPlan::None);
        assert!(!resolved.def.env.contains_key("CENTRALMCP_READONLY"));
    }

    #[tokio::test]
    async fn resolve_pins_override_the_users_own_value() {
        let mut mgr = manager(temp_dir());
        let mut d = def("c", "uv", &["run", "centralmcp"]);
        d.env.insert("centralmcp_readonly".into(), "0".into());
        mgr.save_config(d).unwrap();
        let resolved = mgr.resolve_connect_def("c", None).unwrap();
        let keys: Vec<&String> = resolved
            .def
            .env
            .keys()
            .filter(|k| k.eq_ignore_ascii_case("CENTRALMCP_READONLY"))
            .collect();
        assert_eq!(keys, vec!["CENTRALMCP_READONLY"]);
        assert_eq!(resolved.def.env["CENTRALMCP_READONLY"], "1");
        mgr.install_client("c".into(), fake_client("c", vec![]));
        assert!(mgr.clients.contains_key("c"));
    }

    // ─── Logins in the password store (K2) ───

    #[tokio::test]
    async fn rename_moves_the_login_only_after_the_copy_checks_out() {
        use crate::secret_store::mem::MemBackend;
        let mem = MemBackend::new();
        let mgr = mem_manager(&mem);
        mgr.save_config(def("a", "uvx", &["x"])).unwrap();
        mgr.save_config(def("taken", "uvx", &["y"])).unwrap();
        mgr.creds().set("a", "client_secret: s3cr3t").unwrap();
        mgr.creds().set("taken", "other login").unwrap();
        let manager = Mutex::new(mgr);

        // A name that is taken: nothing moves.
        assert!(rename_server(&manager, "a", "taken").await.is_err());
        assert_eq!(mem.raw("mcp-creds:a").unwrap(), b"client_secret: s3cr3t");
        assert_eq!(mem.raw("mcp-creds:taken").unwrap(), b"other login");

        // The copy reads back wrong: the old name keeps its login and config.
        mem.wrong_read.store(true, Ordering::Relaxed);
        assert!(rename_server(&manager, "a", "b").await.is_err());
        mem.wrong_read.store(false, Ordering::Relaxed);
        assert_eq!(mem.raw("mcp-creds:a").unwrap(), b"client_secret: s3cr3t");
        assert!(mem.raw("mcp-creds:b").is_none());
        assert!(manager.lock().await.list_configs().iter().any(|d| d.name == "a"));

        // A good rename: the new entry, then the old one deleted.
        rename_server(&manager, "a", "b").await.unwrap();
        assert_eq!(mem.raw("mcp-creds:b").unwrap(), b"client_secret: s3cr3t");
        assert!(mem.raw("mcp-creds:a").is_none());
        let names: Vec<String> = manager.lock().await.list_configs().into_iter().map(|d| d.name).collect();
        assert_eq!(names, vec!["b".to_string(), "taken".to_string()]);
    }

    #[tokio::test]
    async fn rename_without_a_login_drops_an_old_login_left_under_the_new_name() {
        use crate::secret_store::mem::MemBackend;
        let mem = MemBackend::new();
        let mgr = mem_manager(&mem);
        mgr.save_config(def("a", "uvx", &["x"])).unwrap();
        mgr.creds().set("b", "left from a server deleted long ago").unwrap();
        let manager = Mutex::new(mgr);
        rename_server(&manager, "a", "b").await.unwrap();
        assert!(mem.accounts().is_empty());
    }

    #[tokio::test]
    async fn a_10kb_login_survives_split_storage_connect_and_export() {
        use crate::secret_store::mem::MemBackend;
        let mem = MemBackend::new();
        mem.max_blob.store(2560, Ordering::Relaxed);
        let mgr = mem_manager(&mem);
        mgr.save_config(def("central", "uvx", &["centralmcp"])).unwrap();
        let yaml: String = (0..400)
            .map(|i| format!("key_{:03}: value-{:012}\n", i, i * 7919))
            .collect::<String>()[..10_240]
            .to_string();
        mgr.creds().set("central", &yaml).unwrap();
        assert!(mem.raw("part4:mcp-creds:central").is_some());

        // A fresh handle reads it back whole (export asks has()).
        let fresh = McpCreds::new(Arc::new(SecretStore::os_for_tests(mem.clone())));
        assert!(fresh.has("central").unwrap());
        let stored = fresh.get("central").unwrap();
        assert_eq!(stored.as_deref().map(String::as_str), Some(yaml.as_str()));

        // Connect: the login file holds exactly the content.
        let resolved = mgr.resolve_connect_def("central", stored).unwrap();
        let path = resolved.def.env.get("CREDS_PATH").expect("creds path");
        assert_eq!(std::fs::read_to_string(path).unwrap(), yaml);
    }

    #[tokio::test]
    async fn a_slow_password_store_never_holds_the_mcp_lock() {
        use crate::secret_store::mem::MemBackend;
        let mem = MemBackend::new();
        let mgr = mem_manager(&mem);
        mgr.save_config(def("slow", "greencli-no-such-command", &[])).unwrap();
        mem.get_delay_ms.store(2_000, Ordering::Relaxed);
        let manager = Arc::new(Mutex::new(mgr));
        let m2 = manager.clone();
        let connecting = tokio::spawn(async move {
            let none = || None;
            connect_server(&m2, "slow", &none).await
        });
        tokio::time::sleep(Duration::from_millis(100)).await;
        let started = std::time::Instant::now();
        let listed = manager.lock().await.list_configs();
        let status = manager.lock().await.status();
        assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
        assert_eq!(listed.len(), 1);
        assert_eq!(status.len(), 1);
        // The connect still finishes (the command doesn't exist).
        assert!(connecting.await.unwrap().is_err());
    }

    #[tokio::test]
    async fn a_stdio_server_does_not_start_without_its_login_when_the_store_fails() {
        use crate::secret_store::mem::MemBackend;
        let mem = MemBackend::new();
        let mgr = mem_manager(&mem);
        mgr.save_config(def("central", "uvx", &["centralmcp"])).unwrap();
        mem.fail_all.store(true, Ordering::Relaxed);
        let manager = Mutex::new(mgr);
        let none = || None;
        let err = connect_server(&manager, "central", &none).await.unwrap_err();
        assert_eq!(err, crate::secret_store::UNAVAILABLE);
    }

    // ─── The login file exists only while its server runs (K3) ───

    /// Every login file in `dir`'s `mcp_creds`, in any run folder.
    fn files_in(dir: &std::path::Path) -> Vec<PathBuf> {
        let mut out = Vec::new();
        for e in std::fs::read_dir(dir.join(CREDS_DIR)).into_iter().flatten().flatten() {
            if e.file_type().unwrap().is_dir() {
                out.extend(std::fs::read_dir(e.path()).unwrap().flatten().map(|f| f.path()));
            } else if !e.file_name().to_string_lossy().ends_with(LOCK_SUFFIX) {
                out.push(e.path());
            }
        }
        out
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_login_file_is_private_and_goes_at_shutdown() {
        use std::os::unix::fs::PermissionsExt;
        let dir = temp_dir();
        let creds = test_creds_file(&dir, "central");
        let path = creds.path().to_path_buf();
        let client = fake_stdio_client_with_creds("central", creds);
        assert_eq!(std::fs::read(&path).unwrap(), b"client_secret: s3cr3t");
        let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
        assert_eq!(mode(&path), 0o600);
        assert_eq!(mode(&dir.join(CREDS_DIR)), 0o700);
        assert_eq!(mode(path.parent().unwrap()), 0o700);
        client.shutdown().await;
        assert!(!path.exists());
        assert!(files_in(&dir).is_empty());
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn the_login_file_goes_when_the_server_exits_by_itself() {
        let dir = temp_dir();
        let creds = test_creds_file(&dir, "central");
        let path = creds.path().to_path_buf();
        let client = fake_stdio_client_with_creds("central", creds);
        let pid = fake_child_pid(&client);
        assert!(path.exists());
        std::process::Command::new("kill")
            .arg(pid.to_string())
            .status()
            .unwrap();
        for _ in 0..100 {
            if !path.exists() {
                break;
            }
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
        assert!(!path.exists(), "the reader didn't delete the login file at EOF");
        assert!(client.is_dead());
        // The client still holds the guard: dropping it later is fine.
        client.shutdown().await;
    }

    #[cfg(unix)]
    #[tokio::test]
    async fn after_a_reconnect_the_new_servers_file_stays() {
        let dir = temp_dir();
        let mut mgr = manager(dir.clone());
        let first = test_creds_file(&dir, "central");
        let first_path = first.path().to_path_buf();
        assert!(mgr
            .install_client("central".into(), fake_stdio_client_with_creds("central", first))
            .is_none());
        let second = test_creds_file(&dir, "central");
        let second_path = second.path().to_path_buf();
        assert_ne!(first_path, second_path);
        let old = mgr
            .install_client("central".into(), fake_stdio_client_with_creds("central", second))
            .expect("the old client");
        old.shutdown().await;
        assert!(!first_path.exists());
        assert!(second_path.exists());
        for c in mgr.take_all_clients() {
            c.shutdown().await;
        }
        assert!(files_in(&dir).is_empty());
    }

    #[tokio::test]
    async fn a_failed_connect_leaves_no_login_file() {
        use crate::secret_store::mem::MemBackend;
        let mem = MemBackend::new();
        let dir = temp_dir();
        let store = Arc::new(SecretStore::os_for_tests(mem.clone()));
        let mgr = McpManager::new(dir.clone(), McpCreds::new(store));
        mgr.save_config(def("central", "greencli-no-such-command", &[])).unwrap();
        mgr.creds().set("central", "client_secret: s3cr3t").unwrap();
        let manager = Mutex::new(mgr);
        let none = || None;
        assert!(connect_server(&manager, "central", &none).await.is_err());
        assert!(dir.join(CREDS_DIR).exists(), "the file was written first");
        assert!(files_in(&dir).is_empty());
    }

    #[test]
    fn the_startup_sweep_empties_the_login_folder() {
        let dir = temp_dir();
        let creds = dir.join(CREDS_DIR);
        std::fs::create_dir_all(&creds).unwrap();
        std::fs::write(creds.join("central_0123456789abcdef"), b"old 1.9 file").unwrap();
        std::fs::write(creds.join("central_0123-ffffffffffffffff"), b"left by a crash").unwrap();
        // A run folder of a copy of the app that is gone: its lock is free.
        let dead = creds.join("run-00000000000000aa");
        std::fs::create_dir_all(&dead).unwrap();
        std::fs::write(dead.join("central-1"), b"left by a crash").unwrap();
        std::fs::write(creds.join("run-00000000000000aa.lock"), b"").unwrap();
        // A run folder with no lock file at all.
        let orphan = creds.join("run-00000000000000bb");
        std::fs::create_dir_all(&orphan).unwrap();
        std::fs::write(orphan.join("central-2"), b"left over").unwrap();
        let keep = temp_dir().join("outside.txt");
        std::fs::write(&keep, b"not ours").unwrap();
        #[cfg(unix)]
        {
            std::os::unix::fs::symlink(&keep, creds.join("link")).unwrap();
            std::os::unix::fs::symlink(&keep, dead.join("link")).unwrap();
        }
        sweep_creds_dir(&dir);
        let left: Vec<String> = std::fs::read_dir(&creds)
            .unwrap()
            .flatten()
            .map(|e| e.file_name().to_string_lossy().to_string())
            .collect();
        assert_eq!(left, vec![SWEEP_LOCK.to_string()]);
        assert_eq!(std::fs::read(&keep).unwrap(), b"not ours");
        // No folder: nothing to do.
        sweep_creds_dir(&temp_dir());
    }

    #[test]
    fn the_sweep_leaves_the_login_files_of_a_running_copy() {
        let dir = temp_dir();
        // This process is the running copy: it holds its run folder's lock.
        let live = CredsFile::write(&dir, "central", b"client_secret: s3cr3t").unwrap();
        std::fs::write(dir.join(CREDS_DIR).join("old-1.9-file"), b"x").unwrap();
        sweep_creds_dir(&dir);
        assert_eq!(std::fs::read(live.path()).unwrap(), b"client_secret: s3cr3t");
        assert_eq!(files_in(&dir), vec![live.path().to_path_buf()]);
        // A second login file goes in the same run folder.
        let other = CredsFile::write(&dir, "other", b"token: x").unwrap();
        assert_eq!(other.path().parent(), live.path().parent());
        drop(other);
        drop(live);
        assert!(files_in(&dir).is_empty());
    }
}
