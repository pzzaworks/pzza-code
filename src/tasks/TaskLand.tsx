import { useEffect, useState, type ReactNode } from "react";
import {
  ChevronDown, CircleAlert, CircleCheck, CircleMinus, CircleX, Crosshair, FlaskConical, GitCommitHorizontal, GitCompareArrows, GitMerge,
  GitPullRequestArrow, History, LoaderCircle, Play, RotateCw, Send, SkipForward, Square, Trash2, TriangleAlert, type LucideIcon,
} from "lucide-react";
import { useStore } from "../state/store";
import { fetchGitChanges } from "../serverApi";
import { refreshCandidate, type CandidateLive } from "./taskLive";
import { failedWithWorktree, useTasks, useTasksUi, type Task, type TaskCandidate } from "./taskStore";
import {
  landCandidate, landingGates, landRefusal, openPullRequestPage, openTimeline, revealCandidate, reviewInTile, runCandidateCheck, sendTaskPrompt,
} from "./taskActions";
import { gatesOpen, type Gate } from "../worktreeLand";
import { resumeChain, skipStep, stopChain } from "./taskChain";
import { TaskMenu, agentName, discardable } from "./TaskParts";
import { Switch } from "../ui/Switch";

// Landing an attempt: what must hold before it lands (the gates), the one
// action it is waiting on (send the prompt, commit, land, open the pull
// request, discard, or resume a paused chain) and every other action. The
// dropdown shows the gist (one line and the next action); the task window
// shows all of it.

const GATE_ICON: Record<Gate["state"], LucideIcon> = { ok: CircleCheck, blocked: CircleX, pending: LoaderCircle, skipped: CircleMinus };
const GATE_STATE: Record<Gate["state"], string> = { ok: "Passed", blocked: "Blocked", pending: "Pending", skipped: "Not needed" };
type Busy = "pr" | "merge" | "check" | "send" | "chain" | null;

/** Where the land flow's steps open: committing, discarding (with what would be lost) and retrying. */
export interface LandHost {
  commit(): void;
  discard(candidateIds: string[], afterLanding?: boolean): void;
  retry(): void;
}

export interface Action { id: string; label: string; icon: LucideIcon; danger?: boolean; run(): void | Promise<void> }

