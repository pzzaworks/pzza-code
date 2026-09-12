import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectPortProcesses, listPortDetails, parsePorts, protectedListenerPort, stopPortContainer, terminateListener, terminateRemoteListener } from "../lib/ports.js";

test("port parser deduplicates IPv4 and IPv6 listeners", () => {
  assert.deepEqual(parsePorts("127.0.0.1:3000\n[::]:3000\n*:4100\n"), [3000, 4100]);
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
  assert.deepEqual(result, [{ port: 8080, containers: [], processes: [] }]);
});

test("serialized device probe remains self-contained", async () => {
  const probe = (0, eval)(`(${inspectPortProcesses.toString()})`);
  const result = await probe({ platform: "darwin", dockerSocket: null, run: async (command, args) => {
    if (command === "lsof") return "p321\ncDocker\nn*:3000";
    if (command === "podman") return containerRow("c".repeat(12), "local-container", "[::1]:3000->80/tcp");
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
