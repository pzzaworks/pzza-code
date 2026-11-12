import { useCallback, useSyncExternalStore } from "react";
import { fetchPaneOutputActivity } from "../serverApi";
import { OUTPUT_POLL_MS } from "./taskStatus";

// When each task tile's output last moved, from tmux's per-window activity
// time (the same tiny JSON poll the hidden-tile dots use, never pty bytes).
// One poll per device, only while a task watches a tile there, at the
// background-activity cadence, and none while the window is hidden. tmux
// reports device-clock seconds, so only a change between two readings counts
// (the time is then this machine's), as in the checkpoint turn watch.

interface Watch { session: string; window?: number }
interface DeviceState {
  watches: Map<string, { watch: Watch; listeners: Set<() => void> }>;
  epochs: Map<string, number>;
  movedAt: Map<string, number>;
  /** The first reading per tile: not movement, but where idle time starts counting. */
  seenAt: Map<string, number>;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
}
const devices = new Map<string, DeviceState>();
const keyOf = (watch: Watch) => `${watch.session}\u0000${watch.window ?? ""}`;
const hostKey = (host: string | undefined) => host ?? "\u0000default";

async function poll(host: string | undefined): Promise<void> {
  const device = devices.get(hostKey(host));
  if (!device || !device.watches.size) return;
  device.timer = undefined;
  if (typeof document !== "undefined" && document.visibilityState === "hidden") return; // resumed by visibilitychange
  device.controller?.abort();
  const controller = new AbortController();
  device.controller = controller;
  const limit = setTimeout(() => controller.abort(), 10000);
  try {
    const rows = await fetchPaneOutputActivity(host, controller.signal);
    if (controller.signal.aborted || !Array.isArray(rows)) return;
    const now = Date.now();
    for (const [key, entry] of device.watches) {
      const matching = rows.filter((row) => row && row.session === entry.watch.session && (entry.watch.window === undefined || row.window === entry.watch.window));
      if (!matching.length) continue;
      const epoch = Math.max(...matching.map((row) => (Number.isInteger(row.activity) ? row.activity : -1)));
      if (epoch < 0) continue;
      const previous = device.epochs.get(key);
      device.epochs.set(key, epoch);
      if (previous === undefined) {
        device.seenAt.set(key, now);
        for (const listener of entry.listeners) listener();
      } else if (epoch !== previous) {
        device.movedAt.set(key, now);
        for (const listener of entry.listeners) listener();
      }
    }
  } catch {
    // Unreachable for now: keep the last readings, the next poll retries.
  } finally {
    clearTimeout(limit);
    // A timed-out request still schedules the next poll; only an unsubscribe stops it.
    if (devices.get(hostKey(host)) === device && device.watches.size && device.controller === controller) {
      device.controller = undefined;
      device.timer = setTimeout(() => void poll(host), OUTPUT_POLL_MS);
    }
  }
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    for (const [key, device] of devices) {
      if (device.timer !== undefined || !device.watches.size) continue;
      void poll(key === "\u0000default" ? undefined : key);
    }
  });
}

function subscribe(host: string | undefined, watch: Watch, listener: () => void): () => void {
  let device = devices.get(hostKey(host));
  if (!device) {
    device = { watches: new Map(), epochs: new Map(), movedAt: new Map(), seenAt: new Map() };
    devices.set(hostKey(host), device);
  }
  const current = device;
  const key = keyOf(watch);
  const entry = current.watches.get(key) ?? { watch, listeners: new Set<() => void>() };
  entry.listeners.add(listener);
  current.watches.set(key, entry);
  // A device already polling picks the new tile up on its next reading.
  if (current.timer === undefined && !current.controller) void poll(host);
  return () => {
    entry.listeners.delete(listener);
    if (entry.listeners.size) return;
    current.watches.delete(key);
    current.epochs.delete(key);
    current.movedAt.delete(key);
    current.seenAt.delete(key);
    if (current.watches.size) return;
    clearTimeout(current.timer);
    current.controller?.abort();
    devices.delete(hostKey(host));
  };
}

/**
 * When a tile's output was last seen moving (`movedAt`, undefined until it
 * moves) and when it was first read (`seenAt`), while `enabled`. A tile that
 * never moves reads idle IDLE_MS after its first reading.
 */
export function useOutputActivity(host: string | undefined, session: string, window: number | undefined, enabled: boolean): { movedAt: number | undefined; seenAt: number | undefined } {
  const key = keyOf({ session, window });
  const subscribeFn = useCallback(
    (listener: () => void) => (enabled ? subscribe(host, { session, window }, listener) : () => {}),
    [enabled, host, session, window],
  );
  const movedAt = useSyncExternalStore(subscribeFn, () => (enabled ? devices.get(hostKey(host))?.movedAt.get(key) : undefined));
  const seenAt = useSyncExternalStore(subscribeFn, () => (enabled ? devices.get(hostKey(host))?.seenAt.get(key) : undefined));
  return { movedAt, seenAt };
}
