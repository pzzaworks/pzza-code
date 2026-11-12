// File access for the code view: directory listing, text read, raw byte stream
// and write, plus pasted-image save. Each has a local branch (this device) and
// an ssh-proxied branch to another device, both bounded to the user's home tree
// by the guards in paths.js.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { SSH_TOKEN, shOn, shQuote } from "./shell.js";
import { cors, json, readBody } from "./http.js";
import { denied, mimeType, realSafePath, remoteGuard, remotePath, safePath } from "./paths.js";

import { FILE_MUTATION_SCRIPT } from "./file-mutations.js";
import { terminalDropRouter } from "./terminal-drop.js";

const FS_ROUTES = new Set(["/fs/move", "/fs/delete", "/fs/list", "/file/read", "/file/raw", "/file/write", "/paste-image"]);

const IMAGE_LIMIT = 20 * 1024 * 1024;

function readImageBody(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let chunks = [];
    let settled = false;
    const fail = (status, message) => {
      if (settled) return;
      settled = true;
      chunks = [];
      reject(Object.assign(new Error(message), { status }));
    };
    req.on("data", (chunk) => {
      if (settled) return;
      size += chunk.length;
      if (size > IMAGE_LIMIT) return fail(413, "Image exceeds the 20 MiB limit");
      chunks.push(chunk);
    });
    req.on("end", () => {
      if (settled) return;
      settled = true;
      resolve(Buffer.concat(chunks, size));
    });
    req.on("aborted", () => fail(400, "Image upload was interrupted"));
    req.on("error", () => fail(400, "Could not read image upload"));
    if (Number(req.headers["content-length"]) > IMAGE_LIMIT) fail(413, "Image exceeds the 20 MiB limit");
  });
}

function imageExtension(bytes) {
  if (bytes.length >= 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) && bytes.toString("ascii", 12, 16) === "IHDR") return "png";
  if (bytes.length >= 4 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return "jpg";
  if (bytes.length >= 10 && ["GIF87a", "GIF89a"].includes(bytes.toString("ascii", 0, 6))) return "gif";
  if (bytes.length >= 16 && bytes.toString("ascii", 0, 4) === "RIFF" && bytes.toString("ascii", 8, 12) === "WEBP" && ["VP8 ", "VP8L", "VP8X"].includes(bytes.toString("ascii", 12, 16))) return "webp";
  if (bytes.length >= 26 && bytes.toString("ascii", 0, 2) === "BM") return "bmp";
  return null;
}

// The code editor round-trips text as UTF-8. Anything else (a Latin-1 file, a
// database, an archive) would come back with every invalid byte replaced by
// U+FFFD, so it is reported as binary and never written over.
const TEXT_LIMIT = 2 * 1024 * 1024;
export function decodeText(bytes) {
  if (bytes.includes(0)) return null;
  // ignoreBOM keeps a leading byte-order mark in the text, so saving keeps it.
  try { return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes); }
  catch { return null; }
}

// Whether a file's whole content is UTF-8 text, read in chunks so a large
// file is checked without loading it at once.
function isTextFile(descriptor) {
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const chunk = Buffer.alloc(1024 * 1024);
  try {
    for (;;) {
      const read = fs.readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) { decoder.decode(); return true; }
      const bytes = chunk.subarray(0, read);
      if (bytes.includes(0)) return false;
      decoder.decode(bytes, { stream: true });
    }
  } catch (error) {
    if (error instanceof TypeError) return false;
    throw error;
  }
}

const fileError = (status, message) => Object.assign(new Error(message), { status });

// A file's version as the editor sees it: the hex SHA-256 of its raw bytes.
const SHA256 = /^[0-9a-f]{64}$/;
export const sha256Hex = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");

