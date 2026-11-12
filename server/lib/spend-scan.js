// Spend per agent from this device's local agent data (ccusage-style): every
// usage adapter (agent-usage/) contributes its tokens per day and model, priced
// from the local rate table or taken as the cost the agent recorded itself.
// Transcript files are parsed incrementally and cached on disk; databases are
// queried directly. Runs in the scan worker, warmed in the background so the
// usage panel never waits on it.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.js";
import { usageAdapter, usageRoots } from "./agent-usage/index.js";
import { bucketCost } from "./agent-usage/pricing.js";
import { COST_SLOT, UNRECORDED_SLOT, hasRecordedCost, localDay, mergeDays, tokenSum } from "./agent-usage/records.js";

const SPEND_WINDOW_DAYS = 30;

// Per-file parse cache persisted to disk, keyed by absolute path, each entry
// tagged with the file's mtime + size. It survives restarts, so after the first
// full scan the (multi-second, whole-history) parse never runs again except for
// files that actually changed - and a file that only grew (the active session)
// is resumed from the last complete line instead of re-read. A corrupt, missing
// or older-format cache just means a cold scan.
const CACHE_FILE = path.join(STATE_DIR, "spend-cache.json");
const CACHE_VERSION = 2;
let memCache = null;

function loadFileCache() {
  if (memCache) return memCache;
  memCache = {};
  try {
    const raw = JSON.parse(fs.readFileSync(CACHE_FILE, "utf8"));
    if (raw && raw.version === CACHE_VERSION && raw.files && typeof raw.files === "object") {
      memCache = raw.files;
    }
  } catch {
    /* cold scan */
  }
  return memCache;
}

function saveFileCache(files) {
  memCache = files;
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ version: CACHE_VERSION, files }));
  } catch {
    /* best effort - a failed write just costs a re-parse next boot */
  }
}

// Bytes of the parsed region fingerprinted at each end (see parsedMark).
const MARK_BYTES = 256;

// A fingerprint of the bytes already parsed: the first and the last
// MARK_BYTES before `parsedBytes`. A file that was replaced or rewritten and
// has since grown past the old offset (log rotation, a session file written
// anew) no longer matches, so it is parsed from scratch instead of resumed
// from an offset inside unrelated content.
async function parsedMark(file, parsedBytes) {
  const handle = await fs.promises.open(file, "r");
  try {
    const head = Math.min(MARK_BYTES, parsedBytes);
    const tailStart = Math.max(head, parsedBytes - MARK_BYTES);
    const buffer = Buffer.alloc(head + (parsedBytes - tailStart));
    const { bytesRead: headRead } = await handle.read(buffer, 0, head, 0);
    const { bytesRead: tailRead } = await handle.read(buffer, head, parsedBytes - tailStart, tailStart);
    if (headRead + tailRead !== buffer.length) return null;
    return crypto.createHash("sha256").update(buffer).digest("hex");
  } finally {
    await handle.close();
  }
}

// Produce the cache entry for `file` with the agent's transcript parser:
// untouched files are reused as-is, files that only grew are resumed from the
// last complete line, anything else (shrunk, replaced, rewritten, mtime moved
// backwards, unusable state) is parsed from scratch. Returns null when the file
// cannot be read or the agent has no transcript parser, so it is retried next scan.
export async function parseTranscript(provider, file, st, prev) {
  const adapter = usageAdapter(provider);
  const parse = adapter?.parse;
  if (!parse) return null;
  if (prev && prev.parsedBytes === st.size && prev.mtimeMs === st.mtimeMs && prev.days && typeof prev.days === "object") return prev;
  // A file the agent rewrites whole (rather than appends to) is never resumed.
  const canResume =
    !adapter.wholeFile &&
    prev &&
    typeof prev.parsedBytes === "number" &&
    prev.parsedBytes <= st.size &&
    prev.mtimeMs <= st.mtimeMs &&
    prev.days &&
    typeof prev.days === "object";
  // Resuming needs proof the parsed bytes are still the same file's: its
  // inode and the fingerprint of what was parsed.
  const sameFile = canResume && prev.ino === st.ino && typeof prev.mark === "string" &&
    await parsedMark(file, prev.parsedBytes).then((mark) => mark === prev.mark, () => false);
  if (sameFile) {
    try {
      const days = structuredClone(prev.days);
      const { parsedBytes, state } = await parse(file, prev.parsedBytes, days, prev.state);
      const mark = await parsedMark(file, parsedBytes);
      return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, parsedBytes, mark, days, state };
    } catch {
      /* fall through to a full parse */
    }
  }
  try {
    const days = {};
    const { parsedBytes, state } = await parse(file, 0, days, null);
    const mark = await parsedMark(file, parsedBytes);
    return { mtimeMs: st.mtimeMs, size: st.size, ino: st.ino, parsedBytes, mark, days, state };
  } catch {
    return null;
  }
}

function emptySpendWindow() {
  return { cost: 0, pricedCost: 0, tokens: 0, unpricedTokens: 0, unpricedModels: [] };
}

