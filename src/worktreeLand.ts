import { useCallback, useSyncExternalStore } from "react";
import { fetchGitStatus, fetchWorktreeInfo, mergeWorktreeBranch, openWorktreePullRequest, type WorktreeInfo } from "./serverApi";
import { confirmAction } from "./state/confirmations";
import { hasPendingPermission } from "./state/permissionPrompts";
import { useStore } from "./state/store";
import { agentLooksBusy } from "./checkpoints";
import { openWebPage, tileGitTarget } from "./tileGit";
import { refreshGitRemote } from "./grid/gitRemote";
import { useTasks, useTasksUi, type Task, type TaskCandidate } from "./tasks/taskStore";

// Bringing a worktree branch's work back, one path for every surface: the
// tile footer, the Worktrees section of Workspace settings, app control and
// Tasks. A worktree a task started lands through that task's land flow (its
// checks, and the outcome recorded on the task); any other worktree passes
// the checks that apply to it (the agent is idle, nothing waits for approval,
// nothing is uncommitted) and then opens a pull request (push, then gh pr
// create --fill, or the host's compare page when gh cannot) or merges into
// the base in the main checkout after a confirmation.

export interface LandResult {
  text: string;
  url?: string;
  failed: boolean;
  /** The branch's pull request, new or existing, when there is one. */
  prUrl?: string;
  /** The merge commit in the base, after a merge. */
  commit?: string;
}
export type LandKind = "pr" | "merge";

// ------------------------------------------------------------------ checks

export type GateState = "ok" | "blocked" | "pending" | "skipped";
export interface Gate { id: "idle" | "approval" | "prompt" | "clean" | "check"; label: string; state: GateState; detail: string }

export const gatesOpen = (gates: readonly Gate[]) => gates.every((gate) => gate.state === "ok" || gate.state === "skipped");

/** Landing mid-turn ships half a change. */
export function idleGate(working: boolean): Gate {
  return { id: "idle", label: "Agent is idle", state: working ? "blocked" : "ok", detail: working ? "It is still working. Wait for it to stop." : "Not producing output." };
}

export function approvalGate(waiting: boolean): Gate {
  return { id: "approval", label: "No approval waiting", state: waiting ? "blocked" : "ok", detail: waiting ? "Answer the agent's approval prompt first." : "Nothing to approve." };
}

/**
 * Nothing uncommitted (it would be left behind), and, when the commits ahead
 * of the base are known, something to land. Undefined while it is read.
 */
export function cleanGate(tree: { dirty: boolean; uncommitted?: number; ahead?: number; base?: string } | undefined): Gate {
  const gate = (state: GateState, detail: string): Gate => ({ id: "clean", label: "Worktree is clean", state, detail });
  if (!tree) return gate("pending", "Reading the worktree…");
  if (tree.dirty) {
    return gate("blocked", tree.uncommitted !== undefined
      ? `${tree.uncommitted} uncommitted ${tree.uncommitted === 1 ? "change" : "changes"}. Commit them first.`
      : "It has uncommitted changes. Commit them first.");
  }
  if (tree.ahead === undefined) return gate("ok", "No uncommitted changes.");
  const base = tree.base || "the base";
  return tree.ahead
    ? gate("ok", `${tree.ahead} ${tree.ahead === 1 ? "commit" : "commits"} ahead of ${base}.`)
    : gate("blocked", `Nothing ahead of ${base} to land.`);
}

const inside = (folder: string, root: string) => folder === root || folder.startsWith(root.endsWith("/") ? root : `${root}/`);

/** The open tiles working in the folder (or below it) on that device. */
function tilesIn(host: string, path: string): string[] {
  return useStore.getState().tiles.flatMap((tile) => {
    const target = tileGitTarget(tile.id);
    return target && target.host === host && inside(target.folder, path) ? [tile.id] : [];
  });
}

/** The checks a worktree outside Tasks passes before it lands, read now. */
export async function worktreeGates(host: string, path: string): Promise<Gate[]> {
  const tiles = tilesIn(host, path);
  const [busy, tree] = await Promise.all([
    Promise.all(tiles.map((tileId) => agentLooksBusy(tileId))).then((answers) => answers.some(Boolean)),
    fetchGitStatus(host, [path], AbortSignal.timeout(15000)).then((results) => results[path] ?? null, () => null),
  ]);
  return [
    idleGate(busy),
    // Read after the busy sample, so a prompt that showed up meanwhile counts.
    approvalGate(tiles.some(hasPendingPermission)),
    tree ? cleanGate({ dirty: tree.dirty }) : { id: "clean", label: "Worktree is clean", state: "blocked", detail: "Its Git status could not be read." },
  ];
}

