import { useStore } from "../state/store";
import { useCheckpointsUi } from "../checkpoints";
import { createSessionInApp, useSessionCreation, WORKTREE_COLLISION } from "../sessionActions";
import { deviceHost } from "../devices";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID } from "../workspaces";
import { hasPendingPermission } from "../state/permissionPrompts";
import { sendPromptToTile } from "../terminal/broadcast";
import { openTileChangesView, openWebPage } from "../tileGit";
import { hasUnsavedEditors } from "../editorChanges";
import { fetchSessions, killSession, scanDevice } from "../serverApi";
import { notify } from "../state/notifications";
import { approvalGate, cleanGate, gateFailure, idleGate, mergeWorktree, openWorktreePr, type Gate, type LandKind, type LandResult } from "../worktreeLand";
import { agentTakesPrompt, sessionAgent, sessionAgentMode, validSessionPrompt, type SessionAgentId } from "../../server/lib/session-agents.js";
import {
  approveTaskCheck, commitTaskWorktree, discardTaskWorktree, fetchTaskBranches, reclaimTaskWorktree, runTaskCheck,
  type DiscardPreview, type ReclaimReason, type ReclaimResult, type TaskStats,
} from "./taskApi";
import { candidateSessionNames, TASK_SLUG_MAX, taskSlug, worktreeBranch } from "./taskStatus";
import { refreshCandidate, settledState, useTaskLive, type CandidateLive } from "./taskLive";
import { findCandidate, useTasks, type CandidateCheck, type Task, type TaskCandidate, type TaskChain, type TaskMode } from "./taskStore";
import { agentAbsence, chainPreset, chainSteps, ROLE_LABEL, type StepSpec } from "./taskChain";

// What Tasks does with a task: start it (a worktree and a tile per
// agent, through the regular new-session path), send a prompt by hand,
// bring a tile forward, land a candidate behind its gates, commit, run the
// check, discard with a confirmed preview, retry with another agent.

export interface AgentPick { id: SessionAgentId; mode: string }
export interface NewTaskInput {
  title: string; prompt: string; deviceId: string; repo: string; base: string;
  /** The agents to start: one, or every agent of a race. A chain's come from its steps. */
  agents: AgentPick[];
  /** One task, one of a parallel batch, a race of the agents (best of N), or a chain of steps (one agent per step). */
  mode?: TaskMode;
  /** A chain's steps, in order: any roles, any number, at least one. */
  steps?: StepSpec[];
}

