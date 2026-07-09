use crate::error::AppError;
use crate::ssh::keys::SshKeyManager;
use async_trait::async_trait;
use russh::client::Handler;
use russh::{client, Channel, ChannelId, Disconnect};
use russh_keys::key;
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc::{channel, Sender};
use tokio::sync::Mutex;

#[derive(Clone, Debug, Serialize)]
pub struct ConnectResponse {
    pub session_id: String,
    pub success: bool,
    pub error: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TerminalDataEvent {
    pub session_id: String,
    pub data: Vec<u8>,
}

#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ConnectionStatusEvent {
    pub session_id: String,
    pub status: String,
    pub message: Option<String>,
}

pub struct SshConnection {
    pub session_id: String,
    pub config: ConnectionConfig,
    pub handle: Option<Arc<Mutex<client::Handle<ClientHandler>>>>,
    pub channel: Option<Arc<Mutex<Channel<client::Msg>>>>,
    pub data_receiver: Option<tokio::sync::mpsc::Receiver<Vec<u8>>>,
    pub connected: bool,
    /// Held open for the session's lifetime when connecting via a jump host;
    /// dropping it tears down the tunnel.
    pub jump_handle: Option<Arc<Mutex<client::Handle<ClientHandler>>>>,
    /// Last terminal size from the frontend, re-applied on (re)connect so the
    /// remote PTY doesn't reset to 80x24 after an auto-reconnect.
    pub last_size: Mutex<(u16, u16)>,
}

#[derive(Clone, Debug)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub key_passphrase: Option<String>,
    /// Seconds between SSH keepalive probes. `None`/`0` disables keepalives.
    pub keep_alive_interval: Option<u64>,
    /// Path to the TOFU known_hosts store. `None` disables host-key checking.
    pub known_hosts_path: Option<PathBuf>,
    /// Optional jump host (bastion / ProxyJump) — connect to the target through it.
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_username: Option<String>,
    pub jump_password: Option<String>,
}

#[derive(Clone, Debug)]
pub enum AuthType {
    Password,
    PublicKey,
    Agent,
}

impl std::fmt::Display for AuthType {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            AuthType::Password => write!(f, "password"),
            AuthType::PublicKey => write!(f, "publickey"),
            AuthType::Agent => write!(f, "agent"),
        }
    }
}

#[derive(Clone)]
pub struct ClientHandler {
    sender: Sender<Vec<u8>>,
    host_port: String,
    known_hosts_path: Option<PathBuf>,
    /// Why check_server_key rejected the host key, so connect() can surface
    /// the mismatch details (possible MITM / re-imaged device) instead of
    /// russh's opaque "unknown key" error.
    reject_reason: Arc<std::sync::Mutex<Option<String>>>,
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        match &self.known_hosts_path {
            Some(path) => {
                let fingerprint = server_public_key.fingerprint();
                let key_type = server_public_key.name();
                match crate::ssh::known_hosts::verify_or_record(
                    path,
                    &self.host_port,
                    key_type,
                    &fingerprint,
                ) {
                    Ok(accepted) => Ok(accepted),
                    Err(reason) => {
                        log::warn!("Rejected SSH host key: {}", reason);
                        if let Ok(mut g) = self.reject_reason.lock() {
                            *g = Some(reason.to_string());
                        }
                        Ok(false)
                    }
                }
            }
            // No store configured → preserve legacy accept-all behaviour.
            None => Ok(true),
        }
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        // Await the send (rather than try_send) so bursty output — `show tech`,
        // a full running-config — applies backpressure to the SSH read loop
        // instead of silently dropping bytes when the buffer fills. A closed
        // receiver just ends the send with an error we can ignore.
        let _ = self.sender.send(data.to_vec()).await;
        Ok(())
    }

    async fn extended_data(
        &mut self,
        _channel: ChannelId,
        _ext: u32,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let _ = self.sender.send(data.to_vec()).await;
        Ok(())
    }
}

impl SshConnection {
    pub fn new(session_id: String, config: ConnectionConfig) -> Self {
        Self {
            session_id,
            config,
            handle: None,
            channel: None,
            data_receiver: None,
            connected: false,
            jump_handle: None,
            last_size: Mutex::new((80, 24)),
        }
    }

    pub fn take_data_receiver(&mut self) -> Option<tokio::sync::mpsc::Receiver<Vec<u8>>> {
        self.data_receiver.take()
    }

