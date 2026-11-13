// Project-wide file listing (the editor's Quick Open) and text search (its
// project search). Both stay inside the editor's folder: a local folder must
// pass realSafePath and a remote one remoteGuard, the tools never follow
// symlinks out of it, and every path a tool reports is checked against the
// same credential denylist before it is returned. The best available tool is
// used (git, ripgrep, then a bounded walk or grep) and every run is capped in
// records, output bytes and time, so a huge folder answers with a truncated
// result instead of a hung request.
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR } from "./config.js";
import { SSH_TOKEN, deviceEnv, shQuote } from "./shell.js";
import { readBody } from "./http.js";
import { realSafePath, refusalReason, remoteGuard, remotePath, safePath, sensitivePath } from "./paths.js";

export const CODE_SEARCH_LIMITS = {
  files: 20_000,
  walkDirs: 20_000,
  walkDepth: 32,
  matches: 1_000,
  matchesPerFile: 50,
  rangesPerLine: 20,
  lineChars: 240,
  query: 256,
  rootLength: 4096,
  outputBytes: 16 * 1024 * 1024,
  scanFileBytes: 1024 * 1024,
  scanTotalBytes: 64 * 1024 * 1024,
  localMs: 8_000,
  remoteMs: 15_000,
};

// Never listed or searched, whatever the ignore rules say.
const ALWAYS_SKIP = new Set(["node_modules", ".git", ".hg", ".svn"]);
// Also skipped by the plain walk, which has no ignore rules to go by.
const WALK_SKIP = new Set([
  ...ALWAYS_SKIP, ".venv", "venv", "__pycache__", ".next", ".nuxt", ".turbo", ".cache", ".gradle", ".idea",
  ".pytest_cache", ".mypy_cache", "dist", "build", "target", "coverage", "Pods", "DerivedData",
]);

