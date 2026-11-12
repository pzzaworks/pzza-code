// The per-user service lives while an app or terminal session needs it.
// Its signed owner preserves the app's Local Network choice across UI restarts.
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Read};
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::os::unix::io::AsRawFd;
use std::os::unix::net::UnixStream;
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Output, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex};
use std::time::{Duration, Instant};

const LABEL: &str = "com.pzzacode.tmux";
const BUNDLE_ID: &str = "com.pzzacode.app";
const SERVER_ARGUMENT: &str = "--local-tmux-server";
// What a bounded command may print per stream; the rest is read and dropped.
const OUTPUT_LIMIT: u64 = 64 * 1024 * 1024;
// After a failed start, the next try waits this long, doubling up to the cap.
const FIRST_RETRY: Duration = Duration::from_secs(10);
const LAST_RETRY: Duration = Duration::from_secs(300);
// Polls in a row without an answer before an adopted server counts as gone.
const GONE_POLLS: u32 = 3;
static START_LOCK: Mutex<()> = Mutex::new(());
static APP_LEASE: Mutex<Option<File>> = Mutex::new(None);
// Set once the app has let go of its terminals (quitting): nothing starts
// the server again after that.
static STOPPED: AtomicBool = AtomicBool::new(false);
static RETRY: Mutex<Retry> = Mutex::new(Retry::new());

/// When the next start may be tried after a failed one.
#[derive(Debug, Clone, Copy, PartialEq)]
struct Retry {
    next: Option<Instant>,
    delay: Duration,
}

impl Retry {
    const fn new() -> Self {
        Retry { next: None, delay: FIRST_RETRY }
    }

    fn due(&self, now: Instant) -> bool {
        self.next.is_none_or(|next| now >= next)
    }

    fn failed(&mut self, now: Instant) {
        self.next = Some(now + self.delay);
        self.delay = (self.delay * 2).min(LAST_RETRY);
    }
}

pub fn socket_path() -> PathBuf {
    // Keep the Unix socket comfortably below macOS's 104-byte limit, even
    // with a long home directory. The directory is private to this user.
    PathBuf::from(format!("/private/tmp/pzzacode-tmux-{}", unsafe {
        libc::geteuid()
    }))
    .join("server.sock")
}

fn private_directory(path: &Path) -> io::Result<()> {
    match DirBuilder::new().mode(0o700).create(path) {
        Ok(()) => {}
        Err(error) if error.kind() == io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(error),
    }
    let metadata = fs::symlink_metadata(path)?;
    if !metadata.is_dir()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "The local terminal socket directory must be a private directory owned by this user",
        ));
    }
    Ok(())
}

fn xml(value: &str) -> String {
    value
        .replace('&', "&amp;")
        .replace('<', "&lt;")
        .replace('>', "&gt;")
        .replace('"', "&quot;")
        .replace('\'', "&apos;")
}

fn service_plist(executable: &Path, path: &str) -> io::Result<String> {
    let executable = executable.to_str().ok_or_else(|| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            "The application path is not UTF-8",
        )
    })?;
    Ok(format!(
        "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n\
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">\n\
<plist version=\"1.0\"><dict>\n\
<key>Label</key><string>{LABEL}</string>\n\
<key>ProgramArguments</key><array><string>{}</string><string>{SERVER_ARGUMENT}</string></array>\n\
<key>AssociatedBundleIdentifiers</key><array><string>{BUNDLE_ID}</string></array>\n\
<key>EnvironmentVariables</key><dict><key>PATH</key><string>{}</string><key>LANG</key><string>en_US.UTF-8</string></dict>\n\
<key>RunAtLoad</key><false/>\n\
<key>KeepAlive</key><false/>\n\
<key>ThrottleInterval</key><integer>10</integer>\n\
<key>ProcessType</key><string>Interactive</string>\n\
<key>AbandonProcessGroup</key><true/>\n\
</dict></plist>\n",
        xml(executable),
        xml(path),
    ))
}

fn unescape_xml(value: &str) -> String {
    value
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", "\"")
        .replace("&apos;", "'")
        .replace("&amp;", "&")
}

/// The PATH a service definition this app wrote holds (see service_plist).
fn service_plist_path(plist: &str) -> Option<String> {
    let start = plist.find("<key>PATH</key><string>")? + "<key>PATH</key><string>".len();
    let length = plist[start..].find("</string>")?;
    Some(unescape_xml(&plist[start..start + length])).filter(|path| !path.is_empty())
}

/// The PATH for the service definition: the login shell's when it reported
/// one; otherwise the one the existing definition holds, so a slow shell
/// never replaces a good PATH there with the fallback (`fallback` only for a
/// first definition).
fn service_path(probed: Option<&str>, existing: Option<&str>, fallback: &str) -> String {
    probed
        .map(String::from)
        .or_else(|| existing.and_then(service_plist_path))
        .unwrap_or_else(|| fallback.to_string())
}

fn write_service(path: &Path, contents: &str) -> io::Result<()> {
    if fs::read_to_string(path).ok().as_deref() == Some(contents) {
        return Ok(());
    }
    use std::io::Write;
    let suffix = crate::agent::random_hex(8)
        .ok_or_else(|| io::Error::other("Could not allocate a service configuration file"))?;
    let temporary = path.with_extension(format!("{suffix}.tmp"));
    let result = (|| {
        let mut file = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .open(&temporary)?;
        file.write_all(contents.as_bytes())?;
        file.sync_all()?;
        fs::rename(&temporary, path)
    })();
    if result.is_err() {
        let _ = fs::remove_file(temporary);
    }
    result
}

fn timed_out() -> io::Error {
    io::Error::new(
        io::ErrorKind::TimedOut,
        "Local terminal service command timed out",
    )
}

