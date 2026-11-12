import { useEffect, useRef, useState, type ReactNode } from "react";
import { ArrowDown, ArrowUp, CornerDownLeft, GitBranch, Link2, ListTodo, LoaderCircle, Plus, ShieldOff, X } from "lucide-react";
import { Select } from "../ui/Select";
import { PathField } from "../ui/PathField";
import { DeviceIcon } from "../ui/DeviceIcon";
import { AgentIcon } from "../icons/AgentIcon";
import { useStore } from "../state/store";
import { deviceHost } from "../devices";
import { compactPath } from "../grid/compactPath";
import { agentSelectOptions } from "../agentChoices";
import { modeIcon, readRecentFolders } from "../panels/SessionMenu";
import { IS_MAC } from "../shortcuts";
import { agentTakesPrompt, sessionAgent, sessionAgentMode, SESSION_PROMPT_MAX_LENGTH, type SessionAgentId } from "../../server/lib/session-agents.js";
import { fetchTaskBranches, type TaskBranches } from "./taskApi";
import { fetchWorktreeInfo } from "../serverApi";
import { createParallelTasks, createTask, newTaskProblem, retryWithAgent, type AgentPick } from "./taskActions";
import { useTasks, useTasksUi, type ChainPreset, type ChainRole, type TaskMode } from "./taskStore";
import { CHAIN_PRESETS, CHAIN_ROLES, chainPreset, ROLE_AGENT, ROLE_HINT, ROLE_LABEL, type StepSpec } from "./taskChain";
import { PanelHead } from "./TasksPanel";
import { useAutoGrow } from "../ui/useAutoGrow";

// The new-task view of the Tasks dropdown, in the new-session form's idiom:
// the prompt and Start first, then device, repository and base branch as one
// segmented bar (remembered from the last task), then the mode and its
// agents. One: one agent. Parallel: one task per line, each with its own
// agent, worktree and branch. Chain: steps one after another in one
// worktree, started from a preset and edited freely (add, remove, reorder,
// any role, an agent per step). Race: the same prompt to as many agents as
// picked, keep the best. Retrying a task keeps its prompt and repository and
// adds attempts with other agents. No mode caps how many start.

const DEVICE_KEY = "pzza.session.device";
const AGENTS_KEY = "pzza.tasks.lastAgents.v1";
const REPO_KEY = "pzza.tasks.lastRepo.v1";
const AGENT_OPTIONS = agentSelectOptions().map((option) => ({ ...option, icon: <AgentIcon id={option.value} size={13} /> }));
/** The next agent offered by Add an agent: one not chosen yet, so best of N compares by default. */
const NEXT_AGENTS: readonly SessionAgentId[] = ["claude", "codex", "gemini", "opencode", "cursor"];

function lastAgents(): AgentPick[] {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(AGENTS_KEY) ?? "[]");
    if (!Array.isArray(value)) return [];
    return value.flatMap((item: unknown) => {
      if (!item || typeof item !== "object" || !("id" in item)) return [];
      const definition = sessionAgent(item.id);
      return definition ? [{ id: definition.id, mode: sessionAgentMode(definition, "mode" in item ? item.mode : undefined).id }] : [];
    });
  } catch {
    return [];
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

function rememberedRepo(deviceId: string): string | undefined {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(REPO_KEY) ?? "{}");
    const path = isRecord(value) ? value[deviceId] : undefined;
    return typeof path === "string" && path.startsWith("/") ? path : undefined;
  } catch {
    return undefined;
  }
}

function remember(deviceId: string, repo: string, agents: readonly AgentPick[]): void {
  try {
    const repos: unknown = JSON.parse(localStorage.getItem(REPO_KEY) ?? "{}");
    localStorage.setItem(REPO_KEY, JSON.stringify({ ...(isRecord(repos) ? repos : {}), [deviceId]: repo }));
    localStorage.setItem(AGENTS_KEY, JSON.stringify(agents));
  } catch { /* remembered for this window only */ }
}

