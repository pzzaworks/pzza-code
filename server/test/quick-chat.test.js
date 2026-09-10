import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeQuickChat, openQuickChat, quickChatCommand, verifyQuickChat } from "../lib/quick-chat.js";

function requireIsolatedTmuxSocket() {
  if (process.env.PZZA_TMUX_SOCKET) {
    throw new Error("Real tmux Quick Chat fixtures refuse an inherited managed socket.");
  }
}

test("rejects invalid agents and SSH targets before executing anything", async () => {
  for (const body of [null, {}, { agent: "claude" }, { host: "-oProxyCommand=bad", agent: "claude" },
    { host: "host;echo bad", agent: "codex" }, { host: "", agent: "sh" }, { host: "", agent: "claude", command: "bad" }]) {
    await assert.rejects(openQuickChat(body, () => assert.fail("must not execute")), { status: 400 });
  }
});

test("explicit local routing and strict remote SSH options", async () => {
  for (const host of ["", "berke@macbook"]) {
    const result = await openQuickChat({ host, agent: "codex" }, (command, args, options, callback) => {
      assert.equal(command, host ? "ssh" : "sh");
      assert.equal(options.timeout, 15000);
      if (host) {
        for (const flag of ["StrictHostKeyChecking=yes", "ForwardAgent=no", "ClearAllForwardings=yes", "ControlPath=none"]) assert.ok(args.includes(flag));
        assert.equal(args.at(-2), host);
      }
      callback(null, "codex\npz\n$1:100:200");
    });
    assert.deepEqual(result, { session: "pzza-quick-chat", host, agent: "codex", launcher: "pz", identity: "$1:100:200" });
  }
});

test("Codex Quick Chat resolves pz in the target login shell without a Codex fallback", () => {
  const command = quickChatCommand("codex");
  assert.match(command, /PZZA_QUICK_CHAT_LAUNCHER=pz/);
  assert.match(command, /getent passwd/);
  assert.match(command, /dscl \. -read/);
  assert.match(command, /command -v pz >\/dev\/null 2>&1/);
  assert.match(command, /-lic 'pz'/);
  assert.doesNotMatch(command, /command -v codex/);
  assert.ok(command.indexOf("has-session") < command.indexOf("command -v pz"));

  const claude = quickChatCommand("claude");
  assert.match(claude, /PZZA_QUICK_CHAT_LAUNCHER=claude/);
  assert.match(claude, /command -v claude/);
});

