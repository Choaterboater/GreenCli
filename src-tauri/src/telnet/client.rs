use crate::error::AppError;
use crate::ssh::client::{ConnectResponse, Connection};
use async_trait::async_trait;
use serde::Serialize;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{channel, Sender};
use tokio::sync::Mutex;

// Telnet command codes (RFC 854)
const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const GA: u8 = 249;
const EL: u8 = 248;
const EC: u8 = 247;
const AYT: u8 = 246;
const AO: u8 = 245;
const IP: u8 = 244;
const BREAK: u8 = 243;
const DM: u8 = 242;
const NOP: u8 = 241;
const SE: u8 = 240;
const EOR: u8 = 239;

// Telnet options
const OPT_ECHO: u8 = 1;
const OPT_SUPPRESS_GO_AHEAD: u8 = 3;
const OPT_STATUS: u8 = 5;
const OPT_TIMING_MARK: u8 = 6;
const OPT_TERMINAL_TYPE: u8 = 24;
const OPT_WINDOW_SIZE: u8 = 31;
const OPT_TERMINAL_SPEED: u8 = 32;
const OPT_REMOTE_FLOW_CONTROL: u8 = 33;
const OPT_LINEMODE: u8 = 34;
const OPT_ENVIRONMENT: u8 = 36;

#[derive(Clone, Debug, Serialize)]
pub struct TelnetConfig {
    pub id: String,
    pub host: String,
    pub port: u16,
}

pub struct TelnetConnection {
    pub session_id: String,
    pub config: TelnetConfig,
    pub write_half: Option<Arc<Mutex<WriteHalf<TcpStream>>>>,
    pub data_sender: Option<Sender<Vec<u8>>>,
    pub data_receiver: Option<tokio::sync::mpsc::Receiver<Vec<u8>>>,
    pub connected: bool,
}

impl TelnetConnection {
    pub fn new(session_id: String, config: TelnetConfig) -> Self {
        Self {
            session_id,
            config,
            write_half: None,
            data_sender: None,
            data_receiver: None,
            connected: false,
        }
    }

    pub fn take_data_receiver(&mut self) -> Option<tokio::sync::mpsc::Receiver<Vec<u8>>> {
        self.data_receiver.take()
    }

    async fn negotiate_options(&self, stream: &mut TcpStream) -> Result<(), AppError> {
        // Send WILL SUPPRESS_GO_AHEAD and WILL ECHO
        let negotiate = [
            IAC, WILL, OPT_SUPPRESS_GO_AHEAD,
            IAC, WILL, OPT_ECHO,
            IAC, DO, OPT_SUPPRESS_GO_AHEAD,
        ];
        stream.write_all(&negotiate).await.map_err(AppError::from)?;
        stream.flush().await.map_err(AppError::from)?;
        Ok(())
    }

    fn process_telnet_data(data: &[u8]) -> Vec<u8> {
        let mut result = Vec::with_capacity(data.len());
        let mut i = 0;
        while i < data.len() {
            if data[i] == IAC && i + 1 < data.len() {
                let cmd = data[i + 1];
                match cmd {
                    WILL | WONT | DO | DONT => {
                        // Skip 3-byte command sequence
                        i += 3;
                        continue;
                    }
                    SB => {
                        // Skip until IAC SE
                        i += 2;
                        while i < data.len() - 1 {
                            if data[i] == IAC && data[i + 1] == SE {
                                i += 2;
                                break;
                            }
                            i += 1;
                        }
                        continue;
                    }
                    _ => {
                        // Skip 2-byte command
                        i += 2;
                        continue;
                    }
                }
            }
            result.push(data[i]);
            i += 1;
        }
        result
    }
}

#[async_trait]
impl Connection for TelnetConnection {
    async fn connect(&mut self) -> Result<ConnectResponse, AppError> {
        let addr = format!("{}:{}", self.config.host, self.config.port);
        let mut stream = TcpStream::connect(&addr)
            .await
            .map_err(|e| AppError::TelnetError(format!("Connect: {}", e)))?;

        self.negotiate_options(&mut stream).await?;

        let (read_half, write_half) = tokio::io::split(stream);
        let (data_tx, data_rx) = channel::<Vec<u8>>(1024);

        // Spawn background task to read from TCP stream and forward to channel
        tokio::spawn(async move {
            let mut reader = read_half;
            let mut buf = vec![0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let processed = TelnetConnection::process_telnet_data(&buf[..n]);
                        if !processed.is_empty() && data_tx.send(processed).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        self.data_sender = None;
        self.write_half = Some(Arc::new(Mutex::new(write_half)));
        self.data_receiver = Some(data_rx);
        self.connected = true;

        Ok(ConnectResponse {
            session_id: self.session_id.clone(),
            success: true,
            error: None,
        })
    }

    async fn disconnect(&mut self) -> Result<(), AppError> {
        self.connected = false;
        self.write_half = None;
        self.data_sender = None;
        self.data_receiver = None;
        Ok(())
    }

    async fn send(&self, data: &[u8]) -> Result<(), AppError> {
        if let Some(ref wh) = self.write_half {
            let mut w = wh.lock().await;
            w.write_all(data).await.map_err(|e| {
                AppError::TelnetError(format!("Write error: {}", e))
            })?;
            w.flush().await.map_err(|e| {
                AppError::TelnetError(format!("Flush error: {}", e))
            })?;
            Ok(())
        } else {
            Err(AppError::TelnetError("Not connected".into()))
        }
    }

    async fn resize(&self, _cols: u16, _rows: u16) -> Result<(), AppError> {
        // Telnet NAWS option would be sent here
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn get_session_id(&self) -> String {
        self.session_id.clone()
    }
}