const GIT_ENV = { GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" };
// A repository's own config can name an fsmonitor program that git would run;
// listing and searching never need it.
const GIT_BASE = ["-c", "core.fsmonitor=false"];
const GIT_LIST = [...GIT_BASE, "ls-files", "-z", "--cached", "--others", "--exclude-standard"];
const RG_LIST = ["--files", "--no-config", "--hidden", "--no-messages", "-0", "-g", "!.git", "-g", "!node_modules"];

function rgSearchArgs({ query, caseSensitive, regex }) {
  return [
    "--json", "--no-config", "--hidden", "--no-messages", "--max-filesize", "2M",
    "--max-count", String(CODE_SEARCH_LIMITS.matchesPerFile), "-g", "!.git", "-g", "!node_modules",
    caseSensitive ? "--case-sensitive" : "--ignore-case", ...(regex ? [] : ["--fixed-strings"]), "-e", query, "--", ".",
  ];
}
// A regular expression goes to git as Perl syntax (closest to the JavaScript
// the editor validated it with) when git was built with PCRE, else as POSIX
// extended syntax.
function gitGrepArgs({ query, caseSensitive, regex }, flavor = regex ? "-P" : "-F") {
  return [...GIT_BASE, "grep", "-n", "-I", "-z", "--no-color", "--untracked", ...(caseSensitive ? [] : ["-i"]), flavor, "-e", query, "--", "."];
}
function grepArgs({ query, caseSensitive, regex }) {
  return [
    "-r", "-n", "-I", "--null", "-m", String(CODE_SEARCH_LIMITS.matchesPerFile),
    ...[...ALWAYS_SKIP].map((name) => `--exclude-dir=${name}`),
    ...(caseSensitive ? [] : ["-i"]), regex ? "-E" : "-F", "-e", query, "--", ".",
  ];
}

const fail = (status, message) => Object.assign(new Error(message), { status });

// ---- Process output, one record at a time ----

// Runs a tool and hands its stdout to `onRecord` one record at a time
// (records end with the `separator` byte). Stops the tool when onRecord
// returns false, the output passes `maxBytes`, the deadline passes or
// `signal` aborts. Resolves { outcome, code }, outcome being "done",
// "stopped", "limit", "timeout", "aborted", "missing" (no such tool) or
// "failed" (an exit code outside `okCodes`).
export function runRecords(command, args, {
  cwd, env, separator = 10, timeoutMs, maxBytes = CODE_SEARCH_LIMITS.outputBytes, signal, onRecord, okCodes = [0], spawnImpl = spawn,
}) {
  return new Promise((resolve) => {
    if (signal?.aborted) { resolve({ outcome: "aborted", code: null }); return; }
    let child;
    try { child = spawnImpl(command, args, { cwd, env, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve({ outcome: "missing", code: null }); return; }
    let settled = false;
    let outcome = null;
    let pending = [];
    let pendingLength = 0;
    let total = 0;
    const finish = (value, code = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      resolve({ outcome: value, code });
    };
    const stop = (value) => {
      if (!outcome) outcome = value;
      child.kill("SIGKILL");
    };
    const timer = setTimeout(() => stop("timeout"), Math.max(1, timeoutMs));
    const abort = () => stop("aborted");
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk) => {
      if (outcome) return;
      total += chunk.length;
      if (total > maxBytes) { stop("limit"); return; }
      let start = 0;
      for (let end = chunk.indexOf(separator); end !== -1; end = chunk.indexOf(separator, start)) {
        const piece = chunk.subarray(start, end);
        const record = pendingLength ? Buffer.concat([...pending, piece], pendingLength + piece.length) : piece;
        pending = [];
        pendingLength = 0;
        start = end + 1;
        if (onRecord(record) === false) { stop("stopped"); return; }
      }
      if (start < chunk.length) {
        pending.push(chunk.subarray(start));
        pendingLength += chunk.length - start;
      }
    });
    child.on("error", (error) => finish(error.code === "ENOENT" ? "missing" : "failed"));
    child.on("close", (code) => {
      if (!outcome && pendingLength && onRecord(Buffer.concat(pending, pendingLength)) === false) outcome = "stopped";
      finish(outcome ?? (okCodes.includes(code) ? "done" : "failed"), code);
    });
  });
}

// ---- Path checks ----

const within = (root, candidate, sep = path.sep) => candidate === root || candidate.startsWith(root + sep);

// A tool's relative path, normalized; null for one that could leave the root.
export function cleanRelative(raw) {
  const rel = raw.startsWith("./") ? raw.slice(2) : raw;
  if (!rel || rel.startsWith("/") || /[\u0000\n\r]/.test(rel)) return null;
  const parts = rel.split("/");
  if (parts.some((part) => part === ".." || part === "." || part === "")) return null;
  return rel;
}

// Whether a file under a local root may be shown: not inside an always-skipped
// folder, and not a credential store by its path in home or its real path.
function localFilter(lexicalRoot, realRoot) {
  const home = os.homedir();
  let realHome = home;
  try { realHome = fs.realpathSync.native(home); } catch { /* Home itself is the bound then. */ }
  let token = path.join(STATE_DIR, "agent-token");
  try { token = fs.realpathSync.native(token); } catch { /* No token file to hide. */ }
  return (rel) => {
    if (rel.split("/").some((part) => ALWAYS_SKIP.has(part))) return false;
    for (const [base, bound] of [[lexicalRoot, home], [realRoot, realHome]]) {
      const absolute = path.join(base, rel);
      if (within(bound, absolute) && sensitivePath(path.relative(bound, absolute))) return false;
    }
    return path.join(realRoot, rel) !== token;
  };
}

// The same for a remote root, given the device's resolved root and home.
function remoteFilter(root, home) {
  return (rel) => {
    if (rel.split("/").some((part) => ALWAYS_SKIP.has(part))) return false;
    const absolute = path.posix.join(root, rel);
    return !(within(home, absolute, "/") && sensitivePath(path.posix.relative(home, absolute)));
  };
}

// Resolves a local folder through the editor's own guards.
function localRoot(root) {
  const lexical = safePath(root);
  let real = null;
  try { real = realSafePath(root); }
  catch (error) { throw error.code === "ENOENT" ? fail(404, "Folder not found") : error; }
  if (!lexical || !real) throw fail(403, refusalReason(root));
  let stat;
  try { stat = fs.statSync(real); } catch { throw fail(404, "Folder not found"); }
  if (!stat.isDirectory()) throw fail(400, "Not a folder");
  return { lexical, real };
}

// ---- Listing ----

// Breadth-first walk of regular files (symlinks are never followed), bounded
// in folders, depth and time.
async function walkFiles(real, { deadline, signal, onFile }) {
  const queue = [{ dir: "", depth: 0 }];
  for (let index = 0; index < queue.length; index++) {
    if (signal?.aborted) return "aborted";
    if (Date.now() > deadline) return "timeout";
    if (index >= CODE_SEARCH_LIMITS.walkDirs) return "limit";
    const { dir, depth } = queue[index];
    let entries;
    try { entries = await fs.promises.readdir(path.join(real, dir), { withFileTypes: true }); }
    catch { continue; }
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (!WALK_SKIP.has(entry.name) && depth < CODE_SEARCH_LIMITS.walkDepth) queue.push({ dir: rel, depth: depth + 1 });
      } else if (entry.isFile() && onFile(rel) === false) return "stopped";
    }
  }
  return "done";
}

