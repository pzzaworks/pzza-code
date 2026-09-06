// The device agent (server/index.js) runs as a managed local sidecar: the app
// launches it on 127.0.0.1:5190 at startup and kills it on exit. Every
// server-backed panel (sessions, ports, usage, accounts, forwarding, MCP, the
// setup wizard) and any external MCP client then talk to this one local backend.
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Manager};

pub const AGENT_PORT: &str = "5190";

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
}

// Fail closed: if the OS RNG cannot be read we must not fall back to a
// predictable value, so the caller skips launching the agent instead.
pub(crate) fn random_hex(len: usize) -> Option<String> {
    use std::io::Read;
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

// The login shell's PATH. GUI apps launched from Finder inherit only a minimal
// PATH, so the agent (and every tool it runs: tmux, ssh, node) would miss
// Homebrew, nvm, etc. Ask the user's login shell for its real PATH, then union
// it with the common install locations so tmux from Homebrew always resolves.
// The login-shell PATH, computed once. A GUI app launched from Finder/Dock
// inherits only launchd's bare PATH, so anything installed by Homebrew (node,
// tmux, ...) is invisible until we rebuild the PATH the user's shell would use.
// Shared by the agent sidecar and local PTY spawns.
pub(crate) fn login_path() -> &'static str {
    static CACHED: OnceLock<String> = OnceLock::new();
    CACHED.get_or_init(agent_path)
}

fn agent_path() -> String {
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
    let shell = std::env::var("SHELL").unwrap_or_else(|_| "/bin/zsh".to_string());
    if let Ok(out) = Command::new(&shell).arg("-lc").arg("printf %s \"$PATH\"").output() {
        if out.status.success() {
            for p in String::from_utf8_lossy(&out.stdout).split(':') {
                push(p);
            }
        }
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
fn find_node(path: &str) -> Option<String> {
    let out = Command::new("/bin/sh")
        .arg("-lc")
        .arg("command -v node")
        .env("PATH", path)
        .output()
        .ok();
    if let Some(out) = out {
        if out.status.success() {
            let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
            if !p.is_empty() {
                return Some(p);
            }
        }
    }
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    None
}

pub fn start(app: &AppHandle) {
    let script = match find_agent_script(app) {
        Some(s) => s,
        None => {
            eprintln!("pzza agent: server/index.js not found; server-backed panels disabled");
            return;
        }
    };
    let path = login_path().to_string();
    let node = match find_node(&path) {
        Some(n) => n,
        None => {
            eprintln!("pzza agent: no Node runtime found; server-backed panels disabled");
            return;
        }
    };
    let (token, instance) = match (random_hex(24), random_hex(8)) {
        (Some(t), Some(i)) => (t, i),
        _ => {
            eprintln!("pzza agent: OS randomness unavailable; refusing to launch the agent");
            return;
        }
    };
    if let Some(state) = app.try_state::<AgentState>() {
        *state.token.lock().unwrap() = token.clone();
        *state.instance.lock().unwrap() = instance.clone();
    }
    match spawn_agent_process(&node, &script, &path, &token, &instance) {
        Ok(child) => {
            if let Some(state) = app.try_state::<AgentState>() {
                *state.child.lock().unwrap() = Some(child);
            }
        }
        Err(e) => eprintln!("pzza agent: failed to launch: {e}"),
    }

    // Watchdog: if the agent process dies (a crash, or something outside the app
    // killing it), bring it back with the SAME token and instance id so the
    // webview's cached credentials stay valid - instead of leaving the app stuck
    // on "Server unreachable" until the user restarts it.
    let app = app.clone();
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_secs(2));
        let Some(state) = app.try_state::<AgentState>() else {
            return;
        };
        if state.shutting_down.load(Ordering::SeqCst) {
            return;
        }
        let mut guard = state.child.lock().unwrap();
        let alive = matches!(guard.as_mut().map(|c| c.try_wait()), Some(Ok(None)));
        if !alive {
            match spawn_agent_process(&node, &script, &path, &token, &instance) {
                Ok(child) => {
                    *guard = Some(child);
                    eprintln!("pzza agent: respawned after it exited");
                }
                Err(e) => eprintln!("pzza agent: respawn failed: {e}"),
            }
        }
    });
}

// Spawn the agent node process. Kept separate so the initial launch and the
// watchdog respawn share exactly the same environment (PATH, token, instance).
fn spawn_agent_process(
    node: &str,
    script: &std::path::Path,
    path: &str,
    token: &str,
    instance: &str,
) -> std::io::Result<Child> {
    let mut cmd = Command::new(node);
    cmd.arg(script)
        .env("PORT", AGENT_PORT)
        // A full PATH so the agent's child processes (tmux, ssh) resolve even
        // when the app was launched from Finder with a minimal environment.
        .env("PATH", path)
        // The bearer token every request to the agent must carry, and the
        // instance id it echoes from /health so the webview can verify it.
        .env("PZZA_AGENT_TOKEN", token)
        .env("PZZA_AGENT_ID", instance)
        // Empty server host = source role: tmux/ports are local to this machine.
        .env("PZZA_SERVER_HOST", "");
    if let Some(dir) = script.parent() {
        cmd.current_dir(dir);
    }
    cmd.spawn()
}

pub fn stop(app: &AppHandle) {
    if let Some(state) = app.try_state::<AgentState>() {
        // Signal the watchdog before killing, so it does not respawn the agent
        // during shutdown.
        state.shutting_down.store(true, Ordering::SeqCst);
        if let Some(mut child) = state.child.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
