import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import { PassThrough, Writable } from "node:stream";
import { createBridge, createBridgeRouter } from "../lib/bridge.js";
import { createBridgeExecutor, BRIDGE_CAPABILITIES, BRIDGE_MUTATIONS } from "../lib/bridge-executor.js";
import { createBrowserConnector, connectorEnvironment, parseApprovedTab, validateBrowserToolSchemas } from "../lib/bridge-browser.js";
import { takeNativeConsentKey } from "../lib/bridge-consent.js";
import { BRIDGE_TOOLS } from "../../mcp/lib/bridge-tools.js";

// Captured from the pinned upstream Zod schemas (input JSON Schema mode).
const BROWSER_SCHEMAS = [
  { name: "browser_tabs", inputSchema: { type: "object", required: ["action"], properties: { action: { type: "string", enum: ["list", "new", "close", "select"] }, index: { type: "number" }, url: { type: "string" } } } },
  { name: "browser_snapshot", inputSchema: { type: "object", properties: { target: { type: "string" }, filename: { type: "string" }, depth: { type: "number" }, boxes: { type: "boolean" } } } },
  { name: "browser_take_screenshot", inputSchema: { type: "object", properties: { target: { type: "string" }, element: { type: "string" }, filename: { type: "string" }, type: { type: "string", enum: ["png", "jpeg", "webp"] }, scale: { type: "string", enum: ["css", "device"] }, fullPage: { type: "boolean" } } } },
  { name: "browser_navigate", inputSchema: { type: "object", required: ["url"], properties: { url: { type: "string" } } } },
  { name: "browser_click", inputSchema: { type: "object", required: ["target"], properties: { target: { type: "string" }, element: { type: "string" }, doubleClick: { type: "boolean" }, button: { type: "string", enum: ["left", "right", "middle"] }, modifiers: { type: "array" } } } },
  { name: "browser_type", inputSchema: { type: "object", required: ["target", "text"], properties: { target: { type: "string" }, element: { type: "string" }, text: { type: "string" }, submit: { type: "boolean" }, slowly: { type: "boolean" } } } },
  { name: "browser_press_key", inputSchema: { type: "object", required: ["key"], properties: { key: { type: "string" } } } },
];

async function storage(t) {
  const dir = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pzza-bridge-security-")));
  const root = path.join(dir, "project"); await fs.mkdir(root);
  t.after(() => fs.rm(dir, { recursive: true, force: true }));
  return { dir, root };
}
const proofRequest = proof => ({ headers: { "x-pzza-native-consent": proof }, socket: { remoteAddress: "127.0.0.1" } });

test("configuration requests need native proof, bind exact digest and consume once", async t => {
  const { dir, root } = await storage(t);
  const key = randomBytes(32).toString("hex");
  const bridge = createBridge({ stateDir: path.join(dir, "state"), nativeConsentKey: key });
  t.after(() => bridge.close());
  const initial = await bridge.state();
  const config = { enabled: true, projects: [{ id: "project", root }], peers: [] };
  const first = bridge.requestConfiguration({ config, expectedConfigHash: initial.configHash });
  const repeat = bridge.requestConfiguration({ config, expectedConfigHash: initial.configHash });
  assert.equal(first.approval.id, repeat.approval.id);
  assert.equal((await bridge.state()).config.enabled, false);
  const decision = { kind: "approval", approvalId: first.approval.id, digest: first.approval.digest, approved: true };
  await assert.rejects(bridge.localDecision(decision, proofRequest(randomBytes(32).toString("hex"))), error => error.code === "LOCAL_CONSENT_REQUIRED");
  await assert.rejects(bridge.localDecision({ ...decision, digest: randomBytes(32).toString("hex") }, proofRequest(key)), error => error.status === 409);
  await assert.rejects(bridge.localDecision(decision, { ...proofRequest(key), socket: { remoteAddress: "192.0.2.1" } }), error => error.code === "LOCAL_CONSENT_REQUIRED");
  await bridge.localDecision(decision, proofRequest(key));
  assert.equal((await bridge.state()).config.enabled, true);
  await assert.rejects(bridge.localDecision(decision, proofRequest(key)), error => error.status === 409);
});

