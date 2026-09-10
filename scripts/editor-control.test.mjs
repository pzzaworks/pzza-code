import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
const output = await build({ entryPoints: [new URL("../src/appControlEditor.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm", target: "es2022" });
const { createEditorAppController } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);

async function fixture(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "pzza-editor-control-"));
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const file = path.join(directory, "notes.md");
  await fs.writeFile(file, "Original text\n");
  let count = 0;
  const state = { path: file, root: directory, content: await fs.readFile(file, "utf8"), revision: "revision-0", loaded: true, dirty: false, saving: false, binary: false, markdown: true, failed: false, tree: true, preview: false, folderPicker: false };
  const change = (content, dirty) => { Object.assign(state, { content, dirty, revision: `revision-${++count}` }); };
  const adapter = {
    read: () => ({ ...state }), change, busy: saving => { state.saving = saving; },
    save: (file, content) => fs.writeFile(file, content), reload: file => fs.readFile(file, "utf8"),
    close: () => { state.path = undefined; }, view: settings => Object.assign(state, settings),
    copyImage: async () => {}, list: async () => [], move: async () => {}, remove: async () => {}, treeAction: async () => {},
  };
  const controller = createEditorAppController(adapter);
  return { state, file, adapter, change, controller, run: (action, args = {}) => controller.execute(action, args) };
}

test("editor metadata omits content and edits save the exact selected revision", async t => {
  const f = await fixture(t);
  assert.equal(Object.hasOwn(f.controller.state(), "content"), false);
  const page = await f.run("editor_read_buffer", { offset: 2, length: 5 });
  assert.equal(page.content, "igina");
  assert.equal(page.hasMore, true);
  const edit = await f.run("editor_edit_buffer", { expectedRevision: page.revision, start: 0, deleteCount: 8, text: "Updated" });
  assert.equal(edit.dirty, true);
  assert.equal(f.state.content, "Updated text\n");
  await assert.rejects(f.run("editor_save", { expectedRevision: page.revision }), /revision changed/);
  assert.equal(await fs.readFile(f.file, "utf8"), "Original text\n");
  await f.run("editor_save", { expectedRevision: edit.revision });
  assert.equal(await fs.readFile(f.file, "utf8"), "Updated text\n");
  assert.equal(f.state.dirty, false);
});

test("saving preserves newer edits and failed writes leave a dirty, retryable buffer", async t => {
  const f = await fixture(t);
  f.change("Saved version", true);
  let release;
  const saving = new Promise(resolve => { release = resolve; });
  f.adapter.save = async (file, content) => { await saving; await fs.writeFile(file, content); };
  const pending = f.run("editor_save", { expectedRevision: f.state.revision });
  assert.equal(f.state.saving, true);
  await assert.rejects(f.run("editor_edit_buffer", { expectedRevision: f.state.revision, start: 0, deleteCount: 0, text: "busy" }), /finish/);
  f.change("New typing during save", true);
  release(); await pending;
  assert.equal(await fs.readFile(f.file, "utf8"), "Saved version");
  assert.equal(f.state.content, "New typing during save");
  assert.equal(f.state.dirty, true);
  assert.equal(f.state.saving, false);
  f.adapter.save = async () => { throw new Error("Device unavailable"); };
  await assert.rejects(f.run("editor_save", { expectedRevision: f.state.revision }), /unavailable/);
  assert.equal(f.state.dirty, true);
  assert.equal(f.state.saving, false);
});

test("discard reloads disk, rejects stale revisions and preserves typing during reload", async t => {
  const f = await fixture(t);
  f.change("Unsaved text", true);
  await f.run("editor_discard", { expectedRevision: f.state.revision });
  assert.equal(f.state.content, "Original text\n");
  assert.equal(f.state.dirty, false);
  f.change("Another edit", true);
  f.adapter.reload = async file => { const content = await fs.readFile(file, "utf8"); f.change("Newer typing", true); return content; };
  await assert.rejects(f.run("editor_discard", { expectedRevision: f.state.revision }), /preserved/);
  assert.equal(f.state.content, "Newer typing");
  assert.equal(f.state.dirty, true);
  assert.equal(f.state.saving, false);
  await assert.rejects(f.run("editor_close_file"), /Save or explicitly discard/);
});

test("unloaded, binary and protected buffers cannot be read or edited", async t => {
  const f = await fixture(t);
  for (const override of [{ loaded: false }, { binary: true }, { failed: true }]) {
    Object.assign(f.state, override);
    await assert.rejects(f.run("editor_read_buffer"), /finish loading/);
    Object.assign(f.state, { loaded: true, binary: false, failed: false });
  }
  for (const name of [".env", ".env.local", "credentials.json", "private.key", ".claude.json", ".codex/auth.json"]) {
    f.state.path = path.join(f.state.root, name);
    await assert.rejects(f.run("editor_read_buffer"), /Credential and environment/);
    await assert.rejects(f.run("editor_edit_buffer", { expectedRevision: f.state.revision, start: 0, deleteCount: 0, text: "text" }), /Credential and environment/);
  }
  f.state.path = f.file;
  await assert.rejects(f.run("editor_edit_buffer", { expectedRevision: f.state.revision, start: 500, deleteCount: 0, text: "text" }), /outside/);
  f.state.markdown = false;
  await assert.rejects(f.run("editor_set_view", { preview: true }), /Markdown/);
});

test("deleting a directory protects every affected unsaved editor while renames preserve buffers", async () => {
  const output = await build({ entryPoints: [new URL("../src/editorChanges.ts", import.meta.url).pathname], bundle: true, write: false, platform: "node", format: "esm", target: "es2022" });
  const { registerEditorFile, beginFileMutation } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
  const unregister = registerEditorFile("remote-editor", () => ({ host: "devbox", path: "/project/src/file.ts", saving: false, dirty: true }));
  try {
    assert.throws(() => beginFileMutation({ host: "devbox", path: "/project/src" }, { allowDirty: false }), /Save or discard/);
    beginFileMutation({ host: "devbox", path: "/project/src" })();
    beginFileMutation({ host: "another-device", path: "/project/src" }, { allowDirty: false })();
    beginFileMutation({ host: "devbox", path: "/project/other" }, { allowDirty: false })();
  } finally { unregister(); }
});
