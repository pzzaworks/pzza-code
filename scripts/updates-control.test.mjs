import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const memory = new Map([['pzza.autoUpdate', 'true']]);
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
globalThis.window = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, location: { protocol: 'http:', hostname: '127.0.0.1' } });
let installAttempts = 0;
globalThis.pzzaUpdateCheck = async () => ({ version: '0.2.31', currentVersion: '0.2.30', downloadAndInstall: async () => { installAttempts++; throw new Error('Installation is outside this check'); } });
globalThis.pzzaRestart = async () => {};
const output = await build({ stdin: { contents: `
  export { useUpdates } from './state/updates';
  export { relaunchApp } from './updater';
  export { registerUnsavedDraft } from './state/unsavedWork';
  export { currentConfirmation, answerConfirmation } from './state/confirmations';
`, resolveDir: new URL('../src', import.meta.url).pathname }, bundle: true, platform: 'browser', format: 'esm', write: false,
  plugins: [{ name: 'updater-boundary', setup(build) {
    build.onResolve({ filter: /^@tauri-apps\/plugin-updater$/ }, () => ({ path: 'updater', namespace: 'test' }));
    build.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: 'core', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, ({ path }) => ({ contents: path === 'core'
      ? 'export const invoke = (...args) => globalThis.pzzaRestart(...args);'
      : 'export const check = () => globalThis.pzzaUpdateCheck();', loader: 'js' }));
  } }],
});
const { useUpdates, relaunchApp, registerUnsavedDraft, currentConfirmation, answerConfirmation } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
const settle = () => new Promise(resolve => setImmediate(resolve));
const installedUpdate = { version: '0.2.31', currentVersion: '0.2.30', install: async () => { throw new Error('Installed updates must not install again'); } };
function ready() {
  useUpdates.setState({ status: { kind: 'ready', update: installedUpdate } });
}

test('an app-control update check never installs automatically even when automatic updates are enabled', async () => {
  assert.equal(useUpdates.getState().autoUpdate, true);
  await useUpdates.getState().check(true, false);
  assert.equal(useUpdates.getState().status.kind, 'available');
  assert.equal(useUpdates.getState().status.update.version, '0.2.31');
  assert.equal(installAttempts, 0);
});

test('restart waits for managed cleanup and suppresses a second click', async () => {
  ready();
  const commands = [];
  let finish;
  globalThis.pzzaRestart = command => { commands.push(command); return new Promise(resolve => { finish = resolve; }); };
  const restarting = useUpdates.getState().relaunch();
  await settle();
  assert.deepEqual(commands, ['app_restart']);
  assert.equal(useUpdates.getState().status.restarting, true);
  await useUpdates.getState().relaunch();
  assert.deepEqual(commands, ['app_restart']);
  finish();
  await restarting;
});

test('cleanup failure preserves the installed update and permits restart retry', async () => {
  ready();
  let attempts = 0;
  globalThis.pzzaRestart = async () => {
    if (++attempts === 1) throw new Error('Dictation is still stopping');
  };
  await useUpdates.getState().relaunch();
  assert.deepEqual(useUpdates.getState().status, {
    kind: 'ready', update: installedUpdate, restarting: false, error: 'Dictation is still stopping',
  });
  await useUpdates.getState().relaunch();
  assert.equal(attempts, 2);
  assert.equal(useUpdates.getState().status.error, undefined);
  assert.equal(useUpdates.getState().status.update, installedUpdate);
  assert.equal(installAttempts, 0);
});

test('the native restart boundary rejects cleanup failures', async () => {
  globalThis.pzzaRestart = async () => { throw new Error('Native cleanup failed'); };
  await assert.rejects(relaunchApp(), /Native cleanup failed/);
});

test('cancelling unsaved work prevents restart and keeps the retry button available', async t => {
  ready();
  t.after(registerUnsavedDraft('restart-settings', () => ({ label: 'Settings', dirty: true })));
  const commands = [];
  globalThis.pzzaRestart = async command => { commands.push(command); };
  const restarting = useUpdates.getState().relaunch();
  const confirmation = currentConfirmation();
  assert.ok(confirmation);
  answerConfirmation(confirmation, false);
  await restarting;
  assert.deepEqual(commands, []);
  assert.equal(useUpdates.getState().status.kind, 'ready');
  assert.equal(useUpdates.getState().status.restarting, false);
});

test('approved unsaved work cancels quick chat before managed restart', async t => {
  ready();
  t.after(registerUnsavedDraft('restart-settings', () => ({ label: 'Settings', dirty: true })));
  const events = [];
  const cancelled = () => events.push('quick-chat-cancel');
  window.addEventListener('pzza:quick-chat-cancel', cancelled);
  t.after(() => window.removeEventListener('pzza:quick-chat-cancel', cancelled));
  globalThis.pzzaRestart = async command => { events.push(command); };
  const restarting = useUpdates.getState().relaunch();
  const confirmation = currentConfirmation();
  assert.ok(confirmation);
  answerConfirmation(confirmation, true);
  await restarting;
  assert.deepEqual(events, ['quick-chat-cancel', 'app_restart']);
});
