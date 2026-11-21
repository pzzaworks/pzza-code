// The program each local terminal pane runs in its foreground (`npm run dev`,
// `vim notes.md`, `tail -f log`), read exactly from the process table, so a
// refresh can start it again in the same pane instead of leaving the user to
// type it. Coding agents are left out: they resume through their own catalog
// line (session_refresh.rs).
//
// The line typed again is always built here from the process's own argument
// vector, never taken from the app: a refresh names the panes to restart and
// the line it was shown, and a pane restarts only when it still runs exactly
// that. Only one plain command qualifies: a pipeline, a subshell, a program
// that renamed itself, one that asks for a password (sudo), a nested shell or
// multiplexer is never typed again. Variables set only for that command
// (`PORT=3001 npm run dev`) are not read (environments hold secrets), so they
// are not typed again either.
use std::collections::HashSet;
#[cfg(target_os = "macos")]
use std::io::Read;

use serde::{Deserialize, Serialize};

use crate::session_refresh::SHELLS;

const MAX_LINE: usize = 2048;
const MAX_LABEL: usize = 120;
// Programs that would ask for a password, or would start another terminal
// server inside the pane.
const PRIVILEGED: &[&str] = &["sudo", "doas", "su", "login", "passwd", "pkexec", "runas"];
const MULTIPLEXERS: &[&str] = &["tmux", "screen", "zellij", "byobu"];
// Interpreters a script's `#!` line runs it under: the script is what was typed.
const SCRIPT_RUNNERS: &[&str] = &["node", "nodejs", "bun", "deno", "python", "python3", "ruby", "perl", "php", "bash", "sh", "zsh", "env"];

/// A pane's foreground program, as the refresh dialog lists it.
#[derive(Debug, Clone, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PaneProgram {
    pub session: String,
    pub window: u32,
    /// The tmux pane id (`%12`) and its index in the window.
    pub pane: String,
    pub index: u32,
    /// The line typed to start it again; None when it cannot be (see `reason`).
    pub command: Option<String>,
    /// What runs, shortened for display.
    pub label: String,
    pub reason: Option<String>,
    /// Every process of the job, for matching the ports it listens on.
    pub pids: Vec<u32>,
}

/// A pane to start its program again in, as the app asks for it: the line it
/// was shown, which must still be the pane's program at refresh time.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProgramRequest {
    pub pane: String,
    pub command: String,
}

/// One row of the process table.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Proc {
    pub pid: u32,
    pub ppid: u32,
    pub pgid: u32,
    /// The foreground process group of its terminal.
    pub tpgid: u32,
}

/// What a pane's shell has in its foreground.
#[derive(Debug, PartialEq)]
pub enum Job {
    /// The shell itself: nothing runs.
    Idle,
    /// One command started by the shell, with every process of its job.
    One { top: u32, pids: Vec<u32> },
    /// Several commands started together (a pipeline): never typed again.
    Pipeline { pids: Vec<u32> },
}

/// The foreground job of the shell `shell` from a process table.
pub fn foreground_job(table: &[Proc], shell: u32) -> Job {
    let Some(root) = table.iter().find(|item| item.pid == shell) else {
        return Job::Idle;
    };
    if root.tpgid == 0 || root.tpgid == root.pgid {
        return Job::Idle;
    }
    let group: Vec<&Proc> = table.iter().filter(|item| item.pgid == root.tpgid).collect();
    let tops: Vec<u32> = group.iter().filter(|item| item.ppid == shell).map(|item| item.pid).collect();
    // Everything below the job's own processes, however deep (servers fork
    // workers into groups of their own).
    let mut pids: Vec<u32> = group.iter().map(|item| item.pid).collect();
    let mut seen: HashSet<u32> = pids.iter().copied().collect();
    let mut at = 0;
    while at < pids.len() {
        let parent = pids[at];
        for item in table.iter().filter(|item| item.ppid == parent) {
            if seen.insert(item.pid) {
                pids.push(item.pid);
            }
        }
        at += 1;
    }
    match tops.as_slice() {
        [] => Job::Idle,
        [top] => Job::One { top: *top, pids },
        _ => Job::Pipeline { pids },
    }
}

fn base(value: &str) -> &str {
    value.rsplit('/').next().unwrap_or(value).trim_start_matches('-')
}

