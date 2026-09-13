import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import { shQuote } from "../lib/shell.js";

const result = await build({ entryPoints: ["src/connection.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { sessionConnection, attachCommand } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("explicit local sessions never inherit a remote default connection", () => {
  const connection = sessionConnection("", { host: "remote-device" });
  assert.equal(connection.host, null);
  const command = attachCommand(connection, "same-name");
  assert.equal(command.cmd, "sh");
  assert.ok(!command.args.includes("remote-device"));
  assert.equal(connection.host ?? "", "");
});

test("named remote and inherited connections retain their target", () => {
  for (const [host, expected] of [["other-device", "other-device"], [undefined, "default-device"]]) {
    const connection = sessionConnection(host, { host: "default-device" });
    assert.equal(connection.host, expected);
    const command = attachCommand(connection, "same-name");
    assert.equal(command.cmd, "ssh");
    assert.ok(command.args.includes(expected));
  }
  assert.equal(attachCommand(sessionConnection(undefined, { host: null }), "same-name").cmd, "sh");
});

test("local attach routes every command through the managed socket with literal shell arguments", async (t) => {
  const root = await mkdtemp("/tmp/pzza-attach-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const log = path.join(root, "calls");
  const socket = path.join(root, "sock ' $(touch injected); $HOME");
  await writeFile(path.join(root, "tmux"), `#!/bin/sh\nprintf '%s\\0' "$@" >> ${shQuote(log)}\nprintf '\\n' >> ${shQuote(log)}\n`, { mode: 0o700 });
  for (const window of [undefined, 2]) {
    await writeFile(log, "");
    const command = attachCommand({ host: null }, "session ' $(touch injected)", "/tmp/folder ' quote", window);
    await promisify(execFile)(command.cmd, [command.args[0], `PATH=${shQuote(root)}:$PATH; ${command.args[1]}`], {
      timeout: 5000, cwd: root, env: { ...process.env, PZZA_TMUX_SOCKET: socket, TMUX: "/tmp/unrelated,1,0" },
    });
    const calls = (await readFile(log, "utf8")).trim().split("\n").map(line => line.split("\0").slice(0, -1));
    assert.ok(calls.length >= 2);
    for (const args of calls) assert.deepEqual(args.slice(0, 3), ["-N", "-S", socket]);
    assert.equal(calls.at(-1)[3], "-u");
    assert.equal(calls.at(-1)[4], window === undefined ? "new-session" : "attach");
  }
  await assert.rejects(stat(path.join(root, "injected")), { code: "ENOENT" });
  for (const window of [undefined, 2]) {
    const remote = attachCommand({ host: "remote" }, "session", undefined, window);
    assert.ok(!remote.args.at(-1).includes("PZZA_TMUX_SOCKET"));
    assert.ok(!remote.args.at(-1).includes("-N -S"));
    assert.match(remote.args.at(-1), /exec tmux -u/);
  }
});

test("managed chat attachment verifies identity and only attaches to the existing session id", () => {
  for (const host of [null, "remote"]) {
    const command = attachCommand({ host }, "pzza-quick-chat", undefined, undefined, { agent: "codex", identity: "$12:100:200" });
    const shell = command.args.at(-1);
    assert.doesNotMatch(shell, /new-session| -A |kill-session/);
    assert.match(shell, /PZZA_QUICK_CHAT_AGENT/);
    assert.match(shell, /session_created/);
    assert.match(shell, /exec .* -u attach -t/);
    assert.match(shell, /\$12/);
  }
  assert.throws(() => attachCommand({ host: null }, "other-session", undefined, undefined, { agent: "codex", identity: "$1:1:1" }));
  assert.throws(() => attachCommand({ host: null }, "pzza-quick-chat", undefined, undefined, { agent: "codex", identity: "$(touch bad)" }));
});

test("local attachment rejects an empty or relative managed socket before invoking tmux", async () => {
  const command = attachCommand({ host: null }, "session");
  for (const socket of ["", "relative"]) {
    await assert.rejects(promisify(execFile)(command.cmd, command.args, {
      timeout: 5000, env: { ...process.env, PZZA_TMUX_SOCKET: socket },
    }), { code: 1 });
  }
});

test("a window view survives attachment and disappears on detach without closing its source", { timeout: 15000 }, async t => {
  const root = await mkdtemp("/tmp/pzza-view-lifetime-");
  const socket = path.join(root, "tmux");
  const tmux = args => promisify(execFile)("tmux", ["-S", socket, ...args], { timeout: 3000 });
  t.after(async () => { await tmux(["kill-server"]).catch(() => {}); await rm(root, { recursive: true, force: true }); });
  await tmux(["-f", "/dev/null", "new-session", "-d", "-s", "source", "sleep 30"]);
  const index = Number((await tmux(["display-message", "-p", "-t", "=source:", "#{window_index}"])).stdout.trim());
  const command = attachCommand({ host: null }, "source", undefined, index);
  await promisify(execFile)("python3", ["-c", String.raw`
import json, os, pty, subprocess, sys, time
command, socket = json.loads(sys.argv[1]), sys.argv[2]
def tmux(*args):
    return subprocess.check_output(['tmux', '-S', socket, *args], text=True, timeout=3).strip()
pid, fd = pty.fork()
if pid == 0:
    os.execvpe(command['cmd'], [command['cmd'], *command['args']], {**os.environ, 'PZZA_TMUX_SOCKET': socket, 'TERM': 'xterm-256color'})
try:
    deadline, view = time.monotonic() + 5, None
    while time.monotonic() < deadline:
        for row in tmux('list-sessions', '-F', '#{session_name}:#{session_attached}').splitlines():
            name, attached = row.rsplit(':', 1)
            if name.startswith('pzza-v-') and attached == '1':
                view = name
        if view and tmux('show-options', '-Av', '-t', view, 'destroy-unattached') == 'on':
            break
        time.sleep(0.05)
    else:
        raise AssertionError('The window view did not attach and arm cleanup')
    tmux('detach-client', '-s', view)
    while time.monotonic() < deadline:
        if view not in tmux('list-sessions', '-F', '#{session_name}').splitlines():
            break
        time.sleep(0.05)
    else:
        raise AssertionError('The detached window view was not removed')
    tmux('has-session', '-t', '=source')
finally:
    os.close(fd)
    os.waitpid(pid, 0)
`, JSON.stringify(command), socket], { timeout: 10000 });
});


test("simultaneous window attachments have distinct view names", () => {
  const original = Date.now;
  Date.now = () => 123456;
  try {
    const commands = Array.from({ length: 20 }, () => attachCommand({ host: null }, "source", undefined, 2).args.at(-1));
    const names = commands.map(command => command.match(/pzza-v-[a-f0-9-]+/)[0]);
    assert.equal(new Set(names).size, commands.length);
  } finally { Date.now = original; }
});
