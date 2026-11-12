// tmux session and window listing on the connected device (or over ssh to a
// named host, for the multi-device scan).
import { execFile } from "node:child_process";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { sh, shQuote, SSH_TOKEN, deviceEnv } from "./shell.js";
import { tmuxCommand } from "./tmux-client.js";
import { ACTIVITY_PROBE_SCRIPT, detectSessionActivity, normalizeEffectiveModel, probeSessionSnapshot } from "./session-activity.js";
import { findSessionModel } from "./session-cost.js";
import { SESSION_USAGE_AGENTS } from "./agent-usage/index.js";
import { SESSION_AGENTS, agentForProgram } from "./session-agents.js";
import { tmuxArgs } from "./tmux-client.js";

const sessionsCommand = (host) =>
  `${tmuxCommand(host)} list-sessions -F '#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}\t#{session_created}'`;

// tmux's stable window id ("@7"). Unlike an index it never moves to another
// window after renumbering or after the original window exits.
export const WINDOW_ID = /^@\d{1,9}$/;

// Exit status of a window termination whose window id is no longer in the
// session: the window already closed, and nothing else is touched.
export const WINDOW_GONE_EXIT = 4;

// Resolve an exact session before modifying it. Internal grouped views retain
// the parent's windows and processes unless they are closed with the parent.
// With a window id, only that exact window is killed, and only while it still
// belongs to the session; a bare index is the legacy form (it targets whatever
// window holds that index now).
export function terminationCommand(name, window, host, windowId) {
  if (typeof name !== "string" || !name.trim() || /[\x00-\x1f\x7f]/.test(name)) throw new Error("invalid session");
  if (window !== undefined && (!Number.isInteger(window) || window < 0)) throw new Error("invalid window");
  if (windowId !== undefined && (typeof windowId !== "string" || !WINDOW_ID.test(windowId))) throw new Error("invalid window");
  const target = shQuote("=" + name + ":");
  const tmux = tmuxCommand(host);
  if (windowId !== undefined) {
    // A session:@id target falls back to the session's current window when
    // the id is not one of its windows, so membership is checked explicitly.
    return `ids=$(${tmux} list-windows -t ${shQuote("=" + name)} -F '#{window_id}') || exit 1
printf '%s\\n' "$ids" | grep -Fqx ${shQuote(windowId)} || exit ${WINDOW_GONE_EXIT}
${tmux} kill-window -t ${shQuote(windowId)}`;
  }
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

export function terminateSession(name, window, host, windowId) {
  if (host !== undefined && (typeof host !== "string" || (host && !SSH_TOKEN.test(host)))) return Promise.reject(new Error("invalid host"));
  const targetHost = host === undefined ? (IS_CLIENT ? DEVBOX : "") : host;
  const command = terminationCommand(name, window, targetHost, windowId);
  const executable = targetHost ? "ssh" : "sh";
  const args = targetHost
    ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", targetHost, command]
    : ["-c", command];
  return new Promise((resolve, reject) => {
    execFile(executable, args, { timeout: 15_000, env: deviceEnv(targetHost) }, (error) => {
      if (!error) return resolve();
      if (windowId !== undefined && error.code === WINDOW_GONE_EXIT) {
        return reject(Object.assign(new Error("That window has already closed; nothing was terminated."), { status: 409 }));
      }
      reject(new Error("Could not close the session on this device"));
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

// Every window on the connected device, or on `host` over ssh ("" is this
// device). A device without a tmux server has none; with `host`, one that
// cannot be reached is an error, so a window tile never takes it for a
// closed window.
export function listWindows(host) {
  if (host !== undefined && (typeof host !== "string" || (host && !SSH_TOKEN.test(host)))) return Promise.reject(new Error("invalid host"));
  const command = (target) => `${tmuxCommand(target)} list-windows -a -F '#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_command}\t#{pane_current_path}\t#{window_id}'`;
  return new Promise((resolve, reject) => {
    const done = (err, out, stderr) => {
      if (err && host !== undefined && !/no server running|no sessions|error connecting.*No such file/.test(String(stderr || ""))) {
        return reject(new Error("Could not list the windows on this device"));
      }
      if (err) return resolve([]);
      const wins = [];
      for (const line of String(out || "").split("\n")) {
        if (!line) continue;
        const [session, index, wname, active, command, path, windowId] = line.split("\t");
        if (session) {
          wins.push({
            session,
            window: Number(index) || 0,
            windowName: wname || "",
            active: active === "1",
            command: command || "",
            path: path || "",
            // Stable id a window tile keeps so Terminate targets this exact window.
            ...(WINDOW_ID.test(windowId || "") ? { windowId } : {}),
          });
        }
      }
      resolve(wins);
    };
    if (host === undefined) return sh(command(), done);
    execFile(host ? "ssh" : "sh", host
      ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", host, command(host)]
      : ["-c", command("")], { timeout: 15_000, env: deviceEnv(host) }, done);
  });
}


const pendingActivity = new Map();
const activityCache = new Map();
// Per-process selector reads of the local probe, reused across polls.
const localProcessReads = new Map();
const ACTIVITY_FRESH_MS = 1_000;
// -u: without it a localeless SSH command gets `_` in place of every tab.
// Pane command names (tmux pane_current_command) that identify a catalog agent.
const AGENT_FALLBACK_CASES = SESSION_AGENTS.flatMap((agent) => {
  const names = agent.detect.programs.filter((name) => agentForProgram(name) === agent.id);
  return names.length ? [`${names.join("|")}) command=${agent.id} ;;`] : [];
}).join(" ");
const ACTIVITY_FALLBACK = `tmux -u list-panes -a -F '#{session_name}\t#{window_index}\t#{window_active}\t#{pane_active}\t#{pane_current_command}' | while IFS="$(printf '\\t')" read -r session window active pane_active command; do [ "$pane_active" = 1 ] || continue; case "$command" in ${AGENT_FALLBACK_CASES} bash|zsh|fish|sh|dash|node|nodejs|bun|deno|python|python3|git|vim|nvim|less|ssh|tmux|btop|htop|top|yazi|ranger|nnn|lf|docker|lazydocker) ;; *) command=;; esac; printf '%s\\t%s\\t%s\\t%s\\n' "$session" "$window" "$active" "$command"; done`;

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
          // A remote row carries its own pane count; none (an older device) stays unknown.
          .map((row) => ({ ...row, paneActive: true, paneCount: Number.isInteger(row.panes) && row.panes > 0 && row.panes < 1000 ? row.panes : null }));
        return resolve(detectSessionActivity(panes, []));
      } catch {
        const panes = String(stdout).split("\n").filter(Boolean).map((line) => {
          const [session, window, active, command] = line.split("\t");
          return { session, window: Number(window), active: active === "1", paneActive: true, command, paneCount: null };
        }).filter((pane) => pane.session && Number.isInteger(pane.window));
        return resolve(detectSessionActivity(panes, []));
      }
    });
  }) : probeSessionSnapshot(tmuxArgs([]), localProcessReads).then(({ rows, panes }) => withReportedModels(rows, panes))).then((rows) => {
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
// One tmux invocation enables it globally, names each window whose own setting
// still turns it off (a `W@<id>` line), and lists the panes.
export const outputActivityScript = (host) =>
  `${tmuxCommand(host)} set-window-option -g monitor-activity on \\; ` +
  `list-windows -a -F '#{?monitor-activity,,W#{window_id}}' \\; ` +
  `list-panes -a -F '#{session_name}\t#{window_index}\t#{window_activity}\t#{pane_current_command}' 2>/dev/null`;

// Turns monitoring on for the given windows in one chained tmux invocation.
export const monitorWindowsScript = (host, windowIds) =>
  `${tmuxCommand(host)} ${windowIds.map((id) => `set-window-option -t ${shQuote(id)} monitor-activity on`).join(" \\; ")} 2>/dev/null`;

export function unmonitoredWindows(out) {
  return [...new Set(String(out || "").split("\n").filter((line) => /^W@\d+$/.test(line)).map((line) => line.slice(1)))];
}

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
  const run = (command, callback) => execFile(targetHost ? "ssh" : "sh", targetHost
    ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", targetHost, command]
    : ["-c", command], { timeout: 15000, env: deviceEnv(targetHost) }, callback);
  return new Promise((resolve, reject) => {
    run(outputActivityScript(targetHost), (error, output, stderr) => {
      if (error && !/no server running|no sessions|error connecting.*No such file/.test(stderr || "")) return reject(new Error("Could not read output activity on this device"));
      if (error) return resolve([]);
      const rows = parsePaneOutputActivity(output);
      const windows = unmonitoredWindows(output);
      // Usually empty: only windows created with their own setting off.
      if (!windows.length) return resolve(rows);
      run(monitorWindowsScript(targetHost, windows), () => resolve(rows));
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

// Active-pane folders from the probe's own pane listing.
function paneFolders(panes) {
  const folders = new Map();
  for (const pane of panes) {
    if (pane.paneActive && pane.cwd?.startsWith("/")) folders.set(`${pane.session}\t${pane.window}`, { cwd: pane.cwd, since: pane.created * 1000 || 0 });
  }
  return folders;
}

async function reportedModel(provider, cwd, since) {
  const key = `${provider}\t${cwd}`;
  const cached = reportedModels.get(key);
  if (cached && Date.now() - cached.at < REPORTED_MODEL_TTL_MS) return cached.model;
  const model = normalizeEffectiveModel(await findSessionModel({ provider, cwd, since }).catch(() => null), provider);
  const found = model && model.provider === provider ? model.model : null;
  reportedModels.set(key, { at: Date.now(), model: found });
  if (reportedModels.size > 256) reportedModels.delete(reportedModels.keys().next().value);
  return found;
}

const REPORTING_AGENTS = new Set(SESSION_USAGE_AGENTS);

export async function withReportedModels(rows, panes) {
  if (!rows.some((row) => REPORTING_AGENTS.has(row.command))) return rows;
  const folders = paneFolders(panes);
  return Promise.all(rows.map(async (row) => {
    if (!REPORTING_AGENTS.has(row.command)) return row;
    const pane = folders.get(`${row.session}\t${row.window}`);
    if (!pane) return row;
    const model = await reportedModel(row.command, pane.cwd, pane.since);
    return model ? { ...row, effectiveModel: model, effectiveProvider: row.command, effectiveModelEvidence: "reported" } : row;
  }));
}