/// One shell word, quoted only when needed. Same rule as shellWord in
/// session-agents.js: "!" is written as \! between quoted runs for csh.
pub fn shell_word(value: &str) -> String {
    let plain = !value.is_empty() && value.chars().all(|c| c.is_ascii_alphanumeric() || "_@%+=:,./-".contains(c));
    if plain {
        value.to_string()
    } else {
        format!("'{}'", value.replace('\'', "'\\''").replace('!', "'\\!'"))
    }
}

/// Whether argv[0] still names the executable (`python3` for python3.12):
/// a process that renamed itself (`next-server (v15)`) no longer shows how
/// it was started.
fn names_executable(argv0: &str, executable: &str) -> bool {
    let (name, exe) = (base(argv0), base(executable));
    !name.is_empty()
        && !argv0.contains(char::is_whitespace)
        && (name == exe || exe.strip_prefix(name).is_some_and(|rest| rest.chars().all(|c| c.is_ascii_digit() || c == '.')))
}

/// The words that start a program again from its exact argument vector and
/// executable, or why it cannot be. `script_line` reads the `#!` line of a
/// file: a script run by its interpreter (`node /opt/homebrew/bin/npm run
/// dev`) is typed as the script (`/opt/homebrew/bin/npm run dev`).
pub fn restart_words(executable: &str, argv: &[String], script_line: &dyn Fn(&str) -> Option<String>) -> Result<Vec<String>, &'static str> {
    let first = argv.first().ok_or("Its arguments could not be read.")?;
    if !names_executable(first, executable) {
        return Err("It renamed itself, so how it was started is not known.");
    }
    let name = base(first);
    if PRIVILEGED.contains(&name) {
        return Err("It runs as another user and would ask for a password.");
    }
    if MULTIPLEXERS.contains(&name) {
        return Err("Another terminal multiplexer runs here.");
    }
    if SHELLS.contains(&name) && argv.len() == 1 {
        return Err("A shell runs inside the shell.");
    }
    let mut words = argv.to_vec();
    // `script_line` gives the first line only of an executable file, so the
    // script can be typed by itself.
    if SCRIPT_RUNNERS.contains(&name) && argv.len() >= 2 && argv[1].starts_with('/') {
        let runs_it = script_line(&argv[1])
            .and_then(|line| line.strip_prefix("#!").map(str::to_string))
            .is_some_and(|line| line.split_whitespace().any(|word| names_executable(base(word), name) || base(word) == name));
        if runs_it {
            words.remove(0);
        }
    }
    if words.iter().any(|word| word.chars().any(char::is_control)) {
        return Err("Its arguments hold control characters.");
    }
    Ok(words)
}

/// A shortened line for display: the program's name and its arguments.
pub fn label(words: &[String]) -> String {
    let mut line = std::iter::once(base(&words[0]).to_string()).chain(words[1..].iter().map(|word| shell_word(word))).collect::<Vec<_>>().join(" ");
    if line.chars().count() > MAX_LABEL {
        line = line.chars().take(MAX_LABEL - 1).collect::<String>() + "…";
    }
    line
}

/// The line typed to start the words again, or None when too long.
pub fn command_line(words: &[String]) -> Option<String> {
    let line = words.iter().map(|word| shell_word(word)).collect::<Vec<_>>().join(" ");
    (line.len() <= MAX_LINE).then_some(line)
}

#[cfg(target_os = "macos")]
pub fn process_table() -> Vec<Proc> {
    let count = unsafe { libc::proc_listallpids(std::ptr::null_mut(), 0) };
    if count <= 0 {
        return Vec::new();
    }
    // Room for processes started meanwhile.
    let mut pids = vec![0 as libc::pid_t; count as usize + 64];
    let bytes = (pids.len() * std::mem::size_of::<libc::pid_t>()) as libc::c_int;
    // SAFETY: `pids` is a writable buffer of exactly `bytes` bytes.
    let found = unsafe { libc::proc_listallpids(pids.as_mut_ptr().cast(), bytes) };
    pids.truncate(found.max(0) as usize);
    pids.into_iter()
        .filter(|pid| *pid > 0)
        .filter_map(|pid| {
            let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
            let size = std::mem::size_of::<libc::proc_bsdinfo>() as libc::c_int;
            // SAFETY: `info` is a writable proc_bsdinfo of exactly `size` bytes.
            let read = unsafe { libc::proc_pidinfo(pid, libc::PROC_PIDTBSDINFO, 0, (&mut info as *mut libc::proc_bsdinfo).cast(), size) };
            (read == size).then_some(Proc { pid: pid as u32, ppid: info.pbi_ppid, pgid: info.pbi_pgid, tpgid: info.e_tpgid })
        })
        .collect()
}

