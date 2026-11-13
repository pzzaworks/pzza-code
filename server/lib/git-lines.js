// Per-line Git data for the file open in the code editor: the file's content
// at HEAD (the editor diffs its own buffer against it for the change gutter,
// so unsaved edits are covered without a request per keystroke) and
// `git blame` of HEAD (the editor maps its lines onto HEAD's through the same
// diff for inline blame). The path is the editor's own absolute file path and
// passes the same home-tree guards as reading the file: realSafePath locally,
// remotePath plus remoteGuard over ssh. A file outside any repository answers
// { repo: false }; a file that is too large answers tooLarge instead of data.
import { execFile } from "node:child_process";
import { lstat, realpath } from "node:fs/promises";
import nodePath from "node:path";
import { GitReviewError, remoteGitReviewCommand, runLocal, validateRepoFile } from "./git-review.js";
import { denied, realSafePath, refusalReason, remoteGuard, remotePath } from "./paths.js";
import { SSH_TOKEN, deviceEnv } from "./shell.js";

export const GIT_LINES_LIMITS = {
  pathLength: 4096,
  // HEAD content and blame are skipped above these, matching the editor's own cut-off.
  blobBytes: 1024 * 1024,
  lines: 10000,
  // Blame output without the content lines: one header per line plus each commit's details once.
  blameBytes: 4 * 1024 * 1024,
  author: 200,
  summary: 500,
  localMs: 15000,
  remoteMs: 25000,
  remoteBuffer: 8 * 1024 * 1024,
};

const CONTROL = /[\u0000-\u001f\u007f]/;
const RS = "\u001e";
// `git ls-tree -l`: "<mode> <type> <object> <size>\t<path>".
const TREE_ENTRY = /^(\d{6}) (\w+) ([0-9a-f]{40}(?:[0-9a-f]{24})?) +(\d+|-)\t/;
const BLAME_HEADER = /^([0-9a-f]{40}(?:[0-9a-f]{24})?) (\d+) (\d+)(?: (\d+))?$/;

export class GitLinesError extends GitReviewError {}
const notFile = () => new GitLinesError("Only regular files have Git line data.");
const outsideRepo = () => new GitLinesError("That file is outside the repository.");
const unreachable = () => new GitLinesError("Could not reach the device to read Git data.", 503);
const gitFailed = () => new GitLinesError("Git data is unavailable for this file.", 500);

export function validateGitFileRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a JSON object with host and path.");
  if (Object.keys(body).some((key) => key !== "host" && key !== "path")) throw new Error("Unknown request field.");
  const host = body.host ?? "";
  if (typeof host !== "string" || (host && !SSH_TOKEN.test(host))) throw new Error("Invalid device host.");
  const { path } = body;
  if (typeof path !== "string" || !(path.startsWith("/") || path.startsWith("~/")) || path.length > GIT_LINES_LIMITS.pathLength || CONTROL.test(path)) {
    throw new Error("The file path must be absolute, at most 4096 characters, without control characters.");
  }
  if (host && !remotePath(path)) throw new Error("The file path must not contain '..' segments.");
  return { host, path };
}

// ------------------------------------------------------------------ parsing

// The HEAD entry of a file, or null when HEAD has no regular file there (a new
// file, a symlink, a submodule, or no commit yet).
export function parseTreeEntry(text) {
  const match = TREE_ENTRY.exec(text);
  if (!match) return null;
  const [, mode, type, object, size] = match;
  if (type !== "blob" || (mode !== "100644" && mode !== "100755") || size === "-") return null;
  return { blob: object, size: Number(size) };
}

// UTF-8 text, or null for binary or other encodings: the editor only opens
// UTF-8 text, so anything else has nothing to compare against.
function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return null; }
}

const clip = (value, max) => (value.length > max ? value.slice(0, max) : value);

