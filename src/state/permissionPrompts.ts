import { create } from "zustand";
import {
  declinesPermission, detectPermissionPrompt, followPermissionPrompt, permissionAgentLabel, permissionAnswerPlan, permissionTitle,
  sameDeclinedPermissionPrompt, samePermissionPrompt, screenWithHistory,
  type PermissionPrompt, type Screen,
} from "../terminal/permissionPrompts";
import { notify, useNotifications, type PermissionOutcome } from "./notifications";
import { useStore } from "./store";
import { sessionDisplayName } from "../sessionMeta";
import { deviceNameFor } from "../devices";

// Approval prompts that coding agents show in their terminals, answered from
// the app. Each terminal registers a target that can read its visible screen
// and send raw input over the same attachment its keyboard input uses; a
// watcher scans the screen after output and keeps one pending prompt per
// tile. Answering re-reads the screen first and sends nothing unless the very
// same prompt is still there.

/** One terminal's screen and input, as seen by the permission watcher. */
export interface PermissionTarget {
  /** The visible screen as currently parsed. */
  screen(): Screen;
  /** The visible screen after all received output has been parsed. */
  freshScreen(): Promise<Screen>;
  /** Raw input over the live attachment; rejects when the tile is detached. */
  send(data: string): Promise<void>;
  /** Whether the terminal has keyboard focus in a focused window. */
  focused(): boolean;
  /** What runs in the pane this tile's input reaches; `fresh` skips any cache. */
  foreground(fresh: boolean): Promise<PaneForeground | null>;
  /**
   * The recent history and visible rows of that pane, captured at once and
   * oldest first, as tmux wrapped them. Read only for an input that starts
   * above the screen.
   */
  paneLines(): Promise<readonly string[]>;
}
/** The agent in a tile's active pane and how many panes share its window. */
export interface PaneForeground {
  agent: string | undefined;
  /** Undefined when the device could not say. */
  panes: number | undefined;
}

export type PermissionPhase = "waiting" | "sending" | "sent";
export interface PendingPermission {
  id: string;
  tileId: string;
  prompt: PermissionPrompt;
  noticeId?: string;
  detectedAt: number;
  phase: PermissionPhase;
  /** Label of the choice sent from the app, while the agent takes it. */
  sentLabel?: string;
  error?: string;
}

interface PermissionState {
  pending: Record<string, PendingPermission>;
}
export const usePermissionPrompts = create<PermissionState>(() => ({ pending: {} }));

const targets = new Map<string, PermissionTarget>();
const blocked = new Map<string, PermissionPrompt>();
// Prompts on screen per tile, offered or not, and the plain notices of those
// that cannot be answered from the app.
const onScreen = new Map<string, PermissionPrompt>();
export const CLIPPED_MESSAGE = "Part of this input is cut off on screen, so approve it in the terminal. Deny works here.";
const unoffered = new Map<string, { prompt: PermissionPrompt; noticeId: string | undefined }>();
const inFlight = new Set<string>();
// A prompt must be seen twice this far apart before it is announced: a CLI
// redrawing its screen can briefly show a half-drawn prompt.
const CONFIRM_MS = 180;
// A prompt that vanishes must stay gone this long before its notice clears:
// a re-attach repaints the pane and can show a blank frame first.
const ABSENT_MS = 700;
const SCAN_THROTTLE_MS = 220;
// After keys were sent, the prompt should leave the screen within this time.
const SENT_TIMEOUT_MS = 5000;
const RECENT_BELL_MS = 15_000;
// A prompt whose pane could not be confirmed is checked again after this,
// doubling up to the maximum.
const RECHECK_MS = 2000;
const RECHECK_MAX_MS = 32_000;

function patch(tileId: string, update: Partial<PendingPermission> | null): void {
  usePermissionPrompts.setState(state => {
    const current = state.pending[tileId];
    if (update === null) {
      if (!current) return state;
      const pending = { ...state.pending };
      delete pending[tileId];
      return { pending };
    }
    if (!current) return state;
    return { pending: { ...state.pending, [tileId]: { ...current, ...update } } };
  });
}

/**
 * Whether a tile is waiting on an approval prompt right now: one is on its
 * screen, whether or not it can be answered from the app. A waiting agent has
 * not finished its turn.
 */
export function hasPendingPermission(tileId: string): boolean {
  return !!usePermissionPrompts.getState().pending[tileId] || onScreen.has(tileId);
}

