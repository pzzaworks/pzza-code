// Git review data for the folder a tile works in: the changed files, one
// file's before/after contents, the branch's web page and pull request, and
// the repository's worktrees with a guarded remove, and failed CI logs saved
// for the agent. Local folders run git (and gh) directly with no shell;
// another device gets one ssh call per read running a fixed script whose
// inputs are positional, single-quoted arguments.
import { execFile, spawn } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, mkdir, open, readlink, realpath, rename } from "node:fs/promises";
import nodePath from "node:path";
import { StringDecoder } from "node:string_decoder";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { SSH_TOKEN, deviceEnv, shQuote } from "./shell.js";

export const GIT_REVIEW_LIMITS = {
  pathLength: 4096,
  files: 500,
  statusBytes: 1024 * 1024,
  side: 512 * 1024,
  binaryProbe: 8 * 1024,
  worktrees: 200,
  listBytes: 1024 * 1024,
  ghBytes: 1024 * 1024,
  localMs: 8000,
  ghMs: 8000,
  removeMs: 30000,
  remoteMs: 25000,
  remoteBuffer: 4 * 1024 * 1024,
  cacheMs: 60000,
  cacheEntries: 200,
};

const CONTROL = /[\u0000-\u001f\u007f]/;
const RS = "\u001e";
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const GH_FIELDS = "number,url,state,isDraft,statusCheckRollup";
const EXTRA_BIN = ["/opt/homebrew/bin", "/usr/local/bin"];

export class GitReviewError extends Error {
  constructor(message, status = 400) { super(message); this.status = status; }
}
const notRepo = () => new GitReviewError("This folder is not inside a Git repository.");
const outsideRepo = () => new GitReviewError("That file is outside the repository.");
const unreachable = () => new GitReviewError("Could not reach the device to read Git data.", 503);

// ---------------------------------------------------------------- validation

function validateFolder(body, extra) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a JSON object with host and path.");
  const allowed = new Set(["host", "path", ...extra]);
  if (Object.keys(body).some((key) => !allowed.has(key))) throw new Error("Unknown request field.");
  const host = body.host ?? "";
  if (typeof host !== "string" || (host && !SSH_TOKEN.test(host))) throw new Error("Invalid device host.");
  const { path } = body;
  if (typeof path !== "string" || !path.startsWith("/") || path.length > GIT_REVIEW_LIMITS.pathLength || CONTROL.test(path)) {
    throw new Error("The folder path must be absolute, at most 4096 characters, without control characters.");
  }
  return { host, path };
}

// A repository-relative file: no leading "/", no empty, "." or ".." segments,
// nothing inside a .git folder, no control characters.
export function validateRepoFile(file) {
  if (typeof file !== "string" || !file || file.length > GIT_REVIEW_LIMITS.pathLength || CONTROL.test(file) || file.startsWith("/")) return false;
  return file.split("/").every((part) => part && part !== "." && part !== ".." && part.toLowerCase() !== ".git");
}

export const validateGitChangesRequest = (body) => validateFolder(body, []);
export const validateGitRemoteRequest = (body) => validateFolder(body, []);
export const validateGitWorktreesRequest = (body) => validateFolder(body, []);

export function validateGitDiffRequest(body) {
  const request = validateFolder(body, ["file", "from"]);
  if (!validateRepoFile(body.file)) throw new Error("The file must be a path inside the repository.");
  if (body.from !== undefined && !validateRepoFile(body.from)) throw new Error("The rename source must be a path inside the repository.");
  return { ...request, file: body.file, from: body.from ?? body.file };
}

export function validateGitRemoveWorktreeRequest(body) {
  const request = validateFolder(body, ["worktree", "deleteBranch"]);
  const { worktree, deleteBranch } = body;
  if (typeof worktree !== "string" || !worktree.startsWith("/") || worktree.length > GIT_REVIEW_LIMITS.pathLength || CONTROL.test(worktree)) {
    throw new Error("The worktree must be an absolute path without control characters.");
  }
  if (typeof deleteBranch !== "boolean") throw new Error("Choose whether to delete the worktree branch.");
  return { ...request, worktree, deleteBranch };
}

// ------------------------------------------------------------------ runners

function localEnv(extra = {}) {
  const env = { ...deviceEnv(""), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C", ...extra };
  const parts = (env.PATH || "/usr/bin:/bin").split(":");
  env.PATH = [...parts, ...EXTRA_BIN.filter((dir) => !parts.includes(dir))].join(":");
  return env;
}

// Runs a program without a shell. Keeps at most maxBytes of stdout (killing the
// process once more arrives, so `truncated` means "there was more"), and
// resolves rather than rejects: callers decide what a failure means.
export function runLocal(cmd, args, { cwd, env = localEnv(), timeoutMs = GIT_REVIEW_LIMITS.localMs, maxBytes = 64 * 1024 } = {}) {
  return new Promise((resolve) => {
    const chunks = [];
    let size = 0, stderr = "", truncated = false, settled = false, child;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ stdout: Buffer.concat(chunks), stderr, truncated, missing: false, timedOut: false, code: null, ...result });
    };
    const timer = setTimeout(() => { child?.kill("SIGKILL"); finish({ timedOut: true }); }, timeoutMs);
    try { child = spawn(cmd, args, { cwd, env, stdio: ["ignore", "pipe", "pipe"] }); }
    catch (error) { finish({ missing: error?.code === "ENOENT" }); return; }
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const room = maxBytes - size;
      if (chunk.length > room) {
        chunks.push(chunk.subarray(0, room));
        size = maxBytes;
        truncated = true;
        child.kill("SIGTERM");
        finish({ code: 0 });
        return;
      }
      chunks.push(chunk);
      size += chunk.length;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => { if (stderr.length < 4096) stderr += chunk.slice(0, 4096 - stderr.length); });
    child.on("error", (error) => finish({ missing: error?.code === "ENOENT" }));
    child.on("close", (code) => finish({ code }));
  });
}

const ok = (result) => result.code === 0 && !result.timedOut && !result.missing;
const firstLine = (buffer) => buffer.toString("utf8").split("\n")[0];

export function remoteGitReviewCommand(host, script, args) {
  const target = host || DEVBOX;
  return ["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", target,
    ["sh", "-c", script, "pzza-git", ...args].map(shQuote).join(" ")]];
}

// One ssh call. Known script exit codes come back to the caller; an ssh
// failure, timeout or overflow is a 503.
function runRemote(host, script, args, { execImpl = execFile, timeout = GIT_REVIEW_LIMITS.remoteMs } = {}) {
  const [cmd, sshArgs] = remoteGitReviewCommand(host, script, args);
  return new Promise((resolve, reject) => {
    execImpl(cmd, sshArgs, { env: deviceEnv(host || DEVBOX), timeout, maxBuffer: GIT_REVIEW_LIMITS.remoteBuffer, encoding: "buffer" }, (error, stdout, stderr) => {
      const code = error ? error.code : 0;
      if (error && (typeof code !== "number" || code === 255 || error.killed)) { reject(unreachable()); return; }
      if (code === 3) { reject(notRepo()); return; }
      if (code === 6) { reject(outsideRepo()); return; }
      resolve({ code, stdout: Buffer.from(stdout ?? ""), stderr: Buffer.from(stderr ?? "") });
    });
  });
}

