import { registerAppControlHandler } from "./appControlRuntime";
import { fetchAgentSessions } from "./serverApi";
import { useStore } from "./state/store";
import { deviceForHost } from "./devices";
import {
  agentLabelOf, agentSessionsHost, isAgentSessionsTile, resumeInNewTile, resumeInTile, useAgentSessionsUi,
} from "./state/agentSessions";
import { AGENT_SESSIONS_LIST_MAX } from "../server/lib/app-control-agent-sessions-schema.js";
import { sessionAgent } from "../server/lib/session-agents.js";
import type { AgentSessionRow, AgentSessionsResponse } from "../server/lib/agent-sessions.js";

// App commands for past coding-agent conversations, through the same checks
// as the Agent sessions dialog. Listing returns metadata only; resuming in an
// open tile was confirmed in the app before the handler runs
// (confirmAppControlAction).

// A cold scan answers with partial results first; a caller waits this long for the rest.
const PARTIAL_WAIT_MS = 8000;
const PARTIAL_RETRY_MS = 1500;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function listSettled(host: string, query: Parameters<typeof fetchAgentSessions>[1]): Promise<AgentSessionsResponse> {
  const until = Date.now() + PARTIAL_WAIT_MS;
  let result = await fetchAgentSessions(host, query);
  while (result.partial && Date.now() < until) {
    await sleep(PARTIAL_RETRY_MS);
    result = await fetchAgentSessions(host, query);
  }
  return result;
}

const describe = (row: AgentSessionRow) => ({
  agent: row.agent,
  agentLabel: agentLabelOf(row.agent),
  sessionId: row.id,
  cwd: row.cwd || null,
  title: row.title,
  startedAt: new Date(row.startedAt).toISOString(),
  lastAt: new Date(row.lastAt).toISOString(),
  branch: row.branch ?? null,
  messages: row.messages ?? null,
  bytes: row.bytes ?? null,
  account: row.account ?? null,
  resume: row.resume,
});

export function initAgentSessionsAppControlHandlers(): () => void {
  const handlers: Record<string, (args: Readonly<Record<string, unknown>>) => unknown> = {
    open_agent_sessions: (args) => {
      const tileId = typeof args.tileId === "string" ? args.tileId : null;
      if (tileId !== null && !isAgentSessionsTile(tileId)) throw new Error("The requested session tile is not open.");
      useAgentSessionsUi.getState().show(tileId);
      return { open: true, tileId };
    },
    list_agent_sessions: async (args) => {
      const host = agentSessionsHost(typeof args.deviceId === "string" ? args.deviceId : undefined);
      const days = typeof args.sinceDays === "number" ? args.sinceDays : undefined;
      const result = await listSettled(host, {
        agent: typeof args.agent === "string" ? args.agent : undefined,
        cwd: typeof args.cwd === "string" ? args.cwd : undefined,
        under: args.under === true,
        q: typeof args.query === "string" ? args.query.trim() : undefined,
        since: days ? Date.now() - days * 86400000 : undefined,
        limit: typeof args.limit === "number" ? Math.min(args.limit, AGENT_SESSIONS_LIST_MAX) : 30,
      });
      const device = deviceForHost(useStore.getState().activeDevices, host);
      return { deviceId: device?.id ?? null, total: result.total, agents: result.agents, partial: result.partial, sessions: result.sessions.map(describe) };
    },
    resume_agent_session: async (args) => {
      const host = agentSessionsHost(args.deviceId as string);
      const sessionId = args.sessionId as string;
      const cwd = args.cwd as string;
      // The conversation as the device lists it: how it resumes, its account and folder.
      const found = await listSettled(host, { agent: args.agent as string, q: sessionId, limit: 20 });
      const row = found.sessions.find((entry) => entry.id === sessionId);
      if (!row) throw new Error("No such conversation on this device. Read list_agent_sessions for session IDs.");
      if (row.cwd && row.cwd !== cwd) throw new Error(`This conversation ran in ${row.cwd}. Pass that folder as cwd.`);
      const target = { ...row, cwd: row.cwd || cwd };
      const mode = typeof args.mode === "string" ? args.mode : undefined;
      if (mode && !sessionAgent(row.agent)?.modes.some((item) => item.id === mode)) throw new Error("Choose a mode that this agent supports.");
      if (typeof args.tileId === "string") {
        await resumeInTile({ tileId: args.tileId, host, row: target, mode, confirm: false });
        return { resumed: true, tileId: args.tileId, sessionId };
      }
      const tileId = await resumeInNewTile({ host, row: target, mode, workspaceId: typeof args.workspaceId === "string" ? args.workspaceId : undefined });
      return { resumed: true, tileId, sessionId };
    },
  };
  const cleanups = Object.entries(handlers).map(([action, handler]) => registerAppControlHandler(action, handler));
  return () => cleanups.forEach((cleanup) => cleanup());
}
