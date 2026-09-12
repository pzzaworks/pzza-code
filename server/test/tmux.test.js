import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm, realpath } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { ACTIVITY_PROBE_SCRIPT, configuredModelSelection, detectSessionActivity, foregroundModelSelection, interpreterEntrypoint, normalizeEffectiveModel, processModelSelectors } from "../lib/session-activity.js";
import { sessionActivity } from "../lib/tmux.js";
import { shQuote } from "../lib/shell.js";

const pane = (overrides = {}) => ({ session: "renamed session", window: 0, active: true, paneActive: true, pid: 10, tty: "/dev/pts/1", command: "bash", ...overrides });
const processRow = (overrides = {}) => ({ pid: 10, ppid: 1, pgid: 10, tpgid: 20, tty: "pts/1", command: "bash", executable: "/bin/bash", ...overrides });

test("foreground nested agent detection ignores background jobs, shell text and session names", () => {
  const processes = [processRow(), processRow({ pid: 20, ppid: 10, pgid: 20 }),
    processRow({ pid: 21, ppid: 20, pgid: 20, command: "node", executable: "/usr/bin/node", entrypoint: "/opt/node_modules/@anthropic-ai/claude-code/cli.js" }),
    processRow({ pid: 30, ppid: 10, pgid: 30, command: "codex", executable: "/bin/codex" })];
  assert.equal(detectSessionActivity([pane()], processes)[0].command, "claude");
  processes.pop();
  processes[2].entrypoint = "/project/server.js";
  processes[2].argv = ["node", "/project/server.js", "codex", "/opt/node_modules/@anthropic-ai/claude-code/cli.js"];
  assert.equal(detectSessionActivity([pane({ session: "claude codex", command: "bash -c codex" })], processes)[0].command, "");
  processes[2].entrypoint = "/tmp/@openai/codex/bin/codex.js";
  assert.equal(detectSessionActivity([pane()], processes)[0].command, "bash");
});

test("opencode pane labels resolve like the other agents, stale or not", () => {
  // A live shell with no agent process behind an opencode label: stale, hide it.
  assert.equal(detectSessionActivity([pane({ command: "opencode" })], [processRow()])[0].command, "");
  // No process snapshot at all: trust the pane label so old terminals brand up.
  assert.equal(detectSessionActivity([pane({ command: "/Users/berke/.opencode/bin/opencode" })], [])[0].command, "opencode");
});

test("foreground detection is scoped to active pane, window, tty and ancestry", () => {
  const panes = [pane(), pane({ window: 1, active: false, pid: 40, tty: "/dev/ttys001", command: "zsh" }), pane({ paneActive: false, pid: 70, tty: "/dev/pts/7" })];
  const processes = [processRow(), processRow({ pid: 20, ppid: 999, pgid: 20, executable: "/bin/claude" }),
    processRow({ pid: 40, pgid: 40, tpgid: 50, tty: "s001" }),
    processRow({ pid: 50, ppid: 40, pgid: 50, tty: "ttys001", executable: "/bin/codex" }),
    processRow({ pid: 22, ppid: 10, pgid: 20, tty: "pts/other", executable: "/bin/claude" })];
  assert.deepEqual(detectSessionActivity(panes, processes), [
    { session: "renamed session", window: 0, active: true, command: "bash", effectiveModel: null, effectiveProvider: null, effectiveModelEvidence: null },
    { session: "renamed session", window: 1, active: false, command: "codex", effectiveModel: null, effectiveProvider: null, effectiveModelEvidence: null },
  ]);
});

