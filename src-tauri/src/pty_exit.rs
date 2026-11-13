// Exit tracking for PTY children: reports each child's exit code once it has
// been reaped and turns a stop request into hangup, then a forced kill.
//
// On macOS one process-wide kqueue thread watches every child, so an open
// terminal costs no exit or reaper thread of its own. Other platforms keep a
// dedicated exit watcher and reaper thread per child.

use std::sync::{Arc, Condvar, Mutex};

use portable_pty::Child;

pub type BoxedChild = Box<dyn Child + Send + Sync>;

#[derive(Default)]
struct ExitSlot {
    code: Mutex<Option<i32>>,
    reaped: Condvar,
}

impl ExitSlot {
    fn publish(&self, code: i32) {
        *self.code.lock().unwrap() = Some(code);
        self.reaped.notify_all();
    }

    fn wait(&self) -> i32 {
        let mut code = self.code.lock().unwrap();
        loop {
            if let Some(code) = *code {
                return code;
            }
            code = self.reaped.wait(code).unwrap();
        }
    }
}

/// Waits for one child's exit code without keeping its stop handle alive.
pub struct ExitWaiter(Arc<ExitSlot>);

impl ExitWaiter {
    /// Blocks until the child has been reaped and returns its exit code.
    pub fn wait(&self) -> i32 {
        self.0.wait()
    }
}

/// A watched child: it is reaped as soon as it exits, independently of
/// whether anyone still reads its terminal output.
pub struct ChildExit {
    slot: Arc<ExitSlot>,
    stopper: imp::Stopper,
}

impl ChildExit {
    /// Asks the child to stop: hangup first, a forced kill if it survives the
    /// grace period. Does nothing once the child has been reaped.
    pub fn stop(&self) {
        self.stopper.stop();
    }

    /// Blocks until the child has been reaped and returns its exit code.
    pub fn wait(&self) -> i32 {
        self.slot.wait()
    }

    pub fn waiter(&self) -> ExitWaiter {
        ExitWaiter(self.slot.clone())
    }
}

/// Watches spawned children. Obtained before spawning, so a failure to set up
/// exit tracking can never leave an unwatched child behind.
pub struct Watcher(imp::Watcher);

impl Watcher {
    pub fn new() -> std::io::Result<Self> {
        imp::Watcher::new().map(Self)
    }

    pub fn watch(&self, child: BoxedChild) -> ChildExit {
        let slot = Arc::new(ExitSlot::default());
        let stopper = self.0.watch(child, slot.clone());
        ChildExit { slot, stopper }
    }
}

#[cfg(target_os = "macos")]
mod imp {
    use std::collections::HashMap;
    use std::io;
    use std::os::fd::{AsRawFd, FromRawFd, OwnedFd};
    use std::sync::atomic::{AtomicU64, Ordering};
    use std::sync::{Arc, Mutex, OnceLock};
    use std::time::{Duration, Instant};

    use super::{BoxedChild, ExitSlot};

    // Matches portable-pty's own Child::kill: SIGHUP, then SIGKILL after 200ms.
    const HANGUP_GRACE: Duration = Duration::from_millis(200);
    // Re-check interval for a child whose exit could not be watched by kqueue,
    // or which reported NOTE_EXIT before it became waitable.
    const POLL_INTERVAL: Duration = Duration::from_millis(20);
    const WAKE_IDENT: usize = 0;

    struct Watched {
        child: BoxedChild,
        slot: Arc<ExitSlot>,
        stopping: bool,
        kill_at: Option<Instant>,
        polled: bool,
    }

    struct Monitor {
        kq: OwnedFd,
        // Entries are keyed by a never-reused token, not the pid, so a late
        // event can never act on a different child that reused the pid.
        children: Mutex<HashMap<u64, Watched>>,
        next_token: AtomicU64,
    }

    fn kevent_change(ident: usize, filter: i16, flags: u16, fflags: u32, token: u64) -> libc::kevent {
        libc::kevent {
            ident,
            filter,
            flags,
            fflags,
            data: 0,
            udata: token as usize as *mut libc::c_void,
        }
    }

    impl Monitor {
        fn new() -> io::Result<Self> {
            // SAFETY: kqueue takes no arguments and returns a new descriptor or -1.
            let fd = unsafe { libc::kqueue() };
            if fd < 0 {
                return Err(io::Error::last_os_error());
            }
            // SAFETY: fd was just returned by kqueue and is owned by nobody else.
            let kq = unsafe { OwnedFd::from_raw_fd(fd) };
            // SAFETY: plain flag update on a descriptor this function owns.
            if unsafe { libc::fcntl(kq.as_raw_fd(), libc::F_SETFD, libc::FD_CLOEXEC) } < 0 {
                return Err(io::Error::last_os_error());
            }
            let monitor = Self {
                kq,
                children: Mutex::new(HashMap::new()),
                next_token: AtomicU64::new(1),
            };
            // A user event lets other threads wake the monitor after a stop
            // request so it can arm the forced-kill deadline.
            monitor.change(kevent_change(WAKE_IDENT, libc::EVFILT_USER, libc::EV_ADD | libc::EV_CLEAR, 0, 0))?;
            Ok(monitor)
        }

