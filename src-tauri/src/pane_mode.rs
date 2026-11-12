// tmux pane modes (copy-mode, view-mode, choose-tree...). With `mouse on` in
// a user's tmux.conf a wheel-up or a drag over a pane enters copy-mode, and
// while a mode is active every key goes to the mode instead of the program.
// A tile asks here whether its pane is in a mode and leaves the mode before
// delivering typed input. Remote devices go over the app's shared ssh master,
// which the tile's own attachment keeps warm, so the hop costs no handshake.
use std::io;
use std::process::{Command, Output};

use crate::sshmux;

const SESSION_MAX_LENGTH: usize = 256;

// The active pane of the session's current window, or of one window. tmux
// never allows ":" or "." in a session name, so neither can widen the target.
pub fn pane_target(session: &str, window: Option<u32>) -> Result<String, String> {
    if session.trim().is_empty()
        || session.len() > SESSION_MAX_LENGTH
        || session.chars().any(|c| c.is_control() || c == ':' || c == '.')
    {
        return Err("Invalid session name.".into());
    }
    Ok(match window {
        Some(index) => format!("={session}:{index}"),
        None => format!("={session}:"),
    })
}

// [user@]host or an ssh-config alias; never an ssh option.
pub fn valid_host(host: &str) -> bool {
    let mut chars = host.chars();
    let first_ok = chars
        .next()
        .is_some_and(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_');
    first_ok
        && host.len() <= 128
        && chars.all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '@' | '-'))
}

fn sh_quote(value: &str) -> String {
    format!("'{}'", value.replace('\'', "'\\''"))
}

// One remote shell command, mirroring the device agent's: print
// #{pane_in_mode}, or leave every mode. `copy-mode -q` cancels any mode; a
// tmux too old for -q can still leave copy and view mode with cancel.
pub fn remote_command(target: &str, leave: bool) -> String {
    let target = sh_quote(target);
    let probe = format!("tmux display-message -p -t {target} '#{{pane_in_mode}}'");
    if !leave {
        return probe;
    }
    format!(
        "tmux copy-mode -q -t {target} 2>/dev/null || {{ [ \"$({probe})\" = 0 ] || tmux send-keys -X -t {target} cancel; }}"
    )
}

#[cfg(target_os = "macos")]
fn bounded(command: &mut Command) -> io::Result<Output> {
    crate::local_tmux::bounded_output(command)
}

#[cfg(not(target_os = "macos"))]
fn bounded(command: &mut Command) -> io::Result<Output> {
    command.stdin(std::process::Stdio::null()).output()
}

fn parse_mode(output: Output) -> Result<bool, String> {
    if !output.status.success() {
        return Err("Could not reach the terminal pane.".into());
    }
    match String::from_utf8_lossy(&output.stdout).trim() {
        "1" => Ok(true),
        "0" => Ok(false),
        _ => Err("Could not read the terminal pane mode.".into()),
    }
}

/// Whether the pane is in a mode now: a probe reports it, leaving reports
/// false once tmux confirmed it. `tmux` builds a client for the server.
pub fn local_pane_mode(tmux: &dyn Fn() -> Command, target: &str, leave: bool) -> Result<bool, String> {
    let probe = || {
        bounded(tmux().args(["display-message", "-p", "-t", target, "#{pane_in_mode}"]))
            .map_err(|error| error.to_string())
            .and_then(parse_mode)
    };
    if !leave {
        return probe();
    }
    let quit = bounded(tmux().args(["copy-mode", "-q", "-t", target])).map_err(|error| error.to_string())?;
    if quit.status.success() || !probe()? {
        return Ok(false);
    }
    let cancel = bounded(tmux().args(["send-keys", "-X", "-t", target, "cancel"])).map_err(|error| error.to_string())?;
    if cancel.status.success() {
        Ok(false)
    } else {
        Err("Could not leave the terminal pane mode.".into())
    }
}

