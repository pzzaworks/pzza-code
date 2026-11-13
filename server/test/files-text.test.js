import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { createHash } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, stat, chmod, chown, link, symlink } from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";

const state = await mkdtemp(path.join(os.tmpdir(), "pzza-files-text-state-"));
process.env.XDG_CONFIG_HOME = state;
const { filesRouter, decodeText, remoteWriteScript } = await import("../lib/files.js");
const { realSafePath } = await import("../lib/paths.js");
const server = createServer((req, res) => {
  filesRouter(req, res, new URL(req.url, "http://localhost")).then((handled) => {
    if (!handled) res.writeHead(404).end();
  }).catch(() => res.writeHead(500).end());
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(state, { recursive: true, force: true });
});

async function fixture(t) {
  const base = await mkdtemp(path.join(os.homedir(), ".pzza-files-text-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  return base;
}

async function read(file, host) {
  const response = await fetch(`${endpoint}/file/read?path=${encodeURIComponent(file)}${host ? `&host=${host}` : ""}`);
  return { status: response.status, body: await response.json() };
}

async function write(body) {
  const response = await fetch(`${endpoint}/file/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

// Runs the ssh-proxied branch on this machine: the remote command runs in sh.
function localSsh(t, wrap = (command) => command) {
  const spawn = childProcess.spawn;
  const execFile = childProcess.execFile;
  const spawned = t.mock.method(childProcess, "spawn", (command, args, options) => {
    if (command !== "ssh") return spawn(command, args, options);
    return spawn("sh", ["-c", wrap(args.at(-1))], options);
  });
  const executed = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    if (command !== "ssh") return execFile(command, args, options, callback);
    return execFile("sh", ["-c", args.at(-1)], options, callback);
  });
  syncBuiltinESMExports();
  t.after(() => {
    spawned.mock.restore();
    executed.mock.restore();
    syncBuiltinESMExports();
  });
}

const LATIN1 = Buffer.from([0x63, 0x61, 0x66, 0xe9, 0x0a]); // "café\n" in Latin-1
const sha256 = (value) => createHash("sha256").update(value).digest("hex");

test("text decoding refuses invalid UTF-8 and NUL bytes and keeps a byte-order mark", () => {
  assert.equal(decodeText(Buffer.from("plain ünïcode\n")), "plain ünïcode\n");
  assert.equal(decodeText(LATIN1), null);
  assert.equal(decodeText(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00])), null);
  assert.equal(decodeText(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), "﻿a");
});

test("local saves replace the file atomically, keep its mode and leave no temporary file", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, "notes.txt");
  await writeFile(file, "before\n");
  await chmod(file, 0o640);
  const before = await stat(file);
  assert.deepEqual(await write({ path: file, content: "after ✓\n" }), { status: 200, body: { ok: true, sha256: sha256("after ✓\n") } });
  assert.equal(await readFile(file, "utf8"), "after ✓\n");
  const after = await stat(file);
  assert.equal(after.mode & 0o777, 0o640);
  assert.notEqual(after.ino, before.ino, "the original was replaced by a rename, not truncated in place");
  assert.deepEqual(await readdir(base), ["notes.txt"]);
  // A new file gets the normal permissions for this account.
  const created = path.join(base, "new.txt");
  assert.equal((await write({ path: created, content: "new\n" })).status, 200);
  assert.equal((await stat(created)).mode & 0o777, 0o666 & ~process.umask());
  // A byte-order mark survives the read and save round trip.
  const marked = path.join(base, "marked.txt");
  await writeFile(marked, Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]));
  const opened = await read(marked);
  assert.equal(opened.body.content, "﻿a\n");
  assert.equal((await write({ path: marked, content: opened.body.content })).status, 200);
  assert.deepEqual(await readFile(marked), Buffer.from([0xef, 0xbb, 0xbf, 0x61, 0x0a]));
});

test("a failed local save leaves the original file and no temporary file behind", async (t) => {
  const base = await fixture(t);
  const folder = path.join(base, "locked");
  await mkdir(folder);
  const file = path.join(folder, "keep.txt");
  await writeFile(file, "original\n");
  await chmod(folder, 0o500);
  try {
    // A new file cannot be created in a folder that refuses new files.
    const result = await write({ path: path.join(folder, "new.txt"), content: "replacement\n" });
    assert.equal(result.status, 500);
    assert.equal(await readFile(file, "utf8"), "original\n");
    assert.deepEqual(await readdir(folder), ["keep.txt"]);
  } finally {
    await chmod(folder, 0o700);
  }
});

test("a read-only file is refused, as a plain write would refuse it, locally and on a device", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, "readonly.txt");
  await writeFile(file, "protected\n");
  await chmod(file, 0o444);
  const before = await stat(file);
  const local = await write({ path: file, content: "replaced\n" });
  assert.equal(local.status, 403);
  assert.match(local.body.error, /read-only/);
  localSsh(t);
  const remote = await write({ path: file, content: "replaced\n", host: "devbox" });
  assert.equal(remote.status, 403);
  assert.match(remote.body.error, /read-only/);
  assert.equal(await readFile(file, "utf8"), "protected\n");
  const after = await stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mode & 0o777, 0o444);
  assert.deepEqual(await readdir(base), ["readonly.txt"]);
});

test("a writable file in a folder that refuses new files is saved in place", async (t) => {
  const base = await fixture(t);
  const folder = path.join(base, "locked");
  await mkdir(folder);
  const file = path.join(folder, "edit.txt");
  await writeFile(file, "original\n");
  const before = await stat(file);
  await chmod(folder, 0o500);
  try {
    const opened = (await read(file)).body.sha256;
    assert.deepEqual(await write({ path: file, content: "saved in place ✓\n", expectedSha256: opened }), { status: 200, body: { ok: true, sha256: sha256("saved in place ✓\n") } });
    assert.equal(await readFile(file, "utf8"), "saved in place ✓\n");
    assert.equal((await stat(file)).ino, before.ino);
    // The version check still guards the in-place write.
    const stale = await write({ path: file, content: "stale\n", expectedSha256: opened });
    assert.equal(stale.status, 409);
    assert.equal(stale.body.sha256, sha256("saved in place ✓\n"));
    // A shorter save leaves no tail of the longer content behind.
    assert.equal((await write({ path: file, content: "x\n" })).status, 200);
    assert.equal(await readFile(file, "utf8"), "x\n");
    // The same on a device, through a temporary file outside the folder.
    localSsh(t);
    const remote = await write({ path: file, content: "remote in place\n", host: "devbox", expectedSha256: sha256("x\n") });
    assert.deepEqual(remote, { status: 200, body: { ok: true, sha256: sha256("remote in place\n") } });
    assert.equal(await readFile(file, "utf8"), "remote in place\n");
    assert.equal((await stat(file)).ino, before.ino);
    assert.deepEqual(await readdir(folder), ["edit.txt"]);
  } finally {
    await chmod(folder, 0o700);
  }
});

test("a hard-linked file is saved in place so every link sees the new content", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, "linked.txt");
  const twin = path.join(base, "twin.txt");
  await writeFile(file, "shared\n");
  await link(file, twin);
  const before = await stat(file);
  const opened = (await read(file)).body.sha256;
  assert.equal((await write({ path: file, content: "both ✓\n", expectedSha256: opened })).status, 200);
  assert.equal(await readFile(twin, "utf8"), "both ✓\n");
  assert.equal((await stat(file)).ino, before.ino);
  localSsh(t);
  assert.equal((await write({ path: twin, content: "remote both\n", host: "devbox", expectedSha256: sha256("both ✓\n") })).status, 200);
  assert.equal(await readFile(file, "utf8"), "remote both\n");
  assert.equal((await stat(twin)).ino, before.ino);
  assert.deepEqual((await readdir(base)).sort(), ["linked.txt", "twin.txt"]);
});

test("a file whose group cannot be kept on a new file is saved in place, never taken over", async (t) => {
  const other = process.getgroups().find((gid) => gid !== process.getgid());
  if (other === undefined) return t.skip("this account belongs to only one group");
  const base = await fixture(t);
  const file = path.join(base, "team.txt");
  await writeFile(file, "team\n");
  await chown(file, process.getuid(), other);
  // This account belongs to the group, so the atomic save keeps it.
  assert.equal((await write({ path: file, content: "kept\n" })).status, 200);
  assert.equal((await stat(file)).gid, other);
  // Where the group cannot be set, the file is written in place instead.
  const before = await stat(file);
  const refused = t.mock.method(fs, "fchownSync", () => { throw Object.assign(new Error("EPERM"), { code: "EPERM" }); });
  t.after(() => refused.mock.restore());
  assert.equal((await write({ path: file, content: "in place\n" })).status, 200);
  assert.equal(refused.mock.callCount(), 1);
  const after = await stat(file);
  assert.equal(after.ino, before.ino);
  assert.equal(after.gid, other);
  assert.equal(await readFile(file, "utf8"), "in place\n");
  assert.deepEqual(await readdir(base), ["team.txt"]);
});

test("a file name near the length limit still saves atomically", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, `${"n".repeat(250)}.txt`);
  await writeFile(file, "long\n");
  const before = await stat(file);
  assert.equal((await write({ path: file, content: "longer ✓\n" })).status, 200);
  assert.equal(await readFile(file, "utf8"), "longer ✓\n");
  assert.notEqual((await stat(file)).ino, before.ino);
  assert.deepEqual(await readdir(base), [path.basename(file)]);
});

test("FIFOs and sockets are refused without ever being opened, so the agent never blocks", async (t) => {
  const base = await fixture(t);
  const fifo = path.join(base, "pipe");
  childProcess.execFileSync("mkfifo", [fifo]);
  // Should a regression open the FIFO, this writer unblocks it so the test
  // fails on the timing below instead of hanging the run.
  const rescue = childProcess.spawn("sh", ["-c", `sleep 5; : > ${"'" + fifo + "'"}`], { stdio: "ignore" });
  t.after(() => rescue.kill());
  const socketPath = path.join(base, "sock");
  const listener = net.createServer().listen(socketPath);
  await once(listener, "listening");
  t.after(() => listener.close());
  const started = Date.now();
  for (const special of [fifo, socketPath]) {
    assert.deepEqual(await read(special), { status: 400, body: { error: "not a file" } }, special);
    assert.equal((await fetch(`${endpoint}/file/raw?path=${encodeURIComponent(special)}`)).status, 400, special);
    assert.equal((await write({ path: special, content: "x\n" })).status, 400, special);
  }
  localSsh(t);
  assert.deepEqual(await read(fifo, "devbox"), { status: 400, body: { error: "not a file" } });
  assert.equal((await fetch(`${endpoint}/file/raw?path=${encodeURIComponent(fifo)}&host=devbox`)).status, 400);
  assert.equal((await write({ path: fifo, content: "x\n", host: "devbox" })).status, 400);
  assert.ok(Date.now() - started < 4000, "every request was answered without waiting on the FIFO");
});

test("a remote save checks the version without any SHA-256 tool on the device", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, "minimal.txt");
  await writeFile(file, "minimal\n");
  // A device whose PATH holds only the basic tools the save needs.
  const bin = path.join(base, "bin");
  await mkdir(bin);
  for (const tool of ["realpath", "readlink", "tr", "cmp", "iconv", "ls", "awk", "mktemp", "dirname", "cat", "head", "wc", "chmod", "chown", "stat", "sync", "mv", "rm"]) {
    const found = childProcess.execFileSync("sh", ["-c", `command -v ${tool} || :`], { encoding: "utf8" }).trim();
    if (found) await symlink(found, path.join(bin, tool));
  }
  const restricted = (command) => `PATH=${"'" + bin + "'"}; export PATH; ${command}`;
  assert.equal(childProcess.execFileSync("sh", ["-c", restricted("command -v sha256sum shasum openssl || echo none")], { encoding: "utf8" }).trim(), "none");
  localSsh(t, restricted);
  const opened = (await read(file, "devbox")).body.sha256;
  assert.equal(opened, sha256("minimal\n"));
  assert.deepEqual(await write({ path: file, content: "saved ✓\n", host: "devbox", expectedSha256: opened }), { status: 200, body: { ok: true, sha256: sha256("saved ✓\n") } });
  assert.equal(await readFile(file, "utf8"), "saved ✓\n");
  await writeFile(file, "changed elsewhere\n");
  const refused = await write({ path: file, content: "stale\n", host: "devbox", expectedSha256: opened });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "changed");
  assert.equal(refused.body.sha256, sha256("changed elsewhere\n"));
  assert.equal(await readFile(file, "utf8"), "changed elsewhere\n");
  assert.deepEqual((await readdir(base)).sort(), ["bin", "minimal.txt"]);
});

test("non-UTF-8 and binary files open read-only and are never written over", async (t) => {
  const base = await fixture(t);
  const latin = path.join(base, "legacy.txt");
  const binary = path.join(base, "data.sqlite");
  await writeFile(latin, LATIN1);
  await writeFile(binary, Buffer.from([0x53, 0x51, 0x4c, 0x00, 0x01, 0xff]));
  assert.deepEqual(await read(latin), { status: 200, body: { path: latin, content: "", binary: true } });
  assert.deepEqual(await read(binary), { status: 200, body: { path: binary, content: "", binary: true } });
  for (const file of [latin, binary]) {
    const result = await write({ path: file, content: "caf�\n" });
    assert.equal(result.status, 409);
    assert.match(result.body.error, /not UTF-8 text/);
  }
  assert.deepEqual(await readFile(latin), LATIN1);
  assert.deepEqual(await readFile(binary), Buffer.from([0x53, 0x51, 0x4c, 0x00, 0x01, 0xff]));
  assert.equal((await write({ path: path.join(base, "x.txt"), content: 5 })).status, 400);
  for (const body of [null, [], "text"]) {
    const response = await fetch(`${endpoint}/file/write`, { method: "POST", body: JSON.stringify(body) });
    assert.equal(response.status, 400, JSON.stringify(body));
  }
});

test("a project folder linked outside home opens and saves; links never reach credentials or write through a dangling link", async (t) => {
  const base = await fixture(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "pzza-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const project = path.join(outside, "project.txt");
  await writeFile(project, "on another volume\n");
  const linkedFolder = path.join(base, "linked");
  await symlink(outside, linkedFolder);
  const viaLink = path.join(linkedFolder, "project.txt");
  const opened = await read(viaLink);
  assert.equal(opened.status, 200);
  assert.equal(opened.body.content, "on another volume\n");
  assert.equal((await fetch(`${endpoint}/file/raw?path=${encodeURIComponent(viaLink)}`)).status, 200);
  assert.equal((await write({ path: viaLink, content: "edited\n", expectedSha256: opened.body.sha256 })).status, 200);
  assert.equal(await readFile(project, "utf8"), "edited\n");
  assert.equal((await write({ path: path.join(linkedFolder, "new.txt"), content: "created\n" })).status, 200);
  assert.deepEqual((await readdir(outside)).sort(), ["new.txt", "project.txt"]);
  // The agent's own token is refused wherever its config folder lives.
  const token = path.join(state, "pzzacode", "agent-token");
  await mkdir(path.dirname(token), { recursive: true });
  await writeFile(token, "token\n");
  const tokenLink = path.join(base, "token");
  await symlink(token, tokenLink);
  assert.equal((await read(tokenLink)).status, 403);
  assert.equal((await write({ path: tokenLink, content: "x\n" })).status, 403);
  assert.equal(await readFile(token, "utf8"), "token\n");
  // A dangling link is never written through.
  const dangling = path.join(base, "dangling.txt");
  await symlink(path.join(outside, "missing.txt"), dangling);
  assert.equal((await write({ path: dangling, content: "x\n" })).status, 403);
  assert.deepEqual((await readdir(outside)).sort(), ["new.txt", "project.txt"]);
  // A link that stays inside home still works and edits its target.
  const target = path.join(base, "target.txt");
  await writeFile(target, "inside\n");
  await symlink(target, path.join(base, "inside-link.txt"));
  assert.equal((await read(path.join(base, "inside-link.txt"))).body.content, "inside\n");
  assert.equal((await write({ path: path.join(base, "inside-link.txt"), content: "edited\n" })).status, 200);
  assert.equal(await readFile(target, "utf8"), "edited\n");
});

test("the real-path guard refuses links into credential stores under home", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pzza-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previous; });
  const realHome = await import("node:fs").then(({ realpathSync }) => realpathSync.native(home));
  await mkdir(path.join(home, ".ssh"));
  await writeFile(path.join(home, ".ssh", "id_ed25519"), "private key\n");
  await mkdir(path.join(home, "project"));
  await writeFile(path.join(home, "project", "file.txt"), "text\n");
  await symlink(path.join(home, ".ssh", "id_ed25519"), path.join(home, "project", "key"));
  await symlink(path.join(home, ".ssh"), path.join(home, "project", "keys"));
  assert.equal(realSafePath(path.join(home, "project", "key")), null);
  assert.equal(realSafePath(path.join(home, "project", "keys", "id_ed25519")), null);
  assert.equal(realSafePath("~/project/key"), null);
  assert.equal(realSafePath(path.join(home, "project", "file.txt")), path.join(realHome, "project", "file.txt"));
  assert.equal(realSafePath(path.join(home, "project", "new.txt")), path.join(realHome, "project", "new.txt"));
  // A folder linked to another volume resolves to its real target.
  const volume = await mkdtemp(path.join(os.tmpdir(), "pzza-volume-"));
  t.after(() => rm(volume, { recursive: true, force: true }));
  await symlink(volume, path.join(home, "project", "volume"));
  assert.equal(realSafePath(path.join(home, "project", "volume", "file.txt")), path.join(fs.realpathSync.native(volume), "file.txt"));
  // A link whose target goes through it back into a key store is still refused.
  await symlink(path.join(home, ".ssh", "id_ed25519"), path.join(volume, "key"));
  assert.equal(realSafePath(path.join(home, "project", "volume", "key")), null);
  assert.throws(() => realSafePath(path.join(home, "missing", "new.txt")), { code: "ENOENT" });
});

test("remote saves stream into a temporary file and replace the target only when complete", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, "remote.txt");
  await writeFile(file, "remote original\n");
  await chmod(file, 0o604);
  localSsh(t);
  assert.deepEqual(await write({ path: file, content: "remote ✓ saved\n", host: "devbox" }), { status: 200, body: { ok: true, sha256: sha256("remote ✓ saved\n") } });
  assert.equal(await readFile(file, "utf8"), "remote ✓ saved\n");
  assert.equal((await stat(file)).mode & 0o777, 0o604);
  assert.deepEqual(await readdir(base), ["remote.txt"]);
  // A new file gets the device's normal permissions. (Run past the guard: its
  // path resolution for a file that does not exist yet needs GNU realpath.)
  const created = path.join(base, "created.txt");
  await new Promise((resolve, reject) => {
    const child = childProcess.execFile("sh", ["-c", `p=${"'" + created + "'"}; ${remoteWriteScript(4)}`], (error) => (error ? reject(error) : resolve()));
    child.stdin.end("new\n");
  });
  assert.equal(await readFile(created, "utf8"), "new\n");
  assert.equal((await stat(created)).mode & 0o777, 0o666 & ~process.umask());
  // Non-UTF-8 content on the device is refused, read and write.
  const latin = path.join(base, "legacy.txt");
  await writeFile(latin, LATIN1);
  assert.deepEqual(await read(latin, "devbox"), { status: 200, body: { path: latin, content: "", binary: true } });
  assert.equal((await write({ path: latin, content: "caf�\n", host: "devbox" })).status, 409);
  assert.deepEqual(await readFile(latin), LATIN1);
  assert.equal((await write({ path: base, content: "x", host: "devbox" })).status, 400);
});

test("a connection that drops mid-transfer leaves the remote file untouched", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, "remote.txt");
  await writeFile(file, "remote original\n");
  // Only the first bytes reach the device, then the stream ends.
  localSsh(t, (command) => `head -c 7 | sh -c ${"'" + command.replace(/'/g, "'\\''") + "'"}`);
  const result = await write({ path: file, content: "x".repeat(200_000), host: "devbox" });
  assert.equal(result.status, 500);
  assert.match(result.body.error, /left unchanged/);
  assert.equal(await readFile(file, "utf8"), "remote original\n");
  assert.deepEqual(await readdir(base), ["remote.txt"]);
});

test("an unreachable device never crashes the agent with EPIPE on a large save", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, "remote.txt");
  await writeFile(file, "remote original\n");
  // ssh exits before reading stdin, as it does when the device is offline.
  localSsh(t, () => "exit 255");
  for (let attempt = 0; attempt < 3; attempt++) {
    const result = await write({ path: file, content: "y".repeat(1024 * 1024), host: "devbox" });
    assert.equal(result.status, 500);
  }
  assert.equal(await readFile(file, "utf8"), "remote original\n");
  assert.equal((await fetch(`${endpoint}/file/read?path=${encodeURIComponent(file)}`)).status, 200, "the agent is still serving");
});

test("reads report the version of the file's bytes, and only for text the editor can save", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, "versioned.txt");
  await writeFile(file, "version one ✓\n");
  assert.deepEqual(await read(file), { status: 200, body: { path: file, content: "version one ✓\n", sha256: sha256("version one ✓\n") } });
  const marked = path.join(base, "marked.txt");
  await writeFile(marked, Buffer.from([0xef, 0xbb, 0xbf, 0x61]));
  assert.equal((await read(marked)).body.sha256, sha256(Buffer.from([0xef, 0xbb, 0xbf, 0x61])), "raw bytes, byte-order mark included");
  const latin = path.join(base, "legacy.txt");
  await writeFile(latin, LATIN1);
  assert.equal("sha256" in (await read(latin)).body, false);
  const large = path.join(base, "large.txt");
  await writeFile(large, "x".repeat(2 * 1024 * 1024 + 1));
  assert.deepEqual(await read(large), { status: 200, body: { path: large, content: "", tooLarge: true } });
  localSsh(t);
  assert.deepEqual(await read(file, "devbox"), { status: 200, body: { path: file, content: "version one ✓\n", sha256: sha256("version one ✓\n") } });
  assert.equal("sha256" in (await read(latin, "devbox")).body, false);
  assert.deepEqual(await read(large, "devbox"), { status: 200, body: { path: large, content: "", tooLarge: true } });
});

