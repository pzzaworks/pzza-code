import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const storage = new Map();
globalThis.localStorage = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
let focused = false;
globalThis.document = { hasFocus: () => focused };
globalThis.window = { __TAURI_INTERNALS__: {}, focus() {} };
const native = { granted: true, checks: 0, requests: 0, deliveries: [] };
globalThis.notificationTestNative = native;
const result = await build({
  stdin: { contents: 'export * from "./src/state/notifications"; export * from "./src/desktopNotifications"; export * from "./src/terminal/notificationSignals";', resolveDir: process.cwd() },
  bundle: true, write: false, platform: "node", format: "esm",
  plugins: [{ name: "notification-transport", setup(builder) {
    builder.onResolve({ filter: /^@tauri-apps\/plugin-notification$/ }, () => ({ path: "native", namespace: "test" }));
    builder.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: `
      export async function isPermissionGranted() { globalThis.notificationTestNative.checks++; return globalThis.notificationTestNative.granted; }
      export async function requestPermission() { globalThis.notificationTestNative.requests++; return globalThis.notificationTestNative.granted ? "granted" : "denied"; }
      export function sendNotification(options) { globalThis.notificationTestNative.deliveries.push(options); }
    ` }));
  } }],
});
const { useNotifications, notify, requestDesktopAlerts, NOTIFICATION_EVENTS, NOTIFICATION_EVENT_CATEGORIES, createTerminalSignals } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const initialPreferences = structuredClone(useNotifications.getState().preferences);
const reset = () => {
  useNotifications.setState({ items: [], preferences: structuredClone(initialPreferences) });
  native.granted = true; native.checks = 0; native.requests = 0; native.deliveries = []; focused = false;
};
const notice = { category: "terminal", event: "terminal-command", title: "Private project", body: "/private/project/file", target: { tileId: "session" } };
const settle = () => new Promise(resolve => setImmediate(resolve));

test("startup never requests OS notification permission", () => { assert.equal(native.requests, 0); });
test("master, category and individual-event settings filter actual emission", () => {
  for (const patch of [{ enabled: false }, { categories: { ...initialPreferences.categories, terminal: false } }, { events: { "terminal-command": false } }]) {
    reset(); useNotifications.getState().configure(patch); notify(notice); assert.equal(useNotifications.getState().items.length, 0);
  }
  reset(); notify(notice); assert.equal(useNotifications.getState().items.length, 1);
});
test("reading only changes unread state and preserves navigation target", () => {
  reset(); notify(notice);
  const item = useNotifications.getState().items[0];
  useNotifications.getState().read(item.id);
  assert.deepEqual(useNotifications.getState().items[0], { ...item, read: true });
  assert.equal(JSON.parse(storage.get("pzza.notifications.v1")).items[0].read, true);
});
test("muting preserves history and suppresses OS alerts; resume delivers private text", async () => {
  reset(); useNotifications.getState().configure({ desktop: true, mutedUntil: Date.now() + 60_000 });
  notify(notice); await settle();
  assert.equal(useNotifications.getState().items.length, 1); assert.equal(native.deliveries.length, 0);
  useNotifications.getState().configure({ mutedUntil: 0 }); notify(notice); await settle();
  assert.equal(native.deliveries.length, 1);
  assert.equal(native.deliveries[0].title, "Private project");
  assert.equal(native.deliveries[0].body, "/private/project/file");
  assert.equal(native.requests, 0);
});
test("focused windows, revoked permission and async disable suppress OS delivery", async () => {
  reset(); useNotifications.getState().configure({ desktop: true }); focused = true; notify(notice); await settle(); assert.equal(native.deliveries.length, 0);
  focused = false; native.granted = false; notify(notice); await settle(); assert.equal(native.deliveries.length, 0); assert.equal(native.requests, 0);
  native.granted = true; notify(notice); useNotifications.getState().configure({ desktop: false }); await settle(); assert.equal(native.deliveries.length, 0);
});
test("only explicit enable requests permission, and denied permission stays denied", async () => {
  reset(); native.granted = false;
  assert.equal(await requestDesktopAlerts(), false); assert.equal(native.requests, 1);
  native.granted = true; assert.equal(await requestDesktopAlerts(), true); assert.equal(native.requests, 1);
});
test("dedupe, retention, read all, dismissal and clear preserve expected history", () => {
  reset();
  useNotifications.setState({ items: [{ ...notice, id: "old", read: false, createdAt: Date.now() - 31 * 86400000 }] });
  notify({ ...notice, dedupeKey: "same" }); notify({ ...notice, dedupeKey: "same" });
  assert.equal(useNotifications.getState().items.length, 1);
  for (let index = 0; index < 305; index++) notify(notice);
  assert.equal(useNotifications.getState().items.length, 300);
  useNotifications.getState().read(); assert.ok(useNotifications.getState().items.every(item => item.read));
  useNotifications.getState().remove(useNotifications.getState().items[0].id); assert.equal(useNotifications.getState().items.length, 299);
  useNotifications.getState().clear(); assert.equal(useNotifications.getState().items.length, 0);
});
test("all configurable events have categories and terminal signals obey event switches", () => {
  assert.deepEqual(Object.keys(NOTIFICATION_EVENT_CATEGORIES).sort(), Object.keys(NOTIFICATION_EVENTS).sort());
  reset(); useNotifications.getState().configure({ events: { "terminal-bell": false } });
  const signals = createTerminalSignals("session", notify, { attachment: true, now: () => 20_000 });
  signals.bell(); assert.equal(useNotifications.getState().items.length, 0);
  signals.osc133("D;0"); assert.equal(useNotifications.getState().items.length, 0);
  signals.osc133("C"); signals.osc133("D;0"); assert.equal(useNotifications.getState().items[0].event, "terminal-command");
  signals.processExit(0); assert.equal(useNotifications.getState().items.length, 1);
});
test("browser delivery keeps permission prompts explicit and uses private text", async () => {
  const browserResult = await build({ entryPoints: ["src/desktopNotifications.ts"], bundle: true, write: false, platform: "node", format: "esm", plugins: [{ name: "browser-runtime", setup(builder) {
    builder.onResolve({ filter: /tauriEnv$/ }, () => ({ path: "runtime", namespace: "browser" }));
    builder.onLoad({ filter: /.*/, namespace: "browser" }, () => ({ contents: "export const HAS_TAURI = false;" }));
  } }] });
  const browser = await import(`data:text/javascript;base64,${Buffer.from(browserResult.outputFiles[0].text).toString("base64")}`);
  let requests = 0;
  const delivered = [];
  globalThis.Notification = class {
    static permission = "default";
    static async requestPermission() { requests++; this.permission = "granted"; return "granted"; }
    constructor(title, options) { delivered.push({ title, ...options }); }
  };
  await browser.deliverDesktopAlert({ category: "app", title: "Private project", body: "/private/project/file" }, () => true); assert.equal(requests, 0); assert.equal(delivered.length, 0);
  assert.equal(await browser.requestDesktopAlerts(), true); assert.equal(requests, 1);
  await browser.deliverDesktopAlert({ category: "app", title: "Private project", body: "/private/project/file" }, () => true); assert.equal(delivered.length, 1);
  assert.equal(delivered[0].title, "Private project");
  assert.equal(delivered[0].body, "/private/project/file");
  await browser.deliverDesktopAlert({ category: "app", title: "Private project", body: "/private/project/file" }, () => false); assert.equal(delivered.length, 1);
});
