import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';

const run = promisify(execFile);
const release = await fs.readFile(new URL('./release.sh', import.meta.url), 'utf8');

test('release builds only Apple Silicon and selects matching bundle paths', () => {
  assert.match(release, /npm run tauri build -- --target aarch64-apple-darwin --bundles app,dmg/);
  assert.match(release, /BUNDLE="src-tauri\/target\/aarch64-apple-darwin\/release\/bundle"/);
  assert.match(release, /DMG="\$BUNDLE\/dmg\/PzzaCode_\$\{VERSION\}_aarch64\.dmg"/);
  assert.doesNotMatch(release, /universal-apple-darwin|x86_64-apple-darwin/);
});

test('ARM-only updater metadata never offers the artifact to Intel installations', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pzza-release-architecture-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const signature = path.join(root, 'signature');
  const notes = path.join(root, 'notes');
  await fs.writeFile(signature, 'test-signature\n');
  await fs.writeFile(notes, 'Architecture verification\n');
  const source = release.match(/<<'PY'\n([\s\S]+?)\nPY/);
  assert.ok(source, 'The release metadata generator must be present');
  // Execute only metadata generation, never the signing or publishing commands.
  const { stdout } = await run('python3', ['-c', source[1], '0.0.0', 'https://example.invalid/app.tar.gz', signature, notes], { timeout: 3000 });
  const metadata = JSON.parse(stdout);
  assert.deepEqual(metadata.platforms, {
    'darwin-aarch64': { signature: 'test-signature', url: 'https://example.invalid/app.tar.gz' },
  });
  assert.equal(metadata.version, '0.0.0');
  assert.equal(metadata.notes, 'Architecture verification');
});
