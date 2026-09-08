use std::collections::HashMap;
use std::io::{Read, Write};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, Response};

// Output is coalesced before it crosses the IPC bridge: a TUI redraw arrives as
// a burst of small pty reads, and every channel message costs a webview eval,
// so bursts are gathered for a few milliseconds (bounded in size) and sent as
// one raw-bytes message. Small enough to be invisible for interactive typing.
const COALESCE_WINDOW: Duration = Duration::from_millis(4);
const COALESCE_MAX_BYTES: usize = 64 * 1024;

const OUTPUT_CREDIT: usize = 256 * 1024;
const READER_QUEUE_CHUNKS: usize = 8;
const MAX_INPUT_BYTES: usize = 1024 * 1024;

#[derive(Default)]
struct OutputState {
    outstanding: usize,
    cancelled: bool,
}

#[derive(Default)]
struct OutputFlow {
    state: Mutex<OutputState>,
    changed: Condvar,
}

impl OutputFlow {
    fn reserve(&self, bytes: usize) -> bool {
        let mut state = self.state.lock().unwrap();
        while !state.cancelled && state.outstanding + bytes > OUTPUT_CREDIT {
            state = self.changed.wait(state).unwrap();
        }
        if state.cancelled {
            return false;
        }
        state.outstanding += bytes;
        true
    }

    fn acknowledge(&self, bytes: usize) -> Result<(), String> {
        let mut state = self.state.lock().unwrap();
        if bytes > state.outstanding {
            return Err("invalid PTY acknowledgement".into());
        }
        state.outstanding -= bytes;
        self.changed.notify_all();
        Ok(())
    }

    fn drain(&self) -> bool {
        let mut state = self.state.lock().unwrap();
        while !state.cancelled && state.outstanding > 0 {
            state = self.changed.wait(state).unwrap();
        }
        !state.cancelled
    }

    fn cancel(&self) {
        self.state.lock().unwrap().cancelled = true;
        self.changed.notify_all();
    }
}

struct PtyHandle {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    flow: OutputFlow,
    reaper: Mutex<Option<std::thread::JoinHandle<()>>>,
}

struct Inner {
    next_id: u32,
    ptys: HashMap<u32, Arc<PtyHandle>>,
}

impl Default for Inner {
    fn default() -> Self {
        Self {
            next_id: 1,
            ptys: HashMap::new(),
        }
    }
}

#[derive(Default)]
pub struct PtyState {
    inner: Arc<Mutex<Inner>>,
}

impl Drop for PtyState {
    fn drop(&mut self) {
        self.shutdown();
    }
}

impl PtyState {
    pub fn shutdown(&self) {
        let handles: Vec<_> = self
            .inner
            .lock()
            .unwrap()
            .ptys
            .drain()
            .map(|(_, handle)| handle)
            .collect();
        for handle in &handles {
            handle.flow.cancel();
            let _ = handle.killer.lock().unwrap().kill();
        }
        for handle in handles {
            if let Some(reaper) = handle.reaper.lock().unwrap().take() {
                let _ = reaper.join();
            }
        }
    }
}

impl PtyState {
    fn handle(&self, id: u32) -> Result<Arc<PtyHandle>, String> {
        self.inner
            .lock()
            .unwrap()
            .ptys
            .get(&id)
            .cloned()
            .ok_or_else(|| format!("no pty {id}"))
    }
}

fn coalesce(first: Vec<u8>, rx: &mpsc::Receiver<Vec<u8>>) -> Vec<u8> {
    let deadline = Instant::now() + COALESCE_WINDOW;
    let mut batch = first;
    while batch.len() < COALESCE_MAX_BYTES {
        let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
            break;
        };
        match rx.recv_timeout(remaining) {
            Ok(more) => batch.extend_from_slice(&more),
            Err(RecvTimeoutError::Timeout | RecvTimeoutError::Disconnected) => break,
        }
    }
    batch
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

