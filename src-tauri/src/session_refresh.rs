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
//
// On disk (all private to the user, in session-state):
// - sessions.json: the last recorded server, sessions and agents, in exactly
//   the format every released version reads and writes. Never add a field.
// - journal.json: what is still owed (a refresh's sessions until its server
//   is gone, sessions or windows a restore could not bring back) with their
//   agents and the folder of their saved output under refresh/. A version
//   that cannot read it never overwrites it and removes no saved output.
// - journal.lock: held while sessions are recorded, refreshed or restored,
//   so two app copies never work on the same journal at once.
// - refresh.lock: held only while a refresh or restore runs, so a refresh can
//   tell one of those (refused) from a periodic record (waited out).
use std::collections::{HashMap, HashSet};
use std::fs::{self, DirBuilder, File, OpenOptions};
use std::io::{self, Write};
use std::os::unix::fs::{DirBuilderExt, OpenOptionsExt, PermissionsExt};
use std::os::unix::io::AsRawFd;
use std::path::{Path, PathBuf};
use std::process::{Command, Output};
use std::time::{Duration, Instant};

use serde::de::DeserializeOwned;
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
// A refresh folder lists its saved output in this file, read back after an
// interrupted refresh.
const MANIFEST: &str = "manifest.json";
const MANIFEST_LIMIT: u64 = 1024 * 1024;
const MAX_MANIFEST_PANES: usize = 4096;
const SCROLLBACK_LIMIT: u64 = 16 * 1024 * 1024;
const JOURNAL_VERSION: u32 = 1;
// How long a restore waits for a refresh or restore another app copy runs.
const RESTORE_WAIT: Duration = Duration::from_secs(60);
// How long a refresh waits for a periodic record to let go of the journal: a
// record makes at most two tmux calls of 4 s each.
const RECORD_WAIT: Duration = Duration::from_secs(30);
// A session restored under its own name while a session of that name is in
// use comes back under this name instead (numbered from 2 when taken).
const RESTORED_SUFFIX: &str = "restored";
const MAX_RESTORED_NAMES: u32 = 20;
const BUSY: &str = "Sessions are already refreshing. Wait for it to finish.";
const KEPT_JOURNAL: &str = "Sessions saved by a newer version of PzzaCode are still waiting to be restored. Open that version to bring them back, then refresh. Nothing was restarted.";

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
/// start time), with the agents detected in their windows (sessions.json).
/// Every released version reads exactly these fields and rejects any other,
/// so this format never changes; whatever else must be kept goes in Journal.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct SavedState {
    server: String,
    sessions: Vec<SavedSession>,
    agents: Vec<AgentResume>,
}

/// What is still owed, and the saved output to bring back with it
/// (journal.json).
///
/// A refresh writes it before it ends the server: `server` is the one about
/// to end, `sessions` lists every session it brings back, and `refresh` names
/// the folder holding their saved output. If the app dies anywhere after
/// that, the next restore finds a replaced server and brings all of them
/// back. A restore leaves here what it could not bring back: whole sessions
/// in `pending`, and for a session it created only partway (named in
/// `partial`) the windows still missing from it. While a restore runs, each
/// session it is building is kept here the same way (see restore_owed), so a
/// crash or a quit that gives up midway still owes the windows not made yet.
///
/// `recorded` names the record servers (sessions.json) the journal was
/// written alongside: the one on disk, and the one about to be written after
/// it. This version rewrites the record only under the journal lock and keeps
/// this list current, so a record of another server means a version that
/// reads only the record (0.2.72 and earlier) ran meanwhile. See
/// outdated_by_record for what is still owed then.
#[derive(Debug, Default, Clone, PartialEq, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Journal {
    version: u32,
    server: String,
    sessions: Vec<SavedSession>,
    pending: Vec<SavedSession>,
    partial: Vec<String>,
    agents: Vec<AgentResume>,
    // The refresh folder (under session-state/refresh) with the saved output.
    refresh: Option<String>,
    // Empty in a journal written before it was kept: nothing is settled then.
    #[serde(default)]
    recorded: Vec<String>,
}

impl Journal {
    fn owes_nothing(&self) -> bool {
        self.sessions.is_empty() && self.pending.is_empty()
    }
}

/// The record servers a journal written now goes with: the record on disk,
/// and `next` when a record of it is written right after the journal.
fn stamp(record: Option<&SavedState>, next: Option<&str>) -> Vec<String> {
    let mut servers: Vec<String> = record.map(|record| record.server.clone()).into_iter().collect();
    if let Some(next) = next.filter(|next| !servers.iter().any(|server| server == next)) {
        servers.push(next.to_string());
    }
    servers
}

/// Whether a version that reads only the record ran since the journal was
/// written: the record names a server the journal was never written with.
fn outdated_by_record(journal: &Journal, record: Option<&SavedState>) -> bool {
    !journal.recorded.is_empty() && record.is_some_and(|record| !journal.recorded.contains(&record.server))
}

/// What a journal still owes once a version that reads only the record ran
/// after it (outdated_by_record). That version owned the sessions meanwhile:
/// it restored whatever the record listed and recorded what the user kept.
///
/// - A refresh's sessions (`sessions`) and sessions created partway
///   (`partial`) were all in the record it read, so it brought them back
///   itself; one missing from its newer record was closed there on purpose
///   and is not owed any more.
/// - Pending sessions are never in the record (a restore records only what
///   it created), so that version never knew them and the user never got
///   them back: they stay owed, unless its newer record lists a session of
///   the same name, which (as for a live session) settles them.
///
/// So a session the user closed is never brought back, and a session lost
/// in a crash is never dropped just because an older version ran.
fn settle_outdated(journal: Journal, record: &SavedState) -> Journal {
    let recorded = |name: &str| record.sessions.iter().any(|session| session.name == name);
    let pending = journal
        .pending
        .iter()
        .filter(|session| !journal.partial.contains(&session.name) && !recorded(&session.name))
        .cloned()
        .collect();
    sanitize_journal(Journal {
        sessions: Vec::new(),
        pending,
        partial: Vec::new(),
        recorded: vec![record.server.clone()],
        ..journal
    })
}

/// The saved state of the last record and the journal, as read from disk.
#[derive(Debug, Default)]
struct Saved {
    record: Option<SavedState>,
    journal: Journal,
    // A journal this version cannot read (a newer version wrote it): it is
    // left exactly as it is, and no saved output is removed.
    journal_kept: bool,
}

impl Saved {
    /// Whether `server` replaced the one the record or a refresh's journal
    /// was taken from.
    fn replaced(&self, server: &str) -> bool {
        self.record.as_ref().is_some_and(|record| record.server != server)
            || (!self.journal.sessions.is_empty() && self.journal.server != server)
    }
}

/// What the current server owes: whole sessions to create, and for the
/// sessions named in `partial`, windows to add to the live session.
#[derive(Debug, Default, Clone, PartialEq)]
pub struct Owed {
    sessions: Vec<SavedSession>,
    partial: HashSet<String>,
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
    // Sessions whose agent was left at its shell: another pane in the same
    // folder continues that agent's last conversation.
    skipped: Vec<FailedSession>,
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
    agent_named(pane_command, agent_command) || (!program.is_empty() && crate::agent_catalog::resume_entry(agent_command).is_some() && INTERPRETERS.contains(&program))
}