const BRANCH = /^(?!-)(?!.*(?:\.\.|@\{|\/\/|\/\.|\.lock$|\/$))[A-Za-z0-9._/-]{1,255}$/;
const NAME_ATTEMPTS = 5;

/** The agents a new task starts sessions for: a chain's step agents, else the agents picked. */
const inputAgents = (input: NewTaskInput): AgentPick[] => (input.mode === "chain" ? (input.steps ?? []).map((step) => step.agent) : input.agents);

/** The error to show for the new-task form, or null when it can start. */
export function newTaskProblem(input: NewTaskInput): string | null {
  if (!input.prompt.trim()) return "Describe the task for the agents.";
  if (!validSessionPrompt(input.prompt)) return "Prompts are one line of at most 4000 characters and cannot start with \"-\".";
  if (!input.repo.startsWith("/")) return "Choose the repository folder.";
  if (!BRANCH.test(input.base)) return "Choose the base branch.";
  const agents = inputAgents(input);
  if (!agents.length) return input.mode === "chain" ? "Add a step." : "Choose an agent.";
  if (agents.some((agent) => !sessionAgent(agent.id))) return "Choose agents from the list.";
  // A Custom step's instruction goes on the agent's command line like a prompt.
  const custom = (input.mode === "chain" ? input.steps ?? [] : []).findIndex((step) => step.role === "custom" && !validSessionPrompt(step.custom ?? ""));
  if (custom >= 0) {
    return (input.steps?.[custom]?.custom ?? "").trim()
      ? `Step ${custom + 1}: instructions are one line of at most 4000 characters and cannot start with "-".`
      : `Step ${custom + 1}: write what the ${ROLE_LABEL.custom} step should do.`;
  }
  if (!useStore.getState().activeDevices.some((device) => device.id === input.deviceId)) return "Choose a configured device.";
  return null;
}

/** The first line of the prompt, cut at a word, as a title. */
export function titleFromPrompt(prompt: string): string {
  const clean = prompt.replace(/\s+/g, " ").trim();
  if (clean.length <= 72) return clean;
  const cut = clean.slice(0, 72);
  return `${cut.slice(0, Math.max(40, cut.lastIndexOf(" ")))}…`;
}

const tileIdOf = (host: string, name: string) => (host ? `${host}::${name}` : name);

// A slug no other task or open session of this device uses yet.
function freeSlug(base: string, host: string, agents: readonly string[], elsewhere: readonly string[]): string {
  const state = useStore.getState();
  const taken = new Set([
    ...elsewhere,
    ...useTasks.getState().tasks.filter((task) => task.host === host).flatMap((task) => task.candidates.map((candidate) => candidate.session)),
    ...state.tiles.filter((tile) => (tile.host ?? "") === host).map((tile) => tile.session ?? tile.name),
    ...(host ? [] : state.allSessions.map((session) => session.name)),
  ]);
  for (let attempt = 1; attempt < 100; attempt++) {
    const slug = attempt === 1 ? base : `${base.slice(0, TASK_SLUG_MAX - 3).replace(/-+$/, "")}-${attempt}`;
    if (candidateSessionNames(slug, agents).every((name) => !taken.has(name) && !taken.has(worktreeBranch(name)))) return slug;
  }
  return `${base.slice(0, TASK_SLUG_MAX - 10).replace(/-+$/, "")}-${Date.now().toString(36)}`;
}

function workspaceForNewTiles(): string {
  const state = useStore.getState();
  const active = state.activeWorkspaceId;
  return active === ALL_WORKSPACE_ID || !state.workspaces.some((item) => item.id === active) ? DEFAULT_WORKSPACE_ID : active;
}

// The regular session creation runs one at a time; a session the user is
// creating meanwhile is waited for instead of failing the task.
export function creationIdle(): Promise<void> {
  if (useSessionCreation.getState().operation?.status !== "running") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("Another session took too long to start.")); }, 120000);
    const stop = useSessionCreation.subscribe((state) => {
      if (state.operation?.status === "running") return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

// Task launches run one after another, across tasks, chains and retries: the
// regular session creation takes one at a time (createSessionInApp refuses a
// second while one runs). Any number of launches can wait here; none is dropped.
let launches: Promise<unknown> = Promise.resolve();
export function enqueueLaunch<T>(work: () => Promise<T>): Promise<T> {
  const run = launches.then(work, work);
  launches = run.catch(() => undefined);
  return run;
}

function newCandidate(host: string, name: string, agent: AgentPick): TaskCandidate {
  const definition = sessionAgent(agent.id);
  return {
    id: crypto.randomUUID(), agent: { id: agent.id, mode: definition ? sessionAgentMode(definition, agent.mode).id : agent.mode }, launch: "starting",
    session: name, tileId: tileIdOf(host, name), worktree: "", branch: worktreeBranch(name),
    promptDelivery: agentTakesPrompt(definition) ? "command" : "pending", startedAt: Date.now(), copied: [],
  };
}

// Starts one candidate: a fresh worktree from the task's base on a new
// pzza/ branch, its setup, and the agent with the prompt on its command line
// when the agent takes one. A name a leftover worktree still holds moves on
// to the next suffix.
async function launchCandidate(task: Task, candidateId: string): Promise<void> {
  const { updateCandidate } = useTasks.getState();
  for (let attempt = 1; attempt <= NAME_ATTEMPTS; attempt++) {
    const found = findCandidate(task.id, candidateId);
    if (!found) return;
    const { candidate } = found;
    const name = attempt === 1 ? candidate.session : `${candidate.session.replace(/-r\d+$/, "")}-r${attempt}`;
    if (attempt > 1) updateCandidate(task.id, candidateId, { session: name, tileId: tileIdOf(task.host, name), branch: worktreeBranch(name) });
    const definition = sessionAgent(candidate.agent.id);
    // A chain's first step gets its own instruction (a planner is told to plan).
    const latest = useTasks.getState().tasks.find((item) => item.id === task.id) ?? task;
    const prompt = agentTakesPrompt(definition) ? (latest.chain?.steps[0]?.instruction ?? task.prompt).trim() : undefined;
    try {
      await creationIdle();
      let created: { cwd?: string; copied: string[] } = { copied: [] };
      const tileId = await createSessionInApp({
        name, deviceId: task.deviceId, workspaceId: task.workspaceId, cwd: task.repo, worktree: true, base: task.base,
        agent: { id: candidate.agent.id, mode: candidate.agent.mode, ...(prompt ? { prompt } : {}) },
      }, (details) => { created = { cwd: details.cwd, copied: details.setup?.copied ?? [] }; });
      const worktree = created.cwd ?? useStore.getState().tiles.find((tile) => tile.id === tileId)?.cwd ?? "";
      updateCandidate(task.id, candidateId, { launch: "started", tileId, worktree, copied: created.copied, startedAt: Date.now(), error: undefined });
      const chain = useTasks.getState().tasks.find((item) => item.id === task.id)?.chain;
      if (chain) useTasks.getState().updateTask(task.id, { chain: { ...chain, steps: chain.steps.map((step, index) => (index === 0 ? { ...step, session: name, tileId } : step)) } });
      return;
    } catch (error) {
      const message = error instanceof Error ? error.message : "Could not start this agent.";
      const collision = WORKTREE_COLLISION.test(message);
      if (collision && attempt < NAME_ATTEMPTS) continue;
      // A name collision created nothing (the folder or branch was already there). Any other
      // failure may have come after the worktree step: TaskTracker reclaims what it left.
      updateCandidate(task.id, candidateId, { launch: "failed", error: message, ...(collision ? {} : { cleanupPending: true }) });
      return;
    }
  }
}

/** Records the task and starts its candidates one after another. */
export async function createTask(input: NewTaskInput): Promise<string> {
  const problem = newTaskProblem(input);
  if (problem) throw new Error(problem);
  const device = useStore.getState().activeDevices.find((item) => item.id === input.deviceId);
  if (!device) throw new Error("Choose a configured device.");
  const host = deviceHost(device);
  const title = input.title.trim().replace(/[\u0000-\u001f\u007f]+/g, " ").slice(0, 200) || titleFromPrompt(input.prompt);
  // Names already used on the device: its sessions and the repository's branches.
  const [sessions, branches] = await Promise.all([
    (host ? scanDevice(host) : fetchSessions()).then((list) => list.map((item) => item.name)).catch(() => [] as string[]),
    fetchTaskBranches(host, input.repo).then((data) => data.branches).catch(() => [] as string[]),
  ]);
  // A chain runs its steps in one worktree: one candidate, started by its first step's agent.
  const chained = input.mode === "chain";
  const launching = chained ? inputAgents(input).slice(0, 1) : input.agents;
  const slug = freeSlug(taskSlug(title), host, launching.map((agent) => agent.id), [...sessions, ...branches]);
  const names = candidateSessionNames(slug, launching.map((agent) => agent.id));
  const prompt = input.prompt.replace(/[\r\n]+/g, " ").trim();
  const mode: TaskMode = input.mode ?? (input.agents.length > 1 ? "race" : "one");
  const steps = input.steps ?? [];
  const chain: TaskChain | undefined = chained ? { preset: chainPreset(steps.map((step) => step.role)), state: "running", steps: chainSteps({ prompt, base: input.base }, steps) } : undefined;
  const task: Task = {
    id: crypto.randomUUID(), title, prompt, slug, deviceId: device.id, host, repo: input.repo, base: input.base,
    workspaceId: workspaceForNewTiles(), createdAt: Date.now(),
    candidates: launching.map((agent, index) => newCandidate(host, names[index], agent)),
    mode, ...(chain ? { chain } : {}),
  };
  useTasks.getState().addTask(task);
  void enqueueLaunch(async () => {
    for (const candidate of task.candidates) await launchCandidate(task, candidate.id);
    notifyStartFailures(task.id);
  });
  return task.id;
}

/** One line of a parallel batch: its own prompt and agent. */
export interface ParallelRow { prompt: string; agent: AgentPick }

/** Starts every row as its own task (own worktree and branch), all at once; the problem with the first bad row stops the batch before anything starts. */
export async function createParallelTasks(input: Omit<NewTaskInput, "prompt" | "agents" | "mode">, rows: readonly ParallelRow[]): Promise<string[]> {
  if (rows.length < 2) throw new Error("Write one task per line, at least two.");
  for (const [index, row] of rows.entries()) {
    const problem = newTaskProblem({ ...input, prompt: row.prompt, agents: [row.agent] });
    if (problem) throw new Error(`Line ${index + 1}: ${problem}`);
  }
  const ids: string[] = [];
  for (const row of rows) ids.push(await createTask({ ...input, title: "", prompt: row.prompt, agents: [row.agent], mode: "parallel" }));
  return ids;
}

// A task that started cleanly shows under Working in the Tasks dropdown, so
// only a launch that failed for some of its agents gets a notice.
function notifyStartFailures(taskId: string): void {
  const task = useTasks.getState().tasks.find((item) => item.id === taskId);
  if (!task) return;
  const failed = task.candidates.filter((candidate) => candidate.launch === "failed").length;
  if (!failed) return;
  const started = task.candidates.length - failed;
  notify({
    category: "app", event: "task-start-failed",
    title: started ? "Task started with problems" : "Task could not start",
    body: `${task.title}: ${started} of ${task.candidates.length} ${task.candidates.length === 1 ? "agent" : "agents"} running in ${started === 1 ? "its own worktree" : "their own worktrees"}. Open the task to see why the rest failed.`,
  });
}

/** Adds another agent to a task: a new worktree from the same base with the same prompt. */
export async function retryWithAgent(taskId: string, agent: AgentPick): Promise<string> {
  const task = useTasks.getState().tasks.find((item) => item.id === taskId);
  if (!task) throw new Error("This task is gone.");
  const base = `${task.slug}-${agent.id}`;
  const taken = new Set([...task.candidates.map((candidate) => candidate.session), ...useStore.getState().tiles.map((tile) => tile.session ?? tile.name)]);
  let name = base;
  for (let count = 2; taken.has(name); count++) name = `${base}-${count}`;
  const candidate = newCandidate(task.host, name, agent);
  useTasks.getState().addCandidate(task.id, candidate);
  // A second agent on the same prompt makes it a race.
  if (task.mode !== "race") useTasks.getState().updateTask(task.id, { mode: "race" });
  await enqueueLaunch(() => launchCandidate(task, candidate.id));
  const result = findCandidate(task.id, candidate.id);
  if (result?.candidate.launch === "failed") throw new Error(result.candidate.error ?? "Could not start this agent.");
  return candidate.id;
}

// ------------------------------------------------- launches that never finished

// A launch the app lost track of (it quit or reloaded mid-launch) may still be
// finishing on the agent server, whose create request gives up after 80
// seconds: its leftovers are looked at only once that is over.
const LAUNCH_SETTLE_MS = 90000;
const loadedAt = Date.now();
const restored = new Set(useTasks.getState().tasks.flatMap((task) => task.candidates.filter((candidate) => candidate.cleanupPending).map((candidate) => candidate.id)));
const reclaiming = new Set<string>();
let settleTimer: ReturnType<typeof setTimeout> | undefined;

const MAX_ERROR = 600;
function reclaimNote(error: string | undefined, result: ReclaimResult): string {
  const kept: Record<ReclaimReason, string> = {
    changes: "Its worktree has changes, so it was kept; discard it once you have looked at it.",
    commits: `Its branch ${result.branch} has commits, so it was kept; discard it once you have looked at it.`,
    locked: "Its worktree is locked, so it was kept.",
    older: `A worktree on ${result.branch} existed before this launch, so it was kept; discard it if it is not needed.`,
    base: `The base branch is gone, so ${result.branch} was kept.`,
    unreadable: "Its worktree could not be read, so it was kept.",
    refused: `git would not remove its worktree, so it was kept${result.error ? ` (${result.error})` : ""}.`,
  };
  const note = result.state === "removed" ? (result.branchDeleted ? `Its unused worktree and branch ${result.branch} were removed.` : "Its unused worktree was removed.")
    : result.state === "kept" ? kept[result.reason ?? "refused"]
      : result.state === "foreign" ? `A folder or branch for ${result.branch} already belongs to something else, so it was left alone.`
        : "";
  return [error ?? "Could not start this agent.", note].filter(Boolean).join(" ").slice(0, MAX_ERROR);
}

// One failed candidate: reattached when its session is running after all (the
// launch got through but the app never heard back), else what its launch
// left behind is removed while it holds no work. A worktree with changes or
// commits is kept and recorded so the regular Discard can remove it. An
// unreachable device leaves it pending for the next try.
async function reclaimCandidate(taskId: string, candidateId: string): Promise<void> {
  const found = findCandidate(taskId, candidateId);
  if (!found || !found.candidate.cleanupPending || found.candidate.launch !== "failed" || reclaiming.has(candidateId)) return;
  const { task, candidate } = found;
  if (!useStore.getState().activeDevices.some((device) => device.id === task.deviceId)) return;
  reclaiming.add(candidateId);
  try {
    const sessions = await (task.host ? scanDevice(task.host) : fetchSessions());
    const running = sessions.some((session) => session.name === candidate.session);
    const result = await reclaimTaskWorktree(task.host, task.repo, candidate.session, task.base, candidate.startedAt, !running);
    const { updateCandidate } = useTasks.getState();
    if (running && result.state === "present" && result.worktree) {
      updateCandidate(task.id, candidate.id, { launch: "started", worktree: result.worktree, error: undefined, cleanupPending: undefined });
      return;
    }
    updateCandidate(task.id, candidate.id, {
      cleanupPending: undefined,
      error: running ? candidate.error : reclaimNote(candidate.error, result),
      ...(result.state === "kept" && result.worktree ? { worktree: result.worktree } : {}),
    });
  } catch {
    // The device or the agent server is unreachable: tried again on the next pass.
  } finally {
    reclaiming.delete(candidateId);
  }
}

/** Reclaims every failed launch not looked at yet, one at a time (TaskTracker runs it). */
export async function reconcileTaskLaunches(): Promise<void> {
  const wait = loadedAt + LAUNCH_SETTLE_MS - Date.now();
  for (const task of useTasks.getState().tasks) {
    for (const candidate of task.candidates) {
      if (!candidate.cleanupPending) continue;
      if (restored.has(candidate.id) && wait > 0) {
        settleTimer ??= setTimeout(() => { void reconcileTaskLaunches(); }, wait);
        continue;
      }
      await reclaimCandidate(task.id, candidate.id);
    }
  }
}

// ------------------------------------------------------------- navigation

// Brings an open tile forward: its workspace, unhidden, active (the canvas scrolls to it).
function activateTile(tileId: string): void {
  const current = useStore.getState();
  const workspace = current.sessionWs[tileId] ?? DEFAULT_WORKSPACE_ID;
  if (current.activeWorkspaceId !== ALL_WORKSPACE_ID && current.activeWorkspaceId !== workspace) current.setWorkspace(workspace);
  if (current.hiddenTiles.includes(tileId)) current.unhideTile(tileId);
  current.setActive(tileId);
}

/** Shows a candidate's tile, reopening it when only its tile was closed. */
export function revealCandidate(task: Task, candidate: TaskCandidate): void {
  const state = useStore.getState();
  if (!state.tiles.some((tile) => tile.id === candidate.tileId)) {
    if (!candidate.worktree) throw new Error("This attempt never got a session.");
    state.assignSession(candidate.tileId, state.workspaces.some((item) => item.id === task.workspaceId) ? task.workspaceId : DEFAULT_WORKSPACE_ID);
    state.openSession(candidate.session, candidate.worktree, task.host);
  }
  activateTile(candidate.tileId);
}

/**
 * Points the canvas at a candidate's tile while its task is open, when that
 * tile is open: nothing is reopened. The active terminal takes the keyboard
 * when it activates; it goes back to the Tasks control that had it, so
 * moving through the list stays in the list.
 */
export function spotlightCandidate(candidate: TaskCandidate): void {
  const state = useStore.getState();
  if (!state.tiles.some((tile) => tile.id === candidate.tileId) || state.activeId === candidate.tileId) return;
  const keep = document.activeElement instanceof HTMLElement && document.activeElement.closest(".tasks-panel, .task-window") ? document.activeElement : null;
  activateTile(candidate.tileId);
  if (!keep) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    if (keep.isConnected && document.activeElement !== keep) keep.focus({ preventScroll: true });
  }));
}

