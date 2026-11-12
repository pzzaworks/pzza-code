import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { build } from "esbuild";
import pty from "node-pty";
import { PANE_HISTORY_ROWS, PaneModeRequestError, paneLines, paneLinesCommand, paneLinesRequest, paneMode, paneModeCommand, paneModeRequest, paneTarget } from "../lib/pane-mode.js";

const run = (command, args, options = {}) => promisify(execFile)(command, args, { timeout: 5000, ...options });
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const gateModule = await build({ entryPoints: [new URL("../../src/terminal/paneModeGate.ts", import.meta.url).pathname], bundle: true, format: "esm", write: false });
const { createPaneModeGate } = await import(`data:text/javascript;base64,${Buffer.from(gateModule.outputFiles[0].text).toString("base64")}`);

function socketEnvironment(t, socket) {
  const previous = process.env.PZZA_TMUX_SOCKET;
  process.env.PZZA_TMUX_SOCKET = socket;
  t.after(() => {
    if (previous === undefined) delete process.env.PZZA_TMUX_SOCKET;
    else process.env.PZZA_TMUX_SOCKET = previous;
  });
}

// An isolated tmux server with the settings behind the bug (mouse on, vi
// mode keys), a plain shell with history to scroll, and a real attached
// client: bytes written to it are what a tile's terminal sends.
async function paneServer(t) {
  const root = await mkdtemp("/tmp/pzza-pane-mode-");
  const socket = path.join(root, "s");
  const tmux = (...args) => run("tmux", ["-N", "-S", socket, ...args]);
  const clients = [];
  t.after(async () => {
    for (const client of clients) client.kill();
    const entries = await readdir(root, { withFileTypes: true }).catch(() => []);
    await Promise.all(entries.filter(entry => entry.isSocket()).map(entry =>
      run("tmux", ["-S", path.join(root, entry.name), "kill-server"]).catch(() => {})));
    await rm(root, { recursive: true, force: true });
  });
  await run("tmux", ["-f", "/dev/null", "-S", socket, "new-session", "-d", "-s", "work", "-x", "80", "-y", "24", "/bin/sh",
    ";", "set-option", "-g", "mouse", "on", ";", "set-window-option", "-g", "mode-keys", "vi"],
  { env: { ...process.env, ENV: "/dev/null", PS1: "$ ", TMUX: "" } });
  const screen = async () => (await tmux("capture-pane", "-p", "-J", "-t", "=work:")).stdout.split("\n").map(line => line.trim());
  const waitForLine = async text => {
    const end = Date.now() + 5000;
    while (!(await screen()).includes(text)) {
      if (Date.now() > end) throw new Error(`${text} never appeared: ${(await screen()).join("\n")}`);
      await pause(50);
    }
  };
  await tmux("send-keys", "-t", "=work:", "-l", "i=0; while [ $i -lt 60 ]; do echo line$i; i=$((i+1)); done");
  await tmux("send-keys", "-t", "=work:", "Enter");
  await waitForLine("line59");
  const attach = async () => {
    const env = { ...process.env, TERM: "xterm-256color" };
    delete env.TMUX;
    const client = pty.spawn("tmux", ["-N", "-S", socket, "attach", "-t", "=work"], { name: "xterm-256color", cols: 80, rows: 24, env });
    client.onData(() => {});
    clients.push(client);
    const end = Date.now() + 5000;
    while (!(await tmux("list-clients", "-F", "#{client_name}")).stdout.trim()) {
      if (Date.now() > end) throw new Error("The client never attached");
      await pause(25);
    }
    return client;
  };
  const inMode = async () => (await tmux("display-message", "-p", "-t", "=work:", "#{pane_in_mode}")).stdout.trim() === "1";
  return { root, socket, tmux, attach, inMode, screen, waitForLine };
}

// What a wheel-up over the pane sends with mouse reporting on.
const WHEEL_UP = "\x1b[<64;10;5M";

test("pane mode requests are validated strictly and targets stay literal", () => {
  assert.equal(paneTarget("work", undefined), "=work:");
  assert.equal(paneTarget("my work", 2), "=my work:2");
  assert.deepEqual(paneModeRequest({ name: "work", leave: true }), { name: "work", window: undefined, host: undefined, leave: true });
  assert.deepEqual(paneModeRequest({ name: "work", window: 0, host: "me@devbox", leave: false }), { name: "work", window: 0, host: "me@devbox", leave: false });
  assert.deepEqual(paneModeRequest({ name: "work", window: null, host: "", leave: false }), { name: "work", window: undefined, host: "", leave: false });
  const invalid = [
    null, [], "work", {},
    { name: "work" }, { name: "work", leave: "yes" },
    { name: "", leave: true }, { name: "  ", leave: true }, { name: "a:b", leave: true }, { name: "a.b", leave: true },
    { name: "a\nb", leave: true }, { name: "x".repeat(257), leave: true }, { name: 7, leave: true },
    { name: "work", window: -1, leave: true }, { name: "work", window: 1.5, leave: true }, { name: "work", window: "1", leave: true },
    { name: "work", host: "-oProxyCommand=touch", leave: true }, { name: "work", host: "box;rm", leave: true }, { name: "work", host: 5, leave: true },
  ];
  for (const body of invalid) assert.throws(() => paneModeRequest(body), PaneModeRequestError, JSON.stringify(body));
  // Remote devices use their own default tmux server, never the local socket.
  const remote = paneModeCommand("it's $(touch x)", 3, "devbox", true);
  assert.ok(remote.startsWith(`tmux -u copy-mode -q -t '=it'\\''s $(touch x):3' 2>/dev/null || `), remote);
  assert.ok(!remote.includes("-S"));
});

