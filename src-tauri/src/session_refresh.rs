// Refreshing local sessions. The local tmux server keeps the privacy grants
// it was started with, so a grant made later reaches existing terminals only
// after the server restarts. A refresh saves every local session (names,
// windows, panes, folders and recent output), restarts the server through
// local_tmux, and recreates the sessions under the same names so tiles attach
// to them again. Running programs are not re-run, except coding agents the
// app asks to resume; the restored output shows what each pane had.
//
// The same layout (without output) and the agents running in each window are
// also kept on disk while the app runs, so sessions lost when the server ends
// on its own (a crash, a logout, a killed service) are recreated the same way
// the next time the app sees the new server.
use std::collections::{HashMap, HashSet};
use std::fs::{self, DirBuilder, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::sync::Mutex;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};

const SESSIONS_FORMAT: &str = "#{session_id}\t#{session_name}";
// Free text (names, folders) comes last so a tab inside it cannot shift the
// other fields.
const WINDOWS_FORMAT: &str = "#{session_id}\t#{window_index}\t#{window_active}\t#{automatic-rename}\t#{window_width}\t#{window_height}\t#{window_layout}\t#{window_name}";
const PANES_FORMAT: &str = "#{session_id}\t#{window_index}\t#{pane_index}\t#{pane_active}\t#{pane_id}\t#{pane_current_command}\t#{pane_current_path}";
const SCROLLBACK_START: &str = "-2000";
const MAX_AGENT_COMMAND: usize = 256;
// Prints a pane's saved output, deletes it, then becomes the pane's shell.
const RESTORE_SCRIPT: &str = "f=$1; shift; if [ -n \"$f\" ] && [ -f \"$f\" ]; then cat -- \"$f\"; rm -f -- \"$f\"; printf '\\033[0m\\n'; fi; exec \"$@\"";
const SHELLS: &[&str] = &["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "nu"];
const INTERPRETERS: &[&str] = &["node", "nodejs", "bun", "deno"];
// One line per pane: whether it is the only pane of a one-window session that
// was started with the default shell, has printed less than a screen and sits
// at its prompt (what attaching to a missing session name creates).
const PLACEHOLDER_FORMAT: &str = "#{session_windows}\t#{window_panes}\t#{history_size}\t#{?pane_start_command,1,0}\t#{pane_current_command}\t#{session_name}";
const SERVER_FORMAT: &str = "#{pid} #{start_time}";
const STATE_LIMIT: u64 = 4 * 1024 * 1024;
const MAX_SAVED_SESSIONS: usize = 200;

static REFRESH: Mutex<()> = Mutex::new(());

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedPane {
    index: u32,
    active: bool,
    id: String,
    command: String,
    cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedWindow {
    index: u32,
    active: bool,
    // Only a name the user set; automatic names follow the running program.
    name: Option<String>,
    layout: String,
    width: u32,
    height: u32,
    panes: Vec<SavedPane>,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct SavedSession {
    name: String,
    windows: Vec<SavedWindow>,
}

/// A coding agent to start again in a window's active pane, as one command
/// line from the agent catalog.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AgentResume {
    session: String,
    // None: the session's active window.
    #[serde(default)]
    window: Option<u32>,
    command: String,
    // Not detected right now (recorded earlier, or what the tile was started
    // with): resume only when that pane was running a program that can be
    // this agent.
    #[serde(default)]
    only_if_busy: bool,
}

/// The local sessions as last seen on one server (identified by its pid and
/// start time), with the agents detected in their windows.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedState {
    server: String,
    sessions: Vec<SavedSession>,
    agents: Vec<AgentResume>,
}

/// What a periodic record found: true when the server was replaced and saved
/// sessions are missing from it, which the app then restores.
#[derive(Debug, Default, Serialize, PartialEq)]
pub struct RecordStatus {
    restarted: bool,
}

#[derive(Debug, Serialize, PartialEq)]
pub struct FailedSession {
    session: String,
    error: String,
}

#[derive(Debug, Default, Serialize)]
pub struct RefreshReport {
    restored: Vec<String>,
    resumed: Vec<String>,
    failed: Vec<FailedSession>,
}

/// How a restored pane becomes interactive: the server's default shell as a
/// login shell, or its default-command, as tmux itself would start it.
#[derive(Debug, Clone)]
pub struct Launch {
    shell: String,
    default_command: Option<String>,
}

fn internal_session(name: &str) -> bool {
    name.starts_with("pzza-v-") || name == "pzza-quick-chat"
}

fn shell_command(command: &str) -> bool {
    let name = command.trim_start_matches('-');
    SHELLS.contains(&name.rsplit('/').next().unwrap_or(name))
}

/// Whether a pane's foreground program (tmux's pane_current_command) can be
/// the agent a catalog command starts: one of the agent's program names (or a
/// longer platform name such as `grok-darwin-arm64`), a script interpreter it
/// runs under, or, for Claude Code's native install, its version-named binary.
pub fn agent_program(pane_command: &str, agent_command: &str) -> bool {
    let program = pane_command.rsplit('/').next().unwrap_or(pane_command).trim_start_matches('-');
    let Some(entry) = crate::agent_catalog::resume_entry(agent_command) else {
        return false;
    };
    if program.is_empty() {
        return false;
    }
    let version = program.split('.').count() >= 3
        && program.split(['.', '-']).take(3).all(|part| !part.is_empty() && part.chars().all(|c| c.is_ascii_digit()));
    let named = entry.programs.iter().any(|name| {
        program == name || program.strip_prefix(name.as_str()).is_some_and(|rest| rest.starts_with(['-', '.']))
    });
    named || INTERPRETERS.contains(&program) || (entry.version_program && version)
}

/// Sessions on the server that look like what attaching to a missing name
/// creates (see PLACEHOLDER_FORMAT), from that listing.
pub fn placeholder_sessions(listing: &str) -> HashSet<String> {
    listing
        .lines()
        .filter_map(|line| {
            let fields: Vec<&str> = line.splitn(6, '\t').collect();
            let [windows, panes, history, started, command, name] = fields[..] else {
                return None;
            };
            (windows == "1" && panes == "1" && history == "0" && started == "0" && shell_command(command) && !name.is_empty())
                .then(|| name.to_string())
        })
        .collect()
}

/// The saved sessions the current server lacks: none while it is the server
/// they were saved from; otherwise each one without a live session of its
/// name, or whose live session is only a placeholder.
pub fn lost_sessions(saved: Option<&SavedState>, server: &str, live: &[SavedSession], placeholders: &HashSet<String>) -> Vec<SavedSession> {
    let Some(saved) = saved.filter(|saved| saved.server != server) else {
        return Vec::new();
    };
    saved
        .sessions
        .iter()
        .filter(|session| placeholders.contains(&session.name) || !live.iter().any(|entry| entry.name == session.name))
        .cloned()
        .collect()
}

/// Agents to resume: those given first (they win for the same pane), then
/// the recorded ones for other windows, each resumed only where its pane was
/// running something that can be that agent.
pub fn with_recorded(given: Vec<AgentResume>, recorded: &[AgentResume]) -> Vec<AgentResume> {
    let mut agents = given;
    agents.extend(recorded.iter().cloned().map(|agent| AgentResume { only_if_busy: true, ..agent }));
    agents
}

/// A saved state read from disk, kept only where it is still well formed:
/// names and folders as a snapshot accepts them, agents from the catalog.
pub fn sanitize_state(mut state: SavedState) -> SavedState {
    state.sessions.retain(|session| !session.name.is_empty() && !internal_session(&session.name) && !session.name.chars().any(char::is_control));
    state.sessions.truncate(MAX_SAVED_SESSIONS);
    for session in &mut state.sessions {
        session.windows.retain(|window| !window.panes.is_empty() && !window.layout.chars().any(char::is_control));
        for window in &mut session.windows {
            window.name = window.name.take().filter(|name| !name.is_empty() && !name.ends_with(';') && !name.chars().any(char::is_control));
            window.width = window.width.clamp(10, 1000);
            window.height = window.height.clamp(5, 1000);
            for pane in &mut window.panes {
                pane.cwd = pane.cwd.take().and_then(|cwd| folder(&cwd));
            }
        }
    }
    state.sessions.retain(|session| !session.windows.is_empty());
    state.agents.retain(|agent| valid_agent_command(&agent.command) && state.sessions.iter().any(|session| session.name == agent.session));
    state
}

fn folder(value: &str) -> Option<String> {
    (value.starts_with('/') && !value.chars().any(|c| c.is_control() && c != '\t')).then(|| value.to_string())
}

/// Every user session on the server from tmux's listings, in listing order.
/// Window views the app creates and Quick Chat are left out: views come back
/// when tiles attach again, and Quick Chat starts its own session on demand.
pub fn plan_snapshot(sessions: &str, windows: &str, panes: &str) -> Vec<SavedSession> {
    let mut panes_by_window: HashMap<(String, u32), Vec<SavedPane>> = HashMap::new();
    for line in panes.lines() {
        let fields: Vec<&str> = line.splitn(7, '\t').collect();
        let [session, window, index, active, id, command, cwd] = fields[..] else {
            continue;
        };
        let (Ok(window), Ok(index)) = (window.parse::<u32>(), index.parse::<u32>()) else {
            continue;
        };
        panes_by_window.entry((session.to_string(), window)).or_default().push(SavedPane {
            index,
            active: active == "1",
            id: id.to_string(),
            command: command.to_string(),
            cwd: folder(cwd),
        });
    }
    let mut windows_by_session: HashMap<String, Vec<SavedWindow>> = HashMap::new();
    for line in windows.lines() {
        let fields: Vec<&str> = line.splitn(8, '\t').collect();
        let [session, index, active, automatic, width, height, layout, name] = fields[..] else {
            continue;
        };
        let Ok(index) = index.parse::<u32>() else {
            continue;
        };
        let Some(mut panes) = panes_by_window.remove(&(session.to_string(), index)) else {
            continue;
        };
        panes.sort_by_key(|pane| pane.index);
        // tmux treats an argument ending in ";" as a command separator.
        let name = (automatic != "1" && !name.is_empty() && !name.ends_with(';') && !name.chars().any(char::is_control))
            .then(|| name.to_string());
        windows_by_session.entry(session.to_string()).or_default().push(SavedWindow {
            index,
            active: active == "1",
            name,
            layout: layout.to_string(),
            width: width.parse().unwrap_or(80),
            height: height.parse().unwrap_or(24),
            panes,
        });
    }
    let mut saved = Vec::new();
    for line in sessions.lines() {
        let Some((id, name)) = line.split_once('\t') else {
            continue;
        };
        if name.is_empty() || internal_session(name) || name.chars().any(char::is_control) {
            continue;
        }
        let Some(mut windows) = windows_by_session.remove(id) else {
            continue;
        };
        windows.sort_by_key(|window| window.index);
        saved.push(SavedSession { name: name.to_string(), windows });
    }
    saved
}

/// The pane's output without the empty screen rows below it.
pub fn trim_scrollback(text: &str) -> &str {
    let mut end = 0;
    let mut offset = 0;
    for line in text.split_inclusive('\n') {
        offset += line.len();
        if !line.trim().is_empty() {
            end = offset;
        }
    }
    &text[..end]
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| value.to_string()).collect()
}