// Collects up to `limit` allowed, de-duplicated relative paths.
function fileCollector(allow, limit = CODE_SEARCH_LIMITS.files) {
  const files = new Set();
  let full = false;
  return {
    files,
    get full() { return full; },
    add(raw) {
      const rel = cleanRelative(raw);
      if (rel && allow(rel)) files.add(rel);
      if (files.size >= limit) { full = true; return false; }
      return true;
    },
  };
}

// Lists a local folder's files: git's view in a repository (tracked plus
// untracked, minus ignored), else ripgrep's (which reads ignore files too),
// else a plain walk. An empty git answer (a folder git ignores) falls through.
async function listLocalFiles(lexical, real, { signal, deadline, rg = "rg", useRg = true }) {
  const allow = localFilter(lexical, real);
  const env = { ...deviceEnv(""), ...GIT_ENV };
  const attempts = [{ tool: "git", command: "git", args: GIT_LIST }];
  if (useRg) attempts.push({ tool: "rg", command: rg, args: RG_LIST });
  for (const { tool, command, args } of attempts) {
    const collector = fileCollector(allow);
    const run = await runRecords(command, args, { cwd: real, env, separator: 0, timeoutMs: deadline - Date.now(), signal, onRecord: (record) => collector.add(record.toString("utf8")) });
    if (run.outcome === "aborted") throw fail(499, "Cancelled");
    if (collector.files.size && run.outcome !== "missing") {
      return { tool, files: [...collector.files], truncated: collector.full || run.outcome === "timeout" || run.outcome === "limit" };
    }
    if (run.outcome === "timeout") return { tool, files: [], truncated: true };
  }
  const collector = fileCollector(allow);
  const outcome = await walkFiles(real, { deadline, signal, onFile: (rel) => collector.add(rel) });
  if (outcome === "aborted") throw fail(499, "Cancelled");
  return { tool: "walk", files: [...collector.files], truncated: collector.full || outcome === "timeout" || outcome === "limit" };
}

export async function listFilesLocal(root, { signal, rg } = {}) {
  const { lexical, real } = localRoot(root);
  const result = await listLocalFiles(lexical, real, { signal, rg, deadline: Date.now() + CODE_SEARCH_LIMITS.localMs });
  return { root: lexical, ...result, files: result.files.sort() };
}

