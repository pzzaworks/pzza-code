import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createServer } from 'vite';
import react from '@vitejs/plugin-react';
import { transform } from 'esbuild';

// Supply an installed browser runtime/executable to run real isolated UI tests.
// No browser profile, app state, device credentials or live backend is reused.
let chromium;
try { ({ chromium } = await import(process.env.PZZA_BROWSER_MODULE ? pathToFileURL(resolve(process.env.PZZA_BROWSER_MODULE)).href : 'playwright')); } catch { /* Optional local browser harness. */ }
const root = fileURLToPath(new URL('..', import.meta.url));
const fixture = `
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Modal } from '/src/ui/Modal';
import { confirmAction, ConfirmationHost } from '/src/ui/ConfirmDialog';
import { FilePicker } from '/src/panels/FilePicker';
import { PathField } from '/src/ui/PathField';
import { SettingsMenu } from '/src/panels/SettingsMenu';
import { ThemeProvider } from '/src/theme/ThemeProvider';
import { useStore } from '/src/state/store';
import { registerUnsavedDraft, confirmUnsavedWork, hasUnsavedWork } from '/src/state/unsavedWork';
import { registerEditorFile, registerEditorDiscard } from '/src/editorChanges';
import { SessionMenu } from '/src/panels/SessionMenu';
import { WorkspaceTabs } from '/src/grid/WorkspaceTabs';
import { UsageSpend } from '/src/panels/UsageSpend';
import { McpMenu } from '/src/panels/McpMenu';
import { confirmAppControlAction } from '/src/appControlCore';
import '/src/styles/global.css';
import '/src/panels/SettingsHub.css';
const app = createRoot(document.getElementById('root'));
window.ui = { answers: [], picks: [], useStore, confirmAppControlAction, confirmUnsavedWork, hasUnsavedWork, registerUnsavedDraft, registerEditorFile, registerEditorDiscard, unmount: () => app.unmount() };
function Dialogs() {
  const [open, setOpen] = useState(true);
  return <><ConfirmationHost /><Modal open={open} title="Outer dialog" onClose={() => setOpen(false)}>
    <button id="queue" onClick={() => { Promise.all([confirmAction({ title:'First decision', message:'Remove the first item?', danger:true }), confirmAction({ title:'Second decision', message:'Remove the second item?', danger:true })]).then(answers => window.ui.answers = answers); }}>Queue decisions</button>
  </Modal></>;
}
function Pending() {
  const [pending, setPending] = useState(true); const [open, setOpen] = useState(true);
  window.ui.finish = () => setPending(false);
  return <Modal open={open} title="Saving" pending={pending} onClose={() => setOpen(false)}><button>Work</button></Modal>;
}
function Picker() {
  const [open, setOpen] = useState(true);
  return <FilePicker open={open} onClose={() => setOpen(false)} mode="folder" start={new URLSearchParams(location.search).get('start') ?? undefined} host="alpha" hosts={[{ host:'alpha', label:'Alpha' }, { host:'beta', label:'Beta' }]} onPick={(path, host) => window.ui.picks.push({path,host})} />;
}
function Path() {
  const [disabled, setDisabled] = useState(false); window.ui.disable = () => setDisabled(true);
  return <PathField value="" host="alpha" fixedHost disabled={disabled} hosts={[{ host:'alpha', label:'Alpha' },{host:'beta',label:'Beta'}]} onChange={(path,host) => window.ui.picks.push({path,host})} />;
}
function Appearance() {
  return <div className="modal settings-hub" style={{ height:'auto', maxHeight:'95vh' }}><div className="settings-hub-content"><SettingsMenu section="appearance" />
    <h3 className="set-title" id="heading">Heading</h3><p id="body">Body text</p><p className="set-note" id="secondary">Secondary text</p>
    <span id="status-dot" style={{ display:'inline-block', width:8, height:8, background:'var(--success)' }} />
    <button className="btn" id="ghost">Ordinary action</button>
    <button className="btn btn-accent" id="accent">Action<svg id="action-icon" width="16" height="16" stroke="currentColor"><path d="M0 0L16 16" /></svg></button>
  </div></div>;
}
function Creation() {
  return <div className="app"><header className="topbar"><div className="brand">Example</div><WorkspaceTabs /><div className="topbar-right" /></header>
  {new URLSearchParams(location.search).get('form') === 'session' ? <Modal open title="New session" size="md" className="creation-dialog" onClose={() => {}}><SessionMenu close={() => {}} /></Modal> : null}</div>;
}
function Usage() {
  const known = { day:'2026-09-01', cost:1, pricedCost:1, tokens:1000, unpricedTokens:0, unpricedModels:[] };
  const unknown = { day:'2026-09-02', cost:null, pricedCost:0, tokens:250, unpricedTokens:250, unpricedModels:['unpriced-model'] };
  const partial = { day:'2026-09-03', cost:null, pricedCost:0.25, tokens:500, unpricedTokens:250, unpricedModels:['unpriced-model'] };
  const empty = { day:'2026-09-04', cost:0, pricedCost:0, tokens:0, unpricedTokens:0, unpricedModels:[] };
  return <div className="menu menu-panel" style={{ position:'relative', width:420, margin:24 }}><UsageSpend color="var(--success)" spend={{ today:unknown, yesterday:known, window:partial, days:[known,unknown,partial,empty] }} /></div>;
}
const mode = new URLSearchParams(location.search).get('mode');
app.render(<ThemeProvider>{mode === 'dialogs' ? <Dialogs /> : mode === 'pending' ? <Pending /> : mode === 'picker' ? <Picker /> : mode === 'path' ? <Path /> : mode === 'appearance' ? <Appearance /> : mode === 'creation' ? <Creation /> : mode === 'usage' ? <Usage /> : mode === 'mcp' ? <><ConfirmationHost /><McpMenu /></> : <ConfirmationHost />}</ThemeProvider>);
`;
let server, browser, origin, scratch;
before(async () => {
  if (!chromium) return;
  scratch = await mkdtemp(join(tmpdir(), 'pzza-ui-safety-'));
  server = await createServer({ root, configFile: false, logLevel: 'error', cacheDir: join(scratch, 'vite'), define: { __APP_VERSION__: JSON.stringify('test') }, plugins: [react(), {
    name: 'ui-safety-fixture',
    resolveId(id) { if (id === '/__ui_fixture.jsx') return '\0ui-safety-fixture.jsx'; },
    async load(id) { if (id === '\0ui-safety-fixture.jsx') return (await transform(fixture, { loader: 'jsx', jsx: 'automatic', format: 'esm' })).code; },
    configureServer(instance) { instance.middlewares.use((req, res, next) => { if (!req.url?.startsWith('/__ui_test')) return next(); res.setHeader('Content-Type', 'text/html'); void instance.transformIndexHtml(req.url, '<!doctype html><html><head></head><body><div id="root"></div><script type="module" src="/__ui_fixture.jsx"></script></body></html>').then(html => res.end(html), next); }); },
  }], server: { host: '127.0.0.1', port: 0, hmr: false } });
  await server.listen();
  origin = server.resolvedUrls.local[0];
  browser = await chromium.launch({ headless: true, ...(process.env.PZZA_BROWSER_EXECUTABLE ? { executablePath: process.env.PZZA_BROWSER_EXECUTABLE } : {}) });
});
after(async () => { await browser?.close(); await server?.close(); if (scratch) await rm(scratch, { recursive: true, force: true }); });
const options = { skip: !chromium, timeout: 25000 };
async function pageFor(t, mode, extra = '') {
  const context = await browser.newContext({ viewport: { width: 900, height: 700 } });
  t.after(() => context.close());
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  await page.route('**/*', route => {
    const url = new URL(route.request().url());
    if (url.origin === new URL(origin).origin || ['data:', 'blob:'].includes(url.protocol)) return route.continue();
    return route.fulfill({ status: 503, headers: { 'Access-Control-Allow-Origin': '*' }, body: '{}' });
  });
  await page.goto(`${origin}__ui_test?mode=${mode}${extra}`);
  await page.waitForFunction(() => !!window.ui);
  return page;
}
async function evidence(page, name) {
  if (!process.env.PZZA_UI_EVIDENCE_ROOT) return;
  await mkdir(process.env.PZZA_UI_EVIDENCE_ROOT, { recursive: true });
  await page.screenshot({ path: join(process.env.PZZA_UI_EVIDENCE_ROOT, name + '.png'), fullPage: true, animations: 'disabled' });
}

