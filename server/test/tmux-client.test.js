import test from "node:test";
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { mkdtemp, mkdir, writeFile, readFile, rm, stat } from "node:fs/promises";
import path from "node:path";
import net from "node:net";
import { tmuxArgs, tmuxCommand } from "../lib/tmux-client.js";
import { deviceEnv, shQuote } from "../lib/shell.js";
import { scanSessions, terminationCommand, duplicationCommand } from "../lib/tmux.js";
import { probeSessionActivity, ACTIVITY_PROBE_SCRIPT } from "../lib/session-activity.js";
import { openQuickChat } from "../lib/quick-chat.js";

const run = (command, args, options = {}) => promisify(execFile)(command, args, { timeout: 5000, ...options });
function socketEnvironment(t, socket) {
  const previous = process.env.PZZA_TMUX_SOCKET;
  if (socket === undefined) delete process.env.PZZA_TMUX_SOCKET;
  else process.env.PZZA_TMUX_SOCKET = socket;
  t.after(() => {
    if (previous === undefined) delete process.env.PZZA_TMUX_SOCKET;
    else process.env.PZZA_TMUX_SOCKET = previous;
  });
}
async function directory(t) {
  const root = await mkdtemp("/tmp/pzza-client-");
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test("managed shell and argv clients preserve hostile socket paths literally", async (t) => {
  const root = await directory(t);
  const socket = path.join(root, "sock ' $(touch injected); $HOME");
  socketEnvironment(t, socket);
  const bin = path.join(root, "bin");
  await mkdir(bin);
  await writeFile(path.join(bin, "tmux"), "#!/bin/sh\nprintf '%s\\0' \"$@\"\n", { mode: 0o700 });
  const args = ["new-session", "-s", "session ' $(literal)"];
  const result = await run("sh", ["-c", `${tmuxCommand("")} ${args.map(shQuote).join(" ")}`], {
    cwd: root, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` },
  });
  assert.deepEqual(result.stdout.split("\0").slice(0, -1), ["-N", "-S", socket, ...args]);
  assert.deepEqual(tmuxArgs(args), ["-N", "-S", socket, ...args]);
  await assert.rejects(stat(path.join(root, "injected")), { code: "ENOENT" });
  for (const invalid of ["", "relative", "/tmp/bad\0socket"]) assert.throws(() => tmuxArgs([], invalid), /Invalid local/);
});

test("standalone clients retain default routing and remote commands discard local socket context", async (t) => {
  socketEnvironment(t, undefined);
  assert.deepEqual(tmuxArgs(["list-sessions"]), ["list-sessions"]);
  const terminate = terminationCommand("work", undefined, "remote");
  const duplicate = duplicationCommand("work", undefined, "copy", "remote");
  process.env.PZZA_TMUX_SOCKET = "/tmp/local socket";
  assert.equal(tmuxCommand("remote"), "tmux");
  assert.equal(terminationCommand("work", undefined, "remote"), terminate);
  assert.equal(duplicationCommand("work", undefined, "copy", "remote"), duplicate);
  const env = deviceEnv("remote", { PZZA_TMUX_SOCKET: "/tmp/local socket", TMUX: "/tmp/unrelated,1,0", PATH: "/bin" });
  assert.deepEqual(env, { PATH: "/bin" });
  await openQuickChat({ host: "remote", agent: "claude" }, (command, args, options, callback) => {
    assert.equal(command, "ssh");
    assert.ok(!args.at(-1).includes("/tmp/local socket"));
    assert.ok(!args.at(-1).includes("-N -S"));
    assert.equal(options.env.PZZA_TMUX_SOCKET, undefined);
    callback(null, "claude\nclaude\n$1:100:200");
  });
});

test("managed scans and activity stay isolated and missing service cannot be recreated by clients", { timeout: 15000 }, async (t) => {
  const root = await directory(t);
  const socket = path.join(root, "managed ' socket");
  const external = path.join(root, "unrelated");
  socketEnvironment(t, socket);
  const tmux = (target, ...args) => run("tmux", ["-S", target, ...args]);
  t.after(async () => {
    await tmux(socket, "kill-server").catch(() => {});
    await tmux(external, "kill-server").catch(() => {});
  });
  await tmux(external, "-f", "/dev/null", "new-session", "-d", "-s", "unrelated", "exec sleep 30");
  await tmux(socket, "-f", "/dev/null", "new-session", "-d", "-s", "managed", "exec sleep 30");
  assert.deepEqual((await scanSessions("")).map(row => row.name), ["managed"]);
  assert.deepEqual((await probeSessionActivity()).map(row => row.session), ["managed"]);
  await run("sh", ["-c", terminationCommand("managed", undefined, "")]);
  await tmux(external, "has-session", "-t", "=unrelated");
  await assert.rejects(run("tmux", tmuxArgs(["new-session", "-d", "-s", "must-not-start"]), {
    env: { ...process.env, TMUX: `${external},1,0` },
  }));
  assert.deepEqual(await scanSessions(""), []);
  const missing = path.join(root, "never-started");
  await assert.rejects(run("tmux", tmuxArgs(["new-session", "-d", "-s", "must-not-start"], missing)));
  await assert.rejects(stat(missing), { code: "ENOENT" });
  await tmux(external, "has-session", "-t", "=unrelated");
});

test("serialized remote activity uses plain tmux even if a remote environment contains a socket variable", async (t) => {
  const root = await directory(t);
  const log = path.join(root, "args");
  await writeFile(path.join(root, "tmux"), `#!/bin/sh\nprintf '%s\\n' "$@" > ${shQuote(log)}\n`, { mode: 0o700 });
  await run(process.execPath, ["-e", ACTIVITY_PROBE_SCRIPT], {
    env: { ...process.env, PATH: `${root}:${process.env.PATH}`, PZZA_TMUX_SOCKET: "/tmp/must-not-be-used" },
  });
  const args = (await readFile(log, "utf8")).split("\n");
  assert.equal(args[0], "list-panes");
  assert.ok(!args.includes("-S"));
});

test("create endpoint reports missing managed service and acknowledges only successful creation", { timeout: 15000 }, async (t) => {
  const root = await directory(t);
  const socket = path.join(root, "service");
  const listener = net.createServer();
  listener.listen(0, "127.0.0.1");
  await once(listener, "listening");
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const child = spawn(process.execPath, ["server/index.js"], { env: {
    ...process.env, PORT: String(port), HOME: root, XDG_CONFIG_HOME: root, PZZA_SERVER_HOST: "",
    PZZA_TMUX_SOCKET: socket, PZZA_AGENT_TOKEN: "fixture-auth", PZZA_MANAGED_AGENT: "0",
  }, stdio: ["ignore", "pipe", "pipe"] });
  t.after(async () => {
    child.kill("SIGTERM");
    if (child.exitCode === null && child.signalCode === null) await once(child, "exit");
    await run("tmux", ["-S", socket, "kill-server"]).catch(() => {});
  });
  await once(child.stdout, "data");
  const create = (name) => fetch(`http://127.0.0.1:${port}/create`, {
    method: "POST", headers: { Authorization: "Bearer fixture-auth", "Content-Type": "application/json" },
    body: JSON.stringify({ name }), signal: AbortSignal.timeout(5000),
  });
  assert.equal((await create("")).status, 400);
  const unavailable = await create("work");
  assert.equal(unavailable.status, 503);
  assert.equal((await unavailable.json()).ok, undefined);
  await run("tmux", ["-S", socket, "-f", "/dev/null", "new-session", "-d", "-s", "anchor", "exec sleep 30"]);
  await run("tmux", ["-S", socket, "set-option", "-g", "default-shell", "/bin/sh"]);
  assert.equal((await create("work")).status, 200);
  await run("tmux", ["-N", "-S", socket, "has-session", "-t", "=work"]);
  assert.equal((await create("work")).status, 503);
});
