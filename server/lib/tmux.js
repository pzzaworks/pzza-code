// tmux session and window listing on the connected device (or over ssh to a
// named host, for the multi-device scan).
import { execFile } from "node:child_process";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { sh, shQuote, SSH_TOKEN, deviceEnv } from "./shell.js";
import { tmuxCommand } from "./tmux-client.js";
import { ACTIVITY_PROBE_SCRIPT, detectSessionActivity, normalizeEffectiveModel, probeSessionActivity } from "./session-activity.js";
import { findSessionModel } from "./session-cost.js";
import { tmuxArgs } from "./tmux-client.js";

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
// The copy is named "<base>", then "<base> 2", "<base> 3"... on the device
// itself, so the name stays readable and unique among that device's sessions.
// Prints the chosen name on the first line and the folder after it.
const MAX_COPIES = 999;
// Letters, digits, spaces, - and _ (as session names allow), no outer spaces.
const COPY_NAME = /^[A-Za-z0-9_-](?:[A-Za-z0-9_ -]*[A-Za-z0-9_-])?$/;
export function duplicationCommand(name, window, copyBase, host) {
  if (typeof name !== "string" || !name.trim() || /[\x00-\x1f\x7f]/.test(name)) throw new Error("invalid session");
  if (window !== undefined && (!Number.isInteger(window) || window < 0)) throw new Error("invalid window");
  if (typeof copyBase !== "string" || !COPY_NAME.test(copyBase)) throw new Error("invalid copy name");
  const target = shQuote(`=${name}:${window ?? ""}`);
  const tmux = tmuxCommand(host);
  return `cwd=$(${tmux} display-message -p -t ${target} '#{pane_current_path}') || exit 1
[ -n "$cwd" ] && [ -d "$cwd" ] || exit 1
copy=${shQuote(copyBase)}; n=1
while ${tmux} has-session -t "=$copy" 2>/dev/null; do
  n=$((n + 1)); [ "$n" -le ${MAX_COPIES} ] || exit 1; copy=${shQuote(copyBase)}" $n"
done
${tmux} new-session -d -s "$copy" -c "$cwd" || exit 1
printf '%s\\n%s' "$copy" "$cwd"`;
}

export function duplicateSession(name, window, host) {
  if (host !== undefined && (typeof host !== "string" || (host && !SSH_TOKEN.test(host)))) return Promise.reject(new Error("invalid host"));
  const prefix = typeof name === "string" ? name.replace(/[^A-Za-z0-9_ -]/g, "-").replace(/\s+/g, " ").trim().slice(0, 60).trim() : "";
  const copyBase = `${prefix || "session"} Copy`;
  const targetHost = host === undefined ? (IS_CLIENT ? DEVBOX : "") : host;
  const command = duplicationCommand(name, window, copyBase, targetHost);
  return new Promise((resolve, reject) => {
    execFile(targetHost ? "ssh" : "sh", targetHost
      ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", targetHost, command]
      : ["-c", command], { timeout: 15_000, maxBuffer: 64 * 1024, env: deviceEnv(targetHost) }, (error, output) => {
      const text = String(output ?? "");
      const split = text.indexOf("\n");
      const copyName = split > 0 ? text.slice(0, split) : "";
      if (error || !COPY_NAME.test(copyName)) reject(new Error("Could not duplicate the session on this device. Check that the source window is still running."));
      else resolve({ name: copyName, cwd: text.slice(split + 1) });
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
// -u: without it a localeless SSH command gets `_` in place of every tab.
const ACTIVITY_FALLBACK = `tmux -u list-panes -a -F '#{session_name}\t#{window_index}\t#{window_active}\t#{pane_active}\t#{pane_current_command}' | while IFS="$(printf '\\t')" read -r session window active pane_active command; do [ "$pane_active" = 1 ] || continue; case "$command" in claude|codex|opencode|bash|zsh|fish|sh|dash|node|nodejs|bun|deno|python|python3|git|vim|nvim|less|ssh|tmux|btop|htop|top|yazi|ranger|nnn|lf|docker|lazydocker) ;; *) command=;; esac; printf '%s\\t%s\\t%s\\t%s\\n' "$session" "$window" "$active" "$command"; done`;

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
        // Reclassify remote rows before returning them. The activity detector
        // validates and retains only normalized effective-model metadata.
        const panes = rows.filter((row) => row && typeof row === "object" && !Array.isArray(row))
          .map((row) => ({ ...row, paneActive: true }));
        return resolve(detectSessionActivity(panes, []));
      } catch {
        const panes = String(stdout).split("\n").filter(Boolean).map((line) => {
          const [session, window, active, command] = line.split("\t");
          return { session, window: Number(window), active: active === "1", paneActive: true, command };
        }).filter((pane) => pane.session && Number.isInteger(pane.window));
        return resolve(detectSessionActivity(panes, []));
      }
    });
  }) : probeSessionActivity().then(withReportedModels)).then((rows) => {
    for (const [key, value] of activityCache) {
      if (Date.now() - value.at >= ACTIVITY_FRESH_MS) activityCache.delete(key);
    }
    activityCache.set(target, { at: Date.now(), rows });
    return rows;
  }).finally(() => pendingActivity.delete(target));
  pendingActivity.set(target, request);
  return request;
}

