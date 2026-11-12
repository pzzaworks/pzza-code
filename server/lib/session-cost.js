// Token cost and run time of the agent session behind one tile, read from the
// agent's own local data with the same usage adapters and prices as the spend
// estimate (spend-scan.js). A tile is matched to a session by its working
// folder and start time, best effort: the newest session for that folder
// active since the tile's session started. Two agents in one folder at the
// same time therefore both resolve to whichever wrote last.
import fs from "node:fs";
import path from "node:path";
import { SESSION_USAGE_AGENTS, usageAdapter, usageRoots } from "./agent-usage/index.js";
import { bucketCost } from "./agent-usage/pricing.js";
import { COST_SLOT, UNRECORDED_SLOT, hasRecordedCost, tokenSum } from "./agent-usage/records.js";
import { parseTranscript } from "./spend-scan.js";

const PROVIDERS = new Set(SESSION_USAGE_AGENTS);
const MAX_CWD_LENGTH = 4096;
// A transcript that was not written to for a while after the tile started can
// still be the one that started it; allow for clock skew only, not hours.
const FUTURE_SLACK_MS = 5 * 60 * 1000;
// Transcripts parsed per lookup while looking for the folder.
const MAX_CANDIDATES = 24;
// Bounds of one POST /session/cost/batch: the tiles of a whole grid in one
// request, each query as large as a single GET may be.
export const SESSION_COST_BATCH_LIMITS = { queries: 64, bodyBytes: 512 * 1024 };
// Parsed transcripts kept in memory between polls, resumed as they grow.
const CACHE_LIMIT = 256;
const cache = new Map();

// Validates the query of GET /session/cost; throws with a message fit for a 400.
export function sessionCostQuery(params, now = Date.now()) {
  const provider = params.get("provider");
  if (!PROVIDERS.has(provider)) throw new Error(`Choose an agent whose sessions can be priced: ${SESSION_USAGE_AGENTS.join(", ")}.`);
  const raw = params.get("cwd");
  if (typeof raw !== "string" || !raw.startsWith("/") || raw.length > MAX_CWD_LENGTH || /[\u0000-\u001f\u007f]/.test(raw)) {
    throw new Error("cwd must be an absolute folder path.");
  }
  if (path.posix.normalize(raw) !== raw) throw new Error("cwd must be a normalized absolute path.");
  const cwd = raw.length > 1 ? raw.replace(/\/+$/, "") : raw;
  const sinceText = params.get("since");
  if (typeof sinceText !== "string" || !/^\d{1,15}$/.test(sinceText)) throw new Error("since must be a start time in milliseconds.");
  const since = Number(sinceText);
  if (since > now + FUTURE_SLACK_MS) throw new Error("since is in the future.");
  return { provider, cwd, since };
}

async function parsed(provider, file) {
  let st;
  try {
    st = await fs.promises.stat(file);
  } catch {
    return null;
  }
  if (!st.isFile()) return null;
  const entry = await parseTranscript(provider, file, st, cache.get(file));
  cache.delete(file);
  if (entry) {
    cache.set(file, entry);
    while (cache.size > CACHE_LIMIT) cache.delete(cache.keys().next().value);
  }
  return entry;
}

function sameFolder(session, cwd) {
  // Older cached entries carry no folder; the folder lookup already narrowed them.
  return !session?.cwd || session.cwd.replace(/\/+$/, "") === cwd;
}

// The session entry for `cwd` since `since` across the agent's data roots:
// the newest matching transcript (with its subagent files) or the database's
// newest matching session.
async function sessionMatch(adapter, roots, cwd, since, now) {
  if (adapter.sessionEntry) {
    let best = null;
    for (const root of roots) {
      const entry = await adapter.sessionEntry(root, cwd, since, now);
      if (entry?.state?.session?.firstAt != null && (!best || entry.state.session.lastAt > best.state.session.lastAt)) best = entry;
    }
    return best ? { entries: [best], subagents: best.subagents ?? 0 } : null;
  }
  const candidates = [];
  for (const root of roots) candidates.push(...await adapter.sessionFiles(root, cwd, since, now));
  for (const { file } of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_CANDIDATES)) {
    const entry = await parsed(adapter.id, file);
    if (!entry || !sameFolder(entry.state?.session, cwd) || entry.state?.session?.firstAt == null) continue;
    const entries = [entry];
    for (const extra of adapter.subagentFiles ? await adapter.subagentFiles(file, entry) : []) {
      const sub = await parsed(adapter.id, extra);
      if (sub) entries.push(sub);
    }
    return { entries, subagents: entries.length - 1 };
  }
  return null;
}

function emptyTotals() {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, pricedCost: 0, unpricedTokens: 0, unpricedModels: [], models: [] };
}

function addEntry(totals, entry) {
  for (const [day, models] of Object.entries(entry.days || {})) {
    for (const [model, buckets] of Object.entries(models)) {
      const sum = tokenSum(buckets);
      if (!sum && !(hasRecordedCost(buckets) && buckets[COST_SLOT] > 0)) continue;
      totals.tokens.input += buckets[0];
      totals.tokens.output += buckets[1];
      totals.tokens.cacheRead += buckets[2];
      totals.tokens.cacheWrite += buckets[3] + buckets[4];
      if (!totals.models.includes(model)) totals.models.push(model);
      const unpriced = (tokens) => {
        totals.unpricedTokens += tokens;
        if (!totals.unpricedModels.includes(model)) totals.unpricedModels.push(model);
      };
      if (hasRecordedCost(buckets)) {
        totals.pricedCost += buckets[COST_SLOT];
        if (buckets[UNRECORDED_SLOT] > 0) unpriced(buckets[UNRECORDED_SLOT]);
        continue;
      }
      const cost = bucketCost(buckets, model, day);
      if (cost === null) unpriced(sum);
      else totals.pricedCost += cost;
    }
  }
}