const defaultPick = (id: SessionAgentId): AgentPick => ({ id, mode: sessionAgent(id)?.defaultMode ?? "default" });

const MODE_KEY = "pzza.tasks.lastMode.v1";
const MODES: readonly { id: TaskMode; label: string; hint: string }[] = [
  { id: "one", label: "One", hint: "One agent on one task" },
  { id: "parallel", label: "Parallel", hint: "One task per line, each with its own agent, worktree and branch, all at once" },
  { id: "chain", label: "Chain", hint: "Steps one after another in one worktree, in any order: write, review, fix, plan, build or your own" },
  { id: "race", label: "Race", hint: "The same prompt to several agents; keep the best, discard the rest" },
];
/** Past this many sessions starting from one Start, the composer says what that costs. */
const MANY_AT_ONCE = 4;
function lastMode(): TaskMode {
  try {
    const value = localStorage.getItem(MODE_KEY);
    return MODES.some((mode) => mode.id === value) ? value as TaskMode : "one";
  } catch {
    return "one";
  }
}

/** The other agent of a chain: one that is not the first, so a review gets a second opinion. */
const secondAgent = (first: AgentPick): AgentPick => defaultPick(NEXT_AGENTS.find((id) => id !== first.id) ?? first.id);
/** A step in the composer: its spec and a key that stays with it when the steps are reordered. */
type DraftStep = StepSpec & { key: string };
const draftStep = (role: ChainRole, agent: AgentPick): DraftStep => ({ key: crypto.randomUUID(), role, agent, ...(role === "custom" ? { custom: "" } : {}) });
/** A preset's steps: the first agent writes, plans and fixes; a second one reviews and builds. */
const presetSteps = (preset: ChainPreset, first: AgentPick): DraftStep[] => {
  const pair = [first, secondAgent(first)];
  return (CHAIN_PRESETS.find((item) => item.id === preset)?.roles ?? []).map((role) => draftStep(role, pair[ROLE_AGENT[role]]));
};
/** The role a new step takes after the last one: work gets a review, a review a fix, a plan a build. */
const NEXT_ROLE: Record<ChainRole, ChainRole> = { write: "review", build: "review", fix: "review", custom: "review", review: "fix", plan: "build" };
const PRESET_OPTIONS = [
  ...CHAIN_PRESETS.map((item) => ({ value: item.id as ChainPreset, label: item.label, sub: item.hint, icon: <Link2 size={13} /> })),
  { value: "custom" as ChainPreset, label: "Custom steps", sub: "Your own steps in your own order; edit them below", icon: <Link2 size={13} /> },
];
const ROLE_OPTIONS = CHAIN_ROLES.map((role) => ({ value: role, label: ROLE_LABEL[role], sub: ROLE_HINT[role] }));