const isLocal = (host) => !host && !IS_CLIENT;

// Splits "\x1ename\nbody" records; a trailing newline printed after a body is
// dropped.
function sections(text) {
  return text.split(RS).slice(1).map((record) => {
    const newline = record.indexOf("\n");
    const name = newline < 0 ? record : record.slice(0, newline);
    const body = newline < 0 ? "" : record.slice(newline + 1);
    return [name, body.endsWith("\n") ? body.slice(0, -1) : body];
  });
}

const PRELUDE = String.raw`export LC_ALL=C GIT_TERMINAL_PROMPT=0
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 3
[ -n "$top" ] || exit 3
`;

async function localToplevel(dir) {
  const result = await runLocal("git", ["-C", dir, "rev-parse", "--show-toplevel"], { maxBytes: 8192 });
  const top = result.stdout.toString("utf8").replace(/\n$/, "");
  if (!ok(result) || !top.startsWith("/") || CONTROL.test(top)) throw notRepo();
  return top;
}

// ------------------------------------------------------------------ changes

// `git status --porcelain=v1 -z`: "XY path\0", and for renames and copies
// "XY new\0old\0". When the output was cut short the last token is partial.
export function parseStatusZ(text, cut = false) {
  const tokens = text.split("\0");
  if (cut || tokens[tokens.length - 1] === "") tokens.pop();
  const files = [];
  let truncated = cut;
  for (let index = 0; index < tokens.length; index += 1) {
    const entry = tokens[index];
    if (entry.length < 4 || entry[2] !== " ") continue;
    const [x, y] = entry;
    const file = entry.slice(3);
    let from;
    if ("RC".includes(x) || "RC".includes(y)) {
      from = tokens[index + 1];
      index += 1;
      if (from === undefined) { truncated = true; break; }
    }
    if (x === "!") continue;
    if (files.length === GIT_REVIEW_LIMITS.files) { truncated = true; break; }
    const status = changeStatus(x, y);
    files.push(status === "renamed" ? { path: file, status, from } : { path: file, status });
  }
  return { files, truncated };
}

function changeStatus(x, y) {
  if (x === "?") return "untracked";
  if (x === "U" || y === "U" || (x === "A" && y === "A") || (x === "D" && y === "D")) return "conflicted";
  if (x === "R" || y === "R") return "renamed";
  if (x === "A" || x === "C") return "added";
  if (x === "D" || y === "D") return "deleted";
  return "modified";
}

const STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain=v1", "-z", "--untracked-files=normal"];

export const REMOTE_CHANGES_SCRIPT = `${PRELUDE}printf '\\036root\\n%s\\n\\036status\\n' "$top"
git -C "$top" ${STATUS_ARGS.join(" ")} 2>/dev/null | head -c ${GIT_REVIEW_LIMITS.statusBytes + 1}
exit 0`;

export async function gitChanges({ host, path }, { execImpl } = {}) {
  if (isLocal(host)) {
    const root = await localToplevel(path);
    const result = await runLocal("git", ["-C", root, ...STATUS_ARGS], { maxBytes: GIT_REVIEW_LIMITS.statusBytes });
    if (!ok(result)) throw new GitReviewError("git status failed in this folder.", 500);
    return { ...parseStatusZ(result.stdout.toString("utf8"), result.truncated), root };
  }
  const { stdout } = await runRemote(host, REMOTE_CHANGES_SCRIPT, [path], { execImpl });
  const marker = stdout.indexOf(`${RS}status\n`);
  const head = sections(stdout.subarray(0, marker < 0 ? stdout.length : marker).toString("utf8"));
  const root = head.find(([name]) => name === "root")?.[1] ?? "";
  if (marker < 0 || !root.startsWith("/") || CONTROL.test(root)) throw new GitReviewError("Invalid Git response from the device.", 502);
  let status = stdout.subarray(marker + 8);
  const cut = status.length > GIT_REVIEW_LIMITS.statusBytes;
  if (cut) status = status.subarray(0, GIT_REVIEW_LIMITS.statusBytes);
  return { ...parseStatusZ(status.toString("utf8"), cut), root };
}

// --------------------------------------------------------------------- diff

const inside = (root, target) => target === root || target.startsWith(root.endsWith("/") ? root : `${root}/`);

export function buildDiff(before, after, truncated) {
  const probe = (buffer) => buffer !== null && buffer.subarray(0, GIT_REVIEW_LIMITS.binaryProbe).includes(0);
  const binary = probe(before) || probe(after);
  // Binary sides that exist come back empty: the UI only needs to know they do.
  const text = (buffer) => (buffer === null ? null : binary ? "" : buffer.toString("utf8"));
  return { before: text(before), after: text(after), binary, truncated };
}

const capSide = (buffer) => (buffer.length > GIT_REVIEW_LIMITS.side
  ? { buffer: buffer.subarray(0, GIT_REVIEW_LIMITS.side), cut: true }
  : { buffer, cut: false });

async function localHeadBlob(root, file) {
  const spec = `HEAD:${file}`;
  const type = await runLocal("git", ["-C", root, "cat-file", "-t", spec], { maxBytes: 64 });
  if (!ok(type) || type.stdout.toString("utf8").trim() !== "blob") return { buffer: null, cut: false };
  const blob = await runLocal("git", ["-C", root, "cat-file", "blob", spec], { maxBytes: GIT_REVIEW_LIMITS.side });
  if (!ok(blob)) return { buffer: null, cut: false };
  return { buffer: blob.stdout, cut: blob.truncated };
}

// Reads root/file without leaving the repository: every directory on the way
// is resolved with realpath and must stay under the real root, and the last
// component is never followed. A symlink comes back as its target text, the
// same thing Git stores for it.
export async function readWorkingFile(root, file) {
  const realRoot = await realpath(root);
  const target = nodePath.resolve(realRoot, file);
  if (!inside(realRoot, target)) throw outsideRepo();
  let parent;
  try { parent = await realpath(nodePath.dirname(target)); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return { buffer: null, cut: false }; throw error; }
  if (!inside(realRoot, parent)) throw outsideRepo();
  const final = nodePath.join(parent, nodePath.basename(target));
  let info;
  try { info = await lstat(final); }
  catch (error) { if (error.code === "ENOENT" || error.code === "ENOTDIR") return { buffer: null, cut: false }; throw error; }
  if (info.isSymbolicLink()) return capSide(Buffer.from(await readlink(final, { encoding: "buffer" })));
  if (!info.isFile()) return { buffer: null, cut: false };
  // O_NOFOLLOW closes the race where the file is swapped for a link after lstat;
  // O_NONBLOCK keeps a swapped-in FIFO from hanging the open.
  const handle = await open(final, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) return { buffer: null, cut: false };
    const buffer = Buffer.alloc(GIT_REVIEW_LIMITS.side + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (!bytesRead) break;
      length += bytesRead;
    }
    return capSide(buffer.subarray(0, length));
  } finally {
    await handle.close();
  }
}