test("the agent endpoint finds and leaves copy-mode so typed text reaches the program", { timeout: 20000 }, async (t) => {
  const pane = await paneServer(t);
  const client = await pane.attach();
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const token = randomBytes(24).toString("hex");
  const agent = spawn(process.execPath, ["server/index.js"], {
    env: { ...process.env, PORT: String(port), HOME: pane.root, XDG_CONFIG_HOME: pane.root, PZZA_SERVER_HOST: "",
      PZZA_TMUX_SOCKET: pane.socket, PZZA_AGENT_TOKEN: token, PZZA_MANAGED_AGENT: "0" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  t.after(async () => {
    agent.kill("SIGTERM");
    if (agent.exitCode === null && agent.signalCode === null) await once(agent, "exit");
  });
  await once(agent.stdout, "data");
  const request = async body => {
    const response = await fetch(`http://127.0.0.1:${port}/session/pane-mode`, {
      method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };

  assert.deepEqual(await request({ name: "work", host: "", leave: false }), { status: 200, body: { inMode: false } });
  client.write(WHEEL_UP + WHEEL_UP);
  await pause(200);
  assert.deepEqual(await request({ name: "work", window: 0, host: "", leave: false }), { status: 200, body: { inMode: true } });
  // This is the bug: vi copy-mode takes the keys, the shell never sees them.
  client.write("echo gone");
  await pause(200);
  assert.equal(await pane.inMode(), true);
  assert.deepEqual(await request({ name: "work", host: "", leave: true }), { status: 200, body: { inMode: false } });
  assert.equal(await pane.inMode(), false);
  client.write("echo reached\r");
  await pane.waitForLine("reached");
  assert.ok(!(await pane.screen()).some(line => line.includes("gone")));

  // Strict validation, and a missing pane is an error rather than a guess.
  for (const body of [{ name: "work", host: "-oProxyCommand=x", leave: true }, { name: "a:b", leave: true }, { name: "work", window: -1, leave: true }, { name: "work" }]) {
    assert.equal((await request(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await request({ name: "missing", host: "", leave: true })).status, 503);
  const unauthorized = await fetch(`http://127.0.0.1:${port}/session/pane-mode`, { method: "POST", body: JSON.stringify({ name: "work", leave: true }) });
  assert.equal(unauthorized.status, 401);

  // The pane's history and visible rows, ending with what the screen shows.
  const lines = async (body, headers = { Authorization: `Bearer ${token}` }) => {
    const response = await fetch(`http://127.0.0.1:${port}/session/pane-lines`, {
      method: "POST", headers: { ...headers, "Content-Type": "application/json" }, body: JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const captured = await lines({ name: "work", window: 0, host: "" });
  assert.equal(captured.status, 200);
  const visible = (await pane.tmux("capture-pane", "-p", "-t", "=work:")).stdout.replace(/\n$/, "").split("\n");
  assert.deepEqual(captured.body.lines.slice(-visible.length), visible);
  assert.ok(captured.body.lines.length > visible.length);
  for (const body of [{ name: "work", host: "-oProxyCommand=x" }, { name: "a:b" }, { name: "work", window: -1 }, []]) {
    assert.equal((await lines(body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await lines({ name: "missing", host: "" })).status, 503);
  assert.equal((await lines({ name: "work" }, {})).status, 401);
});

test("leaving works on every mode and on a tmux without the quit flag", { timeout: 15000 }, async (t) => {
  const pane = await paneServer(t);
  socketEnvironment(t, pane.socket);
  await pane.tmux("choose-tree", "-t", "=work:");
  assert.deepEqual(await paneMode({ name: "work", host: "", leave: false }), { inMode: true });
  assert.deepEqual(await paneMode({ name: "work", host: "", leave: true }), { inMode: false });
  assert.equal(await pane.inMode(), false);
  // Leaving when no mode is on changes nothing and succeeds.
  assert.deepEqual(await paneMode({ name: "work", host: "", leave: true }), { inMode: false });
  await assert.rejects(paneMode({ name: "missing", host: "", leave: true }));

  // The remote command on an older tmux, where `copy-mode -q` is an unknown flag.
  const real = (await run("sh", ["-c", "command -v tmux"])).stdout.trim();
  const bin = path.join(pane.root, "bin");
  await run("mkdir", [bin]);
  await writeFile(path.join(bin, "tmux"), `#!/bin/sh
if [ "$2" = copy-mode ] && [ "$3" = -q ]; then echo rejected >> '${path.join(pane.root, "rejected")}'; echo 'unknown flag -q' >&2; exit 1; fi
exec '${real}' -N -S '${pane.socket}' "$@"
`, { mode: 0o700 });
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  delete env.TMUX;
  const remote = leave => run("sh", ["-c", paneModeCommand("work", undefined, "devbox", leave)], { env });
  await pane.tmux("copy-mode", "-t", "=work:");
  assert.equal((await remote(false)).stdout.trim(), "1");
  await remote(true);
  assert.equal(await pane.inMode(), false);
  await remote(true);
  assert.equal((await remote(false)).stdout.trim(), "0");
  // Both leaves went through the fallback.
  assert.equal((await readFile(path.join(pane.root, "rejected"), "utf8")).trim().split("\n").length, 2);
});

test("the input gate leaves the mode once and delivers every keystroke in order", { timeout: 20000 }, async (t) => {
  const pane = await paneServer(t);
  socketEnvironment(t, pane.socket);
  const client = await pane.attach();
  let leaves = 0;
  const gate = createPaneModeGate({
    write: async data => { client.write(data); },
    leave: async () => {
      leaves++;
      // A slow device: keystrokes keep arriving while the exit runs.
      await pause(300);
      await paneMode({ name: "work", host: "", leave: true });
    },
  });
  await gate.send(WHEEL_UP);
  await gate.send(WHEEL_UP);
  await pause(200);
  assert.equal(await pane.inMode(), true);
  assert.equal(gate.mayBeInMode(), true);
  // Each key as its own input event, none awaited, as a fast typist sends them.
  const writes = [..."echo first keys"].map(key => gate.send(key));
  writes.push(gate.send("\r"));
  await Promise.all(writes);
  await pane.waitForLine("first keys");
  assert.equal(leaves, 1);
  assert.equal(gate.mayBeInMode(), false);

  // Typing with no scroll before it makes no extra call.
  await Promise.all([..."echo second\r"].map(key => gate.send(key)));
  await pane.waitForLine("second");
  assert.equal(leaves, 1);

  // Scrolling back to the bottom leaves copy-mode by itself (copy-mode -e).
  await gate.send(WHEEL_UP);
  await pause(200);
  assert.equal(await pane.inMode(), true);
  for (let step = 0; step < 6; step++) await gate.send("\x1b[<65;10;5M");
  await pause(200);
  assert.equal(await pane.inMode(), false);
});

test("pane line requests are validated strictly and capture a bounded history without joining rows", () => {
  assert.deepEqual(paneLinesRequest({ name: "work" }), { name: "work", window: undefined, host: undefined });
  assert.deepEqual(paneLinesRequest({ name: "work", window: 2, host: "me@devbox" }), { name: "work", window: 2, host: "me@devbox" });
  assert.deepEqual(paneLinesRequest({ name: "work", window: null, host: "" }), { name: "work", window: undefined, host: "" });
  const invalid = [
    null, [], "work", {}, { name: "" }, { name: "a:b" }, { name: "a.b" }, { name: "a\nb" }, { name: "x".repeat(257) },
    { name: "work", window: -1 }, { name: "work", window: 1.5 }, { name: "work", window: "1" },
    { name: "work", host: "-oProxyCommand=touch" }, { name: "work", host: "box;rm" }, { name: "work", host: 5 },
  ];
  for (const body of invalid) assert.throws(() => paneLinesRequest(body), PaneModeRequestError, JSON.stringify(body));
  assert.equal(paneLinesCommand("it's $(touch x)", 3, "devbox"), `tmux -u capture-pane -p -S -${PANE_HISTORY_ROWS} -t '=it'\\''s $(touch x):3'`);
  assert.doesNotMatch(paneLinesCommand("work", undefined, "devbox"), / -J/);
});

test("pane lines hold the bounded history right above the visible rows", { timeout: 20000 }, async (t) => {
  const pane = await paneServer(t);
  socketEnvironment(t, pane.socket);
  await pane.tmux("send-keys", "-t", "=work:", "-l", "i=0; while [ $i -lt 400 ]; do echo \"row$i ╌╌\"; i=$((i+1)); done");
  await pane.tmux("send-keys", "-t", "=work:", "Enter");
  await pane.waitForLine("row399 ╌╌");
  const visible = (await pane.tmux("capture-pane", "-p", "-t", "=work:")).stdout.replace(/\n$/, "").split("\n");
  assert.equal(visible.length, 24);
  const { lines } = await paneLines({ name: "work", host: "" });
  assert.equal(lines.length, PANE_HISTORY_ROWS + visible.length);
  assert.deepEqual(lines.slice(-visible.length), visible);
  const first = visible.findIndex(line => line.startsWith("row"));
  const shown = Number(/^row(\d+)/.exec(visible[first])[1]);
  assert.equal(lines[lines.length - visible.length - 1 + first], `row${shown - 1} ╌╌`);
  await assert.rejects(paneLines({ name: "missing", host: "" }));
});
