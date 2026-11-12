import { useCallback, useEffect, useSyncExternalStore } from "react";
import { fetchGitCiFailures, fetchGitRemote, type GitCiFailures, type GitRemoteInfo } from "../serverApi";
import { broadcastLine } from "../terminal/broadcast";

// The web page and pull request (with its checks) of a folder's branch, shared
// by every visible tile on that folder. Fetched when first needed and then
// once a minute while a tile shows it; the server caches gh calls as well.
const REMOTE_POLL_MS = 60000;

interface RemoteEntry {
  value: GitRemoteInfo | null | undefined;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
  // Set when a poll came due while the window was hidden.
  paused?: { host: string; path: string };
}
const remotes = new Map<string, RemoteEntry>();

async function pollRemote(key: string, host: string, path: string) {
  const entry = remotes.get(key);
  if (!entry) return;
  entry.controller?.abort();
  const controller = new AbortController();
  entry.controller = controller;
  // Hidden: no polling until the window shows again (see below).
  if (document.visibilityState === "hidden") {
    entry.paused = { host, path };
    return;
  }
  try {
    const value = await fetchGitRemote(host, path, controller.signal);
    if (controller.signal.aborted) return;
    entry.value = value;
  } catch {
    if (controller.signal.aborted) return;
    // Not a repository, or the device is unreachable: show nothing.
    entry.value = entry.value ?? null;
  }
  for (const notify of entry.listeners) notify();
  if (remotes.get(key) === entry) entry.timer = setTimeout(() => void pollRemote(key, host, path), REMOTE_POLL_MS);
}

// Back from hidden: refresh what was paused at once.
if (typeof document !== "undefined") document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "hidden") return;
  for (const [key, entry] of remotes) {
    if (!entry.paused) continue;
    const { host, path } = entry.paused;
    entry.paused = undefined;
    void pollRemote(key, host, path);
  }
});

function subscribeRemote(key: string, host: string, path: string, listener: () => void): () => void {
  let entry = remotes.get(key);
  if (!entry) {
    entry = { value: undefined, listeners: new Set() };
    remotes.set(key, entry);
    void pollRemote(key, host, path);
  }
  const current = entry;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (current.listeners.size) return;
    clearTimeout(current.timer);
    current.controller?.abort();
    remotes.delete(key);
  };
}

/** Reads the branch page and pull request of a folder (and folders inside it) again now, e.g. right after opening a pull request. */
export function refreshGitRemote(host: string, path: string): void {
  const prefix = path.endsWith("/") ? path : `${path}/`;
  for (const [key, entry] of remotes) {
    const [entryHost, entryPath] = JSON.parse(key) as [string, string, string];
    if (entryHost !== host || (entryPath !== path && !entryPath.startsWith(prefix))) continue;
    clearTimeout(entry.timer);
    void pollRemote(key, host, path);
  }
}

// The branch is part of the key, so switching branches fetches its own PR.
export function useGitRemote(host: string, path: string | undefined, branch: string | undefined, enabled: boolean): GitRemoteInfo | null | undefined {
  const key = enabled && path && branch ? JSON.stringify([host, path, branch]) : "";
  const subscribe = useCallback(
    (listener: () => void) => (key && path ? subscribeRemote(key, host, path, listener) : () => {}),
    [key, host, path],
  );
  return useSyncExternalStore(subscribe, () => (key ? remotes.get(key)?.value : undefined));
}

// Tiles whose agent works on the same branch of the same checkout: the same
// device and branch, in the same folder or one inside the other. Worktrees
// live in their own folders, so tiles on separate worktrees never match.
// Every open tile running an agent claims, hidden or in another workspace too
// (their Git status is read at the slow background rate).
export interface BranchClaim { host: string; path: string; branch: string; label: string; workspaceId: string; workspace: string }
const claims = new Map<string, BranchClaim>();
const claimListeners = new Set<() => void>();
let claimVersion = 0;
const notifyClaims = () => { claimVersion += 1; for (const notify of claimListeners) notify(); };

function sameCheckout(a: BranchClaim, b: BranchClaim): boolean {
  if (a.host !== b.host || a.branch !== b.branch) return false;
  const inside = (outer: string, inner: string) => inner === outer || inner.startsWith(outer.endsWith("/") ? outer : `${outer}/`);
  return inside(a.path, b.path) || inside(b.path, a.path);
}

// Labels of the other tiles on this tile's checkout and branch; a tile in
// another workspace is named with it, e.g. "api (Workspace 2)".
export function sharedBranchTiles(tileId: string, claim: BranchClaim, all: ReadonlyMap<string, BranchClaim>): string[] {
  return [...all].filter(([id, other]) => id !== tileId && sameCheckout(claim, other))
    .map(([, other]) => (other.workspaceId === claim.workspaceId ? other.label : `${other.label} (${other.workspace})`));
}

/** Registers this tile's agent on its branch and returns the other tiles' agents on it. */
export function useSharedBranch(tileId: string, claim: BranchClaim | null): string[] {
  const active = claim !== null;
  const { host = "", path = "", branch = "", label = "", workspaceId = "", workspace = "" } = claim ?? {};
  useEffect(() => {
    if (!active) return;
    claims.set(tileId, { host, path, branch, label, workspaceId, workspace });
    notifyClaims();
    return () => { claims.delete(tileId); notifyClaims(); };
  }, [tileId, active, host, path, branch, label, workspaceId, workspace]);
  const subscribe = useCallback((listener: () => void) => { claimListeners.add(listener); return () => { claimListeners.delete(listener); }; }, []);
  useSyncExternalStore(subscribe, () => claimVersion);
  return active ? sharedBranchTiles(tileId, { host, path, branch, label, workspaceId, workspace }, claims) : [];
}

// The one line typed to a tile's agent about failed CI: the branch, the
// failed jobs and the saved log file, never the logs themselves.
export function ciFailureLine({ branch, checks, path }: Pick<GitCiFailures, "branch" | "checks" | "path">): string {
  const clean = (value: string) => value.replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, " ").trim();
  const names = checks.map(clean).filter(Boolean).join(", ");
  return `CI failed on ${clean(branch)}${names ? ` (${names})` : ""}. Logs: ${clean(path)}. Please fix.`;
}

// Has the server save the failed CI logs of the folder's branch, then types
// the line pointing at them into the tile's terminal.
export async function sendFailingChecks(tileId: string, host: string, path: string): Promise<void> {
  const failures = await fetchGitCiFailures(host, path);
  const [result] = await broadcastLine([tileId], ciFailureLine(failures));
  if (result?.error) throw new Error(result.error);
}