export function reviewInTile(task: Task, candidate: TaskCandidate): void {
  revealCandidate(task, candidate);
  openTileChangesView(candidate.tileId, candidate.worktree);
}

export function openTimeline(task: Task, candidate: TaskCandidate): void {
  revealCandidate(task, candidate);
  useCheckpointsUi.getState().open(candidate.tileId);
}

export function openPullRequestPage(candidate: TaskCandidate, live: CandidateLive): void {
  const url = live.pr?.url ?? candidate.prUrl;
  if (!url) throw new Error("This attempt has no pull request yet.");
  openWebPage(url);
}

/** Types the task's prompt into an agent that cannot take it on its command line, then Enter. */
export async function sendTaskPrompt(task: Task, candidate: TaskCandidate): Promise<void> {
  if (!useStore.getState().tiles.some((tile) => tile.id === candidate.tileId)) throw new Error("Open the attempt's tile first.");
  if (hasPendingPermission(candidate.tileId)) throw new Error("The agent is waiting on an approval prompt. Answer it first.");
  // A chain step gets its own instruction; a task its prompt.
  const chain = useTasks.getState().tasks.find((item) => item.id === task.id)?.chain;
  const step = chain?.steps.find((item) => item.status === "running" && item.tileId === candidate.tileId);
  // Typed only into the agent itself: after it exits, the same keys would
  // run the prompt as shell commands.
  const agent = step?.agent.id ?? candidate.agent.id;
  const absent = await agentAbsence(candidate.tileId, agent);
  if (absent) {
    const label = sessionAgent(agent)?.label ?? agent;
    throw new Error(absent === "Session closed" ? "Open the attempt's tile first."
      : absent === "Agent exited" ? `${label} is no longer running in the attempt's tile, so the prompt was not typed. Start ${label} there again first.`
        : `Could not check that ${label} still runs in the attempt's tile, so the prompt was not typed.`);
  }
  await sendPromptToTile(candidate.tileId, step?.instruction ?? task.prompt);
  useTasks.getState().updateCandidate(task.id, candidate.id, { promptDelivery: "sent" });
}

