use std::process::Command;

// A tmux session on the device. One session maps to one grid tile, and a
// session name is treated as a cmux tab.
#[derive(serde::Serialize)]
pub struct TmuxSession {
    name: String,
    windows: u32,
    attached: bool,
    command: String,
}

// Build the command that talks to tmux. With a host it hops over ssh and lets
// the remote shell parse the quoted format string; locally it runs tmux
// directly (used when the app runs on the devbox itself for testing).
fn tmux_capture(host: &Option<String>, remote: &str) -> std::io::Result<std::process::Output> {
    match host {
        Some(h) => Command::new("ssh").arg(h).arg(remote).output(),
        None => Command::new("sh").arg("-c").arg(remote).output(),
    }
}

// List the tmux sessions currently on the devbox. Returns an empty list (not an
// error) when no tmux server is running yet.
#[tauri::command]
pub fn tmux_list_sessions(host: Option<String>) -> Result<Vec<TmuxSession>, String> {
    let remote =
        "tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}'";
    let output = tmux_capture(&host, remote).map_err(|e| e.to_string())?;

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
        sessions.push(TmuxSession {
            name,
            windows,
            attached,
            command,
        });
    }
    Ok(sessions)
}