export function TaskComposer({ retryOf }: { retryOf?: string }) {
  const retryTask = useTasks((state) => (retryOf ? state.tasks.find((task) => task.id === retryOf) : undefined));
  const devices = useStore((state) => state.activeDevices);
  const tiles = useStore((state) => state.tiles);
  const activeId = useStore((state) => state.activeId);
  const allSessions = useStore((state) => state.allSessions);
  const draft = useTasksUi((state) => state.draft);
  const [mode, setModeState] = useState<TaskMode>(() => (retryOf ? "race" : lastMode()));
  const prompt = retryTask?.prompt ?? draft;
  const [savedDeviceId, setDeviceId] = useState(() => {
    try { return localStorage.getItem(DEVICE_KEY) ?? devices[0]?.id ?? ""; } catch { return devices[0]?.id ?? ""; }
  });
  const deviceId = retryTask?.deviceId ?? (devices.some((device) => device.id === savedDeviceId) ? savedDeviceId : devices[0]?.id ?? "");
  const device = devices.find((item) => item.id === deviceId);
  const host = device ? deviceHost(device) : "";
  // The repository: the task's when retrying, else the last one used on this
  // device, else the active tile's folder, else the most recent folder.
  const activeTile = tiles.find((tile) => tile.id === activeId);
  const activeFolder = activeTile && (activeTile.host ?? "") === host
    ? activeTile.path ?? allSessions.find((session) => session.name === (activeTile.session ?? activeTile.name))?.path ?? activeTile.cwd : undefined;
  const initialRepo = (id: string) => rememberedRepo(id) ?? (activeFolder?.startsWith("/") ? activeFolder : undefined) ?? readRecentFolders()[id]?.[0] ?? "";
  const [repo, setRepo] = useState(() => retryTask?.repo ?? initialRepo(deviceId));
  const [branches, setBranches] = useState<{ status: "idle" | "loading" | "ready" | "error"; data?: TaskBranches; error?: string }>({ status: "idle" });
  const [base, setBase] = useState(retryTask?.base ?? "");
  // One and Race: the agents (One uses the first); Parallel: the first is every line's default.
  const [agents, setAgents] = useState<AgentPick[]>(() => {
    if (retryTask) {
      const tried = new Set(retryTask.candidates.map((candidate) => candidate.agent.id));
      return [defaultPick(NEXT_AGENTS.find((id) => !tried.has(id)) ?? "claude")];
    }
    const saved = lastAgents();
    return saved.length ? saved : [defaultPick("claude")];
  });
  const [lineAgents, setLineAgents] = useState<Record<number, AgentPick>>({});
  // The chain's steps; the preset shown is the one they match, else Custom steps.
  const [steps, setSteps] = useState<DraftStep[]>(() => presetSteps("review", agents[0] ?? defaultPick("claude")));
  const preset = chainPreset(steps.map((step) => step.role));
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);
  const promptRef = useRef<HTMLTextAreaElement>(null);
  /** A step just turned Custom: its instruction field takes focus once it appears. */
  const focusStep = useRef<string | null>(null);

  useEffect(() => { promptRef.current?.focus({ preventScroll: true }); }, []);
  useAutoGrow(promptRef, prompt, { minLines: mode === "parallel" ? 3 : 1, maxLines: mode === "parallel" ? 8 : 6 });

  // The branches of the chosen repository; the default branch is preselected.
  useEffect(() => {
    if (!repo) { setBranches({ status: "idle" }); return; }
    const controller = new AbortController();
    setBranches({ status: "loading" });
    // A folder inside a task's (or any) linked worktree starts from the main
    // checkout instead, so new worktrees never nest inside another one.
    Promise.all([fetchTaskBranches(host, repo, controller.signal), fetchWorktreeInfo(host, repo, controller.signal).catch(() => null)]).then(([data, info]) => {
      if (controller.signal.aborted) return;
      if (info?.linked && info.main && info.main !== repo) { setRepo(info.main); return; }
      if (data.root !== repo && data.root.startsWith("/")) { setRepo(data.root); return; }
      setBranches({ status: "ready", data });
      setBase((current) => (current && data.branches.includes(current) ? current : data.base ?? data.current ?? data.branches[0] ?? ""));
    }).catch((cause: unknown) => {
      if (!controller.signal.aborted) setBranches({ status: "error", error: cause instanceof Error ? cause.message : "Branches unavailable" });
    });
    return () => controller.abort();
  }, [host, repo]);

  const pickDevice = (id: string) => {
    setDeviceId(id);
    setRepo(initialRepo(id));
    setBase("");
    try { localStorage.setItem(DEVICE_KEY, id); } catch { /* remembered for this window only */ }
  };
  const setMode = (next: TaskMode) => {
    setModeState(next);
    setError(null);
    // A race starts with two different agents; the others use one.
    if (next === "race" && agents.length < 2) setAgents([agents[0], secondAgent(agents[0])]);
    // Untouched preset steps follow the agent picked meanwhile; edited steps stay as they are.
    if (next === "chain" && preset !== "custom") setSteps(presetSteps(preset, agents[0]));
    try { localStorage.setItem(MODE_KEY, next); } catch { /* remembered for this window only */ }
  };
  const choosePreset = (next: ChainPreset) => { if (next !== "custom") setSteps(presetSteps(next, steps[0]?.agent ?? agents[0])); };
  const setAgent = (index: number, next: AgentPick) => setAgents((list) => list.map((item, position) => (position === index ? next : item)));
  const addAgent = () => setAgents((list) => {
    const used = new Set(list.map((item) => item.id));
    return [...list, defaultPick(NEXT_AGENTS.find((id) => !used.has(id)) ?? list[list.length - 1].id)];
  });
  // The step editor: any number of steps, any roles, in any order.
  const changeStep = (key: string, change: Partial<StepSpec>) => setSteps((list) => list.map((step) => (step.key === key ? { ...step, ...change } : step)));
  const setStepRole = (key: string, role: ChainRole) => {
    if (role === "custom") focusStep.current = key;
    setSteps((list) => list.map((step) => (step.key !== key ? step : role === "custom" ? { ...step, role, custom: step.custom ?? "" } : { key: step.key, role, agent: step.agent })));
  };
  const moveStep = (index: number, by: -1 | 1) => setSteps((list) => {
    const to = index + by;
    if (to < 0 || to >= list.length) return list;
    const next = [...list];
    [next[index], next[to]] = [next[to], next[index]];
    return next;
  });
  const removeStep = (key: string) => setSteps((list) => (list.length > 1 ? list.filter((step) => step.key !== key) : list));
  const addStep = () => setSteps((list) => {
    const first = list[0]?.agent ?? agents[0];
    const role = list.length ? NEXT_ROLE[list[list.length - 1].role] : "write";
    return [...list, draftStep(role, [first, secondAgent(first)][ROLE_AGENT[role]])];
  });

  // What starts: the agents each mode launches, and for Parallel the lines.
  const oneLine = prompt.replace(/[\r\n]+/g, " ").trim();
  const lines = mode === "parallel" ? prompt.split(/\r?\n/).map((line) => line.trim()).filter(Boolean) : [];
  const rows = lines.map((line, index) => ({ prompt: line, agent: lineAgents[index] ?? agents[0] }));
  const specs: StepSpec[] = steps.map(({ key: _key, ...spec }) => spec);
  const launching = retryTask || mode === "race" ? agents : mode === "chain" ? specs.map((step) => step.agent) : mode === "parallel" ? [...new Map(rows.map((row) => [`${row.agent.id}:${row.agent.mode}`, row.agent])).values()] : agents.slice(0, 1);
  const input = { title: "", prompt: mode === "parallel" ? lines[0] ?? "" : oneLine, deviceId, repo, base, agents: launching, ...(mode === "chain" && !retryTask ? { steps: specs } : {}) };
  const problem = mode === "parallel" && !retryTask
    ? (lines.length < 2 ? "Write one task per line, at least two." : rows.map((row, index) => { const issue = newTaskProblem({ ...input, prompt: row.prompt, agents: [row.agent] }); return issue ? `Line ${index + 1}: ${issue}` : null; }).find(Boolean) ?? null)
    : newTaskProblem({ ...input, mode: retryTask ? "race" : mode });
  // How many sessions this Start opens side by side: each its own worktree, session and usage.
  const atOnce = retryTask || mode === "race" ? agents.length : mode === "parallel" ? rows.length : 1;
  const noPrompt = launching.filter((agent) => !agentTakesPrompt(sessionAgent(agent.id)));
  const bypass = [...new Set(launching.flatMap((agent) => {
    const definition = sessionAgent(agent.id);
    const agentMode = definition ? sessionAgentMode(definition, agent.mode) : undefined;
    return definition && agentMode?.approval === "bypass" ? [`${definition.label} (${agentMode.label})`] : [];
  }))];

  const submit = async () => {
    if (creating) return;
    if (problem) { setError(problem); return; }
    setCreating(true);
    setError(null);
    try {
      if (retryTask) {
        for (const agent of agents) await retryWithAgent(retryTask.id, agent);
        useTasksUi.getState().go({ kind: "task", taskId: retryTask.id });
        return;
      }
      remember(deviceId, repo, mode === "chain" ? launching.slice(0, 1) : agents);
      if (mode === "parallel") {
        await createParallelTasks({ title: "", deviceId, repo, base }, rows);
        useTasksUi.getState().setDraft("");
        useTasksUi.getState().go({ kind: "list" });
        return;
      }
      const taskId = await createTask({ ...input, mode });
      useTasksUi.getState().setDraft("");
      useTasksUi.getState().go({ kind: "task", taskId });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not start the task.");
    } finally {
      setCreating(false);
    }
  };

  const startLabel = retryTask ? (agents.length > 1 ? `Add ${agents.length} attempts` : "Add attempt")
    : mode === "parallel" ? `Start ${Math.max(lines.length, 2)} tasks` : mode === "chain" ? "Start chain" : mode === "race" ? `Start ${agents.length} agents` : "Start task";
  /** Controls a row carries around its agent: a role picker before it, move buttons after its mode. */
  interface RowExtras { lead?: ReactNode; before?: ReactNode; after?: ReactNode; remove?: { label: string; run: () => void }; withMode?: boolean }
  const agentRow = (agent: AgentPick, key: string | number, label: string, change: (next: AgentPick) => void, { lead, before, after, remove, withMode = true }: RowExtras = {}) => {
    const definition = sessionAgent(agent.id);
    const agentMode = definition ? sessionAgentMode(definition, agent.mode) : undefined;
    return (
      <div key={key} className="ns-seg ns-seg-extra task-agent-seg" role="group" aria-label={label}>
        {lead}
        {before}
        <Select value={agent.id} disabled={creating} ariaLabel={label} className="ns-pill task-agent-pick" options={AGENT_OPTIONS}
          onChange={(id) => { const next = sessionAgent(id); if (next) change(defaultPick(next.id)); }} />
        {withMode && definition && agentMode && definition.modes.length > 1 ? (
          <Select value={agentMode.id} disabled={creating} ariaLabel={`${label} mode`} className={`ns-pill ns-mode ${agentMode.approval === "bypass" ? "ns-mode-danger" : ""}`}
            title={`${definition.label} mode: ${agentMode.description}`} onChange={(next) => change({ id: agent.id, mode: next })}
            options={definition.modes.map((item) => { const Icon = modeIcon(item); return { value: item.id, label: item.label, sub: item.description, icon: <Icon size={13} /> }; })} />
        ) : null}
        {after}
        {remove ? (
          <button type="button" className="ns-clear task-agent-remove" aria-label={remove.label} title="Remove" disabled={creating} onClick={remove.run}><X size={11} aria-hidden="true" /></button>
        ) : null}
      </div>
    );
  };
  const stepRows = steps.map((step, index) => {
    const name = `Step ${index + 1}`;
    const label = `${name}: ${ROLE_LABEL[step.role]}`;
    const many = steps.length > 1;
    return (
      <div key={step.key} className="task-step-edit">
        {agentRow(step.agent, step.key, label, (agent) => changeStep(step.key, { agent }), {
          before: <Select value={step.role} disabled={creating} ariaLabel={`${name} role`} className="ns-pill task-step-role" title={ROLE_HINT[step.role]}
            options={ROLE_OPTIONS} onChange={(role) => { const next = CHAIN_ROLES.find((item) => item === role); if (next) setStepRole(step.key, next); }} />,
          after: many ? (
            <>
              <button type="button" className="ns-clear task-agent-remove" aria-label={`Move ${name.toLowerCase()} up`} title="Move up" disabled={creating || index === 0} onClick={() => moveStep(index, -1)}><ArrowUp size={11} aria-hidden="true" /></button>
              <button type="button" className="ns-clear task-agent-remove" aria-label={`Move ${name.toLowerCase()} down`} title="Move down" disabled={creating || index === steps.length - 1} onClick={() => moveStep(index, 1)}><ArrowDown size={11} aria-hidden="true" /></button>
            </>
          ) : null,
          remove: many ? { label: `Remove ${name.toLowerCase()}`, run: () => removeStep(step.key) } : undefined,
        })}
        {step.role === "custom" ? (
          <div className="ns-seg ns-seg-extra task-agent-seg task-step-custom">
            <input
              ref={(node) => { if (node && focusStep.current === step.key) { focusStep.current = null; node.focus({ preventScroll: true }); } }}
              className="ns-input" value={step.custom ?? ""} maxLength={SESSION_PROMPT_MAX_LENGTH} disabled={creating}
              aria-label={`${name} instruction`} placeholder={`What should step ${index + 1} do?`}
              onChange={(event) => changeStep(step.key, { custom: event.target.value.replace(/[\r\n]+/g, " ") })}
              onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); if (event.metaKey || event.ctrlKey) void submit(); } }}
            />
          </div>
        ) : null}
      </div>
    );
  });

  return (
    <form className="new-session-form task-form" aria-label={retryTask ? "Retry with another agent" : "New task"} aria-busy={creating || undefined}
      onSubmit={(event) => { event.preventDefault(); void submit(); }}>
      <PanelHead title={retryTask ? "Retry with another agent" : "New task"} view={{ kind: "new", retryOf: retryTask ? { taskId: retryTask.id } : undefined }} />
      {/* One composer like New session's: the prompt, and Start in the same box. */}
      <div className="ns-composer">
        <div className="ns-composer-line task-composer-line">
        <ListTodo size={16} className="muted-icon" aria-hidden="true" />
        <textarea
          ref={promptRef}
          className="ns-input task-prompt-input"
          rows={1}
          value={prompt}
          // Parallel checks each line against the prompt limit instead of the whole box.
          maxLength={mode === "parallel" ? undefined : SESSION_PROMPT_MAX_LENGTH}
          readOnly={!!retryTask}
          disabled={creating}
          aria-label="What should the agents do?"
          placeholder={mode === "parallel" ? "One task per line…" : "Describe the task…"}
          // Parallel keeps one task per line; otherwise the prompt is one line on the command line.
          onChange={(event) => useTasksUi.getState().setDraft(mode === "parallel" ? event.target.value : event.target.value.replace(/[\r\n]+/g, " "))}
          onKeyDown={(event) => { if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) { event.preventDefault(); void submit(); } }}
        />
        <button type="submit" className="btn btn-accent ns-create" disabled={creating || !!problem} aria-busy={creating || undefined}
          title={problem ?? `${startLabel} (${IS_MAC ? "⌘" : "Ctrl"} Enter). Each agent works in its own worktree on a new pzza/ branch.`}>
          {creating ? <LoaderCircle size={12} className="sw-spin" aria-hidden="true" /> : null}
          {startLabel}<CornerDownLeft size={12} strokeWidth={2.2} aria-hidden="true" />
        </button>
        </div>
      </div>

      <div className="ns-seg" role="group" aria-label="Where to work">
        {devices.length > 1 ? (
          <Select value={deviceId} disabled={creating || !!retryTask} ariaLabel="Device" className="ns-pill" onChange={pickDevice}
            options={devices.map((item) => ({ value: item.id, label: item.name, sub: item.host, icon: <DeviceIcon device={item} /> }))} />
        ) : null}
        <span className={`ns-pill-path ${repo ? "has-value" : ""}`}>
          <PathField key={deviceId} value={repo} label={repo ? compactPath(repo) : undefined} mode="folder" host={host} fixedHost disabled={creating || !!retryTask}
            placeholder="Repository" title={repo || "Choose the repository"} pickerTitle={`Choose a repository on ${device?.name ?? "this device"}`}
            className="ns-pill" start={repo || undefined} onChange={(path) => setRepo(path)} />
        </span>
        <Select value={base} disabled={creating || !!retryTask || branches.status !== "ready"} ariaLabel="Base branch" className="ns-pill"
          placeholder={branches.status === "loading" ? "Branches…" : "Branch"} onChange={setBase}
          options={(branches.data?.branches ?? (base ? [base] : [])).map((branch) => ({ value: branch, label: branch, sub: branch === branches.data?.base ? "default" : branch === branches.data?.current ? "checked out" : undefined, icon: <GitBranch size={13} /> }))} />
      </div>
      {branches.status === "error" ? <p className="ns-error" role="alert">{branches.error}</p> : null}

      {retryTask ? null : (
        <div className="usage-seg task-mode-seg" role="radiogroup" aria-label="Task mode">
          {MODES.map((item) => (
            <button key={item.id} type="button" role="radio" aria-checked={mode === item.id} className={mode === item.id ? "on" : ""} title={item.hint} disabled={creating}
              onClick={() => setMode(item.id)}>{item.label}</button>
          ))}
        </div>
      )}

      {mode === "chain" && !retryTask ? (
        <>
          <div className="ns-seg ns-seg-extra task-agent-seg" role="group" aria-label="Chain">
            <Select value={preset} disabled={creating} ariaLabel="Chain preset" className="ns-pill task-agent-pick" options={PRESET_OPTIONS}
              onChange={(value) => { const next = PRESET_OPTIONS.find((item) => item.value === value); if (next) choosePreset(next.value); }} />
          </div>
          <div className="task-steps" role="group" aria-label="Steps">{stepRows}</div>
          <button type="button" className="ns-toggle task-add-agent" disabled={creating} onClick={addStep} title="Add a step after the last one; pick its role, agent and mode">
            <Plus size={12} aria-hidden="true" />Add a step
          </button>
        </>
      ) : mode === "parallel" && !retryTask ? (
        <>
          {agentRow(agents[0], 0, "Agent", (next) => setAgent(0, next), { lead: <span className="task-step-label" aria-hidden="true">Every task</span> })}
          {rows.map((row, index) => agentRow(row.agent, index + 1, `Agent for line ${index + 1}`,
            // A line on the default agent follows its mode; another agent starts in its safe default.
            (next) => setLineAgents((current) => ({ ...current, [index]: next.id === agents[0].id ? agents[0] : next })),
            { lead: <span className="task-step-label task-line-label" title={row.prompt}>{index + 1}. {row.prompt}</span>, withMode: false }))}
        </>
      ) : (
        <>
          {(mode === "one" && !retryTask ? agents.slice(0, 1) : agents).map((agent, index) => agentRow(agent, index, `Agent ${index + 1}`, (next) => setAgent(index, next),
            { remove: agents.length > 1 && (mode === "race" || retryTask) ? { label: `Remove ${sessionAgent(agent.id)?.label ?? "agent"}`, run: () => setAgents((list) => list.filter((_, position) => position !== index)) } : undefined }))}
          {mode === "race" || retryTask ? (
            <button type="button" className="ns-toggle task-add-agent" disabled={creating} onClick={addAgent} title="Race another agent on the same prompt; keep the best">
              <Plus size={12} aria-hidden="true" />Add an agent
            </button>
          ) : null}
        </>
      )}

      {atOnce > MANY_AT_ONCE ? (
        <p className="set-note task-many-note" role="note">
          {atOnce} {mode === "parallel" && !retryTask ? "tasks" : "agents"} start at once, each with its own worktree, session and usage.
        </p>
      ) : null}

      {bypass.length ? <p className="ns-warning" role="note"><ShieldOff size={11} aria-hidden="true" /> {bypass.join(", ")} runs every command without asking</p> : null}
      {noPrompt.length ? (
        <p className="set-note" role="note">
          {[...new Set(noPrompt.map((agent) => sessionAgent(agent.id)?.label ?? agent.id))].join(", ")} cannot take a prompt on {noPrompt.length === 1 ? "its" : "their"} command line; the task offers Send prompt once the agent is ready.
        </p>
      ) : null}
      {error ? <p className="ns-error" role="alert">{error}</p> : null}
    </form>
  );
}