const SSH_ARGS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new"];
const quoteAll = (args) => args.map(shQuote).join(" ");
const PRUNE = `\\( ${[...WALK_SKIP].map((name) => `-name ${shQuote(name)}`).join(" -o ")} \\) -prune`;

// One fixed script per request: the guard sets "$p" to the folder (inside the
// remote home, not a credential store), then the folder and home, the tool
// used and its NUL-separated paths follow.
export function remoteListScript(root) {
  return remoteGuard(root) +
    `[ -d "$p" ] || exit 4; cd "$p" || exit 4; export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0; printf '%s\\0%s\\0' "$p" "$h"; ` +
    `if git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf 'git\\0'; exec git ${quoteAll(GIT_LIST)}; ` +
    `elif command -v rg >/dev/null 2>&1; then printf 'rg\\0'; exec rg ${quoteAll(RG_LIST)}; ` +
    `else printf 'walk\\0'; exec find . ${PRUNE} -o -type f -print0; fi`;
}

// The same for a search: rg, else git grep in a repository, else grep -r.
// A regular expression git cannot take as Perl syntax (exit above 1) is
// retried as POSIX extended syntax.
export function remoteSearchScript(root, request) {
  const gitGrep = request.regex
    ? `git ${quoteAll(gitGrepArgs(request, "-P"))}; c=$?; [ "$c" -le 1 ] && exit "$c"; exec git ${quoteAll(gitGrepArgs(request, "-E"))}`
    : `exec git ${quoteAll(gitGrepArgs(request))}`;
  return remoteGuard(root) +
    `[ -d "$p" ] || exit 4; cd "$p" || exit 4; export GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0; printf '%s\\n%s\\n' "$p" "$h"; ` +
    `if command -v rg >/dev/null 2>&1; then printf 'rg\\n'; exec rg ${quoteAll(rgSearchArgs(request))}; ` +
    `elif git rev-parse --is-inside-work-tree >/dev/null 2>&1; then printf 'git\\n'; ${gitGrep}; ` +
    `else printf 'grep\\n'; exec grep ${quoteAll(grepArgs(request))}; fi`;
}

// Turns a remote run's exit into the error the editor shows.
function remoteFailure(run, headers) {
  if (headers[0]?.startsWith("PZZA_DENIED") || run.code === 3) return fail(403, "outside home");
  if (run.code === 4) return fail(404, "Folder not found");
  if (run.outcome === "aborted") return fail(499, "Cancelled");
  if (run.outcome === "timeout") return fail(504, "The device took too long to answer");
  return fail(502, "Could not reach the device");
}

export async function listFilesRemote(host, root, { signal, spawnImpl } = {}) {
  const headers = [];
  let collector = null;
  const run = await runRecords("ssh", [...SSH_ARGS, host, remoteListScript(root)], {
    env: deviceEnv(host), separator: 0, timeoutMs: CODE_SEARCH_LIMITS.remoteMs, signal, spawnImpl,
    onRecord: (record) => {
      const text = record.toString("utf8");
      if (headers.length < 3) {
        headers.push(text);
        if (headers.length === 3) collector = fileCollector(remoteFilter(headers[0], headers[1]));
        return !text.startsWith("PZZA_DENIED");
      }
      return collector.add(text);
    },
  });
  if (!collector || run.outcome === "aborted") throw remoteFailure(run, headers);
  return {
    root: headers[0], tool: headers[2], files: [...collector.files].sort(),
    truncated: collector.full || run.outcome === "timeout" || run.outcome === "limit",
  };
}

// ---- Search ----

