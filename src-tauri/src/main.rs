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

            let mut connection = SshConnection::new(session_id.clone(), ssh_config);
            let response = connection.connect().await.map_err(|e| e.to_string())?;

            // Spawn task to forward SSH data to frontend via terminal_data events
            if let Some(mut rx) = connection.take_data_receiver() {
                let app_fwd = app.clone();
                let sid = session_id.clone();
                tokio::spawn(async move {
                    while let Some(data) = rx.recv().await {
                        let _ = app_fwd.emit_all("terminal_data", TerminalDataEvent {
                            session_id: sid.clone(),
                            data,
                        });
                    }
                    let _ = app_fwd.emit_all("connection_status", ConnectionStatusEvent {
                        session_id: sid,
                        status: "disconnected".to_string(),
                        message: Some("SSH connection closed".to_string()),
                    });
                });
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
                    message: Some(format!("SSH connected to {}", host)),
                },
            );

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

            // Spawn task to forward Telnet data to frontend via terminal_data events
            if let Some(mut rx) = connection.take_data_receiver() {
                let app_fwd = app.clone();
                let sid = session_id.clone();
                tokio::spawn(async move {
                    while let Some(data) = rx.recv().await {
                        let _ = app_fwd.emit_all("terminal_data", TerminalDataEvent {
                            session_id: sid.clone(),
                            data,
                        });
                    }
                    let _ = app_fwd.emit_all("connection_status", ConnectionStatusEvent {
                        session_id: sid,
                        status: "disconnected".to_string(),
                        message: Some("Telnet connection closed".to_string()),
                    });
                });
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

            // Spawn task to forward serial data to frontend via terminal_data events
            if let Some(mut rx) = connection.take_data_receiver() {
                let app_fwd = app.clone();
                let sid = session_id.clone();
                tokio::spawn(async move {
                    while let Some(data) = rx.recv().await {
                        let _ = app_fwd.emit_all("terminal_data", TerminalDataEvent {
                            session_id: sid.clone(),
                            data,
                        });
                    }
                    let _ = app_fwd.emit_all("connection_status", ConnectionStatusEvent {
                        session_id: sid,
                        status: "disconnected".to_string(),
                        message: Some("Serial port closed".to_string()),
                    });
                });
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

            // Spawn task to forward local PTY data to frontend via terminal_data events
            if let Some(mut rx) = connection.take_data_receiver() {
                let app_fwd = app.clone();
                let sid = session_id.clone();
                tokio::spawn(async move {
                    while let Some(data) = rx.recv().await {
                        let _ = app_fwd.emit_all("terminal_data", TerminalDataEvent {
                            session_id: sid.clone(),
                            data,
                        });
                    }
                    let _ = app_fwd.emit_all("connection_status", ConnectionStatusEvent {
                        session_id: sid,
                        status: "disconnected".to_string(),
                        message: Some("Local session ended".to_string()),
                    });
                });
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
            ai_set_key,
            ai_has_key,
            ai_chat,
            ai_cli,
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
