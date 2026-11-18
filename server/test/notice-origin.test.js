import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

// The notifications store as the app bundles it, on a seeded in-memory localStorage.
async function loadNotifications(t, seed) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pzza-notice-origin-test-"));
  const globals = new Map(["navigator", "localStorage", "window", "document", "self"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await rm(dir, { recursive: true, force: true });
  });
  const storage = new Map(seed ? [["pzza.notifications.v1", JSON.stringify(seed)]] : []);
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "document", { configurable: true, value: { hasFocus: () => true } });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "" } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key),
  } });
  const outfile = path.join(dir, "notifications.mjs");
  await build({ entryPoints: ["src/state/notifications.ts"], outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
}

test("a terminal notice keeps its session and device apart, cleaned of control characters", async (t) => {
  const { notify, useNotifications } = await loadNotifications(t);
  notify({ category: "terminal", title: "Claude is waiting", body: "Approve?", source: "api", device: { name: "Dev\u0007box", host: "devbox\n" } });
  const [notice] = useNotifications.getState().items;
  assert.equal(notice.source, "api");
  assert.deepEqual(notice.device, { name: "Devbox", host: "devbox" });
  notify({ category: "app", title: "Setup", body: "Done", source: "Setup" });
  assert.equal(useNotifications.getState().items[0].device, undefined);
});

test("saved notices keep a well-formed device and drop any other", async (t) => {
  const now = Date.now();
  const row = (id, device) => ({ id, category: "terminal", title: "t", body: "b", createdAt: now - 1000, read: false, source: "api", device });
  const { useNotifications } = await loadNotifications(t, { items: [
    row("good", { name: "This device", host: "" }),
    row("nameless", { name: "", host: "devbox" }),
    row("wrong", "This device"),
    row("legacy", undefined),
  ] });
  const byId = Object.fromEntries(useNotifications.getState().items.map((item) => [item.id, item.device]));
  assert.deepEqual(byId, { good: { name: "This device", host: "" }, nameless: undefined, wrong: undefined, legacy: undefined });
});

test("terminal notices saved as \"session (device)\" get their device back, other sources stay as they were", async (t) => {
  const now = Date.now();
  const row = (id, category, source) => ({ id, category, title: "t", body: "b", createdAt: now - 1000, read: false, source });
  const { useNotifications } = await loadNotifications(t, { items: [
    row("mac", "terminal", "api (This Device)"),
    row("remote", "terminal", "web (devbox)"),
    row("app", "app", "Open with PzzaCode (beta)"),
    row("plain", "terminal", "api"),
  ] });
  const byId = Object.fromEntries(useNotifications.getState().items.map((item) => [item.id, { source: item.source, device: item.device }]));
  assert.deepEqual(byId, {
    mac: { source: "api", device: { name: "This Device", host: "" } },
    remote: { source: "web", device: { name: "devbox", host: "devbox" } },
    app: { source: "Open with PzzaCode (beta)", device: undefined },
    plain: { source: "api", device: undefined },
  });
});
