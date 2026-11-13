// The editor's pickers (Quick Open, project search, symbol outline): their
// shortcuts, and a registry so the command palette can open them on a given
// editor without loading the editor's code.
import { inCodeEditorFolder, IS_MAC } from "../shortcuts";

export type CodePickerKind = "files" | "search" | "symbols";

export const CODE_PICKERS: Record<CodePickerKind, { label: string; shortcut: string; keys: string }> = {
  files: { label: "Go to file", shortcut: IS_MAC ? "⌘P" : "Ctrl P", keys: IS_MAC ? "Meta+P" : "Control+P" },
  search: { label: "Search in folder", shortcut: IS_MAC ? "⇧⌘F" : "Ctrl Shift F", keys: IS_MAC ? "Meta+Shift+F" : "Control+Shift+F" },
  symbols: { label: "Go to symbol", shortcut: IS_MAC ? "⇧⌘O" : "Ctrl Shift O", keys: IS_MAC ? "Meta+Shift+O" : "Control+Shift+O" },
};

// Cmd+P, Cmd+Shift+F and Cmd+Shift+O (Ctrl elsewhere). Off macOS a focused
// terminal keeps Ctrl+P and Ctrl+Shift+O for its own programs, and project
// search only answers inside the editor, where terminal search would not help.
export function codePickerShortcut(event: KeyboardEvent): CodePickerKind | null {
  const modifier = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.isComposing) return null;
  const kind = event.code === "KeyP" && !event.shiftKey ? "files"
    : event.code === "KeyF" && event.shiftKey ? "search"
    : event.code === "KeyO" && event.shiftKey ? "symbols"
    : null;
  if (!kind) return null;
  const target = event.target instanceof Element ? event.target : null;
  if (kind === "search") return inCodeEditorFolder(target) ? kind : null;
  if (!IS_MAC && target?.closest(".xterm")) return null;
  return kind;
}

type Opener = (kind: CodePickerKind) => void;
const openers = new Map<string, Opener>();

export function registerCodePickers(tileId: string, open: Opener): () => void {
  openers.set(tileId, open);
  return () => { if (openers.get(tileId) === open) openers.delete(tileId); };
}

/** Opens a picker on the editor of `tileId`; false when that editor is not mounted. */
export function openCodePicker(tileId: string, kind: CodePickerKind): boolean {
  const open = openers.get(tileId);
  if (!open) return false;
  open(kind);
  return true;
}
