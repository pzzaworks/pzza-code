import { create } from "zustand";
import { sessionAgent, validSessionPrompt, type SessionAgentId } from "../../server/lib/session-agents.js";

// Tasks: one prompt handed to one or more agents (best of N), each candidate
// in its own git worktree and tile. What the user asked for and what happened
// to it (merged, pull request, discarded) is kept here and survives restarts;
// live state (working, needs you, review) is derived from signals instead,
// see taskStatus and TaskTracker.

const KEY = "pzza.tasks.v1";
const MAX_TASKS = 200;

export type TaskOutcome = "merged" | "pr" | "discarded";
export type PromptDelivery = "command" | "pending" | "sent";
export type CheckStatus = "none" | "unapproved" | "ready" | "running" | "passed" | "failed" | "timeout" | "error";

export interface CandidateStatsSummary {
  files: number;
  added: number;
  removed: number;
  commits: number;
  dirty: boolean;
  head: string | null;
  at: number;
}

export interface CandidateCheck {
  status: CheckStatus;
  commands: string[];
  at: number;
  durationMs?: number;
  code?: number | null;
  output?: string;
  error?: string;
  /** The worktree state the check ran on (HEAD and diff size); a different state makes the result stale. */
  state?: string;
}

export interface TaskCandidate {
  id: string;
  agent: { id: SessionAgentId; mode: string };
  launch: "starting" | "failed" | "started";
  error?: string;
  /**
   * A failed launch whose leftovers (worktree, branch) were not looked at yet: set when it fails and
   * for a launch the app lost track of (quit or reloaded mid-launch), cleared once reclaimed.
   */
  cleanupPending?: boolean;
  session: string;
  tileId: string;
  worktree: string;
  branch: string;
  promptDelivery: PromptDelivery;
  startedAt: number;
  /** Last time its output was seen moving, for the time it worked. */
  lastActiveAt?: number;
  outcome?: TaskOutcome;
  outcomeAt?: number;
  prUrl?: string;
  mergedCommit?: string;
  /** Files the worktree setup copied from the main checkout: never committed by the app. */
  copied: string[];
  stats?: CandidateStatsSummary;
  check?: CandidateCheck;
}

export type TaskMode = "one" | "parallel" | "chain" | "race";
export type ChainPreset = "review" | "plan" | "custom";
export type ChainRole = "write" | "review" | "fix" | "plan" | "build" | "custom";
export type StepStatus = "waiting" | "running" | "done" | "paused" | "failed" | "skipped";

/** One step of a chain: an agent given one instruction in the chain's worktree. */
export interface ChainStep {
  id: string;
  role: ChainRole;
  agent: { id: SessionAgentId; mode: string };
  status: StepStatus;
  /** A Custom step's own instruction, as the user typed it. */
  custom?: string;
  /** What the step's agent is told, set when the step starts. */
  instruction?: string;
  /** The tmux session the step runs in (a new one, or an earlier step's of the same agent). */
  session?: string;
  tileId?: string;
  startedAt?: number;
  endedAt?: number;
  /** The agent's output was seen moving during this step: its going quiet after that is the finish. */
  sawWork?: boolean;
  /** Why the step paused or failed, in a few words. */
  note?: string;
}

/**
 * A chain: steps run one after another in one worktree on one branch. A handoff
 * is recorded before the next step is launched or sent, so a restart never
 * starts a step twice.
 */
export interface TaskChain {
  preset: ChainPreset;
  steps: ChainStep[];
  state: "running" | "paused" | "stopped" | "done";
  handoff?: { step: number; kind: "launch" | "send"; session: string; at: number };
}

export interface Task {
  id: string;
  title: string;
  prompt: string;
  slug: string;
  deviceId: string;
  host: string;
  repo: string;
  base: string;
  workspaceId: string;
  createdAt: number;
  candidates: TaskCandidate[];
  winnerId?: string;
  /** How it was started: one agent (also each task of a parallel batch), a chain, or a race of agents. */
  mode: TaskMode;
  chain?: TaskChain;
}

// ---------------------------------------------------------------- validation

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const text = (value: unknown, max = 4096): value is string => typeof value === "string" && value.length <= max && !/[\u0000-\u0008\u000b-\u001f\u007f]/.test(value);
const time = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;
const absolute = (value: unknown): value is string => text(value) && value.startsWith("/");
const optional = <T,>(value: unknown, check: (item: unknown) => item is T): T | undefined => (check(value) ? value : undefined);

