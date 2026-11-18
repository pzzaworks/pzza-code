import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { once } from "node:events";
import fs from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";

// Files and folders the user opened in the app from outside home: the editor
// may read, save and list exactly those, granted only through the desktop
// app's own stdin pipe.
const state = await mkdtemp(path.join(os.tmpdir(), "pzza-opened-state-"));
process.env.XDG_CONFIG_HOME = state;
const { filesRouter } = await import("../lib/files.js");
const { listFilesLocal } = await import("../lib/code-search.js");
const { desktopMessage, forgetOpenedPaths, grantOpenedPath, openedPaths, OPENED_PATH_LIMIT, realSafePath } = await import("../lib/paths.js");
const { DESKTOP_MESSAGE_LIMIT, readDesktopMessages } = await import("../lib/agent-lifecycle.js");

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

const REFUSED = "Drop the file onto PzzaCode or open it from Finder to work on it here.";

// A folder outside home, as the temporary folder macOS hands out: reached
// through /var while its real path is under /private/var.
async function outside(t, name = "pzza-opened-") {
  const folder = await mkdtemp(path.join(os.tmpdir(), name));
  t.after(() => rm(folder, { recursive: true, force: true }));
  forgetOpenedPaths();
  t.after(forgetOpenedPaths);
  return folder;
}

const real = (p) => fs.realpathSync.native(p);

async function read(file) {
  const response = await fetch(`${endpoint}/file/read?path=${encodeURIComponent(file)}`);
  return { status: response.status, body: await response.json() };
}

async function raw(file) {
  const response = await fetch(`${endpoint}/file/raw?path=${encodeURIComponent(file)}`);
  return response.status;
}

async function write(file, content) {
  const response = await fetch(`${endpoint}/file/write`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: file, content }) });
  return { status: response.status, body: await response.json() };
}

async function list(folder) {
  const response = await fetch(`${endpoint}/fs/list?path=${encodeURIComponent(folder)}`);
  return { status: response.status, body: await response.json() };
}

test("a file opened from outside home reads and saves; one never opened is refused", async (t) => {
  const folder = await outside(t);
  const opened = path.join(folder, "dropped.txt");
  const other = path.join(folder, "other.txt");
  await writeFile(opened, "dropped\n");
  await writeFile(other, "other\n");
  assert.deepEqual(await read(opened), { status: 403, body: { error: REFUSED } });
  assert.equal((await write(opened, "x\n")).status, 403);
  assert.equal(await readFile(opened, "utf8"), "dropped\n");

  // The app sends the real path; the editor may ask by either spelling.
  desktopMessage({ type: "grant", path: real(opened), folder: false });
  for (const spelling of [opened, real(opened)]) {
    const result = await read(spelling);
    assert.equal(result.status, 200);
    assert.equal(result.body.content, "dropped\n");
    assert.equal(result.body.path, real(opened));
  }
  assert.equal(await raw(opened), 200);
  assert.equal((await write(opened, "saved\n")).status, 200);
  assert.equal(await readFile(opened, "utf8"), "saved\n");

  // Exactly that file: not its neighbours, not new files beside it.
  assert.deepEqual(await read(other), { status: 403, body: { error: REFUSED } });
  assert.equal((await write(other, "x\n")).status, 403);
  assert.equal((await write(path.join(folder, "new.txt"), "x\n")).status, 403);
  assert.deepEqual((await readdir(folder)).sort(), ["dropped.txt", "other.txt"]);
  assert.equal(await readFile(other, "utf8"), "other\n");
  // Its folder does not list either; home stands in, as for any refused folder.
  assert.equal((await list(folder)).body.path, os.homedir());
});

test("a folder opened from outside home grants its tree and nothing beside it", async (t) => {
  const parent = await outside(t);
  const tree = path.join(parent, "tree");
  const sibling = path.join(parent, "tree-sibling");
  await mkdir(path.join(tree, "src"), { recursive: true });
  await mkdir(sibling);
  await writeFile(path.join(tree, "src", "main.ts"), "export {};\n");
  await writeFile(path.join(sibling, "secret.txt"), "sibling\n");
  grantOpenedPath(real(tree), true);

  assert.equal((await read(path.join(tree, "src", "main.ts"))).body.content, "export {};\n");
  assert.equal((await write(path.join(tree, "src", "main.ts"), "edited\n")).status, 200);
  assert.equal((await write(path.join(tree, "src", "new.ts"), "created\n")).status, 200);
  assert.equal(await readFile(path.join(tree, "src", "new.ts"), "utf8"), "created\n");
  const listed = await list(tree);
  assert.equal(listed.status, 200);
  assert.equal(listed.body.path, real(tree));
  assert.deepEqual(listed.body.entries, [{ name: "src", dir: true }]);
  assert.deepEqual((await list(path.join(tree, "src"))).body.entries.map((entry) => entry.name), ["main.ts", "new.ts"]);
  const files = await listFilesLocal(tree, { rg: "pzza-no-such-tool" });
  assert.deepEqual(files.files, ["src/main.ts", "src/new.ts"]);

  // A sibling whose name starts the same, the parent and paths climbing out are refused.
  assert.equal((await read(path.join(sibling, "secret.txt"))).status, 403);
  assert.equal((await write(path.join(sibling, "new.txt"), "x\n")).status, 403);
  assert.equal((await read(path.join(tree, "..", "tree-sibling", "secret.txt"))).status, 403);
  assert.equal((await list(sibling)).body.path, os.homedir());
  assert.equal((await list(parent)).body.path, os.homedir());
  await assert.rejects(listFilesLocal(sibling), { status: 403 });
  assert.deepEqual(await readdir(sibling), ["secret.txt"]);
});

