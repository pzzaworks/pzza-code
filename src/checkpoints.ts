import { create } from "zustand";
import { GitRequestError, postGitReview, type PaneOutputActivity } from "./serverApi";
import { OUTPUT_ACTIVITY_SHARE_MS, readPaneOutputActivity } from "./terminal/outputActivityCache";
import { sessionDisplayName } from "./sessionMeta";
import { useNotifications } from "./state/notifications";
import { hasPendingPermission } from "./state/permissionPrompts";
import { useSessionAgents } from "./state/sessionAgents";
import { isSessionTile, sessionTileById, useStore } from "./state/store";
import { HAS_TAURI } from "./tauriEnv";
import { tileGitTarget } from "./tileGit";
import { runningAgent } from "./ui/LiveSessionIcon";
import { sessionAgent } from "../server/lib/session-agents.js";

// Checkpoints of a tile's working tree (server/lib/checkpoints.js): taken when
// the tile's agent finishes a turn, when an agent first shows up in a tile
// (the baseline the first turn is measured from), on request, and before
// every restore.

export type CheckpointKind = "start" | "turn" | "manual" | "backup";
export type CheckpointFileStatus = "added" | "deleted" | "modified";
export type CheckpointAgainst = "previous" | "now";
export type CheckpointMode = "restore" | "undo";

export interface Checkpoint {
  id: number;
  commit: string;
  time: number;
  kind: CheckpointKind;
  summary: string;
  agent: string;
  session: string;
  branch: string;
  files: number;
  added: number;
  removed: number;
  skipped: number;
}
export interface CheckpointList { root: string; checkpoints: Checkpoint[]; keep: number }
export interface CheckpointFile { path: string; status: CheckpointFileStatus; added: number | null; removed: number | null; binary: boolean }
export interface CheckpointFiles {
  id: number;
  against: CheckpointAgainst;
  from: string;
  to: string;
  /** The checkpoint the changes are measured from, null when it is the commit the checkpoint was taken on. */
  previous: number | null;
  files: CheckpointFile[];
  truncated: boolean;
}
export interface CheckpointPreview {
  id: number;
  mode: CheckpointMode;
  expect: string;
  truncated: boolean;
  blocked: string[];
  files: { path: string; action: "create" | "delete" | "modify" }[];
  applies: boolean;
  reason: string | null;
}
/** `relabelled`: no files changed, and the turn checkpoint named in the request took the summary instead. */
export interface CheckpointCapture { id: number | null; created: boolean; relabelled: boolean; skipped: number; root: string }

// ------------------------------------------------------------------ parsing

type Data = Record<string, unknown>;
const isData = (value: unknown): value is Data => typeof value === "object" && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const KINDS: readonly CheckpointKind[] = ["start", "turn", "manual", "backup"];
const STATUSES: readonly CheckpointFileStatus[] = ["added", "deleted", "modified"];
const ACTIONS = ["create", "delete", "modify"] as const;
const invalid = (what: string) => new Error(`${what} unavailable`);

function parseCheckpoint(value: unknown): Checkpoint | null {
  if (!isData(value) || !isCount(value.id) || typeof value.commit !== "string" || !isCount(value.time)) return null;
  const kind = KINDS.find((entry) => entry === value.kind);
  if (!kind) return null;
  const text = (field: unknown) => (typeof field === "string" ? field : "");
  const count = (field: unknown) => (isCount(field) ? field : 0);
  return {
    id: value.id, commit: value.commit, time: value.time, kind,
    summary: text(value.summary), agent: text(value.agent), session: text(value.session), branch: text(value.branch),
    files: count(value.files), added: count(value.added), removed: count(value.removed), skipped: count(value.skipped),
  };
}

function parseFile(value: unknown): CheckpointFile | null {
  if (!isData(value) || typeof value.path !== "string" || typeof value.binary !== "boolean") return null;
  const status = STATUSES.find((entry) => entry === value.status);
  const lines = (field: unknown) => (isCount(field) ? field : null);
  return status ? { path: value.path, status, added: lines(value.added), removed: lines(value.removed), binary: value.binary } : null;
}

