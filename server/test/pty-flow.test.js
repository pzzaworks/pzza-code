import assert from "node:assert/strict";
import test from "node:test";
import { createPtyOutputFlow } from "../lib/pty.js";

function setup() {
  const sent = [];
  const closed = [];
  let pauses = 0;
  let resumes = 0;
  const ws = { OPEN: 1, readyState: 1, send(bytes, done) { sent.push(bytes); done(); }, close(...args) { closed.push(args); this.readyState = 2; } };
  const term = { pause() { pauses++; }, resume() { resumes++; } };
  return { flow: createPtyOutputFlow(ws, term), sent, closed, get pauses() { return pauses; }, get resumes() { return resumes; } };
}

test("output credits pause PTY until parser consumption reaches low watermark", () => {
  const state = setup();
  for (let i = 0; i < 4; i++) state.flow.data("x".repeat(65536));
  assert.equal(state.pauses, 1);
  state.flow.acknowledge(65536);
  assert.equal(state.resumes, 0);
  state.flow.acknowledge(65536);
  assert.equal(state.resumes, 1);
  assert.equal(state.sent.reduce((n, b) => n + b.length, 0), 262144);
  state.flow.dispose();
});

test("final output must be consumed before normal close, using UTF-8 byte counts", () => {
  const state = setup();
  state.flow.data("你好");
  state.flow.exit();
  assert.equal(state.closed.length, 0);
  state.flow.acknowledge(6);
  assert.deepEqual(state.closed, [[]]);
  assert.equal(state.resumes, 0);
  state.flow.dispose();
});

test("invalid credits cannot grow the output allowance", () => {
  for (const value of [0, -1, 1.5, 100, "1"]) {
    const state = setup();
    state.flow.data("abc");
    state.flow.acknowledge(value);
    assert.equal(state.closed[0][0], 1008);
    state.flow.dispose();
  }
});

test("unexpected oversized PTY read closes with an explicit flow error", () => {
  const state = setup();
  state.flow.data("x".repeat(2 * 1024 * 1024));
  assert.equal(state.sent.length, 0);
  assert.equal(state.closed[0][0], 1011);
  state.flow.dispose();
});

test("browser sends credits only after parser callback and bounds pending input", async (t) => {
  const { build } = await import("esbuild");
  const { mkdtemp, rm } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { pathToFileURL } = await import("node:url");
  const dir = await mkdtemp(join(tmpdir(), "pzza-ws-flow-"));
  const previous = Object.getOwnPropertyDescriptor(globalThis, "WebSocket");
  const sockets = [];
  class Socket {
    static OPEN = 1;
    readyState = 0;
    bufferedAmount = 0;
    sent = [];
    constructor() { sockets.push(this); }
    send(message) { this.sent.push(JSON.parse(message)); }
    close() { this.readyState = 3; }
  }
  Object.defineProperty(globalThis, "WebSocket", { configurable: true, value: Socket });
  t.after(async () => {
    if (previous) Object.defineProperty(globalThis, "WebSocket", previous);
    else delete globalThis.WebSocket;
    await rm(dir, { recursive: true, force: true });
  });
  const outfile = join(dir, "ws.mjs");
  await build({ entryPoints: ["src/terminal/wsPty.ts"], outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent", plugins: [{ name: "local-socket-test", setup(builder) {
    builder.onResolve({ filter: /serverApi$/ }, () => ({ path: "api", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: 'export const wsUrl = () => "ws://127.0.0.1/pty";' }));
  } }] });
  const { openWsPty } = await import(pathToFileURL(outfile).href);
  let consume;
  const errors = [];
  const handle = openWsPty("test", 80, 24, undefined, (_bytes, done) => { consume = done; }, (message) => errors.push(message));
  const socket = sockets[0];
  socket.readyState = 1;
  socket.onopen();
  socket.onmessage({ data: new Uint8Array([1, 2, 3]).buffer });
  assert.equal(socket.sent.length, 1);
  consume();
  consume();
  assert.deepEqual(socket.sent[1], { type: "ack", bytes: 3 });
  assert.equal(socket.sent.length, 2);
  socket.bufferedAmount = 1024 * 1024;
  handle.write("more");
  assert.equal(errors.length, 1);
  assert.equal(socket.readyState, 3);
  handle.close();
});
