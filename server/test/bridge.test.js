import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { PassThrough } from "node:stream";
import { createBridge, canonicalEnvelope, bridgeSshArgs, readBridgeBody, createBridgeRouter } from "../lib/bridge.js";

const timestamp = Date.now();
const executor = () => ({
  calls: [], revoked: [],
  async execute(action, args, context) { this.calls.push({ action, args, context }); return { ok: true }; },
  async listJobs() { return []; },
  async getJob(jobId, peerId) { return { jobId, peerId }; },
  async approve(jobId, approved) { return { jobId, approved }; },
  async cancel(jobId, peerId) { return { jobId, peerId }; },
  async revokePeer(peerId) { this.revoked.push(peerId); },
});
async function pair(t, realExecutor = false) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pzza-bridge-test-")));
  const leftExecutor = executor();
  const rightExecutor = executor();
  let clock = timestamp;
  let captured;
  let transformResponse = (response) => response;
  const right = createBridge({ stateDir: path.join(directory, "right"), executor: realExecutor ? undefined : rightExecutor, now: () => clock });
  const left = createBridge({ stateDir: path.join(directory, "left"), executor: leftExecutor, now: () => clock,
    transport: async (_, request) => { captured = request; return transformResponse(await right.receiveSigned(request)); } });
  t.after(async () => { await left.close(); await right.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const leftIdentity = (await left.state()).identity;
  const rightIdentity = (await right.state()).identity;
  const grant = (identity) => ({ ...identity, label: "Paired device", host: "trusted-device", enabled: true, expiresAt: timestamp + 3600_000, projectIds: ["project"], capabilities: ["terminal.read", "files.read"] });
  const leftConfig = { enabled: true, peers: [grant(rightIdentity)], projects: [{ id: "project", root: directory }] };
  const rightConfig = { enabled: true, peers: [grant(leftIdentity)], projects: [{ id: "project", root: directory }] };
  await left.configure(leftConfig);
  await right.configure(rightConfig);
  const privateKey = crypto.createPrivateKey(await fs.readFile(path.join(directory, "left/bridge/identity.pem")));
  const sign = (changes = {}) => {
    const envelope = { version: 1, source: leftIdentity.id, target: rightIdentity.id, nonce: crypto.randomBytes(24).toString("base64url"), expiresAt: clock + 30_000, action: "terminal.list", args: { projectId: "project" }, ...changes };
    return { envelope, signature: crypto.sign(null, Buffer.from(canonicalEnvelope(envelope)), privateKey).toString("base64") };
  };
  return { directory, left, right, leftIdentity, rightIdentity, leftConfig, rightConfig, leftExecutor, rightExecutor, sign, captured: () => captured, transformResponse: (transform) => { transformResponse = transform; }, advance: (ms) => { clock += ms; }, now: () => clock };
}

test("bridge stays disabled by default and persists a private device identity", async (t) => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pzza-bridge-identity-"));
  const bridge = createBridge({ stateDir: directory, executor: executor() });
  t.after(async () => { bridge.close(); await fs.rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(await fs.readdir(directory), []);
  const first = await bridge.state();
  assert.equal(first.config.enabled, false);
  assert.match(first.identity.id, /^[a-f0-9]{64}$/);
  assert.equal((await fs.stat(path.join(directory, "bridge/identity.pem"))).mode & 0o777, 0o600);
  assert.equal((await fs.stat(path.join(directory, "bridge"))).mode & 0o777, 0o700);
  assert.ok(!JSON.stringify(first).includes("PRIVATE KEY"));
  const again = createBridge({ stateDir: directory, executor: executor() });
  t.after(() => again.close());
  assert.deepEqual((await again.state()).identity, first.identity);
});

test("SSH pairing imports only a validated public identity and rejects a changed fingerprint", async t => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pzza-bridge-import-"));
  const remote = createBridge({ stateDir: path.join(directory, "remote"), executor: executor() });
  let tamper = false;
  const local = createBridge({ stateDir: path.join(directory, "local"), executor: executor(), agentRequest: async (host, endpoint) => {
    assert.equal(host, "trusted-device");
    assert.equal(endpoint, "/bridge/state");
    const value = await remote.state();
    return tamper ? { ...value, identity: { ...value.identity, id: "0".repeat(64) } } : value;
  } });
  t.after(async () => { await local.close(); await remote.close(); await fs.rm(directory, { recursive: true, force: true }); });
  assert.deepEqual(await local.peerIdentity("trusted-device"), { identity: (await remote.state()).identity });
  assert.equal((await local.state()).config.peers.length, 0);
  tamper = true;
  await assert.rejects(local.peerIdentity("trusted-device"), /invalid or local identity/);
  await assert.rejects(local.peerIdentity("-oProxyCommand=command"), /valid trusted SSH/);
});

test("signed dispatch enforces receiving capabilities and project grants", async (t) => {
  const f = await pair(t);
  assert.deepEqual(await f.left.dispatch({ peerId: f.rightIdentity.id, action: "terminal.list", args: { projectId: "project" } }), { ok: true });
  assert.equal(f.rightExecutor.calls[0].context.peerId, f.leftIdentity.id);
  assert.deepEqual(f.rightExecutor.calls[0].context.projectRoots, { project: f.directory });
  await assert.rejects(f.right.receive(f.sign({ action: "terminal.write" })), /not allowed/);
  await assert.rejects(f.right.receive(f.sign({ args: { projectId: "ungranted" } })), /not allowed/);
  const info = await f.right.receive(f.sign({ action: "bridge.describe", args: {} }));
  assert.deepEqual(info.projects, [{ id: "project", name: path.basename(f.directory) }]);
  assert.ok(!JSON.stringify(info).includes(f.directory));
  assert.equal(info.expiresAt, timestamp + 3600_000);
  const job = await f.right.receive(f.sign({ action: "jobs.get", args: { jobId: "12345678-1234-1234-1234-123456789abc" } }));
  assert.equal(job.peerId, f.leftIdentity.id);
});

test("signature, target, expiry and replay protections fail closed across restart", async (t) => {
  const f = await pair(t);
  const signed = f.sign();
  await f.right.receive(signed);
  await assert.rejects(f.right.receive(signed), /already been received/);
  const restarted = createBridge({ stateDir: path.join(f.directory, "right"), executor: executor(), now: f.now });
  t.after(() => restarted.close());
  await assert.rejects(restarted.receive(signed), /already been received/);
  const changed = f.sign();
  changed.envelope.args.projectId = "changed";
  await assert.rejects(f.right.receive(changed), /signature/);
  await assert.rejects(f.right.receive(f.sign({ target: f.leftIdentity.id })), /Invalid or expired/);
  await assert.rejects(f.right.receive(f.sign({ expiresAt: timestamp - 1 })), /Invalid or expired/);
  await assert.rejects(f.right.receive(f.sign({ expiresAt: timestamp + 60_001 })), /Invalid or expired/);
  await assert.rejects(f.right.receive(f.sign({ source: "a".repeat(64) })), /disabled or expired/);
  assert.equal(f.rightExecutor.calls.length, 1);
});

test("revoking, disabling and expiring a peer stop authorization and cancel its jobs", async (t) => {
  const f = await pair(t);
  await f.right.configure({ ...f.rightConfig, peers: [{ ...f.rightConfig.peers[0], enabled: false }] });
  assert.ok(f.rightExecutor.revoked.includes(f.leftIdentity.id));
  await assert.rejects(f.right.receive(f.sign()), /disabled or expired/);
  await f.right.configure(f.rightConfig);
  f.advance(3600_001);
  await assert.rejects(f.right.receive(f.sign()), /disabled or expired/);
  await f.right.configure({ ...f.rightConfig, enabled: false });
  assert.equal((await f.right.state()).config.enabled, false);
});

test("configuration rejects mismatched keys, unlimited grants, unsafe hosts and roots", async (t) => {
  const f = await pair(t);
  const invalidPeer = async (change) => assert.rejects(f.right.configure({ ...f.rightConfig, peers: [{ ...f.rightConfig.peers[0], ...change }] }));
  await invalidPeer({ id: "a".repeat(64) });
  await invalidPeer({ publicKey: "not-a-key" });
  await invalidPeer({ expiresAt: null });
  await invalidPeer({ expiresAt: timestamp + 31 * 86400_000 });
  await invalidPeer({ host: "-oProxyCommand=bad" });
  await invalidPeer({ host: "host;bad" });
  await invalidPeer({ port: 0 });
  await invalidPeer({ projectIds: ["unknown"] });
  await invalidPeer({ capabilities: ["shell.execute"] });
  await assert.rejects(f.right.configure({ ...f.rightConfig, projects: [{ id: "project", root: "relative" }] }));
  await assert.rejects(f.right.configure({ ...f.rightConfig, projects: [{ id: "project", root: path.parse(f.directory).root }] }), /project directory/);
  await assert.rejects(f.right.configure({ ...f.rightConfig, projects: [{ id: "project", root: os.homedir() }] }), /project directory/);
  await f.right.configure({ ...f.rightConfig, peers: [{ ...f.rightConfig.peers[0], host: "" }] });
  assert.equal((await f.right.state()).config.peers[0].host, "");
});

test("SSH dispatch uses verified host keys, no forwarded agent and stdin request data", () => {
  const args = bridgeSshArgs({ host: "user@paired-host", port: 5190 });
  assert.ok(args.includes("StrictHostKeyChecking=yes"));
  assert.ok(args.includes("ForwardAgent=no"));
  assert.ok(args.includes("ControlPath=none"));
  assert.ok(args.includes("BatchMode=yes"));
  assert.equal(args.at(-2), "user@paired-host");
  assert.ok(args.at(-1).includes("--data-binary @-"));
  assert.ok(args.at(-1).includes("http://127.0.0.1:5190/bridge/receive"));
  assert.ok(!args.join(" ").includes("accept-new"));
  assert.throws(() => bridgeSshArgs({ host: "good;bad", port: 5190 }));
});

test("HTTP signed receiver is separate from admin routes and rejects non-loopback callers", async () => {
  const calls = [];
  const router = createBridgeRouter({ receive: async () => { calls.push("receive"); return { ok: true }; } }, (_, status, body) => calls.push({ status, body }));
  const req = new PassThrough();
  req.method = "POST";
  req.headers = { "content-type": "application/json" };
  req.socket = { remoteAddress: "192.0.2.4" };
  assert.equal(await router(req, {}, new URL("http://localhost/bridge/config"), true), false);
  assert.equal(await router(req, {}, new URL("http://localhost/bridge/receive"), true), true);
  assert.equal(calls[0].status, 403);
  assert.ok(!calls.includes("receive"));
});

test("body limits and unsafe state permissions are enforced", async (t) => {
  const req = new PassThrough();
  req.headers = { "content-type": "application/json", "content-length": "2097153" };
  await assert.rejects(readBridgeBody(req), /too large/);
  req.end();
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pzza-bridge-unsafe-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  await fs.chmod(directory, 0o777);
  const bridge = createBridge({ stateDir: directory, executor: executor() });
  await assert.rejects(bridge.state(), /not writable by others/);
});


test("paired real executors read and atomically write only a granted project", async (t) => {
  const f = await pair(t, true);
  const file = path.join(f.directory, "example.txt");
  await fs.writeFile(file, "before");
  await f.right.configure({ ...f.rightConfig, peers: [{ ...f.rightConfig.peers[0], capabilities: ["files.read", "files.write"] }] });
  const read = await f.left.dispatch({ peerId: f.rightIdentity.id, action: "files.read", args: { projectId: "project", path: "example.txt" } });
  assert.equal(Buffer.from(read.content, "base64").toString(), "before");
  await f.left.dispatch({ peerId: f.rightIdentity.id, action: "files.write", args: { projectId: "project", path: "example.txt", content: "after", expectedSha256: read.sha256 } });
  assert.equal(await fs.readFile(file, "utf8"), "after");
  await assert.rejects(f.left.dispatch({ peerId: f.rightIdentity.id, action: "files.write", args: { projectId: "project", path: "example.txt", content: "stale", expectedSha256: read.sha256 } }), /changed/);
  await assert.rejects(f.left.dispatch({ peerId: f.rightIdentity.id, action: "files.read", args: { projectId: "project", path: "../outside" } }), /outside/);
  assert.deepEqual(await f.left.dispatch({ peerId: f.rightIdentity.id, action: "jobs.list", args: {} }), { jobs: [] });
});


test("dispatch verifies the responding device and binds responses to each request", async (t) => {
  const f = await pair(t);
  const call = () => f.left.dispatch({ peerId: f.rightIdentity.id, action: "bridge.describe", args: {} });
  f.transformResponse((response) => { response.envelope.result.platform = "tampered"; return response; });
  await assert.rejects(call(), /signature/);
  const wrongKey = crypto.createPrivateKey(await fs.readFile(path.join(f.directory, "left/bridge/identity.pem")));
  f.transformResponse((response) => ({ ...response, signature: crypto.sign(null, Buffer.from(canonicalEnvelope(response.envelope)), wrongKey).toString("base64") }));
  await assert.rejects(call(), /signature/);
  let saved;
  f.transformResponse((response) => { saved = response; return response; });
  await call();
  f.transformResponse(() => saved);
  await assert.rejects(call(), /invalid signed response/);
});

test("activity retains only authenticated action metadata, never arguments or output", async (t) => {
  const f = await pair(t);
  const sensitive = "private-transcript-fixture-do-not-retain";
  const invalid = f.sign();
  invalid.signature = "A".repeat(86) + "==";
  await assert.rejects(f.right.receive(invalid), /signature/);
  assert.deepEqual(f.right.audit(), { audit: [] });
  await f.right.receive(f.sign({ args: { projectId: "project", text: sensitive, path: `/private/${sensitive}` } }));
  await assert.rejects(f.right.receive(f.sign({ action: sensitive, args: { projectId: sensitive } })), /not allowed/);
  f.rightExecutor.execute = async () => { throw new Error(sensitive); };
  await assert.rejects(f.right.receive(f.sign()), /private-transcript-fixture/);
  const { audit } = f.right.audit();
  assert.equal(audit.length, 3);
  assert.deepEqual(audit.map((entry) => entry.outcome), ["accepted", "denied", "failed"]);
  assert.equal(audit[1].action, "unknown");
  assert.equal(audit[1].projectId, null);
  for (const entry of audit) assert.deepEqual(Object.keys(entry).sort(), ["action", "outcome", "peerId", "projectId", "time"]);
  const file = path.join(f.directory, "right/bridge/audit.json");
  const persisted = await fs.readFile(file, "utf8");
  assert.ok(!persisted.includes(sensitive));
  assert.ok(!persisted.includes("signature"));
  assert.ok(!persisted.includes("PRIVATE KEY"));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  const restarted = createBridge({ stateDir: path.join(f.directory, "right"), executor: executor(), now: f.now });
  t.after(() => restarted.close());
  assert.deepEqual((await restarted.state()).audit, audit);
});

test("activity history remains bounded to the last 200 requests", async (t) => {
  const f = await pair(t);
  for (let index = 0; index < 205; index++) {
    f.advance(1);
    await f.right.receive(f.sign({ action: "bridge.describe", args: {} }));
  }
  const { audit } = f.right.audit();
  assert.equal(audit.length, 200);
  assert.equal(audit[0].time, timestamp + 6);
  assert.equal(audit.at(-1).time, timestamp + 205);
  assert.equal(JSON.parse(await fs.readFile(path.join(f.directory, "right/bridge/audit.json"), "utf8")).length, 200);
});


test("an unchanged expired grant cannot block revoking another peer or disabling the bridge", async (t) => {
  const f = await pair(t);
  const publicKey = crypto.generateKeyPairSync("ed25519").publicKey.export({ format: "der", type: "spki" });
  const other = { ...f.rightConfig.peers[0], id: crypto.createHash("sha256").update(publicKey).digest("hex"), publicKey: publicKey.toString("base64"), label: "Other device" };
  await f.right.configure({ ...f.rightConfig, peers: [...f.rightConfig.peers, other] });
  f.advance(3600_001);
  await f.right.configure(f.rightConfig);
  assert.ok(f.rightExecutor.revoked.includes(other.id));
  await assert.rejects(f.right.receive(f.sign()), /disabled or expired/);
  await assert.rejects(f.right.configure({ ...f.rightConfig, peers: [...f.rightConfig.peers, other] }), /expire within/);
  await f.right.configure({ ...f.rightConfig, enabled: false });
  await assert.rejects(f.right.configure(f.rightConfig), /expire within/);
  await assert.rejects(f.right.configure({ ...f.rightConfig, enabled: false, peers: [{ ...f.rightConfig.peers[0], expiresAt: null }] }), /expire within/);
  assert.equal((await f.right.state()).config.enabled, false);
});

async function setupConnection(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'pzza-bridge-connect-')));
  const right = createBridge({ stateDir: path.join(directory, 'right'), executor: executor() });
  let remoteFailures = false;
  const calls = [];
  const left = createBridge({ stateDir: path.join(directory, 'left'), executor: executor(), now: options.now,
    agentRequest: async (host, endpoint, body) => {
      assert.equal(host, 'trusted-device');
      calls.push({ endpoint, body });
      if (endpoint === '/bridge/state') return right.state();
      assert.equal(endpoint, '/bridge/pair-grant');
      if (remoteFailures && body.operation === 'remove') throw new Error('Disconnected');
      const result = await right.pairGrant(body);
      if (options.dropGrantResponse && body.operation === 'add') throw Object.assign(new Error('Connection dropped after saving'), { status: 502 });
      return result;
    },
    transport: async (_, request) => {
      await options.beforeVerify?.();
      if (options.failVerification) { remoteFailures = options.failRollback; throw Object.assign(new Error('Verification failed'), { status: 502 }); }
      return right.receiveSigned(request);
    },
  });
  t.after(async () => { await left.close(); await right.close(); await fs.rm(directory, { recursive: true, force: true }); });
  const request = { host: 'trusted-device', identityId: (await right.state()).identity.id, label: 'Development device', localLabel: 'Laptop', project: { id: 'project', root: directory }, capabilities: ['files.read', 'terminal.read'], expiresAt: Date.now() + 3600000 };
  return { left, right, request, directory, calls };
}

