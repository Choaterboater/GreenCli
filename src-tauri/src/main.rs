// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod api;
mod error;
mod local;
mod mcp;
mod serial;
mod session;
mod ssh;
mod telnet;
mod vault;

use api::ArubaCxClient;
use error::AppError;
use mcp::{
    McpInitializeRequest, McpResourceReadRequest, McpServer, McpToolCallRequest,
};
use serde::{Deserialize, Serialize};
use ai::{AiChatRequest, AiKeyStore};
use local::{LocalConfig, LocalConnection};
use serial::{client::SerialConfig, SerialConnection};
use session::{SessionManager, SessionStore, SessionFolder, StoredSession};
use ssh::client::{AuthType, ConnectResponse, Connection, ConnectionConfig, ConnectionStatusEvent, TerminalDataEvent};
use ssh::SshConnection;
use telnet::{TelnetConnection, client::TelnetConfig};
use vault::CredentialVault;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tokio::sync::Mutex as AsyncMutex;

// ─── Shared Application State ───

struct AppState {
    session_manager: Arc<AsyncMutex<SessionManager>>,
    session_store: Arc<AsyncMutex<SessionStore>>,
    vault: Arc<Mutex<CredentialVault>>,
    mcp_server: Arc<AsyncMutex<McpServer>>,
    api_clients: Arc<AsyncMutex<HashMap<String, ArubaCxClient>>>,
    ai_keys: AiKeyStore,
    /// Recent terminal output per session, so the AI assistant can read back
    /// command results (bounded tail, plain bytes lossily decoded).
    terminal_buffers: Arc<AsyncMutex<HashMap<String, String>>>,
    /// Open session-log files keyed by session id (raw output streamed to disk).
    session_logs: Arc<AsyncMutex<HashMap<String, std::fs::File>>>,
    app_dir: std::path::PathBuf,
}

impl AppState {
    fn new(app_dir: std::path::PathBuf) -> Result<Self, AppError> {
        let vault_dir = app_dir.clone();
        Ok(Self {
            session_manager: Arc::new(AsyncMutex::new(SessionManager::new())),
            session_store: Arc::new(AsyncMutex::new(SessionStore::new(app_dir.clone())?)),
            vault: Arc::new(Mutex::new(CredentialVault::new(vault_dir)?)),
            mcp_server: Arc::new(AsyncMutex::new(McpServer::new())),
            api_clients: Arc::new(AsyncMutex::new(HashMap::new())),
            ai_keys: AiKeyStore::new(app_dir.clone()),
            terminal_buffers: Arc::new(AsyncMutex::new(HashMap::new())),
            session_logs: Arc::new(AsyncMutex::new(HashMap::new())),
            app_dir,
        })
    }
}

