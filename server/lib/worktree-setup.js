// Per-repository setup for new worktrees. A fresh worktree has none of the
// main checkout's ignored files (.env, local config), so each repository can
// keep .pzzacode/worktree.json in its main checkout, shared with the team:
//
//   { "copy": [".env", "config/*.local.json"], "run": ["npm install"] }
//
// "copy" lists glob patterns of untracked files to copy from the main checkout
// into each new worktree; without it, ignored .env* files at the repository
// root are copied. "run" lists shell commands typed into the new session's
// terminal before its agent starts. A repository file must never execute on
// its own, so commands only run once they are approved on this device for
// that exact list (saving them here approves them; a changed list asks again).
//
// Everything runs as fixed POSIX scripts whose inputs are positional
// arguments: locally through /bin/sh, on another device over one ssh call.
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import nodePath from "node:path";
import { DEVBOX, IS_CLIENT, STATE_DIR } from "./config.js";
import { SSH_TOKEN, deviceEnv } from "./shell.js";
import { GitReviewError, remoteGitReviewCommand } from "./git-review.js";

export const WORKTREE_SETUP_LIMITS = {
  pathLength: 4096,
  configBytes: 16 * 1024,
  patterns: 32,
  patternLength: 200,
  commands: 8,
  commandLength: 500,
  files: 200,
  fileBytes: 1024 * 1024,
  totalBytes: 16 * 1024 * 1024,
  approvals: 500,
  scriptMs: 20000,
  copyMs: 30000,
  buffer: 256 * 1024,
};

export const WORKTREE_CONFIG_FILE = ".pzzacode/worktree.json";
// Used when the file is missing or has no "copy" list: ignored .env* files at
// the repository root ("*" never crosses a "/").
export const DEFAULT_COPY_PATTERNS = [".env*"];

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const RS = "\u001e";
const DEFAULT_APPROVALS_FILE = nodePath.join(STATE_DIR, "worktree-setup-approvals.json");

// ------------------------------------------------------------------- config