// `git blame --porcelain` with the content lines already removed. Every final
// line has a header naming its commit; a commit's details follow its first
// header only. Returns the commits and, per line of HEAD, its commit's index,
// or null when the file has more lines than the cap.
export function parseBlame(text) {
  const commits = [];
  const index = new Map();
  const lines = [];
  let current = null;
  for (const line of text.split("\n")) {
    const header = BLAME_HEADER.exec(line);
    if (header) {
      const hash = header[1];
      const final = Number(header[3]);
      if (final < 1 || final > GIT_LINES_LIMITS.lines) return null;
      let at = index.get(hash);
      if (at === undefined) {
        at = commits.length;
        index.set(hash, at);
        commits.push({ hash, author: "", time: 0, summary: "" });
      }
      current = commits[at];
      lines[final - 1] = at;
      continue;
    }
    if (!current || line.startsWith("\t")) continue;
    const space = line.indexOf(" ");
    const key = space < 0 ? line : line.slice(0, space);
    const value = space < 0 ? "" : line.slice(space + 1);
    if (key === "author") current.author = clip(value, GIT_LINES_LIMITS.author);
    else if (key === "author-time" && /^\d+$/.test(value)) current.time = Number(value);
    else if (key === "summary") current.summary = clip(value, GIT_LINES_LIMITS.summary);
  }
  // A gap would mean a cut-off or garbled stream: no partial attribution.
  for (let at = 0; at < lines.length; at += 1) if (lines[at] === undefined) return null;
  return { commits, lines };
}

// --------------------------------------------------------------------- local

const ok = (result) => result.code === 0 && !result.timedOut && !result.missing;
const git = (top, args, options) => runLocal("git", ["--literal-pathspecs", "-C", top, ...args], { timeoutMs: GIT_LINES_LIMITS.localMs, ...options });

// The repository and repository-relative path of a local file, or null when
// it is in no repository. Symlinks are resolved first (realSafePath), so the
// data is for the file the editor actually reads.
async function localTarget(path) {
  let real;
  try { real = realSafePath(path); }
  catch { return null; }
  if (!real) throw new GitLinesError(refusalReason(path), 403);
  try { if (!(await lstat(real)).isFile()) throw notFile(); }
  catch (error) { if (error instanceof GitLinesError) throw error; }
  const dir = nodePath.dirname(real);
  const top = await runLocal("git", ["-C", dir, "rev-parse", "--show-toplevel"], { maxBytes: 8192 });
  const topText = top.stdout.toString("utf8").replace(/\n$/, "");
  if (!ok(top) || !topText.startsWith("/") || CONTROL.test(topText)) return null;
  const root = await realpath(topText);
  const file = nodePath.relative(root, real);
  if (!file || file.startsWith("..") || nodePath.isAbsolute(file) || !validateRepoFile(file)) throw outsideRepo();
  return { root, file };
}

async function localEntry(root, file) {
  const listed = await git(root, ["ls-tree", "-l", "HEAD", "--", file], { maxBytes: 64 * 1024 });
  return ok(listed) ? parseTreeEntry(listed.stdout.toString("utf8")) : null;
}

async function localHead(path) {
  const target = await localTarget(path);
  if (!target) return { repo: false };
  const entry = await localEntry(target.root, target.file);
  const base = { repo: true, root: target.root, file: target.file, blob: entry?.blob ?? null, head: null, tooLarge: false, binary: false };
  if (!entry) return base;
  if (entry.size > GIT_LINES_LIMITS.blobBytes) return { ...base, tooLarge: true };
  const blob = await git(target.root, ["cat-file", "blob", entry.blob], { maxBytes: GIT_LINES_LIMITS.blobBytes });
  if (!ok(blob) || blob.truncated) throw gitFailed();
  return withContent(base, blob.stdout);
}

function withContent(base, bytes) {
  const text = decodeText(bytes);
  if (text === null) return { ...base, binary: true };
  if (lineCount(text) > GIT_LINES_LIMITS.lines) return { ...base, tooLarge: true };
  return { ...base, head: text };
}

function lineCount(text) {
  let count = 1;
  for (let at = text.indexOf("\n"); at >= 0; at = text.indexOf("\n", at + 1)) count += 1;
  return count;
}