// $1 folder, $2 working-tree file, $3 path at HEAD (the rename source or $2).
// Sides are base64 so binary content survives the text framing.
export const REMOTE_DIFF_SCRIPT = `${PRELUDE}cd -P -- "$top" 2>/dev/null || exit 3
real=$(pwd -P)
if [ "$(git cat-file -t "HEAD:$3" 2>/dev/null)" = blob ]; then
  printf '\\036before\\n'; git cat-file blob "HEAD:$3" 2>/dev/null | head -c ${GIT_REVIEW_LIMITS.side + 1} | base64; printf '\\n'
fi
dir=$(dirname -- "$2"); name=$(basename -- "$2")
if rdir=$(cd -P -- "$dir" 2>/dev/null && pwd -P); then
  case "$rdir/" in "$real"/*) ;; *) exit 6 ;; esac
  if [ -L "$rdir/$name" ]; then
    printf '\\036link\\n'; readlink -- "$rdir/$name" | head -c ${GIT_REVIEW_LIMITS.side + 2} | base64; printf '\\n'
  elif [ -f "$rdir/$name" ]; then
    printf '\\036after\\n'; head -c ${GIT_REVIEW_LIMITS.side + 1} -- "$rdir/$name" | base64; printf '\\n'
  fi
fi
exit 0`;

export async function gitDiff({ host, path, file, from = file }, { execImpl } = {}) {
  let before, after;
  if (isLocal(host)) {
    const root = await localToplevel(path);
    [before, after] = await Promise.all([localHeadBlob(root, from), readWorkingFile(root, file)]);
  } else {
    const { stdout } = await runRemote(host, REMOTE_DIFF_SCRIPT, [path, file, from], { execImpl });
    const found = new Map(sections(stdout.toString("utf8")).map(([name, body]) => [name, Buffer.from(body.replace(/\s+/g, ""), "base64")]));
    before = found.has("before") ? capSide(found.get("before")) : { buffer: null, cut: false };
    if (found.has("link")) {
      const link = found.get("link");
      after = capSide(link[link.length - 1] === 0x0a ? link.subarray(0, -1) : link);
    } else after = found.has("after") ? capSide(found.get("after")) : { buffer: null, cut: false };
  }
  return buildDiff(before.buffer, after.buffer, before.cut || after.cut);
}

// ------------------------------------------------------------------- remote

const WEB_HOSTS = {
  "github.com": (base, branch) => `${base}/tree/${branch}`,
  "gitlab.com": (base, branch) => `${base}/-/tree/${branch}`,
  "bitbucket.org": (base, branch) => `${base}/branch/${branch}`,
};

// The https base of a GitHub, GitLab or Bitbucket remote, from
// https://[user[:token]@]host/owner/repo(.git), ssh://git@host[:port]/owner/repo
// or git@host:owner/repo(.git). Credentials never reach the result.
export function parseRemoteUrl(remote) {
  if (typeof remote !== "string" || remote.length > 2048 || CONTROL.test(remote.trim())) return null;
  const value = remote.trim();
  let host, repoPath;
  const scp = /^[A-Za-z0-9._-]+@([A-Za-z0-9.-]+):(?!\/)(.+)$/.exec(value);
  if (scp) [, host, repoPath] = scp;
  else {
    let url;
    try { url = new URL(value); } catch { return null; }
    if (!["https:", "http:", "ssh:", "git+ssh:"].includes(url.protocol)) return null;
    host = url.hostname;
    repoPath = decodeURIComponent(url.pathname);
  }
  host = host.toLowerCase();
  if (!Object.hasOwn(WEB_HOSTS, host)) return null;
  const parts = repoPath.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "").split("/");
  // GitHub and Bitbucket are owner/repo; GitLab allows nested groups.
  if (parts.length < 2 || (host !== "gitlab.com" && parts.length !== 2) || !parts.every((part) => /^[A-Za-z0-9._-]+$/.test(part) && part !== "." && part !== "..")) return null;
  return { host, base: `https://${host}/${parts.join("/")}` };
}

export function branchWebUrl(remote, branch) {
  if (!branch) return null;
  const parsed = parseRemoteUrl(remote);
  if (!parsed) return null;
  return WEB_HOSTS[parsed.host](parsed.base, branch.split("/").map(encodeURIComponent).join("/"));
}

const FAILING = new Set(["FAILURE", "ERROR", "CANCELLED", "TIMED_OUT", "ACTION_REQUIRED", "STARTUP_FAILURE"]);

// statusCheckRollup mixes CheckRun ({ status, conclusion }) and StatusContext
// ({ state }) entries. Any failure wins, then anything still running.
export function summarizeChecks(rollup) {
  if (!Array.isArray(rollup) || !rollup.length) return "none";
  let pending = false;
  for (const check of rollup) {
    if (!check || typeof check !== "object") continue;
    const result = String(check.conclusion || check.state || "").toUpperCase();
    if (FAILING.has(result)) return "failing";
    const status = String(check.status || "").toUpperCase();
    if ((check.status !== undefined && status !== "COMPLETED") || result === "PENDING" || result === "EXPECTED" || !result) pending = true;
  }
  return pending ? "pending" : "passing";
}

export function parsePullRequest(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!value || typeof value !== "object") return null;
  const { number, url, state, isDraft, statusCheckRollup } = value;
  if (!Number.isSafeInteger(number) || number <= 0 || typeof url !== "string" || !/^https:\/\/[^\s]+$/.test(url) || url.length > 2048) return null;
  if (!["OPEN", "MERGED", "CLOSED"].includes(state)) return null;
  return { number, url, state, draft: isDraft === true, checks: summarizeChecks(statusCheckRollup) };
}

// gh exits 4 when it needs `gh auth login`; any other failure (no PR for the
// branch, no GitHub remote, offline) just means there is no PR to show.
function remoteInfo(origin, branch, gh) {
  const branchName = branch && !CONTROL.test(branch) ? branch : null;
  const ghAvailable = gh !== null && gh.code !== 4;
  const pr = gh !== null && gh.code === 0 ? parsePullRequest(gh.output) : null;
  return { web: branchWebUrl(origin, branchName), pr, ghAvailable };
}

export const REMOTE_INFO_SCRIPT = `${PRELUDE}cd -- "$1" 2>/dev/null || exit 3
export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1
printf '\\036origin\\n%s\\n' "$(git remote get-url origin 2>/dev/null | head -c 2048)"
printf '\\036branch\\n%s\\n' "$(git symbolic-ref --short -q HEAD 2>/dev/null | head -c 1024)"
if command -v gh >/dev/null 2>&1; then
  if command -v timeout >/dev/null 2>&1; then out=$(timeout ${GIT_REVIEW_LIMITS.ghMs / 1000} gh pr view --json ${GH_FIELDS} 2>/dev/null </dev/null); code=$?
  else out=$(gh pr view --json ${GH_FIELDS} 2>/dev/null </dev/null); code=$?; fi
  printf '\\036ghcode\\n%s\\n\\036gh\\n' "$code"; printf '%s' "$out" | head -c ${GIT_REVIEW_LIMITS.ghBytes}; printf '\\n'
fi
exit 0`;