test('queued confirmations default to Cancel, trap focus, restore focus and close only the top dialog', options, async t => {
  const page = await pageFor(t, 'dialogs');
  await page.locator('#queue').click();
  await page.getByRole('alertdialog', { name: 'First decision' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Confirm');
  await page.keyboard.press('Tab');
  assert.equal(await page.evaluate(() => document.activeElement.getAttribute('aria-label')), 'Close');
  await page.getByRole('alertdialog').evaluate(async element => { await Promise.all(element.parentElement.getAnimations({ subtree: true }).map(animation => animation.finished.catch(() => {}))); });
  assert.equal(await page.getByRole('alertdialog').evaluate(element => [...element.querySelectorAll('.modal-title, button')].every(target => { const box = target.getBoundingClientRect(); return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)); })), true);
  await evidence(page, 'confirmation-focus');
  await page.keyboard.press('Escape');
  await page.getByRole('alertdialog', { name: 'Second decision' }).waitFor();
  assert.equal(await page.evaluate(() => document.activeElement.textContent), 'Cancel');
  assert.equal(await page.getByRole('dialog', { name: 'Outer dialog' }).count(), 1);
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.waitForFunction(() => window.ui.answers.length === 2);
  assert.deepEqual(await page.evaluate(() => window.ui.answers), [false, true]);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'queue');
});

