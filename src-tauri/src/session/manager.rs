use crate::error::AppError;
use crate::ssh::client::Connection;
use std::collections::HashMap;
use std::sync::Arc;
use tokio::sync::Mutex;

/// One session's connection, individually lockable so per-session network I/O
/// doesn't serialize behind the shared session-map lock.
type Conn = Arc<Mutex<Box<dyn Connection>>>;

/// Manages active terminal sessions
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, Conn>>>,
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
        // Insert the new connection. If one already existed for this id (reconnect
        // / replace), disconnect the OLD one cleanly — Drop alone never sends an
        // SSH application-level disconnect, leaving the server session lingering.
        let old = {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(connection_id, Arc::new(Mutex::new(connection)))
        };
        if let Some(old) = old {
            let _ = old.lock().await.disconnect().await;
        }
        Ok(())
    }

    pub async fn remove_session(&self, session_id: &str) -> Result<(), AppError> {
        // Remove under the map lock, then disconnect with only the per-session lock.
        let conn = self.sessions.lock().await.remove(session_id);
        if let Some(conn) = conn {
            conn.lock().await.disconnect().await?;
        }
        Ok(())
    }

    pub async fn send_to_session(&self, session_id: &str, data: &[u8]) -> Result<(), AppError> {
        // Clone the per-session handle and DROP the map lock before the network
        // write, so a slow/half-dead peer can't block input to every other session.
        let conn = {
            let sessions = self.sessions.lock().await;
            sessions.get(session_id).cloned()
        }
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        let conn = conn.lock().await;
        if !conn.is_connected() {
            return Err(AppError::SessionNotFound(session_id.to_string()));
        }
        conn.send(data).await
    }

    pub async fn resize_session(
        &self,
        session_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<(), AppError> {
        let conn = {
            let sessions = self.sessions.lock().await;
            sessions.get(session_id).cloned()
        }
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        let conn = conn.lock().await;
        if !conn.is_connected() {
            return Err(AppError::SessionNotFound(session_id.to_string()));
        }
        conn.resize(cols, rows).await
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
        let conn = {
            let sessions = self.sessions.lock().await;
            sessions.get(session_id).cloned()
        }?;
        let c = conn.lock().await;
        c.ssh_handle()
    }
}

impl Default for SessionManager {
    fn default() -> Self {
        Self::new()
    }
}
