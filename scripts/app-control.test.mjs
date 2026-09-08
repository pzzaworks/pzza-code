import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";

async function loadTypeScript(path) {
  const { code } = await transform(await readFile(new URL(path, import.meta.url), "utf8"), { loader: "ts", format: "esm", target: "es2022" });
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}
const { executeAppControl, appControlSnapshot } = await loadTypeScript("../src/appControlCommands.ts");
const { registerEditorFile, hasUnsavedEditors } = await loadTypeScript("../src/editorChanges.ts");

function fixture() {
  const dirty = new Set();
  const writes = [];
  const state = {
    tiles: [{ id: "host::project::w::1", name: "Project", session: "project", host: "devbox", path: "/projects/demo" }],
    activeId: null, activeWorkspaceId: "main", connection: { host: null },
    sessionWs: { "devbox::project": "remote" }, hiddenTiles: ["host::project::w::1"],
    tileTitles: {}, tileCode: {}, workspaceColumns: {}, defaultColumns: 2,
    setActive(id) { writes.push("focus"); state.activeId = id; },
    setWorkspace(id) { writes.push("workspace"); state.activeWorkspaceId = id; },
    unhideTile(id) { writes.push("unhide"); state.hiddenTiles = state.hiddenTiles.filter((entry) => entry !== id); },
    toggleTileCode(id, root) { writes.push("editor"); const current = state.tileCode[id]; state.tileCode[id] = { ...current, open: !current?.open, root: current?.root ?? root, path: undefined }; },
    setTileCodeRoot(id, root) { writes.push("root"); state.tileCode[id] = { ...state.tileCode[id], open: true, root, path: undefined }; },
    setTileCodePath(id, path) { writes.push("path"); state.tileCode[id] = { ...state.tileCode[id], open: true, path }; },
    setTileCodeLayout(id, layout) { writes.push("layout"); state.tileCode[id] = { ...state.tileCode[id], layout }; },
    setColumns(columns) { writes.push("columns"); state.workspaceColumns[state.activeWorkspaceId] = columns; },
    openSession(name, cwd, host) { state.tiles.push({ id: name, name, session: name, cwd, host }); state.activeId = name; },
  };
  const context = {
    getState: () => state, hasUnsavedEditor: (id) => dirty.has(id), defaultWorkspaceId: "main", allWorkspaceId: "all",
  };
  const id = state.tiles[0].id;
  return { state, context, dirty, writes, id, run: (action, args = {}) => executeAppControl(action, args, context) };
}

test("focus reveals a hidden remote tile and switches its workspace", () => {
  const f = fixture();
  const result = f.run("focus_tile", { tileId: f.id });
  assert.equal(result.activeId, f.id);
  assert.equal(result.workspaceId, "remote");
  assert.equal(result.tiles[0].host, "devbox");
  assert.equal(result.tiles[0].hidden, false);
});

test("opening a project session stays local while the app is connected remotely", () => {
  const f = fixture();
  f.state.connection.host = "devbox";
  const result = f.run("open_session", { session: "build-project", cwd: "/projects/demo" });
  assert.equal(result.activeId, "build-project");
  assert.equal(result.tiles.find((tile) => tile.id === "build-project").host, "");
  f.run("open_session", { session: "build-project", cwd: "/projects/demo" });
  assert.equal(f.state.tiles.length, 2);
  assert.throws(() => f.run("open_session", { session: "bad:target", cwd: "/project" }));
  assert.throws(() => f.run("open_session", { session: "valid", cwd: "relative" }));
});

test("opening a local session cannot focus a remote tile with the same legacy ID", () => {
  const f = fixture();
  f.state.tiles[0].id = "project";
  assert.throws(() => f.run("open_session", { session: "project", cwd: "/projects/demo" }), /different device/);
  assert.deepEqual(f.writes, []);
});

test("layout changes apply to an open editor only", () => {
  const f = fixture();
  assert.throws(() => f.run("set_layout", { tileId: f.id, layout: "stacked" }), /editor panel is closed/);
  assert.deepEqual(f.writes, []);
  f.state.tileCode[f.id] = { open: true, root: "/project" };
  const result = f.run("set_layout", { tileId: f.id, layout: "stacked" });
  assert.equal(f.state.tileCode[f.id].layout, "stacked");
  assert.equal(result.tiles[0].editor.layout, "stacked");
});

test("invalid actions, IDs, layouts and columns never mutate state", () => {
  const f = fixture();
  for (const [action, args] of [
    ["run_terminal", {}], ["focus_tile", { tileId: "missing" }],
    ["open_editor", { tileId: f.id, root: "/ok", path: "bad\0path" }], ["open_editor", { tileId: f.id, layout: "invalid" }],
    ["set_layout", { tileId: f.id, layout: "invalid" }],
    ...[0, 9, 1.5, "2", NaN].map((columns) => ["set_columns", { columns }]),
  ]) assert.throws(() => f.run(action, args));
  assert.deepEqual(f.writes, []);
});

test("dirty editor content is protected before any navigation or close mutation", () => {
  const f = fixture();
  f.state.tileCode[f.id] = { open: true, root: "/project", path: "/project/a.ts" };
  f.dirty.add(f.id);
  for (const [action, args] of [
    ["close_editor", {}], ["open_editor", { path: "/project/b.ts" }], ["open_editor", { root: "/other" }],
  ]) assert.throws(() => f.run(action, { tileId: f.id, ...args }), /unsaved changes/);
  assert.deepEqual(f.writes, []);
  f.run("open_editor", { tileId: f.id, path: "/project/a.ts", root: "/project", layout: "stacked" });
  assert.equal(f.state.tileCode[f.id].path, "/project/a.ts");
  assert.equal(f.state.tileCode[f.id].layout, "stacked");
});

test("editor opens requested file and reports selection not load completion", () => {
  const f = fixture();
  f.state.tileCode[f.id] = { open: false, root: "/project", path: "/project/a.ts" };
  const result = f.run("open_editor", { tileId: f.id, path: "/project/a.ts", layout: "full" });
  assert.equal(result.tiles[0].editor.path, "/project/a.ts");
  assert.equal(result.tiles[0].editor.loadState, "not_reported");
  f.run("close_editor", { tileId: f.id });
  assert.equal(f.state.tileCode[f.id].open, false);
});

test("snapshot excludes stale unopened panel state and supports all validated grid widths", () => {
  const f = fixture();
  f.state.tileCode.stale = { open: true, root: "/secret" };
  assert.equal(appControlSnapshot(f.context).tiles.length, 1);
  for (const columns of [1, 2, 4, 8]) assert.equal(f.run("set_columns", { columns }).columns, columns);
});

test("unsaved editor registry supports targeted dirty and saving checks", () => {
  const clean = registerEditorFile("clean", () => ({ saving: false, dirty: false }));
  const dirty = registerEditorFile("dirty", () => ({ saving: false, dirty: true }));
  const saving = registerEditorFile("saving", () => ({ saving: true }));
  try {
    assert.equal(hasUnsavedEditors(), true);
    assert.equal(hasUnsavedEditors(["clean"]), false);
    assert.equal(hasUnsavedEditors(["dirty"]), true);
    assert.equal(hasUnsavedEditors(["saving"]), true);
  } finally { clean(); dirty(); saving(); }
  assert.equal(hasUnsavedEditors(), false);
});