test('pending dialogs refuse Escape/backdrop and host teardown resolves every queued request', options, async t => {
  const page = await pageFor(t, 'pending');
  assert.equal(await page.getByRole('button', { name: 'Close', exact: true }).isDisabled(), true);
  await page.keyboard.press('Escape');
  await page.mouse.click(5, 5);
  assert.equal(await page.getByRole('dialog', { name: 'Saving' }).count(), 1);
  await page.evaluate(() => window.ui.finish());
  await page.waitForFunction(() => !document.querySelector('[aria-label="Close"]').disabled);
  await page.keyboard.press('Escape');
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  await page.goto(`${origin}__ui_test?mode=dialogs`);
  await page.locator('#queue').click();
  await page.evaluate(() => window.ui.unmount());
  await page.waitForFunction(() => window.ui.answers.length === 2);
  assert.deepEqual(await page.evaluate(() => window.ui.answers), [false, false]);
});

test('picker binds the path to the host and ignores delayed requests after switching', options, async t => {
  const page = await pageFor(t, 'none');
  let alpha;
  await page.route('**/fs/list**', route => {
    const host = new URL(route.request().url()).searchParams.get('host');
    if (host === 'alpha') { alpha = route; return; }
    return route.fulfill({ json: { path: '/home/beta', parent: '/home', entries: [] }, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto(`${origin}__ui_test?mode=picker`);
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Use this folder' }).isDisabled(), true);
  await page.locator('.cselect').click();
  await page.locator('.cselect-item').filter({ hasText: 'Beta' }).click();
  await page.waitForFunction(() => !document.querySelector('.fp-foot .btn-accent').disabled);
  if (alpha) await alpha.fulfill({ json: { path: '/home/alpha', parent: '/home', entries: [] }, headers: { 'Access-Control-Allow-Origin': '*' } }).catch(() => {});
  await page.getByRole('button', { name: 'Use this folder' }).click();
  assert.deepEqual(await page.evaluate(() => window.ui.picks), [{ path: '/home/beta', host: 'beta' }]);
});

test('picker access errors never silently choose home and fixed/disabled paths cannot cross devices', options, async t => {
  const page = await pageFor(t, 'none');
  const requests = [];
  await page.route('**/fs/list**', route => {
    const url = new URL(route.request().url()); requests.push(url.searchParams.get('path'));
    return route.fulfill({ status: 403, json: { error: 'Access denied' }, headers: { 'Access-Control-Allow-Origin': '*' } });
  });
  await page.goto(`${origin}__ui_test?mode=picker&start=/forbidden`);
  await page.getByRole('alert').waitFor();
  assert.equal(await page.getByRole('button', { name: 'Use this folder' }).isDisabled(), true);
  assert.deepEqual(requests, ['/forbidden']);
  await evidence(page, 'picker-access-denied');
  await page.goto(`${origin}__ui_test?mode=path`);
  await page.locator('.path-field').click();
  await page.getByRole('dialog').waitFor();
  assert.equal(await page.locator('.fp-host').count(), 0);
  await page.evaluate(() => window.ui.disable());
  await page.getByRole('dialog').waitFor({ state: 'detached' });
  assert.equal(await page.locator('.path-field').isDisabled(), true);
});

test('unsaved settings and editor saves guard exit without discarding drafts', options, async t => {
  const page = await pageFor(t, 'none');
  await page.evaluate(() => {
    window.ui.draft = { label: 'Settings draft', dirty: true, saving: true, revision: 1 };
    window.ui.stopDraft = window.ui.registerUnsavedDraft('test', () => window.ui.draft);
  });
  assert.equal(await page.evaluate(() => window.ui.confirmUnsavedWork()), false);
  await page.evaluate(() => { window.ui.draft.saving = false; window.ui.confirmUnsavedWork().then(answer => window.ui.answer = answer); });
  await page.getByRole('alertdialog').waitFor();
  await page.evaluate(() => { window.ui.draft.revision++; });
  await page.getByRole('button', { name: 'Discard and continue' }).click();
  await page.waitForFunction(() => window.ui.answer !== undefined);
  assert.equal(await page.evaluate(() => window.ui.answer), false);
  assert.equal(await page.evaluate(() => window.ui.draft.dirty), true);
  await page.evaluate(() => { window.ui.stopDraft(); window.ui.stopFile = window.ui.registerEditorFile('editor', () => ({ dirty: false, saving: true })); });
  assert.equal(await page.evaluate(() => window.ui.confirmUnsavedWork()), false);
});

test('text visibility changes real labels/icons in both themes, preserves hierarchy and persists safely', options, async t => {
  const page = await pageFor(t, 'appearance');
  assert.equal(await page.getByRole('slider', { name: 'Text visibility' }).count(), 0);
  await page.getByRole('switch', { name: 'Semi-transparent mode' }).click();
  const sample = () => page.evaluate(() => Object.fromEntries(['heading', 'body', 'secondary', 'ghost', 'accent', 'action-icon'].map(id => [id, getComputedStyle(document.getElementById(id)).color])));
  const baseline = await sample();
  const statusFill = await page.locator('#status-dot').evaluate(element => getComputedStyle(element).backgroundColor);
  await page.evaluate(() => window.ui.useStore.getState().setTransparencyOptions({ textVisibility: 75 }));
  await page.waitForFunction(() => document.documentElement.dataset.textVisibility === 'on');
  const dark = await sample();
  const channel = color => Number(color.match(/\d+/)[0]);
  assert.ok(channel(dark.body) > channel(baseline.body));
  assert.ok(channel(dark.heading) > channel(dark.body));
  assert.ok(channel(dark.body) > channel(dark.secondary));
  assert.equal(dark.accent, dark['action-icon']);
  assert.equal(await page.locator('#status-dot').evaluate(element => getComputedStyle(element).backgroundColor), statusFill);
  assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('pzza.transparencyOptions')).textVisibility), 75);
  await evidence(page, 'text-visibility-dark');
  await page.evaluate(() => window.ui.useStore.getState().setTransparencyOptions({ textVisibility: 100 }));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('body')).color === 'rgb(255, 255, 255)');
  assert.equal(await page.locator('#status-dot').evaluate(element => getComputedStyle(element).backgroundColor), statusFill);
  await page.evaluate(() => { window.ui.useStore.getState().setTransparencyOptions({ textVisibility: 75 }); window.ui.useStore.getState().setTheme('light'); });
  await page.waitForFunction(() => document.documentElement.dataset.appearance === 'light');
  await page.locator('#accent').evaluate(async element => { await Promise.all(element.getAnimations().map(animation => animation.finished.catch(() => {}))); });
  const light = await sample();
  assert.ok(channel(light.heading) < channel(light.body));
  assert.ok(channel(light.body) < channel(light.secondary));
  assert.ok(channel(light.ghost) < 30);
  assert.equal(light.accent, 'rgb(255, 255, 255)', 'Inverse controls retain contrast-safe text');
  assert.equal(light.accent, light['action-icon']);
  assert.equal(await page.locator('#accent').evaluate(element => getComputedStyle(element).backgroundColor), 'rgb(9, 105, 218)');
  await evidence(page, 'text-visibility-light');
  await page.evaluate(() => window.ui.useStore.getState().setTransparencyOptions({ textVisibility: 100 }));
  await page.waitForFunction(() => getComputedStyle(document.getElementById('body')).color === 'rgb(0, 0, 0)');
  await page.getByRole('switch', { name: 'Semi-transparent mode' }).click();
  assert.equal((await sample()).body, 'rgb(31, 35, 40)');
  assert.equal(await page.evaluate(() => window.ui.useStore.getState().transparencyOptions.textVisibility), 100);
});