// ------------------------------------------------------------------ gates

/** The worktree state a check result belongs to. */
export function checkStateKey(stats: Pick<TaskStats, "head" | "files" | "added" | "removed" | "dirty"> | undefined): string {
  return stats ? `${stats.head ?? ""}:${stats.files.length}:${stats.added}:${stats.removed}:${stats.dirty}` : "";
}

export function checkIsCurrent(check: CandidateCheck | undefined, stats: TaskStats | undefined): boolean {
  return !!check && !!stats && check.state === checkStateKey(stats);
}

/**
 * What must hold before a candidate's branch is merged or proposed: the
 * checks every worktree passes (worktreeLand) plus the task's own, the
 * prompt delivered and the repository's check command.
 * `leftovers`: the uncommitted files outside the setup copies, once read (an
 * empty list means only files the setup copied in are left, which the app
 * never commits).
 */
export function landingGates(candidate: TaskCandidate, live: CandidateLive, leftovers?: readonly string[]): Gate[] {
  const stats = live.stats;
  const check = candidate.check;
  const gates: Gate[] = [
    idleGate(live.working),
    approvalGate(hasPendingPermission(candidate.tileId)),
    { id: "prompt", label: "Prompt delivered", state: candidate.promptDelivery === "pending" ? "blocked" : "ok", detail: candidate.promptDelivery === "pending" ? "The agent never got the task." : candidate.promptDelivery === "sent" ? "Sent from Tasks." : "Given on its command line." },
    stats?.dirty && leftovers && !leftovers.length
      ? { id: "clean", label: "Worktree is clean", state: "blocked", detail: `Only files the setup copied in are uncommitted (${candidate.copied.join(", ")}). They are never committed by the app; remove or ignore them in the tile.` }
      : cleanGate(stats && { dirty: stats.dirty, uncommitted: stats.uncommitted, ahead: stats.commits.length, base: stats.base }),
  ];
  if (!check || check.status === "none") gates.push({ id: "check", label: "Check command", state: check ? "skipped" : "pending", detail: check ? "None configured in .pzzacode/worktree.json." : "Looking for a check command…" });
  else if (check.status === "running") gates.push({ id: "check", label: "Check command", state: "pending", detail: `Running ${check.commands.join(" && ")}…` });
  else if (check.status === "unapproved") gates.push({ id: "check", label: "Check command", state: "blocked", detail: "Review and approve the check commands to run them." });
  else if (check.status === "ready") gates.push({ id: "check", label: "Check command", state: "blocked", detail: "Run the check before landing." });
  else if (check.status === "passed") gates.push(checkIsCurrent(check, stats) ? { id: "check", label: "Check command", state: "ok", detail: "Passed on the current changes." } : { id: "check", label: "Check command", state: "blocked", detail: "Passed on older changes. Run it again." });
  else gates.push({ id: "check", label: "Check command", state: "blocked", detail: check.status === "timeout" ? "Timed out after 10 minutes." : check.status === "error" ? check.error ?? "Could not run." : `Failed${typeof check.code === "number" ? ` with exit code ${check.code}` : ""}.` });
  return gates;
}

