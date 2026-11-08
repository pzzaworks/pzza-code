import { useEffect, useState } from "react";
import { fetchSessionCost, type SessionCost } from "../serverApi";

// The agent session cost behind a tile, refreshed once a minute while the tile
// is on screen (paused while the window is hidden). A failed refresh keeps the
// last known value; a lookup that finds no transcript clears it.
const POLL_MS = 60000;

export type CostProvider = "claude" | "codex";

export function useSessionCost(provider: CostProvider | undefined, cwd: string | undefined, since: number | null | undefined, enabled: boolean): SessionCost | null {
  const key = enabled && provider && cwd?.startsWith("/") && since ? `${provider}\n${cwd}\n${since}` : null;
  const [state, setState] = useState<{ key: string | null; value: SessionCost | null }>({ key: null, value: null });
  useEffect(() => {
    if (!key) return;
    const [kind, folder, start] = key.split("\n");
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const poll = async () => {
      if (document.visibilityState !== "hidden") {
        try {
          const value = await fetchSessionCost(kind as CostProvider, folder, Number(start), controller.signal);
          if (!controller.signal.aborted) setState({ key, value: value.found ? value : null });
        } catch {
          /* keep the last value; the next poll retries */
        }
      }
      if (!controller.signal.aborted) timer = setTimeout(() => void poll(), POLL_MS);
    };
    void poll();
    const onVisible = () => { if (document.visibilityState === "visible") { clearTimeout(timer); void poll(); } };
    document.addEventListener("visibilitychange", onVisible);
    return () => { controller.abort(); clearTimeout(timer); document.removeEventListener("visibilitychange", onVisible); };
  }, [key]);
  return state.key === key ? state.value : null;
}

export function formatDuration(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
  return `${Math.floor(hours / 24)}d ${hours % 24}h`;
}

export function formatCost(value: number): string {
  return value >= 100 ? `$${Math.round(value)}` : `$${value.toFixed(2)}`;
}

export function formatTokens(value: number): string {
  if (value >= 1e9) return `${(value / 1e9).toFixed(1)}B`;
  if (value >= 1e6) return `${(value / 1e6).toFixed(1)}M`;
  if (value >= 1e3) return `${Math.round(value / 1e3)}k`;
  return String(value);
}
