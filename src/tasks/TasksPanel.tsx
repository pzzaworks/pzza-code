import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { ArrowLeft, ChevronRight, Plus, Search, ShieldQuestion } from "lucide-react";
import { useTaskLive } from "./taskLive";
import { candidateLive, columnOf, useTaskColumns } from "./taskView";
import { TASK_COLUMNS, type TaskColumn } from "./taskStatus";
import { candidateSettled, useTasks, useTasksUi, type Task, type TaskView } from "./taskStore";
import { AgentStack, DiffStat, StatusDot, TaskNotice, agentName, candidateSummary, phaseOrder, primaryCandidate, shortAgo, shortReason, useNow } from "./TaskParts";
import { TaskComposer } from "./TaskForm";
import { TaskDetail } from "./TaskDetail";
import { CommitView } from "./TaskDialogs";
import { chainSummary } from "./taskChain";

// What the Tasks dropdown in the top bar shows: every task grouped by where
// it stands (Needs you, Working, Review, Done), and in its place, a new task,
// one task, or a step of one (commit, discard). It is built from the same
// pieces as the other top bar menus (Usage, Notifications, New session).

const FILTER_FROM = 7;
const SECTION_ORDER: readonly TaskColumn[] = ["needs-you", "working", "review", "done"];

export function TasksPanel() {
  const view = useTasksUi((state) => state.view);
  const tasks = useTasks((state) => state.tasks);
  const known = view.kind === "list" || (view.kind === "new" && !view.retryOf) || tasks.some((task) => task.id === (view.kind === "new" ? view.retryOf?.taskId : view.taskId));
  // A task removed while it was open (cleared, or gone) goes back to the list.
  useEffect(() => { if (!known) useTasksUi.getState().go({ kind: "list" }); }, [known]);
  const shown: TaskView = known ? view : { kind: "list" };
  // A view swap removes the control that had the keyboard: the panel keeps it, so
  // Escape still steps back and the canvas hands it back here after a spotlight.
  const body = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const active = document.activeElement;
    if (!active || active === document.body || !active.isConnected) body.current?.focus({ preventScroll: true });
  }, [shown]);
  return (
    <div className="menu-body latest-notifications tasks-panel" ref={body} tabIndex={-1} onKeyDown={(event) => {
      // Escape steps back to the list first; from the list it closes the dropdown.
      if (event.key !== "Escape" || shown.kind === "list" || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      useTasksUi.getState().go(back(shown));
    }}>
      {shown.kind === "list" ? <TaskList />
        : shown.kind === "new" ? <TaskComposer key={shown.retryOf?.taskId ?? "new"} retryOf={shown.retryOf?.taskId} />
          : shown.kind === "task" ? <TaskDetail key={shown.taskId} taskId={shown.taskId} />
            : <CommitView taskId={shown.taskId} candidateId={shown.candidateId} />}
      <TaskNotice />
    </div>
  );
}

/** Where a view's back arrow (and Escape) goes. */
export function back(view: TaskView): TaskView {
  if (view.kind === "commit") return { kind: "task", taskId: view.taskId };
  if (view.kind === "new" && view.retryOf) return { kind: "task", taskId: view.retryOf.taskId };
  return { kind: "list" };
}

/** The header every view shares: the dropdown title on the left, the view's actions on the right, and on inner views a back arrow at the far right. */
export function PanelHead({ title, view, tools }: { title: ReactNode; view?: TaskView; tools?: ReactNode }) {
  return (
    <div className="notification-actions menu-head tasks-head">
      <span className="menu-head-title tasks-title">{title}</span>
      {tools || view ? (
        <div className="tasks-head-tools">
          {tools}
          {view ? <button type="button" className="icon-btn tasks-back" aria-label="Back" title="Back (Esc)" onClick={() => useTasksUi.getState().go(back(view))}><ArrowLeft size={15} aria-hidden="true" /></button> : null}
        </div>
      ) : null}
    </div>
  );
}

