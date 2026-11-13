// The device agent (server/index.js) runs as a managed local sidecar: the app
// launches it on 127.0.0.1:5190 at startup and kills it on exit. Every
// server-backed panel (sessions, ports, usage, accounts, forwarding, MCP, the
// setup wizard) and any external MCP client then talk to this one local backend.
use std::path::PathBuf;
use std::process::{Child, Command, ExitStatus, Stdio};
use std::io::Read;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Manager};

pub const AGENT_PORT: &str = "5190";

// tmux decides whether a client speaks UTF-8 from the first set one of
// LC_ALL / LC_CTYPE / LANG, and zsh's line editor reads the same variables. A
// Finder/Dock launch carries none of them, so tmux would print `_` for every
// non-ASCII glyph (Turkish letters, box drawing) in a local session. Hand
// children a UTF-8 locale when the environment has none; an explicit locale,
// UTF-8 or not, is the user's choice and left alone.
pub fn utf8_locale_env() -> Option<(&'static str, &'static str)> {
    let has_locale = ["LC_ALL", "LC_CTYPE", "LANG"]
        .iter()
        .any(|k| std::env::var(k).map(|v| !v.is_empty()).unwrap_or(false));
    if has_locale {
        None
    } else {
        Some(("LANG", "en_US.UTF-8"))
    }
}

#[derive(Default)]
pub struct AgentState {
    pub child: Mutex<Option<Child>>,
    // Per-launch bearer token the agent requires on every request; generated
    // here, handed to the agent via its environment, and to the webview via
    // the agent_token command - it never touches disk on the app side.
    pub token: Mutex<String>,
    // Non-secret per-launch instance id the agent echoes from /health, so the
    // webview can refuse to talk to some other process that grabbed the port.
    pub instance: Mutex<String>,
    // Set on app shutdown so the watchdog stops respawning the agent.
    pub shutting_down: AtomicBool,
    // What the watchdog respawns, once a launch has found Node and the script.
    launch: Mutex<Option<Arc<Launch>>>,
    // Whether a watchdog thread runs; at most one does.
    watchdog: AtomicBool,
    // The agent exited after an update replaced the app on disk, and stays
    // down until the app restarts into the new version.
    restart_required: AtomicBool,
}

// Sent once to the webview when the agent stopped for good until a restart
// (see AgentState::restart_required); agent_restart_required reads it later.
pub const RESTART_REQUIRED_EVENT: &str = "agent-restart-required";

impl AgentState {
    // Notes that the agent stays down until a restart. True only the first
    // time, so the webview is told once.
    fn require_restart(&self) -> bool {
        !self.restart_required.swap(true, Ordering::SeqCst)
    }

    // Claims the single watchdog slot.
    fn claim_watchdog(&self) -> bool {
        !self.watchdog.swap(true, Ordering::SeqCst)
    }

    // Called by the watchdog when it sees shutdown. Returns whether it must
    // exit: a resume that raced this check may have found the slot still
    // taken and started nothing, so the slot is released and then re-claimed
    // when shutdown was called off meanwhile.
    fn release_watchdog(&self) -> bool {
        self.watchdog.store(false, Ordering::SeqCst);
        self.shutting_down.load(Ordering::SeqCst) || !self.claim_watchdog()
    }
}

// The command line the agent runs with. Respawns reuse it, so the agent keeps
// its PATH, token and instance id across crashes.
struct Launch {
    node: String,
    script: PathBuf,
    path: String,
    token: String,
    instance: String,
    origin: Option<FileIdentity>,
}

