import { captureTurnCheckpoint } from "../checkpoints";
import { deviceNameFor } from "../devices";
import { fetchGitChanges, fetchSessionActivity } from "../serverApi";
import { sessionDisplayName } from "../sessionMeta";
import { noticeAllowed, notify, useNotifications, type NoticeAction } from "../state/notifications";
import { useSessionAgents } from "../state/sessionAgents";
import { sessionTileById, useStore } from "../state/store";
import { hasPendingPermission } from "../state/permissionPrompts";
import { HAS_TAURI } from "../tauriEnv";
import { changeSummary, filesChangedLabel, tileGitTarget } from "../tileGit";
import { rowAgent } from "../ui/LiveSessionIcon";

// A coding agent that stops working and waits for the user rings its
// terminal (a bell, or an OSC 9/777 notification); that signal is what marks
// a tile as waiting (Cmd+J jumps to it). When the agent's folder then has
// uncommitted changes, its notice says how many files changed and offers to
// review them. Signals in quick succession (a bell followed by a
// notification) settle into one announcement for the transition.
export const AGENT_FINISHED_SETTLE_MS = 1500;
const LOOKUP_TIMEOUT_MS = 10000;

const pending = new Map<string, { timer: ReturnType<typeof setTimeout>; noticeId?: string }>();
const settledListeners = new Set<(tileId: string) => void>();

/** Calls `listener` with the tile each time an attention signal settles (tasks read it as "the agent waits"). */
export function onAgentSignalSettled(listener: (tileId: string) => void): () => void {
  settledListeners.add(listener);
  return () => { settledListeners.delete(listener); };
}

/** Reports a terminal attention signal of a tile, and the notice it produced if any. */
export function agentSignalled(tileId: string, noticeId: string | undefined): void {
  const previous = pending.get(tileId);
  if (previous) clearTimeout(previous.timer);
  const latest = noticeId ?? previous?.noticeId;
  pending.set(tileId, {
    noticeId: latest,
    timer: setTimeout(() => {
      pending.delete(tileId);
      for (const listener of settledListeners) listener(tileId);
      // A bell for an approval prompt is the agent pausing mid-turn, not finishing one.
      if (!hasPendingPermission(tileId)) void captureTurnCheckpoint(tileId, latest).catch(() => { /* The next turn or a manual checkpoint saves it. */ });
      void announce(tileId, latest).catch(() => { /* A lookup that fails leaves the plain notice. */ });
    }, AGENT_FINISHED_SETTLE_MS),
  });
}

// Whether a coding agent is in the foreground of the tile right now. Without
// an activity row for it, the agent the session was created with counts.
async function agentInTile(tileId: string): Promise<boolean> {
  const state = useStore.getState();
  const tile = sessionTileById(state.tiles, tileId);
  if (!tile) return false;
  try {
    const rows = await fetchSessionActivity(tile.host ?? state.connection.host ?? (HAS_TAURI ? "" : undefined), AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
    const session = tile.session ?? tile.name;
    const row = rows.find((entry) => entry.session === session && (tile.window === undefined ? entry.active : entry.window === tile.window));
    if (row) return rowAgent(row) !== undefined;
  } catch { /* Fall back to the recorded agent below. */ }
  return Boolean(useSessionAgents.getState().agents[tileId]);
}

async function announce(tileId: string, noticeId: string | undefined): Promise<void> {
  // An agent waiting on an approval prompt has not finished.
  if (!noticeAllowed("terminal", "agent-finished") || hasPendingPermission(tileId)) return;
  const target = tileGitTarget(tileId);
  if (!target || !(await agentInTile(tileId))) return;
  const changes = await fetchGitChanges(target.host, target.folder, AbortSignal.timeout(LOOKUP_TIMEOUT_MS));
  if (!changes.files.length || !noticeAllowed("terminal", "agent-finished") || hasPendingPermission(tileId)) return;
  const state = useStore.getState();
  const tile = sessionTileById(state.tiles, tileId);
  if (!tile) return;
  const label = sessionDisplayName(tile, state.tileTitles).replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 100) || "Agent";
  const title = `${label} finished · ${filesChangedLabel(changeSummary(changes))}`;
  const action: NoticeAction = { kind: "review-changes", folder: target.folder };
  // The notice this signal produced, else one still unread from an earlier
  // signal of the same wait: it gains the count instead of a second notice.
  const items = useNotifications.getState().items;
  const existing = (noticeId ? items.find((item) => item.id === noticeId && !item.read) : undefined)
    ?? items.find((item) => !item.read && item.target?.tileId === tileId && item.action?.kind === "review-changes");
  if (existing) {
    useNotifications.getState().update(existing.id, { title, action });
    return;
  }
  notify({
    category: "terminal", event: "agent-finished", title, action,
    body: "The agent stopped and its folder has uncommitted changes. Review them before you commit.",
    target: { tileId }, dedupeKey: `agent-finished:${tileId}`,
    source: `${label} (${deviceNameFor(state.devices, tile.host) || "This device"})`,
  });
}