// Spawn a PTY-backed command and stream its output over `on_data` as raw byte
// chunks (the frontend receives each as an ArrayBuffer). Returns an id used by
// the write/resize/kill commands.
#[tauri::command]
pub fn pty_spawn(
    state: tauri::State<'_, PtyState>,
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    let pty_system = native_pty_system();
    let pair = pty_system
        .openpty(size(cols, rows))
        .map_err(|e| e.to_string())?;

    let mut builder = CommandBuilder::new(&cmd);
    builder.args(&args);
    if let Some(dir) = &cwd {
        builder.cwd(dir);
    }
    // Give programs a sensible terminal identity.
    builder.env("TERM", "xterm-256color");
    // Launched from Finder/Dock, the app only has launchd's bare PATH, so a
    // local `sh -lc exec tmux` (and tmux's own child processes) would not find
    // Homebrew tools. Hand the PTY the same login-shell PATH the agent uses.
    // Harmless for ssh spawns (ssh lives in /usr/bin either way).
    builder.env("PATH", crate::agent::login_path());
    // Without a UTF-8 locale tmux treats this client as ASCII-only and draws
    // `_` in place of every non-ASCII character.
    if let Some((k, v)) = crate::agent::utf8_locale_env() {
        builder.env(k, v);
    }

    // Acquire fallible master handles before spawning so failure cannot orphan a child.
    let mut reader = pair.master.try_clone_reader().map_err(|e| e.to_string())?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let mut child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    let handle = Arc::new(PtyHandle {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        killer: Mutex::new(child.clone_killer()),
        flow: OutputFlow::default(),
        reaper: Mutex::new(None),
    });
    let id = {
        let mut inner = state.inner.lock().unwrap();
        let id = inner.next_id;
        inner.next_id += 1;
        inner.ptys.insert(id, handle.clone());
        id
    };

    // A slow renderer fills this bounded queue, then naturally backpressures the PTY.
    let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(READER_QUEUE_CHUNKS);
    let (exit_tx, exit_rx) = mpsc::sync_channel(1);
    std::thread::spawn(move || {
        let mut buf = [0u8; 8192];
        loop {
            match reader.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    if tx.send(buf[..n].to_vec()).is_err() {
                        break;
                    }
                }
                Err(_) => break,
            }
        }
    });
    // Reap independently: buffered output or inherited slave descriptors must
    // not leave an exited child waiting for the renderer to consume its output.
    let reaper = std::thread::spawn(move || {
        let code = child
            .wait()
            .map(|status| status.exit_code() as i32)
            .unwrap_or(-1);
        let _ = exit_tx.send(code);
    });
    *handle.reaper.lock().unwrap() = Some(reaper);
    let registry = state.inner.clone();
    std::thread::spawn(move || {
        let mut connected = true;
        while let Ok(first) = rx.recv() {
            let batch = coalesce(first, &rx);
            if !handle.flow.reserve(batch.len()) || on_data.send(Response::new(batch)).is_err() {
                connected = false;
                handle.flow.cancel();
                let _ = handle.killer.lock().unwrap().kill();
                break;
            }
        }
        drop(rx);
        if connected && handle.flow.drain() {
            let code = exit_rx.recv().unwrap_or(-1);
            // Keep the registry available until all output credit has returned.
            let _ = on_exit.send(code);
        }
        registry.lock().unwrap().ptys.remove(&id);
    });
    Ok(id)
}

#[tauri::command]
pub fn pty_ack(state: tauri::State<'_, PtyState>, id: u32, bytes: usize) -> Result<(), String> {
    // A parser callback may arrive after its terminal has been closed.
    if let Ok(handle) = state.handle(id) {
        handle.flow.acknowledge(bytes)?;
    }
    Ok(())
}

#[tauri::command]
pub async fn pty_write(
    state: tauri::State<'_, PtyState>,
    id: u32,
    data: String,
) -> Result<(), String> {
    if data.len() > MAX_INPUT_BYTES {
        return Err("PTY input exceeds 1 MiB".into());
    }
    let handle = state.handle(id)?;
    tauri::async_runtime::spawn_blocking(move || {
        let mut writer = handle.writer.lock().unwrap();
        writer
            .write_all(data.as_bytes())
            .map_err(|e| e.to_string())?;
        writer.flush().map_err(|e| e.to_string())
    })
    .await
    .map_err(|e| e.to_string())?
}