/// A process's executable path and exact argument vector (KERN_PROCARGS2:
/// argc, the executable path, padding, then argv; the environment after it
/// is never read).
#[cfg(target_os = "macos")]
pub fn process_args(pid: u32) -> Option<(String, Vec<String>)> {
    let mut mib = [libc::CTL_KERN, libc::KERN_PROCARGS2, pid as libc::c_int];
    let mut size: libc::size_t = 0;
    // SAFETY: a size query with a null buffer.
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, std::ptr::null_mut(), &mut size, std::ptr::null_mut(), 0) } != 0 || size < 4 {
        return None;
    }
    let mut buffer = vec![0u8; size];
    // SAFETY: `buffer` is writable for `size` bytes, which sysctl updates.
    if unsafe { libc::sysctl(mib.as_mut_ptr(), 3, buffer.as_mut_ptr().cast(), &mut size, std::ptr::null_mut(), 0) } != 0 {
        return None;
    }
    buffer.truncate(size);
    parse_procargs(&buffer)
}

/// Parses a KERN_PROCARGS2 buffer into the executable and argv.
pub fn parse_procargs(buffer: &[u8]) -> Option<(String, Vec<String>)> {
    let argc = i32::from_ne_bytes(buffer.get(..4)?.try_into().ok()?);
    if !(1..=4096).contains(&argc) {
        return None;
    }
    let rest = &buffer[4..];
    let end = rest.iter().position(|byte| *byte == 0)?;
    let executable = String::from_utf8(rest[..end].to_vec()).ok()?;
    let mut at = end;
    while rest.get(at) == Some(&0) {
        at += 1;
    }
    let mut argv = Vec::with_capacity(argc as usize);
    for _ in 0..argc {
        let stop = at + rest.get(at..)?.iter().position(|byte| *byte == 0)?;
        argv.push(String::from_utf8(rest[at..stop].to_vec()).ok()?);
        at = stop + 1;
    }
    Some((executable, argv))
}

#[cfg(target_os = "macos")]
fn script_line(path: &str) -> Option<String> {
    use std::os::unix::fs::PermissionsExt;
    let metadata = std::fs::metadata(path).ok()?;
    if !metadata.is_file() || metadata.permissions().mode() & 0o111 == 0 {
        return None;
    }
    let mut file = std::fs::File::open(path).ok()?;
    let mut head = [0u8; 256];
    let read = file.read(&mut head).ok()?;
    let text = String::from_utf8_lossy(&head[..read]);
    text.lines().next().map(str::to_string)
}

/// A listed pane: its session, window, id, index, shell pid and the command
/// tmux shows.
pub struct PaneRef {
    pub session: String,
    pub window: u32,
    pub pane: String,
    pub index: u32,
    pub pid: u32,
    pub command: String,
}

/// Parses `list-panes -a -F PANES` output.
pub const PANES: &str = "#{pane_id}\t#{window_index}\t#{pane_index}\t#{pane_pid}\t#{pane_current_command}\t#{session_name}";

pub fn parse_panes(text: &str) -> Vec<PaneRef> {
    text.lines()
        .filter_map(|line| {
            let mut parts = line.splitn(6, '\t');
            let pane = parts.next()?.to_string();
            let window = parts.next()?.parse().ok()?;
            let index = parts.next()?.parse().ok()?;
            let pid = parts.next()?.parse().ok()?;
            let command = parts.next()?.to_string();
            let session = parts.next()?.to_string();
            (pane.starts_with('%') && !session.is_empty()).then_some(PaneRef { session, window, pane, index, pid, command })
        })
        .collect()
}

