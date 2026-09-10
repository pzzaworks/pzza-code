import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const output = await build({
  entryPoints: [new URL('../src/bridgeApi.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false,
  plugins: [{ name: 'bridge-transport', setup(builder) {
    builder.onResolve({ filter: /^\.\/serverApi$/ }, () => ({ path: 'bridge-transport', namespace: 'test' }));
    builder.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const bridgeRequest = (path, body) => globalThis.bridgeTestRequest(path, body);', loader: 'js' }));
  } }],
});
let moduleId = 0;
const load = () => import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}#${moduleId++}`);
const flush = () => new Promise(resolve => setImmediate(resolve));
const request = { host: 'trusted-device', identityId: 'f'.repeat(64), label: 'Remote', localLabel: 'Local', project: { id: 'project', root: '/project' }, capabilities: ['files.read'], expiresAt: Date.now() + 3600_000 };
const result = { state: { configHash: 'revision', config: { enabled: true, peers: [], projects: [] } }, connection: { projects: [{ id: 'project', name: 'Project' }], capabilities: ['files.read'], expiresAt: request.expiresAt } };
function setup(t) {
  const previousStorage = globalThis.sessionStorage;
  const memory = new Map();
  globalThis.sessionStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value), removeItem: key => memory.delete(key) };
  t.after(() => { globalThis.sessionStorage = previousStorage; delete globalThis.bridgeTestRequest; });
  return memory;
}

test('pairing succeeds after the HTTP timeout window using only short status requests', async t => {
  setup(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const api = await load();
  const began = Date.now();
  const calls = [];
  globalThis.bridgeTestRequest = async (path, body) => {
    calls.push({ path, body });
    return { id: body.operationId, status: path === 'connect' || Date.now() - began < 16_000 ? 'pending' : 'completed', result };
  };
  let completed = false;
  const pending = api.connectBridgeDevice(request).then(value => { completed = true; return value; });
  await flush();
  t.mock.timers.tick(15_000);
  await flush();
  assert.equal(completed, false);
  t.mock.timers.tick(1000);
  await flush();
  assert.deepEqual(await pending, result);
  assert.equal(calls.filter(call => call.path === 'connect').length, 1);
  assert.deepEqual(calls[0].body, { ...request, operationId: calls[0].body.operationId });
  assert.equal(calls.every(call => call.body.operationId === calls[0].body.operationId), true);
  assert.equal(api.getPendingBridgeConnectionId(), null);
});

test('a lost initiating response recovers by the preallocated operation ID, never a repeated grant', async t => {
  setup(t);
  const api = await load();
  const calls = [];
  globalThis.bridgeTestRequest = async (path, body) => {
    calls.push({ path, body });
    if (path === 'connect') {
      assert.equal(api.getPendingBridgeConnectionId(), body.operationId);
      throw new TypeError('Initiating response lost');
    }
    return { id: body.operationId, status: 'completed', result };
  };
  assert.deepEqual(await api.connectBridgeDevice(request), result);
  assert.deepEqual(calls.map(call => call.path), ['connect', 'connect-status']);
  assert.equal(calls[0].body.operationId, calls[1].body.operationId);
});

test('unavailable status stays pending across remount and reload, and recovery cannot replay or widen grants', async t => {
  setup(t);
  const api = await load();
  let starts = 0;
  globalThis.bridgeTestRequest = async (path, body) => {
    if (path === 'connect') { starts++; return { id: body.operationId, status: 'pending' }; }
    throw new TypeError('Status response lost');
  };
  let operationId;
  await assert.rejects(api.connectBridgeDevice(request), error => {
    assert.ok(error instanceof api.BridgeConnectionPendingError);
    assert.equal(error.status, 'pending');
    operationId = error.operationId;
    return true;
  });
  assert.equal(api.getPendingBridgeConnectionId(), operationId);
  const remounted = await load();
  assert.equal(remounted.getPendingBridgeConnectionId(), operationId);
  await assert.rejects(remounted.connectBridgeDevice({ ...request, capabilities: ['files.write'] }), error => error.operationId === operationId);
  assert.equal(starts, 1);
  globalThis.bridgeTestRequest = async (path, body) => {
    assert.equal(path, 'connect-status');
    assert.deepEqual(body, { operationId });
    return { id: operationId, status: 'completed', result };
  };
  assert.deepEqual(await remounted.resumeBridgeConnection(operationId), result);
  assert.equal(remounted.getPendingBridgeConnectionId(), null);
});

test('reported failure is distinct from missing status and preserves rollback warnings', async t => {
  setup(t);
  const api = await load();
  globalThis.bridgeTestRequest = async (path, body) => ({ id: body.operationId, status: path === 'connect' ? 'pending' : 'failed', error: 'Grant could not be fully removed. Revoke access on both devices.' });
  await assert.rejects(api.connectBridgeDevice(request), /could not be fully removed/);
  assert.equal(api.getPendingBridgeConnectionId(), null);
  globalThis.bridgeTestRequest = async (path, body) => {
    if (path === 'connect') return { id: body.operationId, status: 'pending' };
    throw Object.assign(new Error('Result no longer retained'), { status: 404 });
  };
  await assert.rejects(api.connectBridgeDevice(request), error => error instanceof api.BridgeConnectionPendingError && error.noLongerRetained);
  const missingId = api.getPendingBridgeConnectionId();
  assert.ok(missingId);
  globalThis.bridgeTestRequest = () => assert.fail('Dismissing tracking must not change device grants');
  api.dismissPendingBridgeConnection('another-operation');
  assert.equal(api.getPendingBridgeConnectionId(), missingId);
  api.dismissPendingBridgeConnection(missingId);
  assert.equal(api.getPendingBridgeConnectionId(), null);
});

test('bounded waiting leaves accepted work pending instead of inventing failure or completion', async t => {
  setup(t);
  t.mock.timers.enable({ apis: ['Date', 'setTimeout'], now: Date.now() });
  const api = await load();
  let starts = 0;
  globalThis.bridgeTestRequest = async (path, body) => { if (path === 'connect') starts++; return { id: body.operationId, status: 'pending' }; };
  const pending = assert.rejects(api.connectBridgeDevice(request), error => error instanceof api.BridgeConnectionPendingError);
  await flush();
  t.mock.timers.tick(120_000);
  await pending;
  assert.equal(starts, 1);
  assert.ok(api.getPendingBridgeConnectionId());
});

test('explicit unauthorized start is rejected without polling or saving a false pending operation', async t => {
  setup(t);
  const api = await load();
  const calls = [];
  globalThis.bridgeTestRequest = async path => { calls.push(path); throw Object.assign(new Error('Unauthorized'), { status: 401 }); };
  await assert.rejects(api.connectBridgeDevice(request), /Unauthorized/);
  assert.deepEqual(calls, ['connect']);
  assert.equal(api.getPendingBridgeConnectionId(), null);
});