test("native installations and exact wrapper entrypoints work without exposing arguments", () => {
  const native = processRow({ pid: 20, ppid: 10, pgid: 20, executable: "/home/user/.local/share/claude/versions/2.1.10" });
  assert.equal(detectSessionActivity([pane()], [processRow(), native])[0].command, "claude");
  native.executable = "/usr/bin/node";
  native.entrypoint = "/opt/node_modules/@openai/codex/bin/codex.js";
  native.argv = ["node", native.entrypoint, "private prompt"];
  const result = detectSessionActivity([pane()], [processRow(), native]);
  assert.equal(result[0].command, "codex");
  assert.ok(!JSON.stringify(result).includes("private prompt"));
  assert.equal(interpreterEntrypoint(["node", "--require", "loader", "--max-old-space-size=8192", native.entrypoint]), native.entrypoint);
  for (const argv of [["node", "-e", "codex"], ["node", "--eval=code", native.entrypoint], ["node", "-pcode", native.entrypoint]]) {
    assert.equal(interpreterEntrypoint(argv), "");
  }
});

test("effective model metadata uses exact foreground selectors and selected-account settings", async () => {
  const direct = processRow({
    pid: 20,
    ppid: 10,
    pgid: 20,
    command: "claude",
    executable: "/usr/local/bin/claude",
    argv: ["claude", "--model", "gpt-5.1", "private prompt"],
  });
  assert.deepEqual(detectSessionActivity([pane()], [processRow(), direct])[0], {
    session: "renamed session",
    window: 0,
    active: true,
    command: "claude",
    effectiveModel: "gpt-5.1",
    effectiveProvider: "codex",
    effectiveModelEvidence: "configured",
  });
  assert.equal(JSON.stringify(detectSessionActivity([pane()], [processRow(), direct])).includes("private prompt"), false);
  assert.equal(foregroundModelSelection(["claude", "--prompt", "please use --model=gpt-5.1"]).declared, false);

  const files = new Map([
    ["/home/pzza/.claude-work/settings.json", JSON.stringify({ env: { ANTHROPIC_MODEL: "claude-sonnet-5" } })],
    ["/home/pzza/.claude-proxy/settings.json", JSON.stringify({ env: { ANTHROPIC_MODEL: "gpt-5.2" } })],
    ["/home/pzza/.claude/settings.json", JSON.stringify({ env: { ANTHROPIC_MODEL: "claude-mythos-5-1" } })],
  ]);
  const reads = [];
  const fs = {
    realpath: async (file) => file,
    lstat: async (file) => {
      const content = files.get(file);
      if (content === undefined) throw new Error("not found");
      return { isFile: () => true, isSymbolicLink: () => false, size: content.length };
    },
    readFile: async (file) => {
      reads.push(file);
      return files.get(file);
    },
  };
  const modelPath = {
    join: (...parts) => parts.join("/"),
    dirname: (value) => value.slice(0, value.lastIndexOf("/")) || "/",
    basename: (value) => value.slice(value.lastIndexOf("/") + 1),
  };
  const proxyModel = await configuredModelSelection({}, "/home/pzza/.claude-proxy", fs, { homedir: () => "/home/pzza" }, modelPath);
  assert.deepEqual(proxyModel, { effectiveModel: "gpt-5.2", effectiveProvider: "codex", effectiveModelEvidence: "configured" });
  assert.deepEqual(reads, ["/home/pzza/.claude-proxy/settings.json"]);
  reads.length = 0;
  assert.deepEqual(
    await configuredModelSelection({}, "", fs, { homedir: () => "/home/pzza" }, modelPath),
    { effectiveModel: "claude-mythos-5-1", effectiveProvider: "claude", effectiveModelEvidence: "configured" },
  );
  assert.deepEqual(reads, ["/home/pzza/.claude/settings.json"]);

  const selectors = processModelSelectors(["claude"], "OTHER=not-returned\0ANTHROPIC_MODEL=gpt-5.2\0CLAUDE_CONFIG_DIR=/home/pzza/.claude-proxy\0");
  assert.deepEqual(selectors, {
    modelDeclared: true,
    metadata: { effectiveModel: "gpt-5.2", effectiveProvider: "codex", effectiveModelEvidence: "configured" },
    accountDirectory: "/home/pzza/.claude-proxy",
  });
  const configured = processRow({ pid: 20, ppid: 10, pgid: 20, command: "claude", executable: "/usr/local/bin/claude", ...selectors.metadata });
  assert.equal(detectSessionActivity([pane({ effectiveModel: "claude-opus-5", effectiveProvider: "claude", effectiveModelEvidence: "reported" })], [processRow(), configured])[0].effectiveProvider, "codex");
  const flagPrecedence = processRow({
    pid: 20,
    ppid: 10,
    pgid: 20,
    command: "claude",
    executable: "/usr/local/bin/claude",
    argv: ["claude", "--model", "claude-opus-5"],
    ...selectors.metadata,
  });
  assert.equal(detectSessionActivity([pane()], [processRow(), flagPrecedence])[0].effectiveProvider, "claude");
  const unknown = processRow({ pid: 20, ppid: 10, pgid: 20, command: "claude", executable: "/usr/local/bin/claude", argv: ["claude", "--model", "proxy-codex"], ...selectors.metadata });
  assert.equal(detectSessionActivity([pane()], [processRow(), unknown])[0].effectiveProvider, null);

  const foregroundWithoutModel = processRow({ pid: 20, ppid: 10, pgid: 20, command: "claude", executable: "/usr/local/bin/claude" });
  const backgroundCodexModel = processRow({ pid: 30, ppid: 10, pgid: 30, command: "claude", executable: "/usr/local/bin/claude", argv: ["claude", "--model", "gpt-5-codex"] });
  assert.equal(detectSessionActivity([pane()], [processRow(), foregroundWithoutModel, backgroundCodexModel])[0].effectiveProvider, null);
  for (const model of ["gpt-5", "gpt-5.1", "gpt-5.2-codex-max", "gpt-4o-mini"]) assert.equal(normalizeEffectiveModel(model)?.provider, "codex");
  for (const model of ["claude-fable-5-1", "claude-mythos-5-1"]) assert.equal(normalizeEffectiveModel(model)?.provider, "claude");
  assert.equal(normalizeEffectiveModel("proxy-codex"), null);

  const remote = detectSessionActivity([{ ...pane(), command: "claude", effectiveModel: "GPT-5-CODEX", effectiveProvider: "codex", effectiveModelEvidence: "reported" }], []);
  assert.equal(remote[0].effectiveModelEvidence, "reported");
  const stale = detectSessionActivity([{ ...pane(), command: "claude", effectiveModel: "gpt-5-codex", effectiveProvider: "codex", effectiveModelEvidence: "reported" }], [processRow()]);
  assert.equal(stale[0].effectiveProvider, null);
});