/// Whether a pane's foreground program is the agent itself, under one of its
/// own names (not a script interpreter any program can run under).
fn agent_named(pane_command: &str, agent_command: &str) -> bool {
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
    named || (entry.version_program && version)
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

/// What the current server owes. Whole sessions: the journal's pending ones,
/// and once it is not the server they were taken from, the recorded sessions
/// and a refresh's journaled ones. Only those without a live session of their
/// name, or whose live session is only a placeholder. They keep their order
/// of first mention; a journaled copy wins over a recorded one of the same
/// name, and a pending copy over both (the earlier one was the placeholder).
///
/// Windows a restore could not add to a session it created partway are owed
/// with that session: merged into its whole copy when that is owed, else
/// added to the live session where its index is still free. Once the session
/// is closed (gone, or only a placeholder) nothing of it is owed.
pub fn owed_sessions(record: Option<&SavedState>, journal: &Journal, server: &str, live: &[SavedSession], placeholders: &HashSet<String>) -> Owed {
    let missing = |name: &str| placeholders.contains(name) || !live.iter().any(|entry| entry.name == name);
    let mut whole: Vec<SavedSession> = Vec::new();
    let mut put = |session: &SavedSession| match whole.iter_mut().find(|entry| entry.name == session.name) {
        Some(entry) => *entry = session.clone(),
        None => whole.push(session.clone()),
    };
    for session in record.filter(|record| record.server != server).iter().flat_map(|record| &record.sessions) {
        put(session);
    }
    if journal.server != server {
        journal.sessions.iter().for_each(&mut put);
    }
    journal.pending.iter().filter(|session| !journal.partial.contains(&session.name)).for_each(&mut put);
    whole.retain(|session| missing(&session.name));
    let mut partial = HashSet::new();
    for session in journal.pending.iter().filter(|session| journal.partial.contains(&session.name)) {
        if let Some(entry) = whole.iter_mut().find(|entry| entry.name == session.name) {
            for window in &session.windows {
                if !entry.windows.iter().any(|existing| existing.index == window.index) {
                    entry.windows.push(window.clone());
                }
            }
            entry.windows.sort_by_key(|window| window.index);
        } else if let Some(running) = live.iter().find(|entry| entry.name == session.name && !placeholders.contains(&entry.name)) {
            let windows: Vec<SavedWindow> = session
                .windows
                .iter()
                .filter(|window| !running.windows.iter().any(|existing| existing.index == window.index))
                .cloned()
                .collect();
            if !windows.is_empty() {
                partial.insert(session.name.clone());
                whole.push(SavedSession { name: session.name.clone(), windows });
            }
        }
    }
    Owed { sessions: whole, partial }
}

/// Whether the owed sessions still list this pane (a session's saved output
/// is kept per pane until its pane is created again).
fn owes_pane(sessions: &[SavedSession], session: &str, pane: &str) -> bool {
    sessions
        .iter()
        .any(|entry| entry.name == session && entry.windows.iter().any(|window| window.panes.iter().any(|saved| saved.id == pane)))
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
    sanitize_sessions(&mut state.sessions);
    sanitize_agents(&mut state.agents, &state.sessions);
    state
}

/// A journal read from disk, checked like a saved state: its partial names
/// are pending sessions, its folder a refresh folder's name.
pub fn sanitize_journal(mut journal: Journal) -> Journal {
    sanitize_sessions(&mut journal.sessions);
    sanitize_sessions(&mut journal.pending);
    let mut seen = HashSet::new();
    journal.partial.retain(|name| journal.pending.iter().any(|session| &session.name == name) && seen.insert(name.clone()));
    journal.refresh = journal.refresh.take().filter(|name| refresh_name(name));
    let mut servers = HashSet::new();
    journal.recorded.retain(|server| server_name(server) && servers.insert(server.clone()));
    let known: Vec<SavedSession> = journal.sessions.iter().chain(&journal.pending).cloned().collect();
    sanitize_agents(&mut journal.agents, &known);
    journal
}

fn sanitize_agents(agents: &mut Vec<AgentResume>, sessions: &[SavedSession]) {
    agents.retain(|agent| valid_agent_command(&agent.command) && sessions.iter().any(|session| session.name == agent.session));
    let mut seen = Vec::new();
    agents.retain(|agent| {
        let new = !seen.contains(agent);
        seen.push(agent.clone());
        new
    });
}

fn sanitize_sessions(sessions: &mut Vec<SavedSession>) {
    sessions.retain(|session| user_session(&session.name));
    let mut seen = HashSet::new();
    sessions.retain(|session| seen.insert(session.name.clone()));
    sessions.truncate(MAX_SAVED_SESSIONS);
    for session in sessions.iter_mut() {
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
    sessions.retain(|session| !session.windows.is_empty());
}

fn user_session(name: &str) -> bool {
    !name.is_empty() && !internal_session(name) && !name.chars().any(char::is_control)
}

// A refresh folder's name: the 16 hex digits it was created with.
fn refresh_name(name: &str) -> bool {
    name.len() == 16 && name.bytes().all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
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

/// How a restore treats a step that fails.
#[derive(Debug, Clone, Copy, PartialEq)]
pub enum StepKind {
    // Creates a window (or the session with its first window).
    Create,
    // Builds the window further; without it the window is not the saved one.
    Required,
    // Layout and focus only: a failure leaves every pane in place.
    Optional,
}

/// One tmux command of a restore, for the window at `window` (its position
/// in the saved session).
#[derive(Debug, Clone, PartialEq)]
pub struct Step {
    args: Vec<String>,
    window: usize,
    kind: StepKind,
}

/// The tmux commands that recreate one saved session: each window at its
/// index and size, panes in their order and layout, each pane in its folder
/// printing its saved output, then the active pane and window. New panes are
/// split from the last one so they keep the saved order. With `add_to_live`
/// the session already runs and only gets the saved windows (focus stays
/// where its user left it).
pub fn restore_commands(
    session: &SavedSession,
    base_index: u32,
    launch: &Launch,
    scrollback: &dyn Fn(&SavedPane) -> Option<PathBuf>,
    home: &str,
    add_to_live: bool,
) -> Vec<Step> {
    let cwd = |pane: &SavedPane| {
        pane.cwd
            .as_deref()
            .filter(|path| Path::new(path).is_dir())
            .unwrap_or(home)
            .to_string()
    };
    let target = |index: u32| format!("={}:{index}", session.name);
    let mut steps = Vec::new();
    for (position, window) in session.windows.iter().enumerate() {
        let Some(first) = window.panes.first() else {
            continue;
        };
        let step = |args: Vec<String>, kind: StepKind| Step { args, window: position, kind };
        let new_session = position == 0 && !add_to_live;
        let mut create = if new_session {
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
        steps.push(step(create, StepKind::Create));
        if new_session && window.index != base_index {
            let args = vec!["move-window".into(), "-d".into(), "-s".into(), target(base_index), "-t".into(), target(window.index)];
            steps.push(step(args, StepKind::Required));
        }
        for pair in window.panes.windows(2) {
            let (last, pane) = (&pair[0], &pair[1]);
            let mut split = strings(&["split-window", "-d", "-t"]);
            split.push(format!("{}.{}", target(window.index), last.index));
            split.extend(["-c".into(), cwd(pane), "--".into()]);
            split.extend(pane_launch(launch, scrollback(pane).as_deref()));
            steps.push(step(split, StepKind::Required));
            // Keep room for the next split; the saved layout follows.
            steps.push(step(vec!["select-layout".into(), "-t".into(), target(window.index), "tiled".into()], StepKind::Optional));
        }
        if window.panes.len() > 1 {
            steps.push(step(vec!["select-layout".into(), "-t".into(), target(window.index), window.layout.clone()], StepKind::Optional));
            if let Some(active) = window.panes.iter().find(|pane| pane.active) {
                let args = vec!["select-pane".into(), "-t".into(), format!("{}.{}", target(window.index), active.index)];
                steps.push(step(args, StepKind::Optional));
            }
        }
    }
    if !add_to_live {
        if let Some((position, active)) = session.windows.iter().enumerate().find(|(_, window)| window.active) {
            steps.push(Step { args: vec!["select-window".into(), "-t".into(), target(active.index)], window: position, kind: StepKind::Optional });
        }
    }
    steps
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
/// requested window that was saved and created again (`created`), one agent
/// per pane (the first wins).
///
/// Every catalog command continues the last conversation in its folder, so
/// an agent continues in at most one pane per folder: the first one asked
/// for, and none where a pane left running (`busy`) already runs that agent
/// there. The other sessions stay at their shell and are returned with why.
pub fn agent_targets(
    sessions: &[SavedSession],
    agents: &[AgentResume],
    busy: &[SavedSession],
    created: &dyn Fn(&str, u32) -> bool,
) -> (Vec<AgentTarget>, Vec<FailedSession>) {
    let mut targets: Vec<AgentTarget> = Vec::new();
    let mut skipped: Vec<FailedSession> = Vec::new();
    let mut continued: Vec<(&[String], Option<&str>)> = Vec::new();
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
        if !created(&session.name, window.index) || (agent.only_if_busy && !agent_program(&pane.command, &agent.command)) {
            continue;
        }
        let target = format!("={}:{}.{}", session.name, window.index, pane.index);
        if targets.iter().any(|existing| existing.target == target) {
            continue;
        }
        if let Some(entry) = crate::agent_catalog::resume_entry(&agent.command) {
            let conversation = (entry.programs.as_slice(), pane.cwd.as_deref());
            let running = panes_of(busy).any(|(_, live)| live.cwd.as_deref() == conversation.1 && agent_named(&live.command, &agent.command));
            if running || continued.contains(&conversation) {
                if !skipped.iter().any(|entry| entry.session == session.name) {
                    let error = "Its agent was left at the shell: another pane in the same folder continues that agent's last conversation.";
                    skipped.push(FailedSession { session: session.name.clone(), error: error.into() });
                }
                continue;
            }
            continued.push(conversation);
        }
        targets.push(AgentTarget { session: session.name.clone(), window: window.index, target, pane: pane.id.clone(), command: agent.command.clone() });
    }
    (targets, skipped)
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

/// Runs several tmux commands in one call. tmux runs the commands of one call
/// back to back on the server it connected to, so every output comes from
/// the same server. A marker line (unguessable, so no pane path or name can
/// fake it) printed before each command after the first splits the output.
/// tmux skips the rest of the call once a command fails. Returns the output
/// of each command that completed, in order, and tmux's reason when one
/// failed (the output before it is kept).
fn read_chained(tmux: Tmux, commands: &[&[&str]]) -> (Vec<String>, Option<String>) {
    let Some(nonce) = crate::agent::random_hex(8) else {
        return (Vec::new(), Some("No randomness for the tmux listing".into()));
    };
    let marker = format!("pzza-section-{nonce}");
    let mut args: Vec<String> = Vec::new();
    for (number, command) in commands.iter().enumerate() {
        if number > 0 {
            args.extend(strings(&[";", "display-message", "-p", &marker, ";"]));
        }
        args.extend(strings(command));
    }
    let output = match bounded(tmux().args(&args)) {
        Ok(output) => output,
        Err(error) => return (Vec::new(), Some(error.to_string())),
    };
    let stdout = String::from_utf8_lossy(&output.stdout);
    let mut sections: Vec<String> = stdout.split(&format!("{marker}\n")).map(String::from).collect();
    if output.status.success() {
        if sections.len() == commands.len() {
            return (sections, None);
        }
        return (Vec::new(), Some("tmux returned an unexpected listing".into()));
    }
    // The last section is the partial output of the command that failed.
    sections.pop();
    sections.truncate(commands.len());
    let reason = String::from_utf8_lossy(&output.stderr).trim().chars().take(200).collect::<String>();
    (sections, Some(if reason.is_empty() { "tmux did not accept the command".into() } else { reason }))
}

/// The running server (as server_identity reports it) and its sessions,
/// from one tmux call; None when no server answers. Every listing comes from
/// the server named, so no second identity check is needed.
fn server_snapshot(tmux: Tmux) -> Result<Option<(String, Vec<SavedSession>)>, String> {
    let (sections, failed) = read_chained(tmux, &[
        &["display-message", "-p", SERVER_FORMAT],
        &["list-sessions", "-F", SESSIONS_FORMAT],
        &["list-windows", "-a", "-F", WINDOWS_FORMAT],
        &["list-panes", "-a", "-F", PANES_FORMAT],
    ]);
    let Some(identity) = sections.first().map(|text| text.trim()).filter(|identity| server_name(identity)) else {
        // The server did not even report itself: none is running.
        return Ok(None);
    };
    if let Some(reason) = failed {
        return Err(reason);
    }
    Ok(Some((identity.to_string(), plan_snapshot(&sections[1], &sections[2], &sections[3]))))
}

/// The running server and its placeholder sessions, from one tmux call. A
/// listing that fails reads as no placeholders; no server, as None.
fn server_placeholders(tmux: Tmux) -> (Option<String>, HashSet<String>) {
    let (sections, _) = read_chained(tmux, &[&["display-message", "-p", SERVER_FORMAT], &["list-panes", "-a", "-F", PLACEHOLDER_FORMAT]]);
    let identity = sections.first().map(|text| text.trim()).filter(|identity| server_name(identity)).map(String::from);
    (identity, sections.get(1).map(|listing| placeholder_sessions(listing)).unwrap_or_default())
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

/// Saved output files by session name and pane id (pane ids are per server,
/// so they repeat across the sessions of different servers).
pub type Scrollback = HashMap<(String, String), PathBuf>;

fn panes_of(sessions: &[SavedSession]) -> impl Iterator<Item = (&SavedSession, &SavedPane)> {
    sessions.iter().flat_map(|session| session.windows.iter().flat_map(move |window| window.panes.iter().map(move |pane| (session, pane))))
}

/// Saves each pane's recent output to its own private file (0600 in a 0700
/// folder), numbered from `next` on, except panes already in `saved`.
/// Output can hold secrets: it is never logged, and a pane that fails to
/// save simply comes back without it.
pub fn save_scrollback(tmux: Tmux, sessions: &[SavedSession], directory: &Path, next: &mut usize, saved: &Scrollback) -> Scrollback {
    let mut files = Scrollback::new();
    for (session, pane) in panes_of(sessions) {
        if saved.contains_key(&(session.name.clone(), pane.id.clone())) {
            continue;
        }
        let number = *next;
        *next += 1;
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
            .and_then(|mut file| file.write_all(text.as_bytes()).and_then(|_| file.sync_all()));
        match written {
            Ok(()) => {
                files.insert((session.name.clone(), pane.id.clone()), path);
            }
            Err(_) => {
                let _ = fs::remove_file(&path);
            }
        }
    }
    files
}

/// Links an earlier refresh's saved output into this refresh's folder (named
/// from `first` on), so a manifest only ever names files of its own folder.
/// Output that cannot be linked is left out; its pane comes back without it.
fn adopt_scrollback(files: Scrollback, directory: &Path, first: usize) -> Scrollback {
    let mut files: Vec<_> = files.into_iter().collect();
    files.sort();
    files
        .into_iter()
        .enumerate()
        .filter_map(|(offset, (key, source))| {
            let target = directory.join(format!("{}.txt", first + offset));
            fs::hard_link(&source, &target).ok().map(|_| (key, target))
        })
        .collect()
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Manifest {
    panes: Vec<ManifestPane>,
}

#[derive(Debug, Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct ManifestPane {
    session: String,
    pane: String,
    // A bare file name inside the manifest's own folder.
    file: String,
}

/// Lists the saved output files of a refresh folder in its manifest, so an
/// interrupted refresh can be finished from disk.
fn write_manifest(directory: &Path, files: &Scrollback) -> io::Result<()> {
    let mut panes: Vec<ManifestPane> = files
        .iter()
        .filter(|(_, path)| path.parent() == Some(directory))
        .filter_map(|((session, pane), path)| {
            let file = path.file_name()?.to_str()?.to_string();
            Some(ManifestPane { session: session.clone(), pane: pane.clone(), file })
        })
        .collect();
    panes.sort_by(|a, b| a.file.cmp(&b.file));
    let text = serde_json::to_vec(&Manifest { panes }).map_err(io::Error::other)?;
    replace_file(&directory.join(MANIFEST), &text)
}

fn scrollback_file_name(name: &str) -> bool {
    name.strip_suffix(".txt").is_some_and(|number| (1..=9).contains(&number.len()) && number.bytes().all(|byte| byte.is_ascii_digit()))
}

fn pane_id(id: &str) -> bool {
    id.strip_prefix('%').is_some_and(|number| (1..=10).contains(&number.len()) && number.bytes().all(|byte| byte.is_ascii_digit()))
}

// A folder of this user that nobody else can read, and not a link.
fn private_folder(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_dir() && metadata.uid() == unsafe { libc::geteuid() } && metadata.mode() & 0o077 == 0
    })
}

// A regular file of this user (not a link) of at most `limit` bytes.
fn private_file(path: &Path, limit: u64) -> bool {
    use std::os::unix::fs::MetadataExt;
    fs::symlink_metadata(path).is_ok_and(|metadata| {
        metadata.is_file() && metadata.uid() == unsafe { libc::geteuid() } && metadata.len() <= limit
    })
}

/// A file's text when it is a regular file of this user (never through a
/// link) of at most `limit` bytes.
fn read_private(path: &Path, limit: u64) -> Option<String> {
    use std::io::Read;
    use std::os::unix::fs::MetadataExt;
    let file = OpenOptions::new().read(true).custom_flags(libc::O_NOFOLLOW).open(path).ok()?;
    let metadata = file.metadata().ok()?;
    if !metadata.is_file() || metadata.len() > limit || metadata.uid() != unsafe { libc::geteuid() } {
        return None;
    }
    let mut text = String::new();
    file.take(limit + 1).read_to_string(&mut text).ok()?;
    (text.len() as u64 <= limit).then_some(text)
}

/// The saved output a refresh folder's manifest lists. It is read back from
/// disk, so it is trusted only as far as it checks out: the folder and its
/// parent are private folders, the manifest is a small regular file, and each
/// entry names a user session, a pane id and a bare numbered file in the
/// folder that is a regular file (never a link) of bounded size. Anything
/// else is left out; a malformed or oversized manifest yields nothing.
pub fn load_manifest(directory: &Path) -> Scrollback {
    let mut files = Scrollback::new();
    if !directory.parent().is_some_and(private_folder) || !private_folder(directory) {
        return files;
    }
    let Some(manifest) = read_private(&directory.join(MANIFEST), MANIFEST_LIMIT).and_then(|text| serde_json::from_str::<Manifest>(&text).ok()) else {
        return files;
    };
    if manifest.panes.len() > MAX_MANIFEST_PANES {
        return files;
    }
    for ManifestPane { session, pane, file } in manifest.panes {
        if !user_session(&session) || !pane_id(&pane) || !scrollback_file_name(&file) {
            continue;
        }
        let path = directory.join(&file);
        if private_file(&path, SCROLLBACK_LIMIT) {
            files.entry((session, pane)).or_insert(path);
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

/// What a restore did, and what it leaves owed.
#[derive(Debug, Default)]
pub struct Outcome {
    report: RefreshReport,
    // The agents typed into restored panes.
    started: Vec<AgentResume>,
    // Still owed (see Journal): sessions not created, and for the sessions in
    // `partial`, the windows still missing from the live session.
    pending: Vec<SavedSession>,
    partial: Vec<String>,
    // The agents of what is still owed, kept with their own terms.
    pending_agents: Vec<AgentResume>,
    // Output links given to created panes; each pane deletes its own once it
    // has printed it.
    shown: Vec<PathBuf>,
    // Sessions brought back under another name (see restore), as (saved
    // name, new name).
    renamed: Vec<(String, String)>,
}

impl Outcome {
    /// The name a saved session has now.
    fn name_of<'a>(&'a self, saved: &'a str) -> &'a str {
        self.renamed.iter().find(|(old, _)| old == saved).map_or(saved, |(_, new)| new.as_str())
    }
}

/// How building one session went (see restore).
struct Built {
    // The windows (by position) this build created.
    made: Vec<bool>,
    // The position of the window that failed, and why.
    failure: Option<(usize, String)>,
    // A session of its name was already running and in use.
    in_use: bool,
}

/// A name for a saved session whose own name is in use: "<name> (restored)",
/// numbered from 2 when that is taken too, and never one still owed.
fn restored_name(tmux: Tmux, name: &str, owed: &[SavedSession]) -> Option<String> {
    (1..=MAX_RESTORED_NAMES)
        .map(|number| if number == 1 { format!("{name} ({RESTORED_SUFFIX})") } else { format!("{name} ({RESTORED_SUFFIX} {number})") })
        .find(|candidate| {
            !owed.iter().any(|session| &session.name == candidate) && run(tmux, &strings(&["has-session", "-t", &format!("={candidate}")])).is_err()
        })
}

/// Runs the steps that build one session. A session of its name already on
/// the server is replaced only when `replace` allows it at that moment.
/// Once a new session runs while more windows are still to come, it is put
/// on record through `checkpoint` (see restore).
fn build_session(
    tmux: Tmux,
    session: &SavedSession,
    steps: &[Step],
    add_to_live: bool,
    replace: &dyn Fn(&str) -> bool,
    checkpoint: &mut dyn FnMut(&str, Option<&[SavedWindow]>),
) -> Built {
    let name = &session.name;
    let mut built = Built { made: vec![false; session.windows.len()], failure: None, in_use: false };
    for (number, step) in steps.iter().enumerate() {
        let mut attempt = run(tmux, &step.args);
        // A tile that reattached before this restore created an empty
        // session under the name; replace it with the saved one.
        if number == 0 && !add_to_live && attempt.is_err() && run(tmux, &strings(&["has-session", "-t", &format!("={name}")])).is_ok() {
            if !replace(name) {
                built.in_use = true;
                built.failure = Some((0, String::from("A session with this name is already running.")));
                break;
            }
            let _ = run(tmux, &strings(&["kill-session", "-t", &format!("={name}")]));
            attempt = run(tmux, &step.args);
        }
        match attempt {
            Ok(_) if step.kind == StepKind::Create => {
                built.made[step.window] = true;
                if number == 0 && !add_to_live && session.windows.len() > 1 {
                    checkpoint(name, Some(&session.windows));
                }
            }
            Ok(_) => {}
            Err(_) if step.kind == StepKind::Optional => {}
            Err(error) => {
                built.failure = Some((step.window, error));
                break;
            }
        }
    }
    built
}

/// A second name for a saved output file, for one pane to print and delete.
/// The saved file itself stays until its whole session is back, so a session
/// that fails keeps its output for the next try. None when no link can be
/// made; that pane then prints (and deletes) the saved file itself.
fn show_link(file: &Path) -> Option<PathBuf> {
    let link = file.with_extension("show");
    let _ = fs::remove_file(&link);
    fs::hard_link(file, &link).ok().map(|_| link)
}

fn is_show_link(path: &Path) -> bool {
    path.extension().is_some_and(|extension| extension == "show")
}

/// Recreates what is owed on a running server and starts the requested
/// agents again. A session of the same name already on the server is replaced
/// only when `replace` allows it at that moment (a placeholder); one in use
/// is left alone, and the saved session comes back beside it under
/// restored_name instead of being dropped with its output. Sessions in
/// `owed.partial` already run and only get their missing windows.
///
/// A session either comes back whole or stays owed: when a step that builds
/// a window fails, the window (or, for its first window, the session) this
/// restore just made is closed again, and that window and every later one
/// stay owed with their saved output. Earlier windows stay; the session is
/// then owed only the missing ones. Failures are reported by name; the other
/// sessions continue. `busy` are the sessions left running, for the agents.
///
/// `checkpoint` keeps the journal current while this runs: with the windows
/// a new session still owes once it runs (before its other windows exist),
/// and with None once it is back or gone again (what was owed before
/// applies). A crash in between leaves the missing windows owed.
pub fn restore(
    tmux: Tmux,
    owed: &Owed,
    files: &Scrollback,
    agents: &[AgentResume],
    busy: &[SavedSession],
    replace: &dyn Fn(&str) -> bool,
    checkpoint: &mut dyn FnMut(&str, Option<&[SavedWindow]>),
) -> Outcome {
    let launch = launch_of(tmux);
    let base_index = read(tmux, &["show-options", "-gv", "base-index"])
        .ok()
        .and_then(|value| value.trim().parse().ok())
        .unwrap_or(0);
    let home = std::env::var("HOME").unwrap_or_else(|_| String::from("/"));
    let mut outcome = Outcome::default();
    let mut created: HashSet<(String, u32)> = HashSet::new();
    let mut links: HashMap<(String, String), PathBuf> = HashMap::new();
    // The sessions as they come back (under a new name when theirs was taken).
    let mut restored: Vec<SavedSession> = Vec::new();
    for saved in &owed.sessions {
        let add_to_live = owed.partial.contains(&saved.name);
        let shown: HashMap<String, PathBuf> = panes_of(std::slice::from_ref(saved))
            .filter_map(|(_, pane)| {
                let file = files.get(&(saved.name.clone(), pane.id.clone()))?;
                Some((pane.id.clone(), show_link(file).unwrap_or_else(|| file.clone())))
            })
            .collect();
        let scrollback = |pane: &SavedPane| shown.get(&pane.id).cloned();
        let mut session = saved.clone();
        let steps = restore_commands(&session, base_index, &launch, &scrollback, &home, add_to_live);
        let mut built = build_session(tmux, &session, &steps, add_to_live, replace, checkpoint);
        if built.in_use {
            if let Some(name) = restored_name(tmux, &saved.name, &owed.sessions) {
                session.name = name;
                let steps = restore_commands(&session, base_index, &launch, &scrollback, &home, false);
                built = build_session(tmux, &session, &steps, false, replace, checkpoint);
                outcome.renamed.push((saved.name.clone(), session.name.clone()));
            }
        }
        let Built { made, failure, in_use } = built;
        let name = &session.name;
        // Windows before `from` are back as saved.
        let from = match &failure {
            None => session.windows.len(),
            Some(_) if in_use => 0,
            Some((0, _)) if !add_to_live => {
                if made[0] {
                    let _ = run(tmux, &strings(&["kill-session", "-t", &format!("={name}")]));
                }
                0
            }
            Some((position, _)) => {
                if made[*position] {
                    let _ = run(tmux, &strings(&["kill-window", "-t", &format!("={name}:{}", session.windows[*position].index)]));
                }
                *position
            }
        };
        // A new session put on record once it ran: what it still owes now.
        if made[0] && !add_to_live && session.windows.len() > 1 {
            checkpoint(name, (from > 0 && from < session.windows.len()).then(|| &session.windows[from..]));
        }
        for window in &session.windows[..from] {
            created.insert((name.clone(), window.index));
        }
        for (pane, link) in shown {
            if session.windows[..from].iter().any(|window| window.panes.iter().any(|saved| saved.id == pane)) {
                outcome.shown.push(link.clone());
                links.insert((name.clone(), pane), link);
            } else if is_show_link(&link) {
                let _ = fs::remove_file(&link);
            }
        }
        match failure {
            None => outcome.report.restored.push(name.clone()),
            Some((_, error)) if in_use => outcome.report.failed.push(FailedSession { session: name.clone(), error }),
            Some((_, error)) => {
                let partly = from > 0 || add_to_live;
                let error = if partly { format!("Some of its windows could not be restored: {error}") } else { error };
                outcome.report.failed.push(FailedSession { session: name.clone(), error });
                outcome.pending.push(SavedSession { name: name.clone(), windows: session.windows[from..].to_vec() });
                if partly {
                    outcome.partial.push(name.clone());
                }
            }
        }
        restored.push(session);
    }
    // Agents follow their session to its new name.
    let agents: Vec<AgentResume> = agents.iter().map(|agent| AgentResume { session: outcome.name_of(&agent.session).to_string(), ..agent.clone() }).collect();
    let made_window = |session: &str, window: u32| created.contains(&(session.to_string(), window));
    let (targets, skipped) = agent_targets(&restored, &agents, busy, &made_window);
    outcome.report.skipped = skipped;
    for AgentTarget { session, window, target, pane, command } in targets {
        // Type once the pane has printed (and deleted) its saved output, so
        // the command is not echoed into the middle of it.
        if let Some(link) = links.get(&(session.clone(), pane)) {
            let deadline = Instant::now() + Duration::from_secs(3);
            while fs::symlink_metadata(link).is_ok() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(50));
            }
        }
        let typed = run(tmux, &strings(&["send-keys", "-t", &target, "-l", &command]))
            .and_then(|_| run(tmux, &strings(&["send-keys", "-t", &target, "Enter"])));
        match typed {
            Ok(_) => {
                outcome.started.push(AgentResume { session: session.clone(), window: Some(window), command, only_if_busy: false });
                if !outcome.report.resumed.contains(&session) {
                    outcome.report.resumed.push(session);
                }
            }
            Err(_) => outcome.report.failed.push(FailedSession { session, error: "Its agent could not be started again.".into() }),
        }
    }
    let still_owed = |agent: &AgentResume| {
        outcome.pending.iter().any(|session| {
            session.name == agent.session && agent.window.is_none_or(|index| session.windows.iter().any(|window| window.index == index))
        })
    };
    outcome.pending_agents = agents.iter().filter(|agent| still_owed(agent)).cloned().collect();
    outcome
}

/// Waits briefly for created panes to print and delete their output links.
fn wait_for_shown(shown: &[PathBuf]) {
    let deadline = Instant::now() + Duration::from_secs(3);
    while Instant::now() < deadline && shown.iter().any(|file| fs::symlink_metadata(file).is_ok()) {
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Leaves only the `keep` files of a refresh folder (and a manifest listing
/// just them); everything else, output already shown included, is removed.
fn keep_only(directory: &Path, keep: &Scrollback) -> io::Result<()> {
    let kept: HashSet<&Path> = keep.values().map(PathBuf::as_path).collect();
    for entry in fs::read_dir(directory)?.flatten() {
        let path = entry.path();
        if entry.file_name() == MANIFEST || kept.contains(path.as_path()) {
            continue;
        }
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => fs::remove_dir_all(&path)?,
            Ok(_) => fs::remove_file(&path)?,
            Err(_) => {}
        }
    }
    write_manifest(directory, keep)
}

fn state_directory(data: &Path) -> PathBuf {
    data.join("session-state")
}

fn refresh_root(data: &Path) -> PathBuf {
    state_directory(data).join("refresh")
}

// Where a development version before the journal kept its saved output.
fn earlier_refresh_root(data: &Path) -> PathBuf {
    data.join("session-refresh")
}

/// Removes every refresh folder except `keep`, then the root when empty.
/// Links are removed, never followed.
fn discard_refreshes(root: &Path, keep: Option<&str>) {
    let Ok(metadata) = fs::symlink_metadata(root) else {
        return;
    };
    if !metadata.is_dir() {
        let _ = fs::remove_file(root);
        return;
    }
    for entry in fs::read_dir(root).into_iter().flatten().flatten() {
        if keep.is_some_and(|keep| entry.file_name() == keep) {
            continue;
        }
        let path = entry.path();
        match fs::symlink_metadata(&path) {
            Ok(metadata) if metadata.is_dir() => {
                let _ = fs::remove_dir_all(&path);
            }
            Ok(_) => {
                let _ = fs::remove_file(&path);
            }
            Err(_) => {}
        }
    }
    let _ = fs::remove_dir(root);
}

/// A hold on the session journal across every app copy. It is a file lock,
/// so it ends with the process however that ends.
pub struct JournalLock {
    _file: File,
}

impl JournalLock {
    /// Keeps the hold until the process ends, so nothing starts working on
    /// the journal while the app exits.
    pub fn keep_until_exit(self) {
        std::mem::forget(self);
    }
}

/// Waits up to `wait` for a refresh, restore or record running in any app
/// copy to finish its journal work, then holds the journal. None when it is
/// still busy then (or cannot be locked): the journal is crash-safe, so a
/// quit goes on anyway.
fn hold_journal(data: &Path, wait: Duration) -> Option<JournalLock> {
    match lock_journal(data, wait) {
        Ok(Some(lock)) => Some(lock),
        Ok(None) => {
            eprintln!("PzzaCode: saved sessions were still being refreshed or restored after {}s; shutting down anyway", wait.as_secs());
            None
        }
        Err(error) => {
            eprintln!("PzzaCode: could not wait for the saved sessions: {error}; shutting down anyway");
            None
        }
    }
}

/// The journal hold a quit or restart takes before the terminal service
/// stops, so a running refresh or restore finishes first.
pub fn hold_journal_for_quit(app: &tauri::AppHandle, wait: Duration) -> Option<JournalLock> {
    match app_data(app) {
        Ok(data) => hold_journal(&data, wait),
        Err(error) => {
            eprintln!("PzzaCode: could not find the saved sessions: {error}; shutting down anyway");
            None
        }
    }
}

/// Takes the journal lock, waiting up to `wait` while a refresh, restore or
/// record in this or another app copy holds it. None when it is still held
/// then.
fn lock_journal(data: &Path, wait: Duration) -> io::Result<Option<JournalLock>> {
    lock_file(data, "journal.lock", wait)
}

/// Takes one of the session-state locks (a private file, never through a
/// link), waiting up to `wait` while it is held. None when it is still held
/// then.
fn lock_file(data: &Path, name: &str, wait: Duration) -> io::Result<Option<JournalLock>> {
    use std::os::unix::fs::MetadataExt;
    let directory = state_directory(data);
    private_directory(&directory)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(directory.join(name))?;
    let metadata = file.metadata()?;
    if !metadata.is_file() || metadata.uid() != unsafe { libc::geteuid() } || metadata.mode() & 0o077 != 0 {
        return Err(io::Error::new(io::ErrorKind::PermissionDenied, "The session journal lock is not private"));
    }
    let deadline = Instant::now() + wait;
    loop {
        if unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) } == 0 {
            return Ok(Some(JournalLock { _file: file }));
        }
        let error = io::Error::last_os_error();
        if error.kind() != io::ErrorKind::WouldBlock {
            return Err(error);
        }
        if Instant::now() >= deadline {
            return Ok(None);
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

/// Runs one refresh or restore at a time across every app copy: waits up to
/// `wait` for the one running, then refuses (never queues). A periodic
/// record holds only the journal, briefly, so that is waited out (up to
/// RECORD_WAIT) whatever `wait` is: a refresh is refused only while a
/// refresh or restore really runs.
fn exclusively<T>(data: &Path, wait: Duration, work: impl FnOnce() -> Result<T, String>) -> Result<T, String> {
    let unlockable = |_| String::from("Could not lock the saved sessions.");
    let _work = lock_file(data, "refresh.lock", wait).map_err(unlockable)?.ok_or(BUSY)?;
    let _journal = lock_journal(data, wait.max(RECORD_WAIT)).map_err(unlockable)?.ok_or(BUSY)?;
    work()
}

/// The server this app copy last brought up to date: everything owed to it
/// was restored (or tried), or nothing was owed. Local attaches check it.
static SETTLED: std::sync::Mutex<Option<String>> = std::sync::Mutex::new(None);

fn mark_settled(server: &str) {
    *SETTLED.lock().unwrap_or_else(std::sync::PoisonError::into_inner) = Some(server.to_string());
}

#[cfg(target_os = "macos")]
fn settled(server: &str) -> bool {
    SETTLED.lock().unwrap_or_else(std::sync::PoisonError::into_inner).as_deref() == Some(server)
}

/// Before a tile attaches to a server this app has not brought up to date
/// (one ensure_running, a listing or another copy just started): restores
/// what that server owes first, so `new-session -A` never makes a fresh
/// shell under a saved name the restore still has to bring back. Waits up to
/// `wait` for a refresh or restore running elsewhere, and refuses the attach
/// when it is still running then. Cheap once the server is settled.
#[cfg(target_os = "macos")]
fn restore_before_attach(tmux: Tmux, data: &Path, wait: Duration) -> Result<(), String> {
    let Some(server) = server_identity(tmux) else {
        // No server: the attach fails on its own (tmux -N starts none).
        return Ok(());
    };
    if settled(&server) {
        return Ok(());
    }
    match exclusively(data, wait, || restore_owed(tmux, data, Vec::new())) {
        Ok(report) => {
            for failed in &report.failed {
                eprintln!("PzzaCode: the saved session {:?} was not fully restored: {}", failed.session, failed.error);
            }
            Ok(())
        }
        Err(error) if error == BUSY => Err(String::from("Saved sessions are still being restored. Try again in a moment.")),
        Err(error) => {
            // Whatever is still owed stays in the journal for the next try.
            eprintln!("PzzaCode: could not restore saved sessions before attaching: {error}");
            Ok(())
        }
    }
}

/// Makes the local server ready for a tile to attach: started again when it
/// is down, with what it owes restored first (see restore_before_attach).
/// Nothing is restored while the app quits. Runs off the main thread.
#[cfg(target_os = "macos")]
pub fn prepare_local_attach(app: &tauri::AppHandle) -> Result<(), String> {
    crate::local_tmux::ensure_running();
    if crate::local_tmux::stopping() {
        return Ok(());
    }
    match app_data(app) {
        Ok(data) => restore_before_attach(&local_client, &data, RESTORE_WAIT),
        Err(error) => {
            eprintln!("PzzaCode: could not find the saved sessions: {error}");
            Ok(())
        }
    }
}

fn check_agents(agents: &[AgentResume]) -> Result<(), String> {
    if agents.iter().any(|agent| !valid_agent_command(&agent.command)) {
        return Err("An agent to resume is not a supported command.".into());
    }
    Ok(())
}

// A server as server_identity reports it.
fn server_name(identity: &str) -> bool {
    !identity.is_empty() && identity.contains(' ') && identity.chars().all(|c| c.is_ascii_digit() || c == ' ')
}

/// The running server as "pid start-time"; None when no server answers.
pub fn server_identity(tmux: Tmux) -> Option<String> {
    let text = read(tmux, &["display-message", "-p", SERVER_FORMAT]).ok()?;
    let identity = text.trim();
    server_name(identity).then(|| identity.to_string())
}

fn placeholders(tmux: Tmux) -> HashSet<String> {
    read(tmux, &["list-panes", "-a", "-F", PLACEHOLDER_FORMAT]).map(|text| placeholder_sessions(&text)).unwrap_or_default()
}

/// Whether the session of this name is a placeholder right now (not as an
/// earlier listing saw it: a tile may have attached, or been typed into,
/// since).
fn placeholder_now(tmux: Tmux, name: &str) -> bool {
    read(tmux, &["list-panes", "-s", "-t", &format!("={name}"), "-F", PLACEHOLDER_FORMAT]).is_ok_and(|text| placeholder_sessions(&text).contains(name))
}

/// Where the record lives: a file of its own in a private folder.
pub fn state_file(data: &Path) -> PathBuf {
    state_directory(data).join("sessions.json")
}

fn journal_file(data: &Path) -> PathBuf {
    state_directory(data).join("journal.json")
}

/// A saved file as found on disk.
enum Stored<T> {
    Missing,
    Read(T),
    // Present, but not a small regular file of this user, or not of this
    // shape (its text when it could be read).
    Unreadable(Option<String>),
}

fn stored<T: DeserializeOwned>(path: &Path) -> Stored<T> {
    if fs::symlink_metadata(path).is_err_and(|error| error.kind() == io::ErrorKind::NotFound) {
        return Stored::Missing;
    }
    match read_private(path, STATE_LIMIT) {
        Some(text) => match serde_json::from_str(&text) {
            Ok(value) => Stored::Read(value),
            Err(_) => Stored::Unreadable(Some(text)),
        },
        None => Stored::Unreadable(None),
    }
}

/// sessions.json as a development version before the journal wrote it, with
/// what was owed in the same file (and its output under session-refresh).
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct EarlierState {
    server: String,
    sessions: Vec<SavedSession>,
    agents: Vec<AgentResume>,
    #[serde(default)]
    pending: Vec<SavedSession>,
    #[serde(default)]
    refresh: Option<String>,
}

/// The record and the journal on disk, each kept only as far as it checks
/// out. A journal this version cannot read is left exactly as it is
/// (journal_kept). A record that cannot be read is never overwritten in
/// place: one that still holds what was owed (see EarlierState) is split into
/// the record and a journal, anything else is moved aside to
/// sessions.json.unreadable. Runs with the journal lock held.
fn load(data: &Path) -> Saved {
    let (journal, journal_kept, journal_missing) = match stored::<Journal>(&journal_file(data)) {
        Stored::Missing => (Journal::default(), false, true),
        Stored::Read(journal) if journal.version == JOURNAL_VERSION => (sanitize_journal(journal), false, false),
        _ => (Journal::default(), true, false),
    };
    let mut saved = Saved { record: None, journal, journal_kept };
    let path = state_file(data);
    match stored::<SavedState>(&path) {
        Stored::Missing => {}
        Stored::Read(state) => saved.record = Some(sanitize_state(state)),
        Stored::Unreadable(text) => match text.and_then(|text| serde_json::from_str::<EarlierState>(&text).ok()) {
            Some(earlier) => split_earlier(data, earlier, journal_missing, &mut saved),
            None => {
                let _ = fs::rename(&path, path.with_extension("json.unreadable"));
            }
        },
    }
    if let Some(record) = saved.record.as_ref().filter(|record| !saved.journal_kept && outdated_by_record(&saved.journal, Some(record))) {
        let journal = settle_outdated(saved.journal.clone(), record);
        // Kept in memory even when it cannot be written: what is owed is the
        // same either way, and the next journal write carries it.
        let _ = store_journal(data, &journal);
        saved.journal = journal;
    }
    saved
}

/// Moves what an EarlierState still owes into a journal (its saved output
/// into the journal's folder), then writes the record in the format every
/// version reads. A file that cannot be split yet is left for the next try.
fn split_earlier(data: &Path, earlier: EarlierState, journal_missing: bool, saved: &mut Saved) {
    let record = sanitize_state(SavedState { server: earlier.server.clone(), sessions: earlier.sessions.clone(), agents: earlier.agents.clone() });
    saved.record = Some(record.clone());
    if journal_missing && (!earlier.pending.is_empty() || earlier.refresh.is_some()) {
        let root = refresh_root(data);
        let refresh = earlier.refresh.clone().filter(|name| {
            refresh_name(name) && private_directory(&root).is_ok() && fs::rename(earlier_refresh_root(data).join(name), root.join(name)).is_ok()
        });
        let journal = sanitize_journal(Journal {
            version: JOURNAL_VERSION,
            server: earlier.server,
            // With a refresh, the sessions are the ones it ended.
            sessions: if earlier.refresh.is_some() { earlier.sessions } else { Vec::new() },
            pending: earlier.pending,
            partial: Vec::new(),
            agents: earlier.agents,
            refresh,
            recorded: vec![record.server.clone()],
        });
        if store_journal(data, &journal).is_err() {
            return;
        }
        saved.journal = journal;
    }
    if store_state(&state_file(data), &record).is_ok() {
        discard_refreshes(&earlier_refresh_root(data), None);
    }
}

/// Replaces a private file atomically and durably: written to a new 0600
/// file beside it, flushed, renamed over it, and the folder flushed too.
fn replace_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    let directory = path.parent().ok_or_else(|| io::Error::other("No folder for the file"))?;
    let name = path.file_name().ok_or_else(|| io::Error::other("No file name"))?.to_string_lossy().into_owned();
    let suffix = crate::agent::random_hex(8).ok_or_else(|| io::Error::other("No randomness for a temporary file"))?;
    let temporary = directory.join(format!(".{name}-{suffix}.tmp"));
    let written = OpenOptions::new()
        .write(true)
        .create_new(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(&temporary)
        .and_then(|mut file| file.write_all(bytes).and_then(|_| file.sync_all()))
        .and_then(|_| fs::rename(&temporary, path));
    if written.is_err() {
        let _ = fs::remove_file(&temporary);
    }
    written?;
    fs::File::open(directory)?.sync_all()
}

/// Replaces a private JSON file (0600 in a 0700 folder), refusing one too
/// large to be read back. It holds folders and layouts, never terminal output.
fn store_json(path: &Path, value: &impl Serialize) -> io::Result<()> {
    let directory = path.parent().ok_or_else(|| io::Error::other("No folder for the session state"))?;
    private_directory(directory)?;
    let text = serde_json::to_vec(value).map_err(io::Error::other)?;
    if text.len() as u64 > STATE_LIMIT {
        return Err(io::Error::other("The saved sessions are too large"));
    }
    replace_file(path, &text)
}

pub fn store_state(path: &Path, state: &SavedState) -> io::Result<()> {
    store_json(path, state)
}

/// Writes the journal, or removes it once nothing is owed.
fn store_journal(data: &Path, journal: &Journal) -> io::Result<()> {
    let path = journal_file(data);
    if !journal.owes_nothing() {
        return store_json(&path, journal);
    }
    match fs::remove_file(&path) {
        Err(error) if error.kind() != io::ErrorKind::NotFound => Err(error),
        _ => Ok(()),
    }
}

fn sorted(names: &HashSet<String>) -> Vec<String> {
    let mut names: Vec<String> = names.iter().cloned().collect();
    names.sort();
    names
}

/// Keeps the journal to what the server still owes (`owed`) while nothing is
/// restored now: those sessions stay with their agents and saved output, a
/// refresh that never ended this server is dropped, and once nothing is owed
/// the journal goes with every refresh folder. `recorded` is the record on
/// disk now (see Journal). A kept journal is untouched.
fn settle_journal(data: &Path, saved: &Saved, server: &str, owed: &Owed, recorded: Option<&str>) {
    if saved.journal_kept {
        return;
    }
    let mut agents = saved.journal.agents.clone();
    agents.retain(|agent| owed.sessions.iter().any(|session| session.name == agent.session));
    let journal = Journal {
        version: JOURNAL_VERSION,
        server: server.to_string(),
        sessions: Vec::new(),
        pending: owed.sessions.clone(),
        partial: sorted(&owed.partial),
        agents,
        refresh: if owed.sessions.is_empty() { None } else { saved.journal.refresh.clone() },
        recorded: recorded.map(String::from).into_iter().collect(),
    };
    // A journal that already goes with this record is not written again just
    // to forget the other server it names.
    let current = recorded.is_none_or(|server| saved.journal.recorded.iter().any(|entry| entry == server))
        && Journal { recorded: saved.journal.recorded.clone(), ..journal.clone() } == saved.journal;
    if journal.owes_nothing() {
        if store_journal(data, &journal).is_ok() {
            discard_refreshes(&refresh_root(data), None);
        }
    } else if !current {
        let _ = store_journal(data, &journal);
    }
}

/// Records what the server holds after a restore, with the agents just
/// started and the earlier ones of windows that kept theirs. Nothing is
/// recorded when the server stopped answering meanwhile.
fn save_record(tmux: Tmux, data: &Path, saved: &Saved, started: Vec<AgentResume>) {
    let Ok(Some((server, sessions))) = server_snapshot(tmux) else {
        return;
    };
    let mut agents = started;
    for agent in saved.record.iter().flat_map(|record| &record.agents).chain(&saved.journal.agents) {
        if !agents.iter().any(|entry| entry.session == agent.session && entry.window == agent.window) {
            agents.push(AgentResume { only_if_busy: false, ..agent.clone() });
        }
    }
    let _ = store_state(&state_file(data), &sanitize_state(SavedState { server, sessions, agents }));
}

/// Keeps the record current: the server's sessions and the agents detected
/// in their windows (None keeps the ones recorded before). Never overwrites
/// the record of an earlier server whose sessions are missing now; that is
/// reported instead, for restore_lost to bring them back. Nothing is recorded
/// from a server that stopped answering during the listing (it reads as one
/// without sessions). Sessions still owed from earlier stay in the journal;
/// they are retried on launch and whenever the server is replaced, not on
/// every record. Runs with the journal lock held.
pub fn record(tmux: Tmux, data: &Path, agents: Option<Vec<AgentResume>>) -> Result<RecordStatus, String> {
    if let Some(agents) = &agents {
        check_agents(agents)?;
    }
    // The server and its sessions in one tmux call: this runs every few
    // seconds while the app is open.
    let Some((server, live)) = server_snapshot(tmux)? else {
        return Ok(RecordStatus::default());
    };
    let saved = load(data);
    let replaced = saved.replaced(&server);
    let placeholders = if replaced || !saved.journal.pending.is_empty() {
        // Listed in a call of their own, and used only while the same server
        // still answers.
        let (now, placeholders) = server_placeholders(tmux);
        if now.as_deref() != Some(server.as_str()) {
            return Ok(RecordStatus::default());
        }
        placeholders
    } else {
        HashSet::new()
    };
    let owed = owed_sessions(saved.record.as_ref(), &saved.journal, &server, &live, &placeholders);
    if replaced && !owed.sessions.is_empty() {
        return Ok(RecordStatus { restarted: true });
    }
    let agents = match agents {
        Some(agents) => agents,
        None => saved.record.iter().filter(|record| record.server == server).flat_map(|record| record.agents.clone()).collect(),
    };
    let agents = agents.into_iter().map(|agent| AgentResume { only_if_busy: false, ..agent }).collect();
    let state = sanitize_state(SavedState { server: server.clone(), sessions: live, agents });
    if saved.record.as_ref() != Some(&state) {
        store_state(&state_file(data), &state).map_err(|_| String::from("Could not save the session state"))?;
    }
    settle_journal(data, &saved, &server, &owed, Some(&server));
    Ok(RecordStatus::default())
}

/// Recreates what is owed to the running server (see owed_sessions) under
/// their names, windows and folders, with the output a refresh saved for
/// them, and starts their agents. Sessions on the server are never touched,
/// except placeholders standing in for owed ones and sessions owed windows.
/// What fails stays owed with its saved output: the journal is saved before
/// any output is removed, and when it cannot be saved everything stays for
/// the next try. Each session being built is kept in the journal meanwhile
/// (see restore). Runs with the journal lock held.
fn restore_owed(tmux: Tmux, data: &Path, given: Vec<AgentResume>) -> Result<RefreshReport, String> {
    let server = server_identity(tmux).ok_or("The terminal server is not running.")?;
    let saved = load(data);
    let root = refresh_root(data);
    let live = snapshot(tmux)?;
    let placeholders = placeholders(tmux);
    let owed = owed_sessions(saved.record.as_ref(), &saved.journal, &server, &live, &placeholders);
    if owed.sessions.is_empty() {
        // Nothing is owed. A refresh that never replaced this server leaves
        // only output that is still on screen.
        settle_journal(data, &saved, &server, &owed, saved.record.as_ref().map(|record| record.server.as_str()));
        if !saved.journal_kept {
            discard_refreshes(&root, None);
        }
        mark_settled(&server);
        return Ok(RefreshReport::default());
    }
    let mut files = saved.journal.refresh.as_deref().map(|name| load_manifest(&root.join(name))).unwrap_or_default();
    files.retain(|(session, pane), _| owes_pane(&owed.sessions, session, pane));
    // Journaled agents (a refresh detected them moments before it ended the
    // server) keep their own terms; recorded and given ones wait for their
    // program.
    let recorded = saved.record.as_ref().map(|record| record.agents.clone()).unwrap_or_default();
    let agents: Vec<AgentResume> = saved
        .journal
        .agents
        .iter()
        .cloned()
        .chain(with_recorded(Vec::new(), &recorded))
        .chain(given.into_iter().map(|agent| AgentResume { only_if_busy: true, ..agent }))
        .collect();
    let busy: Vec<SavedSession> = live
        .into_iter()
        .filter(|session| owed.partial.contains(&session.name) || !owed.sessions.iter().any(|entry| entry.name == session.name))
        .collect();
    // The journal while sessions are being built: what was owed before, plus
    // for each new session that runs before all its windows exist, the
    // windows it still owes (as one restored partway).
    let mut progress = Journal { version: JOURNAL_VERSION, recorded: stamp(saved.record.as_ref(), None), ..saved.journal.clone() };
    let mut checkpoint = |name: &str, windows: Option<&[SavedWindow]>| {
        if saved.journal_kept {
            return;
        }
        progress.pending.retain(|session| session.name != name);
        progress.partial.retain(|entry| entry != name);
        match windows {
            Some(windows) => {
                progress.pending.push(SavedSession { name: name.to_string(), windows: windows.to_vec() });
                progress.partial.push(name.to_string());
            }
            None => {
                if let Some(before) = saved.journal.pending.iter().find(|session| session.name == name) {
                    progress.pending.push(before.clone());
                    if saved.journal.partial.iter().any(|entry| entry == name) {
                        progress.partial.push(name.to_string());
                    }
                }
            }
        }
        let _ = store_journal(data, &progress);
    };
    // Whether a session of an owed name may be replaced is decided when the
    // name is found taken, not from the listing above.
    let outcome = restore(tmux, &owed, &files, &agents, &busy, &|name| placeholder_now(tmux, name), &mut checkpoint);
    if !saved.journal_kept {
        // Saved output follows a session brought back under a new name.
        let keep: Scrollback = files
            .iter()
            .map(|((session, pane), file)| ((outcome.name_of(session).to_string(), pane.clone()), file.clone()))
            .filter(|((session, pane), _)| owes_pane(&outcome.pending, session, pane))
            .collect();
        let folder = saved.journal.refresh.clone().filter(|_| !keep.is_empty());
        let partial: HashSet<String> = outcome.partial.iter().cloned().collect();
        let journal = sanitize_journal(Journal {
            version: JOURNAL_VERSION,
            server: server.clone(),
            sessions: Vec::new(),
            pending: outcome.pending.clone(),
            partial: sorted(&partial),
            agents: outcome.pending_agents.clone(),
            refresh: folder.clone(),
            // save_record below records this server.
            recorded: stamp(saved.record.as_ref(), Some(&server)),
        });
        if store_journal(data, &journal).is_ok() {
            wait_for_shown(&outcome.shown);
            match &folder {
                Some(name) => {
                    if keep_only(&root.join(name), &keep).is_ok() {
                        discard_refreshes(&root, Some(name));
                    }
                }
                None => discard_refreshes(&root, None),
            }
        }
    }
    save_record(tmux, data, &saved, outcome.started);
    mark_settled(&server);
    Ok(outcome.report)
}

/// Recreates local sessions a replaced server lost, or that an interrupted
/// refresh or a failed restore still owes, and starts the agents recorded in
/// them, or else the given ones, where their pane ran that agent.
pub fn restore_lost(tmux: Tmux, data: &Path, agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    check_agents(&agents)?;
    restore_owed(tmux, data, agents)
}

/// The journal as it will be read back, refused unless it still lists every
/// session and pane: a refresh never ends a session it cannot bring back.
fn complete_journal(journal: Journal) -> Result<Journal, String> {
    let count = journal.sessions.len() + journal.pending.len();
    if count > MAX_SAVED_SESSIONS {
        return Err(format!(
            "A refresh can bring back at most {MAX_SAVED_SESSIONS} sessions, and {count} would need to come back. Close some sessions, then refresh again. Nothing was restarted."
        ));
    }
    let panes = |journal: &Journal| panes_of(&journal.sessions).chain(panes_of(&journal.pending)).count();
    let checked = sanitize_journal(journal.clone());
    if checked.sessions.len() != journal.sessions.len() || checked.pending.len() != journal.pending.len() || panes(&checked) != panes(&journal) {
        return Err("Some sessions could not be saved for a refresh. Nothing was restarted.".into());
    }
    Ok(checked)
}

/// Saves the local sessions with their output, restarts the server and
/// restores them, with the agents given (detected now) or else recorded.
/// What is still owed from earlier comes back too, with the output an
/// interrupted refresh saved for it. Runs with the journal lock held.
///
/// Nothing is ended before the record, the journal (see Journal) and the
/// output manifest are on disk, and only when the journal lists every session
/// the restart ends. A failed restart leaves them for the next restore.
pub fn refresh_with(tmux: Tmux, data: &Path, agents: Vec<AgentResume>, restart: &dyn Fn() -> Result<(), String>) -> Result<RefreshReport, String> {
    check_agents(&agents)?;
    let root = refresh_root(data);
    let saved = load(data);
    if saved.journal_kept {
        return Err(KEPT_JOURNAL.into());
    }
    let live = snapshot(tmux)?;
    let server = server_identity(tmux).unwrap_or_default();
    let placeholders = placeholders(tmux);
    let owed = owed_sessions(saved.record.as_ref(), &saved.journal, &server, &live, &placeholders);
    // Everything running ends, except placeholders standing in for sessions
    // owed whole (those come back from the journal instead).
    let ending = |sessions: Vec<SavedSession>| -> Vec<SavedSession> {
        sessions
            .into_iter()
            .filter(|session| owed.partial.contains(&session.name) || !owed.sessions.iter().any(|entry| entry.name == session.name))
            .collect()
    };
    let recorded = saved.record.as_ref().map(|record| record.agents.clone()).unwrap_or_default();
    // Detected agents first, then journaled ones with their own terms, then
    // recorded ones waiting for their program.
    let agents: Vec<AgentResume> = agents.into_iter().chain(saved.journal.agents.iter().cloned()).chain(with_recorded(Vec::new(), &recorded)).collect();
    // An earlier refresh that never finished: its output still belongs to
    // what is owed now.
    let earlier = saved.journal.refresh.clone();
    let mut earlier_files = earlier.as_deref().map(|name| load_manifest(&root.join(name))).unwrap_or_default();
    earlier_files.retain(|(session, pane), _| owes_pane(&owed.sessions, session, pane));
    // Other folders are left from refreshes that finished or never ended
    // their server; the earlier one stays until this journal replaces it.
    discard_refreshes(&root, earlier.as_deref());
    let suffix = crate::agent::random_hex(8).ok_or("Could not prepare the session refresh")?;
    let directory = root.join(&suffix);
    private_directory(&root)
        .and_then(|_| private_directory(&directory))
        .map_err(|_| "Could not prepare a private folder for the session refresh")?;
    let mut folder_named = false;
    let journaled = (|| -> Result<(), String> {
        let folder_named = &mut folder_named;
        let unsaved = || String::from("Could not save the sessions before refreshing. Nothing was restarted.");
        let mut next = 0;
        let mut files = save_scrollback(tmux, &ending(live), &directory, &mut next, &Scrollback::new());
        // Saving output takes a moment; whatever opened meanwhile ends too,
        // so it is listed (with its output) as well.
        let latest = ending(snapshot(tmux)?);
        let more = save_scrollback(tmux, &latest, &directory, &mut next, &files);
        files.extend(more);
        files.extend(adopt_scrollback(earlier_files, &directory, next));
        let journal = complete_journal(Journal {
            version: JOURNAL_VERSION,
            server: server.clone(),
            sessions: latest,
            pending: owed.sessions.clone(),
            partial: sorted(&owed.partial),
            agents,
            refresh: Some(suffix.clone()),
            // The record below is written right after the journal.
            recorded: stamp(saved.record.as_ref(), Some(&server)),
        })?;
        write_manifest(&directory, &files).map_err(|_| unsaved())?;
        // Older versions read only the record: should one run before this
        // refresh is restored, it still brings the sessions back.
        let record = sanitize_state(SavedState { server: server.clone(), sessions: journal.sessions.clone(), agents: recorded.clone() });
        store_journal(data, &journal).map_err(|_| unsaved())?;
        if store_state(&state_file(data), &record).is_err() {
            // Back to the journal from before, which never named this folder.
            // Should that fail too, the folder stays: the journal names it.
            *folder_named = store_journal(data, &saved.journal).is_err();
            return Err(unsaved());
        }
        Ok(())
    })();
    if let Err(error) = journaled {
        if !folder_named {
            let _ = fs::remove_dir_all(&directory);
        }
        return Err(error);
    }
    // The journal now holds the earlier output too.
    discard_refreshes(&root, Some(&suffix));
    restart().map_err(|error| format!("{}. The sessions are saved and come back once the terminal server runs again.", error.trim_end_matches('.')))?;
    restore_owed(tmux, data, Vec::new())
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
    exclusively(&data, Duration::ZERO, || {
        refresh_with(&local_client, &data, agents, &|| {
            crate::local_tmux::restart().map_err(|error| format!("The terminal server could not restart: {error}"))
        })
    })
}

#[cfg(not(target_os = "macos"))]
fn refresh_blocking(_data: PathBuf, _agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    Err("Refreshing sessions is only available in the macOS app.".into())
}

#[cfg(target_os = "macos")]
fn restore_blocking(data: PathBuf, agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    exclusively(&data, RESTORE_WAIT, || restore_lost(&local_client, &data, agents))
}

#[cfg(not(target_os = "macos"))]
fn restore_blocking(_data: PathBuf, _agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    Ok(RefreshReport::default())
}

#[cfg(target_os = "macos")]
fn record_blocking(data: PathBuf, agents: Option<Vec<AgentResume>>) -> Result<RecordStatus, String> {
    // A server that failed to start or ended meanwhile is started again; its
    // lost sessions are then reported for restoring.
    crate::local_tmux::ensure_running();
    // Skipped while a refresh or restore runs in any app copy: it records
    // the sessions itself.
    let Some(_lock) = lock_journal(&data, Duration::ZERO).map_err(|_| String::from("Could not lock the saved sessions."))? else {
        return Ok(RecordStatus::default());
    };
    record(&local_client, &data, agents)
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
/// them. Refuses while another refresh or restore is running.
#[tauri::command]
pub async fn local_tmux_refresh_sessions(app: tauri::AppHandle, agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || refresh_blocking(data, agents))
        .await
        .map_err(|error| error.to_string())?
}

/// Recreates local sessions a replaced server lost; `agents` are the ones to
/// fall back on where none was recorded. Waits for a refresh or restore that
/// is running (in any app copy) to finish first.
#[tauri::command]
pub async fn local_tmux_restore_sessions(app: tauri::AppHandle, agents: Vec<AgentResume>) -> Result<RefreshReport, String> {
    let data = app_data(&app)?;
    tauri::async_runtime::spawn_blocking(move || restore_blocking(data, agents))
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
        let steps = restore_commands(&session, 0, &launch, &saved, &home, false);
        let commands: Vec<Vec<String>> = steps.iter().map(|step| step.args.clone()).collect();
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
        // Only the steps that build a window count as failures; layout and
        // focus are best effort.
        let kinds: Vec<(usize, StepKind)> = steps.iter().map(|step| (step.window, step.kind)).collect();
        assert_eq!(kinds, [
            (0, StepKind::Create),
            (0, StepKind::Required),
            (0, StepKind::Required),
            (0, StepKind::Optional),
            (0, StepKind::Required),
            (0, StepKind::Optional),
            (0, StepKind::Optional),
            (0, StepKind::Optional),
            (1, StepKind::Create),
            (1, StepKind::Optional),
        ]);

        let custom = Launch { shell: "/bin/bash".into(), default_command: Some("exec fish".into()) };
        let single = SavedSession { name: "s".into(), windows: vec![session.windows[1].clone()] };
        let commands: Vec<Vec<String>> = restore_commands(&single, 5, &custom, &|_| None, &home, false).into_iter().map(|step| step.args).collect();
        assert_eq!(&commands[0][commands[0].len() - 3..], ["/bin/bash", "-c", "exec fish"]);
        assert!(!commands.iter().any(|command| command[0] == "move-window"), "a window already at the base index stays");

        // Windows still missing from a running session are added to it,
        // leaving its focus alone.
        let heads: Vec<String> = restore_commands(&session, 0, &launch, &saved, &home, true).iter().map(|step| step.args[..4.min(step.args.len())].join(" ")).collect();
        assert_eq!(heads[0], "new-window -d -t =work:2");
        assert!(!heads.iter().any(|head| head.starts_with("new-session") || head.starts_with("move-window") || head.starts_with("select-window")), "{heads:?}");
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
        let all = |_: &str, _: u32| true;
        let targets = |agents: &[AgentResume]| agent_targets(&sessions, agents, &[], &all).0;
        let found = targets(&[agent("work", 0, true), agent("work", 0, false), agent("work", 1, true), agent("gone", 0, false), agent("work", 9, false)]);
        assert_eq!(found, [AgentTarget { session: "work".into(), window: 0, target: "=work:0.1".into(), pane: "%1".into(), command: "claude -c --permission-mode manual".into() }]);
        // A detected agent resumes even where the pane now shows its shell.
        assert_eq!(targets(&[agent("work", 1, false)])[0].target, "=work:1.0");
        // Without a window, the session's active one.
        let active = AgentResume { session: "work".into(), window: None, command: "codex resume --last --sandbox workspace-write --ask-for-approval on-request".into(), only_if_busy: false };
        assert_eq!(targets(&[active])[0].target, "=work:0.1");
        // Nothing goes to a window that was not created again.
        assert!(agent_targets(&sessions, &[agent("work", 0, false)], &[], &|_, window| window != 0).0.is_empty());
    }

    #[test]
    fn an_agent_continues_its_last_conversation_in_one_pane_per_folder() {
        let session = |name: &str, cwd: &str| SavedSession {
            name: name.into(),
            windows: vec![SavedWindow { index: 0, active: true, name: None, layout: String::new(), width: 80, height: 24, panes: vec![pane(0, true, "claude", cwd)] }],
        };
        let sessions = vec![session("a", "/repo"), session("b", "/repo"), session("c", "/other"), session("d", "/repo")];
        let agent = |name: &str, command: &str| AgentResume { session: name.into(), window: Some(0), command: command.into(), only_if_busy: false };
        let claude = "claude -c --permission-mode manual";
        let codex = "codex resume --last --sandbox workspace-write --ask-for-approval on-request";
        let all = |_: &str, _: u32| true;
        // Another mode of the same agent is the same conversation; another
        // agent in that folder has a conversation of its own.
        let agents = [agent("a", claude), agent("b", "claude -c --permission-mode plan"), agent("c", claude), agent("d", codex)];
        let (targets, skipped) = agent_targets(&sessions, &agents, &[], &all);
        assert_eq!(targets.iter().map(|target| target.session.as_str()).collect::<Vec<_>>(), ["a", "c", "d"]);
        assert_eq!(skipped.iter().map(|entry| entry.session.as_str()).collect::<Vec<_>>(), ["b"]);
        // A pane left running that already runs the agent in that folder
        // keeps its conversation; a script interpreter there does not count.
        let running = vec![session("live", "/repo")];
        let (targets, skipped) = agent_targets(&sessions, &[agent("a", claude)], &running, &all);
        assert!(targets.is_empty());
        assert_eq!(skipped[0].session, "a");
        let mut node = session("live", "/repo");
        node.windows[0].panes[0].command = "node".into();
        assert_eq!(agent_targets(&sessions, &[agent("a", claude)], &[node], &all).0.len(), 1);
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
            // Tests only ever run their own server, never the app's.
            assert!(socket.starts_with("/private/tmp") && socket.parent().unwrap().file_name().unwrap().to_string_lossy().starts_with("pzza-refresh-test-"));
            #[cfg(target_os = "macos")]
            assert_ne!(socket, crate::local_tmux::socket_path());
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
    fn one_chained_call_lists_what_separate_calls_list() {
        let server = Server::new();
        let client = || server.client();
        assert_eq!(server_snapshot(&client), Ok(None), "no server running");
        assert_eq!(server_placeholders(&client), (None, HashSet::new()));
        server.start("1");
        let tmux = |args: &[&str]| server.read(args);
        tmux(&["new-session", "-d", "-s", "work one", "-x", "100", "-y", "30"]);
        tmux(&["split-window", "-d", "-h", "-t", "=work one:1"]);
        tmux(&["new-window", "-d", "-t", "=work one:4", "-n", "logs"]);
        let (identity, sessions) = server_snapshot(&client).unwrap().expect("the server answers");
        assert_eq!(Some(identity.clone()), server_identity(&client));
        assert_eq!(sessions, snapshot(&client).unwrap());
        assert_eq!(sessions.iter().map(|session| session.name.as_str()).collect::<Vec<_>>(), ["placeholder", "work one"]);
        assert_eq!(sessions[1].windows.len(), 2);
        assert_eq!(sessions[1].windows[0].panes.len(), 2);
        assert_eq!(server_placeholders(&client), (Some(identity), placeholders(&client)));
        // A listing that fails after the server answered is an error, never
        // a server without sessions.
        let (sections, failed) = read_chained(&client, &[&["display-message", "-p", "#{pid}"], &["list-windows", "-t", "=missing"], &["list-sessions"]]);
        assert_eq!(sections.len(), 1);
        assert!(failed.is_some_and(|reason| reason.contains("missing")));
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
        let files = save_scrollback(&client, &sessions, &scrollback, &mut 0, &Scrollback::new());
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
        let (report, _) = {
            let owed = Owed { sessions: sessions.clone(), partial: HashSet::new() };
            let outcome = restore(&client, &owed, &files, &agents, &[], &|_| true, &mut |_, _| {});
            assert!(outcome.pending.is_empty() && outcome.partial.is_empty());
            wait_for_shown(&outcome.shown);
            assert!(outcome.shown.iter().all(|link| !link.exists()), "each pane prints and deletes its own link");
            (outcome.report, outcome.started)
        };
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
        assert!(files.values().all(|file| file.exists()), "the saved output stays until it is discarded");
    }

    #[test]
    fn a_refresh_refuses_to_run_twice() {
        let server = Server::new();
        let data = server.directory.join("data");
        let nested = exclusively(&data, Duration::ZERO, || Ok(exclusively(&data, Duration::ZERO, || Ok(()))));
        assert_eq!(nested.unwrap().unwrap_err(), "Sessions are already refreshing. Wait for it to finish.");
        // A concurrent test fork can hold the descriptor for a moment before exec.
        assert!(exclusively(&data, Duration::from_secs(1), || Ok(())).is_ok(), "the lock is released afterwards");
        // A record (in this or another app copy) waits its turn too.
        let held = lock_journal(&data, Duration::from_secs(1)).unwrap().unwrap();
        assert!(lock_journal(&data, Duration::from_millis(200)).unwrap().is_none());
        drop(held);
        assert!(lock_journal(&data, Duration::from_secs(1)).unwrap().is_some());
        let lock = fs::metadata(state_directory(&data).join("journal.lock")).unwrap();
        assert_eq!(lock.mode() & 0o777, 0o600);
    }

    #[test]
    fn a_refresh_waits_out_a_record_but_refuses_a_running_restore() {
        let directory = PathBuf::from(format!("/private/tmp/pzza-refresh-wait-test-{}", crate::agent::random_hex(6).unwrap()));
        let data = directory.join("data");
        // A periodic record holds only the journal, for a moment.
        let record = lock_journal(&data, Duration::from_secs(1)).unwrap().unwrap();
        let (taken, released) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            taken.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            drop(record);
        });
        released.recv().unwrap();
        let start = Instant::now();
        assert!(exclusively(&data, Duration::ZERO, || Ok(())).is_ok(), "a record is waited out");
        assert!(start.elapsed() >= Duration::from_millis(250));
        worker.join().unwrap();
        // A refresh or restore running holds the refresh lock: refused at once.
        let running = lock_file(&data, "refresh.lock", Duration::from_secs(1)).unwrap().unwrap();
        let start = Instant::now();
        assert_eq!(exclusively(&data, Duration::ZERO, || Ok(())).unwrap_err(), BUSY);
        assert!(start.elapsed() < Duration::from_secs(1));
        drop(running);
        let lock = fs::metadata(state_directory(&data).join("refresh.lock")).unwrap();
        assert_eq!(lock.mode() & 0o777, 0o600);
        fs::remove_dir_all(&directory).unwrap();
    }

    #[test]
    fn a_quit_waits_for_journal_work_and_then_holds_the_journal() {
        let directory = PathBuf::from(format!("/private/tmp/pzza-quit-hold-test-{}", crate::agent::random_hex(6).unwrap()));
        let data = directory.join("data");
        // A refresh holds the journal for a moment; the quit waits it out.
        let refresh = lock_journal(&data, Duration::from_secs(1)).unwrap().unwrap();
        let (taken, released) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            taken.send(()).unwrap();
            std::thread::sleep(Duration::from_millis(300));
            drop(refresh);
        });
        released.recv().unwrap();
        let start = Instant::now();
        let hold = hold_journal(&data, Duration::from_secs(10)).expect("the quit gets the journal once the refresh ends");
        assert!(start.elapsed() >= Duration::from_millis(250), "the quit waited for the refresh");
        worker.join().unwrap();
        // Nothing starts on the journal while the quit holds it.
        assert!(lock_journal(&data, Duration::ZERO).unwrap().is_none());
        // A quit that waits longer than its limit goes on without the journal.
        let start = Instant::now();
        assert!(hold_journal(&data, Duration::from_millis(200)).is_none());
        assert!(start.elapsed() < Duration::from_secs(2));
        // Kept until the process ends, the hold outlives its value.
        hold.keep_until_exit();
        assert!(lock_journal(&data, Duration::from_millis(100)).unwrap().is_none());
        fs::remove_dir_all(&directory).unwrap();
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
        let state = SavedState { server: "1 100".into(), sessions: vec![saved("api"), saved("notes"), saved("keep")], ..SavedState::default() };
        let live = vec![saved("notes"), saved("keep")];
        let none = Journal::default();
        let names = |owed: Owed| owed.sessions.into_iter().map(|session| session.name).collect::<Vec<_>>();
        assert!(owed_sessions(Some(&state), &none, "1 100", &[], &HashSet::new()).sessions.is_empty(), "the same server lost nothing");
        assert!(owed_sessions(None, &none, "2 200", &[], &HashSet::new()).sessions.is_empty());
        assert_eq!(names(owed_sessions(Some(&state), &none, "2 200", &live, &HashSet::new())), ["api"]);
        assert_eq!(names(owed_sessions(Some(&state), &none, "2 200", &live, &HashSet::from(["notes".to_string()]))), ["api", "notes"]);
        // A refresh's journal owes its sessions once its server is gone,
        // whatever the record says by then.
        let journal = Journal { version: JOURNAL_VERSION, server: "1 100".into(), sessions: vec![saved("api"), saved("lost")], ..Journal::default() };
        let emptied = SavedState { server: "2 200".into(), ..SavedState::default() };
        assert!(owed_sessions(Some(&emptied), &journal, "1 100", &[saved("api"), saved("lost")], &HashSet::new()).sessions.is_empty());
        assert_eq!(names(owed_sessions(Some(&emptied), &journal, "2 200", &[saved("api")], &HashSet::new())), ["lost"]);
    }

    #[test]
    fn pending_sessions_stay_owed_until_one_of_their_name_is_in_use() {
        let mut full = saved("notes");
        full.windows[0].layout = "full".into();
        let state = SavedState { server: "1 100".into(), sessions: vec![saved("api"), saved("notes")], ..SavedState::default() };
        let journal = Journal { version: JOURNAL_VERSION, server: "1 100".into(), pending: vec![saved("old"), full], ..Journal::default() };
        let names = |owed: &Owed| owed.sessions.iter().map(|session| session.name.clone()).collect::<Vec<_>>();
        // The same server still owes its pending sessions, and only those.
        let owed = owed_sessions(Some(&state), &journal, "1 100", &[saved("api")], &HashSet::new());
        assert_eq!(names(&owed), ["old", "notes"]);
        // A placeholder does not settle a debt; a session in use does.
        let owed = owed_sessions(Some(&state), &journal, "1 100", &[saved("old"), saved("notes")], &HashSet::from(["notes".to_string()]));
        assert_eq!(names(&owed), ["notes"]);
        // A new server owes both, in order, the pending copy winning a name
        // recorded twice (the recorded one stood in for it).
        let owed = owed_sessions(Some(&state), &journal, "2 200", &[], &HashSet::new());
        assert_eq!(names(&owed), ["api", "notes", "old"]);
        assert_eq!(owed.sessions[1].windows[0].layout, "full");
        // Pending sessions are checked like recorded ones, and keep their agents.
        let agent = |session: &str| AgentResume { session: session.into(), window: Some(0), command: "claude -c --permission-mode manual".into(), only_if_busy: false };
        let clean = sanitize_journal(Journal {
            pending: vec![saved("old"), saved("old"), saved("pzza-v-x"), saved("bad\nname")],
            partial: vec!["old".into(), "old".into(), "gone".into()],
            agents: vec![agent("old"), agent("gone"), agent("old")],
            refresh: Some("../escape".into()),
            ..journal.clone()
        });
        assert_eq!(clean.pending.iter().map(|session| session.name.as_str()).collect::<Vec<_>>(), ["old"]);
        assert_eq!(clean.partial, ["old"]);
        assert_eq!(clean.agents, [agent("old")]);
        assert_eq!(clean.refresh, None);
        assert_eq!(sanitize_journal(Journal { refresh: Some("0123456789abcdef".into()), ..journal }).refresh.as_deref(), Some("0123456789abcdef"));
    }

    #[test]
    fn a_journal_owes_only_what_an_older_version_never_saw() {
        let journal = Journal {
            version: JOURNAL_VERSION,
            server: "1 100".into(),
            sessions: vec![saved("closed"), saved("kept")],
            pending: vec![saved("lost"), saved("named"), saved("half")],
            partial: vec!["half".into()],
            agents: vec![
                AgentResume { session: "lost".into(), window: Some(0), command: "claude -c --permission-mode manual".into(), only_if_busy: false },
                AgentResume { session: "closed".into(), window: Some(0), command: "claude -c --permission-mode manual".into(), only_if_busy: false },
            ],
            refresh: Some("0123456789abcdef".into()),
            recorded: vec!["1 100".into(), "2 200".into()],
        };
        let record = |server: &str, names: &[&str]| SavedState { server: server.into(), sessions: names.iter().map(|name| saved(name)).collect(), agents: Vec::new() };
        // This version wrote the record, or no record at all: nothing changes.
        assert!(!outdated_by_record(&journal, Some(&record("1 100", &[]))));
        assert!(!outdated_by_record(&journal, Some(&record("2 200", &[]))));
        assert!(!outdated_by_record(&journal, None));
        // A journal written before the stamp is never settled this way.
        assert!(!outdated_by_record(&Journal { recorded: Vec::new(), ..journal.clone() }, Some(&record("9 900", &[]))));
        // An older version recorded server 3 since: it restored "kept" and
        // the user closed "closed" there. "named" is a name it had in use.
        let newer = record("3 300", &["kept", "named", "half"]);
        assert!(outdated_by_record(&journal, Some(&newer)));
        let settled = settle_outdated(journal.clone(), &newer);
        assert!(settled.sessions.is_empty(), "the refresh's sessions were the older version's to restore");
        assert_eq!(settled.pending.iter().map(|session| session.name.as_str()).collect::<Vec<_>>(), ["lost"], "a session it never saw stays owed");
        assert!(settled.partial.is_empty());
        assert_eq!(settled.agents.iter().map(|agent| agent.session.as_str()).collect::<Vec<_>>(), ["lost"]);
        assert_eq!(settled.recorded, ["3 300"]);
        assert_eq!(settled.refresh.as_deref(), Some("0123456789abcdef"), "its saved output stays with it");
        // A closed session is not owed to any later server either.
        let owed = owed_sessions(Some(&newer), &settled, "4 400", &[], &HashSet::new());
        let mut names: Vec<String> = owed.sessions.into_iter().map(|session| session.name).collect();
        names.sort();
        assert_eq!(names, ["half", "kept", "lost", "named"], "only the newer record and the never-seen session");
    }

    #[test]
    fn loading_settles_a_journal_an_older_version_outlived() {
        let directory = PathBuf::from(format!("/private/tmp/pzza-outdated-test-{}", crate::agent::random_hex(6).unwrap()));
        let data = directory.join("data");
        let journal = Journal {
            version: JOURNAL_VERSION,
            server: "1 100".into(),
            sessions: vec![saved("closed")],
            pending: vec![saved("lost")],
            recorded: vec!["1 100".into()],
            ..Journal::default()
        };
        store_journal(&data, &journal).unwrap();
        store_state(&state_file(&data), &SavedState { server: "1 100".into(), sessions: vec![saved("closed")], agents: Vec::new() }).unwrap();
        assert_eq!(load(&data).journal, journal, "the record this version wrote");
        // An older version restored "closed", the user closed it there, and
        // it recorded its own server.
        store_state(&state_file(&data), &SavedState { server: "2 200".into(), sessions: vec![saved("other")], agents: Vec::new() }).unwrap();
        let loaded = load(&data).journal;
        assert!(loaded.sessions.is_empty());
        assert_eq!(loaded.pending, [saved("lost")]);
        let stored: Journal = serde_json::from_str(&fs::read_to_string(journal_file(&data)).unwrap()).unwrap();
        assert_eq!(stored, loaded, "settled on disk too");
        // A journal written before the stamp is read as it is.
        let unstamped = r#"{"version":1,"server":"1 1","sessions":[],"pending":[],"partial":[],"agents":[],"refresh":null}"#;
        fs::write(journal_file(&data), unstamped).unwrap();
        assert!(!load(&data).journal_kept);
        fs::remove_dir_all(&directory).unwrap();
    }

    fn window(index: u32, id: &str) -> SavedWindow {
        SavedWindow { index, active: false, name: None, layout: "L".into(), width: 80, height: 24, panes: vec![SavedPane { id: id.into(), ..pane(0, true, "zsh", "/tmp") }] }
    }

    #[test]
    fn a_session_restored_partway_is_owed_its_missing_windows() {
        let missing = SavedSession { name: "work".into(), windows: vec![window(3, "%3"), window(5, "%5")] };
        let journal = Journal { version: JOURNAL_VERSION, server: "2 200".into(), pending: vec![missing], partial: vec!["work".into()], ..Journal::default() };
        let live = |indices: &[u32]| SavedSession { name: "work".into(), windows: indices.iter().map(|index| window(*index, "%9")).collect() };
        let indices = |owed: &Owed| owed.sessions.iter().flat_map(|session| session.windows.iter().map(|window| window.index)).collect::<Vec<_>>();
        // Added to the running session where its index is still free.
        let owed = owed_sessions(None, &journal, "2 200", &[live(&[0, 5])], &HashSet::new());
        assert_eq!(indices(&owed), [3]);
        assert!(owed.partial.contains("work"));
        // Nothing once all are there, or once the session was closed.
        assert!(owed_sessions(None, &journal, "2 200", &[live(&[0, 3, 5])], &HashSet::new()).sessions.is_empty());
        assert!(owed_sessions(None, &journal, "2 200", &[], &HashSet::new()).sessions.is_empty());
        assert!(owed_sessions(None, &journal, "2 200", &[live(&[0])], &HashSet::from(["work".to_string()])).sessions.is_empty());
        // When the server ended again, the recorded part and the missing
        // windows come back as one session.
        let record = SavedState { server: "2 200".into(), sessions: vec![live(&[0])], agents: Vec::new() };
        let owed = owed_sessions(Some(&record), &journal, "3 300", &[], &HashSet::new());
        assert_eq!(indices(&owed), [0, 3, 5]);
        assert!(owed.partial.is_empty());
        assert!(owes_pane(&owed.sessions, "work", "%5") && !owes_pane(&owed.sessions, "work", "%7"));
    }

    #[test]
    fn a_refresh_never_ends_a_session_its_journal_cannot_hold() {
        let journal = |count: usize| Journal { version: JOURNAL_VERSION, sessions: (0..count).map(|number| saved(&format!("s{number}"))).collect(), ..Journal::default() };
        assert_eq!(complete_journal(journal(MAX_SAVED_SESSIONS)).unwrap().sessions.len(), MAX_SAVED_SESSIONS);
        assert!(complete_journal(journal(MAX_SAVED_SESSIONS + 1)).unwrap_err().contains("at most 200"));
        let mut unsaved = journal(2);
        unsaved.sessions[1].windows[0].layout = "bad\nlayout".into();
        assert_eq!(complete_journal(unsaved).unwrap_err(), "Some sessions could not be saved for a refresh. Nothing was restarted.");
    }

    #[test]
    fn a_refresh_manifest_is_trusted_only_as_far_as_it_checks_out() {
        use std::os::unix::fs::symlink;
        let server = Server::new();
        let root = server.directory.join("session-refresh");
        let directory = root.join("0123456789abcdef");
        private_directory(&directory).unwrap();
        let outside = server.directory.join("outside.txt");
        fs::write(&outside, "secret").unwrap();
        fs::write(directory.join("0.txt"), "kept").unwrap();
        fs::write(directory.join("1.txt"), "doubled").unwrap();
        symlink(&outside, directory.join("2.txt")).unwrap();
        fs::create_dir(directory.join("3.txt")).unwrap();
        fs::write(directory.join("4.txt"), vec![b'x'; (SCROLLBACK_LIMIT + 1) as usize]).unwrap();
        let entry = |session: &str, pane: &str, file: &str| serde_json::json!({ "session": session, "pane": pane, "file": file });
        let manifest = |panes: Vec<serde_json::Value>| fs::write(directory.join(MANIFEST), serde_json::json!({ "panes": panes }).to_string()).unwrap();
        manifest(vec![
            entry("work", "%1", "0.txt"),
            entry("work", "%1", "1.txt"),
            entry("work", "%2", "2.txt"),
            entry("work", "%3", "3.txt"),
            entry("work", "%4", "4.txt"),
            entry("work", "%5", "../outside.txt"),
            entry("work", "%6", outside.to_str().unwrap()),
            entry("work", "%7", "missing.txt"),
            entry("work", "7", "0.txt"),
            entry("bad\nname", "%8", "0.txt"),
            entry("pzza-v-view", "%9", "0.txt"),
        ]);
        let files = load_manifest(&directory);
        assert_eq!(files.len(), 1, "{files:?}");
        assert_eq!(files[&("work".to_string(), "%1".to_string())], directory.join("0.txt"));

        // An unknown field or too many entries discards the whole manifest.
        fs::write(directory.join(MANIFEST), r#"{"panes":[],"extra":1}"#).unwrap();
        assert!(load_manifest(&directory).is_empty());
        manifest((0..=MAX_MANIFEST_PANES).map(|_| entry("work", "%1", "0.txt")).collect());
        assert!(load_manifest(&directory).is_empty());
        // A linked manifest is not followed.
        let elsewhere = server.directory.join("manifest.json");
        fs::write(&elsewhere, serde_json::json!({ "panes": [entry("work", "%1", "0.txt")] }).to_string()).unwrap();
        fs::remove_file(directory.join(MANIFEST)).unwrap();
        symlink(&elsewhere, directory.join(MANIFEST)).unwrap();
        assert!(load_manifest(&directory).is_empty());
        fs::remove_file(directory.join(MANIFEST)).unwrap();
        fs::copy(&elsewhere, directory.join(MANIFEST)).unwrap();
        assert_eq!(load_manifest(&directory).len(), 1);
        // A folder others can read, or a linked folder, is not trusted.
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o755)).unwrap();
        assert!(load_manifest(&directory).is_empty());
        fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
        let linked = root.join("fedcba9876543210");
        symlink(&directory, &linked).unwrap();
        assert!(load_manifest(&linked).is_empty());

        // Discarding removes the links, never what they point at.
        discard_refreshes(&root, None);
        assert!(!root.exists());
        assert_eq!(fs::read_to_string(&outside).unwrap(), "secret");
        assert!(elsewhere.exists());
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
            ..SavedState::default()
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
        let data = server.directory.join("data");
        let path = state_file(&data);
        let detected = vec![AgentResume { session: "api".into(), window: Some(3), command: "claude -c --permission-mode plan".into(), only_if_busy: false }];
        assert_eq!(record(&client, &data, Some(detected)).unwrap(), RecordStatus { restarted: false });
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
        assert_eq!(record(&client, &data, None).unwrap(), RecordStatus { restarted: true });
        assert_eq!(fs::read(&path).unwrap(), recorded, "the lost sessions stay recorded until restored");

        let report = restore_lost(&client, &data, Vec::new()).unwrap();
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
        let again = restore_lost(&client, &data, Vec::new()).unwrap();
        assert!(again.restored.is_empty() && again.failed.is_empty());
        assert_eq!(tmux(&["list-sessions", "-F", "#{session_name}"]), sessions);
        assert_eq!(record(&client, &data, None).unwrap(), RecordStatus { restarted: false });
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
        record(&client, &data, Some(detected)).unwrap();

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
        assert!(!refresh_root(&data).exists(), "saved output is deleted after restoring");
        assert_eq!(record(&client, &data, None).unwrap(), RecordStatus { restarted: false }, "the refresh recorded the new server");
    }

    // A refresh that dies right after ending the server: "lost" was lost by
    // an earlier server, "work" and "notes" have output on the current one.
    // Returns the app data folder; no server runs afterwards.
    fn interrupted_refresh(server: &Server) -> PathBuf {
        let tmux = |args: &[&str]| server.read(args);
        let client = || server.client();
        let data = server.directory.join("data");
        let folder = folders(server, &["work", "notes", "lost"]);
        server.start("0");
        tmux(&["new-session", "-d", "-s", "lost", "-c", &folder[2]]);
        tmux(&["kill-session", "-t", "=placeholder"]);
        record(&client, &data, None).unwrap();
        let _ = server.client().arg("kill-server").output();

        server.start("0");
        tmux(&["new-session", "-d", "-s", "work", "-x", "100", "-y", "30", "-c", &folder[0]]);
        tmux(&["split-window", "-d", "-h", "-t", "=work:0", "-c", &folder[0]]);
        tmux(&["new-session", "-d", "-s", "notes", "-c", &folder[1]]);
        tmux(&["new-window", "-d", "-t", "=notes:1", "-c", &folder[1]]);
        tmux(&["kill-session", "-t", "=placeholder"]);
        tmux(&["send-keys", "-t", "=work:0.0", "echo saved-work-left", "Enter"]);
        tmux(&["send-keys", "-t", "=work:0.1", "echo saved-work-right", "Enter"]);
        tmux(&["send-keys", "-t", "=notes:0", "echo saved-notes", "Enter"]);
        server.wait_for("=work:0.0", "saved-work-left");
        server.wait_for("=work:0.1", "saved-work-right");
        server.wait_for("=notes:0", "saved-notes");
        let identity = server_identity(&client).unwrap();

        let ended = || {
            let _ = server.client().arg("kill-server").output();
            Err(String::from("The app was stopped"))
        };
        assert_eq!(refresh_with(&client, &data, Vec::new(), &ended).unwrap_err(), "The app was stopped. The sessions are saved and come back once the terminal server runs again.");
        // The journal names the ended server and everything to bring back.
        let journal = load(&data).journal;
        assert_eq!(journal.server, identity);
        assert_eq!(journal.sessions.iter().map(|session| session.name.as_str()).collect::<Vec<_>>(), ["notes", "work"]);
        assert_eq!(journal.pending.iter().map(|session| session.name.as_str()).collect::<Vec<_>>(), ["lost"]);
        let directory = refresh_root(&data).join(journal.refresh.as_deref().unwrap());
        let files = load_manifest(&directory);
        for (session, window, pane) in [("work", 0, 0), ("work", 0, 1), ("notes", 0, 0)] {
            let id = &journal.sessions.iter().find(|entry| entry.name == session).unwrap().windows[window].panes[pane].id;
            assert!(files.contains_key(&(session.to_string(), id.clone())), "{session} {id} has saved output");
        }
        // The record stays in the format every version reads: an older one
        // brings the same sessions back instead of overwriting the journal.
        let text = fs::read_to_string(state_file(&data)).unwrap();
        let fields: serde_json::Value = serde_json::from_str(&text).unwrap();
        let mut keys: Vec<&String> = fields.as_object().unwrap().keys().collect();
        keys.sort();
        assert_eq!(keys, ["agents", "server", "sessions"]);
        let record: SavedState = serde_json::from_str(&text).unwrap();
        assert_eq!((record.server.as_str(), record.sessions.len()), (identity.as_str(), 2));
        data
    }

    fn assert_restored_with_output(server: &Server, report: &RefreshReport) {
        let mut restored = report.restored.clone();
        restored.sort();
        assert_eq!(restored, ["lost", "notes", "work"], "{report:?}");
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        server.wait_for("=work:0.0", "saved-work-left");
        server.wait_for("=work:0.1", "saved-work-right");
        server.wait_for("=notes:0", "saved-notes");
        assert!(server.read(&["list-windows", "-t", "=notes", "-F", "#{window_index}"]).lines().eq(["0", "1"]));
        assert!(pane_path(server, "=lost:").ends_with("/lost"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn an_interrupted_refresh_brings_every_session_back_with_its_output() {
        let server = Server::new();
        let data = interrupted_refresh(&server);
        let client = || server.client();
        // The app opens on a new server, where a tile already made "notes".
        // The test server's own session stays: unlike the app's server, it
        // would exit while the placeholder is replaced.
        server.start("0");
        server.read(&["new-session", "-d", "-s", "notes"]);
        assert_eq!(record(&client, &data, None).unwrap(), RecordStatus { restarted: true }, "the journal is never overwritten");
        let report = restore_lost(&client, &data, Vec::new()).unwrap();
        assert_restored_with_output(&server, &report);
        assert!(!refresh_root(&data).exists(), "the saved output is removed once restored");
        assert!(!journal_file(&data).exists(), "nothing is owed any more");
        assert_eq!(load(&data).record.unwrap().server, server_identity(&client).unwrap());
        let again = restore_lost(&client, &data, Vec::new()).unwrap();
        assert!(again.restored.is_empty() && again.failed.is_empty(), "nothing is restored twice");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn the_next_refresh_uses_the_output_an_interrupted_one_saved() {
        let server = Server::new();
        let data = interrupted_refresh(&server);
        let client = || server.client();
        server.start("0");
        server.read(&["new-session", "-d", "-s", "notes"]);
        server.read(&["kill-session", "-t", "=placeholder"]);
        // A refresh before any restore: the earlier output is carried over
        // into its own journal instead of being removed.
        let restart = || {
            let _ = server.client().arg("kill-server").output();
            server.start("0");
            Ok(())
        };
        let report = refresh_with(&client, &data, Vec::new(), &restart).unwrap();
        assert_restored_with_output(&server, &report);
        assert!(!refresh_root(&data).exists(), "the saved output is removed once restored");
        assert!(!journal_file(&data).exists());
    }

    // A tmux that refuses any command with the argument $REFUSE_ARG while the
    // file $REFUSE exists.
    fn refusing<'a>(server: &'a Server, argument: &str) -> (PathBuf, impl Fn() -> Command + 'a) {
        let script = server.directory.join("refusing-tmux");
        fs::write(&script, "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = \"$REFUSE_ARG\" ] && [ -e \"$REFUSE\" ]; then echo 'refused for the test' >&2; exit 1; fi; done\nexec tmux \"$@\"\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let flag = server.directory.join("refuse");
        let argument = argument.to_string();
        let command_flag = flag.clone();
        (flag, move || {
            let mut command = Command::new(&script);
            command.args(["-N", "-S"]).arg(&server.socket).env_remove("TMUX").env("REFUSE", &command_flag).env("REFUSE_ARG", &argument);
            command
        })
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_session_that_fails_to_restore_stays_owed_until_it_comes_back() {
        let server = Server::new();
        server.start("0");
        let folder = folders(&server, &["kept", "doomed"]);
        let tmux = |args: &[&str]| server.read(args);
        tmux(&["new-session", "-d", "-s", "kept", "-c", &folder[0]]);
        tmux(&["new-session", "-d", "-s", "doomed", "-c", &folder[1]]);
        tmux(&["new-window", "-d", "-t", "=doomed:4", "-n", "build", "-c", &folder[1]]);
        tmux(&["kill-session", "-t", "=placeholder"]);
        let client = || server.client();
        let data = server.directory.join("data");
        let agent = AgentResume { session: "doomed".into(), window: Some(4), command: "claude -c --permission-mode manual".into(), only_if_busy: false };
        record(&client, &data, Some(vec![agent.clone()])).unwrap();
        let _ = server.client().arg("kill-server").output();
        server.start("0");

        // Creating "doomed" is refused while the flag file exists.
        let (flag, refusing) = refusing(&server, "doomed");
        fs::write(&flag, "").unwrap();
        let report = restore_lost(&refusing, &data, Vec::new()).unwrap();
        assert_eq!(report.restored, ["kept"]);
        assert_eq!(report.failed, [FailedSession { session: "doomed".into(), error: "refused for the test".into() }]);
        let owed = |journal: &Journal| journal.pending.iter().map(|session| session.name.clone()).collect::<Vec<_>>();
        let kept_agent = |journal: &Journal| journal.agents.iter().any(|entry| entry.session == "doomed" && entry.window == Some(4) && entry.command == agent.command);
        let saved = load(&data);
        assert_eq!(saved.record.unwrap().server, server_identity(&client).unwrap(), "the new server is recorded");
        assert_eq!(owed(&saved.journal), ["doomed"]);
        assert!(saved.journal.partial.is_empty(), "nothing of it was created");
        assert_eq!(saved.journal.pending[0].windows.len(), 2);
        assert!(kept_agent(&saved.journal), "its agent is kept too");

        // Recording keeps it without retrying it every round.
        for agents in [None, Some(Vec::new())] {
            assert_eq!(record(&client, &data, agents).unwrap(), RecordStatus { restarted: false });
            let journal = load(&data).journal;
            assert_eq!(owed(&journal), ["doomed"]);
            assert!(kept_agent(&journal));
        }
        assert!(run(&client, &strings(&["has-session", "-t", "=doomed"])).is_err());

        // The next launch retries it, once.
        fs::remove_file(&flag).unwrap();
        let report = restore_lost(&client, &data, Vec::new()).unwrap();
        assert_eq!(report.restored, ["doomed"]);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(tmux(&["list-windows", "-t", "=doomed", "-F", "#{window_index} #{window_name}"]).lines().last(), Some("4 build"));
        assert_eq!(pane_path(&server, "=doomed:4"), folder[1]);
        assert!(!journal_file(&data).exists());
        let again = restore_lost(&client, &data, Vec::new()).unwrap();
        assert!(again.restored.is_empty() && again.failed.is_empty());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_session_restored_partway_keeps_its_missing_windows_and_their_output() {
        let server = Server::new();
        server.start("0");
        let folder = folders(&server, &["kept", "doomed"]);
        let tmux = |args: &[&str]| server.read(args);
        tmux(&["new-session", "-d", "-s", "kept", "-c", &folder[0]]);
        tmux(&["new-session", "-d", "-s", "doomed", "-x", "120", "-y", "40", "-c", &folder[1]]);
        tmux(&["new-window", "-d", "-t", "=doomed:4", "-n", "build", "-c", &folder[1]]);
        tmux(&["split-window", "-d", "-h", "-t", "=doomed:4", "-c", &folder[1]]);
        tmux(&["kill-session", "-t", "=placeholder"]);
        for (target, text) in [("=doomed:0", "saved-first"), ("=doomed:4.0", "saved-left"), ("=doomed:4.1", "saved-right")] {
            tmux(&["send-keys", "-t", target, &format!("echo {text}"), "Enter"]);
            server.wait_for(target, text);
        }
        let client = || server.client();
        let data = server.directory.join("data");
        // Splitting window 4 is refused once the server was restarted, so the
        // window is made and then closed again.
        let (flag, refusing) = refusing(&server, "=doomed:4.0");
        let restart = || {
            let _ = server.client().arg("kill-server").output();
            server.start("0");
            fs::write(&flag, "").unwrap();
            Ok(())
        };
        let report = refresh_with(&refusing, &data, Vec::new(), &restart).unwrap();
        assert_eq!(report.restored, ["kept"]);
        assert_eq!(report.failed, [FailedSession { session: "doomed".into(), error: "Some of its windows could not be restored: refused for the test".into() }]);
        assert_eq!(tmux(&["list-windows", "-t", "=doomed", "-F", "#{window_index}"]).trim(), "0", "the half-built window was closed");
        server.wait_for("=doomed:0", "saved-first");

        // Window 4 stays owed with both panes and their saved output.
        let journal = load(&data).journal;
        assert_eq!((journal.partial.as_slice(), journal.pending.len()), (["doomed".to_string()].as_slice(), 1));
        let missing = &journal.pending[0];
        assert_eq!(missing.windows.iter().map(|window| (window.index, window.panes.len())).collect::<Vec<_>>(), [(4, 2)]);
        let directory = refresh_root(&data).join(journal.refresh.as_deref().unwrap());
        let files = load_manifest(&directory);
        assert_eq!(files.len(), 2, "only output not shown yet is kept: {files:?}");
        assert!(missing.windows[0].panes.iter().all(|pane| files.contains_key(&("doomed".to_string(), pane.id.clone()))));
        let left: Vec<_> = fs::read_dir(&directory).unwrap().flatten().map(|entry| entry.file_name().to_string_lossy().into_owned()).collect();
        assert_eq!(left.len(), 3, "two saved files and the manifest: {left:?}");
        // Recording on the same server keeps what is owed.
        assert_eq!(record(&client, &data, None).unwrap(), RecordStatus { restarted: false });
        assert_eq!(load(&data).journal, journal);

        // The next try adds the window to the running session.
        fs::remove_file(&flag).unwrap();
        let first_pane = tmux(&["display-message", "-p", "-t", "=doomed:0", "#{pane_id} #{pane_pid}"]);
        let report = restore_lost(&refusing, &data, Vec::new()).unwrap();
        assert_eq!(report.restored, ["doomed"]);
        assert!(report.failed.is_empty(), "{:?}", report.failed);
        assert_eq!(tmux(&["list-windows", "-t", "=doomed", "-F", "#{window_index} #{window_name} #{window_panes}"]).lines().collect::<Vec<_>>()[1], "4 build 2");
        server.wait_for("=doomed:4.0", "saved-left");
        server.wait_for("=doomed:4.1", "saved-right");
        assert_eq!(tmux(&["display-message", "-p", "-t", "=doomed:0", "#{pane_id} #{pane_pid}"]), first_pane, "the running window is untouched");
        assert!(!journal_file(&data).exists());
        assert!(!refresh_root(&data).exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_crash_while_a_session_is_built_leaves_its_missing_windows_owed() {
        let server = Server::new();
        server.start("0");
        let folder = folders(&server, &["work"]);
        let tmux = |args: &[&str]| server.read(args);
        tmux(&["new-session", "-d", "-s", "work", "-c", &folder[0]]);
        tmux(&["new-window", "-d", "-t", "=work:3", "-n", "build", "-c", &folder[0]]);
        tmux(&["new-window", "-d", "-t", "=work:5", "-n", "logs", "-c", &folder[0]]);
        tmux(&["kill-session", "-t", "=placeholder"]);
        let client = || server.client();
        let data = server.directory.join("data");
        record(&client, &data, None).unwrap();
        let _ = server.client().arg("kill-server").output();
        server.start("0");

        // The app dies when window 3 is about to be made: the files on disk
        // then are copied aside, and the command is refused.
        let crash = server.directory.join("crash");
        private_directory(&crash).unwrap();
        let script = server.directory.join("crashing-tmux");
        fs::write(&script, "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = '=work:3' ] && [ ! -e \"$CRASH/done\" ]; then cp \"$STATE/journal.json\" \"$CRASH/journal.json\"; cp \"$STATE/sessions.json\" \"$CRASH/sessions.json\"; touch \"$CRASH/done\"; exit 1; fi; done\nexec tmux \"$@\"\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let crashing = || {
            let mut command = Command::new(&script);
            command.args(["-N", "-S"]).arg(&server.socket).env_remove("TMUX").env("CRASH", &crash).env("STATE", state_directory(&data));
            command
        };
        restore_lost(&crashing, &data, Vec::new()).unwrap();
        assert!(crash.join("done").exists());
        // As the crash left it: the session with its first window only, and
        // the journal and record from that moment.
        assert_eq!(tmux(&["list-windows", "-t", "=work", "-F", "#{window_index}"]).trim(), "0");
        fs::copy(crash.join("journal.json"), journal_file(&data)).unwrap();
        fs::copy(crash.join("sessions.json"), state_file(&data)).unwrap();
        let journal = load(&data).journal;
        assert_eq!(journal.partial, ["work"], "the session being built is on record");

        // The next launch adds the windows the crash left out.
        let report = restore_lost(&client, &data, Vec::new()).unwrap();
        assert_eq!(report.restored, ["work"], "{report:?}");
        assert_eq!(tmux(&["list-windows", "-t", "=work", "-F", "#{window_index} #{window_name}"]).lines().collect::<Vec<_>>()[1..], ["3 build", "5 logs"]);
        assert!(!journal_file(&data).exists());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_name_taken_during_a_restore_is_checked_then_and_never_loses_the_saved_session() {
        let server = Server::new();
        server.start("0");
        let folder = folders(&server, &["api", "notes"]);
        let tmux = |args: &[&str]| server.read(args);
        tmux(&["new-session", "-d", "-s", "api", "-c", &folder[0]]);
        tmux(&["new-window", "-d", "-t", "=api:2", "-n", "logs", "-c", &folder[0]]);
        tmux(&["new-session", "-d", "-s", "notes", "-c", &folder[1]]);
        tmux(&["kill-session", "-t", "=placeholder"]);
        let client = || server.client();
        let sessions = snapshot(&client).unwrap();
        let _ = server.client().arg("kill-server").output();
        server.start("0");
        // After the listing a restore works from, a tile makes a placeholder
        // "notes", and "api" is made and put to use.
        tmux(&["new-session", "-d", "-s", "notes"]);
        tmux(&["new-session", "-d", "-s", "api", "/bin/sleep", "60"]);
        let api_before = tmux(&["list-panes", "-s", "-t", "=api", "-F", "#{pane_id} #{pane_pid}"]);
        let owed = Owed { sessions, partial: HashSet::new() };
        let outcome = restore(&client, &owed, &Scrollback::new(), &[], &[], &|name| placeholder_now(&client, name), &mut |_, _| {});
        let mut restored = outcome.report.restored.clone();
        restored.sort();
        assert_eq!(restored, ["api (restored)", "notes"], "{:?}", outcome.report);
        assert!(outcome.report.failed.is_empty() && outcome.pending.is_empty());
        assert_eq!(tmux(&["list-panes", "-s", "-t", "=api", "-F", "#{pane_id} #{pane_pid}"]), api_before, "the session in use is untouched");
        assert_eq!(tmux(&["list-windows", "-t", "=api (restored)", "-F", "#{window_index} #{window_name}"]).lines().last(), Some("2 logs"));
        assert_eq!(pane_path(&server, "=api (restored):0"), folder[0]);
        assert_eq!(pane_path(&server, "=notes:"), folder[1], "the placeholder was replaced");
        assert!(!placeholder_now(&client, "api") && !placeholder_now(&client, "missing"));
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_tile_attaching_to_a_new_server_waits_for_what_it_owes() {
        let server = Server::new();
        server.start("0");
        let folder = folders(&server, &["api"]);
        let tmux = |args: &[&str]| server.read(args);
        tmux(&["new-session", "-d", "-s", "api", "-c", &folder[0]]);
        tmux(&["new-window", "-d", "-t", "=api:4", "-c", &folder[0]]);
        tmux(&["kill-session", "-t", "=placeholder"]);
        let client = || server.client();
        let data = server.directory.join("data");
        record(&client, &data, None).unwrap();
        // The server ends while the app runs and comes back empty.
        let _ = server.client().arg("kill-server").output();
        server.start("0");

        // A restore runs elsewhere: the attach waits, then refuses.
        let running = lock_file(&data, "refresh.lock", Duration::from_secs(1)).unwrap().unwrap();
        assert_eq!(restore_before_attach(&client, &data, Duration::from_millis(200)).unwrap_err(), "Saved sessions are still being restored. Try again in a moment.");
        assert!(run(&client, &strings(&["has-session", "-t", "=api"])).is_err());
        drop(running);

        // Otherwise what the server owes comes back before the attach.
        restore_before_attach(&client, &data, Duration::from_secs(5)).unwrap();
        assert_eq!(tmux(&["list-windows", "-t", "=api", "-F", "#{window_index}"]).lines().collect::<Vec<_>>(), ["0", "4"]);
        assert_eq!(pane_path(&server, "=api:4"), folder[0]);
        // Settled: the next attach restores nothing again.
        let windows = tmux(&["list-windows", "-a", "-F", "#{session_name}:#{window_index}"]);
        restore_before_attach(&client, &data, Duration::from_secs(5)).unwrap();
        assert_eq!(tmux(&["list-windows", "-a", "-F", "#{session_name}:#{window_index}"]), windows);
        // No server: nothing to wait for (tmux -N starts none).
        let _ = server.client().arg("kill-server").output();
        assert!(restore_before_attach(&client, &data, Duration::ZERO).is_ok());
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_server_that_ends_during_a_record_leaves_the_record_alone() {
        let server = Server::new();
        server.start("0");
        server.read(&["new-session", "-d", "-s", "work"]);
        let client = || server.client();
        let data = server.directory.join("data");
        record(&client, &data, None).unwrap();
        let recorded = fs::read(state_file(&data)).unwrap();
        // The server ends right before the sessions are listed.
        let script = server.directory.join("ending-tmux");
        fs::write(&script, "#!/bin/sh\nfor arg in \"$@\"; do if [ \"$arg\" = list-sessions ]; then tmux -N -S \"$3\" kill-server; fi; done\nexec tmux \"$@\"\n").unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let ending = || {
            let mut command = Command::new(&script);
            command.args(["-N", "-S"]).arg(&server.socket).env_remove("TMUX");
            command
        };
        assert_eq!(record(&ending, &data, None).unwrap(), RecordStatus { restarted: false });
        assert_eq!(fs::read(state_file(&data)).unwrap(), recorded, "no empty listing replaces the record");
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn a_journal_this_version_cannot_read_is_left_alone() {
        let server = Server::new();
        server.start("0");
        server.read(&["new-session", "-d", "-s", "work"]);
        let client = || server.client();
        let data = server.directory.join("data");
        record(&client, &data, None).unwrap();
        // Written by a newer version, with its saved output.
        let newer = r#"{"version":2,"server":"1 1","sessions":[],"pending":[],"partial":[],"agents":[],"refresh":"0123456789abcdef","more":true}"#;
        fs::write(journal_file(&data), newer).unwrap();
        let folder = refresh_root(&data).join("0123456789abcdef");
        private_directory(&folder).unwrap();
        assert_eq!(record(&client, &data, None).unwrap(), RecordStatus { restarted: false });
        let restart = || -> Result<(), String> { panic!("a refresh must not end the server") };
        assert_eq!(refresh_with(&client, &data, Vec::new(), &restart).unwrap_err(), KEPT_JOURNAL);
        assert!(restore_lost(&client, &data, Vec::new()).is_ok());
        assert_eq!(fs::read_to_string(journal_file(&data)).unwrap(), newer);
        assert!(folder.exists(), "its saved output stays");
        assert!(load(&data).record.is_some(), "the record is still kept current");
    }

    #[test]
    fn a_record_that_still_holds_what_is_owed_is_split_into_the_journal() {
        let server = Server::new();
        let data = server.directory.join("data");
        private_directory(&state_directory(&data)).unwrap();
        let earlier = earlier_refresh_root(&data).join("0123456789abcdef");
        private_directory(&earlier).unwrap();
        fs::write(earlier.join("0.txt"), "output").unwrap();
        let entry = serde_json::json!({ "panes": [{ "session": "old", "pane": "%0", "file": "0.txt" }] });
        fs::write(earlier.join(MANIFEST), entry.to_string()).unwrap();
        let session = serde_json::to_value(saved("old")).unwrap();
        let text = serde_json::json!({ "server": "1 1", "sessions": [session.clone()], "agents": [], "pending": [session], "refresh": "0123456789abcdef" });
        fs::write(state_file(&data), text.to_string()).unwrap();
        let saved_now = load(&data);
        assert_eq!(saved_now.journal.pending.iter().map(|session| session.name.as_str()).collect::<Vec<_>>(), ["old"]);
        assert_eq!(saved_now.journal.refresh.as_deref(), Some("0123456789abcdef"));
        assert_eq!(load_manifest(&refresh_root(&data).join("0123456789abcdef")).len(), 1, "its output moved with it");
        assert!(!earlier_refresh_root(&data).exists());
        let record: SavedState = serde_json::from_str(&fs::read_to_string(state_file(&data)).unwrap()).unwrap();
        assert_eq!(record.sessions.len(), 1);
        assert_eq!(load(&data).journal, saved_now.journal);

        // Anything else unreadable is moved aside, never overwritten.
        fs::write(state_file(&data), "{not json").unwrap();
        assert!(load(&data).record.is_none());
        assert_eq!(fs::read_to_string(state_file(&data).with_extension("json.unreadable")).unwrap(), "{not json");
        assert!(!state_file(&data).exists());
    }
}