function markUnpriced(total, tokens, model) {
  total.unpricedTokens += tokens;
  if (!total.unpricedModels.includes(model)) total.unpricedModels.push(model);
  total.unpricedModels.sort();
}

// Adds one day's buckets for one model: the cost the agent recorded, or the
// tokens priced at the model's rates. Tokens without either stay unpriced.
export function addSpend(total, buckets, model, day) {
  const tokens = tokenSum(buckets);
  const recorded = hasRecordedCost(buckets);
  // An agent that records cost but not tokens (Crush) still has spend.
  if (!tokens && !(recorded && buckets[COST_SLOT] > 0)) return;
  total.tokens += tokens;
  if (recorded) {
    total.pricedCost += buckets[COST_SLOT];
    if (buckets[UNRECORDED_SLOT] > 0) markUnpriced(total, buckets[UNRECORDED_SLOT], model);
  } else {
    const cost = bucketCost(buckets, model, day);
    if (cost === null) markUnpriced(total, tokens, model);
    else total.pricedCost += cost;
  }
  // A known subtotal is useful, but must never masquerade as a complete total.
  total.cost = total.unpricedTokens ? null : total.pricedCost;
}

// One adapter root's day -> model -> buckets for the window, or null when its
// data could not be read. Transcript files go through the parse cache.
async function rootDays(adapter, root, horizon, cache, nextCache, changes) {
  if (adapter.records) return adapter.records(root, horizon);
  const days = {};
  // A session can exist as several files (Gemini CLI copies its old project
  // folders when it renames them); such copies share a sessionKey and only the
  // most complete one counts.
  const sessions = new Map();
  for (const file of adapter.transcripts(root)) {
    let st;
    try {
      st = fs.statSync(file);
    } catch {
      continue;
    }
    if (st.mtimeMs < horizon) continue; // too old to touch the 30-day window
    // Reuse the parsed result unless the file changed. Only the bytes an
    // actually-changed file (essentially just the active transcript) gained
    // are read, so a huge history is streamed in full only once.
    const entry = await parseTranscript(adapter.id, file, st, cache[file]);
    if (!entry) continue;
    if (entry !== cache[file]) changes.count++;
    nextCache[file] = entry;
    const key = entry.state?.sessionKey;
    if (typeof key !== "string" || !key) mergeDays(days, entry.days);
    else if (!sessions.has(key) || sessions.get(key).parsedBytes < entry.parsedBytes) sessions.set(key, entry);
  }
  for (const entry of sessions.values()) mergeDays(days, entry.days);
  return days;
}

// All discovery, parsing, and disk cache work runs in the scan worker.
export async function scanSpend(now) {
  const dayToday = localDay(now);
  const dayYesterday = localDay(now - 86400000);
  const horizon = now - SPEND_WINDOW_DAYS * 86400000;

  const cache = loadFileCache();
  const nextCache = {};
  // Whether any file's entry changed, so an idle rescan skips rewriting the
  // (whole-history) cache file.
  const changes = { count: 0 };
  const data = [];
  for (const root of usageRoots()) {
    const adapter = usageAdapter(root.provider);
    if (!adapter) continue;
    const days = await rootDays(adapter, root, horizon, cache, nextCache, changes);
    if (!days) continue;
    const win = { today: emptySpendWindow(), yesterday: emptySpendWindow(), window: emptySpendWindow() };
    for (const [day, models] of Object.entries(days)) {
      const inWindow = new Date(`${day}T00:00:00`).getTime() >= horizon;
      for (const [model, buckets] of Object.entries(models)) {
        if (day === dayToday) addSpend(win.today, buckets, model, day);
        if (day === dayYesterday) addSpend(win.yesterday, buckets, model, day);
        if (inWindow) addSpend(win.window, buckets, model, day);
      }
    }
    // Agents without a signed-in account card are listed only when they did
    // something in the window, so an installed but idle agent adds no row.
    if (!adapter.listWhenIdle && !win.window.tokens && !win.window.pricedCost) continue;
    // Per-day totals across models for the trailing window (oldest first), for
    // the usage trend sparkline. Days with no activity are filled in as zero so
    // the bars line up on a calendar.
    const series = [];
    for (let i = SPEND_WINDOW_DAYS - 1; i >= 0; i--) {
      const day = localDay(now - i * 86400000);
      const total = emptySpendWindow();
      for (const [model, buckets] of Object.entries(days[day] || {})) addSpend(total, buckets, model, day);
      series.push({ day, ...total });
    }
    data.push({
      provider: adapter.id,
      label: root.label,
      pricingBasis: adapter.pricingBasis,
      ...(adapter.tracksTokens === false ? { tokensTracked: false } : {}),
      ...win,
      days: series,
    });
  }
  // nextCache holds only the files seen this pass, so deleted / aged-out files
  // drop out and the cache never grows without bound. Every kept entry is the
  // cached one when nothing changed, so equal counts mean no file dropped out.
  if (changes.count || Object.keys(nextCache).length !== Object.keys(cache).length) saveFileCache(nextCache);
  else memCache = nextCache;
  return data;
}