fn pane_launch(launch: &Launch, scrollback: Option<&Path>) -> Vec<String> {
    let mut args = strings(&["/bin/sh", "-c", RESTORE_SCRIPT, "pzza-restore"]);
    args.push(scrollback.map(|path| path.to_string_lossy().into_owned()).unwrap_or_default());
    args.push(launch.shell.clone());
    match &launch.default_command {
        Some(command) => args.extend([String::from("-c"), command.clone()]),
        None => args.push(String::from("-l")),
    }
    args
}

/// The tmux commands that recreate one saved session: each window at its
/// index and size, panes in their order and layout, each pane in its folder
/// printing its saved output, then the active pane and window. New panes are
/// split from the last one so they keep the saved order.
pub fn restore_commands(
    session: &SavedSession,
    base_index: u32,
    launch: &Launch,
    scrollback: &dyn Fn(&SavedPane) -> Option<PathBuf>,
    home: &str,
) -> Vec<Vec<String>> {
    let cwd = |pane: &SavedPane| {
        pane.cwd
            .as_deref()
            .filter(|path| Path::new(path).is_dir())
            .unwrap_or(home)
            .to_string()
    };
    let target = |index: u32| format!("={}:{index}", session.name);
    let mut commands = Vec::new();
    for (position, window) in session.windows.iter().enumerate() {
        let Some(first) = window.panes.first() else {
            continue;
        };
        let mut create = if position == 0 {
            let mut args = strings(&["new-session", "-d", "-s"]);
            args.push(session.name.clone());
            args.extend(["-x".into(), window.width.to_string(), "-y".into(), window.height.to_string()]);
            args
        } else {
            vec!["new-window".into(), "-d".into(), "-t".into(), target(window.index)]
        };
        if let Some(name) = &window.name {
            create.extend(["-n".into(), name.clone()]);
        }
        create.extend(["-c".into(), cwd(first), "--".into()]);
        create.extend(pane_launch(launch, scrollback(first).as_deref()));
        commands.push(create);
        if position == 0 && window.index != base_index {
            commands.push(vec![
                "move-window".into(),
                "-d".into(),
                "-s".into(),
                target(base_index),
                "-t".into(),
                target(window.index),
            ]);
        }
        for pair in window.panes.windows(2) {
            let (last, pane) = (&pair[0], &pair[1]);
            let mut split = strings(&["split-window", "-d", "-t"]);
            split.push(format!("{}.{}", target(window.index), last.index));
            split.extend(["-c".into(), cwd(pane), "--".into()]);
            split.extend(pane_launch(launch, scrollback(pane).as_deref()));
            commands.push(split);
            // Keep room for the next split; the saved layout follows.
            commands.push(vec!["select-layout".into(), "-t".into(), target(window.index), "tiled".into()]);
        }
        if window.panes.len() > 1 {
            commands.push(vec!["select-layout".into(), "-t".into(), target(window.index), window.layout.clone()]);
            if let Some(active) = window.panes.iter().find(|pane| pane.active) {
                commands.push(vec![
                    "select-pane".into(),
                    "-t".into(),
                    format!("{}.{}", target(window.index), active.index),
                ]);
            }
        }
    }
    if let Some(active) = session.windows.iter().find(|window| window.active) {
        commands.push(vec!["select-window".into(), "-t".into(), target(active.index)]);
    }
    commands
}

/// Exactly one of the catalog's resume commands (agent_catalog.json); anything
/// else, including a catalog command with extra text, is refused.
pub fn valid_agent_command(command: &str) -> bool {
    command.len() <= MAX_AGENT_COMMAND && crate::agent_catalog::resume_entry(command).is_some()
}

#[derive(Debug, PartialEq)]
pub struct AgentTarget {
    session: String,
    window: u32,
    // The restored pane, as a tmux target.
    target: String,
    // The saved pane it replaces.
    pane: String,
    command: String,
}