test("bearer-era approve endpoint cannot approve and startup proof is removed from child environment", async t => {
  const { dir } = await storage(t);
  const previous = process.env.PZZA_BRIDGE_CONSENT_KEY;
  process.env.PZZA_BRIDGE_CONSENT_KEY = randomBytes(32).toString("hex");
  const proof = takeNativeConsentKey();
  assert.equal(proof.length, 64); assert.equal(process.env.PZZA_BRIDGE_CONSENT_KEY, undefined);
  if (previous !== undefined) process.env.PZZA_BRIDGE_CONSENT_KEY = previous;
  const bridge = createBridge({ stateDir: path.join(dir, "state"), nativeConsentKey: proof });
  t.after(() => bridge.close());
  let result;
  const router = createBridgeRouter(bridge, (_, status, value) => { result = { status, value }; });
  const req = new PassThrough(); req.method = "POST"; req.headers = { "content-type": "application/json" }; req.socket = { remoteAddress: "127.0.0.1" };
  const handling = router(req, {}, new URL("http://localhost/bridge/approve"));
  req.end(JSON.stringify({ jobId: randomUUID(), approved: true })); await handling;
  assert.equal(result.status, 403); assert.equal(result.value.code, "LOCAL_CONSENT_REQUIRED");
});

test("duplicate mutations survive restart and reject changed input without rewriting files", async t => {
  const { dir, root } = await storage(t);
  const stateDir = path.join(dir, "state");
  const grant = { peerId: "device", projectRoots: { project: root }, capabilities: BRIDGE_CAPABILITIES };
  const executor = createBridgeExecutor({ stateDir });
  const args = { projectId: "project", requestId: randomUUID(), path: "source.txt", content: "first", expectedSha256: null };
  const [first, duplicate] = await Promise.all([executor.execute("files.write", args, grant), executor.execute("files.write", args, grant)]);
  assert.deepEqual(first, duplicate);
  await assert.rejects(executor.execute("files.write", { ...args, content: "changed" }, grant), error => error.code === "REQUEST_ID_CONFLICT");
  await assert.rejects(executor.execute("files.write", { ...args, requestId: undefined }, grant), error => error.code === "REQUEST_ID_REQUIRED");
  await executor.close();
  const restarted = createBridgeExecutor({ stateDir });
  assert.deepEqual(await restarted.execute("files.write", args, grant), first);
  assert.equal(await fs.readFile(path.join(root, "source.txt"), "utf8"), "first");
  await restarted.close();
});

test("file reads deny sensitive paths, linked bytes and sensitive content without returning redacted replacements", async t => {
  const { dir, root } = await storage(t);
  const executor = createBridgeExecutor({ stateDir: path.join(dir, "state") });
  const context = { peerId: "device", projectRoots: { project: root }, capabilities: BRIDGE_CAPABILITIES };
  const invoke = (action, args) => executor.execute(action, { projectId: "project", requestId: randomUUID(), ...args }, context);
  await fs.writeFile(path.join(root, ".env"), "not a credential");
  await fs.mkdir(path.join(root, ".git"));
  await fs.writeFile(path.join(root, "settings.txt"), `access_token=${randomBytes(32).toString("hex")}`);
  await fs.writeFile(path.join(root, "normal.txt"), "ordinary source");
  await fs.link(path.join(root, "normal.txt"), path.join(root, "linked.txt"));
  await assert.rejects(invoke("files.read", { path: ".env" }), error => error.code === "SENSITIVE_PATH");
  await assert.rejects(invoke("files.read", { path: "settings.txt" }), error => error.code === "SENSITIVE_CONTENT");
  await assert.rejects(invoke("files.read", { path: "linked.txt" }), /regular file/);
  await assert.rejects(invoke("files.write", { path: "replacement.txt", content: "[REDACTED]", expectedSha256: null }), error => error.code === "SENSITIVE_CONTENT");
  const page = await invoke("files.list", { limit: 1 });
  assert.equal(page.entries.length, 1); assert.equal(page.nextCursor, 1);
  assert.ok(!page.entries.some(entry => entry.name.startsWith(".")));
  await executor.close();
});

