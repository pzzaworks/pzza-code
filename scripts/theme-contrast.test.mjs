import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

const moduleUrl = source => 'data:text/javascript;base64,' + Buffer.from(ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText).toString('base64');
const typesUrl = moduleUrl(readFileSync(new URL('../src/theme/types.ts', import.meta.url), 'utf8'));
const { deriveChrome, contrastRatio, textVisibilityVars, luminance } = await import(typesUrl);
const themesSource = readFileSync(new URL('../src/theme/themes.ts', import.meta.url), 'utf8').replaceAll('"./types"', JSON.stringify(typesUrl));
const { BUILTIN_THEMES, terminalPalette } = await import(moduleUrl(themesSource));
const light = BUILTIN_THEMES.find(theme => theme.appearance === 'light');
const chrome = deriveChrome(light.terminal, 'light');

test('light text and semantic statuses remain readable on every routine surface', () => {
  for (const role of ['text', 'muted', 'success', 'warning', 'danger']) {
    for (const surface of ['bg', 'surface', 'surfaceAlt', 'hover', 'input']) {
      const ratio = contrastRatio(chrome[role], chrome[surface]);
      assert.ok(ratio >= 4.5, `${role} on ${surface}: ${ratio.toFixed(2)}:1`);
    }
  }
  assert.ok(contrastRatio(chrome.accentText, chrome.accent) >= 4.5);
  assert.ok(contrastRatio(chrome.selectedText, chrome.selected) >= 4.5);
});

test('light input boundaries and focus rings remain identifiable', () => {
  assert.ok(contrastRatio(chrome.controlBorder, chrome.input) >= 3);
  for (const surface of ['bg', 'surface', 'surfaceAlt']) assert.ok(contrastRatio(chrome.focusRing, chrome[surface]) >= 3);
});

test('all light terminal text colors meet normal-text contrast', () => {
  for (const [role, color] of Object.entries(light.terminal)) {
    if (['background', 'cursorAccent', 'selectionBackground'].includes(role)) continue;
    assert.ok(contrastRatio(color, light.terminal.background) >= 4.5, role);
  }
});

test('visibility defaults preserve text colors and the bounded boost retains text hierarchy', () => {
  for (const theme of BUILTIN_THEMES) {
    const palette = deriveChrome(theme.terminal, theme.appearance);
    const baseline = textVisibilityVars(palette, theme.appearance, 0);
    assert.equal(baseline['--text'], palette.text);
    assert.equal(baseline['--muted'], palette.muted);
    assert.deepEqual(textVisibilityVars(palette, theme.appearance, NaN), baseline);
    assert.deepEqual(textVisibilityVars(palette, theme.appearance, -50), baseline);
    const extreme = theme.appearance === 'dark' ? '#ffffff' : '#000000';
    const boosted = textVisibilityVars(palette, theme.appearance, 75);
    for (const fill of ['--success', '--warning', '--danger', '--accent', '--selected', '--surface']) assert.equal(Object.hasOwn(boosted, fill), false, `Visibility must not change ${fill}`);
    const heading = luminance(boosted['--heading-text']);
    const body = luminance(boosted['--text']);
    const secondary = luminance(boosted['--muted']);
    assert.ok(theme.appearance === 'dark' ? heading > body && body > secondary : heading < body && body < secondary);
    for (const key of ['--heading-text', '--text', '--muted', '--selected-text', '--accent-foreground']) assert.equal(textVisibilityVars(palette, theme.appearance, 120)[key], extreme);
  }
});

test('native Help and in-app topics stay in sync', () => {
  const ui = readFileSync(new URL('../src/panels/HelpModal.tsx', import.meta.url), 'utf8');
  const native = readFileSync(new URL('../src-tauri/src/menu.rs', import.meta.url), 'utf8');
  const sections = [...ui.matchAll(/id: "([\w-]+)",\s*label: "([^"]+)",\s*icon:/g)];
  assert.equal(sections.length, 17);
  for (const [, id, label] of sections) assert.ok(native.includes(`("${id}", "${label}")`), `Missing native Help topic: ${id}`);
});

test('transparent terminals preserve the appearance used for contrast and color queries', () => {
  for (const theme of BUILTIN_THEMES) {
    const glass = terminalPalette(theme.id, true);
    assert.equal(glass.background, theme.terminal.background + '00');
    assert.equal(glass.foreground, theme.terminal.foreground);
    assert.deepEqual(terminalPalette(theme.id, false), theme.terminal);
  }
  assert.equal(terminalPalette('light', true).background, '#ffffff00');
});