// The editor saved over a version it never saw: the file on disk is another
// version (`current`), or is gone (null). Nothing was written.
function changedError(current) {
  return Object.assign(fileError(409, current ? "The file changed on disk after it was opened." : "The file was deleted or moved on disk after it was opened."), {
    changed: true,
    ...(current ? { sha256: current } : {}),
  });
}
// The 409 body the editor recognises as a changed file.
const changedReply = (error) => ({ error: error.message, code: "changed", ...(error.sha256 ? { sha256: error.sha256 } : {}) });

const NOT_FILE = "not a file";

// Open an already resolved path only when it is a regular file. A FIFO,
// socket or device is refused from lstat before any open, because opening a
// FIFO with no writer blocks the agent's only thread. O_NONBLOCK covers one
// swapped in after the lstat (it changes nothing for a regular file), and
// O_NOFOLLOW a link swapped in. The caller closes the descriptor.
function openRegularFile(target, flags = fs.constants.O_RDONLY) {
  if (!fs.lstatSync(target).isFile()) throw fileError(400, NOT_FILE);
  const descriptor = fs.openSync(target, flags | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK);
  try {
    const stat = fs.fstatSync(descriptor);
    if (!stat.isFile()) throw fileError(400, NOT_FILE);
    return { descriptor, stat };
  } catch (error) {
    fs.closeSync(descriptor);
    throw error;
  }
}

// SHA-256 of everything an open file holds, read from its start in chunks.
function descriptorVersion(descriptor) {
  const hash = crypto.createHash("sha256");
  const chunk = Buffer.alloc(1024 * 1024);
  for (let position = 0, read; (read = fs.readSync(descriptor, chunk, 0, chunk.length, position)) > 0; position += read) hash.update(chunk.subarray(0, read));
  return hash.digest("hex");
}

