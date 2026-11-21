import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { INTERNAL_SESSIONS, inspectPortProcesses, listPortDetails, parsePorts, portProbeRules, protectedListenerPort, stopPortContainer, terminateListener, terminateRemoteListener } from "../lib/ports.js";

test("port parser deduplicates IPv4 and IPv6 listeners", () => {
  assert.deepEqual(parsePorts("127.0.0.1:3000\n[::]:3000\n*:4100\n"), [3000, 4100]);
});

test("macOS process scans preserve surviving identities when another process disappears", async (t) => {
  const root = await mkdtemp(path.join(os.homedir(), ".pzza-port-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "surviving-project" }));
  let exitCode = 1;
  t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    // The process table and the session list are read too; neither is needed here.
    if (command === "ps" || command === "tmux") return callback(null, "");
    assert.equal(command, "lsof");
    if (args.includes("-iTCP")) callback(null, "p1234\ncnode\nn127.0.0.1:4567\n");
    else callback(Object.assign(new Error("Process selection incomplete"), { code: exitCode }), `p1234\nn${root}\n`);
  });
  syncBuiltinESMExports();
  t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
  const inspect = () => inspectPortProcesses({ platform: "darwin", containers: false });
  assert.equal((await inspect())[0].processes[0].name, "surviving-project");
  exitCode = 2;
  assert.equal((await inspect())[0].processes[0].name, "node");
});

