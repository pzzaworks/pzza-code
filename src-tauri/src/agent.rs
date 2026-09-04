// The device agent (server/index.js) runs as a managed local sidecar: the app
// launches it on 127.0.0.1:5190 at startup and kills it on exit. Every
// server-backed panel (sessions, ports, usage, accounts, forwarding, MCP, the
// setup wizard) and any external MCP client then talk to this one local backend.
use std::path::PathBuf;
use std::process::{Child, Command};
use std::sync::Mutex;
use tauri::{AppHandle, Manager};

pub const AGENT_PORT: &str = "5190";

#[derive(Default)]
pub struct AgentState(pub Mutex<Option<Child>>);

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

// Find a Node runtime. GUI apps launched from Finder do not inherit the login
// shell PATH, so check the common install locations first, then ask a login
// shell (which picks up nvm / fnm / asdf shims and Homebrew).
fn find_node() -> Option<String> {
    for c in ["/opt/homebrew/bin/node", "/usr/local/bin/node", "/usr/bin/node"] {
        if std::path::Path::new(c).exists() {
            return Some(c.to_string());
        }
    }
    let out = Command::new("/bin/sh")
        .arg("-lc")
        .arg("command -v node")
        .output()
        .ok()?;
    if out.status.success() {
        let p = String::from_utf8_lossy(&out.stdout).trim().to_string();
        if !p.is_empty() {
            return Some(p);
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
    let node = match find_node() {
        Some(n) => n,
        None => {
            eprintln!("pzza agent: no Node runtime found; server-backed panels disabled");
            return;
        }
    };
    let work_dir = script.parent().map(PathBuf::from);
    let mut cmd = Command::new(node);
    cmd.arg(&script)
        .env("PORT", AGENT_PORT)
        // Empty devbox host = source role: tmux/ports are local to this machine.
        .env("PZZA_DEVBOX_HOST", "");
    if let Some(dir) = work_dir {
        cmd.current_dir(dir);
    }
    match cmd.spawn() {
        Ok(child) => {
            if let Some(state) = app.try_state::<AgentState>() {
                *state.0.lock().unwrap() = Some(child);
            }
        }
        Err(e) => eprintln!("pzza agent: failed to launch: {e}"),
    }
}

pub fn stop(app: &AppHandle) {
    if let Some(state) = app.try_state::<AgentState>() {
        if let Some(mut child) = state.0.lock().unwrap().take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}
