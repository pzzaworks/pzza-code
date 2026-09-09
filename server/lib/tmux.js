// tmux session and window listing on the connected device (or over ssh to a
// named host, for the multi-device scan).
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { sh, shQuote, SSH_TOKEN, deviceEnv } from "./shell.js";
import { tmuxCommand } from "./tmux-client.js";
import { ACTIVITY_PROBE_SCRIPT, detectSessionActivity, probeSessionActivity } from "./session-activity.js";

const sessionsCommand = (host) =>
  `${tmuxCommand(host)} list-sessions -F '#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}\t#{session_created}'`;

// Resolve an exact session before modifying it. Internal grouped views retain
// the parent's windows and processes unless they are closed with the parent.
export function terminationCommand(name, window, host) {
  if (typeof name !== "string" || !name.trim() || /[\x00-\x1f\x7f]/.test(name)) throw new Error("invalid session");
  if (window !== undefined && (!Number.isInteger(window) || window < 0)) throw new Error("invalid window");
  const target = shQuote("=" + name + ":");
  const tmux = tmuxCommand(host);
  if (window !== undefined) return `${tmux} kill-window -t ${shQuote("=" + name + ":" + window)}`;
  return `session_id=$(${tmux} display-message -p -t ${target} '#{session_id}') || exit 1
[ -n "$session_id" ] || exit 1
group=$(${tmux} display-message -p -t "$session_id:" '#{session_group}') || exit 1
if [ -n "$group" ]; then
  views=$(${tmux} list-sessions -F '#{session_id}\t#{session_group}\t#{session_name}') || exit 1
  printf '%s\n' "$views" | while IFS="$(printf '\t')" read -r view_id view_group view_name; do
    [ "$view_group" = "$group" ] || continue
    [ "$view_id" != "$session_id" ] || continue
    case "$view_name" in pzza-v-*) ${tmux} kill-session -t "$view_id" || exit 1 ;; esac
  done || exit 1
fi
${tmux} kill-session -t "$session_id"`;
}

export function terminateSession(name, window, host) {
  if (host !== undefined && (typeof host !== "string" || (host && !SSH_TOKEN.test(host)))) return Promise.reject(new Error("invalid host"));
  const targetHost = host === undefined ? (IS_CLIENT ? DEVBOX : "") : host;
  const command = terminationCommand(name, window, targetHost);
  const executable = targetHost ? "ssh" : "sh";
  const args = targetHost
    ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", targetHost, command]
    : ["-c", command];
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 15_000, env: deviceEnv(targetHost) }, (error) => {
      if (error) reject(new Error("Could not close the session on this device"));
      else resolve();
    });
  });
}

// Resolve the source's live pane rather than a cached path from the UI. A copy
// starts a separate shell, so terminating it cannot affect the original pane.
export function duplicationCommand(name, window, copyName, host) {
  if (typeof name !== "string" || !name.trim() || /[\x00-\x1f\x7f]/.test(name)) throw new Error("invalid session");
  if (window !== undefined && (!Number.isInteger(window) || window < 0)) throw new Error("invalid window");
  if (typeof copyName !== "string" || !/^[A-Za-z0-9_-]+$/.test(copyName)) throw new Error("invalid copy name");
  const target = shQuote(`=${name}:${window ?? ""}`);
  const tmux = tmuxCommand(host);
  return `cwd=$(${tmux} display-message -p -t ${target} '#{pane_current_path}') || exit 1
[ -n "$cwd" ] && [ -d "$cwd" ] || exit 1
${tmux} new-session -d -s ${shQuote(copyName)} -c "$cwd" || exit 1
printf '%s' "$cwd"`;
}

export function duplicateSession(name, window, host) {
  if (host !== undefined && (typeof host !== "string" || (host && !SSH_TOKEN.test(host)))) return Promise.reject(new Error("invalid host"));
  const prefix = typeof name === "string" ? name.replace(/[^A-Za-z0-9_-]/g, "-").slice(0, 60) : "";
  const copyName = `${prefix || "session"}-copy-${randomUUID()}`;
  const targetHost = host === undefined ? (IS_CLIENT ? DEVBOX : "") : host;
  const command = duplicationCommand(name, window, copyName, targetHost);
  return new Promise((resolve, reject) => {
    execFile(targetHost ? "ssh" : "sh", targetHost
      ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", targetHost, command]
      : ["-c", command], { timeout: 15_000, maxBuffer: 64 * 1024, env: deviceEnv(targetHost) }, (error, cwd) => {
      if (error) reject(new Error("Could not duplicate the session on this device. Check that the source window is still running."));
      else resolve({ name: copyName, cwd });
    });
  });
}