test('fresh app window control is off and enabling requires an explicit local confirmation', options, async t => {
  const page = await pageFor(t, 'mcp');
  const control = page.getByRole('switch', { name: 'Allow app window control' });
  assert.equal(await control.getAttribute('aria-checked'), 'false');
  await control.click();
  await page.getByRole('alertdialog', { name: 'Allow app window control?' }).waitFor();
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  assert.equal(await control.getAttribute('aria-checked'), 'false');
  assert.equal(await page.evaluate(() => localStorage.getItem('pzza.mcp.enabled')), null);
  await control.click();
  await page.getByRole('button', { name: 'Allow window control', exact: true }).click();
  await page.waitForFunction(() => localStorage.getItem('pzza.mcp.enabled') === '1');
  await page.reload();
  await control.waitFor();
  assert.equal(await control.getAttribute('aria-checked'), 'true');
});

test('destructive app-control preflight waits for local approval and rejects pending drafts', options, async t => {
  const page = await pageFor(t, 'none');
  await page.evaluate(() => {
    window.ui.useStore.getState().addWorkspace('Disposable workspace');
    const workspaceId = window.ui.useStore.getState().workspaces.find(item => item.name === 'Disposable workspace').id;
    window.ui.confirmAppControlAction('delete_workspace', { workspaceId }).then(answer => window.ui.answer = answer);
  });
  await page.getByRole('alertdialog', { name: 'Delete workspace?' }).waitFor();
  assert.equal(await page.evaluate(() => window.ui.answer), undefined);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.waitForFunction(() => window.ui.answer === false);
  assert.equal(await page.evaluate(() => window.ui.useStore.getState().workspaces.some(item => item.name === 'Disposable workspace')), true);
  const refused = await page.evaluate(async () => {
    const stop = window.ui.registerUnsavedDraft('settings', () => ({ label:'Settings', dirty:true, saving:true }));
    try { await window.ui.confirmAppControlAction('relaunch_app', {}); return false; } catch { return true; } finally { stop(); }
  });
  assert.equal(refused, true);
  assert.equal(await page.getByRole('alertdialog').count(), 0);
});