test("owned build artifacts remain installable from protected private job storage", async t => {
  const { dir, root } = await storage(t);
  const calls = []; const children = [];
  const simulatorId = randomUUID();
  const executor = createBridgeExecutor({ stateDir: path.join(dir, ".config", "pzzacode", "bridge"), platform: "darwin", run: async (command, args) => { calls.push({ command, args }); return { stdout: command === "/usr/bin/plutil" ? "com.example.fixture" : "" }; }, startProcess: (command, args) => { calls.push({ command, args }); const child = new EventEmitter(); children.push(child); return child; } });
  const context = { peerId: "peer", projectRoots: { project: root }, capabilities: BRIDGE_CAPABILITIES, resources: { simulatorIds: [simulatorId], bundleIds: ["com.example.fixture"], browserOrigins: [] } };
  const execute = (action, args) => executor.execute(action, { projectId: "project", requestId: randomUUID(), ...args }, context);
  await fs.mkdir(path.join(root, "App.xcodeproj"));
  const build = await execute("ios.build", { project: "App.xcodeproj", scheme: "App" });
  const artifact = "Build/Products/App.app";
  await fs.mkdir(path.join(build.outputDirectory, artifact), { recursive: true });
  await fs.writeFile(path.join(build.outputDirectory, artifact, "Info.plist"), "fixture metadata");
  children[0].emit("close", 0);
  for (let i = 0; i < 100 && !(await executor.getJob(build.id)).artifacts; i++) await new Promise(resolve => setTimeout(resolve, 2));
  const installation = await execute("simulator.install", { simulatorId, buildJobId: build.id, path: artifact });
  assert.equal(installation.status, "running");
  assert.equal(calls.at(-1).args.at(-1), path.join(build.outputDirectory, artifact));
  await assert.rejects(execute("files.read", { path: path.relative(root, path.join(build.outputDirectory, artifact, "Info.plist")) }), error => error.status === 403);
  await executor.close();
});

test("simulator and bundle scopes deny unapproved resources before invoking local tools", async t => {
  const { dir, root } = await storage(t); const calls = [];
  const simulatorId = randomUUID();
  const executor = createBridgeExecutor({ stateDir: path.join(dir, "state"), platform: "darwin", run: async (command, args) => { calls.push({ command, args }); return { stdout: "" }; } });
  const context = { peerId: "device", projectRoots: { project: root }, capabilities: BRIDGE_CAPABILITIES, resources: { simulatorIds: [simulatorId], bundleIds: [], browserOrigins: [] } };
  await assert.rejects(executor.execute("simulator.boot", { projectId: "project", requestId: randomUUID(), simulatorId: randomUUID() }, context), error => error.code === "SIMULATOR_DENIED");
  await assert.rejects(executor.execute("simulator.launch", { projectId: "project", requestId: randomUUID(), simulatorId, bundleId: "com.example.other" }, context), error => error.code === "RESOURCE_DENIED");
  assert.equal(calls.length, 0); await executor.close();
});