/// The panes to type an agent command into: the active pane of each
/// requested window that was saved, one agent per pane (the first wins).
pub fn agent_targets(sessions: &[SavedSession], agents: &[AgentResume]) -> Vec<AgentTarget> {
    let mut targets: Vec<AgentTarget> = Vec::new();
    for agent in agents {
        let Some(session) = sessions.iter().find(|session| session.name == agent.session) else {
            continue;
        };
        let Some(window) = session.windows.iter().find(|window| agent.window.map_or(window.active, |index| window.index == index)) else {
            continue;
        };
        let Some(pane) = window.panes.iter().find(|pane| pane.active).or(window.panes.first()) else {
            continue;
        };
        if agent.only_if_busy && !agent_program(&pane.command, &agent.command) {
            continue;
        }
        let target = format!("={}:{}.{}", session.name, window.index, pane.index);
        if !targets.iter().any(|existing| existing.target == target) {
            targets.push(AgentTarget { session: session.name.clone(), window: window.index, target, pane: pane.id.clone(), command: agent.command.clone() });
        }
    }
    targets
}

type Tmux<'a> = &'a dyn Fn() -> Command;

#[cfg(target_os = "macos")]
fn bounded(command: &mut Command) -> io::Result<Output> {
    crate::local_tmux::bounded_output(command)
}

#[cfg(not(target_os = "macos"))]
fn bounded(command: &mut Command) -> io::Result<Output> {
    command.stdin(std::process::Stdio::null()).output()
}

fn run(tmux: Tmux, args: &[String]) -> Result<Output, String> {
    let output = bounded(tmux().args(args)).map_err(|error| error.to_string())?;
    if output.status.success() {
        Ok(output)
    } else {
        let reason = String::from_utf8_lossy(&output.stderr).trim().chars().take(200).collect::<String>();
        Err(if reason.is_empty() { "tmux did not accept the command".into() } else { reason })
    }
}

fn read(tmux: Tmux, args: &[&str]) -> Result<String, String> {
    run(tmux, &strings(args)).map(|output| String::from_utf8_lossy(&output.stdout).into_owned())
}

/// The sessions on the server right now; none when no server is running.
pub fn snapshot(tmux: Tmux) -> Result<Vec<SavedSession>, String> {
    let sessions = match read(tmux, &["list-sessions", "-F", SESSIONS_FORMAT]) {
        Ok(text) => text,
        Err(error) if error.contains("no server running") || error.contains("error connecting") || error.contains("No such file") => {
            return Ok(Vec::new());
        }
        Err(error) => return Err(error),
    };
    let windows = read(tmux, &["list-windows", "-a", "-F", WINDOWS_FORMAT])?;
    let panes = read(tmux, &["list-panes", "-a", "-F", PANES_FORMAT])?;
    Ok(plan_snapshot(&sessions, &windows, &panes))
}

fn private_directory(path: &Path) -> io::Result<()> {
    DirBuilder::new().recursive(true).mode(0o700).create(path)?;
    fs::set_permissions(path, fs::Permissions::from_mode(0o700))
}

/// Saves each pane's recent output to its own private file (0600 in a 0700
/// folder). Output can hold secrets: it is never logged, and a pane that
/// fails to save simply comes back without it.
pub fn save_scrollback(tmux: Tmux, sessions: &[SavedSession], directory: &Path) -> HashMap<String, PathBuf> {
    let mut files = HashMap::new();
    let panes = sessions.iter().flat_map(|session| session.windows.iter()).flat_map(|window| window.panes.iter());
    for (number, pane) in panes.enumerate() {
        let Ok(text) = read(tmux, &["capture-pane", "-p", "-e", "-J", "-S", SCROLLBACK_START, "-t", &pane.id]) else {
            continue;
        };
        let text = trim_scrollback(&text);
        if text.is_empty() {
            continue;
        }
        let path = directory.join(format!("{number}.txt"));
        let written = OpenOptions::new()
            .write(true)
            .create_new(true)
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW)
            .open(&path)
            .and_then(|mut file| file.write_all(text.as_bytes()));
        match written {
            Ok(()) => {
                files.insert(pane.id.clone(), path);
            }
            Err(_) => {
                let _ = fs::remove_file(&path);
            }
        }
    }
    files
}

fn launch_of(tmux: Tmux) -> Launch {
    let option = |name: &str| read(tmux, &["show-options", "-gv", name]).map(|value| value.trim().to_string()).unwrap_or_default();
    let shell = option("default-shell");
    let default_command = option("default-command");
    Launch {
        shell: if shell.starts_with('/') { shell } else { String::from("/bin/sh") },
        default_command: (!default_command.is_empty()).then_some(default_command),
    }
}

/// Recreates the saved sessions on a running server and starts the requested
/// agents again. A session of the same name already on the server is replaced
/// only when `replace` allows it; otherwise that session fails. A session that
/// fails is reported by name; the rest continue. Returns the agents started.
pub fn restore(
    tmux: Tmux,
    sessions: &[SavedSession],
    files: &HashMap<String, PathBuf>,
    agents: &[AgentResume],
    replace: &dyn Fn(&str) -> bool,
) -> (RefreshReport, Vec<AgentResume>) {
    let launch = launch_of(tmux);
    let base_index = read(tmux, &["show-options", "-gv", "base-index"])
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0);
    let home = std::env::var("HOME").unwrap_or_else(|_| String::from("/"));
    let mut report = RefreshReport::default();
    for session in sessions {
        let commands = restore_commands(session, base_index, &launch, &|pane| files.get(&pane.id).cloned(), &home);
        let mut result = Ok(());
        for (step, command) in commands.iter().enumerate() {
            let mut attempt = run(tmux, command);
            // A tile that reattached before this restore created an empty
            // session under the name; replace it with the saved one.
            if step == 0 && attempt.is_err() && run(tmux, &strings(&["has-session", "-t", &format!("={}", session.name)])).is_ok() {
                if !replace(&session.name) {
                    result = Err(String::from("A session with this name is already running."));
                    break;
                }
                let _ = run(tmux, &strings(&["kill-session", "-t", &format!("={}", session.name)]));
                attempt = run(tmux, command);
            }
            if let Err(error) = attempt {
                result = Err(error);
                break;
            }
        }
        match result {
            Ok(()) => report.restored.push(session.name.clone()),
            Err(error) => report.failed.push(FailedSession { session: session.name.clone(), error }),
        }
    }
    let mut started = Vec::new();
    for AgentTarget { session, window, target, pane, command } in agent_targets(sessions, agents) {
        if !report.restored.contains(&session) {
            continue;
        }
        // Type once the pane has printed (and deleted) its saved output, so
        // the command is not echoed into the middle of it.
        if let Some(file) = files.get(&pane) {
            let deadline = Instant::now() + Duration::from_secs(3);
            while file.exists() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let typed = run(tmux, &strings(&["send-keys", "-t", &target, "-l", &command]))
            .and_then(|_| run(tmux, &strings(&["send-keys", "-t", &target, "Enter"])));
        match typed {
            Ok(_) => {
                started.push(AgentResume { session: session.clone(), window: Some(window), command, only_if_busy: false });
                if !report.resumed.contains(&session) {
                    report.resumed.push(session);
                }
            }
            Err(_) => report.failed.push(FailedSession { session, error: "Its agent could not be started again.".into() }),
        }
    }
    (report, started)
}

/// Waits briefly for restored panes to print and delete their saved output,
/// then removes whatever is left.
pub fn discard_scrollback(directory: &Path) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && fs::read_dir(directory).is_ok_and(|mut entries| entries.next().is_some()) {
        std::thread::sleep(Duration::from_millis(100));
    }
    let _ = fs::remove_dir_all(directory);
}

/// Runs one refresh at a time; a second one is refused, not queued.
fn exclusively<T>(work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let _running = REFRESH
        .try_lock()
        .map_err(|_| String::from("Sessions are already refreshing. Wait for it to finish."))?;
    work()
}

fn check_agents(agents: &[AgentResume]) -> Result<(), String> {
    if agents.iter().any(|agent| !valid_agent_command(&agent.command)) {
        return Err("An agent to resume is not a supported command.".into());
    }
    Ok(())
}

