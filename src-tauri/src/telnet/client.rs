use crate::error::AppError;
use crate::ssh::client::{ConnectResponse, Connection};
use async_trait::async_trait;
use serde::Serialize;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt, WriteHalf};
use tokio::net::TcpStream;
use tokio::sync::mpsc::{channel, Sender};
use tokio::sync::Mutex;

// Telnet command codes (RFC 854) — only those actually handled below.
const IAC: u8 = 255;
const DONT: u8 = 254;
const DO: u8 = 253;
const WONT: u8 = 252;
const WILL: u8 = 251;
const SB: u8 = 250;
const SE: u8 = 240;

// Telnet options
const OPT_ECHO: u8 = 1;
const OPT_SUPPRESS_GO_AHEAD: u8 = 3;

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
    pub reader_task: Option<tokio::task::JoinHandle<()>>,
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
            reader_task: None,
            connected: false,
        }
    }

    pub fn take_data_receiver(&mut self) -> Option<tokio::sync::mpsc::Receiver<Vec<u8>>> {
        self.data_receiver.take()
    }

    async fn negotiate_options(&self, stream: &mut TcpStream) -> Result<(), AppError> {
        // As an interactive terminal client we want the REMOTE end to echo, so
        // we request `DO ECHO` (and `WONT ECHO` ourselves). Offering `WILL ECHO`
        // — as this used to — tells the server *we* will echo, which is
        // backwards and leaves typed input unechoed on many devices.
        let negotiate = [
            IAC, WILL, OPT_SUPPRESS_GO_AHEAD,
            IAC, DO, OPT_SUPPRESS_GO_AHEAD,
            IAC, DO, OPT_ECHO,
            IAC, WONT, OPT_ECHO,
        ];
        stream.write_all(&negotiate).await.map_err(AppError::from)?;
        stream.flush().await.map_err(AppError::from)?;
        Ok(())
    }

    /// Number of trailing bytes that form an INCOMPLETE telnet command sequence
    /// (an IAC negotiation split across two reads). Those bytes must be carried
    /// over to the next read instead of being treated as data.
    fn incomplete_tail_len(data: &[u8]) -> usize {
        // Walk backwards to the last IAC that could start an unterminated seq.
        let n = data.len();
        if n == 0 {
            return 0;
        }
        // Lone trailing IAC.
        if data[n - 1] == IAC {
            return 1;
        }
        // IAC + negotiation verb with the option byte still missing.
        if n >= 2 && data[n - 2] == IAC && matches!(data[n - 1], WILL | WONT | DO | DONT) {
            return 2;
        }
        // Unterminated sub-negotiation: an IAC SB with no following IAC SE.
        let mut i = 0;
        let mut sb_start: Option<usize> = None;
        while i + 1 < n {
            if data[i] == IAC {
                match data[i + 1] {
                    SB => {
                        sb_start = Some(i);
                        i += 2;
                        continue;
                    }
                    SE => {
                        sb_start = None;
                        i += 2;
                        continue;
                    }
                    WILL | WONT | DO | DONT => {
                        i += 3;
                        continue;
                    }
                    _ => {
                        i += 2;
                        continue;
                    }
                }
            }
            i += 1;
        }
        sb_start.map(|s| n - s).unwrap_or(0)
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
                    IAC => {
                        // IAC IAC (255 255) is an ESCAPED single 0xFF data byte
                        // (RFC 854) — emit ONE 0xFF, don't drop both. Otherwise any
                        // real data containing 0xFF is silently corrupted.
                        result.push(IAC);
                        i += 2;
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

        // Spawn background task to read from TCP stream and forward to channel.
        // `carry` holds the tail of a telnet command sequence that was split
        // across a read boundary so it is parsed correctly next time.
        let reader_task = tokio::spawn(async move {
            let mut reader = read_half;
            let mut buf = vec![0u8; 4096];
            let mut carry: Vec<u8> = Vec::new();
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        let mut chunk = std::mem::take(&mut carry);
                        chunk.extend_from_slice(&buf[..n]);
                        let keep = TelnetConnection::incomplete_tail_len(&chunk);
                        let split = chunk.len() - keep;
                        if keep > 0 {
                            carry = chunk[split..].to_vec();
                        }
                        let processed = TelnetConnection::process_telnet_data(&chunk[..split]);
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
        self.reader_task = Some(reader_task);
        self.connected = true;

        Ok(ConnectResponse {
            session_id: self.session_id.clone(),
            success: true,
            error: None,
        })
    }

    async fn disconnect(&mut self) -> Result<(), AppError> {
        self.connected = false;
        // Shut the write half down first so the peer sees a clean FIN…
        if let Some(wh) = self.write_half.take() {
            if let Ok(mut w) = wh.try_lock() {
                let _ = w.shutdown().await;
            }
        }
        // …then abort the reader task so its read half drops and the TCP
        // socket is fully released (previously it lingered until the peer
        // closed, leaking the connection).
        if let Some(task) = self.reader_task.take() {
            task.abort();
        }
        self.data_sender = None;
        self.data_receiver = None;
        Ok(())
    }

    async fn send(&self, data: &[u8]) -> Result<(), AppError> {
        if let Some(ref wh) = self.write_half {
            let mut w = wh.lock().await;
            w.write_all(data)
                .await
                .map_err(|e| AppError::TelnetError(format!("Write error: {}", e)))?;
            w.flush()
                .await
                .map_err(|e| AppError::TelnetError(format!("Flush error: {}", e)))?;
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
