import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const installer = await fs.readFile(new URL('../install.sh', import.meta.url), 'utf8');
const source = installer.match(/<<'PZZA_PRIVATE_STATE'\n([\s\S]+?)\nPZZA_PRIVATE_STATE/)[1];
const prepare = directory => run(process.execPath, ['-e', source.replaceAll('process.argv[2]', 'process.argv[1]'), directory], { timeout: 3000 });

test('installer repairs existing private app state permissions without changing contents', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pzza-install-state-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const state = path.join(root, 'state');
  await fs.mkdir(path.join(state, 'backups'), { recursive: true });
  await fs.chmod(state, 0o775);
  await fs.chmod(path.join(state, 'backups'), 0o775);
  await fs.writeFile(path.join(state, 'preferences.json'), '{}');
  await prepare(state);
  await prepare(state);
  assert.equal((await fs.stat(state)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(state, 'backups'))).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(path.join(state, 'preferences.json'), 'utf8'), '{}');
});

test('installer refuses symbolic links for state and backups without changing their targets', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pzza-install-symlink-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const target = path.join(root, 'target');
  await fs.mkdir(target); await fs.chmod(target, 0o755);
  const state = path.join(root, 'state'); await fs.symlink(target, state);
  await assert.rejects(prepare(state), /without symlinks/);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
  await fs.unlink(state); await fs.mkdir(state); await fs.symlink(target, path.join(state, 'backups'));
  await assert.rejects(prepare(state), /without symlinks/);
  assert.equal((await fs.stat(target)).mode & 0o777, 0o755);
});