function wireProcess(calls, invalidSchema = false) {
  const child = new EventEmitter(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
  child.kill = () => { queueMicrotask(() => child.emit("close", 0)); return true; };
  child.stdin = new Writable({ write(chunk, _, done) {
    const message = JSON.parse(chunk.toString()); calls.push(message);
    let result = {};
    if (message.method === "initialize") result = { protocolVersion: "2024-11-05" };
    if (message.method === "tools/list") result = { tools: invalidSchema ? [] : BROWSER_SCHEMAS };
    if (message.method === "tools/call") result = { content: [{ type: "text", text: message.params.name === "browser_tabs" ? "- 0: (current) [Test](https://example.test/page)" : "### Snapshot\n- button Submit [ref=e1]" }] };
    if (message.params?.name === "browser_take_screenshot") result = { content: [{ type: "image", mimeType: "image/png", data: Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64") }] };
    if (message.id !== undefined) queueMicrotask(() => child.stdout.write(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }) + "\n"));
    done();
  } });
  return child;
}

test("real connector transport enforces scope, environment isolation and exact snapshot bindings", async t => {
  const { dir, root } = await storage(t); const calls = []; let spawnOptions;
  const connector = createBrowserConnector({ stateDir: dir, locate: async () => "/installed/playwright/cli.js", locateApplication: async () => ({ name: "Chromium", executable: "/installed/browser" }), startProcess: (command, args, options) => { spawnOptions = { command, args, options }; return wireProcess(calls); } });
  const context = { peerId: "peer" }; const args = { projectId: "project", origin: "https://example.test" };
  const attached = await connector.attach(context, args, root);
  for (let attempt = 0; attempt < 100; attempt++) {
    if (connector.status(context, { ...args, sessionId: attached.sessionId }).status === "attached") break;
    await new Promise(resolve => setImmediate(resolve));
  }
  const scope = { projectId: "project", sessionId: attached.sessionId, tabId: attached.tabId };
  assert.equal(connector.status(context, scope).status, "attached");
  assert.ok(spawnOptions.args.includes("--extension")); assert.ok(spawnOptions.args.includes("--executable-path"));
  assert.equal(spawnOptions.options.env.PLAYWRIGHT_MCP_EXTENSION_TOKEN, undefined);
  assert.equal(spawnOptions.options.env.PZZA_BRIDGE_CONSENT_KEY, undefined);
  await assert.rejects(connector.perform("browser.snapshot", { peerId: "other" }, scope, async () => {}), error => error.status === 404);
  await assert.rejects(connector.perform("browser.snapshot", context, { ...scope, tabId: randomUUID() }, async () => {}), error => error.code === "BROWSER_TAB_DENIED");
  const image = await connector.perform("browser.screenshot", context, scope, async () => {});
  assert.equal(image.mimeType, "image/png");
  assert.deepEqual(calls.find(message => message.params?.name === "browser_take_screenshot").params.arguments, { type: "png", scale: "css", fullPage: false });
  await connector.perform("browser.snapshot", context, scope, async () => {});
  const binding = connector.binding(context, { ...scope, target: "e1" });
  await connector.perform("browser.click", context, { ...scope, target: "e1", binding }, async () => {});
  await assert.rejects(connector.perform("browser.click", context, { ...scope, target: "e1", binding }, async () => {}), error => error.code === "STALE_APPROVAL");
  assert.equal(calls.filter(message => message.params?.name === "browser_click").length, 1);
  assert.ok(!calls.some(message => /evaluate|run_code|cookie|cdp/.test(message.params?.name || "")));
  await connector.revokePeer("peer"); assert.equal(connector.status(context, { projectId: "project" }).sessions.length, 0);
  await connector.close();
});

test("tab parsing, child environment and named mutation schemas fail closed", () => {
  assert.throws(() => parseApprovedTab({ content: [{ type: "text", text: "- 0: (current) [A](https://evil.test)" }] }, "https://example.test"), error => error.code === "BROWSER_TAB_SCOPE_CHANGED");
  assert.throws(() => parseApprovedTab({ content: [{ type: "text", text: "- 0: (current) [A](https://example.test)\n- 1: [B](https://example.test)" }] }, "https://example.test"), error => error.code === "BROWSER_TAB_SCOPE_CHANGED");
  const environment = connectorEnvironment({ HOME: "/home/user", NODE_OPTIONS: "--inspect", PLAYWRIGHT_MCP_EXTENSION_TOKEN: randomBytes(32).toString("hex"), PZZA_BRIDGE_CONSENT_KEY: randomBytes(32).toString("hex") });
  assert.deepEqual(environment, { HOME: "/home/user" });
  for (const action of BRIDGE_MUTATIONS) {
    const tool = BRIDGE_TOOLS.find(item => item.name === `bridge_${action.replaceAll(".", "_")}`);
    assert.ok(tool, `Named tool for ${action}`);
    assert.ok(tool.inputSchema.required.includes("requestId"));
    assert.equal(tool.inputSchema.additionalProperties, false);
  }
  assert.ok(!BRIDGE_TOOLS.some(tool => /bridge_.*(?:evaluate|run_code|approve|cookie)/.test(tool.name)));
});

test("captured upstream schemas validate target, snapshot depth, inline screenshot parameters and reject drift", () => {
  validateBrowserToolSchemas(BROWSER_SCHEMAS);
  for (const [name, modify] of [
    ["browser_click", schema => { schema.required = ["ref"]; schema.properties.ref = { type: "string" }; delete schema.properties.target; }],
    ["browser_snapshot", schema => { schema.properties.depth.type = "string"; }],
    ["browser_take_screenshot", schema => { schema.required = ["filename"]; }],
    ["browser_type", schema => { schema.required.push("submit"); }],
  ]) {
    const changed = structuredClone(BROWSER_SCHEMAS); modify(changed.find(tool => tool.name === name).inputSchema);
    assert.throws(() => validateBrowserToolSchemas(changed), error => error.code === "BROWSER_SCHEMA_MISMATCH");
  }
});

test("failed browser attachments cannot permanently exhaust session capacity", async t => {
  const { dir, root } = await storage(t);
  const connector = createBrowserConnector({ stateDir: dir, locate: async () => "/installed/playwright/cli.js", locateApplication: async () => ({ name: "Chromium", executable: "/installed/browser" }), startProcess: () => wireProcess([], true) });
  const context = { peerId: "peer" };
  for (let i = 0; i < 40; i++) {
    const session = await connector.attach(context, { projectId: "project", origin: "https://example.test" }, root);
    for (let attempt = 0; attempt < 100 && connector.status(context, { projectId: "project", sessionId: session.sessionId }).status !== "failed"; attempt++) await new Promise(resolve => setTimeout(resolve, 2));
    assert.equal(connector.status(context, { projectId: "project", sessionId: session.sessionId }).status, "failed");
  }
  assert.ok(connector.status(context, { projectId: "project" }).sessions.length <= 32);
  await connector.close();
});
