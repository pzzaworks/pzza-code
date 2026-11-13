import { sessionTileById, useStore } from "../state/store";
import { createSessionInApp, creationIdle, enqueueLaunch } from "../sessionActions";
import { sendPromptToTile } from "../terminal/broadcast";
import { hasPendingPermission } from "../state/permissionPrompts";
import { paneForeground } from "../terminal/permissionForeground";
import { useNotifications } from "../state/notifications";
import { fetchSessions, scanDevice } from "../serverApi";
import { DEFAULT_WORKSPACE_ID } from "../workspaces";
import { agentTakesPrompt, sessionAgent, SESSION_PROMPT_MAX_LENGTH } from "../../server/lib/session-agents.js";
import { fetchTaskStats } from "./taskApi";
import { useTasks, type ChainPreset, type ChainRole, type ChainStep, type Task, type TaskChain } from "./taskStore";

// Chains: steps that run one after another in one worktree on one branch,
// each an agent given one instruction. A step finishes on the same signals
// the task status reads (its output moved, then went quiet with no approval
// waiting); the next step then starts in the same worktree, in the session of
// an earlier step of the same agent when its tile is still open, else in a new
// session there. A step that needs approval or fails pauses the chain until
// the user resumes, skips the step or stops the chain.

export interface ChainPresetInfo { id: Exclude<ChainPreset, "custom">; label: string; roles: readonly ChainRole[]; hint: string }
/** Quick starts for the step list; any steps in any order make a chain. */
export const CHAIN_PRESETS: readonly ChainPresetInfo[] = [
  { id: "review", label: "Write, then review, then fix", roles: ["write", "review", "fix"], hint: "One agent writes, another reviews the diff, the first fixes what the review found." },
  { id: "plan", label: "Plan, then build", roles: ["plan", "build"], hint: "One agent writes a plan, another implements it." },
];
/** The preset a list of roles matches, else custom. */
export function chainPreset(roles: readonly ChainRole[]): ChainPreset {
  return CHAIN_PRESETS.find((item) => item.roles.length === roles.length && item.roles.every((role, index) => role === roles[index]))?.id ?? "custom";
}

/** Which of a preset's two agents runs a role: the first (writes, plans, fixes) or the second (reviews, builds). */
export const ROLE_AGENT: Record<ChainRole, 0 | 1> = { write: 0, review: 1, fix: 0, plan: 0, build: 1, custom: 0 };
export const ROLE_LABEL: Record<ChainRole, string> = { write: "Write", review: "Review", fix: "Fix", plan: "Plan", build: "Build", custom: "Custom" };
export const ROLE_VERB: Record<ChainRole, string> = { write: "writing", review: "reviewing", fix: "fixing", plan: "planning", build: "building", custom: "working" };
export const ROLE_HINT: Record<ChainRole, string> = {
  write: "Does the task as written",
  review: "Reviews the branch so far without changing code",
  fix: "Fixes what the last review found, or problems in the changes so far",
  plan: "Writes a plan without changing code",
  build: "Implements the last plan, or the task when there is none",
  custom: "Your own instruction for this step",
};
export const CHAIN_ROLES: readonly ChainRole[] = ["write", "review", "fix", "plan", "build", "custom"];

export const PLAN_FILE = ".pzza/plan.md";
export const REVIEW_FILE = ".pzza/review.md";

const squash = (value: string) => value.replace(/\s+/g, " ").trim();

// Instructions go on the agent's command line: one line, at most the prompt
// limit, the task's prompt shortened to fit around the fixed text.
function fit(template: (prompt: string) => string, prompt: string): string {
  const room = SESSION_PROMPT_MAX_LENGTH - squash(template("")).length - 1;
  const clean = squash(prompt);
  const fitted = clean.length > room ? `${clean.slice(0, Math.max(0, room - 1))}…` : clean;
  return squash(template(fitted)).slice(0, SESSION_PROMPT_MAX_LENGTH);
}

/** What a step needs to know about the ones before it. */
export type StepShape = Pick<ChainStep, "role" | "custom"> & { status?: ChainStep["status"] };

// Whether an earlier step left a file for this one: a plan no build has
// followed yet, or a review no fix has. Skipped steps left nothing.
function leftFile(steps: readonly StepShape[], index: number, producer: ChainRole, consumer: ChainRole): boolean {
  for (let position = index - 1; position >= 0; position--) {
    const step = steps[position];
    if (step.status === "skipped") continue;
    if (step.role === consumer) return false;
    if (step.role === producer) return true;
  }
  return false;
}

