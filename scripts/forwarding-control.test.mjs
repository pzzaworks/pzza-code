import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const forwarded = new Set();
const calls = [];
const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
globalThis.window = Object.assign(new EventTarget(), { location: { protocol: 'http:', hostname: '127.0.0.1' }, __TAURI_INTERNALS__: { invoke: async (command, args) => {
  calls.push({ command, args });
  if (command === 'forward_scan') return { masterUp: true, remote: [8080, 8081], wanted: [8080, 8081], forwarded: [...forwarded] };
  if (command === 'forward_set') { if (args.enable) forwarded.add(args.port); else forwarded.delete(args.port); return; }
  throw new Error('Unexpected native operation');
} } });
const output = await build({ entryPoints: [new URL('../src/panels/PortsMenu.tsx', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false, loader: { '.css': 'empty' }, define: { __APP_VERSION__: '"test"' } });
const control = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('UI and app-control reconciliations share a queue and never add an existing forward twice', async () => {
  await Promise.all([control.reconcileSelectedForwarding('trusted', true), control.reconcileSelectedForwarding('trusted', true)]);
  assert.deepEqual([...forwarded], [8080, 8081]);
  assert.equal(calls.filter(call => call.command === 'forward_set').length, 2);
  await control.reconcileSelectedForwarding('trusted', false);
  assert.equal(forwarded.size, 0);
});

test('inactive forwarding views stop before touching native tunnels and saved choices share the UI store', async () => {
  const count = calls.length;
  await assert.rejects(control.reconcileSelectedForwarding('trusted', true, () => false), /view changed/);
  assert.equal(calls.length, count);
  control.updateForwardConfig({ serverId: 'remote', clientId: 'this-mac', enabled: false });
  assert.deepEqual(control.useForwardConfig.getState(), { serverId: 'remote', clientId: 'this-mac', enabled: false });
  assert.equal(memory.get('pzza.fwd.enabled'), '0');
});