function rootsFor(provider, accounts) {
  return accounts.filter((account) => account.provider === provider);
}

// Finds the session for `cwd` that ran since `since` and returns its cost and
// time span, or { found: false }. `accounts` defaults to this device's agent
// data roots. File paths and transcript text are never returned.
export async function findSessionCost({ provider, cwd, since, now = Date.now(), accounts = usageRoots() }) {
  const adapter = usageAdapter(provider);
  const match = adapter ? await sessionMatch(adapter, rootsFor(provider, accounts), cwd, since, now) : null;
  if (!match) return { found: false, provider };
  const totals = emptyTotals();
  const session = match.entries[0].state.session;
  let lastAt = session.lastAt;
  for (const entry of match.entries) {
    addEntry(totals, entry);
    const at = entry.state?.session?.lastAt;
    if (Number.isFinite(at) && at > lastAt) lastAt = at;
  }
  totals.models.sort();
  totals.unpricedModels.sort();
  return {
    found: true,
    provider,
    startedAt: session.firstAt,
    lastAt,
    subagents: match.subagents,
    models: totals.models,
    // An agent that records cost but not tokens (Crush) has no token counts.
    tokens: adapter.tracksTokens === false ? null : totals.tokens,
    // A known subtotal must never pass for a complete cost.
    cost: totals.unpricedTokens ? null : totals.pricedCost,
    pricedCost: totals.pricedCost,
    unpricedModels: totals.unpricedModels,
    pricingBasis: adapter.pricingBasis,
  };
}

// Validates the body of POST /session/cost/batch. A malformed request throws
// (400); one bad query only fails its own slot, as its own GET would have.
export function sessionCostBatchQueries(body, now = Date.now()) {
  if (!body || typeof body !== "object" || Array.isArray(body)) throw new Error("Send a JSON object with queries.");
  if (body.host !== undefined && body.host !== "") throw new Error("Session cost is only read on this device.");
  const { queries } = body;
  if (!Array.isArray(queries) || !queries.length || queries.length > SESSION_COST_BATCH_LIMITS.queries) {
    throw new Error(`Send between 1 and ${SESSION_COST_BATCH_LIMITS.queries} queries.`);
  }
  return queries.map((item) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: "Each query must be an object." };
    // Only string fields, exactly as a GET query string would carry them.
    const params = { get: (name) => (typeof item[name] === "string" ? item[name] : null) };
    try {
      return sessionCostQuery(params, now);
    } catch (error) {
      return { error: error.message };
    }
  });
}

// Answers validated batch queries in order. Identical queries are looked up
// once, and lookups run one after another so a full grid never fans out into
// parallel transcript reads. A failed lookup only fails its own slot.
export async function findSessionCosts(queries, { now = Date.now(), accounts = usageRoots(), find = findSessionCost } = {}) {
  const answers = new Map();
  const results = [];
  for (const query of queries) {
    if (query.error) {
      results.push({ error: query.error });
      continue;
    }
    const key = `${query.provider}\n${query.cwd}\n${query.since}`;
    if (!answers.has(key)) {
      answers.set(key, await find({ ...query, now, accounts }).catch(() => ({ error: "Session cost is unavailable on this device" })));
    }
    results.push(answers.get(key));
  }
  return results;
}

async function boundedJson(req, limit) {
  const declared = Number(req.headers?.["content-length"]);
  if (Number.isFinite(declared) && declared > limit) return { tooLarge: true };
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) return { tooLarge: true };
    chunks.push(chunk);
  }
  try {
    return { value: JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") };
  } catch {
    return { value: null };
  }
}

export async function sessionCostRouter(req, res, url, json) {
  if (url.pathname === "/session/cost/batch") {
    if (req.method !== "POST") {
      json(res, 405, { error: "Use POST for batched session cost" });
      return true;
    }
    const body = await boundedJson(req, SESSION_COST_BATCH_LIMITS.bodyBytes);
    if (body.tooLarge) {
      json(res, 413, { error: "Session cost request too large." });
      return true;
    }
    let queries;
    try {
      queries = sessionCostBatchQueries(body.value);
    } catch (error) {
      json(res, 400, { error: error.message });
      return true;
    }
    try {
      json(res, 200, { results: await findSessionCosts(queries) });
    } catch {
      json(res, 503, { error: "Session cost is unavailable on this device" });
    }
    return true;
  }
  if (url.pathname !== "/session/cost") return false;
  if (req.method !== "GET") {
    json(res, 405, { error: "Use GET for session cost" });
    return true;
  }
  // Transcripts live on the device that runs the agent; this endpoint reads
  // only this device's.
  if (url.searchParams.get("host")) {
    json(res, 400, { error: "Session cost is only read on this device." });
    return true;
  }
  let query;
  try {
    query = sessionCostQuery(url.searchParams);
  } catch (error) {
    json(res, 400, { error: error.message });
    return true;
  }
  try {
    json(res, 200, await findSessionCost(query));
  } catch {
    json(res, 503, { error: "Session cost is unavailable on this device" });
  }
  return true;
}

// The model an agent session in `cwd` is actually running: the model of the
// newest reply in that folder's newest session active since `since`. Null when
// no session matches (a session that has not replied yet).
export async function findSessionModel({ provider, cwd, since, now = Date.now(), accounts = usageRoots() }) {
  if (!PROVIDERS.has(provider) || typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > MAX_CWD_LENGTH) return null;
  const match = await sessionMatch(usageAdapter(provider), rootsFor(provider, accounts), cwd, since, now);
  const model = match?.entries[0].state?.session?.lastModel;
  return typeof model === "string" && model ? model : null;
}
