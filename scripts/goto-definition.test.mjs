import assert from "node:assert/strict";
import test from "node:test";
import { build } from "esbuild";

const result = await build({
  entryPoints: ["src/grid/TileCodePanel.tsx"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node",
  loader: { ".css": "empty" },
  logLevel: "silent",
});
const goto = await import(`data:text/javascript;base64,${Buffer.from(result.outputFiles[0].text).toString("base64")}`);
const { wordAtLine, lineModuleSpec, importClauseNames, findDefinitionLine, normalizeAbsolute, resolveRelativeImport, probeCandidates } = goto;

test("word extraction stops at punctuation", () => {
  assert.equal(wordAtLine("import { Select } from", 10), "Select");
  assert.equal(wordAtLine("../ui/Select", 3), "ui");
  assert.equal(wordAtLine("  ", 1), null);
  assert.equal(wordAtLine("$store", 0), "$store");
});

test("module specifier detection covers imports and re-exports", () => {
  const single = lineModuleSpec('import { Select } from "../ui/Select";');
  assert.equal(single?.spec, "../ui/Select");
  const line = 'import { Select } from "../ui/Select";';
  assert.ok(single && line.slice(single.from, single.to) === "../ui/Select");
  assert.equal(lineModuleSpec('import "./side-effect.css";')?.spec, "./side-effect.css");
  assert.equal(lineModuleSpec('export { X } from "./other";')?.spec, "./other");
  assert.equal(lineModuleSpec("const x = 1;"), null);
  assert.equal(lineModuleSpec('const s = "not an import";'), null);
});

test("import clause names cover default, namespace, named and type imports", () => {
  assert.deepEqual(importClauseNames('import { Select } from "../ui/Select";'), ["Select"]);
  assert.deepEqual(importClauseNames('import Default, { A, B as C } from "./m";').sort(), ["A", "C", "Default"]);
  assert.deepEqual(importClauseNames('import * as NS from "./m";'), ["NS"]);
  assert.deepEqual(importClauseNames('import type { T } from "./m";'), ["T"]);
  assert.deepEqual(importClauseNames('import "./side-effect.css";'), []);
});

test("definitions resolve for declarations, aliases and default exports", () => {
  const lines = [
    'import { useState } from "react";',
    "export function BridgeSettings() {",
    "  const [open, setOpen] = useState(false);",
    "}",
    "const helper = () => {};",
    "export { helper as util };",
    "export default BridgeSettings;",
  ];
  assert.equal(findDefinitionLine(lines, "BridgeSettings"), 2);
  assert.equal(findDefinitionLine(lines, "helper"), 5);
  assert.equal(findDefinitionLine(lines, "util"), 5);
  assert.equal(findDefinitionLine(lines, "open"), 3);
  assert.equal(findDefinitionLine(lines, "useState"), null);
  assert.equal(findDefinitionLine(lines, "missing"), null);
  // Clicking on the definition itself still resolves to it.
  assert.equal(findDefinitionLine(lines, "BridgeSettings", 2), 2);
});

test("relative imports resolve and probes cover extensions and indexes", () => {
  assert.equal(resolveRelativeImport("/a/b/File.ts", "../ui/Select"), "/a/ui/Select");
  assert.equal(resolveRelativeImport("/a/b/File.ts", "./x"), "/a/b/x");
  assert.equal(resolveRelativeImport("/a/b/File.ts", "react"), null);
  assert.equal(normalizeAbsolute("/a/b/../c/./d"), "/a/c/d");
  const probes = probeCandidates("/a/ui/Select");
  assert.ok(probes.includes("/a/ui/Select"));
  assert.ok(probes.includes("/a/ui/Select.tsx"));
  assert.ok(probes.includes("/a/ui/Select/index.ts"));
  assert.deepEqual(probeCandidates("/a/file.css"), ["/a/file.css"]);
});
