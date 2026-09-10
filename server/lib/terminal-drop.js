import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { SSH_TOKEN, shQuote } from "./shell.js";
import { DEVBOX, IS_CLIENT } from "./config.js";

export const DROP_LIMITS = { count: 8, file: 16 * 1024 * 1024, total: 32 * 1024 * 1024 };
const uploads = new Map();
let active = 0;
const failure = (status, message) => Object.assign(new Error(message), { status });

export function validateDropManifest(value) {
  if (!Array.isArray(value) || !value.length || value.length > DROP_LIMITS.count) throw failure(400, "Drop between one and eight regular files.");
  let total = 0;
  for (const file of value) {
    if (!file || typeof file !== "object" || Object.keys(file).some(key => key !== "name" && key !== "size") ||
        typeof file.name !== "string" || !file.name || [".", ".."].includes(file.name) ||
        /[\\/\x00-\x1f\x7f-\x9f]/u.test(file.name) || Buffer.byteLength(file.name) > 255 ||
        !Number.isSafeInteger(file.size) || file.size < 0 || file.size > DROP_LIMITS.file) {
      throw failure(400, "Use regular files with safe names, up to 16 MiB each.");
    }
    total += file.size;
  }
  if (total > DROP_LIMITS.total) throw failure(413, "Drop at most 32 MiB at once.");
  if (new Set(value.map(file => file.name)).size !== value.length) throw failure(400, "Dropped filenames must be distinct.");
  return total;
}

async function readDropBody(req, expected, signal) {
  if (req.headers["content-length"] !== undefined && Number(req.headers["content-length"]) !== expected) throw failure(400, "Dropped file sizes do not match the upload.");
  const chunks = [];
  let size = 0;
  const abort = () => req.destroy();
  signal.addEventListener("abort", abort, { once: true });
  try {
    if (signal.aborted) throw failure(400, "File drop cancelled.");
    for await (const chunk of req) {
      size += chunk.length;
      if (size > expected) throw failure(413, "Drop upload exceeds its declared size.");
      chunks.push(chunk);
    }
    if (signal.aborted || size !== expected) throw failure(400, "File drop was interrupted.");
    return Buffer.concat(chunks, size);
  } finally { signal.removeEventListener("abort", abort); }
}

const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes",
  "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
  "-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/pzza-mux-%C", "-o", "ControlPersist=120"];

function remoteRun(host, script, bytes, signal) {
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", [...SSH_OPTIONS, host, `python3 -c ${shQuote(script)}`],
      { timeout: 25000, maxBuffer: 16384, signal }, (error, stdout) => {
        if (error) reject(failure(503, "Could not copy files to the selected device. Check SSH access, the trusted host key, and Python 3."));
        else resolve(String(stdout));
      });
    child.stdin.on("error", () => {});
    child.stdin.end(bytes);
  });
}

// Only an authenticated upload receipt selects the private temporary directory.
// No client-supplied filesystem path ever enters creation or cleanup commands.
async function discardUpload(upload) {
  if (upload.cleanup) return upload.cleanup;
  upload.cleanup = (async () => {
    if (upload.host) {
      const script = `import os, shutil, stat\np=${JSON.stringify(upload.directory)}\ntry:\n s=os.lstat(p)\n if not stat.S_ISDIR(s.st_mode) or s.st_uid != os.getuid(): raise RuntimeError('invalid directory')\n shutil.rmtree(p)\nexcept FileNotFoundError: pass\n`;
      await remoteRun(upload.host, script, Buffer.alloc(0), AbortSignal.timeout(10000));
    } else if (upload.directory) await fs.rm(upload.directory, { recursive: true, force: true });
    uploads.delete(upload.id);
  })().catch(error => { upload.cleanup = undefined; throw error; });
  return upload.cleanup;
}