// The version of the file at `target` now; null when there is none.
function currentVersion(target) {
  let opened;
  try { opened = openRegularFile(target); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  try { return descriptorVersion(opened.descriptor); } finally { fs.closeSync(opened.descriptor); }
}

// Errors from creating the temporary file that mean the folder will not take
// a new file, while the target itself may still be writable.
const FOLDER_REFUSED = new Set(["EACCES", "EPERM"]);
// Errors from the rename that mean the target cannot be replaced as a
// directory entry (a single file bind-mounted over it, another device).
const RENAME_REFUSED = new Set(["EBUSY", "EXDEV", "EPERM"]);

// In-place fallback for writeTextFileAtomic: the target's own inode is
// overwritten, so its hard links, a bind mount over it, its owner, group,
// ACLs and extended attributes all stay as they are. The cost is atomicity: a
// crash or a full disk part-way through can leave the file partly written.
// The version check reads through the same descriptor that is then written,
// so the bytes checked are exactly the bytes replaced.
function writeInPlace(target, data, expectedSha256) {
  let descriptor;
  try { ({ descriptor } = openRegularFile(target, fs.constants.O_RDWR)); }
  catch (error) { throw error.code === "ENOENT" && expectedSha256 !== undefined ? changedError(null) : error; }
  try {
    if (expectedSha256 !== undefined) {
      const current = descriptorVersion(descriptor);
      if (current !== expectedSha256) throw changedError(current);
    }
    for (let offset = 0; offset < data.length;) offset += fs.writeSync(descriptor, data, offset, data.length - offset, offset);
    fs.ftruncateSync(descriptor, data.length);
    fs.fsyncSync(descriptor);
  } finally { fs.closeSync(descriptor); }
}

// Save local text. `target` must already be resolved by realSafePath. With
// `expectedSha256` (the version the editor read), the file must still be
// exactly that version right before it is replaced, or nothing is written
// (changedError). A file the user cannot write is refused, as a plain write
// would refuse it. Returns the version saved.
//
// The normal path is atomic: the content goes to a private temporary file in
// the same folder, is flushed to disk, takes the original's mode, owner and
// group, then replaces the target with one rename, so a full disk, a crash or
// a killed agent leaves the original intact. Replacing the directory entry
// would break a file with hard links, one bind-mounted into a container, a
// file whose owner or group this account cannot set on a new file, and a
// file in a folder that refuses new files; those are written in place
// instead (writeInPlace), which keeps the inode and every link to it but is
// not atomic. A plain single-link file still loses extended attributes and
// ACLs on the atomic path, as they cannot be copied from here.
export function writeTextFileAtomic(target, content, expectedSha256) {
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256))) throw fileError(400, "invalid file version");
  const data = Buffer.from(content, "utf8");
  let existing = null;
  try { existing = fs.lstatSync(target); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  let inPlace = false;
  if (existing) {
    if (!existing.isFile()) throw fileError(400, NOT_FILE);
    try { fs.accessSync(target, fs.constants.W_OK); }
    catch (error) {
      if (error.code === "EACCES" || error.code === "EPERM" || error.code === "EROFS") throw fileError(403, "This file is read-only, so the editor cannot save it.");
      throw error;
    }
    const { descriptor } = openRegularFile(target);
    try {
      if (!isTextFile(descriptor)) throw fileError(409, "This file is not UTF-8 text, so the editor cannot save it without corrupting it.");
    } finally { fs.closeSync(descriptor); }
    // A second link, or a file mounted over its folder entry, must keep its inode.
    inPlace = existing.nlink > 1 || existing.dev !== fs.statSync(path.dirname(target)).dev;
  }
  if (inPlace) {
    writeInPlace(target, data, expectedSha256);
    return sha256Hex(data);
  }
  // A fixed-length name, so a target name near NAME_MAX still gets one.
  const temporary = path.join(path.dirname(target), `.pzza-${crypto.randomBytes(4).toString("hex")}.tmp`);
  let descriptor;
  try {
    descriptor = fs.openSync(temporary, fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_NOFOLLOW, existing ? 0o600 : 0o666);
  } catch (error) {
    if (!existing || !FOLDER_REFUSED.has(error.code)) throw error;
    writeInPlace(target, data, expectedSha256);
    return sha256Hex(data);
  }
  let renamed = false;
  let fallBack = false;
  try {
    for (let offset = 0; offset < data.length;) offset += fs.writeSync(descriptor, data, offset);
    if (existing) {
      if (existing.uid !== process.getuid?.() || existing.gid !== process.getgid?.()) {
        // Only root, or the owner for a group it belongs to, can keep a foreign
        // owner or group; anyone else writes in place rather than take the file over.
        try { fs.fchownSync(descriptor, existing.uid, existing.gid); } catch { fallBack = true; }
      }
      if (!fallBack) fs.fchmodSync(descriptor, existing.mode & 0o7777);
    }
    if (!fallBack) {
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      // Checked as late as possible, so a change made while the new content
      // was written is still seen.
      if (expectedSha256 !== undefined) {
        const current = currentVersion(target);
        if (current !== expectedSha256) throw changedError(current);
      }
      try {
        fs.renameSync(temporary, target);
        renamed = true;
      } catch (error) {
        if (!existing || !RENAME_REFUSED.has(error.code)) throw error;
        fallBack = true;
      }
    }
  } finally {
    // Anything but a completed rename discards the temporary file.
    if (!renamed) {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* Already closed. */ }
      }
      try { fs.unlinkSync(temporary); } catch { /* Preserve the original failure. */ }
    }
  }
  if (fallBack) {
    writeInPlace(target, data, expectedSha256);
    return sha256Hex(data);
  }
  // Persist the rename itself; a folder that cannot be opened is still saved.
  try {
    const folder = fs.openSync(path.dirname(target), fs.constants.O_RDONLY);
    try { fs.fsyncSync(folder); } finally { fs.closeSync(folder); }
  } catch { /* Best effort: some filesystems refuse fsync on a directory. */ }
  return sha256Hex(data);
}

