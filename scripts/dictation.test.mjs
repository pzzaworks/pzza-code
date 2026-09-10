import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundle = await build({
  entryPoints: [new URL("../src/state/dictation.ts", import.meta.url).pathname],
  bundle: true, write: false, platform: "node", format: "esm", target: "es2022",
  plugins: [{ name: "dictation-boundaries", setup(builder) {
    builder.onResolve({ filter: /^(?:@tauri-apps\/api\/(?:core|event)|\.\.\/tauriEnv|\.\/notifications)$/ }, args => ({ path: args.path, namespace: "boundary" }));
    builder.onLoad({ filter: /.*/, namespace: "boundary" }, args => ({ contents:
      args.path.endsWith("/core") ? "export const invoke = (...args) => globalThis.dictationFixture.invoke(...args);" :
      args.path.endsWith("/event") ? "export const listen = (...args) => globalThis.dictationFixture.listen(...args);" :
      args.path.endsWith("tauriEnv") ? "export const HAS_TAURI = true;" : "export const notify = () => {};"
    }));
  } }],
});
let fixtureCount = 0;
const settle = () => new Promise(resolve => setImmediate(resolve));

async function fixture(t) {
  const listeners = new Map();
  const commands = [];
  const writes = [];
  const previews = [];
  let visible = "";
  let clears = 0;
  let insert = async text => { writes.push(text); return true; };
  const navigatorDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
  Object.defineProperty(globalThis, "navigator", { value: { platform: "MacIntel", userAgent: "Mac" }, configurable: true });
  globalThis.dictationFixture = {
    invoke: async (command, args) => {
      commands.push({ command, args });
      if (command === "speech_model_status") return { installed: true, downloading: false, downloadedBytes: 1, totalBytes: 1 };
    },
    listen: async (name, handler) => { listeners.set(name, handler); return () => listeners.delete(name); },
  };
  const source = `${bundle.outputFiles[0].text}\n// Isolate recording lifecycle ${++fixtureCount}.`;
  const module = await import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
  module.useDictation.setState({ enabled: true, model: "ready" });
  const unregister = module.registerDictationTarget("terminal", {
    insert: text => insert(text), focus: () => {},
    preview: text => { visible = text; previews.push(text); },
    clearPreview: () => { visible = ""; clears++; },
  });
  await module.useDictation.getState().start("terminal");
  const id = module.useDictation.getState().recording.id;
  const emit = (kind, text, eventId = id) => listeners.get("dictation")({ payload: { id: eventId, kind, text } });
  emit("listening");
  t.after(async () => {
    await module.useDictation.getState().cancel();
    unregister();
    if (navigatorDescriptor) Object.defineProperty(globalThis, "navigator", navigatorDescriptor);
    else delete globalThis.navigator;
    delete globalThis.dictationFixture;
  });
  return { ...module, emit, id, writes, commands, previews, unregister, visible: () => visible, clearCount: () => clears, setInsert: value => { insert = value; } };
}

test("partial words revise inline without entering the process and confirmed text is sent once", async t => {
  const f = await fixture(t);
  f.emit("partial", "Please right");
  assert.equal(f.visible(), "Please right");
  assert.deepEqual(f.writes, []);
  f.emit("partial", "Please write this");
  assert.equal(f.visible(), "Please write this");
  f.emit("committed", "Please write");
  await settle();
  assert.deepEqual(f.writes, ["Please write"]);
  assert.equal(f.visible(), " this");
  f.emit("committed", "Please write");
  await settle();
  assert.deepEqual(f.writes, ["Please write"]);
  f.emit("final", "Please write this");
  await settle();
  assert.deepEqual(f.writes, ["Please write", " this"]);
  assert.equal(f.visible(), "");
  assert.equal(f.useDictation.getState().recording, null);
});

