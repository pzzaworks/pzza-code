import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CircleCheck, CircleDashed, CircleX, FlaskConical, GitPullRequestArrow, LoaderCircle, MoreHorizontal, X, type LucideIcon } from "lucide-react";
import { openWebPage } from "../tileGit";
import { AgentIcon } from "../icons/AgentIcon";
import type { GitPullRequest } from "../serverApi";
import { sessionAgent, sessionAgentMode } from "../../server/lib/session-agents.js";
import type { CandidateLive } from "./taskLive";
import { PHASE_LABEL, phaseColumn, type CandidatePhase } from "./taskStatus";
import { failedWithWorktree, useTasksUi, type CandidateCheck, type CandidateStatsSummary, type Task, type TaskCandidate } from "./taskStore";

// Small pieces the Tasks dropdown and Help share, built from the app's own
// menu classes (usage-dot, menu-item, icon-btn).

/** The current time, ticking while `enabled`, for elapsed times. */
export function useNow(enabled: boolean, interval = 1000): number {
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => { if (document.visibilityState !== "hidden") setNow(Date.now()); }, interval);
    return () => clearInterval(timer);
  }, [enabled, interval]);
  return now;
}

// ---------------------------------------------------------------- reading

export function agentName(candidate: Pick<TaskCandidate, "agent">): string {
  return sessionAgent(candidate.agent.id)?.label ?? candidate.agent.id;
}

export function modeName(candidate: Pick<TaskCandidate, "agent">): string {
  const definition = sessionAgent(candidate.agent.id);
  return definition ? sessionAgentMode(definition, candidate.agent.mode).label : candidate.agent.mode;
}

/** The attempt a task acts on by default: the landed one, else the first still in play. */
export function primaryCandidate(task: Task): TaskCandidate {
  return task.candidates.find((candidate) => candidate.id === task.winnerId)
    ?? task.candidates.find((candidate) => candidate.outcome !== "discarded" && candidate.launch !== "failed")
    ?? task.candidates[0];
}

/** What Discard can remove: attempts in play or proposed, and failed launches whose worktree was kept. */
export const discardable = (candidate: TaskCandidate) => (candidate.launch === "started" && (!candidate.outcome || candidate.outcome === "pr")) || failedWithWorktree(candidate);

/** Files and lines changed against the base: live when read this session, else the last saved numbers. */
export function candidateSummary(candidate: TaskCandidate, live: Pick<CandidateLive, "stats">): Pick<CandidateStatsSummary, "files" | "added" | "removed" | "commits" | "dirty"> | undefined {
  const stats = live.stats;
  return stats ? { files: stats.files.length, added: stats.added, removed: stats.removed, commits: stats.commits.length, dirty: stats.dirty } : candidate.stats;
}