// One shell command on a remote device, over the shared ssh master.
fn remote(host: &str, command: String) -> Result<Output, String> {
    bounded(
        Command::new("ssh")
            .args(sshmux::control_args())
            .args(["-o", "BatchMode=yes"])
            .arg(host)
            .arg(command)
            .env_remove("PZZA_TMUX_SOCKET"),
    )
    .map_err(|error| error.to_string())
}

fn remote_pane_mode(host: &str, target: &str, leave: bool) -> Result<bool, String> {
    let output = remote(host, remote_command(target, leave))?;
    if leave {
        return if output.status.success() {
            Ok(false)
        } else {
            Err("Could not leave the terminal pane mode.".into())
        };
    }
    parse_mode(output)
}

#[cfg(target_os = "macos")]
fn local_client() -> Command {
    crate::local_tmux::client_command()
}

#[cfg(not(target_os = "macos"))]
fn local_client() -> Command {
    let mut command = Command::new("tmux");
    command.env_remove("TMUX");
    command
}

// Probe (leave = false) or leave (leave = true) the mode of a tile's pane on
// this device (no host) or a remote one. Resolves whether it is in a mode.
#[tauri::command]
pub async fn tmux_pane_mode(
    host: Option<String>,
    session: String,
    window: Option<u32>,
    leave: bool,
) -> Result<bool, String> {
    let target = pane_target(&session, window)?;
    let host = host.filter(|value| !value.is_empty());
    if host.as_deref().is_some_and(|value| !valid_host(value)) {
        return Err("Invalid device host.".into());
    }
    tauri::async_runtime::spawn_blocking(move || match host {
        Some(host) => remote_pane_mode(&host, &target, leave),
        None => local_pane_mode(&local_client, &target, leave),
    })
    .await
    .map_err(|error| error.to_string())?
}

// How far above the visible rows a pane's history is read: enough for a long
// command in an approval prompt that starts above the screen.
const HISTORY_ROWS: u32 = 300;

// The pane's last HISTORY_ROWS history rows and its visible rows in one
// capture, so the two line up. No -J: rows stay wrapped as on screen.
pub fn capture_args(target: &str) -> Vec<String> {
    vec![
        "capture-pane".into(),
        "-p".into(),
        "-S".into(),
        format!("-{HISTORY_ROWS}"),
        "-t".into(),
        target.into(),
    ]
}

// The same capture as one remote shell command, mirroring the device agent's.
pub fn remote_lines_command(target: &str) -> String {
    format!("tmux -u capture-pane -p -S -{HISTORY_ROWS} -t {}", sh_quote(target))
}

fn parse_lines(output: Output) -> Result<Vec<String>, String> {
    if !output.status.success() {
        return Err("Could not read the terminal pane.".into());
    }
    let text = String::from_utf8_lossy(&output.stdout);
    Ok(text.strip_suffix('\n').unwrap_or(&text).split('\n').map(str::to_owned).collect())
}

pub fn local_pane_lines(tmux: &dyn Fn() -> Command, target: &str) -> Result<Vec<String>, String> {
    bounded(tmux().args(capture_args(target)))
        .map_err(|error| error.to_string())
        .and_then(parse_lines)
}

// The recent history and visible rows of a tile's pane on this device (no
// host) or a remote one, oldest first.
#[tauri::command]
pub async fn tmux_pane_lines(
    host: Option<String>,
    session: String,
    window: Option<u32>,
) -> Result<Vec<String>, String> {
    let target = pane_target(&session, window)?;
    let host = host.filter(|value| !value.is_empty());
    if host.as_deref().is_some_and(|value| !valid_host(value)) {
        return Err("Invalid device host.".into());
    }
    tauri::async_runtime::spawn_blocking(move || match host {
        Some(host) => remote(&host, remote_lines_command(&target)).and_then(parse_lines),
        None => local_pane_lines(&local_client, &target),
    })
    .await
    .map_err(|error| error.to_string())?
}

