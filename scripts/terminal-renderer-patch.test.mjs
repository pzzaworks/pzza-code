import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { patchTerminalRenderer, terminalRendererOptimizerPatch, terminalRendererPatch } from "./terminal-renderer-patch.mjs";

const versions = { xterm: "5.5.0", "addon-webgl": "0.18.0" };
const sources = {};
for (const renderer of Object.keys(versions)) {
  sources[renderer] = await readFile(new URL(`../node_modules/@xterm/${renderer}/lib/${renderer}.js`, import.meta.url), "utf8");
}
const patched = Object.fromEntries(Object.entries(sources).map(([name, source]) => [name, patchTerminalRenderer(source, name, versions[name])]));

test("renderer source and version drift fail closed", () => {
  for (const name of Object.keys(sources)) {
    assert.throws(() => patchTerminalRenderer(sources[name] + " ", name, versions[name]), /Unsupported terminal renderer/);
    assert.throws(() => patchTerminalRenderer(sources[name], name, "99.0.0"), /Unsupported terminal renderer/);
    assert.doesNotThrow(() => new Function(patched[name]));
  }
});

test("WebGL explicit RGB, indexed and inverse backgrounds keep their RGB and follow alpha", () => {
  const source = patched["addon-webgl"];
  const method = source.slice(source.indexOf("_updateRectangle(e,"), source.indexOf("_addRectangle(e,t,i,s"));
  const Renderer = new Function(`let l,c,d,_,u,g,v; return class { ${method} }`)();
  const renderer = new Renderer();
  renderer._terminal = { rows: 1, cols: 1 };
  renderer._dimensions = { device: { cell: { width: 1, height: 1 } } };
  renderer._themeService = { colors: { ansi: [{ rgba: 0x204060ff }], foreground: { rgba: 0xabcdefFF }, background: { rgba: 0 } } };
  let result;
  renderer._addRectangle = (...args) => { result = args.slice(-4); };
  for (const alpha of [0, 0.25, 0.5, 1]) {
    renderer._pzzaBackgroundOpacity = alpha;
    for (const [fg, bg, rgb] of [
      [0, 50331648, [0, 0, 0]],
      [0, 50331648 | 0x204060, [32, 64, 96]],
      [0, 16777216, [32, 64, 96]],
      [67108864 | 50331648 | 0x204060, 0, [32, 64, 96]],
    ]) {
      renderer._updateRectangle({ attributes: new Float32Array(8) }, 0, fg, bg, 0, 1, 0);
      assert.deepEqual(result, [...rgb.map((channel) => channel / 255), alpha]);
    }
  }
  assert.ok(source.includes("blendFuncSeparate(h.SRC_ALPHA,h.ONE_MINUS_SRC_ALPHA,h.ONE,h.ONE_MINUS_SRC_ALPHA)"));
});

test("DOM fallback scales only cell background styles, never foregrounds or dimensions", () => {
  const source = patched.xterm;
  const method = source.slice(source.indexOf("_addStyle(e,t){"), source.indexOf("_isCellInSelection(e,t){"));
  const Renderer = new Function(`return class { ${method} }`)();
  const renderer = new Renderer();
  let style = "";
  const element = { getAttribute: () => style, setAttribute: (_name, value) => { style = value; } };
  renderer._addStyle(element, "background-color:#000000");
  assert.equal(style, "background-color:color-mix(in srgb, #000000 calc(var(--pzza-cell-background-opacity, 1) * 100%), transparent);");
  style = "";
  renderer._addStyle(element, "color:#123456");
  renderer._addStyle(element, "width:20px");
  assert.equal(style, "color:#123456;width:20px;");
  assert.ok(source.includes(".${m}${i} { background-color: color-mix"));
  assert.ok(source.includes(".${m}${a.INVERTED_DEFAULT_COLOR} { background-color: color-mix"));
});

test("WebGL clears previous translucent pixels before painting every background frame", () => {
  const source = patched["addon-webgl"];
  const method = source.slice(source.indexOf("renderBackgrounds(){"), source.indexOf("renderCursor(){"));
  const Renderer = new Function(`return class { ${method} }`)();
  const renderer = new Renderer();
  const calls = [];
  renderer._gl = {
    COLOR_BUFFER_BIT: 16384,
    clearColor: (...rgba) => calls.push(["clearColor", ...rgba]),
    clear: (mask) => calls.push(["clear", mask]),
  };
  renderer._renderVertices = () => calls.push(["backgrounds"]);
  renderer.renderBackgrounds();
  renderer.renderBackgrounds();
  assert.deepEqual(calls, [
    ["clearColor", 0, 0, 0, 0], ["clear", 16384], ["backgrounds"],
    ["clearColor", 0, 0, 0, 0], ["clear", 16384], ["backgrounds"],
  ]);
});

test("development optimizer and production transform produce identical patched renderers", async () => {
  let onLoad;
  terminalRendererOptimizerPatch().setup({ onLoad: (_options, callback) => { onLoad = callback; } });
  for (const name of Object.keys(sources)) {
    const path = fileURLToPath(new URL(`../node_modules/@xterm/${name}/lib/${name}.js`, import.meta.url));
    const development = await onLoad({ path });
    const production = await terminalRendererPatch().transform(sources[name], path);
    assert.equal(development.contents, patched[name]);
    assert.equal(production.code, patched[name]);
  }
  assert.equal(await terminalRendererPatch().transform("unrelated", "/src/example.ts"), null);
});
