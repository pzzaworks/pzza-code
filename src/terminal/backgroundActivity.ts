import { deviceNameFor } from "../devices";
import { fetchPaneOutputActivity } from "../serverApi";
import { sessionDisplayName } from "../sessionMeta";
import { notify, useNotifications } from "../state/notifications";
import { useStore } from "../state/store";

// Live dots for hidden tiles without streaming pty output. The visible-only
// transport (Terminal.tsx) holds credit while a tile is off-screen, so its
// xterm stops parsing - and with it the bell/OSC notifications. This poller
// watches tmux window_activity (a tiny JSON poll, no output bytes) and lights
// the same green dot the moment a hidden shell/agent produces output. Viewing
// the tile clears it via the existing readTile path, and the resumed terminal
// replays everything in order.

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

function prune(known: Set<string>) {
  for (const id of [...lastSeen.keys()]) if (!known.has(id)) lastSeen.delete(id);
  for (const id of [...hiddenStreak.keys()]) if (!known.has(id)) hiddenStreak.delete(id);
  for (const id of [...dotted]) if (!known.has(id)) dotted.delete(id);
}

function hasUnreadBgDot(tileId: string): boolean {
  return useNotifications.getState().items.some(
    (item) => !item.read && item.target?.tileId === tileId &&
      item.dedupeKey?.startsWith(`bg-activity:${tileId}:`),
  );
}

async function pollOnce(): Promise<void> {
  if (document.hidden) return;
  const state = useStore.getState();
  const known = new Set(state.tiles.map((t) => t.id));
  prune(known);
  const isHiddenTile = (id: string) => state.tileObserved[id] === false;
  const hidden = state.tiles.filter(
    (t) => !t.id.startsWith("quick-chat:") && isHiddenTile(t.id),
  );
  // Visible tiles leave the streak so a later hide starts with a fresh
  // baseline instead of a stale dot.
  for (const tile of state.tiles) {
    if (tile.id.startsWith("quick-chat:") || !isHiddenTile(tile.id)) {
      hiddenStreak.delete(tile.id);
      dotted.delete(tile.id);
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
    let rows;
    try {
      rows = await fetchPaneOutputActivity(
        hostKey === "" ? undefined : hostKey,
        AbortSignal.timeout(10000),
      );
    } catch {
      return;
    }
    if (!Array.isArray(rows)) return;
    const live = useStore.getState();
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
      lastSeen.set(tile.id, peak.activity);
      // First hidden poll only baselines: everything up to this epoch was
      // already on screen while the tile was visible.
      const streak = (hiddenStreak.get(tile.id) ?? 0) + 1;
      hiddenStreak.set(tile.id, streak);
      if (streak < 2 || previous === undefined || peak.activity <= previous) continue;
      // The tile may have become visible mid-poll; only dot truly hidden ones.
      if (useStore.getState().tileObserved[tile.id] !== false) continue;
      if (dotted.has(tile.id) || hasUnreadBgDot(tile.id)) continue;
      const label = sessionDisplayName(tile, live.tileTitles)
        .replace(/[\x00-\x1f\x7f-\x9f]/g, "").slice(0, 100);
      const device = deviceNameFor(live.devices, tile.host) || "This device";
      dotted.add(tile.id);
      notify({
        category: "terminal",
        event: "terminal-bell",
        title: "Terminal has new activity",
        body: "New output arrived while this tile was hidden. Open it to catch up.",
        target: { tileId: tile.id },
        dedupeKey: `bg-activity:${tile.id}:${peak.activity}`,
        source: `${label || "Terminal"} (${deviceNameFor(live.devices, tile.host) || device})`,
      });
    }
  }));
}

let timer: ReturnType<typeof setInterval> | undefined;

export function startBackgroundActivityPoll(): () => void {
  if (timer !== undefined) return stopBackgroundActivityPoll;
  void pollOnce().catch(() => {});
  timer = setInterval(() => {
    void pollOnce().catch(() => {});
  }, POLL_MS);
  return stopBackgroundActivityPoll;
}

export function stopBackgroundActivityPoll(): void {
  clearInterval(timer);
  timer = undefined;
}