#[cfg(test)]
mod tests {
    use super::*;
    use portable_pty::{native_pty_system, CommandBuilder, PtySize};
    use std::fs;
    use std::io::{Read, Write};
    use std::os::unix::fs::PermissionsExt;
    use std::path::PathBuf;
    use std::time::{Duration, Instant};

    #[test]
    fn targets_and_hosts_are_strict() {
        assert_eq!(pane_target("work", None).unwrap(), "=work:");
        assert_eq!(pane_target("my work", Some(3)).unwrap(), "=my work:3");
        for bad in ["", "  ", "a:b", "a.b", "a\nb", "a\u{7f}b", &"x".repeat(257)] {
            assert!(pane_target(bad, None).is_err(), "{bad:?} must be rejected");
        }
        assert!(valid_host("devbox"));
        assert!(valid_host("me@box.local"));
        for bad in ["", "-oProxyCommand=x", "box;rm", "box name", "box$(x)", &"h".repeat(129)] {
            assert!(!valid_host(bad), "{bad:?} must be rejected");
        }
    }

    #[test]
    fn remote_commands_quote_the_target_literally() {
        let command = remote_command("=it's $(x):1", true);
        assert!(command.starts_with("tmux copy-mode -q -t '=it'\\''s $(x):1' 2>/dev/null || "));
        assert_eq!(
            remote_command("=w:", false),
            "tmux display-message -p -t '=w:' '#{pane_in_mode}'"
        );
    }

    // An isolated server with the settings that cause the bug: mouse on and
    // vi mode keys, as a user's tmux.conf commonly sets.
    struct Server {
        directory: PathBuf,
        socket: PathBuf,
    }

