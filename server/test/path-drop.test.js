import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

// folderDrop.ts with its app boundaries replaced: folders are the paths that
// end in "/dir", terminals are hit at x < 100 and a dialog at x > 900.
const STUBS = {
  "../serverApi": "export const listDir = path => path.endsWith('/dir') ? Promise.resolve([]) : Promise.reject(new Error('not a folder'));",
  "../state/newSession": "export const requestNewSession = (...args) => globalThis.calls.push(['session', ...args]);",
  "../openFiles": "export const openFiles = paths => globalThis.calls.push(['files', paths]); export const openFolders = paths => globalThis.calls.push(['folders', paths]);",
  "./fileDrop": "export const terminalDropTargetAt = x => x < 100;",
  "../tauriEnv": "export const HAS_TAURI = false;",
  "../shortcuts": "export const IS_MAC = true;",
  "@tauri-apps/api/webview": "export const getCurrentWebview = () => ({});",
};
const result = await build({
  entryPoints: ["src/terminal/folderDrop.ts"], bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "path-drop-test-boundary", setup(build) {
    build.onResolve({ filter: /.*/ }, args => Object.hasOwn(STUBS, args.path) ? { path: args.path, namespace: "stub" } : undefined);
    build.onLoad({ filter: /.*/, namespace: "stub" }, args => ({ contents: STUBS[args.path], loader: "js" }));
  } }],
});
const { handlePathDrag, usePathDrag } = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

const dialog = { closest: () => ({}) };
const plain = { closest: () => null };
globalThis.document = { elementsFromPoint: x => [x > 900 ? dialog : plain] };

async function drop(paths, x) {
  globalThis.calls = [];
  await handlePathDrag({ type: "enter", paths, x, y: 10 });
  const shown = usePathDrag.getState();
  await handlePathDrag({ type: "drop", paths, x, y: 10 });
  return { shown, calls: globalThis.calls, after: usePathDrag.getState() };
}

test("a single folder dropped off a terminal opens the new-session form", async () => {
  const { shown, calls, after } = await drop(["/work/dir"], 500);
  assert.deepEqual(shown, { label: "dir", session: true, target: "open" });
  assert.deepEqual(calls, [["session", "/work/dir", ""]]);
  assert.equal(after.label, null);
});

test("files and several folders dropped off a terminal open as tiles", async () => {
  const { shown, calls } = await drop(["/work/a.ts", "/work/dir", "/other/dir"], 500);
  assert.deepEqual(shown, { label: "3 items", session: false, target: "open" });
  assert.deepEqual(calls, [["folders", ["/work/dir", "/other/dir"]], ["files", ["/work/a.ts"]]]);
});

test("a drop on a terminal is left to the terminal and one on a dialog does nothing", async () => {
  const onTerminal = await drop(["/work/dir", "/work/a.ts"], 50);
  assert.equal(onTerminal.shown.target, "terminal");
  assert.deepEqual(onTerminal.calls, []);
  const onDialog = await drop(["/work/a.ts"], 950);
  assert.equal(onDialog.shown.target, "none");
  assert.deepEqual(onDialog.calls, []);
});

test("relative or control-character paths are ignored", async () => {
  for (const paths of [["relative/dir"], ["/work/line\nbreak"], []]) {
    const { shown, calls } = await drop(paths, 500);
    assert.equal(shown.label, null);
    assert.deepEqual(calls, []);
  }
});