/** "now", "4m", "3h", "2d": how long ago, at a glance. */
export function shortAgo(ms: number): string {
  const minutes = Math.floor(Math.max(0, ms) / 60000);
  if (minutes < 1) return "now";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 24 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/** The color a phase reads in: a pull request as good news (green), a merge in purple as on the Git hosts. */
export function phaseTone(phase: CandidatePhase): string {
  return phase === "failed" ? "danger" : phase === "merged" ? "merged" : phase === "pr" ? "review" : phase === "discarded" ? "muted" : phaseColumn(phase);
}

export function phaseOrder(phase: CandidatePhase): number {
  return ["needs-you", "failed", "working", "starting", "review", "pr", "merged", "discarded"].indexOf(phase);
}

/** A state in a few words: a failed launch says so instead of its whole error (shown in full where it is read). */
export function shortReason(live: Pick<CandidateLive, "phase" | "reason">): string {
  return live.phase === "failed" ? "Could not start" : live.reason;
}

// ----------------------------------------------------------------- pieces

/** The app's status dot in a task tone; it pulses while the agent works. */
export function StatusDot({ tone, live = false, label }: { tone: string; live?: boolean; label?: string }) {
  return <span className={`usage-dot task-tone-${tone} ${live ? "task-dot-live" : ""}`} role={label ? "img" : undefined} aria-label={label} aria-hidden={label ? undefined : true} />;
}

/** A candidate's phase as a dot and its reason. */
export function PhaseLabel({ live }: { live: Pick<CandidateLive, "phase" | "reason" | "working"> }) {
  return (
    <span className="task-phase" title={`${PHASE_LABEL[live.phase]}: ${live.reason}`}>
      <StatusDot tone={phaseTone(live.phase)} live={live.working} />
      <span className="task-phase-text">{shortReason(live)}</span>
    </span>
  );
}

/** Agent logos side by side, one per attempt; the first four. */
export function AgentStack({ candidates, size = 13 }: { candidates: readonly TaskCandidate[]; size?: number }) {
  return (
    <span className="task-agents" aria-label={candidates.map(agentName).join(", ")} role="img">
      {candidates.slice(0, 4).map((candidate) => (
        <span key={candidate.id} className={`usage-brand ${candidate.outcome === "discarded" ? "is-discarded" : ""}`} title={`${agentName(candidate)} · ${modeName(candidate)}`}>
          <AgentIcon id={candidate.agent.id} size={size} />
        </span>
      ))}
    </span>
  );
}

/** Lines added and removed against the base, with the file count when `files` is given. */
export function DiffStat({ files, added, removed }: { files?: number; added: number; removed: number }) {
  const count = files === undefined ? "" : `${files} ${files === 1 ? "file" : "files"} changed, `;
  return (
    <span className="task-diffstat" aria-label={`${count}${added} lines added, ${removed} removed`}>
      {files === undefined ? null : <span className="muted">{files} {files === 1 ? "file" : "files"}</span>}
      <span className="task-add">+{added}</span>
      <span className="task-del">−{removed}</span>
    </span>
  );
}

const CHECKS_ICON = { passing: CircleCheck, failing: CircleX, pending: LoaderCircle, none: CircleDashed } as const;
const CHECKS_TEXT = { passing: "checks pass", failing: "checks fail", pending: "checks running", none: "no checks" } as const;

/** The pull request number with its state and checks, as the app's small pill. */
export function PrChip({ pr, url }: { pr: GitPullRequest | null | undefined; url?: string }) {
  if (!pr && !url) return null;
  if (!pr) return <span className="task-meta-item"><GitPullRequestArrow size={11} aria-hidden="true" />PR</span>;
  const Icon = CHECKS_ICON[pr.checks];
  const state = pr.state === "MERGED" ? "merged" : pr.state === "CLOSED" ? "closed" : pr.draft ? "draft" : "open";
  return (
    <span className="task-meta-item task-chip-pr" title={`Pull request #${pr.number}: ${state}, ${CHECKS_TEXT[pr.checks]}`}>
      <GitPullRequestArrow size={11} aria-hidden="true" />#{pr.number}
      {pr.state === "OPEN" ? <Icon size={11} aria-label={CHECKS_TEXT[pr.checks]} className={pr.checks === "pending" ? "sw-spin" : undefined} /> : <span>{state}</span>}
    </span>
  );
}

const CHECK_TEXT: Record<CandidateCheck["status"], string> = {
  none: "No check", unapproved: "Check needs approval", ready: "Check not run", running: "Checking…", passed: "Check passed", failed: "Check failed", timeout: "Check timed out", error: "Check error",
};

/** The repository check command's last result on this attempt, as the app's small pill. */
export function CheckChip({ check, stale }: { check: CandidateCheck | undefined; stale?: boolean }) {
  if (!check || check.status === "none") return null;
  return (
    <span className="task-meta-item" title={`${CHECK_TEXT[check.status]}${stale ? " on older changes" : ""}: ${check.commands.join(" && ")}`}>
      {check.status === "running" ? <LoaderCircle size={11} className="sw-spin" aria-hidden="true" /> : <FlaskConical size={11} aria-hidden="true" />}
      {stale && check.status === "passed" ? "Check outdated" : CHECK_TEXT[check.status]}
    </span>
  );
}

// ------------------------------------------------------------------- menu

export interface MenuAction {
  id: string;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  disabled?: boolean;
  run(): void | Promise<void>;
}

/**
 * A button that opens a short list of actions under it (the overflow menus
 * and the Land split button). The list renders at the document root so a
 * scrolling pane never clips it; a failed action shows as the Tasks notice.
 */
export function TaskMenu({ label, actions, children, className = "icon-btn", title, disabled = false }: {
  label: string; actions: readonly MenuAction[]; children?: ReactNode; className?: string; title?: string; disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const close = (refocus: boolean) => { setOpen(false); if (refocus) button.current?.focus({ preventScroll: true }); };
  useLayoutEffect(() => {
    const element = menu.current;
    const anchor = button.current?.getBoundingClientRect();
    if (!open || !element || !anchor) return;
    const box = element.getBoundingClientRect();
    const below = anchor.bottom + 4 + box.height <= window.innerHeight - 8;
    element.style.top = `${below ? anchor.bottom + 4 : Math.max(8, anchor.top - 4 - box.height)}px`;
    element.style.left = `${Math.max(8, Math.min(anchor.right - box.width, window.innerWidth - 8 - box.width))}px`;
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [open]);
  useEffect(() => {
    if (!open) return;
    const dismiss = () => setOpen(false);
    window.addEventListener("resize", dismiss);
    window.addEventListener("blur", dismiss);
    return () => { window.removeEventListener("resize", dismiss); window.removeEventListener("blur", dismiss); };
  }, [open]);
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    event.stopPropagation();
    if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); close(true); return; }
    if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)")];
    const index = items.findIndex((item) => item === document.activeElement);
    const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? items.length - 1 : 1)) % items.length;
    items[next]?.focus();
  };
  const run = (action: MenuAction) => {
    close(true);
    try {
      void Promise.resolve(action.run()).catch((error: unknown) => useTasksUi.getState().say({ text: error instanceof Error ? error.message : "That did not work.", failed: true }));
    } catch (error) {
      useTasksUi.getState().say({ text: error instanceof Error ? error.message : "That did not work.", failed: true });
    }
  };
  return (
    <>
      <button ref={button} type="button" className={className} aria-label={label} title={title ?? label} aria-haspopup="menu" aria-expanded={open} disabled={disabled}
        onClick={(event) => { event.stopPropagation(); setOpen(!open); }}>
        {children ?? <MoreHorizontal size={15} aria-hidden="true" />}
      </button>
      {open ? createPortal(
        <div className="cselect-backdrop pzza-portal" onMouseDown={() => close(false)}>
          <div ref={menu} className="menu task-menu" role="menu" aria-label={label} onMouseDown={(event) => event.stopPropagation()} onKeyDown={onKeyDown}>
            {actions.map((action) => (
              <button key={action.id} type="button" role="menuitem" className={`menu-item ${action.danger ? "task-menu-danger" : ""}`} disabled={action.disabled} onClick={() => run(action)}>
                <action.icon size={15} aria-hidden="true" />{action.label}
              </button>
            ))}
          </div>
        </div>,
        document.body,
      ) : null}
    </>
  );
}

/** The outcome of the last action, until dismissed or replaced. */
export function TaskNotice() {
  const notice = useTasksUi((state) => state.notice);
  if (!notice) return null;
  return (
    <div className={`set-note task-notice ${notice.failed ? "is-error" : ""}`} role={notice.failed ? "alert" : "status"}>
      <span>{notice.text}</span>
      {notice.url ? <button type="button" className="btn btn-sm" onClick={() => { if (notice.url) openWebPage(notice.url); }}>Open</button> : null}
      <button type="button" className="dismiss-btn" aria-label="Dismiss" onClick={() => useTasksUi.getState().say(null)}><X size={14} aria-hidden="true" /></button>
    </div>
  );
}