test("an in-flight paste hides composition and reconciles the latest bilingual hypothesis afterward", async t => {
  const f = await fixture(t);
  let finish;
  f.setInsert(text => { f.writes.push(text); return new Promise(resolve => { finish = resolve; }); });
  f.emit("partial", "Bu dosyayı save");
  f.emit("committed", "Bu dosyayı");
  await settle();
  assert.equal(f.visible(), "");
  const clearCount = f.clearCount();
  f.emit("partial", "Bu dosyayı save the file");
  assert.equal(f.visible(), "");
  assert.equal(f.clearCount(), clearCount, "An in-flight partial must preserve the terminal echo barrier");
  finish(true);
  await settle();
  assert.equal(f.visible(), " save the file");
  assert.deepEqual(f.writes, ["Bu dosyayı"]);
});

test("cancel invalidates queued commits and stale partials immediately", async t => {
  const f = await fixture(t);
  f.emit("partial", "Do not enter this");
  f.emit("committed", "Do not");
  await f.useDictation.getState().cancel();
  f.emit("partial", "Stale words");
  await settle();
  assert.equal(f.visible(), "");
  assert.deepEqual(f.writes, []);
});

test("Stop removes preedit while final recognition still flushes to the terminal", async t => {
  const f = await fixture(t);
  f.emit("partial", "Keep listening");
  await f.useDictation.getState().stop();
  assert.equal(f.visible(), "");
  f.emit("partial", "Keep listening now");
  assert.equal(f.visible(), "");
  f.emit("final", "Keep listening now");
  await settle();
  assert.deepEqual(f.writes, ["Keep listening now"]);
  assert.equal(f.useDictation.getState().recording, null);
});

test("terminal failures clear preedit and cancel further recognition delivery", async t => {
  const f = await fixture(t);
  f.setInsert(async () => false);
  f.emit("partial", "Some words");
  f.emit("committed", "Some");
  await settle();
  assert.equal(f.visible(), "");
  assert.equal(f.useDictation.getState().recording.phase, "error");
  assert.ok(f.commands.some(entry => entry.command === "speech_stop" && entry.args.cancel === true));
  f.emit("partial", "Should stay hidden");
  assert.equal(f.visible(), "");
});

test("control input is stripped and an unmatched confirmed prefix never produces destructive edits", async t => {
  const f = await fixture(t);
  f.emit("partial", "hello\nworld\u0003");
  assert.equal(f.visible(), "hello world");
  f.emit("committed", "hello");
  await settle();
  f.emit("partial", "a revised beginning");
  assert.equal(f.visible(), "");
  assert.deepEqual(f.writes, ["hello"]);
  assert.equal(f.dictationPendingText("tekrar tekrar dene", "tekrar"), " tekrar dene");
  f.emit("error");
  assert.equal(f.visible(), "");
});

test("disposing the terminal clears composition and invalidates pending delivery", async t => {
  const f = await fixture(t);
  f.emit("partial", "Pending words");
  f.emit("committed", "Pending");
  f.unregister();
  await settle();
  assert.equal(f.visible(), "");
  assert.deepEqual(f.writes, []);
  assert.equal(f.useDictation.getState().recording, null);
});

test("completion of an old paste cannot replace a new recording's composition", async t => {
  const f = await fixture(t);
  let finish;
  f.setInsert(text => { f.writes.push(text); return new Promise(resolve => { finish = resolve; }); });
  f.emit("final", "Earlier recording");
  await settle();
  await f.useDictation.getState().cancel();
  await f.useDictation.getState().start("terminal");
  const nextId = f.useDictation.getState().recording.id;
  f.emit("listening", undefined, nextId);
  f.emit("partial", "Yeni kayıt", nextId);
  assert.equal(f.visible(), "Yeni kayıt");
  finish(true);
  await settle();
  assert.equal(f.visible(), "Yeni kayıt");
  assert.equal(f.useDictation.getState().recording.id, nextId);
  assert.equal(f.useDictation.getState().recording.committed, "");
});
