use crate::error::AppError;
use crate::ssh::client::Connection;
use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use tokio::sync::Mutex;

/// One session's connection, individually lockable so per-session network I/O
/// doesn't serialize behind the shared session-map lock.
type Conn = Arc<Mutex<Box<dyn Connection>>>;

/// How long teardown waits for a graceful disconnect before giving up and
/// dropping its handle. A send() wedged on a dead peer (exhausted SSH remote
/// window, full telnet/serial buffer) can hold the per-session lock
/// indefinitely; without this cap, disconnect/reconnect on that session would
/// hang forever behind that lock.
const DISCONNECT_TIMEOUT: std::time::Duration = std::time::Duration::from_secs(5);

/// Manages active terminal sessions.
///
/// Each entry carries a generation token (monotonic, process-wide) so
/// background tasks (output forwarders / reconnect supervisors) can prove they
/// still own the registered connection before acting on it: a re-`connect` on
/// the same id stores a NEW generation, which naturally fences off the old
/// task's `contains_gen`/`remove_session_if` calls so it can't tear down a
/// replacement connection it doesn't own.
pub struct SessionManager {
    sessions: Arc<Mutex<HashMap<String, (u64, Conn)>>>,
    next_generation: AtomicU64,
}

impl SessionManager {
    pub fn new() -> Self {
        Self {
            sessions: Arc::new(Mutex::new(HashMap::new())),
            next_generation: AtomicU64::new(0),
        }
    }

    /// Disconnect with a hard timeout (see `DISCONNECT_TIMEOUT`). Every caller
    /// has already removed the entry from the map, so on timeout we just drop
    /// our handle — the wedged send keeps the connection alive until its write
    /// errors out, but the session id is already free for reuse.
    async fn disconnect_with_timeout(session_id: &str, conn: Conn) -> Result<(), AppError> {
        match tokio::time::timeout(DISCONNECT_TIMEOUT, async {
            conn.lock().await.disconnect().await
        })
        .await
        {
            Ok(result) => result,
            Err(_) => {
                eprintln!(
                    "[session] disconnect of '{}' timed out after {:?}; dropping handle (a wedged write is holding the connection lock)",
                    session_id, DISCONNECT_TIMEOUT
                );
                Ok(())
            }
        }
    }

    /// Register a connection, returning the generation token that identifies
    /// THIS registration. Background tasks spawned for the connection should
    /// hold the token and use `contains_gen` / `remove_session_if` for their
    /// ownership decisions, so they never act on a replacement registration.
    pub async fn add_session(
        &self,
        session_id: String,
        connection: Box<dyn Connection>,
    ) -> Result<u64, AppError> {
        let connection_id = connection.get_session_id();
        if session_id != connection_id {
            return Err(AppError::ConfigError(format!(
                "Session ID mismatch: expected {}, got {}",
                session_id, connection_id
            )));
        }
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        // Insert the new connection FIRST (map lock only — the id immediately
        // maps to the new connection even if the old one's teardown is slow).
        // If one already existed for this id (reconnect / replace), disconnect
        // the OLD one cleanly — Drop alone never sends an SSH application-level
        // disconnect, leaving the server session lingering.
        let old = {
            let mut sessions = self.sessions.lock().await;
            sessions.insert(
                connection_id,
                (generation, Arc::new(Mutex::new(connection))),
            )
        };
        if let Some((_, old)) = old {
            let _ = Self::disconnect_with_timeout(&session_id, old).await;
        }
        Ok(generation)
    }

