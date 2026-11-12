import { useEffect, useMemo, useRef, useState } from "react";
import { useStore } from "../state/store";
import { hasPendingPermission, usePermissionPrompts } from "../state/permissionPrompts";
import { useSessionActivity, rowAgent } from "../ui/LiveSessionIcon";
import { useGitStatus } from "../grid/gitStatus";
import { useGitRemote } from "../grid/gitRemote";
import { useOutputActivity } from "./outputActivity";
import { fetchTaskStats } from "./taskApi";
import { candidateState, IDLE_MS } from "./taskStatus";
import { dropCandidateLive, setCandidateLive, useTaskLive } from "./taskLive";
import { useTasks, useTasksUi, type Task, type TaskCandidate } from "./taskStore";

// Always mounted in the app shell and renders nothing: one watcher per task
// candidate that is still in play reads the signals the app already has and
// writes the candidate's state to useTaskLive. Candidates that failed to
// start, merged or were discarded need no watcher.

const LAST_ACTIVE_SAVE_MS = 30000;
const STATS_DEBOUNCE_MS = 400;

export function TaskTracker() {
  const tasks = useTasks((state) => state.tasks);
  const watched = useMemo(() => tasks.flatMap((task) => task.candidates
    .filter((candidate) => candidate.launch === "started" && candidate.outcome !== "discarded" && candidate.outcome !== "merged" && candidate.worktree)
    .map((candidate) => ({ task, candidate }))), [tasks]);
  // A candidate that stops being watched falls back to its settled state.
  const ids = useRef(new Set<string>());
  useEffect(() => {
    const next = new Set(watched.map(({ candidate }) => candidate.id));
    for (const id of ids.current) if (!next.has(id)) dropCandidateLive(id);
    ids.current = next;
  }, [watched]);
  // Failed launches whose leftovers were not looked at yet are reclaimed on start, after a launch
  // fails, when a device comes back and whenever Tasks opens (no timer polls a device).
  const pending = useTasks((state) => state.tasks.flatMap((task) => task.candidates.filter((candidate) => candidate.cleanupPending).map((candidate) => candidate.id)).join(","));
  const devices = useStore((state) => state.activeDevices.map((device) => device.id).join(","));
  const tasksOpened = useTasksUi((state) => state.opened);
  useEffect(() => {
    if (!pending) return;
    void import("./taskActions").then((actions) => actions.reconcileTaskLaunches()).catch(() => {});
  }, [pending, devices, tasksOpened]);
  // A chain handoff the app lost track of (it closed mid-handoff) is picked up on start and when a device comes back.
  const handoffs = useTasks((state) => state.tasks.filter((task) => task.chain?.handoff).map((task) => task.id).join(","));
  useEffect(() => {
    if (!handoffs) return;
    void import("./taskChain").then((chain) => chain.reconcileChains()).catch(() => {});
  }, [handoffs, devices]);
  const chains = useMemo(() => tasks.filter((task) => task.chain?.state === "running" && !task.chain.handoff), [tasks]);
  return <>
    {watched.map(({ task, candidate }) => <CandidateWatch key={candidate.id} task={task} candidate={candidate} />)}
    {chains.map((task) => <ChainWatch key={task.id} task={task} />)}
  </>;
}

// Moves a running chain on from the step's state, as the status reads it: work
// seen, then quiet with nothing to approve, is the finish and the next step
// starts; an approval, an agent that exited or a session that closed pauses
// the chain for the user. A prompt still to be typed in waits like any task.
function ChainWatch({ task }: { task: Task }) {
  const candidate = task.candidates[0];
  const chain = task.chain;
  const index = chain ? chain.steps.findIndex((step) => step.status === "running") : -1;
  const step = chain?.steps[index];
  const live = useTaskLive((state) => (candidate ? state.live[candidate.id] : undefined));
  const permission = usePermissionPrompts((state) => !!step?.tileId && !!state.pending[step.tileId]);
  useEffect(() => {
    if (!candidate || !step) return;
    void import("./taskChain").then((actions) => {
      if (candidate.launch === "failed") { actions.pauseChain(task.id, index, candidate.error ?? "Could not start"); return; }
      // The state must be of this step's session: right after a handoff it can still be the previous one's.
      if (!live || candidate.session !== step.session) return;
      if (permission || (live.phase === "needs-you" && live.reason === "Approval needed")) { actions.pauseChain(task.id, index, "Approval needed"); return; }
      // Real output only: a session not read yet also counts as working ("Starting").
      if (live.working) { if (live.phase === "working" && !step.sawWork) actions.markStepWorking(task.id, index); return; }
      if (!step.sawWork) return;
      if (live.phase === "review" || (live.phase === "needs-you" && live.reason === "Waiting for you")) {
        // An agent that stopped to ask something waits for an answer, not for the next step.
        if (step.tileId && actions.stepAskedQuestion(step.tileId, step.startedAt ?? 0)) { actions.pauseChain(task.id, index, "Asked a question"); return; }
        void actions.continueChain(task.id, index, "done");
        return;
      }
      if (live.phase === "needs-you" && live.reason !== "Prompt not sent yet") actions.pauseChain(task.id, index, live.reason);
    }).catch(() => {});
  }, [task.id, index, step?.session, step?.sawWork, candidate?.session, candidate?.launch, live?.phase, live?.reason, live?.working, permission]);
  return null;
}