impl Launch {
    // The script folder is the app bundle's Resources/server. An update
    // installed in the background renames the running bundle away and moves
    // the new one into its place, so the same path then holds another
    // folder. Respawning from it would run the new version's agent against
    // this still-running older app; the agent stays down until the app
    // restarts into the new version instead.
    fn replaced(&self) -> bool {
        match (&self.origin, self.script.parent().and_then(file_identity)) {
            (Some(origin), Some(current)) => *origin != current,
            (Some(_), None) => true,
            (None, _) => false,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
struct FileIdentity {
    device: u64,
    inode: u64,
}

#[cfg(unix)]
fn file_identity(path: &std::path::Path) -> Option<FileIdentity> {
    use std::os::unix::fs::MetadataExt;
    let metadata = std::fs::metadata(path).ok()?;
    Some(FileIdentity { device: metadata.dev(), inode: metadata.ino() })
}

#[cfg(not(unix))]
fn file_identity(_path: &std::path::Path) -> Option<FileIdentity> {
    None
}

// Fail closed: if the OS RNG cannot be read we must not fall back to a
// predictable value, so the caller skips launching the agent instead.
pub(crate) fn random_hex(len: usize) -> Option<String> {
    let mut bytes = vec![0u8; len];
    let mut f = std::fs::File::open("/dev/urandom").ok()?;
    f.read_exact(&mut bytes).ok()?;
    Some(bytes.iter().map(|b| format!("{b:02x}")).collect())
}

#[tauri::command]
pub fn agent_token(state: tauri::State<AgentState>) -> String {
    state.token.lock().unwrap().clone()
}

#[tauri::command]
pub fn agent_instance(state: tauri::State<AgentState>) -> String {
    state.instance.lock().unwrap().clone()
}

/// Whether the agent stopped after an update was installed and comes back
/// only once the app restarts (the same news as RESTART_REQUIRED_EVENT, for a
/// webview that was not listening yet).
#[tauri::command]
pub fn agent_restart_required(state: tauri::State<AgentState>) -> bool {
    state.restart_required.load(Ordering::SeqCst)
}

// Locate the agent's server/index.js. In a bundled app it lives under the
// resource dir; during `tauri dev` there is no bundle, so fall back to walking
// up from the executable to the project root where the source tree sits.
fn find_agent_script(app: &AppHandle) -> Option<PathBuf> {
    if let Ok(res) = app.path().resource_dir() {
        let p = res.join("server").join("index.js");
        if p.exists() {
            return Some(p);
        }
    }
    let exe = std::env::current_exe().ok()?;
    for ancestor in exe.ancestors() {
        let p = ancestor.join("server").join("index.js");
        if p.exists() {
            return Some(p);
        }
    }
    None
}

const LOGIN_SHELL_TIMEOUT: Duration = Duration::from_secs(5);
const NODE_LOOKUP_TIMEOUT: Duration = Duration::from_secs(3);
// A PATH or a binary path is short; a startup file printing more is not read.
const PROBE_OUTPUT_LIMIT: usize = 64 * 1024;

// Runs a short probe of the user's shell and returns its stdout when it exits
// successfully within `timeout`. Stdin is closed, so a prompt fails instead of
// waiting. The probe gets its own process group: on timeout the whole group is
// killed, including anything the startup files ran in the foreground. A
// background job left holding stdout open never delays the result.
fn bounded_stdout(command: &mut Command, timeout: Duration) -> Option<String> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    let mut child = command.spawn().ok()?;
    let deadline = Instant::now() + timeout;
    let output = Arc::new(Mutex::new(Vec::new()));
    let (closed, eof) = mpsc::channel();
    if let Some(mut stdout) = child.stdout.take() {
        let output = output.clone();
        std::thread::spawn(move || {
            let mut chunk = [0u8; 4096];
            while let Ok(read) = stdout.read(&mut chunk) {
                if read == 0 {
                    break;
                }
                let Ok(mut output) = output.lock() else { break };
                if output.len() + read > PROBE_OUTPUT_LIMIT {
                    break;
                }
                output.extend_from_slice(&chunk[..read]);
            }
            let _ = closed.send(());
        });
    }
    let status = wait_child_timeout(&mut child, deadline.saturating_duration_since(Instant::now())).ok().flatten();
    let Some(status) = status else {
        #[cfg(unix)]
        // Still our unreaped child, so its process group id cannot be reused.
        unsafe {
            libc::kill(-(child.id() as libc::pid_t), libc::SIGKILL);
        }
        let _ = child.kill();
        let _ = child.wait();
        return None;
    };
    // What the probe printed before exiting is already in the pipe.
    let _ = eof.recv_timeout(Duration::from_millis(250));
    if !status.success() {
        return None;
    }
    let bytes = output.lock().ok()?.clone();
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

/// Waits up to `timeout` for `child` to exit and reaps it. None: it still
/// runs at the deadline, and stays unreaped, so its pid (and process group)
/// remain safe to signal. The wait blocks in waitid on a helper thread, so a
/// running command never wakes the caller on a timer.
pub(crate) fn wait_child_timeout(child: &mut Child, timeout: Duration) -> std::io::Result<Option<ExitStatus>> {
    if let Some(status) = child.try_wait()? {
        return Ok(Some(status));
    }
    let deadline = Instant::now() + timeout;
    #[cfg(unix)]
    {
        let (exited, report) = mpsc::channel();
        let pid = child.id();
        std::thread::Builder::new().name("pzza-child-exit".into()).spawn(move || {
            wait_exit(pid);
            let _ = exited.send(());
        })?;
        match report.recv_timeout(timeout) {
            Ok(()) | Err(mpsc::RecvTimeoutError::Disconnected) => {}
            Err(mpsc::RecvTimeoutError::Timeout) => return Ok(None),
        }
    }
    // The child is waitable now. Only when waitid failed (or off Unix) does
    // this poll out what is left of the timeout.
    loop {
        if let Some(status) = child.try_wait()? {
            return Ok(Some(status));
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

/// Blocks until our child `pid` has exited, without reaping it (WNOWAIT):
/// only the owner of its Child reaps, so the pid cannot be reused while that
/// owner may still signal it. Returns at once when there is nothing left to
/// wait for (already reaped, or not our child).
#[cfg(unix)]
pub(crate) fn wait_exit(pid: u32) {
    loop {
        // SAFETY: siginfo_t is plain data and waitid only writes into it.
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        if unsafe { libc::waitid(libc::P_PID, pid as libc::id_t, &mut info, libc::WEXITED | libc::WNOWAIT) } == 0 {
            return;
        }
        if std::io::Error::last_os_error().raw_os_error() != Some(libc::EINTR) {
            return;
        }
    }
}

// After a login-shell probe timed out, it is tried again in the background
// after these delays; until one succeeds every caller gets the fallback PATH.
const LOGIN_PATH_RETRIES: [Duration; 5] = [
    Duration::from_secs(30),
    Duration::from_secs(60),
    Duration::from_secs(120),
    Duration::from_secs(300),
    Duration::from_secs(600),
];

/// The login-shell PATH: probed once, and kept only when the probe answered.
/// A probe that times out (a slow profile on a cold boot, say) is not kept:
/// callers get the common install locations plus the inherited PATH for the
/// time being, while the probe is retried in the background.
struct LoginPath {
    probed: OnceLock<String>,
    fallback: OnceLock<String>,
    // Whether the first probe ran (later ones run in the background).
    tried: Mutex<bool>,
}

impl LoginPath {
    const fn new() -> Self {
        LoginPath { probed: OnceLock::new(), fallback: OnceLock::new(), tried: Mutex::new(false) }
    }

    /// The probed PATH, or else the fallback. The first caller probes (and
    /// the callers arriving meanwhile wait for it); after a failed probe,
    /// `retry` is started once to keep trying.
    fn get(&self, probe: impl FnOnce() -> Option<String>, retry: impl FnOnce()) -> &str {
        if let Some(path) = self.probed.get() {
            return path;
        }
        {
            let mut tried = self.tried.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            if !*tried {
                *tried = true;
                match probe() {
                    Some(login) => {
                        return self.probed.get_or_init(|| compose_path(Some(&login)));
                    }
                    None => retry(),
                }
            }
        }
        self.probed.get().map_or_else(|| self.fallback.get_or_init(|| compose_path(None)).as_str(), String::as_str)
    }

    /// Keeps a PATH a later probe reported.
    fn keep(&self, login: &str) {
        let _ = self.probed.set(compose_path(Some(login)));
    }

    fn probed(&self) -> Option<&str> {
        self.probed.get().map(String::as_str)
    }
}

static LOGIN_PATH: LoginPath = LoginPath::new();

// The login shell's PATH. A GUI app launched from Finder/Dock inherits only
// launchd's bare PATH, so anything installed by Homebrew, nvm, asdf and the
// like (node, tmux, ...) is invisible until we rebuild the PATH the user's
// shell would use: its own PATH, unioned with the common install locations
// so tmux from Homebrew always resolves. Shared by the agent sidecar, local
// PTY spawns and the terminal service. See LoginPath for a slow shell.
pub(crate) fn login_path() -> &'static str {
    LOGIN_PATH.get(probe_login_path, retry_login_path)
}

/// The login-shell PATH only when the shell reported it (never the fallback),
/// for what outlives this process, such as the terminal service definition.
pub(crate) fn probed_login_path() -> Option<&'static str> {
    login_path();
    LOGIN_PATH.probed()
}

// Startup files can wait on a network call or a password prompt; past the
// limit the probe gives up.
fn probe_login_path() -> Option<String> {
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    let login = bounded_stdout(Command::new(&shell).arg("-lc").arg("printf %s \"$PATH\""), LOGIN_SHELL_TIMEOUT);
    if login.is_none() {
        eprintln!(
            "PzzaCode: the login shell did not report its PATH within {}s; using the common install locations for now",
            LOGIN_SHELL_TIMEOUT.as_secs()
        );
    }
    login
}

fn retry_login_path() {
    let spawned = std::thread::Builder::new().name("login-path-retry".into()).spawn(|| {
        for delay in LOGIN_PATH_RETRIES {
            std::thread::sleep(delay);
            if let Some(login) = probe_login_path() {
                LOGIN_PATH.keep(&login);
                return;
            }
        }
    });
    if let Err(error) = spawned {
        eprintln!("PzzaCode: could not retry reading the login shell PATH: {error}");
    }
}

// The common install locations, then the login shell's PATH when known,
// then the inherited one.
fn compose_path(login: Option<&str>) -> String {
    let mut dirs: Vec<String> = Vec::new();
    let mut push = |p: &str| {
        let p = p.trim();
        if !p.is_empty() && !dirs.iter().any(|d| d == p) {
            dirs.push(p.to_string());
        }
    };
    for base in [
        "/opt/homebrew/bin",
        "/opt/homebrew/sbin",
        "/usr/local/bin",
        "/usr/bin",
        "/bin",
        "/usr/sbin",
        "/sbin",
    ] {
        push(base);
    }
    for p in login.unwrap_or_default().split(':') {
        push(p);
    }
    if let Ok(existing) = std::env::var("PATH") {
        for p in existing.split(':') {
            push(p);
        }
    }
    dirs.join(":")
}

// Find a Node runtime, preferring whatever the login PATH resolves (nvm / fnm /
// asdf shims and Homebrew), falling back to the common install locations.
pub(crate) fn find_node(path: &str) -> Option<String> {
    let found = bounded_stdout(
        Command::new("/bin/sh")
            .arg("-lc")
            .arg("command -v node")
            .env("PATH", path),
        NODE_LOOKUP_TIMEOUT,
    );
    if let Some(found) = found {
        let p = found.trim().to_string();
        if !p.is_empty() {
            return Some(p);
        }
    }
    for c in [
        "/opt/homebrew/bin/node",
        "/usr/local/bin/node",
        "/usr/bin/node",
    ] {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

// Starts the agent without holding the caller. The credentials are ready at
// once, so the webview can ask for them while the slow part (the login shell,
// the Node lookup) runs off the main thread. Starting again (after Node was
// installed) keeps the credentials the webview already has.
pub fn start(app: &AppHandle) {
    let Some(state) = app.try_state::<AgentState>() else {
        return;
    };
    let credentials = {
        let mut token = state.token.lock().unwrap();
        let mut instance = state.instance.lock().unwrap();
        if token.is_empty() || instance.is_empty() {
            match (random_hex(24), random_hex(8)) {
                (Some(t), Some(i)) => {
                    *token = t;
                    *instance = i;
                }
                _ => {
                    eprintln!("pzza agent: OS randomness unavailable; refusing to launch the agent");
                    return;
                }
            }
        }
        (token.clone(), instance.clone())
    };
    let app = app.clone();
    let spawned = std::thread::Builder::new()
        .name("device-agent-launch".into())
        .spawn(move || launch(&app, credentials));
    if let Err(error) = spawned {
        eprintln!("pzza agent: could not start launching the agent: {error}");
    }
}

fn launch(app: &AppHandle, (token, instance): (String, String)) {
    let Some(script) = find_agent_script(app) else {
        eprintln!("pzza agent: server/index.js not found; server-backed panels disabled");
        return;
    };
    let path = login_path().to_string();
    let Some(node) = find_node(&path) else {
        eprintln!("pzza agent: no Node runtime found; server-backed panels disabled");
        return;
    };
    let origin = script.parent().and_then(file_identity);
    let launch = Arc::new(Launch { node, script, path, token, instance, origin });
    let state = app.state::<AgentState>();
    *state.launch.lock().unwrap() = Some(launch.clone());
    {
        let mut child = state.child.lock().unwrap();
        // Shutdown may have begun while Node was looked up; stop() takes the
        // child under this lock, so nothing spawned here outlives it.
        if state.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let alive = matches!(child.as_mut().map(Child::try_wait), Some(Ok(None)));
        if !alive {
            match spawn_agent_process(&launch) {
                Ok(spawned) => *child = Some(spawned),
                Err(e) => eprintln!("pzza agent: failed to launch: {e}"),
            }
        }
    }
    start_watchdog(app);
}

// Watchdog: if the agent process dies (a crash, or something outside the app
// killing it), bring it back with the SAME token and instance id so the
// webview's cached credentials stay valid - instead of leaving the app stuck
// on "Server unreachable" until the user restarts it.
fn start_watchdog(app: &AppHandle) {
    let state = app.state::<AgentState>();
    if !state.claim_watchdog() {
        return;
    }
    let watcher = app.clone();
    let spawned = std::thread::Builder::new()
        .name("device-agent-watchdog".into())
        .spawn(move || watch(watcher));
    if let Err(error) = spawned {
        state.watchdog.store(false, Ordering::SeqCst);
        eprintln!("pzza agent: could not start the watchdog: {error}");
    }
}

// The watchdog respawns at most this often, so an agent that exits at once
// is never restarted in a tight loop. Without a running agent to wait on (no
// launch yet, a failed respawn, an update pending a restart) it checks again
// this often.
const RESPAWN_INTERVAL: Duration = Duration::from_secs(2);

// The pid of the agent while it runs (unreaped), for the watchdog to block on.
fn running_agent(state: &AgentState) -> Option<u32> {
    let mut guard = state.child.lock().unwrap();
    let child = guard.as_mut()?;
    matches!(child.try_wait(), Ok(None)).then(|| child.id())
}

fn watch(app: AppHandle) {
    use tauri::Emitter;
    // launch() spawned the agent right before starting the watchdog.
    let mut spawned = Instant::now();
    loop {
        let Some(state) = app.try_state::<AgentState>() else {
            return;
        };
        // Blocks until the agent exits (stop() ending it included), so a
        // running agent never wakes the watchdog.
        match running_agent(&state) {
            #[cfg(unix)]
            Some(pid) => wait_exit(pid),
            _ => std::thread::sleep(RESPAWN_INTERVAL),
        }
        let since = spawned.elapsed();
        if since < RESPAWN_INTERVAL && !state.shutting_down.load(Ordering::SeqCst) {
            std::thread::sleep(RESPAWN_INTERVAL - since);
        }
        if state.shutting_down.load(Ordering::SeqCst) {
            if state.release_watchdog() {
                return;
            }
            continue;
        }
        let Some(launch) = state.launch.lock().unwrap().clone() else {
            continue;
        };
        let mut guard = state.child.lock().unwrap();
        // Shutdown may have started while this thread waited for the child
        // lock; the next round sees it and lets the watchdog go.
        if state.shutting_down.load(Ordering::SeqCst) {
            continue;
        }
        if matches!(guard.as_mut().map(Child::try_wait), Some(Ok(None))) {
            continue;
        }
        if launch.replaced() {
            // The webview shows that a restart is needed, instead of panels
            // that stay unreachable with no reason given.
            if state.require_restart() {
                eprintln!("pzza agent: exited after PzzaCode was updated on disk; restart PzzaCode to start the new version");
                if let Err(error) = app.emit(RESTART_REQUIRED_EVENT, true) {
                    eprintln!("pzza agent: could not report that a restart is needed: {error}");
                }
            }
            continue;
        }
        spawned = Instant::now();
        match spawn_agent_process(&launch) {
            Ok(child) => {
                *guard = Some(child);
                eprintln!("pzza agent: respawned after it exited");
            }
            Err(e) => eprintln!("pzza agent: respawn failed: {e}"),
        }
    }
}

// Spawn the agent node process. Kept separate so the initial launch and the
// watchdog respawn share exactly the same environment (PATH, token, instance).
fn spawn_agent_process(launch: &Launch) -> std::io::Result<Child> {
    let mut cmd = Command::new(&launch.node);
    #[cfg(target_os = "macos")]
    cmd.env("PZZA_TMUX_SOCKET", crate::local_tmux::socket_path())
        .env_remove("TMUX");
    cmd.arg(&launch.script)
        .env("PORT", AGENT_PORT)
        // A full PATH so the agent's child processes (tmux, ssh) resolve even
        // when the app was launched from Finder with a minimal environment.
        .env("PATH", &launch.path)
        // The bearer token every request to the agent must carry, and the
        // instance id it echoes from /health so the webview can verify it.
        .env("PZZA_AGENT_TOKEN", &launch.token)
        .env("PZZA_AGENT_ID", &launch.instance)
        // Empty server host = source role: tmux/ports are local to this machine.
        .env("PZZA_SERVER_HOST", "")
        // Keep the write end in Child. Process exit closes it even when Rust
        // cleanup cannot run, so the agent also exits after a force-quit.
        .env("PZZA_MANAGED_AGENT", "1")
        .stdin(Stdio::piped());
    // So the tmux servers and shells the agent starts render UTF-8.
    if let Some((k, v)) = utf8_locale_env() {
        cmd.env(k, v);
    }
    if let Some(dir) = launch.script.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn()
}

pub fn stop(app: &AppHandle) -> Result<(), String> {
    if let Some(state) = app.try_state::<AgentState>() {
        // Signal the watchdog before killing, so it does not respawn the agent
        // during shutdown.
        state.shutting_down.store(true, Ordering::SeqCst);
        let child = state.child.lock().map_err(|_| "Device agent lock failed")?.take();
        if let Some(mut child) = child {
            drop(child.stdin.take());
            if let Err(error) = terminate_agent(&mut child, Duration::from_secs(5)) {
                *state.child.lock().map_err(|_| "Device agent lock failed")? = Some(child);
                return Err(format!("Could not reap the device agent: {error}"));
            }
        }
    }
    Ok(())
}

// Calls off a stop() whose shutdown did not finish: the app keeps running, so
// the watchdog keeps the agent up again. An agent whose input stop() already
// closed exits on its own and is respawned.
pub fn resume(app: &AppHandle) {
    let Some(state) = app.try_state::<AgentState>() else {
        return;
    };
    state.shutting_down.store(false, Ordering::SeqCst);
    let launched = state.launch.lock().map(|launch| launch.is_some()).unwrap_or(false);
    if launched {
        start_watchdog(app);
    }
}

fn terminate_agent(child: &mut Child, grace: Duration) -> std::io::Result<ExitStatus> {
    if let Some(status) = child.try_wait()? {
        return Ok(status);
    }
    #[cfg(unix)]
    {
        // This is our still-unreaped child, so its PID cannot be reused by another process.
        unsafe {
            libc::kill(child.id() as libc::pid_t, libc::SIGTERM);
        }
        if let Some(status) = wait_child_timeout(child, grace)? {
            return Ok(status);
        }
    }
    #[cfg(not(unix))]
    let _ = grace;
    child.kill()?;
    child.wait()
}

#[cfg(all(test, unix))]
mod shutdown_tests {
    use super::*;
    use std::io::{BufRead, BufReader};
    use std::process::Stdio;

    fn ready_child(script: &str) -> Child {
        let mut child = Command::new("/bin/sh")
            .args(["-c", script])
            .stdout(Stdio::piped())
            .spawn()
            .unwrap();
        let mut ready = String::new();
        BufReader::new(child.stdout.take().unwrap())
            .read_line(&mut ready)
            .unwrap();
        assert_eq!(ready.trim(), "ready");
        child
    }

    #[test]
    fn agent_shutdown_allows_cleanup_before_reaping() {
        let mut child = ready_child("trap 'exit 7' TERM; printf 'ready\n'; while :; do :; done");
        let status = terminate_agent(&mut child, Duration::from_secs(1)).unwrap();
        assert_eq!(status.code(), Some(7));
        assert_eq!(child.try_wait().unwrap().unwrap().code(), Some(7));
    }

    #[test]
    fn agent_shutdown_forces_exit_after_the_grace_period() {
        let mut child = ready_child("trap '' TERM; printf 'ready\n'; exec sleep 30");
        let start = Instant::now();
        let status = terminate_agent(&mut child, Duration::from_millis(50)).unwrap();
        assert!(!status.success());
        assert!(start.elapsed() < Duration::from_secs(2));
        assert!(child.try_wait().unwrap().is_some());
    }
}

#[cfg(all(test, unix))]
mod launch_tests {
    use super::*;

    #[test]
    fn shell_probe_returns_what_it_printed() {
        let output = bounded_stdout(Command::new("/bin/sh").args(["-c", "printf %s /a:/b"]), Duration::from_secs(5));
        assert_eq!(output.as_deref(), Some("/a:/b"));
    }

    #[test]
    fn shell_probe_that_fails_reports_nothing() {
        let output = bounded_stdout(Command::new("/bin/sh").args(["-c", "printf %s /a; exit 3"]), Duration::from_secs(5));
        assert_eq!(output, None);
    }

    #[test]
    fn shell_probe_that_hangs_is_killed_at_the_limit() {
        let start = Instant::now();
        let output = bounded_stdout(Command::new("/bin/sh").args(["-c", "sleep 30; printf late"]), Duration::from_millis(200));
        assert_eq!(output, None);
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn shell_probe_ignores_a_background_job_holding_its_output() {
        let start = Instant::now();
        let output = bounded_stdout(Command::new("/bin/sh").args(["-c", "(sleep 5) & printf %s ok"]), Duration::from_secs(5));
        assert_eq!(output.as_deref(), Some("ok"));
        assert!(start.elapsed() < Duration::from_secs(2));
    }

    #[test]
    fn one_watchdog_survives_a_resume_racing_its_exit() {
        let state = AgentState::default();
        assert!(state.claim_watchdog());
        assert!(!state.claim_watchdog());
        // Shutdown: the watchdog lets its slot go.
        state.shutting_down.store(true, Ordering::SeqCst);
        assert!(state.release_watchdog());
        // A resume after that exit starts a new watchdog.
        state.shutting_down.store(false, Ordering::SeqCst);
        assert!(state.claim_watchdog());
        // A resume that found the slot still taken started nothing, so the
        // exiting watchdog keeps running instead.
        assert!(!state.release_watchdog());
        assert!(!state.claim_watchdog());
    }

    #[test]
    fn a_login_path_probe_that_timed_out_is_retried_not_kept() {
        let cache = LoginPath::new();
        let retries = std::cell::Cell::new(0);
        let fallback = cache.get(|| None, || retries.set(retries.get() + 1)).to_string();
        assert_eq!(fallback, compose_path(None));
        assert_eq!(cache.probed(), None, "the fallback is never kept as the login PATH");
        // Later callers get the fallback at once; the retry runs elsewhere.
        let again = cache.get(|| panic!("callers never probe again themselves"), || panic!("the retry starts once")).to_string();
        assert_eq!(again, fallback);
        assert_eq!(retries.get(), 1);
        // Once a retry hears from the shell, everyone gets its PATH.
        cache.keep("/nix/profile/bin");
        assert!(cache.get(|| None, || {}).split(':').any(|dir| dir == "/nix/profile/bin"));
        assert!(cache.probed().is_some());
    }

    #[test]
    fn a_login_path_the_shell_reported_is_kept() {
        let cache = LoginPath::new();
        let path = cache.get(|| Some("/opt/local/bin:/usr/bin".into()), || panic!("nothing to retry")).to_string();
        assert!(path.split(':').any(|dir| dir == "/opt/local/bin"));
        assert!(path.starts_with("/opt/homebrew/bin:"), "the common locations come first");
        assert_eq!(cache.probed(), Some(path.as_str()));
        assert_eq!(cache.get(|| panic!("probed once"), || panic!("nothing to retry")), path);
    }

    #[test]
    fn an_agent_stopped_by_an_update_asks_for_a_restart_once() {
        let state = AgentState::default();
        assert!(!state.restart_required.load(Ordering::SeqCst));
        assert!(state.require_restart(), "the first notice is sent");
        assert!(!state.require_restart(), "and only once");
        assert!(state.restart_required.load(Ordering::SeqCst));
    }

    #[test]
    fn a_replaced_bundle_is_never_respawned_from() {
        let root = std::env::temp_dir().join(format!("pzza-agent-origin-{}", std::process::id()));
        let server = root.join("server");
        std::fs::create_dir_all(&server).unwrap();
        let launch = Launch {
            node: "node".into(),
            script: server.join("index.js"),
            path: String::new(),
            token: String::new(),
            instance: String::new(),
            origin: file_identity(&server),
        };
        assert!(!launch.replaced());
        // An update moves the running bundle away and the new one into place.
        std::fs::rename(&server, root.join("previous")).unwrap();
        assert!(launch.replaced());
        std::fs::create_dir(&server).unwrap();
        assert!(launch.replaced());
        std::fs::remove_dir_all(&root).unwrap();
    }
}
