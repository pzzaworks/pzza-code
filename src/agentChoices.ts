import { SESSION_AGENTS, agentCanContinue, agentTakesPrompt, type SessionAgentDefinition, type SessionAgentId } from "../server/lib/session-agents.js";

// How the app lists catalog agents to pick from and describes them, shared by
// the new-session form, Quick Chat, Help and setup.

/** Catalog agents, tier 1 first, each tier in catalog order. */
export function agentsByTier(): SessionAgentDefinition[] {
  return [...SESSION_AGENTS].sort((a, b) => a.tier - b.tier);
}

/** Select options for the agents, grouped by tier and searchable by maker and command. */
export function agentSelectOptions(): { value: SessionAgentId; label: string; group: string; keywords: string[] }[] {
  return agentsByTier().map((agent) => ({
    value: agent.id,
    label: agent.label,
    group: agent.tier === 1 ? "Agents" : "More agents",
    keywords: [agent.vendor, agent.command, agent.id],
  }));
}

/** What the continue toggle picks up, from how far the agent looks back. */
export function continueHint(agent: SessionAgentDefinition): string {
  if (agent.resume.scope === "directory") return "Continue the most recent conversation in this folder instead of starting a new one";
  if (agent.resume.scope === "account") return `Continue the most recent ${agent.label} conversation on this account, from any folder`;
  return `Continue the most recent ${agent.label} conversation, which may come from another folder`;
}

/** What the form offers for an agent besides its modes, in a few words. */
export function agentStartNotes(agent: SessionAgentDefinition): string {
  const notes = [
    agentTakesPrompt(agent) ? "Starting prompt" : "No starting prompt",
    !agentCanContinue(agent) ? "No continue" : agent.resume.scope === "directory" ? "Continues in this folder" : "Continues from any folder",
  ];
  if (agent.tier === 2) notes.push("Limited support");
  return notes.join(" · ");
}

export interface FoundAgent {
  id: SessionAgentId;
  path: string | null;
}

/** Catalog agents split into installed and missing, tier 1 first; unknown ids are dropped. */
export function agentInstallState(found: readonly FoundAgent[]): { installed: { agent: SessionAgentDefinition; path: string }[]; missing: SessionAgentDefinition[] } {
  const paths = new Map(found.map((item) => [item.id, item.path]));
  const agents = agentsByTier();
  return {
    installed: agents.flatMap((agent) => { const path = paths.get(agent.id); return path ? [{ agent, path }] : []; }),
    missing: agents.filter((agent) => !paths.get(agent.id)),
  };
}