function readStats(value: unknown): CandidateStatsSummary | undefined {
  if (!isRecord(value)) return undefined;
  const { files, added, removed, commits, dirty, head, at } = value;
  if (![files, added, removed, commits].every((count) => typeof count === "number" && Number.isInteger(count) && count >= 0) || typeof dirty !== "boolean" || !time(at)) return undefined;
  return { files: files as number, added: added as number, removed: removed as number, commits: commits as number, dirty, head: typeof head === "string" && /^[0-9a-f]{7,64}$/.test(head) ? head : null, at };
}

const CHECK_STATUSES: readonly CheckStatus[] = ["none", "unapproved", "ready", "running", "passed", "failed", "timeout", "error"];
function readCheck(value: unknown): CandidateCheck | undefined {
  if (!isRecord(value) || !CHECK_STATUSES.includes(value.status as CheckStatus) || !Array.isArray(value.commands) || !value.commands.every((item) => text(item, 500)) || !time(value.at)) return undefined;
  // A check cannot still be running after a restart: the request that ran it is gone.
  const status = value.status === "running" ? "error" : value.status as CheckStatus;
  return {
    status, commands: value.commands as string[], at: value.at,
    durationMs: optional(value.durationMs, time), code: typeof value.code === "number" ? value.code : null,
    output: optional(value.output, (item): item is string => text(item, 16384)),
    error: value.status === "running" ? "The app restarted while the check ran." : optional(value.error, (item): item is string => text(item, 600)),
    state: optional(value.state, (item): item is string => text(item, 200)),
  };
}

function readCandidate(value: unknown): TaskCandidate | null {
  if (!isRecord(value)) return null;
  const rawAgent = isRecord(value.agent) ? value.agent : undefined;
  const agent = sessionAgent(rawAgent?.id);
  // A mode the catalog no longer has falls back to the agent's default.
  const mode = agent?.modes.find((item) => item.id === rawAgent?.mode)?.id ?? agent?.defaultMode;
  if (!agent || !mode || !text(value.id, 64) || !text(value.session, 128) || !text(value.tileId, 300) || !text(value.branch, 255) || !time(value.startedAt)) return null;
  if (value.worktree !== "" && !absolute(value.worktree)) return null;
  const launch = value.launch === "started" || value.launch === "failed" ? value.launch : value.launch === "starting" ? "failed" : null;
  if (!launch) return null;
  const delivery: PromptDelivery = value.promptDelivery === "pending" || value.promptDelivery === "sent" ? value.promptDelivery : "command";
  const outcome = value.outcome === "merged" || value.outcome === "pr" || value.outcome === "discarded" ? value.outcome : undefined;
  return {
    id: value.id, agent: { id: agent.id, mode }, launch,
    error: value.launch === "starting" ? "The app closed while this attempt was starting." : optional(value.error, (item): item is string => text(item, 600)),
    cleanupPending: value.launch === "starting" || (launch === "failed" && value.cleanupPending === true) ? true : undefined,
    session: value.session, tileId: value.tileId, worktree: value.worktree as string, branch: value.branch, promptDelivery: delivery,
    startedAt: value.startedAt, lastActiveAt: optional(value.lastActiveAt, time), outcome, outcomeAt: optional(value.outcomeAt, time),
    prUrl: optional(value.prUrl, (item): item is string => text(item, 2048) && /^https:\/\/\S+$/.test(item)),
    mergedCommit: optional(value.mergedCommit, (item): item is string => typeof item === "string" && /^[0-9a-f]{7,64}$/.test(item)),
    copied: Array.isArray(value.copied) ? value.copied.filter((item): item is string => text(item, 4096)).slice(0, 200) : [],
    stats: readStats(value.stats), check: readCheck(value.check),
  };
}

const CHAIN_ROLES: readonly ChainRole[] = ["write", "review", "fix", "plan", "build", "custom"];
const STEP_STATUSES: readonly StepStatus[] = ["waiting", "running", "done", "paused", "failed", "skipped"];

function readStep(value: unknown): ChainStep | null {
  if (!isRecord(value) || !text(value.id, 64) || !CHAIN_ROLES.includes(value.role as ChainRole) || !STEP_STATUSES.includes(value.status as StepStatus)) return null;
  const rawAgent = isRecord(value.agent) ? value.agent : undefined;
  const agent = sessionAgent(rawAgent?.id);
  const mode = agent?.modes.find((item) => item.id === rawAgent?.mode)?.id ?? agent?.defaultMode;
  if (!agent || !mode) return null;
  // A Custom step is nothing without its instruction; other roles carry none.
  const custom = value.role === "custom" ? value.custom : undefined;
  if (value.role === "custom" && !(typeof custom === "string" && validSessionPrompt(custom))) return null;
  return {
    id: value.id, role: value.role as ChainRole, agent: { id: agent.id, mode }, status: value.status as StepStatus,
    ...(typeof custom === "string" ? { custom } : {}),
    session: optional(value.session, (item): item is string => text(item, 128)), tileId: optional(value.tileId, (item): item is string => text(item, 300)),
    startedAt: optional(value.startedAt, time), endedAt: optional(value.endedAt, time), sawWork: value.sawWork === true ? true : undefined,
    note: optional(value.note, (item): item is string => text(item, 600)),
    instruction: optional(value.instruction, (item): item is string => typeof item === "string" && item.length <= 4096),
  };
}