test("a local save based on an older version is refused and changes nothing", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, "shared.txt");
  await writeFile(file, "opened\n");
  const opened = (await read(file)).body.sha256;
  // The same version: saved, and the new version comes back.
  const saved = await write({ path: file, content: "mine\n", expectedSha256: opened });
  assert.deepEqual(saved, { status: 200, body: { ok: true, sha256: sha256("mine\n") } });
  // Another program wrote since: refused with the version on disk.
  await writeFile(file, "the agent's edit\n");
  const refused = await write({ path: file, content: "stale\n", expectedSha256: saved.body.sha256 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "changed");
  assert.equal(refused.body.sha256, sha256("the agent's edit\n"));
  assert.match(refused.body.error, /changed on disk/);
  assert.equal(await readFile(file, "utf8"), "the agent's edit\n");
  assert.deepEqual(await readdir(base), ["shared.txt"], "no temporary file is left");
  // Deleted since it was opened: refused, not recreated.
  const gone = path.join(base, "gone.txt");
  const missing = await write({ path: gone, content: "x\n", expectedSha256: sha256("was here\n") });
  assert.equal(missing.status, 409);
  assert.equal(missing.body.code, "changed");
  assert.equal("sha256" in missing.body, false);
  assert.deepEqual(await readdir(base), ["shared.txt"]);
  // Without a version the save is unconditional, as before.
  assert.equal((await write({ path: file, content: "overwrite\n" })).status, 200);
  assert.equal(await readFile(file, "utf8"), "overwrite\n");
  for (const expectedSha256 of ["abc", sha256("x").toUpperCase(), 5, null]) {
    const result = await write({ path: file, content: "bad\n", expectedSha256 });
    assert.equal(result.status, 400, JSON.stringify(expectedSha256));
  }
  assert.equal(await readFile(file, "utf8"), "overwrite\n");
});

