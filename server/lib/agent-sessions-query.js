// The query of GET /agent-sessions and the response checks, shared by the
// route, the remote device request (device-agent.js) and the worker. Plain
// validation only: no file or network access.
import path from "node:path";
import { SESSION_AGENT_IDS, sessionAgent, validAgentAccount } from "./session-agents.js";

export const AGENT_SESSIONS_LIMITS = { limit: 300, defaultLimit: 150, offset: 100_000, q: 200, cwd: 4096 };
const AGENTS = new Set(SESSION_AGENT_IDS);
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
// The parameters a query is made of, in the order a canonical one lists them.
const FIELDS = ["agent", "cwd", "under", "since", "q", "limit", "offset", "fresh"];

// A value from URLSearchParams or a typed AgentSessionsQuery, as query text.
function reader(input) {
  if (input && typeof input.get === "function") return (name) => input.get(name);
  const object = input && typeof input === "object" && !Array.isArray(input) ? input : {};
  return (name) => {
    const value = object[name];
    if (value === undefined || value === null || value === false) return null;
    if (value === true) return "1";
    return typeof value === "string" || typeof value === "number" ? String(value) : "\u0000";
  };
}

const flag = (value, name) => {
  if (value === null || value === "" || value === "0") return false;
  if (value === "1") return true;
  throw new Error(`${name} must be 1 or 0.`);
};

const integer = (value, name, min, max) => {
  if (!/^\d{1,15}$/.test(value)) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  const number = Number(value);
  if (number < min || number > max) throw new Error(`${name} must be a whole number from ${min} to ${max}.`);
  return number;
};

/**
 * Validates a query (URLSearchParams or an AgentSessionsQuery object) and
 * returns { agent?, cwd?, under, since?, q?, limit, offset, fresh }; throws
 * with a message fit for a 400.
 */
export function parseAgentSessionsQuery(input) {
  const get = reader(input);
  const query = { under: false, limit: AGENT_SESSIONS_LIMITS.defaultLimit, offset: 0, fresh: false };
  const agent = get("agent");
  if (agent !== null && agent !== "") {
    if (!AGENTS.has(agent)) throw new Error("Choose an agent from the catalog.");
    query.agent = agent;
  }
  const cwd = get("cwd");
  if (cwd !== null && cwd !== "") {
    if (!cwd.startsWith("/") || cwd.length > AGENT_SESSIONS_LIMITS.cwd || CONTROL.test(cwd)) throw new Error("cwd must be an absolute folder path.");
    const folder = cwd.length > 1 ? cwd.replace(/\/+$/, "") : cwd;
    if (path.posix.normalize(folder) !== folder) throw new Error("cwd must be a normalized absolute path.");
    query.cwd = folder;
  }
  query.under = flag(get("under"), "under");
  if (query.under && !query.cwd) throw new Error("under needs a cwd.");
  const since = get("since");
  if (since !== null && since !== "") query.since = integer(since, "since", 0, 999_999_999_999_999);
  const q = get("q");
  if (q !== null && q.trim() !== "") {
    if (q.length > AGENT_SESSIONS_LIMITS.q || CONTROL.test(q)) throw new Error(`Search text is one line of at most ${AGENT_SESSIONS_LIMITS.q} characters.`);
    query.q = q.trim();
  }
  const limit = get("limit");
  if (limit !== null && limit !== "") query.limit = integer(limit, "limit", 1, AGENT_SESSIONS_LIMITS.limit);
  const offset = get("offset");
  if (offset !== null && offset !== "") query.offset = integer(offset, "offset", 0, AGENT_SESSIONS_LIMITS.offset);
  query.fresh = flag(get("fresh"), "fresh");
  return query;
}

/** The canonical endpoint for a validated query, built from its fields only. */
export function agentSessionsEndpoint(query) {
  const params = new URLSearchParams();
  for (const name of FIELDS) {
    const value = query[name];
    if (value === undefined || value === false || (name === "offset" && value === 0) || (name === "limit" && value === AGENT_SESSIONS_LIMITS.defaultLimit)) continue;
    params.set(name, value === true ? "1" : String(value));
  }
  const text = params.toString();
  return text ? `/agent-sessions?${text}` : "/agent-sessions";
}

/**
 * Whether `endpoint` is an /agent-sessions request a remote device may be
 * asked: only the query fields, valid, and in canonical form (so nothing
 * else, a host included, can ride along).
 */
export function validAgentSessionsEndpoint(endpoint) {
  if (typeof endpoint !== "string" || endpoint.length > 8192 || !/^\/agent-sessions(?:\?[A-Za-z0-9%._~+=&*-]*)?$/.test(endpoint)) return false;
  const params = new URLSearchParams(endpoint.slice("/agent-sessions".length + 1));
  for (const name of params.keys()) if (!FIELDS.includes(name)) return false;
  try {
    return agentSessionsEndpoint(parseAgentSessionsQuery(params)) === endpoint;
  } catch {
    return false;
  }
}

const RESUME = new Set(["id", "last", "none"]);
const time = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0;
const count = (value) => Number.isSafeInteger(value) && value >= 0;
const plain = (value, max) => typeof value === "string" && value.length <= max && !CONTROL.test(value);

// One row as the contract shapes it, or null.
function checkedRow(row) {
  if (!row || typeof row !== "object" || Array.isArray(row)) return null;
  if (!AGENTS.has(row.agent) || !plain(row.id, 128) || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(row.id)) return null;
  if (!plain(row.cwd, AGENT_SESSIONS_LIMITS.cwd) || (row.cwd && !row.cwd.startsWith("/"))) return null;
  if (!plain(row.title, 200) || !time(row.startedAt) || !time(row.lastAt) || !RESUME.has(row.resume)) return null;
  const out = { agent: row.agent, id: row.id, cwd: row.cwd, title: row.title, startedAt: row.startedAt, lastAt: row.lastAt };
  if (plain(row.branch, 256) && row.branch) out.branch = row.branch;
  if (count(row.messages)) out.messages = row.messages;
  if (count(row.bytes)) out.bytes = row.bytes;
  if (validAgentAccount(sessionAgent(row.agent), row.account)) out.account = row.account;
  // Only where an agent that finds its id from any folder lost its own folder.
  if (plain(row.resumeIn, AGENT_SESSIONS_LIMITS.cwd) && row.resumeIn.startsWith("/") && path.posix.normalize(row.resumeIn) === row.resumeIn
    && row.cwd && row.resume === "id" && sessionAgent(row.agent)?.resume.byId?.anyFolder) out.resumeIn = row.resumeIn;
  out.resume = row.resume;
  return out;
}

/** A response from another device's agent, checked and reshaped; throws when it is not one. */
export function checkedAgentSessionsResponse(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || !Array.isArray(value.sessions) || value.sessions.length > AGENT_SESSIONS_LIMITS.limit
    || !count(value.total) || !value.agents || typeof value.agents !== "object" || Array.isArray(value.agents) || typeof value.partial !== "boolean") {
    throw new Error("Invalid agent sessions response");
  }
  const agents = {};
  for (const [agent, number] of Object.entries(value.agents)) if (AGENTS.has(agent) && count(number)) agents[agent] = number;
  const sessions = value.sessions.map(checkedRow).filter(Boolean);
  return { sessions, total: value.total, agents, partial: value.partial };
}
