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
import { cors, json, readBody, readRawBody } from "./http.js";
import { denied, mimeType, remoteGuard, remotePath, safePath } from "./paths.js";

const FS_ROUTES = new Set(["/fs/list", "/file/read", "/file/raw", "/file/write", "/paste-image"]);

// Route the file endpoints. Returns true if it owned (and answered) the request.
export async function filesRouter(req, res, url) {
  if (!FS_ROUTES.has(url.pathname)) return false;

  const hostParam = url.searchParams.get("host") || "";
  const fsHost = SSH_TOKEN.test(hostParam) ? hostParam : "";

  if (url.pathname === "/fs/list" && fsHost) {
    const raw = url.searchParams.get("path") || "";
    const p = raw ? remotePath(raw) : null;
    if (raw && !p) return json(res, 400, { error: "invalid path" }), true;
    const cmd = (p ? remoteGuard(p) : `p=$(cd ~ && pwd -P); `) + `cd "$p" && pwd -P && ls -1Ap 2>/dev/null`;
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
    const p = safePath(url.searchParams.get("path")) || os.homedir();
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
    const buf = await readRawBody(req);
    if (!buf.length) return json(res, 400, { error: "empty" }), true;
    const ct = String(req.headers["content-type"] || "image/png");
    const ext = ct.includes("jpeg") || ct.includes("jpg")
      ? "jpg"
      : ct.includes("gif")
        ? "gif"
        : ct.includes("webp")
          ? "webp"
          : "png";
    // Private, per-user, unguessable: a 0700 cache dir, a random name, and an
    // exclusive 0600 create - pasted screenshots often carry secrets, and a
    // shared /tmp would expose them to every other account on the box.
    const name = `${crypto.randomBytes(12).toString("hex")}.${ext}`;
    if (IS_CLIENT) {
      const remote =
        `d="\${XDG_RUNTIME_DIR:-$HOME/.cache}/pzzacode/paste"; umask 077; mkdir -p "$d" && ` +
        `cat > "$d/${name}" && printf %s "$d/${name}"`;
      const p = execFile("ssh", ["-o", "BatchMode=yes", DEVBOX, remote], (err, out) =>
        err
          ? json(res, 500, { error: String(err.message || err) })
          : json(res, 200, { path: String(out || "").trim() }),
      );
      p.stdin.write(buf);
      p.stdin.end();
      return true;
    }
    const dir = path.join(process.env.XDG_RUNTIME_DIR || path.join(os.homedir(), ".cache"), "pzzacode", "paste");
    const file = path.join(dir, name);
    try {
      fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
      fs.writeFileSync(file, buf, { flag: "wx", mode: 0o600 });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) }), true;
    }
    return json(res, 200, { path: file }), true;
  }

  return false;
}