        // Applies one change; EV_RECEIPT reports its own result instead of
        // dequeuing pending events.
        fn change(&self, mut change: libc::kevent) -> io::Result<()> {
            change.flags |= libc::EV_RECEIPT;
            loop {
                // SAFETY: kevent is plain data and the kernel only writes into `receipt`.
                let mut receipt: libc::kevent = unsafe { std::mem::zeroed() };
                let count = unsafe { libc::kevent(self.kq.as_raw_fd(), &change, 1, &mut receipt, 1, std::ptr::null()) };
                if count < 0 {
                    let error = io::Error::last_os_error();
                    if error.kind() == io::ErrorKind::Interrupted {
                        continue;
                    }
                    return Err(error);
                }
                if count == 1 && receipt.flags & libc::EV_ERROR != 0 && receipt.data != 0 {
                    return Err(io::Error::from_raw_os_error(receipt.data as i32));
                }
                return Ok(());
            }
        }

        fn wake(&self) {
            // Cannot fail once registered; a lost wake would only delay the
            // forced kill until the next event.
            let _ = self.change(kevent_change(WAKE_IDENT, libc::EVFILT_USER, 0, libc::NOTE_TRIGGER, 0));
        }

        fn watch(&self, child: BoxedChild, slot: Arc<ExitSlot>) -> u64 {
            let token = self.next_token.fetch_add(1, Ordering::Relaxed);
            let pid = child.process_id();
            let mut children = self.children.lock().unwrap();
            // Registered under the lock, so the monitor finds the entry for
            // any event this registration produces.
            let watched = pid.is_some_and(|pid| {
                self.change(kevent_change(pid as usize, libc::EVFILT_PROC, libc::EV_ADD | libc::EV_ONESHOT, libc::NOTE_EXIT, token))
                    .is_ok()
            });
            children.insert(token, Watched { child, slot, stopping: false, kill_at: None, polled: !watched });
            // A child that exited before registration (ESRCH) is collected here.
            if !collect(&mut children, token) && !watched {
                drop(children);
                self.wake();
            }
            token
        }

        fn stop(&self, token: u64) {
            let mut children = self.children.lock().unwrap();
            if collect(&mut children, token) {
                return;
            }
            let Some(watched) = children.get_mut(&token) else {
                return;
            };
            if watched.stopping {
                return;
            }
            watched.stopping = true;
            // Only this module reaps the child, and only under this lock, so
            // the pid still belongs to it.
            if let Some(pid) = watched.child.process_id() {
                // SAFETY: sends a signal to a live, unreaped child.
                unsafe { libc::kill(pid as libc::pid_t, libc::SIGHUP) };
            }
            watched.kill_at = Some(Instant::now() + HANGUP_GRACE);
            drop(children);
            self.wake();
        }

        // Forces kills whose grace has expired and re-checks polled children.
        // Returns how long the monitor may sleep before it must look again.
        fn service(&self, children: &mut HashMap<u64, Watched>) -> Option<Duration> {
            let now = Instant::now();
            let due: Vec<u64> = children
                .iter()
                .filter(|(_, watched)| watched.polled || watched.kill_at.is_some_and(|at| at <= now))
                .map(|(token, _)| *token)
                .collect();
            for token in due {
                if collect(children, token) {
                    continue;
                }
                let watched = children.get_mut(&token).expect("uncollected child is still watched");
                if watched.kill_at.is_some_and(|at| at <= now) {
                    watched.kill_at = None;
                    if let Some(pid) = watched.child.process_id() {
                        // SAFETY: the child is unreaped, see `stop`.
                        unsafe { libc::kill(pid as libc::pid_t, libc::SIGKILL) };
                    }
                }
            }
            children
                .values()
                .flat_map(|watched| {
                    let poll = watched.polled.then_some(POLL_INTERVAL);
                    let kill = watched.kill_at.map(|at| at.saturating_duration_since(now));
                    poll.into_iter().chain(kill)
                })
                .min()
        }