/// The running server as "pid start-time"; None when no server answers.
pub fn server_identity(tmux: Tmux) -> Option<String> {
    let text = read(tmux, &["display-message", "-p", SERVER_FORMAT]).ok()?;
    let identity = text.trim();
    (!identity.is_empty() && identity.contains(' ') && identity.chars().all(|c| c.is_ascii_digit() || c == ' ')).then(|| identity.to_string())
}

fn placeholders(tmux: Tmux) -> HashSet<String> {
    read(tmux, &["list-panes", "-a", "-F", PLACEHOLDER_FORMAT]).map(|text| placeholder_sessions(&text)).unwrap_or_default()
}

/// Where the saved state lives: a file of its own in a private folder.
pub fn state_file(data: &Path) -> PathBuf {
    data.join("session-state").join("sessions.json")
}

/// The saved state, when it is a regular file of this user that parses.
pub fn load_state(path: &Path) -> Option<SavedState> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    let mut file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > STATE_LIMIT || metadata.uid() != unsafe { libc::geteuid() } {
        return None;
    }
    let mut text = String::new();
    file.read_to_string(&mut text).ok()?;
    serde_json::from_str(&text).ok().map(sanitize_state)
}

/// Replaces the saved state atomically (0600 in a 0700 folder). It holds
/// folders and window layouts, never terminal output.
pub fn store_state(path: &Path, state: &SavedState) -> io::Result<()> {
    let directory = path.parent().ok_or_else(|| io::Error::other("No folder for the session state"))?;
    private_directory(directory)?;
    let suffix = crate::agent::random_hex(8).ok_or_else(|| io::Error::other("No randomness for the session state"))?;
    let temporary = directory.join(format!(".sessions-{suffix}.tmp"));
    let text = serde_json::to_vec(state).map_err(io::Error::other)?;
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .and_then(|mut file| file.write_all(&text).and_then(|_| file.sync_all()))
        .and_then(|_| fs::rename(&temporary, path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written
}

/// Saves what the server holds after a restore: its sessions, the agents just
/// started, and the earlier recorded agents of windows that kept theirs.
fn save_after(tmux: Tmux, path: &Path, recorded: &[AgentResume], started: Vec<AgentResume>) {
    let (Some(server), Ok(sessions)) = (server_identity(tmux), snapshot(tmux)) else {
        return;
    };
    let mut agents = started;
    for agent in recorded {
        if !agents.iter().any(|entry| entry.session == agent.session && entry.window == agent.window) {
            agents.push(AgentResume { only_if_busy: false, ..agent.clone() });
        }
    }
    let _ = store_state(path, &sanitize_state(SavedState { server, sessions, agents }));
}

/// Keeps the saved state current: the server's sessions and the agents
/// detected in their windows (None keeps the ones recorded before). Never
/// overwrites the state of an earlier server whose sessions are missing now;
/// that is reported instead, for restore_lost to bring them back.
pub fn record(tmux: Tmux, path: &Path, agents: Option<Vec<AgentResume>>) -> Result<RecordStatus, String> {
    if let Some(agents) = &agents {
        check_agents(agents)?;
    }
    let Some(server) = server_identity(tmux) else {
        return Ok(RecordStatus::default());
    };
    let saved = load_state(path);
    let live = snapshot(tmux)?;
    let replaced = saved.as_ref().is_some_and(|saved| saved.server != server);
    if replaced && !lost_sessions(saved.as_ref(), &server, &live, &placeholders(tmux)).is_empty() {
        return Ok(RecordStatus { restarted: true });
    }
    let agents = match agents {
        Some(agents) => agents,
        None if !replaced => saved.as_ref().map(|saved| saved.agents.clone()).unwrap_or_default(),
        None => Vec::new(),
    };
    let agents = agents.into_iter().map(|agent| AgentResume { only_if_busy: false, ..agent }).collect();
    let state = sanitize_state(SavedState { server, sessions: live, agents });
    if saved.as_ref() != Some(&state) {
        store_state(path, &state).map_err(|_| String::from("Could not save the session state"))?;
    }
    Ok(RecordStatus::default())
}

/// Recreates the saved sessions the server lost (see lost_sessions) under
/// their names, windows and folders, and starts the agents recorded in them,
/// or else the given ones, where their pane ran that agent. Sessions on the
/// server are never touched, except placeholders standing in for lost ones.
pub fn restore_lost(tmux: Tmux, path: &Path, agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    check_agents(&agents)?;
    let server = server_identity(tmux).ok_or("The terminal server is not running.")?;
    let saved = load_state(path);
    if saved.as_ref().is_none_or(|saved| saved.server == server) {
        return Ok(RefreshReport::default());
    }
    let live = snapshot(tmux)?;
    let placeholders = placeholders(tmux);
    let lost = lost_sessions(saved.as_ref(), &server, &live, &placeholders);
    let recorded = saved.map(|saved| saved.agents).unwrap_or_default();
    // Nothing is detected on a new server: every agent waits for its pane.
    let agents = with_recorded(Vec::new(), &recorded).into_iter().chain(agents.into_iter().map(|agent| AgentResume { only_if_busy: true, ..agent })).collect::<Vec<_>>();
    let (report, started) = restore(tmux, &lost, &HashMap::new(), &agents, &|name| placeholders.contains(name));
    save_after(tmux, path, &recorded, started);
    Ok(report)
}

/// Saves the local sessions with their output, restarts the server and
/// restores them, with the agents given (detected now) or else recorded.
/// Sessions an earlier, unexpected restart lost come back too.
pub fn refresh_with(tmux: Tmux, data: &Path, agents: Vec<AgentResume>, restart: &dyn Fn() -> Result<(), String>) -> Result<RefreshReport, String> {
    check_agents(&agents)?;
    let path = state_file(data);
    let saved = load_state(&path);
    let live = snapshot(tmux)?;
    let server = server_identity(tmux).unwrap_or_default();
    let placeholders = if saved.as_ref().is_some_and(|saved| saved.server != server) { placeholders(tmux) } else { HashSet::new() };
    let lost = lost_sessions(saved.as_ref(), &server, &live, &placeholders);
    let current: Vec<SavedSession> = live.into_iter().filter(|session| !lost.iter().any(|entry| entry.name == session.name)).collect();
    let recorded = saved.map(|saved| saved.agents).unwrap_or_default();
    let agents = with_recorded(agents, &recorded);
    let root = data.join("session-refresh");
    // Nothing else refreshes now: anything here was left by an interrupted run.
    let _ = fs::remove_dir_all(&root);
    let suffix = crate::agent::random_hex(8).ok_or("Could not prepare the session refresh")?;
    let directory = root.join(suffix);
    private_directory(&directory).map_err(|_| "Could not prepare a private folder for the session refresh")?;
    let result = (|| {
        let files = save_scrollback(tmux, &current, &directory);
        restart()?;
        let sessions: Vec<SavedSession> = current.iter().cloned().chain(lost).collect();
        let (report, started) = restore(tmux, &sessions, &files, &agents, &|_| true);
        save_after(tmux, &path, &recorded, started);
        Ok(report)
    })();
    discard_scrollback(&directory);
    let _ = fs::remove_dir(&root);
    result
}

// UTF-8 output whatever the app's locale: without it tmux prints every tab
// of the listings as "_", and no session could be read.
#[cfg(target_os = "macos")]
fn local_client() -> Command {
    let mut command = crate::local_tmux::client_command();
    command.arg("-u");
    command
}

#[cfg(target_os = "macos")]
fn refresh_blocking(data: PathBuf, agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    refresh_with(&local_client, &data, agents, &|| {
        crate::local_tmux::restart().map_err(|error| format!("The terminal server could not restart: {error}"))
    })
}

#[cfg(not(target_os = "macos"))]
fn refresh_blocking(_data: PathBuf, _agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    Err("Refreshing sessions is only available in the macOS app.".into())
}

#[cfg(target_os = "macos")]
fn restore_blocking(data: PathBuf, agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    restore_lost(&local_client, &state_file(&data), agents)
}

#[cfg(not(target_os = "macos"))]
fn restore_blocking(_data: PathBuf, _agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    Ok(RefreshReport::default())
}

#[cfg(target_os = "macos")]
fn record_blocking(data: PathBuf, agents: Option<Vec<AgentResume>>) -> Result<RecordStatus, String> {
    // Skipped while a refresh or restore runs: it saves the state itself.
    let Ok(_running) = REFRESH.try_lock() else {
        return Ok(RecordStatus::default());
    };
    record(&local_client, &state_file(&data), agents)
}

#[cfg(not(target_os = "macos"))]
fn record_blocking(_data: PathBuf, _agents: Option<Vec<AgentResume>>) -> Result<RecordStatus, String> {
    Ok(RecordStatus::default())
}

fn app_data(app: &tauri::AppHandle) -> Result<PathBuf, String> {
    use tauri::Manager;
    app.path().app_data_dir().map_err(|error| error.to_string())
}

/// Saves the local sessions, restarts the local tmux server and restores
/// them. Refuses while another refresh is running.
#[tauri::command]
pub async fn local_tmux_refresh_sessions(app: tauri::AppHandle, agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || exclusively(|| refresh_blocking(data, agents)))
        .await
        .map_err(|error| error.to_string())?
}

/// Recreates local sessions a replaced server lost; `agents` are the ones to
/// fall back on where none was recorded. Refuses while a refresh is running.
#[tauri::command]
pub async fn local_tmux_restore_sessions(app: tauri::AppHandle, agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || exclusively(|| restore_blocking(data, agents)))
        .await
        .map_err(|error| error.to_string())?
}

