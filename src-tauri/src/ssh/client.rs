use crate::error::AppError;
use crate::ssh::keys::SshKeyManager;
use async_trait::async_trait;
use russh::client::Handler;
use russh::{client, Channel, ChannelId, Disconnect};
use russh_keys::key;
use serde::Serialize;
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
    pub data_sender: Option<Sender<Vec<u8>>>,
    pub data_receiver: Option<tokio::sync::mpsc::Receiver<Vec<u8>>>,
    pub connected: bool,
}

#[derive(Clone, Debug)]
pub struct ConnectionConfig {
    pub id: String,
    pub host: String,
    pub port: u16,
    pub username: String,
    pub auth_type: AuthType,
    pub password: Option<String>,
    pub private_key: Option<String>,
    pub key_passphrase: Option<String>,
    /// Seconds between SSH keepalive probes. `None`/`0` disables keepalives.
    pub keep_alive_interval: Option<u64>,
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
}

#[async_trait]
impl Handler for ClientHandler {
    type Error = russh::Error;

    async fn check_server_key(
        &mut self,
        _server_public_key: &key::PublicKey,
    ) -> Result<bool, Self::Error> {
        Ok(true)
    }

    async fn data(
        &mut self,
        _channel: ChannelId,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let _ = self.sender.try_send(data.to_vec());
        Ok(())
    }

    async fn extended_data(
        &mut self,
        _channel: ChannelId,
        _ext: u32,
        data: &[u8],
        _session: &mut client::Session,
    ) -> Result<(), Self::Error> {
        let _ = self.sender.try_send(data.to_vec());
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
            data_sender: None,
            data_receiver: None,
            connected: false,
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

        let (data_tx, data_rx) = channel::<Vec<u8>>(1024);
        self.data_sender = Some(data_tx.clone());

        let handler = ClientHandler { sender: data_tx };
        let mut handle = russh::client::connect(
            client_config,
            (self.config.host.clone(), self.config.port),
            handler,
        )
        .await
        .map_err(|e| AppError::SshError(format!("Connection failed: {}", e)))?;

        // Authenticate
        match self.config.auth_type {
            AuthType::Password => {
                let password = self.config.password.clone().unwrap_or_default();
                let auth_res = handle
                    .authenticate_password(&self.config.username, password)
                    .await
                    .map_err(|e| AppError::SshError(format!("Auth failed: {}", e)))?;

                if !auth_res {
                    return Err(AppError::AuthError(
                        "Password authentication failed".into(),
                    ));
                }
            }
            AuthType::PublicKey => {
                let key_pair = if let Some(ref key_str) = self.config.private_key {
                    let passphrase = self.config.key_passphrase.as_deref();
                    SshKeyManager::load_private_key(key_str.as_bytes(), passphrase)?
                } else {
                    return Err(AppError::AuthError(
                        "No private key provided".into(),
                    ));
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
                return Err(AppError::AuthError(
                    "SSH agent auth not yet implemented".into(),
                ));
            }
        }

        // Open session channel with PTY
        let mut channel = handle
            .channel_open_session()
            .await
            .map_err(|e| AppError::SshError(format!("Channel open: {}", e)))?;

        channel
            .request_pty(
                false,
                &self.get_term_type(),
                80,
                24,
                0,
                0,
                &[],
            )
            .await
            .map_err(|e| AppError::SshError(format!("PTY request: {}", e)))?;

        channel
            .request_shell(false)
            .await
            .map_err(|e| AppError::SshError(format!("Shell request: {}", e)))?;

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
        self.data_sender = None;
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

    pub async fn resize(&self, cols: u16, rows: u16) -> Result<(), AppError> {
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
        self.connected
    }

    fn get_session_id(&self) -> String {
        self.session_id.clone()
    }
}
