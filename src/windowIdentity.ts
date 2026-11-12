// Which tmux window a window tile stands for.
//
// A tile attaches to its window by index, and keeps tmux's id for it ("@7")
// so Terminate never ends another window that later took that index. tmux
// hands out ids per server, from @0 again after every restart, so an id says
// nothing once the server was replaced (Refresh sessions, a restore after a
// reboot, a remote device rebooting). The id is therefore kept together with
// the creation time of the session it was read from: a session that was
// created again (restored under the same name, its windows put back at their
// indices) makes the old id meaningless, and the window at the tile's index is
// the tile's window again.

// tmux's window id. Unlike an index it never moves to another window after
// renumbering or after the original window exits.
const WINDOW_ID = /^@\d{1,9}$/;
export const validWindowId = (value: unknown): value is string => typeof value === "string" && WINDOW_ID.test(value);

// A session creation time in milliseconds, as a device reports it.
export const validSessionCreatedAt = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;

/** A window as its device reports it right now. */
export interface LocatedWindow {
  session: string;
  window: number;
  /** tmux's id for the window; absent when the device does not report one. */
  windowId?: string;
  /** Creation time (ms) of the window's session; null when the device does not report it. */
  sessionCreatedAt: number | null;
}

/** What a window tile remembers about the window it was opened on. */
export interface WindowIdentity {
  windowId?: string;
  /** Creation time (ms) of the session `windowId` was read from. */
  windowSessionCreatedAt?: number;
}

export type TerminateTarget =
  /** End exactly this window. */
  | { kind: "window"; windowId: string }
  /** No window holds the tile's index any more: nothing to terminate. */
  | { kind: "gone" }
  /** Another window holds the tile's index now: terminating it would end the wrong window. */
  | { kind: "moved" };

/**
 * The window a Terminate on a window tile may end, from what the tile
 * remembers and the window at its index right now (looked up just before).
 */
export function terminateTarget(stored: WindowIdentity, current: LocatedWindow | undefined): TerminateTarget {
  if (!current) return { kind: "gone" };
  if (!validWindowId(current.windowId)) throw new Error("This device did not report which window that is.");
  // Opened by index alone, or the very window it was opened on.
  if (stored.windowId === undefined || stored.windowId === current.windowId) return { kind: "window", windowId: current.windowId };
  // The session was created again since the id was read, so the id came from
  // an earlier terminal server and the window at the index is the tile's.
  if (sessionRecreated(stored, current)) return { kind: "window", windowId: current.windowId };
  return { kind: "moved" };
}

/**
 * The identity a window tile should keep from the window at its index right
 * now; null to keep what it has. A tile without one takes the window's, an
 * id read in an earlier lifetime of the session is replaced, and an id not
 * yet tied to a session is tied only while it still names the same window.
 */
export function refreshedIdentity(stored: WindowIdentity, current: LocatedWindow | undefined): Required<WindowIdentity> | null {
  if (!current || !validWindowId(current.windowId) || current.sessionCreatedAt === null) return null;
  const fresh = { windowId: current.windowId, windowSessionCreatedAt: current.sessionCreatedAt };
  if (stored.windowId === undefined || sessionRecreated(stored, current)) return fresh;
  if (stored.windowSessionCreatedAt === undefined && stored.windowId === current.windowId) return fresh;
  return null;
}

function sessionRecreated(stored: WindowIdentity, current: LocatedWindow): boolean {
  return stored.windowSessionCreatedAt !== undefined && current.sessionCreatedAt !== null && stored.windowSessionCreatedAt !== current.sessionCreatedAt;
}