function readChain(value: unknown): TaskChain | undefined {
  if (!isRecord(value) || (value.preset !== "review" && value.preset !== "plan" && value.preset !== "custom") || !Array.isArray(value.steps)) return undefined;
  const steps = value.steps.map(readStep);
  if (!steps.length || steps.some((step) => step === null)) return undefined;
  const state = value.state === "paused" || value.state === "stopped" || value.state === "done" ? value.state : "running";
  const raw = isRecord(value.handoff) ? value.handoff : undefined;
  const handoff = raw && typeof raw.step === "number" && Number.isInteger(raw.step) && raw.step >= 0 && raw.step < steps.length
    && (raw.kind === "launch" || raw.kind === "send") && text(raw.session, 128) && time(raw.at) ? { step: raw.step, kind: raw.kind === "send" ? "send" as const : "launch" as const, session: String(raw.session), at: Number(raw.at) } : undefined;
  return { preset: value.preset, steps: steps as ChainStep[], state, ...(handoff ? { handoff } : {}) };
}

export function readTask(value: unknown): Task | null {
  if (!isRecord(value) || !text(value.id, 64) || !text(value.title, 200) || !text(value.prompt, 4000) || !text(value.slug, 64) || !text(value.deviceId, 200)
    || !text(value.host, 300) || !absolute(value.repo) || !text(value.base, 255) || !text(value.workspaceId, 200) || !time(value.createdAt) || !Array.isArray(value.candidates)) return null;
  const candidates = value.candidates.map(readCandidate).filter((item): item is TaskCandidate => item !== null);
  if (!candidates.length) return null;
  const chain = readChain(value.chain);
  const mode: TaskMode = chain ? "chain" : value.mode === "parallel" || value.mode === "one" || value.mode === "race" ? value.mode : candidates.length > 1 ? "race" : "one";
  return {
    id: value.id, title: value.title, prompt: value.prompt, slug: value.slug, deviceId: value.deviceId, host: value.host, repo: value.repo, base: value.base,
    workspaceId: value.workspaceId, createdAt: value.createdAt, candidates,
    winnerId: typeof value.winnerId === "string" && candidates.some((item) => item.id === value.winnerId) ? value.winnerId : undefined,
    mode, ...(chain ? { chain } : {}),
  };
}

function load(): Task[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (!isRecord(value) || !Array.isArray(value.tasks)) return [];
    return value.tasks.map(readTask).filter((task): task is Task => task !== null).slice(0, MAX_TASKS);
  } catch {
    return [];
  }
}

/**
 * Landed, discarded, or failed with nothing left behind: a failed launch that still has a worktree to
 * discard, or leftovers not looked at yet, is not settled.
 */
/** A failed launch whose worktree was kept because it holds work: discarded like any other candidate. */
export const failedWithWorktree = (candidate: TaskCandidate): boolean => candidate.launch === "failed" && !!candidate.worktree && !candidate.outcome;

export const candidateSettled = (candidate: TaskCandidate): boolean =>
  !!candidate.outcome || (candidate.launch === "failed" && !candidate.worktree && !candidate.cleanupPending);

// Over the cap, the oldest settled tasks go first; a task with work still in
// play is never dropped.
function capTasks(tasks: Task[]): Task[] {
  if (tasks.length <= MAX_TASKS) return tasks;
  const settled = (task: Task) => task.candidates.every(candidateSettled);
  const drop = new Set(tasks.filter(settled).slice(-(tasks.length - MAX_TASKS)).map((task) => task.id));
  return tasks.filter((task) => !drop.has(task.id));
}

let saveWarned = false;
function save(tasks: Task[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify({ tasks }));
    saveWarned = false;
  } catch {
    // Storage full or unavailable: tasks still work in this window; say so once.
    if (saveWarned) return;
    saveWarned = true;
    queueMicrotask(() => useTasksUi.getState().say({ text: "Tasks could not be saved, so changes since now are lost when the app restarts. Clear finished tasks to free space.", failed: true }));
  }
}