// ─── Request/Response Types ───

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ConnectionConfigRequest {
    pub id: String,
    pub name: String,
    pub protocol: String,
    pub host: Option<String>,
    pub port: Option<u16>,
    pub username: Option<String>,
    pub auth_type: Option<String>,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub key_passphrase: Option<String>,
    pub serial_port: Option<String>,
    pub baud_rate: Option<u32>,
    pub device_type: String,
    #[serde(default)]
    pub keep_alive_interval: Option<u64>,
    #[serde(default)]
    pub auto_reconnect: Option<bool>,
    /// For protocol "local": the command to run in the PTY. None => default shell.
    #[serde(default)]
    pub command: Option<String>,
    #[serde(default)]
    pub args: Option<Vec<String>>,
    #[serde(default)]
    pub cwd: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApiLoginRequest {
    pub host: String,
    pub username: String,
    pub password: String,
}

// ─── Helpers ───

/// Forward a connection's incoming data to the frontend (`terminal_data`),
/// mirror it into the per-session output buffer (for AI read-back), and emit a
/// `disconnected` status when the stream ends.
/// Mirror one output chunk into the per-session buffer + log file and emit it
/// to the frontend. Shared by the plain forwarder and the SSH supervisor.
async fn write_and_emit(
    app: &AppHandle,
    buffers: &Arc<AsyncMutex<HashMap<String, String>>>,
    logs: &Arc<AsyncMutex<HashMap<String, std::fs::File>>>,
    session_id: &str,
    data: Vec<u8>,
) {
    {
        let mut map = buffers.lock().await;
        let buf = map.entry(session_id.to_string()).or_default();
        buf.push_str(&String::from_utf8_lossy(&data));
        // Keep a bounded tail (~150KB) on a char boundary.
        if buf.len() > 200_000 {
            let mut cut = buf.len() - 150_000;
            while cut < buf.len() && !buf.is_char_boundary(cut) {
                cut += 1;
            }
            *buf = buf[cut..].to_string();
        }
    }
    {
        let mut logs = logs.lock().await;
        if let Some(file) = logs.get_mut(session_id) {
            use std::io::Write;
            let _ = file.write_all(&data);
        }
    }
    let _ = app.emit_all(
        "terminal_data",
        TerminalDataEvent {
            session_id: session_id.to_string(),
            data,
        },
    );
}

fn spawn_forwarder(
    app: AppHandle,
    buffers: Arc<AsyncMutex<HashMap<String, String>>>,
    logs: Arc<AsyncMutex<HashMap<String, std::fs::File>>>,
    session_id: String,
    mut rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    close_msg: &'static str,
) {
    tokio::spawn(async move {
        while let Some(data) = rx.recv().await {
            write_and_emit(&app, &buffers, &logs, &session_id, data).await;
        }
        let _ = app.emit_all(
            "connection_status",
            ConnectionStatusEvent {
                session_id,
                status: "disconnected".to_string(),
                message: Some(close_msg.to_string()),
            },
        );
    });
}

/// SSH forwarder with auto-reconnect. Forwards output like `spawn_forwarder`,
/// but when the stream closes it reconnects with exponential backoff — unless
/// the session was removed from the manager (a user-initiated disconnect) or
/// `auto_reconnect` is off.
#[allow(clippy::too_many_arguments)]
fn spawn_ssh_supervisor(
    app: AppHandle,
    buffers: Arc<AsyncMutex<HashMap<String, String>>>,
    logs: Arc<AsyncMutex<HashMap<String, std::fs::File>>>,
    session_manager: Arc<AsyncMutex<SessionManager>>,
    ssh_config: ConnectionConfig,
    session_id: String,
    first_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    auto_reconnect: bool,
) {
    tokio::spawn(async move {
        let mut rx = first_rx;
        let mut first = true;
        let mut backoff = 1u64;

        loop {
            if !first {
                // Reconnect path (the initial connection is made by the caller).
                let _ = app.emit_all(
                    "connection_status",
                    ConnectionStatusEvent {
                        session_id: session_id.clone(),
                        status: "reconnecting".to_string(),
                        message: Some(format!("Reconnecting in {}s…", backoff)),
                    },
                );
                for _ in 0..backoff {
                    tokio::time::sleep(std::time::Duration::from_secs(1)).await;
                    if !session_manager.lock().await.contains(&session_id).await {
                        return; // user disconnected during backoff
                    }
                }
                let mut conn = SshConnection::new(session_id.clone(), ssh_config.clone());
                match conn.connect().await {
                    Ok(_) => match conn.take_data_receiver() {
                        Some(nrx) => {
                            backoff = 1;
                            let _ = session_manager
                                .lock()
                                .await
                                .add_session(session_id.clone(), Box::new(conn))
                                .await;
                            rx = nrx;
                            let _ = app.emit_all(
                                "connection_status",
                                ConnectionStatusEvent {
                                    session_id: session_id.clone(),
                                    status: "connected".to_string(),
                                    message: Some("Reconnected".to_string()),
                                },
                            );
                        }
                        None => return,
                    },
                    Err(_) => {
                        backoff = (backoff * 2).min(30);
                        if !session_manager.lock().await.contains(&session_id).await {
                            return;
                        }
                        continue; // retry (backoff sleep happens at top)
                    }
                }
            }
            first = false;

            // Forward until the stream closes.
            while let Some(data) = rx.recv().await {
                write_and_emit(&app, &buffers, &logs, &session_id, data).await;
            }

            // Stream closed — reconnect only if still wanted.
            let still_present = session_manager.lock().await.contains(&session_id).await;
            if !still_present || !auto_reconnect {
                let _ = app.emit_all(
                    "connection_status",
                    ConnectionStatusEvent {
                        session_id: session_id.clone(),
                        status: "disconnected".to_string(),
                        message: Some("SSH connection closed".to_string()),
                    },
                );
                return;
            }
        }
    });
}

// ─── Tauri Commands ───

#[tauri::command]
async fn connect(
    config: ConnectionConfigRequest,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<ConnectResponse, String> {
    let session_id = config.id.clone();

    match config.protocol.as_str() {
        "ssh" => {
            let auth_type = match config.auth_type.as_deref() {
                Some("key") | Some("publickey") => AuthType::PublicKey,
                Some("agent") => AuthType::Agent,
                _ => AuthType::Password,
            };
            let host = config.host.clone().unwrap_or_default();

            let ssh_config = ConnectionConfig {
                id: config.id.clone(),
                host: host.clone(),
                port: config.port.unwrap_or(22),
                username: config.username.unwrap_or_default(),
                auth_type,
                password: config.password,
                private_key: config.private_key,
                key_passphrase: config.key_passphrase,
                keep_alive_interval: config.keep_alive_interval,
                known_hosts_path: Some(state.app_dir.join("known_hosts.json")),
            };

            let auto_reconnect = config.auto_reconnect.unwrap_or(false);
            let mut connection = SshConnection::new(session_id.clone(), ssh_config.clone());
            let response = connection.connect().await.map_err(|e| e.to_string())?;
            let rx_opt = connection.take_data_receiver();

            state
                .session_manager
                .lock()
                .await
                .add_session(session_id.clone(), Box::new(connection))
                .await
                .map_err(|e| e.to_string())?;

            let _ = app.emit_all(
                "connection_status",
                ConnectionStatusEvent {
                    session_id: session_id.clone(),
                    status: "connected".to_string(),
                    message: Some(format!("SSH connected to {}", host)),
                },
            );

            // Forward output (+ capture for AI read-back/logging) with
            // auto-reconnect when enabled.
            if let Some(rx) = rx_opt {
                spawn_ssh_supervisor(
                    app.clone(),
                    state.terminal_buffers.clone(),
                    state.session_logs.clone(),
                    state.session_manager.clone(),
                    ssh_config,
                    session_id.clone(),
                    rx,
                    auto_reconnect,
                );
            }

            Ok(response)
        }
        "telnet" => {
            let telnet_config = TelnetConfig {
                id: config.id.clone(),
                host: config.host.unwrap_or_default(),
                port: config.port.unwrap_or(23),
            };

            let mut connection = TelnetConnection::new(session_id.clone(), telnet_config);
            let response = connection.connect().await.map_err(|e| e.to_string())?;

            // Forward Telnet data + capture output for AI read-back.
            if let Some(rx) = connection.take_data_receiver() {
                spawn_forwarder(
                    app.clone(),
                    state.terminal_buffers.clone(),
                    state.session_logs.clone(),
                    session_id.clone(),
                    rx,
                    "Telnet connection closed",
                );
            }

            state
                .session_manager
                .lock()
                .await
                .add_session(session_id.clone(), Box::new(connection))
                .await
                .map_err(|e| e.to_string())?;

            let _ = app.emit_all(
                "connection_status",
                ConnectionStatusEvent {
                    session_id: session_id.clone(),
                    status: "connected".to_string(),
                    message: Some("Telnet connected".to_string()),
                },
            );

            Ok(response)
        }
        "serial" => {
            let serial_config = SerialConfig {
                id: config.id.clone(),
                port: config.serial_port.unwrap_or_default(),
                baud_rate: config.baud_rate.unwrap_or(9600),
                data_bits: 8,
                parity: "none".to_string(),
                stop_bits: 1,
            };

            let mut connection = SerialConnection::new(session_id.clone(), serial_config);
            let response = connection.connect().await.map_err(|e| e.to_string())?;

            // Forward serial data + capture output for AI read-back.
            if let Some(rx) = connection.take_data_receiver() {
                spawn_forwarder(
                    app.clone(),
                    state.terminal_buffers.clone(),
                    state.session_logs.clone(),
                    session_id.clone(),
                    rx,
                    "Serial port closed",
                );
            }

            state
                .session_manager
                .lock()
                .await
                .add_session(session_id.clone(), Box::new(connection))
                .await
                .map_err(|e| e.to_string())?;

            let _ = app.emit_all(
                "connection_status",
                ConnectionStatusEvent {
                    session_id: session_id.clone(),
                    status: "connected".to_string(),
                    message: Some("Serial connected".to_string()),
                },
            );

            Ok(response)
        }
        "local" => {
            let local_config = LocalConfig {
                id: config.id.clone(),
                command: config.command,
                args: config.args.unwrap_or_default(),
                cwd: config.cwd,
            };

            let mut connection = LocalConnection::new(session_id.clone(), local_config);
            let response = connection.connect().await.map_err(|e| e.to_string())?;

            // Forward local PTY data + capture output for AI read-back.
            if let Some(rx) = connection.take_data_receiver() {
                spawn_forwarder(
                    app.clone(),
                    state.terminal_buffers.clone(),
                    state.session_logs.clone(),
                    session_id.clone(),
                    rx,
                    "Local session ended",
                );
            }

            state
                .session_manager
                .lock()
                .await
                .add_session(session_id.clone(), Box::new(connection))
                .await
                .map_err(|e| e.to_string())?;

            let _ = app.emit_all(
                "connection_status",
                ConnectionStatusEvent {
                    session_id: session_id.clone(),
                    status: "connected".to_string(),
                    message: Some("Local shell started".to_string()),
                },
            );

            Ok(response)
        }
        _ => Err(format!("Unsupported protocol: {}", config.protocol)),
    }
}

#[tauri::command]
async fn disconnect(
    session_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .session_manager
        .lock()
        .await
        .remove_session(&session_id)
        .await
        .map_err(|e| e.to_string())?;

    state.terminal_buffers.lock().await.remove(&session_id);
    state.session_logs.lock().await.remove(&session_id);

    let _ = app.emit_all(
        "connection_status",
        ConnectionStatusEvent {
            session_id,
            status: "disconnected".to_string(),
            message: Some("Session closed".to_string()),
        },
    );

    Ok(())
}

#[tauri::command]
async fn send_data(
    session_id: String,
    data: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let bytes = data.into_bytes();
    state
        .session_manager
        .lock()
        .await
        .send_to_session(&session_id, &bytes)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn resize_terminal(
    session_id: String,
    cols: u16,
    rows: u16,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .session_manager
        .lock()
        .await
        .resize_session(&session_id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<StoredSession>, String> {
    let mut store = state.session_store.lock().await;
    let data = store.load().map_err(|e| e.to_string())?;
    let mut sessions = Vec::new();
    for folder in &data.folders {
        sessions.extend(folder.items.clone());
    }
    sessions.extend(data.sessions);
    Ok(sessions)
}

#[tauri::command]
async fn list_folders(state: State<'_, AppState>) -> Result<Vec<SessionFolder>, String> {
    let mut store = state.session_store.lock().await;
    let data = store.load().map_err(|e| e.to_string())?;
    Ok(data.folders)
}

#[tauri::command]
async fn save_session(
    config: ConnectionConfigRequest,
    folder_id: Option<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let session = StoredSession {
        id: config.id,
        name: config.name,
        protocol: config.protocol,
        host: config.host,
        port: config.port,
        username: config.username,
        auth_type: config.auth_type,
        device_type: config.device_type,
        folder_id: folder_id.clone(),
        tags: vec![],
        notes: None,
        serial_port: config.serial_port,
        baud_rate: config.baud_rate,
    };

    let mut store = state.session_store.lock().await;
    let folder_id = folder_id.unwrap_or_else(|| "default".to_string());
    store.add_session(&folder_id, session).map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_session(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut store = state.session_store.lock().await;
    store.remove_session(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_folder(
    name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let folder_id = format!(
        "folder-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_err(|e| e.to_string())?
            .as_millis()
    );
    let folder = SessionFolder {
        id: folder_id.clone(),
        name,
        items: vec![],
        expanded: true,
    };
    let mut store = state.session_store.lock().await;
    store.add_folder(folder).map_err(|e| e.to_string())?;
    Ok(folder_id)
}

// ─── Vault Commands ───

#[tauri::command]
fn vault_unlock(password: String, state: State<'_, AppState>) -> Result<bool, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    vault.unlock(&password).map_err(|e| e.to_string())?;
    Ok(true)
}

#[tauri::command]
fn vault_lock(state: State<'_, AppState>) -> Result<(), String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    vault.lock();
    Ok(())
}

#[tauri::command]
fn vault_store(key: String, value: String, state: State<'_, AppState>) -> Result<(), String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    vault.store(&key, &value).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_retrieve(
    key: String,
    state: State<'_, AppState>,
) -> Result<Option<String>, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    vault.retrieve(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_delete(key: String, state: State<'_, AppState>) -> Result<(), String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    vault.delete(&key).map_err(|e| e.to_string())
}

#[tauri::command]
fn vault_is_unlocked(state: State<'_, AppState>) -> Result<bool, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    Ok(vault.is_unlocked())
}

// ─── Utility Commands ───

/// Read any user-selected file as text. Uses std::fs (not the webview `fs`
/// allowlist, which is scope-limited), and decodes lossily so large terminal
/// logs / captures with stray non-UTF8 bytes still open.
#[tauri::command]
fn read_file_text(path: String) -> Result<String, String> {
    std::fs::read(&path)
        .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
        .map_err(|e| format!("Failed to read {}: {}", path, e))
}

/// Write text to any user-selected path (companion to read_file_text).
#[tauri::command]
fn write_file_text(path: String, contents: String) -> Result<(), String> {
    std::fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path, e))
}

/// Recent captured output for a session (used by the AI assistant to read back
/// command results). Returns the bounded tail buffer, or empty if none.
#[tauri::command]
async fn get_terminal_output(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let map = state.terminal_buffers.lock().await;
    Ok(map.get(&session_id).cloned().unwrap_or_default())
}

/// Begin streaming a session's raw output to a timestamped log file under the
/// app data dir's `logs/` folder. Returns the file path.
#[tauri::command]
async fn start_session_log(
    session_id: String,
    name: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let dir = state.app_dir.join("logs");
    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    let millis = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_millis())
        .unwrap_or(0);
    let safe: String = name
        .chars()
        .map(|c| if c.is_alphanumeric() || c == '-' || c == '_' { c } else { '_' })
        .collect();
    let safe = if safe.is_empty() { "session".to_string() } else { safe };
    let path = dir.join(format!("{}_{}.log", safe, millis));
    let file = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
        .map_err(|e| e.to_string())?;
    state.session_logs.lock().await.insert(session_id, file);
    Ok(path.to_string_lossy().into_owned())
}

#[tauri::command]
async fn stop_session_log(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.session_logs.lock().await.remove(&session_id);
    Ok(())
}

#[tauri::command]
async fn is_session_logging(session_id: String, state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.session_logs.lock().await.contains_key(&session_id))
}

#[tauri::command]
fn list_serial_ports() -> Vec<String> {
    SessionStore::list_serial_ports()
}

#[tauri::command]
fn generate_keypair() -> Result<HashMap<String, String>, String> {
    let (public_key, private_key) = ssh::SshKeyManager::generate_keypair()
        .map_err(|e| e.to_string())?;
    let mut result = HashMap::new();
    result.insert("publicKey".to_string(), public_key);
    result.insert("privateKey".to_string(), private_key);
    Ok(result)
}

// ─── MCP Commands ───

#[tauri::command]
async fn mcp_initialize(
    request: McpInitializeRequest,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let server = state.mcp_server.lock().await;
    let response = server.initialize(request);
    serde_json::to_value(response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mcp_tools_list(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let server = state.mcp_server.lock().await;
    let response = server.list_tools();
    serde_json::to_value(response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mcp_tools_call(
    request: McpToolCallRequest,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let server = state.mcp_server.lock().await;
    let response = server.call_tool(request);
    serde_json::to_value(response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mcp_resources_list(
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let server = state.mcp_server.lock().await;
    let response = server.list_resources();
    serde_json::to_value(response).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mcp_resources_read(
    request: McpResourceReadRequest,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let server = state.mcp_server.lock().await;
    let response = server.read_resource(request);
    serde_json::to_value(response).map_err(|e| e.to_string())
}

// ─── API Commands ───

#[tauri::command]
async fn api_login(
    request: ApiLoginRequest,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    let mut client = ArubaCxClient::new(request.host.clone());
    client
        .login(&request.username, &request.password)
        .await
        .map_err(|e| e.to_string())?;
    let mut clients = state.api_clients.lock().await;
    clients.insert(request.host, client);
    Ok(true)
}

#[tauri::command]
async fn api_get_interfaces(
    host: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let clients = state.api_clients.lock().await;
    let client = clients
        .get(&host)
        .ok_or("Not logged in. Call api_login first.")?;
    let interfaces = client.get_interfaces().await.map_err(|e| e.to_string())?;
    serde_json::to_value(interfaces).map_err(|e| e.to_string())
}

#[tauri::command]
async fn api_get_vlans(
    host: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let clients = state.api_clients.lock().await;
    let client = clients
        .get(&host)
        .ok_or("Not logged in. Call api_login first.")?;
    let vlans = client.get_vlans().await.map_err(|e| e.to_string())?;
    serde_json::to_value(vlans).map_err(|e| e.to_string())
}

#[tauri::command]
async fn api_get_system(
    host: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let clients = state.api_clients.lock().await;
    let client = clients
        .get(&host)
        .ok_or("Not logged in. Call api_login first.")?;
    let system = client.get_system().await.map_err(|e| e.to_string())?;
    serde_json::to_value(system).map_err(|e| e.to_string())
}

/// Generic Postman-style request against a logged-in CX device. Routes through
/// the Rust client (handles self-signed certs + cookie auth; no browser CORS).
#[tauri::command]
async fn api_request(
    host: String,
    method: String,
    path: String,
    body: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let clients = state.api_clients.lock().await;
    let client = clients
        .get(&host)
        .ok_or("Not logged in. Connect to the device first.")?;
    let (status, text) = client
        .request(&method, &path, body.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    Ok(serde_json::json!({ "status": status, "body": parsed }))
}

#[tauri::command]
async fn api_execute_cli(
    host: String,
    command: String,
    state: State<'_, AppState>,
) -> Result<String, String> {
    let clients = state.api_clients.lock().await;
    let client = clients
        .get(&host)
        .ok_or("Not logged in. Call api_login first.")?;
    client.execute_cli(&command).await.map_err(|e| e.to_string())
}

// ─── AI Commands ───

#[tauri::command]
fn ai_set_key(provider: String, key: String, state: State<'_, AppState>) -> Result<(), String> {
    state.ai_keys.set(&provider, &key).map_err(|e| e.to_string())
}

#[tauri::command]
fn ai_has_key(provider: String, state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.ai_keys.has(&provider))
}

/// Proxy one AI provider request from Rust (keys never touch the webview).
#[tauri::command]
async fn ai_chat(
    request: AiChatRequest,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    ai::chat_request(&state.ai_keys, request)
        .await
        .map_err(|e| e.to_string())
}

/// Run a locally installed AI CLI one-shot with the prompt on stdin.
#[tauri::command]
async fn ai_cli(command: String, prompt: String) -> Result<String, String> {
    ai::cli_passthrough(&command, &prompt)
        .await
        .map_err(|e| e.to_string())
}

// ─── Main ───

fn main() {
    env_logger::init();

    tauri::Builder::default()
        .setup(|app| {
            let app_dir = app
                .path_resolver()
                .app_data_dir()
                .expect("Failed to get app data dir");
            let state = AppState::new(app_dir)?;
            app.manage(state);
            Ok(())
        })
        .on_window_event(|event| {
            if let WindowEvent::Destroyed = event.event() {
                // Cleanup handled by drop
            }
        })
        .invoke_handler(tauri::generate_handler![
            connect,
            disconnect,
            send_data,
            resize_terminal,
            list_sessions,
            list_folders,
            save_session,
            delete_session,
            create_folder,
            vault_unlock,
            vault_lock,
            vault_store,
            vault_retrieve,
            vault_delete,
            vault_is_unlocked,
            list_serial_ports,
            get_terminal_output,
            start_session_log,
            stop_session_log,
            is_session_logging,
            read_file_text,
            write_file_text,
            generate_keypair,
            mcp_initialize,
            mcp_tools_list,
            mcp_tools_call,
            mcp_resources_list,
            mcp_resources_read,
            api_login,
            api_get_interfaces,
            api_get_vlans,
            api_get_system,
            api_execute_cli,
            api_request,
            ai_set_key,
            ai_has_key,
            ai_chat,
            ai_cli,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