    pub async fn connect(&mut self) -> Result<ConnectResponse, AppError> {
        // Previously this set inactivity_timeout = 30s, which garbage-collected
        // idle interactive sessions after 30 seconds of silence. Disable the
        // inactivity GC and instead rely on keepalive probes to detect dead peers.
        let keepalive = self
            .config
            .keep_alive_interval
            .filter(|s| *s > 0)
            .map(std::time::Duration::from_secs);
        let client_config = Arc::new(client::Config {
            inactivity_timeout: None,
            keepalive_interval: keepalive,
            keepalive_max: 3,
            ..Default::default()
        });

        // The handler owns the only sender: when the russh session task ends
        // (server drop, keepalive_max exceeded) the channel closes, which is
        // what signals EOF to the supervisor. Do NOT retain a clone here.
        let (data_tx, data_rx) = channel::<Vec<u8>>(1024);

        let reject_reason: Arc<std::sync::Mutex<Option<String>>> =
            Arc::new(std::sync::Mutex::new(None));
        // Turn a host-key rejection into an actionable error: russh only says
        // "unknown key", but the handler records WHY (mismatch = possible MITM
        // or re-imaged device, and how to clear the old entry).
        let key_error = {
            let reject_reason = reject_reason.clone();
            move |prefix: &str, e: russh::Error| -> AppError {
                let detail = reject_reason.lock().ok().and_then(|g| g.clone());
                match detail {
                    Some(d) => AppError::SshError(format!(
                        "{}: {} — {} (manage saved host keys in Settings → Known Hosts)",
                        prefix, e, d
                    )),
                    None => AppError::SshError(format!("{}: {}", prefix, e)),
                }
            }
        };

        let handler = ClientHandler {
            sender: data_tx,
            host_port: format!("{}:{}", self.config.host, self.config.port),
            known_hosts_path: self.config.known_hosts_path.clone(),
            reject_reason: reject_reason.clone(),
        };

        // Connect directly, or tunnel through a jump host (ProxyJump) when set.
        let mut handle = if let Some(ref jump_host) = self.config.jump_host {
            let jump_port = self.config.jump_port.unwrap_or(22);
            // The jump session's own data is irrelevant (we only open a tunnel),
            // so its handler discards data but still verifies the jump host key.
            let (jdtx, _jdrx) = channel::<Vec<u8>>(16);
            let jump_handler = ClientHandler {
                sender: jdtx,
                host_port: format!("{}:{}", jump_host, jump_port),
                known_hosts_path: self.config.known_hosts_path.clone(),
                reject_reason: reject_reason.clone(),
            };
            let mut jump = russh::client::connect(
                client_config.clone(),
                (jump_host.clone(), jump_port),
                jump_handler,
            )
            .await
            .map_err(|e| key_error("Jump host connect failed", e))?;

            // Authenticate to the bastion. A jump password is rarely set (especially
            // for ssh_config-imported ProxyJump), and most bastions are key/agent
            // only — so try password (if given), then the configured private key,
            // then ssh-agent, rather than failing on an empty password.
            let jump_user = self
                .config
                .jump_username
                .clone()
                .filter(|u| !u.is_empty())
                .unwrap_or_else(|| self.config.username.clone());
            let jump_pass = self.config.jump_password.clone().unwrap_or_default();
            let mut jump_ok = false;
            if !jump_pass.is_empty() {
                jump_ok = jump
                    .authenticate_password(&jump_user, jump_pass)
                    .await
                    .map_err(|e| AppError::SshError(format!("Jump host auth failed: {}", e)))?;
            }
            if !jump_ok {
                if let Some(ref key_str) = self.config.private_key {
                    if let Ok(kp) = SshKeyManager::load_private_key(
                        key_str.as_bytes(),
                        self.config.key_passphrase.as_deref(),
                    ) {
                        jump_ok = jump
                            .authenticate_publickey(&jump_user, Arc::new(kp))
                            .await
                            .unwrap_or(false);
                    }
                }
            }
            if !jump_ok {
                if let Ok(mut agent) = russh_keys::agent::client::AgentClient::connect_env().await {
                    if let Ok(identities) = agent.request_identities().await {
                        for key in identities {
                            let (back, res) =
                                jump.authenticate_future(jump_user.clone(), key, agent).await;
                            agent = back;
                            if matches!(res, Ok(true)) {
                                jump_ok = true;
                                break;
                            }
                        }
                    }
                }
            }
            if !jump_ok {
                return Err(AppError::AuthError(
                    "Jump host authentication failed (tried password, key, and agent)".into(),
                ));
            }

            // Open a tunnel from the jump host to the target and run SSH over it.
            let tunnel = jump
                .channel_open_direct_tcpip(
                    self.config.host.clone(),
                    self.config.port as u32,
                    "127.0.0.1",
                    0,
                )
                .await
                .map_err(|e| AppError::SshError(format!("Tunnel to target failed: {}", e)))?;

            let target =
                russh::client::connect_stream(client_config.clone(), tunnel.into_stream(), handler)
                    .await
                    .map_err(|e| key_error("Connect via jump host failed", e))?;

            // Keep the jump session alive for the lifetime of this connection.
            self.jump_handle = Some(Arc::new(Mutex::new(jump)));
            target
        } else {
            russh::client::connect(
                client_config.clone(),
                (self.config.host.clone(), self.config.port),
                handler,
            )
            .await
            .map_err(|e| key_error("Connection failed", e))?
        };

        // Authenticate
        match self.config.auth_type {
            AuthType::Password => {
                let password = self.config.password.clone().unwrap_or_default();
                let auth_res = handle
                    .authenticate_password(&self.config.username, password.clone())
                    .await
                    .map_err(|e| AppError::SshError(format!("Auth failed: {}", e)))?;

                if !auth_res {
                    // Fall back to keyboard-interactive: lots of network gear
                    // (TACACS+/RADIUS) presents the password via a challenge
                    // prompt rather than the `password` auth method. Answer each
                    // prompt with the same password.
                    use russh::client::KeyboardInteractiveAuthResponse;
                    let mut authed = false;
                    let mut first_round = true;
                    let mut res = handle
                        .authenticate_keyboard_interactive_start(
                            self.config.username.clone(),
                            None,
                        )
                        .await
                        .map_err(|e| {
                            AppError::SshError(format!("Keyboard-interactive start: {}", e))
                        })?;
                    // Cap the number of challenge rounds; break out on success/failure.
                    for _ in 0..4 {
                        match res {
                            KeyboardInteractiveAuthResponse::Success => {
                                authed = true;
                                break;
                            }
                            KeyboardInteractiveAuthResponse::Failure => break,
                            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                                // Only answer the FIRST prompt of the FIRST round with the
                                // password — never blast it into every prompt (a second
                                // factor / OTP prompt must not receive the password).
                                let answers: Vec<String> = prompts
                                    .iter()
                                    .enumerate()
                                    .map(|(i, _)| {
                                        if first_round && i == 0 {
                                            password.clone()
                                        } else {
                                            String::new()
                                        }
                                    })
                                    .collect();
                                // Servers often open with a zero-prompt banner
                                // round — the password must stay armed for the
                                // first round that actually asks something.
                                if !prompts.is_empty() {
                                    first_round = false;
                                }
                                res = handle
                                    .authenticate_keyboard_interactive_respond(answers)
                                    .await
                                    .map_err(|e| {
                                        AppError::SshError(format!(
                                            "Keyboard-interactive respond: {}",
                                            e
                                        ))
                                    })?;
                            }
                        }
                    }
                    if !authed {
                        return Err(AppError::AuthError(
                            "Password / keyboard-interactive authentication failed".into(),
                        ));
                    }
                }
            }
            AuthType::PublicKey => {
                let key_pair = if let Some(ref key_str) = self.config.private_key {
                    let passphrase = self.config.key_passphrase.as_deref();
                    SshKeyManager::load_private_key(key_str.as_bytes(), passphrase)?
                } else {
                    return Err(AppError::AuthError("No private key provided".into()));
                };

                let auth_res = handle
                    .authenticate_publickey(&self.config.username, Arc::new(key_pair))
                    .await
                    .map_err(|e| AppError::SshError(format!("Key auth failed: {}", e)))?;

                if !auth_res {
                    return Err(AppError::AuthError(
                        "Public key authentication failed".into(),
                    ));
                }
            }
            AuthType::Agent => {
                // Authenticate against a running ssh-agent (SSH_AUTH_SOCK on
                // unix; the OpenSSH/Pageant pipe on Windows). Try each loaded
                // identity until one is accepted.
                let mut agent = russh_keys::agent::client::AgentClient::connect_env()
                    .await
                    .map_err(|e| {
                        AppError::AuthError(format!(
                            "Could not reach ssh-agent (is it running / SSH_AUTH_SOCK set?): {}",
                            e
                        ))
                    })?;
                let identities = agent.request_identities().await.map_err(|e| {
                    AppError::AuthError(format!("ssh-agent request failed: {}", e))
                })?;
                if identities.is_empty() {
                    return Err(AppError::AuthError(
                        "ssh-agent has no keys loaded (run `ssh-add`)".into(),
                    ));
                }
                let mut authenticated = false;
                for key in identities {
                    let (agent_back, res) = handle
                        .authenticate_future(self.config.username.clone(), key, agent)
                        .await;
                    agent = agent_back;
                    if matches!(res, Ok(true)) {
                        authenticated = true;
                        break;
                    }
                }
                if !authenticated {
                    return Err(AppError::AuthError(
                        "SSH agent authentication failed (no agent key was accepted)".into(),
                    ));
                }
            }
        }

