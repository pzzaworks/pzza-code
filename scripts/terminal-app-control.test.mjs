import test from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { build } from 'esbuild';
const output = await build({ entryPoints: [new URL('../src/appControlTerminal.ts', import.meta.url).pathname], bundle: true, platform: 'browser', format: 'esm', write: false });
const { createTerminalAppController, redactTerminalOutput } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);
function fixture() {
  const state = { connected: true, cols: 80, rows: 24, bufferLines: 2, viewportY: 0, hasSelection: false, bracketedPasteMode: false };
  const writes = []; let lines = ['first', 'last']; let selection = 'selected'; let copied = false;
  const controller = createTerminalAppController({ state: () => ({ ...state }), lines: () => lines, selection: () => selection,
    paste: async text => { writes.push({ paste: text }); }, sendControl: async key => { writes.push({ key }); }, pasteClipboard: async () => {},
    copy: async () => { copied = true; }, selectAll: () => { state.hasSelection = true; }, clearSelection: () => { state.hasSelection = false; }, clear: () => { lines = []; }, scroll: (_, count) => { state.viewportY += count; },
  });
  return { state, writes, controller, lines: value => { lines = value; }, selection: value => { selection = value; }, copied: () => copied };
}
test('terminal text insertion never submits and multiline/control input fails before transport', async () => {
  const f = fixture();
  assert.deepEqual(await f.controller.execute('terminal_input', { text: 'printf ready' }), { inserted: 12 });
  assert.deepEqual(f.writes, [{ paste: 'printf ready' }]);
  for (const text of ['first\nsecond', '\u001b[31m', '\r', '\t']) await assert.rejects(f.controller.execute('terminal_input', { text }));
  await assert.rejects(f.controller.execute('terminal_input', { text: '界'.repeat(22000) }), /64 KiB/);
  await assert.rejects(f.controller.execute('terminal_paste', { text: 'first\nsecond' }), /bracketed paste/);
  f.state.bracketedPasteMode = true;
  await f.controller.execute('terminal_paste', { text: 'first\nsecond' });
  await f.controller.execute('terminal_submit', {});
  assert.deepEqual(f.writes.at(-1), { key: '\r' });
  await f.controller.execute('terminal_key', { key: 'interrupt' });
  assert.deepEqual(f.writes.at(-1), { key: '\x03' });
  f.state.connected = false;
  await assert.rejects(f.controller.execute('terminal_submit', {}), /disconnected/);
});
test('terminal output and selection redact credential shapes before pagination and clipping', async () => {
  const f = fixture();
  const credential = crypto.randomBytes(36).toString('base64url');
  f.lines(['ordinary output', `ACCESS_TOKEN=${credential}`, '-----BEGIN PRIVATE KEY-----', credential, '-----END PRIVATE KEY-----', `https://user:${credential}@example.test/path`]);
  const read = await f.controller.execute('terminal_read_output', { startLine: 1, lines: 5, maxChars: 1000 });
  assert.equal(read.redacted, true); assert.ok(!read.text.includes(credential)); assert.ok(read.text.includes('[REDACTED]'));
  f.selection(`authorization: Bearer ${credential}`);
  const selected = await f.controller.execute('terminal_read_selection', {});
  assert.ok(!selected.text.includes(credential));
  assert.ok(!JSON.stringify(f.controller.state()).includes(credential));
  assert.equal(redactTerminalOutput('ordinary output').redacted, false);
});
test('terminal selection, clipboard and scrolling affect only the mounted surface and bounded reads reject invalid ranges', async () => {
  const f = fixture();
  await f.controller.execute('terminal_select_all', {}); assert.equal(f.state.hasSelection, true);
  assert.deepEqual(await f.controller.execute('terminal_copy', {}), { copied: true }); assert.equal(f.copied(), true);
  await f.controller.execute('terminal_clear_selection', {}); assert.equal(f.state.hasSelection, false);
  await f.controller.execute('terminal_scroll', { target: 'relative', lines: 7 }); assert.equal(f.state.viewportY, 7);
  await assert.rejects(f.controller.execute('terminal_scroll', { target: 'relative' }), /line count/);
  await assert.rejects(f.controller.execute('terminal_read_output', { startLine: 100 }), /outside/);
  await f.controller.execute('terminal_clear', {});
  assert.equal((await f.controller.execute('terminal_read_output', {})).text, ''); assert.equal(f.writes.length, 0);
});
