// MCP client — connects OUT to external MCP servers (stdio transport) so the
// in-app AI assistant can use their tools (e.g. the user's `centralmcp` Aruba
// Central/GLP server, or a future Juniper/Mist one).
//
// Transport: newline-delimited JSON-RPC 2.0 over the child process's
// stdin/stdout, per the MCP stdio spec. A background reader task correlates
// responses to pending requests by id; notifications are ignored.

use crate::error::AppError;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashMap;
use std::fs;
use std::path::PathBuf;
use std::process::Stdio;
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::{Child, ChildStdin, Command};
use tokio::sync::{oneshot, Mutex};

fn default_true() -> bool {
    true
}

/// A persisted MCP server definition (how to launch it).
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct McpServerDef {
    pub name: String,
    pub command: String,
    #[serde(default)]
    pub args: Vec<String>,
    #[serde(default)]
    pub env: HashMap<String, String>,
    #[serde(default)]
    pub cwd: Option<String>,
    /// Name of the env var the server reads for its credentials FILE path
    /// (default `CREDS_PATH`). The app writes the managed credentials content to
    /// a file and points this var at it on connect.
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

/// Cheap, clonable handle that can issue requests on a connected client's pipe.
/// Cloning it (3 Arcs) lets a caller release the manager mutex BEFORE awaiting a
/// tool round-trip, so one slow tool never serialises the whole MCP subsystem.
#[derive(Clone)]
pub struct McpCaller {
    stdin: Arc<Mutex<ChildStdin>>,
    pending: Pending,
    next_id: Arc<Mutex<i64>>,
}

pub struct McpClient {
    child: Child,
    caller: McpCaller,
    pub tools: Vec<McpToolInfo>,
    /// Server name/version from the handshake (kept for future UI display).
    #[allow(dead_code)]
    pub server_info: Value,
    reader: tokio::task::JoinHandle<()>,
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

impl McpClient {
    pub async fn connect(def: &McpServerDef) -> Result<McpClient, AppError> {
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
            .stderr(Stdio::null())
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

        let pending: Pending = Arc::new(Mutex::new(HashMap::new()));
        let pending_r = pending.clone();

        // Reader task: dispatch responses to waiters; ignore notifications. A
        // transient read error (e.g. a non-UTF8 banner byte) skips that line
        // rather than killing the whole connection; only EOF ends the loop.
        let reader = tokio::spawn(async move {
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
                // server (sampling/roots/elicitation), not a response to us. Never
                // match it against pending waiters — ids restart at 1 each reconnect
                // so a server-request id can collide with one of ours.
                if v.get("method").is_some() {
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
            // Stream closed — fail any outstanding requests.
            let mut p = pending_r.lock().await;
            for (_, tx) in p.drain() {
                let _ = tx.send(Err("MCP server process exited".into()));
            }
        });

        let caller = McpCaller {
            stdin: Arc::new(Mutex::new(stdin)),
            pending,
            next_id: Arc::new(Mutex::new(0)),
        };

        // Handshake.
        let init = caller
            .request(
                "initialize",
                json!({
                    "protocolVersion": "2024-11-05",
                    "capabilities": {},
                    "clientInfo": { "name": "hpe-network-terminal", "version": env!("CARGO_PKG_VERSION") }
                }),
            )
            .await?;
        let server_info = init.get("serverInfo").cloned().unwrap_or(Value::Null);
        caller.notify("notifications/initialized", json!({})).await?;

        // Discover tools.
        let tools_res = caller.request("tools/list", json!({})).await?;
        let tools = tools_res
            .get("tools")
            .and_then(|t| t.as_array())
            .cloned()
            .unwrap_or_default()
            .iter()
            .filter_map(|t| {
                let name = t.get("name").and_then(|n| n.as_str())?.to_string();
                Some(McpToolInfo {
                    server: def.name.clone(),
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
            })
            .collect();

        Ok(McpClient {
            child,
            caller,
            tools,
            server_info,
            reader,
        })
    }

    /// A clonable handle for issuing tool calls without holding the manager lock.
    pub fn caller(&self) -> McpCaller {
        self.caller.clone()
    }

    pub async fn shutdown(mut self) {
        self.reader.abort();
        let _ = self.child.start_kill();
        let _ = self.child.wait().await;
    }
}

impl McpCaller {
    async fn request(&self, method: &str, params: Value) -> Result<Value, AppError> {
        let id = {
            let mut n = self.next_id.lock().await;
            *n += 1;
            *n
        };
        let (tx, rx) = oneshot::channel();
        self.pending.lock().await.insert(id, tx);

        let msg = json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params });
        let line = format!("{}\n", serde_json::to_string(&msg)?);
        {
            let mut stdin = self.stdin.lock().await;
            stdin.write_all(line.as_bytes()).await.map_err(AppError::from)?;
            stdin.flush().await.map_err(AppError::from)?;
        }

        match tokio::time::timeout(std::time::Duration::from_secs(60), rx).await {
            Ok(Ok(Ok(v))) => Ok(v),
            Ok(Ok(Err(e))) => Err(AppError::ApiError(format!("MCP '{}': {}", method, e))),
            Ok(Err(_)) => Err(AppError::ApiError("MCP response channel dropped".into())),
            Err(_) => {
                self.pending.lock().await.remove(&id);
                Err(AppError::ApiError(format!("MCP '{}' timed out", method)))
            }
        }
    }

    async fn notify(&self, method: &str, params: Value) -> Result<(), AppError> {
        let msg = json!({ "jsonrpc": "2.0", "method": method, "params": params });
        let line = format!("{}\n", serde_json::to_string(&msg)?);
        let mut stdin = self.stdin.lock().await;
        stdin.write_all(line.as_bytes()).await.map_err(AppError::from)?;
        stdin.flush().await.map_err(AppError::from)?;
        Ok(())
    }

    /// Call a tool and return its text content. A tool-level failure is an MCP
    /// `result` with `isError: true` (NOT a JSON-RPC error), so we check that
    /// and surface it as an Err instead of feeding the error text back as a
    /// valid answer.
    pub async fn call_tool(&self, name: &str, args: Value) -> Result<String, AppError> {
        let res = self
            .request("tools/call", json!({ "name": name, "arguments": args }))
            .await?;
        let text = res
            .get("content")
            .and_then(|c| c.as_array())
            .map(|arr| {
                arr.iter()
                    .filter_map(|b| b.get("text").and_then(|t| t.as_str()))
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
            Ok(serde_json::to_string_pretty(&res).unwrap_or_default())
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

    pub fn set_credentials(&self, name: &str, content: &str) -> Result<(), AppError> {
        self.secrets.set(name, content)
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

    pub fn all_tools(&self) -> Vec<McpToolInfo> {
        self.clients.values().flat_map(|c| c.tools.clone()).collect()
    }

    pub fn status(&self) -> Vec<Value> {
        self.store
            .load()
            .iter()
            .map(|d| {
                json!({
                    "name": d.name,
                    "enabled": d.enabled,
                    "connected": self.clients.contains_key(&d.name),
                    "toolCount": self.clients.get(&d.name).map(|c| c.tools.len()).unwrap_or(0),
                })
            })
            .collect()
    }

    /// Clone a caller handle for a connected server so the command can drop the
    /// manager lock before awaiting the (up-to-60s) tool round-trip.
    pub fn caller_for(&self, server: &str) -> Option<McpCaller> {
        self.clients.get(server).map(|c| c.caller())
    }
}