test("a remote save based on an older version is refused on the device and changes nothing", async (t) => {
  const base = await fixture(t);
  const file = path.join(base, "remote.txt");
  await writeFile(file, "remote opened\n");
  localSsh(t);
  const opened = (await read(file, "devbox")).body.sha256;
  const saved = await write({ path: file, content: "remote mine\n", host: "devbox", expectedSha256: opened });
  assert.deepEqual(saved, { status: 200, body: { ok: true, sha256: sha256("remote mine\n") } });
  assert.equal(await readFile(file, "utf8"), "remote mine\n");
  await writeFile(file, "remote agent edit\n");
  const refused = await write({ path: file, content: "remote stale\n", host: "devbox", expectedSha256: saved.body.sha256 });
  assert.equal(refused.status, 409);
  assert.equal(refused.body.code, "changed");
  assert.equal(refused.body.sha256, sha256("remote agent edit\n"));
  assert.equal(await readFile(file, "utf8"), "remote agent edit\n");
  assert.deepEqual(await readdir(base), ["remote.txt"], "the temporary file is removed");
  // Deleted since it was opened: exit 6 with no version, nothing created. (Run
  // past the guard: its path resolution for a missing file needs GNU realpath.)
  const gone = path.join(base, "gone.txt");
  const exit = await new Promise((resolve) => {
    const child = childProcess.execFile("sh", ["-c", `p=${"'" + gone + "'"}; ${remoteWriteScript(2, opened)}`], (error, stdout) => resolve({ code: error?.code ?? 0, stdout }));
    child.stdin.end("x\n");
  });
  assert.deepEqual(exit, { code: 6, stdout: "" });
  assert.deepEqual(await readdir(base), ["remote.txt"]);
  assert.throws(() => remoteWriteScript(1, "'; rm -rf ~; '"), /invalid file version/);
});
