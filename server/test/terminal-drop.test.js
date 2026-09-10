import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { readFile, stat, mkdtemp, rm, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";

const root = await mkdtemp(path.join(os.tmpdir(), "pzza-drop-tests-"));
process.env.XDG_CONFIG_HOME = path.join(root, "state");
process.env.PZZA_SERVER_HOST = "default-device";
const { filesRouter } = await import("../lib/files.js");
const { validateDropManifest } = await import("../lib/terminal-drop.js");
const server = createServer((req, res) => { void filesRouter(req, res, new URL(req.url, "http://localhost")).catch(() => { if (!res.destroyed) res.writeHead(500).end(); }); });
await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}/terminal-drop`;
test.after(async () => {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
  await rm(root, { recursive: true, force: true });
});
const manifest = [{ name: "regular ' file.txt", size: 5 }, { name: "empty.bin", size: 0 }];
async function upload(files = manifest, body = Buffer.from("hello"), host = "") {
  const query = new URLSearchParams({ files: JSON.stringify(files), ...(host === undefined ? {} : { host }) });
  const response = await fetch(`${endpoint}?${query}`, { method: "POST", body, duplex: "half" });
  return { status: response.status, value: await response.json() };
}
async function remove(id) {
  const response = await fetch(`${endpoint}?${new URLSearchParams({ id })}`, { method: "DELETE" });
  return response.status;
}

test("drop manifest rejects traversal, control names, directories, symlink declarations and size/count overflow", () => {
  for (const value of [[], Array(9).fill({ name: "a", size: 1 }), [{ name: "../a", size: 1 }], [{ name: "a\\b", size: 1 }],
    [{ name: "a\ncommand", size: 1 }], [{ name: "a", size: -1 }], [{ name: "a", size: 16 * 1024 * 1024 + 1 }],
    [{ name: "a", size: 1, directory: true }], [{ name: "a", size: 1, symlink: true }],
    [{ name: "a", size: 1 }, { name: "a", size: 1 }],
    ["a", "b", "c"].map(name => ({ name, size: 16 * 1024 * 1024 }))]) assert.throws(() => validateDropManifest(value));
  assert.equal(validateDropManifest(manifest), 5);
});

test("local browser uploads have exclusive private temporary storage and cleanup is receipt-only", async () => {
  const result = await upload();
  assert.equal(result.status, 200);
  assert.match(result.value.id, /^[a-f0-9]{32}$/);
  const [file, empty] = result.value.paths;
  assert.equal(await readFile(file, "utf8"), "hello");
  assert.equal((await stat(empty)).size, 0);
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await stat(path.dirname(file))).mode & 0o777, 0o700);
  assert.equal(await remove("../arbitrary"), 400);
  assert.equal(await remove("f".repeat(32)), 404);
  assert.equal(await remove(result.value.id), 200);
  await assert.rejects(stat(file), { code: "ENOENT" });
  assert.equal(await remove(result.value.id), 404);
});

test("wrong target and oversized declared body are refused before any remote process", async t => {
  const transport = t.mock.method(childProcess, "execFile", () => assert.fail("no process may execute"));
  syncBuiltinESMExports();
  try {
    assert.equal((await upload(manifest, Buffer.from("hello"), "-oProxyCommand=bad")).status, 400);
    assert.equal((await upload(manifest, Buffer.from("too long"))).status, 400);
    const body = Readable.from([Buffer.from("hello"), Buffer.from("extra")]);
    assert.equal((await upload(manifest, body)).status, 413);
  } finally { transport.mock.restore(); syncBuiltinESMExports(); }
});

test("authenticated account SSH transport writes real regular files and deletes their private copy", async t => {
  const execute = childProcess.execFile;
  const seen = [];
  const transport = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    assert.equal(command, "ssh");
    for (const option of ["BatchMode=yes", "StrictHostKeyChecking=yes", "ForwardAgent=no", "ClearAllForwardings=yes", "ControlPath=~/.ssh/pzza-mux-%C"]) assert.ok(args.includes(option));
    seen.push(args.at(-2));
    return execute("sh", ["-c", args.at(-1)], options, callback);
  });
  syncBuiltinESMExports();
  try {
    const result = await upload(manifest, Buffer.from("hello"), "selected-device");
    assert.equal(result.status, 200);
    assert.equal(await readFile(result.value.paths[0], "utf8"), "hello");
    assert.equal((await stat(result.value.paths[0])).mode & 0o777, 0o600);
    assert.equal(await remove(result.value.id), 200);
    await assert.rejects(stat(result.value.paths[0]), { code: "ENOENT" });
    assert.deepEqual(seen, ["selected-device", "selected-device"]);
  } finally { transport.mock.restore(); syncBuiltinESMExports(); }
});

test("remote subprocess failure after file creation cleans the entire partial transfer", async t => {
  const execute = childProcess.execFile;
  const before = new Set((await readdir("/tmp")).filter(name => name.startsWith("pzzacode-drop-")));
  let calls = 0;
  const transport = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls++;
    // Execute the real upload program and simulate loss of its SSH result.
    return execute("sh", ["-c", args.at(-1)], options, (error, stdout) => {
      callback(calls === 1 ? Object.assign(new Error("connection lost"), { code: 255 }) : error, stdout);
    });
  });
  syncBuiltinESMExports();
  try {
    assert.equal((await upload(manifest, Buffer.from("hello"), "selected-device")).status, 503);
    assert.equal(calls, 2, "failed upload performs authenticated cleanup");
    const after = new Set((await readdir("/tmp")).filter(name => name.startsWith("pzzacode-drop-")));
    assert.deepEqual(after, before);
  } finally { transport.mock.restore(); syncBuiltinESMExports(); }
});
