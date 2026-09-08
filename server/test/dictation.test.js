import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

test("dictation opt-in, native events, pinned insertion and cancellation", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pzza-dictation-test-"));
  const globals = new Map(["navigator", "localStorage", "window", "__dictationTest"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await rm(dir, { recursive: true, force: true });
  });
  const storage = new Map();
  const window = new EventTarget();
  const notifications = [];
  window.addEventListener("pzza-notification", event => notifications.push(event.detail));
  Object.defineProperty(globalThis, "window", { configurable: true, value: window });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "" } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) } });
  const listeners = new Map();
  const calls = [];
  let disconnected = false;
  globalThis.__dictationTest = {
    listen: async (event, callback) => { listeners.set(event, callback); return () => listeners.delete(event); },
    invoke: async (command, args) => {
      calls.push({ command, args });
      if (command === "speech_model_status") return { installed: false, downloading: false, downloadedBytes: 0, totalBytes: 100 };
      if (command === "speech_start" && disconnected) throw new Error("Microphone access denied");
    },
  };
  const outfile = path.join(dir, "dictation.mjs");
  await build({ entryPoints: ["src/state/dictation.ts"], outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent", plugins: [{ name: "native-test-boundary", setup(builder) {
    builder.onResolve({ filter: /^(?:@tauri-apps\/api\/(?:core|event)|\.\.\/tauriEnv)$/ }, (args) => ({ path: args.path, namespace: "native-test" }));
    builder.onLoad({ filter: /.*/, namespace: "native-test" }, () => ({ contents: "export const HAS_TAURI = true; export const invoke = (...args) => globalThis.__dictationTest.invoke(...args); export const listen = (...args) => globalThis.__dictationTest.listen(...args);", loader: "js" }));
  } }] });
  const { useDictation, initializeDictation, registerDictationTarget, dictationText } = await import(pathToFileURL(outfile).href);
  const emit = (event, payload) => listeners.get(event)({ payload });
  assert.equal(useDictation.getState().enabled, false);
  await initializeDictation();
  assert.deepEqual(calls.map((call) => call.command), ["speech_model_status"]);
  assert.equal(useDictation.getState().model, "missing");
  await useDictation.getState().download();
  assert.equal(useDictation.getState().model, "downloading", "invoke acceptance must not mark download complete");
  await useDictation.getState().download();
  assert.equal(calls.filter((call) => call.command === "speech_model_download").length, 1);
  emit("dictation-download", { status: "downloading", downloadedBytes: 50, totalBytes: 100 });
  assert.equal(useDictation.getState().downloadedBytes, 50);
  emit("dictation-download", { status: "ready", downloadedBytes: 100, totalBytes: 100 });
  assert.equal(notifications.length, 1);
  assert.equal(notifications[0].event, "model-ready");
  assert.equal(useDictation.getState().model, "ready");
  assert.equal(storage.get("pzza.dictation.enabled"), "true");
  const inserted = [];
  const unregister = registerDictationTarget("first", (text) => { inserted.push(text); return true; });
  registerDictationTarget("second", () => { assert.fail("Transcript reached wrong terminal"); });
  await useDictation.getState().start("first");
  const id = useDictation.getState().recording.id;
  emit("dictation", { id, kind: "listening" });
  emit("dictation", { id, kind: "partial", text: "Merhaba world" });
  assert.deepEqual(inserted, [], "partials must never be sent to terminal");
  await useDictation.getState().start("second");
  assert.equal(useDictation.getState().recording.id, id);
  await useDictation.getState().stop();
  assert.equal(useDictation.getState().recording.phase, "finalizing");
  emit("dictation", { id, kind: "final", text: "Merhaba\nworld\r\u0003\u001b" });
  emit("dictation", { id, kind: "final", text: "duplicate event" });
  assert.deepEqual(inserted, ["Merhaba world"]);
  assert.equal(dictationText("Türkçe\u2028English\ttext\u009b"), "Türkçe English text");
  await useDictation.getState().start("first");
  const cancelled = useDictation.getState().recording.id;
  await useDictation.getState().cancel();
  emit("dictation", { id: cancelled, kind: "final", text: "late result" });
  assert.deepEqual(inserted, ["Merhaba world"]);
  await useDictation.getState().start("first");
  unregister();
  assert.equal(useDictation.getState().recording, null, "closing target cancels recording");
  disconnected = true;
  registerDictationTarget("first", () => true);
  await useDictation.getState().start("first");
  assert.match(useDictation.getState().recording.error, /Microphone access denied/);
  useDictation.getState().setEnabled(false);
  assert.equal(useDictation.getState().recording, null);
  assert.equal(storage.get("pzza.dictation.enabled"), "false");
});
