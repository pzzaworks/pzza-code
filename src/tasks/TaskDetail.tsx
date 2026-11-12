import { useEffect, useRef, useState } from "react";
import { Crosshair, FolderGit2, GitBranch, Monitor } from "lucide-react";
import { useStore } from "../state/store";
import { deviceNameFor } from "../devices";
import { AgentIcon } from "../icons/AgentIcon";
import { useTaskLive } from "./taskLive";
import { candidateLive, columnOf } from "./taskView";
import { TASK_COLUMNS } from "./taskStatus";
import { useTasks, useTasksUi, type Task } from "./taskStore";
import { revealCandidate, spotlightCandidate } from "./taskActions";
import { chainSummary } from "./taskChain";
import { DiffStat, PhaseLabel, StatusDot, agentName, candidateSummary, phaseTone, primaryCandidate, shortReason } from "./TaskParts";
import { LandSummary, type LandHost } from "./TaskLand";
import { PanelHead } from "./TasksPanel";

// One task at a glance in the Tasks dropdown: its name, where it stands and
// where it works, its changes in one line, and the next action beside Open
// details. Everything else (attempts or chain steps side by side, the diff,
// every land check and action) is in the task window. Opening a task brings
// its tile forward on the canvas, so the live terminal stays in view.

export function TaskDetail({ taskId }: { taskId: string }) {
  const task = useTasks((state) => state.tasks.find((item) => item.id === taskId));
  const live = useTaskLive((state) => state.live);
  const devices = useStore((state) => state.devices);
  const deviceCount = useStore((state) => state.activeDevices.length);
  const selected = task ? primaryCandidate(task) : undefined;
  const tileOpen = useStore((state) => !!selected && state.tiles.some((tile) => tile.id === selected.tileId));
  // The canvas follows the task shown here (once its tile exists).
  useEffect(() => { if (selected) spotlightCandidate(selected); }, [selected?.id, selected?.tileId, tileOpen]);
  if (!task || !selected) return null;
  const selectedLive = candidateLive(live, selected);
  const race = task.candidates.length > 1;
  const column = columnOf(task, live);
  const usable = selected.launch === "started" && selected.outcome !== "discarded" && !!selected.worktree;
  const summary = candidateSummary(selected, selectedLive);
  const details = () => useTasksUi.getState().openDetails({ taskId: task.id });
  const host: LandHost = {
    commit: () => useTasksUi.getState().go({ kind: "commit", taskId: task.id, candidateId: selected.id }),
    discard: () => details(),
    retry: () => useTasksUi.getState().go({ kind: "new", retryOf: { taskId: task.id } }),
  };
  return (
    <section className="task-step" aria-label={`Task: ${task.title}`}>
      <PanelHead title={task.chain ? "Task · Chain" : race ? `Task · Race of ${task.candidates.length}` : "Task"} view={{ kind: "task", taskId }} tools={usable ? (
        <button type="button" className="icon-btn tasks-back" aria-label={tileOpen ? "Focus tile" : "Reopen tile"} title={tileOpen ? "Focus tile" : "Reopen tile"} onClick={() => revealCandidate(task, selected)}>
          <Crosshair size={14} aria-hidden="true" />
        </button>
      ) : undefined} />
      <TitleField task={task} />
      <div className="task-meta">
        {task.chain ? <span className="task-phase"><StatusDot tone={column} live={column === "working"} />{chainSummary(task.chain)}</span>
          : race ? <span className="task-phase"><StatusDot tone={column} live={column === "working"} />{TASK_COLUMNS.find((item) => item.id === column)?.label}</span>
            : <PhaseLabel live={selectedLive} />}
        <span className="task-meta-item" title={task.repo}><FolderGit2 size={12} aria-hidden="true" />{task.repo.replace(/\/+$/, "").split("/").pop()}</span>
        <span className="task-meta-item" title={`Started from ${task.base}`}><GitBranch size={12} aria-hidden="true" />{task.base}</span>
        {deviceCount > 1 ? <span className="task-meta-item"><Monitor size={12} aria-hidden="true" />{deviceNameFor(devices, task.host || undefined)}</span> : null}
      </div>
      {race ? (
        <ul className="task-attempt-lines" aria-label="Attempts">
          {task.candidates.map((candidate) => {
            const state = candidateLive(live, candidate);
            const lines = candidateSummary(candidate, state);
            return (
              <li key={candidate.id} className={candidate.outcome === "discarded" ? "is-discarded" : undefined}>
                <StatusDot tone={phaseTone(state.phase)} live={state.working} />
                <span className="usage-brand"><AgentIcon id={candidate.agent.id} size={12} /></span>
                <span className="task-attempt-name">{agentName(candidate)}</span>
                {lines?.files ? <DiffStat added={lines.added} removed={lines.removed} /> : <span className="muted">{shortReason(state)}</span>}
              </li>
            );
          })}
        </ul>
      ) : usable && selected.outcome !== "merged" ? (
        <div className="task-meta">
          {summary ? <DiffStat files={summary.files} added={summary.added} removed={summary.removed} /> : <span>Reading changes…</span>}
          {summary?.commits ? <span>{summary.commits} {summary.commits === 1 ? "commit" : "commits"}</span> : null}
        </div>
      ) : null}
      <LandSummary key={selected.id} task={task} candidate={selected} live={selectedLive} host={host} onDetails={details} />
    </section>
  );
}

/** The task's name, renamed in place: click it, type, Enter. */
export function TitleField({ task, className = "task-title" }: { task: Task; className?: string }) {
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(task.title);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => { if (editing) input.current?.select(); }, [editing]);
  const save = () => {
    const title = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 200);
    if (title && title !== task.title) useTasks.getState().updateTask(task.id, { title });
    setEditing(false);
  };
  if (!editing) return <button type="button" className={className} title="Rename" onClick={() => { setValue(task.title); setEditing(true); }}>{task.title}</button>;
  return (
    <input ref={input} className="ns-input task-title-input" value={value} maxLength={200} aria-label="Task title" onChange={(event) => setValue(event.target.value)} onBlur={save}
      onKeyDown={(event) => {
        if (event.key === "Enter") { event.preventDefault(); save(); }
        if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setEditing(false); }
      }} />
  );
}