async function localRemoteInfo(path, ghCommand) {
  await localToplevel(path);
  const [origin, branch, gh] = await Promise.all([
    runLocal("git", ["-C", path, "remote", "get-url", "origin"], { maxBytes: 2048 }),
    runLocal("git", ["-C", path, "symbolic-ref", "--short", "-q", "HEAD"], { maxBytes: 1024 }),
    runLocal(ghCommand, ["pr", "view", "--json", GH_FIELDS], {
      cwd: path, timeoutMs: GIT_REVIEW_LIMITS.ghMs, maxBytes: GIT_REVIEW_LIMITS.ghBytes,
      env: localEnv({ GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" }),
    }),
  ]);
  const ghResult = gh.missing ? null : { code: gh.timedOut || gh.truncated ? -1 : gh.code, output: gh.stdout.toString("utf8") };
  return remoteInfo(ok(origin) ? firstLine(origin.stdout) : "", ok(branch) ? firstLine(branch.stdout) : "", ghResult);
}

const remoteCache = new Map();
export function clearGitRemoteCache() { remoteCache.clear(); }

// The UI polls this, and gh makes a network call, so results (and in-flight
// lookups) are kept per device and folder for a minute in a bounded map.
export function gitRemote({ host, path }, { execImpl, ghCommand = "gh", now = Date.now } = {}) {
  const key = `${host || DEVBOX}\u0000${path}`;
  const cached = remoteCache.get(key);
  if (cached && cached.expires > now()) return cached.promise;
  remoteCache.delete(key);
  for (const [entry, value] of remoteCache) if (value.expires <= now()) remoteCache.delete(entry);
  while (remoteCache.size >= GIT_REVIEW_LIMITS.cacheEntries) remoteCache.delete(remoteCache.keys().next().value);
  const promise = isLocal(host) ? localRemoteInfo(path, ghCommand) : runRemote(host, REMOTE_INFO_SCRIPT, [path], { execImpl }).then(({ stdout }) => {
    const found = new Map(sections(stdout.toString("utf8")));
    const gh = found.has("ghcode") ? { code: Number(found.get("ghcode")), output: found.get("gh") ?? "" } : null;
    return remoteInfo(found.get("origin") ?? "", found.get("branch") ?? "", gh);
  });
  const entry = { expires: now() + GIT_REVIEW_LIMITS.cacheMs, promise };
  remoteCache.set(key, entry);
  promise.catch(() => { if (remoteCache.get(key) === entry) remoteCache.delete(key); });
  return promise;
}

// ---------------------------------------------------------------- worktrees

export function parseWorktreeList(text) {
  const worktrees = [];
  let current = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9), head: "", branch: null, locked: false, bare: false };
      worktrees.push(current);
    } else if (!current) continue;
    else if (line.startsWith("HEAD ")) current.head = line.slice(5);
    else if (line.startsWith("branch ")) current.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (line === "bare") current.bare = true;
    else if (line === "locked" || line.startsWith("locked ")) current.locked = true;
  }
  return worktrees.slice(0, GIT_REVIEW_LIMITS.worktrees);
}