test("fallback accepts only known executable labels and preserves existing tool icons", () => {
  for (const command of ["btop", "htop", "top", "yazi", "ranger", "nnn", "lf", "docker", "lazydocker", "claude", "codex"]) {
    assert.equal(detectSessionActivity([pane({ command })], [])[0].command, command);
  }
  assert.equal(detectSessionActivity([pane({ command: "arbitrary private command" })], [])[0].command, "");
  assert.equal(detectSessionActivity([pane({ command: "claude" })], [processRow()])[0].command, "");
});

test("activity requests deduplicate in flight, cache briefly, refresh after expiry, reject invalid hosts and sanitize output", async (t) => {
  let calls = 0;
  const callbacks = [];
  const mock = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls++;
    assert.equal(command, "ssh");
    assert.ok(args.includes("ControlPath=~/.ssh/pzza-mux-%C"));
    assert.ok(options.timeout <= 10_000);
    callbacks.push(callback);
  });
  syncBuiltinESMExports();
  try {
    const first = sessionActivity("fixture-device");
    const same = sessionActivity("fixture-device");
    assert.equal(first, same);
    callbacks[0](null, JSON.stringify([{
      session: "one",
      window: 2,
      active: false,
      command: "claude",
      effectiveModel: "gpt-5-codex",
      effectiveProvider: "codex",
      effectiveModelEvidence: "reported",
    }]));
    assert.deepEqual(await first, [{
      session: "one",
      window: 2,
      active: false,
      command: "claude",
      effectiveModel: "gpt-5-codex",
      effectiveProvider: "codex",
      effectiveModelEvidence: "reported",
    }]);
    assert.deepEqual(await sessionActivity("fixture-device"), await first);
    assert.equal(calls, 1);
    const clock = t.mock.method(Date, "now", () =>  Date.prototype.getTime.call(new Date()) + 1001);
    const next = sessionActivity("fixture-device");
    callbacks[1](null, "one\t2\t0\tcodex\n");
    assert.equal((await next)[0].command, "codex");
    clock.mock.restore();
    assert.equal(calls, 2);
    await assert.rejects(sessionActivity("-bad host"), /invalid host/);
    assert.equal(calls, 2);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

const execute = promisify(childProcess.execFile);
const run = (command, args, options = {}) => execute(command, args, { timeout: 5_000, ...options });

test("real isolated tmux probe tracks foreground wrapper, background exclusion and return to shell", async (t) => {
  const root = await mkdtemp("/tmp/pzza-activity-");
  const socket = path.join(root, "socket");
  const realTmux = (await run("sh", ["-c", "command -v tmux"])).stdout.trim();
  const tmux = (...args) => run(realTmux, ["-S", socket, ...args]);
  t.after(async () => {
    await tmux("kill-server").catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "tmux"), `#!/bin/sh\nexec ${shQuote(realTmux)} -S ${shQuote(socket)} "$@"\n`, { mode: 0o700 });
  const environment = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  const scripts = [];
  for (const [packageName, filename, signal] of [["@anthropic-ai/claude-code", "cli.js", "foreground-ready"], ["@openai/codex", "bin/codex.js", "background-ready"]]) {
    const script = path.join(root, "node_modules", packageName, filename);
    await mkdir(path.dirname(script), { recursive: true });
    await writeFile(script, `require("node:child_process").execFileSync(${JSON.stringify(realTmux)}, ["-S", ${JSON.stringify(socket)}, "wait-for", "-S", ${JSON.stringify(signal)}]); setInterval(() => {}, 1000);\n`);
    scripts.push(script);
  }
  await tmux("-f", "/dev/null", "new-session", "-d", "-s", "renamed-session", "bash --noprofile --norc");
  await tmux("send-keys", "-t", "renamed-session:0", `${shQuote(process.execPath)} ${shQuote(scripts[0])}`, "Enter");
  await tmux("wait-for", "foreground-ready");
  await tmux("new-window", "-t", "renamed-session", "bash --noprofile --norc");
  await tmux("send-keys", "-t", "renamed-session:1", `${shQuote(process.execPath)} ${shQuote(scripts[1])} &`, "Enter");
  await tmux("wait-for", "background-ready");
  const snapshot = async () => JSON.parse((await run(process.execPath, ["-e", ACTIVITY_PROBE_SCRIPT], { env: environment })).stdout);
  const rows = await snapshot();
  assert.equal(rows.find((row) => row.window === 0).command, "claude");
  assert.equal(rows.find((row) => row.window === 1).command, "bash");
  assert.deepEqual(rows.map((row) => row.session), ["renamed-session", "renamed-session"]);
  await tmux("send-keys", "-t", "renamed-session:0", "C-c");
  await tmux("send-keys", "-t", "renamed-session:0", `${shQuote(realTmux)} -S ${shQuote(socket)} wait-for -S returned`, "Enter");
  await tmux("wait-for", "returned");
  assert.equal((await snapshot()).find((row) => row.window === 0).command, "bash");
});

test("termination closes grouped internal views and preserves unrelated sessions", async () => {
  const { terminationCommand } = await import("../lib/tmux.js");
  const socket = `pzza-termination-${process.pid}-${Date.now()}`;
  const exec = promisify(childProcess.execFile);
  const tmux = (...args) => exec("tmux", ["-L", socket, ...args]);
  const terminate = (name, window) => exec("sh", ["-c", terminationCommand(name, window).replaceAll("tmux ", `tmux -L ${socket} `)]);
  try {
    await tmux("-f", "/dev/null", "new-session", "-d", "-s", "work", "sleep 120");
    await tmux("new-window", "-t", "=work:", "sleep 120");
    await tmux("new-session", "-d", "-t", "=work", "-s", "pzza-v-test");
    await tmux("new-session", "-d", "-s", "work-extra", "sleep 120");
    await tmux("new-session", "-d", "-t", "=work-extra", "-s", "pzza-v-unrelated");
    await terminate("work", 1);
    assert.equal((await tmux("list-windows", "-t", "=work", "-F", "#{window_index}")).stdout.trim(), "0");
    await assert.rejects(terminate("wor"));
    await tmux("has-session", "-t", "=work");
    const terminatedWindow = (await tmux("display-message", "-p", "-t", "=work:", "#{window_id}")).stdout.trim();
    await terminate("work");
    assert.ok(!(await tmux("list-windows", "-a", "-F", "#{window_id}")).stdout.trim().split("\n").includes(terminatedWindow));
    await assert.rejects(tmux("has-session", "-t", "=work"));
    await assert.rejects(tmux("has-session", "-t", "=pzza-v-test"));
    await tmux("has-session", "-t", "=work-extra");
    await tmux("has-session", "-t", "=pzza-v-unrelated");
    await assert.rejects(terminate("work"));
  } finally {
    await tmux("kill-server").catch(() => {});
  }
});

test("termination preserves device scope and propagates remote failure", async (t) => {
  const { terminationCommand, terminateSession } = await import("../lib/tmux.js");
  const requests = [];
  const mock = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    assert.equal(options.timeout, 15_000);
    requests.push({ command, args });
    callback(args.includes("offline-device") ? new Error("unreachable") : null);
  });
  syncBuiltinESMExports();
  try {
    await terminateSession("same-name", undefined, "fixture-device");
    assert.equal(requests[0].command, "ssh");
    assert.equal(requests[0].args.at(-2), "fixture-device");
    await assert.rejects(terminateSession("same-name", undefined, "offline-device"), /Could not close/);
    await assert.rejects(terminateSession("same-name", undefined, "-bad-host"), /invalid host/);
    assert.equal(requests.length, 2);
    assert.throws(() => terminationCommand("bad\nname"), /invalid session/);
    assert.throws(() => terminationCommand("valid", -1), /invalid window/);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});