    /// Atomically swap in `connection` for `session_id` ONLY if the current
    /// entry's generation still equals `expected_gen`. Returns the NEW
    /// generation on success, or `None` if ownership was lost (a user disconnect
    /// removed the entry, or a newer `connect` replaced it). The check and the
    /// swap happen under a single map-lock with no await between them, so a
    /// concurrent disconnect/connect can't slip in between — closing the TOCTOU
    /// window that `contains_gen` + `add_session` left open. On `None` the map is
    /// left untouched and the passed-in connection is disconnected here (Drop
    /// alone never sends an SSH application-level disconnect).
    pub async fn replace_if_gen(
        &self,
        session_id: &str,
        expected_gen: u64,
        connection: Box<dyn Connection>,
    ) -> Option<u64> {
        let generation = self.next_generation.fetch_add(1, Ordering::Relaxed) + 1;
        let old = {
            let mut sessions = self.sessions.lock().await;
            match sessions.get(session_id) {
                Some((gen, _)) if *gen == expected_gen => sessions.insert(
                    session_id.to_string(),
                    (generation, Arc::new(Mutex::new(connection))),
                ),
                _ => {
                    // Ownership lost: leave the map untouched and tear down the
                    // connection we were handed so we don't leak an SSH session.
                    drop(sessions);
                    let mut connection = connection;
                    let _ = connection.disconnect().await;
                    return None;
                }
            }
        };
        if let Some((_, old)) = old {
            let _ = Self::disconnect_with_timeout(session_id, old).await;
        }
        Some(generation)
    }

    /// Unconditionally remove a session (user-driven disconnect).
    pub async fn remove_session(&self, session_id: &str) -> Result<(), AppError> {
        // Remove under the map lock FIRST (the id becomes immediately
        // reusable), then disconnect holding only the per-session lock —
        // bounded by the timeout so a wedged write can never hang teardown.
        let conn = self
            .sessions
            .lock()
            .await
            .remove(session_id)
            .map(|(_, conn)| conn);
        if let Some(conn) = conn {
            Self::disconnect_with_timeout(session_id, conn).await?;
        }
        Ok(())
    }

    /// Remove + disconnect only if the stored generation matches — i.e. the
    /// caller still owns the registered connection. Returns whether the entry
    /// was removed: `false` means the session was already gone (user
    /// disconnect) or replaced by a newer `connect` (not ours to touch).
    pub async fn remove_session_if(&self, session_id: &str, generation: u64) -> bool {
        let conn = {
            let mut sessions = self.sessions.lock().await;
            match sessions.get(session_id) {
                Some((gen, _)) if *gen == generation => {
                    sessions.remove(session_id).map(|(_, conn)| conn)
                }
                _ => None,
            }
        };
        match conn {
            Some(conn) => {
                let _ = Self::disconnect_with_timeout(session_id, conn).await;
                true
            }
            None => false,
        }
    }

    pub async fn send_to_session(&self, session_id: &str, data: &[u8]) -> Result<(), AppError> {
        // Clone the per-session handle and DROP the map lock before the network
        // write, so a slow/half-dead peer can't block input to every other session.
        let conn = {
            let sessions = self.sessions.lock().await;
            sessions.get(session_id).map(|(_, conn)| conn.clone())
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
            sessions.get(session_id).map(|(_, conn)| conn.clone())
        }
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        let conn = conn.lock().await;
        if !conn.is_connected() {
            return Err(AppError::SessionNotFound(session_id.to_string()));
        }
        conn.resize(cols, rows).await
    }

    /// Send a line BREAK on the session (serial only; other transports report it
    /// unsupported via the Connection trait default).
    pub async fn send_break(&self, session_id: &str) -> Result<(), AppError> {
        let conn = {
            let sessions = self.sessions.lock().await;
            sessions.get(session_id).map(|(_, conn)| conn.clone())
        }
        .ok_or_else(|| AppError::SessionNotFound(session_id.to_string()))?;
        let conn = conn.lock().await;
        conn.send_break().await
    }

    /// Whether the session is still registered AND still the same registration
    /// the caller created (generation match). Used by the forwarder/reconnect
    /// supervisor — a user-initiated disconnect removes the session, and a new
    /// `connect` on the same id bumps the generation; either way the old
    /// background task should stand down.
    pub async fn contains_gen(&self, session_id: &str, generation: u64) -> bool {
        self.sessions
            .lock()
            .await
            .get(session_id)
            .is_some_and(|(gen, _)| *gen == generation)
    }

    /// Get the SSH handle for SFTP operations (returns None for non-SSH sessions).
    pub async fn get_ssh_handle(
        &self,
        session_id: &str,
    ) -> Option<Arc<Mutex<russh::client::Handle<crate::ssh::client::ClientHandler>>>> {
        let conn = {
            let sessions = self.sessions.lock().await;
            sessions.get(session_id).map(|(_, conn)| conn.clone())
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
