import { invoke } from "@tauri-apps/api/core";
import { create } from "zustand";
import { useStore } from "./store";
import { notify } from "./notifications";
import { noteDetectedAgents, useSessionAgents } from "./sessionAgents";
import { PERMISSIONS, PERMISSIONS_SUPPORTED, permissionStatuses, type PermissionId, type PermissionStatus } from "./permissions";
import { autoSavedLocalAgents } from "./workspaceSnapshots";
import { sessionConnection } from "../connection";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, wsKeyOf } from "../workspaces";
import { fetchSessionActivity, type SessionActivity } from "../serverApi";
import { rowAgent } from "../ui/LiveSessionIcon";
import { sessionAgentResumeCommand, type SessionAgentChoice } from "../../server/lib/session-agents.js";

// Refreshing local sessions: the local tmux server keeps the privacy grants
// it started with, so a new grant reaches terminals only after it restarts.
// The native side saves every local session, restarts the server and puts
// them back under the same names; local tiles detach meanwhile and attach
// again afterwards. Remote devices are never touched.
//
// Restoring local sessions: while the app runs, the native side keeps a copy
// of the local sessions (windows, folders) and the agents seen in them. When
// the server was replaced (at launch, or while running) and sessions are
// missing, the same restore brings them back and continues their agents' chats.

export interface SessionRefreshNotice {
  tone: "ok" | "fail";
  message: string;
  /** Sessions that could not be restored, or whose agent could not be resumed, by name. */
  failed: string[];
}

interface SessionRefreshState {
  running: boolean;
  /** The running work restores lost sessions rather than refreshing them. */
  restoring: boolean;
  /** Until the launch check has looked for lost sessions, local tiles wait to attach. */
  pending: boolean;
  /** Bumped after each refresh so local terminals attach again. */
  generation: number;
  notice: SessionRefreshNotice | null;
}

// The local terminal server and its saved state exist in the macOS app only.
const LOCAL_SESSIONS_KEPT = PERMISSIONS_SUPPORTED;
// How often the saved local sessions are brought up to date.
const RECORD_MS = 10_000;

export const useSessionRefresh = create<SessionRefreshState>(() => ({ running: false, restoring: false, pending: false, generation: 0, notice: null }));

export interface AgentResume {
  session: string;
  /** Omitted: the session's active window. */
  window?: number;
  command: string;
  /** Only recorded, not detected: resume only if that pane runs a program that can be this agent. */
  onlyIfBusy: boolean;
}

interface RefreshReport {
  restored: string[];
  resumed: string[];
  failed: { session: string; error: string }[];
  /** Restored sessions whose agent stayed at its shell: another pane in the same folder continues that agent's last conversation. */
  skipped: { session: string; error: string }[];
}

export interface LocalTile {
  session: string;
  window?: number;
  choice?: SessionAgentChoice;
}

type ActivityRow = Pick<SessionActivity, "session" | "window" | "active" | "command" | "effectiveProvider">;

/**
 * Which agents to start again after the restart, from the catalog. Detected
 * agents (activity rows) resume, in the mode their tile recorded when it is
 * the same agent. Without activity (null), agents recorded for tiles resume
 * only where their program is running. Agents whose "continue" could pick up
 * a conversation from another folder (or that cannot continue at all) are
 * left at the shell.
 */
export function agentsToResume(rows: readonly ActivityRow[] | null, tiles: readonly LocalTile[]): AgentResume[] {
  if (!rows) {
    return tiles.flatMap(tile => {
      const command = tile.choice ? sessionAgentResumeCommand(tile.choice.id, tile.choice) : null;
      return command ? [{ session: tile.session, ...(tile.window !== undefined ? { window: tile.window } : {}), command, onlyIfBusy: true }] : [];
    });
  }
  return rows.flatMap(row => {
    const agent = rowAgent(row);
    if (!agent) return [];
    const tile = tiles.find(item => item.session === row.session && (item.window === undefined ? row.active : item.window === row.window));
    const command = sessionAgentResumeCommand(agent, tile?.choice);
    return command ? [{ session: row.session, window: row.window, command, onlyIfBusy: false }] : [];
  });
}

