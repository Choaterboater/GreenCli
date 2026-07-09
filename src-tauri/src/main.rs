// Prevents additional console window on Windows in release
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod ai;
mod api;
mod central;
mod error;
mod intent;
mod local;
mod mcp;
mod serial;
mod session;
mod sftp;
mod ssh;
mod telnet;
mod vault;

use ai::{AiChatRequest, AiKeyStore};
use api::{Aos8Client, ApstraClient, ArubaCxClient, AossClient, JunosClient, MistClient};
use central::CentralClient;
use error::AppError;
use local::{LocalConfig, LocalConnection};
use mcp::{McpClient, McpManager, McpServerDef};
use serde::{Deserialize, Serialize};
use serial::{client::SerialConfig, SerialConnection};
use session::{SessionFolder, SessionManager, SessionStore, StoredSession};
use sftp::{
    download as sftp_download_file, list_dir as sftp_read_dir, mkdir as sftp_mkdir,
    open_sftp as open_sftp_session, remove_dir as sftp_remove_dir,
    remove_file as sftp_remove_file, rename as sftp_rename, upload as sftp_upload_file, RemoteEntry,
};
use ssh::client::{
    AuthType, ConnectResponse, Connection, ConnectionConfig, ConnectionStatusEvent,
    TerminalDataEvent,
};
use ssh::SshConnection;
use telnet::{client::TelnetConfig, TelnetConnection};
use vault::CredentialVault;

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use tauri::{AppHandle, Manager, State, WindowEvent};
use tokio::sync::Mutex as AsyncMutex;

// ─── Shared Application State ───

/// Active SSH port-forwards keyed by forward id (meta + listener task).
type ForwardsMap =
    Arc<AsyncMutex<HashMap<String, (ssh::forward::ForwardMeta, tokio::task::JoinHandle<()>)>>>;

struct AppState {
    session_manager: Arc<SessionManager>,
    session_store: Arc<AsyncMutex<SessionStore>>,
    vault: Arc<Mutex<CredentialVault>>,
    /// Outbound MCP client manager — connects to external MCP servers so the AI
    /// assistant can use their tools (provider-agnostic).
    mcp_manager: Arc<AsyncMutex<McpManager>>,
    api_clients: Arc<AsyncMutex<HashMap<String, ArubaCxClient>>>,
    aos8_clients: Arc<AsyncMutex<HashMap<String, Aos8Client>>>,
    aoss_clients: Arc<AsyncMutex<HashMap<String, AossClient>>>,
    /// Juniper Apstra fabric controller (single configured target).
    apstra: Arc<AsyncMutex<Option<ApstraClient>>>,
    /// Juniper Mist cloud (single configured target, token auth).
    mist: Arc<AsyncMutex<Option<MistClient>>>,
    /// Juniper Junos REST clients keyed by host (HTTP Basic, optional on-box REST).
    junos_clients: Arc<AsyncMutex<HashMap<String, JunosClient>>>,
    central: Arc<AsyncMutex<CentralClient>>,
    ai_keys: AiKeyStore,
    /// Durable network-intent / desired-state store.
    intents: intent::IntentStore,
    /// Recent terminal output per session, so the AI assistant can read back
    /// command results (bounded tail, plain bytes lossily decoded).
    terminal_buffers: Arc<AsyncMutex<HashMap<String, String>>>,
    /// Last-known terminal geometry per session, so an auto-reconnect can request
    /// the PTY at the size the user actually has rather than resetting to 80x24.
    terminal_sizes: Arc<AsyncMutex<HashMap<String, (u16, u16)>>>,
    /// Open session-log files keyed by session id (raw output streamed to disk).
    session_logs: Arc<AsyncMutex<HashMap<String, std::fs::File>>>,
    /// Active SSH port-forwards keyed by forward id (meta + listener task).
    forwards: ForwardsMap,
    /// Cancellation flags for in-flight AI streams, keyed by stream id, so the
    /// frontend Stop button can actually abort the backend request/egress.
    ai_cancels: Arc<AsyncMutex<HashMap<String, Arc<std::sync::atomic::AtomicBool>>>>,
    app_dir: std::path::PathBuf,
}