test('usage bars reflect measured tokens and expose honest daily estimates', options, async t => {
  const page = await pageFor(t, 'usage');
  await page.getByRole('img', { name: /Daily token usage/ }).waitFor();
  const bars = await page.locator('.usage-trend-bar').evaluateAll(elements => elements.map(element => ({ height: element.style.height, border: getComputedStyle(element).borderTopStyle, pixels: element.getBoundingClientRect().height })));
  assert.deepEqual(bars.map(bar => bar.height), ['100%', '25%', '50%', '0%']);
  assert.ok(bars.every(bar => bar.border !== 'dashed'));
  assert.ok(Math.abs(bars[1].pixels / bars[0].pixels - 0.25) < 0.03);
  assert.equal(bars[3].pixels, 0);
  await page.getByText('Daily breakdown', { exact: true }).click();
  await page.getByRole('table').waitFor();
  assert.equal(await page.getByRole('cell', { name: 'Unavailable', exact: true }).count(), 1);
  assert.equal(await page.getByRole('cell', { name: '$0.25+ (partial)', exact: true }).count(), 1);
  const note = page.getByRole('note');
  assert.equal(await note.textContent(), 'API estimate (short context), not billed spend.');
  const typography = await note.evaluate(element => ({ size: getComputedStyle(element).fontSize, color: getComputedStyle(element).color, iconColor: getComputedStyle(element.querySelector('svg')).color, surrounding: getComputedStyle(document.querySelector('.usage-daily-details')).fontSize, row: getComputedStyle(document.querySelector('.usage-detail-row')).fontSize }));
  assert.equal(typography.size, '11px');
  assert.equal(typography.size, typography.surrounding);
  assert.ok(parseFloat(typography.size) < parseFloat(typography.row));
  assert.equal(typography.color, typography.iconColor);
  await evidence(page, 'usage-daily-breakdown');
  await evidence(page, 'usage-info-dark');
  await page.evaluate(() => { window.ui.useStore.getState().setTheme('light'); window.ui.useStore.getState().setSemiTransparent(true); window.ui.useStore.getState().setTransparencyOptions({ textVisibility: 75 }); });
  await page.waitForFunction(() => document.documentElement.dataset.appearance === 'light' && document.documentElement.dataset.textVisibility === 'on');
  assert.equal(await note.evaluate(element => getComputedStyle(element).color), await page.locator('.usage-daily-details').evaluate(element => getComputedStyle(element).color));
  await evidence(page, 'usage-info-light');
});