function noticeSource(tileId: string): string {
  const state = useStore.getState();
  const tile = state.tiles.find(candidate => candidate.id === tileId);
  const clean = (text: string) => text.replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 100);
  const label = tile ? clean(sessionDisplayName(tile, state.tileTitles)) : clean(tileId);
  const device = clean(tile?.host ? deviceNameFor(state.devices, tile.host) || tile.host : "This device") || "This device";
  return `${label || "Terminal"} (${device})`;
}

function resolveNotice(entry: PendingPermission, outcome: PermissionOutcome, choice?: string): void {
  if (!entry.noticeId) return;
  const notifications = useNotifications.getState();
  const notice = notifications.items.find(item => item.id === entry.noticeId);
  if (!notice || notice.action?.kind !== "permission") return;
  notifications.update(notice.id, { action: { ...notice.action, outcome, choice: choice?.slice(0, 80) } });
  notifications.read(notice.id);
}

// A bell or OSC notification the agent sent for this same wait says less
// than the prompt does, so the prompt's notice takes its place.
function dropRecentBells(tileId: string): void {
  const notifications = useNotifications.getState();
  const now = Date.now();
  for (const item of notifications.items) {
    if (!item.read && item.target?.tileId === tileId && item.event === "terminal-bell" && now - item.createdAt < RECENT_BELL_MS) notifications.remove(item.id);
  }
}

function announce(tileId: string, prompt: PermissionPrompt, focused: boolean): void {
  const id = crypto.randomUUID();
  dropRecentBells(tileId);
  clearUnoffered(tileId);
  const noticeId = notify({
    category: "terminal", event: "agent-permission",
    title: permissionTitle(prompt), body: prompt.subject || prompt.question,
    source: noticeSource(tileId), target: { tileId },
    action: { kind: "permission", promptId: id, agent: prompt.agent },
    dedupeKey: `agent-permission:${id}`,
  });
  // Someone typing in that terminal already sees the prompt.
  if (noticeId && focused) useNotifications.getState().read(noticeId);
  usePermissionPrompts.setState(state => ({
    pending: { ...state.pending, [tileId]: { id, tileId, prompt, noticeId, detectedAt: Date.now(), phase: "waiting" } },
  }));
}

// A prompt that is on screen but cannot be answered from the app still means
// the agent waits: a plain notice says so, without buttons.
function announceUnoffered(tileId: string, prompt: PermissionPrompt, reason: string, focused: boolean): void {
  const known = unoffered.get(tileId);
  if (known && followPermissionPrompt(known.prompt, prompt)) { unoffered.set(tileId, { ...known, prompt }); return; }
  clearUnoffered(tileId);
  dropRecentBells(tileId);
  const noticeId = notify({
    category: "terminal", event: "agent-permission",
    title: `${permissionAgentLabel(prompt.agent)}: Waiting for approval in the terminal`,
    body: `${reason} Answer in the terminal.`,
    source: noticeSource(tileId), target: { tileId },
    dedupeKey: `agent-permission-unoffered:${tileId}:${crypto.randomUUID()}`,
  });
  if (noticeId && focused) useNotifications.getState().read(noticeId);
  unoffered.set(tileId, { prompt, noticeId });
}

function clearUnoffered(tileId: string): void {
  const known = unoffered.get(tileId);
  if (!known) return;
  unoffered.delete(tileId);
  if (known.noticeId) useNotifications.getState().read(known.noticeId);
}

function settle(tileId: string, prompt: PermissionPrompt | null, focused: boolean): void {
  const entry = usePermissionPrompts.getState().pending[tileId];
  const kept = entry && prompt ? followPermissionPrompt(entry.prompt, prompt) : null;
  if (entry && kept) {
    // The same prompt redrawn: show it as it is on screen now.
    if (entry.prompt !== kept && (entry.prompt.subject !== kept.subject || entry.prompt.selected !== kept.selected || entry.prompt.clipped !== kept.clipped || entry.prompt.cols !== kept.cols)) patch(tileId, { prompt: kept });
    return;
  }
  if (entry) {
    patch(tileId, null);
    resolveNotice(entry, entry.phase === "waiting" ? "elsewhere" : "answered", entry.sentLabel);
  }
  if (prompt) announce(tileId, prompt, focused);
}