    impl Server {
        fn start() -> Self {
            let directory = PathBuf::from(format!(
                "/private/tmp/pzza-pane-mode-test-{}",
                crate::agent::random_hex(6).unwrap()
            ));
            fs::create_dir(&directory).unwrap();
            fs::set_permissions(&directory, fs::Permissions::from_mode(0o700)).unwrap();
            let socket = directory.join("s");
            let server = Server { directory, socket };
            let status = Command::new("tmux")
                .args(["-f", "/dev/null", "-S"])
                .arg(&server.socket)
                .args([
                    "new-session", "-d", "-s", "work", "-x", "80", "-y", "24", "/bin/sh", ";",
                    "set-option", "-g", "mouse", "on", ";",
                    "set-window-option", "-g", "mode-keys", "vi",
                ])
                .env_remove("TMUX")
                .env("ENV", "/dev/null")
                .env("PS1", "$ ")
                .status()
                .unwrap();
            assert!(status.success());
            server
        }
        fn client(&self) -> Command {
            let mut command = Command::new("tmux");
            command.args(["-N", "-S"]).arg(&self.socket).env_remove("TMUX");
            command
        }
        fn run(&self, args: &[&str]) -> String {
            let output = bounded(self.client().args(args)).unwrap();
            assert!(output.status.success(), "tmux {args:?}: {}", String::from_utf8_lossy(&output.stderr));
            String::from_utf8_lossy(&output.stdout).into_owned()
        }
        fn wait_for_line(&self, text: &str) {
            let deadline = Instant::now() + Duration::from_secs(5);
            loop {
                let screen = self.run(&["capture-pane", "-p", "-J", "-t", "=work:"]);
                if screen.lines().any(|line| line.trim() == text) {
                    return;
                }
                assert!(Instant::now() < deadline, "{text} never appeared: {screen}");
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

    // A real attached client, as a tile is: bytes written here are what the
    // terminal sends, including mouse reports.
    struct Client {
        writer: Box<dyn Write + Send>,
        child: Box<dyn portable_pty::Child + Send + Sync>,
        // Closing the master would hang up the client.
        _master: Box<dyn portable_pty::MasterPty + Send>,
    }

    impl Client {
        fn attach(server: &Server) -> Self {
            let pair = native_pty_system()
                .openpty(PtySize { rows: 24, cols: 80, pixel_width: 0, pixel_height: 0 })
                .unwrap();
            let mut reader = pair.master.try_clone_reader().unwrap();
            std::thread::spawn(move || {
                let mut buffer = [0u8; 4096];
                while matches!(reader.read(&mut buffer), Ok(read) if read > 0) {}
            });
            let mut command = CommandBuilder::new("tmux");
            command.arg("-N");
            command.arg("-S");
            command.arg(&server.socket);
            command.args(["attach", "-t", "=work"]);
            command.env("TERM", "xterm-256color");
            command.env_remove("TMUX");
            let child = pair.slave.spawn_command(command).unwrap();
            drop(pair.slave);
            let writer = pair.master.take_writer().unwrap();
            let deadline = Instant::now() + Duration::from_secs(5);
            while server.run(&["list-clients", "-F", "#{client_name}"]).trim().is_empty() {
                assert!(Instant::now() < deadline, "the client never attached");
                std::thread::sleep(Duration::from_millis(25));
            }
            Client { writer, child, _master: pair.master }
        }
        fn send(&mut self, bytes: &str) {
            self.writer.write_all(bytes.as_bytes()).unwrap();
            self.writer.flush().unwrap();
            // Let the client hand the bytes to the server.
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    impl Drop for Client {
        fn drop(&mut self) {
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
    }

    #[test]
    fn typed_text_reaches_the_program_after_leaving_copy_mode() {
        let server = Server::start();
        let tmux = || server.client();
        // Fill the history so copy-mode has somewhere to scroll.
        server.run(&["send-keys", "-t", "=work:", "-l", "i=0; while [ $i -lt 60 ]; do echo line$i; i=$((i+1)); done"]);
        server.run(&["send-keys", "-t", "=work:", "Enter"]);
        server.wait_for_line("line59");
        let mut client = Client::attach(&server);
        assert!(!local_pane_mode(&tmux, "=work:", false).unwrap());
        // A wheel-up over the pane, as the terminal reports it with mouse on.
        client.send("\x1b[<64;10;5M\x1b[<64;10;5M");
        assert!(local_pane_mode(&tmux, "=work:", false).unwrap());
        // Without leaving, vi copy-mode swallows the keys.
        client.send("echo gone");
        assert!(local_pane_mode(&tmux, "=work:", false).unwrap());
        assert!(!local_pane_mode(&tmux, "=work:", true).unwrap());
        assert!(!local_pane_mode(&tmux, "=work:", false).unwrap());
        client.send("echo typed-after-leave\r");
        server.wait_for_line("typed-after-leave");
        // Every mode, not only copy-mode, and leaving twice is harmless.
        server.run(&["choose-tree", "-t", "=work:"]);
        assert!(local_pane_mode(&tmux, "=work:", false).unwrap());
        assert!(!local_pane_mode(&tmux, "=work:", true).unwrap());
        assert!(!local_pane_mode(&tmux, "=work:", true).unwrap());
        assert!(!local_pane_mode(&tmux, "=work:", false).unwrap());
        assert!(local_pane_mode(&tmux, "=missing:", true).is_err());
        assert!(local_pane_mode(&tmux, "=missing:", false).is_err());
    }

    #[test]
    fn pane_line_captures_are_bounded_and_quote_the_target_literally() {
        assert_eq!(capture_args("=w:2"), ["capture-pane", "-p", "-S", "-300", "-t", "=w:2"]);
        assert_eq!(
            remote_lines_command("=it's $(x):1"),
            "tmux -u capture-pane -p -S -300 -t '=it'\\''s $(x):1'"
        );
    }

    #[test]
    fn pane_lines_hold_the_bounded_history_right_above_the_visible_rows() {
        let server = Server::start();
        let tmux = || server.client();
        // More history than is read, with text a wrap and a box-drawing rule.
        server.run(&["send-keys", "-t", "=work:", "-l", "i=0; while [ $i -lt 400 ]; do echo \"row$i ╌╌\"; i=$((i+1)); done"]);
        server.run(&["send-keys", "-t", "=work:", "Enter"]);
        server.wait_for_line("row399 ╌╌");
        let lines = local_pane_lines(&tmux, "=work:").unwrap();
        let visible = server.run(&["capture-pane", "-p", "-t", "=work:"]);
        let visible: Vec<&str> = visible.strip_suffix('\n').unwrap_or(&visible).split('\n').collect();
        assert_eq!(visible.len(), 24);
        assert_eq!(lines.len(), HISTORY_ROWS as usize + visible.len());
        assert_eq!(&lines[lines.len() - visible.len()..], visible.as_slice());
        // The history row right above the screen continues it.
        let first = visible.iter().position(|line| line.starts_with("row")).unwrap();
        let shown: u32 = visible[first].trim_start_matches("row").split(' ').next().unwrap().parse().unwrap();
        assert_eq!(lines[lines.len() - visible.len() - 1 + first], format!("row{} ╌╌", shown - 1));
        assert!(local_pane_lines(&tmux, "=missing:").is_err());

        // The remote command reads the same rows, through a stand-in for the
        // device's tmux bound to this isolated server.
        let real = String::from_utf8_lossy(&Command::new("sh").args(["-c", "command -v tmux"]).output().unwrap().stdout)
            .trim()
            .to_string();
        let bin = server.directory.join("bin");
        fs::create_dir(&bin).unwrap();
        fs::write(bin.join("tmux"), format!("#!/bin/sh\nexec '{real}' -N -S '{}' \"$@\"\n", server.socket.display())).unwrap();
        fs::set_permissions(bin.join("tmux"), fs::Permissions::from_mode(0o700)).unwrap();
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let output = bounded(
            Command::new("env")
                .args(["-i", &format!("PATH={path}"), "sh", "-c", &remote_lines_command("=work:")]),
        )
        .unwrap();
        assert_eq!(parse_lines(output).unwrap(), lines);
    }

    #[test]
    fn the_remote_command_leaves_modes_even_on_a_tmux_without_quit_flag() {
        let server = Server::start();
        let real = String::from_utf8_lossy(&Command::new("sh").args(["-c", "command -v tmux"]).output().unwrap().stdout)
            .trim()
            .to_string();
        let bin = server.directory.join("bin");
        fs::create_dir(&bin).unwrap();
        // A stand-in for an older tmux: same server, but `copy-mode -q` is an unknown flag.
        let wrapper = format!(
            "#!/bin/sh\nif [ \"$1\" = copy-mode ] && [ \"$2\" = -q ]; then echo 'unknown flag -q' >&2; exit 1; fi\nexec '{real}' -N -S '{}' \"$@\"\n",
            server.socket.display()
        );
        fs::write(bin.join("tmux"), wrapper).unwrap();
        fs::set_permissions(bin.join("tmux"), fs::Permissions::from_mode(0o700)).unwrap();
        let path = format!("{}:{}", bin.display(), std::env::var("PATH").unwrap_or_default());
        let shell = |leave: bool| {
            bounded(Command::new("sh").args(["-c", &remote_command("=work:", leave)]).env("PATH", &path).env_remove("TMUX")).unwrap()
        };
        assert!(!parse_mode(shell(false)).unwrap());
        // Not in a mode: leaving succeeds and changes nothing.
        assert!(shell(true).status.success());
        server.run(&["copy-mode", "-t", "=work:"]);
        assert!(parse_mode(shell(false)).unwrap());
        assert!(shell(true).status.success());
        assert!(!parse_mode(shell(false)).unwrap());
    }
}
