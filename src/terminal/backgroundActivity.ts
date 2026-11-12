import { deviceNameFor } from "../devices";
import { fetchPaneOutputActivity } from "../serverApi";
import { sessionDisplayName } from "../sessionMeta";
import { notify, useNotifications } from "../state/notifications";
import { useStore } from "../state/store";
import { outputWorking } from "../tasks/taskStatus";
import { paneForeground } from "./permissionForeground";
import { sessionAgent, type SessionAgentId } from "../../server/lib/session-agents.js";

// Live dots for hidden tiles without streaming pty output. The visible-only
// transport (Terminal.tsx) holds credit while a tile is off-screen, so its
// xterm stops parsing - and with it the bell/OSC notifications. This poller
// watches tmux window_activity (a tiny JSON poll, no output bytes) instead.
// A coding agent printing output is just working, so its tile is dotted only
// once the output goes quiet after moving (the idle rule of the checkpoint
// turn watch and the task tracker): it finished its turn or waits for you.
// A shell or other program is dotted the moment it produces output. Viewing
// the tile clears the dot via the existing readTile path, and the resumed
// terminal replays everything in order.

const POLL_MS = 4000;

// Full-screen TUIs redraw constantly; a dot for them is pure noise. Shells,
// REPLs and coding agents get dots.
const NOISY_COMMANDS = new Set([
  "btop", "htop", "top", "atop",
  "yazi", "ranger", "nnn", "lf",
  "lazydocker", "docker",
  "vim", "nvim", "vi", "less", "more",
]);

const shortCommand = (value: string) =>
  value.split("/").pop()?.replace(/^-/, "") ?? "";

// Last activity epoch observed per tile. Updated for visible tiles too, so a
// resume redraw never causes an instant dot when the tile hides again.
const lastSeen = new Map<string, number>();
// Consecutive polls a tile has spent hidden. The first hidden poll only
// baselines (its output was already seen while visible); dots start from the
// second poll, so rapid gidip-gelme never flashes a stale dot.
const hiddenStreak = new Map<string, number>();
// Tiles already dotted for their current hidden burst. One dot until viewed.
const dotted = new Set<string>();
// Hidden tiles whose coding agent is working: the agent and when (this
// machine's clock) its output was last seen moving.
const agentTurns = new Map<string, { agent: SessionAgentId; movedAt: number }>();

function prune(known: Set<string>) {
  for (const id of [...lastSeen.keys()]) if (!known.has(id)) lastSeen.delete(id);
  for (const id of [...hiddenStreak.keys()]) if (!known.has(id)) hiddenStreak.delete(id);
  for (const id of [...dotted]) if (!known.has(id)) dotted.delete(id);
  for (const id of [...agentTurns.keys()]) if (!known.has(id)) agentTurns.delete(id);
}

function hasUnreadBgDot(tileId: string): boolean {
  return useNotifications.getState().items.some(
    (item) => !item.read && item.target?.tileId === tileId &&
      item.dedupeKey?.startsWith(`bg-activity:${tileId}:`),
  );
}

type Tile = ReturnType<typeof useStore.getState>["tiles"][number];

// One dot per hidden burst, and only for a tile that is still hidden.
function dot(tile: Tile, activity: number, title: string, body: string): void {
  if (useStore.getState().tileObserved[tile.id] !== false) return;
  if (dotted.has(tile.id) || hasUnreadBgDot(tile.id)) return;
  const live = useStore.getState();
  const label = sessionDisplayName(tile, live.tileTitles)
    .replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 100);
  const device = deviceNameFor(live.devices, tile.host) || "This device";
  dotted.add(tile.id);
  notify({
    category: "terminal",
    event: "terminal-bell",
    title,
    body,
    target: { tileId: tile.id },
    dedupeKey: `bg-activity:${tile.id}:${activity}`,
    source: `${label || "Terminal"} (${device})`,
  });
}