/// Reads a pipe to its end on a thread of its own, keeping at most
/// OUTPUT_LIMIT bytes, and sends what it read once the pipe closes.
fn drain(pipe: Option<impl Read + Send + 'static>) -> io::Result<mpsc::Receiver<Vec<u8>>> {
    let (sender, receiver) = mpsc::channel();
    std::thread::Builder::new()
        .name("pzza-command-output".into())
        .spawn(move || {
            let mut bytes = Vec::new();
            if let Some(mut pipe) = pipe {
                let _ = (&mut pipe).take(OUTPUT_LIMIT).read_to_end(&mut bytes);
                // Past the limit the rest is read and dropped, so the command
                // never blocks on a full pipe.
                let _ = io::copy(&mut pipe, &mut io::sink());
            }
            let _ = sender.send(bytes);
        })?;
    Ok(receiver)
}

/// Runs a command with a 4 s limit and returns what it printed. Both pipes
/// are read while it runs: a command that prints more than a pipe holds
/// (a long pane capture) would otherwise block until it is killed.
pub(crate) fn bounded_output(command: &mut Command) -> io::Result<Output> {
    bounded_output_within(command, Duration::from_secs(4))
}

fn bounded_output_within(command: &mut Command, timeout: Duration) -> io::Result<Output> {
    let mut child = command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()?;
    let pipes = drain(child.stdout.take()).and_then(|stdout| Ok((stdout, drain(child.stderr.take())?)));
    let (stdout, stderr) = match pipes {
        Ok(pipes) => pipes,
        Err(error) => {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
    };
    let deadline = Instant::now() + timeout;
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break status,
            Ok(None) if Instant::now() < deadline => std::thread::sleep(Duration::from_millis(5)),
            waited => {
                let _ = child.kill();
                let _ = child.wait();
                waited?;
                return Err(timed_out());
            }
        }
    };
    // The pipes close with the command (and anything it left running that
    // kept them open gets until the deadline, at least a moment).
    let grace = deadline.saturating_duration_since(Instant::now()).max(Duration::from_millis(500));
    let stdout = stdout.recv_timeout(grace).map_err(|_| timed_out())?;
    let stderr = stderr.recv_timeout(Duration::from_millis(500)).map_err(|_| timed_out())?;
    Ok(Output { status, stdout, stderr })
}

pub fn client_command() -> Command {
    let mut command = Command::new("tmux");
    command
        .args(["-N", "-S"])
        .arg(socket_path())
        .env("PATH", crate::agent::login_path())
        .env_remove("TMUX");
    command
}

fn tmux_available() -> bool {
    Command::new("tmux")
        .arg("-V")
        .env("PATH", crate::agent::login_path())
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok_and(|status| status.success())
}

pub(crate) fn homebrew() -> Option<&'static str> {
    ["/opt/homebrew/bin/brew", "/usr/local/bin/brew"]
        .into_iter()
        .find(|path| Path::new(path).is_file())
}

/// Installs one Homebrew formula non-interactively. Callers pass fixed formula
/// names only; nothing here comes from user input.
pub(crate) fn brew_install(formula: &'static str) -> Result<(), String> {
    let brew = homebrew().ok_or(format!(
        "Homebrew is needed to install {formula}. Install Homebrew first, then try again."
    ))?;
    let output = Command::new(brew)
        .args(["install", formula])
        .env("PATH", crate::agent::login_path())
        // Skip the index refresh: it can take minutes and these formulae are in any recent index.
        .env("HOMEBREW_NO_AUTO_UPDATE", "1")
        .env("HOMEBREW_NO_ENV_HINTS", "1")
        .stdin(Stdio::null())
        .output()
        .map_err(|_| "Homebrew could not be started".to_string())?;
    if !output.status.success() {
        let reason = String::from_utf8_lossy(&output.stderr)
            .lines()
            .rev()
            .find(|line| !line.trim().is_empty())
            .map(|line| line.trim().chars().take(300).collect::<String>())
            .unwrap_or_default();
        return Err(format!("Homebrew could not install {formula}. {reason}").trim().to_string());
    }
    Ok(())
}

/// Installs tmux with Homebrew when it is missing, then starts the local
/// terminal service. Homebrew itself needs an administrator password to
/// install, so it is a prerequisite rather than something set up silently.
pub fn install() -> Result<(), String> {
    if !tmux_available() {
        brew_install("tmux")?;
        if !tmux_available() {
            return Err("tmux was installed but cannot be found. Restart PzzaCode and try again.".into());
        }
    }
    start().map_err(|error| error.to_string())
}

pub fn start() -> io::Result<()> {
    let _guard = START_LOCK
        .lock()
        .map_err(|_| io::Error::other("Local terminal startup interrupted"))?;
    scheduled_start(start_locked(Duration::from_secs(5)))
}

// Notes a start's outcome for ensure_running: a failure delays the next try.
fn scheduled_start(result: io::Result<()>) -> io::Result<()> {
    if let Ok(mut retry) = RETRY.lock() {
        match &result {
            Ok(()) => *retry = Retry::new(),
            Err(_) => retry.failed(Instant::now()),
        }
    }
    result
}

/// Starts the local terminal server again when it does not answer (a start
/// that failed at launch or after a refresh, or a server that ended while the
/// app runs). Cheap while the server answers; otherwise it tries at most once
/// per retry delay, never while another start runs, and never once the app
/// has let go of its terminals. Callers run it off the main thread.
pub fn ensure_running() {
    if STOPPED.load(Ordering::SeqCst) {
        return;
    }
    let owned = APP_LEASE.lock().is_ok_and(|lease| lease.is_some());
    if owned && UnixStream::connect(socket_path()).is_ok() {
        return;
    }
    let Ok(_guard) = START_LOCK.try_lock() else {
        return;
    };
    if STOPPED.load(Ordering::SeqCst) || !RETRY.lock().is_ok_and(|retry| retry.due(Instant::now())) {
        return;
    }
    if let Err(error) = scheduled_start(start_locked(Duration::from_secs(5))) {
        eprintln!("PzzaCode local terminals: {error}");
    }
}

/// Whether the app has let go of its terminals (it is quitting).
pub fn stopping() -> bool {
    STOPPED.load(Ordering::SeqCst)
}

