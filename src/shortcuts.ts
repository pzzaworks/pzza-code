// Keyboard-shortcut helpers. Workspaces switch with Alt/Option + number, tiles
// activate with Ctrl + number. We key off KeyboardEvent.code ("Digit1"...) not
// .key, because Option+number on macOS yields special characters, not digits.

export const IS_MAC =
  typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// Short labels shown on the buttons.
export const ALT_LABEL = IS_MAC ? "⌥" : "Alt";
export const CTRL_LABEL = IS_MAC ? "⌃" : "Ctrl";
export const NEW_SESSION_SHORTCUT = { label: IS_MAC ? "⌘N" : "Ctrl N", keys: IS_MAC ? "Meta+N" : "Control+N" };
export const NEW_WORKSPACE_SHORTCUT = { label: IS_MAC ? "⇧⌘N" : "Ctrl Shift N", keys: IS_MAC ? "Meta+Shift+N" : "Control+Shift+N" };

export function newItemShortcut(event: KeyboardEvent): "session" | "workspace" | null {
  const modifier = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.code !== "KeyN" || event.isComposing) return null;
  return event.shiftKey ? "workspace" : "session";
}

export const COMMAND_PALETTE_SHORTCUT = { label: IS_MAC ? "⌘K" : "Ctrl K", keys: IS_MAC ? "Meta+K" : "Control+K" };

// Cmd+K opens the command palette everywhere on macOS: Cmd never reaches a
// shell. Off macOS Ctrl+K is the shell's kill-line, so a focused terminal keeps it.
export function commandPaletteShortcut(event: KeyboardEvent): boolean {
  const modifier = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || event.altKey || event.shiftKey || event.code !== "KeyK" || event.isComposing) return false;
  return IS_MAC || !(event.target instanceof Element && event.target.closest(".xterm"));
}

// Pretty badge text for a given number, e.g. "⌥1" on macOS or "Alt 1" elsewhere.
export const altBadge = (n: number) => (IS_MAC ? `${ALT_LABEL}${n}` : `${ALT_LABEL} ${n}`);
export const ctrlBadge = (n: number) => (IS_MAC ? `${CTRL_LABEL}${n}` : `${CTRL_LABEL} ${n}`);

// Returns the 0-9 digit from a KeyboardEvent's physical code, or null.
export function digitFromCode(code: string): number | null {
  const m = /^Digit([0-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}

export const SEARCH_TERMINALS_SHORTCUT = { label: IS_MAC ? "⇧⌘F" : "Ctrl Shift F", keys: IS_MAC ? "Meta+Shift+F" : "Control+Shift+F" };

// Cmd+Shift+F (Ctrl+Shift+F elsewhere) searches every terminal's scrollback,
// from anywhere: plain Cmd/Ctrl+F stays the focused terminal's or editor's find.
export function searchTerminalsShortcut(event: KeyboardEvent): boolean {
  const modifier = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  return modifier && event.shiftKey && !event.altKey && event.code === "KeyF" && !event.isComposing;
}

export const TASKS_SHORTCUT = { label: IS_MAC ? "⇧⌘T" : "Ctrl Shift T", keys: IS_MAC ? "Meta+Shift+T" : "Control+Shift+T" };

// Cmd+Shift+T shows or hides Tasks from anywhere on macOS. Off macOS
// Ctrl+Shift+T reaches terminal programs, so a focused terminal keeps it.
export function tasksShortcut(event: KeyboardEvent): boolean {
  const modifier = IS_MAC ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
  if (!modifier || !event.shiftKey || event.altKey || event.code !== "KeyT" || event.isComposing) return false;
  return IS_MAC || !(event.target instanceof Element && event.target.closest(".xterm"));
}