const shortRef = (ref) => ref.replace(/^refs\/(?:heads|remotes)\//, "");

async function localBase(top) {
  const symbolic = await runLocal("git", ["-C", top, "symbolic-ref", "-q", "refs/remotes/origin/HEAD"], { maxBytes: 1024 });
  const candidates = [ok(symbolic) ? firstLine(symbolic.stdout) : "", "refs/heads/main", "refs/heads/master"];
  for (const ref of candidates) {
    if (!ref.startsWith("refs/") || CONTROL.test(ref)) continue;
    if (ok(await runLocal("git", ["-C", top, "show-ref", "--verify", "-q", ref], { maxBytes: 1024 }))) return ref;
  }
  return null;
}

// "dirty" | "clean" | "unknown" (missing folder or git failed).
async function localWorktreeState(dir) {
  const result = await runLocal("git", ["-C", dir, "--no-optional-locks", "status", "--porcelain", "--untracked-files=normal"], { maxBytes: 1 });
  if (result.truncated || (ok(result) && result.stdout.length)) return "dirty";
  return ok(result) ? "clean" : "unknown";
}

// How a worktree HEAD is already contained in the base, or null when it is not
// proven. Each check only ever answers "yes" when the branch's work is in the
// base, so a null is the safe default (the branch is then kept):
//  - "ancestor": the commit is reachable from the base (a normal merge).
//  - "patch": `git cherry` matches every branch commit to a base commit by
//    patch-id (a rebase merge or cherry-picks).
//  - "squash": merging the branch into the base (`git merge-tree --write-tree`,
//    git 2.38+; older git fails and the check is skipped) cleanly yields the
//    base's own tree, so the branch adds nothing the base lacks. A branch whose
//    net diff is empty is not counted, since "already in base" is vacuous there.
// merge-tree may write the merged tree into the object store as loose objects;
// they are unreferenced and pruned by gc.
const MERGE_KINDS = ["ancestor", "patch", "squash"];

async function localMergedBy(top, base, head) {
  if (!base || !SHA.test(head)) return null;
  const git = (args, maxBytes = 1024) => runLocal("git", ["-C", top, ...args], { maxBytes });
  if (ok(await git(["merge-base", "--is-ancestor", head, base]))) return "ancestor";
  const cherry = await git(["cherry", base, head], GIT_REVIEW_LIMITS.listBytes);
  if (ok(cherry) && !cherry.truncated) {
    const lines = cherry.stdout.toString("utf8").split("\n").filter(Boolean);
    if (lines.length && lines.every((line) => line.startsWith("- "))) return "patch";
  }
  // Exit 1 means the branch changes something since the fork point.
  if ((await git(["diff", "--quiet", "--no-ext-diff", `${base}...${head}`])).code !== 1) return null;
  const merged = await git(["merge-tree", "--write-tree", base, head], 4096);
  const baseTree = await git(["rev-parse", "--verify", "-q", `${base}^{tree}`]);
  if (!ok(merged) || merged.truncated || !ok(baseTree)) return null;
  const tree = firstLine(baseTree.stdout);
  return SHA.test(tree) && merged.stdout.toString("utf8").trim() === tree ? "squash" : null;
}

// The same checks as localMergedBy for the device scripts: merged_by top base
// head prints the kind and succeeds, or fails silently.
const MERGED_BY_SH = String.raw`merged_by() {
  if git -C "$1" merge-base --is-ancestor "$3" "$2" 2>/dev/null </dev/null; then echo ancestor; return 0; fi
  if mb_cherry=$(git -C "$1" cherry "$2" "$3" 2>/dev/null </dev/null) && [ -n "$mb_cherry" ] \
    && ! printf '%s\n' "$mb_cherry" | grep -qv '^- '; then echo patch; return 0; fi
  git -C "$1" diff --quiet --no-ext-diff "$2...$3" >/dev/null 2>&1 </dev/null
  [ $? -eq 1 ] || return 1
  mb_tree=$(git -C "$1" merge-tree --write-tree "$2" "$3" 2>/dev/null </dev/null) || return 1
  mb_base=$(git -C "$1" rev-parse --verify -q "$2^{tree}" 2>/dev/null </dev/null) || return 1
  if [ -n "$mb_base" ] && [ "$mb_tree" = "$mb_base" ]; then echo squash; return 0; fi
  return 1
}
`;

async function localWorktreeData(path) {
  const top = await localToplevel(path);
  const list = await runLocal("git", ["-C", top, "worktree", "list", "--porcelain"], { maxBytes: GIT_REVIEW_LIMITS.listBytes });
  if (!ok(list)) throw new GitReviewError("git could not list the worktrees.", 500);
  const entries = parseWorktreeList(list.stdout.toString("utf8"));
  const base = await localBase(top);
  const realTop = await realpath(top).catch(() => top);
  const annotated = [];
  for (let index = 0; index < entries.length; index += 8) {
    annotated.push(...await Promise.all(entries.slice(index, index + 8).map(async (entry) => {
      const real = await realpath(entry.path).catch(() => "");
      const state = entry.bare || !real ? "unknown" : await localWorktreeState(entry.path);
      const mergedBy = await localMergedBy(top, base, entry.head);
      return { ...entry, real, state, mergedBy };
    })));
  }
  return { realTop, base, entries: annotated };
}

// $1 folder. Prints the real top-level, the base ref, the raw porcelain list,
// then one record per worktree (listed path, real path, state) and one per
// HEAD commit that is merged into the base (commit, then how).
export const REMOTE_WORKTREES_SCRIPT = `${PRELUDE}${MERGED_BY_SH}realtop=$(cd -P -- "$top" 2>/dev/null && pwd -P) || realtop=$top
base=$(git -C "$top" symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null) || base=""
found=""
for ref in "$base" refs/heads/main refs/heads/master; do
  if [ -n "$ref" ] && git -C "$top" show-ref --verify -q "$ref" 2>/dev/null; then base=$ref; found=1; break; fi
done
[ -n "$found" ] || base=""
list=$(git -C "$top" worktree list --porcelain 2>/dev/null | head -c ${GIT_REVIEW_LIMITS.listBytes})
printf '\\036root\\n%s\\n\\036base\\n%s\\n\\036list\\n%s\\n' "$realtop" "$base" "$list"
printf '%s\\n' "$list" | sed -n 's/^worktree //p' | head -n ${GIT_REVIEW_LIMITS.worktrees} | while IFS= read -r wt; do
  real=$(cd -P -- "$wt" 2>/dev/null && pwd -P) || real=""
  state=unknown
  if [ -n "$real" ] && [ "$(git -C "$wt" rev-parse --is-inside-work-tree 2>/dev/null </dev/null)" = true ]; then
    if [ -n "$(git -C "$wt" --no-optional-locks status --porcelain --untracked-files=normal 2>/dev/null </dev/null | head -c 1)" ]; then state=dirty; else state=clean; fi
  fi
  printf '\\036wt\\n%s\\n%s\\n%s\\n' "$wt" "$real" "$state"
done
if [ -n "$base" ]; then
  printf '%s\\n' "$list" | sed -n 's/^HEAD //p' | sort -u | head -n ${GIT_REVIEW_LIMITS.worktrees} | while IFS= read -r h; do
    if by=$(merged_by "$top" "$base" "$h"); then printf '\\036merged\\n%s\\n%s\\n' "$h" "$by"; fi
  done
fi
exit 0`;

async function remoteWorktreeData(host, path, execImpl) {
  const { stdout } = await runRemote(host, REMOTE_WORKTREES_SCRIPT, [path], { execImpl });
  let realTop = "", base = null, entries = [];
  const states = new Map(), merged = new Map();
  for (const [name, body] of sections(stdout.toString("utf8"))) {
    if (name === "root") realTop = body;
    else if (name === "base") base = body.startsWith("refs/") ? body : null;
    else if (name === "list") entries = parseWorktreeList(body);
    else if (name === "wt") {
      const [listed, real = "", state = "unknown"] = body.split("\n");
      states.set(listed, { real, state: ["dirty", "clean"].includes(state) ? state : "unknown" });
    } else if (name === "merged") {
      const [head, kind] = body.split("\n");
      if (MERGE_KINDS.includes(kind)) merged.set(head, kind);
    }
  }
  if (!realTop.startsWith("/")) throw new GitReviewError("Invalid Git response from the device.", 502);
  return {
    realTop, base,
    entries: entries.map((entry) => ({ ...entry, ...(entry.bare ? { real: "", state: "unknown" } : states.get(entry.path) ?? { real: "", state: "unknown" }), mergedBy: (base && merged.get(entry.head)) || null })),
  };
}

const worktreeData = ({ host, path }, execImpl) => (isLocal(host) ? localWorktreeData(path) : remoteWorktreeData(host, path, execImpl));

export async function gitWorktrees(request, { execImpl } = {}) {
  const { realTop, base, entries } = await worktreeData(request, execImpl);
  return {
    base: base ? shortRef(base) : null,
    worktrees: entries.map((entry, index) => ({
      path: entry.path,
      branch: entry.branch,
      head: entry.head,
      merged: entry.mergedBy !== null,
      mergedBy: entry.mergedBy,
      // An unreadable worktree counts as dirty so nothing offers to remove it.
      dirty: entry.state !== "clean",
      current: Boolean(entry.real) && entry.real === realTop,
      locked: entry.locked,
      main: index === 0,
    })),
  };
}

// $1 main worktree, $2 worktree to remove, $3 branch to delete ("" = keep),
// $4 the branch tip proven merged and $5 the base ("" = only git branch -d).
// No --force on the worktree: git itself refuses dirty or locked ones. A branch
// git branch -d refuses (squash and rebase merges) is force-deleted only when
// it still points at $4 and merged_by proves it again right here.
export const REMOTE_REMOVE_SCRIPT = String.raw`export LC_ALL=C GIT_TERMINAL_PROMPT=0
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
${MERGED_BY_SH}err=$(git -C "$1" worktree remove "$2" 2>&1 >/dev/null </dev/null) || { printf '%s' "$err" | head -c 1024; exit 7; }
printf 'removed\n'
if [ -n "$3" ]; then
  if git -C "$1" branch -d "$3" >/dev/null 2>&1 </dev/null; then printf 'branch-deleted\n'
  elif [ -n "$4" ] && [ -n "$5" ] && [ "$(git -C "$1" rev-parse --verify -q "refs/heads/$3" 2>/dev/null </dev/null)" = "$4" ] \
    && merged_by "$1" "$5" "$4" >/dev/null && git -C "$1" branch -D "$3" >/dev/null 2>&1 </dev/null; then printf 'branch-deleted\n'
  fi
fi
exit 0`;

// git branch -d only knows ancestry, so a squash- or rebase-merged branch is
// refused; it is then force-deleted only while its tip is still the commit the
// listing proved merged and the proof holds again at this moment.
async function localDeleteBranch(main, base, branch, provenHead) {
  if (ok(await runLocal("git", ["-C", main, "branch", "-d", branch], { maxBytes: 4096 }))) return true;
  if (!provenHead || !base) return false;
  const tip = await runLocal("git", ["-C", main, "rev-parse", "--verify", "-q", `refs/heads/${branch}`], { maxBytes: 1024 });
  if (!ok(tip) || firstLine(tip.stdout) !== provenHead) return false;
  if (!await localMergedBy(main, base, provenHead)) return false;
  return ok(await runLocal("git", ["-C", main, "branch", "-D", branch], { maxBytes: 4096 }));
}

const gitMessage = (text) => text.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/^(?:fatal|error): /, "").trim().slice(0, 300);