export function validateSearchRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw fail(400, "Invalid request");
  const host = body.host ?? "";
  if (typeof host !== "string" || (host && !SSH_TOKEN.test(host))) throw fail(400, "Invalid device host");
  const root = validateRoot(body.root, host);
  const { query } = body;
  if (typeof query !== "string" || !query || query.length > CODE_SEARCH_LIMITS.query || /[\u0000\n\r]/.test(query)) {
    throw fail(400, `Search for 1 to ${CODE_SEARCH_LIMITS.query} characters on one line`);
  }
  const caseSensitive = body.caseSensitive === true;
  const regex = body.regex === true;
  try { compileQuery(query, { caseSensitive, regex }); }
  catch { throw fail(400, "Invalid regular expression"); }
  return { host, root, query, caseSensitive, regex };
}

function validateRoot(root, host) {
  if (typeof root !== "string" || !root || root.length > CODE_SEARCH_LIMITS.rootLength || /[\u0000-\u001f\u007f]/.test(root)) throw fail(400, "Invalid folder");
  if (host && !remotePath(root)) throw fail(400, "Invalid folder");
  return root;
}

// The query as a JavaScript expression, used to mark matches in lines a tool
// reports without positions and to search files directly.
export function compileQuery(query, { caseSensitive, regex }) {
  const source = regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(source, caseSensitive ? "g" : "gi");
}

export function matchRanges(matcher, text) {
  const ranges = [];
  matcher.lastIndex = 0;
  for (let match; ranges.length < CODE_SEARCH_LIMITS.rangesPerLine && (match = matcher.exec(text));) {
    if (match[0].length === 0) { matcher.lastIndex++; continue; }
    ranges.push([match.index, match.index + match[0].length]);
  }
  return ranges;
}

// A matched line as shown: no line ending or leading indentation, and a long
// line cut to a window around its first match, with the ranges moved along.
export function clipLine(raw, ranges) {
  let text = raw.replace(/\r?\n$/, "");
  let shift = 0;
  const first = ranges[0]?.[0] ?? text.length;
  const indent = Math.min(text.length - text.trimStart().length, first);
  text = text.slice(indent);
  shift -= indent;
  const limit = CODE_SEARCH_LIMITS.lineChars;
  if (text.length > limit) {
    const start = Math.max(0, first - indent - 40);
    if (start > 0) {
      text = `…${text.slice(start, start + limit - 1)}`;
      shift += 1 - start;
    } else text = `${text.slice(0, limit - 1)}…`;
  }
  const clipped = [];
  for (const [from, to] of ranges) {
    const a = Math.max(0, from + shift);
    const b = Math.min(text.length, to + shift);
    if (b > a) clipped.push([a, b]);
  }
  return { text, ranges: clipped };
}

// UTF-16 offset of a UTF-8 byte offset in a line.
const charOffset = (bytes, offset) => bytes.subarray(0, Math.max(0, Math.min(offset, bytes.length))).toString("utf8").length;

// One `rg --json` record: a match line with its byte-offset submatches.
export function parseRgRecord(record) {
  let event;
  try { event = JSON.parse(record.toString("utf8")); } catch { return null; }
  if (!event || event.type !== "match" || !event.data) return null;
  const { path: file, lines, line_number: line, submatches } = event.data;
  if (typeof file?.text !== "string" || typeof lines?.text !== "string" || !Number.isInteger(line)) return null;
  const bytes = Buffer.from(lines.text, "utf8");
  const ranges = (Array.isArray(submatches) ? submatches : [])
    .filter((match) => Number.isInteger(match?.start) && Number.isInteger(match?.end) && match.end > match.start)
    .slice(0, CODE_SEARCH_LIMITS.rangesPerLine)
    .map((match) => [charOffset(bytes, match.start), charOffset(bytes, match.end)]);
  return { path: file.text, line, text: lines.text, ranges };
}

// One `git grep -n -z` record: path NUL line NUL text.
export function parseGitGrepRecord(record) {
  const first = record.indexOf(0);
  const second = first < 0 ? -1 : record.indexOf(0, first + 1);
  if (second < 0) return null;
  const line = Number(record.subarray(first + 1, second).toString("latin1"));
  if (!Number.isInteger(line) || line < 1) return null;
  return { path: record.subarray(0, first).toString("utf8"), line, text: record.subarray(second + 1).toString("utf8") };
}