/** Reads (run=false) or runs the repository's check command in the candidate's worktree, keeping the result on the candidate. */
export async function runCandidateCheck(task: Task, candidate: TaskCandidate, options: { run: boolean; approve?: string[] }): Promise<void> {
  const { updateCandidate } = useTasks.getState();
  if (options.approve) await approveTaskCheck(task.host, candidate.worktree, options.approve);
  const stats = useTaskLive.getState().live[candidate.id]?.stats;
  const at = Date.now();
  if (options.run) updateCandidate(task.id, candidate.id, { check: { status: "running", commands: candidate.check?.commands ?? options.approve ?? [], at } });
  try {
    const result = await runTaskCheck(task.host, candidate.worktree, options.run);
    updateCandidate(task.id, candidate.id, {
      check: { status: result.status, commands: result.commands, at: Date.now(), durationMs: result.durationMs, code: result.code ?? null, output: result.output?.slice(-4000), state: options.run ? checkStateKey(stats) : undefined },
    });
  } catch (error) {
    updateCandidate(task.id, candidate.id, { check: { status: "error", commands: candidate.check?.commands ?? [], at, error: error instanceof Error ? error.message.slice(0, 600) : "Could not run the check." } });
    throw error;
  }
}

export async function commitCandidate(task: Task, candidate: TaskCandidate, message: string): Promise<string> {
  const { commit } = await commitTaskWorktree(task.host, candidate.worktree, message.trim(), candidate.copied);
  refreshCandidate(candidate.id);
  return commit;
}

