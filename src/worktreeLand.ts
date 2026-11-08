import { useCallback, useSyncExternalStore } from "react";
import { fetchWorktreeInfo, mergeWorktreeBranch, openWorktreePullRequest, type WorktreeInfo } from "./serverApi";
import { confirmAction } from "./state/confirmations";
import { openWebPage } from "./tileGit";
import { refreshGitRemote } from "./grid/gitRemote";

// Bringing a worktree branch's work back, shared by the Worktrees section of
// Workspace settings and the tile footer: open a pull request (push, then
// gh pr create --fill, or the host's compare page when gh cannot), or merge
// the branch into the base in the main checkout after a confirmation.

export interface LandResult { text: string; url?: string; failed: boolean }

const failure = (error: unknown, fallback: string): LandResult => ({ text: error instanceof Error ? error.message : fallback, failed: true });

/** Pushes the worktree's branch and opens its pull request; falls back to the compare page in the browser. */
export async function openWorktreePr(host: string, path: string): Promise<LandResult> {
  try {
    const result = await openWorktreePullRequest(host, path);
    refreshGitRemote(host, path);
    if (result.url) {
      return { text: result.created ? `Opened a pull request for ${result.branch}:` : `${result.message ?? "A pull request already exists."}`, url: result.url, failed: false };
    }
    if (result.compareUrl) {
      openWebPage(result.compareUrl);
      return { text: `${result.message ?? "Pushed."} The compare page is open in the browser:`, url: result.compareUrl, failed: false };
    }
    return { text: `${result.message ?? "Pushed."} This remote has no web page to open a pull request on.`, failed: true };
  } catch (error) {
    return failure(error, "Could not open a pull request.");
  }
}

/** Confirms, then merges the worktree's branch into the base in the main checkout. Null when cancelled. */
export async function mergeWorktree(host: string, path: string, branch: string, base: string): Promise<LandResult | null> {
  const accepted = await confirmAction({
    title: `Merge ${branch} into ${base}?`,
    message: `Runs git merge --no-ff ${branch} in the main checkout of this repository, which must be on ${base} with no uncommitted changes. On a conflict the merge is aborted and ${base} stays as it was. Nothing is pushed.`,
    confirmLabel: `Merge into ${base}`,
  });
  if (!accepted) return null;
  try {
    const result = await mergeWorktreeBranch(host, path, branch, base);
    refreshGitRemote(host, result.main);
    return { text: `Merged ${branch} into ${base}${result.commit ? ` (${result.commit.slice(0, 7)})` : ""} in ${result.main}.`, failed: false };
  } catch (error) {
    return failure(error, "Could not merge the worktree.");
  }
}

// Whether a tile's folder is a linked worktree, read once per folder and
// branch (a new branch reads it again) and shared by every tile on it.
interface InfoEntry { value: WorktreeInfo | null | undefined; listeners: Set<() => void> }
const infos = new Map<string, InfoEntry>();

function subscribeInfo(key: string, host: string, path: string, listener: () => void): () => void {
  let entry = infos.get(key);
  if (!entry) {
    const created: InfoEntry = { value: undefined, listeners: new Set() };
    infos.set(key, created);
    entry = created;
    void fetchWorktreeInfo(host, path, AbortSignal.timeout(15000)).catch(() => null).then((value) => {
      created.value = value;
      if (!created.listeners.size && infos.get(key) === created) infos.delete(key);
      for (const notify of created.listeners) notify();
    });
  }
  const current = entry;
  current.listeners.add(listener);
  return () => {
    current.listeners.delete(listener);
    if (!current.listeners.size && current.value !== undefined) infos.delete(key);
  };
}

export function useWorktreeInfo(host: string, path: string | undefined, branch: string | undefined): WorktreeInfo | null | undefined {
  const key = path && branch ? JSON.stringify([host, path, branch]) : "";
  const subscribe = useCallback(
    (listener: () => void) => (key && path ? subscribeInfo(key, host, path, listener) : () => {}),
    [key, host, path],
  );
  return useSyncExternalStore(subscribe, () => (key ? infos.get(key)?.value : undefined));
}
