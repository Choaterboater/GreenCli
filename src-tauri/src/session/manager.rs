use crate::error::AppError;
use crate::ssh::client::Connection;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// Manages active terminal sessions
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, Box<dyn Connection>>>>,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
        }
    }

    pub async fn add_session(
        &self,
        session_id: String,
        connection: Box<dyn Connection>,
    ) -> Result<(), AppError> {
        let connection_id = connection.get_session_id();
        if session_id != connection_id {
            return Err(AppError::ConfigError(format!(
                "Session ID mismatch: expected {}, got {}",
                session_id, connection_id
            )));
        }
        let mut sessions = self.sessions.lock().await;
        sessions.insert(connection_id, connection);
        Ok(())
    }

    pub async fn remove_session(&self, session_id: &str) -> Result<(), AppError> {
        let mut sessions = self.sessions.lock().await;
        if let Some(mut connection) = sessions.remove(session_id) {
            connection.disconnect().await?;
        }
        Ok(())
    }

    pub async fn send_to_session(&self, session_id: &str, data: &[u8]) -> Result<(), AppError> {
        let sessions = self.sessions.lock().await;
        let connection = sessions
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        if !connection.is_connected() {
            return Err(AppError::SessionNotFound(session_id.to_string()));
        }
        connection.send(data).await
    }

    pub async fn resize_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), AppError> {
        let sessions = self.sessions.lock().await;
        let connection = sessions
            .get(session_id)
            .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        if !connection.is_connected() {
            return Err(AppError::SessionNotFound(session_id.to_string()));
        }
        connection.resize(cols, rows).await
    }

    /// Whether a session is currently registered (used by the reconnect
    /// supervisor — a user-initiated disconnect removes the session, which
    /// naturally signals the supervisor to stop retrying).
    pub async fn contains(&self, session_id: &str) -> bool {
        self.sessions.lock().await.contains_key(session_id)
    }

    /// Get the SSH handle for SFTP operations (returns None for non-SSH sessions).
    pub async fn get_ssh_handle(
        &self,
        session_id: &str,
    ) -> Option<Arc<Mutex<russh::client::Handle<crate::ssh::client::ClientHandler>>>> {
        let sessions = self.sessions.lock().await;
        sessions.get(session_id).and_then(|c| c.ssh_handle())
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}