/// Restarts the local tmux server so privacy grants made since it started
/// reach new shells: macOS attributes them to the helper process, which only
/// picks up a grant when it is started again. Every session on the server
/// ends; callers save and recreate them. This app holds its lease throughout
/// (taking one when its launch start failed), so the exiting helper never
/// unregisters the service and other app instances keep their own leases.
pub fn restart() -> io::Result<()> {
    let _guard = START_LOCK
        .lock()
        .map_err(|_| io::Error::other("Local terminal startup interrupted"))?;
    if STOPPED.load(Ordering::SeqCst) {
        return Err(io::Error::other("Local terminals are shutting down"));
    }
    let socket = socket_path();
    {
        let mut lease = APP_LEASE
            .lock()
            .map_err(|_| io::Error::other("Local terminal ownership interrupted"))?;
        if lease.is_none() {
            private_directory(socket.parent().unwrap())?;
            *lease = Some(app_lease(socket.parent().unwrap())?);
        }
    }
    let _ = bounded_output(client_command().arg("kill-server"));
    let deadline = Instant::now() + Duration::from_secs(5);
    while UnixStream::connect(&socket).is_ok() {
        if Instant::now() >= deadline {
            return Err(io::Error::other("The local terminal server did not stop"));
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    // The old helper notices its tmux exit within one ownership poll; launchd
    // starts the job again only once that process is gone, and start_locked
    // then makes sure the job runs this app's executable. A failure leaves
    // the caller's saved sessions for ensure_running to bring back.
    scheduled_start(start_locked(Duration::from_secs(15)))
}

/// The service job as `launchctl print` shows it.
#[derive(Debug, Clone, PartialEq)]
struct LoadedJob {
    program: Option<String>,
    running: bool,
}

/// What to do with the service job before starting its helper.
#[derive(Debug, Clone, Copy, PartialEq)]
enum JobAction {
    Keep,
    Register,
    Reregister,
}

/// The job's own `program` and `state` lines from `launchctl print`; nested
/// blocks (arguments, environment, endpoints) are skipped.
fn loaded_job(print: &str) -> LoadedJob {
    let mut job = LoadedJob { program: None, running: false };
    let mut depth = 0usize;
    for line in print.lines() {
        let text = line.trim();
        if text == "}" {
            depth = depth.saturating_sub(1);
            continue;
        }
        if depth == 1 {
            if let Some(program) = text.strip_prefix("program = ") {
                if job.program.is_none() && !program.is_empty() {
                    job.program = Some(program.to_string());
                }
            } else if let Some(state) = text.strip_prefix("state = ") {
                job.running = state == "running";
            }
        }
        if text.ends_with('{') {
            depth += 1;
        }
    }
    job
}

/// Whether the job must be registered (again) before its helper starts. A
/// live server is never touched, and neither is a helper that is running
/// (starting up, or exiting after its server ended). Only an idle job that
/// starts another executable is replaced; an unreadable program is kept.
fn job_action(socket_alive: bool, job: Option<&LoadedJob>, executable: &Path) -> JobAction {
    if socket_alive {
        return JobAction::Keep;
    }
    let Some(job) = job else {
        return JobAction::Register;
    };
    match &job.program {
        Some(program) if !job.running && Path::new(program) != executable => JobAction::Reregister,
        _ => JobAction::Keep,
    }
}

fn start_locked(timeout: Duration) -> io::Result<()> {
    let socket = socket_path();
    private_directory(socket.parent().unwrap())?;
    let lease = app_lease(socket.parent().unwrap())?;
    let home = std::env::var_os("HOME")
        .ok_or_else(|| io::Error::new(io::ErrorKind::NotFound, "Home directory unavailable"))?;
    let directory = PathBuf::from(home).join("Library/LaunchAgents");
    fs::create_dir_all(&directory)?;
    let plist = directory.join(format!("{LABEL}.plist"));
    // The service outlives this process, so it gets the login shell's PATH
    // only once the shell reported it; until then it keeps the one it has.
    let path = service_path(
        crate::agent::probed_login_path(),
        fs::read_to_string(&plist).ok().as_deref(),
        crate::agent::login_path(),
    );
    write_service(&plist, &service_plist(&std::env::current_exe()?, &path)?)?;
    let executable = std::env::current_exe()?;
    let domain = format!("gui/{}", unsafe { libc::geteuid() });
    let target = format!("{domain}/{LABEL}");
    let loaded = bounded_output(Command::new("/bin/launchctl").args(["print", &target]))?;
    if !loaded.status.success() {
        let result = bounded_output(
            Command::new("/bin/launchctl")
                .args(["bootstrap", &domain])
                .arg(&plist),
        )?;
        if !result.status.success() {
            // Another app instance can register the same job concurrently.
            let loaded = bounded_output(Command::new("/bin/launchctl").args(["print", &target]))?;
            if !loaded.status.success() {
                return Err(io::Error::other(
                    "Could not register the local terminal service with the user login session",
                ));
            }
        }
    }
    // Never boot out a loaded job while its server answers: it owns live
    // terminals. Writing the plist does not change a loaded job, so a job
    // registered by another copy of the app keeps starting that copy, which
    // macOS can refuse to launch. Once no server answers and no helper runs,
    // the job is registered again from the current plist (once per start, so
    // two app copies starting together cannot keep replacing each other).
    let deadline = Instant::now() + timeout;
    let mut next_start = Instant::now();
    let mut reregistered = false;
    loop {
        if UnixStream::connect(&socket).is_ok() && set_exit_empty(&socket, false).is_ok() {
            pin_window_indices(&socket);
            // A server whose helper ended keeps running in its own process
            // group; a new helper adopts it, so ownership still ends when the
            // last app closes. No -k, and only when no helper runs.
            let idle = bounded_output(Command::new("/bin/launchctl").args(["print", &target]))
                .ok()
                .filter(|output| output.status.success())
                .is_some_and(|output| !loaded_job(&String::from_utf8_lossy(&output.stdout)).running);
            if idle {
                let _ = bounded_output(Command::new("/bin/launchctl").args(["kickstart", &target]));
            }
            *APP_LEASE
                .lock()
                .map_err(|_| io::Error::other("Local terminal ownership interrupted"))? =
                Some(lease);
            return Ok(());
        }
        if Instant::now() >= deadline {
            return Err(io::Error::other("The local terminal service is unavailable. Check that background activity for PzzaCode is enabled and tmux is installed."));
        }
        if UnixStream::connect(&socket).is_err() && Instant::now() >= next_start {
            let job = bounded_output(Command::new("/bin/launchctl").args(["print", &target]))
                .ok()
                .filter(|output| output.status.success())
                .map(|output| loaded_job(&String::from_utf8_lossy(&output.stdout)));
            // Checked again right before acting: a server that came up since
            // the probe above must never lose its job.
            let alive = UnixStream::connect(&socket).is_ok();
            match job_action(alive, job.as_ref(), &executable) {
                JobAction::Keep => {}
                JobAction::Register => {
                    let _ = bounded_output(
                        Command::new("/bin/launchctl")
                            .args(["bootstrap", &domain])
                            .arg(&plist),
                    );
                }
                JobAction::Reregister if !reregistered => {
                    reregistered = true;
                    let _ = bounded_output(Command::new("/bin/launchctl").args(["bootout", &target]));
                    // A failed bootstrap (the bootout still settling) is
                    // retried on the next round as an unregistered job.
                    let _ = bounded_output(
                        Command::new("/bin/launchctl")
                            .args(["bootstrap", &domain])
                            .arg(&plist),
                    );
                }
                JobAction::Reregister => {}
            }
            // No -k: opening a UI must never kill existing terminal sessions.
            // Retry if the previous helper was still exiting on the first probe.
            let _ = bounded_output(Command::new("/bin/launchctl").args(["kickstart", &target]));
            next_start = Instant::now() + Duration::from_millis(500);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn lease_file(directory: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_CLOEXEC)
        .open(directory.join("app.lock"))?;
    let metadata = file.metadata()?;
    if !metadata.is_file()
        || metadata.uid() != unsafe { libc::geteuid() }
        || metadata.mode() & 0o077 != 0
    {
        return Err(io::Error::new(
            io::ErrorKind::PermissionDenied,
            "Local terminal ownership file is not private",
        ));
    }
    Ok(file)
}

fn app_lease(directory: &Path) -> io::Result<File> {
    let file = lease_file(directory)?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_SH) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

struct IdleLease<'a>(&'a File);

impl Drop for IdleLease<'_> {
    fn drop(&mut self) {
        unsafe {
            libc::flock(self.0.as_raw_fd(), libc::LOCK_UN);
        }
    }
}

fn idle_lease(file: &File) -> io::Result<Option<IdleLease<'_>>> {
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        let error = io::Error::last_os_error();
        return if error.kind() == io::ErrorKind::WouldBlock {
            Ok(None)
        } else {
            Err(error)
        };
    }
    Ok(Some(IdleLease(file)))
}

