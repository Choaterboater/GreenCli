use crate::error::AppError;
use crate::ssh::keys::{tofu_fingerprint, tofu_key_type, SshKeyManager};
use async_trait::async_trait;
use russh::client::Handler;
use russh::keys::{PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh::{client, ChannelMsg, ChannelWriteHalf, Disconnect};
use serde::Serialize;
use std::path::PathBuf;
use std::sync::Arc;
use tokio::sync::mpsc::channel;
use tokio::sync::Mutex;

#[derive(Clone, Debug, Serialize)]
pub struct ConnectResponse {
    pub session_id: String,
    pub success: bool,
    pub error: Option<String>,
    /// Non-fatal host-key advisory (e.g. a NEW key algorithm was recorded for
    /// an already-known host) for the frontend to surface as a warning toast.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub warning: Option<String>,
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
    pub channel_writer: Option<ChannelWriteHalf<client::Msg>>,
    pub channel_reader_task: Option<tokio::task::JoinHandle<()>>,
    pub data_receiver: Option<tokio::sync::mpsc::Receiver<Vec<u8>>>,
    pub connected: bool,
    /// Held open for the session's lifetime when connecting via a jump host;
    /// dropping it tears down the tunnel.
    pub jump_handle: Option<Arc<Mutex<client::Handle<ClientHandler>>>>,
    /// Last terminal size from the frontend, re-applied on (re)connect so the
    /// remote PTY doesn't reset to 80x24 after an auto-reconnect.
    pub last_size: Mutex<(u16, u16)>,
}

#[derive(Clone)]
pub struct ConnectionConfig {
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    /// Wiped on drop so a freed-but-unzeroed password never lingers in memory.
    pub password: Option<zeroize::Zeroizing<String>>,
    /// Wiped on drop (see `password`) — key material must not linger as
    /// freed-but-unzeroed plaintext either.
    pub private_key: Option<zeroize::Zeroizing<String>>,
    /// Wiped on drop (see `password`).
    pub key_passphrase: Option<zeroize::Zeroizing<String>>,
    /// Seconds between SSH keepalive probes. `None`/`0` disables keepalives.
    pub keep_alive_interval: Option<u64>,
    /// Path to the TOFU known_hosts store. `None` REJECTS every host key
    /// (fail closed) — all production call sites must pass a path.
    pub known_hosts_path: Option<PathBuf>,
    /// Optional jump host (bastion / ProxyJump) — connect to the target through it.
    pub jump_host: Option<String>,
    pub jump_port: Option<u16>,
    pub jump_username: Option<String>,
    /// Wiped on drop (see `password`).
    pub jump_password: Option<zeroize::Zeroizing<String>>,
}

impl std::fmt::Debug for ConnectionConfig {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Redact every secret-bearing field: Debug output (logs, panics, `{:?}`)
        // must never dump passwords, passphrases, or key material.
        let redact = |v: &Option<zeroize::Zeroizing<String>>| v.as_ref().map(|_| "[REDACTED]");
        f.debug_struct("ConnectionConfig")
            .field("host", &self.host)
            .field("port", &self.port)
            .field("username", &self.username)
            .field("auth_type", &self.auth_type)
            .field("password", &redact(&self.password))
            .field("private_key", &redact(&self.private_key))
            .field("key_passphrase", &redact(&self.key_passphrase))
            .field("keep_alive_interval", &self.keep_alive_interval)
            .field("known_hosts_path", &self.known_hosts_path)
            .field("jump_host", &self.jump_host)
            .field("jump_port", &self.jump_port)
            .field("jump_username", &self.jump_username)
            .field("jump_password", &redact(&self.jump_password))
            .finish()
    }
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

pub struct ClientHandler {
    host_port: String,
    known_hosts_path: Option<PathBuf>,
    /// Why check_server_key rejected the host key, so connect() can surface
    /// the mismatch details (possible MITM / re-imaged device) instead of
    /// russh's opaque "unknown key" error.
    reject_reason: Arc<std::sync::Mutex<Option<String>>>,
    /// Non-fatal host-key advisory (new algorithm recorded for a known host),
    /// surfaced to the frontend so it can toast a warning on connect.
    warning: Arc<std::sync::Mutex<Option<String>>>,
}

impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        server_public_key: &PublicKeyOrCertificate,
    ) -> Result<bool, Self::Error> {
        let pk = server_public_key.public_key();
        match &self.known_hosts_path {
            Some(path) => {
                let fingerprint = tofu_fingerprint(&pk);
                let key_type = tofu_key_type(&pk);
                match crate::ssh::known_hosts::verify_or_record(
                    path,
                    &self.host_port,
                    &key_type,
                    &fingerprint,
                ) {
                    Ok(outcome) => {
                        // A previously-known host presenting a NEW key algorithm
                        // is accepted (TOFU), but an unexpected algorithm can
                        // signal a downgrade attempt — flag it so connect() can
                        // surface a warning to the user.
                        if outcome == crate::ssh::known_hosts::KeyVerifyResult::NewAlgorithm {
                            let msg = format!(
                                "Host {} presented a new host key algorithm ({}) with fingerprint \
                                 {}. It was recorded alongside the existing trusted key(s) — verify \
                                 this change was expected (firmware upgrade / new key); otherwise \
                                 this could be a downgrade attempt.",
                                self.host_port, key_type, fingerprint
                            );
                            log::warn!("{}", msg);
                            if let Ok(mut g) = self.warning.lock() {
                                *g = Some(msg);
                            }
                        }
                        Ok(true)
                    }
                    Err(reason) => {
                        log::warn!("Rejected SSH host key: {}", reason);
                        if let Ok(mut g) = self.reject_reason.lock() {
                            *g = Some(reason.to_string());
                        }
                        Ok(false)
                    }
                }
            }
            // No store configured → REJECT (fail closed). Accepting any key
            // here would silently re-open the MITM hole; every production call
            // site passes a path, so a missing one is a programming error.
            None => {
                let reason =
                    "No known_hosts store configured — refusing to accept an unverified host key";
                log::warn!("Rejected SSH host key: {}", reason);
                if let Ok(mut g) = self.reject_reason.lock() {
                    *g = Some(reason.to_string());
                }
                Ok(false)
            }
        }
    }
}