const body = (host: string, path: string, extra: Data = {}) => ({ host, path, ...extra });

export async function fetchCheckpoints(host: string, path: string, signal?: AbortSignal): Promise<CheckpointList> {
  const value = await postGitReview("checkpoints", body(host, path), "Checkpoints unavailable", signal);
  if (!isData(value) || typeof value.root !== "string" || !Array.isArray(value.checkpoints) || !isCount(value.keep)) throw invalid("Checkpoints");
  return { root: value.root, keep: value.keep, checkpoints: value.checkpoints.map(parseCheckpoint).filter((entry): entry is Checkpoint => entry !== null) };
}

export async function captureCheckpoint(host: string, path: string, meta: { kind: Exclude<CheckpointKind, "backup">; agent?: string; session?: string; summary?: string; relabel?: number }, signal?: AbortSignal): Promise<CheckpointCapture> {
  const value = await postGitReview("checkpoints/capture", body(host, path, { ...meta }), "Could not save a checkpoint", signal);
  if (!isData(value)) throw invalid("Checkpoint");
  const id = value.id === null ? null : isCount(value.id) ? value.id : undefined;
  if (id === undefined || typeof value.created !== "boolean" || !isCount(value.skipped) || typeof value.root !== "string") throw invalid("Checkpoint");
  const result: CheckpointCapture = { id, created: value.created, relabelled: value.relabelled === true, skipped: value.skipped, root: value.root };
  if (result.created || result.relabelled) bumpCheckpoints(host, result.root);
  return result;
}

export async function fetchCheckpointFiles(host: string, path: string, id: number, against: CheckpointAgainst, signal?: AbortSignal): Promise<CheckpointFiles> {
  const value = await postGitReview("checkpoints/files", body(host, path, { id, against }), "Checkpoint changes unavailable", signal);
  if (!isData(value) || typeof value.from !== "string" || typeof value.to !== "string" || !Array.isArray(value.files) || typeof value.truncated !== "boolean") throw invalid("Checkpoint changes");
  const files = value.files.map(parseFile).filter((file): file is CheckpointFile => file !== null);
  return { id, against, from: value.from, to: value.to, previous: isCount(value.previous) ? value.previous : null, files, truncated: value.truncated };
}

export interface CheckpointFileDiff { before: string | null; after: string | null; binary: boolean; truncated: boolean }

export async function fetchCheckpointDiff(host: string, path: string, from: string, to: string, file: string, signal?: AbortSignal): Promise<CheckpointFileDiff> {
  const value = await postGitReview("checkpoints/diff", body(host, path, { from, to, file }), "File changes unavailable", signal);
  const textOrNull = (field: unknown): field is string | null => field === null || typeof field === "string";
  if (!isData(value) || !textOrNull(value.before) || !textOrNull(value.after) || typeof value.binary !== "boolean" || typeof value.truncated !== "boolean") throw invalid("File changes");
  return { before: value.before, after: value.after, binary: value.binary, truncated: value.truncated };
}

export async function previewCheckpoint(host: string, path: string, id: number, mode: CheckpointMode, signal?: AbortSignal): Promise<CheckpointPreview> {
  const value = await postGitReview("checkpoints/preview", body(host, path, { id, mode }), "Could not prepare the restore", signal);
  if (!isData(value) || typeof value.expect !== "string" || !Array.isArray(value.files) || !Array.isArray(value.blocked) || typeof value.applies !== "boolean") throw invalid("Restore preview");
  const files = value.files.flatMap((file) => {
    if (!isData(file) || typeof file.path !== "string") return [];
    const action = ACTIONS.find((entry) => entry === file.action);
    return action ? [{ path: file.path, action }] : [];
  });
  return {
    id, mode, expect: value.expect, files, applies: value.applies, truncated: value.truncated === true,
    blocked: value.blocked.filter((entry): entry is string => typeof entry === "string"),
    reason: typeof value.reason === "string" ? value.reason : null,
  };
}