/** One reading of every hidden tile's output activity; `now` is this machine's clock. */
export async function pollBackgroundActivity(now = Date.now()): Promise<void> {
  if (document.hidden) return;
  const state = useStore.getState();
  const known = new Set(state.tiles.map((t) => t.id));
  prune(known);
  const isHiddenTile = (id: string) => state.tileObserved[id] === false;
  const hidden = state.tiles.filter(
    (t) => !t.id.startsWith("quick-chat:") && isHiddenTile(t.id),
  );
  // Visible tiles leave the streak so a later hide starts with a fresh
  // baseline instead of a stale dot; a turn seen on screen needs no dot.
  for (const tile of state.tiles) {
    if (tile.id.startsWith("quick-chat:") || !isHiddenTile(tile.id)) {
      hiddenStreak.delete(tile.id);
      dotted.delete(tile.id);
      agentTurns.delete(tile.id);
    }
  }
  if (!hidden.length) return;
  const byHost = new Map<string, typeof hidden>();
  for (const tile of hidden) {
    const hostKey = tile.host ?? state.connection.host ?? "";
    const group = byHost.get(hostKey) ?? [];
    group.push(tile);
    byHost.set(hostKey, group);
  }
  await Promise.all([...byHost].map(async ([hostKey, tiles]) => {
    const host = hostKey === "" ? undefined : hostKey;
    let rows;
    try {
      rows = await fetchPaneOutputActivity(host, AbortSignal.timeout(10000));
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    // The first foreground lookup of a poll reads the device afresh; the
    // other tiles there share that reading.
    let freshForeground = true;
    for (const tile of tiles) {
      const session = tile.session ?? tile.name;
      const candidates = rows.filter(
        (row) => row && row.session === session &&
          (tile.window === undefined || row.window === tile.window),
      );
      if (!candidates.length) continue;
      const peak = candidates.reduce((a, b) => (b.activity > a.activity ? b : a));
      if (!Number.isInteger(peak.activity) || peak.activity < 0) continue;
      if (NOISY_COMMANDS.has(shortCommand(peak.command))) {
        lastSeen.set(tile.id, peak.activity);
        continue;
      }
      const previous = lastSeen.get(tile.id);
      // First hidden poll only baselines: everything up to this epoch was
      // already on screen while the tile was visible.
      const streak = (hiddenStreak.get(tile.id) ?? 0) + 1;
      hiddenStreak.set(tile.id, streak);
      const turn = agentTurns.get(tile.id);
      if (streak >= 2 && previous !== undefined && peak.activity > previous) {
        // New output: is a coding agent producing it (the pane's foreground
        // program, from the device's activity rows and the agent catalog)?
        let agent: SessionAgentId | undefined;
        try {
          const pane = await paneForeground(host, session, tile.window, freshForeground);
          freshForeground = false;
          agent = sessionAgent(pane?.agent)?.id;
        } catch {
          // Unknown for now: this output is read again on the next poll.
          continue;
        }
        lastSeen.set(tile.id, peak.activity);
        // An agent that just exited still finishes its turn quietly.
        const working = agent ?? turn?.agent;
        if (working) {
          agentTurns.set(tile.id, { agent: working, movedAt: now });
          continue;
        }
        dot(tile, peak.activity, "Terminal has new activity",
          "New output arrived while this tile was hidden. Open it to catch up.");
        continue;
      }
      lastSeen.set(tile.id, peak.activity);
      if (!turn || outputWorking({ now, outputMovedAt: turn.movedAt })) continue;
      agentTurns.delete(tile.id);
      const label = sessionAgent(turn.agent)?.label ?? "The agent";
      dot(tile, peak.activity, `${label} stopped and may need you`,
        `${label} went quiet after working while this tile was hidden. It finished its turn or is waiting for you.`);
    }
  }));
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startBackgroundActivityPoll(): () => void {
  if (timer !== undefined) return stopBackgroundActivityPoll;
  void pollBackgroundActivity().catch(() => {});
  timer = setInterval(() => {
    void pollBackgroundActivity().catch(() => {});
  }, POLL_MS);
  return stopBackgroundActivityPoll;
}

export function stopBackgroundActivityPoll(): void {
  clearInterval(timer);
  timer = undefined;
}