/**
 * The agents auto-saved snapshots recorded for local sessions the list does
 * not cover yet: resumed only where their program still runs, for agents
 * activity detection missed.
 */
export function snapshotAgents(covered: readonly AgentResume[], saved: ReadonlyMap<string, SessionAgentChoice>): AgentResume[] {
  const sessions = new Set(covered.map(agent => agent.session));
  return [...saved].flatMap(([session, choice]) => {
    const command = sessions.has(session) ? null : sessionAgentResumeCommand(choice.id, choice);
    return command ? [{ session, command, onlyIfBusy: true }] : [];
  });
}

type CanvasState = Pick<ReturnType<typeof useStore.getState>, "tiles" | "connection" | "hiddenTiles" | "activeWorkspaceId" | "sessionWs">;

/**
 * Whether a local tile is on the canvas: in the active workspace and not
 * hidden. Such a tile shows its own refresh state, so the shared notice only
 * needs to say so when none is in view.
 */
export function localTileOnCanvas(state: CanvasState): boolean {
  return state.tiles.some(tile => !sessionConnection(tile.host, state.connection).host && !state.hiddenTiles.includes(tile.id) &&
    (state.activeWorkspaceId === ALL_WORKSPACE_ID || (state.sessionWs[wsKeyOf(tile)] ?? DEFAULT_WORKSPACE_ID) === state.activeWorkspaceId));
}

function localTiles(): LocalTile[] {
  const state = useStore.getState();
  const choices = useSessionAgents.getState().agents;
  return state.tiles
    .filter(tile => !sessionConnection(tile.host, state.connection).host)
    .map(tile => ({ session: tile.session ?? tile.name, window: tile.window, choice: choices[tile.id] }));
}

// The new terminal server hands out window ids afresh, so local window tiles
// tie their ids to the restored sessions again.
function retieLocalWindowIds(): void {
  void useStore.getState().recordWindowIds("").catch(() => {});
}

const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/**
 * The notice for a refresh or restore: `ok` when everything came back,
 * otherwise each session that was not restored, and each restored one whose
 * agent was not resumed, by name. Sessions whose agent was left at its shell
 * on purpose (another pane in the same folder continues that conversation)
 * are named too, without making it a failure.
 */
export function reportNotice(report: RefreshReport, ok: string, lead = ""): SessionRefreshNotice {
  const restored = new Set(report.restored);
  const sessions = [...new Set(report.failed.filter(item => !restored.has(item.session)).map(item => item.session))];
  const agents = [...new Set(report.failed.filter(item => restored.has(item.session)).map(item => item.session))];
  const atShell = [...new Set(report.skipped.map(item => item.session))].filter(session => !sessions.includes(session) && !agents.includes(session));
  const skipped = atShell.length ? `Agents left at the shell in ${atShell.join(", ")}: another session in the same folder continues that conversation.` : "";
  if (!sessions.length && !agents.length) return { tone: "ok", message: [ok, skipped].filter(Boolean).join(" "), failed: [] };
  const parts = [
    lead,
    sessions.length ? `Some sessions could not be restored: ${sessions.join(", ")}.` : "",
    agents.length ? `Agents could not be resumed in: ${agents.join(", ")}.` : "",
    skipped,
  ];
  return { tone: "fail", message: parts.filter(Boolean).join(" "), failed: [...sessions, ...agents] };
}

function refreshOk(report: RefreshReport): string {
  return report.restored.length ? "Sessions refreshed." : "Terminal server restarted. There were no sessions to restore.";
}