/** Why an attempt cannot land at all (whatever its checks say), or null when it can. */
export function landRefusal(task: Task, candidate: TaskCandidate): string | null {
  if (candidate.launch !== "started" || candidate.outcome === "discarded" || !candidate.worktree) return "This attempt has no worktree to land.";
  if (candidate.outcome === "merged") return `This attempt is already merged into ${task.base}.`;
  if (candidate.outcome === "pr") return "This attempt already has a pull request.";
  if (task.candidates.some((item) => item.id !== candidate.id && (item.outcome === "merged" || item.outcome === "pr"))) return "Another attempt of this task already landed.";
  // A chain lands once, after its last step (or once stopped).
  if (task.chain?.state === "running" || task.chain?.state === "paused") return "The chain is still running. It lands after its last step.";
  return null;
}

/**
 * Lands an attempt behind its checks: opens its pull request, or merges it
 * into the task's base after the merge confirmation, and records the outcome
 * on the task. The Land button and every surface outside Tasks
 * (worktreeLand) come through here. Null when the merge was cancelled.
 */
export async function landCandidate(task: Task, candidate: TaskCandidate, kind: LandKind): Promise<LandResult | null> {
  const found = findCandidate(task.id, candidate.id);
  if (!found) return { text: "This attempt is gone.", failed: true };
  const refusal = landRefusal(found.task, found.candidate);
  if (refusal) return { text: refusal, failed: true };
  // The check command is looked up first when nothing read it yet (the land section does on show).
  if (!found.candidate.check) await runCandidateCheck(found.task, found.candidate, { run: false }).catch(() => { /* shown on the gate */ });
  const current = findCandidate(task.id, candidate.id) ?? found;
  const live = useTaskLive.getState().live[current.candidate.id] ?? settledState(current.candidate);
  const blocked = gateFailure(kind, landingGates(current.candidate, live));
  if (blocked) return blocked;
  return kind === "pr" ? proposeCandidate(current.task, current.candidate) : mergeCandidate(current.task, current.candidate, live);
}

