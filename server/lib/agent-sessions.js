// Past coding-agent conversations on a device for GET /agent-sessions (types
// in agent-sessions.d.ts). The scan runs in a worker thread so reading many
// transcripts never stalls the terminal bridge on this thread; another
// device's list is asked from that device's own agent over SSH.
import { Worker } from "node:worker_threads";
import { SSH_TOKEN } from "./shell.js";
import { deviceAgentRequest } from "./device-agent.js";
import { agentSessionsEndpoint, checkedAgentSessionsResponse, parseAgentSessionsQuery } from "./agent-sessions-query.js";

// The worker answers within its own scan budget (8 s); this only catches a
// worker that stopped answering.
const WORKER_TIMEOUT_MS = 30_000;
let worker = null;
let nextId = 1;
const pending = new Map();

function failAll(message) {
  for (const request of pending.values()) request.reject(new Error(message));
  pending.clear();
}

function scanWorker() {
  if (worker) return worker;
  const current = new Worker(new URL("./agent-sessions-worker.js", import.meta.url));
  worker = current;
  current.on("message", ({ id, data, error }) => {
    const request = pending.get(id);
    if (!request) return;
    pending.delete(id);
    if (!pending.size) current.unref();
    if (error) request.reject(new Error(error));
    else request.resolve(data);
  });
  const stopped = () => {
    if (worker !== current) return;
    worker = null;
    failAll("Agent sessions worker stopped");
  };
  current.on("error", stopped);
  current.on("exit", stopped);
  return current;
}

/** Lists this device's past agent conversations; throws for an invalid query. */
export async function listAgentSessions(query = {}) {
  const valid = parseAgentSessionsQuery(query);
  const current = scanWorker();
  current.ref();
  const id = nextId++;
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!pending.delete(id)) return;
      if (!pending.size) current.unref();
      reject(new Error("Agent sessions took too long"));
    }, WORKER_TIMEOUT_MS);
    timer.unref?.();
    const done = (fn) => (value) => { clearTimeout(timer); fn(value); };
    pending.set(id, { resolve: done(resolve), reject: done(reject) });
    current.postMessage({ id, query: valid });
  });
}

/**
 * Asks another device's agent for its list. Only the validated query fields
 * are sent (agentSessionsEndpoint), never the client's text or the host, and
 * the answer is checked before it is passed on. Identical requests share one
 * SSH round trip, and an answer is reused for a few seconds unless `fresh`.
 */
export function createRemoteAgentSessions({ request = deviceAgentRequest, now = Date.now, reuseMs = 20_000 } = {}) {
  const cache = new Map();
  return async (host, query) => {
    if (!SSH_TOKEN.test(host)) throw new Error("Invalid device host");
    const endpoint = agentSessionsEndpoint(query);
    const key = `${host}\n${agentSessionsEndpoint({ ...query, fresh: false })}`;
    const entry = cache.get(key);
    if (entry?.pending) return entry.pending;
    if (entry && !query.fresh && !entry.value.partial && now() - entry.at < reuseMs) return entry.value;
    const next = { at: now(), value: null, pending: null };
    next.pending = request(host, endpoint).then((value) => {
      next.value = checkedAgentSessionsResponse(value);
      next.at = now();
      return next.value;
    }).finally(() => {
      next.pending = null;
      if (!next.value) cache.delete(key);
    });
    cache.delete(key);
    cache.set(key, next);
    while (cache.size > 64) cache.delete(cache.keys().next().value);
    return next.pending;
  };
}

/** GET /agent-sessions[?host=]: this device's list, or a remote device's. */
export function createAgentSessionsRouter({ list = listAgentSessions, remote = createRemoteAgentSessions() } = {}) {
  return async (req, res, url, json) => {
    if (url.pathname !== "/agent-sessions") return false;
    if (req.method !== "GET") {
      json(res, 405, { error: "Use GET for agent sessions" });
      return true;
    }
    const host = url.searchParams.get("host") || "";
    if (host && !SSH_TOKEN.test(host)) {
      json(res, 400, { error: "Invalid device host" });
      return true;
    }
    let query;
    try {
      query = parseAgentSessionsQuery(url.searchParams);
    } catch (error) {
      json(res, 400, { error: error.message });
      return true;
    }
    try {
      json(res, 200, host ? await remote(host, query) : await list(query));
    } catch {
      json(res, 503, { error: host ? "Agent sessions are unavailable on that device" : "Agent sessions are unavailable on this device" });
    }
    return true;
  };
}

export const agentSessionsRouter = createAgentSessionsRouter();
