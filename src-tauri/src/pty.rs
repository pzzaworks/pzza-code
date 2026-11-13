use std::collections::HashMap;
use std::io::{Read, Write};
#[cfg(not(unix))]
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Condvar, Mutex};
use std::time::{Duration, Instant};

use portable_pty::{native_pty_system, CommandBuilder, MasterPty, PtySize};
use tauri::ipc::{Channel, Response};

#[path = "pty_exit.rs"]
mod exit;

// Output is coalesced before it crosses the IPC bridge: a TUI redraw arrives as
// a burst of small pty reads, and every channel message costs a webview eval,
// so bursts are gathered for a few milliseconds (bounded in size) and sent as
// one raw-bytes message. Small enough to be invisible for interactive typing.
const COALESCE_WINDOW: Duration = Duration::from_millis(4);
const COALESCE_MAX_BYTES: usize = 64 * 1024;
const READ_CHUNK: usize = 8192;

// Bytes sent to the renderer but not yet acknowledged. The renderer returns
// credit cumulatively (see ptyBridge.ts), well below this window.
const OUTPUT_CREDIT: usize = 256 * 1024;
#[cfg(not(unix))]
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

    // `bytes` may cover any number of delivered batches: acknowledgements
    // are plain byte counts, so the renderer can return credit in bulk.
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
    flow: OutputFlow,
    exit: exit::ChildExit,
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
            handle.exit.stop();
        }
        let exits: Vec<_> = handles.iter().map(|handle| handle.exit.waiter()).collect();
        // Release our master/writer ownership before waiting for tty exit.
        // Other callers may still hold handles, so the output thread also
        // drains pending output after the renderer disconnects.
        drop(handles);
        for exit in exits {
            exit.wait();
        }
    }
}