// Opens the pull request for a candidate's branch through the shared landing
// path; a pull request, new or existing, settles the candidate as proposed.
async function proposeCandidate(task: Task, candidate: TaskCandidate): Promise<LandResult> {
  const result = await openWorktreePr(task.host, candidate.worktree);
  refreshCandidate(candidate.id);
  if (result.prUrl) {
    useTasks.getState().updateCandidate(task.id, candidate.id, { outcome: "pr", outcomeAt: Date.now(), prUrl: result.prUrl });
    useTasks.getState().updateTask(task.id, { winnerId: candidate.id });
    // The Tasks notice offers the link as a button, not inline after the text.
    return { ...result, text: result.text.replace(/:$/, ".") };
  }
  if (!result.failed && result.url) return { ...result, text: result.text.replace(/:$/, "; the task follows the pull request once it exists.") };
  return result;
}

// Merges a candidate's branch into the task's base through the shared landing
// path (after its confirmation) and settles the candidate as merged.
async function mergeCandidate(task: Task, candidate: TaskCandidate, live: CandidateLive): Promise<LandResult | null> {
  const branch = live.stats?.branch ?? candidate.branch;
  try {
    const result = await mergeWorktree(task.host, candidate.worktree, branch, task.base);
    if (result && !result.failed) {
      useTasks.getState().updateCandidate(task.id, candidate.id, { outcome: "merged", outcomeAt: Date.now(), ...(result.commit ? { mergedCommit: result.commit } : {}) });
      useTasks.getState().updateTask(task.id, { winnerId: candidate.id });
    }
    return result;
  } finally {
    refreshCandidate(candidate.id);
  }
}