const ranBefore = (steps: readonly StepShape[], index: number) => steps.slice(0, index).some((step) => step.status !== "skipped");

/**
 * What step `index` of a chain is told, from its role and what the steps
 * before it left: a build follows a plan in PLAN_FILE, a fix follows a review
 * in REVIEW_FILE, a review (and a fix with no review to go on) gets `context`,
 * the diff summary so far. A Custom step is its typed instruction with the
 * task for context.
 */
export function stepInstruction(task: Pick<Task, "prompt" | "base">, steps: readonly StepShape[], index: number, context = ""): string {
  const step = steps[index];
  const after = ranBefore(steps, index);
  const write = () => (after ? fit((prompt) => `Continue this task, building on the changes already on this branch: ${prompt}`, task.prompt) : fit((prompt) => prompt, task.prompt));
  switch (step.role) {
    case "write": return write();
    case "plan": return fit((prompt) => `${after ? "Plan the next changes for this task, building on what is already on this branch," : "Plan this task"} without changing any code yet: ${prompt} Write the plan as numbered, concrete steps to ${PLAN_FILE} in this folder, then stop.`, task.prompt);
    case "build": return leftFile(steps, index, "plan", "build")
      ? fit((prompt) => `Implement the plan in ${PLAN_FILE} for this task: ${prompt} Follow it step by step, then delete ${PLAN_FILE}.`, task.prompt)
      : write();
    case "review": return fit((prompt) => `Review the changes on this branch against ${task.base} for this task: ${prompt} Do not change any code. ${context} Write your findings, most important first, with file and line references, to ${REVIEW_FILE}, then stop.`, task.prompt);
    case "fix": return leftFile(steps, index, "review", "fix")
      ? fit((prompt) => `Address the review in ${REVIEW_FILE} for this task: ${prompt} Fix each finding that holds, then delete ${REVIEW_FILE}.`, task.prompt)
      : fit((prompt) => `Find and fix problems in the changes on this branch against ${task.base} for this task: ${prompt} ${context}`, task.prompt);
    case "custom": {
      const own = squash(step.custom ?? "");
      // An instruction too long to leave room for the task goes alone.
      return own.length > SESSION_PROMPT_MAX_LENGTH - 200 ? own.slice(0, SESSION_PROMPT_MAX_LENGTH) : fit((prompt) => `${own} This step is part of this task: ${prompt}`, task.prompt);
    }
  }
}

/** One step of a new chain as the composer describes it. */
export interface StepSpec { role: ChainRole; agent: ChainStep["agent"]; custom?: string }

/** The steps of a new chain: the first runs, the rest wait. */
export function chainSteps(task: Pick<Task, "prompt" | "base">, specs: readonly StepSpec[]): ChainStep[] {
  const steps: ChainStep[] = specs.map((spec, index) => ({
    id: crypto.randomUUID(), role: spec.role, agent: spec.agent, status: index === 0 ? "running" : "waiting",
    ...(spec.role === "custom" ? { custom: squash(spec.custom ?? "") } : {}),
  }));
  if (steps[0]) Object.assign(steps[0], { instruction: stepInstruction(task, steps, 0), startedAt: Date.now() });
  return steps;
}

/** The step the chain is on: running, or stopped at (paused or failed); undefined once nothing is left. */
export function currentStep(chain: TaskChain): number {
  return chain.steps.findIndex((step) => step.status === "running" || step.status === "paused" || step.status === "failed");
}

/** "Step 2 of 3 · Codex reviewing", for the list and the task's status. */
export function chainSummary(chain: TaskChain): string {
  const index = currentStep(chain);
  const total = chain.steps.length;
  if (chain.state === "done") return `Chain done · ${total} steps`;
  if (chain.state === "stopped") return `Chain stopped${index >= 0 ? ` at step ${index + 1} of ${total}` : ""}`;
  if (index < 0) return `Step ${total} of ${total}`;
  const step = chain.steps[index];
  const agent = sessionAgent(step.agent.id)?.label ?? step.agent.id;
  if (step.status === "running") return `Step ${index + 1} of ${total} · ${agent} ${ROLE_VERB[step.role]}`;
  return `Step ${index + 1} of ${total} · Paused${step.note ? `: ${step.note}` : ""}`;
}