// One `grep -rn --null` record: path NUL line ":" text.
export function parseGrepRecord(record) {
  const first = record.indexOf(0);
  if (first < 0) return null;
  const rest = record.subarray(first + 1).toString("utf8");
  const colon = rest.indexOf(":");
  const line = Number(rest.slice(0, colon));
  if (colon < 1 || !Number.isInteger(line) || line < 1) return null;
  return { path: record.subarray(0, first).toString("utf8"), line, text: rest.slice(colon + 1) };
}

// Gathers matches grouped by file, within the per-file and total caps.
function matchCollector(allow, matcher) {
  const files = new Map();
  let count = 0;
  let truncated = false;
  return {
    get truncated() { return truncated; },
    get count() { return count; },
    add(hit) {
      if (!hit) return true;
      const rel = cleanRelative(hit.path);
      if (!rel || !allow(rel)) return true;
      let file = files.get(rel);
      if (!file) { file = { path: rel, matches: [] }; files.set(rel, file); }
      if (file.matches.length >= CODE_SEARCH_LIMITS.matchesPerFile) { file.more = true; return true; }
      file.matches.push({ line: hit.line, ...clipLine(hit.text, hit.ranges ?? matchRanges(matcher, hit.text.replace(/\r?\n$/, ""))) });
      count++;
      if (count >= CODE_SEARCH_LIMITS.matches) { truncated = true; return false; }
      return true;
    },
    files: () => [...files.values()],
  };
}

const PARSERS = { rg: parseRgRecord, git: parseGitGrepRecord, grep: parseGrepRecord };

// Reads candidate files directly, for a device with neither rg nor git grep
// (or a folder outside any repository). Bounded in file size, total bytes
// read and time; binary files are skipped.
async function scanFiles(real, files, matcher, collector, { deadline, signal }) {
  let total = 0;
  for (const rel of files) {
    if (signal?.aborted) return "aborted";
    if (Date.now() > deadline) return "timeout";
    if (total > CODE_SEARCH_LIMITS.scanTotalBytes) return "limit";
    const absolute = path.join(real, rel);
    let bytes;
    try {
      const stat = await fs.promises.lstat(absolute);
      if (!stat.isFile() || stat.size > CODE_SEARCH_LIMITS.scanFileBytes) continue;
      bytes = await fs.promises.readFile(absolute);
    } catch { continue; }
    total += bytes.length;
    if (bytes.subarray(0, 8000).includes(0)) continue;
    const lines = bytes.toString("utf8").split("\n");
    for (let index = 0; index < lines.length; index++) {
      matcher.lastIndex = 0;
      if (!matcher.test(lines[index])) continue;
      if (collector.add({ path: rel, line: index + 1, text: lines[index] }) === false) return "stopped";
    }
  }
  return "done";
}

export async function searchLocal(request, { signal, rg = "rg" } = {}) {
  const { lexical, real } = localRoot(request.root);
  const deadline = Date.now() + CODE_SEARCH_LIMITS.localMs;
  const allow = localFilter(lexical, real);
  const matcher = compileQuery(request.query, request);
  const env = { ...deviceEnv(""), ...GIT_ENV };
  const attempts = [
    { tool: "rg", command: rg, args: rgSearchArgs(request) },
    ...(request.regex
      ? [{ tool: "git", command: "git", args: gitGrepArgs(request, "-P") }, { tool: "git", command: "git", args: gitGrepArgs(request, "-E") }]
      : [{ tool: "git", command: "git", args: gitGrepArgs(request) }]),
  ];
  for (const { tool, command, args } of attempts) {
    const collector = matchCollector(allow, matcher);
    const run = await runRecords(command, args, {
      cwd: real, env, timeoutMs: deadline - Date.now(), signal, okCodes: [0, 1],
      onRecord: (record) => collector.add(PARSERS[tool](record)),
    });
    if (run.outcome === "aborted") throw fail(499, "Cancelled");
    if (run.outcome === "missing" || (run.outcome === "failed" && collector.count === 0)) continue;
    return searchResult(lexical, tool, collector, run.outcome);
  }
  // Neither tool could run: read the listed files directly.
  const listing = await listLocalFiles(lexical, real, { signal, deadline, useRg: false });
  const collector = matchCollector(allow, matcher);
  const outcome = await scanFiles(real, listing.files, matcher, collector, { deadline, signal });
  if (outcome === "aborted") throw fail(499, "Cancelled");
  const result = searchResult(lexical, "scan", collector, outcome);
  if (listing.truncated) result.truncated = true;
  return result;
}

