import { useCallback, useSyncExternalStore } from "react";
import { fetchGitStatus, type GitFolderStatus } from "../serverApi";

// One batched Git status poll per device. Folders of visible tiles refresh
// every 10s; folders only needed in the background (hidden tiles running an
// agent, in any workspace) refresh once a minute, riding along in the same
// batched request. Paused while the window is hidden, refreshed as soon as it
// is shown again. A new folder is fetched right away (batched with any others
// mounting in the same moment).
const POLL_MS = 10000;
const BACKGROUND_MS = 60000;
const BATCH_MS = 60;
const MAX_PATHS = 64;

/** How often a folder's status is needed: a visible tile, a background claim, or not at all. */
export type GitStatusRate = "visible" | "background" | "off";

interface PathUse { visible: number; background: number; fetchedAt: number }
interface Device {
  paths: Map<string, PathUse>; // folder -> tiles using it, by rate
  results: Map<string, GitFolderStatus | null>;
  listeners: Set<() => void>;
  timer?: ReturnType<typeof setTimeout>;
  controller?: AbortController;
}
const devices = new Map<string, Device>();

const same = (a: GitFolderStatus | null | undefined, b: GitFolderStatus | null) =>
  a === b || (!!a && !!b && a.branch === b.branch && a.detached === b.detached && a.dirty === b.dirty && a.ahead === b.ahead && a.behind === b.behind);

// Milliseconds until a folder is due again (0 = due now).
const dueIn = (use: PathUse, now: number) => Math.max(0, use.fetchedAt + (use.visible ? POLL_MS : BACKGROUND_MS) - now);

function schedule(host: string, delay: number) {
  const device = devices.get(host);
  if (!device) return;
  clearTimeout(device.timer);
  device.timer = setTimeout(() => void poll(host), delay);
}

function scheduleNext(host: string, device: Device) {
  const now = Date.now();
  let next = BACKGROUND_MS;
  for (const use of device.paths.values()) next = Math.min(next, dueIn(use, now));
  schedule(host, Math.max(next, BATCH_MS));
}

async function poll(host: string) {
  const device = devices.get(host);
  if (!device || !device.paths.size) return;
  if (document.visibilityState === "hidden") return; // resumed by visibilitychange
  device.controller?.abort();
  const controller = new AbortController();
  device.controller = controller;
  const now = Date.now();
  // Once a request goes out, background folders due before the next visible
  // poll ride along instead of waking the device again. Visible folders come
  // first, so the cap never drops one for a background folder.
  const entries = [...device.paths];
  const sending = entries.some(([, use]) => dueIn(use, now) <= BATCH_MS);
  const paths = entries
    .filter(([, use]) => sending && dueIn(use, now) <= (use.visible ? BATCH_MS : POLL_MS))
    .sort(([, a], [, b]) => Number(b.visible > 0) - Number(a.visible > 0))
    .slice(0, MAX_PATHS)
    .map(([path]) => path);
  for (const path of paths) {
    const use = device.paths.get(path);
    if (use) use.fetchedAt = now;
  }
  if (paths.length) {
    try {
      const results = await fetchGitStatus(host, paths, controller.signal);
      if (controller.signal.aborted) return;
      let changed = false;
      for (const path of paths) {
        if (!device.paths.has(path)) continue;
        const next = results[path] ?? null;
        if (!same(device.results.get(path), next) || !device.results.has(path)) { device.results.set(path, next); changed = true; }
      }
      if (changed) for (const notify of device.listeners) notify();
    } catch {
      // Keep the last known state; the next poll retries.
    }
  }
  if (!controller.signal.aborted && devices.get(host) === device) scheduleNext(host, device);
}

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") for (const host of devices.keys()) schedule(host, 0);
  });
}

function subscribe(host: string, path: string, rate: "visible" | "background", listener: () => void): () => void {
  let device = devices.get(host);
  if (!device) {
    device = { paths: new Map(), results: new Map(), listeners: new Set() };
    devices.set(host, device);
  }
  const current = device;
  current.listeners.add(listener);
  const use = current.paths.get(path) ?? { visible: 0, background: 0, fetchedAt: 0 };
  // A folder that just became visible may hold a minute-old result: refresh it.
  const refresh = !current.paths.has(path) || (rate === "visible" && !use.visible);
  use[rate] += 1;
  current.paths.set(path, use);
  if (refresh) {
    use.fetchedAt = 0;
    schedule(host, BATCH_MS);
  }
  return () => {
    current.listeners.delete(listener);
    use[rate] = Math.max(0, use[rate] - 1);
    if (!use.visible && !use.background && current.paths.get(path) === use) { current.paths.delete(path); current.results.delete(path); }
    if (!current.paths.size) {
      clearTimeout(current.timer);
      current.controller?.abort();
      devices.delete(host);
    }
  };
}

// Branch/dirty state of `path` on `host` ("" = the agent's own device), or
// undefined until known (always undefined while the rate is "off").
export function useGitStatus(host: string, path: string | undefined, rate: GitStatusRate): GitFolderStatus | null | undefined {
  const active = rate !== "off" && !!path;
  const subscribeFn = useCallback(
    (listener: () => void) => (rate !== "off" && path ? subscribe(host, path, rate, listener) : () => {}),
    [rate, host, path],
  );
  return useSyncExternalStore(subscribeFn, () => (active && path ? devices.get(host)?.results.get(path) : undefined));
}