// ------------------------------------------------------------------ runner

const busy = new Set<string>();
const task = (taskId: string): Task | undefined => useTasks.getState().tasks.find((item) => item.id === taskId);
const tileIdOf = (host: string, name: string) => (host ? `${host}::${name}` : name);
const errorText = (error: unknown, fallback: string) => (error instanceof Error ? error.message : fallback).slice(0, 600);

function setChain(taskId: string, change: Partial<TaskChain>): void {
  const current = task(taskId)?.chain;
  if (current) useTasks.getState().updateTask(taskId, { chain: { ...current, ...change } });
}

function withStep(steps: readonly ChainStep[], index: number, change: Partial<ChainStep>): ChainStep[] {
  return steps.map((step, position) => (position === index ? { ...step, ...change } : step));
}

/** A session name for a step that needs its own: the task's slug, the step and the agent. */
function stepSession(slug: string, index: number, agent: string): string {
  return `${slug.slice(0, 40)}-s${index + 1}-${agent}`.slice(0, 60);
}

// The diff summary and commit range, for a step that looks at the changes so
// far: a review, and a fix with no review to go on.
async function stepContext(item: Task, steps: readonly ChainStep[], index: number): Promise<string> {
  const role = steps[index]?.role;
  if (role !== "review" && !(role === "fix" && !leftFile(steps, index, "review", "fix"))) return "";
  const worktree = item.candidates[0]?.worktree;
  if (!worktree) return "";
  try {
    const stats = await fetchTaskStats(item.host, worktree, item.base);
    const files = stats.files.slice(0, 12).map((file) => file.path).join(", ");
    const range = stats.mergeBase && stats.head ? ` Commits ${stats.mergeBase.slice(0, 7)}..${stats.head.slice(0, 7)} (git log ${item.base}..HEAD).` : "";
    return `So far: ${stats.files.length} ${stats.files.length === 1 ? "file" : "files"} changed (+${stats.added} -${stats.removed})${files ? `: ${files}${stats.files.length > 12 ? " and more" : ""}` : ""}.${range} Uncommitted work counts too (git diff ${item.base} and git status).`;
  } catch {
    return `See git diff ${item.base} and git status for the changes.`;
  }
}

/**
 * Why `agent` cannot take typed input in the tile, read afresh from the
 * device: the program in the foreground of the pane the tile's keys reach is
 * another one (the agent exited to its shell) or cannot be read. Undefined
 * when that agent runs there.
 */
export async function agentAbsence(tileId: string, agent: string): Promise<string | undefined> {
  const state = useStore.getState();
  const tile = sessionTileById(state.tiles, tileId);
  if (!tile) return "Session closed";
  const host = tile.host ?? state.connection.host ?? "";
  try {
    const pane = await paneForeground(host || undefined, tile.session ?? tile.name, tile.window, true);
    return pane?.agent === agent ? undefined : "Agent exited";
  } catch {
    return "Could not check that the agent still runs";
  }
}

/**
 * Starts step `index`: in an earlier step's session of the same agent and
 * mode when its tile is open (the instruction is typed there), else in a new
 * session in the chain's worktree. The handoff is saved first, so a restart
 * in between never starts the step twice.
 */
async function startStep(taskId: string, steps: ChainStep[], index: number): Promise<void> {
  const item = task(taskId);
  const candidate = item?.candidates[0];
  if (!item || !candidate?.worktree) return;
  const step = steps[index];
  const instruction = stepInstruction(item, steps, index, await stepContext(item, steps, index));
  const tiles = useStore.getState().tiles;
  const earlier = steps.slice(0, index).reverse().find((other) => other.session && other.tileId && other.agent.id === step.agent.id && other.agent.mode === step.agent.mode
    && tiles.some((tile) => tile.id === other.tileId));
  const now = Date.now();
  if (earlier?.session && earlier.tileId) {
    if (hasPendingPermission(earlier.tileId)) {
      setChain(taskId, { steps: withStep(steps, index, { status: "paused", instruction, note: "Approval needed" }), state: "paused", handoff: undefined });
      return;
    }
    // The tile stays open on the login shell after its agent exits: typed
    // there, the instruction would run as a shell command.
    const absent = await agentAbsence(earlier.tileId, step.agent.id);
    if (absent) {
      setChain(taskId, { steps: withStep(steps, index, { status: "paused", instruction, note: absent }), state: "paused", handoff: undefined });
      return;
    }
    setChain(taskId, { steps: withStep(steps, index, { instruction }), state: "running", handoff: { step: index, kind: "send", session: earlier.session, at: now } });
    try {
      await sendPromptToTile(earlier.tileId, instruction);
    } catch (error) {
      setChain(taskId, { steps: withStep(steps, index, { status: "failed", instruction, note: errorText(error, "Could not type the instruction") }), state: "paused", handoff: undefined });
      return;
    }
    useTasks.getState().updateCandidate(taskId, candidate.id, { session: earlier.session, tileId: earlier.tileId, agent: step.agent, promptDelivery: "sent" });
    setChain(taskId, { steps: withStep(steps, index, { status: "running", session: earlier.session, tileId: earlier.tileId, startedAt: now, sawWork: undefined, note: undefined, instruction }), state: "running", handoff: undefined });
    return;
  }
  const session = stepSession(item.slug, index, step.agent.id);
  setChain(taskId, { steps: withStep(steps, index, { instruction }), state: "running", handoff: { step: index, kind: "launch", session, at: now } });
  await launchStep(taskId, index, session);
}