// A repository-relative glob: no absolute paths, no "." or ".." segments,
// nothing inside .git, and no leading ":" (Git pathspec magic is added by the
// copy script, never taken from the file).
export function validCopyPattern(pattern) {
  if (typeof pattern !== "string" || !pattern || pattern.length > WORKTREE_SETUP_LIMITS.patternLength || CONTROL.test(pattern)) return false;
  if (pattern.startsWith("/") || pattern.startsWith(":") || pattern.includes("\\")) return false;
  return pattern.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

// One shell command line: typed into a terminal, so it must stay on one line.
export function validSetupCommand(command) {
  return typeof command === "string" && command.length > 0 && command.length <= WORKTREE_SETUP_LIMITS.commandLength
    && command.trim() === command && !CONTROL.test(command);
}

function listOf(value, field, max, valid, normalize) {
  if (!Array.isArray(value)) throw new Error(`"${field}" must be a list of strings.`);
  if (value.length > max) throw new Error(`"${field}" can hold at most ${max} entries.`);
  const items = [];
  for (const raw of value) {
    const item = typeof raw === "string" ? normalize(raw) : raw;
    if (!valid(item)) throw new Error(`"${field}" has an invalid entry: ${typeof raw === "string" ? JSON.stringify(raw.slice(0, 80)) : typeof raw}.`);
    if (!items.includes(item)) items.push(item);
  }
  return items;
}

// { copy: string[] | null (null = the default patterns), run: string[] }.
export function normalizeWorktreeConfig(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("The setup must be a JSON object.");
  const unknown = Object.keys(value).find((key) => !["copy", "run"].includes(key));
  if (unknown !== undefined) throw new Error(`Unknown setup field "${unknown.slice(0, 40)}".`);
  const copy = value.copy === undefined ? null
    : listOf(value.copy, "copy", WORKTREE_SETUP_LIMITS.patterns, validCopyPattern, (item) => item.trim().replace(/^\.\/+/, ""));
  const run = value.run === undefined ? []
    : listOf(value.run, "run", WORKTREE_SETUP_LIMITS.commands, validSetupCommand, (item) => item.trim());
  return { copy, run };
}

export function parseWorktreeConfig(text) {
  if (Buffer.byteLength(text) > WORKTREE_SETUP_LIMITS.configBytes) throw new Error(`${WORKTREE_CONFIG_FILE} is larger than ${WORKTREE_SETUP_LIMITS.configBytes / 1024} KiB.`);
  let value;
  try { value = JSON.parse(text); } catch { throw new Error(`${WORKTREE_CONFIG_FILE} is not valid JSON.`); }
  return normalizeWorktreeConfig(value);
}

export function serializeWorktreeConfig({ copy, run }) {
  return `${JSON.stringify(copy === null ? { run } : { copy, run }, null, 2)}\n`;
}

// The commands typed into a new session: each one through eval of a single
// quoted word, so a "#" or "&" inside one command cannot swallow or detach the
// rest, joined with && so the agent starts only after the setup succeeded and
// a failure stays visible in the terminal.
export function setupCommandLine(run, agentCommand) {
  const quote = (value) => `'${value.replace(/'/g, `'\\''`)}'`;
  return [...run.map((command) => `eval ${quote(command)}`), ...(agentCommand ? [agentCommand] : [])].join(" && ");
}

// ---------------------------------------------------------------- approvals

const approvalKey = (host, main, run) => crypto.createHash("sha256").update(JSON.stringify([host, main, run])).digest("hex");

async function readApprovals(file) {
  try {
    const value = JSON.parse(await fs.readFile(file, "utf8"));
    return Array.isArray(value?.approved) ? value.approved.filter((item) => typeof item === "string" && /^[0-9a-f]{64}$/.test(item)) : [];
  } catch {
    return [];
  }
}

let approvalWrites = Promise.resolve();

export async function setupApproved(host, main, run, { approvalsFile = DEFAULT_APPROVALS_FILE } = {}) {
  if (!run.length) return true;
  return (await readApprovals(approvalsFile)).includes(approvalKey(host, main, run));
}

// Writes are serialized and atomic (temporary file, then rename); the newest
// approvals are kept when the list is full.
export function approveSetup(host, main, run, { approvalsFile = DEFAULT_APPROVALS_FILE } = {}) {
  const write = approvalWrites.then(async () => {
    if (!run.length) return;
    const key = approvalKey(host, main, run);
    const approved = (await readApprovals(approvalsFile)).filter((item) => item !== key);
    approved.push(key);
    const kept = approved.slice(-WORKTREE_SETUP_LIMITS.approvals);
    await fs.mkdir(nodePath.dirname(approvalsFile), { recursive: true });
    const temporary = `${approvalsFile}.${crypto.randomUUID()}`;
    await fs.writeFile(temporary, JSON.stringify({ approved: kept }), { mode: 0o600, flag: "wx" });
    await fs.rename(temporary, approvalsFile);
  });
  approvalWrites = write.catch(() => {});
  return write;
}

// ------------------------------------------------------------------ scripts

const PRELUDE = String.raw`export LC_ALL=C GIT_TERMINAL_PROMPT=0
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 3
[ -n "$top" ] || exit 3
`;

// Expects $top. Prints the main checkout (the first worktree Git lists) and
// the setup file read from it; a symbolic link is reported, never followed.
// The file comes last so its text needs no framing.
export const MAIN_CONFIG_SH = String.raw`main=$(git -C "$top" worktree list --porcelain 2>/dev/null </dev/null | sed -n '1s/^worktree //p')
{ [ -n "$main" ] && [ -d "$main" ]; } || main=$top
printf '\036main\n%s\n' "$main"
cfg="$main/${WORKTREE_CONFIG_FILE}"
if [ -L "$main/.pzzacode" ] || [ -L "$cfg" ]; then printf '\036config-link\n'
elif [ -f "$cfg" ]; then printf '\036config\n'; head -c ${WORKTREE_SETUP_LIMITS.configBytes + 1} -- "$cfg"
fi
`;

export const READ_SETUP_SCRIPT = `${PRELUDE}${MAIN_CONFIG_SH}exit 0`;

// $1 folder, $2 the file's new text. Writes through a fresh temporary file
// (noclobber) renamed over the target, refusing symbolic links on the way.
export const WRITE_SETUP_SCRIPT = String.raw`${PRELUDE}main=$(git -C "$top" worktree list --porcelain 2>/dev/null </dev/null | sed -n '1s/^worktree //p')
{ [ -n "$main" ] && [ -d "$main" ]; } || main=$top
dir="$main/.pzzacode"
[ -L "$dir" ] && exit 9
[ -d "$dir" ] || mkdir -- "$dir" 2>/dev/null || exit 10
[ -L "$dir/worktree.json" ] && exit 9
tmp="$dir/.worktree.json.$$"
( set -C; printf '%s' "$2" > "$tmp" ) 2>/dev/null || exit 10
mv -f -- "$tmp" "$dir/worktree.json" 2>/dev/null || { rm -f -- "$tmp"; exit 10; }
printf '\036main\n%s\n' "$main"
exit 0`;

// $1 main checkout, $2 new worktree, $3 "ignored" (only Git-ignored files) or
// "untracked", then the glob patterns. Git lists the matching untracked files
// of the main checkout; each one is copied only when it is a regular file (no
// symbolic link) whose real folder is inside the main checkout, under the
// size caps, and its destination does not exist yet. Destination folders are
// created one level at a time and never through a symbolic link, so nothing
// is written outside the worktree.
export const COPY_SETUP_SCRIPT = String.raw`export LC_ALL=C GIT_TERMINAL_PROMPT=0
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
src=$(cd -P -- "$1" 2>/dev/null && pwd -P) || exit 3
dst=$(cd -P -- "$2" 2>/dev/null && pwd -P) || exit 3
mode=$3
shift 3
n=$#
while [ "$n" -gt 0 ]; do set -- "$@" ":(glob)$1"; shift; n=$((n - 1)); done
[ "$#" -gt 0 ] || exit 0
if [ "$mode" = ignored ]; then
  list=$(git -c core.quotePath=false -C "$src" ls-files --others --ignored --exclude-standard -- "$@" 2>/dev/null </dev/null | head -n ${WORKTREE_SETUP_LIMITS.files + 1})
else
  list=$(git -c core.quotePath=false -C "$src" ls-files --others -- "$@" 2>/dev/null </dev/null | head -n ${WORKTREE_SETUP_LIMITS.files + 1})
fi
[ -n "$list" ] || exit 0
skip() { printf '\036skipped\n%s\n%s\n' "$1" "$2"; }
printf '%s\n' "$list" | {
  count=0 total=0
  while IFS= read -r f; do
    [ -n "$f" ] || continue
    count=$((count + 1))
    if [ "$count" -gt ${WORKTREE_SETUP_LIMITS.files} ]; then printf '\036more\n'; break; fi
    case "$f" in \"*) skip "$f" name; continue ;; esac
    dir=$(dirname -- "$f"); base=$(basename -- "$f")
    sdir=$(cd -P -- "$src/$dir" 2>/dev/null && pwd -P) || { skip "$f" missing; continue; }
    case "$sdir/" in "$src"/*) ;; *) skip "$f" outside; continue ;; esac
    s="$sdir/$base"
    if [ -L "$s" ] || [ ! -f "$s" ]; then skip "$f" not-file; continue; fi
    size=$(wc -c < "$s" 2>/dev/null | tr -d ' ')
    [ -n "$size" ] || { skip "$f" missing; continue; }
    if [ "$size" -gt ${WORKTREE_SETUP_LIMITS.fileBytes} ]; then skip "$f" too-large; continue; fi
    if [ $((total + size)) -gt ${WORKTREE_SETUP_LIMITS.totalBytes} ]; then skip "$f" total-limit; continue; fi
    target=$dst ok=1
    if [ "$dir" != . ]; then
      saved=$IFS; IFS=/; set -f
      for part in $dir; do
        if [ -L "$target/$part" ]; then ok=0; break; fi
        if [ ! -d "$target/$part" ]; then mkdir -- "$target/$part" 2>/dev/null || { ok=0; break; }; fi
        target="$target/$part"
      done
      set +f; IFS=$saved
    fi
    [ "$ok" = 1 ] || { skip "$f" outside; continue; }
    if [ -e "$target/$base" ] || [ -L "$target/$base" ]; then skip "$f" exists; continue; fi
    if cp -p -- "$s" "$target/$base" 2>/dev/null; then total=$((total + size)); printf '\036copied\n%s\n' "$f"
    else skip "$f" failed; fi
  done
}
exit 0`;

// Splits "\x1ename\nbody" records; the body's trailing newline is dropped.
export function scriptSections(text) {
  return text.split(RS).slice(1).map((record) => {
    const newline = record.indexOf("\n");
    const name = newline < 0 ? record : record.slice(0, newline);
    const body = newline < 0 ? "" : record.slice(newline + 1);
    return [name, body.endsWith("\n") ? body.slice(0, -1) : body];
  });
}

// The main checkout and its setup as printed by MAIN_CONFIG_SH:
// { main, exists, config, error }. An unreadable file yields an error and no
// config, so nothing is copied or run from it.
export function readSetupSections(sections) {
  const found = new Map(sections);
  const main = found.get("main") ?? "";
  if (!main.startsWith("/") || main.length > WORKTREE_SETUP_LIMITS.pathLength || CONTROL.test(main)) return null;
  if (found.has("config-link")) return { main, exists: true, config: null, error: `${WORKTREE_CONFIG_FILE} is a symbolic link, so it is ignored.` };
  if (!found.has("config")) return { main, exists: false, config: { copy: null, run: [] }, error: null };
  try { return { main, exists: true, config: parseWorktreeConfig(found.get("config")), error: null }; }
  catch (error) { return { main, exists: true, config: null, error: error.message }; }
}

const SKIP_REASONS = new Set(["name", "missing", "outside", "not-file", "too-large", "total-limit", "exists", "failed"]);

export function parseCopyOutput(text) {
  const copied = [], skipped = [];
  let more = false;
  for (const [name, body] of scriptSections(text)) {
    if (name === "copied" && body && !CONTROL.test(body)) copied.push(body);
    else if (name === "skipped") {
      const cut = body.lastIndexOf("\n");
      const file = body.slice(0, cut), reason = body.slice(cut + 1);
      if (cut > 0 && SKIP_REASONS.has(reason)) skipped.push({ path: file.replace(CONTROL, "?"), reason });
    } else if (name === "more") more = true;
  }
  return { copied, skipped, more };
}

// ------------------------------------------------------------------ runners

const isLocal = (host) => !host && !IS_CLIENT;
// The device a request addresses, as approvals are keyed: "" for this machine.
export const setupHost = (host) => (isLocal(host) ? "" : host || DEVBOX);

// Runs a fixed script with positional arguments: /bin/sh here, one ssh call
// on another device. Resolves with the exit code and stdout; an unreachable
// device, a timeout or an oversized output rejects with a 503.
export function runDeviceScript(host, script, args, { execImpl = execFile, env, timeout = WORKTREE_SETUP_LIMITS.scriptMs, maxBuffer = WORKTREE_SETUP_LIMITS.buffer } = {}) {
  const local = isLocal(host);
  const [cmd, cmdArgs] = local ? ["/bin/sh", ["-c", script, "pzza-git", ...args]] : remoteGitReviewCommand(host, script, args);
  return new Promise((resolve, reject) => {
    execImpl(cmd, cmdArgs, { env: env ?? deviceEnv(local ? "" : host || DEVBOX), timeout, maxBuffer, encoding: "buffer" }, (error, stdout) => {
      const code = error ? error.code : 0;
      if (error && (typeof code !== "number" || (!local && code === 255) || error.killed)) {
        reject(new GitReviewError(local ? "Git did not finish in time." : "Could not reach the device to run Git.", 503));
        return;
      }
      resolve({ code, text: Buffer.from(stdout ?? "").toString("utf8") });
    });
  });
}

const notRepo = () => new GitReviewError("This folder is not inside a Git repository.");

// ---------------------------------------------------------------- endpoints

export function validateSetupFolder(body, extra = []) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a JSON object with host and path.");
  const allowed = new Set(["host", "path", ...extra]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("Unknown request field.");
  const host = body.host ?? "";
  if (typeof host !== "string" || (host && !SSH_TOKEN.test(host))) throw new Error("Invalid device host.");
  const { path } = body;
  if (typeof path !== "string" || !path.startsWith("/") || path.length > WORKTREE_SETUP_LIMITS.pathLength || CONTROL.test(path)) {
    throw new Error("The folder path must be absolute, at most 4096 characters, without control characters.");
  }
  return { host, path };
}

export const validateSetupReadRequest = (body) => validateSetupFolder(body);

export function validateSetupSaveRequest(body) {
  const request = validateSetupFolder(body, ["copy", "run"]);
  return { ...request, ...normalizeWorktreeConfig({ copy: body.copy ?? undefined, run: body.run ?? [] }) };
}

export function validateSetupApproveRequest(body) {
  const request = validateSetupFolder(body, ["run"]);
  const { run } = normalizeWorktreeConfig({ run: body.run });
  if (!run.length) throw new Error("There are no setup commands to approve.");
  return { ...request, run };
}

async function readSetup({ host, path }, options) {
  const { code, text } = await runDeviceScript(host, READ_SETUP_SCRIPT, [path], options);
  if (code === 3) throw notRepo();
  const setup = code === 0 ? readSetupSections(scriptSections(text)) : null;
  if (!setup) throw new GitReviewError("Invalid Git response from the device.", 502);
  return setup;
}

async function describeSetup(host, setup, options) {
  const config = setup.config ?? { copy: null, run: [] };
  return {
    main: setup.main,
    file: WORKTREE_CONFIG_FILE,
    exists: setup.exists,
    error: setup.error,
    copy: config.copy ?? DEFAULT_COPY_PATTERNS,
    defaultCopy: config.copy === null,
    run: config.run,
    approved: setup.config !== null && await setupApproved(setupHost(host), setup.main, config.run, options),
  };
}

export async function worktreeSetup(request, options = {}) {
  return describeSetup(request.host, await readSetup(request, options), options);
}

export async function saveWorktreeSetup({ host, path, copy, run }, options = {}) {
  const { code, text } = await runDeviceScript(host, WRITE_SETUP_SCRIPT, [path, serializeWorktreeConfig({ copy, run })], options);
  if (code === 3) throw notRepo();
  if (code === 9) throw new GitReviewError(`${WORKTREE_CONFIG_FILE} or its folder is a symbolic link; replace it with a regular file first.`, 409);
  if (code !== 0) throw new GitReviewError(`Could not write ${WORKTREE_CONFIG_FILE} in the main checkout.`, 500);
  const main = new Map(scriptSections(text)).get("main") ?? "";
  if (!main.startsWith("/")) throw new GitReviewError("Invalid Git response from the device.", 502);
  // Whoever saves the commands has just reviewed them.
  await approveSetup(setupHost(host), main, run, options);
  return worktreeSetup({ host, path }, options);
}

// Approves only the list the caller was shown: it must still be what the file
// holds right now.
export async function approveWorktreeSetup({ host, path, run }, options = {}) {
  const setup = await readSetup({ host, path }, options);
  if (!setup.config || JSON.stringify(setup.config.run) !== JSON.stringify(run)) {
    throw new GitReviewError("The setup commands changed since they were shown. Review them again.", 409);
  }
  await approveSetup(setupHost(host), setup.main, run, options);
  return describeSetup(host, setup, options);
}

const ROUTES = {
  "/git/worktree-setup": [validateSetupReadRequest, worktreeSetup],
  "/git/worktree-setup/save": [validateSetupSaveRequest, saveWorktreeSetup],
  "/git/worktree-setup/approve": [validateSetupApproveRequest, approveWorktreeSetup],
};

export async function worktreeSetupRouter(req, res, url, json) {
  if (!Object.hasOwn(ROUTES, url.pathname)) return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST for worktree setup requests" }); return true; }
  const [validate, handle] = ROUTES[url.pathname];
  const { readBody } = await import("./http.js");
  let request;
  try { request = validate(await readBody(req)); }
  catch (error) { json(res, 400, { error: error.message }); return true; }
  try { json(res, 200, await handle(request)); }
  catch (error) {
    if (error instanceof GitReviewError) json(res, error.status, { error: error.message });
    else json(res, 500, { error: "The worktree setup is unavailable for this folder." });
  }
  return true;
}
