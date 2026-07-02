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

use crate::error::AppError;
use futures::StreamExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::Duration;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{mpsc, oneshot, Mutex};

fn default_true() -> bool {
    true
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
    #[serde(default = "default_true")]
    pub enabled: bool,
}

/// A discovered tool exposed by a connected MCP server.
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpToolInfo {
    pub server: String,
    pub name: String,
    #[serde(default)]
    pub description: String,
    pub input_schema: Value,
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

    pub fn load(&self) -> Vec<McpServerDef> {
        fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save(&self, defs: &[McpServerDef]) -> Result<(), AppError> {
        fs::write(&self.path, serde_json::to_vec_pretty(defs)?).map_err(AppError::from)?;
        Ok(())
    }

    pub fn upsert(&self, def: McpServerDef) -> Result<(), AppError> {
        let mut all = self.load();
        if let Some(existing) = all.iter_mut().find(|d| d.name == def.name) {
            *existing = def;
        } else {
            all.push(def);
        }
        self.save(&all)
    }

    pub fn remove(&self, name: &str) -> Result<(), AppError> {
        let mut all = self.load();
        all.retain(|d| d.name != name);
        self.save(&all)
    }
}

// ─── Credentials store ───
//
// Holds the contents of each server's credentials file (e.g. centralmcp's
// `credentials.yaml`) kept in the app data dir, OUTSIDE the webview/localStorage.
// On connect the content is written to a file and the server's credentials env
// var (default `CREDS_PATH`) is pointed at it.

pub struct McpSecretStore {
    path: PathBuf,
}

impl McpSecretStore {
    pub fn new(app_dir: PathBuf) -> Self {
        Self {
            path: app_dir.join("mcp_creds.json"),
        }
    }

    fn load(&self) -> HashMap<String, String> {
        fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_default()
    }

    fn save(&self, m: &HashMap<String, String>) -> Result<(), AppError> {
        // Create with mode 0600 directly (no world-readable write-then-chmod window).
        write_secret_file(&self.path, &serde_json::to_vec(m)?)
    }

    pub fn set(&self, name: &str, content: &str) -> Result<(), AppError> {
        let mut m = self.load();
        if content.is_empty() {
            m.remove(name);
        } else {
            m.insert(name.to_string(), content.to_string());
        }
        self.save(&m)
    }

    pub fn get(&self, name: &str) -> Option<String> {
        self.load().get(name).cloned()
    }

    pub fn has(&self, name: &str) -> bool {
        self.load().get(name).map(|c| !c.is_empty()).unwrap_or(false)
    }
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
    /// EOF/error; for Http, the (optional) standalone listener stream closed
    /// after being established. Checked before every request so callers get
    /// a clear "server has exited" error instead of a raw I/O failure, and so
    /// the manager stops reporting the client as connected. An Http server
    /// that never establishes the optional standalone stream (allowed by
    /// spec) simply never flips this — its health is judged per-request.
    dead: Arc<AtomicBool>,
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
    /// listener (a no-op already-finished task if the server doesn't support it).
    reader: tokio::task::JoinHandle<()>,
    /// Refetches the tool list when the server sends `notifications/tools/list_changed`
    /// (e.g. centralmcp enabling a new capability mid-session) — without this the
    /// AI keeps using a stale tool list until the user manually reconnects.
    refresher: tokio::task::JoinHandle<()>,
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
                .filter_map(|t| {
                    let name = t.get("name").and_then(|n| n.as_str())?.to_string();
                    Some(McpToolInfo {
                        server: server_name.to_string(),
                        name,
                        description: t
                            .get("description")
                            .and_then(|d| d.as_str())
                            .unwrap_or("")
                            .to_string(),
                        input_schema: t
                            .get("inputSchema")
                            .cloned()
                            .unwrap_or_else(|| json!({ "type": "object" })),
                    })
                }),
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
    Ok(tools)
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
    if let Some(err) = v.get("error") {
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
            let _ = rb.send().await;
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
    tools_changed_tx: &mpsc::UnboundedSender<()>,
    awaiting_id: Option<i64>,
) -> Option<Result<Value, AppError>> {
    let mut stream = resp.bytes_stream();
    let mut buf = String::new();
    while let Some(chunk) = stream.next().await {
        let chunk = match chunk {
            Ok(c) => c,
            Err(e) => {
                return awaiting_id
                    .map(|_| Err(AppError::ApiError(format!("MCP stream read error: {}", e))));
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
            if let Some(result) =
                handle_pushed_message(&v, http, url, session_id, tools_changed_tx, awaiting_id)
                    .await
            {
                return Some(result);
            }
        }
    }
    awaiting_id.map(|_| Err(AppError::ApiError("MCP stream ended without a response".into())))
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

impl McpClient {
    pub async fn connect(def: &McpServerDef) -> Result<McpClient, AppError> {
        match def.transport {
            McpTransport::Stdio => Self::connect_stdio(def).await,
            McpTransport::Http => Self::connect_http(def).await,
        }
    }

    async fn connect_stdio(def: &McpServerDef) -> Result<McpClient, AppError> {
        let mut cmd = Command::new(&def.command);
        cmd.args(&def.args);
        augment_path(&mut cmd);
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
        let pending_r = pending.clone();
        let dead = Arc::new(AtomicBool::new(false));
        let dead_r = dead.clone();

        let stdin = Arc::new(Mutex::new(stdin));
        let stdin_r = stdin.clone();

        // Signalled by the reader on `notifications/tools/list_changed`; the
        // refresher task (spawned below, after the initial tools/list) drains
        // it and refetches. `McpCaller` also holds a clone (only meaningfully
        // used by the Http variant, but present on both for a uniform struct)
        // — the reader's own clone is what actually closes the channel here.
        let (tools_changed_tx, tools_changed_rx) = tokio::sync::mpsc::unbounded_channel::<()>();
        let tools_changed_tx_reader = tools_changed_tx.clone();

        // Reader task: dispatch responses to waiters; answer server-initiated
        // requests (ping keep-alives especially) instead of leaving them hanging.
        // A transient read error (e.g. a non-UTF8 banner byte) skips that line
        // rather than killing the whole connection; only EOF ends the loop.
        let reader = tokio::spawn(async move {
            let tools_changed_tx = tools_changed_tx_reader;
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
                        if let Some(err) = v.get("error") {
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
        });

        let caller = McpCaller {
            server: Arc::from(def.name.as_str()),
            io: ClientIo::Stdio { stdin },
            pending,
            next_id: Arc::new(Mutex::new(0)),
            tools_changed_tx: tools_changed_tx.clone(),
            dead,
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
        let init = match caller
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "greencli", "version": env!("CARGO_PKG_VERSION") }
                }),
            )
            .await
        {
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
        let tools = Arc::new(std::sync::Mutex::new(tools));
        let refresher = spawn_refresher(caller.clone(), tools.clone(), def.name.clone(), tools_changed_rx);

        Ok(McpClient {
            child: Some(child),
            caller,
            tools,
            server_info,
            reader,
            refresher,
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
            .build()
            .map_err(|e| AppError::ApiError(format!("Failed to build HTTP client: {}", e)))?;
        let session_id: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let dead = Arc::new(AtomicBool::new(false));
        let (tools_changed_tx, tools_changed_rx) = mpsc::unbounded_channel::<()>();

        let caller = McpCaller {
            server: Arc::from(def.name.as_str()),
            io: ClientIo::Http {
                http: http.clone(),
                url: url.clone(),
                session_id: session_id.clone(),
            },
            pending: Arc::new(Mutex::new(HashMap::new())), // unused for Http
            next_id: Arc::new(Mutex::new(0)),
            tools_changed_tx: tools_changed_tx.clone(),
            dead: dead.clone(),
        };

        // Handshake — same JSON-RPC calls as stdio; McpCaller dispatches the
        // actual HTTP mechanics internally.
        let init = caller
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "greencli", "version": env!("CARGO_PKG_VERSION") }
                }),
            )
            .await
            .map_err(|e| {
                AppError::ApiError(format!(
                    "{} (is the server running in Streamable HTTP mode at this URL?)",
                    e
                ))
            })?;
        let server_info = init.get("serverInfo").cloned().unwrap_or(Value::Null);
        caller.notify("notifications/initialized", json!({})).await?;

        let tools = fetch_all_tools(&caller, &def.name).await?;
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
            let dead = dead.clone();
            let tools_changed_tx = tools_changed_tx.clone();
            tokio::spawn(async move {
                let sid = session_id.lock().await.clone();
                let mut rb = http.get(url.as_ref()).header("Accept", "text/event-stream");
                if let Some(sid) = &sid {
                    rb = rb.header("Mcp-Session-Id", sid);
                }
                let resp = match rb.send().await {
                    Ok(r) => r,
                    Err(_) => return, // couldn't connect — leave `dead` false, judge health per-request
                };
                let is_stream = resp
                    .headers()
                    .get("content-type")
                    .and_then(|v| v.to_str().ok())
                    .map(|ct| ct.starts_with("text/event-stream"))
                    .unwrap_or(false);
                if !resp.status().is_success() || !is_stream {
                    return; // standalone stream unsupported — optional, not an error
                }
                // Established: from here, closing/erroring DOES mean dead,
                // mirroring stdio's EOF-marks-dead semantic.
                let _ =
                    drain_sse(resp, &http, &url, &session_id, &tools_changed_tx, None).await;
                dead.store(true, Ordering::Relaxed);
            })
        };

        let refresher = spawn_refresher(caller.clone(), tools.clone(), def.name.clone(), tools_changed_rx);

        Ok(McpClient {
            child: None,
            caller,
            tools,
            server_info,
            reader,
            refresher,
        })
    }

    /// A clonable handle for issuing tool calls without holding the manager lock.
    pub fn caller(&self) -> McpCaller {
        self.caller.clone()
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
        self.request_with_timeout(method, params, 60).await
    }

    async fn request_with_timeout(
        &self,
        method: &str,
        params: Value,
        timeout_secs: u64,
    ) -> Result<Value, AppError> {
        if self.dead.load(Ordering::Relaxed) {
            return Err(self.exited_error());
        }
        let id = {
            let mut n = self.next_id.lock().await;
            *n += 1;
            *n
        };

        match &self.io {
            ClientIo::Stdio { stdin } => {
                let (tx, rx) = oneshot::channel();
                self.pending.lock().await.insert(id, tx);

                let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
                let line = format!("{}\n", serde_json::to_string(&msg)?);
                let write_res: std::io::Result<()> = {
                    let mut stdin = stdin.lock().await;
                    match stdin.write_all(line.as_bytes()).await {
                        Ok(()) => stdin.flush().await,
                        Err(e) => Err(e),
                    }
                };
                if let Err(e) = write_res {
                    // The request never reached the server, so no response will
                    // ever arrive — drop the waiter or it leaks in the pending map.
                    self.pending.lock().await.remove(&id);
                    return Err(if self.dead.load(Ordering::Relaxed) {
                        self.exited_error()
                    } else {
                        AppError::from(e)
                    });
                }

                match tokio::time::timeout(Duration::from_secs(timeout_secs), rx).await {
                    Ok(Ok(Ok(v))) => Ok(v),
                    Ok(Ok(Err(e))) => Err(AppError::ApiError(format!("MCP '{}': {}", method, e))),
                    Ok(Err(_)) => Err(AppError::ApiError("MCP response channel dropped".into())),
                    Err(_) => {
                        self.pending.lock().await.remove(&id);
                        Err(AppError::ApiError(format!(
                            "MCP '{}' timed out after {}s",
                            method, timeout_secs
                        )))
                    }
                }
            }
            ClientIo::Http { http, url, session_id } => {
                let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
                let fut = async {
                    let sid = session_id.lock().await.clone();
                    let mut rb = http
                        .post(url.as_ref())
                        .header("Content-Type", "application/json")
                        .header("Accept", "application/json, text/event-stream")
                        .json(&msg);
                    if let Some(sid) = &sid {
                        rb = rb.header("Mcp-Session-Id", sid);
                    }
                    let resp = rb.send().await.map_err(|e| {
                        AppError::ApiError(format!("MCP '{}': HTTP request failed: {}", method, e))
                    })?;

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
                        let body = resp.text().await.unwrap_or_default();
                        let snippet: String = body.chars().take(500).collect();
                        return Err(AppError::ApiError(format!(
                            "MCP '{}': HTTP {}: {}",
                            method,
                            status.as_u16(),
                            snippet
                        )));
                    }

                    if content_type.starts_with("text/event-stream") {
                        drain_sse(resp, http, url, session_id, &self.tools_changed_tx, Some(id))
                            .await
                            .unwrap_or_else(|| {
                                Err(AppError::ApiError(format!(
                                    "MCP '{}': stream closed without a response",
                                    method
                                )))
                            })
                    } else {
                        let body: Value = resp.json().await.map_err(|e| {
                            AppError::ApiError(format!("MCP '{}': response parse: {}", method, e))
                        })?;
                        extract_result_or_error(body)
                    }
                };
                match tokio::time::timeout(Duration::from_secs(timeout_secs), fut).await {
                    Ok(r) => r,
                    Err(_) => Err(AppError::ApiError(format!(
                        "MCP '{}' timed out after {}s",
                        method, timeout_secs
                    ))),
                }
            }
        }
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
            ClientIo::Http { http, url, session_id } => {
                let sid = session_id.lock().await.clone();
                let mut rb = http
                    .post(url.as_ref())
                    .header("Content-Type", "application/json")
                    .header("Accept", "application/json, text/event-stream")
                    .json(&msg);
                if let Some(sid) = &sid {
                    rb = rb.header("Mcp-Session-Id", sid);
                }
                let resp = rb
                    .send()
                    .await
                    .map_err(|e| AppError::ApiError(format!("MCP notify '{}': {}", method, e)))?;
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

    /// Call a tool and return its text content. A tool-level failure is an MCP
    /// `result` with `isError: true` (NOT a JSON-RPC error), so we check that
    /// and surface it as an Err instead of feeding the error text back as a
    /// valid answer.
    ///
    /// Uses a longer timeout than the handshake/list requests: real tools proxy
    /// slow cloud APIs (Aruba Central reports, firmware queries) that
    /// legitimately run past 60s.
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<String, AppError> {
        let res = self
            .request_with_timeout("tools/call", json!({ "name": name, "arguments": args }), 300)
            .await?;
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
    secrets: McpSecretStore,
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

/// Lock down a secrets file to owner-only (0600) on Unix.
#[cfg(unix)]
fn restrict_perms(path: &std::path::Path) {
    use std::os::unix::fs::PermissionsExt;
    let _ = fs::set_permissions(path, fs::Permissions::from_mode(0o600));
}
#[cfg(not(unix))]
fn restrict_perms(_path: &std::path::Path) {}

/// Write a secret file owner-only WITHOUT a world-readable window: on Unix create
/// the file with mode 0600 directly, rather than fs::write (umask 0644) then chmod
/// — which leaves the cleartext readable to other local users in between.
fn write_secret_file(path: &std::path::Path, content: &[u8]) -> Result<(), AppError> {
    #[cfg(unix)]
    {
        use std::io::Write;
        use std::os::unix::fs::OpenOptionsExt;
        let mut f = fs::OpenOptions::new()
            .create(true)
            .truncate(true)
            .write(true)
            .mode(0o600)
            .open(path)
            .map_err(AppError::from)?;
        f.write_all(content).map_err(AppError::from)?;
    }
    #[cfg(not(unix))]
    {
        fs::write(path, content).map_err(AppError::from)?;
    }
    restrict_perms(path); // also fixes perms if the file pre-existed
    Ok(())
}

impl McpManager {
    pub fn new(app_dir: PathBuf) -> Self {
        Self {
            store: McpConfigStore::new(app_dir.clone()),
            secrets: McpSecretStore::new(app_dir.clone()),
            app_dir,
            clients: HashMap::new(),
        }
    }

    pub fn list_configs(&self) -> Vec<McpServerDef> {
        self.store.load()
    }

    pub fn save_config(&self, def: McpServerDef) -> Result<(), AppError> {
        self.store.upsert(def)
    }

    /// Rename a server, migrating everything keyed by name: config entry, stored
    /// credentials, the materialised creds file, and any live client (so its
    /// tools stay routable without a reconnect).
    pub fn rename_server(&mut self, from: &str, to: &str) -> Result<(), AppError> {
        if from == to {
            return Ok(());
        }
        let mut all = self.store.load();
        if all.iter().any(|d| d.name == to) {
            return Err(AppError::ApiError(format!(
                "An MCP server named '{}' already exists",
                to
            )));
        }
        let def = all
            .iter_mut()
            .find(|d| d.name == from)
            .ok_or_else(|| AppError::ApiError(format!("No MCP server named '{}'", from)))?;
        def.name = to.to_string();
        self.store.save(&all)?;
        // Move stored credentials to the new name (deleting the old entry used to
        // silently drop them on rename).
        if let Some(content) = self.secrets.get(from) {
            self.secrets.set(to, &content)?;
            self.secrets.set(from, "")?;
        }
        // The materialised creds file is keyed by name too; drop the old one (a
        // fresh one is written under the new name on next connect).
        let _ = fs::remove_file(self.app_dir.join("mcp_creds").join(sanitize_filename(from)));
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

    pub fn set_credentials(&self, name: &str, content: &str) -> Result<(), AppError> {
        self.secrets.set(name, content)?;
        if content.is_empty() {
            // Clearing the stored secret must also delete the materialised
            // cleartext file, or it lingers on disk until the server is removed.
            let _ = fs::remove_file(self.app_dir.join("mcp_creds").join(sanitize_filename(name)));
        }
        Ok(())
    }

    pub fn has_credentials(&self, name: &str) -> bool {
        self.secrets.has(name)
    }

    /// Remove a server's config + stored credentials. The caller must first
    /// `take_client` and shut it down outside the lock.
    pub fn remove_config_only(&self, name: &str) -> Result<(), AppError> {
        let _ = self.secrets.set(name, "");
        // Also delete the materialised cleartext creds file that resolve_connect_def
        // wrote, so the secret doesn't linger on disk after the server is removed.
        let creds_file = self.app_dir.join("mcp_creds").join(sanitize_filename(name));
        let _ = fs::remove_file(&creds_file);
        self.store.remove(name)
    }

    /// Load a server def and materialise its managed credentials into a 0600
    /// file, injecting the credentials env var. Cheap + non-blocking, so it runs
    /// under the (brief) manager lock; the spawn/handshake happens unlocked.
    pub fn resolve_connect_def(&self, name: &str) -> Result<McpServerDef, AppError> {
        let mut def = self
            .store
            .load()
            .into_iter()
            .find(|d| d.name == name)
            .ok_or_else(|| AppError::ApiError(format!("No MCP server named '{}'", name)))?;
        // Meaningless for Http: there's no process the app spawns to inject an
        // env var into — the server was already started separately.
        if def.transport == McpTransport::Stdio {
            if let Some(content) = self.secrets.get(name) {
                let dir = self.app_dir.join("mcp_creds");
                std::fs::create_dir_all(&dir).map_err(AppError::from)?;
                let path = dir.join(sanitize_filename(name));
                write_secret_file(&path, content.as_bytes())?;
                let var = def
                    .credentials_env_var
                    .clone()
                    .filter(|v| !v.trim().is_empty())
                    .unwrap_or_else(|| "CREDS_PATH".to_string());
                def.env.insert(var, path.to_string_lossy().to_string());
            }
        }
        Ok(def)
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

    /// Detach every live client (for app-exit cleanup — shut them down outside
    /// the lock).
    pub fn take_all_clients(&mut self) -> Vec<McpClient> {
        self.clients.drain().map(|(_, c)| c).collect()
    }

    pub fn all_tools(&self) -> Vec<McpToolInfo> {
        // Skip dead clients: advertising a crashed server's tools to the AI
        // just produces doomed tool calls.
        self.clients
            .values()
            .filter(|c| !c.is_dead())
            .flat_map(|c| c.tools.lock().map(|g| g.clone()).unwrap_or_default())
            .collect()
    }

    pub fn status(&self) -> Vec<Value> {
        self.store
            .load()
            .iter()
            .map(|d| {
                // A client whose process has exited is NOT connected, even if it
                // is still sitting in the map awaiting a reconnect.
                let live = self.clients.get(&d.name).filter(|c| !c.is_dead());
                json!({
                    "name": d.name,
                    "enabled": d.enabled,
                    "connected": live.is_some(),
                    "toolCount": live
                        .map(|c| c.tools.lock().map(|g| g.len()).unwrap_or(0))
                        .unwrap_or(0),
                })
            })
            .collect()
    }

    /// Clone a caller handle for a connected server so the command can drop the
    /// manager lock before awaiting the (up-to-60s) tool round-trip.
    ///
    /// Dead clients are deliberately NOT filtered here: the caller's own dead
    /// check in `request()` yields the precise "server has exited — reconnect"
    /// error, which beats the generic "not connected" the command would emit.
    pub fn caller_for(&self, server: &str) -> Option<McpCaller> {
        self.clients.get(server).map(|c| c.caller())
    }
}