// Opens a session for a step in the chain's worktree and points the task at it.
async function launchStep(taskId: string, index: number, session: string): Promise<void> {
  const item = task(taskId);
  const candidate = item?.candidates[0];
  const steps = item?.chain?.steps;
  if (!item || !candidate || !steps) return;
  const step = steps[index];
  const takes = agentTakesPrompt(sessionAgent(step.agent.id));
  try {
    // Sessions are created one at a time, after any task launch or new session in progress.
    const tileId = await enqueueLaunch(async () => { await creationIdle(); return createSessionInApp({
      name: session, deviceId: item.deviceId, cwd: candidate.worktree,
      workspaceId: useStore.getState().workspaces.some((workspace) => workspace.id === item.workspaceId) ? item.workspaceId : DEFAULT_WORKSPACE_ID,
      agent: { id: step.agent.id, mode: step.agent.mode, ...(takes && step.instruction ? { prompt: step.instruction } : {}) },
    }); });
    useTasks.getState().updateCandidate(taskId, candidate.id, { session, tileId, agent: step.agent, promptDelivery: takes ? "command" : "pending" });
    setChain(taskId, { steps: withStep(task(taskId)?.chain?.steps ?? steps, index, { status: "running", session, tileId, startedAt: Date.now(), sawWork: undefined, note: undefined }), state: "running", handoff: undefined });
  } catch (error) {
    setChain(taskId, { steps: withStep(task(taskId)?.chain?.steps ?? steps, index, { status: "failed", note: errorText(error, "Could not start this step") }), state: "paused", handoff: undefined });
  }
}

/** Ends step `index` as done or skipped and starts the next waiting step, or finishes the chain. */
export async function continueChain(taskId: string, index: number, outcome: "done" | "skipped"): Promise<void> {
  if (busy.has(taskId)) return;
  busy.add(taskId);
  try {
    const chain = task(taskId)?.chain;
    if (!chain || chain.handoff) return;
    const steps = withStep(chain.steps, index, { status: outcome, endedAt: Date.now(), ...(outcome === "done" ? { note: undefined } : {}) });
    const next = steps.findIndex((step, position) => position > index && step.status === "waiting");
    if (next < 0) { setChain(taskId, { steps, state: "done", handoff: undefined }); return; }
    await startStep(taskId, steps, next);
  } finally {
    busy.delete(taskId);
  }
}

/**
 * Whether the step's agent stopped on a question in its chat rather than on
 * finished work: its latest message since the step began, the one its finish
 * signal carried, ends with a question mark. The chain then waits for the
 * user instead of handing a half-done step to the next agent.
 */
export function stepAskedQuestion(tileId: string, since: number): boolean {
  const latest = useNotifications.getState().items
    .filter((item) => item.target?.tileId === tileId && item.createdAt >= since)
    .sort((a, b) => b.createdAt - a.createdAt)[0];
  const lastLine = latest?.body.trim().split("\n").map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  return lastLine.endsWith("?");
}

/** The running step's agent was seen working: its going quiet after this is the finish. */
export function markStepWorking(taskId: string, index: number): void {
  const chain = task(taskId)?.chain;
  if (chain && !chain.steps[index]?.sawWork) setChain(taskId, { steps: withStep(chain.steps, index, { sawWork: true }) });
}

