import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';
const output = await build({ stdin: { contents: 'export * from "./src/state/unsavedWork"; export * from "./src/state/confirmations"; export * from "./src/editorChanges";', resolveDir: new URL('..', import.meta.url).pathname }, bundle: true, platform: 'node', format: 'esm', write: false });
const api = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString('base64')}`);

test('queued confirmation answers cannot settle a later request and teardown cancels every waiter', async () => {
  const stop = api.mountConfirmationHost();
  const first = api.confirmAction({ title: 'First', message: 'First decision' });
  const original = api.currentConfirmation();
  const second = api.confirmAction({ title: 'Second', message: 'Second decision' });
  api.answerConfirmation(original, true);
  api.answerConfirmation(original, true);
  assert.equal(await first, true);
  assert.equal(api.currentConfirmation().title, 'Second');
  stop();
  assert.equal(await second, false);
  assert.equal(api.currentConfirmation(), null);
});

test('a host effect remount preserves queued requests rather than losing resolvers', async () => {
  const stop = api.mountConfirmationHost();
  const pending = api.confirmAction({ title: 'Decision', message: 'Current decision' });
  stop();
  const finish = api.mountConfirmationHost();
  await Promise.resolve();
  assert.equal(api.currentConfirmation().title, 'Decision');
  api.answerConfirmation(api.currentConfirmation(), false);
  assert.equal(await pending, false);
  finish();
});

test('saving editors and settings block exit without clearing work or opening discard prompts', async () => {
  const stopEditor = api.registerEditorFile('editor', () => ({ saving: true, dirty: true, revision: 1 }));
  assert.equal(api.hasPendingSaves(), true);
  assert.equal(await api.confirmUnsavedWork(), false);
  assert.equal(api.currentConfirmation(), null);
  stopEditor();
  const stopDraft = api.registerUnsavedDraft('draft', () => ({ label: 'Settings', dirty: false, saving: true }));
  assert.equal(api.hasUnsavedWork(), true);
  assert.equal(await api.confirmUnsavedWork(), false);
  stopDraft();
  assert.equal(api.hasUnsavedWork(), false);
});

test('draft edits during confirmation invalidate approval and cancellation retains the draft', async () => {
  const draft = { label: 'Settings', dirty: true, saving: false, revision: 1 };
  const stop = api.registerUnsavedDraft('draft', () => draft);
  try {
    const pending = api.confirmUnsavedWork();
    assert.equal(api.confirmUnsavedWork(), pending);
    draft.revision++;
    api.answerConfirmation(api.currentConfirmation(), true);
    assert.equal(await pending, false);
    assert.equal(draft.dirty, true);
    const cancelled = api.confirmUnsavedWork();
    api.answerConfirmation(api.currentConfirmation(), false);
    assert.equal(await cancelled, false);
    assert.equal(draft.dirty, true);
  } finally { stop(); }
});

test('saving or editing an editor during its exit confirmation prevents discard', async () => {
  const file = { saving: false, dirty: true, revision: 1 };
  const stopFile = api.registerEditorFile('editor', () => file);
  let respond;
  const stopCheck = api.registerEditorDiscard('editor', () => new Promise(resolve => { respond = resolve; }));
  try {
    const pending = api.confirmEditorDiscard();
    file.revision++;
    respond(true);
    assert.equal(await pending, false);
    const saving = api.confirmEditorDiscard();
    file.saving = true;
    respond(true);
    assert.equal(await saving, false);
  } finally { stopFile(); stopCheck(); }
});

test('an old draft registration cleanup cannot remove its replacement', () => {
  const first = api.registerUnsavedDraft('draft', () => ({ label: 'Old', dirty: false }));
  const second = api.registerUnsavedDraft('draft', () => ({ label: 'New', dirty: true }));
  first();
  assert.equal(api.hasUnsavedWork(), true);
  second();
  assert.equal(api.hasUnsavedWork(), false);
});