test('creation forms keep consistent widths and reachable actions on short narrow viewports', options, async t => {
  const page = await pageFor(t, 'creation', '&form=session');
  await page.setViewportSize({ width: 390, height: 440 });
  await page.getByRole('textbox', { name: 'New session name' }).fill('local-check');
  const sessionBox = await page.locator('.creation-dialog').boundingBox();
  assert.ok(sessionBox.x >= 0 && sessionBox.x + sessionBox.width <= 390);
  assert.ok(sessionBox.y >= 0 && sessionBox.y + sessionBox.height <= 440);
  await evidence(page, 'new-session-narrow');
  await page.goto(`${origin}__ui_test?mode=creation`);
  await page.getByRole('button', { name: 'New workspace', exact: true }).click();
  await page.locator('.ws-chip-name').fill('local-check');
  await page.getByRole('button', { name: 'Icon & color' }).click();
  await page.getByRole('button', { name: 'Add workspace' }).scrollIntoViewIfNeeded();
  const panelBox = await page.locator('.new-workspace-panel').boundingBox();
  const actionBox = await page.getByRole('button', { name: 'Add workspace' }).boundingBox();
  assert.ok(panelBox.x >= 0 && panelBox.x + panelBox.width <= 390);
  assert.ok(actionBox.y >= 0 && actionBox.y + actionBox.height <= 440);
  await evidence(page, 'new-workspace-narrow');
});