impl AppState {
    fn new(app_dir: std::path::PathBuf) -> Result<Self, AppError> {
        let vault_dir = app_dir.clone();
        Ok(Self {
            session_manager: Arc::new(SessionManager::new()),
            session_store: Arc::new(AsyncMutex::new(SessionStore::new(app_dir.clone())?)),
            vault: Arc::new(Mutex::new(CredentialVault::new(vault_dir)?)),
            mcp_manager: Arc::new(AsyncMutex::new(McpManager::new(app_dir.clone()))),
            api_clients: Arc::new(AsyncMutex::new(HashMap::new())),
            aos8_clients: Arc::new(AsyncMutex::new(HashMap::new())),
            aoss_clients: Arc::new(AsyncMutex::new(HashMap::new())),
            apstra: Arc::new(AsyncMutex::new(None)),
            mist: Arc::new(AsyncMutex::new(None)),
            junos_clients: Arc::new(AsyncMutex::new(HashMap::new())),
            central: Arc::new(AsyncMutex::new(CentralClient::new())),
            ai_keys: AiKeyStore::new(app_dir.clone()),
            intents: intent::IntentStore::new(app_dir.clone()),
            terminal_buffers: Arc::new(AsyncMutex::new(HashMap::new())),
            terminal_sizes: Arc::new(AsyncMutex::new(HashMap::new())),
            session_logs: Arc::new(AsyncMutex::new(HashMap::new())),
            forwards: Arc::new(AsyncMutex::new(HashMap::new())),
            ai_cancels: Arc::new(AsyncMutex::new(HashMap::new())),
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
    #[serde(default)]
    pub data_bits: Option<u8>,
    #[serde(default)]
    pub parity: Option<String>,
    #[serde(default)]
    pub stop_bits: Option<u8>,
    #[serde(default)]
    pub startup_commands: Option<String>,
    pub device_type: String,
    #[serde(default)]
    pub device_profile_id: Option<String>,
    #[serde(default)]
    pub tags: Option<Vec<String>>,
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
    // Jump host (ProxyJump) for SSH.
    #[serde(default)]
    pub jump_host: Option<String>,
    #[serde(default)]
    pub jump_port: Option<u16>,
    #[serde(default)]
    pub jump_username: Option<String>,
    #[serde(default)]
    pub jump_password: Option<String>,
}

#[derive(Clone, Debug, Serialize, Deserialize)]
pub struct ApiLoginRequest {
    pub host: String,
    pub username: String,
    pub password: String,
    /// Allow self-signed certs. The frontend always sends this explicitly (driven by
    /// the "Verify device TLS" setting); the fallback when omitted is secure (false
    /// => verify), not silently permissive.
    #[serde(default)]
    pub accept_invalid_certs: bool,
    /// Full REST base URL from the UI Base URL field, e.g.
    /// "https://192.168.1.10/rest/v10.13". Absent => https://{host}/rest/v10.09.
    #[serde(default)]
    pub base_url: Option<String>,
    /// Optional REST port (used by Junos REST, default 3443).
    #[serde(default)]
    pub port: Option<u16>,
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
        // Only append to an EXISTING buffer. The entry is pre-created when the
        // forwarder starts and removed by disconnect(); using get_mut (not
        // or_default) means a chunk that drains AFTER disconnect can't resurrect
        // a buffer entry that was just cleaned up (which would leak forever).
        if let Some(buf) = map.get_mut(session_id) {
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

/// Abort and remove every port-forward belonging to `session_id`. Used by the
/// user-driven disconnect command and by the SSH supervisor when the peer
/// closes the session or a reconnect swaps in a fresh handle — forward tasks
/// hold a clone of the OLD russh handle, so they can never carry traffic again
/// once that connection dies. (The Tunnels UI re-queries `ssh_list_forwards`
/// each time it opens, so backend removal is enough to keep it accurate.)
async fn close_session_forwards(forwards: &ForwardsMap, session_id: &str) {
    let mut fwds = forwards.lock().await;
    let ids: Vec<String> = fwds
        .iter()
        .filter(|(_, (meta, _))| meta.session_id == session_id)
        .map(|(id, _)| id.clone())
        .collect();
    for id in ids {
        if let Some((_, task)) = fwds.remove(&id) {
            task.abort();
        }
    }
}

#[allow(clippy::too_many_arguments)]
fn spawn_forwarder(
    app: AppHandle,
    buffers: Arc<AsyncMutex<HashMap<String, String>>>,
    logs: Arc<AsyncMutex<HashMap<String, std::fs::File>>>,
    session_manager: Arc<SessionManager>,
    session_id: String,
    generation: u64,
    mut rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    close_msg: &'static str,
) {
    tokio::spawn(async move {
        // Pre-create the output buffer so write_and_emit (which only appends to an
        // existing entry) has somewhere to write, and so disconnect's remove() is final.
        buffers.lock().await.entry(session_id.clone()).or_default();
        while let Some(first) = rx.recv().await {
            // Coalesce a burst of small PTY chunks into one event. Interactive TUIs
            // (claude/kimi) emit many tiny writes; one big terminal_data event is far
            // cheaper to serialize/parse than dozens, which keeps two heavy shells
            // from overwhelming the webview.
            let mut data = first;
            while data.len() < 64 * 1024 {
                match rx.try_recv() {
                    Ok(more) => data.extend_from_slice(&more),
                    Err(_) => break,
                }
            }
            write_and_emit(&app, &buffers, &logs, &session_id, data).await;
        }
        // The underlying stream (telnet/serial/local PTY) ended. If we still own
        // the registered session (generation match), this is a peer-initiated
        // close — drop the dead connection and announce it. If the entry is gone,
        // the user called disconnect() (which emits its own status); if the
        // generation changed, a newer connect replaced us and owns the session.
        // In both of those cases stay silent and leave the registration alone.
        let peer_closed = session_manager
            .remove_session_if(&session_id, generation)
            .await;
        if peer_closed {
            let _ = app.emit_all(
                "connection_status",
                ConnectionStatusEvent {
                    session_id,
                    status: "disconnected".to_string(),
                    message: Some(close_msg.to_string()),
                },
            );
        }
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
    session_manager: Arc<SessionManager>,
    forwards: ForwardsMap,
    terminal_sizes: Arc<AsyncMutex<HashMap<String, (u16, u16)>>>,
    ssh_config: ConnectionConfig,
    session_id: String,
    mut generation: u64,
    first_rx: tokio::sync::mpsc::Receiver<Vec<u8>>,
    auto_reconnect: bool,
) {
    tokio::spawn(async move {
        // Pre-create the output buffer (write_and_emit only appends to an existing
        // entry; disconnect's remove() must be final). Persists across reconnects.
        buffers.lock().await.entry(session_id.clone()).or_default();
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
                    if !session_manager.contains_gen(&session_id, generation).await {
                        // User disconnected during backoff — or a fresh connect
                        // replaced our registration (new generation). Either way
                        // this supervisor no longer owns the session.
                        return;
                    }
                }
                let mut conn = SshConnection::new(session_id.clone(), ssh_config.clone());
                // Request the reconnected PTY at the user's last-known size rather
                // than the hardcoded 80x24, so wide output / TUIs don't reflow.
                if let Some(&(cols, rows)) = terminal_sizes.lock().await.get(&session_id) {
                    conn.set_initial_size(cols, rows).await;
                }
                match conn.connect().await {
                    Ok(_) => match conn.take_data_receiver() {
                        Some(nrx) => {
                            // Atomically swap in the new connection ONLY if we
                            // still own the registration. This closes the TOCTOU
                            // window the old contains_gen-then-add_session had: a
                            // concurrent user Disconnect (or a fresh connect) that
                            // lands during connect()/here no longer gets clobbered
                            // by a resurrected session. On loss, replace_if_gen
                            // tears the new connection down for us.
                            match session_manager
                                .replace_if_gen(&session_id, generation, Box::new(conn))
                                .await
                            {
                                Some(gen) => generation = gen,
                                None => return,
                            }
                            // Only now that we've confirmed ownership and swapped
                            // in the new connection, tear down the OLD port-forwards
                            // (cloned from the dead handle, so they can't carry
                            // traffic). Doing this AFTER the ownership check avoids
                            // closing a concurrent new owner's forwards on the race
                            // where we lost ownership during connect().
                            close_session_forwards(&forwards, &session_id).await;
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
                        if !session_manager.contains_gen(&session_id, generation).await {
                            return;
                        }
                        continue; // retry (backoff sleep happens at top)
                    }
                }
            }
            first = false;

            // Forward until the stream closes.
            let started = std::time::Instant::now();
            while let Some(first) = rx.recv().await {
                // Coalesce bursts (see spawn_forwarder) so heavy output doesn't flood IPC.
                let mut data = first;
                while data.len() < 64 * 1024 {
                    match rx.try_recv() {
                        Ok(more) => data.extend_from_slice(&more),
                        Err(_) => break,
                    }
                }
                write_and_emit(&app, &buffers, &logs, &session_id, data).await;
            }

            // Stream closed — reconnect only if the registration is still ours
            // (a user disconnect removes it; a new connect bumps the generation).
            if !auto_reconnect || !session_manager.contains_gen(&session_id, generation).await {
                // Peer-initiated close with no auto-reconnect: if we still own
                // the registration, drop the dead connection (mirrors
                // spawn_forwarder) so the manager doesn't keep routing
                // keystrokes/SFTP to a dead handle, and tear down this session's
                // port-forwards — their tasks hold a clone of the dead handle.
                if session_manager.remove_session_if(&session_id, generation).await {
                    close_session_forwards(&forwards, &session_id).await;
                    let _ = app.emit_all(
                        "connection_status",
                        ConnectionStatusEvent {
                            session_id: session_id.clone(),
                            status: "disconnected".to_string(),
                            message: Some("SSH connection closed".to_string()),
                        },
                    );
                }
                // If the session is already gone (user disconnect — it emitted
                // its own status and closed its forwards) or replaced by a new
                // connect (the new owner manages it), stay silent.
                return;
            }
            // Reset backoff only after a stable session; escalate if it flapped.
            backoff = if started.elapsed() >= std::time::Duration::from_secs(5) {
                1
            } else {
                (backoff * 2).min(30)
            };
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
                host: host.clone(),
                port: config.port.unwrap_or(22),
                username: config.username.unwrap_or_default(),
                auth_type,
                password: config.password,
                private_key: config.private_key,
                key_passphrase: config.key_passphrase,
                keep_alive_interval: config.keep_alive_interval,
                known_hosts_path: Some(state.app_dir.join("known_hosts.json")),
                jump_host: config.jump_host.filter(|h| !h.is_empty()),
                jump_port: config.jump_port,
                jump_username: config.jump_username,
                jump_password: config.jump_password,
            };

            let auto_reconnect = config.auto_reconnect.unwrap_or(false);
            let mut connection = SshConnection::new(session_id.clone(), ssh_config.clone());
            let response = connection.connect().await.map_err(|e| e.to_string())?;
            let rx_opt = connection.take_data_receiver();

            let generation = state
                .session_manager.add_session(session_id.clone(), Box::new(connection))
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
                    state.forwards.clone(),
                    state.terminal_sizes.clone(),
                    ssh_config,
                    session_id.clone(),
                    generation,
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
            let rx_opt = connection.take_data_receiver();

            // Register the session BEFORE spawning the forwarder, so the forwarder's
            // stream-end cleanup (remove_session_if) always runs after the session
            // exists — otherwise an instantly-closing stream leaves a ghost
            // "connected" tab.
            let generation = state
                .session_manager.add_session(session_id.clone(), Box::new(connection))
                .await
                .map_err(|e| e.to_string())?;

            // Emit "connected" BEFORE spawning the forwarder (mirrors SSH), so an
            // instantly-dying stream can't emit "disconnected" first and leave a
            // ghost connected tab.
            let _ = app.emit_all(
                "connection_status",
                ConnectionStatusEvent {
                    session_id: session_id.clone(),
                    status: "connected".to_string(),
                    message: Some("Telnet connected".to_string()),
                },
            );

            // Forward Telnet data + capture output for AI read-back.
            if let Some(rx) = rx_opt {
                spawn_forwarder(
                    app.clone(),
                    state.terminal_buffers.clone(),
                    state.session_logs.clone(),
                    state.session_manager.clone(),
                    session_id.clone(),
                    generation,
                    rx,
                    "Telnet connection closed",
                );
            }

            Ok(response)
        }
        "serial" => {
            let serial_config = SerialConfig {
                id: config.id.clone(),
                port: config.serial_port.unwrap_or_default(),
                baud_rate: config.baud_rate.unwrap_or(9600),
                data_bits: config.data_bits.unwrap_or(8),
                parity: config.parity.clone().unwrap_or_else(|| "none".to_string()),
                stop_bits: config.stop_bits.unwrap_or(1),
            };

            let mut connection = SerialConnection::new(session_id.clone(), serial_config);
            let response = connection.connect().await.map_err(|e| e.to_string())?;
            let rx_opt = connection.take_data_receiver();

            // Register the session before spawning the forwarder (see telnet note).
            let generation = state
                .session_manager.add_session(session_id.clone(), Box::new(connection))
                .await
                .map_err(|e| e.to_string())?;

            // Emit "connected" before spawning the forwarder (see telnet note).
            let _ = app.emit_all(
                "connection_status",
                ConnectionStatusEvent {
                    session_id: session_id.clone(),
                    status: "connected".to_string(),
                    message: Some("Serial connected".to_string()),
                },
            );

            // Forward serial data + capture output for AI read-back.
            if let Some(rx) = rx_opt {
                spawn_forwarder(
                    app.clone(),
                    state.terminal_buffers.clone(),
                    state.session_logs.clone(),
                    state.session_manager.clone(),
                    session_id.clone(),
                    generation,
                    rx,
                    "Serial port closed",
                );
            }

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
            let rx_opt = connection.take_data_receiver();

            // Register the session before spawning the forwarder (see telnet note) —
            // especially important for `local`, where a bad command can exit instantly.
            let generation = state
                .session_manager.add_session(session_id.clone(), Box::new(connection))
                .await
                .map_err(|e| e.to_string())?;

            // Emit "connected" before spawning the forwarder (see telnet note).
            let _ = app.emit_all(
                "connection_status",
                ConnectionStatusEvent {
                    session_id: session_id.clone(),
                    status: "connected".to_string(),
                    message: Some("Local shell started".to_string()),
                },
            );

            // Forward local PTY data + capture output for AI read-back.
            if let Some(rx) = rx_opt {
                spawn_forwarder(
                    app.clone(),
                    state.terminal_buffers.clone(),
                    state.session_logs.clone(),
                    state.session_manager.clone(),
                    session_id.clone(),
                    generation,
                    rx,
                    "Local session ended",
                );
            }

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
    // The map entry is removed inside remove_session BEFORE the network
    // disconnect runs, so even if the disconnect errors we must still tear down
    // per-session state and notify the UI — otherwise a disconnect that returned
    // Err would orphan port-forwards, leak the buffer/log, and leave the UI
    // showing "connected". Log and continue rather than gating cleanup on it.
    if let Err(e) = state.session_manager.remove_session(&session_id).await {
        eprintln!("[disconnect] remove_session('{}') failed: {}", session_id, e);
    }

    state.terminal_buffers.lock().await.remove(&session_id);
    state.terminal_sizes.lock().await.remove(&session_id);
    state.session_logs.lock().await.remove(&session_id);

    // Tear down any SSH port-forwards belonging to this session, so a disconnect
    // doesn't leave orphaned tunnels with the local port bound and stale entries
    // in the Tunnels UI. (forwards are keyed by forward id, not session id.)
    close_session_forwards(&state.forwards, &session_id).await;

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
        .session_manager.send_to_session(&session_id, &bytes)
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
    // Remember the size so an auto-reconnect can restore it (the mount-time fit
    // fires this on first connect, so the map is populated before any reconnect).
    state
        .terminal_sizes
        .lock()
        .await
        .insert(session_id.clone(), (cols, rows));
    state
        .session_manager.resize_session(&session_id, cols, rows)
        .await
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn serial_send_break(session_id: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .session_manager
        .send_break(&session_id)
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
        device_profile_id: config.device_profile_id,
        folder_id: folder_id.clone(),
        tags: config.tags.unwrap_or_default(),
        notes: None,
        serial_port: config.serial_port,
        baud_rate: config.baud_rate,
        data_bits: config.data_bits,
        parity: config.parity,
        stop_bits: config.stop_bits,
        startup_commands: config.startup_commands.filter(|c| !c.trim().is_empty()),
        keep_alive_interval: config.keep_alive_interval,
        auto_reconnect: config.auto_reconnect,
        command: config.command,
        args: config.args,
        cwd: config.cwd,
        jump_host: config.jump_host.filter(|h| !h.is_empty()),
        jump_port: config.jump_port,
        jump_username: config.jump_username,
    };

    let mut store = state.session_store.lock().await;
    let folder_id = folder_id.unwrap_or_else(|| "default".to_string());
    store
        .add_session(&folder_id, session)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_session(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut store = state.session_store.lock().await;
    store.remove_session(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn rename_session(id: String, name: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut store = state.session_store.lock().await;
    store.rename_session(&id, &name).map_err(|e| e.to_string())
}

#[tauri::command]
async fn move_session(
    id: String,
    folder_id: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut store = state.session_store.lock().await;
    store.move_session(&id, &folder_id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn set_session_tags(
    id: String,
    tags: Vec<String>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut store = state.session_store.lock().await;
    store.set_tags(&id, tags).map_err(|e| e.to_string())
}

#[tauri::command]
async fn update_folder(
    id: String,
    name: Option<String>,
    expanded: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mut store = state.session_store.lock().await;
    store
        .update_folder(&id, name.as_deref(), expanded)
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn delete_folder(id: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut store = state.session_store.lock().await;
    store.remove_folder(&id).map_err(|e| e.to_string())
}

#[tauri::command]
async fn create_folder(name: String, state: State<'_, AppState>) -> Result<String, String> {
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
async fn vault_unlock(password: String, state: State<'_, AppState>) -> Result<bool, String> {
    // The Argon2 KDF is deliberately slow; as a sync command it ran on the
    // main thread and froze every window for the whole derivation.
    let vault = state.vault.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let vault = vault.lock().map_err(|e| e.to_string())?;
        vault.unlock(&password).map_err(|e| e.to_string())?;
        Ok(true)
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn vault_change_password(
    old_password: String,
    new_password: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // change_password runs the Argon2 KDF twice (verify old + derive new), so
    // like vault_unlock it must run off the main thread to avoid freezing the UI.
    let vault = state.vault.clone();
    tauri::async_runtime::spawn_blocking(move || {
        let vault = vault.lock().map_err(|e| e.to_string())?;
        vault
            .change_password(&old_password, &new_password)
            .map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
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
fn vault_retrieve(key: String, state: State<'_, AppState>) -> Result<Option<String>, String> {
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

#[tauri::command]
fn vault_is_initialized(state: State<'_, AppState>) -> Result<bool, String> {
    let vault = state.vault.lock().map_err(|e| e.to_string())?;
    Ok(vault.is_initialized())
}

// ─── Utility Commands ───

/// Read any user-selected file as text. Uses std::fs (not the webview `fs`
/// allowlist, which is scope-limited), and decodes lossily so large terminal
/// logs / captures with stray non-UTF8 bytes still open.
#[tauri::command]
async fn read_file_text(path: String) -> Result<String, String> {
    // async: sync commands run on the main thread, and a multi-MB log/capture
    // read froze the whole UI for its duration.
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::read(&path)
            .map(|bytes| String::from_utf8_lossy(&bytes).into_owned())
            .map_err(|e| format!("Failed to read {}: {}", path, e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Write text to any user-selected path (companion to read_file_text).
#[tauri::command]
async fn write_file_text(path: String, contents: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        std::fs::write(&path, contents).map_err(|e| format!("Failed to write {}: {}", path, e))
    })
    .await
    .map_err(|e| e.to_string())?
}

/// Pop a session out into its own OS window. The new window loads the same
/// React app; the frontend sees the `popout-<sessionId>` window label and
/// renders a terminal-only view for that session. Terminal data is emitted via
/// emit_all, so the new window receives the stream with no extra routing. When
/// the pop-out closes, `popout_closed` tells the main window to restore the tab.
///
/// Deliberately NOT async: async commands run on the async runtime's thread
/// pool, but macOS requires NSWindow creation on the main thread — an
/// off-thread WindowBuilder yields a window that can't be moved/managed.
/// Sync commands run on the main thread.
#[tauri::command]
fn pop_out_session(
    session_id: String,
    title: Option<String>,
    app: AppHandle,
) -> Result<(), String> {
    let label = format!("popout-{}", session_id);
    if let Some(w) = app.get_window(&label) {
        let _ = w.set_focus();
        return Ok(());
    }
    let win = tauri::WindowBuilder::new(&app, &label, tauri::WindowUrl::App("index.html".into()))
        .title(title.unwrap_or_else(|| "GreenCli".into()))
        .inner_size(960.0, 600.0)
        .min_inner_size(480.0, 320.0)
        .build()
        .map_err(|e| e.to_string())?;
    let notify_app = app.clone();
    win.on_window_event(move |ev| {
        if let WindowEvent::Destroyed = ev {
            let _ = notify_app.emit_all("popout_closed", &session_id);
        }
    });
    Ok(())
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
        .map(|c| {
            if c.is_alphanumeric() || c == '-' || c == '_' {
                c
            } else {
                '_'
            }
        })
        .collect();
    let safe = if safe.is_empty() {
        "session".to_string()
    } else {
        safe
    };
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
async fn is_session_logging(
    session_id: String,
    state: State<'_, AppState>,
) -> Result<bool, String> {
    Ok(state.session_logs.lock().await.contains_key(&session_id))
}

#[tauri::command]
fn list_serial_ports() -> Vec<String> {
    SessionStore::list_serial_ports()
}

#[tauri::command]
fn generate_keypair() -> Result<HashMap<String, String>, String> {
    let (public_key, private_key) =
        ssh::SshKeyManager::generate_keypair().map_err(|e| e.to_string())?;
    let mut result = HashMap::new();
    result.insert("publicKey".to_string(), public_key);
    result.insert("privateKey".to_string(), private_key);
    Ok(result)
}

// ─── Outbound MCP client commands (connect to external MCP servers) ───

#[tauri::command]
async fn mcp_list_servers(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mgr = state.mcp_manager.lock().await;
    serde_json::to_value(mgr.list_configs()).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mcp_save_server(def: McpServerDef, state: State<'_, AppState>) -> Result<(), String> {
    let mgr = state.mcp_manager.lock().await;
    mgr.save_config(def).map_err(|e| e.to_string())
}

/// Rename a server, migrating its stored credentials, materialised creds file,
/// and live connection to the new name (deleting + re-adding loses all three).
#[tauri::command]
async fn mcp_rename_server(from: String, to: String, state: State<'_, AppState>) -> Result<(), String> {
    let mut mgr = state.mcp_manager.lock().await;
    mgr.rename_server(&from, &to).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mcp_delete_server(name: String, state: State<'_, AppState>) -> Result<(), String> {
    // Detach the live client + remove config under a brief lock, then shut the
    // client down OUTSIDE the lock so a slow process exit can't block the UI.
    let (client, res) = {
        let mut mgr = state.mcp_manager.lock().await;
        let client = mgr.take_client(&name);
        (client, mgr.remove_config_only(&name))
    };
    if let Some(c) = client {
        c.shutdown().await;
    }
    res.map_err(|e| e.to_string())
}

/// Spawn + handshake with a configured server; returns the discovered tool
/// count. The (slow) spawn/handshake runs WITHOUT the manager lock held, so
/// other MCP commands stay responsive while a server is connecting.
#[tauri::command]
async fn mcp_connect(name: String, state: State<'_, AppState>) -> Result<usize, String> {
    // 1) brief lock: resolve def + materialise credentials.
    let def = {
        let mgr = state.mcp_manager.lock().await;
        mgr.resolve_connect_def(&name).map_err(|e| e.to_string())?
    };
    // 2) unlocked: spawn + handshake (connect the NEW client before touching the
    //    old one, so a failed reconnect leaves the existing connection intact).
    let client = McpClient::connect(&def).await.map_err(|e| e.to_string())?;
    let count = client.tools.lock().map(|g| g.len()).unwrap_or(0);
    // 3) brief lock: swap in; shut down any displaced client outside the lock.
    let old = {
        let mut mgr = state.mcp_manager.lock().await;
        mgr.install_client(name, client)
    };
    if let Some(old) = old {
        old.shutdown().await;
    }
    Ok(count)
}

#[tauri::command]
async fn mcp_disconnect(name: String, state: State<'_, AppState>) -> Result<(), String> {
    let client = {
        let mut mgr = state.mcp_manager.lock().await;
        mgr.take_client(&name)
    };
    if let Some(c) = client {
        c.shutdown().await;
    }
    Ok(())
}

#[tauri::command]
async fn mcp_status(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mgr = state.mcp_manager.lock().await;
    Ok(serde_json::Value::Array(mgr.status()))
}

/// All tools across every connected MCP server (for the AI tool loop / UI).
#[tauri::command]
async fn mcp_all_tools(state: State<'_, AppState>) -> Result<serde_json::Value, String> {
    let mgr = state.mcp_manager.lock().await;
    serde_json::to_value(mgr.all_tools()).map_err(|e| e.to_string())
}

/// Invoke a tool on a connected MCP server (used by the AI assistant).
#[tauri::command]
async fn mcp_call(
    server: String,
    tool: String,
    args: serde_json::Value,
    state: State<'_, AppState>,
) -> Result<String, String> {
    // Clone the caller handle under a brief lock, then release it before the
    // (up-to-60s) tool round-trip so MCP stays responsive / parallelisable.
    let caller = {
        let mgr = state.mcp_manager.lock().await;
        mgr.caller_for(&server)
    };
    let caller = caller.ok_or_else(|| format!("MCP server '{}' is not connected", server))?;
    caller.call_tool(&tool, args).await.map_err(|e| e.to_string())
}

/// Store the credentials-file content for an MCP server (kept in the app data
/// dir, written to a file + injected as an env var path on connect). Empty
/// content clears it.
#[tauri::command]
async fn mcp_set_credentials(
    name: String,
    content: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let mgr = state.mcp_manager.lock().await;
    mgr.set_credentials(&name, &content).map_err(|e| e.to_string())
}

#[tauri::command]
async fn mcp_has_credentials(name: String, state: State<'_, AppState>) -> Result<bool, String> {
    let mgr = state.mcp_manager.lock().await;
    Ok(mgr.has_credentials(&name))
}

// ─── SSH hosts / config import ───

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
struct KnownHostEntry {
    host_port: String,
    key_type: String,
    fingerprint: String,
}

#[tauri::command]
fn list_known_hosts(state: State<'_, AppState>) -> Result<Vec<KnownHostEntry>, String> {
    let kh = crate::ssh::known_hosts::KnownHosts::new(state.app_dir.join("known_hosts.json"));
    Ok(kh
        .list()
        .into_iter()
        .map(|(host_port, key_type, fingerprint)| KnownHostEntry {
            host_port,
            key_type,
            fingerprint,
        })
        .collect())
}

#[tauri::command]
fn remove_known_host(host_port: String, state: State<'_, AppState>) -> Result<(), String> {
    let kh = crate::ssh::known_hosts::KnownHosts::new(state.app_dir.join("known_hosts.json"));
    kh.remove(&host_port);
    Ok(())
}

/// Parse ~/.ssh/config (or a supplied path) into importable host entries.
#[tauri::command]
fn import_ssh_config(
    path: Option<String>,
) -> Result<Vec<crate::ssh::ssh_config::ImportedHost>, String> {
    let p = match path {
        Some(p) if !p.trim().is_empty() => std::path::PathBuf::from(p),
        _ => crate::ssh::ssh_config::default_config_path()
            .ok_or("Could not locate ~/.ssh/config (no HOME set)")?,
    };
    let content =
        std::fs::read_to_string(&p).map_err(|e| format!("Read {}: {}", p.display(), e))?;
    Ok(crate::ssh::ssh_config::parse(&content))
}

// ─── Network intent / desired-state ───

#[tauri::command]
fn intent_list(state: State<'_, AppState>) -> Result<Vec<intent::Intent>, String> {
    Ok(state.intents.load())
}

#[tauri::command]
fn intent_list_strict(state: State<'_, AppState>) -> Result<Vec<intent::Intent>, String> {
    state.intents.load_strict().map_err(|e| e.to_string())
}

#[tauri::command]
fn intent_save(intent: intent::Intent, state: State<'_, AppState>) -> Result<(), String> {
    state.intents.upsert(intent).map_err(|e| e.to_string())
}

#[tauri::command]
fn intent_delete(id: String, state: State<'_, AppState>) -> Result<(), String> {
    state.intents.remove(&id).map_err(|e| e.to_string())
}

#[tauri::command]
fn intent_set_result(
    id: String,
    result: intent::IntentResult,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.intents.set_result(&id, result).map_err(|e| e.to_string())
}

// ─── SSH port forwarding ───

#[tauri::command]
async fn ssh_start_forward(
    session_id: String,
    kind: String,
    local_port: u16,
    remote_host: Option<String>,
    remote_port: Option<u16>,
    state: State<'_, AppState>,
) -> Result<ssh::forward::ForwardMeta, String> {
    let handle = state
        .session_manager.get_ssh_handle(&session_id)
        .await
        .ok_or("This session is not a connected SSH session")?;

    let task = match kind.as_str() {
        "local" => {
            let rh = remote_host.clone().ok_or("Local forward needs a remote host")?;
            let rp = remote_port.ok_or("Local forward needs a remote port")?;
            ssh::forward::start_local(handle, local_port, rh, rp)
                .await
                .map_err(|e| e.to_string())?
        }
        "dynamic" => ssh::forward::start_dynamic(handle, local_port)
            .await
            .map_err(|e| e.to_string())?,
        other => return Err(format!("Unsupported forward kind: {}", other)),
    };

    let id = format!(
        "fwd-{}",
        std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map(|d| d.as_micros())
            .unwrap_or(0)
    );
    let meta = ssh::forward::ForwardMeta {
        id: id.clone(),
        session_id,
        kind,
        local_port,
        remote_host,
        remote_port,
    };
    state.forwards.lock().await.insert(id, (meta.clone(), task));
    Ok(meta)
}

#[tauri::command]
async fn ssh_stop_forward(id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some((_, task)) = state.forwards.lock().await.remove(&id) {
        task.abort();
    }
    Ok(())
}

#[tauri::command]
async fn ssh_list_forwards(state: State<'_, AppState>) -> Result<Vec<ssh::forward::ForwardMeta>, String> {
    Ok(state
        .forwards
        .lock()
        .await
        .values()
        .map(|(m, _)| m.clone())
        .collect())
}

// ─── API Commands ───

#[tauri::command]
async fn api_login(request: ApiLoginRequest, state: State<'_, AppState>) -> Result<bool, String> {
    let mut client = ArubaCxClient::new(
        request.host.clone(),
        request.accept_invalid_certs,
        request.base_url.clone(),
    );
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

// ─── ArubaOS 8 (controller/conductor) + AOS-S (no Central) ───

#[tauri::command]
async fn aos8_login(request: ApiLoginRequest, state: State<'_, AppState>) -> Result<bool, String> {
    let mut client = Aos8Client::new(request.host.clone(), request.accept_invalid_certs);
    client
        .login(&request.username, &request.password)
        .await
        .map_err(|e| e.to_string())?;
    state.aos8_clients.lock().await.insert(request.host, client);
    Ok(true)
}

#[tauri::command]
async fn aos8_show(
    host: String,
    command: String,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let clients = state.aos8_clients.lock().await;
    let client = clients.get(&host).ok_or("Not logged in to AOS-8 controller.")?;
    let (status, text) = client.show(&command).await.map_err(|e| e.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    Ok(serde_json::json!({ "status": status, "body": parsed }))
}

#[tauri::command]
async fn aos8_request(
    host: String,
    method: String,
    path: String,
    body: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let clients = state.aos8_clients.lock().await;
    let client = clients.get(&host).ok_or("Not logged in to AOS-8 controller.")?;
    let (status, text) = client
        .request(&method, &path, body.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    Ok(serde_json::json!({ "status": status, "body": parsed }))
}

#[tauri::command]
async fn aoss_login(request: ApiLoginRequest, state: State<'_, AppState>) -> Result<bool, String> {
    let client = AossClient::new(request.host.clone(), request.accept_invalid_certs);
    client
        .login(&request.username, &request.password)
        .await
        .map_err(|e| e.to_string())?;
    state.aoss_clients.lock().await.insert(request.host, client);
    Ok(true)
}

#[tauri::command]
async fn aoss_request(
    host: String,
    method: String,
    path: String,
    body: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let clients = state.aoss_clients.lock().await;
    let client = clients.get(&host).ok_or("Not logged in to AOS-S switch.")?;
    let (status, text) = client
        .request(&method, &path, body.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    Ok(serde_json::json!({ "status": status, "body": parsed }))
}

// ─── Juniper Apstra ───

#[tauri::command]
async fn apstra_configure(
    host: String,
    username: String,
    password: String,
    accept_invalid_certs: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let client = ApstraClient::new(host, username, password, accept_invalid_certs);
    *state.apstra.lock().await = Some(client);
    Ok(())
}

#[tauri::command]
async fn apstra_clear(state: State<'_, AppState>) -> Result<(), String> {
    *state.apstra.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn apstra_request(
    method: String,
    path: String,
    body: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let mut guard = state.apstra.lock().await;
    let client = guard
        .as_mut()
        .ok_or("Apstra not configured. Add it in Settings → Juniper Apstra.")?;
    let (status, text) = client
        .request(&method, &path, body.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    Ok(serde_json::json!({ "status": status, "body": parsed }))
}

// ─── Juniper Mist Cloud ───

#[tauri::command]
async fn mist_configure(
    base_url: String,
    token: String,
    accept_invalid_certs: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let client = MistClient::new(base_url, token, accept_invalid_certs.unwrap_or(false));
    *state.mist.lock().await = Some(client);
    Ok(())
}

#[tauri::command]
async fn mist_clear(state: State<'_, AppState>) -> Result<(), String> {
    *state.mist.lock().await = None;
    Ok(())
}

#[tauri::command]
async fn mist_request(
    method: String,
    path: String,
    body: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let guard = state.mist.lock().await;
    let client = guard
        .as_ref()
        .ok_or("Mist not configured. Add a token in Settings → Juniper Mist.")?;
    let (status, text) = client
        .request(&method, &path, body.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    Ok(serde_json::json!({ "status": status, "body": parsed }))
}

// ─── Juniper Junos REST API ───

#[tauri::command]
async fn junos_login(request: ApiLoginRequest, state: State<'_, AppState>) -> Result<bool, String> {
    let client = JunosClient::new(
        request.host.clone(),
        request.port.unwrap_or(3443),
        request.username,
        request.password,
        request.accept_invalid_certs,
    );
    client.login().await.map_err(|e| e.to_string())?;
    state.junos_clients.lock().await.insert(request.host, client);
    Ok(true)
}

#[tauri::command]
async fn junos_request(
    host: String,
    method: String,
    path: String,
    body: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let clients = state.junos_clients.lock().await;
    let client = clients
        .get(&host)
        .ok_or("Not logged in to this Junos device (Junos REST must be enabled).")?;
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
    client
        .execute_cli(&command)
        .await
        .map_err(|e| e.to_string())
}

// ─── Aruba Central Commands ───

#[tauri::command]
async fn central_configure(
    base_url: String,
    client_id: String,
    client_secret: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state
        .central
        .lock()
        .await
        .configure(base_url, client_id, client_secret);
    Ok(())
}

#[tauri::command]
async fn central_set_token(
    base_url: String,
    token: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    state.central.lock().await.configure_token(base_url, token);
    Ok(())
}

#[tauri::command]
async fn central_clear(state: State<'_, AppState>) -> Result<(), String> {
    state.central.lock().await.clear();
    Ok(())
}

#[tauri::command]
async fn central_is_configured(state: State<'_, AppState>) -> Result<bool, String> {
    Ok(state.central.lock().await.is_configured())
}

#[tauri::command]
async fn central_request(
    method: String,
    path: String,
    body: Option<String>,
    state: State<'_, AppState>,
) -> Result<serde_json::Value, String> {
    let (status, text) = state
        .central
        .lock()
        .await
        .request(&method, &path, body.as_deref())
        .await
        .map_err(|e| e.to_string())?;
    let parsed: serde_json::Value =
        serde_json::from_str(&text).unwrap_or(serde_json::Value::String(text));
    Ok(serde_json::json!({ "status": status, "body": parsed }))
}

// ─── SFTP Commands ───

#[tauri::command]
async fn sftp_list_dir(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<Vec<RemoteEntry>, String> {
    let handle = state
        .session_manager.get_ssh_handle(&session_id)
        .await
        .ok_or_else(|| "No SSH handle for this session".to_string())?;
    // Scope the shared-handle lock to just opening the SFTP channel; the
    // returned SftpSession owns its own stream, so the transfer below runs with
    // the lock released — a slow/large transfer no longer blocks concurrent SFTP
    // ops, port-forward channel-opens, or disconnect on the same session.
    let sftp = {
        let mut handle = handle.lock().await;
        open_sftp_session(&mut handle)
            .await
            .map_err(|e| e.to_string())?
    };
    sftp_read_dir(&sftp, &path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_download(
    session_id: String,
    remote_path: String,
    local_path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle = state
        .session_manager.get_ssh_handle(&session_id)
        .await
        .ok_or_else(|| "No SSH handle for this session".to_string())?;
    // Scope the shared-handle lock to just opening the SFTP channel; the
    // returned SftpSession owns its own stream, so the transfer below runs with
    // the lock released — a slow/large transfer no longer blocks concurrent SFTP
    // ops, port-forward channel-opens, or disconnect on the same session.
    let sftp = {
        let mut handle = handle.lock().await;
        open_sftp_session(&mut handle)
            .await
            .map_err(|e| e.to_string())?
    };
    sftp_download_file(&sftp, &remote_path, &local_path)
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_upload(
    session_id: String,
    local_path: String,
    remote_path: String,
    overwrite: Option<bool>,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle = state
        .session_manager.get_ssh_handle(&session_id)
        .await
        .ok_or_else(|| "No SSH handle for this session".to_string())?;
    // Scope the shared-handle lock to just opening the SFTP channel; the
    // returned SftpSession owns its own stream, so the transfer below runs with
    // the lock released — a slow/large transfer no longer blocks concurrent SFTP
    // ops, port-forward channel-opens, or disconnect on the same session.
    let sftp = {
        let mut handle = handle.lock().await;
        open_sftp_session(&mut handle)
            .await
            .map_err(|e| e.to_string())?
    };
    sftp_upload_file(&sftp, &local_path, &remote_path, overwrite.unwrap_or(false))
        .await
        .map(|_| ())
        .map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_mkdir_cmd(
    session_id: String,
    path: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle = state
        .session_manager.get_ssh_handle(&session_id)
        .await
        .ok_or_else(|| "No SSH handle for this session".to_string())?;
    let sftp = {
        let mut handle = handle.lock().await;
        open_sftp_session(&mut handle).await.map_err(|e| e.to_string())?
    };
    sftp_mkdir(&sftp, &path).await.map_err(|e| e.to_string())
}

#[tauri::command]
async fn sftp_delete(
    session_id: String,
    path: String,
    is_dir: bool,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle = state
        .session_manager.get_ssh_handle(&session_id)
        .await
        .ok_or_else(|| "No SSH handle for this session".to_string())?;
    let sftp = {
        let mut handle = handle.lock().await;
        open_sftp_session(&mut handle).await.map_err(|e| e.to_string())?
    };
    if is_dir {
        sftp_remove_dir(&sftp, &path).await.map_err(|e| e.to_string())
    } else {
        sftp_remove_file(&sftp, &path).await.map_err(|e| e.to_string())
    }
}

#[tauri::command]
async fn sftp_rename_cmd(
    session_id: String,
    from: String,
    to: String,
    state: State<'_, AppState>,
) -> Result<(), String> {
    let handle = state
        .session_manager.get_ssh_handle(&session_id)
        .await
        .ok_or_else(|| "No SSH handle for this session".to_string())?;
    let sftp = {
        let mut handle = handle.lock().await;
        open_sftp_session(&mut handle).await.map_err(|e| e.to_string())?
    };
    sftp_rename(&sftp, &from, &to).await.map_err(|e| e.to_string())
}

// ─── AI Commands ───

#[tauri::command]
fn ai_set_key(provider: String, key: String, state: State<'_, AppState>) -> Result<(), String> {
    state
        .ai_keys
        .set(&provider, &key)
        .map_err(|e| e.to_string())
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

/// Streaming chat — emits `ai_chunk`/`ai_done`/`ai_error` events for stream_id.
#[tauri::command]
async fn ai_chat_stream(
    request: AiChatRequest,
    stream_id: String,
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<(), String> {
    // Register a cancel flag the Stop button (ai_cancel_stream) can trip.
    let cancel = Arc::new(std::sync::atomic::AtomicBool::new(false));
    state
        .ai_cancels
        .lock()
        .await
        .insert(stream_id.clone(), cancel.clone());

    let result = ai::chat_stream(&state.ai_keys, request, &app, &stream_id, cancel).await;

    // Always deregister the flag, success or failure.
    state.ai_cancels.lock().await.remove(&stream_id);

    if let Err(e) = result {
        let _ = app.emit_all(
            "ai_error",
            serde_json::json!({ "streamId": stream_id, "error": e.to_string() }),
        );
        return Err(e.to_string());
    }
    Ok(())
}

/// Stop an in-flight AI stream — trips its cancel flag so the backend drops the
/// provider request/egress instead of running to completion (and being billed).
#[tauri::command]
async fn ai_cancel_stream(stream_id: String, state: State<'_, AppState>) -> Result<(), String> {
    if let Some(flag) = state.ai_cancels.lock().await.get(&stream_id) {
        flag.store(true, std::sync::atomic::Ordering::Relaxed);
    }
    Ok(())
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

            // Auto-connect enabled MCP servers in the background so the AI's
            // tools survive an app restart without reconnecting each one by hand.
            let handle = app.handle();
            tauri::async_runtime::spawn(async move {
                let state = handle.state::<AppState>();
                let defs = {
                    let mgr = state.mcp_manager.lock().await;
                    mgr.list_configs()
                };
                for def in defs.into_iter().filter(|d| d.enabled) {
                    let resolved = {
                        let mgr = state.mcp_manager.lock().await;
                        mgr.resolve_connect_def(&def.name)
                    };
                    let resolved = match resolved {
                        Ok(r) => r,
                        Err(e) => {
                            log::warn!("MCP auto-connect '{}': {}", def.name, e);
                            continue;
                        }
                    };
                    // Spawn/handshake runs WITHOUT the manager lock (same pattern
                    // as mcp_connect) so a slow server can't block MCP commands.
                    match McpClient::connect(&resolved).await {
                        Ok(client) => {
                            let old = {
                                let mut mgr = state.mcp_manager.lock().await;
                                mgr.install_client(def.name.clone(), client)
                            };
                            if let Some(old) = old {
                                old.shutdown().await;
                            }
                        }
                        Err(e) => log::warn!("MCP auto-connect '{}' failed: {}", def.name, e),
                    }
                }
            });
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
            serial_send_break,
            list_sessions,
            list_folders,
            save_session,
            delete_session,
            rename_session,
            set_session_tags,
            update_folder,
            delete_folder,
            create_folder,
            move_session,
            vault_unlock,
            vault_change_password,
            vault_lock,
            vault_store,
            vault_retrieve,
            vault_delete,
            vault_is_unlocked,
            vault_is_initialized,
            list_serial_ports,
            get_terminal_output,
            pop_out_session,
            start_session_log,
            stop_session_log,
            is_session_logging,
            read_file_text,
            write_file_text,
            generate_keypair,
            api_login,
            api_get_interfaces,
            api_get_vlans,
            api_get_system,
            api_execute_cli,
            api_request,
            aos8_login,
            aos8_show,
            aos8_request,
            aoss_login,
            aoss_request,
            apstra_configure,
            apstra_clear,
            apstra_request,
            mist_configure,
            mist_clear,
            mist_request,
            junos_login,
            junos_request,
            central_configure,
            central_set_token,
            central_clear,
            central_is_configured,
            central_request,
            sftp_list_dir,
            sftp_download,
            sftp_upload,
            sftp_mkdir_cmd,
            sftp_delete,
            sftp_rename_cmd,
            ai_set_key,
            ai_has_key,
            ai_chat,
            ai_cancel_stream,
            ai_cli,
            ai_chat_stream,
            mcp_list_servers,
            mcp_save_server,
            mcp_rename_server,
            mcp_delete_server,
            mcp_connect,
            mcp_disconnect,
            mcp_status,
            mcp_all_tools,
            mcp_call,
            mcp_set_credentials,
            mcp_has_credentials,
            list_known_hosts,
            remove_known_host,
            import_ssh_config,
            ssh_start_forward,
            ssh_stop_forward,
            ssh_list_forwards,
            intent_list,
            intent_list_strict,
            intent_save,
            intent_delete,
            intent_set_result,
        ])
        .build(tauri::generate_context!())
        .expect("error while running tauri application")
        .run(|app_handle, event| {
            if let tauri::RunEvent::Exit = event {
                // Tauri v1 leaves via std::process::exit after the event loop, so
                // kill_on_drop destructors never run — reap MCP server children
                // explicitly or they outlive the app (not every server exits on
                // stdin EOF).
                let state: State<AppState> = app_handle.state();
                let mgr = state.mcp_manager.clone();
                tauri::async_runtime::block_on(async move {
                    let clients = { mgr.lock().await.take_all_clients() };
                    for c in clients {
                        c.shutdown().await;
                    }
                });
            }
        });
}
