import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Check, Copy, ListTodo } from "lucide-react";
import { Modal } from "../ui/Modal";
import { useStore } from "../state/store";
import { deviceNameFor } from "../devices";
import { compactPath } from "../grid/compactPath";
import { AgentIcon } from "../icons/AgentIcon";
import { useTaskLive, type CandidateLive } from "./taskLive";
import { candidateElapsed, candidateLive, columnOf } from "./taskView";
import { elapsedLabel, TASK_COLUMNS } from "./taskStatus";
import { useTasks, useTasksUi, type ChainStep, type Task, type TaskCandidate } from "./taskStore";
import { checkIsCurrent, spotlightCandidate } from "./taskActions";
import { chainSummary, currentStep, ROLE_LABEL, ROLE_VERB } from "./taskChain";
import { CheckChip, PrChip, StatusDot, agentName, candidateSummary, modeName, phaseTone, primaryCandidate, shortReason, useNow } from "./TaskParts";
import { LandPanel, type LandHost } from "./TaskLand";
import { CommitDialog, DiscardDialog, type DiscardRequest } from "./TaskDialogs";
import { TaskChanges } from "./TaskChanges";
import { TitleField } from "./TaskDetail";
import { sessionAgent, sessionAgentMode } from "../../server/lib/session-agents.js";
import "../grid/Checkpoints.css";

// A task's full details, in the same window as a tile's Checkpoints: the
// task (name, state, where it works, the prompt) on top, its attempts (a race)
// or steps (a chain) as the timeline on the left, and the selected one on the
// right with every action, the land checks with their fixes, and its changes
// with the diff. Picking an attempt or step brings its tile forward.

const STEP_LABEL: Record<ChainStep["status"], string> = { waiting: "Waiting", running: "Running", done: "Done", paused: "Paused", failed: "Failed", skipped: "Skipped" };
const STEP_TONE: Record<ChainStep["status"], string> = { waiting: "muted", running: "working", done: "review", paused: "needs-you", failed: "danger", skipped: "muted" };

export function TaskWindow() {
  const details = useTasksUi((state) => state.details);
  const task = useTasks((state) => (details ? state.tasks.find((item) => item.id === details.taskId) : undefined));
  // A task removed while its window is open closes the window.
  useEffect(() => { if (details && !task) useTasksUi.getState().closeDetails(); }, [details, task]);
  if (!details || !task) return null;
  return <Window key={task.id} task={task} candidateId={details.candidateId} stepIndex={details.step} />;
}