/// The program of each pane whose foreground runs something other than a
/// shell or a coding agent (`is_agent` tells those apart from tmux's pane
/// command), read with `table` and `args`.
pub fn programs_of(
    panes: &[PaneRef],
    table: &[Proc],
    args: &dyn Fn(u32) -> Option<(String, Vec<String>)>,
    script_line: &dyn Fn(&str) -> Option<String>,
    is_agent: &dyn Fn(&str) -> bool,
) -> Vec<PaneProgram> {
    panes
        .iter()
        .filter(|pane| !SHELLS.contains(&base(&pane.command)) && !is_agent(&pane.command))
        .filter_map(|pane| {
            let listed = |command: Option<String>, label: String, reason: Option<&str>, pids: Vec<u32>| PaneProgram {
                session: pane.session.clone(),
                window: pane.window,
                pane: pane.pane.clone(),
                index: pane.index,
                command,
                label,
                reason: reason.map(str::to_string),
                pids,
            };
            match foreground_job(table, pane.pid) {
                Job::Idle => None,
                Job::Pipeline { pids } => Some(listed(None, pane.command.clone(), Some("Several commands run together here."), pids)),
                Job::One { top, pids } => {
                    let Some((executable, argv)) = args(top) else {
                        return Some(listed(None, pane.command.clone(), Some("Its arguments could not be read."), pids));
                    };
                    // The job may be an agent tmux names by another name (a version).
                    if argv.first().is_some_and(|first| is_agent(base(first))) {
                        return None;
                    }
                    Some(match restart_words(&executable, &argv, script_line) {
                        // A script agent under its interpreter (codex under node).
                        Ok(words) if is_agent(base(&words[0])) => return None,
                        Ok(words) => match command_line(&words) {
                            Some(line) => listed(Some(line), label(&words), None, pids),
                            None => listed(None, label(&words), Some("Its command line is too long to type again."), pids),
                        },
                        Err(reason) => listed(None, argv.first().map(|first| base(first).to_string()).unwrap_or_default(), Some(reason), pids),
                    })
                }
            }
        })
        .collect()
}

/// The programs running in the local panes now.
#[cfg(target_os = "macos")]
pub fn local_programs(panes: &[PaneRef], is_agent: &dyn Fn(&str) -> bool) -> Vec<PaneProgram> {
    let table = process_table();
    programs_of(panes, &table, &process_args, &script_line, is_agent)
}

#[cfg(not(target_os = "macos"))]
pub fn local_programs(_panes: &[PaneRef], _is_agent: &dyn Fn(&str) -> bool) -> Vec<PaneProgram> {
    Vec::new()
}