test("receiver scans, icons and termination distinguish explicit local from default and named remote targets", async () => {
  const exec = promisify(childProcess.execFile);
  const script = `
    import childProcess from 'node:child_process';
    import { syncBuiltinESMExports } from 'node:module';
    const calls = [];
    childProcess.execFile = (command, args, options, callback) => {
      calls.push({ command, host: command === 'ssh' ? args.at(-2) : '', timeout: options.timeout });
      callback(null);
    };
    syncBuiltinESMExports();
    const { terminateSession, scanSessions, sessionActivity } = await import('./server/lib/tmux.js');
    await terminateSession('same-name', undefined, '');
    await terminateSession('same-name');
    await terminateSession('same-name', undefined, 'other-device');
    await scanSessions('');
    await scanSessions();
    await scanSessions('other-device');
    await sessionActivity('');
    await sessionActivity();
    await sessionActivity('other-device');
    process.stdout.write(JSON.stringify(calls));
  `;
  const { stdout } = await exec(process.execPath, ["--input-type=module", "-e", script], {
    env: { ...process.env, PZZA_SERVER_HOST: "default-device" }, timeout: 5000,
  });
  assert.deepEqual(JSON.parse(stdout), [
    { command: "sh", host: "", timeout: 15_000 },
    { command: "ssh", host: "default-device", timeout: 15_000 },
    { command: "ssh", host: "other-device", timeout: 15_000 },
    { command: "sh", host: "", timeout: 15_000 },
    { command: "ssh", host: "default-device", timeout: 15_000 },
    { command: "ssh", host: "other-device", timeout: 15_000 },
    { command: "tmux", host: "", timeout: 3_000 },
    { command: "ps", host: "", timeout: 3_000 },
    { command: "ssh", host: "default-device", timeout: 9_000 },
    { command: "ssh", host: "other-device", timeout: 9_000 },
  ]);
});

