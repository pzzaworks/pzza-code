import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { closeQuickChat, openQuickChat } from "../lib/quick-chat.js";

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
      callback(null, "codex");
    });
    assert.deepEqual(result, { session: "pzza-quick-chat", host, agent: "codex" });
  }
});

test("connection errors are actionable and never expose subprocess output", async () => {
  await assert.rejects(openQuickChat({ host: "offline", agent: "claude" }, (_command, _args, _options, callback) => {
    callback(Object.assign(new Error("private diagnostic"), { code: 255 }), "private output");
  }), error => error.status === 503 && /choose another device/.test(error.message) && !/private/.test(error.message));
});

test("real isolated tmux: concurrent opens reuse one process, preserve agent, and recreate after termination", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-quick-chat-test-"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  // Test-only executables hold the pane open without contacting a provider.
  for (const name of ["claude", "codex"]) await writeFile(path.join(bin, name), "#!/bin/sh\nexec sleep 60\n", { mode: 0o700 });
  const env = { ...process.env, HOME: root, TMUX: "", TMUX_TMPDIR: root, PATH: `${bin}:${process.env.PATH}` };
  const run = (command, args, options, callback) => execFile(command, args, { ...options, env }, callback);
  const tmux = (...args) => promisify(execFile)("tmux", args, { env, timeout: 5000 });
  try {
    // Start the isolated server first so the test exercises session creation,
    // not tmux's separate initial server startup race. Use controlled commands
    // so a login shell cannot recreate history files during fixture cleanup.
    await tmux("-f", "/dev/null", "new-session", "-d", "-s", "test-anchor", "exec sleep 60");
    await tmux("set-option", "-g", "default-shell", "/bin/sh");
    const results = await Promise.all(Array.from({ length: 6 }, () => openQuickChat({ host: "", agent: "claude" }, run)));
    assert.ok(results.every(result => result.agent === "claude"));
    const before = (await tmux("display-message", "-p", "-t", "=pzza-quick-chat:", "#{pane_pid}")).stdout;
    assert.equal((await openQuickChat({ host: "", agent: "codex" }, run)).agent, "claude");
    assert.equal((await tmux("display-message", "-p", "-t", "=pzza-quick-chat:", "#{pane_pid}")).stdout, before);
    const sessions = (await tmux("list-sessions", "-F", "#{session_name}")).stdout.trim().split("\n");
    assert.equal(sessions.filter(name => name === "pzza-quick-chat").length, 1);
    await closeQuickChat({ host: "" }, run);
    await assert.rejects(tmux("has-session", "-t", "=pzza-quick-chat"));
    await closeQuickChat({ host: "" }, run);
    assert.equal((await openQuickChat({ host: "", agent: "codex" }, run)).agent, "codex");
    await closeQuickChat({ host: "" }, run);
    await tmux("new-session", "-d", "-s", "pzza-quick-chat", "exec sleep 60");
    await assert.rejects(openQuickChat({ host: "", agent: "claude" }, run), /not a managed/);
    await assert.rejects(closeQuickChat({ host: "" }, run), /not a managed/);
    await tmux("has-session", "-t", "=pzza-quick-chat");
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
