import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeviceSession } from "../lib/session-create.js";
import { shQuote } from "../lib/shell.js";
import { SESSION_NAME_MAX_LENGTH } from "../lib/session-name.js";
import { validateAppCommand } from "../lib/app-control-schema.js";
const exec = promisify(execFile);

test("session creation rejects invalid targets, malformed accounts and extra inputs before executing", async () => {
  let called = false;
  const run = () => { called = true; throw new Error("Unexpected process"); };
  for (const body of [null, [], { name: "bad:name" }, { name: "valid", host: "-oProxyCommand=bad" }, { name: "valid", cwd: "relative" }, { name: "valid", account: { provider: "other", dir: "/account" } }, { name: "valid", account: { provider: "codex", dir: "/account", extra: true } }, { name: "valid", extra: true }]) {
    await assert.rejects(createDeviceSession(body, run), { status: 400 });
  }
  assert.equal(called, false);
});

test("session names enforce the character limit and reject unsafe characters before executing", async () => {
  const run = () => { throw new Error("Unexpected process"); };
  for (const name of ["", "   ", "x".repeat(SESSION_NAME_MAX_LENGTH + 1), "tab\tname", "line\nname", "name\n", "name\r", "name\0", "a:b", "a.b", "$(touch bad)", "semi;colon"]) {
    await assert.rejects(createDeviceSession({ name }, run), { status: 400 });
  }
  await assert.rejects(createDeviceSession({ name: "x".repeat(SESSION_NAME_MAX_LENGTH + 1) }, run), /at most 128 characters/);
  for (const name of ["My project notes", "x".repeat(SESSION_NAME_MAX_LENGTH)]) {
    assert.equal(validateAppCommand("create_session", { name, deviceId: "this-mac" }).name, name);
    assert.equal(validateAppCommand("open_session", { session: name, cwd: "/tmp" }).session, name);
  }
  assert.throws(() => validateAppCommand("create_session", { name: "x".repeat(SESSION_NAME_MAX_LENGTH + 1), deviceId: "this-mac" }));
});

test("remote session requests use explicit trusted SSH and never carry the local tmux socket", async () => {
  const prior = process.env.PZZA_TMUX_SOCKET;
  process.env.PZZA_TMUX_SOCKET = "/tmp/local-session-service";
  try {
    let request;
    const result = await createDeviceSession({ name: "  remote work  ", host: "devbox", cwd: "/home/user/project" }, (command, args, options, callback) => {
      assert.equal(command, "ssh");
      assert.ok(args.includes("StrictHostKeyChecking=yes"));
      assert.equal(args.at(-2), "devbox");
      assert.equal(options.env.PZZA_TMUX_SOCKET, undefined);
      assert.ok(!args.at(-1).includes("/tmp/local-session-service"));
      return { stdin: { on() {}, end(data) { request = JSON.parse(data); callback(null, JSON.stringify({ ok: true })); } } };
    });
    assert.deepEqual(request.tmuxOptions, []);
    assert.equal(request.name, "remote work");
    assert.equal(result.name, "remote work");
    assert.equal(result.host, "devbox");
  } finally { if (prior === undefined) delete process.env.PZZA_TMUX_SOCKET; else process.env.PZZA_TMUX_SOCKET = prior; }
});

test("creation binds only an actual account on the destination and preserves literal working directories", { timeout: 15000 }, async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "pzza-session-create-"));
  const socket = path.join(home, "tmux");
  const cwd = path.join(home, "folder ' $(literal)");
  await fs.mkdir(cwd);
  await fs.mkdir(path.join(home, ".codex"));
  await fs.writeFile(path.join(home, ".codex/auth.json"), "{}");
  const tmux = args => exec("tmux", ["-S", socket, ...args], { timeout: 5000 });
  t.after(async () => { await tmux(["kill-server"]).catch(() => {}); await fs.rm(home, { recursive: true, force: true }); });
  await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "anchor", "exec sleep 30"]);
  await tmux(["set-option", "-g", "default-shell", "/bin/sh"]);
  const environment = { ...process.env, HOME: home, PZZA_TMUX_SOCKET: socket };
  const run = (command, args, options, callback) => execFile(command, args, { ...options, env: environment }, callback);
  const previous = process.env.PZZA_TMUX_SOCKET;
  process.env.PZZA_TMUX_SOCKET = socket;
  try {
    const boundaryName = "x".repeat(SESSION_NAME_MAX_LENGTH);
    await createDeviceSession({ name: boundaryName, cwd }, run);
    await tmux(["has-session", "-t", `=${boundaryName}`]);
    await createDeviceSession({ name: "account work", cwd, account: { provider: "codex", dir: path.join(home, ".codex") } }, run);
    const result = await tmux(["show-environment", "-t", "=account work", "CODEX_HOME"]);
    assert.equal(result.stdout.trim(), `CODEX_HOME=${await fs.realpath(path.join(home, ".codex"))}`);
    const report = path.join(home, "working-directory.txt");
    await tmux(["send-keys", "-t", "=account work:", "-l", `pwd > ${shQuote(report)}; tmux -S ${shQuote(socket)} wait-for -S cwd-ready`]);
    await tmux(["send-keys", "-t", "=account work:", "Enter"]);
    await tmux(["wait-for", "cwd-ready"]);
    assert.equal(await fs.realpath((await fs.readFile(report, "utf8")).trim()), await fs.realpath(cwd));
    await assert.rejects(createDeviceSession({ name: "missing-account", account: { provider: "codex", dir: path.join(home, ".codex-missing") } }, run), { status: 400 });
    await fs.symlink(path.join(home, ".codex"), path.join(home, ".codex-link"));
    await assert.rejects(createDeviceSession({ name: "linked-account", account: { provider: "codex", dir: path.join(home, ".codex-link") } }, run), { status: 400 });
    await assert.rejects(tmux(["has-session", "-t", "=missing-account"]));
    await assert.rejects(tmux(["has-session", "-t", "=linked-account"]));
  } finally { if (previous === undefined) delete process.env.PZZA_TMUX_SOCKET; else process.env.PZZA_TMUX_SOCKET = previous; }
});
