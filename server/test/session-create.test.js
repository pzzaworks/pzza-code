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
import { sessionAgentCommand } from "../lib/session-agents.js";
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
    assert.equal((await tmux(["show-environment", "-t", "=account work", "OPENTUI_NOTIFICATION_PROTOCOL"])).stdout.trim(), "OPENTUI_NOTIFICATION_PROTOCOL=osc777");
    assert.equal((await tmux(["show-options", "-wv", "-t", "=account work:", "allow-passthrough"])).stdout.trim(), "on");
    assert.equal((await tmux(["show-options", "-wAv", "-t", "=anchor:", "allow-passthrough"])).stdout.trim(), "off");
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

test("agent launches accept only catalog agents and modes before executing", async () => {
  let called = false;
  const run = () => { called = true; throw new Error("Unexpected process"); };
  for (const agent of [null, "claude", { id: "claude" }, { id: "claude", mode: "yolo" }, { id: "bash", mode: "default" }, { id: "codex", mode: "default", args: "--x" }, { id: "claude; rm -rf ~", mode: "default" }]) {
    await assert.rejects(createDeviceSession({ name: "valid", agent }, run), { status: 400 });
  }
  assert.equal(called, false);
  assert.equal(sessionAgentCommand({ id: "claude", mode: "bypass" }), "claude --dangerously-skip-permissions");
  assert.equal(sessionAgentCommand({ id: "codex", mode: "readOnly" }), "codex --sandbox read-only");
  assert.equal(sessionAgentCommand({ id: "opencode", mode: "default" }), "opencode");
});

test("a created session types the agent command into its own tmux target, locally and over SSH", async () => {
  const prior = process.env.PZZA_TMUX_SOCKET;
  process.env.PZZA_TMUX_SOCKET = "/tmp/local-session-service";
  try {
    const calls = [];
    const run = (command, args, options, callback) => {
      calls.push({ command, args });
      if (calls.length === 1) return { stdin: { on() {}, end() { callback(null, JSON.stringify({ ok: true })); } } };
      callback(null, "");
      return { stdin: null };
    };
    const local = await createDeviceSession({ name: "my work", cwd: "/tmp", agent: { id: "claude", mode: "plan" } }, run);
    assert.equal(local.agentStarted, true);
    assert.deepEqual(calls[1], { command: "tmux", args: ["-N", "-S", "/tmp/local-session-service", "send-keys", "-t", "=my work:", "-l", "claude --permission-mode plan", ";", "send-keys", "-t", "=my work:", "Enter"] });
    calls.length = 0;
    const remote = await createDeviceSession({ name: "remote", host: "devbox", agent: { id: "codex", mode: "default" } }, run);
    assert.equal(remote.agentStarted, true);
    assert.equal(calls[1].command, "ssh");
    assert.ok(calls[1].args.includes("StrictHostKeyChecking=yes"));
    assert.equal(calls[1].args.at(-1), "'tmux' '-u' 'send-keys' '-t' '=remote:' '-l' 'codex' ';' 'send-keys' '-t' '=remote:' 'Enter'");
    assert.ok(!calls[1].args.at(-1).includes("/tmp/local-session-service"));
    const failed = await createDeviceSession({ name: "remote", host: "devbox", agent: { id: "codex", mode: "default" } }, (command, args, options, callback) => {
      if (command === "ssh" && args.at(-1).includes("python3")) return { stdin: { on() {}, end() { callback(null, JSON.stringify({ ok: true })); } } };
      callback(new Error("tmux failed"));
      return { stdin: null };
    });
    assert.deepEqual(failed, { ok: true, host: "devbox", name: "remote", agentStarted: false });
  } finally { if (prior === undefined) delete process.env.PZZA_TMUX_SOCKET; else process.env.PZZA_TMUX_SOCKET = prior; }
});

test("agent commands add resume flags and a single quoted starting prompt", () => {
  assert.equal(sessionAgentCommand({ id: "claude", mode: "plan", resume: true, prompt: "fix the login bug" }), "claude -c --permission-mode plan 'fix the login bug'");
  assert.equal(sessionAgentCommand({ id: "codex", mode: "readOnly", resume: true }), "codex resume --last --sandbox read-only");
  assert.equal(sessionAgentCommand({ id: "opencode", mode: "default", prompt: "it's $(whoami) `id`" }), "opencode --prompt 'it'\\''s $(whoami) `id`'");
  for (const prompt of ["", "   ", "two\nlines", "tab\tinside", "x".repeat(4001), 42]) {
    assert.throws(() => sessionAgentCommand({ id: "claude", mode: "default", prompt }));
  }
  assert.throws(() => sessionAgentCommand({ id: "claude", mode: "default", resume: "yes" }));
});

test("worktree sessions create a sibling worktree on a new branch and start there", { timeout: 20000 }, async () => {
  const exec = promisify(execFile);
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pzza-worktree-")));
  const repo = path.join(root, "app");
  await fs.mkdir(path.join(repo, "src"), { recursive: true });
  await exec("git", ["init", "-q", repo]);
  await exec("git", ["-C", repo, "-c", "user.email=t@example.com", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init"]);
  let request;
  const run = (command, args, options, callback) => {
    if (command === "/bin/sh") return execFile(command, args, options, callback);
    return { stdin: { on() {}, end(data) { request = JSON.parse(data); callback(null, JSON.stringify({ ok: true })); } } };
  };
  try {
    const result = await createDeviceSession({ name: "Fix Login", cwd: path.join(repo, "src"), worktree: true }, run);
    const expected = path.join(root, "app.worktrees", "fix-login");
    assert.equal(result.cwd, expected);
    assert.equal(request.cwd, expected);
    assert.equal((await exec("git", ["-C", expected, "branch", "--show-current"])).stdout.trim(), "pzza/fix-login");
    await assert.rejects(createDeviceSession({ name: "Fix Login", cwd: repo, worktree: true }, run), { status: 400, message: /already exists/ });
    await assert.rejects(createDeviceSession({ name: "Elsewhere", cwd: root, worktree: true }, run), { status: 400, message: /not inside a git repository/ });
    await assert.rejects(createDeviceSession({ name: "No folder", worktree: true }, run), { status: 400 });
  } finally {
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("remote worktrees pass the folder and slug as quoted positional arguments", async () => {
  const calls = [];
  const run = (command, args, options, callback) => {
    calls.push(args.at(-1));
    if (calls.length === 1) { callback(null, "/srv/app.worktrees/api"); return { stdin: null }; }
    return { stdin: { on() {}, end() { callback(null, JSON.stringify({ ok: true })); } } };
  };
  const result = await createDeviceSession({ name: "api", host: "devbox", cwd: "/srv/app 'x'", worktree: true }, run);
  assert.equal(result.cwd, "/srv/app.worktrees/api");
  assert.ok(calls[0].startsWith("'sh' '-c' '"));
  assert.ok(calls[0].endsWith("'pzza-worktree' '/srv/app '\\''x'\\''' 'api'"));
});
