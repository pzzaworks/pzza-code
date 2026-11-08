// Onboarding requirements for this Mac: what is installed, and one-step
// installs for what is missing. Every installable item and binary name is a
// fixed literal; the webview only picks one by id.
use std::process::{Command, Stdio};

use tauri::{AppHandle, Manager};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupTool {
    id: &'static str,
    path: Option<String>,
}

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupStatus {
    homebrew: Option<String>,
    node: Option<String>,
    tmux: Option<String>,
    agent_running: bool,
    // Optional coding agent CLIs, reported so onboarding can show what is ready.
    agents: Vec<SetupTool>,
}

const AGENT_CLIS: [&str; 3] = ["claude", "codex", "opencode"];

// Resolves a fixed binary name against the login PATH, plus the per-user
// install locations agent CLIs use.
pub(crate) fn resolve(binary: &'static str) -> Option<String> {
    let output = Command::new("/bin/sh")
        .args(["-c", "command -v \"$1\"", "resolve", binary])
        .env("PATH", crate::agent::login_path())
        .stdin(Stdio::null())
        .output()
        .ok()?;
    let found = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if output.status.success() && found.starts_with('/') {
        return Some(found);
    }
    let home = std::env::var("HOME").ok()?;
    [format!("{home}/.local/bin/{binary}"), format!("{home}/.{binary}/bin/{binary}")]
        .into_iter()
        .find(|candidate| std::path::Path::new(candidate).is_file())
}

fn agent_running(app: &AppHandle) -> bool {
    app.try_state::<crate::agent::AgentState>()
        .is_some_and(|state| state.child.lock().map(|child| child.is_some()).unwrap_or(false))
}

#[tauri::command]
pub async fn setup_status(app: AppHandle) -> Result<SetupStatus, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let path = crate::agent::login_path();
        SetupStatus {
            homebrew: homebrew_path(),
            node: crate::agent::find_node(path),
            tmux: resolve("tmux"),
            agent_running: agent_running(&app),
            agents: AGENT_CLIS.into_iter().map(|id| SetupTool { id, path: resolve(id) }).collect(),
        }
    })
    .await
    .map_err(|error| error.to_string())
}

// The official Homebrew installer, run in Terminal because it asks for the
// administrator password and confirmation there. Fixed text, never user input.
#[cfg(target_os = "macos")]
const HOMEBREW_INSTALL: &str = "#!/bin/bash\n\
echo 'Installing Homebrew for PzzaCode. Enter your Mac password when asked.'\n\
/bin/bash -c \"$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)\"\n\
echo\n\
echo 'Done. Return to PzzaCode; it continues the setup on its own.'\n";

// Opening a .command file runs it in Terminal without asking for permission to
// control Terminal. The file lives in a private directory only this user can read.
#[cfg(target_os = "macos")]
fn open_homebrew_installer() -> Result<(), String> {
    use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt};
    let failed = |_| "Could not prepare the Homebrew installer".to_string();
    let directory = std::env::temp_dir().join(format!("pzzacode-setup-{}", unsafe { libc::geteuid() }));
    match std::fs::DirBuilder::new().mode(0o700).create(&directory) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
        Err(error) => return Err(failed(error)),
    }
    let script = directory.join("install-homebrew.command");
    let _ = std::fs::remove_file(&script);
    let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o700).open(&script).map_err(failed)?;
    std::io::Write::write_all(&mut file, HOMEBREW_INSTALL.as_bytes()).map_err(failed)?;
    drop(file);
    let status = Command::new("/usr/bin/open")
        .args(["-a", "Terminal"])
        .arg(&script)
        .stdin(Stdio::null())
        .status()
        .map_err(|_| "Terminal could not be opened".to_string())?;
    if status.success() { Ok(()) } else { Err("Terminal could not be opened for the Homebrew installer".into()) }
}

// Homebrew runs one install at a time and fails a second one that races for
// its lock, so installs started from here queue behind each other instead.
#[cfg(target_os = "macos")]
static INSTALL_LOCK: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(target_os = "macos")]
#[tauri::command]
pub async fn setup_install(app: AppHandle, item: String) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || {
        // Opening the Homebrew installer never waits on a running install.
        if item == "homebrew" {
            return open_homebrew_installer();
        }
        let _queued = INSTALL_LOCK.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
        install_item(&app, &item)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(target_os = "macos")]
fn install_item(app: &AppHandle, item: &str) -> Result<(), String> {
    match item {
        "node" => {
            if crate::agent::find_node(crate::agent::login_path()).is_none() {
                crate::local_tmux::brew_install("node")?;
            }
            // The agent could not start without Node; start it now that Node exists.
            if !agent_running(app) {
                crate::agent::start(app);
            }
            Ok(())
        }
        "tmux" => crate::local_tmux::install(),
        _ => Err("Unknown setup item".into()),
    }
}

#[cfg(not(target_os = "macos"))]
#[tauri::command]
pub async fn setup_install(_item: String) -> Result<(), String> {
    Err("Automatic setup is only available on macOS. Install Node.js and tmux with your package manager.".into())
}

#[cfg(target_os = "macos")]
fn homebrew_path() -> Option<String> {
    crate::local_tmux::homebrew().map(str::to_owned)
}

#[cfg(not(target_os = "macos"))]
fn homebrew_path() -> Option<String> {
    None
}