export async function gitRemoveWorktree({ host, path, worktree, deleteBranch }, { execImpl } = {}) {
  const { base, entries } = await worktreeData({ host, path }, execImpl);
  const index = entries.findIndex((entry) => entry.path === worktree || (entry.real && entry.real === worktree));
  if (index < 0) throw new GitReviewError("That folder is not one of this repository's worktrees.");
  if (index === 0) throw new GitReviewError("The main worktree cannot be removed.");
  const target = entries[index];
  if (target.locked) throw new GitReviewError("This worktree is locked. Unlock it with git worktree unlock first.");
  if (target.state === "unknown") throw new GitReviewError("Could not check this worktree for changes. If its folder is gone, run git worktree prune.");
  if (target.state === "dirty") throw new GitReviewError("This worktree has uncommitted or untracked changes. Commit or discard them first.");
  const main = entries[0].path;
  // Only the worktree's own branch, never the base branch.
  const baseBranch = base ? base.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/[^/]+\//, "") : null;
  const branch = deleteBranch && target.branch && target.branch !== baseBranch && !target.branch.startsWith("-")
    && !target.branch.startsWith("refs/") && !CONTROL.test(target.branch) ? target.branch : "";
  // The commit whose merge was just proven; without one only -d is tried.
  const provenHead = branch && target.mergedBy && SHA.test(target.head) ? target.head : "";
  if (isLocal(host)) {
    const removed = await runLocal("git", ["-C", main, "worktree", "remove", target.path], { timeoutMs: GIT_REVIEW_LIMITS.removeMs, maxBytes: 4096 });
    if (!ok(removed)) throw new GitReviewError(`git refused to remove the worktree: ${gitMessage(removed.stderr) || "unknown error"}`);
    const deleted = branch ? await localDeleteBranch(main, base, branch, provenHead) : false;
    return { removed: true, branchDeleted: deleted };
  }
  const { code, stdout } = await runRemote(host, REMOTE_REMOVE_SCRIPT, [main, target.path, branch, provenHead, provenHead ? base : ""],
    { execImpl, timeout: GIT_REVIEW_LIMITS.remoteMs + GIT_REVIEW_LIMITS.removeMs });
  const output = stdout.toString("utf8");
  if (code === 7) throw new GitReviewError(`git refused to remove the worktree: ${gitMessage(output) || "unknown error"}`);
  if (code !== 0 || !output.startsWith("removed\n")) throw new GitReviewError("Could not remove the worktree on this device.", 503);
  return { removed: true, branchDeleted: output.includes("branch-deleted\n") };
}

// -------------------------------------------------------------- CI failures

