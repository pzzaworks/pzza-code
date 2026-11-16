// App commands for past coding-agent conversations: open the Agent sessions
// dialog, list a device's conversations (metadata only, never transcripts) and
// resume one in a new tile or in an open tile's terminal.
import { AGENT_SESSION_ID_MAX_LENGTH, SESSION_AGENTS } from "./session-agents.js";

const string = (maxLength = 512) => ({ type: "string", minLength: 1, maxLength, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const enumeration = (...values) => ({ type: "string", enum: values });
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const command = (description, properties = {}, required = []) => ({ description, type: "object", properties, required, additionalProperties: false });

export const AGENT_SESSIONS_LIST_MAX = 100;

const tileId = string();
const deviceId = string(128);
const agent = enumeration(...SESSION_AGENTS.map(item => item.id));
const folder = { type: "string", minLength: 1, maxLength: 4096, pattern: "^/[^\\u0000-\\u001f\\u007f]*$" };
// Conversation ids are the agents' own (UUIDs and similar), in the catalog's plain id characters (validAgentSessionId).
const sessionId = { type: "string", minLength: 1, maxLength: AGENT_SESSION_ID_MAX_LENGTH, pattern: "^[A-Za-z0-9][A-Za-z0-9_.:-]*$" };
const mode = enumeration(...new Set(SESSION_AGENTS.flatMap(item => item.modes.map(entry => entry.id))));

export const AGENT_SESSIONS_APP_COMMANDS = {
  open_agent_sessions: command("Open the Agent sessions dialog (past Claude Code, Codex and other agent conversations), scoped to a tile's device and folder when tileId is given.", { tileId }),
  list_agent_sessions: command("List past coding-agent conversations on a device, newest first: agent, id, folder, title (summary or first prompt), branch, times, size and how it can be resumed. Never returns transcript content. deviceId defaults to the app's connected device; under includes folders below cwd.", {
    deviceId, agent, cwd: folder, under: { type: "boolean" }, query: string(200),
    sinceDays: integer(1, 3650), limit: integer(1, AGENT_SESSIONS_LIST_MAX),
  }),
  resume_agent_session: command("Resume a past coding-agent conversation from list_agent_sessions: in a new tile in its folder (default), or, with tileId, by typing the resume command into that open tile's terminal, which must be on the same device, at its shell prompt and running no agent. The tile path asks the user to confirm in the app first. mode defaults to the agent's last used mode.", {
    deviceId, agent, sessionId, cwd: folder, mode, tileId, workspaceId: string(128),
  }, ["deviceId", "agent", "sessionId", "cwd"]),
};