function Window({ task, candidateId, stepIndex }: { task: Task; candidateId?: string; stepIndex?: number }) {
  const live = useTaskLive((state) => state.live);
  const devices = useStore((state) => state.devices);
  const deviceCount = useStore((state) => state.activeDevices.length);
  const notice = useTasksUi((state) => state.notice);
  const now = useNow(true);
  const [commit, setCommit] = useState<string | null>(null);
  const [discard, setDiscard] = useState<DiscardRequest | null>(null);
  const chain = task.chain;
  // A chain's steps share one attempt (its worktree); a race has one per agent.
  const candidate = chain ? task.candidates[0] : task.candidates.find((item) => item.id === candidateId) ?? primaryCandidate(task);
  const step = chain ? Math.max(0, Math.min(chain.steps.length - 1, stepIndex ?? (currentStep(chain) >= 0 ? currentStep(chain) : chain.steps.length - 1))) : -1;
  const spotlit = chain ? chain.steps[step]?.tileId ?? candidate.tileId : candidate.tileId;
  const tileOpen = useStore((state) => state.tiles.some((tile) => tile.id === spotlit));
  useEffect(() => { spotlightCandidate({ ...candidate, tileId: spotlit }); }, [spotlit, tileOpen]);
  const selectedLive = candidateLive(live, candidate);
  const column = columnOf(task, live);
  const usable = candidate.launch === "started" && candidate.outcome !== "discarded" && !!candidate.worktree;
  const host: LandHost = {
    commit: () => setCommit(candidate.id),
    discard: (candidateIds, afterLanding) => setDiscard({ taskId: task.id, candidateIds, afterLanding }),
    retry: () => { useTasksUi.getState().closeDetails(); useTasksUi.getState().show({ kind: "new", retryOf: { taskId: task.id } }); },
  };
  const state = chain ? chainSummary(chain) : task.candidates.length > 1 ? TASK_COLUMNS.find((item) => item.id === column)?.label ?? "" : shortReason(selectedLive);
  const mode = chain ? "Chain" : task.candidates.length > 1 ? `Race of ${task.candidates.length}` : task.mode === "parallel" ? "Parallel" : "One agent";
  return (
    <Modal open onClose={() => useTasksUi.getState().closeDetails()} title="Task" icon={ListTodo} size="xl" className="cp-modal task-window">
      <div className="cp">
        <header className="cp-detail-head task-window-head">
          <div className="cp-detail-heading">
            <TitleField task={task} className="cp-detail-title task-window-title" />
            <span className="cp-detail-id">{mode}</span>
          </div>
          <div className="cp-detail-meta">
            <span className="cp-detail-agent"><StatusDot tone={chain ? column : task.candidates.length > 1 ? column : phaseTone(selectedLive.phase)} live={column === "working"} />{state}</span>
            <span title={task.repo}>{compactPath(task.repo)}</span>
            <span>from <code className="cp-detail-branch">{task.base}</code></span>
            {deviceCount > 1 ? <span>{deviceNameFor(devices, task.host || undefined)}</span> : null}
            <time dateTime={new Date(task.createdAt).toISOString()} title={new Date(task.createdAt).toLocaleString()}>started {elapsedLabel(now - task.createdAt)} ago</time>
          </div>
          <Prompt task={task} />
        </header>
        <div className="cp-banner-slot" aria-live="polite">
          {notice ? <div className={`cp-banner ${notice.failed ? "is-error" : ""}`} role={notice.failed ? "alert" : "status"}><span>{notice.text}</span></div> : null}
        </div>
        <div className="cp-layout">
          {chain ? <Steps task={task} selected={step} /> : <Attempts task={task} selected={candidate} live={live} now={now} />}
          <section className="cp-detail" aria-label={chain ? `Step ${step + 1}` : agentName(candidate)}>
            <header className="cp-detail-head">
              {chain ? <StepHead step={chain.steps[step]} index={step} total={chain.steps.length} /> : (
                <>
                  <div className="cp-detail-heading">
                    <h3 className="cp-detail-title">{agentName(candidate)}</h3>
                    <span className="cp-detail-id">{modeName(candidate)}</span>
                  </div>
                  <AttemptMeta candidate={candidate} live={selectedLive} now={now} />
                </>
              )}
              {chain ? <AttemptMeta candidate={candidate} live={selectedLive} now={now} phase={false} /> : null}
              <LandPanel key={candidate.id} task={task} candidate={candidate} live={selectedLive} host={host} />
            </header>
            {usable && candidate.outcome !== "merged" ? <TaskChanges key={candidate.id} task={task} candidate={candidate} live={selectedLive} />
              : <div className="cp-body"><Note task={task} candidate={candidate} /></div>}
          </section>
        </div>
      </div>
      {commit ? <CommitDialog taskId={task.id} candidateId={commit} onClose={() => setCommit(null)} /> : null}
      {discard ? <DiscardDialog key={discard.candidateIds.join()} request={discard} onClose={() => setDiscard(null)} /> : null}
    </Modal>
  );
}

/** The prompt, when the title does not already say all of it. */
function Prompt({ task }: { task: Task }) {
  const [copied, setCopied] = useState(false);
  if (task.prompt === task.title) return null;
  return (
    <div className="task-prompt">
      <p className="cp-compare-note" title={task.prompt}>{task.prompt}</p>
      <button type="button" className="tile-btn" aria-label="Copy the prompt" title="Copy the prompt"
        onClick={() => void navigator.clipboard.writeText(task.prompt).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1600); }, () => useTasksUi.getState().say({ text: "Could not copy the prompt.", failed: true }))}>
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
    </div>
  );
}