// Output-activity probe for hidden tiles: per-pane last-activity epoch so the
// UI can light a notification dot without streaming any pty output.
// monitor-activity only records the timestamp; visual-activity stays off so no
// activity messages are injected into attached terminals.
const outputActivityScript = (host) => {
  const tmux = tmuxCommand(host);
  return (
    `${tmux} set-window-option -g monitor-activity on 2>/dev/null; ` +
    `${tmux} list-windows -a -F '#{session_name}:#{window_index}' 2>/dev/null | ` +
    `while IFS= read -r target; do case "$target" in *:*[0-9]*) ${tmux} set-window-option -t "$target" monitor-activity on 2>/dev/null;; esac; done; ` +
    `${tmux} list-panes -a -F '#{session_name}\t#{window_index}\t#{window_activity}\t#{pane_current_command}' 2>/dev/null`
  );
};

export function parsePaneOutputActivity(out) {
  const rows = [];
  for (const line of String(out || "").split("\n")) {
    if (!line) continue;
    const [session, window, activity, command] = line.split("\t");
    if (!session || /[\x00-\x1f\x7f]/.test(session)) continue;
    const windowIndex = Number(window);
    const lastActivity = Number(activity);
    if (!Number.isInteger(windowIndex) || windowIndex < 0) continue;
    if (!Number.isInteger(lastActivity) || lastActivity < 0) continue;
    rows.push({ session, window: windowIndex, activity: lastActivity, command: typeof command === "string" ? command : "" });
  }
  return rows;
}

// Last-output epoch per tmux pane on a device (including sessions the app
// never opened). Never rejects on a missing server: no tmux = no activity.
export function paneOutputActivity(host) {
  if (host !== undefined && (typeof host !== "string" || (host && !SSH_TOKEN.test(host)))) return Promise.reject(new Error("invalid host"));
  const targetHost = host === undefined ? (IS_CLIENT ? DEVBOX : "") : host;
  const command = outputActivityScript(targetHost);
  return new Promise((resolve, reject) => {
    execFile(targetHost ? "ssh" : "sh", targetHost
      ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", targetHost, command]
      : ["-c", command], { timeout: 15000, env: deviceEnv(targetHost) }, (error, output, stderr) => {
      if (error && !/no server running|no sessions|error connecting.*No such file/.test(stderr || "")) return reject(new Error("Could not read output activity on this device"));
      resolve(error ? [] : parsePaneOutputActivity(output));
    });
  });
}

// Local agent sessions: the model the agent's newest reply actually used,
// read from its own transcript, is reported evidence and beats a configured
// guess (settings often name an alias such as "opus", or nothing at all).
// Lookups are cached per agent and folder briefly so the 1 s activity poll
// does not walk transcript folders each time.
const REPORTED_MODEL_TTL_MS = 15_000;
const reportedModels = new Map();

function localPaneFolders() {
  return new Promise((resolve) => {
    execFile("tmux", ["-u", ...tmuxArgs([]), "list-panes", "-a", "-F", "#{session_name}\t#{window_index}\t#{pane_active}\t#{session_created}\t#{pane_current_path}"],
      { timeout: 3_000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
        const folders = new Map();
        if (!error) for (const line of String(stdout).split("\n")) {
          const [session, window, active, created, cwd] = line.split("\t");
          if (active === "1" && cwd?.startsWith("/")) folders.set(`${session}\t${window}`, { cwd, since: Number(created) * 1000 || 0 });
        }
        resolve(folders);
      });
  });
}

async function reportedModel(provider, cwd, since) {
  const key = `${provider}\t${cwd}`;
  const cached = reportedModels.get(key);
  if (cached && Date.now() - cached.at < REPORTED_MODEL_TTL_MS) return cached.model;
  const model = normalizeEffectiveModel(await findSessionModel({ provider, cwd, since }).catch(() => null));
  const found = model && model.provider === provider ? model.model : null;
  reportedModels.set(key, { at: Date.now(), model: found });
  if (reportedModels.size > 256) reportedModels.delete(reportedModels.keys().next().value);
  return found;
}

export async function withReportedModels(rows) {
  const agents = rows.filter((row) => row.command === "claude" || row.command === "codex");
  if (!agents.length) return rows;
  const folders = await localPaneFolders();
  return Promise.all(rows.map(async (row) => {
    if (row.command !== "claude" && row.command !== "codex") return row;
    const pane = folders.get(`${row.session}\t${row.window}`);
    if (!pane) return row;
    const model = await reportedModel(row.command, pane.cwd, pane.since);
    return model ? { ...row, effectiveModel: model, effectiveProvider: row.command, effectiveModelEvidence: "reported" } : row;
  }));
}