/** The first check that stops a landing, as a failed result. */
export function gateFailure(kind: LandKind, gates: readonly Gate[]): LandResult | null {
  const blocker = gates.find((gate) => gate.state !== "ok" && gate.state !== "skipped");
  if (!blocker) return null;
  const detail = blocker.id === "idle" ? "An agent in this worktree is still working. Land once it stops." : blocker.id === "check" ? `${blocker.label}: ${blocker.detail}` : blocker.detail;
  return { text: `Can't ${kind === "pr" ? "open a pull request" : "merge"} yet. ${detail}`, failed: true };
}

// --------------------------------------------------------------- landing

const failure = (error: unknown, fallback: string): LandResult => ({ text: error instanceof Error ? error.message : fallback, failed: true });

/**
 * Pushes the worktree's branch and opens its pull request; falls back to the
 * compare page in the browser. No checks: callers go through landWorktree or
 * a task's land flow.
 */
export async function openWorktreePr(host: string, path: string): Promise<LandResult> {
  try {
    const result = await openWorktreePullRequest(host, path);
    refreshGitRemote(host, path);
    if (result.url) {
      return { text: result.created ? `Opened a pull request for ${result.branch}:` : `${result.message ?? "A pull request already exists."}`, url: result.url, prUrl: result.url, failed: false };
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

/**
 * Confirms, then merges the worktree's branch into the base in the main
 * checkout. Null when cancelled. No checks: callers go through landWorktree
 * or a task's land flow.
 */
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
    return { text: `Merged ${branch} into ${base}${result.commit ? ` (${result.commit.slice(0, 7)})` : ""} in ${result.main}.`, failed: false, ...(result.commit ? { commit: result.commit } : {}) };
  } catch (error) {
    return failure(error, "Could not merge the worktree.");
  }
}

/** The task attempt working in this worktree, when a task started it and it is still in play. */
export function worktreeTask(host: string, path: string): { task: Task; candidate: TaskCandidate } | null {
  for (const task of useTasks.getState().tasks) {
    if (task.host !== host) continue;
    const candidate = task.candidates.find((item) => item.worktree === path && item.launch === "started" && item.outcome !== "discarded");
    if (candidate) return { task, candidate };
  }
  return null;
}

/** The title of the task working in this worktree, or null. */
export function useWorktreeTaskTitle(host: string, path: string | undefined): string | null {
  return useTasks((state) => {
    if (!path) return null;
    const task = state.tasks.find((item) => item.host === host && item.candidates.some((candidate) => candidate.worktree === path && candidate.launch === "started" && candidate.outcome !== "discarded"));
    return task?.title ?? null;
  });
}

export interface LandRequest { kind: LandKind; host: string; path: string; branch: string; base: string | null }

/**
 * Lands a worktree from outside Tasks (the tile footer, Workspace settings,
 * app control). A task's worktree goes through the task's land flow: with
 * `interactive`, the task window opens on that attempt (its checks with their
 * fixes, and Land); without, the task lands it here behind the same checks.
 * Any other worktree passes the generic checks first. Null when cancelled or
 * handed to the task window.
 */
export async function landWorktree(request: LandRequest, options: { interactive: boolean }): Promise<LandResult | null> {
  const owner = worktreeTask(request.host, request.path);
  if (owner) {
    if (options.interactive) {
      useTasksUi.getState().openDetails({ taskId: owner.task.id, candidateId: owner.candidate.id });
      return null;
    }
    const { landCandidate } = await import("./tasks/taskActions");
    return landCandidate(owner.task, owner.candidate, request.kind);
  }
  if (request.kind === "merge" && !request.base) return { text: "The worktree's base branch is unknown.", failed: true };
  const blocked = gateFailure(request.kind, await worktreeGates(request.host, request.path));
  if (blocked) return blocked;
  return request.kind === "pr" ? openWorktreePr(request.host, request.path) : mergeWorktree(request.host, request.path, request.branch, request.base ?? "");
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