// `phase` is off for a chain step, whose own status line already says where it stands.
function AttemptMeta({ candidate, live, now, phase = true }: { candidate: TaskCandidate; live: CandidateLive; now: number; phase?: boolean }) {
  const [copied, setCopied] = useState(false);
  const branch = live.stats?.branch ?? candidate.branch;
  const stale = candidate.check?.status === "passed" && !!live.stats && !checkIsCurrent(candidate.check, live.stats);
  return (
    <div className="cp-detail-meta">
      {phase ? <span className="cp-detail-agent"><StatusDot tone={phaseTone(live.phase)} live={live.working} />{shortReason(live)}</span> : null}
      {candidate.launch === "started" ? <span title="Time worked">{elapsedLabel(candidateElapsed(candidate, live, now))}</span> : null}
      {candidate.worktree && candidate.outcome !== "discarded" ? (
        <button type="button" className="task-branch" title={`Copy ${branch}`} aria-label={`Copy the branch ${branch}`}
          onClick={() => void navigator.clipboard.writeText(branch).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1400); }, () => useTasksUi.getState().say({ text: "Could not copy the branch.", failed: true }))}>
          <code className="cp-detail-branch">{copied ? "Copied" : branch}</code>
        </button>
      ) : null}
      <PrChip pr={live.pr} url={candidate.prUrl} />
      <CheckChip check={candidate.check} stale={stale} />
    </div>
  );
}

function StepHead({ step, index, total }: { step: ChainStep; index: number; total: number }) {
  const definition = sessionAgent(step.agent.id);
  const mode = definition ? sessionAgentMode(definition, step.agent.mode).label : step.agent.mode;
  return (
    <>
      <div className="cp-detail-heading">
        <h3 className="cp-detail-title">Step {index + 1} of {total}: {ROLE_LABEL[step.role]}</h3>
        <span className="cp-detail-id">{definition?.label ?? step.agent.id} · {mode}</span>
      </div>
      <div className="cp-detail-meta">
        <span className="cp-detail-agent"><StatusDot tone={STEP_TONE[step.status]} live={step.status === "running"} />{STEP_LABEL[step.status]}{step.note ? `: ${step.note}` : ""}</span>
        {step.session ? <span>{step.session}</span> : null}
      </div>
      {step.instruction ? <p className="cp-compare-note task-instruction" title={step.instruction}>{step.instruction}</p> : <p className="cp-compare-note task-instruction" title={step.custom}>Starts when the step before it finishes{step.custom ? `: ${step.custom}` : "."}</p>}
    </>
  );
}

