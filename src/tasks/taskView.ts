import { useMemo } from "react";
import { settledState, useTaskLive, type CandidateLive } from "./taskLive";
import { taskColumn, type TaskColumn } from "./taskStatus";
import { useTasks, type Task, type TaskCandidate } from "./taskStore";

// List-level reads shared by the top bar button and the dropdown: each task's
// column from its candidates' live states.

export function candidateLive(live: Record<string, CandidateLive>, candidate: TaskCandidate): CandidateLive {
  return live[candidate.id] ?? settledState(candidate);
}

export function columnOf(task: Task, live: Record<string, CandidateLive>): TaskColumn {
  const column = taskColumn(task.candidates.map((candidate) => candidateLive(live, candidate).phase));
  // A chain between steps is still at work; a paused one waits on you; it is up for review only once its last step is done.
  if (task.chain?.state === "paused") return "needs-you";
  if (task.chain?.state === "running") return column === "needs-you" || column === "done" ? column : "working";
  return column;
}

/** Tasks per column, newest first. */
export function useTaskColumns(): Record<TaskColumn, Task[]> {
  const tasks = useTasks((state) => state.tasks);
  const live = useTaskLive((state) => state.live);
  return useMemo(() => {
    const columns: Record<TaskColumn, Task[]> = { working: [], "needs-you": [], review: [], done: [] };
    for (const task of [...tasks].sort((a, b) => b.createdAt - a.createdAt)) columns[columnOf(task, live)].push(task);
    return columns;
  }, [tasks, live]);
}

/** How many tasks wait on the user (the top bar badge). */
export function useNeedsYouCount(): number {
  const tasks = useTasks((state) => state.tasks);
  return useTaskLive((state) => tasks.filter((task) => columnOf(task, state.live) === "needs-you").length);
}

/** Time the candidate has worked: running ones count to now, settled ones to their last output. */
export function candidateElapsed(candidate: TaskCandidate, live: CandidateLive, now: number): number {
  const end = candidate.outcomeAt ?? (live.working || live.phase === "needs-you" || live.phase === "starting" ? now : candidate.lastActiveAt ?? now);
  return Math.max(0, end - candidate.startedAt);
}
