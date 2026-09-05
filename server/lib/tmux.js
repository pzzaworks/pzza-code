// tmux session and window listing on the connected device (or over ssh to a
// named host, for the multi-device scan).
import { sh, shOn } from "./shell.js";

const SESSIONS_CMD =
  "tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}'";

export function parseSessions(out) {
  const sessions = [];
  for (const line of String(out || "").split("\n")) {
    if (!line) continue;
    const [name, windows, attached, command, path] = line.split("\t");
    if (name) {
      sessions.push({
        name,
        windows: Number(windows) || 0,
        attached: attached !== "0",
        command: command || "",
        path: path || "",
      });
    }
  }
  return sessions;
}

export function listSessions() {
  return new Promise((resolve) => {
    sh(SESSIONS_CMD, (err, out) => resolve(err ? [] : parseSessions(out)));
  });
}

// Scan every tmux session on a device (including ones the app never opened).
export function scanSessions(host) {
  return new Promise((resolve) => {
    shOn(host, SESSIONS_CMD, (err, out) => resolve(err ? [] : parseSessions(out)));
  });
}

export function listWindows() {
  return new Promise((resolve) => {
    sh(
      "tmux list-windows -a -F '#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_command}\t#{pane_current_path}'",
      (err, out) => {
        if (err) return resolve([]);
        const wins = [];
        for (const line of out.split("\n")) {
          if (!line) continue;
          const [session, index, wname, active, command, path] = line.split("\t");
          if (session) {
            wins.push({
              session,
              window: Number(index) || 0,
              windowName: wname || "",
              active: active === "1",
              command: command || "",
              path: path || "",
            });
          }
        }
        resolve(wins);
      },
    );
  });
}