function searchResult(root, tool, collector, outcome) {
  const files = collector.files().sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return {
    root, tool, files, matchCount: collector.count,
    truncated: collector.truncated || files.some((file) => file.more) || outcome === "timeout" || outcome === "limit",
    ...(outcome === "timeout" ? { timedOut: true } : {}),
  };
}

export async function searchRemote(host, request, { signal, spawnImpl } = {}) {
  const headers = [];
  let collector = null;
  const matcher = compileQuery(request.query, request);
  const run = await runRecords("ssh", [...SSH_ARGS, host, remoteSearchScript(request.root, request)], {
    env: deviceEnv(host), timeoutMs: CODE_SEARCH_LIMITS.remoteMs, signal, spawnImpl, okCodes: [0, 1],
    onRecord: (record) => {
      if (headers.length < 3) {
        const text = record.toString("utf8");
        headers.push(text);
        if (headers.length === 3) collector = PARSERS[text] ? matchCollector(remoteFilter(headers[0], headers[1]), matcher) : null;
        return !text.startsWith("PZZA_DENIED") && (headers.length < 3 || collector !== null);
      }
      return collector.add(PARSERS[headers[2]](record));
    },
  });
  if (!collector || run.outcome === "aborted") throw remoteFailure(run, headers);
  return searchResult(headers[0], headers[2], collector, run.outcome);
}

// ---- Routes ----

// Aborts the work when the editor drops the request (a newer query, a
// closed panel), so a stale search never keeps running.
function requestSignal(res) {
  const controller = new AbortController();
  res.on("close", () => { if (!res.writableFinished) controller.abort(); });
  return controller.signal;
}

function reply(json, res, error) {
  if (res.destroyed || res.writableEnded) return;
  const status = Number.isInteger(error?.status) ? error.status : 500;
  json(res, status, { error: status === 500 ? "Search failed on this device" : error.message });
}

// GET /code/files?root=&host=  and  POST /code/search {root, host, query, caseSensitive, regex}.
export async function codeSearchRouter(req, res, url, json) {
  if (url.pathname === "/code/files") {
    if (req.method !== "GET") return json(res, 405, { error: "GET required" }), true;
    try {
      const host = url.searchParams.get("host") || "";
      if (host && !SSH_TOKEN.test(host)) throw fail(400, "Invalid device host");
      const root = validateRoot(url.searchParams.get("root"), host);
      const signal = requestSignal(res);
      const result = host ? await listFilesRemote(host, root, { signal }) : await listFilesLocal(root, { signal });
      if (!res.destroyed) json(res, 200, result);
    } catch (error) { reply(json, res, error); }
    return true;
  }
  if (url.pathname === "/code/search") {
    if (req.method !== "POST") return json(res, 405, { error: "POST required" }), true;
    try {
      const request = validateSearchRequest(await readBody(req));
      const signal = requestSignal(res);
      const result = request.host ? await searchRemote(request.host, request, { signal }) : await searchLocal(request, { signal });
      if (!res.destroyed) json(res, 200, result);
    } catch (error) { reply(json, res, error); }
    return true;
  }
  return false;
}