// Stops offering a prompt from the app: its notice says why, and the same
// prompt is not offered again until it has left the screen.
function lock(tileId: string, entry: PendingPermission, outcome: PermissionOutcome): void {
  blocked.set(tileId, entry.prompt);
  if (usePermissionPrompts.getState().pending[tileId]?.id === entry.id) patch(tileId, null);
  resolveNotice(entry, outcome);
}

// Why keys sent to this tile would not reach the agent that drew the prompt:
// a split window (input goes to the active pane only, whichever pane drew
// the prompt), or a pane that runs something else, e.g. a shell printing a
// prompt-like screen. Null when it is safe.
function unreachable(prompt: PermissionPrompt, foreground: PaneForeground | null): string | null {
  if (!foreground || foreground.panes === undefined) return "This device could not say what runs in this terminal.";
  if (foreground.panes !== 1) return "This window is split into panes.";
  if (foreground.agent !== prompt.agent) return `${permissionAgentLabel(prompt.agent)} is not running in this terminal's active pane.`;
  return null;
}

/**
 * Watches one terminal for approval prompts. `schedule` is cheap and may be
 * called after every parsed write; scans are throttled and read only the
 * visible rows. A prompt is offered only once the tile's pane is known to run
 * that agent, alone in its window; otherwise it is reported as waiting in the
 * terminal. Either way the tile counts as waiting (hasPendingPermission).
 */