test("Bash login shells resolve a pz alias without exposing its expansion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-quick-chat-bash-"));
  try {
    await writeFile(path.join(root, ".bashrc"), "alias pz=':'\n", { mode: 0o600 });
    await writeFile(path.join(root, ".bash_profile"), ". \"$HOME/.bashrc\"\n", { mode: 0o600 });
    await promisify(execFile)("/bin/bash", ["-lic", "command -v pz >/dev/null 2>&1 && pz"], {
      env: { ...process.env, HOME: root },
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("connection errors are actionable and never expose subprocess output", async () => {
  await assert.rejects(openQuickChat({ host: "offline", agent: "claude" }, (_command, _args, _options, callback) => {
    callback(Object.assign(new Error("private diagnostic"), { code: 255 }), "private output");
  }), error => error.status === 503 && /choose another device/.test(error.message) && !/private/.test(error.message));
});

test("real isolated tmux: concurrent opens reuse one process, preserve agent, and recreate after termination", async () => {
  requireIsolatedTmuxSocket();
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-quick-chat-test-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  // Test-only launcher and shell aliases hold the pane open without contacting a provider.
  await writeFile(path.join(bin, "claude"), "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
  await writeFile(path.join(root, ".zshrc"), "alias pz='exec sleep 60'\n", { mode: 0o600 });
  await writeFile(path.join(root, ".bashrc"), "alias pz='exec sleep 60'\n", { mode: 0o600 });
  await writeFile(path.join(root, ".bash_profile"), ". \"$HOME/.bashrc\"\n", { mode: 0o600 });
  const env = { ...process.env, HOME: root, ZDOTDIR: root, TMUX: "", TMUX_TMPDIR: root, PATH: `${bin}:${process.env.PATH}` };
  const run = (command, args, options, callback) => execFile(command, args, { ...options, env }, callback);
  const tmux = (...args) => promisify(execFile)("tmux", args, { env, timeout: 5000 });
  try {
    // Start the isolated server first so the test exercises session creation,
    // not tmux's separate initial server startup race. Use controlled commands
    // so a login shell cannot recreate history files during fixture cleanup.
    await tmux("-f", "/dev/null", "new-session", "-d", "-s", "test-anchor", "exec sleep 60");
    await tmux("set-option", "-g", "default-shell", "/bin/sh");
    const results = await Promise.all(Array.from({ length: 6 }, () => openQuickChat({ host: "", agent: "claude" }, run)));
    assert.ok(results.every(result => result.agent === "claude" && result.launcher === "claude" && result.identity === results[0].identity));
    const existing = { host: "", agent: "claude", identity: results[0].identity };
    assert.deepEqual(await verifyQuickChat(existing, run), { verified: true });
    await assert.rejects(verifyQuickChat({ ...existing, agent: "codex" }, run), /not the expected managed/);
    const before = (await tmux("display-message", "-p", "-t", "=pzza-quick-chat:", "#{pane_pid}")).stdout;
    const reused = await openQuickChat({ host: "", agent: "codex" }, run);
    assert.equal(reused.agent, "claude");
    assert.equal(reused.launcher, "claude");
    assert.equal((await tmux("display-message", "-p", "-t", "=pzza-quick-chat:", "#{pane_pid}")).stdout, before);
    const sessions = (await tmux("list-sessions", "-F", "#{session_name}")).stdout.trim().split("\n");
    assert.equal(sessions.filter(name => name === "pzza-quick-chat").length, 1);
    await closeQuickChat({ host: "" }, run);
    await assert.rejects(tmux("has-session", "-t", "=pzza-quick-chat"));
    await assert.rejects(verifyQuickChat(existing, run), /ended or was replaced/);
    await assert.rejects(tmux("has-session", "-t", "=pzza-quick-chat"), "verification must not create a shell");
    await closeQuickChat({ host: "" }, run);
    const replacement = await openQuickChat({ host: "", agent: "codex" }, run);
    assert.equal(replacement.agent, "codex");
    assert.equal(replacement.launcher, "pz");
    assert.notEqual(replacement.identity, existing.identity);
    await assert.rejects(verifyQuickChat({ ...existing, agent: "codex" }, run), /ended or was replaced/);
    await closeQuickChat({ host: "" }, run);
    await tmux("new-session", "-d", "-s", "pzza-quick-chat", "exec sleep 60");
    await assert.rejects(openQuickChat({ host: "", agent: "claude" }, run), /not the expected managed/);
    await assert.rejects(closeQuickChat({ host: "" }, run), /not the expected managed/);
    await tmux("has-session", "-t", "=pzza-quick-chat");
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});


test("legacy managed Codex chat stays attached without starting or requiring pz", async () => {
  requireIsolatedTmuxSocket();
  const root = await mkdtemp(path.join(os.tmpdir(), "pzqc-l-"));
  const { PZZA_QUICK_CHAT_AGENT: _agent, PZZA_QUICK_CHAT_LAUNCHER: _launcher, ...baseEnv } = process.env;
  const env = { ...baseEnv, HOME: root, TMUX: "", TMUX_TMPDIR: root };
  const run = (command, args, options, callback) => execFile(command, args, { ...options, env }, callback);
  const tmux = (...args) => promisify(execFile)("tmux", args, { env, timeout: 5000 });
  try {
    await tmux("-f", "/dev/null", "new-session", "-d", "-s", "pzza-quick-chat", "-x", "160", "-y", "45", "-e", "PZZA_QUICK_CHAT_AGENT=codex", "exec sleep 60");
    await assert.rejects(tmux("show-environment", "-t", "=pzza-quick-chat", "PZZA_QUICK_CHAT_LAUNCHER"));
    const identity = (await tmux("display-message", "-p", "-t", "=pzza-quick-chat:", "#{session_id}:#{session_created}:#{pid}")).stdout.trim();
    const pid = (await tmux("display-message", "-p", "-t", "=pzza-quick-chat:", "#{pane_pid}")).stdout;

    const chat = await openQuickChat({ host: "", agent: "codex" }, run);

    assert.equal(chat.session, "pzza-quick-chat");
    assert.equal(chat.host, "");
    assert.equal(chat.agent, "codex");
    assert.equal(chat.launcher, "codex");
    assert.equal(chat.identity, identity);
    assert.equal((await tmux("display-message", "-p", "-t", "=pzza-quick-chat:", "#{pane_pid}")).stdout, pid);
    assert.equal((await tmux("display-message", "-p", "-t", "=pzza-quick-chat:", "#{session_id}:#{session_created}:#{pid}")).stdout.trim(), identity);
    assert.deepEqual(await verifyQuickChat({ host: "", agent: "codex", identity }, run), { verified: true });
    await assert.rejects(tmux("show-environment", "-t", "=pzza-quick-chat", "PZZA_QUICK_CHAT_LAUNCHER"));
  } finally {
    await tmux("kill-server").catch(() => {});
    await rm(root, { recursive: true, force: true });
  }
});

test("close rejects arbitrary targets and is idempotent when no chat exists", async () => {
  for (const body of [null, {}, { host: "-bad" }, { host: "", session: "other" }, { host: "", agent: "claude" }]) {
    await assert.rejects(closeQuickChat(body, () => assert.fail("must not execute")), { status: 400 });
  }
  assert.deepEqual(await closeQuickChat({ host: "" }, (_command, args, _options, callback) => {
    assert.match(args.at(-1), /PZZA_QUICK_CHAT_AGENT/);
    assert.match(args.at(-1), /kill-session -t '=pzza-quick-chat'/);
    callback(null, "");
  }), { closed: true });
});
