use std::process::Command;

use crate::sshmux;

// The active pane's working folder comes last, so a tab inside a folder name
// cannot shift the other fields.
const SESSION_FORMAT: &str = "#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{session_created}\t#{pane_current_path}";

// A tmux session on the device. One session maps to one grid tile, and a
// session name is treated as a cmux tab.
#[derive(serde::Serialize)]
pub struct TmuxSession {
    name: String,
    windows: u32,
    attached: bool,
    command: String,
    #[serde(rename = "createdAt")]
    created_at: Option<u64>,
    // Active pane's current folder (shown in the tile footer).
    #[serde(skip_serializing_if = "Option::is_none")]
    path: Option<String>,
}

// Build the command that talks to tmux. With a host it hops over ssh and lets
// the remote shell parse the quoted format string; locally it runs tmux
// directly (used when the app runs on the devbox itself for testing).
fn tmux_capture(host: &Option<String>, remote: &str) -> std::io::Result<std::process::Output> {
    match host {
        Some(h) => Command::new("ssh")
            .args(sshmux::control_args())
            .arg(h)
            .arg(remote)
            .env_remove("PZZA_TMUX_SOCKET")
            .output(),
        None => {
            #[cfg(target_os = "macos")]
            {
                // A local server that failed to start, or ended while the app
                // runs, is started again here (at most once per retry delay).
                crate::local_tmux::ensure_running();
                local_list_command().output()
            }
            #[cfg(not(target_os = "macos"))]
            {
                Command::new("sh").arg("-c").arg(remote).output()
            }
        }
    }
}

// UTF-8 output whatever the app's locale (a Finder launch has none): without
// -u tmux prints every tab of the listing as "_", and no field could be read.
#[cfg(target_os = "macos")]
fn local_list_command() -> Command {
    let mut command = crate::local_tmux::client_command();
    command.args(["-u", "list-sessions", "-F", SESSION_FORMAT]);
    command
}

// List the tmux sessions currently on the devbox. Returns an empty list (not an
// error) when no tmux server is running yet.
// Async so the blocking ssh runs off the main thread: a session refresh against
// a dropped device must not freeze the window (see forward.rs for the same
// pattern). It returns an empty list rather than an error when the server is
// simply not up yet.
#[tauri::command]
pub async fn tmux_list_sessions(host: Option<String>) -> Result<Vec<TmuxSession>, String> {
    tauri::async_runtime::spawn_blocking(move || list_sessions_blocking(host))
        .await
        .map_err(|error| error.to_string())?
}

fn list_sessions_blocking(host: Option<String>) -> Result<Vec<TmuxSession>, String> {
    let remote = format!("tmux list-sessions -F '{SESSION_FORMAT}'");
    let output = tmux_capture(&host, &remote).map_err(|e| e.to_string())?;

    if !output.status.success() {
        let stderr = String::from_utf8_lossy(&output.stderr);
        if stderr.contains("no server running") || stderr.contains("no current session") {
            return Ok(Vec::new());
        }
        // An empty stdout with a nonzero exit and no known message is treated as
        // "nothing running" rather than a hard failure, so the grid stays usable.
        if output.stdout.is_empty() {
            return Ok(Vec::new());
        }
        return Err(stderr.trim().to_string());
    }

    let text = String::from_utf8_lossy(&output.stdout);
    let mut sessions = Vec::new();
    for line in text.lines() {
        let mut parts = line.split('\t');
        let name = parts.next().unwrap_or("").to_string();
        if name.is_empty() {
            continue;
        }
        let windows = parts.next().unwrap_or("0").parse().unwrap_or(0);
        let attached = parts.next().unwrap_or("0") != "0";
        let command = parts.next().unwrap_or("").to_string();
        let created_at = parts.next().and_then(|value| value.parse::<u64>().ok())
            .filter(|value| *value > 0).and_then(|value| value.checked_mul(1000));
        let path = parse_path(parts.collect::<Vec<_>>().join("\t"));
        sessions.push(TmuxSession {
            name,
            windows,
            attached,
            command,
            created_at,
            path,
        });
    }
    Ok(sessions)
}

// An absolute folder from tmux, or None for an empty/odd value.
fn parse_path(value: String) -> Option<String> {
    let trimmed = value.trim_end_matches(['\r', '\n']);
    (trimmed.starts_with('/') && trimmed.len() <= 4096 && !trimmed.chars().any(char::is_control))
        .then(|| trimmed.to_string())
}

#[cfg(test)]
mod tests {
    use super::parse_path;

    // Only inspects the command; it never runs against the app's server.
    #[cfg(target_os = "macos")]
    #[test]
    fn the_local_session_list_is_read_as_utf8() {
        let command = super::local_list_command();
        let args: Vec<_> = command.get_args().map(|arg| arg.to_string_lossy().into_owned()).collect();
        let list = args.iter().position(|arg| arg == "list-sessions").unwrap();
        assert!(args[..list].iter().any(|arg| arg == "-u"), "{args:?}");
        assert_eq!(args[list + 1..], ["-F".to_string(), super::SESSION_FORMAT.to_string()]);
    }

    #[test]
    fn session_paths_are_absolute_and_free_of_control_characters() {
        assert_eq!(parse_path("/Users/me/app".into()), Some("/Users/me/app".into()));
        assert_eq!(parse_path("/Users/me/with\ttab".into()), None);
        assert_eq!(parse_path("".into()), None);
        assert_eq!(parse_path("relative".into()), None);
    }
}