/// Records the local sessions and the agents detected in them (null: not
/// known now), and says whether the server was replaced with sessions lost.
#[tauri::command]
pub async fn local_tmux_record_sessions(app: tauri::AppHandle, agents: Option<Vec<AgentResume>>) -> Result<RecordStatus, String> {
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || record_blocking(data, agents))
        .await
        .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    fn pane(index: u32, active: bool, command: &str, cwd: &str) -> SavedPane {
        SavedPane { index, active, id: format!("%{index}"), command: command.into(), cwd: Some(cwd.into()) }
    }

    #[test]
    fn snapshots_keep_user_sessions_windows_and_panes_in_order() {
        let sessions = "$0\twork one\n$1\tpzza-v-abc\n$2\tpzza-quick-chat\n$3\tlogs\n";
        let windows = "$0\t3\t1\t0\t100\t30\tlayout-b\tbuild;\n\
                       $0\t0\t0\t1\t120\t40\tlayout-a\tzsh\n\
                       $1\t0\t1\t1\t120\t40\tlayout-a\tzsh\n\
                       $3\t1\t1\t0\t80\t24\tlayout-c\tmy\ttabbed name\n";
        let panes = "$0\t0\t1\t0\t%2\tclaude\t/Users/me/with\ttab\n\
                     $0\t0\t0\t1\t%1\tzsh\t/Users/me/app\n\
                     $0\t3\t0\t1\t%4\tvim\t/Users/me/app/src\n\
                     $1\t0\t0\t1\t%1\tzsh\t/Users/me/app\n\
                     $3\t1\t0\t1\t%5\t-zsh\trelative\n";
        let saved = plan_snapshot(sessions, windows, panes);
        assert_eq!(saved.iter().map(|session| session.name.as_str()).collect::<Vec<_>>(), ["work one", "logs"]);
        let work = &saved[0];
        assert_eq!(work.windows.iter().map(|window| window.index).collect::<Vec<_>>(), [0, 3]);
        assert_eq!(work.windows[0].name, None, "automatic names are not pinned");
        assert_eq!(work.windows[1].name, None, "a name ending in ; would split the tmux command");
        assert_eq!((work.windows[0].width, work.windows[0].height), (120, 40));
        assert!(work.windows[1].active);
        let first = &work.windows[0].panes;
        assert_eq!(first.iter().map(|pane| pane.id.as_str()).collect::<Vec<_>>(), ["%1", "%2"]);
        assert_eq!(first[1].cwd.as_deref(), Some("/Users/me/with\ttab"));
        assert!(first[0].active);
        assert_eq!(saved[1].windows[0].name, None, "control characters are not restored as names");
        assert_eq!(saved[1].windows[0].panes[0].cwd, None);
    }

    #[test]
    fn scrollback_drops_only_the_empty_rows_below_the_output() {
        assert_eq!(trim_scrollback("one\n\ntwo  \n   \n\n"), "one\n\ntwo  \n");
        assert_eq!(trim_scrollback("\n \n"), "");
        assert_eq!(trim_scrollback("last line without newline"), "last line without newline");
    }

    #[test]
    fn restore_plan_recreates_windows_panes_layout_and_focus() {
        let home = std::env::temp_dir().to_string_lossy().into_owned();
        let session = SavedSession {
            name: "work".into(),
            windows: vec![
                SavedWindow {
                    index: 2,
                    active: false,
                    name: None,
                    layout: "L1".into(),
                    width: 120,
                    height: 40,
                    panes: vec![pane(0, false, "zsh", "/"), pane(1, true, "claude", "/missing/folder"), pane(2, false, "zsh", "/")],
                },
                SavedWindow { index: 5, active: true, name: Some("logs".into()), layout: "L2".into(), width: 120, height: 40, panes: vec![pane(0, true, "zsh", "/")] },
            ],
        };
        let launch = Launch { shell: "/bin/zsh".into(), default_command: None };
        let saved = |pane: &SavedPane| (pane.index == 1).then(|| PathBuf::from("/private/out/1.txt"));
        let commands = restore_commands(&session, 0, &launch, &saved, &home);
        let heads: Vec<String> = commands.iter().map(|command| command[..4.min(command.len())].join(" ")).collect();
        assert_eq!(heads, [
            "new-session -d -s work",
            "move-window -d -s =work:0",
            "split-window -d -t =work:2.0",
            "select-layout -t =work:2 tiled",
            "split-window -d -t =work:2.1",
            "select-layout -t =work:2 tiled",
            "select-layout -t =work:2 L1",
            "select-pane -t =work:2.1",
            "new-window -d -t =work:5",
            "select-window -t =work:5",
        ]);
        assert_eq!(&commands[0][4..8], ["-x", "120", "-y", "40"]);
        assert_eq!(commands[1][5], "=work:2");
        // A folder that no longer exists falls back to home.
        let split = &commands[2];
        let cwd = split.iter().position(|arg| arg == "-c").unwrap();
        assert_eq!(split[cwd + 1], home);
        assert_eq!(split[cwd + 2], "--");
        assert_eq!(&split[cwd + 3..cwd + 5], ["/bin/sh", "-c"]);
        assert_eq!(&split[cwd + 6..], ["pzza-restore", "/private/out/1.txt", "/bin/zsh", "-l"]);
        let window = &commands[8];
        assert_eq!(&window[4..6], ["-n", "logs"]);
        assert_eq!(&window[window.len() - 3..], ["", "/bin/zsh", "-l"], "a pane without output starts its shell directly");

        let custom = Launch { shell: "/bin/bash".into(), default_command: Some("exec fish".into()) };
        let single = SavedSession { name: "s".into(), windows: vec![session.windows[1].clone()] };
        let commands = restore_commands(&single, 5, &custom, &|_| None, &home);
        assert_eq!(&commands[0][commands[0].len() - 3..], ["/bin/bash", "-c", "exec fish"]);
        assert!(!commands.iter().any(|command| command[0] == "move-window"), "a window already at the base index stays");
    }

    #[test]
    fn agents_resume_in_the_active_pane_only_from_catalog_commands() {
        assert!(valid_agent_command("claude -c --permission-mode acceptEdits"));
        assert!(valid_agent_command("codex resume --last --sandbox read-only --ask-for-approval on-request"));
        assert!(valid_agent_command("opencode -c --agent plan"));
        assert!(valid_agent_command("gemini --resume latest --approval-mode default"));
        assert!(valid_agent_command("kiro-cli chat --resume"));
        assert!(valid_agent_command(r#"env 'OPENCODE_CONFIG_CONTENT={"permission":{"edit":"ask","bash":"ask","webfetch":"ask"},"agent":{"build":{"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}}}' opencode -c --agent build"#));
        // A user's agent.build.permission outranked the old global-only override, so it no longer restores.
        assert!(!valid_agent_command(r#"env 'OPENCODE_PERMISSION={"edit":"ask","bash":"ask","webfetch":"ask"}' opencode -c"#));
        // Plain words that are not catalog commands, agents that cannot resume by themselves, and
        // the pre-catalog Claude command (now auto mode) are all refused.
        for unsafe_command in ["", "-c", "claude -c", "claude -c --permission-mode manual ", "claude -c --permission-mode manual --dangerously-skip-permissions", "goose session --resume", "cline --auto-approve false", "bash", "claude; rm -rf /", "claude 'x'", "claude $(id)", "claude\n", "claude && x", &"a".repeat(300)] {
            assert!(!valid_agent_command(unsafe_command), "{unsafe_command:?}");
        }
        let sessions = vec![SavedSession {
            name: "work".into(),
            windows: vec![
                SavedWindow { index: 0, active: true, name: None, layout: String::new(), width: 80, height: 24, panes: vec![pane(0, false, "zsh", "/"), pane(1, true, "claude", "/")] },
                SavedWindow { index: 1, active: false, name: None, layout: String::new(), width: 80, height: 24, panes: vec![pane(0, true, "-zsh", "/")] },
            ],
        }];
        let agent = |session: &str, window: u32, only_if_busy: bool| AgentResume { session: session.into(), window: Some(window), command: "claude -c --permission-mode manual".into(), only_if_busy };
        let targets = agent_targets(&sessions, &[agent("work", 0, true), agent("work", 0, false), agent("work", 1, true), agent("gone", 0, false), agent("work", 9, false)]);
        assert_eq!(targets, [AgentTarget { session: "work".into(), window: 0, target: "=work:0.1".into(), pane: "%1".into(), command: "claude -c --permission-mode manual".into() }]);
        // A detected agent resumes even where the pane now shows its shell.
        assert_eq!(agent_targets(&sessions, &[agent("work", 1, false)])[0].target, "=work:1.0");
        // Without a window, the session's active one.
        let active = AgentResume { session: "work".into(), window: None, command: "codex resume --last --sandbox workspace-write --ask-for-approval on-request".into(), only_if_busy: false };
        assert_eq!(agent_targets(&sessions, &[active])[0].target, "=work:0.1");
    }

    struct Server {
        directory: PathBuf,
        socket: PathBuf,
    }

    impl Server {
        fn new() -> Self {
            let directory = PathBuf::from(format!("/private/tmp/pzza-refresh-test-{}", crate::agent::random_hex(6).unwrap()));
            private_directory(&directory).unwrap();
            let socket = directory.join("s");
            Server { directory, socket }
        }
        // Starts a server with a fixed shell and no user configuration. Its
        // panes use the test folder as home, so login shells find this
        // test's own programs (see fake_agent) first.
        fn start(&self, base_index: &str) {
            let path = format!("{}:{}", self.directory.join("bin").display(), std::env::var("PATH").unwrap_or_default());
            let status = Command::new("tmux")
                .args(["-f", "/dev/null", "-S"])
                .arg(&self.socket)
                .args(["new-session", "-d", "-s", "placeholder", "-x", "100", "-y", "30", "/bin/sleep", "60", ";", "set-option", "-g", "default-shell", "/bin/sh", ";", "set-option", "-g", "base-index", base_index])
                .env_remove("TMUX")
                .env("PATH", path)
                .env("HOME", &self.directory)
                .status()
                .unwrap();
            assert!(status.success());
        }
        // A stand-in for Claude Code: `claude` prints the arguments it was
        // started with, and the returned program shows in tmux under a
        // version name, as the native install does.
        fn fake_agent(&self) -> String {
            let bin = self.directory.join("bin");
            private_directory(&bin).unwrap();
            fs::write(bin.join("claude"), "#!/bin/sh\necho \"resumed-agent $*\"\nexec /bin/sleep 60\n").unwrap();
            fs::set_permissions(bin.join("claude"), fs::Permissions::from_mode(0o700)).unwrap();
            // A login shell resets PATH from the system list first.
            fs::write(self.directory.join(".profile"), format!("PATH=\"{}:$PATH\"; export PATH\n", bin.display())).unwrap();
            let versions = self.directory.join("versions");
            private_directory(&versions).unwrap();
            let program = versions.join("2.1.322");
            fs::copy("/bin/sleep", &program).unwrap();
            // A copied system binary runs only once signed again (ad hoc).
            assert!(Command::new("/usr/bin/codesign").args(["--force", "-s", "-"]).arg(&program).output().unwrap().status.success());
            program.to_string_lossy().into_owned()
        }
        fn wait_command(&self, target: &str, command: &str) {
            let deadline = Instant::now() + Duration::from_secs(5);
            while self.read(&["display-message", "-p", "-t", target, "#{pane_current_command}"]).trim() != command {
                assert!(Instant::now() < deadline, "{target} never ran {command}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        fn client(&self) -> Command {
            let mut command = Command::new("tmux");
            command.args(["-N", "-S"]).arg(&self.socket).env_remove("TMUX");
            command
        }
        fn read(&self, args: &[&str]) -> String {
            read(&|| self.client(), args).unwrap()
        }
        // Waits for a line that is exactly `text` (command output, not the
        // typed command), and returns the pane's lines.
        fn wait_for(&self, target: &str, text: &str) -> Vec<String> {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let screen = self.read(&["capture-pane", "-p", "-J", "-S", "-200", "-t", target]);
                let lines: Vec<String> = screen.lines().map(|line| line.trim().to_string()).collect();
                if lines.iter().any(|line| line == text) {
                    return lines;
                }
                assert!(Instant::now() < deadline, "{text} did not appear in {target}: {screen}");
                std::thread::sleep(Duration::from_millis(50));
            }
        }
    }

    impl Drop for Server {
        fn drop(&mut self) {
            let _ = self.client().arg("kill-server").output();
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[test]
    fn a_restarted_server_gets_the_same_sessions_windows_folders_and_output() {
        let server = Server::new();
        server.start("1");
        let folders: Vec<PathBuf> = ["one", "two", "three"].iter().map(|name| {
            let path = server.directory.join(name);
            fs::create_dir(&path).unwrap();
            fs::canonicalize(path).unwrap()
        }).collect();
        let folder = |index: usize| folders[index].to_str().unwrap().to_string();
        let tmux = |args: &[&str]| server.read(args);
        tmux(&["new-session", "-d", "-s", "work one", "-x", "100", "-y", "30", "-c", &folder(0)]);
        tmux(&["split-window", "-d", "-h", "-t", "=work one:1", "-c", &folder(1)]);
        tmux(&["new-window", "-d", "-t", "=work one:4", "-n", "logs", "-c", &folder(2)]);
        tmux(&["select-window", "-t", "=work one:4"]);
        tmux(&["select-pane", "-t", "=work one:1.1"]);
        tmux(&["new-session", "-d", "-s", "pzza-v-view", "-t", "=work one"]);
        tmux(&["send-keys", "-t", "=work one:1.0", "echo saved-left-output", "Enter"]);
        tmux(&["send-keys", "-t", "=work one:1.1", "echo saved-right-output", "Enter"]);
        server.wait_for("=work one:1.0", "saved-left-output");
        server.wait_for("=work one:1.1", "saved-right-output");
        let geometry = &["list-panes", "-t", "=work one:1", "-F", "#{pane_left},#{pane_top},#{pane_width}x#{pane_height}"];
        let layout_before = tmux(geometry);
        tmux(&["kill-session", "-t", "=placeholder"]);

        let client = || server.client();
        let sessions = snapshot(&client).unwrap();
        assert_eq!(sessions.iter().map(|session| session.name.as_str()).collect::<Vec<_>>(), ["work one"]);
        let scrollback = server.directory.join("scrollback");
        private_directory(&scrollback).unwrap();
        let files = save_scrollback(&client, &sessions, &scrollback);
        assert_eq!(files.len(), 3);
        for path in files.values() {
            let metadata = fs::metadata(path).unwrap();
            assert_eq!(metadata.mode() & 0o777, 0o600);
            assert_eq!(metadata.uid(), unsafe { libc::geteuid() });
        }
        assert_eq!(fs::metadata(&scrollback).unwrap().permissions().mode() & 0o777, 0o700);

        let _ = server.client().arg("kill-server").output();
        // A different base index proves windows keep their saved numbers.
        server.start("0");
        let agents = vec![AgentResume { session: "work one".into(), window: Some(1), command: "echo resumed-agent".into(), only_if_busy: false }];
        let (report, _) = restore(&client, &sessions, &files, &agents, &|_| true);
        assert_eq!(report.restored, ["work one"]);
        assert_eq!(report.resumed, ["work one"]);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        tmux(&["kill-session", "-t", "=placeholder"]);

        let windows = tmux(&["list-windows", "-t", "=work one", "-F", "#{window_index}\t#{window_active}\t#{window_name}"]);
        let windows: Vec<&str> = windows.lines().collect();
        assert_eq!(windows.len(), 2);
        assert!(windows[0].starts_with("1\t0\t"));
        assert_eq!(windows[1], "4\t1\tlogs");
        let panes = tmux(&["list-panes", "-s", "-t", "=work one", "-F", "#{window_index}.#{pane_index}\t#{pane_active}\t#{pane_current_path}"]);
        assert_eq!(panes.lines().collect::<Vec<_>>(), [
            format!("1.0\t0\t{}", folder(0)),
            format!("1.1\t1\t{}", folder(1)),
            format!("4.0\t1\t{}", folder(2)),
        ]);
        assert_eq!(tmux(geometry), layout_before);
        server.wait_for("=work one:1.0", "saved-left-output");
        // The agent goes to the window's active pane, after its output.
        let right = server.wait_for("=work one:1.1", "resumed-agent");
        let line = |text: &str| right.iter().position(|line| line == text).unwrap();
        assert!(line("saved-right-output") < line("resumed-agent"));
        discard_scrollback(&scrollback);
        assert!(!scrollback.exists(), "saved output is deleted after restoring");
    }

    #[test]
    fn a_refresh_refuses_to_run_twice() {
        let nested = exclusively(|| Ok(exclusively(|| Ok(()))));
        assert_eq!(nested.unwrap().unwrap_err(), "Sessions are already refreshing. Wait for it to finish.");
        assert!(exclusively(|| Ok(())).is_ok(), "the lock is released afterwards");
    }

    #[test]
    fn agents_resume_only_where_their_program_ran() {
        assert!(agent_program("2.1.322", "claude -c --permission-mode manual"), "Claude Code's native binary is named after its version");
        assert!(agent_program("claude", "claude -c --permission-mode plan"));
        assert!(agent_program("node", "codex resume --last --sandbox read-only --ask-for-approval on-request"));
        assert!(agent_program("opencode", r#"env 'OPENCODE_CONFIG_CONTENT={"permission":{"edit":"ask","bash":"ask","webfetch":"ask"},"agent":{"build":{"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}}}' opencode -c --agent build"#), "an environment prefix is not the program");
        assert!(agent_program("kiro-cli-chat", "kiro-cli chat --resume"));
        assert!(agent_program("python3.12", "aider --restore-chat-history"));
        assert!(agent_program(".kilo", r#"env 'KILO_CONFIG_CONTENT={"permission":{"edit":"ask","bash":"ask","webfetch":"ask"},"agent":{"code":{"permission":{"edit":"ask","bash":"ask","webfetch":"ask"}}}}' kilo --continue"#));
        let claude = "claude -c --permission-mode manual";
        for (pane, agent) in [("zsh", claude), ("-zsh", claude), ("vim", claude), ("", claude), ("2.1.322", "codex resume --last --sandbox read-only --ask-for-approval on-request"), ("claudette", claude), ("claude", "claude -c"), ("goose", "goose session --resume")] {
            assert!(!agent_program(pane, agent), "{pane} / {agent}");
        }
    }

    #[test]
    fn placeholders_are_untouched_single_shells() {
        let listing = "1\t1\t0\t0\tzsh\tnotes\n1\t1\t0\t1\tzsh\tstarted with a command\n1\t1\t12\t0\tzsh\tused\n1\t1\t0\t0\tclaude\tbusy\n2\t1\t0\t0\tzsh\ttwo windows\n2\t1\t0\t0\tzsh\ttwo windows\n1\t1\t0\t0\t-bash\twith\ttab\n";
        let mut names: Vec<String> = placeholder_sessions(listing).into_iter().collect();
        names.sort();
        assert_eq!(names, ["notes", "with\ttab"]);
    }

    fn saved(name: &str) -> SavedSession {
        SavedSession {
            name: name.into(),
            windows: vec![SavedWindow { index: 0, active: true, name: None, layout: "L".into(), width: 80, height: 24, panes: vec![pane(0, true, "zsh", "/tmp")] }],
        }
    }

    #[test]
    fn only_a_new_server_loses_sessions() {
        let state = SavedState { server: "1 100".into(), sessions: vec![saved("api"), saved("notes"), saved("keep")], agents: Vec::new() };
        let live = vec![saved("notes"), saved("keep")];
        let names = |sessions: Vec<SavedSession>| sessions.into_iter().map(|session| session.name).collect::<Vec<_>>();
        assert!(lost_sessions(Some(&state), "1 100", &[], &HashSet::new()).is_empty(), "the same server lost nothing");
        assert!(lost_sessions(None, "2 200", &[], &HashSet::new()).is_empty());
        assert_eq!(names(lost_sessions(Some(&state), "2 200", &live, &HashSet::new())), ["api"]);
        assert_eq!(names(lost_sessions(Some(&state), "2 200", &live, &HashSet::from(["notes".to_string()]))), ["api", "notes"]);
    }

    #[test]
    fn saved_state_is_validated_when_read() {
        let mut bad_window = saved("windows");
        bad_window.windows[0].name = Some("x;".into());
        bad_window.windows[0].panes[0].cwd = Some("relative".into());
        let state = sanitize_state(SavedState {
            server: "1 1".into(),
            sessions: vec![saved("pzza-v-view"), saved("pzza-quick-chat"), saved("bad\nname"), bad_window, SavedSession { name: "empty".into(), windows: Vec::new() }],
            agents: vec![
                AgentResume { session: "windows".into(), window: Some(0), command: "claude -c --permission-mode manual".into(), only_if_busy: false },
                AgentResume { session: "windows".into(), window: Some(0), command: "claude; rm -rf /".into(), only_if_busy: false },
                AgentResume { session: "gone".into(), window: Some(0), command: "claude -c --permission-mode manual".into(), only_if_busy: false },
            ],
        });
        assert_eq!(state.sessions.iter().map(|session| session.name.as_str()).collect::<Vec<_>>(), ["windows"]);
        assert_eq!(state.sessions[0].windows[0].name, None);
        assert_eq!(state.sessions[0].windows[0].panes[0].cwd, None);
        assert_eq!(state.agents.len(), 1);
        let recorded = with_recorded(vec![AgentResume { session: "a".into(), window: None, command: "codex resume --last --sandbox read-only --ask-for-approval on-request".into(), only_if_busy: false }], &state.agents);
        assert_eq!(recorded.iter().map(|agent| agent.only_if_busy).collect::<Vec<_>>(), [false, true], "recorded agents wait for their program");
    }

    fn folders(server: &Server, names: &[&str]) -> Vec<String> {
        names.iter().map(|name| {
            let path = server.directory.join(name);
            fs::create_dir(&path).unwrap();
            fs::canonicalize(path).unwrap().to_string_lossy().into_owned()
        }).collect()
    }

    fn pane_path(server: &Server, target: &str) -> String {
        server.read(&["display-message", "-p", "-t", target, "#{pane_current_path}"]).trim().to_string()
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_replaced_server_gets_its_lost_sessions_and_agents_back_once() {
        use std::os::unix::fs::MetadataExt;
        let server = Server::new();
        let agent = server.fake_agent();
        server.start("0");
        let folder = folders(&server, &["api", "logs", "keep"]);
        let tmux = |args: &[&str]| server.read(args);
        tmux(&["new-session", "-d", "-s", "api", "-x", "100", "-y", "30", "-c", &folder[0]]);
        tmux(&["new-window", "-d", "-t", "=api:3", "-n", "logs", "-c", &folder[1]]);
        tmux(&["send-keys", "-t", "=api:3", &format!("{agent} 60"), "Enter"]);
        tmux(&["new-session", "-d", "-s", "notes", "-c", &folder[1]]);
        tmux(&["new-session", "-d", "-s", "keep", "-c", &folder[2]]);
        tmux(&["kill-session", "-t", "=placeholder"]);
        server.wait_command("=api:3", "2.1.322");

        let client = || server.client();
        let path = state_file(&server.directory.join("data"));
        let detected = vec![AgentResume { session: "api".into(), window: Some(3), command: "claude -c --permission-mode plan".into(), only_if_busy: false }];
        assert_eq!(record(&client, &path, Some(detected)).unwrap(), RecordStatus { restarted: false });
        assert_eq!(fs::metadata(&path).unwrap().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(path.parent().unwrap()).unwrap().mode() & 0o777, 0o700);
        let recorded = fs::read(&path).unwrap();

        // The server ends on its own; a new one has a tile's placeholder for
        // "notes" and a "keep" that is in use.
        let _ = server.client().arg("kill-server").output();
        server.start("0");
        tmux(&["new-session", "-d", "-s", "notes"]);
        tmux(&["new-session", "-d", "-s", "keep", "-c", &folder[2]]);
        tmux(&["new-window", "-d", "-t", "=keep"]);
        tmux(&["kill-session", "-t", "=placeholder"]);
        let keep_before = tmux(&["list-panes", "-s", "-t", "=keep", "-F", "#{pane_id} #{pane_pid}"]);
        assert_eq!(record(&client, &path, None).unwrap(), RecordStatus { restarted: true });
        assert_eq!(fs::read(&path).unwrap(), recorded, "the lost sessions stay recorded until restored");

        let report = restore_lost(&client, &path, Vec::new()).unwrap();
        assert_eq!(report.restored, ["api", "notes"]);
        assert_eq!(report.resumed, ["api"]);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        let windows = tmux(&["list-windows", "-t", "=api", "-F", "#{window_index}\t#{window_active}\t#{window_name}"]);
        assert_eq!(windows.lines().map(|line| line.split('\t').take(2).collect::<Vec<_>>().join(" ")).collect::<Vec<_>>(), ["0 1", "3 0"]);
        assert!(windows.lines().nth(1).unwrap().ends_with("\tlogs"));
        assert_eq!(pane_path(&server, "=api:0"), folder[0]);
        assert_eq!(pane_path(&server, "=api:3"), folder[1]);
        assert_eq!(pane_path(&server, "=notes:"), folder[1], "the placeholder was replaced by the saved session");
        // The agent continues its chat in the window it ran in, nowhere else.
        server.wait_for("=api:3", "resumed-agent -c --permission-mode plan");
        assert!(!tmux(&["capture-pane", "-p", "-t", "=api:0"]).contains("resumed-agent"));
        assert_eq!(tmux(&["list-panes", "-s", "-t", "=keep", "-F", "#{pane_id} #{pane_pid}"]), keep_before, "a session in use is untouched");

        // Nothing is restored twice.
        let sessions = tmux(&["list-sessions", "-F", "#{session_name}"]);
        let again = restore_lost(&client, &path, Vec::new()).unwrap();
        assert!(again.restored.is_empty() && again.failed.is_empty());
        assert_eq!(tmux(&["list-sessions", "-F", "#{session_name}"]), sessions);
        assert_eq!(record(&client, &path, None).unwrap(), RecordStatus { restarted: false });
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_refresh_resumes_recorded_agents_that_detection_missed() {
        let server = Server::new();
        let agent = server.fake_agent();
        server.start("0");
        let names = ["clean", "rp6", "test"];
        let folder = folders(&server, &names);
        let tmux = |args: &[&str]| server.read(args);
        for (name, cwd) in names.iter().zip(&folder) {
            tmux(&["new-session", "-d", "-s", name, "-x", "100", "-y", "30", "-c", cwd]);
            tmux(&["send-keys", "-t", &format!("={name}:"), &format!("echo saved-{name}-output; {agent} 60"), "Enter"]);
        }
        tmux(&["new-session", "-d", "-s", "shell", "-c", &folder[0]]);
        tmux(&["kill-session", "-t", "=placeholder"]);
        for name in names {
            server.wait_command(&format!("={name}:"), "2.1.322");
        }
        let client = || server.client();
        let data = server.directory.join("data");
        // Recorded while the agents ran; "shell" stands for an agent that has
        // quit since, which stays stopped.
        let detected = names.iter().chain(&["shell"]).map(|name| AgentResume { session: name.to_string(), window: Some(0), command: "claude -c --permission-mode manual".into(), only_if_busy: false }).collect();
        record(&client, &state_file(&data), Some(detected)).unwrap();

        // Activity detection found nothing at the moment of the refresh.
        let restart = || {
            let _ = server.client().arg("kill-server").output();
            server.start("0");
            Ok(())
        };
        let report = refresh_with(&client, &data, Vec::new(), &restart).unwrap();
        assert_eq!(report.restored, ["clean", "rp6", "shell", "test"]);
        assert_eq!(report.resumed, names);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        for (name, cwd) in names.iter().zip(&folder) {
            let target = format!("={name}:");
            assert_eq!(pane_path(&server, &target), *cwd, "{name} keeps its folder");
            let lines = server.wait_for(&target, "resumed-agent -c --permission-mode manual");
            let line = |text: &str| lines.iter().position(|line| line == text).unwrap();
            assert!(line(&format!("saved-{name}-output")) < line("resumed-agent -c --permission-mode manual"), "{name} keeps its output above the agent");
        }
        assert!(!tmux(&["capture-pane", "-p", "-t", "=shell:"]).contains("resumed-agent"), "a shell is not given an agent");
        assert!(!data.join("session-refresh").exists(), "saved output is deleted after restoring");
        assert_eq!(record(&client, &state_file(&data), None).unwrap(), RecordStatus { restarted: false }, "the refresh recorded the new server");
    }
}