export async function terminalDropRouter(req, res, url, json) {
  if (url.pathname !== "/terminal-drop") return false;
  if (req.method === "DELETE") {
    const id = url.searchParams.get("id");
    if (!id || !/^[a-f0-9]{32}$/.test(id)) return json(res, 400, { error: "Invalid drop receipt." }), true;
    const upload = uploads.get(id);
    if (!upload || !upload.complete) return json(res, 404, { error: "This drop receipt is unavailable." }), true;
    try { await discardUpload(upload); json(res, 200, { removed: true }); }
    catch { json(res, 503, { error: "The temporary copy could not be removed from its device." }); }
    return true;
  }
  if (req.method !== "POST") return json(res, 405, { error: "Use POST or DELETE." }), true;
  // Receipts expire, not the user's successfully pasted files. OS temporary
  // storage owns their later lifetime; failed/cancelled transfers are removed.
  for (const [id, upload] of uploads) if (upload.complete && upload.created < Date.now() - 30 * 60 * 1000) uploads.delete(id);
  if (active >= 2 || uploads.size >= 256) return json(res, 429, { error: "Finish current drops or retry later." }), true;
  let files;
  let expected;
  const requestedHost = url.searchParams.get("host") ?? (IS_CLIENT ? DEVBOX : "");
  try {
    if (requestedHost && !SSH_TOKEN.test(requestedHost)) throw failure(400, "Invalid device host.");
    const raw = url.searchParams.get("files") ?? "";
    if (raw.length > 8192) throw failure(400, "Invalid drop manifest.");
    try { files = JSON.parse(raw); } catch { throw failure(400, "Invalid drop manifest."); }
    expected = validateDropManifest(files);
  } catch (error) { return json(res, error.status ?? 400, { error: error.message }), true; }
  active++;
  const controller = new AbortController();
  const abort = () => { if (!res.writableFinished) controller.abort(); };
  res.once("close", abort);
  const timer = setTimeout(() => controller.abort(), 30000);
  let upload;
  try {
    const bytes = await readDropBody(req, expected, controller.signal);
    const id = crypto.randomBytes(16).toString("hex");
    upload = { id, host: requestedHost, directory: "", created: Date.now(), complete: false };
    uploads.set(id, upload);
    if (requestedHost) {
      upload.directory = `/tmp/pzzacode-drop-${id}`;
      const script = `import os, sys, json, shutil, signal\n` +
        `files=json.loads(${JSON.stringify(JSON.stringify(files))})\ndirectory=${JSON.stringify(upload.directory)}\ncreated=False\nsuccess=False\n` +
        `def stopped(*_): raise RuntimeError('interrupted')\n` +
        `for s in (signal.SIGHUP, signal.SIGTERM, signal.SIGINT): signal.signal(s, stopped)\n` +
        `try:\n os.mkdir(directory, 0o700)\n created=True\n paths=[]\n` +
        ` for f in files:\n  p=os.path.join(directory,f['name'])\n  with open(p,'xb') as out:\n   os.chmod(p,0o600)\n   remaining=f['size']\n   while remaining:\n    data=sys.stdin.buffer.read(min(65536,remaining))\n    if not data: raise RuntimeError('truncated')\n    out.write(data)\n    remaining-=len(data)\n  paths.append(p)\n` +
        ` if sys.stdin.buffer.read(1): raise RuntimeError('oversized')\n` +
        ` print(json.dumps(paths),flush=True)\n success=True\n` +
        `finally:\n if created and not success: shutil.rmtree(directory)\n`;
      const output = await remoteRun(requestedHost, script, bytes, controller.signal);
      const paths = JSON.parse(output);
      const intended = files.map(file => `${upload.directory}/${file.name}`);
      if (JSON.stringify(paths) !== JSON.stringify(intended)) throw failure(502, "The device returned invalid temporary file paths.");
      upload.paths = paths;
    } else {
      upload.directory = await fs.mkdtemp(path.join(os.tmpdir(), "pzzacode-drop-"));
      await fs.chmod(upload.directory, 0o700);
      let offset = 0;
      upload.paths = [];
      for (const file of files) {
        if (controller.signal.aborted) throw failure(400, "File drop cancelled.");
        const target = path.join(upload.directory, file.name);
        await fs.writeFile(target, bytes.subarray(offset, offset + file.size), { flag: "wx", mode: 0o600, signal: controller.signal });
        offset += file.size;
        upload.paths.push(target);
      }
    }
    if (controller.signal.aborted) throw failure(400, "File drop cancelled.");
    upload.complete = true;
    // A connection lost before the success response finishes is still a failed
    // transfer, even if all bytes already reached the target device.
    res.once("close", () => { if (!res.writableFinished) void discardUpload(upload).catch(() => {}); });
    json(res, 200, { id: upload.id, paths: upload.paths });
  } catch (error) {
    if (upload) {
      try { await discardUpload(upload); }
      catch { upload.complete = true; /* Keep its receipt available for explicit cleanup. */ }
    }
    if (!res.destroyed) json(res, error.status ?? 503, { error: error.status ? error.message : "The file drop failed. No path was inserted." });
  } finally {
    active--;
    clearTimeout(timer);
    res.removeListener("close", abort);
  }
  return true;
}