function useLand(task: Task, candidate: TaskCandidate, live: CandidateLive, host: LandHost) {
  const multiple = task.candidates.length > 1;
  const landed = task.candidates.find((item) => item.outcome === "merged" || item.outcome === "pr");
  const usable = candidate.launch === "started" && candidate.outcome !== "discarded" && !!candidate.worktree;
  // Not yet landed, no other attempt landed, and a chain only after its last step.
  const landable = landRefusal(task, candidate) === null;
  const tileOpen = useStore((state) => state.tiles.some((tile) => tile.id === candidate.tileId));
  const say = useTasksUi((state) => state.say);
  const [busy, setBusy] = useState<Busy>(null);
  const [discardOthers, setDiscardOthers] = useState(true);

  // Uncommitted files outside the setup copies, read whenever the worktree is dirty.
  const [leftovers, setLeftovers] = useState<string[] | undefined>();
  const dirtyKey = landable && live.stats?.dirty ? `${live.stats.head}:${live.stats.uncommitted}` : "";
  useEffect(() => {
    if (!dirtyKey) { setLeftovers(undefined); return; }
    const controller = new AbortController();
    fetchGitChanges(task.host, candidate.worktree, controller.signal)
      .then((changes) => setLeftovers(changes.files.map((file) => file.path).filter((path) => !candidate.copied.includes(path))))
      .catch(() => setLeftovers(undefined));
    return () => controller.abort();
  }, [dirtyKey, task.host, candidate.worktree]);

  // Fresh changes and the repository's check command whenever an attempt that can land is shown.
  useEffect(() => {
    if (!landable) return;
    refreshCandidate(candidate.id);
    const check = candidate.check;
    if (!check || check.status === "none" || check.status === "error") void runCandidateCheck(task, candidate, { run: false }).catch(() => { /* shown on the gate */ });
  }, [candidate.id, landable]);

  const gates = landable ? landingGates(candidate, live, leftovers) : [];
  const ready = landable && gatesOpen(gates);
  const others = task.candidates.filter((item) => item.id !== candidate.id && item.launch === "started" && !item.outcome).map((item) => item.id);
  const run = async (kind: Exclude<Busy, null>, work: () => Promise<unknown>) => {
    setBusy(kind);
    try { await work(); }
    catch (error) { say({ text: error instanceof Error ? error.message : "That did not work.", failed: true }); }
    finally { setBusy(null); }
  };
  const land = (kind: "pr" | "merge") => run(kind, async () => {
    const outcome = await landCandidate(task, candidate, kind);
    if (!outcome) return;
    say(outcome);
    const after = useTasks.getState().tasks.find((item) => item.id === task.id)?.candidates.find((item) => item.id === candidate.id);
    if (!outcome.failed && (after?.outcome === "pr" || after?.outcome === "merged") && multiple && discardOthers && others.length) host.discard(others, true);
  });
  const runCheck = (approve?: string[]) => run("check", () => runCandidateCheck(task, candidate, { run: true, approve }).catch(() => { /* the result is on the gate */ }));
  const sendPrompt = () => run("send", async () => { await sendTaskPrompt(task, candidate); say({ text: "Prompt sent to the agent.", failed: false }); });
  const discardThis = () => host.discard([candidate.id]);
  const chainPaused = task.chain?.state === "paused";

  // The one action the attempt is waiting on.
  const committable = landable && !!live.stats?.dirty && (leftovers === undefined || leftovers.length > 0);
  const hasPr = !!live.pr || !!candidate.prUrl;
  let primary: ReactNode = null;
  let primaryId = "";
  if (failedWithWorktree(candidate) || (usable && landed && landed.id !== candidate.id && !candidate.outcome)) {
    primaryId = "discard";
    primary = <button type="button" className="btn btn-sm btn-danger" onClick={discardThis}><Trash2 size={13} aria-hidden="true" />Discard{multiple ? ` ${agentName(candidate)}` : ""}</button>;
  } else if (chainPaused) {
    primaryId = "resume";
    primary = (
      <button type="button" className="btn btn-sm btn-accent" disabled={busy !== null} aria-busy={busy === "chain" || undefined} onClick={() => void run("chain", () => resumeChain(task.id))}
        title="Continue the chain: a step that ran counts as finished and the next one starts; a step that never got going starts again">
        {busy === "chain" ? <LoaderCircle size={13} className="sw-spin" aria-hidden="true" /> : <Play size={13} aria-hidden="true" />}Resume
      </button>
    );
  } else if (usable && (candidate.outcome === "pr" || (candidate.outcome !== "merged" && hasPr))) {
    primaryId = "pr";
    primary = <button type="button" className="btn btn-sm btn-accent" onClick={() => void run("pr", async () => openPullRequestPage(candidate, live))}><GitPullRequestArrow size={13} aria-hidden="true" />Open pull request</button>;
  } else if (usable && !candidate.outcome && candidate.promptDelivery === "pending") {
    primaryId = "send";
    primary = (
      <button type="button" className="btn btn-sm btn-accent" disabled={busy === "send" || !tileOpen} aria-busy={busy === "send" || undefined}
        title={tileOpen ? "Type the prompt into the agent and press Enter. Send it once the agent shows its input." : "Reopen the tile first"} onClick={() => void sendPrompt()}>
        {busy === "send" ? <LoaderCircle size={13} className="sw-spin" aria-hidden="true" /> : <Send size={13} aria-hidden="true" />}Send prompt
      </button>
    );
  } else if (committable) {
    primaryId = "commit";
    primary = <button type="button" className="btn btn-sm btn-accent" onClick={host.commit}><GitCommitHorizontal size={13} aria-hidden="true" />Commit…</button>;
  } else if (landable) {
    primaryId = "land";
    const blockedTitle = "Every check must pass first";
    primary = (
      <span className="task-split" role="group" aria-label="Land">
        <button type="button" className="btn btn-sm btn-accent task-split-main" disabled={!ready || busy !== null} aria-busy={busy === "merge" || busy === "pr" || undefined}
          title={ready ? `Merge into ${task.base}` : blockedTitle} onClick={() => void land("merge")}>
          {busy === "merge" || busy === "pr" ? <LoaderCircle size={13} className="sw-spin" aria-hidden="true" /> : <GitMerge size={13} aria-hidden="true" />}
          {multiple ? `Land ${agentName(candidate)}` : "Land"}
        </button>
        <TaskMenu label="Land options" title={ready ? "Merge or open a pull request" : blockedTitle} className="btn btn-sm btn-accent task-split-caret" disabled={!ready || busy !== null}
          actions={[
            { id: "merge", label: `Merge into ${task.base}`, icon: GitMerge, run: () => land("merge") },
            { id: "pr", label: "Open pull request", icon: GitPullRequestArrow, run: () => land("pr") },
          ]}>
          <ChevronDown size={13} aria-hidden="true" />
        </TaskMenu>
      </span>
    );
  }

  // Everything else the attempt offers, in the task window.
  const actions: Action[] = [
    ...(task.chain && (task.chain.state === "running" || task.chain.state === "paused") ? [
      { id: "skip", label: "Skip step", icon: SkipForward, run: () => run("chain", () => skipStep(task.id)) },
      { id: "stop", label: "Stop chain", icon: Square, run: () => stopChain(task.id) },
    ] : []),
    ...(usable ? [
      { id: "focus", label: tileOpen ? "Focus tile" : "Reopen tile", icon: Crosshair, run: () => revealCandidate(task, candidate) },
      { id: "review", label: "Review in tile", icon: GitCompareArrows, run: () => reviewInTile(task, candidate) },
      { id: "timeline", label: "Timeline", icon: History, run: () => openTimeline(task, candidate) },
    ] : []),
    ...(usable && hasPr && primaryId !== "pr" ? [{ id: "pr", label: "Open pull request", icon: GitPullRequestArrow, run: () => openPullRequestPage(candidate, live) }] : []),
    ...(landable && live.stats?.dirty && primaryId !== "commit" ? [{ id: "commit", label: "Commit…", icon: GitCommitHorizontal, run: host.commit }] : []),
    ...(task.chain ? [] : [{ id: "retry", label: "Retry with another agent", icon: RotateCw, run: host.retry }]),
    ...((discardable(candidate) && candidate.outcome !== "merged") && primaryId !== "discard"
      ? [{ id: "discard", label: multiple ? `Discard ${agentName(candidate)}` : "Discard", icon: Trash2, danger: true, run: discardThis }] : []),
  ];

  const blocked = gates.filter((gate) => gate.state === "blocked");
  const pending = gates.some((gate) => gate.state === "pending");
  const check = candidate.check;
  const gateAction = (gate: Gate): ReactNode => {
    if (gate.id === "clean" && gate.state === "blocked" && live.stats?.dirty && (!leftovers || leftovers.length > 0)) {
      return <button type="button" className="btn btn-sm" onClick={host.commit}><GitCommitHorizontal size={12} aria-hidden="true" />Commit…</button>;
    }
    if (gate.id === "prompt" && gate.state === "blocked") return <button type="button" className="btn btn-sm" disabled={busy !== null || !tileOpen} onClick={() => void sendPrompt()}><Send size={12} aria-hidden="true" />Send prompt</button>;
    if (gate.id !== "check" || !check || gate.state === "ok") return null;
    if (check.status === "unapproved") return <button type="button" className="btn btn-sm" disabled={busy !== null} onClick={() => void runCheck(check.commands)}><FlaskConical size={12} aria-hidden="true" />Approve and run</button>;
    if (["ready", "passed", "failed", "timeout", "error"].includes(check.status)) {
      return (
        <button type="button" className="btn btn-sm" disabled={busy !== null || (check.status === "error" && !check.commands.length)} onClick={() => void runCheck()}>
          {busy === "check" ? <LoaderCircle size={12} className="sw-spin" aria-hidden="true" /> : <FlaskConical size={12} aria-hidden="true" />}Run check
        </button>
      );
    }
    return null;
  };
  // Most details read on their own; the idle and check ones need their subject.
  const headline = (gate: Gate) => (gate.id === "idle" ? "The agent is still working; land once it stops." : gate.id === "check" ? `${gate.label}: ${gate.detail}` : gate.detail);
  const summary = blocked.length ? headline(blocked[0]) : pending ? "Checking whether it can land…" : `Ready to land into ${task.base}`;
  const SummaryIcon = blocked.length ? CircleAlert : pending ? LoaderCircle : CircleCheck;
  // The first blocker's own fix, unless the primary button already is that fix.
  const repeats = (gate: Gate) => (gate.id === "clean" && primaryId === "commit") || (gate.id === "prompt" && primaryId === "send");
  const quick = blocked.length && !repeats(blocked[0]) ? gateAction(blocked[0]) : null;
  // A race lands one attempt; the others go too unless this is turned off.
  const option = primaryId === "land" && multiple && others.length > 0;
  return { gates, blocked, pending, summary, SummaryIcon, quick, gateAction, primary, primaryId, actions, option, discardOthers, setDiscardOthers, check, busy };
}