/** "Restored 3 sessions and resumed 2 agents." */
export function restoredMessage(report: RefreshReport): string {
  return `Restored ${plural(report.restored.length, "session")}${report.resumed.length ? ` and resumed ${plural(report.resumed.length, "agent")}` : ""}.`;
}

function failureReason(error: unknown): string {
  return error instanceof Error ? error.message : typeof error === "string" ? error : "";
}

/**
 * Saves, restarts and restores the local sessions. Throws only when a
 * refresh is already running; any other outcome is reported in the notice.
 */
export async function refreshLocalSessions(): Promise<void> {
  if (useSessionRefresh.getState().running) throw new Error("Sessions are already refreshing.");
  useSessionRefresh.setState({ running: true, restoring: false, notice: null });
  try {
    const tiles = localTiles();
    const rows = await fetchSessionActivity("").catch(() => null);
    const detected = agentsToResume(rows, tiles);
    const agents = [...detected, ...snapshotAgents(detected, autoSavedLocalAgents())];
    const report = await invoke<RefreshReport>("local_tmux_refresh_sessions", { agents });
    useSessionRefresh.setState({ notice: reportNotice(report, refreshOk(report)) });
  } catch (error) {
    useSessionRefresh.setState({ notice: { tone: "fail", message: `Sessions could not be refreshed. ${failureReason(error)}`.trim(), failed: [] } });
  } finally {
    useSessionRefresh.setState(state => ({ running: false, generation: state.generation + 1 }));
    retieLocalWindowIds();
  }
}

/**
 * Brings back local sessions a replaced terminal server lost, with their
 * agents continuing their chats, and says so briefly. Sessions still running
 * are left alone; nothing happens while a refresh or restore runs.
 */
export async function restoreLostSessions(options: { quiet?: boolean } = {}): Promise<void> {
  if (useSessionRefresh.getState().running) return;
  useSessionRefresh.setState({ running: true, restoring: true });
  let changed = false;
  try {
    const agents = snapshotAgents([], autoSavedLocalAgents());
    const report = await invoke<RefreshReport>("local_tmux_restore_sessions", { agents });
    changed = report.restored.length > 0 || report.failed.length > 0;
    if (changed) {
      const message = restoredMessage(report);
      useSessionRefresh.setState({ notice: reportNotice(report, message, report.restored.length ? message : "") });
    }
  } catch (error) {
    // At launch a missing terminal server only means there is nothing to restore.
    if (!options.quiet) {
      useSessionRefresh.setState({ notice: { tone: "fail", message: `Sessions could not be restored. ${failureReason(error)}`.trim(), failed: [] } });
      changed = true;
    }
  } finally {
    // Tiles attach again only when sessions changed under them.
    useSessionRefresh.setState(state => ({ running: false, restoring: false, generation: state.generation + (changed ? 1 : 0) }));
    if (changed) retieLocalWindowIds();
  }
}

// The agents detected in local sessions now, for the native record and for
// snapshots; null when activity is unavailable.
async function detectLocalAgents(): Promise<AgentResume[] | null> {
  const rows = await fetchSessionActivity("").catch(() => null);
  if (!rows) return null;
  noteDetectedAgents(Object.fromEntries(rows.flatMap(row => {
    const agent = row.active ? rowAgent(row) : undefined;
    return agent ? [[row.session, agent]] : [];
  })));
  return agentsToResume(rows, localTiles());
}

/**
 * Keeps local sessions safe across terminal server restarts: right away it
 * restores sessions lost while the app was closed (tiles wait for this
 * check), then keeps the native record of sessions and agents current and
 * restores whenever the server was replaced. Start it before the first
 * render, so no tile attaches before the check. Returns a stop.
 */