        // Open session channel with PTY
        let channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::SshError(format!("Channel open: {}", e)))?;

        // want_reply=true: wait for the server to actually accept the PTY and shell.
        // With false, a server that REFUSES them (restricted accounts, appliances,
        // forced-command keys) still resolves Ok and we'd report a connected-but-dead
        // session. A rejection now surfaces as a clear connect error.
        // Request the PTY at the terminal's LAST KNOWN size — a hardcoded 80x24
        // left every auto-reconnected session with a mis-sized remote PTY until
        // the user happened to resize the window.
        let (cols, rows) = *self.last_size.lock().await;
        channel
            .request_pty(true, &self.get_term_type(), cols as u32, rows as u32, 0, 0, &[])
            .await
            .map_err(|_| {
                AppError::SshError(
                    "The server refused a PTY (the account or device may not allow an interactive shell)".into(),
                )
            })?;

        channel
            .request_shell(true)
            .await
            .map_err(|_| {
                AppError::SshError(
                    "The server refused to start a shell (restricted account or forced-command key?)".into(),
                )
            })?;

        self.handle = Some(Arc::new(Mutex::new(handle)));
        self.channel = Some(Arc::new(Mutex::new(channel)));
        self.data_receiver = Some(data_rx);
        self.connected = true;

        Ok(ConnectResponse {
            session_id: self.session_id.clone(),
            success: true,
            error: None,
        })
    }

    pub async fn disconnect(&mut self) -> Result<(), AppError> {
        if let Some(ref handle) = self.handle {
            let handle = handle.lock().await;
            let _ = handle
                .disconnect(Disconnect::ByApplication, "Closing", "")
                .await;
        }
        self.connected = false;
        self.handle = None;
        self.channel = None;
        self.jump_handle = None;
        Ok(())
    }

    pub async fn send(&self, data: &[u8]) -> Result<(), AppError> {
        if let Some(ref channel_arc) = &self.channel {
            let channel = channel_arc.lock().await;
            let cursor = std::io::Cursor::new(data);
            channel
                .data(cursor)
                .await
                .map_err(|e| AppError::SshError(format!("Send: {}", e)))?;
            Ok(())
        } else {
            Err(AppError::SessionNotFound(
                "SSH session not connected".into(),
            ))
        }
    }

    /// Set the size the PTY will be requested at BEFORE connecting. Used by the
    /// reconnect supervisor to carry the user's last-known geometry into the
    /// fresh connection (resize() can't be used pre-connect — there is no channel
    /// yet, so window_change would error).
    pub async fn set_initial_size(&self, cols: u16, rows: u16) {
        *self.last_size.lock().await = (cols, rows);
    }

    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), AppError> {
        // Remember the size so a reconnect requests the PTY at the right one.
        *self.last_size.lock().await = (cols, rows);
        if let Some(ref channel_arc) = &self.channel {
            let channel = channel_arc.lock().await;
            channel
                .window_change(cols as u32, rows as u32, 0, 0)
                .await
                .map_err(|e| AppError::SshError(format!("Resize: {}", e)))?;
            Ok(())
        } else {
            Err(AppError::SessionNotFound(
                "SSH session not connected".into(),
            ))
        }
    }

    pub fn is_connected(&self) -> bool {
        self.connected
    }

    fn get_term_type(&self) -> String {
        "xterm-256color".to_string()
    }
}

