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
const OPT_NAWS: u8 = 31; // Negotiate About Window Size (RFC 1073)

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
    /// Latest terminal size (cols, rows) — sent as a NAWS subnegotiation right
    /// after option negotiation and re-sent on every resize.
    pub size: Mutex<(u16, u16)>,
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
            size: Mutex::new((80, 24)),
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
        let mut negotiate = vec![
            IAC, WILL, OPT_SUPPRESS_GO_AHEAD,
            IAC, DO, OPT_SUPPRESS_GO_AHEAD,
            IAC, DO, OPT_ECHO,
            IAC, WONT, OPT_ECHO,
            IAC, WILL, OPT_NAWS,
        ];
        // The reader task strips all incoming negotiation, so we never see the
        // server's `DO NAWS`. Instead — like most clients — send the window
        // size unsolicited right after `WILL NAWS` (and again on every
        // resize); devices accept it once NAWS has been offered.
        let (cols, rows) = *self.size.lock().await;
        negotiate.extend_from_slice(&Self::naws_subnegotiation(cols, rows));
        stream.write_all(&negotiate).await.map_err(AppError::from)?;
        stream.flush().await.map_err(AppError::from)?;
        Ok(())
    }

    /// Build an `IAC SB NAWS w-hi w-lo h-hi h-lo IAC SE` window-size
    /// subnegotiation (RFC 1073). Any 0xFF byte in the payload (sizes whose
    /// hi/lo byte is 255) must be escaped as `IAC IAC` per RFC 855.
    fn naws_subnegotiation(cols: u16, rows: u16) -> Vec<u8> {
        let mut buf = vec![IAC, SB, OPT_NAWS];
        for byte in [
            (cols >> 8) as u8,
            (cols & 0xff) as u8,
            (rows >> 8) as u8,
            (rows & 0xff) as u8,
        ] {
            buf.push(byte);
            if byte == IAC {
                buf.push(IAC);
            }
        }
        buf.extend_from_slice(&[IAC, SE]);
        buf
    }

    /// Number of trailing bytes that form an INCOMPLETE telnet command sequence
    /// (an IAC negotiation split across two reads). Those bytes must be carried
    /// over to the next read instead of being treated as data.
    fn incomplete_tail_len(data: &[u8]) -> usize {
        // Forward scan with sequence context, so a trailing `IAC IAC` escape is
        // recognized as COMPLETE (carrying its second byte would merge it with
        // the next chunk and swallow a real data byte), and an open `IAC SB …`
        // subnegotiation carries from its start, not just the final byte.
        let n = data.len();
        let mut i = 0;
        let mut sb_start: Option<usize> = None;
        while i < n {
            if data[i] != IAC {
                i += 1;
                continue;
            }
            if i + 1 >= n {
                // Lone trailing IAC — could begin any sequence.
                return n - sb_start.unwrap_or(i);
            }
            match data[i + 1] {
                IAC => i += 2, // escaped 0xFF data byte — complete pair
                SB => {
                    if sb_start.is_none() {
                        sb_start = Some(i);
                    }
                    i += 2;
                }
                SE => {
                    sb_start = None;
                    i += 2;
                }
                WILL | WONT | DO | DONT => {
                    if i + 2 >= n {
                        // Verb present but option byte still missing.
                        return n - sb_start.unwrap_or(i);
                    }
                    i += 3;
                }
                _ => i += 2,
            }
        }
        sb_start.map(|s| n - s).unwrap_or(0)
    }

    /// Strip telnet commands from `data`, returning the remaining terminal
    /// bytes plus any negotiation REPLIES owed to the server. RFC 854 requires
    /// refusing options we don't support — a server waiting on an answer to
    /// `DO TERMINAL-TYPE` etc. can otherwise stall the session.
    fn process_telnet_data(data: &[u8]) -> (Vec<u8>, Vec<u8>) {
        let mut result = Vec::with_capacity(data.len());
        let mut replies: Vec<u8> = Vec::new();
        let mut i = 0;
        while i < data.len() {
            if data[i] == IAC && i + 1 < data.len() {
                let cmd = data[i + 1];
                match cmd {
                    WILL | WONT | DO | DONT => {
                        if i + 2 < data.len() {
                            let opt = data[i + 2];
                            match cmd {
                                // Options we advertised (WILL SGA/NAWS) or
                                // requested (DO ECHO/SGA) at connect need no
                                // further answer; refuse everything else. Only
                                // ever replying with refusals avoids ack loops.
                                DO if opt != OPT_SUPPRESS_GO_AHEAD && opt != OPT_NAWS => {
                                    replies.extend_from_slice(&[IAC, WONT, opt]);
                                }
                                WILL if opt != OPT_ECHO && opt != OPT_SUPPRESS_GO_AHEAD => {
                                    replies.extend_from_slice(&[IAC, DONT, opt]);
                                }
                                _ => {}
                            }
                        }
                        // Skip 3-byte command sequence
                        i += 3;
                        continue;
                    }
                    SB => {
                        // Skip subnegotiation payload until IAC SE. An IAC IAC
                        // inside is an escaped payload byte, not a terminator
                        // candidate; an unterminated SB (shouldn't happen with
                        // the carry logic) is swallowed, not leaked as data.
                        i += 2;
                        loop {
                            if i + 1 >= data.len() {
                                i = data.len();
                                break;
                            }
                            if data[i] == IAC {
                                if data[i + 1] == SE {
                                    i += 2;
                                    break;
                                }
                                i += 2;
                            } else {
                                i += 1;
                            }
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
        (result, replies)
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
        let write_half = Arc::new(Mutex::new(write_half));
        let writer_for_reader = write_half.clone();

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
                        let (processed, replies) =
                            TelnetConnection::process_telnet_data(&chunk[..split]);
                        if !replies.is_empty() {
                            let mut w = writer_for_reader.lock().await;
                            let _ = w.write_all(&replies).await;
                            let _ = w.flush().await;
                        }
                        if !processed.is_empty() && data_tx.send(processed).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

        self.data_sender = None;
        self.write_half = Some(write_half);
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
            // RFC 854: a literal 0xFF data byte must be escaped as IAC IAC or
            // the server reads it as the start of a command.
            let escaped: Vec<u8>;
            let payload: &[u8] = if data.contains(&IAC) {
                let mut out = Vec::with_capacity(data.len() + 4);
                for &b in data {
                    out.push(b);
                    if b == IAC {
                        out.push(IAC);
                    }
                }
                escaped = out;
                &escaped
            } else {
                data
            };
            let mut w = wh.lock().await;
            w.write_all(payload)
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

    async fn resize(&self, cols: u16, rows: u16) -> Result<(), AppError> {
        // Remember the size so negotiate_options() re-sends it on (re)connect.
        *self.size.lock().await = (cols, rows);
        if let Some(ref wh) = self.write_half {
            let mut w = wh.lock().await;
            w.write_all(&Self::naws_subnegotiation(cols, rows))
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

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn get_session_id(&self) -> String {
        self.session_id.clone()
    }
}