async function localBlame(path) {
  const target = await localTarget(path);
  if (!target) return { repo: false };
  const entry = await localEntry(target.root, target.file);
  const base = { repo: true, root: target.root, file: target.file, blob: entry?.blob ?? null, tooLarge: false, commits: [], lines: [] };
  if (!entry) return base;
  if (entry.size > GIT_LINES_LIMITS.blobBytes) return { ...base, tooLarge: true };
  // Content lines are never needed; dropping them here would need a pipe, so
  // they are read and skipped, within a cap sized for the largest file allowed.
  const blamed = await git(target.root, ["blame", "--porcelain", "HEAD", "--", target.file], { maxBytes: GIT_LINES_LIMITS.blameBytes + GIT_LINES_LIMITS.blobBytes });
  if (blamed.truncated) return { ...base, tooLarge: true };
  if (!ok(blamed)) throw gitFailed();
  return withBlame(base, blamed.stdout.toString("utf8"));
}

function withBlame(base, text) {
  const parsed = parseBlame(text);
  return parsed ? { ...base, ...parsed } : { ...base, tooLarge: true };
}

// -------------------------------------------------------------------- remote

// Sets $real (repository top) and $rel (file inside it) after remoteGuard has
// bounded "$p" to the remote home, or prints a norepo record. Exit 4: not a
// regular file; 6: the resolved file left the repository.
const REMOTE_LOCATE = `export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_LITERAL_PATHSPECS=1
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
set -f
[ ! -e "$p" ] || [ -f "$p" ] || exit 4
d=$(dirname -- "$p"); n=$(basename -- "$p")
rd=$(cd -P -- "$d" 2>/dev/null && pwd -P) || { printf '\\036norepo\\n'; exit 0; }
top=$(git -C "$rd" rev-parse --show-toplevel 2>/dev/null) || { printf '\\036norepo\\n'; exit 0; }
real=$(cd -P -- "$top" 2>/dev/null && pwd -P) || { printf '\\036norepo\\n'; exit 0; }
case "$rd/$n" in "$real"/*) ;; *) exit 6 ;; esac
rel=\${rd#"$real"}; rel=\${rel#/}; rel="\${rel:+$rel/}$n"
cd -- "$real" || exit 5
printf '\\036root\\n%s\\n\\036file\\n%s\\n' "$real" "$rel"
entry=$(git ls-tree -l HEAD -- "$rel" 2>/dev/null | head -n 1)
printf '\\036entry\\n%s\\n' "$entry"
set -- $entry
[ "$1" = 100644 ] || [ "$1" = 100755 ] || exit 0
[ "$2" = blob ] || exit 0
[ "$4" -le ${GIT_LINES_LIMITS.blobBytes} ] 2>/dev/null || exit 0
`;

export function remoteHeadScript(path) {
  return `${remoteGuard(path)}${REMOTE_LOCATE}printf '\\036content\\n'; git cat-file blob "$3" 2>/dev/null | head -c ${GIT_LINES_LIMITS.blobBytes + 1} | base64; printf '\\n'
exit 0`;
}

export function remoteBlameScript(path) {
  return `${remoteGuard(path)}${REMOTE_LOCATE}printf '\\036blame\\n'; git blame --porcelain HEAD -- "$rel" 2>/dev/null | awk 'substr($0, 1, 1) != "\\t"' | head -c ${GIT_LINES_LIMITS.blameBytes + 1} | base64; printf '\\n'
exit 0`;
}

function runRemote(host, script, execImpl) {
  const [cmd, args] = remoteGitReviewCommand(host, script, []);
  return new Promise((resolve, reject) => {
    execImpl(cmd, args, { env: deviceEnv(host), timeout: GIT_LINES_LIMITS.remoteMs, maxBuffer: GIT_LINES_LIMITS.remoteBuffer, encoding: "buffer" }, (error, stdout) => {
      const out = Buffer.from(stdout ?? "");
      const code = error ? error.code : 0;
      if (code === 3 && denied(out.toString("latin1"))) { reject(new GitLinesError("This file is protected or outside your home folder.", 403)); return; }
      if (code === 4) { reject(notFile()); return; }
      if (code === 6) { reject(outsideRepo()); return; }
      if (error) { reject(typeof code === "number" && code !== 255 && !error.killed ? gitFailed() : unreachable()); return; }
      resolve(out.toString("utf8"));
    });
  });
}

