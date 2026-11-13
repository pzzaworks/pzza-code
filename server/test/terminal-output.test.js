import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ entryPoints: ["src/terminal/outputScheduler.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { createOutputScheduler } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("output waits for parser completion, preserves bytes and returns each credit once", () => {
  const writes = [];
  let consumed = 0;
  const scheduler = createOutputScheduler({ delay: () => 0, write: (bytes, done) => writes.push({ bytes, done }) });
  scheduler.push(new Uint8Array([0xe2]), () => consumed++);
  scheduler.push(new Uint8Array([0x82, 0xac]), () => consumed++);
  scheduler.push(new Uint8Array([27, 91, 48, 109]), () => consumed++);
  assert.equal(writes.length, 1);
  assert.equal(consumed, 0);
  writes[0].done();
  assert.equal(consumed, 1);
  assert.equal(writes.length, 2);
  assert.deepEqual([...writes[1].bytes], [0x82, 0xac, 27, 91, 48, 109]);
  writes[1].done();
  writes[1].done();
  assert.equal(consumed, 3);
  scheduler.dispose();
});

test("hidden output batches until flush; disposal prevents late writes and credit", () => {
  const writes = [];
  let consumed = 0;
  const scheduler = createOutputScheduler({ delay: () => 250, write: (bytes, done) => writes.push({ bytes, done }) });
  scheduler.push(new Uint8Array([1]), () => consumed++);
  scheduler.push(new Uint8Array([2]), () => consumed++);
  assert.equal(writes.length, 0);
  scheduler.flush();
  assert.deepEqual([...writes[0].bytes], [1, 2]);
  scheduler.dispose();
  writes[0].done();
  scheduler.push(new Uint8Array([3]), () => consumed++);
  scheduler.flush();
  assert.equal(writes.length, 1);
  assert.equal(consumed, 0);
});

test("a full credit window respects the hidden cadence until flushed", () => {
  let written = 0;
  const scheduler = createOutputScheduler({ delay: () => 250, write: bytes => { written += bytes.length; } });
  scheduler.push(new Uint8Array(256 * 1024), () => {});
  assert.equal(written, 0);
  scheduler.flush();
  assert.equal(written, 256 * 1024);
  scheduler.dispose();
});

test("native bridge acknowledges parsed bytes and serializes UTF-8 input per terminal", async () => {
  const calls = [];
  let finishSpawn;
  let finishWrite;
  const previous = globalThis.__ptyAudit;
  globalThis.__ptyAudit = { invoke(command, args) {
    calls.push({ command, args });
    if (command === "pty_spawn") return new Promise(resolve => { finishSpawn = resolve; });
    if (command === "pty_write" && !finishWrite) return new Promise(resolve => { finishWrite = resolve; });
    return Promise.resolve();
  } };
  try {
    const compiled = await build({ entryPoints: ["src/terminal/ptyBridge.ts"], bundle: true, write: false, format: "esm", platform: "node", plugins: [{ name: "native-test", setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "native", namespace: "test" }));
      b.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class Channel {} export const invoke = (command,args) => globalThis.__ptyAudit.invoke(command,args);" }));
    } }] });
    const bridge = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
    let parsed;
    const spawning = bridge.spawnPty({ cmd: "test", args: [], cols: 80, rows: 24 }, (_bytes, done) => { parsed = done; }, () => {});
    calls[0].args.onData.onmessage(new Uint8Array([1, 2, 3]).buffer);
    assert.equal(calls.length, 1);
    parsed(); parsed();
    assert.equal(calls.length, 1);
    finishSpawn(7);
    await spawning;
    assert.deepEqual(calls[1], { command: "pty_ack", args: { id: 7, bytes: 3 } });
    const text = "a".repeat(65535) + "🍕" + "z";
    const first = bridge.writePty(7, text);
    const second = bridge.writePty(7, "next");
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(calls.filter(c => c.command === "pty_write").length, 1);
    finishWrite();
    await Promise.all([first, second]);
    const writes = calls.filter(c => c.command === "pty_write").map(c => c.args.data);
    assert.equal(writes.join(""), text + "next");
    assert.equal(writes[0].length, 65535);
    await assert.rejects(bridge.writePty(7, "x".repeat(4 * 1024 * 1024 + 1)), /backed up/);
  } finally {
    if (previous === undefined) delete globalThis.__ptyAudit;
    else globalThis.__ptyAudit = previous;
  }
});

test("a lone chunk is written without a copy", () => {
  const writes = [];
  const scheduler = createOutputScheduler({ delay: () => 0, write: (bytes, done) => writes.push({ bytes, done }) });
  const chunk = new Uint8Array([1, 2, 3]);
  scheduler.push(chunk, () => {});
  assert.equal(writes[0].bytes, chunk);
  scheduler.dispose();
});

test("streaming output returns its credit cumulatively", async () => {
  const calls = [];
  const previous = globalThis.__ptyAudit;
  globalThis.__ptyAudit = { invoke(command, args) {
    calls.push({ command, args });
    return Promise.resolve(command === "pty_spawn" ? 9 : undefined);
  } };
  try {
    const compiled = await build({ entryPoints: ["src/terminal/ptyBridge.ts"], bundle: true, write: false, format: "esm", platform: "node", plugins: [{ name: "native-test", setup(b) {
      b.onResolve({ filter: /^@tauri-apps\/api\/core$/ }, () => ({ path: "native", namespace: "test" }));
      b.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export class Channel {} export const invoke = (command,args) => globalThis.__ptyAudit.invoke(command,args);" }));
    } }] });
    const bridge = await import(`data:text/javascript;base64,${Buffer.from(compiled.outputFiles[0].text).toString("base64")}`);
    // The parser finishes one write per frame while a streaming agent sends
    // about four chunks per frame (250 chunks in a second).
    const parsing = [];
    const scheduler = createOutputScheduler({ delay: () => 0, write: (_bytes, done) => parsing.push(done) });
    await bridge.spawnPty({ cmd: "test", args: [], cols: 80, rows: 24 }, scheduler.push, () => {});
    const channel = calls[0].args.onData;
    for (let index = 0; index < 250; index++) {
      channel.onmessage(new Uint8Array(100).buffer);
      if (index % 4 === 3) parsing.shift()();
      await Promise.resolve();
    }
    while (parsing.length) { parsing.shift()(); await Promise.resolve(); }
    // Credit below the bulk threshold is returned by a short timer, so the
    // tail of a stream is always acknowledged.
    await new Promise((resolve) => setTimeout(resolve, 100));
    const acks = calls.filter((call) => call.command === "pty_ack");
    assert.equal(acks.reduce((sum, call) => sum + call.args.bytes, 0), 250 * 100);
    assert.ok(acks.every((call) => call.args.id === 9));
    // Cumulative instead of one per chunk or per parsed write.
    assert.ok(acks.length <= 2, `${acks.length} acknowledgements`);
    // Bulk output returns its credit as soon as 64 KiB have been parsed,
    // without waiting for the timer.
    calls.length = 0;
    for (let index = 0; index < 2; index++) {
      channel.onmessage(new Uint8Array(32 * 1024).buffer);
      parsing.shift()();
    }
    assert.deepEqual(calls.map((call) => call.args.bytes), [64 * 1024]);
    scheduler.dispose();
  } finally {
    if (previous === undefined) delete globalThis.__ptyAudit;
    else globalThis.__ptyAudit = previous;
  }
});