#[tauri::command]
pub fn pty_resize(
    state: tauri::State<'_, PtyState>,
    id: u32,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let handle = state.handle(id)?;
    let result = handle
        .master
        .lock()
        .unwrap()
        .resize(size(cols, rows))
        .map_err(|e| e.to_string());
    result
}

// The kill handle is independent of blocked input and output locks.
#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    let handle = state.inner.lock().unwrap().ptys.remove(&id);
    if let Some(handle) = handle {
        handle.flow.cancel();
        let _ = handle.killer.lock().unwrap().kill();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn output_credit_blocks_until_consumed_and_cancel_unblocks() {
        let flow = Arc::new(OutputFlow::default());
        assert!(flow.reserve(OUTPUT_CREDIT));
        let worker_flow = flow.clone();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            tx.send(worker_flow.reserve(1)).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
        flow.acknowledge(1).unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
        assert!(flow.acknowledge(OUTPUT_CREDIT + 1).is_err());
        flow.cancel();
        assert!(!flow.reserve(1));
        assert!(!flow.drain());
    }

    #[test]
    fn coalescing_has_a_deadline_even_with_continuous_output() {
        let (tx, rx) = mpsc::sync_channel(READER_QUEUE_CHUNKS);
        let writer = std::thread::spawn(move || {
            while tx.send(vec![1]).is_ok() {
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let start = Instant::now();
        let batch = coalesce(vec![0], &rx);
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(batch.len() < COALESCE_MAX_BYTES);
        drop(rx);
        writer.join().unwrap();
    }

    #[test]
    fn final_output_is_drained_before_exit() {
        let flow = Arc::new(OutputFlow::default());
        assert!(flow.reserve(12));
        let worker_flow = flow.clone();
        let (tx, rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            tx.send(worker_flow.drain()).unwrap();
        });
        assert!(rx.recv_timeout(Duration::from_millis(20)).is_err());
        flow.acknowledge(12).unwrap();
        assert!(rx.recv_timeout(Duration::from_secs(1)).unwrap());
        worker.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn child_is_reaped_and_trailing_output_is_preserved() {
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "printf trailing-output; exit 7"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let status = child.wait().unwrap();
        assert_eq!(status.exit_code(), 7);
        let mut output = Vec::new();
        // Unix PTYs may report EIO rather than EOF after the slave closes.
        let _ = reader.read_to_end(&mut output);
        assert!(String::from_utf8_lossy(&output).contains("trailing-output"));
        assert_eq!(child.try_wait().unwrap().unwrap().exit_code(), 7);
    }

    #[cfg(unix)]
    #[test]
    fn kill_does_not_wait_for_a_blocked_writer() {
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let writer = pair.master.take_writer().unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "exec sleep 30"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let handle = Arc::new(PtyHandle {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(child.clone_killer()),
            flow: OutputFlow::default(),
            reaper: Mutex::new(None),
        });
        let writing_handle = handle.clone();
        let (started_tx, started_rx) = mpsc::channel();
        let (done_tx, done_rx) = mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut writer = writing_handle.writer.lock().unwrap();
            started_tx.send(()).unwrap();
            let _ = writer.write_all(&vec![b'x'; MAX_INPUT_BYTES]);
            let _ = done_tx.send(());
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let was_blocked = done_rx.recv_timeout(Duration::from_millis(20)).is_err();
        *handle.reaper.lock().unwrap() = Some(std::thread::spawn(move || {
            child.wait().unwrap();
        }));
        let state = PtyState::default();
        state.inner.lock().unwrap().ptys.insert(1, handle);
        let start = Instant::now();
        state.shutdown();
        let kill_elapsed = start.elapsed();
        assert!(state.inner.lock().unwrap().ptys.is_empty());
        let writer_finished = done_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        assert!(was_blocked);
        assert!(kill_elapsed < Duration::from_secs(1));
        assert!(writer_finished);
        worker.join().unwrap();
    }
}
