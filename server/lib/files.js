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
import { denied, mimeType, remoteGuard, remotePath, safePath } from "./paths.js";

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
    const cmd =
      remoteGuard(p) +
      `sz=$(wc -c < "$p" 2>/dev/null || echo 0); if [ "$sz" -gt 2097152 ]; then echo TOOLARGE; else cat "$p"; fi`;
    execFile(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", fsHost, cmd],
      { maxBuffer: 4 * 1024 * 1024 },
      (err, out) => {
        if (denied(out)) return json(res, 403, { error: "outside home" });
        if (err) return json(res, 404, { error: String(err.message || err) });
        const text = String(out || "");
        if (text.startsWith("TOOLARGE")) return json(res, 200, { path: p, content: "", tooLarge: true });
        return json(res, 200, { path: p, content: text });
      },
    );
    return true;
  }

  if (url.pathname === "/file/raw" && fsHost) {
    const p = remotePath(url.searchParams.get("path"));
    if (!p) return json(res, 400, { error: "invalid path" }), true;
    // Guard first (small round trip), then stream the bytes.
    execFile(
      "ssh",
      ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", fsHost, remoteGuard(p) + `printf OK`],
      (err, out) => {
        if (err || denied(out) || String(out || "") !== "OK") return json(res, 403, { error: "outside home" });
        cors(res);
        res.writeHead(200, { "Content-Type": mimeType(p), "Cache-Control": "no-store" });
        const child = spawn("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", fsHost, `cat ${shQuote(p)}`]);
        child.stdout.pipe(res);
        child.on("error", () => res.destroyed || res.end());
      },
    );
    return true;
  }

  if (url.pathname === "/file/read") {
    const p = safePath(url.searchParams.get("path"));
    if (!p) return json(res, 400, { error: "invalid path" }), true;
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return json(res, 400, { error: "not a file" }), true;
      if (st.size > 2 * 1024 * 1024) return json(res, 200, { path: p, content: "", tooLarge: true }), true;
      return json(res, 200, { path: p, content: fs.readFileSync(p, "utf8") }), true;
    } catch (e) {
      return json(res, 404, { error: String(e.message || e) }), true;
    }
  }

  if (url.pathname === "/file/write" && req.method === "POST") {
    const body = await readBody(req);
    const writeHost = SSH_TOKEN.test(String(body.host || "")) ? String(body.host) : "";
    if (writeHost) {
      const rp = remotePath(body.path);
      if (!rp) return json(res, 400, { error: "invalid path" }), true;
      // Same $HOME bound as reads; the content streams over ssh stdin so no
      // size/quoting limits apply. Exit 3 = guard refused the path.
      const child = spawn("ssh", [
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=8",
        writeHost,
        remoteGuard(rp) + `cat > "$p"`,
      ]);
      child.stdout.resume();
      child.on("error", (e) => json(res, 500, { error: String(e.message || e) }));
      child.on("close", (code) => {
        if (code === 3) return json(res, 403, { error: "outside home" });
        return code === 0 ? json(res, 200, { ok: true }) : json(res, 500, { error: `write failed (${code})` });
      });
      child.stdin.end(String(body.content ?? ""));
      return true;
    }
    const p = safePath(body.path);
    if (!p) return json(res, 400, { error: "invalid path" }), true;
    try {
      fs.writeFileSync(p, String(body.content ?? ""));
      return json(res, 200, { ok: true }), true;
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) }), true;
    }
  }

  // Stream a file's raw bytes with its media type, so the code view can preview
  // images and PDFs instead of loading them as text.
  if (url.pathname === "/file/raw") {
    const p = safePath(url.searchParams.get("path"));
    if (!p) return json(res, 400, { error: "invalid path" }), true;
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      return json(res, 404, { error: String(e.message || e) }), true;
    }
    if (!st.isFile()) return json(res, 400, { error: "not a file" }), true;
    if (st.size > 50 * 1024 * 1024) return json(res, 413, { error: "file too large" }), true;
    cors(res);
    res.writeHead(200, {
      "Content-Type": mimeType(p),
      "Content-Length": st.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(p)
      .on("error", () => res.destroyed || res.end())
      .pipe(res);
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
