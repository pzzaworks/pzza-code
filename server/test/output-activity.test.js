import assert from "node:assert/strict";
import test from "node:test";
import { paneOutputActivity, parsePaneOutputActivity } from "../lib/tmux.js";

test("output activity rows keep session, window, epoch and command", () => {
  assert.deepEqual(
    parsePaneOutputActivity("Devbox - Shell\t0\t1789895803\tbash\nTreasury\t2\t0\tbtop\n"),
    [
      { session: "Devbox - Shell", window: 0, activity: 1789895803, command: "bash" },
      { session: "Treasury", window: 2, activity: 0, command: "btop" },
    ],
  );
});

test("output activity parsing drops malformed and hostile rows", () => {
  assert.deepEqual(parsePaneOutputActivity(""), []);
  assert.deepEqual(parsePaneOutputActivity("only-two\tfields\n"), []);
  assert.deepEqual(parsePaneOutputActivity("s\tNaN\t12\tbash\n"), []);
  assert.deepEqual(parsePaneOutputActivity("s\t0\t-3\tbash\n"), []);
  assert.deepEqual(parsePaneOutputActivity("s\t1.5\t12\tbash\n"), []);
  assert.deepEqual(parsePaneOutputActivity("bad\x01name\t0\t12\tbash\n"), []);
  assert.deepEqual(parsePaneOutputActivity("s\t0\t12\n"), [{ session: "s", window: 0, activity: 12, command: "" }]);
});

test("output activity rejects an invalid host without spawning", () => {
  assert.rejects(paneOutputActivity("-bad host"), /invalid host/);
});

test("output activity uses one tmux invocation and configures only unmonitored windows", { timeout: 15_000 }, async (t) => {
  const { execFile } = await import("node:child_process");
  const { promisify } = await import("node:util");
  const { mkdtemp, mkdir, readFile, rm, writeFile } = await import("node:fs/promises");
  const path = await import("node:path");
  const { shQuote } = await import("../lib/shell.js");
  const run = (command, args, options = {}) => promisify(execFile)(command, args, { timeout: 5_000, ...options });
  const root = await mkdtemp("/tmp/pzza-output-");
  const socket = path.join(root, "socket");
  const realTmux = (await run("sh", ["-c", "command -v tmux"])).stdout.trim();
  const tmux = (...args) => run(realTmux, ["-S", socket, ...args]);
  const previous = { path: process.env.PATH, socket: process.env.PZZA_TMUX_SOCKET };
  t.after(async () => {
    process.env.PATH = previous.path;
    if (previous.socket === undefined) delete process.env.PZZA_TMUX_SOCKET;
    else process.env.PZZA_TMUX_SOCKET = previous.socket;
    await tmux("kill-server").catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  const bin = path.join(root, "bin");
  const log = path.join(root, "invocations");
  await mkdir(bin);
  await writeFile(path.join(bin, "tmux"), `#!/bin/sh\necho x >> ${shQuote(log)}\nexec ${shQuote(realTmux)} "$@"\n`, { mode: 0o700 });
  await tmux("-f", "/dev/null", "new-session", "-d", "-s", "work", "sleep 30");
  for (let index = 0; index < 4; index++) await tmux("new-window", "-t", "work", "sleep 30");
  await tmux("set-window-option", "-t", "work:2", "monitor-activity", "off");
  process.env.PATH = `${bin}:${process.env.PATH}`;
  process.env.PZZA_TMUX_SOCKET = socket;
  const invocations = async () => (await readFile(log, "utf8").catch(() => "")).split("\n").filter(Boolean).length;

  const first = await paneOutputActivity("");
  assert.deepEqual(first.map((row) => row.window), [0, 1, 2, 3, 4]);
  assert.equal(await invocations(), 2);
  assert.equal((await tmux("list-windows", "-t", "work", "-F", "#{monitor-activity}")).stdout, "1\n1\n1\n1\n1\n");
  await paneOutputActivity("");
  assert.equal(await invocations(), 3);
});