async function connectionOutcome(bridge, operationId) {
  for (let attempt = 0; attempt < 1000; attempt++) {
    const operation = bridge.connectionStatus({ operationId });
    if (operation.status !== 'pending') return operation;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('Pairing did not settle');
}
async function completeConnection(bridge, request) {
  const operation = bridge.connect({ ...request, operationId: crypto.randomUUID() });
  const outcome = await connectionOutcome(bridge, operation.id);
  if (outcome.status === 'failed') throw new Error(outcome.error);
  return outcome.result;
}

test('trusted setup configures both identities, verifies signed access and grants only the selected remote project', async t => {
  const f = await setupConnection(t);
  const result = await completeConnection(f.left, f.request);
  assert.deepEqual(result.connection.projects, [{ id: 'project', name: path.basename(f.directory) }]);
  assert.deepEqual(result.connection.capabilities, ['files.read', 'terminal.read']);
  assert.deepEqual(result.state.config.peers[0].capabilities, []);
  assert.deepEqual(result.state.config.projects, []);
  assert.equal((await f.right.state()).config.peers[0].host, '');
  await assert.rejects(completeConnection(f.left, f.request), /already paired/);
  await assert.rejects(f.left.dispatch({ peerId: f.request.identityId, action: 'files.write', args: { projectId: 'project' } }), /not allowed/);
  await assert.rejects(f.left.dispatch({ peerId: f.request.identityId, action: 'files.read', args: { projectId: 'other' } }), /not allowed/);
});

test('pairing rolls back both grants when signed verification fails', async t => {
  const f = await setupConnection(t, { failVerification: true });
  await assert.rejects(completeConnection(f.left, f.request), /Verification failed/);
  assert.deepEqual((await f.left.state()).config, { enabled: false, projects: [], peers: [] });
  assert.deepEqual((await f.right.state()).config, { enabled: false, projects: [], peers: [] });
});

test('pairing explicitly reports a destination rollback failure', async t => {
  const f = await setupConnection(t, { failVerification: true, failRollback: true });
  await assert.rejects(completeConnection(f.left, f.request), /could not be fully removed/);
  assert.deepEqual((await f.left.state()).config.peers, []);
  assert.equal((await f.right.state()).config.peers.length, 1);
});

test('pairing rejects changed identities, unsafe project roots and stale config without grants', async t => {
  const f = await setupConnection(t);
  await assert.rejects(completeConnection(f.left, { ...f.request, identityId: 'f'.repeat(64) }), /identity changed/);
  await assert.rejects(completeConnection(f.left, { ...f.request, project: { id: 'project', root: '/' } }), /project directory/);
  await assert.rejects(f.right.pairGrant({ operation: 'add', expectedIdentityId: f.request.identityId, expectedConfigHash: '0'.repeat(64), peer: {}, project: f.request.project }), /settings changed/);
  assert.deepEqual((await f.left.state()).config.peers, []);
  assert.deepEqual((await f.right.state()).config.peers, []);
});

test('pairing never reactivates previously disabled global access or replaces an existing project scope', async t => {
  const f = await setupConnection(t);
  const other = crypto.generateKeyPairSync('ed25519').publicKey.export({ format: 'der', type: 'spki' });
  const peer = { id: crypto.createHash('sha256').update(other).digest('hex'), publicKey: other.toString('base64'), label: 'Other', host: '', port: 5190, enabled: true, expiresAt: f.request.expiresAt, projectIds: [], capabilities: [] };
  await f.right.configure({ enabled: false, peers: [peer], projects: [] });
  await assert.rejects(completeConnection(f.left, f.request), /Enable or revoke existing/);
  await f.right.configure({ enabled: true, peers: [peer], projects: [{ id: 'project', root: path.dirname(f.directory) }] });
  await assert.rejects(completeConnection(f.left, f.request), /another folder/);
  assert.equal((await f.right.state()).config.peers.length, 1);
});


test('pairing removes the exact remote grant when its successful response is lost', async t => {
  const f = await setupConnection(t, { dropGrantResponse: true });
  await assert.rejects(completeConnection(f.left, f.request), /Connection dropped after saving/);
  assert.deepEqual((await f.left.state()).config, { enabled: false, projects: [], peers: [] });
  assert.deepEqual((await f.right.state()).config, { enabled: false, projects: [], peers: [] });
});

test('pairing start and status stay bounded while verification exceeds the HTTP timeout', async t => {
  const gate = Promise.withResolvers();
  const verifying = Promise.withResolvers();
  t.after(() => gate.resolve());
  let clock = Date.now();
  const f = await setupConnection(t, { now: () => clock, beforeVerify: () => { verifying.resolve(); return gate.promise; } });
  const operationId = crypto.randomUUID();
  const request = new PassThrough();
  request.method = 'POST';
  request.headers = { 'content-type': 'application/json' };
  let response;
  const router = createBridgeRouter(f.left, (_res, status, value) => { response = { status, value }; });
  const handled = router(request, {}, new URL('http://localhost/bridge/connect'));
  request.end(JSON.stringify({ ...f.request, operationId }));
  await handled;
  assert.equal(response.status, 202);
  assert.equal(response.value.status, 'pending');
  await verifying.promise;
  clock += 16_000;
  assert.equal(f.left.connectionStatus({ operationId }).status, 'pending');
  const calls = f.calls.length;
  for (let check = 0; check < 10; check++) assert.equal(f.left.connectionStatus({ operationId }).status, 'pending');
  assert.equal(f.calls.length, calls, 'status must not re-run remote work');
  gate.resolve();
  const completed = await connectionOutcome(f.left, operationId);
  assert.equal(completed.status, 'completed');
  assert.deepEqual(completed.result.connection.capabilities, f.request.capabilities);
  assert.deepEqual(completed.result.connection.projects.map(project => project.id), [f.request.project.id]);
  assert.equal(completed.result.connection.expiresAt, f.request.expiresAt);
  assert.equal(f.calls.filter(call => call.body?.operation === 'add').length, 1);
});

test('duplicate pairing IDs recover a lost start response without repeating grants or changing scope', async t => {
  const gate = Promise.withResolvers();
  const verifying = Promise.withResolvers();
  t.after(() => gate.resolve());
  const f = await setupConnection(t, { beforeVerify: () => { verifying.resolve(); return gate.promise; } });
  const input = { ...f.request, operationId: crypto.randomUUID() };
  f.left.connect(input); // Discard the initiating response, as a disconnected client would.
  await verifying.promise;
  assert.equal(f.left.connectionStatus({ operationId: input.operationId }).status, 'pending');
  assert.equal(f.left.connect(input).status, 'pending');
  for (const change of [{ identityId: 'f'.repeat(64) }, { project: { ...input.project, id: 'other' } }, { capabilities: ['files.write'] }, { expiresAt: input.expiresAt + 1 }]) {
    assert.throws(() => f.left.connect({ ...input, ...change }), /different request/);
  }
  assert.throws(() => f.left.connect({ ...input, operationId: crypto.randomUUID() }), /already running/);
  gate.resolve();
  const completed = await connectionOutcome(f.left, input.operationId);
  assert.deepEqual(f.left.connect(input), completed);
  completed.result.connection.capabilities.push('files.write');
  assert.deepEqual(f.left.connectionStatus({ operationId: input.operationId }).result.connection.capabilities, f.request.capabilities);
  assert.equal(f.calls.filter(call => call.body?.operation === 'add').length, 1);
});

test('tracked failures settle only after rollback and preserve incomplete rollback warnings', async t => {
  for (const failRollback of [false, true]) {
    const f = await setupConnection(t, { failVerification: true, failRollback });
    const input = { ...f.request, operationId: crypto.randomUUID() };
    assert.equal(f.left.connect(input).status, 'pending');
    const failed = await connectionOutcome(f.left, input.operationId);
    assert.equal(failed.status, 'failed');
    assert.match(failed.error, failRollback ? /could not be fully removed/ : /Verification failed/);
    assert.deepEqual((await f.left.state()).config.peers, []);
    assert.equal((await f.right.state()).config.peers.length, failRollback ? 1 : 0);
    const callCount = f.calls.length;
    assert.deepEqual(f.left.connect(input), failed);
    assert.equal(f.calls.length, callCount);
  }
});

test('pairing history is bounded, retains pending operations and never evicts recent results', async t => {
  let clock = Date.now();
  const f = await setupConnection(t, { now: () => clock });
  const ids = [];
  for (let index = 0; index < 32; index++) {
    const operationId = crypto.randomUUID();
    ids.push(operationId);
    f.left.connect({ ...f.request, identityId: 'f'.repeat(64), operationId });
    assert.equal((await connectionOutcome(f.left, operationId)).status, 'failed');
  }
  assert.throws(() => f.left.connect({ ...f.request, operationId: crypto.randomUUID() }), error => error.status === 429);
  assert.equal(f.left.connectionStatus({ operationId: ids[0] }).status, 'failed');
  clock += 3600_001;
  assert.throws(() => f.left.connectionStatus({ operationId: ids[0] }), error => error.status === 404);
  assert.throws(() => f.left.connectionStatus({ operationId: 'invalid' }), error => error.status === 400);
  assert.throws(() => f.left.connectionStatus({ operationId: ids[1], capabilities: ['files.write'] }), error => error.status === 400);
  const operation = f.left.connect({ ...f.request, identityId: 'f'.repeat(64), operationId: crypto.randomUUID() });
  assert.equal((await connectionOutcome(f.left, operation.id)).status, 'failed');
});

test('pairing start and status are never exposed through the signed peer receiver', async t => {
  const f = await pair(t);
  const router = createBridgeRouter(f.right, () => assert.fail('Admin endpoint bypassed authentication'));
  for (const endpoint of ['connect', 'connect-status']) {
    assert.equal(await router({ method: 'POST' }, {}, new URL(`http://localhost/bridge/${endpoint}`), true), false);
    await assert.rejects(f.right.receive(f.sign({ action: `bridge.${endpoint}`, args: { operationId: crypto.randomUUID() } })), /not allowed/);
  }
});

test('checked administrative configuration and revocation reject stale updates and signed-peer elevation', async t => {
  const f = await pair(t);
  const initial = await f.right.state();
  await assert.rejects(f.right.receive(f.sign({ action: 'bridge.configure', args: { enabled: true } })), /not allowed/);
  await f.right.configureChecked({ config: { ...initial.config, enabled: false }, expectedConfigHash: initial.configHash });
  assert.throws(() => f.right.revoke({ peerId: f.leftIdentity.id, expectedConfigHash: initial.configHash }), /settings changed/);
  const current = await f.right.state();
  await f.right.revoke({ peerId: f.leftIdentity.id, expectedConfigHash: current.configHash });
  assert.equal((await f.right.state()).config.peers.length, 0);
});

test('settings routes cannot restore revoked access from stale or unchecked drafts', async t => {
  const f = await pair(t);
  const initial = await f.right.state();
  const call = async (endpoint, body) => {
    let response;
    const router = createBridgeRouter(f.right, (_res, status, value) => { response = { status, value }; });
    const request = new PassThrough();
    request.method = 'POST';
    request.headers = { 'content-type': 'application/json' };
    const pending = router(request, {}, new URL(`http://localhost/bridge/${endpoint}`));
    request.end(JSON.stringify(body));
    assert.equal(await pending, true);
    return response;
  };
  await f.right.revoke({ peerId: f.leftIdentity.id, expectedConfigHash: initial.configHash });
  const stale = await call('configure', { config: initial.config, expectedConfigHash: initial.configHash });
  assert.equal(stale.status, 409);
  assert.match(stale.value.error, /settings changed/);
  assert.equal((await call('config', initial.config)).status, 404);
  assert.equal((await call('configure', { config: initial.config })).status, 409);
  const current = await f.right.state();
  assert.equal(current.config.peers.length, 0);
  const saved = await call('configure', { config: { ...current.config, enabled: false }, expectedConfigHash: current.configHash });
  assert.equal(saved.status, 200);
  assert.equal(saved.value.config.enabled, false);
  assert.equal(saved.value.config.peers.length, 0);
});