impl Drop for PtyHandle {
    // Dropping the last handle stops a child that is still running.
    fn drop(&mut self) {
        self.exit.stop();
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

// Reads PTY output on the terminal's single output thread: a blocking read
// for the first bytes of a burst, then poll() bounded by the coalescing
// deadline for the rest, so no separate reader thread or queue is needed.
#[cfg(unix)]
struct OutputReader {
    file: std::fs::File,
    eof: bool,
}

#[cfg(unix)]
impl OutputReader {
    fn new(master: &dyn MasterPty) -> Result<Self, String> {
        use std::os::fd::{FromRawFd, OwnedFd};
        let fd = master.as_raw_fd().ok_or("PTY has no file descriptor")?;
        // Own a duplicate, so reading and polling never depend on how long the
        // master itself stays open.
        // SAFETY: duplicates a descriptor the master keeps open for this call.
        let dup = unsafe { libc::fcntl(fd, libc::F_DUPFD_CLOEXEC, 0) };
        if dup < 0 {
            return Err(std::io::Error::last_os_error().to_string());
        }
        // SAFETY: `dup` is a fresh descriptor owned by nobody else.
        Ok(Self::from_fd(unsafe { OwnedFd::from_raw_fd(dup) }))
    }

    fn from_fd(fd: std::os::fd::OwnedFd) -> Self {
        Self {
            file: std::fs::File::from(fd),
            eof: false,
        }
    }

    // Appends one read to `batch`; false (and EOF recorded) once output ends.
    fn read_into(&mut self, batch: &mut Vec<u8>) -> bool {
        let mut buf = [0u8; READ_CHUNK];
        loop {
            match self.file.read(&mut buf) {
                Ok(0) => break,
                Ok(n) => {
                    batch.extend_from_slice(&buf[..n]);
                    return true;
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => {}
                // EIO means the slave side closed, which is EOF on a PTY master.
                Err(_) => break,
            }
        }
        self.eof = true;
        false
    }

    // Some(true): readable, or hung up (the next read reports EOF);
    // Some(false): nothing arrived in time; None: interrupted, retry.
    fn readable_within(&self, timeout: Duration) -> Option<bool> {
        use std::os::fd::AsRawFd;
        let mut pollfd = libc::pollfd {
            fd: self.file.as_raw_fd(),
            events: libc::POLLIN,
            revents: 0,
        };
        // poll() takes whole milliseconds; round up so a sub-millisecond
        // remainder still waits instead of busy-looping.
        let millis = timeout.as_micros().div_ceil(1000).min(libc::c_int::MAX as u128) as libc::c_int;
        // SAFETY: one valid pollfd for the duration of the call.
        match unsafe { libc::poll(&mut pollfd, 1, millis) } {
            0 => Some(false),
            // POLLNVAL would make the next read block; end the batch instead.
            n if n > 0 => Some(pollfd.revents & libc::POLLNVAL == 0),
            _ if std::io::Error::last_os_error().kind() == std::io::ErrorKind::Interrupted => None,
            _ => Some(false),
        }
    }

    // Blocks for the next burst and gathers it for up to `window`. None at EOF.
    fn next_batch(&mut self, window: Duration) -> Option<Vec<u8>> {
        let mut batch = Vec::new();
        if self.eof || !self.read_into(&mut batch) {
            return None;
        }
        let deadline = Instant::now() + window;
        while batch.len() < COALESCE_MAX_BYTES {
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                break;
            };
            match self.readable_within(remaining) {
                Some(true) => {
                    if !self.read_into(&mut batch) {
                        break;
                    }
                }
                Some(false) => break,
                None => {}
            }
        }
        Some(batch)
    }

    // macOS can wait for buffered tty output before completing child exit,
    // so output is read to EOF even when no renderer wants the bytes.
    fn drain(mut self) {
        let mut sink = Vec::with_capacity(READ_CHUNK);
        while !self.eof && self.read_into(&mut sink) {
            sink.clear();
        }
    }
}

// Without poll() on the PTY handle, a helper thread reads into a bounded
// queue and the output thread coalesces from it.
#[cfg(not(unix))]
struct OutputReader {
    rx: mpsc::Receiver<Vec<u8>>,
}

#[cfg(not(unix))]
impl OutputReader {
    fn new(master: &dyn MasterPty) -> Result<Self, String> {
        let reader = master.try_clone_reader().map_err(|e| e.to_string())?;
        // A slow renderer fills this bounded queue, then naturally backpressures the PTY.
        let (tx, rx) = mpsc::sync_channel::<Vec<u8>>(READER_QUEUE_CHUNKS);
        std::thread::spawn(move || read_output(reader, tx));
        Ok(Self { rx })
    }

    fn next_batch(&mut self, window: Duration) -> Option<Vec<u8>> {
        let first = self.rx.recv().ok()?;
        Some(coalesce(first, &self.rx, window))
    }

    // Closing the queue makes the reader thread drain to EOF on its own.
    fn drain(self) {}
}

#[cfg(not(unix))]
fn coalesce(first: Vec<u8>, rx: &mpsc::Receiver<Vec<u8>>, window: Duration) -> Vec<u8> {
    let deadline = Instant::now() + window;
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

#[cfg(not(unix))]
fn read_output(mut reader: Box<dyn Read + Send>, tx: mpsc::SyncSender<Vec<u8>>) {
    let mut connected = true;
    let mut buf = [0u8; READ_CHUNK];
    loop {
        match reader.read(&mut buf) {
            Ok(0) | Err(_) => break,
            Ok(n) => {
                if connected && tx.send(buf[..n].to_vec()).is_err() {
                    // Drain even when no renderer wants the bytes.
                    connected = false;
                }
            }
        }
    }
}

fn size(cols: u16, rows: u16) -> PtySize {
    PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    }
}

// Every spawn except ssh attaches to the app's own local tmux server.
#[cfg(target_os = "macos")]
fn local_attach(cmd: &str) -> bool {
    cmd != "ssh"
}

// Spawn a PTY-backed command and stream its output over `on_data` as raw byte
// chunks (the frontend receives each as an ArrayBuffer). Returns an id used by
// the write/resize/kill commands.
#[tauri::command]
pub async fn pty_spawn(
    app: tauri::AppHandle,
    state: tauri::State<'_, PtyState>,
    cmd: String,
    args: Vec<String>,
    cwd: Option<String>,
    cols: u16,
    rows: u16,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) -> Result<u32, String> {
    // A local attach never starts a server itself (tmux -N), so a server that
    // failed to start or has ended is started again first, and whatever a
    // new server owes is restored before the attach can take a saved name
    // (session_refresh::prepare_local_attach). ensure_running backs off after
    // failures and does nothing while the app quits; both can take seconds,
    // so they run on a blocking thread, never the main thread.
    #[cfg(target_os = "macos")]
    if local_attach(&cmd) {
        tauri::async_runtime::spawn_blocking(move || crate::session_refresh::prepare_local_attach(&app))
            .await
            .map_err(|error| error.to_string())??;
    }
    #[cfg(not(target_os = "macos"))]
    let _ = app;
    spawn(&state, cmd, args, cwd, cols, rows, on_data, on_exit)
}

/// Spawns the PTY for `pty_spawn` once the server it needs is up.
pub fn spawn(
    state: &PtyState,
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
    #[cfg(target_os = "macos")]
    {
        if local_attach(&cmd) {
            builder.env("PZZA_TMUX_SOCKET", crate::local_tmux::socket_path());
        } else {
            builder.env_remove("PZZA_TMUX_SOCKET");
        }
        builder.env_remove("TMUX");
    }
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

    // Acquire fallible master handles and exit tracking before spawning so
    // failure cannot orphan a child.
    let output = OutputReader::new(&*pair.master)?;
    let writer = pair.master.take_writer().map_err(|e| e.to_string())?;
    let watcher = exit::Watcher::new().map_err(|e| e.to_string())?;
    let child = pair
        .slave
        .spawn_command(builder)
        .map_err(|e| e.to_string())?;
    drop(pair.slave);
    // Reaped independently of output: buffered output or inherited slave
    // descriptors must not leave an exited child waiting for the renderer.
    let exit = watcher.watch(child);
    let handle = Arc::new(PtyHandle {
        master: Mutex::new(pair.master),
        writer: Mutex::new(writer),
        flow: OutputFlow::default(),
        exit,
    });
    let id = {
        let mut inner = state.inner.lock().unwrap();
        let id = inner.next_id;
        inner.next_id += 1;
        inner.ptys.insert(id, handle.clone());
        id
    };

    let registry = state.inner.clone();
    let forwarding = handle.clone();
    let started = std::thread::Builder::new()
        .name(format!("pty-{id}"))
        .spawn(move || forward_output(id, registry, forwarding, output, on_data, on_exit));
    if let Err(error) = started {
        // Dropping the last handle stops the child.
        state.inner.lock().unwrap().ptys.remove(&id);
        handle.flow.cancel();
        return Err(error.to_string());
    }
    Ok(id)
}

// The terminal's only thread: reads and coalesces output, waits for renderer
// credit (a slow renderer stops the reads, which backpressures the PTY), and
// reports the exit code once all output has been consumed.
fn forward_output(
    id: u32,
    registry: Arc<Mutex<Inner>>,
    handle: Arc<PtyHandle>,
    mut output: OutputReader,
    on_data: Channel<Response>,
    on_exit: Channel<i32>,
) {
    while let Some(batch) = output.next_batch(COALESCE_WINDOW) {
        if !handle.flow.reserve(batch.len()) || on_data.send(Response::new(batch)).is_err() {
            handle.flow.cancel();
            handle.exit.stop();
            registry.lock().unwrap().ptys.remove(&id);
            // Release master/writer ownership while draining, as a separate
            // reader would: only the output descriptor stays open.
            drop(handle);
            output.drain();
            return;
        }
    }
    // Keep the registry available until all output credit has returned.
    if handle.flow.drain() {
        let _ = on_exit.send(handle.exit.wait());
    }
    registry.lock().unwrap().ptys.remove(&id);
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

// Shutdown requests are independent of blocked input and output locks.
#[tauri::command]
pub fn pty_kill(state: tauri::State<'_, PtyState>, id: u32) -> Result<(), String> {
    let handle = state.inner.lock().unwrap().ptys.remove(&id);
    if let Some(handle) = handle {
        handle.flow.cancel();
        handle.exit.stop();
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn only_local_spawns_use_the_local_terminal_server() {
        assert!(local_attach("sh"));
        assert!(local_attach("tmux"));
        assert!(!local_attach("ssh"));
    }

    #[cfg(unix)]
    fn pipe() -> (OutputReader, std::fs::File) {
        use std::os::fd::{FromRawFd, OwnedFd};
        let mut fds = [0; 2];
        assert_eq!(unsafe { libc::pipe(fds.as_mut_ptr()) }, 0);
        let (read, write) = unsafe { (OwnedFd::from_raw_fd(fds[0]), OwnedFd::from_raw_fd(fds[1])) };
        (OutputReader::from_fd(read), std::fs::File::from(write))
    }

    #[cfg(unix)]
    #[test]
    fn output_is_drained_to_eof_after_the_renderer_disconnects() {
        let (reader, mut writer) = pipe();
        let output_size = 3 * READ_CHUNK + 17;
        let writing = std::thread::spawn(move || writer.write_all(&vec![b'x'; output_size]).unwrap());
        // Draining consumes everything, so the writer completes, then sees EOF.
        reader.drain();
        writing.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_burst_is_coalesced_into_one_batch() {
        let (mut reader, mut writer) = pipe();
        let writing = std::thread::spawn(move || {
            writer.write_all(b"first").unwrap();
            std::thread::sleep(Duration::from_millis(1));
            writer.write_all(b"-second").unwrap();
            writer
        });
        let batch = reader.next_batch(Duration::from_millis(200)).unwrap();
        assert_eq!(batch, b"first-second");
        drop(writing.join().unwrap());
        assert_eq!(reader.next_batch(COALESCE_WINDOW), None);
    }

    #[cfg(unix)]
    #[test]
    fn a_quiet_terminal_is_not_held_for_the_coalescing_window() {
        let (mut reader, mut writer) = pipe();
        writer.write_all(b"prompt$ ").unwrap();
        let start = Instant::now();
        let batch = reader.next_batch(Duration::from_millis(50)).unwrap();
        let elapsed = start.elapsed();
        assert_eq!(batch, b"prompt$ ");
        // Waits out the window for more, but never longer.
        assert!(elapsed >= Duration::from_millis(45), "{elapsed:?}");
        assert!(elapsed < Duration::from_millis(500), "{elapsed:?}");
    }

    #[cfg(unix)]
    #[test]
    fn coalescing_has_a_deadline_even_with_continuous_output() {
        let (mut reader, mut writer) = pipe();
        let writing = std::thread::spawn(move || {
            while writer.write_all(&[1]).is_ok() {
                std::thread::sleep(Duration::from_millis(1));
            }
        });
        let start = Instant::now();
        let batch = reader.next_batch(COALESCE_WINDOW).unwrap();
        assert!(start.elapsed() < Duration::from_secs(1));
        assert!(batch.len() < COALESCE_MAX_BYTES);
        drop(reader);
        writing.join().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn a_batch_is_bounded_in_size() {
        let (mut reader, mut writer) = pipe();
        let writing = std::thread::spawn(move || {
            while writer.write_all(&[b'y'; READ_CHUNK]).is_ok() {}
        });
        let batch = reader.next_batch(Duration::from_secs(5)).unwrap();
        assert!(batch.len() >= COALESCE_MAX_BYTES);
        assert!(batch.len() < COALESCE_MAX_BYTES + READ_CHUNK);
        drop(reader);
        writing.join().unwrap();
    }

    // poll() must report readiness on a real PTY master, or bursts would
    // never be coalesced.
    #[cfg(unix)]
    #[test]
    fn pty_output_is_coalesced() {
        let pair = native_pty_system().openpty(size(80, 24)).unwrap();
        let mut reader = OutputReader::new(&*pair.master).unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "printf one; sleep 0.01; printf two; sleep 0.01; printf three"]);
        let mut child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let batch = reader.next_batch(Duration::from_secs(2)).unwrap();
        assert_eq!(batch, b"onetwothree");
        assert_eq!(reader.next_batch(COALESCE_WINDOW), None);
        assert_eq!(child.wait().unwrap().exit_code(), 0);
    }

    #[test]
    fn output_credit_blocks_until_consumed_and_cancel_unblocks() {
        let flow = Arc::new(OutputFlow::default());
        assert!(flow.reserve(OUTPUT_CREDIT));
        let worker_flow = flow.clone();
        let (tx, rx) = std::sync::mpsc::channel();
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
    fn credit_for_many_batches_is_returned_in_one_acknowledgement() {
        let flow = OutputFlow::default();
        for _ in 0..4 {
            assert!(flow.reserve(1000));
        }
        flow.acknowledge(4000).unwrap();
        assert!(flow.drain());
    }

    #[test]
    fn final_output_is_drained_before_exit() {
        let flow = Arc::new(OutputFlow::default());
        assert!(flow.reserve(12));
        let worker_flow = flow.clone();
        let (tx, rx) = std::sync::mpsc::channel();
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
        // Drain concurrently, as the app does: macOS can wait for pending
        // terminal output to be consumed before completing child exit.
        let output = std::thread::spawn(move || {
            let mut output = Vec::new();
            // Unix PTYs may report EIO rather than EOF after the slave closes.
            let _ = reader.read_to_end(&mut output);
            output
        });
        let status = child.wait().unwrap();
        assert_eq!(status.exit_code(), 7);
        assert!(String::from_utf8_lossy(&output.join().unwrap()).contains("trailing-output"));
        assert_eq!(child.try_wait().unwrap().unwrap().exit_code(), 7);
    }

    // Spawns `script` through the real spawn path. Every delivered batch is
    // recorded and, when `ack` is set, its credit returned right away.
    #[cfg(unix)]
    fn spawn_script(
        state: &Arc<PtyState>,
        script: &str,
        ack: bool,
    ) -> (u32, Arc<Mutex<Vec<u8>>>, std::sync::mpsc::Receiver<i32>) {
        let received = Arc::new(Mutex::new(Vec::new()));
        let recorded = received.clone();
        let acking = Arc::downgrade(state);
        let on_data = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Raw(bytes) = body else {
                panic!("PTY output must be raw bytes");
            };
            recorded.lock().unwrap().extend_from_slice(&bytes);
            if let Some(state) = acking.upgrade().filter(|_| ack) {
                let handle = state.inner.lock().unwrap().ptys.values().next().cloned();
                if let Some(handle) = handle {
                    handle.flow.acknowledge(bytes.len()).unwrap();
                }
            }
            Ok(())
        });
        let (exit_tx, exit_rx) = std::sync::mpsc::channel();
        let on_exit = Channel::new(move |body| {
            let tauri::ipc::InvokeResponseBody::Json(json) = body else {
                panic!("exit code must be JSON");
            };
            exit_tx.send(json.parse().unwrap()).unwrap();
            Ok(())
        });
        let id = spawn(state, "/bin/sh".into(), vec!["-c".into(), script.into()], None, 80, 24, on_data, on_exit).unwrap();
        (id, received, exit_rx)
    }

    #[cfg(unix)]
    #[test]
    fn output_and_exit_code_reach_the_renderer() {
        let state = Arc::new(PtyState::default());
        let (_, received, exit_rx) = spawn_script(&state, "printf hello; exit 5", true);
        assert_eq!(exit_rx.recv_timeout(Duration::from_secs(5)).unwrap(), 5);
        assert!(String::from_utf8_lossy(&received.lock().unwrap()).contains("hello"));
        let deadline = Instant::now() + Duration::from_secs(2);
        while !state.inner.lock().unwrap().ptys.is_empty() {
            assert!(Instant::now() < deadline, "finished terminal stayed registered");
            std::thread::sleep(Duration::from_millis(5));
        }
    }

    #[cfg(unix)]
    #[test]
    fn exit_waits_for_unacknowledged_output() {
        let state = Arc::new(PtyState::default());
        let (id, received, exit_rx) = spawn_script(&state, "printf pending; exit 0", false);
        assert!(exit_rx.recv_timeout(Duration::from_millis(300)).is_err());
        let delivered = received.lock().unwrap().len();
        assert!(delivered > 0);
        state.handle(id).unwrap().flow.acknowledge(delivered).unwrap();
        assert_eq!(exit_rx.recv_timeout(Duration::from_secs(5)).unwrap(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn kill_does_not_wait_for_a_blocked_writer() {
        let state = Arc::new(PtyState::default());
        // Raw mode without echo: a canonical tty discards input it cannot
        // queue (so the write would finish), and echo would be consumed by
        // the output thread. Raw input that is never read fills the queue
        // and blocks the writer for real.
        let (id, received, _) = spawn_script(&state, "stty raw -echo; printf ready; exec sleep 30", true);
        let deadline = Instant::now() + Duration::from_secs(2);
        while !received.lock().unwrap().ends_with(b"ready") {
            assert!(Instant::now() < deadline, "terminal never became ready");
            std::thread::sleep(Duration::from_millis(5));
        }
        let handle = state.handle(id).unwrap();
        let writing_handle = handle.clone();
        drop(handle);
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            let mut writer = writing_handle.writer.lock().unwrap();
            started_tx.send(()).unwrap();
            let _ = writer.write_all(&vec![b'x'; MAX_INPUT_BYTES]);
            drop(writer);
            drop(writing_handle);
            let _ = done_tx.send(());
        });
        started_rx.recv_timeout(Duration::from_secs(1)).unwrap();
        let was_blocked = done_rx.recv_timeout(Duration::from_millis(20)).is_err();
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

    #[cfg(unix)]
    #[test]
    fn shutdown_drains_buffered_output_after_the_renderer_disconnects() {
        let state = Arc::new(PtyState::default());
        // Output is never acknowledged, so credit runs out and the output
        // thread blocks while `yes` fills the tty.
        let (id, received, _) = spawn_script(&state, "exec /usr/bin/yes", false);
        let deadline = Instant::now() + Duration::from_secs(2);
        while received.lock().unwrap().len() < OUTPUT_CREDIT - COALESCE_MAX_BYTES - READ_CHUNK {
            assert!(Instant::now() < deadline, "credit never ran out");
            std::thread::sleep(Duration::from_millis(5));
        }
        // Retaining another caller's handle must not prevent child exit.
        let retained = state.handle(id).unwrap();
        let shutdown_state = state.clone();
        let (finished_tx, finished_rx) = std::sync::mpsc::channel();
        let shutting_down = std::thread::spawn(move || {
            shutdown_state.shutdown();
            finished_tx.send(()).unwrap();
        });
        let finished = finished_rx.recv_timeout(Duration::from_secs(2)).is_ok();
        assert!(finished, "Shutdown stopped draining buffered tty output");
        shutting_down.join().unwrap();
        assert!(state.inner.lock().unwrap().ptys.is_empty());
        drop(retained);
    }
}
