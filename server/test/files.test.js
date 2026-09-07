import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, lstat, symlink } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { FILE_MUTATION_SCRIPT } from "../lib/file-mutations.js";

const state = await mkdtemp(path.join(tmpdir(), "pzza-files-state-"));
process.env.XDG_CONFIG_HOME = state;
const { filesRouter } = await import("../lib/files.js");
const server = createServer((req, res) => {
  filesRouter(req, res, new URL(req.url, "http://localhost")).then((handled) => {
    if (!handled) res.writeHead(404).end();
  }).catch(() => res.writeHead(500).end());
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const address = server.address();
const endpoint = `http://127.0.0.1:${address.port}`;
test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(state, { recursive: true, force: true });
});

async function fixture(t) {
  const base = await mkdtemp(path.join(homedir(), ".pzza-files-test-"));
  t.after(() => rm(base, { recursive: true, force: true }));
  const root = path.join(base, "project");
  await mkdir(root);
  return { base, root };
}

async function request(operation, body) {
  const response = await fetch(`${endpoint}/fs/${operation}`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

async function missing(file) {
  await assert.rejects(lstat(file), { code: "ENOENT" });
}

test("move renames files and directories without shell expansion and returns canonical destination", async (t) => {
  const { root } = await fixture(t);
  const source = path.join(root, "a 'quoted' $(ignored).txt");
  const destination = path.join(root, "renamed.txt");
  await writeFile(source, "content\n");
  assert.deepEqual(await request("move", { root, path: source, destination }), { status: 200, body: { path: destination } });
  assert.equal(await readFile(destination, "utf8"), "content\n");
  await missing(source);
  const folder = path.join(root, "folder");
  await mkdir(folder);
  await writeFile(path.join(folder, "child"), "child\n");
  const moved = path.join(root, "moved");
  assert.equal((await request("move", { root, path: folder, destination: moved })).status, 200);
  assert.equal(await readFile(path.join(moved, "child"), "utf8"), "child\n");
});

test("moves never overwrite existing files or directories, including concurrent destination creation", async (t) => {
  const { root } = await fixture(t);
  const source = path.join(root, "source");
  const destination = path.join(root, "destination");
  await writeFile(source, "source\n");
  await writeFile(destination, "existing\n");
  assert.equal((await request("move", { root, path: source, destination })).status, 409);
  assert.equal(await readFile(destination, "utf8"), "existing\n");
  await rm(destination);
  await mkdir(destination);
  assert.equal((await request("move", { root, path: source, destination })).status, 409);
  assert.equal(await readFile(source, "utf8"), "source\n");
  assert.deepEqual(await readdir(destination), []);
  await rm(destination, { recursive: true });
  const second = path.join(root, "second");
  await writeFile(second, "second\n");
  const outcomes = await Promise.all([source, second].map((file) => request("move", { root, path: file, destination })));
  assert.deepEqual(outcomes.map((result) => result.status).sort(), [200, 409]);
  const loser = outcomes[0].status === 409 ? source : second;
  assert.ok((await lstat(loser)).isFile());
  assert.notEqual(await readFile(loser, "utf8"), await readFile(destination, "utf8"));
});

test("root changes, traversal, outside destinations, self moves and Git metadata are refused", async (t) => {
  const { base, root } = await fixture(t);
  const source = path.join(root, "file");
  await writeFile(source, "keep\n");
  for (const target of [root, `${root}/../project/file`, path.join(base, "outside")]) {
    assert.ok((await request("delete", { root, path: target })).status >= 400);
    assert.ok((await request("move", { root, path: source, destination: target })).status >= 400);
  }
  const folder = path.join(root, "folder");
  await mkdir(folder);
  assert.equal((await request("move", { root, path: folder, destination: path.join(folder, "child") })).status, 409);
  const metadata = path.join(root, ".git");
  await mkdir(metadata);
  await writeFile(path.join(metadata, "config"), "fixture\n");
  for (const target of [metadata, path.join(metadata, "config")]) {
    assert.equal((await request("delete", { root, path: target })).status, 403);
    assert.equal((await request("move", { root, path: target, destination: path.join(root, "other") })).status, 403);
  }
  assert.equal((await request("move", { root, path: source, destination: path.join(metadata, "other") })).status, 403);
  assert.equal(await readFile(source, "utf8"), "keep\n");
});

test("directory symlinks cannot escape the root; deleting a final symlink leaves its target intact", async (t) => {
  const { base, root } = await fixture(t);
  const outside = path.join(base, "outside");
  await mkdir(outside);
  const kept = path.join(outside, "kept");
  await writeFile(kept, "keep\n");
  const link = path.join(root, "link");
  await symlink(outside, link);
  assert.equal((await request("delete", { root, path: path.join(link, "kept") })).status, 403);
  const source = path.join(root, "source");
  await writeFile(source, "source\n");
  assert.equal((await request("move", { root, path: source, destination: path.join(link, "created") })).status, 403);
  assert.equal((await request("move", { root, path: link, destination: path.join(root, "other-link") })).status, 403);
  assert.deepEqual(await request("delete", { root, path: link }), { status: 200, body: { ok: true } });
  assert.equal(await readFile(kept, "utf8"), "keep\n");
  await missing(link);
  const external = await mkdtemp("/tmp/pzza-files-outside-");
  t.after(() => rm(external, { recursive: true, force: true }));
  const alias = path.join(base, "outside-home");
  await symlink(external, alias);
  await writeFile(path.join(external, "kept"), "outside\n");
  assert.equal((await request("delete", { root: alias, path: path.join(alias, "kept") })).status, 403);
  assert.equal(await readFile(path.join(external, "kept"), "utf8"), "outside\n");
});

test("recursive deletion removes selected tree without following symlinks and preflights nested Git metadata", async (t) => {
  const { base, root } = await fixture(t);
  const outside = path.join(base, "kept");
  await writeFile(outside, "keep\n");
  const tree = path.join(root, "tree");
  await mkdir(path.join(tree, "nested"), { recursive: true });
  await writeFile(path.join(tree, "nested", "file"), "delete\n");
  await symlink(outside, path.join(tree, "outside-link"));
  assert.equal((await request("delete", { root, path: tree })).status, 200);
  await missing(tree);
  assert.equal(await readFile(outside, "utf8"), "keep\n");
  await mkdir(path.join(tree, ".git"), { recursive: true });
  await writeFile(path.join(tree, "regular"), "keep\n");
  assert.equal((await request("delete", { root, path: tree })).status, 403);
  assert.equal((await request("move", { root, path: tree, destination: path.join(root, "elsewhere") })).status, 403);
  assert.equal(await readFile(path.join(tree, "regular"), "utf8"), "keep\n");
});

test("invalid device hosts and non-POST requests fail closed without changing local files", async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, "file");
  await writeFile(file, "keep\n");
  for (const host of ["-oProxyCommand=bad", "bad host", {}, 1, null]) {
    assert.equal((await request("delete", { root, path: file, host })).status, 400);
    assert.equal((await request("move", { root, path: file, destination: path.join(root, "other"), host })).status, 400);
  }
  assert.equal((await fetch(`${endpoint}/fs/delete`)).status, 405);
  assert.equal(await readFile(file, "utf8"), "keep\n");
});


