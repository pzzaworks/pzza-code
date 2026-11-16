import { useMemo } from "react";
import type { Extension } from "@codemirror/state";
import { tags as t } from "@lezer/highlight";
import { createTheme } from "@uiw/codemirror-themes";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { mix } from "./types";
import type { Theme } from "./types";
import { useActiveTheme } from "./useActiveTheme";

// PzzaCode's own themes keep the GitHub editor colors they were tuned with;
// every other theme gets an editor built from its terminal palette, so code
// reads in the same colors as the terminal next to it.
// Keyed by the colors the editor uses, so renaming a theme or changing its
// background reuses the editor theme; a few recent ones are kept.
const editors = new Map<string, Extension>();
const EDITORS_KEPT = 24;

function paletteEditor(theme: Theme): Extension {
  const p = theme.terminal;
  const light = theme.appearance === "light";
  const comment = light ? mix(p.foreground, p.background, 0.45) : p.brightBlack;
  return createTheme({
    theme: theme.appearance,
    settings: {
      background: p.background,
      foreground: p.foreground,
      caret: p.cursor,
      selection: p.selectionBackground,
      selectionMatch: mix(p.background, p.yellow, 0.22),
      lineHighlight: mix(p.background, p.foreground, light ? 0.04 : 0.05),
      gutterBackground: p.background,
      gutterForeground: mix(p.foreground, p.background, 0.55),
      gutterActiveForeground: p.foreground,
      gutterBorder: "transparent",
    },
    styles: [
      { tag: [t.comment, t.lineComment, t.blockComment, t.docComment], color: comment, fontStyle: "italic" },
      { tag: [t.keyword, t.controlKeyword, t.moduleKeyword, t.operatorKeyword, t.definitionKeyword, t.modifier], color: p.magenta },
      { tag: [t.string, t.special(t.string), t.regexp, t.character], color: p.green },
      { tag: [t.number, t.bool, t.null, t.atom, t.unit], color: p.yellow },
      { tag: [t.function(t.variableName), t.function(t.propertyName), t.macroName], color: p.blue },
      { tag: [t.typeName, t.className, t.namespace, t.tagName, t.standard(t.tagName)], color: p.cyan },
      { tag: [t.propertyName, t.attributeName, t.labelName], color: p.brightBlue },
      { tag: [t.definition(t.variableName), t.self, t.special(t.variableName)], color: p.red },
      { tag: [t.operator, t.punctuation, t.separator, t.bracket, t.angleBracket], color: mix(p.foreground, p.background, 0.25) },
      { tag: [t.meta, t.annotation, t.processingInstruction], color: p.brightMagenta },
      { tag: [t.escape, t.link, t.url], color: p.brightCyan },
      { tag: t.heading, color: p.blue, fontWeight: "bold" },
      { tag: t.emphasis, fontStyle: "italic" },
      { tag: t.strong, fontWeight: "bold" },
      { tag: t.strikethrough, textDecoration: "line-through" },
      { tag: t.invalid, color: p.brightRed },
      { tag: [t.inserted], color: p.green },
      { tag: [t.deleted], color: p.red },
      { tag: [t.changed], color: p.yellow },
    ],
  });
}

export function editorThemeFor(theme: Theme): Extension {
  if (theme.id === "pzzacode") return githubDark;
  if (theme.id === "pzzacode-light") return githubLight;
  const key = `${theme.appearance}:${JSON.stringify(theme.terminal)}`;
  let editor = editors.get(key);
  if (!editor) {
    editor = paletteEditor(theme);
    if (editors.size >= EDITORS_KEPT) editors.delete(editors.keys().next().value as string);
    editors.set(key, editor);
  }
  return editor;
}

/** The CodeMirror theme for the theme the app shows. */
export function useEditorTheme(): Extension {
  const theme = useActiveTheme();
  return useMemo(() => editorThemeFor(theme), [theme]);
}
