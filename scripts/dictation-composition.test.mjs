import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({ entryPoints: [new URL('../src/terminal/dictationComposition.ts', import.meta.url).pathname], bundle: true, format: 'esm', write: false });
const { createDictationComposition } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function fixture() {
  class Element {
    style = {}; children = []; hidden = false; textContent = '';
    setAttribute() {} appendChild(child) { this.children.push(child); } remove() { this.removed = true; }
    getBoundingClientRect() { return { width: 600, height: 200 }; }
  }
  const screen = new Element(); const handlers = new Map(); const frames = new Map(); let nextFrame = 0;
  const event = name => callback => { if (!handlers.has(name)) handlers.set(name, new Set()); handlers.get(name).add(callback); return { dispose() { handlers.get(name).delete(callback); } }; };
  globalThis.requestAnimationFrame = callback => { frames.set(++nextFrame, callback); return nextFrame; };
  globalThis.cancelAnimationFrame = id => frames.delete(id);
  globalThis.document = { createElement: () => new Element() };
  const buffer = { type: 'normal', baseY: 0, cursorY: 0, viewportY: 0, cursorX: 8 };
  const markers = [];
  const terminal = { cols: 30, rows: 10, element: { querySelector: () => screen }, options: { fontFamily: 'monospace', fontSize: 16, fontWeight: 'normal', letterSpacing: 0 }, buffer: { active: buffer, onBufferChange: event('buffer') },
    onCursorMove: event('cursor'), onResize: event('resize'), onScroll: event('scroll'), onRender: event('render'), onWriteParsed: event('parsed'),
    registerMarker() { const callbacks = new Set(); const marker = { line: buffer.baseY + buffer.cursorY, onDispose(callback) { callbacks.add(callback); return { dispose() { callbacks.delete(callback); } }; }, dispose() { for (const callback of [...callbacks]) callback(); callbacks.clear(); } }; markers.push(marker); return marker; },
  };
  const composition = createDictationComposition(terminal);
  const paint = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(); };
  return { composition, buffer, markers, paint, fire: name => { for (const callback of handlers.get(name) ?? []) callback(); }, layer: () => screen.children.at(-1), pending: () => frames.size };
}
test('composition revisions remain view-only and an empty pending suffix retains the parsed-echo barrier', () => {
  const f = fixture();
  f.composition.preview('old partial'); f.paint();
  f.composition.preview('revised partial'); f.paint(); assert.equal(f.layer().children[0].textContent, 'revised partial');
  f.composition.beginConfirmedWrite(); f.composition.preview(''); f.composition.preview(' pending'); f.paint(); assert.equal(f.layer().hidden, true);
  f.fire('parsed'); f.paint(); assert.equal(f.layer().hidden, false);
  f.composition.clear(); assert.equal(f.layer().hidden, true);
  f.composition.dispose(); assert.equal(f.layer().removed, true);
});
test('composition follows TUI cursor geometry, stays bounded at delayed bottom wrap, and clears with a disposed normal marker', () => {
  const f = fixture();
  f.buffer.type = 'alternate'; f.buffer.cursorY = 3; f.buffer.cursorX = 4;
  f.composition.preview('Merhaba world'); f.paint(); assert.equal(f.layer().style.top, '60px'); assert.equal(f.layer().style.textIndent, '80px');
  f.buffer.cursorX = 30; f.buffer.cursorY = 9; f.fire('cursor'); f.paint();
  assert.equal(f.layer().hidden, false); assert.equal(f.layer().style.transform, 'translateY(-100%)'); assert.equal(f.layer().style.maxHeight, '60px');
  f.composition.suspend(true); assert.equal(f.layer().hidden, true); f.composition.suspend(false); f.paint(); assert.equal(f.layer().hidden, false);
  f.buffer.type = 'normal'; f.buffer.cursorX = 1; f.buffer.cursorY = 2; f.fire('buffer'); f.paint();
  f.markers.at(-1).dispose(); assert.equal(f.layer().hidden, true);
  f.composition.dispose(); f.fire('cursor'); assert.equal(f.pending(), 0);
});
