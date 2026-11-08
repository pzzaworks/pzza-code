// Token cost and run time of the agent session behind one tile, read from the
// agent's own local transcripts with the same parser and prices as the spend
// estimate (spend-scan.js). A tile is matched to a transcript by its working
// folder and start time, best effort: the newest transcript for that folder
// written since the tile's session started. Two agents in one folder at the
// same time therefore both resolve to whichever wrote last.
import fs from "node:fs";
import path from "node:path";
import { discoverAccounts } from "./accounts.js";
import { bucketCost, parseTranscript } from "./spend-scan.js";

const PROVIDERS = new Set(["claude", "codex"]);
const MAX_CWD_LENGTH = 4096;
// A transcript that was not written to for a while after the tile started can
// still be the one that started it; allow for clock skew only, not hours.
const FUTURE_SLACK_MS = 5 * 60 * 1000;
// Bounds per lookup: transcripts parsed while looking for the folder, subagent
// files under one Claude session, and Codex day folders walked back in time.
const MAX_CANDIDATES = 24;
const MAX_SIDECHAINS = 200;
const MAX_CODEX_DAYS = 31;
// Parsed transcripts kept in memory between polls, resumed as they grow.
const CACHE_LIMIT = 256;
const cache = new Map();

// Claude Code stores a folder's sessions under projects/<folder with every
// character other than a letter or digit replaced by "-">.
export function claudeProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// Validates the query of GET /session/cost; throws with a message fit for a 400.
export function sessionCostQuery(params, now = Date.now()) {
  const provider = params.get("provider");
  if (!PROVIDERS.has(provider)) throw new Error("Choose claude or codex.");
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

// .jsonl files directly in `dir` written at or after `since`, newest first.
async function recentTranscripts(dir, since) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
    const file = path.join(dir, entry.name);
    try {
      const { mtimeMs } = await fs.promises.stat(file);
      if (mtimeMs >= since) files.push({ file, mtimeMs });
    } catch {
      /* removed meanwhile */
    }
  }
  return files.sort((a, b) => b.mtimeMs - a.mtimeMs);
}

// Every .jsonl below `dir` (a Claude session's subagent transcripts), bounded.
async function nestedTranscripts(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length && files.length < MAX_SIDECHAINS) {
    let entries;
    try {
      entries = await fs.promises.readdir(stack.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const file = path.join(entry.parentPath || entry.path || dir, entry.name);
      if (entry.isDirectory()) stack.push(file);
      else if (entry.isFile() && entry.name.endsWith(".jsonl") && files.length < MAX_SIDECHAINS) files.push(file);
    }
  }
  return files;
}

function localDay(ms) {
  const d = new Date(ms);
  return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")];
}

// Codex keeps sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl by start date: the
// days from the tile's start (one day earlier for time zones) to tomorrow.
function codexDayFolders(dir, since, now) {
  const folders = [];
  const first = Math.max(since - 86400000, now - MAX_CODEX_DAYS * 86400000);
  for (let at = now + 86400000; at >= first; at -= 86400000) folders.push(path.join(dir, "sessions", ...localDay(at)));
  return folders;
}

function sameFolder(session, cwd) {
  // Older cached entries carry no folder; the slug match already narrowed them.
  return !session?.cwd || session.cwd.replace(/\/+$/, "") === cwd;
}

async function newestMatch(provider, candidates, cwd) {
  for (const { file } of candidates.sort((a, b) => b.mtimeMs - a.mtimeMs).slice(0, MAX_CANDIDATES)) {
    const entry = await parsed(provider, file);
    if (entry && sameFolder(entry.state?.session, cwd) && entry.state?.session?.firstAt != null) return { file, entry };
  }
  return null;
}

function emptyTotals() {
  return { tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, pricedCost: 0, unpricedTokens: 0, unpricedModels: [], models: [] };
}

function addEntry(totals, entry) {
  for (const [day, models] of Object.entries(entry.days || {})) {
    for (const [model, buckets] of Object.entries(models)) {
      const sum = buckets.reduce((a, b) => a + b, 0);
      if (!sum) continue;
      totals.tokens.input += buckets[0];
      totals.tokens.output += buckets[1];
      totals.tokens.cacheRead += buckets[2];
      totals.tokens.cacheWrite += buckets[3] + buckets[4];
      if (!totals.models.includes(model)) totals.models.push(model);
      const cost = bucketCost(buckets, model, day);
      if (cost === null) {
        totals.unpricedTokens += sum;
        if (!totals.unpricedModels.includes(model)) totals.unpricedModels.push(model);
      } else totals.pricedCost += cost;
    }
  }
}

// Finds the session for `cwd` that ran since `since` and returns its cost and
// time span, or { found: false }. `accounts` defaults to this device's agent
// config folders. File paths and transcript text are never returned.
export async function findSessionCost({ provider, cwd, since, now = Date.now(), accounts = discoverAccounts() }) {
  const dirs = accounts.filter((account) => account.provider === provider).map((account) => account.dir);
  const candidates = [];
  if (provider === "claude") {
    const slug = claudeProjectSlug(cwd);
    for (const dir of dirs) candidates.push(...await recentTranscripts(path.join(dir, "projects", slug), since));
  } else {
    for (const dir of dirs) for (const folder of codexDayFolders(dir, since, now)) candidates.push(...await recentTranscripts(folder, since));
  }
  const match = await newestMatch(provider, candidates, cwd);
  if (!match) return { found: false, provider };
  const totals = emptyTotals();
  addEntry(totals, match.entry);
  const session = match.entry.state.session;
  let lastAt = session.lastAt;
  let subagents = 0;
  if (provider === "claude") {
    // Subagents of a Claude session log to <session id>/subagents/*.jsonl.
    for (const file of await nestedTranscripts(match.file.replace(/\.jsonl$/, ""))) {
      const entry = await parsed(provider, file);
      if (!entry) continue;
      subagents++;
      addEntry(totals, entry);
      const at = entry.state?.session?.lastAt;
      if (Number.isFinite(at) && at > lastAt) lastAt = at;
    }
  }
  totals.models.sort();
  totals.unpricedModels.sort();
  return {
    found: true,
    provider,
    startedAt: session.firstAt,
    lastAt,
    subagents,
    models: totals.models,
    tokens: totals.tokens,
    // A known subtotal must never pass for a complete cost.
    cost: totals.unpricedTokens ? null : totals.pricedCost,
    pricedCost: totals.pricedCost,
    unpricedModels: totals.unpricedModels,
    pricingBasis: "standard-api-short-context",
  };
}

export async function sessionCostRouter(req, res, url, json) {
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
// newest reply in that folder's newest transcript written since `since`.
// Null when no transcript matches (a session that has not replied yet).
export async function findSessionModel({ provider, cwd, since, now = Date.now(), accounts = discoverAccounts() }) {
  if (!PROVIDERS.has(provider) || typeof cwd !== "string" || !cwd.startsWith("/") || cwd.length > MAX_CWD_LENGTH) return null;
  const dirs = accounts.filter((account) => account.provider === provider).map((account) => account.dir);
  const candidates = [];
  if (provider === "claude") {
    const slug = claudeProjectSlug(cwd);
    for (const dir of dirs) candidates.push(...await recentTranscripts(path.join(dir, "projects", slug), since));
  } else {
    for (const dir of dirs) for (const folder of codexDayFolders(dir, since, now)) candidates.push(...await recentTranscripts(folder, since));
  }
  const match = await newestMatch(provider, candidates, cwd);
  const model = match?.entry.state?.session?.lastModel;
  return typeof model === "string" && model ? model : null;
}