/** A restore that failed; `backup` is the checkpoint holding the files from before it, when one was saved. */
export class CheckpointRestoreError extends Error {
  constructor(message: string, readonly backup: number | null) { super(message); }
}

export async function restoreCheckpoint(host: string, path: string, preview: CheckpointPreview, session: string, root: string): Promise<{ backup: number }> {
  try {
    const value = await postGitReview("checkpoints/restore", body(host, path, { id: preview.id, mode: preview.mode, expect: preview.expect, session }), "Could not restore the checkpoint");
    if (!isData(value) || value.restored !== true || !isCount(value.backup)) throw invalid("Restore");
    return { backup: value.backup };
  } catch (cause) {
    if (cause instanceof GitRequestError) throw new CheckpointRestoreError(cause.message, isCount(cause.details.backup) ? cause.details.backup : null);
    throw cause;
  } finally {
    // A failed restore may still have saved the state before it.
    bumpCheckpoints(host, root);
  }
}

// -------------------------------------------------------------------- state

const rootKey = (host: string, root: string) => `${host}\u0000${root}`;

interface CheckpointsUi {
  /** The tile whose checkpoint timeline is open, if any. */
  openTileId: string | null;
  /** Bumped per device and worktree whenever its checkpoints change. */
  revisions: Record<string, number>;
  open(tileId: string): void;
  close(): void;
}

export const useCheckpointsUi = create<CheckpointsUi>((set) => ({
  openTileId: null,
  revisions: {},
  open: (tileId) => set({ openTileId: tileId }),
  close: () => set({ openTileId: null }),
}));

export function bumpCheckpoints(host: string, root: string): void {
  const key = rootKey(host, root);
  useCheckpointsUi.setState((state) => ({ revisions: { ...state.revisions, [key]: (state.revisions[key] ?? 0) + 1 } }));
}

export const checkpointRevision = (state: CheckpointsUi, host: string, root: string | undefined): number => (root ? state.revisions[rootKey(host, root)] ?? 0 : 0);

// ------------------------------------------------------------------ capture

const CONTROL = /[\u0000-\u001f\u007f-\u009f]+/g;
const SUMMARY_CHARS = 300;
const CAPTURE_TIMEOUT_MS = 45000;

export function agentLabel(agent: string): string {
  return sessionAgent(agent)?.label ?? (agent ? agent[0].toUpperCase() + agent.slice(1) : "Agent");
}

// A notice body only says something about the turn when the agent wrote it:
// the generic texts a bare bell produces are left out.
const GENERIC_BODIES = [/^No message was provided/i, /^New output arrived/i];
export function turnSummary(text: string | undefined): string {
  const clean = (text ?? "").replace(CONTROL, " ").replace(/\s+/g, " ").trim();
  if (!clean || GENERIC_BODIES.some((pattern) => pattern.test(clean))) return "";
  return clean.length > SUMMARY_CHARS ? `${clean.slice(0, SUMMARY_CHARS - 1)}…` : clean;
}

interface TileContext { host: string; folder: string; agent: string; session: string }

// The tile's folder and the coding agent in it (the running one, else the one
// it was created with); null when either is unknown.
function tileContext(tileId: string): TileContext | null {
  const target = tileGitTarget(tileId);
  const state = useStore.getState();
  const tile = sessionTileById(state.tiles, tileId);
  if (!target || !tile) return null;
  const session = tile.session ?? tile.name;
  const host = tile.host ?? state.connection.host ?? (HAS_TAURI ? "" : undefined);
  const agent = runningAgent(session, tile.window, host) ?? useSessionAgents.getState().agents[tileId]?.id;
  if (!agent) return null;
  const label = sessionDisplayName(tile, state.tileTitles).replace(CONTROL, " ").trim().slice(0, 120);
  return { host: target.host, folder: target.folder, agent, session: label };
}

// ----------------------------------------------------------- turn capture