/** Holds the chain at step `index` until the user resumes, skips or stops it. */
export function pauseChain(taskId: string, index: number, note: string): void {
  const chain = task(taskId)?.chain;
  if (!chain || chain.state !== "running") return;
  setChain(taskId, { steps: withStep(chain.steps, index, { status: "paused", note }), state: "paused" });
}

/**
 * Picks the chain up where it paused: a step that ran counts as finished and
 * the next one starts; a step that never got going (its launch failed, or the
 * app closed while handing over) is started again.
 */
export async function resumeChain(taskId: string): Promise<void> {
  const chain = task(taskId)?.chain;
  if (!chain || chain.state === "done" || chain.state === "stopped") return;
  const index = currentStep(chain);
  if (index < 0) return;
  const step = chain.steps[index];
  if (step.status === "paused" && step.sawWork) {
    setChain(taskId, { state: "running" });
    await continueChain(taskId, index, "done");
    return;
  }
  if (busy.has(taskId)) return;
  busy.add(taskId);
  try {
    await startStep(taskId, withStep(chain.steps, index, { status: "waiting", note: undefined }), index);
  } finally {
    busy.delete(taskId);
  }
}

export async function skipStep(taskId: string): Promise<void> {
  const chain = task(taskId)?.chain;
  if (!chain) return;
  const index = currentStep(chain);
  if (index < 0) return;
  setChain(taskId, { state: "running" });
  await continueChain(taskId, index, "skipped");
}

/** Stops the chain: no further step starts; the worktree stays to land or discard. */
export function stopChain(taskId: string): void {
  const chain = task(taskId)?.chain;
  if (!chain) return;
  setChain(taskId, { state: "stopped", handoff: undefined, steps: chain.steps.map((step) => (step.status === "waiting" ? { ...step, status: "skipped" } : step.status === "running" ? { ...step, status: "done", endedAt: Date.now() } : step)) });
}

// ---------------------------------------------------------- after restart

// A handoff the app lost track of: a launch is looked for on the device (and
// adopted when its session is there, else started once any request still in
// flight has given up); a typed instruction cannot be checked, so that step
// pauses for the user.
const SETTLE_MS = 90000;
const reconciling = new Set<string>();

export async function reconcileChains(): Promise<void> {
  for (const item of useTasks.getState().tasks) {
    const handoff = item.chain?.handoff;
    if (!item.chain || !handoff || reconciling.has(item.id) || busy.has(item.id)) continue;
    if (!useStore.getState().activeDevices.some((device) => device.id === item.deviceId)) continue;
    const steps = item.chain.steps;
    if (handoff.kind === "send") {
      setChain(item.id, { steps: withStep(steps, handoff.step, { status: "paused", note: "The app closed while handing over; check the tile" }), state: "paused", handoff: undefined });
      continue;
    }
    reconciling.add(item.id);
    try {
      const sessions = await (item.host ? scanDevice(item.host) : fetchSessions());
      const candidate = item.candidates[0];
      if (sessions.some((session) => session.name === handoff.session)) {
        const tileId = tileIdOf(item.host, handoff.session);
        const state = useStore.getState();
        if (!state.tiles.some((tile) => tile.id === tileId) && candidate?.worktree) {
          state.assignSession(tileId, state.workspaces.some((workspace) => workspace.id === item.workspaceId) ? item.workspaceId : DEFAULT_WORKSPACE_ID);
          state.openSession(handoff.session, candidate.worktree, item.host);
        }
        const step = steps[handoff.step];
        if (candidate) useTasks.getState().updateCandidate(item.id, candidate.id, { session: handoff.session, tileId, agent: step.agent, promptDelivery: agentTakesPrompt(sessionAgent(step.agent.id)) ? "command" : "pending" });
        setChain(item.id, { steps: withStep(steps, handoff.step, { status: "running", session: handoff.session, tileId, startedAt: step.startedAt ?? Date.now() }), state: "running", handoff: undefined });
      } else if (Date.now() - handoff.at >= SETTLE_MS) {
        await launchStep(item.id, handoff.step, handoff.session);
      } else {
        setTimeout(() => { void reconcileChains(); }, handoff.at + SETTLE_MS - Date.now());
      }
    } catch {
      // The device is unreachable: tried again when it comes back.
    } finally {
      reconciling.delete(item.id);
    }
  }
}