// Remote twin of writeTextFileAtomic, run after remoteGuard has set "$p" to
// the resolved target. The content streams into a temporary file and its
// byte count is verified before the target is touched, so a dropped
// connection never truncates the file.
//
// Like the local save it is atomic where it can be: the temporary file sits
// beside the target, takes its owner, group and mode, and is renamed over it.
// A file with hard links, one whose owner or group this account cannot set,
// a folder that refuses new files, or a target that cannot be replaced by a
// rename (a bind mount) is written in place from a temporary file elsewhere
// instead: the inode and every link to it are kept, but a failure part-way
// can leave the file partly written (exit 9).
//
// With `expectedSha256` the device needs no hash tool: right before the
// replace it snapshots the target and sends "PZZA_VERSION <size>\n" and those
// bytes on stdout, the agent hashes them, and answers "same" or "changed" on
// stdin after the content. Only "same" lets the save go ahead. The content is
// then read with `head -c` (it must not swallow the answer); the agent sends
// the answer only once the snapshot arrived, so nothing is read past it.
// Exit 4: not a regular file; 5: existing content is not UTF-8 text; 6: the
// file is another version or is gone; 8: the file is read-only.
export function remoteWriteScript(byteCount, expectedSha256) {
  if (!Number.isSafeInteger(byteCount) || byteCount < 0) throw new Error("invalid size");
  if (expectedSha256 !== undefined && (typeof expectedSha256 !== "string" || !SHA256.test(expectedSha256))) throw new Error("invalid file version");
  const versionCheck = expectedSha256 === undefined ? "" : (
    `[ -f "$p" ] || exit 6; ` +
    `s=$(mktemp) && cat -- "$p" > "$s" || exit 1; ` +
    `z=$(wc -c < "$s" | tr -d ' '); [ "$z" -le ${TEXT_LIMIT} ] || exit 6; ` +
    `printf 'PZZA_VERSION %s\\n' "$z"; cat -- "$s" || exit 1; ` +
    `read -r v || exit 6; [ "$v" = same ] || exit 6; `
  );
  return (
    `[ ! -e "$p" ] || [ -f "$p" ] || exit 4; ` +
    `n=; o=; ` +
    `if [ -f "$p" ]; then ` +
    `[ -w "$p" ] || exit 8; ` +
    `LC_ALL=C tr -d '\\000' < "$p" | cmp -s - "$p" || exit 5; ` +
    `if command -v iconv >/dev/null 2>&1; then iconv -f UTF-8 -t UTF-8 < "$p" >/dev/null 2>&1 || exit 5; fi; ` +
    `n=$(ls -ldn -- "$p" | awk '{print $2}'); o=$(ls -ldn -- "$p" | awk '{print $3":"$4}'); ` +
    `fi; ` +
    `t=; s=; a=; trap 'rm -f -- "$t" "$s"' 0; trap 'exit 1' HUP INT TERM PIPE; ` +
    // Atomic (a=1) for a new file or a single-link one whose folder takes a new file.
    `if [ ! -f "$p" ] || [ "$n" = 1 ]; then t=$(mktemp "$(dirname -- "$p")/.pzza-save.XXXXXX" 2>/dev/null) && a=1; fi; ` +
    `if [ -z "$a" ]; then [ -f "$p" ] || exit 1; t=$(mktemp) || exit 1; fi; ` +
    (expectedSha256 === undefined ? `cat > "$t" || exit 1; ` : `head -c ${byteCount} > "$t" || exit 1; `) +
    `[ "$(wc -c < "$t" | tr -d ' ')" = ${byteCount} ] || exit 1; ` +
    `if [ -n "$a" ] && [ -f "$p" ]; then ` +
    `[ "$(ls -ldn -- "$t" | awk '{print $3":"$4}')" = "$o" ] || chown "$o" "$t" 2>/dev/null || a=; ` +
    `fi; ` +
    `if [ -n "$a" ]; then ` +
    `if [ -f "$p" ]; then m=$(stat -c %a -- "$p" 2>/dev/null || stat -f %Lp -- "$p" 2>/dev/null) && chmod "$m" "$t" || exit 1; ` +
    `else u=$(umask); chmod "$(printf '%o' $(( 0666 & ~u )))" "$t" || exit 1; fi; ` +
    `sync "$t" 2>/dev/null || :; ` +
    `fi; ` +
    versionCheck +
    `if [ -n "$a" ] && mv -f -- "$t" "$p" 2>/dev/null; then t=; exit 0; fi; ` +
    `[ -f "$p" ] || exit 1; ` +
    `cat -- "$t" > "$p" || exit 9; exit 0`
  );
}

