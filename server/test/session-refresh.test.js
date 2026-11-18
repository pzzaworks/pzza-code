import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

// The refresh module as the app bundles it, on an empty in-memory localStorage.
async function loadRefresh(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pzza-session-refresh-test-"));
  const globals = new Map(["navigator", "localStorage", "window", "document", "self"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await rm(dir, { recursive: true, force: true });
  });
  const storage = new Map();
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, "self", { configurable: true, value: globalThis });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "" } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key),
  } });
  const outfile = path.join(dir, "refresh.mjs");
  await build({ entryPoints: ["src/state/sessionRefresh.ts"], outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent", loader: { ".css": "empty", ".svg": "empty", ".png": "empty" } });
  return import(pathToFileURL(outfile).href);
}

const CONVERSATION = "0b5c2a8e-3f41-4d7a-9c1e-5a6b7c8d9e0f";
const claude = (session, launch, extra = {}) => ({ session, window: 0, active: true, panes: 1, command: "claude", effectiveProvider: null, launch: { mode: null, account: null, ...launch }, ...extra });

test("an agent resumes with the conversation it reported, and without one the native record decides", async (t) => {
  const { agentsToResume } = await loadRefresh(t);
  const [known, unknown] = agentsToResume([claude("one", { conversation: CONVERSATION }), claude("two", {})], []);
  assert.equal(known.session, "one");
  assert.equal(known.conversation, CONVERSATION);
  assert.match(known.command, /^claude /);
  assert.equal(unknown.session, "two");
  assert.equal("conversation" in unknown, false);
});

test("only shells and idle agents leave a session free to refresh", async (t) => {
  const { busySessions } = await loadRefresh(t);
  assert.deepEqual(busySessions([
    { session: "shell", window: 0, active: true, panes: 1, command: "zsh", effectiveProvider: null },
    { session: "login-shell", window: 0, active: true, panes: 1, command: "-zsh", effectiveProvider: null },
    claude("idle", { status: "idle", conversation: CONVERSATION }),
  ]), []);
  assert.deepEqual(busySessions([
    claude("working", { status: "busy" }),
    // No status reported: not known to be idle.
    claude("unknown", {}),
    { session: "server", window: 0, active: true, panes: 1, command: "node", effectiveProvider: null },
    // Only the active pane is read, so a split window is never assumed idle.
    { session: "split", window: 1, active: true, panes: 2, command: "zsh", effectiveProvider: null },
    claude("working", { status: "busy" }, { window: 2 }),
  ]), ["working", "unknown", "server", "split"]);
});
