// The menu bar's tools, the session top bar's items and the session status
// bar (whole or per item) that can be turned off in Settings > General >
// Menu & session bars. New session and Settings always stay in the menu bar,
// a session's title and Close in its top bar. Everything is shown unless the
// user hides it.

export const TOP_BAR_ITEMS = [
  { id: "top:tasks", label: "Tasks" },
  { id: "top:quick-chat", label: "Quick Chat" },
  // Sync and Remote desktop appear only once a remote device is set up.
  { id: "top:sync", label: "Sync projects", needsRemote: true },
  { id: "top:remote", label: "Remote desktop", needsRemote: true },
  { id: "top:ports", label: "Port manager" },
  { id: "top:usage", label: "Agent usage" },
  { id: "top:notifications", label: "Notifications" },
] as const;

export const SESSION_HEADER_ITEMS = [
  { id: "header:device", label: "Device" },
  { id: "header:shortcut", label: "Shortcut" },
  { id: "header:mic", label: "Dictation" },
  { id: "header:code", label: "Code" },
  { id: "header:move", label: "Move" },
  { id: "header:duplicate", label: "Duplicate" },
  { id: "header:fullscreen", label: "Fullscreen" },
  { id: "header:hide", label: "Hide" },
] as const;

/** The whole status bar under each session. */
export const STATUS_BAR_ID = "status:bar";

export const STATUS_BAR_ITEMS = [
  { id: "status:session", label: "Session name" },
  { id: "status:git", label: "Git" },
  { id: "status:worktree", label: "Worktree" },
  { id: "status:path", label: "Folder" },
  { id: "status:started", label: "Start time" },
] as const;

export type BarItemId = (typeof TOP_BAR_ITEMS)[number]["id"] | (typeof SESSION_HEADER_ITEMS)[number]["id"]
  | (typeof STATUS_BAR_ITEMS)[number]["id"] | typeof STATUS_BAR_ID;

const KNOWN = new Set<string>([...[...TOP_BAR_ITEMS, ...SESSION_HEADER_ITEMS, ...STATUS_BAR_ITEMS].map(item => item.id), STATUS_BAR_ID]);

export function isBarItemId(value: unknown): value is BarItemId {
  return typeof value === "string" && KNOWN.has(value);
}

/** A stored list of hidden items, keeping only known ids, once each. */
export function validHiddenBarItems(value: unknown): BarItemId[] {
  return Array.isArray(value) ? [...new Set(value.filter(isBarItemId))] : [];
}
