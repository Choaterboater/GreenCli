// Stop for the AI panel: the flags Stop trips, keyed by stream or run id, and
// the Stops that arrive before their run is registered. No Tauri here, so it
// moves to Tauri 2 unchanged; main.rs keeps one CancelBook in AppState.

use std::collections::HashMap;
use std::future::Future;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Arc;
use std::time::{Duration, Instant};

/// How long a Stop for a not-yet-registered id is remembered.
pub const EARLY_STOP_TTL: Duration = Duration::from_secs(30);
/// How often a wait looks at the Stop flag.
pub const POLL: Duration = Duration::from_millis(250);

/// The cancel flags of the AI runs in flight.
#[derive(Default)]
pub struct CancelBook {
    flags: HashMap<String, Arc<AtomicBool>>,
    /// Stop pressed for an id the backend hasn't registered yet (the request
    /// is still on its way from the UI).
    early: HashMap<String, Instant>,
}

impl CancelBook {
    /// A flag for run `id`. An id Stop already asked for gets a flag that is
    /// already tripped, so the run starts stopped. A reused id must not
    /// silently replace a live run's flag (that run would go on, uncancellable,
    /// and be billed), so the old flag is tripped; the bool says it happened.
    pub fn register(&mut self, id: &str) -> (Arc<AtomicBool>, bool) {
        let flag = Arc::new(AtomicBool::new(false));
        if self.early.remove(id).is_some() {
            flag.store(true, Ordering::Relaxed);
        }
        let displaced = self.flags.insert(id.to_string(), flag.clone());
        if let Some(old) = &displaced {
            old.store(true, Ordering::Relaxed);
        }
        (flag, displaced.is_some())
    }

    /// Stop: trip the run's flag, or remember the id for a run that isn't
    /// registered yet. Old early Stops are dropped here.
    pub fn cancel(&mut self, id: &str, now: Instant) {
        if let Some(flag) = self.flags.get(id) {
            flag.store(true, Ordering::Relaxed);
            return;
        }
        self.early
            .retain(|_, at| now.saturating_duration_since(*at) < EARLY_STOP_TTL);
        self.early.insert(id.to_string(), now);
    }

    /// The run ended: forget its flag, but not a newer run's under the same id.
    pub fn finish(&mut self, id: &str, flag: &Arc<AtomicBool>) {
        if self.flags.get(id).is_some_and(|f| Arc::ptr_eq(f, flag)) {
            self.flags.remove(id);
        }
    }
}

/// Wait for `fut` unless Stop trips `cancel` first (looked at every 250 ms).
/// None when stopped; `fut` is dropped then, which ends a request in flight.
pub async fn until_cancelled<F: Future>(fut: F, cancel: &AtomicBool) -> Option<F::Output> {
    let mut fut = std::pin::pin!(fut);
    loop {
        if cancel.load(Ordering::Relaxed) {
            return None;
        }
        if let Ok(out) = tokio::time::timeout(POLL, fut.as_mut()).await {
            return Some(out);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tripped(flag: &AtomicBool) -> bool {
        flag.load(Ordering::Relaxed)
    }

    #[test]
    fn stop_before_register_starts_stopped() {
        let mut book = CancelBook::default();
        book.cancel("a", Instant::now());
        let (flag, displaced) = book.register("a");
        assert!(tripped(&flag));
        assert!(!displaced);
        // Used up: the next run with that id starts normally.
        book.finish("a", &flag);
        let (again, _) = book.register("a");
        assert!(!tripped(&again));
    }

    #[test]
    fn stop_after_register_trips_the_flag() {
        let mut book = CancelBook::default();
        let (flag, _) = book.register("a");
        assert!(!tripped(&flag));
        book.cancel("a", Instant::now());
        assert!(tripped(&flag));
        assert!(book.early.is_empty());
    }

    #[test]
    fn early_stops_expire() {
        let mut book = CancelBook::default();
        let start = Instant::now();
        book.cancel("old", start);
        book.cancel("new", start + EARLY_STOP_TTL + Duration::from_secs(1));
        assert!(!book.early.contains_key("old"));
        let (flag, _) = book.register("new");
        assert!(tripped(&flag));
    }

    #[test]
    fn reused_id_trips_the_old_run() {
        let mut book = CancelBook::default();
        let (first, _) = book.register("a");
        let (second, displaced) = book.register("a");
        assert!(displaced);
        assert!(tripped(&first));
        assert!(!tripped(&second));
        // The first run ending must not drop the second run's flag.
        book.finish("a", &first);
        book.cancel("a", Instant::now());
        assert!(tripped(&second));
        book.finish("a", &second);
        assert!(book.flags.is_empty());
    }

    #[tokio::test]
    async fn until_cancelled_returns_the_output() {
        let cancel = AtomicBool::new(false);
        assert_eq!(until_cancelled(async { 7 }, &cancel).await, Some(7));
    }

    #[tokio::test]
    async fn until_cancelled_never_starts_when_stopped() {
        let cancel = AtomicBool::new(true);
        let started = AtomicBool::new(false);
        let out = until_cancelled(
            async {
                started.store(true, Ordering::Relaxed);
                1
            },
            &cancel,
        )
        .await;
        assert_eq!(out, None);
        assert!(!tripped(&started));
    }

    #[tokio::test]
    async fn until_cancelled_sees_a_stop_while_waiting() {
        let cancel = Arc::new(AtomicBool::new(false));
        let stopper = cancel.clone();
        tokio::spawn(async move {
            tokio::time::sleep(Duration::from_millis(50)).await;
            stopper.store(true, Ordering::Relaxed);
        });
        let begun = Instant::now();
        let out = until_cancelled(std::future::pending::<()>(), &cancel).await;
        assert_eq!(out, None);
        assert!(begun.elapsed() < Duration::from_secs(5));
    }
}