function TaskList() {
  const columns = useTaskColumns();
  const tasks = useTasks((state) => state.tasks);
  const [query, setQuery] = useState("");
  const [doneOpen, setDoneOpen] = useState(false);
  const list = useRef<HTMLDivElement>(null);
  const now = useNow(true, 15000);
  const waiting = columns["needs-you"];
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const matches = (task: Task) => !words.length || words.every((word) => [task.title, task.prompt, task.base, task.repo, ...task.candidates.flatMap((candidate) => [candidate.branch, agentName(candidate)])].join(" ").toLowerCase().includes(word));
  const sections = SECTION_ORDER.flatMap((id) => {
    const column = TASK_COLUMNS.find((item) => item.id === id);
    const shown = columns[id].filter(matches);
    return column && shown.length ? [{ ...column, tasks: shown }] : [];
  });

  // The count jumps to the next task that needs you.
  const next = () => { if (waiting[0]) useTasksUi.getState().go({ kind: "task", taskId: waiting[0].id }); };
  // Up and Down move between rows, Home and End to the ends.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!["ArrowUp", "ArrowDown", "Home", "End"].includes(event.key) || !(event.target instanceof HTMLElement) || !event.target.matches(".task-row")) return;
    const rows = [...(list.current?.querySelectorAll<HTMLElement>(".task-row") ?? [])];
    const index = rows.indexOf(event.target);
    const target = event.key === "Home" ? rows[0] : event.key === "End" ? rows.at(-1) : rows[index + (event.key === "ArrowDown" ? 1 : -1)];
    if (!target) return;
    event.preventDefault();
    target.focus();
  };
  // Removes them from the list only: branches, worktrees and pull requests stay as they are.
  const clearDone = () => {
    for (const task of columns.done.filter((item) => item.candidates.every(candidateSettled))) useTasks.getState().removeTask(task.id);
  };

  return (
    <>
      <PanelHead title="Tasks" tools={<>
        {waiting.length ? (
          <button type="button" className="perm-waiting-count tasks-waiting" title="Open the next task that needs you" onClick={next}>
            <ShieldQuestion size={12} aria-hidden="true" />{waiting.length} {waiting.length === 1 ? "needs" : "need"} you
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" onClick={() => useTasksUi.getState().go({ kind: "new" })}><Plus size={13} aria-hidden="true" />New task</button>
      </>} />
      {!tasks.length ? (
        <div className="usage-empty tasks-empty">
          <span>No tasks yet. Hand a change to one agent, several tasks at once, a chain of agents or a race; each works in its own worktree.</span>
        </div>
      ) : (
        <>
          {tasks.length >= FILTER_FROM ? (
            <div className="ns-composer tasks-filter">
              <div className="ns-composer-line">
                <Search size={14} className="muted-icon" aria-hidden="true" />
                <input type="search" className="ns-input" value={query} placeholder="Filter tasks" aria-label="Filter tasks" onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape" && query) { event.preventDefault(); event.stopPropagation(); setQuery(""); } }} />
              </div>
            </div>
          ) : null}
          <div className="tasks-sections" ref={list} onKeyDown={onKeyDown}>
            {sections.map((section) => {
              const folded = section.id === "done" && !doneOpen && !words.length;
              return (
                <section key={section.id} className="usage-others tasks-section" aria-label={section.label}>
                  <div className="usage-section-title">
                    {section.id === "done" ? (
                      <button type="button" className="tasks-section-toggle" aria-expanded={!folded} onClick={() => setDoneOpen(!doneOpen)}>
                        <ChevronRight size={12} className={`usage-agent-chevron ${folded ? "" : "is-open"}`} aria-hidden="true" />{section.label}
                      </button>
                    ) : <span>{section.label}</span>}
                    <span className="usage-section-note">
                      {section.id === "done" && !folded ? <button type="button" className="tasks-section-toggle" onClick={clearDone}>Clear</button> : section.tasks.length}
                    </span>
                  </div>
                  {folded ? null : (
                    <div role="list" aria-label={section.label} className="notification-list tasks-rows">
                      {section.tasks.map((task) => <TaskRow key={task.id} task={task} now={now} />)}
                    </div>
                  )}
                </section>
              );
            })}
            {!sections.length ? <p className="usage-empty">No tasks match.</p> : null}
          </div>
        </>
      )}
    </>
  );
}

function TaskRow({ task, now }: { task: Task; now: number }) {
  const live = useTaskLive((state) => state.live);
  const column = columnOf(task, live);
  const multiple = task.candidates.length > 1;
  const primary = primaryCandidate(task);
  // The most urgent attempt speaks for the row; a finished task speaks for its pick.
  const lead = column === "done" ? primary : [...task.candidates].sort((a, b) => phaseOrder(candidateLive(live, a).phase) - phaseOrder(candidateLive(live, b).phase))[0];
  const leadLive = candidateLive(live, lead);
  const summary = !multiple || task.winnerId ? candidateSummary(primary, candidateLive(live, primary)) : undefined;
  const changed = task.candidates.reduce((latest, candidate) => Math.max(latest, candidate.outcomeAt ?? candidate.lastActiveAt ?? candidate.startedAt), task.createdAt);
  const tone = leadLive.phase === "failed" ? "danger" : column;
  return (
    <article role="listitem" className="notification-row">
      <button type="button" className={`notification-content task-row task-tone-${tone}`} data-task-id={task.id} aria-label={`${task.title}, ${shortReason(leadLive)}`}
        onClick={() => useTasksUi.getState().go({ kind: "task", taskId: task.id })}>
        <span className="notification-title">
          <StatusDot tone={tone} live={leadLive.working} />
          <strong>{task.title}</strong>
        </span>
        <span className="task-row-meta">
          <AgentStack candidates={task.candidates} size={12} />
          {task.chain ? <span className="task-row-reason">{chainSummary(task.chain)}</span>
            : column === "needs-you" || column === "working" ? <span className="task-row-reason">{shortReason(leadLive)}</span>
            : summary?.files ? <DiffStat added={summary.added} removed={summary.removed} />
              : <span className="task-row-reason">{multiple ? `Race of ${task.candidates.length}` : shortReason(leadLive)}</span>}
        </span>
        <small title={new Date(changed).toLocaleString()}>{shortAgo(now - changed)}</small>
      </button>
    </article>
  );
}
