// Onboarding requirements for this Mac: what is installed, and one-step
// installs for what is missing. Every installable item and binary name is a
// fixed literal (agent CLIs come from the bundled catalog); the webview only
// picks one by id. Agent CLIs are only looked for, never installed.
use std::path::{Path, PathBuf};
#[cfg(target_os = "macos")]
use std::process::{Command, Stdio};

use tauri::{AppHandle, Manager};

#[derive(serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SetupTool {
    id: String,
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

fn is_executable_file(path: &Path) -> bool {
    use std::os::unix::fs::PermissionsExt;
    std::fs::metadata(path).is_ok_and(|metadata| metadata.is_file() && metadata.permissions().mode() & 0o111 != 0)
}

// Finds a fixed binary name in each folder of `path` in order, then in the
// per-user install folders: ~/.local/bin, ~/.<name>/bin and the given extra
// folders (relative to the home folder). The first executable `accept` takes
// wins, so a same-named tool earlier on PATH (Foundry's forge) does not hide
// an agent installed later on it.
fn find_binary(binary: &str, path: &str, home: Option<&str>, extra: &[String], accept: impl Fn(&Path) -> bool) -> Option<String> {
    let on_path = std::env::split_paths(path).filter(|folder| folder.is_absolute()).map(|folder| folder.join(binary));
    let installed = home.into_iter().flat_map(|home| {
        [format!("{home}/.local/bin/{binary}"), format!("{home}/.{binary}/bin/{binary}")]
            .into_iter()
            .chain(extra.iter().map(move |folder| format!("{home}/{folder}/{binary}")))
            .map(PathBuf::from)
    });
    on_path
        .chain(installed)
        .find(|candidate| is_executable_file(candidate) && accept(candidate))
        .map(|found| found.to_string_lossy().into_owned())
}

pub(crate) fn resolve(binary: &str) -> Option<String> {
    let home = std::env::var("HOME").ok();
    find_binary(binary, crate::agent::login_path(), home.as_deref(), &[], |_| true)
}

// Each catalog agent with the first of its binaries that is installed and is
// not a same-named tool its catalog entry rules out.
fn agent_tools() -> Vec<SetupTool> {
    let path = crate::agent::login_path();
    let home = std::env::var("HOME").ok();
    crate::agent_catalog::catalog()
        .agents
        .iter()
        .map(|agent| SetupTool {
            id: agent.id.clone(),
            path: agent
                .binaries
                .iter()
                .find_map(|binary| find_binary(binary, path, home.as_deref(), &agent.install_dirs, |found| agent.allows_binary(found))),
        })
        .collect()
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
            agents: agent_tools(),
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

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{symlink, PermissionsExt};

    fn executable(path: &Path) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, "#!/bin/sh\n").unwrap();
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o755)).unwrap();
    }

    #[test]
    fn agent_binaries_skip_same_named_tools_on_path() {
        let root = std::env::temp_dir().join(format!("pzza-setup-test-{}", crate::agent::random_hex(8).unwrap()));
        let home = root.join("home");
        let foundry = home.join(".foundry/bin");
        let brew = root.join("brew/bin");
        executable(&foundry.join("forge"));
        let forgecode = root.join("brew/lib/node_modules/forgecode/bin/forge");
        executable(&forgecode);
        std::fs::create_dir_all(&brew).unwrap();
        symlink(&forgecode, brew.join("forge")).unwrap();
        // A goose on PATH that resolves into Homebrew's migration-tool keg.
        let keg = root.join("brew/Cellar/goose/3.26.0/bin/goose");
        executable(&keg);
        symlink(&keg, brew.join("goose")).unwrap();
        // Not executable: never a match.
        std::fs::write(foundry.join("amp"), "").unwrap();

        let agent = |id: &str| crate::agent_catalog::catalog().agents.iter().find(|agent| agent.id == id).unwrap();
        let path = std::env::join_paths([&foundry, &brew]).unwrap();
        let path = path.to_str().unwrap();
        let home_dir = home.to_str();
        let find = |id: &str, binary: &str| {
            let agent = agent(id);
            find_binary(binary, path, home_dir, &agent.install_dirs, |found| agent.allows_binary(found))
        };
        // Foundry's forge comes first on PATH; ForgeCode later on PATH is found instead.
        assert_eq!(find("forgecode", "forge"), Some(brew.join("forge").to_string_lossy().into_owned()));
        assert_eq!(find("goose", "goose"), None, "the migration tool is not goose");
        assert_eq!(find("amp", "amp"), None);
        // Without catalog rules the first executable on PATH wins.
        assert_eq!(find_binary("forge", path, home_dir, &[], |_| true), Some(foundry.join("forge").to_string_lossy().into_owned()));
        // The per-user install folders are tried after PATH.
        let local = home.join(".local/bin/goose");
        executable(&local);
        assert_eq!(find("goose", "goose"), Some(local.to_string_lossy().into_owned()));
        std::fs::remove_dir_all(&root).unwrap();
    }
}
