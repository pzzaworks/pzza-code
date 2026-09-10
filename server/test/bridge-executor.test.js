import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import test from "node:test";
import { createBridgeExecutor, BRIDGE_CAPABILITIES } from "../lib/bridge-executor.js";

async function fixture(t, options = {}) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pzza-bridge-executor-")));
  t.after(async () => { await executor.close(); await fs.rm(dir, { recursive: true, force: true }); });
  const root = path.join(dir, "project");
  await fs.mkdir(root);
  const calls = [];
  const children = [];
  const executor = createBridgeExecutor({ stateDir: path.join(dir, "state"), platform: "darwin",
    resolveTool: async (name) => `/tools/${name}`,
    run: async (command, args) => { calls.push({ command, args }); return { stdout: command === "/usr/bin/plutil" ? "com.example.fixture" : "" }; },
    startProcess: (command, args, opts) => { calls.push({ command, args, opts }); const child = new EventEmitter(); children.push(child); return child; },
    ...options });
  const context = { peerId: "peer-one", projectRoots: { project: root }, capabilities: BRIDGE_CAPABILITIES, resources: { simulatorIds: ["12345678-1234-1234-1234-123456789abc", "22345678-1234-1234-1234-123456789abc"], bundleIds: ["com.example.fixture"], browserOrigins: [] } };
  const invoke = (action, args = {}, grant = context) => executor.execute(action, { projectId: "project", requestId: randomUUID(), ...args }, grant);
  return { dir, root, executor, calls, children, context, invoke };
}

