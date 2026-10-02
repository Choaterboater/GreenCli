// Stop for MCP tool calls. The AI panel gives each call an id; Stop sends
// `mcp_cancel_call` with that id. Pure: no Tauri, no I/O.
//
// A Stop can arrive before the call registers (the two invokes race), so an
// unknown id is remembered for a while and a later register for it fails,
// which means the call is never sent.

use std::collections::{HashMap, VecDeque};
use tokio::sync::oneshot;

/// Stop already came for this call.
#[derive(Debug, PartialEq, Eq)]
pub struct Cancelled;

/// Ids longer than this are ignored (the call runs, but can't be stopped).
const MAX_ID_CHARS: usize = 64;
/// How many early Stops are remembered. The oldest is dropped first.
const MAX_EARLY: usize = 64;

struct Inner {
    live: HashMap<String, oneshot::Sender<()>>,
    early: VecDeque<String>,
}

pub struct CallRegistry {
    inner: std::sync::Mutex<Inner>,
}

impl Default for CallRegistry {
    fn default() -> Self {
        Self::new()
    }
}

fn usable(call_id: &str) -> bool {
    !call_id.is_empty() && call_id.chars().count() <= MAX_ID_CHARS
}

impl CallRegistry {
    pub fn new() -> Self {
        Self {
            inner: std::sync::Mutex::new(Inner {
                live: HashMap::new(),
                early: VecDeque::new(),
            }),
        }
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Inner> {
        // A panic while holding this lock can't leave the maps half-changed in
        // a way that matters, so a poisoned lock is still used.
        self.inner.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Ok(Some(rx)): cancellable. Ok(None): id ignored (empty, over 64 chars, or
    /// already live), so the call runs uncancellable. Err(Cancelled): Stop
    /// already came for this id.
    pub fn register(&self, call_id: &str) -> Result<Option<oneshot::Receiver<()>>, Cancelled> {
        if !usable(call_id) {
            return Ok(None);
        }
        let mut inner = self.lock();
        if let Some(at) = inner.early.iter().position(|id| id == call_id) {
            inner.early.remove(at);
            return Err(Cancelled);
        }
        if inner.live.contains_key(call_id) {
            return Ok(None);
        }
        let (tx, rx) = oneshot::channel();
        inner.live.insert(call_id.to_string(), tx);
        Ok(Some(rx))
    }

    /// Sends on a live call's sender (returns true), or remembers the id so a
    /// later register fails (max 64 remembered, oldest dropped). Ignored ids
    /// return false.
    pub fn cancel(&self, call_id: &str) -> bool {
        if !usable(call_id) {
            return false;
        }
        let mut inner = self.lock();
        if let Some(tx) = inner.live.remove(call_id) {
            // The receiver may be gone already (the call just finished).
            let _ = tx.send(());
            return true;
        }
        if !inner.early.iter().any(|id| id == call_id) {
            if inner.early.len() >= MAX_EARLY {
                inner.early.pop_front();
            }
            inner.early.push_back(call_id.to_string());
        }
        false
    }

    /// The call is over: forget it.
    pub fn finish(&self, call_id: &str) {
        self.lock().live.remove(call_id);
    }
}

/// The future request_cancellable selects on. Resolves only when the sender
/// actually sent (); a dropped sender (RecvError) parks forever, so it never
/// counts as a Stop.
pub async fn stop_signal(rx: Option<oneshot::Receiver<()>>) {
    if let Some(rx) = rx {
        if rx.await.is_ok() {
            return;
        }
    }
    std::future::pending::<()>().await
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;

    #[tokio::test]
    async fn register_then_cancel_fires_the_stop_signal() {
        let reg = CallRegistry::new();
        let rx = reg.register("mcp-1").unwrap();
        assert!(rx.is_some());
        assert!(reg.cancel("mcp-1"));
        tokio::time::timeout(Duration::from_secs(1), stop_signal(rx))
            .await
            .expect("stop_signal should complete");
    }

    #[test]
    fn cancel_before_register_refuses_the_call() {
        let reg = CallRegistry::new();
        assert!(!reg.cancel("mcp-2"));
        assert_eq!(reg.register("mcp-2").unwrap_err(), Cancelled);
        // Remembered once only.
        assert!(reg.register("mcp-2").unwrap().is_some());
    }

    #[test]
    fn finish_removes_the_entry() {
        let reg = CallRegistry::new();
        let _rx = reg.register("mcp-3").unwrap();
        reg.finish("mcp-3");
        assert!(!reg.cancel("mcp-3"));
    }

    #[test]
    fn keeps_the_newest_64_early_cancels() {
        let reg = CallRegistry::new();
        for i in 0..70 {
            reg.cancel(&format!("id-{i}"));
        }
        // The six oldest were dropped, so they register normally.
        for i in 0..6 {
            assert!(reg.register(&format!("id-{i}")).unwrap().is_some());
        }
        for i in 6..70 {
            assert_eq!(reg.register(&format!("id-{i}")).unwrap_err(), Cancelled);
        }
    }

    #[test]
    fn empty_and_overlong_ids_are_ignored() {
        let reg = CallRegistry::new();
        let long = "x".repeat(65);
        assert!(reg.register("").unwrap().is_none());
        assert!(reg.register(&long).unwrap().is_none());
        assert!(!reg.cancel(""));
        assert!(!reg.cancel(&long));
        // Not remembered either.
        assert!(reg.register(&long).unwrap().is_none());
        assert!(reg.register(&"y".repeat(64)).unwrap().is_some());
    }

    #[tokio::test]
    async fn duplicate_register_keeps_the_first_entry() {
        let reg = CallRegistry::new();
        let first = reg.register("dup").unwrap();
        assert!(first.is_some());
        assert!(reg.register("dup").unwrap().is_none());
        assert!(reg.cancel("dup"));
        tokio::time::timeout(Duration::from_secs(1), stop_signal(first))
            .await
            .expect("the first receiver still fires");
    }

    #[tokio::test]
    async fn a_dropped_sender_is_not_a_stop() {
        let reg = CallRegistry::new();
        let rx = reg.register("drop").unwrap();
        reg.finish("drop"); // drops the sender without sending
        let waited = tokio::time::timeout(Duration::from_millis(50), stop_signal(rx)).await;
        assert!(waited.is_err(), "stop_signal must park, not complete");
        // No receiver at all parks too.
        let none = tokio::time::timeout(Duration::from_millis(50), stop_signal(None)).await;
        assert!(none.is_err());
    }
}
