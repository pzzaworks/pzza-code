import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const memory = new Map([['pzza.autoUpdate', 'true']]);
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
globalThis.window = Object.assign(new EventTarget(), { __TAURI_INTERNALS__: {}, location: { protocol: 'http:', hostname: '127.0.0.1' } });
let installAttempts = 0;
globalThis.pzzaUpdateCheck = async () => ({ version: '0.2.31', currentVersion: '0.2.30', downloadAndInstall: async () => { installAttempts++; throw new Error('Installation is outside this check'); } });
const output = await build({ entryPoints: [new URL('../src/state/updates.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false,
  plugins: [{ name: 'updater-boundary', setup(build) {
    build.onResolve({ filter: /^@tauri-apps\/plugin-updater$/ }, () => ({ path: 'updater', namespace: 'test' }));
    build.onLoad({ filter: /.*/, namespace: 'test' }, () => ({ contents: 'export const check = () => globalThis.pzzaUpdateCheck();', loader: 'js' }));
  } }],
});
const { useUpdates } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('an app-control update check never installs automatically even when automatic updates are enabled', async () => {
  assert.equal(useUpdates.getState().autoUpdate, true);
  await useUpdates.getState().check(true, false);
  assert.equal(useUpdates.getState().status.kind, 'available');
  assert.equal(useUpdates.getState().status.update.version, '0.2.31');
  assert.equal(installAttempts, 0);
});