test("duplicate starts an independent shell in the selected window's live folder", async (t) => {
  const { duplicationCommand } = await import("../lib/tmux.js");
  const root = await realpath(await mkdtemp("/tmp/pzza-duplicate-"));
  const socket = path.join(root, "socket");
  const realTmux = (await run("sh", ["-c", "command -v tmux"])).stdout.trim();
  const tmux = (...args) => run(realTmux, ["-S", socket, ...args]);
  t.after(async () => {
    await tmux("kill-server").catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const bin = path.join(root, "bin");
  const cwd = path.join(root, "folder with 'quotes' and $(literal)");
  await mkdir(bin);
  await mkdir(cwd);
  await writeFile(path.join(bin, "tmux"), `#!/bin/sh\nexec ${shQuote(realTmux)} -S ${shQuote(socket)} "$@"\n`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  await tmux("-f", "/dev/null", "new-session", "-d", "-s", "source", "-c", root, "exec /bin/sh");
  await tmux("set-option", "-g", "default-shell", "/bin/sh");
  await tmux("new-window", "-d", "-t", "source:1", "-c", cwd);
  await tmux("send-keys", "-t", "=source:1", `${shQuote(realTmux)} -S ${shQuote(socket)} wait-for -S source-ready`, "Enter");
  await tmux("wait-for", "source-ready");
  const sourcePane = (await tmux("display-message", "-p", "-t", "=source:1", "#{pane_id}")).stdout.trim();
  const result = await run("sh", ["-c", duplicationCommand("source", 1, "source-copy")], { env });
  assert.equal(result.stdout, cwd);
  await tmux("send-keys", "-t", "=source-copy:", `${shQuote(realTmux)} -S ${shQuote(socket)} wait-for -S copy-ready`, "Enter");
  await tmux("wait-for", "copy-ready");
  assert.equal((await tmux("display-message", "-p", "-t", "=source-copy:", "#{pane_current_path}")).stdout.trim(), cwd);
  assert.notEqual((await tmux("display-message", "-p", "-t", "=source-copy:", "#{pane_id}")).stdout.trim(), sourcePane);
  assert.equal((await tmux("display-message", "-p", "-t", "=source-copy:", "#{session_group}")).stdout.trim(), "");
  await tmux("kill-session", "-t", "=source-copy");
  assert.equal((await tmux("display-message", "-p", "-t", "=source:1", "#{pane_id}")).stdout.trim(), sourcePane);
  await assert.rejects(run("sh", ["-c", duplicationCommand("missing", undefined, "missing-copy")], { env }));
  await assert.rejects(tmux("has-session", "-t", "=missing-copy"));
  for (const [name, window, copy] of [["source\nother", 1, "copy"], ["source", -1, "copy"], ["source", 1, "-bad;copy"]]) {
    assert.throws(() => duplicationCommand(name, window, copy), /invalid/);
  }
});

test("duplicate routes to the source host, uses unique names and reports failures", async (t) => {
  const { duplicateSession } = await import("../lib/tmux.js");
  const calls = [];
  const mock = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls.push({ command, args });
    assert.ok(options.timeout <= 15000);
    callback(args.includes("offline-device") ? new Error("failed") : null, "/projects/live");
  });
  syncBuiltinESMExports();
  try {
    const first = await duplicateSession("source", 3, "fixture-device");
    const second = await duplicateSession("source", 3, "fixture-device");
    assert.notEqual(first.name, second.name);
    assert.equal(first.cwd, "/projects/live");
    assert.equal(calls[0].command, "ssh");
    assert.ok(calls[0].args.includes("fixture-device"));
    assert.match(calls[0].args.at(-1), /=source:3/);
    await duplicateSession("source", undefined, "");
    assert.equal(calls[2].command, "sh");
    await assert.rejects(duplicateSession("source", undefined, "offline-device"), /Could not duplicate/);
    await assert.rejects(duplicateSession("source", undefined, "-bad-host"), /invalid host/);
    assert.equal(calls.length, 4);
  } finally {
    mock.mock.restore();
    syncBuiltinESMExports();
  }
});