        fn run(&self) {
            // SAFETY: kevent is plain data; zero is a valid empty event.
            let mut events: [libc::kevent; 32] = unsafe { std::mem::zeroed() };
            let mut timeout = None;
            loop {
                let timespec = timeout.map(|wait: Duration| libc::timespec {
                    tv_sec: wait.as_secs() as libc::time_t,
                    tv_nsec: wait.subsec_nanos() as libc::c_long,
                });
                let timespec_ptr = timespec.as_ref().map_or(std::ptr::null(), |spec| spec as *const libc::timespec);
                // SAFETY: `events` is a valid buffer of the length passed.
                let count = unsafe {
                    libc::kevent(self.kq.as_raw_fd(), std::ptr::null(), 0, events.as_mut_ptr(), events.len() as libc::c_int, timespec_ptr)
                };
                let failed = count < 0 && io::Error::last_os_error().kind() != io::ErrorKind::Interrupted;
                if failed {
                    // Never spin on a persistent kqueue error.
                    std::thread::sleep(POLL_INTERVAL);
                }
                let mut children = self.children.lock().unwrap();
                if failed {
                    // Events may have been lost: poll every child until reaped.
                    for watched in children.values_mut() {
                        watched.polled = true;
                    }
                }
                for event in &events[..count.max(0) as usize] {
                    if event.filter != libc::EVFILT_PROC {
                        continue;
                    }
                    let token = event.udata as usize as u64;
                    // NOTE_EXIT can precede the moment the child becomes
                    // waitable; keep checking it until it is reaped.
                    if !collect(&mut children, token) {
                        if let Some(watched) = children.get_mut(&token) {
                            watched.polled = true;
                        }
                    }
                }
                timeout = self.service(&mut children);
            }
        }
    }

    // Reaps the child if it has exited and publishes its code. Returns true
    // once the child is no longer watched.
    fn collect(children: &mut HashMap<u64, Watched>, token: u64) -> bool {
        let Some(watched) = children.get_mut(&token) else {
            return true;
        };
        let code = match watched.child.try_wait() {
            Ok(Some(status)) => status.exit_code() as i32,
            Ok(None) => return false,
            Err(_) => -1,
        };
        if let Some(watched) = children.remove(&token) {
            watched.slot.publish(code);
        }
        true
    }

    fn monitor() -> io::Result<Arc<Monitor>> {
        static MONITOR: OnceLock<Arc<Monitor>> = OnceLock::new();
        static INIT: Mutex<()> = Mutex::new(());
        if let Some(monitor) = MONITOR.get() {
            return Ok(monitor.clone());
        }
        let _init = INIT.lock().unwrap();
        if let Some(monitor) = MONITOR.get() {
            return Ok(monitor.clone());
        }
        let monitor = Arc::new(Monitor::new()?);
        let running = monitor.clone();
        // Published only once its thread runs, so a failed start is retried
        // by the next spawn instead of leaving children unwatched.
        std::thread::Builder::new()
            .name("pty-exit".into())
            .spawn(move || running.run())?;
        let _ = MONITOR.set(monitor.clone());
        Ok(monitor)
    }

    pub struct Watcher(Arc<Monitor>);

    impl Watcher {
        pub fn new() -> io::Result<Self> {
            monitor().map(Self)
        }

        pub fn watch(&self, child: BoxedChild, slot: Arc<ExitSlot>) -> Stopper {
            let token = self.0.watch(child, slot);
            Stopper { monitor: self.0.clone(), token }
        }
    }

    pub struct Stopper {
        monitor: Arc<Monitor>,
        token: u64,
    }

    impl Stopper {
        pub fn stop(&self) {
            self.monitor.stop(self.token);
        }
    }
}

#[cfg(not(target_os = "macos"))]
mod imp {
    use std::sync::{mpsc, Arc};
    #[cfg(not(unix))]
    use std::time::Duration;

    use super::{BoxedChild, ExitSlot};

    pub struct Watcher;

    impl Watcher {
        pub fn new() -> std::io::Result<Self> {
            Ok(Self)
        }

        pub fn watch(&self, child: BoxedChild, slot: Arc<ExitSlot>) -> Stopper {
            let (stop, stop_rx) = mpsc::channel();
            #[cfg(unix)]
            if let Some(pid) = child.process_id() {
                let wake = stop.clone();
                std::thread::spawn(move || watch_exit(pid, wake));
            }
            // Reap independently: buffered output or inherited slave
            // descriptors must not leave an exited child unreaped.
            std::thread::spawn(move || slot.publish(reap_child(child, stop_rx)));
            Stopper(stop)
        }
    }

    // The exit watcher holds a sender too, so stop requests are explicit
    // messages rather than the channel closing.
    pub struct Stopper(mpsc::Sender<()>);

    impl Stopper {
        pub fn stop(&self) {
            let _ = self.0.send(());
        }
    }