export function parseSessions(out) {
  const sessions = [];
  for (const line of String(out || "").split("\n")) {
    if (!line) continue;
    const [name, windows, attached, command, path, created] = line.split("\t");
    if (name) {
      sessions.push({
        name,
        windows: Number(windows) || 0,
        attached: attached !== "0",
        command: command || "",
        path: path || "",
        createdAt: Number.isFinite(Number(created)) && Number(created) > 0 ? Number(created) * 1000 : null,
      });
    }
  }
  return sessions;
}

export function listSessions() {
  return new Promise((resolve) => {
    sh(sessionsCommand(), (err, out) => resolve(err ? [] : parseSessions(out)));
  });
}

// Scan every tmux session on a device (including ones the app never opened).
export function scanSessions(host) {
  if (host !== undefined && (typeof host !== "string" || (host && !SSH_TOKEN.test(host)))) return Promise.reject(new Error("invalid host"));
  const targetHost = host === undefined ? (IS_CLIENT ? DEVBOX : "") : host;
  const command = sessionsCommand(targetHost);
  return new Promise((resolve, reject) => {
    execFile(targetHost ? "ssh" : "sh", targetHost
      ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", targetHost, command]
      : ["-c", command], { timeout: 15000, env: deviceEnv(targetHost) }, (error, output, stderr) => {
      if (error && !/no server running|no sessions|error connecting.*No such file/.test(stderr || "")) return reject(new Error("Could not scan sessions on this device"));
      resolve(error ? [] : parseSessions(output));
    });
  });
}

export function listWindows() {
  return new Promise((resolve) => {
    sh(
      `${tmuxCommand()} list-windows -a -F '#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_command}\t#{pane_current_path}'`,
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


const pendingActivity = new Map();
const activityCache = new Map();
const ACTIVITY_FRESH_MS = 1_000;
const ACTIVITY_FALLBACK = `tmux list-panes -a -F '#{session_name}\t#{window_index}\t#{window_active}\t#{pane_active}\t#{pane_current_command}' | while IFS="$(printf '\\t')" read -r session window active pane_active command; do [ "$pane_active" = 1 ] || continue; case "$command" in claude|codex|bash|zsh|fish|sh|dash|node|nodejs|bun|deno|python|python3|git|vim|nvim|less|ssh|tmux|btop|htop|top|yazi|ranger|nnn|lf|docker|lazydocker) ;; *) command=;; esac; printf '%s\\t%s\\t%s\\t%s\\n' "$session" "$window" "$active" "$command"; done`;

export function sessionActivity(host) {
  if (host !== undefined && (typeof host !== "string" || (host && !SSH_TOKEN.test(host)))) return Promise.reject(new Error("invalid host"));
  const target = host === undefined ? (IS_CLIENT ? DEVBOX : "") : host;
  const cached = activityCache.get(target);
  if (cached && Date.now() - cached.at < ACTIVITY_FRESH_MS) return Promise.resolve(cached.rows);
  if (pendingActivity.has(target)) return pendingActivity.get(target);
  const request = (target ? new Promise((resolve) => {
    const command = "ssh";
    const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/pzza-mux-%C", "-o", "ControlPersist=120", target,
        `if command -v node >/dev/null 2>&1; then node -e ${shQuote(ACTIVITY_PROBE_SCRIPT)}; else ${ACTIVITY_FALLBACK}; fi`];
    execFile(command, args, { timeout: 9_000, maxBuffer: 1024 * 1024, env: deviceEnv(target) }, (error, stdout) => {
      if (error) return resolve([]);
      try {
        const rows = JSON.parse(stdout);
        if (!Array.isArray(rows)) return resolve([]);
        return resolve(detectSessionActivity(rows.map((row) => ({ ...row, paneActive: true })), []));
      } catch {
        const panes = String(stdout).split("\n").filter(Boolean).map((line) => {
          const [session, window, active, command] = line.split("\t");
          return { session, window: Number(window), active: active === "1", paneActive: true, command };
        }).filter((pane) => pane.session && Number.isInteger(pane.window));
        return resolve(detectSessionActivity(panes, []));
      }
    });
  }) : probeSessionActivity()).then((rows) => {
    for (const [key, value] of activityCache) {
      if (Date.now() - value.at >= ACTIVITY_FRESH_MS) activityCache.delete(key);
    }
    activityCache.set(target, { at: Date.now(), rows });
    return rows;
  }).finally(() => pendingActivity.delete(target));
  pendingActivity.set(target, request);
  return request;
}