// Failed GitHub Actions logs of a branch, saved to a file inside the
// repository's git dir (never part of the working tree, so never committed)
// for the tile's agent to read. `gh run list` finds the newest commit's runs;
// `gh run view <id> --log-failed` prints "job\tstep\tline" for failed steps,
// of which only the last jobLines lines per job are kept.
export const CI_LIMITS = {
  listRuns: 30,
  runs: 4,
  jobLines: 200,
  lineChars: 1000,
  fileBytes: 512 * 1024,
  streamBytes: 64 * 1024 * 1024,
  logMs: 30000,
  names: 8,
};
export const CI_LOG_NAME = "ci-failure.log";
const CI_FAILED = new Set(["failure", "timed_out", "startup_failure", "cancelled"]);
const CI_RUN_FIELDS = "databaseId,workflowName,headSha,conclusion";
const GH_ENV = { GH_PROMPT_DISABLED: "1", GH_NO_UPDATE_NOTIFIER: "1", NO_COLOR: "1" };
const ANSI = /\u001b\[[0-9;]*[A-Za-z]/g;

export const validateGitCiFailuresRequest = (body) => validateFolder(body, []);

const ghMissing = () => new GitReviewError("The GitHub CLI (gh) is not installed on this device. Install it and run gh auth login to send CI logs.", 409);
const ghSignedOut = () => new GitReviewError("The GitHub CLI is not signed in on this device. Run gh auth login, then try again.", 409);
const notOnBranch = () => new GitReviewError("This folder is not on a branch, so it has no CI runs.", 409);
const logNotSaved = () => new GitReviewError("Could not save the CI logs in the repository's .git folder.", 500);
const cleanName = (value) => (typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ").trim().slice(0, 200) : "");

// The failed runs of the newest commit that has runs on the branch (gh lists
// newest first); runs of older commits are already superseded.
export function failedCiRuns(text) {
  let value;
  try { value = JSON.parse(text); } catch { return null; }
  if (!Array.isArray(value)) return null;
  const runs = value.filter((run) => run && Number.isSafeInteger(run.databaseId) && run.databaseId > 0
    && typeof run.headSha === "string" && SHA.test(run.headSha));
  if (!runs.length) return { sha: null, runs: [] };
  const sha = runs[0].headSha;
  return {
    sha,
    runs: runs.filter((run) => run.headSha === sha && CI_FAILED.has(String(run.conclusion).toLowerCase())).slice(0, CI_LIMITS.runs)
      .map((run) => ({ id: run.databaseId, workflow: cleanName(run.workflowName) || `run ${run.databaseId}` })),
  };
}

// gh exited with `code` (null: not installed) after printing `output`.
function ciPlan(branch, gh) {
  if (gh === null) throw ghMissing();
  if (gh.code === 4) throw ghSignedOut();
  if (gh.code !== 0) throw new GitReviewError(`gh could not list the GitHub Actions runs of ${branch}${gh.detail ? `: ${gh.detail}` : "."}`, 502);
  const plan = failedCiRuns(gh.output);
  if (!plan) throw new GitReviewError("gh returned an unreadable run list.", 502);
  if (!plan.sha) throw new GitReviewError(`No GitHub Actions runs found for ${branch}.`, 409);
  if (!plan.runs.length) throw new GitReviewError(`The latest GitHub Actions runs of ${branch} have no failed jobs.`, 409);
  return plan;
}

// Collects `--log-failed` output as it streams. The device script does the
// same in awk (REMOTE_CI_LOGS_SCRIPT), so both write the same file.
export function createJobTail() {
  const jobs = new Map();
  let partial = "";
  const add = (raw) => {
    const line = raw.replace(/\r/g, "").replace(/﻿/g, "").replace(ANSI, "");
    if (!line) return;
    const tab = line.indexOf("\t");
    const job = (tab < 0 ? "" : line.slice(0, tab)) || "log";
    const rest = tab < 0 ? line : line.slice(tab + 1);
    let entry = jobs.get(job);
    if (!entry) { entry = { lines: [], total: 0 }; jobs.set(job, entry); }
    entry.total += 1;
    entry.lines.push(rest.slice(0, CI_LIMITS.lineChars));
    if (entry.lines.length > CI_LIMITS.jobLines) entry.lines.shift();
  };
  return {
    push(text) {
      const lines = (partial + text).split("\n");
      partial = lines.pop();
      lines.forEach(add);
    },
    end() { if (partial) add(partial); partial = ""; return jobs; },
  };
}

export function ciJobsText(jobs) {
  if (!jobs.size) return "(failed step logs unavailable)\n";
  const out = [];
  for (const [job, { lines, total }] of jobs) {
    out.push(`--- job: ${job}${total > lines.length ? ` (last ${lines.length} of ${total} lines)` : ""} ---`, ...lines);
  }
  return `${out.join("\n")}\n`;
}

const ciHeader = (branch, sha) => `CI failure logs for ${branch} at ${sha}\nFailed steps only: the last ${CI_LIMITS.jobLines} lines of each failed job.\n`;
const CI_TRUNCATED = "\n[truncated: the log file reached its size limit]\n";

// Keeps the first fileBytes bytes, like `head -c` in the device script.
export function capCiLog(buffer) {
  return buffer.length > CI_LIMITS.fileBytes ? Buffer.concat([buffer.subarray(0, CI_LIMITS.fileBytes), Buffer.from(CI_TRUNCATED)]) : buffer;
}

function localFailedLog(ghCommand, cwd, id) {
  return new Promise((resolve) => {
    const tail = createJobTail();
    const decoder = new StringDecoder("utf8");
    let size = 0, settled = false, child;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      child?.kill("SIGKILL");
      tail.push(decoder.end());
      resolve(tail.end());
    };
    const timer = setTimeout(finish, CI_LIMITS.logMs);
    try { child = spawn(ghCommand, ["run", "view", String(id), "--log-failed"], { cwd, env: localEnv(GH_ENV), stdio: ["ignore", "pipe", "ignore"] }); }
    catch { finish(); return; }
    child.stdout.on("data", (chunk) => {
      if (settled) return;
      const part = chunk.subarray(0, CI_LIMITS.streamBytes - size);
      size += part.length;
      tail.push(decoder.write(part));
      if (size >= CI_LIMITS.streamBytes) finish();
    });
    child.on("error", finish);
    child.on("close", finish);
  });
}

// Replaces <gitdir>/pzzacode/ci-failure.log through a fresh private temp file;
// a symlinked pzzacode folder is refused and rename never follows a link.
async function writeCiLog(gitDir, content) {
  const dir = nodePath.join(gitDir, "pzzacode");
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    if (!(await lstat(dir)).isDirectory()) throw logNotSaved();
    const file = nodePath.join(dir, CI_LOG_NAME);
    const temp = nodePath.join(dir, `.${CI_LOG_NAME}.${process.pid}.${Date.now()}.tmp`);
    const handle = await open(temp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try { await handle.writeFile(content); } finally { await handle.close(); }
    await rename(temp, file);
    return file;
  } catch (error) {
    if (error instanceof GitReviewError) throw error;
    throw logNotSaved();
  }
}

const uniqueNames = (names) => [...new Set(names.map(cleanName).filter(Boolean))];

async function localCiFailures(path, ghCommand) {
  const top = await localToplevel(path);
  const branchResult = await runLocal("git", ["-C", top, "symbolic-ref", "--short", "-q", "HEAD"], { maxBytes: 1024 });
  const branch = ok(branchResult) ? firstLine(branchResult.stdout) : "";
  if (!branch || CONTROL.test(branch)) throw notOnBranch();
  const gitDirResult = await runLocal("git", ["-C", top, "rev-parse", "--absolute-git-dir"], { maxBytes: 8192 });
  const gitDir = ok(gitDirResult) ? firstLine(gitDirResult.stdout) : "";
  if (!gitDir.startsWith("/") || CONTROL.test(gitDir)) throw notRepo();
  const list = await runLocal(ghCommand, ["run", "list", `--branch=${branch}`, "--limit", String(CI_LIMITS.listRuns), "--json", CI_RUN_FIELDS], {
    cwd: top, timeoutMs: GIT_REVIEW_LIMITS.ghMs, maxBytes: GIT_REVIEW_LIMITS.ghBytes, env: localEnv(GH_ENV),
  });
  const plan = ciPlan(branch, list.missing ? null : {
    code: list.timedOut || list.truncated ? -1 : list.code, output: list.stdout.toString("utf8"), detail: gitMessage(list.stderr.split("\n")[0] ?? ""),
  });
  const logs = await Promise.all(plan.runs.map((run) => localFailedLog(ghCommand, top, run.id)));
  const parts = [Buffer.from(ciHeader(branch, plan.sha))];
  plan.runs.forEach((run, index) => {
    parts.push(Buffer.from(`\n=== ${run.workflow} (run ${run.id}) ===\n`), Buffer.from(ciJobsText(logs[index])).subarray(0, CI_LIMITS.fileBytes + 1));
  });
  const file = await writeCiLog(gitDir, capCiLog(Buffer.concat(parts)));
  const jobs = uniqueNames(logs.flatMap((jobsOfRun) => [...jobsOfRun.keys()]));
  return { branch, sha: plan.sha, path: file, checks: (jobs.length ? jobs : uniqueNames(plan.runs.map((run) => run.workflow))).slice(0, CI_LIMITS.names) };
}

// $1 folder. Prints the branch and gh's run list (exit 9: no gh, 8: no branch).
export const REMOTE_CI_RUNS_SCRIPT = String.raw`${PRELUDE}cd -- "$top" 2>/dev/null || exit 3
export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1
br=$(git symbolic-ref --short -q HEAD 2>/dev/null) || exit 8
command -v gh >/dev/null 2>&1 || exit 9
if command -v timeout >/dev/null 2>&1; then out=$(timeout ${GIT_REVIEW_LIMITS.ghMs / 1000} gh run list --branch="$br" --limit ${CI_LIMITS.listRuns} --json ${CI_RUN_FIELDS} 2>/dev/null </dev/null); code=$?
else out=$(gh run list --branch="$br" --limit ${CI_LIMITS.listRuns} --json ${CI_RUN_FIELDS} 2>/dev/null </dev/null); code=$?; fi
printf '\036branch\n%s\n\036ghcode\n%s\n\036gh\n' "$br" "$code"; printf '%s' "$out" | head -c ${GIT_REVIEW_LIMITS.ghBytes}; printf '\n'
exit 0`;

// $1 folder, $2 branch, $3 commit, then pairs of run id and workflow name.
// Writes the same file as the local path, then prints its path and the job
// names (exit 9: no gh, 10: the file could not be written).
export const REMOTE_CI_LOGS_SCRIPT = String.raw`${PRELUDE}cd -- "$top" 2>/dev/null || exit 3
export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1
gd=$(git rev-parse --absolute-git-dir 2>/dev/null) || exit 3
command -v gh >/dev/null 2>&1 || exit 9
gh_logs() {
  if command -v timeout >/dev/null 2>&1; then timeout ${CI_LIMITS.logMs / 1000} gh run view "$1" --log-failed 2>/dev/null </dev/null
  else gh run view "$1" --log-failed 2>/dev/null </dev/null; fi
}
tail_jobs() {
  awk -v max=${CI_LIMITS.jobLines} -v width=${CI_LIMITS.lineChars} '
  { gsub(/\r/, ""); gsub(/\357\273\277/, ""); gsub(/\033\[[0-9;]*[A-Za-z]/, "")
    if ($0 == "") next
    t = index($0, "\t")
    if (t) { job = substr($0, 1, t - 1); rest = substr($0, t + 1) } else { job = ""; rest = $0 }
    if (job == "") job = "log"
    if (!(job in n)) { order[++jobs] = job; n[job] = 0 }
    n[job]++; buf[job, n[job] % max] = substr(rest, 1, width) }
  END {
    if (!jobs) { print "(failed step logs unavailable)"; exit }
    for (i = 1; i <= jobs; i++) {
      job = order[i]; total = n[job]; first = total > max ? total - max + 1 : 1
      if (total > max) printf "--- job: %s (last %d of %d lines) ---\n", job, max, total
      else printf "--- job: %s ---\n", job
      for (k = first; k <= total; k++) print buf[job, k % max]
    } }'
}
dir="$gd/pzzacode"
[ -L "$dir" ] && exit 10
mkdir -p -- "$dir" 2>/dev/null || exit 10
[ -d "$dir" ] && [ ! -L "$dir" ] || exit 10
umask 077
tmp="$dir/.${CI_LOG_NAME}.$$.tmp"
rm -f -- "$tmp" "$tmp.cut"
branch=$2; sha=$3; shift 3
{
  printf 'CI failure logs for %s at %s\nFailed steps only: the last ${CI_LIMITS.jobLines} lines of each failed job.\n' "$branch" "$sha"
  while [ $# -ge 2 ]; do
    printf '\n=== %s (run %s) ===\n' "$2" "$1"
    gh_logs "$1" | head -c ${CI_LIMITS.streamBytes} | tail_jobs | head -c ${CI_LIMITS.fileBytes + 1}
    shift 2
  done
} > "$tmp" || exit 10
if [ "$(wc -c < "$tmp" | tr -d ' ')" -gt ${CI_LIMITS.fileBytes} ]; then
  { head -c ${CI_LIMITS.fileBytes} "$tmp"; printf '\n[truncated: the log file reached its size limit]\n'; } > "$tmp.cut" && mv -f -- "$tmp.cut" "$tmp" || exit 10
fi
mv -f -- "$tmp" "$dir/${CI_LOG_NAME}" || exit 10
printf '\036file\n%s\n\036jobs\n' "$dir/${CI_LOG_NAME}"
sed -n 's/^--- job: \(.*\) ---$/\1/p' "$dir/${CI_LOG_NAME}" | sed 's/ (last [0-9]* of [0-9]* lines)$//' | head -n 50
exit 0`;

async function remoteCiFailures(host, path, execImpl) {
  const listed = await runRemote(host, REMOTE_CI_RUNS_SCRIPT, [path], { execImpl });
  if (listed.code === 8) throw notOnBranch();
  if (listed.code === 9) throw ghMissing();
  const found = new Map(sections(listed.stdout.toString("utf8")));
  const branch = found.get("branch") ?? "";
  if (listed.code !== 0 || !branch || CONTROL.test(branch)) throw new GitReviewError("Invalid Git response from the device.", 502);
  const plan = ciPlan(branch, { code: Number(found.get("ghcode")), output: found.get("gh") ?? "", detail: "" });
  const args = [path, branch, plan.sha, ...plan.runs.flatMap((run) => [String(run.id), run.workflow])];
  const { code, stdout } = await runRemote(host, REMOTE_CI_LOGS_SCRIPT, args,
    { execImpl, timeout: GIT_REVIEW_LIMITS.remoteMs + plan.runs.length * CI_LIMITS.logMs });
  if (code === 9) throw ghMissing();
  if (code === 10) throw logNotSaved();
  const result = new Map(sections(stdout.toString("utf8")));
  const file = result.get("file") ?? "";
  if (code !== 0 || !file.startsWith("/") || CONTROL.test(file)) throw new GitReviewError("Invalid Git response from the device.", 502);
  const jobs = uniqueNames((result.get("jobs") ?? "").split("\n"));
  return { branch, sha: plan.sha, path: file, checks: (jobs.length ? jobs : uniqueNames(plan.runs.map((run) => run.workflow))).slice(0, CI_LIMITS.names) };
}

export function gitCiFailures({ host, path }, { execImpl, ghCommand = "gh" } = {}) {
  return isLocal(host) ? localCiFailures(path, ghCommand) : remoteCiFailures(host, path, execImpl);
}

// ------------------------------------------------------------------- router

const ROUTES = {
  "/git/changes": [validateGitChangesRequest, gitChanges],
  "/git/diff": [validateGitDiffRequest, gitDiff],
  "/git/remote": [validateGitRemoteRequest, gitRemote],
  "/git/worktrees": [validateGitWorktreesRequest, gitWorktrees],
  "/git/worktrees/remove": [validateGitRemoveWorktreeRequest, gitRemoveWorktree],
  "/git/ci-failures": [validateGitCiFailuresRequest, gitCiFailures],
};

export async function gitReviewRouter(req, res, url, json) {
  if (!Object.hasOwn(ROUTES, url.pathname)) return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST for Git review requests" }); return true; }
  const [validate, handle] = ROUTES[url.pathname];
  const { readBody } = await import("./http.js");
  let request;
  try { request = validate(await readBody(req)); }
  catch (error) { json(res, 400, { error: error.message }); return true; }
  try { json(res, 200, await handle(request)); }
  catch (error) {
    if (error instanceof GitReviewError) json(res, error.status, { error: error.message });
    else json(res, 500, { error: "Git data is unavailable for this folder." });
  }
  return true;
}
