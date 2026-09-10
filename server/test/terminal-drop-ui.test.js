import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const result = await build({ entryPoints: ["src/terminal/fileDrop.ts"], bundle: true, write: false, format: "esm", platform: "node",
  plugins: [{ name: "notification-test-boundary", setup(build) {
    build.onResolve({ filter: /state\/notifications$/ }, () => ({ path: "notification", namespace: "test" }));
    build.onLoad({ filter: /.*/, namespace: "test" }, () => ({ contents: "export const notify = () => {};", loader: "js" }));
  } }],
});
const { shellQuotePaths, validateDroppedFiles, externalDrop, installTerminalDrops, registerTerminalDropTarget } =
  await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);

test("absolute dropped paths are literal shell arguments with no Enter or control characters", async () => {
  const paths = ["/tmp/a ' quote.txt", "/tmp/$(touch nope); space", "/tmp/empty"];
  const quoted = shellQuotePaths(paths);
  assert.doesNotMatch(quoted, /[\r\n\x00-\x1f\x7f]/);
  const output = await promisify(execFile)("sh", ["-c", `set -- ${quoted}; printf '%s\\0' "$@"`], { timeout: 5000 });
  assert.deepEqual(output.stdout.split("\0").slice(0, -1), paths);
  for (const path of ["relative", "/tmp/line\ncommand", "/tmp/\x1bescape"]) assert.throws(() => shellQuotePaths([path]));
});

test("frontend count, bytes, names and internal drag guards match backend boundaries", () => {
  validateDroppedFiles([{ name: "real-file.txt", size: 0 }]);
  for (const files of [[], Array(9).fill({ name: "a", size: 1 }), [{ name: "bad\nname", size: 1 }],
    [{ name: "a", size: 16 * 1024 * 1024 + 1 }], ["a", "b", "c"].map(name => ({ name, size: 16 * 1024 * 1024 }))]) assert.throws(() => validateDroppedFiles(files));
  for (const types of [["application/pzza-session"], ["application/x-pzza-workspace"], ["application/x-pzza-file"]]) assert.equal(externalDrop(types), false);
  assert.equal(externalDrop(["text/uri-list"]), true);
  assert.equal(externalDrop(["Files"]), true);
  assert.equal(externalDrop(["text/plain"], true), false);
});

test("root listeners block external navigation, route files by hit target and preserve internal editor/tile/workspace drops", () => {
  const priorWindow = globalThis.window;
  const priorDocument = globalThis.document;
  const events = new EventTarget();
  const a = { contains: node => node === a };
  const b = { contains: node => node === b };
  let hits = [b];
  globalThis.window = events;
  globalThis.document = { elementsFromPoint: () => hits };
  const accepted = [];
  const unregisterA = registerTerminalDropTarget(a, data => accepted.push(["a", data]));
  const unregisterB = registerTerminalDropTarget(b, data => accepted.push(["b", data]));
  const dispose = installTerminalDrops();
  const send = (types, items = [], eventType = "drop") => {
    const event = new Event(eventType, { cancelable: true });
    Object.defineProperties(event, { clientX: { value: 10 }, clientY: { value: 10 }, dataTransfer: { value: { types, items } } });
    events.dispatchEvent(event);
    return event;
  };
  try {
    assert.equal(send(["text/uri-list"]).defaultPrevented, true);
    assert.equal(send(["Files"], [], "dragover").defaultPrevented, true);
    const file = new File(["data"], "dropped.txt");
    const item = { kind: "file", getAsFile: () => file, webkitGetAsEntry: () => ({ isDirectory: false }) };
    assert.equal(send(["Files"], [item]).defaultPrevented, true);
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0][0], "b", "the drop chooses the hit terminal, not previously active terminal");
    assert.deepEqual(accepted[0][1].files, [file]);
    hits = [];
    assert.equal(send(["Files"], [item]).defaultPrevented, true);
    assert.equal(accepted.length, 1);
    hits = [{ modal: true }, b];
    send(["Files"], [item]);
    assert.equal(accepted.length, 1, "an overlay must not route a drop to the terminal underneath");
    for (const type of ["application/pzza-session", "application/x-pzza-workspace", "application/x-pzza-file"]) assert.equal(send([type]).defaultPrevented, false);
    hits = [a];
    send(["Files"], [{ ...item, webkitGetAsEntry: () => ({ isDirectory: true }) }]);
    assert.equal(accepted.length, 1, "directories are never passed to terminal upload");
    events.dispatchEvent(new Event("dragstart"));
    assert.equal(send(["text/plain"]).defaultPrevented, false, "internal editor text drags remain intact");
  } finally {
    dispose(); unregisterA(); unregisterB();
    globalThis.window = priorWindow;
    globalThis.document = priorDocument;
  }
});
