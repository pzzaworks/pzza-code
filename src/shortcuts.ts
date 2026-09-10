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

// Pretty badge text for a given number, e.g. "⌥1" on macOS or "Alt 1" elsewhere.
export const altBadge = (n: number) => (IS_MAC ? `${ALT_LABEL}${n}` : `${ALT_LABEL} ${n}`);
export const ctrlBadge = (n: number) => (IS_MAC ? `${CTRL_LABEL}${n}` : `${CTRL_LABEL} ${n}`);

// Returns the 0-9 digit from a KeyboardEvent's physical code, or null.
export function digitFromCode(code: string): number | null {
  const m = /^Digit([0-9])$/.exec(code);
  return m ? Number(m[1]) : null;
}
