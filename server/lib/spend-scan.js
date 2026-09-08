// Estimated spend from local Claude/Codex transcripts (ccusage-style). Scans
// JSONL transcripts, prices token buckets per model, and caches the result;
// warmed in the background so the usage panel never waits on the scan.
import fs from "node:fs";
import path from "node:path";
import { STATE_DIR } from "./config.js";
import { discoverAccounts } from "./accounts.js";

// USD per million (input, output) tokens.
const PRICING = {
  "claude-fable-5": [10.0, 50.0],
  "claude-mythos-5": [10.0, 50.0],
  "claude-opus-5": [5.0, 25.0],
  "claude-opus-4-8": [5.0, 25.0],
  "claude-opus-4-7": [5.0, 25.0],
  "claude-opus-4-6": [5.0, 25.0],
  "claude-opus-4-5": [5.0, 25.0],
  "claude-sonnet-5": [3.0, 15.0],
  "claude-sonnet-4-6": [3.0, 15.0],
  "claude-sonnet-4-5": [3.0, 15.0],
  "claude-haiku-4-5": [1.0, 5.0],
  "gpt-5.6-sol": [4.0, 20.0],
  "gpt-5.6-terra": [2.0, 12.0],
  "gpt-5.6-luna": [0.2, 1.2],
  "gpt-5.5": [5.0, 30.0],
  "gpt-5.4": [2.5, 15.0],
  "gpt-5.4-mini": [0.75, 4.5],
  "gpt-5.4-nano": [0.2, 1.25],
  "gpt-5.3-codex": [1.75, 14.0],
  "gpt-5.2-codex": [1.75, 14.0],
  "gpt-5.2": [1.75, 14.0],
  "gpt-5.1-codex": [1.25, 10.0],
  "gpt-5.1-codex-mini": [0.25, 2.0],
  "gpt-5.1": [1.25, 10.0],
  "gpt-5-codex": [1.25, 10.0],
  "gpt-5": [1.25, 10.0],
  "gpt-5-mini": [0.25, 2.0],
  "gpt-5-nano": [0.05, 0.4],
};
const PROMO_PRICING = { "claude-sonnet-5": [[2.0, 10.0], "2026-08-31"] };
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_5M_RATE = 1.25;
const CACHE_WRITE_1H_RATE = 2.0;
const CODEX_COUNTERS = ["input_tokens", "cached_input_tokens", "output_tokens"];
const SPEND_WINDOW_DAYS = 30;


function modelRates(model, day) {
  const name = String(model || "").split("[")[0];
  const candidates = [name];
  const parts = name.split("-");
  if (parts.length >= 2 && /^\d{8}$/.test(parts[parts.length - 1])) {
    candidates.push(parts.slice(0, -1).join("-"));
  }
  for (const c of candidates) {
    const promo = PROMO_PRICING[c];
    if (promo && day <= promo[1]) return promo[0];
    if (PRICING[c]) return PRICING[c];
  }
  return null;
}

function bucketCost(b, model, day) {
  const rates = modelRates(model, day);
  if (!rates) return 0;
  const [ri, wo] = rates;
  return (
    (b[0] * ri +
      b[1] * wo +
      b[2] * ri * CACHE_READ_RATE +
      b[3] * ri * CACHE_WRITE_5M_RATE +
      b[4] * ri * CACHE_WRITE_1H_RATE) /
    1_000_000
  );
}

