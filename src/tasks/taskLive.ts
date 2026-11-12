import { create } from "zustand";
import type { GitPullRequest } from "../serverApi";
import { onAgentSignalSettled } from "../terminal/agentFinished";
import type { TaskStats } from "./taskApi";
import type { CandidateState } from "./taskStatus";
import { useTasks, type TaskCandidate } from "./taskStore";

// The live side of tasks, never persisted: each candidate's derived state,
// its latest changes against the base and its pull request, plus when each
// tile's agent last rang for attention. TaskTracker writes it; the dropdown and
// the top bar button read it.

export interface CandidateLive extends CandidateState {
  stats?: TaskStats;
  statsError?: string;
  pr?: GitPullRequest | null;
  /** Whether a coding agent runs in the tile; undefined when unknown. */
  agentRunning?: boolean;
}

interface LiveState {
  live: Record<string, CandidateLive>;
  /** Local time of each tile's last settled attention signal. */
  bells: Record<string, number>;
  /** Per candidate: bumped to read its changes again now (after an action). */
  refresh: Record<string, number>;
}

export const useTaskLive = create<LiveState>(() => ({ live: {}, bells: {}, refresh: {} }));

// Only task tiles are tracked.
onAgentSignalSettled((tileId) => {
  if (!useTasks.getState().tasks.some((task) => task.candidates.some((candidate) => candidate.tileId === tileId))) return;
  useTaskLive.setState((state) => ({ bells: { ...state.bells, [tileId]: Date.now() } }));
});

export function setCandidateLive(candidateId: string, next: CandidateLive): void {
  const current = useTaskLive.getState().live[candidateId];
  if (current && (Object.keys(next) as (keyof CandidateLive)[]).every((key) => Object.is(current[key], next[key])) && Object.keys(current).length === Object.keys(next).length) return;
  useTaskLive.setState((state) => ({ live: { ...state.live, [candidateId]: next } }));
}

export function dropCandidateLive(candidateId: string): void {
  if (!(candidateId in useTaskLive.getState().live)) return;
  useTaskLive.setState((state) => {
    const live = { ...state.live };
    delete live[candidateId];
    return { live };
  });
}

export function refreshCandidate(candidateId: string): void {
  useTaskLive.setState((state) => ({ refresh: { ...state.refresh, [candidateId]: (state.refresh[candidateId] ?? 0) + 1 } }));
}

/** What a candidate shows when no watcher runs for it (it failed, landed or was discarded). */
export function settledState(candidate: TaskCandidate): CandidateLive {
  if (candidate.outcome === "discarded") return { phase: "discarded", reason: "Discarded", working: false };
  if (candidate.outcome === "merged") return { phase: "merged", reason: "Merged", working: false };
  if (candidate.outcome === "pr") return { phase: "pr", reason: "Pull request open", working: false };
  if (candidate.launch === "failed") return { phase: "failed", reason: candidate.error ?? "Could not start", working: false };
  if (candidate.launch === "starting") return { phase: "starting", reason: "Creating the worktree", working: true };
  return { phase: "working", reason: "Starting", working: true };
}

export function useCandidateLive(candidate: TaskCandidate): CandidateLive {
  const live = useTaskLive((state) => state.live[candidate.id]);
  return live ?? settledState(candidate);
}