/// The requested restarts that still hold: the pane still runs exactly the
/// line the app was shown. Anything else is dropped.
pub fn accepted<'a>(programs: &'a [PaneProgram], requests: &[ProgramRequest]) -> Vec<&'a PaneProgram> {
    programs
        .iter()
        .filter(|program| program.command.as_deref().is_some_and(|line| requests.iter().any(|request| request.pane == program.pane && request.command == line)))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn words(items: &[&str]) -> Vec<String> {
        items.iter().map(|item| item.to_string()).collect()
    }

    #[test]
    fn the_foreground_job_is_one_command_or_a_pipeline() {
        let p = |pid, ppid, pgid, tpgid| Proc { pid, ppid, pgid, tpgid };
        // zsh 10 at the prompt.
        assert_eq!(foreground_job(&[p(10, 1, 10, 10)], 10), Job::Idle);
        // npm 20 (group 20) with a child 21 and a worker 30 in a group of its own.
        let table = [p(10, 1, 10, 20), p(20, 10, 20, 20), p(21, 20, 20, 20), p(30, 21, 30, 20), p(99, 1, 99, 0)];
        assert_eq!(foreground_job(&table, 10), Job::One { top: 20, pids: vec![20, 21, 30] });
        // `a | b`: two commands of the shell in one group.
        let pipe = [p(10, 1, 10, 20), p(20, 10, 20, 20), p(21, 10, 20, 20)];
        assert!(matches!(foreground_job(&pipe, 10), Job::Pipeline { .. }));
        assert_eq!(foreground_job(&[], 10), Job::Idle);
    }

    #[test]
    fn programs_start_again_as_they_were_typed() {
        let npm = |path: &str| (path == "/opt/homebrew/bin/npm").then(|| String::from("#!/usr/bin/env node"));
        let none = |_: &str| None;
        assert_eq!(restart_words("/opt/homebrew/bin/node", &words(&["node", "/opt/homebrew/bin/npm", "run", "dev"]), &npm).unwrap(), words(&["/opt/homebrew/bin/npm", "run", "dev"]));
        // A script given by hand stays under its interpreter.
        assert_eq!(restart_words("/usr/bin/python3", &words(&["python3", "/tmp/x.py"]), &none).unwrap(), words(&["python3", "/tmp/x.py"]));
        assert_eq!(restart_words("/opt/homebrew/bin/python3.12", &words(&["python3", "-m", "http.server"]), &none).unwrap(), words(&["python3", "-m", "http.server"]));
        assert_eq!(command_line(&words(&["vim", "my notes.md", "it's", "!x"])).unwrap(), "vim 'my notes.md' 'it'\\''s' ''\\!'x'");
        for (executable, argv) in [
            ("/usr/local/bin/node", vec!["next-server (v15.0.3)"]),
            ("/usr/bin/sudo", vec!["sudo", "rm", "x"]),
            ("/opt/homebrew/bin/tmux", vec!["tmux", "attach"]),
            ("/bin/zsh", vec!["zsh"]),
            ("/usr/bin/less", vec!["less", "a\u{1b}[31m"]),
        ] {
            assert!(restart_words(executable, &words(&argv), &none).is_err(), "{argv:?}");
        }
        assert_eq!(label(&words(&["/opt/homebrew/bin/npm", "run", "dev"])), "npm run dev");
    }

    #[test]
    fn panes_list_only_programs_that_are_not_shells_or_agents() {
        let panes = parse_panes("%1\t0\t0\t10\tnode\twork\n%2\t0\t1\t11\tzsh\twork\n%3\t1\t0\t12\t2.1.330\twork\n%4\t2\t0\t13\tgrep\tlogs\nbad line\n");
        assert_eq!(panes.len(), 4);
        let p = |pid, ppid, pgid, tpgid| Proc { pid, ppid, pgid, tpgid };
        let table = [p(10, 1, 10, 20), p(20, 10, 20, 20), p(11, 1, 11, 11), p(12, 1, 12, 30), p(30, 12, 30, 30), p(13, 1, 13, 40), p(40, 13, 40, 40), p(41, 13, 40, 40)];
        let args = |pid: u32| match pid {
            20 => Some(("/opt/homebrew/bin/node".into(), words(&["node", "/opt/homebrew/bin/npm", "run", "dev"]))),
            30 => Some(("/Users/me/.local/share/claude/versions/2.1.330".into(), words(&["claude"]))),
            _ => None,
        };
        let npm = |path: &str| (path == "/opt/homebrew/bin/npm").then(|| String::from("#!/usr/bin/env node"));
        let is_agent = |command: &str| command == "claude" || command == "2.1.330";
        let programs = programs_of(&panes, &table, &args, &npm, &is_agent);
        assert_eq!(programs.len(), 2);
        assert_eq!(programs[0].command.as_deref(), Some("/opt/homebrew/bin/npm run dev"));
        assert_eq!(programs[0].label, "npm run dev");
        assert_eq!(programs[0].pids, [20]);
        assert_eq!((programs[1].pane.as_str(), programs[1].command.as_deref()), ("%4", None), "a pipeline");
        let requests = vec![
            ProgramRequest { pane: "%1".into(), command: "/opt/homebrew/bin/npm run dev".into() },
            ProgramRequest { pane: "%4".into(), command: "grep x".into() },
            ProgramRequest { pane: "%1".into(), command: "rm -rf ~".into() },
        ];
        assert_eq!(accepted(&programs, &requests).iter().map(|program| program.pane.as_str()).collect::<Vec<_>>(), ["%1"]);
    }

    #[test]
    fn process_arguments_parse_from_the_kernel_layout() {
        let mut buffer = 3i32.to_ne_bytes().to_vec();
        buffer.extend(b"/opt/homebrew/bin/node\0\0\0\0node\0/opt/homebrew/bin/npm\0run dev\0SECRET=x\0");
        assert_eq!(parse_procargs(&buffer), Some(("/opt/homebrew/bin/node".into(), words(&["node", "/opt/homebrew/bin/npm", "run dev"]))));
        assert_eq!(parse_procargs(&0i32.to_ne_bytes()), None);
        assert_eq!(parse_procargs(&[1, 0]), None);
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn this_process_reads_its_own_arguments() {
        let (executable, argv) = process_args(std::process::id()).expect("own arguments");
        assert!(executable.starts_with('/'));
        assert_eq!(argv, std::env::args().collect::<Vec<_>>());
        assert!(process_table().iter().any(|item| item.pid == std::process::id()));
    }
}
