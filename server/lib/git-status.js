// Batched, read-only Git status for the folders tiles are working in: the
// checked-out branch, whether the work tree has changes, and ahead/behind
// counts against the upstream. Local folders run git directly (no shell);
// another device gets one ssh call running a fixed script over quoted paths.
import { execFile, spawn } from "node:child_process";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { SSH_TOKEN, deviceEnv, shQuote } from "./shell.js";

export const GIT_STATUS_LIMITS = { paths: 64, pathLength: 4096, localMs: 5000, remoteMs: 15000, buffer: 1024 * 1024 };
const STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--untracked-files=normal"];
const RECORD = "\u001e";

export function validateGitStatusRequest(body) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a JSON object with host and paths.");
  const host = body.host ?? "";
  if (typeof host !== "string" || (host && !SSH_TOKEN.test(host))) throw new Error("Invalid device host.");
  const { paths } = body;
  if (!Array.isArray(paths) || !paths.length || paths.length > GIT_STATUS_LIMITS.paths) throw new Error(`Send between 1 and ${GIT_STATUS_LIMITS.paths} folder paths.`);
  for (const path of paths) {
    if (typeof path !== "string" || !path.startsWith("/") || path.length > GIT_STATUS_LIMITS.pathLength || /[\u0000-\u001f\u007f]/.test(path)) {
      throw new Error("Folder paths must be absolute, at most 4096 characters, without control characters.");
    }
  }
  return { host, paths: [...new Set(paths)] };
}

// Reads `git status --porcelain=v2 --branch` headers. Any entry line after the
// headers means the work tree is dirty; null when the folder is not a repo.
export function parseStatusHeaders(lines) {
  let oid = null, head = null, ahead = null, behind = null, dirty = false;
  for (const line of lines) {
    if (line.startsWith("# branch.oid ")) oid = line.slice(13).trim();
    else if (line.startsWith("# branch.head ")) head = line.slice(14).trim();
    else if (line.startsWith("# branch.ab ")) {
      const match = /^\+(\d+) -(\d+)$/.exec(line.slice(12).trim());
      if (match) { ahead = Number(match[1]); behind = Number(match[2]); }
    } else if (line && !line.startsWith("#")) dirty = true;
  }
  if (head === null) return null;
  const detached = head === "(detached)";
  const branch = detached ? (oid && oid !== "(initial)" ? oid.slice(0, 7) : "HEAD") : head;
  return { branch, detached, dirty, ahead, behind };
}

// One local folder: stream status and stop at the first entry line, so a huge
// work tree never buffers its whole file list.
export function localGitStatus(path, { spawnImpl = spawn, timeoutMs = GIT_STATUS_LIMITS.localMs } = {}) {
  return new Promise((resolve) => {
    let child;
    try { child = spawnImpl("git", ["-C", path, ...STATUS_ARGS], { env: { ...deviceEnv(""), GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" }, stdio: ["ignore", "pipe", "ignore"] }); }
    catch { resolve(null); return; }
    const lines = [];
    let rest = "", dirty = false, settled = false, size = 0;
    const finish = (value) => { if (settled) return; settled = true; clearTimeout(timer); resolve(value); };
    const timer = setTimeout(() => { child.kill("SIGKILL"); finish(null); }, timeoutMs);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      rest += chunk;
      const parts = rest.split("\n");
      rest = parts.pop() ?? "";
      for (const line of parts) {
        if (line.startsWith("#")) lines.push(line);
        else if (line) { dirty = true; break; }
      }
      if (dirty || size > GIT_STATUS_LIMITS.buffer) { child.kill("SIGTERM"); finish(parseStatusHeaders(dirty ? [...lines, "dirty"] : lines)); }
    });
    child.on("error", () => finish(null));
    child.on("close", (code) => finish(code === 0 ? parseStatusHeaders(rest ? [...lines, rest] : lines) : null));
  });
}

// A fixed POSIX script: every path is single-quoted, each record starts with
// a record separator and the path, followed by the status headers and at most
// one entry line (awk exits on the first one).
export function remoteGitStatusScript(paths) {
  return `for d in ${paths.map(shQuote).join(" ")}; do printf '\\036%s\\n' "$d"; ` +
    `LC_ALL=C GIT_TERMINAL_PROMPT=0 git -C "$d" ${STATUS_ARGS.join(" ")} 2>/dev/null | awk '/^#/ { print; next } { print "dirty"; exit }'; done`;
}

export function parseRemoteGitStatus(output, paths) {
  const results = Object.fromEntries(paths.map((path) => [path, null]));
  for (const record of output.split(RECORD).slice(1)) {
    const [path, ...lines] = record.split("\n");
    if (Object.hasOwn(results, path)) results[path] = parseStatusHeaders(lines);
  }
  return results;
}

export function remoteGitStatusCommand(host, paths) {
  const target = host || DEVBOX;
  return ["ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", target, `sh -c ${shQuote(remoteGitStatusScript(paths))}`]];
}

export async function gitStatus({ host, paths }, { execImpl = execFile, spawnImpl = spawn } = {}) {
  if (!host && !IS_CLIENT) {
    // A handful at a time keeps a 64-folder poll from forking 64 gits at once.
    const results = {};
    for (let index = 0; index < paths.length; index += 8) {
      const batch = paths.slice(index, index + 8);
      const values = await Promise.all(batch.map((path) => localGitStatus(path, { spawnImpl })));
      batch.forEach((path, offset) => { results[path] = values[offset]; });
    }
    return results;
  }
  const [cmd, args] = remoteGitStatusCommand(host, paths);
  const output = await new Promise((resolve, reject) => {
    execImpl(cmd, args, { env: deviceEnv(host || DEVBOX), timeout: GIT_STATUS_LIMITS.remoteMs, maxBuffer: GIT_STATUS_LIMITS.buffer }, (error, stdout) => {
      if (error) reject(new Error("Could not read Git status on this device."));
      else resolve(String(stdout));
    });
  });
  return parseRemoteGitStatus(output, paths);
}

export async function gitStatusRouter(req, res, url, json) {
  if (url.pathname !== "/git/status") return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST for Git status" }); return true; }
  const { readBody } = await import("./http.js");
  let request;
  try { request = validateGitStatusRequest(await readBody(req)); }
  catch (error) { json(res, 400, { error: error.message }); return true; }
  try { json(res, 200, { results: await gitStatus(request) }); }
  catch (error) { json(res, 503, { error: error.message }); }
  return true;
}