/** A race's attempts (or the one agent of a task), as the Checkpoints timeline lists checkpoints. */
function Attempts({ task, selected, live, now }: { task: Task; selected: TaskCandidate; live: Record<string, CandidateLive>; now: number }) {
  const items = useRef(new Map<string, HTMLDivElement>());
  const choose = (candidate: TaskCandidate) => useTasksUi.setState({ details: { taskId: task.id, candidateId: candidate.id } });
  const move = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const count = task.candidates.length;
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? count - 1 : -1;
    if (next < 0 || next >= count || next === index) return;
    event.preventDefault();
    const target = task.candidates[next];
    items.current.get(target.id)?.focus();
    choose(target);
  };
  return (
    <div className="cp-timeline" role="listbox" aria-label="Attempts">
      <div className="cp-day">
        <div className="cp-day-label" aria-hidden="true">{task.candidates.length > 1 ? "Attempts" : "Agent"}</div>
        {task.candidates.map((candidate, index) => {
          const state = candidateLive(live, candidate);
          const summary = candidateSummary(candidate, state);
          const on = candidate.id === selected.id;
          return (
            <div key={candidate.id} ref={(element) => { if (element) items.current.set(candidate.id, element); else items.current.delete(candidate.id); }}
              role="option" aria-selected={on} tabIndex={on ? 0 : -1} aria-label={`${agentName(candidate)}, ${shortReason(state)}`}
              className={`cp-item${on ? " on" : ""}${index === task.candidates.length - 1 ? " is-last" : ""}${candidate.outcome === "discarded" ? " is-discarded" : ""}`}
              style={{ "--cp-i": index } as CSSProperties} onClick={() => choose(candidate)} onKeyDown={(event) => move(event, index)}>
              <span className="cp-rail" aria-hidden="true"><span className={`cp-node usage-dot task-tone-${phaseTone(state.phase)}`} /></span>
              <span className="cp-item-main">
                <span className="cp-item-head">
                  <span className="cp-item-agent" aria-hidden="true"><AgentIcon id={candidate.agent.id} size={12} /></span>
                  <span className="cp-item-title">{agentName(candidate)}{candidate.id === task.winnerId ? " · picked" : ""}</span>
                </span>
                <span className="cp-item-meta" aria-hidden="true">
                  <span>{shortReason(state)}</span>
                  {summary?.files ? <span>{summary.files} {summary.files === 1 ? "file" : "files"}</span> : null}
                  {summary?.files ? <span><span className="cp-add">+{summary.added}</span> <span className="cp-del">−{summary.removed}</span></span> : null}
                  {candidate.launch === "started" ? <span>{elapsedLabel(candidateElapsed(candidate, state, now))}</span> : null}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A chain's steps in order, with where each stands. */
function Steps({ task, selected }: { task: Task; selected: number }) {
  const steps = task.chain?.steps ?? [];
  const items = useRef(new Map<number, HTMLDivElement>());
  const choose = (index: number) => useTasksUi.setState({ details: { taskId: task.id, step: index } });
  const move = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : event.key === "Home" ? 0 : event.key === "End" ? steps.length - 1 : -1;
    if (next < 0 || next >= steps.length || next === index) return;
    event.preventDefault();
    items.current.get(next)?.focus();
    choose(next);
  };
  return (
    <div className="cp-timeline" role="listbox" aria-label="Steps">
      <div className="cp-day">
        <div className="cp-day-label" aria-hidden="true">Steps</div>
        {steps.map((step, index) => {
          const on = index === selected;
          const agent = sessionAgent(step.agent.id)?.label ?? step.agent.id;
          return (
            <div key={step.id} ref={(element) => { if (element) items.current.set(index, element); else items.current.delete(index); }}
              role="option" aria-selected={on} tabIndex={on ? 0 : -1} aria-label={`Step ${index + 1}, ${ROLE_LABEL[step.role]} by ${agent}, ${STEP_LABEL[step.status]}`}
              className={`cp-item${on ? " on" : ""}${index === steps.length - 1 ? " is-last" : ""}`} style={{ "--cp-i": index } as CSSProperties}
              onClick={() => choose(index)} onKeyDown={(event) => move(event, index)}>
              <span className="cp-rail" aria-hidden="true"><span className={`cp-node usage-dot task-tone-${STEP_TONE[step.status]} ${step.status === "running" ? "task-dot-live" : ""}`} /></span>
              <span className="cp-item-main">
                <span className="cp-item-head">
                  <span className="cp-item-agent" aria-hidden="true"><AgentIcon id={step.agent.id} size={12} /></span>
                  <span className="cp-item-title">{index + 1}. {ROLE_LABEL[step.role]} · {agent}</span>
                </span>
                <span className="cp-item-meta" aria-hidden="true">
                  <span>{step.status === "running" ? `${agent} ${ROLE_VERB[step.role]}` : STEP_LABEL[step.status]}</span>
                  {step.note && step.status !== "running" ? <span>{step.note}</span> : null}
                </span>
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** Why an attempt shows no changes: it merged, failed (and what was kept), is starting, or was discarded. */
function Note({ task, candidate }: { task: Task; candidate: TaskCandidate }) {
  const stats = candidate.stats;
  const text = candidate.outcome === "merged" ? `Merged into ${task.base}${candidate.mergedCommit ? ` as ${candidate.mergedCommit.slice(0, 7)}` : ""}${stats?.files ? `: ${stats.files} ${stats.files === 1 ? "file" : "files"}, +${stats.added} −${stats.removed}` : ""}. Its changes are part of ${task.base} now.`
    : candidate.launch === "failed" ? candidate.error ?? "This agent could not start."
      : candidate.launch === "starting" ? "Creating the worktree and starting the agent…"
        : candidate.outcome === "discarded" ? "This attempt was discarded; its worktree is gone." : "Waiting for the agent's worktree…";
  return <div className={`cp-note task-attempt-note ${candidate.launch === "failed" ? "is-failed" : ""}`} role={candidate.launch === "failed" ? "note" : undefined}>{text}</div>;
}