test("files stay inside grant, reject escaping symlinks and serialize optimistic writes", async (t) => {
  const { root, dir, invoke, context } = await fixture(t);
  await fs.writeFile(path.join(dir, "outside"), "outside");
  await fs.symlink(path.join(dir, "outside"), path.join(root, "link"));
  await assert.rejects(invoke("files.read", { path: "../outside" }), /outside/);
  await assert.rejects(invoke("files.read", { path: "link" }), /Symlink/);
  await assert.rejects(invoke("files.read", { path: "anything" }, { ...context, capabilities: [] }), /not granted/);
  const created = await invoke("files.write", { path: "hello.txt", content: "hello", expectedSha256: null });
  const read = await invoke("files.read", { path: "hello.txt" });
  assert.equal(Buffer.from(read.content, "base64").toString(), "hello");
  assert.equal(read.sha256, created.sha256);
  const writes = await Promise.allSettled(["first", "second"].map((content) => invoke("files.write", { path: "hello.txt", content, expectedSha256: read.sha256 })));
  assert.equal(writes.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal(writes.filter((result) => result.status === "rejected").length, 1);
  await assert.rejects(invoke("files.write", { path: "hello.txt", content: "oops", expectedSha256: null }), /changed/);
});

test("terminal actions use exact in-project single-pane targets and never shell interpolation", async (t) => {
  let root;
  const calls = [];
  const setup = await fixture(t, { run: async (command, args) => {
    calls.push({ command, args });
    if (args[0] === "list-panes" && args[1] === "-a") return { stdout: `session\t0\t%7\t${root}\n` };
    if (args[0] === "list-panes") return { stdout: "%7\n" };
    return { stdout: "output" };
  } });
  root = setup.root;
  await setup.invoke("terminal.write", { session: "session", text: "$(literal); test", enter: true });
  assert.deepEqual(calls.at(-2), { command: "tmux", args: ["send-keys", "-t", "%7", "-l", "--", "$(literal); test"] });
  assert.deepEqual(calls.at(-1).args, ["send-keys", "-t", "%7", "Enter"]);
  await assert.rejects(setup.invoke("terminal.write", { session: "different", text: "x" }), /granted project/);
});

test("jobs are owned, share simulator lease, cancel and survive restart as interrupted", async (t) => {
  const { executor, invoke, children, dir } = await fixture(t);
  const simulatorId = "12345678-1234-1234-1234-123456789abc";
  const first = await invoke("simulator.boot", { simulatorId });
  assert.equal(first.status, "running");
  await assert.rejects(executor.getJob(first.id, "other"), /not found/);
  await assert.rejects(invoke("simulator.boot", { simulatorId }), /busy/);
  children[0].emit("close", 0);
  for (let tries = 0; tries < 20 && children.length < 2; tries++) await new Promise((resolve) => setTimeout(resolve, 2));
  children[1].emit("close", 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal((await executor.getJob(first.id, "peer-one")).status, "completed");
  const next = await invoke("simulator.boot", { simulatorId });
  const restarted = createBridgeExecutor({ stateDir: path.join(dir, "state") });
  assert.equal((await restarted.getJob(next.id, "peer-one")).status, "interrupted");
  await executor.revokePeer("peer-one");
  assert.equal((await executor.getJob(next.id, "peer-one")).status, "cancelled");
  const fresh = await invoke("simulator.boot", { simulatorId });
  assert.equal(fresh.status, "running");
});

test("submission remains pending, checks artifact hash, consumes approval once and binds destination", async (t) => {
  const { root, invoke, executor, calls } = await fixture(t);
  await fs.writeFile(path.join(root, "app.json"), JSON.stringify({ expo: { name: "Fixture", slug: "fixture", owner: "fixture-owner", extra: { eas: { projectId: "12345678-1234-1234-1234-123456789abc" } } } }));
  await fs.writeFile(path.join(root, "app.ipa"), "fixture bytes");
  const pending = await invoke("ios.submit", { artifact: "app.ipa", destination: "1234567890" });
  assert.equal(pending.status, "waiting_approval");
  assert.equal(calls.length, 0);
  await fs.writeFile(path.join(root, "app.ipa"), "changed");
  await assert.rejects(executor.approve(pending.id, true), /changed/);
  assert.equal(calls.length, 0);
  const next = await invoke("ios.submit", { artifact: "app.ipa", destination: "1234567890" });
  const approved = await executor.approve(next.id, true);
  assert.equal(approved.status, "running");
  const command = calls.at(-1);
  assert.equal(command.command, "/tools/eas");
  assert.ok(command.args.includes("--path"));
  assert.ok(!command.args.includes("--id"));
  const config = JSON.parse(await fs.readFile(path.join(command.opts.cwd, "eas.json"), "utf8"));
  assert.equal(config.submit.bridge.ios.ascAppId, "1234567890");
  await assert.rejects(executor.approve(next.id, true), /consumed/);
});

test("build actions reject non-macOS and unknown arguments", async (t) => {
  const { invoke } = await fixture(t, { platform: "linux" });
  await assert.rejects(invoke("ios.build", { project: "app.xcodeproj", scheme: "App" }), /macOS/);
  await assert.rejects(invoke("files.list", { command: "arbitrary" }), /Unexpected/);
});

test("build artifacts can be installed only by their owner inside the completed output directory", async (t) => {
  const { root, invoke, executor, children, calls, context } = await fixture(t);
  await fs.mkdir(path.join(root, "App.xcodeproj"));
  const build = await invoke("ios.build", { project: "App.xcodeproj", scheme: "App" });
  const artifact = "Build/Products/Debug-iphonesimulator/App.app";
  await fs.mkdir(path.join(build.outputDirectory, artifact), { recursive: true });
  await fs.writeFile(path.join(build.outputDirectory, artifact, "Info.plist"), "fixture metadata");
  children[0].emit("close", 0);
  // Drain the asynchronous filesystem artifact discovery, without touching a real tool.
  for (let tries = 0; tries < 20; tries++) {
    if ((await executor.getJob(build.id, context.peerId)).artifacts) break;
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
  assert.deepEqual((await executor.getJob(build.id, context.peerId)).artifacts, [artifact]);
  const args = { simulatorId: "12345678-1234-1234-1234-123456789abc", buildJobId: build.id, path: artifact };
  await assert.rejects(invoke("simulator.install", args, { ...context, peerId: "another" }), /not found/);
  await assert.rejects(invoke("simulator.install", { ...args, path: "../../outside.app" }), /outside/);
  await invoke("simulator.install", args);
  assert.equal(calls.at(-1).args.at(-1), path.join(build.outputDirectory, artifact));
});

test("revocation during authorization prevents delayed process startup", async (t) => {
  let release;
  let checks = 0;
  const { invoke, executor, calls } = await fixture(t, { authorize: async () => {
    if (++checks === 2) await new Promise((resolve) => { release = resolve; });
  } });
  const request = invoke("simulator.boot", { simulatorId: "12345678-1234-1234-1234-123456789abc" });
  for (let tries = 0; tries < 20 && !release; tries++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.ok(release);
  await executor.revokePeer("peer-one");
  release();
  await assert.rejects(request, /revoked/);
  assert.equal(calls.length, 0);
});

test("shutdown cancels process groups concurrently and persists cancelled jobs", async (t) => {
  const children = new Map();
  const kills = [];
  const { invoke, executor } = await fixture(t, {
    startProcess: () => { const child = new EventEmitter(); child.pid = 700 + children.size; children.set(child.pid, child); return child; },
    killProcess: (pid, signal) => { kills.push({ pid, signal }); },
  });
  const first = await invoke("simulator.boot", { simulatorId: "12345678-1234-1234-1234-123456789abc" });
  const second = await invoke("simulator.boot", { simulatorId: "22345678-1234-1234-1234-123456789abc" });
  const closing = executor.close();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(kills, [{ pid: -700, signal: "SIGTERM" }, { pid: -701, signal: "SIGTERM" }]);
  for (const child of children.values()) child.emit("close", null);
  await closing;
  assert.equal((await executor.getJob(first.id)).status, "cancelled");
  assert.equal((await executor.getJob(second.id)).status, "cancelled");
});

test("simulator boot waits for readiness then opens its GUI under one cancellable job", async (t) => {
  const { invoke, executor, calls, children } = await fixture(t);
  const simulatorId = "12345678-1234-1234-1234-123456789abc";
  const job = await invoke("simulator.boot", { simulatorId });
  assert.deepEqual(calls[0].args, ["simctl", "bootstatus", simulatorId, "-b"]);
  assert.equal(calls[0].command, "/usr/bin/xcrun");
  assert.equal(job.status, "running");
  children[0].emit("close", 0);
  for (let tries = 0; tries < 20 && children.length < 2; tries++) await new Promise((resolve) => setTimeout(resolve, 2));
  assert.deepEqual(calls[1].args, ["-a", "Simulator", "--args", "-CurrentDeviceUDID", simulatorId]);
  assert.equal(calls[1].command, "/usr/bin/open");
  assert.equal((await executor.getJob(job.id)).status, "running");
  await assert.rejects(invoke("simulator.boot", { simulatorId }), /busy/);
  children[1].emit("close", 0);
  await new Promise((resolve) => setImmediate(resolve));
  const completed = await executor.getJob(job.id);
  assert.equal(completed.status, "completed");
  assert.equal(completed.logs.filter((entry) => entry.message === "Completed.").length, 1);
  const cancelled = await invoke("simulator.boot", { simulatorId });
  const current = children.at(-1);
  current.emit("close", 0);
  await executor.cancel(cancelled.id);
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(calls.length, 3, "cancellation between steps must prevent GUI launch");
});

test("retention removes only validated private build directories and rejects persisted cleanup paths", async (t) => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pzza-bridge-retention-"));
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  const stateDir = path.join(dir, "state");
  const storage = path.join(stateDir, "bridge-jobs");
  const root = path.join(dir, "project");
  const build = path.join(storage, "build-12345678-1234-1234-1234-123456789abc");
  await fs.mkdir(build, { recursive: true });
  await fs.mkdir(root);
  await fs.writeFile(path.join(root, "keep"), "keep");
  const jobs = Array.from({ length: 100 }, (_, index) => ({
    id: `12345678-1234-1234-1234-${String(index).padStart(12, "0")}`, peerId: "peer", projectId: "project",
    action: "ios.build", status: "completed", logs: [], createdAt: index,
    ...(index === 0 ? { outputDirectory: build } : index === 1 ? { outputDirectory: storage } : index === 2 ? { outputDirectory: root } : {}),
  }));
  await fs.writeFile(path.join(storage, "jobs.json"), JSON.stringify(jobs));
  const executor = createBridgeExecutor({ stateDir, platform: "darwin", startProcess: () => new EventEmitter() });
  assert.equal((await executor.getJob(jobs[1].id)).outputDirectory, undefined);
  assert.equal((await executor.getJob(jobs[2].id)).outputDirectory, undefined);
  const grant = { peerId: "peer", projectRoots: { project: root }, capabilities: BRIDGE_CAPABILITIES, resources: { simulatorIds: ["1", "2", "3"].map(prefix => `${prefix}2345678-1234-1234-1234-123456789abc`), bundleIds: [], browserOrigins: [] } };
  for (const prefix of ["1", "2", "3"]) await executor.execute("simulator.boot", {
    requestId: randomUUID(), projectId: "project", simulatorId: `${prefix}2345678-1234-1234-1234-123456789abc`,
  }, grant);
  await assert.rejects(fs.stat(build), { code: "ENOENT" });
  assert.equal(await fs.readFile(path.join(root, "keep"), "utf8"), "keep");
  assert.ok((await fs.stat(storage)).isDirectory());
  await executor.close();
});

test("an empty connected app can discover and open its first verified project session", async (t) => {
  let root;
  let opened = false;
  const commands = [];
  const appControl = {
    list: () => [{ clientId: "local-client", label: "Desktop app", privateField: "hidden" }],
    command: async (clientId, action, args) => {
      commands.push({ clientId, action, args });
      if (action === "open_session") { opened = true; return { ok: true }; }
      return { tiles: opened ? [{ id: "tile-one", session: "session", host: "", hidden: false }] : [] };
    },
  };
  const setup = await fixture(t, { appControl, run: async (command, args) => {
    if (args[0] === "list-panes" && args[1] === "-a") return { stdout: `session\t0\t%7\t${root}\n` };
    return { stdout: "%7\n" };
  } });
  root = setup.root;
  assert.deepEqual(await setup.invoke("app.list_clients"), { clients: [{ clientId: "local-client", label: "Desktop app" }] });
  assert.equal(commands.length, 0);
  await assert.rejects(setup.invoke("app.open_session", { clientId: "local-client", session: "outside" }), /granted project/);
  const state = await setup.invoke("app.open_session", { clientId: "local-client", session: "session" });
  assert.deepEqual(commands[0], { clientId: "local-client", action: "open_session", args: { session: "session", cwd: root } });
  assert.equal(state.tiles[0].id, "tile-one");
  assert.equal(state.tiles[0].session, "session");
});
