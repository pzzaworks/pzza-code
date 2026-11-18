import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { pathToFileURL } from "node:url";
import test from "node:test";
import { build } from "esbuild";

// The store as the app runs it, on an in-memory localStorage seeded with a
// session that has a window tile, an editor, a span, a hidden window, a stale
// display title and leftovers of a closed tile under the name it is renamed to.
async function loadStore(t, seed) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pzza-session-rename-test-"));
  const globals = new Map(["navigator", "localStorage", "window", "document"].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]));
  t.after(async () => {
    for (const [key, descriptor] of globals) {
      if (descriptor) Object.defineProperty(globalThis, key, descriptor);
      else delete globalThis[key];
    }
    await rm(dir, { recursive: true, force: true });
  });
  const storage = new Map(Object.entries(seed).map(([key, value]) => [key, JSON.stringify(value)]));
  Object.defineProperty(globalThis, "window", { configurable: true, value: new EventTarget() });
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { platform: "MacIntel", userAgent: "" } });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
    getItem: (key) => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value), removeItem: (key) => storage.delete(key),
  } });
  const outfile = path.join(dir, "store.mjs");
  await build({ entryPoints: ["src/state/store.ts"], outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  const { useStore, tileFolder } = await import(pathToFileURL(outfile).href);
  return { useStore, tileFolder, saved: (key) => JSON.parse(storage.get(key) ?? "null") };
}

const seed = {
  "pzza.workspaces": [{ id: "ws-a", name: "A" }, { id: "ws-b", name: "B" }, { id: "ws-stale", name: "Stale" }],
  "pzza.tiles": [
    { id: "work", name: "work", cwd: "/tmp" },
    { id: "work::w::1", name: "work · logs", session: "work", window: 1, windowId: "@4", windowSessionCreatedAt: 1700000000000 },
    { id: "box::work", name: "work", session: "work", host: "box" },
    { id: "other", name: "other" },
  ],
  "pzza.sessionWs": { work: "ws-a", "box::work": "ws-b", api: "ws-stale" },
  "pzza.hidden": ["work::w::1", "api"],
  "pzza.tileSpans": { "ws-a": { work: { c: 2, r: 1 }, api: { c: 3, r: 3 } }, __all__: { "work::w::1": { c: 1, r: 2 } } },
  "pzza.tileTitles": { work: "Old label", "box::work": "Remote label", api: "Leftover title" },
  "pzza.tileCode": { work: { open: true, layout: "side-by-side", root: "/tmp" }, "api::w::1": { open: true, layout: "full", root: "/old" } },
};

test("a renamed session moves every tile and per-tile state to the new name, and nothing old is inherited", async (t) => {
  const { useStore, saved } = await loadStore(t, seed);
  useStore.getState().setActive("work::w::1");
  const moved = useStore.getState().renameSessionTiles("", "work", "api");
  assert.deepEqual(moved, { work: "api", "work::w::1": "api::w::1" });

  const state = useStore.getState();
  assert.deepEqual(state.tiles.map((tile) => tile.id), ["api", "api::w::1", "box::work", "other"], "order is kept");
  assert.deepEqual(state.tiles[0], { id: "api", name: "api", cwd: "/tmp" });
  assert.deepEqual(state.tiles[1], { id: "api::w::1", name: "api · logs", session: "api", window: 1, windowId: "@4", windowSessionCreatedAt: 1700000000000 });
  // The same name on another device is a different session and stays as it was.
  assert.deepEqual(state.tiles[2], { id: "box::work", name: "work", session: "work", host: "box" });
  assert.equal(state.activeId, "api::w::1");

  // The real name shows: the old label and the closed tile's leftover title are gone.
  assert.deepEqual(state.tileTitles, { "box::work": "Remote label" });
  assert.deepEqual(state.sessionWs, { api: "ws-a", "box::work": "ws-b" });
  assert.deepEqual(state.hiddenTiles, ["api::w::1"]);
  assert.deepEqual(state.tileSpan, { "ws-a": { api: { c: 2, r: 1 } }, __all__: { "api::w::1": { c: 1, r: 2 } } }, "sizes move in every workspace");
  assert.deepEqual(state.tileCode, { api: { open: true, layout: "side-by-side", root: "/tmp" } });
  // Everything is persisted under the new ids.
  assert.deepEqual(saved("pzza.tiles").map((tile) => tile.id), ["api", "api::w::1", "box::work", "other"]);
  assert.deepEqual(saved("pzza.tileTitles"), state.tileTitles);
  assert.deepEqual(saved("pzza.sessionWs"), state.sessionWs);
  assert.deepEqual(saved("pzza.hidden"), state.hiddenTiles);
  assert.deepEqual(saved("pzza.tileSpans"), state.tileSpan);
  assert.deepEqual(saved("pzza.tileCode"), state.tileCode);

  // Renaming from a window tile renames the whole session, the remote one only on its device.
  assert.deepEqual(useStore.getState().renameSessionTiles("", "api", "Devbox - api"), { api: "Devbox - api", "api::w::1": "Devbox - api::w::1" });
  // A name the grid would shorten keeps showing exactly as typed.
  assert.equal(useStore.getState().tileTitles["Devbox - api"], "Devbox - api");
  assert.equal(useStore.getState().tiles[1].name, "api · logs");
  assert.deepEqual(useStore.getState().renameSessionTiles("box", "work", "remote api"), { "box::work": "box::remote api" });
  assert.deepEqual(useStore.getState().tiles[2], { id: "box::remote api", name: "remote api", session: "remote api", host: "box" });
  assert.deepEqual(useStore.getState().sessionWs, { "Devbox - api": "ws-a", "box::remote api": "ws-b" });
  assert.equal(useStore.getState().tileTitles["box::remote api"], undefined);
  assert.deepEqual(useStore.getState().renameSessionTiles("", "missing", "x"), {});
});

test("a tile still open under the new name gives way, and a renamed window keeps its id", async (t) => {
  const { useStore } = await loadStore(t, { ...seed, "pzza.tiles": [...seed["pzza.tiles"], { id: "api", name: "api" }] });
  assert.deepEqual(useStore.getState().renameSessionTiles("", "work", "api"), { work: "api", "work::w::1": "api::w::1" });
  assert.deepEqual(useStore.getState().tiles.map((tile) => tile.id), ["api", "api::w::1", "box::work", "other"]);
  assert.equal(useStore.getState().tiles[0].cwd, "/tmp", "the renamed tile, not the stale one");

  useStore.getState().renameTile("api::w::1", "custom");
  useStore.getState().renameWindowTile("api::w::1", "server");
  assert.equal(useStore.getState().tiles[1].id, "api::w::1");
  assert.equal(useStore.getState().tiles[1].name, "api · server");
  assert.equal(useStore.getState().tileTitles["api::w::1"], undefined);
});

test("a new session forgets what a closed tile of the same name left behind, never an open tile's state", async (t) => {
  const { useStore } = await loadStore(t, seed);
  useStore.getState().forgetTileState(["api", "work"]);
  const state = useStore.getState();
  assert.equal(state.tileTitles.api, undefined);
  assert.equal(state.tileSpan["ws-a"].api, undefined);
  assert.ok(!state.hiddenTiles.includes("api"));
  assert.equal(state.tileTitles.work, "Old label", "an open tile keeps its own state");
  assert.deepEqual(state.tileSpan["ws-a"].work, { c: 2, r: 1 });
});

test("session names reserved for the app's own sessions are refused", async () => {
  const { normalizeSessionName } = await import("../lib/session-name.js");
  for (const name of ["pzza-v-1", "pzza-v-anything", "pzza-quick-chat", " pzza-quick-chat "]) {
    assert.throws(() => normalizeSessionName(name), /reserved/, name);
  }
  assert.equal(normalizeSessionName(" pzza-vault "), "pzza-vault");
  assert.equal(normalizeSessionName("-dash"), "-dash");
});

test("editors stay locked while any rename of their tile runs, and listeners hear each change", async () => {
  const built = await build({ entryPoints: ["src/editorChanges.ts"], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  const { lockEditors, editorLocked, onEditorLocks } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
  let heard = 0;
  const stop = onEditorLocks(() => { heard++; });
  const first = lockEditors(["work", "work::w::1"]);
  const second = lockEditors(["work"]);
  assert.ok(editorLocked("work") && editorLocked("work::w::1") && !editorLocked("other"));
  first();
  first();
  assert.ok(editorLocked("work"), "still held by the second rename");
  assert.ok(!editorLocked("work::w::1"));
  second();
  assert.ok(!editorLocked("work"));
  assert.equal(heard, 4, "each lock and each first release");
  stop();
});

test("tile sizes are kept per workspace: one set in All never sizes the tile in its own workspace", async (t) => {
  const { useStore, saved } = await loadStore(t, {
    "pzza.workspaces": [{ id: "ws-a", name: "A" }, { id: "ws-b", name: "B" }],
    "pzza.tiles": [{ id: "work", name: "work" }, { id: "other", name: "other" }],
    "pzza.sessionWs": { work: "ws-a", other: "ws-b" },
    // Saved before sizes were kept per workspace: one map for every workspace.
    "pzza.tileSpan": { work: { c: 2, r: 3 } },
  });
  // The old sizes stay in All; every workspace starts automatic.
  assert.deepEqual(useStore.getState().tileSpan, { __all__: { work: { c: 2, r: 3 } } });
  assert.equal(saved("pzza.tileSpan"), null, "the legacy key is gone");

  useStore.getState().setTileSpan("ws-a", "work", 1, 1);
  useStore.getState().setTileSpan("__all__", "other", 1, 2);
  assert.deepEqual(useStore.getState().tileSpan, { __all__: { work: { c: 2, r: 3 }, other: { c: 1, r: 2 } }, "ws-a": { work: { c: 1, r: 1 } } });

  // Auto arrange in All leaves the workspaces' own sizes alone, and the other way round.
  assert.equal(useStore.getState().autoArrange("__all__"), 2);
  assert.deepEqual(useStore.getState().tileSpan, { "ws-a": { work: { c: 1, r: 1 } } });
  useStore.getState().setTileSpan("__all__", "work", 2, 2);
  assert.equal(useStore.getState().autoArrange("ws-a"), 1);
  assert.deepEqual(useStore.getState().tileSpan, { __all__: { work: { c: 2, r: 2 } } });

  useStore.getState().setTileSpan("ws-b", "other", 2, 1);
  useStore.getState().clearTileSpan("ws-b", "other");
  useStore.getState().clearTileSpan("ws-b", "missing");
  assert.deepEqual(useStore.getState().tileSpan, { __all__: { work: { c: 2, r: 2 } } });

  // A deleted workspace takes its sizes with it.
  useStore.getState().setTileSpan("ws-b", "other", 2, 1);
  useStore.getState().removeWorkspace("ws-b");
  assert.deepEqual(saved("pzza.tileSpans"), { __all__: { work: { c: 2, r: 2 } } });

  // A snapshot's layout applies to its own workspace only, and hidden tiles are kept by id.
  useStore.getState().applyWorkspaceLayout("ws-a", { tiles: [{ id: "work", name: "work", span: { c: 1, r: 2 }, hidden: true }] });
  assert.deepEqual(useStore.getState().tileSpan, { __all__: { work: { c: 2, r: 2 } }, "ws-a": { work: { c: 1, r: 2 } } });
  assert.deepEqual(useStore.getState().hiddenTiles, ["work"]);
});

test("a hidden remote tile restored from a snapshot is hidden by its id, not its session name", async (t) => {
  const { useStore } = await loadStore(t, {
    "pzza.workspaces": [{ id: "ws-a", name: "A" }],
    "pzza.tiles": [{ id: "box::work", name: "work", session: "work", host: "box" }],
  });
  useStore.getState().applyWorkspaceLayout("ws-a", { tiles: [{ id: "box::work", name: "work", hidden: true }] });
  assert.deepEqual(useStore.getState().hiddenTiles, ["box::work"]);
  useStore.getState().applyWorkspaceLayout("ws-a", { tiles: [{ id: "box::work", name: "work", hidden: false }] });
  assert.deepEqual(useStore.getState().hiddenTiles, []);
});

// The canvas layout as the app runs it.
async function loadLayout(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pzza-layout-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "layout.mjs");
  await build({ entryPoints: ["src/grid/autoLayout.ts"], outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  return import(pathToFileURL(outfile).href);
}

test("saved sizes report every row track their tiles take, so the canvas fits them on screen", async (t) => {
  const { arrangeTiles } = await loadLayout(t);
  const size = { width: 1380, height: 798, gap: 10 };
  const arrange = (saved) => arrangeTiles({ ids: ["a", "b"], saved, setting: 0, size, maxRows: 4 });
  // Side by side: one auto row, two tracks.
  const plain = arrange({});
  assert.equal(plain.rows, 1);
  assert.equal(plain.rowTracks, 2);
  // Widened: the neighbour wraps to a second row, which used to make every row a full screen tall.
  const widened = arrange({ a: { c: 1.5, r: 1 } });
  assert.equal(widened.rows, 1);
  assert.equal(widened.rowTracks, 4);
  assert.deepEqual(widened.spans.get("b"), { c: 4, r: 2 });
  // Taller than the auto row (a size kept from when more tiles shared the canvas).
  const tall = arrange({ a: { c: 1, r: 2 } });
  assert.equal(tall.rowTracks, 4);
  // Shorter than the auto row: the unit stays the auto row, so the tile really is shorter.
  const short = arrange({ b: { c: 1, r: 0.5 } });
  assert.equal(short.rows, 1);
  assert.equal(short.rowTracks, 2);
  assert.deepEqual(short.spans.get("b"), { c: 2, r: 1 });
});

test("a tile's folder follows the session's live folder, not the folder it was opened in", async (t) => {
  const { tileFolder } = await loadStore(t, {});
  const live = new Map([["work", "/repo/app"], ["relative", "repo"]]);
  // Opened in a parent folder, then cd'd into the repository: the live folder wins.
  assert.equal(tileFolder({ id: "work", name: "work", cwd: "/repo" }, live), "/repo/app");
  // A window tile keeps its own folder, not the session's active window.
  assert.equal(tileFolder({ id: "work::w::1", name: "work · logs", session: "work", window: 1, path: "/repo/logs", cwd: "/repo" }, live), "/repo/logs");
  // Not listed yet, or listed without an absolute folder: the opening folder fills in.
  assert.equal(tileFolder({ id: "fresh", name: "fresh", cwd: "/repo" }, live), "/repo");
  assert.equal(tileFolder({ id: "relative", name: "relative", cwd: "/repo" }, live), "/repo");
  // The session list belongs to the connected device, so another device's tile never reads it.
  assert.equal(tileFolder({ id: "box::work", name: "work", session: "work", host: "box", cwd: "/srv/app" }, live), "/srv/app");
  assert.equal(tileFolder({ id: "box::other", name: "other", session: "other", host: "box" }, live), undefined);
  // File and folder tiles work in their own folder.
  assert.equal(tileFolder({ id: "file:/repo/app/a.ts", name: "a.ts", kind: "file", file: "/repo/app/a.ts" }, live), "/repo/app");
});
