import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
globalThis.window = Object.assign(new EventTarget(), { location: { protocol: 'http:', hostname: '127.0.0.1', port: '1438' } });
const output = await build({ entryPoints: [new URL('../src/state/projectSync.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false });
const control = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('saved sync choices update the shared UI store and persist exact repository/device options', () => {
  const previous = control.useProjectSyncPreferences.getState();
  const options = { ...previous.options, cloneMissing: false, syncEnvs: false, repos: { project: { enabled: false, env: false } }, envExclude: ['private'] };
  let observed;
  const stop = control.useProjectSyncPreferences.subscribe(value => { observed = value; });
  control.updateProjectSyncPreferences({ root: '~/Projects/selected', devicesOff: ['other'], options });
  stop();
  assert.deepEqual(observed.options, options);
  assert.equal(memory.get('pzza.projectsRoot'), '~/Projects/selected');
  assert.deepEqual(JSON.parse(memory.get('pzza.sync.options')), options);
  assert.deepEqual(JSON.parse(memory.get('pzza.sync.devicesOff')), ['other']);
});

test('scan/sync control returns running state and prevents duplicate work while exposing completion and cancellation', async () => {
  let finish;
  let cancelled = false;
  const pending = new Promise(resolve => { finish = resolve; });
  const unbind = control.bindProjectOperations({ scan: () => pending, sync: async () => false, cancel: async () => { cancelled = true; }, snapshot: () => ({ scanning: false, syncing: false, error: null, scan: { devices: [] }, sync: null }) });
  const started = await control.startProjectOperation('scan');
  assert.equal(started.operation.status, 'running');
  await assert.rejects(control.startProjectOperation('scan'), /already running/);
  await control.cancelProjectOperation();
  assert.equal(cancelled, true);
  finish(true); await new Promise(resolve => setImmediate(resolve));
  assert.equal(control.projectSyncSnapshot().operation.status, 'complete');
  await control.startProjectOperation('sync'); await new Promise(resolve => setImmediate(resolve));
  assert.equal(control.projectSyncSnapshot().operation.status, 'failed');
  unbind();
});

test('control opens the actual sync surface when needed and refuses sync until a scan is available', async () => {
  let unbind;
  const onOpen = event => {
    assert.equal(event.detail, 'sync');
    unbind = control.bindProjectOperations({ scan: async () => true, sync: async () => true, cancel: async () => {}, snapshot: () => ({ scanning: true, syncing: false, error: null, scan: null, sync: null }) });
  };
  window.addEventListener('pzza-notification-section', onOpen, { once: true });
  await assert.rejects(control.startProjectOperation('sync'), /Wait for the project scan/);
  unbind();
});

test('sync summaries distinguish safe skips and current repositories from unsynced work', () => {
  const result = statuses => ({ root: '~/Projects', devices: [{ id: 'local', error: null, envs: [], results: statuses.map((status, index) => ({ projectId: `project-${index}`, rel: `repo-${index}`, status, detail: '' })) }] });
  const unchanged = control.summarizeProjectSync(result(['current', 'skipped']));
  assert.equal(unchanged.complete, true);
  assert.equal(unchanged.needsAttention, false);
  assert.match(unchanged.body, /1 already current, 1 skipped/);
  const dirty = control.summarizeProjectSync(result(['updated', 'dirty']));
  assert.equal(dirty.complete, false);
  assert.equal(dirty.title, 'Sync needs attention');
  assert.match(dirty.body, /left dirty and unsynced/);
  const stashed = control.summarizeProjectSync(result(['stashed']));
  assert.equal(stashed.complete, true);
  assert.equal(stashed.needsAttention, true);
  assert.match(stashed.body, /local changes preserved in a stash/);
  const cancelled = control.summarizeProjectSync({ ...result(['current']), cancelled: true });
  assert.equal(cancelled.complete, false);
  assert.equal(cancelled.title, 'Sync cancelled');
  const failures = result(['failed']);
  failures.devices[0].error = 'Device unavailable';
  failures.devices[0].envs.push({ status: 'failed' });
  assert.match(control.summarizeProjectSync(failures).body, /3 errors/);
});