export function createPermissionWatcher(tileId: string, target: PermissionTarget) {
  let disposed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timerAt = 0;
  let lastScan = 0;
  let candidate: { prompt: PermissionPrompt; at: number } | null = null;
  let absentSince = 0;
  let checking = false;
  let rejected: { prompt: PermissionPrompt; until: number; delay: number } | null = null;
  // The agent last confirmed in this pane: some agents draw another agent's
  // prompt (Kilo Code keeps OpenCode's panel), and the screen is read as
  // this one's.
  let paneAgent: string | undefined;
  targets.set(tileId, target);

  // The rows above the screen, kept for the screen they line up with, so an
  // input that starts above the screen reads in full. Read only while such a
  // prompt shows, again once the screen changes, and after a failure again
  // after a delay that doubles.
  let history: { rows: string; above: readonly string[] | undefined; retryAt: number; delay: number } | null = null;
  let historyLoading = false;
  let historyRetry: ReturnType<typeof setTimeout> | undefined;
  const loadHistory = (screen: Screen, key: string) => {
    historyLoading = true;
    clearTimeout(historyRetry);
    const delay = history?.rows === key ? Math.min(history.delay * 2, RECHECK_MAX_MS) : RECHECK_MS;
    void target.paneLines().then(lines => screenWithHistory(screen, lines)?.above, () => undefined).then(above => {
      historyLoading = false;
      if (disposed) return;
      history = { rows: key, above, retryAt: performance.now() + delay, delay };
      // A rescan reads the prompt with the rows above, or tries again later;
      // neither holds back a scan already due.
      if (above) schedule();
      else historyRetry = setTimeout(() => schedule(), delay);
    });
  };
  const read = () => {
    try {
      const screen = target.screen();
      const prompt = detectPermissionPrompt(screen, paneAgent);
      if (prompt?.clipped !== "start") return prompt;
      const key = screen.rows.join("\n");
      if (history?.rows === key && history.above) return detectPermissionPrompt({ ...screen, above: history.above }, paneAgent) ?? prompt;
      if (!historyLoading && (history?.rows !== key || performance.now() >= history.retryAt)) loadHistory(screen, key);
      return prompt;
    } catch { return null; }
  };
  // Confirms the pane before a prompt is offered. A rejected prompt is
  // checked again with backoff: activity can lag an agent that just started.
  const verify = (prompt: PermissionPrompt) => {
    if (checking) return;
    const again = rejected && followPermissionPrompt(rejected.prompt, prompt);
    if (rejected && again && performance.now() < rejected.until) {
      schedule(rejected.until - performance.now());
      return;
    }
    checking = true;
    const delay = rejected && again ? Math.min(rejected.delay * 2, RECHECK_MAX_MS) : RECHECK_MS;
    void target.foreground(false).catch(() => null).then(foreground => {
      checking = false;
      if (disposed) return;
      const reason = unreachable(prompt, foreground);
      // The pane runs another agent alone, and the screen reads as its prompt
      // too: read it as that agent's from now on and confirm it again.
      if (reason && foreground?.panes === 1 && foreground.agent && foreground.agent !== paneAgent && foreground.agent !== prompt.agent
        && detectPermissionPrompt(target.screen(), foreground.agent)?.agent === foreground.agent) {
        paneAgent = foreground.agent;
        schedule();
        return;
      }
      if (reason) {
        rejected = { prompt, until: performance.now() + delay, delay };
        // Only one pane, running something else: prompt-like text (a shell
        // printing a log), not an agent waiting. Otherwise the agent may well
        // wait in a pane the app cannot answer.
        if (foreground?.panes === 1) {
          onScreen.delete(tileId);
          clearUnoffered(tileId);
        } else if (onScreen.has(tileId)) announceUnoffered(tileId, prompt, reason, target.focused());
        schedule(delay);
        return;
      }
      rejected = null;
      // The screen may have moved on while the check ran.
      const now = read();
      if (now && followPermissionPrompt(prompt, now)) settle(tileId, now, target.focused());
      else schedule();
    });
  };
  const gone = () => {
    onScreen.delete(tileId);
    blocked.delete(tileId);
    clearUnoffered(tileId);
    rejected = null;
  };

  const scan = () => {
    timer = undefined;
    if (disposed) return;
    lastScan = performance.now();
    const prompt = read();
    const entry = usePermissionPrompts.getState().pending[tileId];
    if (!prompt) {
      candidate = null;
      if ((!entry && !onScreen.has(tileId) && !blocked.has(tileId)) || inFlight.has(tileId)) return;
      if (!absentSince) absentSince = lastScan;
      if (lastScan - absentSince < ABSENT_MS) { schedule(ABSENT_MS - (lastScan - absentSince)); return; }
      absentSince = 0;
      gone();
      if (entry) settle(tileId, null, false);
      return;
    }
    absentSince = 0;
    const block = blocked.get(tileId);
    if (block) {
      if (followPermissionPrompt(block, prompt)) return;
      blocked.delete(tileId);
    }
    if (entry && followPermissionPrompt(entry.prompt, prompt)) { candidate = null; settle(tileId, prompt, target.focused()); return; }
    // An answer in progress owns the screen until it finishes.
    if (inFlight.has(tileId)) return;
    if (!candidate || !followPermissionPrompt(candidate.prompt, prompt)) {
      candidate = { prompt, at: lastScan };
      schedule(CONFIRM_MS);
      return;
    }
    if (lastScan - candidate.at < CONFIRM_MS) { schedule(CONFIRM_MS - (lastScan - candidate.at)); return; }
    candidate = null;
    onScreen.set(tileId, prompt);
    verify(prompt);
  };
  // New output scans soon (throttled); an explicit delay sets the next scan.
  // A long recheck wait never holds back a scan that output asks for.
  function schedule(delay?: number) {
    if (disposed) return;
    const wait = delay ?? Math.max(0, SCAN_THROTTLE_MS - (performance.now() - lastScan));
    const at = performance.now() + wait;
    if (timer !== undefined) {
      if (delay === undefined && timerAt <= at) return;
      clearTimeout(timer);
    }
    timerAt = at;
    timer = setTimeout(scan, wait);
  }
  return {
    schedule: () => schedule(),
    dispose() {
      disposed = true;
      clearTimeout(timer);
      clearTimeout(historyRetry);
      if (targets.get(tileId) === target) targets.delete(tileId);
      // A closed tile cannot be answered any more. A remounted one (same
      // tile, new attachment) registers again and rescans.
      queueMicrotask(() => {
        if (targets.has(tileId) || useStore.getState().tiles.some(tile => tile.id === tileId)) return;
        gone();
        const entry = usePermissionPrompts.getState().pending[tileId];
        if (!entry) return;
        patch(tileId, null);
        resolveNotice(entry, "closed");
      });
    },
  };
}

export type PermissionAnswer = "sent" | "stale" | "failed";

async function waitForScreen(target: PermissionTarget, until: (screen: Screen) => boolean, timeoutMs: number): Promise<boolean> {
  const deadline = performance.now() + timeoutMs;
  for (;;) {
    if (until(await target.freshScreen())) return true;
    if (performance.now() >= deadline) return false;
    await new Promise(resolve => setTimeout(resolve, 60));
  }
}