fn set_exit_empty(socket: &Path, enabled: bool) -> io::Result<()> {
    let output = bounded_output(
        Command::new("tmux")
            .args(["-N", "-S"])
            .arg(socket)
            .args([
                "set-option",
                "-s",
                "exit-empty",
                if enabled { "on" } else { "off" },
            ])
            .env("PATH", crate::agent::login_path())
            .env_remove("TMUX"),
    )?;
    if output.status.success() {
        Ok(())
    } else {
        Err(io::Error::other(
            "Local terminal server did not accept its lifetime setting",
        ))
    }
}

// Window tiles are tracked and terminated by their tmux window index. The
// managed server loads the user's tmux.conf, which commonly sets
// `renumber-windows on`; that would renumber the survivors whenever a sibling
// window closes, leaving a tile pointing at a now-different window. Pin the
// numbering on this server we own so an index stays valid for a window's life,
// so a terminate never kills the wrong window or leaves the session behind.
// Best effort: a server that rejects the option must not block ownership.
fn pin_window_indices(socket: &Path) {
    let _ = bounded_output(
        Command::new("tmux")
            .args(["-N", "-S"])
            .arg(socket)
            .args(["set-option", "-g", "renumber-windows", "off"])
            .env("PATH", crate::agent::login_path())
            .env_remove("TMUX"),
    );
}

pub fn stop() {
    STOPPED.store(true, Ordering::SeqCst);
    let Ok(mut lease) = APP_LEASE.lock() else {
        return;
    };
    if lease.take().is_none() {
        return;
    }
    let socket = socket_path();
    let result = (|| -> io::Result<()> {
        let observer = lease_file(socket.parent().unwrap())?;
        if let Some(_idle) = idle_lease(&observer)? {
            if UnixStream::connect(&socket).is_ok() {
                set_exit_empty(&socket, true)?;
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        eprintln!("PzzaCode local terminal idle cleanup: {error}");
    }
}

fn server_lock(directory: &Path) -> io::Result<File> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join("server.lock"))?;
    if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } != 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(file)
}

fn run_server() -> io::Result<i32> {
    run_service_at(&socket_path(), LABEL, Command::new("tmux"))
}

fn run_service_at(socket: &Path, label: &str, command: Command) -> io::Result<i32> {
    let code = run_server_at(socket, command)?;
    let observer = lease_file(socket.parent().unwrap())?;
    if let Some(_idle) = idle_lease(&observer)? {
        if UnixStream::connect(&socket).is_err() {
            // Also removes a previously loaded KeepAlive definition after its
            // sessions end. Holding the idle lease keeps a new app from racing
            // this removal; it will register the current on-demand definition.
            let target = format!("gui/{}/{label}", unsafe { libc::geteuid() });
            let _ = bounded_output(Command::new("/bin/launchctl").args(["bootout", &target]));
        }
    }
    Ok(code)
}