// A finished turn is caught from two signals. The agent's finish signal (a
// bell or notification) carries its message, but it only reaches the app from
// a terminal that is on screen and not focused, often a minute after the turn
// ended, and never while the app is closed or restarting. So every tile with
// a coding agent is also watched from its output (focused or not, on screen
// or not, whether or not the window has focus): output that stops for
// IDLE_MS after it moved ends a turn. tmux reports output time in whole
// seconds of the device clock, so only changes between polls are used (never
// a comparison with this machine's clock). One small poll per device.
const WATCH_MS = 4000;
const IDLE_MS = 8000;
// A bell is printed with the agent's last output: output seen moving this
// shortly before it still belongs to the turn the bell ends.
const BELL_GRACE_MS = WATCH_MS + 1500;
const turnWatch = new Map<string, { activity: number; movedAt: number; moving: boolean }>();
const lastFinished = new Map<string, number>();
// Per tile, the newest turn checkpoint saved here without the agent's message
// (when the capture started, and its number), which the message can still name.
const unlabelled = new Map<string, { at: number; id: number }>();

/**
 * Saves a checkpoint after the agent in a tile finished a turn; unchanged trees are not saved twice. A tile waiting on an approval prompt is mid-turn, so nothing is saved.
 * When the output watch already saved this turn without a message and nothing changed since, the message the finish signal brings names that checkpoint.
 */
export async function captureTurnCheckpoint(tileId: string, noticeId?: string): Promise<CheckpointCapture | null> {
  const now = Date.now();
  lastFinished.set(tileId, now);
  const watched = turnWatch.get(tileId);
  if (watched) watched.moving = false;
  if (hasPendingPermission(tileId)) return null;
  const context = tileContext(tileId);
  if (!context) return null;
  const notice = noticeId ? useNotifications.getState().items.find((item) => item.id === noticeId) : undefined;
  const summary = turnSummary(notice?.body);
  // Same turn: the output has not moved since that save, apart from the
  // burst printed with the signal.
  const saved = unlabelled.get(tileId);
  const sameTurn = saved !== undefined && watched !== undefined && (watched.movedAt <= saved.at || watched.movedAt >= now - BELL_GRACE_MS);
  const relabel = summary && sameTurn ? saved.id : undefined;
  const result = await captureCheckpoint(context.host, context.folder, {
    kind: "turn", agent: context.agent, session: context.session, summary, ...(relabel ? { relabel } : {}),
  }, AbortSignal.timeout(CAPTURE_TIMEOUT_MS));
  if (result.created && result.id && !summary) unlabelled.set(tileId, { at: now, id: result.id });
  else if (result.created || result.relabelled) unlabelled.delete(tileId);
  return result;
}

/**
 * The baseline the agent's next turn is measured from, when an agent shows up in a tile.
 * `resumed`: the agent was already running when the tile was first seen (the app just started). If it is mid-turn then, and
 * the folder already has checkpoints, no baseline is saved: cutting the turn here would file its changes (often all of them,
 * when the agent itself restarted the app) under the baseline. Its end saves them with the turn, together with anything that
 * changed while the app was closed.
 */
export async function captureAgentStart(tileId: string, agent: string, resumed = false): Promise<CheckpointCapture | null> {
  const context = tileContext(tileId);
  if (!context) return null;
  if (resumed && await agentLooksBusy(tileId) && (await fetchCheckpoints(context.host, context.folder)).checkpoints.length) return null;
  return captureCheckpoint(context.host, context.folder, {
    kind: "start", agent, session: context.session, summary: `Baseline for ${agentLabel(agent)}`,
  }, AbortSignal.timeout(CAPTURE_TIMEOUT_MS));
}

/** A checkpoint the user asked for. */
export function captureManualCheckpoint(tileId: string, host: string, folder: string): Promise<CheckpointCapture> {
  const context = tileContext(tileId);
  return captureCheckpoint(host, folder, {
    kind: "manual", agent: context?.agent ?? "", session: context?.session ?? "", summary: "Checkpoint saved by hand",
  }, AbortSignal.timeout(CAPTURE_TIMEOUT_MS));
}

let watchTimer: ReturnType<typeof setInterval> | undefined;
let watchUsers = 0;
let watching = false;

interface WatchedTile { id: string; session: string; window?: number }

