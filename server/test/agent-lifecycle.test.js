import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import { createServerShutdown } from '../lib/agent-lifecycle.js';
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

async function startServer(t, handler, options) {
  const server = http.createServer(handler);
  const sockets = new Set();
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  let exits = 0;
  let complete;
  const exited = new Promise(resolve => { complete = resolve; });
  const shutdown = createServerShutdown(server, () => { exits++; complete(); }, options);
  t.after(() => { for (const socket of sockets) socket.destroy(); server.close(); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, shutdown, exited, exits: () => exits, port: server.address().port };
}

test('shutdown disconnects a long poll without waiting for the grace period', { timeout: 5000 }, async t => {
  let received;
  const ready = new Promise(resolve => { received = resolve; });
  const fixture = await startServer(t, (req, res) => {
    res.writeHead(200);
    res.flushHeaders();
    received();
  });
  const client = net.connect(fixture.port, '127.0.0.1');
  t.after(() => client.destroy());
  client.resume();
  client.write('GET /poll HTTP/1.1\r\nHost: localhost\r\n\r\n');
  await ready;
  const closed = once(client, 'close');
  const start = performance.now();
  fixture.shutdown.stop();
  await Promise.all([fixture.exited, closed]);
  assert.ok(performance.now() - start < 500, 'A background read delayed shutdown');
  assert.equal(fixture.exits(), 1);
});

test('shutdown disconnects an upgraded terminal transport promptly', { timeout: 5000 }, async t => {
  const fixture = await startServer(t, () => {});
  let connected;
  const ready = new Promise(resolve => { connected = resolve; });
  fixture.server.on('upgrade', (req, socket) => {
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: terminal\r\n\r\n');
    connected();
  });
  const client = net.connect(fixture.port, '127.0.0.1');
  t.after(() => client.destroy());
  client.resume();
  client.write('GET /pty HTTP/1.1\r\nHost: localhost\r\nConnection: Upgrade\r\nUpgrade: terminal\r\n\r\n');
  await ready;
  const closed = once(client, 'close');
  const start = performance.now();
  fixture.shutdown.stop();
  await Promise.all([fixture.exited, closed]);
  assert.ok(performance.now() - start < 500, 'An upgraded connection delayed shutdown');
});

test('shutdown allows an in-flight write and its response to finish', { timeout: 5000 }, async t => {
  let received;
  const ready = new Promise(resolve => { received = resolve; });
  const fixture = await startServer(t, async (req, res) => {
    const body = [];
    for await (const chunk of req) body.push(chunk);
    assert.equal(Buffer.concat(body).toString(), 'save this');
    received(res);
  });
  const request = http.request({ host: '127.0.0.1', port: fixture.port, method: 'POST', path: '/save' });
  t.after(() => request.destroy());
  const response = once(request, 'response').then(async ([res]) => {
    const body = [];
    for await (const chunk of res) body.push(chunk);
    return Buffer.concat(body).toString();
  });
  request.end('save this');
  const pending = await ready;
  fixture.shutdown.stop();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.exits(), 0, 'Shutdown interrupted the active save');
  pending.end('saved');
  assert.equal(await response, 'saved');
  await fixture.exited;
  assert.equal(fixture.exits(), 1);
});

test('an unresponsive write has a bounded shutdown and repeated stop exits once', { timeout: 5000 }, async t => {
  let received;
  const ready = new Promise(resolve => { received = resolve; });
  const fixture = await startServer(t, req => { req.resume(); received(); }, { graceMs: 50 });
  const client = net.connect(fixture.port, '127.0.0.1');
  t.after(() => client.destroy());
  client.resume();
  client.write('POST /save HTTP/1.1\r\nHost: localhost\r\nContent-Length: 0\r\n\r\n');
  await ready;
  const start = performance.now();
  fixture.shutdown.stop();
  fixture.shutdown.stop();
  await fixture.exited;
  assert.ok(performance.now() - start < 500);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(fixture.exits(), 1);
});