// ---------------------------------------------------------------- discard

/**
 * Closes the candidate's session, then removes its worktree and branch as previewed and confirmed.
 * "kept" when there was no preview to confirm (unreadable or locked worktree): only the session closed.
 */
export async function discardCandidate(task: Task, candidate: TaskCandidate, preview: DiscardPreview | null): Promise<"removed" | "kept"> {
  const state = useStore.getState();
  // A chain's earlier steps ran in sessions of their own in the same worktree: they close too.
  const chain = useTasks.getState().tasks.find((item) => item.id === task.id)?.chain;
  const others = [...new Set((chain?.steps ?? []).flatMap((step) => (step.session && step.session !== candidate.session ? [step.session] : [])))];
  const otherTiles = others.map((session) => tileIdOf(task.host, session));
  const tiles = state.tiles.filter((tile) => tile.id === candidate.tileId || otherTiles.includes(tile.id));
  if (hasUnsavedEditors(tiles.map((tile) => tile.id))) throw new Error("Save or discard the open editor changes in this attempt's tile first.");
  if (chain) useTasks.getState().updateTask(task.id, { chain: { ...chain, state: chain.state === "done" ? "done" : "stopped", handoff: undefined } });
  for (const session of others) await killSession(session, undefined, task.host).catch(() => { /* already gone */ });
  try {
    await killSession(candidate.session, undefined, task.host);
  } catch {
    // A session that is already gone is fine; one still running keeps the worktree.
    const sessions = await (task.host ? scanDevice(task.host) : fetchSessions()).catch(() => null);
    if (!sessions || sessions.some((session) => session.name === candidate.session)) throw new Error("Could not close the attempt's session, so its worktree was kept.");
  }
  for (const tile of tiles) useStore.getState().closeTile(tile.id);
  void useStore.getState().loadSessions().catch(() => {});
  // Without a confirmed preview the worktree stays and the candidate stays in play.
  if (!preview) return "kept";
  await discardTaskWorktree(task.host, candidate.worktree, preview.fingerprint);
  useTasks.getState().updateCandidate(task.id, candidate.id, { outcome: "discarded", outcomeAt: Date.now() });
  return "removed";
}

/** The agent picks a task can be retried with: every catalog agent, with its default mode. */
export function agentPick(id: SessionAgentId, mode?: string): AgentPick {
  const definition = sessionAgent(id);
  if (!definition) throw new Error("Unknown agent.");
  return { id: definition.id, mode: sessionAgentMode(definition, mode).id };
}