test("listener identity uses its actual project name, then working folder", { skip: !["linux", "darwin"].includes(os.platform()) }, async (t) => {
  const root = await mkdtemp(path.join(os.homedir(), ".pzza-port-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "service");
  await mkdir(cwd);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "actual-preview-project" }));
  const child = spawn(process.execPath, ["-e", "require('node:http').createServer((req,res)=>res.end()).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } });
  const [chunk] = await once(child.stdout, "data");
  const port = Number(String(chunk).trim());
  const find = async () => (await inspectPortProcesses({ containers: false })).find((entry) => entry.port === port)?.processes.find((entry) => entry.pid === child.pid);
  const project = await find();
  assert.equal(project?.name, "actual-preview-project");
  assert.equal(project?.source, "package");
  assert.ok(project.process);
  assert.equal("arguments" in project, false);
  assert.equal("environment" in project, false);
  await rm(path.join(root, "package.json"));
  const folder = await find();
  assert.equal(folder?.name, "service");
  assert.equal(folder?.source, "folder");
});

test("invalid SSH targets fail before process probing", async () => {
  await assert.rejects(listPortDetails("-oProxyCommand=bad"), /Invalid device host/);
});

test("protected ports refuse termination while ordinary ports pass", () => {
  assert.equal(protectedListenerPort([3000, 8080]), null);
  assert.equal(protectedListenerPort([3000, 5190]), 5190);
  assert.equal(protectedListenerPort([22]), 22);
  assert.equal(protectedListenerPort([]), null);
});

test("process termination validates its target before touching anything", async () => {
  for (const pid of [0, 1, -5, 1.5, Number.NaN, "123", null, undefined]) {
    await assert.rejects(terminateListener({ pid }), /valid process ID/);
  }
  await assert.rejects(terminateListener({ pid: process.pid }), /valid process ID/);
  await assert.rejects(terminateListener({ host: "-oProxyCommand=bad", pid: 1234 }), /Invalid device host/);
  // Nothing may execute for an invalid target: an unknown pid fails the
  // ownership check without killing.
  await assert.rejects(terminateListener({ pid: 2147483647 }), /not listening/);
});

async function spawnListener(t) {
  const child = spawn(process.execPath, ["-e", "require('node:http').createServer((req,res)=>res.end()).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { stdio: ["ignore", "pipe", "ignore"] });
  t.after(() => { if (child.exitCode === null) child.kill("SIGKILL"); });
  const [chunk] = await once(child.stdout, "data");
  return { child, port: Number(String(chunk).trim()) };
}

// Waits for process death without an "exit" listener: under some test
// harnesses awaiting the exit event of a just-signaled child never settles,
// while the production path (plain node) is unaffected.
async function waitForDeath(child, timeoutMs = 5000) {
  const start = Date.now();
  for (;;) {
    if (child.exitCode !== null) return;
    try {
      process.kill(child.pid, 0);
    } catch (error) {
      if (error?.code === "ESRCH") return;
      throw error;
    }
    if (Date.now() - start > timeoutMs) throw new Error(`Process ${child.pid} did not exit after SIGTERM.`);
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

test("local termination kills only a verified listener and reports its ports", { skip: !["linux", "darwin"].includes(os.platform()) }, async (t) => {
  const { child, port } = await spawnListener(t);
  const result = await terminateListener({ pid: child.pid });
  assert.equal(result.pid, child.pid);
  assert.deepEqual(result.ports, [port]);
  await waitForDeath(child);
  // A second attempt finds nothing to kill instead of signaling a reused pid.
  await assert.rejects(terminateListener({ pid: child.pid }), /not listening/);
});

test("serialized remote terminator stays self-contained and enforces the same contract", async (t) => {
  const terminate = (0, eval)(`(${terminateRemoteListener.toString()})`);
  await assert.rejects(terminate(1, []), /valid process ID/);
  await assert.rejects(terminate(process.pid, []), /valid process ID/);
  if (!["linux", "darwin"].includes(os.platform())) return;
  const { child, port } = await spawnListener(t);
  const result = await terminate(child.pid, [22, 5190]);
  assert.equal(result.pid, child.pid);
  assert.deepEqual(result.ports, [port]);
  await waitForDeath(child);
});

test("container stop validates strictly and only ever runs stop", async () => {
  const calls = [];
  const runExec = async (command, args) => { calls.push([command, ...args]); return ""; };
  await assert.deepEqual(
    await stopPortContainer({ id: "a".repeat(12), runtime: "docker" }, { runExec }),
    { id: "a".repeat(12), runtime: "docker" },
  );
  assert.deepEqual(calls, [["docker", "stop", "a".repeat(12)]]);
  await assert.deepEqual(
    await stopPortContainer({ host: "devbox", id: "B".repeat(64), runtime: "podman" }, { runExec }),
    { id: "B".repeat(64), runtime: "podman" },
  );
  assert.deepEqual(calls[1], ["ssh", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "devbox", "podman", "stop", "B".repeat(64)]);
  for (const body of [
    { id: "short", runtime: "docker" },
    { id: "a".repeat(65), runtime: "docker" },
    { id: "zzzzzzzzzzzz", runtime: "docker" },
    { id: "a".repeat(12), runtime: "exec" },
    { id: "a".repeat(12), runtime: "docker; rm" },
    { host: "-oProxyCommand=bad", id: "a".repeat(12), runtime: "docker" },
  ]) {
    const before = calls.length;
    await assert.rejects(stopPortContainer(body, { runExec }), /invalid|Invalid/);
    assert.equal(calls.length, before);
  }
  await assert.rejects(stopPortContainer({ id: "a".repeat(12), runtime: "docker" }, { runExec: async () => { throw new Error("daemon down"); } }), /container runtime/);
});

const containerRow = (id, name, ports, project = "", service = "") => [id, name, ports, project, service].map(JSON.stringify).join("\t");

test("published container TCP bindings identify Compose services and NAT-only ports", async () => {
  const calls = [];
  const result = await inspectPortProcesses({
    platform: "linux", dockerSocket: "/fixture/docker.sock",
    run: async (command, args) => {
      calls.push({ command, args });
      if (command === "ss") return "LISTEN 0 4096 0.0.0.0:3000 0.0.0.0:*";
      if (command === "docker") return containerRow("a".repeat(12), "web-1", "0.0.0.0:3000->80/tcp, [::]:3000->80/tcp, 127.0.0.1:4100-4102->90-92/tcp, 5000/tcp, 0.0.0.0:5353->53/udp", "pzza", "web");
      return containerRow("b".repeat(12), ["worker"], "0.0.0.0:7000->7000/tcp");
    },
  });
  assert.deepEqual(result.map(({ port }) => port), [3000, 4100, 4101, 4102, 7000]);
  assert.equal(result[0].containers.length, 1);
  assert.equal(result[0].containers[0].name, "pzza / web");
  assert.equal(result[0].containers[0].runtime, "docker");
  assert.equal(result.at(-1).containers[0].name, "worker");
  assert.deepEqual(result[1].processes, []);
  assert.ok(calls.find(({ command, args }) => command === "docker" && args[0] === "--host" && args[1] === "unix:///fixture/docker.sock"));
  assert.ok(calls.find(({ command, args }) => command === "podman" && args[0] === "--remote=false"));
  assert.equal(JSON.stringify(calls).includes("inspect"), false);
  assert.equal(JSON.stringify(calls).includes(".Labels"), false);
});

test("malformed metadata and unavailable daemons do not lose host listeners", async () => {
  const result = await inspectPortProcesses({ platform: "linux", dockerSocket: "/fixture/docker.sock", run: async (command) => {
    if (command === "ss") return "LISTEN 0 4096 127.0.0.1:8080 0.0.0.0:*";
    if (command === "docker") return ["invalid-json", containerRow("a".repeat(12), "bad", "0.0.0.0:1-65535->1-65535/tcp, 0.0.0.0:0->80/tcp"), containerRow("invalid", "bad", "0.0.0.0:9000->80/tcp")].join("\n");
    return "";
  } });
  // Nothing names the owner, so the port counts as a system one.
  assert.deepEqual(result, [{ port: 8080, scope: "local", system: true, internal: false, containers: [], processes: [] }]);
});

test("serialized device probe remains self-contained", async () => {
  const probe = (0, eval)(`(${inspectPortProcesses.toString()})`);
  const result = await probe({ platform: "darwin", dockerSocket: null, run: async (command, args) => {
    if (command === "lsof") return "p321\ncDocker\nn*:3000";
    if (command === "podman") return containerRow("c".repeat(12), "local-container", "[::1]:3000->80/tcp");
    if (command === "ps" || command === "tmux") return "";
    assert.fail(`Unexpected command ${command} ${args.join(" ")}`);
  } });
  assert.equal(result[0].containers[0].name, "local-container");
  assert.equal(result[0].processes[0].process, "Docker");
});

test("custom Unix Docker host takes priority over context without contacting remote engines", async () => {
  const calls = [];
  await inspectPortProcesses({ platform: "linux", dockerHost: "unix:///custom/docker.sock", isSocket: async (candidate) => candidate === "/custom/docker.sock", run: async (command, args) => {
    calls.push([command, ...args]);
    return "";
  } });
  assert.ok(calls.some((args) => args[0] === "docker" && args[1] === "--host" && args[2] === "unix:///custom/docker.sock"));
  assert.equal(calls.some((args) => args.includes("context")), false);
});

test("local context sockets support Colima while remote endpoints never reach ps", async () => {
  for (const endpoint of ["unix:///home/test/.colima/default/docker.sock", "tcp://remote:2375", "ssh://remote", "unix:///bad\nendpoint"]) {
    const calls = [];
    await inspectPortProcesses({ platform: "linux", dockerHost: "tcp://ignored:2375", isSocket: async (candidate) => candidate === "/home/test/.colima/default/docker.sock", run: async (command, args) => {
      calls.push([command, ...args]);
      return command === "docker" && args[0] === "context" ? endpoint : "";
    } });
    assert.ok(calls.some((args) => JSON.stringify(args) === JSON.stringify(["docker", "context", "inspect", "--format", "{{.Endpoints.docker.Host}}"] )));
    const ps = calls.filter((args) => args[0] === "docker" && args.includes("ps"));
    assert.equal(ps.length, endpoint.includes(".colima") ? 1 : 0);
    if (ps.length) assert.equal(ps[0][2], endpoint);
  }
});

test("listeners report their reach, age, kind of service and the session that started them", async () => {
  const root = await mkdtemp(path.join(os.homedir(), ".pzza-port-test-"));
  try {
    await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "shop", dependencies: { next: "16.0.0", express: "5.0.0" } }));
    const calls = [];
    const result = await inspectPortProcesses({
      platform: "darwin", containers: false, tmux: ["tmux", "-N", "-S", "/fixture/tmux.sock"],
      run: async (command, args) => {
        calls.push([command, ...args].join(" "));
        if (command === "lsof" && args.includes("-iTCP")) return "p500\ncnode\nn127.0.0.1:3000\np600\ncnode\nn*:4000\np700\ncpostgres\nn[::1]:5432\n";
        if (command === "lsof") return `p500\nn${root}\np600\nn${root}\np700\nn${root}\n`;
        // 600 is a grandchild of the pane 20; 700 has no terminal above it.
        if (command === "ps") return "  500    20       05:10\n  600   550 1-02:03:04\n  550    20       09:00\n   20     1    10:00:00\n  700     1       00:42\n";
        if (command === "tmux") return "20\t/dev/ttys001\tShop dev\n";
        return "";
      },
    });
    const [web, api, database] = result;
    assert.deepEqual([web.port, web.scope, api.port, api.scope, database.port, database.scope], [3000, "local", 4000, "network", 5432, "local"]);
    // The framework is named before the server library under it.
    assert.deepEqual({ kind: web.processes[0].kind, session: web.processes[0].session, uptime: web.processes[0].uptime }, { kind: "Next.js", session: "Shop dev", uptime: 310 });
    assert.deepEqual({ session: api.processes[0].session, uptime: api.processes[0].uptime }, { session: "Shop dev", uptime: 93784 });
    // A database started in a project folder is named by its process, not by the project's framework.
    assert.deepEqual({ kind: database.processes[0].kind, session: database.processes[0].session, uptime: database.processes[0].uptime }, { kind: "PostgreSQL", session: null, uptime: 42 });
    assert.ok(calls.includes("tmux -N -S /fixture/tmux.sock -u list-panes -a -F #{pane_pid}\t#{pane_tty}\t#{session_name}"));
    // Only ids, parents, ages and terminals are read from the process table: no arguments.
    assert.ok(calls.includes("ps -axo pid=,ppid=,etime=,tty="));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a listener maps to its session through any depth of parents, or through the pane's terminal", async () => {
  const calls = [];
  const result = await inspectPortProcesses({
    platform: "darwin", containers: false,
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "lsof" && args.includes("-iTCP")) return "p900\ncnode\nn*:3000\np910\ncnode\nn127.0.0.1:3100\np920\ncnode\nn127.0.0.1:3200\np930\ncnode\nn127.0.0.1:3300\n";
      // 900 runs six levels below the pane shell 10 (shell, npm, sh, node,
      // next, worker); 910 lost its parents but kept the pane's terminal; 920
      // runs in a terminal outside tmux; 930 sits in a parent loop.
      if (command === "ps") return [
        "   10     1 10:00:00 ttys001", "  11    10 09:00 ttys001", "  12    11 09:00 ttys001", "  13    12 09:00 ttys001",
        "   14    13 09:00 ttys001", "  900    14 08:00 ttys001", "  910     1 07:00 ttys002", "  920   500 06:00 ttys009",
        "  500     1 06:00 ttys009", "  930   931 05:00 ??", "  931   930 05:00 ??",
      ].join("\n");
      if (command === "tmux") return "10\t/dev/ttys001\tWeb app\n20\t/dev/ttys002\tAPI nightly\n";
      return "";
    },
  });
  const session = (port) => result.find((entry) => entry.port === port).processes[0].session;
  assert.equal(session(3000), "Web app");
  assert.equal(session(3100), "API nightly");
  assert.equal(session(3200), null);
  assert.equal(session(3300), null);
  // Program paths are read only for listeners no session started.
  const programs = calls.find((call) => call.includes("-d txt"));
  assert.equal(programs, "lsof -a -p 920,930 -d txt -Fn");
});

test("system services are told apart from developer services by owner, program and port", async () => {
  const root = await mkdtemp(path.join(os.homedir(), ".pzza-port-test-"));
  try {
    const project = path.join(root, "shop");
    await mkdir(project);
    await writeFile(path.join(project, "package.json"), JSON.stringify({ name: "shop", dependencies: { vite: "7.0.0" } }));
    const result = await inspectPortProcesses({
      platform: "darwin", dockerSocket: "/fixture/docker.sock", protectedPorts: [22, 5190],
      run: async (command, args) => {
        if (command === "lsof" && args.includes("-iTCP")) return [
          "p100", "crapportd", "n*:49152",
          "p101", "cSetappAgent", "n127.0.0.1:2432",
          "p102", "cadb", "n127.0.0.1:5037",
          "p103", "cpostgres", "n127.0.0.1:5432",
          "p104", "cnode", "n*:5173",
          "p105", "cnode", "n*:3000",
          "p106", "cnode", "n127.0.0.1:5190",
          "p107", "cOrbStack Helper", "n127.0.0.1:6379", "n127.0.0.1:32222", "n*:4000",
          "p108", "cnode", "n*:4000",
        ].join("\n");
        if (command === "lsof" && args.includes("cwd")) return ["p100", "n/", "p101", "n/", "p102", "n/", "p103", "n/", "p104", `n${project}`, "p105", `n${project}`, "p106", "n/", "p107", `n${project}`, "p108", `n${project}`].join("\n");
        if (command === "lsof" && args.includes("txt")) return [
          "p100", "ftxt", "n/usr/libexec/rapportd", "ftxt", "n/usr/lib/dyld",
          "p101", "ftxt", "n/Users/dev/Library/Application Support/Setapp/Setapp.app/Contents/MacOS/SetappAgent",
          "p102", "ftxt", "n/opt/homebrew/bin/adb",
          "p103", "ftxt", "n/Applications/Postgres.app/Contents/Versions/17/bin/postgres",
          "p104", "ftxt", "n/opt/homebrew/bin/node",
          "p106", "ftxt", "n/opt/homebrew/bin/node",
          "p107", "ftxt", "n/Applications/OrbStack.app/Contents/MacOS/OrbStack Helper",
          "p108", "ftxt", "n/opt/homebrew/bin/node",
        ].join("\n");
        if (command === "ps") return "  105    50 01:00 ttys001\n   50     1 02:00 ttys001\n";
        if (command === "tmux") return "50\t/dev/ttys001\tShop\n";
        if (command === "docker") return containerRow("d".repeat(12), "shop-redis-1", "127.0.0.1:6379->6379/tcp", "shop", "redis");
        return "";
      },
    });
    const port = (number) => result.find((entry) => entry.port === number);
    // An OS program, an app bundle helper and a daemon outside any project.
    assert.equal(port(49152).system, true);
    assert.equal(port(2432).system, true);
    assert.equal(port(5037).system, true);
    // A well-known server stays visible even when it ships inside an app.
    assert.equal(port(5432).system, false);
    // Project servers, started in a session or not, stay visible.
    assert.equal(port(5173).system, false);
    assert.deepEqual({ system: port(3000).system, session: port(3000).processes[0].session }, { system: false, session: "Shop" });
    // A protected port is a system one even when a project runs on it.
    assert.equal(port(5190).system, true);
    // A container runtime helper is a system process, but a port it publishes
    // for a container, or shares with a project server, is not a system port.
    assert.equal(port(6379).system, false);
    assert.equal(port(32222).system, true);
    assert.equal(port(4000).system, false);
    assert.deepEqual(port(4000).processes.map((item) => [item.pid, item.system]), [[107, true], [108, false]]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("each port is listed once with its addresses, sockets and processes merged", async () => {
  const mac = await inspectPortProcesses({
    platform: "darwin", containers: false, sessions: false,
    run: async (command, args) => {
      if (command === "lsof" && args.includes("-iTCP")) return "p200\ncnode\nn127.0.0.1:3000\nn[::1]:3000\nn*:3000\nn127.0.0.1:3000\np201\ncnode\nn[::1]:3000\np200\ncnode\nn127.0.0.1:3001\n";
      return "";
    },
  });
  assert.deepEqual(mac.map(({ port, scope }) => [port, scope]), [[3000, "network"], [3001, "local"]]);
  assert.deepEqual(mac[0].processes.map(({ pid }) => pid), [200, 201]);
  const linux = await inspectPortProcesses({
    platform: "linux", containers: false, sessions: false,
    run: async (command) => command === "ss" ? [
      'LISTEN 0 511 127.0.0.1:5173 0.0.0.0:* users:(("node",pid=300,fd=20))',
      'LISTEN 0 511 [::1]:5173 [::]:* users:(("node",pid=300,fd=21),("node",pid=300,fd=22))',
    ].join("\n") : "",
  });
  assert.equal(linux.length, 1);
  assert.deepEqual([linux[0].port, linux[0].scope, linux[0].processes.length], [5173, "local", 1]);
});

test("the serialized probe carries the protected ports to the source device", async () => {
  const probe = (0, eval)(`(${inspectPortProcesses.toString()})`);
  const result = await probe({ platform: "linux", containers: false, protectedPorts: [22], run: async (command) => command === "ss" ? "LISTEN 0 128 0.0.0.0:22 0.0.0.0:*\nLISTEN 0 128 0.0.0.0:8080 0.0.0.0:*" : "" });
  assert.deepEqual(result.map(({ port, system }) => [port, system]), [[22, true], [8080, true]]);
});

test("coding agents' own listeners and the app's own sessions are internal, while a dev server an agent started is not", async () => {
  const calls = [];
  const rules = await portProbeRules();
  // The rules are plain data, so the serialized probe gets them as JSON.
  const probe = (0, eval)(`(${inspectPortProcesses.toString()})`);
  const result = await probe({
    ...JSON.parse(JSON.stringify(rules)), platform: "darwin", containers: false,
    run: async (command, args) => {
      calls.push([command, ...args].join(" "));
      if (command === "lsof" && args.includes("-iTCP")) return [
        "p400", "c2.1.330", "n127.0.0.1:62697",
        "p401", "cnode", "n*:3000",
        "p402", "ccodex", "n127.0.0.1:41000",
        "p403", "c2.1.328", "n127.0.0.1:51862",
        "p404", "cnode", "n127.0.0.1:5173",
        "p405", "cpython3", "n127.0.0.1:8000",
        "p406", "c2.1.330", "n127.0.0.1:4100", "p407", "cnode", "n127.0.0.1:4100",
      ].join("\n");
      // 401 is the agent 400's dev server; 403 and 404 run in the app's own
      // sessions; everything else in "Shop".
      if (command === "ps") return [
        "   10     1 10:00 ttys001", "  400    10 05:00 ttys001", "  401   400 04:00 ttys001", "  402    10 04:00 ttys001",
        "   20     1 10:00 ttys002", "  403    20 03:00 ttys002", "   30     1 10:00 ttys003", "  404    30 02:00 ttys003",
        "  405    10 01:00 ttys001", "  406    10 01:00 ttys001", "  407    10 01:00 ttys001",
      ].join("\n");
      // The view session repeats Shop's pane; it must not take it over.
      if (command === "tmux") return "10\t/dev/ttys001\tShop\n10\t/dev/ttys001\tpzza-v-abc-1\n20\t/dev/ttys002\tpzza-quick-chat\n30\t/dev/ttys003\tpzza-v-def-2\n";
      return "";
    },
  });
  const port = (number) => result.find((entry) => entry.port === number);
  assert.deepEqual(INTERNAL_SESSIONS, { names: ["pzza-quick-chat"], prefixes: ["pzza-v-"] });
  assert.ok(rules.agentPrograms.includes("codex"));
  assert.equal(rules.agentPrograms.some((name) => /^(python\d*|node)$/i.test(name)), false);
  assert.equal(rules.versionNamedAgents, true);
  // A version-named agent binary and a catalog agent program: internal.
  assert.deepEqual([port(62697).internal, port(62697).processes[0].agent, port(62697).processes[0].session], [true, true, "Shop"]);
  assert.equal(port(41000).internal, true);
  // The agent's dev server, and an interpreter some agents run under, stay visible.
  assert.deepEqual([port(3000).internal, port(3000).processes[0].session], [false, "Shop"]);
  assert.equal(port(8000).internal, false);
  // Anything in the app's own sessions is internal.
  assert.deepEqual([port(51862).internal, port(51862).processes[0].session], [true, "pzza-quick-chat"]);
  assert.equal(port(5173).internal, true);
  // A port an agent shares with a real server is not.
  assert.equal(port(4100).internal, false);
  assert.ok(calls.some((call) => call.startsWith("tmux") && call.includes("#{pane_pid}\t#{pane_tty}\t#{session_name}")));
});
