// tmux pane modes (copy-mode, view-mode, choose-tree...). With `mouse on` in
// a user's tmux.conf a wheel-up or a drag over a pane enters copy-mode, and
// while a mode is active every key goes to the mode instead of the program.
// A tile asks here whether its pane is in a mode and leaves the mode before
// delivering typed input.
import { execFile } from "node:child_process";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { SSH_TOKEN, deviceEnv, shQuote } from "./shell.js";
import { tmuxCommand } from "./tmux-client.js";

const SESSION_MAX_LENGTH = 256;
// How far above the visible rows a pane's history is read: enough for a long
// command in an approval prompt that starts above the screen.
export const PANE_HISTORY_ROWS = 300;
const PANE_OUTPUT_BYTES = 2 * 1024 * 1024;

export class PaneModeRequestError extends Error {}

// The active pane of the session's current window, or of one window. tmux
// never allows ":" or "." in a session name, so neither can widen the target.
export function paneTarget(name, window) {
  if (typeof name !== "string" || !name.trim() || name.length > SESSION_MAX_LENGTH || /[\x00-\x1f\x7f:.]/.test(name)) {
    throw new PaneModeRequestError("Invalid session name");
  }
  if (window !== undefined && (!Number.isSafeInteger(window) || window < 0)) throw new PaneModeRequestError("Invalid window");
  return `=${name}:${window ?? ""}`;
}

// One shell command: either print #{pane_in_mode}, or leave every mode.
// `copy-mode -q` cancels any mode; a tmux too old for -q can still leave copy
// and view mode with the cancel command, which fails only when no mode is on.
export function paneModeCommand(name, window, host, leave) {
  const target = shQuote(paneTarget(name, window));
  const tmux = tmuxCommand(host);
  const probe = `${tmux} display-message -p -t ${target} '#{pane_in_mode}'`;
  if (!leave) return probe;
  return `${tmux} copy-mode -q -t ${target} 2>/dev/null || { [ "$(${probe})" = 0 ] || ${tmux} send-keys -X -t ${target} cancel; }`;
}

// Validates an HTTP body naming a pane into { name, window, host }.
export function paneLinesRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new PaneModeRequestError("Invalid request");
  if (body.host !== undefined && (typeof body.host !== "string" || (body.host && !SSH_TOKEN.test(body.host)))) {
    throw new PaneModeRequestError("Invalid device host");
  }
  const window = body.window === null ? undefined : body.window;
  paneTarget(body.name, window);
  return { name: body.name, window, host: body.host };
}

// Validates an HTTP body into { name, window, host, leave }.
export function paneModeRequest(body) {
  const request = paneLinesRequest(body);
  if (typeof body.leave !== "boolean") throw new PaneModeRequestError("Invalid request");
  return { ...request, leave: body.leave };
}

// The pane's last PANE_HISTORY_ROWS history rows and its visible rows in one
// capture, so the two line up. No -J: rows stay wrapped as on screen.
export function paneLinesCommand(name, window, host) {
  return `${tmuxCommand(host)} capture-pane -p -S -${PANE_HISTORY_ROWS} -t ${shQuote(paneTarget(name, window))}`;
}

// Resolves { lines }: the pane's recent history and visible rows, oldest first.
export function paneLines({ name, window, host }) {
  const targetHost = paneHost(host);
  const command = paneLinesCommand(name, window, targetHost);
  return new Promise((resolve, reject) => {
    runOnPaneHost(targetHost, command, (error, stdout) => {
      if (error) return reject(new Error("Could not read the terminal pane on this device"));
      resolve({ lines: String(stdout).replace(/\n$/, "").split("\n") });
    });
  });
}

// The pane's device: this one, or the dev box a client build reaches.
function paneHost(host) {
  return host === undefined ? (IS_CLIENT ? DEVBOX : "") : host;
}

// Runs one tmux command line on the pane's device, bounded tightly: typed
// input and approval answers wait on it.
function runOnPaneHost(targetHost, command, callback) {
  const executable = targetHost ? "ssh" : "sh";
  const args = targetHost
    ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=4", "-o", "StrictHostKeyChecking=accept-new", targetHost, command]
    : ["-c", command];
  execFile(executable, args, { timeout: 5000, maxBuffer: PANE_OUTPUT_BYTES, env: deviceEnv(targetHost) }, callback);
}

// Resolves { inMode }: whether the pane is in a mode now. Leaving reports
// false once tmux confirmed it.
export function paneMode({ name, window, host, leave }) {
  const targetHost = paneHost(host);
  const command = paneModeCommand(name, window, targetHost, leave);
  return new Promise((resolve, reject) => {
    runOnPaneHost(targetHost, command, (error, stdout) => {
      if (error) return reject(new Error("Could not reach the terminal pane on this device"));
      if (leave) return resolve({ inMode: false });
      const value = String(stdout).trim();
      if (value !== "0" && value !== "1") return reject(new Error("Could not read the terminal pane mode"));
      resolve({ inMode: value === "1" });
    });
  });
}
