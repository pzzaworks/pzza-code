import { useCallback, useSyncExternalStore } from "react";
import type { SessionActivity } from "../serverApi";
import { readSessionActivity } from "../terminal/sessionActivityCache";
import { HAS_TAURI } from "../tauriEnv";
import { useStore } from "../state/store";
import { sessionIcon, iconColor, sessionIconTooltip, launcherAgent } from "../sessionMeta";
import { sessionAgent, type SessionAgentId } from "../../server/lib/session-agents.js";

// One activity poll per device, shared by every tile on it. While the window
// is hidden nothing is on screen, so it slows down (app commands and snapshot
// autosave still read these rows) and refreshes as soon as it is shown again.
const POLL_MS = 3000;
const HIDDEN_POLL_MS = 30000;
// A reading this young, taken for another caller, serves a poll as well.
const SHARE_MS = 1000;

interface DeviceActivity {
  rows: SessionActivity[] | null;
  listeners: Set<() => void>;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
  refresh?: () => Promise<void>;
}
const devices = new Map<string | undefined, DeviceActivity>();

if (typeof document !== "undefined") {
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState !== "visible") return;
    // A device with no timer is mid-request; its answer is already on the way.
    for (const device of devices.values()) {
      if (device.timer === undefined || !device.refresh) continue;
      clearTimeout(device.timer);
      device.timer = undefined;
      void device.refresh();
    }
  });
}

function subscribe(host: string | undefined, listener: () => void): () => void {
  let entry = devices.get(host);
  if (!entry) {
    entry = { rows: null, listeners: new Set(), controller: new AbortController() };
    devices.set(host, entry);
  }
  const device = entry;
  device.listeners.add(listener);
  if (device.listeners.size === 1) {
    const refresh = async () => {
      const previous = device.rows;
      try {
        // Reuses a reading another feature (a foreground check) just took.
        const rows = await readSessionActivity(host, { maxAge: SHARE_MS, signal: device.controller.signal });
        if (!device.controller.signal.aborted) device.rows = reuseActivityRows(device.rows, rows);
      } catch {
        if (!device.controller.signal.aborted) device.rows = null;
      }
      if (device.controller.signal.aborted) return;
      if (device.rows !== previous) for (const notify of device.listeners) notify();
      device.timer = setTimeout(() => { device.timer = undefined; void refresh(); }, document.visibilityState === "hidden" ? HIDDEN_POLL_MS : POLL_MS);
    };
    device.refresh = refresh;
    void refresh();
  }
  return () => {
    device.listeners.delete(listener);
    if (!device.listeners.size) {
      device.controller.abort();
      clearTimeout(device.timer);
      devices.delete(host);
    }
  };
}

// A poll that returns equal data keeps the previous array, and each unchanged
// row keeps its object, so subscribers see the same snapshot and skip a render.
export function reuseActivityRows(previous: SessionActivity[] | null, next: SessionActivity[]): SessionActivity[] {
  if (!previous) return next;
  const key = (row: SessionActivity) => `${row.session}\0${row.window}`;
  const byKey = new Map(previous.map((row) => [key(row), row]));
  const sameRow = (left: SessionActivity, right: SessionActivity) => {
    const keys = Object.keys(right) as (keyof SessionActivity)[];
    return Object.keys(left).length === keys.length && keys.every((name) => Object.is(left[name], right[name]));
  };
  let changed = previous.length !== next.length;
  const rows = next.map((row, index) => {
    const earlier = byKey.get(key(row));
    const kept = earlier && sameRow(earlier, row) ? earlier : row;
    if (kept !== previous[index]) changed = true;
    return kept;
  });
  return changed ? rows : previous;
}

// The live activity row for a session (its active window) or one window,
// from the shared per-device poll. Undefined until the device answers. The
// row itself is the snapshot, so a change to another session's row does not
// re-render this one.
export function useSessionActivity(session: string, windowIndex?: number, host?: string): SessionActivity | undefined {
  const connectionHost = useStore((state) => state.connection.host);
  const source = host ?? connectionHost ?? (HAS_TAURI ? "" : undefined);
  return useSyncExternalStore(
    // Keep subscriptions stable across refreshes so one poll serves a device.
    useSubscribe(source),
    () => devices.get(source)?.rows?.find((row) => row.session === session && (windowIndex === undefined ? row.active : row.window === windowIndex)),
  );
}

export type ActivityAgent = SessionAgentId;

// The coding agent an activity row shows in the foreground: the launched
// command when it is a catalog agent, else its detected model provider;
// undefined for shells and other programs.
export function activityAgent(activity: SessionActivity | undefined): ActivityAgent | undefined {
  return activity ? rowAgent(activity) : undefined;
}

/**
 * The coding agent running in a session right now (a catalog agent id), from
 * the activity rows the tiles already poll; undefined when none is known. For
 * callers outside React, such as app commands.
 */
export function runningAgent(session: string, windowIndex?: number, host?: string): SessionAgentId | undefined {
  const source = host ?? useStore.getState().connection.host ?? (HAS_TAURI ? "" : undefined);
  const row = devices.get(source)?.rows?.find((entry) => entry.session === session && (windowIndex === undefined ? entry.active : entry.window === windowIndex));
  return row ? rowAgent(row) : undefined;
}

/** The coding agent one activity row shows in the foreground, if any. */
export function rowAgent(row: Pick<SessionActivity, "command" | "effectiveProvider">): SessionAgentId | undefined {
  return launcherAgent(row.command) ?? sessionAgent(row.effectiveProvider)?.id;
}

/**
 * Whether a session is known to sit at its shell prompt (nothing else in the
 * foreground), from the same activity rows; false when unknown.
 */
export function sessionAtShell(session: string, windowIndex?: number, host?: string): boolean {
  const source = host ?? useStore.getState().connection.host ?? (HAS_TAURI ? "" : undefined);
  const row = devices.get(source)?.rows?.find((entry) => entry.session === session && (windowIndex === undefined ? entry.active : entry.window === windowIndex));
  const command = (row?.command || "").toLowerCase().replace(/^-/, "").split("/").pop() || "";
  return ["zsh", "bash", "fish", "sh", "dash", "ksh", "tcsh", "nu"].includes(command);
}

export function LiveSessionIcon({ session, window: windowIndex, host, size = 14 }: {
  session: string; window?: number; host?: string; size?: number;
}) {
  const current = useSessionActivity(session, windowIndex, host);
  const command = current?.command;
  const effectiveProvider = current?.effectiveProvider;
  const Icon = sessionIcon(command, effectiveProvider);
  const color = iconColor(command, effectiveProvider);
  const tooltip = sessionIconTooltip(command, current?.effectiveModel, effectiveProvider, current?.effectiveModelEvidence);
  return <span title={tooltip} style={{ display: "inline-flex", color }}><Icon size={size} /></span>;
}

function useSubscribe(host: string | undefined) {
  return useCallback((listener: () => void) => subscribe(host, listener), [host]);
}