test("links inside an opened folder never lead out of it, and never write through a dangling link", async (t) => {
  const parent = await outside(t);
  const tree = path.join(parent, "tree");
  const elsewhere = path.join(parent, "elsewhere");
  await mkdir(tree);
  await mkdir(elsewhere);
  await writeFile(path.join(elsewhere, "target.txt"), "elsewhere\n");
  await writeFile(path.join(tree, "inside.txt"), "inside\n");
  await symlink(path.join(elsewhere, "target.txt"), path.join(tree, "file-link"));
  await symlink(elsewhere, path.join(tree, "folder-link"));
  await symlink(path.join(tree, "inside.txt"), path.join(tree, "inside-link"));
  await symlink(path.join(elsewhere, "missing.txt"), path.join(tree, "dangling"));
  grantOpenedPath(real(tree), true);

  for (const escaping of [path.join(tree, "file-link"), path.join(tree, "folder-link", "target.txt"), path.join(tree, "folder-link", "new.txt")]) {
    assert.equal((await read(escaping)).status, 403, escaping);
    assert.equal((await write(escaping, "x\n")).status, 403, escaping);
  }
  assert.equal((await list(path.join(tree, "folder-link"))).body.path, os.homedir());
  assert.equal(await readFile(path.join(elsewhere, "target.txt"), "utf8"), "elsewhere\n");
  // A link that stays inside the folder edits its target.
  assert.equal((await write(path.join(tree, "inside-link"), "edited\n")).status, 200);
  assert.equal(await readFile(path.join(tree, "inside.txt"), "utf8"), "edited\n");
  // A dangling link is never written through, even to a place inside.
  assert.equal((await write(path.join(tree, "dangling"), "x\n")).status, 403);
  assert.deepEqual(await readdir(elsewhere), ["target.txt"]);
});

test("credential stores and the agent token stay refused inside an opened folder", async (t) => {
  // The opened folder holds a whole home (as opening / would).
  const root = await outside(t);
  const home = path.join(root, "home");
  const previous = process.env.HOME;
  process.env.HOME = home;
  t.after(() => { process.env.HOME = previous; });
  await mkdir(path.join(home, ".ssh"), { recursive: true });
  await writeFile(path.join(home, ".ssh", "id_ed25519"), "private key\n");
  await writeFile(path.join(home, "notes.txt"), "notes\n");
  await symlink(path.join(home, ".ssh"), path.join(root, "keys"));
  await symlink(path.join(home, ".ssh", "id_ed25519"), path.join(root, "key"));
  const token = path.join(state, "pzzacode", "agent-token");
  await mkdir(path.dirname(token), { recursive: true });
  await writeFile(token, "token\n");
  await symlink(token, path.join(root, "token"));
  grantOpenedPath(real(root), true);
  grantOpenedPath(real(path.join(home, ".ssh", "id_ed25519")), false);
  grantOpenedPath(real(token), false);

  for (const denied of [
    path.join(home, ".ssh", "id_ed25519"),
    path.join(root, "keys", "id_ed25519"),
    path.join(root, "key"),
    path.join(root, "token"),
    real(token),
  ]) {
    assert.equal(realSafePath(denied), null, denied);
    assert.equal((await read(denied)).status, 403, denied);
    assert.equal((await write(denied, "x\n")).status, 403, denied);
  }
  assert.equal(await readFile(path.join(home, ".ssh", "id_ed25519"), "utf8"), "private key\n");
  assert.equal(await readFile(token, "utf8"), "token\n");
  // Home itself still works by its own rules.
  assert.equal((await read(path.join(home, "notes.txt"))).body.content, "notes\n");
});