#[cfg(unix)]
async fn connect_ssh_agent(
) -> Result<russh::keys::agent::client::AgentClient<tokio::net::UnixStream>, russh::keys::Error> {
    russh::keys::agent::client::AgentClient::connect_env().await
}

// russh-keys 0.43's connect_env on non-unix always returned AgentFailure.
// Keep that behavior rather than taking a new pageant dependency this PR.
#[cfg(not(unix))]
async fn connect_ssh_agent(
) -> Result<russh::keys::agent::client::AgentClient<tokio::net::TcpStream>, russh::keys::Error> {
    Err(russh::keys::Error::AgentFailure)
}

async fn rsa_hash_alg(handle: &client::Handle<ClientHandler>) -> Option<russh::keys::HashAlg> {
    handle
        .best_supported_rsa_hash()
        .await
        .ok()
        .flatten()
        .flatten()
}

impl SshConnection {
    pub fn new(session_id: String, config: ConnectionConfig) -> Self {
        Self {
            session_id,
            config,
            handle: None,
            channel_writer: None,
            channel_reader_task: None,
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

        // The primary channel reader task owns the only sender: when the channel
        // ends, its sender drops and signals EOF to the supervisor. Do NOT retain
        // a clone here.
        let (data_tx, data_rx) = channel::<Vec<u8>>(1024);

        let reject_reason: Arc<std::sync::Mutex<Option<String>>> =
            Arc::new(std::sync::Mutex::new(None));
        // Non-fatal host-key advisories recorded by check_server_key (e.g. a
        // new algorithm on a known host); threaded back like reject_reason.
        let warning: Arc<std::sync::Mutex<Option<String>>> = Arc::new(std::sync::Mutex::new(None));
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
            host_port: format!("{}:{}", self.config.host, self.config.port),
            known_hosts_path: self.config.known_hosts_path.clone(),
            reject_reason: reject_reason.clone(),
            warning: warning.clone(),
        };

        // Connect directly, or tunnel through a jump host (ProxyJump) when set.
        let mut handle = if let Some(ref jump_host) = self.config.jump_host {
            let jump_port = self.config.jump_port.unwrap_or(22);
            // The jump session only transports forwarded traffic. Its handler
            // verifies the jump host key but never owns terminal output.
            let jump_handler = ClientHandler {
                host_port: format!("{}:{}", jump_host, jump_port),
                known_hosts_path: self.config.known_hosts_path.clone(),
                reject_reason: reject_reason.clone(),
                warning: warning.clone(),
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
            let jump_pass = self
                .config
                .jump_password
                .as_ref()
                .map(|z| z.as_str())
                .unwrap_or_default();
            let mut jump_ok = false;
            // Track WHY key auth to the bastion failed so the final error can
            // say more than "tried password, key, and agent".
            let mut jump_key_err: Option<String> = None;
            if !jump_pass.is_empty() {
                jump_ok = jump
                    .authenticate_password(&jump_user, jump_pass)
                    .await
                    .map_err(|e| AppError::SshError(format!("Jump host auth failed: {}", e)))?
                    .success();
            }
            if !jump_ok {
                if let Some(ref key_str) = self.config.private_key {
                    match SshKeyManager::load_private_key(
                        key_str.as_bytes(),
                        self.config.key_passphrase.as_ref().map(|z| z.as_str()),
                    ) {
                        Ok(kp) => {
                            let hash = rsa_hash_alg(&jump).await;
                            match jump
                                .authenticate_publickey(
                                    &jump_user,
                                    PrivateKeyWithHashAlg::new(Arc::new(kp), hash),
                                )
                                .await
                            {
                                Ok(v) => jump_ok = v.success(),
                                Err(e) => jump_key_err = Some(e.to_string()),
                            }
                        }
                        Err(e) => jump_key_err = Some(e.to_string()),
                    }
                }
            }
            if !jump_ok {
                if let Ok(mut agent) = connect_ssh_agent().await {
                    if let Ok(identities) = agent.request_identities().await {
                        let hash = rsa_hash_alg(&jump).await;
                        for ident in identities {
                            let pubkey = ident.public_key().into_owned();
                            match jump
                                .authenticate_publickey_with(
                                    jump_user.clone(),
                                    pubkey,
                                    hash,
                                    &mut agent,
                                )
                                .await
                            {
                                Ok(v) if v.success() => {
                                    jump_ok = true;
                                    break;
                                }
                                _ => {}
                            }
                        }
                    }
                }
            }
            if !jump_ok {
                let detail = jump_key_err
                    .map(|e| format!("; key auth error: {}", e))
                    .unwrap_or_default();
                return Err(AppError::AuthError(format!(
                    "Jump host authentication failed (tried password, key, and agent{})",
                    detail
                )));
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
                let password: &str = self
                    .config
                    .password
                    .as_ref()
                    .map(|z| z.as_str())
                    .unwrap_or_default();
                let auth_res = handle
                    .authenticate_password(&self.config.username, password)
                    .await
                    .map_err(|e| AppError::SshError(format!("Auth failed: {}", e)))?;

                if !auth_res.success() {
                    // Fall back to keyboard-interactive: lots of network gear
                    // (TACACS+/RADIUS) presents the password via a challenge
                    // prompt rather than the `password` auth method. Answer each
                    // prompt with the same password.
                    use russh::client::KeyboardInteractiveAuthResponse;
                    let mut authed = false;
                    let mut first_round = true;
                    let mut res = handle
                        .authenticate_keyboard_interactive_start(self.config.username.clone(), None)
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
                            KeyboardInteractiveAuthResponse::Failure { .. } => break,
                            KeyboardInteractiveAuthResponse::InfoRequest { prompts, .. } => {
                                // Only answer the FIRST prompt of the FIRST round with the
                                // password — never blast it into every prompt (a second
                                // factor / OTP prompt must not receive the password).
                                let answers: Vec<String> = prompts
                                    .iter()
                                    .enumerate()
                                    .map(|(i, _)| {
                                        if first_round && i == 0 {
                                            // russh's API takes owned responses — the
                                            // answer String here is an unavoidable
                                            // boundary copy (single first-round answer,
                                            // consumed by russh, never retained locally).
                                            password.to_string()
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
                    let passphrase = self.config.key_passphrase.as_ref().map(|z| z.as_str());
                    SshKeyManager::load_private_key(key_str.as_bytes(), passphrase)?
                } else {
                    return Err(AppError::AuthError("No private key provided".into()));
                };

                let hash = rsa_hash_alg(&handle).await;
                let auth_res = handle
                    .authenticate_publickey(
                        &self.config.username,
                        PrivateKeyWithHashAlg::new(Arc::new(key_pair), hash),
                    )
                    .await
                    .map_err(|e| AppError::SshError(format!("Key auth failed: {}", e)))?;

                if !auth_res.success() {
                    return Err(AppError::AuthError(
                        "Public key authentication failed".into(),
                    ));
                }
            }
            AuthType::Agent => {
                // Authenticate against a running ssh-agent (SSH_AUTH_SOCK on
                // unix; the OpenSSH/Pageant pipe on Windows). Try each loaded
                // identity until one is accepted.
                let mut agent = connect_ssh_agent().await.map_err(|e| {
                    AppError::AuthError(format!(
                        "Could not reach ssh-agent (is it running / SSH_AUTH_SOCK set?): {}",
                        e
                    ))
                })?;
                let identities = agent
                    .request_identities()
                    .await
                    .map_err(|e| AppError::AuthError(format!("ssh-agent request failed: {}", e)))?;
                if identities.is_empty() {
                    return Err(AppError::AuthError(
                        "ssh-agent has no keys loaded (run `ssh-add`)".into(),
                    ));
                }
                let mut authenticated = false;
                let hash = rsa_hash_alg(&handle).await;
                for ident in identities {
                    let pubkey = ident.public_key().into_owned();
                    match handle
                        .authenticate_publickey_with(
                            self.config.username.clone(),
                            pubkey,
                            hash,
                            &mut agent,
                        )
                        .await
                    {
                        Ok(v) if v.success() => {
                            authenticated = true;
                            break;
                        }
                        _ => {}
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

        channel.request_shell(true).await.map_err(|_| {
            AppError::SshError(
                "The server refused to start a shell (restricted account or forced-command key?)"
                    .into(),
            )
        })?;

        let (mut channel_reader, channel_writer) = channel.split();
        let channel_reader_task = tokio::spawn(async move {
            while let Some(message) = channel_reader.wait().await {
                let data = match message {
                    ChannelMsg::Data { data } | ChannelMsg::ExtendedData { data, .. } => data,
                    ChannelMsg::Eof | ChannelMsg::Close => break,
                    _ => continue,
                };

                if data_tx.send(data.to_vec()).await.is_err() {
                    break;
                }
            }
        });

        self.handle = Some(Arc::new(Mutex::new(handle)));
        self.channel_writer = Some(channel_writer);
        self.channel_reader_task = Some(channel_reader_task);
        self.data_receiver = Some(data_rx);
        self.connected = true;

        Ok(ConnectResponse {
            session_id: self.session_id.clone(),
            success: true,
            error: None,
            warning: warning.lock().ok().and_then(|g| g.clone()),
        })
    }

    pub async fn disconnect(&mut self) -> Result<(), AppError> {
        // Close the session channel BEFORE disconnecting the handle: russh's
        // handle.disconnect() only sends SSH_MSG_DISCONNECT and never closes
        // the open channel, so the server keeps the shell (and omp/pty) alive
        // across a reconnect — leaving the old live session + new one fighting,
        // which showed up as a doubled HUD line and keystrokes going to a
        // half-dead channel. Sending CHANNEL_CLOSE lets sshd reap the shell.
        if let Some(ref channel_writer) = self.channel_writer {
            let _ = channel_writer.close().await;
        }
        if let Some(channel_reader_task) = self.channel_reader_task.take() {
            channel_reader_task.abort();
            let _ = channel_reader_task.await;
        }
        if let Some(ref handle) = self.handle {
            let handle = handle.lock().await;
            let _ = handle
                .disconnect(Disconnect::ByApplication, "Closing", "")
                .await;
        }
        self.channel_writer = None;
        self.handle = None;
        self.jump_handle = None;
        self.connected = false;
        Ok(())
    }

    pub async fn send(&self, data: &[u8]) -> Result<(), AppError> {
        if let Some(ref channel_writer) = self.channel_writer {
            channel_writer
                .data(data)
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
        if let Some(ref channel_writer) = self.channel_writer {
            channel_writer
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

#[cfg(test)]
mod tests {
    use super::*;
    use russh::keys::{Algorithm, PrivateKey};
    use russh::server::{self, Session};
    use russh::{Channel, ChannelId};
    use std::time::{Duration, SystemTime, UNIX_EPOCH};
    use tokio::net::TcpListener;
    use tokio::sync::oneshot;
    use tokio::task::JoinHandle;
    use tokio::time::timeout;

    const BURST_MESSAGE_COUNT: usize = 256;
    const AWAIT_TIMEOUT: Duration = Duration::from_secs(10);
    const SERVER_LIFETIME_TIMEOUT: Duration = Duration::from_secs(30);

    fn indexed_message(index: usize) -> Vec<u8> {
        format!("channel-data-{index:03}\n").into_bytes()
    }

    struct DrainTestServer {
        probe_tx: Option<oneshot::Sender<Vec<u8>>>,
    }

    impl server::Handler for DrainTestServer {
        type Error = russh::Error;

        async fn auth_password(
            &mut self,
            _user: &str,
            _password: &str,
        ) -> Result<server::Auth, Self::Error> {
            Ok(server::Auth::Accept)
        }

        async fn channel_open_session(
            &mut self,
            _channel: Channel<server::Msg>,
            reply: server::ChannelOpenHandle,
            _session: &mut Session,
        ) -> Result<(), Self::Error> {
            reply.accept().await;
            Ok(())
        }

        async fn pty_request(
            &mut self,
            channel: ChannelId,
            _term: &str,
            _col_width: u32,
            _row_height: u32,
            _pix_width: u32,
            _pix_height: u32,
            _modes: &[(russh::Pty, u32)],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            Ok(())
        }

        async fn shell_request(
            &mut self,
            channel: ChannelId,
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            session.channel_success(channel)?;
            let handle = session.handle();
            tokio::spawn(async move {
                let send_burst = async {
                    for index in 0..BURST_MESSAGE_COUNT {
                        handle
                            .data(channel, indexed_message(index))
                            .await
                            .map_err(|_| ())?;
                    }
                    Ok::<(), ()>(())
                };
                let _ = timeout(AWAIT_TIMEOUT, send_burst).await;
            });
            Ok(())
        }

        async fn data(
            &mut self,
            channel: ChannelId,
            data: &[u8],
            session: &mut Session,
        ) -> Result<(), Self::Error> {
            if let Some(probe_tx) = self.probe_tx.take() {
                let _ = probe_tx.send(data.to_vec());
            }
            if data == b"probe" {
                session.data(channel, b"pong".to_vec())?;
                session.eof(channel)?;
                session.close(channel)?;
            }
            Ok(())
        }
    }

    struct AbortOnDropTask(Option<JoinHandle<()>>);

    impl AbortOnDropTask {
        fn new(task: JoinHandle<()>) -> Self {
            Self(Some(task))
        }

        async fn stop(mut self) {
            if let Some(task) = self.0.take() {
                task.abort();
                let _ = timeout(AWAIT_TIMEOUT, task).await;
            }
        }
    }

    impl Drop for AbortOnDropTask {
        fn drop(&mut self) {
            if let Some(task) = self.0.take() {
                task.abort();
            }
        }
    }

    struct TempTofuDir {
        path: PathBuf,
    }

    impl TempTofuDir {
        fn create() -> Result<Self, String> {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map_err(|error| format!("system clock before Unix epoch: {error}"))?
                .as_nanos();
            let path = std::env::temp_dir().join(format!(
                "greencli-channel-drain-{}-{nonce}",
                std::process::id()
            ));
            std::fs::create_dir(&path)
                .map_err(|error| format!("create temporary TOFU directory: {error}"))?;
            Ok(Self { path })
        }

        fn known_hosts_path(&self) -> PathBuf {
            self.path.join("known_hosts.json")
        }
    }

    impl Drop for TempTofuDir {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.path);
        }
    }

    async fn start_loopback_server() -> Result<
        (
            std::net::SocketAddr,
            oneshot::Receiver<Vec<u8>>,
            AbortOnDropTask,
        ),
        String,
    > {
        let host_key = PrivateKey::random(&mut rand_os::rng(), Algorithm::Ed25519)
            .map_err(|error| format!("generate Ed25519 host key: {error}"))?;
        let server_config = Arc::new(server::Config {
            auth_rejection_time: Duration::ZERO,
            auth_rejection_time_initial: Some(Duration::ZERO),
            keys: vec![host_key],
            ..Default::default()
        });
        let listener = timeout(AWAIT_TIMEOUT, TcpListener::bind(("127.0.0.1", 0)))
            .await
            .map_err(|_| "timed out binding loopback SSH server".to_string())?
            .map_err(|error| format!("bind loopback SSH server: {error}"))?;
        let address = listener
            .local_addr()
            .map_err(|error| format!("read loopback SSH server address: {error}"))?;
        let (probe_tx, probe_rx) = oneshot::channel();

        let task = tokio::spawn(async move {
            let accepted = timeout(AWAIT_TIMEOUT, listener.accept()).await;
            let Ok(Ok((socket, _))) = accepted else {
                return;
            };
            let running = timeout(
                AWAIT_TIMEOUT,
                server::run_stream(
                    server_config,
                    socket,
                    DrainTestServer {
                        probe_tx: Some(probe_tx),
                    },
                ),
            )
            .await;
            let Ok(Ok(running)) = running else {
                return;
            };
            let _ = timeout(SERVER_LIFETIME_TIMEOUT, running).await;
        });

        Ok((address, probe_rx, AbortOnDropTask::new(task)))
    }

    async fn run_channel_drain_regression() -> Result<(), String> {
        let tofu_dir = TempTofuDir::create()?;
        let (address, probe_rx, server_task) = start_loopback_server().await?;
        let mut connection = SshConnection::new(
            "channel-drain-regression".to_string(),
            ConnectionConfig {
                host: address.ip().to_string(),
                port: address.port(),
                username: "test-user".to_string(),
                auth_type: AuthType::Password,
                password: Some(zeroize::Zeroizing::new("test-password".to_string())),
                private_key: None,
                key_passphrase: None,
                keep_alive_interval: None,
                known_hosts_path: Some(tofu_dir.known_hosts_path()),
                jump_host: None,
                jump_port: None,
                jump_username: None,
                jump_password: None,
            },
        );

        let test_result = async {
            timeout(AWAIT_TIMEOUT, connection.connect())
                .await
                .map_err(|_| "timed out connecting production SSH client".to_string())?
                .map_err(|error| format!("connect production SSH client: {error}"))?;
            let mut output = connection
                .take_data_receiver()
                .ok_or_else(|| "production client did not expose its output receiver".to_string())?;

            for index in 0..BURST_MESSAGE_COUNT {
                let actual = timeout(AWAIT_TIMEOUT, output.recv())
                    .await
                    .map_err(|_| format!("timed out waiting for indexed message {index}"))?
                    .ok_or_else(|| format!("output closed before indexed message {index}"))?;
                let expected = indexed_message(index);
                if actual != expected {
                    return Err(format!(
                        "indexed message {index} out of order: expected {expected:?}, got {actual:?}"
                    ));
                }
            }

            timeout(AWAIT_TIMEOUT, connection.send(b"probe"))
                .await
                .map_err(|_| "timed out sending probe after output burst".to_string())?
                .map_err(|error| format!("send probe after output burst: {error}"))?;

            let observed_probe = timeout(AWAIT_TIMEOUT, probe_rx)
                .await
                .map_err(|_| "timed out waiting for server to observe probe".to_string())?
                .map_err(|_| "server dropped probe observer".to_string())?;
            if observed_probe != b"probe" {
                return Err(format!(
                    "server observed unexpected input: {observed_probe:?}"
                ));
            }

            let pong = timeout(AWAIT_TIMEOUT, output.recv())
                .await
                .map_err(|_| "timed out waiting for pong".to_string())?
                .ok_or_else(|| "output closed before pong".to_string())?;
            if pong != b"pong" {
                return Err(format!("expected pong, got {pong:?}"));
            }

            let after_close = timeout(AWAIT_TIMEOUT, output.recv())
                .await
                .map_err(|_| "output receiver stayed open after EOF/close".to_string())?;
            if let Some(extra) = after_close {
                return Err(format!("unexpected output after pong: {extra:?}"));
            }

            Ok(())
        }
        .await;

        let disconnect_result = timeout(AWAIT_TIMEOUT, connection.disconnect())
            .await
            .map_err(|_| "timed out disconnecting production SSH client".to_string())
            .and_then(|result| {
                result.map_err(|error| format!("disconnect production SSH client: {error}"))
            });
        server_task.stop().await;
        drop(tofu_dir);

        test_result?;
        disconnect_result
    }

    #[tokio::test]
    async fn drains_more_than_russh_channel_buffer_and_keeps_input_writable() {
        if let Err(error) = run_channel_drain_regression().await {
            panic!("{error}");
        }
    }
}
