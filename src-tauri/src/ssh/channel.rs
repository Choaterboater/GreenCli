use russh::ChannelId;
use serde::Serialize;
use tokio::sync::mpsc::Sender;

#[derive(Clone, Debug)]
pub struct SshChannel {
    pub channel_id: ChannelId,
    pub sender: Sender<Vec<u8>>,
}

impl SshChannel {
    pub fn new(channel_id: ChannelId, sender: Sender<Vec<u8>>) -> Self {
        Self {
            channel_id,
            sender,
        }
    }

    pub async fn send_data(&self, data: Vec<u8>) -> Result<(), crate::error::AppError> {
        self.sender
            .send(data)
            .await
            .map_err(|e| crate::error::AppError::SshError(format!("Channel send: {}", e)))?;
        Ok(())
    }
}

#[derive(Clone, Debug, Serialize)]
pub struct AuthPromptEvent {
    pub session_id: String,
    pub prompt: String,
    pub echo: bool,
}