export function startLocalSessionGuard(intervalMs = RECORD_MS): () => void {
  if (!LOCAL_SESSIONS_KEPT) return () => {};
  useSessionRefresh.setState({ pending: true });
  let stopped = false;
  let timer: number | undefined;
  const tick = async () => {
    try {
      if (!useSessionRefresh.getState().running) {
        const agents = await detectLocalAgents();
        const status = stopped ? null : await invoke<{ restarted: boolean }>("local_tmux_record_sessions", { agents });
        if (status?.restarted && !stopped) await restoreLostSessions();
      }
    } catch {
      /* No local terminal server right now: try again on the next round. */
    } finally {
      if (!stopped) timer = window.setTimeout(() => void tick(), intervalMs);
    }
  };
  // The launch check: silent when nothing was lost, so tiles attach as usual.
  void restoreLostSessions({ quiet: true }).finally(() => {
    useSessionRefresh.setState({ pending: false });
    if (!stopped) void tick();
  });
  return () => {
    stopped = true;
    window.clearTimeout(timer);
  };
}

export function dismissSessionRefreshNotice(): void {
  useSessionRefresh.setState({ notice: null });
}

// The last statuses seen, kept across launches: a grant macOS applies only
// after a relaunch shows up as a change on the next start.
const LAST_KNOWN_KEY = "pzza.permissions.lastKnown.v1";
type Statuses = Partial<Record<PermissionId, PermissionStatus>>;
let lastKnown: Statuses | null = null;

function loadLastKnown(): Statuses {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(LAST_KNOWN_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const statuses: Statuses = {};
    for (const { id } of PERMISSIONS) {
      const status = (value as Record<string, unknown>)[id];
      if (status === "granted" || status === "notGranted" || status === "denied" || status === "unknown") statuses[id] = status;
    }
    return statuses;
  } catch {
    return {};
  }
}

async function localSessionsExist(): Promise<boolean> {
  const sessions = await invoke<{ name: string }[]>("tmux_list_sessions", { host: null });
  return sessions.some(session => !session.name.startsWith("pzza-v-") && session.name !== "pzza-quick-chat");
}

/**
 * Feeds every permission status read. When a permission terminals need goes
 * from not allowed to allowed while local sessions exist, a notification says
 * that running sessions get it after Refresh sessions. The sessions are never
 * restarted on their own: a restart stops every program running in them, and
 * a status read can change for reasons that are not a new grant (an update,
 * another copy of the app, a reinstalled tmux).
 */
export function observePermissionStatuses(next: Statuses): void {
  const previous = lastKnown ?? loadLastKnown();
  lastKnown = { ...previous, ...next };
  try {
    localStorage.setItem(LAST_KNOWN_KEY, JSON.stringify(lastKnown));
  } catch {
    /* Without storage, changes are still seen while the app stays open. */
  }
  const granted = PERMISSIONS.filter(item => item.refreshSessions && next[item.id] === "granted" &&
    (previous[item.id] === "notGranted" || previous[item.id] === "denied"));
  if (!granted.length) return;
  void localSessionsExist()
    .then(exist => {
      if (!exist) return;
      const names = [...new Set(granted.map(item => item.subject === "tmux" ? `${item.label} for tmux` : item.label))].join(", ");
      notify({
        category: "app",
        title: "New permission ready for new sessions",
        body: `${names} ${granted.length > 1 ? "are" : "is"} allowed. New terminals have it now. Running sessions get it after Refresh sessions in Settings > Setup, which restarts the programs running in them.`,
        dedupeKey: `permission-granted:${granted.map(item => item.id).join(",")}`,
      });
    })
    .catch(() => { /* No local terminal server: nothing is running without it. */ });
}

/** One status read shortly after launch, for grants made while the app was closed or that needed a relaunch. */
export function checkPermissionsAtLaunch(delayMs = 3000): () => void {
  if (!PERMISSIONS_SUPPORTED) return () => {};
  const timer = window.setTimeout(() => {
    void permissionStatuses().then(observePermissionStatuses, () => { /* Read again when Setup opens. */ });
  }, delayMs);
  return () => window.clearTimeout(timer);
}