// --------------------------------------------------------------------- store

interface TaskState {
  tasks: Task[];
  addTask(task: Task): void;
  updateTask(id: string, change: Partial<Omit<Task, "id" | "candidates">>): void;
  addCandidate(taskId: string, candidate: TaskCandidate): void;
  updateCandidate(taskId: string, candidateId: string, change: Partial<Omit<TaskCandidate, "id">>): void;
  removeTask(id: string): void;
}

export const useTasks = create<TaskState>((set, get) => {
  const commit = (tasks: Task[]) => { save(tasks); set({ tasks }); };
  return {
    tasks: load(),
    addTask: (task) => commit(capTasks([task, ...get().tasks.filter((item) => item.id !== task.id)])),
    updateTask: (id, change) => commit(get().tasks.map((task) => (task.id === id ? { ...task, ...change } : task))),
    addCandidate: (taskId, candidate) => commit(get().tasks.map((task) => (task.id === taskId ? { ...task, candidates: [...task.candidates, candidate] } : task))),
    updateCandidate: (taskId, candidateId, change) => {
      let changed = false;
      const tasks = get().tasks.map((task) => {
        if (task.id !== taskId) return task;
        return {
          ...task,
          candidates: task.candidates.map((candidate) => {
            if (candidate.id !== candidateId) return candidate;
            const keys = Object.keys(change) as (keyof typeof change)[];
            // Stats read again with the same numbers change nothing but their time.
            const same = (key: keyof typeof change) => (key === "stats" && candidate.stats && change.stats
              ? JSON.stringify({ ...candidate.stats, at: 0 }) === JSON.stringify({ ...change.stats, at: 0 })
              : candidate[key] === change[key]);
            if (keys.every(same)) return candidate;
            changed = true;
            return { ...candidate, ...change };
          }),
        };
      });
      if (changed) commit(tasks);
    },
    removeTask: (id) => commit(get().tasks.filter((task) => task.id !== id)),
  };
});

export function findCandidate(taskId: string, candidateId: string): { task: Task; candidate: TaskCandidate } | null {
  const task = useTasks.getState().tasks.find((item) => item.id === taskId);
  const candidate = task?.candidates.find((item) => item.id === candidateId);
  return task && candidate ? { task, candidate } : null;
}

// ------------------------------------------------------------ dropdown state

// The Tasks dropdown in the top bar and the view it shows: the list, the
// new-task form, one task at a glance, or its commit step. Opened from
// anywhere: the top bar, the palette, the shortcut or a notice. A task's full
// details (attempts or steps, changes, land checks, every action) open in
// the task window instead, like a tile's Checkpoints.
export type TaskView =
  | { kind: "list" }
  | { kind: "new"; retryOf?: { taskId: string } }
  | { kind: "task"; taskId: string }
  | { kind: "commit"; taskId: string; candidateId: string };
export interface TaskDetails { taskId: string; candidateId?: string; step?: number }
export interface BoardNotice { text: string; failed: boolean; url?: string }
interface TasksUiState {
  open: boolean;
  /** Bumped every time the dropdown opens, so attempts refresh their Git data. */
  opened: number;
  view: TaskView;
  /** The new-task prompt being written, kept while the dropdown is closed. */
  draft: string;
  /** The outcome of the last action, shown until dismissed or replaced. */
  notice: BoardNotice | null;
  /** The task window: which task, and which attempt or chain step it shows. */
  details: TaskDetails | null;
  openDetails(details: TaskDetails): void;
  closeDetails(): void;
  /** Opens the dropdown, on `view` when given (else where it was left). */
  show(view?: TaskView): void;
  close(): void;
  toggle(): void;
  go(view: TaskView): void;
  setDraft(draft: string): void;
  say(notice: BoardNotice | null): void;
}

export const useTasksUi = create<TasksUiState>((set, get) => ({
  open: false,
  opened: 0,
  view: { kind: "list" },
  draft: "",
  notice: null,
  details: null,
  // The window takes over from the dropdown, as Notifications hands over to Settings.
  openDetails: (details) => set({ details, open: false, notice: null }),
  closeDetails: () => set({ details: null }),
  show: (view) => set((state) => ({ open: true, opened: state.open ? state.opened : state.opened + 1, ...(view ? { view, notice: null } : {}) })),
  close: () => set({ open: false, notice: null }),
  toggle: () => (get().open ? get().close() : get().show()),
  go: (view) => set({ view, notice: null }),
  setDraft: (draft) => set({ draft }),
  say: (notice) => set({ notice }),
}));