#[async_trait]
pub trait Connection: Send + Sync {
    async fn connect(&mut self) -> Result<ConnectResponse, AppError>;
    async fn disconnect(&mut self) -> Result<(), AppError>;
    async fn send(&self, data: &[u8]) -> Result<(), AppError>;
    async fn resize(&self, cols: u16, rows: u16) -> Result<(), AppError>;
    fn is_connected(&self) -> bool;
    fn get_session_id(&self) -> String;
    /// Return the SSH handle if this is an SSH connection (for SFTP).
    fn ssh_handle(&self) -> Option<Arc<Mutex<client::Handle<ClientHandler>>>> {
        None
    }
    /// Send a line BREAK. Only meaningful on serial connections (used to
    /// interrupt boot / drop into ROMMON); the default reports it unsupported.
    async fn send_break(&self) -> Result<(), AppError> {
        Err(AppError::SerialError(
            "BREAK is only supported on serial connections".into(),
        ))
    }
}

#[async_trait]
impl Connection for SshConnection {
    async fn connect(&mut self) -> Result<ConnectResponse, AppError> {
        SshConnection::connect(self).await
    }

    async fn disconnect(&mut self) -> Result<(), AppError> {
        SshConnection::disconnect(self).await
    }

    async fn send(&self, data: &[u8]) -> Result<(), AppError> {
        SshConnection::send(self, data).await
    }

    async fn resize(&self, cols: u16, rows: u16) -> Result<(), AppError> {
        SshConnection::resize(self, cols, rows).await
    }

    fn is_connected(&self) -> bool {
        SshConnection::is_connected(self)
    }

    fn get_session_id(&self) -> String {
        self.session_id.clone()
    }

    fn ssh_handle(&self) -> Option<Arc<Mutex<client::Handle<ClientHandler>>>> {
        self.handle.clone()
    }
}