function walkJsonl(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    let entries;
    try {
      entries = fs.readdirSync(stack.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(e.parentPath || e.path || dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  return out;
}

function transcriptFiles(provider, dir) {
  const roots = provider === "claude" ? ["projects"] : ["sessions", "archived_sessions"];
  const files = [];
  for (const r of roots) files.push(...walkJsonl(path.join(dir, r)));
  return files;
}

function recordDay(rec) {
  const d = new Date(rec.timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addBuckets(days, day, model, values) {
  const d = (days[day] = days[day] || {});
  const b = (d[model] = d[model] || [0, 0, 0, 0, 0]);
  for (let i = 0; i < values.length; i++) b[i] += values[i];
}

// Sum one file's day -> model -> buckets into the account-wide accumulator.
function mergeDays(into, from) {
  for (const [day, models] of Object.entries(from)) {
    for (const [model, buckets] of Object.entries(models)) {
      addBuckets(into, day, model, buckets);
    }
  }
}

// Per-file parse cache persisted to disk, keyed by absolute path, each entry
// tagged with the file's mtime + size. It survives restarts, so after the first
// full scan the (multi-second, whole-history) parse never runs again except for
// files that actually changed - and a file that only grew (the active session)
// is resumed from the last complete line instead of re-read. A corrupt, missing
// or older-format cache just means a cold scan.
const CACHE_FILE = path.join(STATE_DIR, "spend-cache.json");
const CACHE_VERSION = 2;
// Cap on the dedup keys persisted per Claude file for incremental resumes. A
// retry is logged right next to its original, so the last few hundred keys
// are all a resume ever needs; a cold parse still dedups the whole file.
const SEEN_KEEP = 200;
// Bytes per read: bounds peak memory per file and the sync work per tick.
const READ_CHUNK = 1024 * 1024;
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

// Stream `file` from byte `start`, calling onLine(line) for every complete
// (newline-terminated) line. Chunks are split on the raw bytes, so a multi-byte
// character straddling two reads is decoded intact and only the unfinished tail
// is carried between reads. Resolves with the byte offset just past the last
// line consumed; a trailing line without a newline is consumed only if it is
// already valid JSON (a fully written record awaiting its "\n"), otherwise it
// is left for the next scan, which resumes from the returned offset.
async function readLines(file, start, onLine) {
  let consumed = start;
  let parts = [];
  let bytes = 0;
  const stream = fs.createReadStream(file, { start, highWaterMark: READ_CHUNK });
  for await (const chunk of stream) {
    let from = 0;
    for (let nl = chunk.indexOf(10); nl !== -1; nl = chunk.indexOf(10, from)) {
      const part = chunk.subarray(from, nl);
      if (parts.length) {
        parts.push(part);
        onLine(Buffer.concat(parts, bytes + part.length).toString("utf8"));
      } else onLine(part.toString("utf8"));
      consumed += bytes + part.length + 1;
      parts = [];
      bytes = 0;
      from = nl + 1;
    }
    if (from < chunk.length) {
      const part = chunk.subarray(from);
      parts.push(part);
      bytes += part.length;
    }
  }
  if (bytes) {
    const tail = Buffer.concat(parts, bytes).toString("utf8");
    let complete = false;
    try {
      JSON.parse(tail);
      complete = true;
    } catch {
      /* partial write - re-read from `consumed` next time */
    }
    if (complete) {
      onLine(tail);
      consumed += bytes;
    }
  }
  return consumed;
}

// Parse a Claude transcript (from byte `start`, continuing `state`) into
// day -> model -> buckets. Deduplicates by (message id, requestId) within the
// file (retries logged twice); each file is parsed at most once and the result
// is cached, so cross-file dupes - which Claude Code does not actually produce
// (a session appends to its own file) - are not worth a global pass.
async function parseClaudeFile(file, start, days, state) {
  const seen = new Set(state && Array.isArray(state.seen) ? state.seen : []);
  const parsedBytes = await readLines(file, start, (line) => {
    if (!line.includes('"usage"')) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    const msg = rec.message;
    if (!msg || typeof msg !== "object") return;
    const usage = msg.usage;
    const model = msg.model;
    if (!usage || typeof usage !== "object" || !model || String(model).startsWith("<")) return;
    const key = `${msg.id} ${rec.requestId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const day = recordDay(rec);
    if (!day) return;
    const created = usage.cache_creation || {};
    let five = created.ephemeral_5m_input_tokens;
    const hour = created.ephemeral_1h_input_tokens;
    if (five == null && hour == null) five = usage.cache_creation_input_tokens;
    addBuckets(days, day, model, [
      usage.input_tokens || 0,
      usage.output_tokens || 0,
      usage.cache_read_input_tokens || 0,
      five || 0,
      hour || 0,
    ]);
  });
  // Sets iterate in insertion order, so the slice keeps the most recent keys.
  const keys = [...seen];
  return { parsedBytes, state: { seen: keys.slice(Math.max(0, keys.length - SEEN_KEEP)) } };
}

// Parse a Codex transcript. token_count events carry running totals, so the
// last totals (`previous`) and the current `model` are the resume state.
async function parseCodexFile(file, start, days, state) {
  let model = state && typeof state.model === "string" ? state.model : null;
  let previous =
    state && Array.isArray(state.previous) && state.previous.length === CODEX_COUNTERS.length
      ? state.previous.map(Number)
      : null;
  const parsedBytes = await readLines(file, start, (line) => {
    if (!line.includes('"turn_context"') && !line.includes('"token_count"')) return;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      return;
    }
    const payload = rec.payload;
    if (!payload || typeof payload !== "object") return;
    if (rec.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
      return;
    }
    if (rec.type !== "event_msg" || payload.type !== "token_count") return;
    const total = (payload.info || {}).total_token_usage;
    if (!total || typeof total !== "object") return;
    const current = CODEX_COUNTERS.map((n) => Number(total[n] || 0));
    const delta =
      previous === null || current.some((now, i) => now < previous[i])
        ? current
        : current.map((now, i) => now - previous[i]);
    previous = current;
    const day = recordDay(rec);
    if (!model || !day || !delta.some((x) => x)) return;
    const cached = Math.min(delta[1], delta[0]);
    addBuckets(days, day, model, [delta[0] - cached, delta[2], cached, 0, 0]);
  });
  return { parsedBytes, state: { model, previous } };
}

// Produce the cache entry for `file`: untouched files are reused as-is, files
// that only grew are resumed from the last complete line, anything else (shrunk,
// rewritten, mtime moved backwards, unusable state) is parsed from scratch.
// Returns null when the file cannot be read, so it is retried next scan.
async function parseTranscript(provider, file, st, prev) {
  const parse = provider === "claude" ? parseClaudeFile : parseCodexFile;
  const canResume =
    prev &&
    typeof prev.parsedBytes === "number" &&
    prev.parsedBytes <= st.size &&
    prev.mtimeMs <= st.mtimeMs &&
    prev.days &&
    typeof prev.days === "object";
  if (canResume && prev.parsedBytes === st.size && prev.mtimeMs === st.mtimeMs) return prev;
  if (canResume) {
    try {
      const days = structuredClone(prev.days);
      const { parsedBytes, state } = await parse(file, prev.parsedBytes, days, prev.state);
      return { mtimeMs: st.mtimeMs, size: st.size, parsedBytes, days, state };
    } catch {
      /* fall through to a full parse */
    }
  }
  try {
    const days = {};
    const { parsedBytes, state } = await parse(file, 0, days, null);
    return { mtimeMs: st.mtimeMs, size: st.size, parsedBytes, days, state };
  } catch {
    return null;
  }
}

// All discovery, parsing, and disk cache work runs in the scan worker.
export async function scanSpend(now) {
  const dayStr = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const dayToday = dayStr(now);
  const dayYesterday = dayStr(now - 86400000);
  const horizon = now - SPEND_WINDOW_DAYS * 86400000;

  const cache = loadFileCache();
  const nextCache = {};
  const data = [];
  for (const acc of discoverAccounts()) {
    const days = {};
    for (const file of transcriptFiles(acc.provider, acc.dir)) {
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
      const entry = await parseTranscript(acc.provider, file, st, cache[file]);
      if (!entry) continue;
      nextCache[file] = entry;
      mergeDays(days, entry.days);
    }
    const win = { today: [0, 0], yesterday: [0, 0], window: [0, 0] };
    for (const [day, models] of Object.entries(days)) {
      const inWindow = new Date(`${day}T00:00:00`).getTime() >= horizon;
      for (const [model, buckets] of Object.entries(models)) {
        const cost = bucketCost(buckets, model, day);
        const tokens = buckets.reduce((a, b) => a + b, 0);
        if (day === dayToday) {
          win.today[0] += cost;
          win.today[1] += tokens;
        }
        if (day === dayYesterday) {
          win.yesterday[0] += cost;
          win.yesterday[1] += tokens;
        }
        if (inWindow) {
          win.window[0] += cost;
          win.window[1] += tokens;
        }
      }
    }
    // Per-day totals across models for the trailing window (oldest first), for
    // the usage trend sparkline. Days with no activity are filled in as zero so
    // the bars line up on a calendar.
    const series = [];
    for (let i = SPEND_WINDOW_DAYS - 1; i >= 0; i--) {
      const day = dayStr(now - i * 86400000);
      let cost = 0;
      let tokens = 0;
      for (const [model, buckets] of Object.entries(days[day] || {})) {
        cost += bucketCost(buckets, model, day);
        tokens += buckets.reduce((a, b) => a + b, 0);
      }
      series.push({ day, cost, tokens });
    }
    data.push({
      provider: acc.provider,
      label: acc.label,
      today: { cost: win.today[0], tokens: win.today[1] },
      yesterday: { cost: win.yesterday[0], tokens: win.yesterday[1] },
      window: { cost: win.window[0], tokens: win.window[1] },
      days: series,
    });
  }
  // nextCache holds only the files seen this pass, so deleted / aged-out files
  // drop out and the cache never grows without bound.
  saveFileCache(nextCache);
  return data;
}
