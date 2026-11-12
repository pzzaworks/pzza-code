import { fetchSessionActivity, type SessionActivity } from "../serverApi";
import { agentForProgram, sessionAgent } from "../../server/lib/session-agents.js";
import { HAS_TAURI } from "../tauriEnv";
import type { PaneForeground } from "../state/permissionPrompts";

// What runs in the pane a tile's keys reach: the CLI in the foreground of
// the window's active pane (from the device's activity rows, matched against
// the session agent catalog) and how many panes share that window. Reads are
// shared per device for a moment, so many tiles cost one request.
const CACHE_MS = 1500;
const cache = new Map<string, { at: number; rows: Promise<SessionActivity[]> }>();

export async function paneForeground(host: string | undefined, session: string, window: number | undefined, fresh: boolean): Promise<PaneForeground | null> {
  const source = host ?? (HAS_TAURI ? "" : undefined);
  const key = source ?? "";
  let entry = cache.get(key);
  if (fresh || !entry || Date.now() - entry.at > CACHE_MS) {
    const rows = fetchSessionActivity(source, AbortSignal.timeout(5000));
    const created = { at: Date.now(), rows };
    cache.set(key, created);
    rows.catch(() => { if (cache.get(key) === created) cache.delete(key); });
    entry = created;
  }
  const row = (await entry.rows).find(candidate => candidate.session === session && (window === undefined ? candidate.active : candidate.window === window));
  if (!row) return null;
  const launcher = (row.command || "").toLowerCase().split("/").pop() || "";
  return {
    agent: sessionAgent(launcher)?.id ?? agentForProgram(launcher),
    panes: typeof row.panes === "number" && Number.isInteger(row.panes) ? row.panes : undefined,
  };
}