// Parses the version snapshot remoteWriteScript sends before replacing the
// file. Feed it stdout chunks; it returns the snapshot's SHA-256 once the
// whole snapshot arrived, null for a reply that is not one, and undefined
// while more bytes are due.
function versionReader() {
  const chunks = [];
  let length = 0;
  return (chunk) => {
    chunks.push(chunk);
    length += chunk.length;
    const bytes = Buffer.concat(chunks, length);
    const end = bytes.indexOf(10);
    if (end < 0) return length > 32 ? null : undefined;
    const header = /^PZZA_VERSION (\d+)$/.exec(bytes.subarray(0, end).toString("latin1"));
    if (!header || Number(header[1]) > TEXT_LIMIT) return null;
    const body = bytes.subarray(end + 1);
    if (body.length < Number(header[1])) return undefined;
    return body.length === Number(header[1]) ? sha256Hex(body) : null;
  };
}

// Route the file endpoints. Returns true if it owned (and answered) the request.
export async function filesRouter(req, res, url) {
  if (url.pathname === "/terminal-drop") return terminalDropRouter(req, res, url, json);
  if (!FS_ROUTES.has(url.pathname)) return false;

  if (url.pathname === "/fs/move" || url.pathname === "/fs/delete") {
    if (req.method !== "POST") return json(res, 405, { error: "POST required" }), true;
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "Invalid request" }), true;
    if (body.host !== undefined && (typeof body.host !== "string" || (body.host && !SSH_TOKEN.test(body.host)))) {
      return json(res, 400, { error: "Invalid device host" }), true;
    }
    const operation = url.pathname === "/fs/move" ? "move" : "delete";
    const host = body.host || "";
    const command = host ? "ssh" : "python3";
    const args = host
      ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", host, `python3 -c ${shQuote(FILE_MUTATION_SCRIPT)}`]
      : ["-c", FILE_MUTATION_SCRIPT];
    const child = execFile(command, args, { timeout: 30_000, maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        const missingRuntime = (command === "python3" && error.code === "ENOENT") || /python3.*(?:not found|No such file)/i.test(stderr);
        return json(res, missingRuntime ? 501 : 500, { error: missingRuntime
          ? "Python 3 is required on this device for safe file operations"
          : error.killed ? "File operation timed out; refresh the tree to check its state" : "File operation failed on this device" });
      }
      try {
        const result = JSON.parse(stdout);
        if (!Number.isInteger(result.status) || result.status < 200 || result.status > 599) throw new Error("Invalid status");
        return json(res, result.status, result.error ? { error: result.error } : result.result);
      } catch {
        return json(res, 500, { error: "Invalid response from file operation" });
      }
    });
    child.stdin.on("error", () => {});
    child.stdin.end(JSON.stringify({ operation, root: body.root, path: body.path, destination: body.destination }));
    return true;
  }

  const hostParam = url.searchParams.get("host") || "";
  const fsHost = SSH_TOKEN.test(hostParam) ? hostParam : "";

  if (url.pathname === "/fs/list" && fsHost) {
    const raw = url.searchParams.get("path") || "";
    const p = raw ? remotePath(raw) : null;
    if (raw && !p) return json(res, 400, { error: "invalid path" }), true;
    const cmd = (p ? remoteGuard(p, { listOnly: true }) : `p=$(cd ~ && pwd -P); `) + `cd "$p" && pwd -P && ls -1Ap 2>/dev/null`;
    shOn(fsHost, cmd, (err, out) => {
      if (denied(out)) return json(res, 403, { error: "outside home" });
      if (err) return json(res, 404, { error: String(err.message || err) });
      const [cwd, ...names] = String(out || "").split("\n");
      const entries = names
        .filter(Boolean)
        .filter((n) => n !== "./" && n !== "../")
        .map((n) => (n.endsWith("/") ? { name: n.slice(0, -1), dir: true } : { name: n, dir: false }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return json(res, 200, { path: cwd, parent: path.posix.dirname(cwd), entries });
    });
    return true;
  }

  if (url.pathname === "/file/read" && fsHost) {
    const p = remotePath(url.searchParams.get("path"));
    if (!p) return json(res, 400, { error: "invalid path" }), true;
    // Exit 4: a FIFO, socket or device, refused before anything reads it.
    const cmd =
      remoteGuard(p) +
      `[ ! -e "$p" ] || [ -f "$p" ] || exit 4; ` +
      `sz=$(wc -c < "$p" 2>/dev/null || echo 0); if [ "$sz" -gt 2097152 ]; then echo TOOLARGE; else cat "$p"; fi`;
    execFile(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", fsHost, cmd],
      { maxBuffer: 4 * 1024 * 1024, encoding: "buffer" },
      (err, out) => {
        if (denied(out)) return json(res, 403, { error: "outside home" });
        if (err?.code === 4) return json(res, 400, { error: NOT_FILE });
        if (err) return json(res, 404, { error: String(err.message || err) });
        const bytes = Buffer.isBuffer(out) ? out : Buffer.from(String(out || ""));
        if (bytes.subarray(0, 8).toString("latin1") === "TOOLARGE") return json(res, 200, { path: p, content: "", tooLarge: true });
        const text = decodeText(bytes);
        if (text === null) return json(res, 200, { path: p, content: "", binary: true });
        return json(res, 200, { path: p, content: text, sha256: sha256Hex(bytes) });
      },
    );
    return true;
  }

  if (url.pathname === "/file/raw" && fsHost) {
    const p = remotePath(url.searchParams.get("path"));
    if (!p) return json(res, 400, { error: "invalid path" }), true;
    // Guard first (small round trip), then stream the bytes. Only a regular
    // file is streamed, and the stream re-applies the guard (its marker goes
    // nowhere) so it reads exactly the path that was checked.
    const regular = `[ -f "$p" ] || exit 4; `;
    execFile(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", fsHost, remoteGuard(p) + `[ ! -e "$p" ] || ${regular}printf OK`],
      (err, out) => {
        if (denied(out)) return json(res, 403, { error: "outside home" });
        if (err?.code === 4) return json(res, 400, { error: NOT_FILE });
        if (err || String(out || "") !== "OK") return json(res, 403, { error: "outside home" });
        cors(res);
        res.writeHead(200, { "Content-Type": mimeType(p), "Cache-Control": "no-store" });
        const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", fsHost, `{ ${remoteGuard(p)}} >/dev/null; ${regular}exec cat -- "$p"`]);
        child.stdout.pipe(res);
        child.on("error", () => res.destroyed || res.end());
      },
    );
    return true;
  }

  if (url.pathname === "/file/read") {
    let descriptor;
    try {
      const p = realSafePath(url.searchParams.get("path"));
      if (!p) return json(res, 400, { error: "invalid path" }), true;
      // The resolved path has no links left; a FIFO or device is refused unopened.
      const opened = openRegularFile(p);
      descriptor = opened.descriptor;
      if (opened.stat.size > TEXT_LIMIT) return json(res, 200, { path: p, content: "", tooLarge: true }), true;
      const bytes = fs.readFileSync(descriptor);
      const text = decodeText(bytes);
      if (text === null) return json(res, 200, { path: p, content: "", binary: true }), true;
      return json(res, 200, { path: p, content: text, sha256: sha256Hex(bytes) }), true;
    } catch (e) {
      return json(res, e.status ?? 404, { error: String(e.message || e) }), true;
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
    }
  }

  if (url.pathname === "/file/write" && req.method === "POST") {
    const body = await readBody(req);
    if (!body || typeof body !== "object" || Array.isArray(body)) return json(res, 400, { error: "Invalid request" }), true;
    if (body.content !== undefined && typeof body.content !== "string") return json(res, 400, { error: "content must be text" }), true;
    // The version the editor read: the write only replaces exactly that file.
    const expected = body.expectedSha256;
    if (expected !== undefined && (typeof expected !== "string" || !SHA256.test(expected))) return json(res, 400, { error: "invalid file version" }), true;
    const content = body.content ?? "";
    const writeHost = SSH_TOKEN.test(String(body.host || "")) ? String(body.host) : "";
    if (writeHost) {
      const rp = remotePath(body.path);
      if (!rp) return json(res, 400, { error: "invalid path" }), true;
      // Same $HOME bound as reads; the content streams over ssh stdin so no
      // size/quoting limits apply. Exit 3 = guard refused the path.
      const data = Buffer.from(content, "utf8");
      const child = spawn("ssh", [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        writeHost,
        remoteGuard(rp) + remoteWriteScript(data.length, expected),
      ]);
      // ssh that exits before reading (offline device, refused path) makes the
      // pending write fail with EPIPE; the exit code below reports it instead.
      child.stdin.on("error", () => {});
      // With a version to check, the device sends the file's current bytes
      // right before replacing it; the agent hashes them and answers on stdin.
      // `current` is that hash once known, null for a reply that was not one.
      let current;
      if (expected !== undefined) {
        const readVersion = versionReader();
        child.stdout.on("data", (chunk) => {
          if (current !== undefined) return;
          current = readVersion(chunk);
          if (current !== undefined) child.stdin.end(current === expected ? "same\n" : "changed\n");
        });
      }
      let answered = false;
      const answer = (status, payload) => {
        if (answered) return;
        answered = true;
        json(res, status, payload);
      };
      child.on("error", (e) => answer(500, { error: String(e.message || e) }));
      child.on("close", (code) => {
        if (code === 0) return answer(200, { ok: true, sha256: sha256Hex(data) });
        if (code === 3) return answer(403, { error: "outside home" });
        if (code === 4) return answer(400, { error: "not a file" });
        if (code === 5) return answer(409, { error: "This file is not UTF-8 text, so the editor cannot save it without corrupting it." });
        if (code === 6 && current === null) return answer(500, { error: "Could not read the file's version on the device; the file was left unchanged." });
        if (code === 6 && expected !== undefined) return answer(409, changedReply(changedError(current ?? null)));
        if (code === 8) return answer(403, { error: "This file is read-only, so the editor cannot save it." });
        if (code === 9) return answer(500, { error: "The save stopped part-way on the device, so the file there may be incomplete." });
        return answer(500, { error: `write failed (${code}); the file on the device was left unchanged` });
      });
      // The version answer follows the content, so stdin stays open for it.
      if (expected === undefined) child.stdin.end(data);
      else child.stdin.write(data);
      return true;
    }
    try {
      const p = realSafePath(body.path);
      if (!p) return json(res, 400, { error: "invalid path" }), true;
      const sha256 = writeTextFileAtomic(p, content, expected);
      return json(res, 200, { ok: true, sha256 }), true;
    } catch (e) {
      if (e.changed) return json(res, 409, changedReply(e)), true;
      return json(res, e.status ?? 500, { error: String(e.message || e) }), true;
    }
  }

  // Stream a file's raw bytes with its media type, so the code view can preview
  // images and PDFs instead of loading them as text.
  if (url.pathname === "/file/raw") {
    let p;
    let opened;
    try {
      p = realSafePath(url.searchParams.get("path"));
      if (!p) return json(res, 400, { error: "invalid path" }), true;
      opened = openRegularFile(p);
    } catch (e) {
      return json(res, e.status ?? 404, { error: String(e.message || e) }), true;
    }
    const { descriptor, stat: st } = opened;
    if (st.size > 50 * 1024 * 1024) {
      fs.closeSync(descriptor);
      return json(res, 413, { error: "file too large" }), true;
    }
    cors(res);
    res.writeHead(200, {
      "Content-Type": mimeType(p),
      "Content-Length": st.size,
      "Cache-Control": "no-store",
    });
    // Streams the descriptor that was checked, and closes it when done.
    const stream = fs.createReadStream(null, { fd: descriptor, start: 0 });
    stream.on("error", () => res.destroyed || res.end()).pipe(res);
    res.on("close", () => stream.destroy());
    return true;
  }

  if (url.pathname === "/fs/list") {
    const p = safePath(url.searchParams.get("path"), { listOnly: true }) || os.homedir();
    try {
      const entries = fs
        .readdirSync(p, { withFileTypes: true })
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return json(res, 200, { path: p, parent: path.dirname(p), entries }), true;
    } catch (e) {
      return json(res, 404, { error: String(e.message || e) }), true;
    }
  }

  if (url.pathname === "/paste-image" && req.method === "POST") {
    const requestedHost = url.searchParams.get("host") || "";
    if (requestedHost && !SSH_TOKEN.test(requestedHost)) return json(res, 400, { error: "Invalid device host" }), true;
    const host = url.searchParams.has("host") ? requestedHost : IS_CLIENT ? DEVBOX : "";
    let buf;
    try {
      buf = await readImageBody(req);
    } catch (error) {
      return json(res, error.status || 400, { error: error.message }), true;
    }
    const ext = imageExtension(buf);
    if (!ext) return json(res, 415, { error: "Unsupported or invalid image; use PNG, JPEG, GIF, WebP or BMP" }), true;
    const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
    if (host) {
      // Noclobber opens exclusively; traps remove a partial upload on failure.
      // Only the random basename and verified byte count enter the shell text.
      const remote =
        `d="\${XDG_RUNTIME_DIR:-$HOME/.cache}/pzzacode/paste"; umask 077; ` +
        `mkdir -p "$d" && [ ! -L "$d" ] && chmod 700 "$d" || exit 1; ` +
        `f="$d/${name}"; set -C; exec 3>"$f" || exit 1; ` +
        `trap 'rm -f "$f"' 0; trap 'exit 1' HUP INT TERM; ` +
        `cat >&3 && exec 3>&- && [ "$(wc -c < "$f" | tr -d ' ')" = ${buf.length} ] || exit 1; ` +
        `printf '%s' "$f"; trap - 0 HUP INT TERM`;
      const child = execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new",
        "-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/pzza-mux-%C", "-o", "ControlPersist=120", host, remote],
      { timeout: 30_000, maxBuffer: 16 * 1024 }, (error, stdout) => {
        if (error) return json(res, 500, { error: "Could not save image on the selected device" });
        const savedPath = String(stdout || "");
        if (!savedPath.startsWith("/") || !savedPath.endsWith(`/${name}`)) return json(res, 500, { error: "Invalid image path from selected device" });
        return json(res, 200, { path: savedPath });
      });
      child.stdin.on("error", () => {});
      child.stdin.end(buf);
      return true;
    }
    const dir = path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache"), "pzzacode", "paste");
    const file = path.join(dir, name);
    let descriptor;
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      if (fs.lstatSync(dir).isSymbolicLink()) throw new Error("Invalid paste directory");
      fs.chmodSync(dir, 0o700);
      descriptor = fs.openSync(file, "wx", 0o600);
      fs.writeFileSync(descriptor, buf);
      fs.closeSync(descriptor);
    } catch {
      if (descriptor !== undefined) {
        try { fs.closeSync(descriptor); } catch { /* Already closed. */ }
        try { fs.unlinkSync(file); } catch { /* Preserve the original write failure. */ }
      }
      return json(res, 500, { error: "Could not save image on this device" }), true;
    }
    return json(res, 200, { path: file }), true;
  }

  return false;
}