test("grants are bounded: the oldest is forgotten first, a repeat becomes the newest", async (t) => {
  const folder = await outside(t);
  const first = path.join(folder, "first.txt");
  await writeFile(first, "first\n");
  grantOpenedPath(real(first), false);
  for (let index = 0; index < OPENED_PATH_LIMIT - 1; index++) grantOpenedPath(`/pzza-test/${index}`, false);
  // Opened again: it is the newest now, so the next grant forgets another.
  grantOpenedPath(real(first), false);
  grantOpenedPath("/pzza-test/extra", true);
  assert.equal(openedPaths().length, OPENED_PATH_LIMIT);
  assert.equal(openedPaths()[0].path, "/pzza-test/1");
  assert.equal((await read(first)).status, 200);
  for (let index = 0; index < OPENED_PATH_LIMIT; index++) grantOpenedPath(`/pzza-test/more-${index}`, false);
  assert.equal(openedPaths().length, OPENED_PATH_LIMIT);
  assert.equal((await read(first)).status, 403);
});

test("only well-formed grant messages grant anything", async (t) => {
  await outside(t);
  for (const message of [
    { type: "grant", path: "relative/path", folder: true },
    { type: "grant", path: "/a\0b", folder: false },
    { type: "grant", path: `/${"a".repeat(4096)}`, folder: false },
    { type: "grant", path: 42 },
    { type: "revoke", path: "/tmp" },
    null,
  ]) desktopMessage(message);
  assert.deepEqual(openedPaths(), []);
  desktopMessage({ type: "grant", path: "/pzza-test/folder", folder: "yes" });
  assert.deepEqual(openedPaths(), [{ path: "/pzza-test/folder", folder: false }], "only folder: true grants a tree");
});

test("desktop messages are whole JSON lines, however the pipe splits them", () => {
  const stream = new PassThrough();
  const messages = [];
  readDesktopMessages(stream, (message) => messages.push(message));
  stream.write('{"type":"grant","pa');
  stream.write('th":"/a","folder":true}\n{"type":"grant","path":"/b"}\nnot json\n[1]\n');
  stream.write(`{"type":"grant","path":"/${"x".repeat(DESKTOP_MESSAGE_LIMIT)}`);
  stream.write('"}\n{"type":"grant","path":"/c"}\n');
  stream.write('{"type":"grant","path":"/unfinished"}');
  assert.deepEqual(messages, [
    { type: "grant", path: "/a", folder: true },
    { type: "grant", path: "/b" },
    { type: "grant", path: "/c" },
  ]);
});

// The real agent wiring in a child: stdin is the app's pipe, HTTP is what
// any token holder (the webview, MCP, app-control) can reach.
const AGENT = `
  import http from "node:http";
  import { watchDesktopLifetime } from ${JSON.stringify(new URL("../lib/agent-lifecycle.js", import.meta.url).href)};
  import { desktopMessage } from ${JSON.stringify(new URL("../lib/paths.js", import.meta.url).href)};
  import { filesRouter } from ${JSON.stringify(new URL("../lib/files.js", import.meta.url).href)};
  const server = http.createServer((req, res) => {
    filesRouter(req, res, new URL(req.url, "http://localhost")).then((handled) => { if (!handled) res.writeHead(404).end(); });
  });
  server.listen(0, "127.0.0.1", () => process.stdout.write(server.address().port + "\\n"));
  watchDesktopLifetime(() => process.exit(0), desktopMessage);
`;

test("only the app's stdin pipe grants; nothing over HTTP does", { timeout: 20_000 }, async (t) => {
  const folder = await outside(t);
  const file = path.join(folder, "dropped.txt");
  await writeFile(file, "dropped\n");
  const agent = spawn(process.execPath, ["--input-type=module", "-e", AGENT], {
    env: { ...process.env, PZZA_MANAGED_AGENT: "1", XDG_CONFIG_HOME: state },
    stdio: ["pipe", "pipe", "inherit"],
  });
  t.after(() => agent.kill("SIGKILL"));
  const [line] = await once(agent.stdout, "data");
  const base = `http://127.0.0.1:${String(line).trim()}`;
  const readThere = async () => (await fetch(`${base}/file/read?path=${encodeURIComponent(file)}`)).status;
  assert.equal(await readThere(), 403);
  // Whatever an HTTP caller sends, wherever, carries no grant.
  const grant = JSON.stringify({ type: "grant", path: real(file), folder: false });
  for (const route of ["/grant", "/opened", "/file/grant", "/fs/grant", "/file/write", "/fs/list"]) {
    await fetch(`${base}${route}`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer guessed" }, body: grant }).then((response) => response.arrayBuffer());
  }
  assert.equal(await readThere(), 403);
  // The app's pipe does.
  agent.stdin.write(`${grant}\n`);
  let status = 403;
  for (let attempt = 0; attempt < 50 && status !== 200; attempt++) {
    status = await readThere();
    if (status !== 200) await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.equal(status, 200);
  // Closing the pipe still ends the agent.
  const exited = once(agent, "exit");
  agent.stdin.end();
  assert.deepEqual(await exited, [0, null]);
});
