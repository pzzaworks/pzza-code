import { useCallback, useSyncExternalStore } from "react";
import { fetchSessionActivity, type SessionActivity } from "../serverApi";
import { HAS_TAURI } from "../tauriEnv";
import { useStore } from "../state/store";
import { sessionIcon, iconColor, sessionIconTooltip } from "../sessionMeta";

interface DeviceActivity {
  rows: SessionActivity[] | null;
  listeners: Set<() => void>;
  controller: AbortController;
  timer?: ReturnType<typeof setTimeout>;
}
const devices = new Map<string | undefined, DeviceActivity>();

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
      try {
        const rows = await fetchSessionActivity(host, device.controller.signal);
        if (!device.controller.signal.aborted) device.rows = rows;
      } catch {
        if (!device.controller.signal.aborted) device.rows = null;
      }
      if (device.controller.signal.aborted) return;
      for (const notify of device.listeners) notify();
      device.timer = setTimeout(refresh, 3000);
    };
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

// The live activity row for a session (its active window) or one window,
// from the shared per-device poll. Undefined until the device answers.
export function useSessionActivity(session: string, windowIndex?: number, host?: string): SessionActivity | undefined {
  const connectionHost = useStore((state) => state.connection.host);
  const source = host ?? connectionHost ?? (HAS_TAURI ? "" : undefined);
  const rows = useSyncExternalStore(
    // Keep subscriptions stable across refreshes so one poll serves a device.
    useSubscribe(source),
    () => devices.get(source)?.rows ?? null,
  );
  return rows?.find((row) => row.session === session && (windowIndex === undefined ? row.active : row.window === windowIndex));
}

export type ActivityAgent = "claude" | "codex" | "opencode";

// The coding agent an activity row shows in the foreground, from its detected
// provider or else the launched command; undefined for shells and other programs.
export function activityAgent(activity: SessionActivity | undefined): ActivityAgent | undefined {
  const provider = activity?.effectiveProvider ?? activity?.command?.toLowerCase().split("/").pop();
  return provider === "claude" || provider === "codex" || provider === "opencode" ? provider : undefined;
}

/**
 * The coding agent running in a session right now ("claude", "codex",
 * "opencode"), from the activity rows the tiles already poll; undefined when
 * none is known. For callers outside React, such as app commands.
 */
export function runningAgent(session: string, windowIndex?: number, host?: string): string | undefined {
  const source = host ?? useStore.getState().connection.host ?? (HAS_TAURI ? "" : undefined);
  const row = devices.get(source)?.rows?.find((entry) => entry.session === session && (windowIndex === undefined ? entry.active : entry.window === windowIndex));
  return row ? rowAgent(row) : undefined;
}

/** The coding agent one activity row shows in the foreground, if any. */
export function rowAgent(row: Pick<SessionActivity, "command" | "effectiveProvider">): string | undefined {
  const launcher = (row.command || "").toLowerCase().split("/").pop() || "";
  if (launcher === "opencode") return launcher;
  const value = row.effectiveProvider || launcher;
  return value === "claude" || value === "codex" ? value : undefined;
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
