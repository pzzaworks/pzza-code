import { create } from "zustand";
import { sessionAgent, type SessionAgentChoice } from "../../server/lib/session-agents.js";
import { useStore } from "./store";

// The agent and mode a session was created with, keyed by tile id. This is
// what the user asked for at creation; the running process is still detected
// separately from the terminal's foreground command.
const KEY = "pzza.session.agents.v1";
// Entries of tiles that are gone are dropped beyond this many (see keptSessionAgents).
const MAX_ENTRIES = 200;

function load(): Record<string, SessionAgentChoice> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, SessionAgentChoice> = {};
    for (const [tileId, choice] of Object.entries(value)) {
      if (!choice || typeof choice !== "object" || !("id" in choice) || !("mode" in choice)) continue;
      const agent = sessionAgent(choice.id);
      if (agent && agent.modes.some((mode) => mode.id === choice.mode)) out[tileId] = { id: agent.id, mode: String(choice.mode) };
    }
    return out;
  } catch {
    return {};
  }
}

export const useSessionAgents = create<{ agents: Record<string, SessionAgentChoice> }>(() => ({ agents: load() }));

/**
 * The entries to keep after a change: every one whose tile is still open
 * (however old: a tile left open for months keeps its agent and mode), the
 * one just written, and the newest of the rest up to `max`. Only entries of
 * tiles that are gone ever make room, however many sessions Tasks create.
 */
export function keptSessionAgents(agents: Record<string, SessionAgentChoice>, open: ReadonlySet<string>, written: string, max = MAX_ENTRIES): Record<string, SessionAgentChoice> {
  const entries = Object.entries(agents);
  if (entries.length <= max) return agents;
  const live = (tileId: string) => open.has(tileId) || tileId === written;
  const room = Math.max(0, max - entries.filter(([tileId]) => live(tileId)).length);
  const closed = entries.filter(([tileId]) => !live(tileId));
  const keptClosed = new Set(closed.slice(closed.length - Math.min(room, closed.length)).map(([tileId]) => tileId));
  return Object.fromEntries(entries.filter(([tileId]) => live(tileId) || keptClosed.has(tileId)));
}

export function rememberSessionAgent(tileId: string, choice: SessionAgentChoice | undefined): void {
  const agents = { ...useSessionAgents.getState().agents };
  if (choice) agents[tileId] = choice;
  else delete agents[tileId];
  const kept = keptSessionAgents(agents, new Set(useStore.getState().tiles.map((tile) => tile.id)), tileId);
  useSessionAgents.setState({ agents: kept });
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* preferences are optional */
  }
}

// The agent last seen running in each local session's active window, by
// session name: what a snapshot records for sessions whose agent was not
// started through the app. Kept in memory; the native side keeps its own copy.
export const useDetectedAgents = create<{ agents: Record<string, string> }>(() => ({ agents: {} }));

export function noteDetectedAgents(agents: Record<string, string>): void {
  const previous = useDetectedAgents.getState().agents;
  const keys = Object.keys(agents);
  if (keys.length === Object.keys(previous).length && keys.every((key) => previous[key] === agents[key])) return;
  useDetectedAgents.setState({ agents });
}

