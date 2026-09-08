use std::sync::atomic::{AtomicU8, Ordering};
use std::sync::Arc;

#[derive(Default)]
pub struct ShutdownState {
    phase: Arc<AtomicU8>,
}

impl ShutdownState {
    pub fn complete(&self) -> bool {
        self.phase.load(Ordering::Acquire) == 2
    }

    // Exit requests must return to the native event loop immediately. Waiting
    // for child processes here would make macOS report an unresponsive app.
    pub fn start(&self, cleanup: impl FnOnce() + Send + 'static, finish: impl FnOnce() + Send + 'static) {
        if self.phase.compare_exchange(0, 1, Ordering::AcqRel, Ordering::Acquire).is_err() {
            return;
        }
        let phase = self.phase.clone();
        std::thread::spawn(move || {
            cleanup();
            phase.store(2, Ordering::Release);
            finish();
        });
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::mpsc;
    use std::time::{Duration, Instant};

    #[test]
    fn shutdown_does_not_block_the_requesting_thread_or_start_twice() {
        let state = ShutdownState::default();
        let (release, waiting) = mpsc::channel();
        let (completed, result) = mpsc::channel();
        let start = Instant::now();
        state.start(move || waiting.recv_timeout(Duration::from_secs(2)).unwrap(), move || completed.send(()).unwrap());
        assert!(start.elapsed() < Duration::from_millis(100));
        assert!(!state.complete());
        let (duplicate, duplicate_result) = mpsc::channel();
        state.start(move || duplicate.send(()).unwrap(), || {});
        assert!(duplicate_result.recv_timeout(Duration::from_millis(20)).is_err());
        release.send(()).unwrap();
        result.recv_timeout(Duration::from_secs(2)).unwrap();
        assert!(state.complete());
    }

    #[test]
    fn exit_is_allowed_only_after_cleanup_finishes() {
        let state = ShutdownState::default();
        let phase = state.phase.clone();
        let (completed, result) = mpsc::channel();
        state.start(|| {}, move || completed.send(phase.load(Ordering::Acquire)).unwrap());
        assert_eq!(result.recv_timeout(Duration::from_secs(2)).unwrap(), 2);
    }
}