function CandidateWatch({ task, candidate }: { task: Task; candidate: TaskCandidate }) {
  const host = task.host;
  const tileOpen = useStore((state) => state.tiles.some((tile) => tile.id === candidate.tileId));
  const tasksOpen = useTasksUi((state) => state.open);
  const tasksOpened = useTasksUi((state) => state.opened);
  const landed = candidate.outcome === "pr";
  const activity = useSessionActivity(candidate.session, undefined, host);
  const agentRunning = activity ? rowAgent(activity) !== undefined : undefined;
  const pending = usePermissionPrompts((state) => !!state.pending[candidate.tileId]);
  const bellAt = useTaskLive((state) => state.bells[candidate.tileId]);
  const refreshNonce = useTaskLive((state) => state.refresh[candidate.id] ?? 0);
  const output = useOutputActivity(host, candidate.session, undefined, tileOpen && !landed);
  // The first reading counts as movement for the idle clock (a tile that never moves reads idle IDLE_MS later).
  const outputMovedAt = output.movedAt ?? output.seenAt;
  const status = useGitStatus(host, candidate.worktree, tasksOpen ? "visible" : "background");
  const [stats, setStats] = useState(() => useTaskLive.getState().live[candidate.id]?.stats);
  const [statsError, setStatsError] = useState<string | undefined>();
  const branch = status?.branch || stats?.branch || candidate.branch;
  const hasWork = (stats?.commits.length ?? candidate.stats?.commits ?? 0) > 0 || landed;
  const remote = useGitRemote(host, candidate.worktree, branch, hasWork);
  // gh reports the newest pull request of the branch name, which can be an old
  // merged or closed one from an earlier branch of the same name: only an open
  // one, or the one this candidate opened, belongs to it.
  const pr = remote === undefined ? undefined : remote?.pr && (remote.pr.state === "OPEN" || remote.pr.url === candidate.prUrl) ? remote.pr : null;
  // Re-evaluates once output has been quiet for IDLE_MS (a one-shot timer, not a poll).
  const [now, setNow] = useState(Date.now);
  useEffect(() => {
    if (outputMovedAt === undefined) return;
    setNow(Date.now());
    const wait = outputMovedAt + IDLE_MS + 50 - Date.now();
    if (wait <= 0) return;
    const timer = setTimeout(() => setNow(Date.now()), wait);
    return () => clearTimeout(timer);
  }, [outputMovedAt, bellAt]);

  const permission = pending || hasPendingPermission(candidate.tileId);
  const changes = stats ? stats.files.length > 0 || stats.commits.length > 0 : statsError ? status?.dirty ?? false : candidate.stats ? candidate.stats.files > 0 || candidate.stats.commits > 0 : undefined;
  const derived = candidateState({
    now, launch: candidate.launch, outcome: candidate.outcome, tileOpen, agentRunning, permission,
    promptPending: candidate.promptDelivery === "pending", outputMovedAt, bellAt, changes,
    pr,
  });

  // Changes against the base: read when the watcher starts, when Git status
  // moves (files changed, a commit, another branch), when the agent stops,
  // when Tasks opens and after an action asks for it. Never on a timer.
  const statusKey = status ? `${status.branch}\u0000${status.dirty}\u0000${status.ahead}\u0000${status.behind}` : "";
  useEffect(() => {
    const controller = new AbortController();
    const timer = setTimeout(() => {
      fetchTaskStats(host, candidate.worktree, task.base, controller.signal).then((next) => {
        if (controller.signal.aborted) return;
        setStats(next);
        setStatsError(undefined);
        const files = next.files.length;
        useTasks.getState().updateCandidate(task.id, candidate.id, {
          stats: { files, added: next.added, removed: next.removed, commits: next.commits.length, dirty: next.dirty, head: next.head, at: Date.now() },
          ...(next.branch && next.branch !== candidate.branch ? { branch: next.branch } : {}),
        });
      }).catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setStatsError(cause instanceof Error ? cause.message : "Changes unavailable");
      });
    }, STATS_DEBOUNCE_MS);
    return () => { clearTimeout(timer); controller.abort(); };
    // `derived.working` flips when the agent starts or stops a turn.
  }, [host, candidate.worktree, task.base, task.id, candidate.id, statusKey, derived.working, tasksOpened, refreshNonce]);

  // The time it worked: when its output last really moved, saved now and then
  // while it works and once more when it stops.
  useEffect(() => {
    const moved = output.movedAt;
    if (moved === undefined || moved === candidate.lastActiveAt) return;
    if (derived.working && moved - (candidate.lastActiveAt ?? 0) < LAST_ACTIVE_SAVE_MS) return;
    useTasks.getState().updateCandidate(task.id, candidate.id, { lastActiveAt: moved });
  }, [output.movedAt, derived.working, candidate.lastActiveAt, task.id, candidate.id]);

  // A pull request merged on the host settles the candidate as merged.
  useEffect(() => {
    if (pr?.state === "MERGED" && candidate.outcome !== "merged") {
      useTasks.getState().updateCandidate(task.id, candidate.id, { outcome: "merged", outcomeAt: Date.now(), prUrl: pr.url });
    } else if (pr?.state === "OPEN" && candidate.prUrl !== pr.url) {
      useTasks.getState().updateCandidate(task.id, candidate.id, { prUrl: pr.url });
    } else if (pr?.state === "CLOSED" && candidate.outcome === "pr") {
      // A closed pull request puts the candidate back in play: land it again or discard it.
      useTasks.getState().updateCandidate(task.id, candidate.id, { outcome: undefined, outcomeAt: undefined });
    }
  }, [pr?.state, pr?.url, candidate.outcome, candidate.prUrl, task.id, candidate.id]);

  useEffect(() => {
    setCandidateLive(candidate.id, { ...derived, stats, statsError, pr, agentRunning });
  }, [candidate.id, derived.phase, derived.reason, derived.working, stats, statsError, pr, agentRunning]);
  return null;
}