async function watchTurns(): Promise<void> {
  if (watching) return;
  watching = true;
  try {
    const state = useStore.getState();
    const known = new Set(state.tiles.map((tile) => tile.id));
    for (const id of [...turnWatch.keys()]) if (!known.has(id)) turnWatch.delete(id);
    for (const id of [...unlabelled.keys()]) if (!known.has(id)) unlabelled.delete(id);
    const devices = new Map<string, { host: string | undefined; tiles: WatchedTile[] }>();
    for (const tile of state.tiles.filter(isSessionTile)) {
      if (tile.id.startsWith("quick-chat:")) continue;
      const session = tile.session ?? tile.name;
      const host = tile.host ?? state.connection.host ?? (HAS_TAURI ? "" : undefined);
      if (!runningAgent(session, tile.window, host)) { turnWatch.delete(tile.id); continue; }
      const key = host ?? "\u0000default";
      const device = devices.get(key) ?? { host, tiles: [] };
      device.tiles.push({ id: tile.id, session, window: tile.window });
      devices.set(key, device);
    }
    await Promise.all([...devices.values()].map(async ({ host, tiles }) => {
      let rows: PaneOutputActivity[];
      // Shared with the other output-activity pollers; this watch also runs
      // while the window is hidden, since agents keep finishing turns then.
      try { rows = await readPaneOutputActivity(host, { maxAge: OUTPUT_ACTIVITY_SHARE_MS }); } catch { return; /* The next poll retries. */ }
      const now = Date.now();
      for (const tile of tiles) {
        const activity = Math.max(-1, ...rows.filter((row) => row.session === tile.session && (tile.window === undefined || row.window === tile.window)).map((row) => row.activity));
        if (activity < 0) continue;
        const seen = turnWatch.get(tile.id);
        if (!seen) { turnWatch.set(tile.id, { activity, movedAt: now, moving: false }); continue; }
        if (activity !== seen.activity) { turnWatch.set(tile.id, { activity, movedAt: now, moving: true }); continue; }
        if (!seen.moving || now - seen.movedAt < IDLE_MS) continue;
        seen.moving = false;
        if (now - (lastFinished.get(tile.id) ?? 0) < IDLE_MS) continue;
        void captureTurnCheckpoint(tile.id).catch(() => { /* The next turn saves these changes. */ });
      }
    }));
  } finally {
    watching = false;
  }
}

/** Keeps the turn watch over every agent tile running while any tile uses checkpoints. */
export function retainCheckpointWatch(): () => void {
  watchUsers += 1;
  if (watchTimer === undefined) watchTimer = setInterval(() => { void watchTurns(); }, WATCH_MS);
  return () => {
    watchUsers -= 1;
    if (watchUsers === 0 && watchTimer !== undefined) { clearInterval(watchTimer); watchTimer = undefined; }
  };
}

// ---------------------------------------------------------- busy detection

const BUSY_SAMPLE_MS = 2200;

/**
 * Whether the agent in a tile looks mid-turn: it runs and its output moved
 * within a short window (sampled twice, so device clocks never matter).
 */
export async function agentLooksBusy(tileId: string, signal?: AbortSignal): Promise<boolean> {
  const state = useStore.getState();
  const tile = sessionTileById(state.tiles, tileId);
  if (!tile) return false;
  const session = tile.session ?? tile.name;
  const host = tile.host ?? state.connection.host ?? (HAS_TAURI ? "" : undefined);
  if (!runningAgent(session, tile.window, host)) return false;
  const sample = async () => {
    // Each sample asks the device anew: a shared reading could be older than the gap.
    const rows = await readPaneOutputActivity(host, { maxAge: 0, signal });
    return Math.max(-1, ...rows.filter((row) => row.session === session && (tile.window === undefined || row.window === tile.window)).map((row) => row.activity));
  };
  try {
    const first = await sample();
    await new Promise((resolve) => setTimeout(resolve, BUSY_SAMPLE_MS));
    const second = await sample();
    return first >= 0 && second > first;
  } catch {
    return false;
  }
}
