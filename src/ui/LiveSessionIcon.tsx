import { useCallback, useSyncExternalStore } from "react";
import { fetchSessionActivity, type SessionActivity } from "../serverApi";
import { HAS_TAURI } from "../tauriEnv";
import { useStore } from "../state/store";
import { sessionIcon, iconColor } from "../sessionMeta";

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

export function LiveSessionIcon({ session, window: windowIndex, host, size = 14 }: {
  session: string; window?: number; host?: string; size?: number;
}) {
  const connectionHost = useStore((state) => state.connection.host);
  const source = host ?? connectionHost ?? (HAS_TAURI ? "" : undefined);
  const rows = useSyncExternalStore(
    // Keep subscriptions stable across refreshes so one poll serves a device.
    useSubscribe(source),
    () => devices.get(source)?.rows ?? null,
  );
  const current = rows?.find((row) => row.session === session && (windowIndex === undefined ? row.active : row.window === windowIndex));
  const command = current?.command;
  const Icon = sessionIcon(command);
  const color = iconColor(command);
  return <span title={command ? `Running: ${command}` : "Running process unavailable"} style={{ display: "inline-flex", color }}><Icon size={size} /></span>;
}

function useSubscribe(host: string | undefined) {
  return useCallback((listener: () => void) => subscribe(host, listener), [host]);
}
