import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, mkdir, readFile, stat, readdir, rm } from "node:fs/promises";
import { PassThrough, Readable } from "node:stream";
import path from "node:path";
import test from "node:test";

const root = await mkdtemp("/tmp/pzza-paste-test-");
process.env.XDG_CONFIG_HOME = path.join(root, "state");
process.env.XDG_RUNTIME_DIR = path.join(root, "local");
process.env.PZZA_SERVER_HOST = "default-device";
const { filesRouter } = await import("../lib/files.js");
const server = createServer((req, res) => {
  filesRouter(req, res, new URL(req.url, "http://localhost")).catch(() => res.writeHead(500).end());
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/paste-image`;
test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});
const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=", "base64");
async function upload(body = png, query = "host=", contentType = "image/png") {
  const response = await fetch(`${endpoint}${query === null ? "" : `?${query}`}`, {
    method: "POST", headers: { "Content-Type": contentType }, body, duplex: "half",
  });
  return { status: response.status, body: await response.json() };
}

test("explicit empty host stores locally even on a receiver, with signature extension and private permissions", async () => {
  const result = await upload(png, "host=", "image/jpeg");
  assert.equal(result.status, 200);
  assert.ok(result.body.path.startsWith(path.join(root, "local") + "/"));
  assert.ok(result.body.path.endsWith(".png"));
  assert.deepEqual(await readFile(result.body.path), png);
  assert.equal((await stat(result.body.path)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(result.body.path))).mode & 0o777, 0o700);
});

test("invalid hosts, unsupported signatures and oversized image uploads fail without creating files", async () => {
  const dir = path.join(root, "local", "pzzacode", "paste");
  const before = await readdir(dir);
  assert.equal((await upload(png, "host=-bad%20host")).status, 400);
  assert.equal((await upload(Buffer.from("<svg></svg>"))).status, 415);
  assert.equal((await upload(Buffer.alloc(0))).status, 415);
  assert.equal((await upload(Buffer.alloc(20 * 1024 * 1024 + 1))).status, 413);
  const chunked = Readable.from([Buffer.alloc(10 * 1024 * 1024), Buffer.alloc(10 * 1024 * 1024), Buffer.from("overflow")]);
  assert.equal((await upload(chunked)).status, 413);
  assert.deepEqual(await readdir(dir), before);
});

test("explicit remote host and omitted host route to their actual device and preserve image bytes", async (t) => {
  const execute = childProcess.execFile;
  const seen = [];
  const transport = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    assert.equal(command, "ssh");
    const host = args.at(-2);
    seen.push(host);
    assert.ok(options.timeout <= 30_000);
    assert.ok(args.includes("ControlPath=~/.ssh/pzza-mux-%C"));
    return execute("sh", ["-c", args.at(-1)], { ...options, env: { ...process.env, XDG_RUNTIME_DIR: path.join(root, host) } }, callback);
  });
  syncBuiltinESMExports();
  try {
    for (const [query, device] of [["host=other-device", "other-device"], [null, "default-device"]]) {
      const result = await upload(png, query);
      assert.equal(result.status, 200);
      assert.ok(result.body.path.startsWith(path.join(root, device) + "/"));
      assert.deepEqual(await readFile(result.body.path), png);
      assert.equal((await stat(result.body.path)).mode & 0o777, 0o600);
    }
    assert.deepEqual(seen, ["other-device", "default-device"]);
  } finally {
    transport.mock.restore();
    syncBuiltinESMExports();
  }
});

test("remote write failure removes partial image and reports failure", async (t) => {
  const execute = childProcess.execFile;
  const directory = path.join(root, "failed-device", "pzzacode", "paste");
  await mkdir(directory, { recursive: true });
  const transport = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    assert.equal(command, "ssh");
    const script = `cat() { command dd bs=1 count=1 2>/dev/null; return 1; }; ${args.at(-1)}`;
    return execute("sh", ["-c", script], { ...options, env: { ...process.env, XDG_RUNTIME_DIR: path.join(root, "failed-device") } }, callback);
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await upload(png, "host=failed-device")).status, 500);
    assert.deepEqual(await readdir(directory), []);
  } finally {
    transport.mock.restore();
    syncBuiltinESMExports();
  }
});

test("body read errors produce an error response without saving incomplete content", async () => {
  const req = new PassThrough();
  req.method = "POST";
  req.headers = {};
  let status;
  let payload;
  const res = { writeHead(value) { status = value; }, end(value) { payload = JSON.parse(value); } };
  const pending = filesRouter(req, res, new URL("http://localhost/paste-image?host="));
  req.write(png.subarray(0, 12));
  req.emit("error", new Error("fixture upload failure"));
  assert.equal(await pending, true);
  assert.equal(status, 400);
  assert.match(payload.error, /read image upload/);
  req.destroy();
});
