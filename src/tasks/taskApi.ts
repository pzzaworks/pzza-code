import { postGitReview, type GitChangeStatus, type GitFileDiff } from "../serverApi";

// Typed calls to the device agent's task routes (server/lib/tasks.js): the
// branches to start from, a worktree's changes against its base, one file's
// diff against the base, the guarded discard, a commit and the check command.

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isString = (value: unknown): value is string => typeof value === "string";
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 0;
const countOrNull = (value: unknown): value is number | null => value === null || isCount(value);
const STATUSES: readonly GitChangeStatus[] = ["modified", "added", "deleted", "renamed", "untracked", "conflicted"];
const isStatus = (value: unknown): value is GitChangeStatus => STATUSES.some((status) => status === value);

function invalid(what: string): never {
  throw new Error(`${what} unavailable: unexpected answer from the device.`);
}

export interface TaskBranches { root: string; current: string | null; base: string | null; branches: string[] }

export async function fetchTaskBranches(host: string, path: string, signal?: AbortSignal): Promise<TaskBranches> {
  const value = await postGitReview("task/branches", { host, path }, "Branches unavailable", signal);
  if (!isRecord(value) || !isString(value.root) || !isStringOrNull(value.current) || !isStringOrNull(value.base) || !Array.isArray(value.branches)) invalid("Branches");
  return { root: value.root, current: value.current, base: value.base, branches: value.branches.filter(isString) };
}

export interface TaskCommit { sha: string; subject: string }
export interface TaskFile { path: string; status: GitChangeStatus; from?: string; added: number | null; removed: number | null }
export interface TaskStats {
  root: string;
  branch: string | null;
  head: string | null;
  base: string;
  baseFound: boolean;
  mergeBase: string | null;
  commits: TaskCommit[];
  ahead: number;
  behind: number;
  files: TaskFile[];
  truncated: boolean;
  added: number;
  removed: number;
  uncommitted: number;
  dirty: boolean;
}

const readCommit = (value: unknown): TaskCommit | null => (isRecord(value) && isString(value.sha) && isString(value.subject) ? { sha: value.sha, subject: value.subject } : null);
function readFile(value: unknown): TaskFile | null {
  if (!isRecord(value) || !isString(value.path) || !isStatus(value.status) || !countOrNull(value.added) || !countOrNull(value.removed)) return null;
  return { path: value.path, status: value.status, ...(isString(value.from) ? { from: value.from } : {}), added: value.added, removed: value.removed };
}
const list = <T,>(value: unknown, read: (item: unknown) => T | null): T[] | null => {
  if (!Array.isArray(value)) return null;
  const items = value.map(read);
  return items.every((item): item is T => item !== null) ? items : null;
};

export async function fetchTaskStats(host: string, path: string, base: string, signal?: AbortSignal): Promise<TaskStats> {
  const value = await postGitReview("task/stats", { host, path, base }, "Changes unavailable", signal);
  if (!isRecord(value)) invalid("Changes");
  const commits = list(value.commits, readCommit);
  const files = list(value.files, readFile);
  if (!commits || !files || !isString(value.root) || !isStringOrNull(value.branch) || !isStringOrNull(value.head) || !isString(value.base) || typeof value.baseFound !== "boolean"
    || !isStringOrNull(value.mergeBase) || !isCount(value.ahead) || !isCount(value.behind) || typeof value.truncated !== "boolean" || !isCount(value.added) || !isCount(value.removed)
    || !isCount(value.uncommitted) || typeof value.dirty !== "boolean") invalid("Changes");
  return {
    root: value.root, branch: value.branch, head: value.head, base: value.base, baseFound: value.baseFound, mergeBase: value.mergeBase, commits,
    ahead: value.ahead, behind: value.behind, files, truncated: value.truncated, added: value.added, removed: value.removed, uncommitted: value.uncommitted, dirty: value.dirty,
  };
}

export async function fetchTaskDiff(host: string, path: string, base: string, file: string, from: string | undefined, signal?: AbortSignal): Promise<GitFileDiff> {
  const value = await postGitReview("task/diff", { host, path, base, file, ...(from ? { from } : {}) }, "File changes unavailable", signal);
  if (!isRecord(value) || !isStringOrNull(value.before) || !isStringOrNull(value.after) || typeof value.binary !== "boolean" || typeof value.truncated !== "boolean") invalid("File changes");
  return { before: value.before, after: value.after, binary: value.binary, truncated: value.truncated };
}

export interface DiscardPreview {
  main: string;
  branch: string;
  base: string | null;
  commits: TaskCommit[];
  uncommitted: { path: string; status: GitChangeStatus }[];
  /** Ignored files and folders ("dir/" for a whole folder) the removal deletes too. */
  ignored: string[];
  truncated: boolean;
  /** A locked worktree is never removed. */
  locked: boolean;
  fingerprint: string;
}

