use crate::error::AppError;
use crate::ssh::client::{ConnectResponse, Connection};
use async_trait::async_trait;
use serde::Serialize;
use std::sync::Arc;
use tokio::io::AsyncWriteExt;
use tokio::sync::mpsc::channel;
use tokio::sync::Mutex;
use tokio_serial::{DataBits, Parity, SerialPort, SerialPortBuilderExt, SerialStream, StopBits};

#[derive(Clone, Debug, Serialize)]
pub struct SerialConfig {
    pub id: String,
    pub port: String,
    pub baud_rate: u32,
    pub data_bits: u8,
    pub parity: String,
    pub stop_bits: u8,
}

pub struct SerialConnection {
    pub session_id: String,
    pub config: SerialConfig,
    // The whole serial stream, shared between the reader task and the
    // write/break paths. It is deliberately NOT split into read/write halves:
    // a serial BREAK (SerialPort::set_break) needs the underlying port, which
    // the opaque tokio::io split halves don't expose.
    stream: Option<Arc<Mutex<SerialStream>>>,
    data_receiver: Option<tokio::sync::mpsc::Receiver<Vec<u8>>>,
    reader_task: Option<tokio::task::JoinHandle<()>>,
    connected: bool,
}

impl SerialConnection {
    pub fn new(session_id: String, config: SerialConfig) -> Self {
        Self {
            session_id,
            config,
            stream: None,
            data_receiver: None,
            reader_task: None,
            connected: false,
        }
    }

    pub fn take_data_receiver(&mut self) -> Option<tokio::sync::mpsc::Receiver<Vec<u8>>> {
        self.data_receiver.take()
    }

    /// Send a serial BREAK: assert the break condition, hold it briefly, then
    /// release it. Network gear watches for a BREAK during boot to interrupt the
    /// boot sequence and drop into ROMMON / the bootloader (Cisco Ctrl-Break,
    /// Juniper/Aruba boot interrupt, etc.).
    pub async fn send_break(&self) -> Result<(), AppError> {
        if let Some(ref stream) = self.stream {
            let guard = stream.lock().await;
            guard
                .set_break()
                .map_err(|e| AppError::SerialError(format!("Set break: {}", e)))?;
            // A BREAK must be held longer than one character time; ~250ms is the
            // conventional console value the boot ROMs look for.
            tokio::time::sleep(std::time::Duration::from_millis(250)).await;
            guard
                .clear_break()
                .map_err(|e| AppError::SerialError(format!("Clear break: {}", e)))?;
            Ok(())
        } else {
            Err(AppError::SerialError("Serial port not connected".into()))
        }
    }

    fn data_bits(&self) -> DataBits {
        match self.config.data_bits {
            5 => DataBits::Five,
            6 => DataBits::Six,
            7 => DataBits::Seven,
            _ => DataBits::Eight,
        }
    }

    fn parity(&self) -> Parity {
        match self.config.parity.to_lowercase().as_str() {
            "even" => Parity::Even,
            "odd" => Parity::Odd,
            _ => Parity::None,
        }
    }

    fn stop_bits(&self) -> StopBits {
        match self.config.stop_bits {
            2 => StopBits::Two,
            _ => StopBits::One,
        }
    }
}

#[async_trait]
impl Connection for SerialConnection {
    async fn connect(&mut self) -> Result<ConnectResponse, AppError> {
        let stream = tokio_serial::new(&self.config.port, self.config.baud_rate)
            .data_bits(self.data_bits())
            .parity(self.parity())
            .stop_bits(self.stop_bits())
            .open_native_async()
            .map_err(|e| AppError::SerialError(format!("Open {}: {}", self.config.port, e)))?;

        // Share the whole stream (instead of tokio::io::split) so send() and a
        // BREAK can both reach the underlying port. try_read keeps the reader
        // non-blocking, so it only holds the lock momentarily.
        let stream = Arc::new(Mutex::new(stream));
        let (data_tx, data_rx) = channel::<Vec<u8>>(1024);

        // Spawn background reader forwarding serial bytes to the frontend channel.
        let reader_stream = stream.clone();
        let reader_task = tokio::spawn(async move {
            let mut buf = vec![0u8; 4096];
            loop {
                // Grab whatever is buffered without holding the lock across an
                // await, so writes / a BREAK aren't starved of the port.
                let chunk = {
                    let mut guard = reader_stream.lock().await;
                    match guard.try_read(&mut buf) {
                        Ok(0) => break,
                        Ok(n) => Some(buf[..n].to_vec()),
                        Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => None,
                        Err(_) => break,
                    }
                };
                match chunk {
                    Some(data) => {
                        if data_tx.send(data).await.is_err() {
                            break;
                        }
                    }
                    // Nothing pending: yield briefly (lock released) before
                    // polling again rather than spinning the CPU.
                    None => tokio::time::sleep(std::time::Duration::from_millis(5)).await,
                }
            }
        });

        self.stream = Some(stream);
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
        // Abort the reader so it drops its handle to the stream; once that and
        // self.stream (below) are both gone the serial port is released —
        // otherwise it stayed open and blocked re-opening the port.
        if let Some(task) = self.reader_task.take() {
            task.abort();
        }
        self.stream = None;
        self.data_receiver = None;
        Ok(())
    }

    async fn send(&self, data: &[u8]) -> Result<(), AppError> {
        if let Some(ref stream) = self.stream {
            let mut w = stream.lock().await;
            w.write_all(data)
                .await
                .map_err(|e| AppError::SerialError(format!("Write error: {}", e)))?;
            w.flush()
                .await
                .map_err(|e| AppError::SerialError(format!("Flush error: {}", e)))?;
            Ok(())
        } else {
            Err(AppError::SerialError("Serial port not connected".into()))
        }
    }

    async fn resize(&self, _cols: u16, _rows: u16) -> Result<(), AppError> {
        // Serial has no window-size concept.
        Ok(())
    }

    fn is_connected(&self) -> bool {
        self.connected
    }

    fn get_session_id(&self) -> String {
        self.session_id.clone()
    }

    async fn send_break(&self) -> Result<(), AppError> {
        SerialConnection::send_break(self).await
    }
}
