import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ entryPoints: ["src/terminal/dictationComposition.ts"], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", external: ["@xterm/xterm"] });
const { pendingColor, separatedFromCaret } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

test("pending dictation words are drawn in the terminal foreground, dimmed", () => {
  assert.equal(pendingColor("#ffffff"), "rgba(255, 255, 255, 0.55)");
  assert.equal(pendingColor("#1E1e1e"), "rgba(30, 30, 30, 0.55)");
  assert.equal(pendingColor("#abc"), "rgba(170, 187, 204, 0.55)");
  assert.equal(pendingColor(" rgb(12, 34, 56) "), "rgba(12, 34, 56, 0.55)");
  assert.equal(pendingColor("rgba(12, 34, 56, 0.9)"), "rgba(12, 34, 56, 0.55)");
  // Anything else is left as the theme gave it rather than guessed.
  for (const color of ["white", "#ffff", "rgb(300, 0, 0)", "var(--fg)", ""]) assert.equal(pendingColor(color), color, color);
});

// A one-line buffer holding `line` with the caret at `column`.
const buffer = (line, column) => ({
  baseY: 0, cursorY: 0, cursorX: column,
  getLine: () => ({ getCell: (x) => ({ getChars: () => (x < line.length ? line[x] : "") }) }),
});

test("dictated words after a word start with a space instead of running into it", () => {
  assert.equal(separatedFromCaret(buffer("> Bu ve", 7), "üst kısmında"), " üst kısmında");
  // After a space, at the line start, after the prompt's space, or text that brings its own: as is.
  assert.equal(separatedFromCaret(buffer("> Bu ve ", 8), "üst"), "üst");
  assert.equal(separatedFromCaret(buffer("", 0), "üst"), "üst");
  assert.equal(separatedFromCaret(buffer("> ", 2), "üst"), "üst");
  assert.equal(separatedFromCaret(buffer("> Bu ve", 7), " sonra"), " sonra");
  assert.equal(separatedFromCaret(buffer("> Bu ve", 7), ""), "");
  // An empty cell before the caret (nothing written there) is not a word.
  assert.equal(separatedFromCaret(buffer("> Bu", 6), "ve"), "ve");
});
