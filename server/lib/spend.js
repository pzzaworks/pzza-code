// Estimated spend from local Claude/Codex transcripts (ccusage-style). Scans
// JSONL transcripts, prices token buckets per model, and caches the result;
// warmed in the background so the usage panel never waits on the scan.
import fs from "node:fs";
import path from "node:path";
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
export const SPEND_FRESH_MS = 10 * 60 * 1000;
let spendCache = { at: 0, data: null };

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

function parseClaudeSpend(file, seen, days) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line || !line.includes('"usage"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = rec.message;
    if (!msg || typeof msg !== "object") continue;
    const usage = msg.usage;
    const model = msg.model;
    if (!usage || typeof usage !== "object" || !model || String(model).startsWith("<")) continue;
    const key = `${msg.id} ${rec.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const day = recordDay(rec);
    if (!day) continue;
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
  }
}

function parseCodexSpend(file, days) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  let model = null;
  let previous = null;
  for (const line of text.split("\n")) {
    if (!line || (!line.includes('"turn_context"') && !line.includes('"token_count"'))) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = rec.payload;
    if (!payload || typeof payload !== "object") continue;
    if (rec.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
      continue;
    }
    if (rec.type !== "event_msg" || payload.type !== "token_count") continue;
    const total = (payload.info || {}).total_token_usage;
    if (!total || typeof total !== "object") continue;
    const current = CODEX_COUNTERS.map((n) => Number(total[n] || 0));
    const delta =
      previous === null || current.some((now, i) => now < previous[i])
        ? current
        : current.map((now, i) => now - previous[i]);
    previous = current;
    const day = recordDay(rec);
    if (!model || !day || !delta.some((x) => x)) continue;
    const cached = Math.min(delta[1], delta[0]);
    addBuckets(days, day, model, [delta[0] - cached, delta[2], cached, 0, 0]);
  }
}

// The transcripts can be big; yield to the event loop between files so scanning
// never freezes the terminals/WS for the whole (multi-second) pass.
async function scanSpend(now) {
  const dayStr = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const dayToday = dayStr(now);
  const dayYesterday = dayStr(now - 86400000);
  const horizon = now - SPEND_WINDOW_DAYS * 86400000;

  const data = [];
  for (const acc of discoverAccounts()) {
    const days = {};
    const seen = new Set();
    for (const file of transcriptFiles(acc.provider, acc.dir)) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < horizon) continue; // too old to touch the 30-day window
      if (acc.provider === "claude") parseClaudeSpend(file, seen, days);
      else parseCodexSpend(file, days);
      await new Promise((r) => setImmediate(r)); // let the event loop breathe
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
  spendCache = { at: now, data };
  return data;
}

let spendScan = null;

export function computeSpend() {
  const now = Date.now();
  if (spendCache.data && now - spendCache.at < SPEND_FRESH_MS) return Promise.resolve(spendCache.data);
  if (spendScan) return spendScan; // a scan is already running - share it
  spendScan = scanSpend(now).finally(() => {
    spendScan = null;
  });
  return spendScan;
}
