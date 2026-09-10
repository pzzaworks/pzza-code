import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function loadTypeScript(path) {
  const output = await build({ entryPoints: [new URL(path, import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm", target: "es2022" });
  const code = output.outputFiles[0].text;
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

test("workspace mutation validates every target before writing and preserves remote assignment keys", () => {
  const f = fixture();
  f.state.workspaces = [{ id: "main", name: "Main" }, { id: "remote", name: "Remote" }, { id: "system", name: "System", system: true }];
  f.state.reorderWorkspace = (...args) => f.writes.push(args);
  f.state.assignSession = (key, id) => { f.state.sessionWs[key] = id; };
  for (const args of [{ workspaceId: "all", targetId: "main", placement: "before" }, { workspaceId: "remote", targetId: "missing", placement: "after" }]) assert.throws(() => f.run("reorder_workspace", args));
  for (const workspaceId of ["main", "system", "missing"]) assert.throws(() => f.run("delete_workspace", { workspaceId }));
  assert.deepEqual(f.writes, []);
  f.run("reorder_workspace", { workspaceId: "remote", targetId: "main", placement: "before" });
  assert.deepEqual(f.writes, [["remote", "main", "before"]]);
  f.run("assign_tile", { tileId: f.id, workspaceId: "main" });
  assert.equal(f.state.sessionWs["devbox::project"], "main");
  assert.equal(f.state.sessionWs.project, undefined);
});

test("SSH device boundaries reject unsupported hosts before creating or selecting devices", () => {
  const f = fixture();
  f.state.devices = [{ id: "this-mac", name: "This Device", host: "localhost" }, { id: "invalid", name: "Invalid", host: "ssh://host" }];
  f.state.addDevice = (...args) => f.writes.push(args);
  f.state.setHost = host => { f.state.connection.host = host; };
  for (const host of ["-oProxyCommand=x", "ssh://host", "host:22", "host/path", "x".repeat(129), "a b"]) assert.throws(() => f.run("add_device", { name: "Remote", host }));
  assert.throws(() => f.run("add_device", { name: "Remote", host: "a".repeat(128), user: "user" }));
  assert.throws(() => f.run("set_connection", { deviceId: "invalid" }));
  assert.throws(() => f.run("remove_device", { deviceId: "this-mac" }));
  assert.deepEqual(f.writes, []);
  f.run("add_device", { name: "Remote", host: "dev-machine", user: "berke" });
  assert.deepEqual(f.writes, [["Remote", "dev-machine", "berke"]]);
  f.run("set_connection", { deviceId: "this-mac" });
  assert.equal(f.state.connection.host, null);
});

test("remote window selection stays namespaced and cannot accidentally target local sessions", () => {
  const f = fixture();
  f.state.openWindow = (window, displayName, host) => {
    f.state.tiles.push({ id: `${host ? `${host}::` : ""}${window.session}::w::${window.window}`, name: displayName, session: window.session, window: window.window, host });
  };
  f.run("open_session", { session: "project", window: 2, cwd: "/project", host: "other-host" });
  assert.equal(f.state.activeId, "other-host::project::w::2");
  assert.equal(f.state.tiles.at(-1).host, "other-host");
  f.run("open_session", { session: "project", window: 2, cwd: "/project", host: "other-host" });
  assert.equal(f.state.tiles.length, 2);
});

test("close and appearance commands reject unsafe input before state mutation", () => {
  const f = fixture();
  f.state.closeTile = id => f.writes.push(["close", id]);
  f.state.setTheme = theme => f.writes.push(["theme", theme]);
  f.dirty.add(f.id);
  assert.throws(() => f.run("close_tile", { tileId: f.id }), /unsaved/);
  assert.throws(() => f.run("configure_appearance", { theme: "light", fontSize: 100 }));
  assert.throws(() => f.run("configure_appearance", { theme: "light", execute: "command" }));
  assert.deepEqual(f.writes, []);
  f.run("configure_appearance", { theme: "light" });
  f.dirty.clear(); f.run("close_tile", { tileId: f.id });
  assert.deepEqual(f.writes, [["theme", "light"], ["close", f.id]]);
});

test("app snapshots explicitly select public device fields and never include editor content", () => {
  const f = fixture();
  f.state.devices = [{ id: "remote", name: "Remote", host: "dev", user: "user", credential: "private marker" }];
  f.state.tileCode[f.id] = { open: true, root: "/project", content: "unsaved private text" };
  const result = JSON.stringify(appControlSnapshot(f.context));
  assert.ok(!result.includes("private marker"));
  assert.ok(!result.includes("unsaved private text"));
});

test("lifecycle completion runs only after acknowledgment and once despite result retry", async () => {
  const runtime = await loadTypeScript("../src/appControlRuntime.ts");
  let completions = 0;
  assert.throws(() => runtime.afterAppControlReport(async () => {}), /acknowledged/);
  const result = await runtime.runAppControlExecution("one", () => {
    runtime.afterAppControlReport(async () => { completions++; });
    return { accepted: true };
  });
  assert.equal(result.accepted, true);
  assert.equal(completions, 0);
  await runtime.finishAppControlReport("one");
  await runtime.finishAppControlReport("one");
  assert.equal(completions, 1);
  await assert.rejects(runtime.runAppControlExecution("two", () => {
    runtime.afterAppControlReport(async () => { completions++; });
    throw Error("Failure before acknowledgment");
  }));
  await runtime.finishAppControlReport("two");
  assert.equal(completions, 1);
  await runtime.runAppControlExecution("three", () => runtime.afterAppControlReport(async () => { completions++; }));
  runtime.discardAppControlReport("three");
  await runtime.finishAppControlReport("three");
  assert.equal(completions, 1);
});
