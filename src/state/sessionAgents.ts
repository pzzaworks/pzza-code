import { create } from "zustand";
import { sessionAgent, type SessionAgentChoice } from "../../server/lib/session-agents.js";

// The agent and mode a session was created with, keyed by tile id. This is
// what the user asked for at creation; the running process is still detected
// separately from the terminal's foreground command.
const KEY = "pzza.session.agents.v1";
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

export function rememberSessionAgent(tileId: string, choice: SessionAgentChoice | undefined): void {
  const agents = { ...useSessionAgents.getState().agents };
  if (choice) agents[tileId] = choice;
  else delete agents[tileId];
  const entries = Object.entries(agents);
  const kept = Object.fromEntries(entries.slice(Math.max(0, entries.length - MAX_ENTRIES)));
  useSessionAgents.setState({ agents: kept });
  try {
    localStorage.setItem(KEY, JSON.stringify(kept));
  } catch {
    /* preferences are optional */
  }
}

// "Claude Code · Plan" style label, or null when the session has no recorded agent.
export function sessionAgentLabel(choice: SessionAgentChoice | undefined): { agent: string; mode: string } | null {
  const agent = choice ? sessionAgent(choice.id) : undefined;
  const mode = agent?.modes.find((item) => item.id === choice?.mode);
  return agent && mode ? { agent: agent.label, mode: mode.label } : null;
}