fn run_server_at(socket: &Path, mut command: Command) -> io::Result<i32> {
    let directory = socket.parent().unwrap();
    private_directory(directory)?;
    let _lock = server_lock(directory)?;
    let lease = lease_file(directory)?;
    if UnixStream::connect(socket).is_ok() {
        // The server outlived an earlier helper (it runs in a process group
        // of its own). It is never replaced: this helper takes over its
        // ownership and ends when it does.
        return supervise(socket, &lease, None);
    }
    // Keep this signed helper alive as the responsible process. tmux must not
    // daemonize, and must not inherit a server selection from another terminal.
    // Its own process group keeps it, and every session, alive when this
    // helper exits for any reason: launchd ends whatever is left in a job's
    // process group once the job's process is gone.
    let child = command
        .args(["-D", "-S"])
        .arg(socket)
        .env_remove("TMUX")
        .env_remove("PZZA_TMUX_SOCKET")
        .stdin(Stdio::null())
        .process_group(0)
        .spawn()?;
    supervise(socket, &lease, Some(child))
}

/// Applies app ownership to the server until it ends: while any app holds a
/// lease the server stays up when empty, otherwise it exits with its last
/// session. The server is watched as this helper's child, or (adopted, or
/// when the child cannot be waited on) through its socket. A failed lease
/// check counts as owned, which only keeps sessions alive.
fn supervise(socket: &Path, lease: &File, mut child: Option<std::process::Child>) -> io::Result<i32> {
    // File locks disappear on normal exit, crashes and force-quit, and cannot
    // confuse a reused PID with a live app. Only ownership transitions issue
    // a tmux command; otherwise the check is two local system calls.
    let mut owner = None;
    let mut unanswered = 0;
    loop {
        if let Some(server) = child.as_mut() {
            match server.try_wait() {
                Ok(Some(status)) => return Ok(status.code().unwrap_or(1)),
                Ok(None) => {}
                Err(_) => child = None,
            }
        }
        if child.is_none() {
            unanswered = if UnixStream::connect(socket).is_ok() { 0 } else { unanswered + 1 };
            if unanswered >= GONE_POLLS {
                return Ok(0);
            }
        }
        // Hold exclusive ownership until the idle setting is applied, so an
        // opening app cannot race an idle decision made just before its lease.
        let idle = idle_lease(lease).unwrap_or(None);
        let running = idle.is_none();
        if owner != Some(running) && UnixStream::connect(socket).is_ok() {
            if set_exit_empty(socket, !running).is_ok() {
                owner = Some(running);
            }
        }
        drop(idle);
        std::thread::sleep(Duration::from_millis(500));
    }
}

