// How a task candidate's state is read from signals the app already has: the
// terminal's output activity, the approval prompt watcher, the agent's bell,
// whether its tile is open, its Git changes and its pull request. Pure, so the
// rules can be tested without a device.

export type CandidatePhase = "starting" | "working" | "needs-you" | "review" | "pr" | "merged" | "discarded" | "failed";
export type TaskColumn = "working" | "needs-you" | "review" | "done";

export const TASK_COLUMNS: readonly { id: TaskColumn; label: string; hint: string }[] = [
  { id: "working", label: "Working", hint: "Agents busy on their worktree" },
  { id: "needs-you", label: "Needs you", hint: "Approvals, questions and prompts to send" },
  { id: "review", label: "Review", hint: "Stopped with changes to look at" },
  { id: "done", label: "Done", hint: "Merged, in a pull request or discarded" },
];

/** No output for this long after it moved means the agent stopped (as the checkpoint turn watch). */
export const IDLE_MS = 8000;
/** The output poll interval: output seen within one poll after a bell was printed before it. */
export const OUTPUT_POLL_MS = 4000;
const BELL_GRACE_MS = OUTPUT_POLL_MS + 1500;

export interface CandidateSignals {
  now: number;
  launch: "starting" | "failed" | "started";
  outcome?: "merged" | "pr" | "discarded";
  tileOpen: boolean;
  /** Whether a coding agent is in the tile's foreground; undefined when the device has not said. */
  agentRunning: boolean | undefined;
  permission: boolean;
  promptPending: boolean;
  /** Local time the tile's output was last seen moving (the first reading counts as movement). */
  outputMovedAt?: number;
  /** Local time of the agent's last attention signal (bell or notification). */
  bellAt?: number;
  /** Commits ahead of the base or uncommitted files; undefined until known. */
  changes: boolean | undefined;
  pr?: { state: "OPEN" | "MERGED" | "CLOSED" } | null;
}

export interface CandidateState {
  phase: CandidatePhase;
  /** Why it needs you, or what it is doing, in a few words. */
  reason: string;
  working: boolean;
}

/** Output moved recently, and not only the burst printed right before the agent rang. */
export function outputWorking(signals: Pick<CandidateSignals, "now" | "outputMovedAt" | "bellAt">): boolean {
  const { now, outputMovedAt, bellAt } = signals;
  if (outputMovedAt === undefined || now - outputMovedAt >= IDLE_MS) return false;
  return bellAt === undefined || outputMovedAt - bellAt > BELL_GRACE_MS;
}

export function candidateState(signals: CandidateSignals): CandidateState {
  const state = (phase: CandidatePhase, reason: string, working = false): CandidateState => ({ phase, reason, working });
  if (signals.outcome === "discarded") return state("discarded", "Discarded");
  if (signals.outcome === "merged" || signals.pr?.state === "MERGED") return state("merged", "Merged");
  if (signals.launch === "starting") return state("starting", "Creating the worktree", true);
  if (signals.launch === "failed") return state("failed", "Could not start");
  // A proposed candidate stays proposed while its pull request cannot be read (gh missing, offline).
  if (signals.pr?.state === "OPEN" || (signals.outcome === "pr" && !signals.pr)) return state("pr", "Pull request open");
  if (signals.permission) return state("needs-you", "Approval needed");
  if (signals.promptPending) return state("needs-you", "Prompt not sent yet");
  if (!signals.tileOpen) return signals.changes ? state("review", "Session closed") : state("needs-you", "Session closed");
  const working = outputWorking(signals);
  if (working) return state("working", signals.agentRunning === false ? "Running setup" : "Working", true);
  if (signals.changes) return state("review", signals.agentRunning === false ? "Agent exited" : "Ready for review");
  if (signals.agentRunning === false) return state("needs-you", "Agent exited without changes");
  if (signals.outputMovedAt === undefined) return state("starting", "Starting", true);
  if (signals.changes === undefined) return state("working", "Checking changes");
  return state("needs-you", "Waiting for you");
}

const COLUMN_OF: Record<CandidatePhase, TaskColumn> = {
  starting: "working", working: "working", "needs-you": "needs-you", failed: "needs-you", review: "review", pr: "done", merged: "done", discarded: "done",
};
export const phaseColumn = (phase: CandidatePhase): TaskColumn => COLUMN_OF[phase];

// Most urgent first: one candidate that needs you puts the whole task there.
const URGENCY: readonly TaskColumn[] = ["needs-you", "working", "review", "done"];

/** The column of a task from its candidates' phases. A landed candidate (PR or merge) settles the task. */
export function taskColumn(phases: readonly CandidatePhase[]): TaskColumn {
  if (!phases.length) return "needs-you";
  if (phases.some((phase) => phase === "merged" || phase === "pr")) return "done";
  const columns = phases.map(phaseColumn);
  return URGENCY.find((column) => columns.includes(column)) ?? "done";
}

export const PHASE_LABEL: Record<CandidatePhase, string> = {
  starting: "Starting", working: "Working", "needs-you": "Needs you", review: "Review", pr: "PR open", merged: "Merged", discarded: "Discarded", failed: "Failed",
};

/** "45s", "12m", "3h 05m", "2d 4h". */
export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.floor(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

/** Longest task slug: with "-<agent>-<n>" it stays within the 60 characters of a worktree name. */
export const TASK_SLUG_MAX = 40;

/** A branch-safe slug for a task title: lowercase letters, digits and single hyphens, cut at a word. */
export function taskSlug(title: string, max = TASK_SLUG_MAX): string {
  // Accents fold to their base letter (NFKD splits off the combining marks).
  const full = title.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  let slug = full.slice(0, max);
  if (full.length > max && full[max] !== "-" && slug.lastIndexOf("-") >= 12) slug = slug.slice(0, slug.lastIndexOf("-"));
  return slug.replace(/-+$/, "") || "task";
}

/** The tmux session name of each candidate: the slug alone, or slug-agent with a counter for repeats. */
export function candidateSessionNames(slug: string, agents: readonly string[]): string[] {
  if (agents.length === 1) return [slug];
  const seen = new Map<string, number>();
  return agents.map((agent) => {
    const count = (seen.get(agent) ?? 0) + 1;
    seen.set(agent, count);
    const repeats = agents.filter((other) => other === agent).length > 1;
    return `${slug}-${agent}${repeats ? `-${count}` : ""}`;
  });
}

/** The branch the server creates for a worktree session (session-create.js worktreeSlug). */
export function worktreeBranch(sessionName: string): string {
  const slug = sessionName.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").replace(/^-+|-+$/g, "").slice(0, 60);
  return `pzza/${slug}`;
}