/** The dropdown's gist: one line of what stands before landing, then Open details and the next action. */
export function LandSummary({ task, candidate, live, host, onDetails }: { task: Task; candidate: TaskCandidate; live: CandidateLive; host: LandHost; onDetails(): void }) {
  const land = useLand(task, candidate, live, host);
  // A race is compared, picked and landed in the task window, and discarding always happens there.
  const race = task.candidates.length > 1;
  const primary = race || land.primaryId === "discard" ? null : land.primary;
  return (
    <div className="task-land" role="group" aria-label="Land">
      {!race && land.gates.length && land.primaryId !== "pr" && land.primaryId !== "discard" ? (
        <div className={`task-gates-line ${land.blocked.length ? "is-blocked" : land.pending ? "is-pending" : "is-ok"}`}>
          <land.SummaryIcon size={14} className={`task-gates-icon ${!land.blocked.length && land.pending ? "sw-spin" : ""}`} aria-hidden="true" />
          <span className="task-gates-text" title={land.summary}>{land.summary}</span>
          {land.quick}
        </div>
      ) : null}
      <div className="task-actions usage-footer">
        <span />
        <button type="button" className="btn btn-sm" onClick={onDetails}>Open details</button>
        {primary}
      </div>
    </div>
  );
}

/** The task window's land section: every check with its fix, the check command, the actions and the next one. */
export function LandPanel({ task, candidate, live, host }: { task: Task; candidate: TaskCandidate; live: CandidateLive; host: LandHost }) {
  const land = useLand(task, candidate, live, host);
  const [showOutput, setShowOutput] = useState(false);
  const check = land.check;
  return (
    <>
      <div className="cp-detail-actions task-detail-actions" role="group" aria-label="Actions">
        {land.primary}
        {land.actions.map((action) => (
          <button key={action.id} type="button" className={`btn btn-sm cp-action ${action.danger ? "btn-danger" : ""}`} disabled={land.busy !== null} onClick={() => void action.run()}>
            <action.icon size={13} aria-hidden="true" />{action.label}
          </button>
        ))}
      </div>
      {land.option ? (
        <label className="task-discard-others" title="After landing, close the other attempts and delete their worktrees (you confirm what is lost first)">
          <Switch small on={land.discardOthers} onToggle={() => land.setDiscardOthers(!land.discardOthers)} title="Discard the other attempts" />
          <span>Discard the other attempts</span>
        </label>
      ) : null}
      {land.gates.length && land.primaryId !== "pr" && land.primaryId !== "discard" ? (
        <section className="task-gates-section" aria-label="Land checks">
          <ul className="task-gates" aria-label="Land checks">
            {land.gates.map((gate) => {
              const Icon = GATE_ICON[gate.state];
              return (
                <li key={gate.id} className={`task-gate is-${gate.state}`}>
                  <Icon size={14} className={gate.state === "pending" ? "sw-spin" : undefined} role="img" aria-label={GATE_STATE[gate.state]} />
                  <span className="task-gate-text"><span className="task-gate-label">{gate.label}</span><span className="task-gate-detail">{gate.detail}</span></span>
                  {land.gateAction(gate)}
                </li>
              );
            })}
          </ul>
          {check && check.commands.length && check.status !== "none" ? (
            <div className="task-check-box">
              <span className="task-gate-detail">Check command from .pzzacode/worktree.json: <code className="task-check-commands">{check.commands.join(" && ")}</code></span>
              {check.status === "unapproved" ? <p className="cp-detail-warn"><TriangleAlert size={12} aria-hidden="true" />These commands come from the repository. They run in this worktree on {task.host || "this device"} once you approve them, and again without asking until the list changes.</p> : null}
              {check.output ? (
                <>
                  <button type="button" className="notification-more task-output-toggle" aria-expanded={showOutput} onClick={() => setShowOutput(!showOutput)}>{showOutput ? "Hide output" : "Show output"}{check.durationMs !== undefined ? ` · ${Math.round(check.durationMs / 1000)}s` : ""}</button>
                  {showOutput ? <pre className="task-check-output" tabIndex={0} aria-label="Check output">{check.output}</pre> : null}
                </>
              ) : null}
            </div>
          ) : null}
        </section>
      ) : null}
    </>
  );
}