    // The owning child handle escalates from hangup to a forced kill. A cloned
    // signal handle only sends SIGHUP and can leave shutdown waiting forever.
    fn reap_child(mut child: BoxedChild, stop: mpsc::Receiver<()>) -> i32 {
        let mut signalled = false;
        loop {
            match child.try_wait() {
                Ok(Some(status)) => return status.exit_code() as i32,
                Err(_) => return -1,
                // Still running after a signal: it was a stop request.
                Ok(None) if signalled => break,
                Ok(None) => {}
            }
            signalled = next_signal(&stop);
        }
        let _ = child.kill();
        child.wait().map(|status| status.exit_code() as i32).unwrap_or(-1)
    }

    // Blocks until a stop request, the exit watcher's report that the child is
    // waitable, or every sender is gone; a running terminal never wakes on a timer.
    #[cfg(unix)]
    fn next_signal(stop: &mpsc::Receiver<()>) -> bool {
        let _ = stop.recv();
        true
    }

    #[cfg(not(unix))]
    fn next_signal(stop: &mpsc::Receiver<()>) -> bool {
        !matches!(stop.recv_timeout(Duration::from_millis(20)), Err(mpsc::RecvTimeoutError::Timeout))
    }

    // Waits for the child to exit without reaping it (WNOWAIT), then wakes the
    // reaper, which collects the status. Only the reaper reaps, so the pid cannot
    // be reused while the reaper may still signal it.
    #[cfg(unix)]
    fn watch_exit(pid: u32, wake: mpsc::Sender<()>) {
        loop {
            // SAFETY: siginfo_t is plain data and waitid only writes into it.
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            if unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0 {
                let _ = wake.send(());
                return;
            }
            match std::io::Error::last_os_error().raw_os_error() {
                Some(libc::EINTR) => {}
                // Already reaped after a stop request: nothing is left to report.
                Some(libc::ECHILD) => return,
                _ => std::thread::sleep(std::time::Duration::from_millis(20)),
            }
        }
    }
}

#[cfg(all(test, unix))]
mod tests {
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};

    use super::*;

    // Spawns a shell script on a PTY whose output is drained in the background,
    // as the app does.
    fn spawn_watched(script: &str) -> (ChildExit, std::thread::JoinHandle<()>) {
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut reader = pair.master.try_clone_reader().unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", script]);
        let watcher = Watcher::new().unwrap();
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let output = std::thread::spawn(move || {
            let _ = std::io::copy(&mut reader, &mut std::io::sink());
            drop(pair.master);
        });
        (watcher.watch(child), output)
    }

    #[test]
    fn exit_code_is_reported_once_the_child_exits() {
        let (exit, output) = spawn_watched("sleep 0.2; exit 7");
        let waiter = exit.waiter();
        let (done_tx, done_rx) = std::sync::mpsc::channel();
        std::thread::spawn(move || done_tx.send(waiter.wait()).unwrap());
        assert_eq!(done_rx.recv_timeout(std::time::Duration::from_secs(5)).unwrap(), 7);
        // A stop after the exit is a no-op and the code stays available.
        exit.stop();
        assert_eq!(exit.wait(), 7);
        output.join().unwrap();
    }

    #[test]
    fn an_immediate_exit_is_not_missed() {
        let (exit, output) = spawn_watched("exit 3");
        assert_eq!(exit.wait(), 3);
        output.join().unwrap();
    }

    #[test]
    fn many_children_are_tracked_independently() {
        let watched: Vec<_> = (0..16).map(|code| spawn_watched(&format!("sleep 0.0{}; exit {code}", code % 5))).collect();
        for (code, (exit, output)) in watched.into_iter().enumerate() {
            assert_eq!(exit.wait(), code as i32);
            output.join().unwrap();
        }
    }

    #[test]
    fn stop_kills_a_running_child() {
        let (exit, output) = spawn_watched("exec sleep 30");
        std::thread::sleep(std::time::Duration::from_millis(50));
        let start = std::time::Instant::now();
        exit.stop();
        assert_ne!(exit.wait(), 0);
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
        output.join().unwrap();
    }

    #[test]
    fn stop_escalates_when_hangup_is_ignored() {
        use std::io::{BufRead, BufReader};
        let pair = native_pty_system()
            .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
            .unwrap();
        let mut command = CommandBuilder::new("/bin/sh");
        command.args(["-c", "trap '' HUP; printf 'ready\\n'; exec sleep 30"]);
        let watcher = Watcher::new().unwrap();
        let child = pair.slave.spawn_command(command).unwrap();
        drop(pair.slave);
        let mut ready = String::new();
        BufReader::new(pair.master.try_clone_reader().unwrap()).read_line(&mut ready).unwrap();
        assert_eq!(ready.trim(), "ready");
        let exit = watcher.watch(child);
        let start = std::time::Instant::now();
        exit.stop();
        assert_ne!(exit.wait(), 0);
        assert!(start.elapsed() >= std::time::Duration::from_millis(150));
        assert!(start.elapsed() < std::time::Duration::from_secs(2));
    }
}
