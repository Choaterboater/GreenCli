use crate::error::AppError;
use crate::ssh::client::{ConnectResponse, Connection};
use async_trait::async_trait;
use serde::Serialize;
use std::sync::Arc;
use tokio::io::{AsyncReadExt, AsyncWriteExt, ReadHalf, WriteHalf};
use tokio::sync::mpsc::channel;
use tokio::sync::Mutex;
use tokio_serial::{DataBits, Parity, SerialPortBuilderExt, SerialStream, StopBits};

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
    write_half: Option<Arc<Mutex<WriteHalf<SerialStream>>>>,
    data_receiver: Option<tokio::sync::mpsc::Receiver<Vec<u8>>>,
    connected: bool,
}

impl SerialConnection {
    pub fn new(session_id: String, config: SerialConfig) -> Self {
        Self {
            session_id,
            config,
            write_half: None,
            data_receiver: None,
            connected: false,
        }
    }

    pub fn take_data_receiver(&mut self) -> Option<tokio::sync::mpsc::Receiver<Vec<u8>>> {
        self.data_receiver.take()
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
            .map_err(|e| {
                AppError::SerialError(format!("Open {}: {}", self.config.port, e))
            })?;

        let (read_half, write_half): (ReadHalf<SerialStream>, WriteHalf<SerialStream>) =
            tokio::io::split(stream);
        let (data_tx, data_rx) = channel::<Vec<u8>>(1024);

        // Spawn background reader forwarding serial bytes to the frontend channel.
        tokio::spawn(async move {
            let mut reader = read_half;
            let mut buf = vec![0u8; 4096];
            loop {
                match reader.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(n) => {
                        if data_tx.send(buf[..n].to_vec()).await.is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });

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
        self.data_receiver = None;
        Ok(())
    }

    async fn send(&self, data: &[u8]) -> Result<(), AppError> {
        if let Some(ref wh) = self.write_half {
            let mut w = wh.lock().await;
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
}