// The prompt on a fresh read of the screen. With `full`, an input that starts
// above the screen is read in full from a new capture of the pane's history,
// as the watcher read it, so the two reads compare alike.
async function freshPrompt(target: PermissionTarget, full: boolean, agent: string): Promise<PermissionPrompt | null> {
  const screen = await target.freshScreen();
  const prompt = detectPermissionPrompt(screen, agent);
  if (!full || prompt?.clipped !== "start") return prompt;
  const lines = await target.paneLines().catch(() => null);
  const whole = lines ? screenWithHistory(screen, lines) : null;
  return (whole && detectPermissionPrompt(whole, agent)) || prompt;
}

/**
 * Answers a tile's pending prompt with one of its choices. Keys are sent only
 * when the pane still runs that agent alone in its window and a fresh read of
 * the screen shows the identical prompt; otherwise nothing is sent. A prompt
 * whose input is cut short on screen can only be declined. Once any
 * key went out, a step that fails locks the prompt instead of offering its
 * buttons again: the terminal is in a state the app did not plan for.
 */
export async function answerPermission(tileId: string, promptId: string, choiceId: string, feedback?: string): Promise<PermissionAnswer> {
  const entry = usePermissionPrompts.getState().pending[tileId];
  if (!entry || entry.id !== promptId) return "stale";
  if (entry.phase !== "waiting" || inFlight.has(tileId)) return "failed";
  const target = targets.get(tileId);
  if (!target) {
    patch(tileId, { error: "This terminal is not attached. Open the tile to answer." });
    return "failed";
  }
  // What would be approved must be readable in full. Declining approves
  // nothing, so it works on an input cut short on screen too.
  const chosen = entry.prompt.choices.find(option => option.id === choiceId);
  if (entry.prompt.clipped && !(chosen && declinesPermission(chosen))) {
    patch(tileId, { error: CLIPPED_MESSAGE });
    return "failed";
  }
  inFlight.add(tileId);
  patch(tileId, { phase: "sending", error: undefined });
  let sentAny = false;
  try {
    const foreground = await target.foreground(true).catch(() => null);
    if (unreachable(entry.prompt, foreground)) {
      lock(tileId, entry, "unverified");
      return "stale";
    }
    // Read as the prompt was: a prompt whose start stayed unreadable holds
    // only what the screen shows, so it is compared without the history.
    const current = await freshPrompt(target, entry.prompt.clipped !== "start", entry.prompt.agent);
    const latest = usePermissionPrompts.getState().pending[tileId];
    const same = !!current && (entry.prompt.clipped ? sameDeclinedPermissionPrompt(entry.prompt, current) : samePermissionPrompt(entry.prompt, current));
    if (!current || !latest || latest.id !== promptId || !same) {
      // Still the same prompt, but its start could not be read again.
      if (current?.clipped === "start" && entry.prompt.clipped !== "start" && latest?.id === promptId && followPermissionPrompt(entry.prompt, current)) {
        throw new Error("Could not read the whole input in the terminal again. Nothing was sent.");
      }
      if (latest?.id === promptId) {
        patch(tileId, null);
        resolveNotice(latest, "elsewhere");
      }
      return "stale";
    }
    // Plan from the screen as it is now (the highlight may have moved).
    const plan = permissionAnswerPlan(current, choiceId, feedback);
    const choice = current.choices.find(option => option.id === choiceId);
    for (const step of plan) {
      if (step.kind === "send") {
        sentAny = true;
        await target.send(step.data);
      } else if (!(await waitForScreen(target, step.until, step.timeoutMs))) throw new Error(step.failure);
    }
    patch(tileId, { phase: "sent", sentLabel: choice?.label });
    setTimeout(() => {
      const after = usePermissionPrompts.getState().pending[tileId];
      if (after?.id === promptId && after.phase === "sent") lock(tileId, after, "interrupted");
    }, SENT_TIMEOUT_MS);
    return "sent";
  } catch (error) {
    if (sentAny) lock(tileId, entry, "interrupted");
    else patch(tileId, { phase: "waiting", error: error instanceof Error ? error.message : "The answer could not be sent." });
    return "failed";
  } finally {
    inFlight.delete(tileId);
  }
}

/** The pending prompt a notice is about, if it is still waiting. */
export function pendingForNotice(state: PermissionState, tileId: string | undefined, promptId: string): PendingPermission | undefined {
  const entry = tileId ? state.pending[tileId] : undefined;
  return entry?.id === promptId ? entry : undefined;
}

