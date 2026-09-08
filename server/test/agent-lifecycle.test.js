import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const lifecycle = new URL('../lib/agent-lifecycle.js', import.meta.url).href;
const childScript = `
  import { watchDesktopLifetime } from ${JSON.stringify(lifecycle)};
  setInterval(() => {}, 1000);
  watchDesktopLifetime(() => { process.stdout.write('stopped\\n'); process.exit(0); });
  process.stdout.write('ready\\n');
`;
async function start(t, managed) {
  const child = spawn(process.execPath, ['--input-type=module', '-e', childScript], {
    env: { ...process.env, PZZA_MANAGED_AGENT: managed ? '1' : '0' }, stdio: ['pipe', 'pipe', 'pipe'],
  });
  t.after(() => child.kill('SIGKILL'));
  const exited = once(child, 'exit');
  await once(child.stdout, 'data');
  return { child, exited };
}
test('managed agent exits when its owning pipe closes', { timeout: 5000 }, async t => {
  const { child, exited } = await start(t, true);
  child.stdin.end();
  assert.deepEqual(await exited, [0, null]);
});
test('standalone agent is not tied to stdin', { timeout: 5000 }, async t => {
  const { child, exited } = await start(t, false);
  child.stdin.end();
  await new Promise(resolve => setTimeout(resolve, 100));
  assert.equal(child.exitCode, null);
  child.kill('SIGTERM');
  assert.equal((await exited)[1], 'SIGTERM');
});
test('managed agent exits after its parent is killed without cleanup', { timeout: 5000 }, async t => {
  const parentScript = `
    const { spawn } = require('node:child_process');
    const child = spawn(process.execPath, ['--input-type=module', '-e', ${JSON.stringify(childScript)}], {
      env: { ...process.env, PZZA_MANAGED_AGENT: '1' }, stdio: ['pipe', 'inherit', 'inherit']
    });
    process.stdout.write('pid:' + child.pid + '\\n');
    setInterval(() => {}, 1000);
  `;
  const parent = spawn(process.execPath, ['-e', parentScript], { stdio: ['ignore', 'pipe', 'pipe'] });
  let childPid;
  t.after(() => { parent.kill('SIGKILL'); if (childPid) { try { process.kill(childPid, 'SIGKILL'); } catch {} } });
  let output = '';
  await new Promise(resolve => parent.stdout.on('data', chunk => {
    output += chunk;
    const match = output.match(/pid:(\d+)/);
    if (match) childPid = Number(match[1]);
    if (output.includes('ready')) resolve();
  }));
  const closed = once(parent.stdout, 'end');
  parent.kill('SIGKILL');
  await closed;
  assert.match(output, /stopped/);
  childPid = undefined;
});
