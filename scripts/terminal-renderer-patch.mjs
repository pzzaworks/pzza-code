import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync } from "node:fs";

// These renderer releases hard-code opaque cell backgrounds. Patch their
// distribution at build time, never terminal output or installed dependencies.
// Full hashes deliberately make a dependency update require renderer review.
const RENDERERS = {
  "xterm": {
    version: "5.5.0",
    hash: "1f991ac3b4b283ebf96e60ae23a00a52765dd3a2e46fa6fdda9f1aab032f7495",
  },
  "addon-webgl": {
    version: "0.18.0",
    hash: "9ffa9ac3ff6d47d4e6216ed1972ca8e0b5336cef744f50ebdc3f67b0ed727cdb",
  },
};

const OPACITY = "--pzza-cell-background-opacity";
// Vite's dependency cache includes optimizer plugin names, not their function
// bodies. Include this patch's digest so edits cannot reuse an older renderer.
const PLUGIN_NAME = `terminal-cell-background-opacity-${createHash("sha256").update(readFileSync(new URL(import.meta.url))).digest("hex").slice(0, 12)}`;
const mix = (color) => `color-mix(in srgb, ${color} calc(var(${OPACITY}, 1) * 100%), transparent)`;

function replaceOnce(source, before, after) {
  const index = source.indexOf(before);
  if (index < 0 || source.indexOf(before, index + before.length) >= 0) {
    throw new Error("Terminal renderer patch target changed. Review the installed renderer before building.");
  }
  return source.slice(0, index) + after + source.slice(index + before.length);
}

export function patchTerminalRenderer(source, renderer, version) {
  const expected = RENDERERS[renderer];
  if (!expected || version !== expected.version ||
    createHash("sha256").update(source).digest("hex") !== expected.hash) {
    throw new Error(`Unsupported terminal renderer ${renderer}@${version}. Review the background-opacity patch before building.`);
  }
  if (renderer === "addon-webgl") {
    // A transparent viewport rectangle cannot erase the previous frame under
    // blending. Clear first so repeated renders never accumulate cell alpha.
    source = replaceOnce(source, "renderBackgrounds(){this._renderVertices(this._vertices)}",
      "renderBackgrounds(){this._gl.clearColor(0,0,0,0);this._gl.clear(this._gl.COLOR_BUFFER_BIT);this._renderVertices(this._vertices)}");
    // Read once per background-model update, not once per terminal cell.
    source = replaceOnce(source, "updateBackgrounds(e){const t=this._terminal,i=this._vertices;",
      `updateBackgrounds(e){const t=this._terminal,i=this._vertices;this._pzzaBackgroundOpacity=Math.max(0,Math.min(1,Number(t.element?.style.getPropertyValue("${OPACITY}")||"1")));`);
    source = replaceOnce(source, "g=(l>>8&255)/255,v=1,this._addRectangle(e.attributes",
      "g=(l>>8&255)/255,v=this._pzzaBackgroundOpacity,this._addRectangle(e.attributes");
    // RGB uses source alpha; alpha itself must not be multiplied by alpha a
    // second time when compositing translucent rectangles and glyph edges.
    return replaceOnce(source, "h.blendFunc(h.SRC_ALPHA,h.ONE_MINUS_SRC_ALPHA)",
      "h.blendFuncSeparate(h.SRC_ALPHA,h.ONE_MINUS_SRC_ALPHA,h.ONE,h.ONE_MINUS_SRC_ALPHA)");
  }
  // Indexed/inverse cell backgrounds are stylesheet rules. Foregrounds and
  // cursor rules are intentionally untouched.
  source = replaceOnce(source,
    "${this._terminalSelector} .${m}${i} { background-color: ${s.css}; }",
    "${this._terminalSelector} .${m}${i} { background-color: " + mix("${s.css}") + "; }");
  source = replaceOnce(source,
    "${this._terminalSelector} .${m}${a.INVERTED_DEFAULT_COLOR} { background-color: ${e.foreground.css}; }",
    "${this._terminalSelector} .${m}${a.INVERTED_DEFAULT_COLOR} { background-color: " + mix("${e.foreground.css}") + "; }");
  // True-color and decoration/dim overrides are inline cell styles.
  return replaceOnce(source, '_addStyle(e,t){e.setAttribute("style",',
    `_addStyle(e,t){t.startsWith("background-color:")&&(t="background-color:${mix('"+t.slice(17)+"')}");e.setAttribute("style",`);
}

const rendererFile = /[/\\]@xterm[/\\](xterm|addon-webgl)[/\\]lib[/\\](?:xterm|addon-webgl)\.js$/;

async function transformFile(source, path) {
  const match = path.match(rendererFile);
  if (!match) return null;
  const manifest = JSON.parse(await readFile(path.replace(/[/\\]lib[/\\][^/\\]+$/, "/package.json"), "utf8"));
  return patchTerminalRenderer(source, match[1], manifest.version);
}

export function terminalRendererPatch() {
  return {
    name: PLUGIN_NAME,
    enforce: "pre",
    async transform(source, id) {
      const code = await transformFile(source, id);
      return code === null ? null : { code, map: null };
    },
  };
}

export function terminalRendererOptimizerPatch() {
  return {
    name: PLUGIN_NAME,
    setup(build) {
      build.onLoad({ filter: rendererFile }, async ({ path }) => ({
        contents: await transformFile(await readFile(path, "utf8"), path),
        loader: "js",
      }));
    },
  };
}
