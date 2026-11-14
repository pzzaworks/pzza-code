import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ entryPoints: ["src/terminal/dictationComposition.ts"], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent", external: ["@xterm/xterm"] });
const { commonPrefixLength, pendingColor, separatedFromCaret } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

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
  assert.equal(separatedFromCaret(buffer("> Open the", 10), "settings page"), " settings page");
  // After a space, at the line start, after the prompt's space, or text that brings its own: as is.
  assert.equal(separatedFromCaret(buffer("> Open the ", 11), "menu"), "menu");
  assert.equal(separatedFromCaret(buffer("", 0), "menu"), "menu");
  assert.equal(separatedFromCaret(buffer("> ", 2), "menu"), "menu");
  assert.equal(separatedFromCaret(buffer("> Open the", 10), " menu"), " menu");
  assert.equal(separatedFromCaret(buffer("> Open the", 10), ""), "");
  // An empty cell before the caret (nothing written there) is not a word.
  assert.equal(separatedFromCaret(buffer("> Open", 8), "menu"), "menu");
});

test("only the text that changed since the last render counts as new", () => {
  assert.equal(commonPrefixLength("Listening", "Transcribing"), 0);
  assert.equal(commonPrefixLength("open the menu ", "open the menu and the bar "), 14);
  assert.equal(commonPrefixLength("", "new"), 0);
  assert.equal(commonPrefixLength("café", "café"), 4);
  // Characters, not UTF-16 units: an emoji counts once.
  assert.equal(commonPrefixLength("ok 👍 done", "ok 👍 next"), 5);
});