pub fn headless_exit_code() -> Option<i32> {
    if std::env::args_os().nth(1).as_deref() != Some(std::ffi::OsStr::new(SERVER_ARGUMENT)) {
        return None;
    }
    Some(match run_server() {
        Ok(code) => code,
        Err(error) => {
            eprintln!("PzzaCode local terminal service: {error}");
            1
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn directory() -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "pzza-tmux-test-{}",
            crate::agent::random_hex(8).unwrap()
        ));
        private_directory(&path).unwrap();
        path
    }

    #[test]
    fn a_service_keeps_its_path_until_the_login_shell_reports_one() {
        let executable = Path::new("/Applications/PzzaCode.app/Contents/MacOS/app");
        let existing = service_plist(executable, "/opt/local/bin:/a&<b>").unwrap();
        assert_eq!(service_plist_path(&existing).as_deref(), Some("/opt/local/bin:/a&<b>"));
        // A probe that timed out never replaces the PATH already there.
        assert_eq!(service_path(None, Some(&existing), "/usr/bin:/bin"), "/opt/local/bin:/a&<b>");
        // Once the shell answers, its PATH is written.
        assert_eq!(service_path(Some("/nix/bin:/usr/bin"), Some(&existing), "/usr/bin:/bin"), "/nix/bin:/usr/bin");
        // A first definition (or one that holds none) takes the fallback.
        assert_eq!(service_path(None, None, "/usr/bin:/bin"), "/usr/bin:/bin");
        assert_eq!(service_path(None, Some("<plist/>"), "/usr/bin:/bin"), "/usr/bin:/bin");
        // Kept as it was: escaped once in the file, never twice.
        let rewritten = service_plist(executable, &service_path(None, Some(&existing), "")).unwrap();
        assert_eq!(rewritten, existing);
    }

    #[test]
    fn service_preserves_app_identity_and_escapes_paths() {
        let content = service_plist(
            Path::new("/Applications/Berke's & <App>.app/Contents/MacOS/app"),
            "/bin:&<tools>",
        )
        .unwrap();
        let directory = directory();
        let file = directory.join("job.plist");
        write_service(&file, &content).unwrap();
        assert!(Command::new("/usr/bin/plutil")
            .arg("-lint")
            .arg(&file)
            .status()
            .unwrap()
            .success());
        assert!(content.contains("AssociatedBundleIdentifiers"));
        assert!(content.contains("<key>KeepAlive</key><false/>"));
        assert!(content.contains("<key>RunAtLoad</key><false/>"));
        assert!(content.contains("<key>AbandonProcessGroup</key><true/>"), "a helper exit must never take the server down");
        assert!(content.contains("Berke&apos;s &amp; &lt;App&gt;"));
        assert!(content.contains(SERVER_ARGUMENT));
        assert_eq!(fs::metadata(&file).unwrap().mode() & 0o777, 0o600);
        fs::remove_dir_all(directory).unwrap();
    }

    // Shaped like `launchctl print gui/<uid>/<label>` for a job that another
    // copy of the app registered.
    const PRINTED_JOB: &str = "gui/501/com.pzzacode.tmux = {
\tactive count = 0
\tpath = /Users/me/Library/LaunchAgents/com.pzzacode.tmux.plist
\ttype = LaunchAgent
\tstate = not running

\tprogram = /Users/me/src/app/target/release/bundle/macos/PzzaCode.app/Contents/MacOS/pzzacode
\targuments = {
\t\t/Users/me/src/app/target/release/bundle/macos/PzzaCode.app/Contents/MacOS/pzzacode
\t\t--local-tmux-server
\t}

\tenvironment = {
\t\tPATH => /opt/homebrew/bin:/usr/bin:/bin
\t\tprogram = /not/the/job
\t}

\tdomain = gui/501 [100022]
\tlast exit reason = OS_REASON_CODESIGNING | Launch Constraint Violation
\tendpoints = {
\t\t\"com.example\" = {
\t\t\tstate = active
\t\t}
\t}
}
";

    #[test]
    fn reads_the_loaded_program_and_state_of_the_job() {
        let job = loaded_job(PRINTED_JOB);
        assert_eq!(
            job.program.as_deref(),
            Some("/Users/me/src/app/target/release/bundle/macos/PzzaCode.app/Contents/MacOS/pzzacode")
        );
        assert!(!job.running, "a nested block's state is not the job's");
        let running = loaded_job(&PRINTED_JOB.replace("state = not running", "state = running"));
        assert!(running.running);
        assert_eq!(loaded_job(""), LoadedJob { program: None, running: false });
        assert_eq!(loaded_job("gui/501/x = {\n\tstate = running\n}\n").program, None);
    }

    #[test]
    fn a_stale_job_is_registered_again_only_without_a_server() {
        let current = Path::new("/Applications/PzzaCode.app/Contents/MacOS/pzzacode");
        let stale = loaded_job(PRINTED_JOB);
        let same = LoadedJob { program: Some(current.to_string_lossy().into_owned()), running: false };
        // A live server keeps whatever job owns it.
        assert_eq!(job_action(true, Some(&stale), current), JobAction::Keep);
        assert_eq!(job_action(true, None, current), JobAction::Keep);
        // No server: a job that starts another app copy is replaced.
        assert_eq!(job_action(false, Some(&stale), current), JobAction::Reregister);
        assert_eq!(job_action(false, Some(&same), current), JobAction::Keep);
        assert_eq!(job_action(false, None, current), JobAction::Register);
        // A helper still running (starting, or exiting) is never booted out.
        let running = LoadedJob { running: true, ..stale.clone() };
        assert_eq!(job_action(false, Some(&running), current), JobAction::Keep);
        // An unreadable program is left alone.
        let unknown = LoadedJob { program: None, running: false };
        assert_eq!(job_action(false, Some(&unknown), current), JobAction::Keep);
    }

    #[test]
    fn rejects_shared_and_symlinked_socket_directories() {
        let directory = directory();
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert_eq!(
            private_directory(&directory).unwrap_err().kind(),
            io::ErrorKind::PermissionDenied
        );
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let link = directory.with_extension("link");
        symlink(&directory, &link).unwrap();
        assert!(private_directory(&link).is_err());
        fs::remove_file(link).unwrap();
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn only_one_service_can_own_the_server() {
        let directory = directory();
        let first = server_lock(&directory).unwrap();
        assert!(server_lock(&directory).is_err());
        drop(first);
        // A concurrent fork can briefly retain the descriptor until exec.
        let deadline = Instant::now() + Duration::from_secs(1);
        while let Err(error) = server_lock(&directory) {
            assert_eq!(error.kind(), io::ErrorKind::WouldBlock);
            assert!(
                Instant::now() < deadline,
                "Server ownership was not released"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn clients_cannot_start_an_unmanaged_server() {
        let command = client_command();
        let args: Vec<_> = command.get_args().collect();
        assert_eq!(args[0], "-N");
        assert_eq!(args[1], "-S");
        assert_eq!(args[2], socket_path());
        assert!(socket_path().as_os_str().len() < 100);
    }

    #[test]
    fn pinned_window_indices_survive_a_sibling_close() {
        let directory = directory();
        let socket = directory.join("server.sock");
        // First command (without -N) starts the server; later -N commands attach.
        let tmux = |start: bool, args: &[&str]| {
            let mut command = Command::new("tmux");
            command.args(["-f", "/dev/null"]);
            if !start {
                command.arg("-N");
            }
            bounded_output(command.arg("-S").arg(&socket).args(args).env_remove("TMUX")).unwrap()
        };
        assert!(tmux(true, &["new-session", "-d", "-s", "w", "/bin/sleep 30"])
            .status
            .success());
        assert!(tmux(false, &["new-window", "-t", "=w", "/bin/sleep 30"])
            .status
            .success());
        assert!(tmux(false, &["new-window", "-t", "=w", "/bin/sleep 30"])
            .status
            .success());
        // A user's tmux.conf commonly enables this; prove the pin overrides it.
        assert!(tmux(false, &["set-option", "-g", "renumber-windows", "on"])
            .status
            .success());
        pin_window_indices(&socket);
        assert_eq!(
            String::from_utf8_lossy(&tmux(false, &["show-option", "-gv", "renumber-windows"]).stdout)
                .trim(),
            "off"
        );
        // Closing the middle window must leave the last window's index untouched,
        // so a tile still terminates exactly the window it was created for.
        let before: Vec<String> =
            String::from_utf8_lossy(&tmux(false, &["list-windows", "-t", "=w", "-F", "#{window_index}"]).stdout)
                .split_whitespace()
                .map(str::to_owned)
                .collect();
        let middle = &before[1];
        assert!(tmux(false, &["kill-window", "-t", &format!("=w:{middle}")])
            .status
            .success());
        let after: Vec<String> =
            String::from_utf8_lossy(&tmux(false, &["list-windows", "-t", "=w", "-F", "#{window_index}"]).stdout)
                .split_whitespace()
                .map(str::to_owned)
                .collect();
        assert_eq!(after, vec![before[0].clone(), before[2].clone()]);
        let _ = tmux(false, &["kill-server"]);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn ownership_ends_only_after_the_last_app_exits() {
        let directory = directory();
        let observer = lease_file(&directory).unwrap();
        assert!(idle_lease(&observer).unwrap().is_some());
        let first = app_lease(&directory).unwrap();
        let second = app_lease(&directory).unwrap();
        assert!(idle_lease(&observer).unwrap().is_none());
        drop(first);
        assert!(idle_lease(&observer).unwrap().is_none());
        drop(second);
        // Parallel process tests can inherit the lease briefly before exec.
        let deadline = Instant::now() + Duration::from_secs(1);
        while idle_lease(&observer).unwrap().is_none() {
            assert!(Instant::now() < deadline, "App ownership was not released");
            std::thread::sleep(Duration::from_millis(10));
        }
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn helper_exits_when_unused_and_preserves_sessions_across_app_exit() {
        let directory = directory();
        let socket = directory.join("server.sock");
        let lease = app_lease(&directory).unwrap();
        let helper_socket = socket.clone();
        let helper = std::thread::spawn(move || {
            let mut command = Command::new("tmux");
            command.args(["-f", "/dev/null"]);
            run_server_at(&helper_socket, command)
        });
        let deadline = Instant::now() + Duration::from_secs(5);
        while UnixStream::connect(&socket).is_err() {
            assert!(
                Instant::now() < deadline,
                "Private terminal helper did not start"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        let command = |args: &[&str]| {
            bounded_output(
                Command::new("tmux")
                    .args(["-N", "-S"])
                    .arg(&socket)
                    .args(args)
                    .env_remove("TMUX"),
            )
            .unwrap()
        };
        assert!(
            command(&["new-session", "-d", "-s", "survivor", "/bin/sleep 30"])
                .status
                .success()
        );
        // The server is not in the helper's process group, so launchd ending
        // that group (any helper exit) leaves it running.
        let pid: libc::pid_t = String::from_utf8_lossy(&command(&["display-message", "-p", "#{pid}"]).stdout)
            .trim()
            .parse()
            .unwrap();
        let group = unsafe { libc::getpgid(pid) };
        assert_eq!(group, pid, "the server leads a process group of its own");
        assert_ne!(group, unsafe { libc::getpgrp() });
        drop(lease);
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            let output = command(&["show-option", "-sv", "exit-empty"]);
            if output.stdout.starts_with(b"on") {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Helper did not release idle ownership"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(command(&["has-session", "-t", "survivor"]).status.success());
        assert!(!helper.is_finished());
        let reopened = app_lease(&directory).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            if command(&["show-option", "-sv", "exit-empty"])
                .stdout
                .starts_with(b"off")
            {
                break;
            }
            assert!(
                Instant::now() < deadline,
                "Reopened app did not reclaim its helper"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert!(command(&["kill-session", "-t", "survivor"])
            .status
            .success());
        assert!(command(&["show-option", "-sv", "exit-empty"])
            .status
            .success());
        assert!(!helper.is_finished(), "The app still owns the empty helper");
        drop(reopened);
        let deadline = Instant::now() + Duration::from_secs(5);
        while !helper.is_finished() {
            assert!(
                Instant::now() < deadline,
                "Unused terminal helper did not exit"
            );
            std::thread::sleep(Duration::from_millis(20));
        }
        assert_eq!(helper.join().unwrap().unwrap(), 0);
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn a_new_helper_adopts_a_server_that_outlived_its_helper() {
        let directory = directory();
        let socket = directory.join("server.sock");
        let command = |args: &[&str]| {
            bounded_output(
                Command::new("tmux")
                    .args(["-f", "/dev/null", "-S"])
                    .arg(&socket)
                    .args(args)
                    .env_remove("TMUX"),
            )
            .unwrap()
        };
        // A server left running after its helper ended.
        assert!(command(&["new-session", "-d", "-s", "survivor", "/bin/sleep 30"]).status.success());
        let pid = command(&["display-message", "-p", "#{pid}"]).stdout;
        let lease = app_lease(&directory).unwrap();
        let helper_socket = socket.clone();
        let helper = std::thread::spawn(move || {
            let mut command = Command::new("tmux");
            command.args(["-f", "/dev/null"]);
            run_server_at(&helper_socket, command)
        });
        let wait_for = |description: &str, condition: &dyn Fn() -> bool| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !condition() {
                assert!(Instant::now() < deadline, "{description}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let exit_empty = |value: &[u8]| command(&["show-option", "-sv", "exit-empty"]).stdout.starts_with(value);
        wait_for("The new helper did not take ownership", &|| exit_empty(b"off"));
        assert!(!helper.is_finished(), "an existing server is adopted, not refused");
        assert_eq!(command(&["display-message", "-p", "#{pid}"]).stdout, pid, "the server was never replaced");
        drop(lease);
        wait_for("The adopting helper did not release idle ownership", &|| exit_empty(b"on"));
        assert!(command(&["has-session", "-t", "survivor"]).status.success());
        // The last session ends the server, and with it the helper.
        assert!(command(&["kill-session", "-t", "survivor"]).status.success());
        wait_for("The adopting helper did not end with its server", &|| helper.is_finished());
        assert_eq!(helper.join().unwrap().unwrap(), 0);
        assert!(UnixStream::connect(&socket).is_err());
        fs::remove_dir_all(directory).unwrap();
    }

    #[test]
    fn bounded_commands_return_output_larger_than_a_pipe() {
        let output = bounded_output(Command::new("/bin/sh").args(["-c", "head -c 300000 /dev/zero; head -c 100000 /dev/zero >&2"])).unwrap();
        assert!(output.status.success());
        assert_eq!((output.stdout.len(), output.stderr.len()), (300_000, 100_000));
        let slow = bounded_output_within(Command::new("/bin/sleep").arg("5"), Duration::from_millis(200));
        assert_eq!(slow.unwrap_err().kind(), io::ErrorKind::TimedOut);
    }

    #[test]
    fn failed_starts_are_retried_later_and_later() {
        let start = Instant::now();
        let mut retry = Retry::new();
        assert!(retry.due(start));
        retry.failed(start);
        assert!(!retry.due(start + Duration::from_secs(9)));
        assert!(retry.due(start + FIRST_RETRY));
        for _ in 0..10 {
            retry.failed(start);
        }
        assert_eq!(retry.delay, LAST_RETRY);
        assert!(retry.due(start + LAST_RETRY));
    }

    #[test]
    #[ignore = "Requires a macOS login session to register an isolated launchd job"]
    fn launchd_reloads_idle_service_without_interrupting_sessions() {
        const CHILD_DIRECTORY: &str = "PZZA_LAUNCHD_LIFECYCLE_TEST_DIRECTORY";
        const TEST_FILTER: &str =
            "local_tmux::tests::launchd_reloads_idle_service_without_interrupting_sessions";
        let child_directory = std::env::var_os(CHILD_DIRECTORY);
        let directory = child_directory
            .clone()
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                PathBuf::from(format!(
                    "/private/tmp/pzza-launchd-test-{}",
                    crate::agent::random_hex(8).unwrap()
                ))
            });
        assert_eq!(directory.parent(), Some(Path::new("/private/tmp")));
        let name = directory.file_name().unwrap().to_str().unwrap();
        assert!(name.starts_with("pzza-launchd-test-"));
        let label = format!("com.pzzacode.tmux.lifecycle.{name}");
        let socket = directory.join("server.sock");
        assert_ne!(label, LABEL);
        assert_ne!(socket, socket_path());
        private_directory(&directory).unwrap();
        if child_directory.is_some() {
            let mut command = Command::new("tmux");
            command.args(["-f", "/dev/null"]);
            assert_eq!(run_service_at(&socket, &label, command).unwrap(), 0);
            return;
        }

        let domain = format!("gui/{}", unsafe { libc::geteuid() });
        let target = format!("{domain}/{label}");
        struct Service {
            target: String,
            directory: PathBuf,
            socket: PathBuf,
        }
        impl Drop for Service {
            fn drop(&mut self) {
                let _ =
                    bounded_output(Command::new("/bin/launchctl").args(["bootout", &self.target]));
                let _ = bounded_output(
                    Command::new("tmux")
                        .args(["-N", "-S"])
                        .arg(&self.socket)
                        .arg("kill-server")
                        .env("PATH", crate::agent::login_path())
                        .env_remove("TMUX"),
                );
                let _ = fs::remove_dir_all(&self.directory);
            }
        }
        let _service = Service {
            target: target.clone(),
            directory: directory.clone(),
            socket: socket.clone(),
        };
        let plist = directory.join("service.plist");
        let executable = std::env::current_exe().unwrap();
        let contents = format!(
            "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<plist version=\"1.0\"><dict>\
            <key>Label</key><string>{}</string>\
            <key>ProgramArguments</key><array><string>{}</string><string>--exact</string><string>{TEST_FILTER}</string><string>--include-ignored</string><string>--nocapture</string></array>\
            <key>EnvironmentVariables</key><dict><key>{CHILD_DIRECTORY}</key><string>{}</string><key>PATH</key><string>{}</string></dict>\
            <key>KeepAlive</key><false/><key>RunAtLoad</key><false/>\
            <key>ThrottleInterval</key><integer>1</integer>\
            </dict></plist>\n",
            xml(&label), xml(executable.to_str().unwrap()), xml(directory.to_str().unwrap()), xml(crate::agent::login_path()),
        );
        let launchctl =
            |args: &[&str]| bounded_output(Command::new("/bin/launchctl").args(args)).unwrap();
        let tmux = |args: &[&str]| {
            bounded_output(
                Command::new("tmux")
                    .args(["-N", "-S"])
                    .arg(&socket)
                    .args(args)
                    .env("PATH", crate::agent::login_path())
                    .env_remove("TMUX"),
            )
            .unwrap()
        };
        let wait_for = |description: &str, condition: &dyn Fn() -> bool| {
            let deadline = Instant::now() + Duration::from_secs(5);
            while !condition() {
                assert!(Instant::now() < deadline, "{description}");
                std::thread::sleep(Duration::from_millis(20));
            }
        };
        let start = || {
            assert!(launchctl(&["bootstrap", &domain, plist.to_str().unwrap()])
                .status
                .success());
            let _ = launchctl(&["kickstart", &target]);
            wait_for("Isolated launchd helper did not start", &|| {
                UnixStream::connect(&socket).is_ok()
            });
        };
        let loaded_keepalive = || {
            let loaded = launchctl(&["print", &target]);
            assert!(
                loaded.status.success(),
                "Isolated launchd job is not loaded"
            );
            String::from_utf8_lossy(&loaded.stdout)
                .to_ascii_lowercase()
                .contains("keepalive")
        };
        let wait_unloaded = || {
            wait_for("Idle helper did not unregister its launchd job", &|| {
                !launchctl(&["print", &target]).status.success()
            })
        };

        let lease = app_lease(&directory).unwrap();
        write_service(
            &plist,
            &contents.replace(
                "<key>KeepAlive</key><false/>",
                "<key>KeepAlive</key><true/>",
            ),
        )
        .unwrap();
        start();
        assert!(loaded_keepalive());
        assert!(
            tmux(&["new-session", "-d", "-s", "survivor", "/bin/sleep 60"])
                .status
                .success()
        );
        write_service(&plist, &contents).unwrap();
        assert!(
            loaded_keepalive(),
            "Writing the plist must not replace the running job"
        );
        drop(lease);
        wait_for("Closed app did not release its terminal helper", &|| {
            tmux(&["show-option", "-sv", "exit-empty"])
                .stdout
                .starts_with(b"on")
        });
        assert!(tmux(&["has-session", "-t", "survivor"]).status.success());
        assert!(
            loaded_keepalive(),
            "A live session must retain the loaded job"
        );
        assert!(tmux(&["kill-session", "-t", "survivor"]).status.success());
        wait_unloaded();

        let lease = app_lease(&directory).unwrap();
        start();
        assert!(
            !loaded_keepalive(),
            "Fresh startup must use the current on-demand definition"
        );
        assert!(tmux(&["show-option", "-sv", "exit-empty"]).status.success());
        drop(lease);
        wait_unloaded();
        assert!(UnixStream::connect(&socket).is_err());
    }
}