export async function previewTaskDiscard(host: string, path: string, base: string, signal?: AbortSignal): Promise<DiscardPreview> {
  const value = await postGitReview("task/discard/preview", { host, path, base }, "Could not read the worktree", signal ?? AbortSignal.timeout(30000));
  const commits = isRecord(value) ? list(value.commits, readCommit) : null;
  const uncommitted = isRecord(value) ? list(value.uncommitted, (item) => (isRecord(item) && isString(item.path) && isStatus(item.status) ? { path: item.path, status: item.status } : null)) : null;
  const ignored = isRecord(value) ? list(value.ignored, (item) => (isString(item) && item ? item : null)) : null;
  if (!isRecord(value) || !commits || !uncommitted || !ignored || !isString(value.main) || !isString(value.branch) || !isStringOrNull(value.base) || typeof value.truncated !== "boolean" || !isString(value.fingerprint)) invalid("Worktree");
  return { main: value.main, branch: value.branch, base: value.base, commits, uncommitted, ignored, truncated: value.truncated, locked: value.locked === true, fingerprint: value.fingerprint };
}

export async function discardTaskWorktree(host: string, path: string, fingerprint: string): Promise<{ branchDeleted: boolean }> {
  const value = await postGitReview("task/discard", { host, path, fingerprint }, "Could not remove the worktree", AbortSignal.timeout(60000));
  if (!isRecord(value) || value.removed !== true || typeof value.branchDeleted !== "boolean") invalid("Worktree removal");
  return { branchDeleted: value.branchDeleted };
}

/** What a launch that never finished left behind: "present" only when looking, "kept" with why when it holds work or is not provably this launch's. */
export type ReclaimState = "absent" | "removed" | "kept" | "foreign" | "present";
export type ReclaimReason = "locked" | "older" | "base" | "commits" | "unreadable" | "changes" | "refused";
export interface ReclaimResult { state: ReclaimState; worktree: string | null; branch: string; reason?: ReclaimReason; error?: string; branchDeleted: boolean }
const RECLAIM_STATES: readonly ReclaimState[] = ["absent", "removed", "kept", "foreign", "present"];
const RECLAIM_REASONS: readonly ReclaimReason[] = ["locked", "older", "base", "commits", "unreadable", "changes", "refused"];

/** Looks for (remove=false) or safely removes (remove=true) the worktree and branch a candidate's launch created. */
export async function reclaimTaskWorktree(host: string, repo: string, session: string, base: string, startedAt: number, remove: boolean): Promise<ReclaimResult> {
  const value = await postGitReview("task/reclaim", { host, path: repo, session, base, startedAt: Math.floor(startedAt), remove }, "Could not look for the candidate's worktree", AbortSignal.timeout(60000));
  if (!isRecord(value)) invalid("Worktree cleanup");
  const state = RECLAIM_STATES.find((item) => item === value.state);
  if (!state || !isStringOrNull(value.worktree) || !isString(value.branch) || typeof value.branchDeleted !== "boolean") invalid("Worktree cleanup");
  const reason = RECLAIM_REASONS.find((item) => item === value.reason);
  return {
    state, worktree: value.worktree, branch: value.branch, branchDeleted: value.branchDeleted,
    ...(reason ? { reason } : {}), ...(isString(value.error) ? { error: value.error } : {}),
  };
}

export async function commitTaskWorktree(host: string, path: string, message: string, exclude: string[]): Promise<{ commit: string }> {
  const value = await postGitReview("task/commit", { host, path, message, exclude }, "Could not commit the changes", AbortSignal.timeout(120000));
  if (!isRecord(value) || !isString(value.commit)) invalid("Commit");
  return { commit: value.commit };
}

export type TaskCheckStatus = "none" | "unapproved" | "ready" | "passed" | "failed" | "timeout";
export interface TaskCheckResult { status: TaskCheckStatus; commands: string[]; code?: number | null; output?: string; durationMs?: number }
const CHECK_STATUSES: readonly TaskCheckStatus[] = ["none", "unapproved", "ready", "passed", "failed", "timeout"];

function readCheck(value: unknown): TaskCheckResult {
  if (!isRecord(value) || !CHECK_STATUSES.includes(value.status as TaskCheckStatus) || !Array.isArray(value.commands) || !value.commands.every(isString)) invalid("Check");
  return {
    status: value.status as TaskCheckStatus, commands: value.commands,
    ...(typeof value.code === "number" || value.code === null ? { code: value.code } : {}),
    ...(isString(value.output) ? { output: value.output } : {}),
    ...(isCount(value.durationMs) ? { durationMs: value.durationMs } : {}),
  };
}

// Runs for up to ten minutes on the device; the request waits for it.
const CHECK_TIMEOUT_MS = 11 * 60 * 1000;

export async function runTaskCheck(host: string, path: string, run: boolean, signal?: AbortSignal): Promise<TaskCheckResult> {
  return readCheck(await postGitReview("task/check", { host, path, run }, "Could not run the check", signal ?? AbortSignal.timeout(run ? CHECK_TIMEOUT_MS : 30000)));
}

export async function approveTaskCheck(host: string, path: string, check: string[]): Promise<TaskCheckResult> {
  return readCheck(await postGitReview("task/check/approve", { host, path, check }, "Could not approve the check", AbortSignal.timeout(30000)));
}
