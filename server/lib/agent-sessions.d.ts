// Past coding-agent conversations on a device, as GET /agent-sessions returns
// them. Shared by the device agent, the app and app control.

/** How the app can reopen a conversation: by its id, only as the agent's newest one in its folder, or not at all. */
export type AgentSessionResume = "id" | "last" | "none";

export interface AgentSessionRow {
  /** Agent catalog id (server/lib/session-agents.js). */
  agent: string;
  /** The agent's own conversation id. */
  id: string;
  /** Absolute folder the conversation ran in; empty when unknown. */
  cwd: string;
  /**
   * Where it reopens when `cwd` no longer exists on the device (moved or
   * deleted): the newest folder it worked in that still does, else home.
   * Only for agents that find a conversation id from any folder.
   */
  resumeIn?: string;
  /** One line, at most 160 characters, secrets redacted: the summary or first prompt. */
  title: string;
  /** Epoch milliseconds. */
  startedAt: number;
  /** Epoch milliseconds of the last activity. */
  lastAt: number;
  branch?: string;
  messages?: number;
  bytes?: number;
  /** Absolute folder of a non-default account (for example "/Users/me/.claude-work"). */
  account?: string;
  resume: AgentSessionResume;
}

export interface AgentSessionsQuery {
  agent?: string;
  /** Absolute folder. */
  cwd?: string;
  /** With cwd: include conversations in folders under it. */
  under?: boolean;
  /** Epoch milliseconds: only conversations active since then. */
  since?: number;
  /** Matched against title, folder, branch and id prefix. */
  q?: string;
  /** 1-300, default 150. */
  limit?: number;
  offset?: number;
  /** Rescan instead of serving cached results. */
  fresh?: boolean;
}

export interface AgentSessionsResponse {
  /** Newest first, after every filter, paged by limit/offset. */
  sessions: AgentSessionRow[];
  /** Matches before paging. */
  total: number;
  /** Matches per agent with every filter except agent applied, for facet counts. */
  agents: Record<string, number>;
  /** True while a cold scan is still running; ask again shortly for the rest. */
  partial: boolean;
}

export function listAgentSessions(query: AgentSessionsQuery): Promise<AgentSessionsResponse>;