function records(text) {
  const found = new Map();
  for (const record of text.split(RS).slice(1)) {
    const newline = record.indexOf("\n");
    const name = newline < 0 ? record : record.slice(0, newline);
    const body = newline < 0 ? "" : record.slice(newline + 1);
    found.set(name, body.endsWith("\n") ? body.slice(0, -1) : body);
  }
  return found;
}

// The located file, or null for a norepo answer; anything malformed is a 502.
function remoteTarget(found) {
  if (found.has("norepo")) return null;
  const root = found.get("root") ?? "";
  const file = found.get("file") ?? "";
  if (!root.startsWith("/") || CONTROL.test(root) || !validateRepoFile(file)) throw new GitLinesError("Invalid Git response from the device.", 502);
  return { root, file, entry: parseTreeEntry(found.get("entry") ?? "") };
}

const base64 = (body) => Buffer.from(body.replace(/\s+/g, ""), "base64");

async function remoteHead(host, path, execImpl) {
  const found = records(await runRemote(host, remoteHeadScript(path), execImpl));
  const target = remoteTarget(found);
  if (!target) return { repo: false };
  const { root, file, entry } = target;
  const base = { repo: true, root, file, blob: entry?.blob ?? null, head: null, tooLarge: false, binary: false };
  if (!entry) return base;
  if (entry.size > GIT_LINES_LIMITS.blobBytes) return { ...base, tooLarge: true };
  if (!found.has("content")) throw gitFailed();
  const bytes = base64(found.get("content"));
  if (bytes.length > GIT_LINES_LIMITS.blobBytes) return { ...base, tooLarge: true };
  return withContent(base, bytes);
}

async function remoteBlame(host, path, execImpl) {
  const found = records(await runRemote(host, remoteBlameScript(path), execImpl));
  const target = remoteTarget(found);
  if (!target) return { repo: false };
  const { root, file, entry } = target;
  const base = { repo: true, root, file, blob: entry?.blob ?? null, tooLarge: false, commits: [], lines: [] };
  if (!entry) return base;
  if (entry.size > GIT_LINES_LIMITS.blobBytes) return { ...base, tooLarge: true };
  if (!found.has("blame")) throw gitFailed();
  const bytes = base64(found.get("blame"));
  if (bytes.length > GIT_LINES_LIMITS.blameBytes) return { ...base, tooLarge: true };
  return withBlame(base, bytes.toString("utf8"));
}

// An empty host is this device, as for the editor's own file reads.
export function gitFileHead({ host, path }, { execImpl = execFile } = {}) {
  return host ? remoteHead(host, path, execImpl) : localHead(path);
}

export function gitFileBlame({ host, path }, { execImpl = execFile } = {}) {
  return host ? remoteBlame(host, path, execImpl) : localBlame(path);
}

// ------------------------------------------------------------------- router

const ROUTES = {
  "/git/file-head": gitFileHead,
  "/git/file-blame": gitFileBlame,
};

export async function gitLinesRouter(req, res, url, json) {
  if (!Object.hasOwn(ROUTES, url.pathname)) return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST for Git line requests" }); return true; }
  const { readBody } = await import("./http.js");
  let request;
  try { request = validateGitFileRequest(await readBody(req)); }
  catch (error) { json(res, 400, { error: error.message }); return true; }
  try { json(res, 200, await ROUTES[url.pathname](request)); }
  catch (error) {
    if (error instanceof GitReviewError) json(res, error.status, { error: error.message });
    else json(res, 500, { error: "Git data is unavailable for this file." });
  }
  return true;
}