test("SSH requests execute the same guarded mutations with safely quoted script transport", async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, "remote 'quoted' file");
  const destination = path.join(root, "remote destination");
  await writeFile(file, "transport fixture\n");
  const execute = childProcess.execFile;
  let remoteCalls = 0;
  const transport = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    if (command !== "ssh") return execute(command, args, options, callback);
    assert.equal(args.at(-2), "test-device");
    remoteCalls++;
    return execute("sh", ["-c", args.at(-1)], options, callback);
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await request("move", { root, path: file, destination, host: "test-device" }), {
      status: 200, body: { path: destination },
    });
    assert.equal(await readFile(destination, "utf8"), "transport fixture\n");
    assert.equal((await request("delete", { root, path: destination, host: "test-device" })).status, 200);
    await missing(destination);
    assert.equal(remoteCalls, 2);
  } finally {
    transport.mock.restore();
    syncBuiltinESMExports();
  }
});

test("missing Python runtime fails explicitly without touching the selected file", async (t) => {
  const { root } = await fixture(t);
  const file = path.join(root, "file");
  await writeFile(file, "keep\n");
  const previousPath = process.env.PATH;
  process.env.PATH = root;
  try {
    const result = await request("delete", { root, path: file });
    assert.equal(result.status, 501);
    assert.match(result.body.error, /Python 3 is required/);
    assert.equal(await readFile(file, "utf8"), "keep\n");
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
  }
});


test("mutation guards preserve existing protected user stores and system keychains", async () => {
  const script = `import json, sys
scope = {"__name__": "mutation_guard_test"}
exec(json.load(sys.stdin)["script"], scope)
protected = scope["protected"]
refused = scope["Refused"]
for location in [".ssh", ".ssh/key", ".gnupg", ".aws/config", ".config/pzzacode/agent-token", ".claude/.credentials.json", ".codex/auth.json", "Library/Keychains", "Library/Keychains/fixture"]:
    try:
        protected("/fixture/home", "/fixture/home/" + location)
    except refused:
        continue
    raise AssertionError("Protected store was accepted")
protected("/fixture/home", "/fixture/home/projects/app/source.py")
print("ok")
`;
  const output = await new Promise((resolve, reject) => {
    const child = childProcess.execFile("python3", ["-c", script], { timeout: 5_000 }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
    child.stdin.end(JSON.stringify({ script: FILE_MUTATION_SCRIPT }));
  });
  assert.equal(output.trim(), "ok");
});
