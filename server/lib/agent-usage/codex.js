// Codex: ~/.codex*/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl (plus
// archived_sessions/). token_count events carry running token totals and, for
// ChatGPT sign-ins, the plan's rate-limit windows at that moment.
import fs from "node:fs";
import path from "node:path";
import { discoverAccounts } from "../accounts.js";
import { addUsage, epochMs, isJsonl, localDay, noteSession, parseJson, readLines, recentFiles, sessionState, walkFiles } from "./records.js";

const COUNTERS = ["input_tokens", "cached_input_tokens", "output_tokens"];
const MAX_CODEX_DAYS = 31;

// Parse a Codex transcript. token_count events carry running totals, so the
// last totals (`previous`) and the current `model` are the resume state.
async function parse(file, start, days, state) {
  let model = state && typeof state.model === "string" ? state.model : null;
  let previous =
    state && Array.isArray(state.previous) && state.previous.length === COUNTERS.length
      ? state.previous.map(Number)
      : null;
  const session = sessionState(state);
  const parsedBytes = await readLines(file, start, (line) => {
    if (!line.includes('"turn_context"') && !line.includes('"token_count"')) return;
    const rec = parseJson(line);
    const payload = rec?.payload;
    if (!payload || typeof payload !== "object") return;
    if (rec.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
      if (typeof payload.cwd === "string" && payload.cwd && !session.cwd) session.cwd = payload.cwd;
      return;
    }
    if (rec.type !== "event_msg" || payload.type !== "token_count") return;
    const total = (payload.info || {}).total_token_usage;
    if (!total || typeof total !== "object") return;
    const current = COUNTERS.map((n) => Number(total[n] || 0));
    const delta =
      previous === null || current.some((now, i) => now < previous[i])
        ? current
        : current.map((now, i) => now - previous[i]);
    previous = current;
    const day = localDay(rec.timestamp);
    if (!model || !day || !delta.some((x) => x)) return;
    noteSession(session, epochMs(rec.timestamp), undefined, model);
    const cached = Math.min(delta[1], delta[0]);
    addUsage(days, day, model, [delta[0] - cached, delta[2], cached, 0, 0]);
  });
  return { parsedBytes, state: { model, previous, session } };
}

function dayParts(ms) {
  const d = new Date(ms);
  return [String(d.getFullYear()), String(d.getMonth() + 1).padStart(2, "0"), String(d.getDate()).padStart(2, "0")];
}

// Codex keeps sessions/<yyyy>/<mm>/<dd>/rollout-*.jsonl by start date: the
// days from `since` (one day earlier for time zones) to tomorrow, newest first.
function dayFolders(dir, since, now) {
  const folders = [];
  const first = Math.max(since - 86400000, now - MAX_CODEX_DAYS * 86400000);
  for (let at = now + 86400000; at >= first; at -= 86400000) folders.push(path.join(dir, "sessions", ...dayParts(at)));
  return folders;
}

// How far back from the newest rollouts to look for a rate-limit sample, and
// how much of each file's tail to read: the latest token_count is always near
// the end, so a long session is never read in full.
const LIMIT_DAYS = 8;
const LIMIT_FILES = 4;
const TAIL_BYTES = 512 * 1024;

async function fileTail(file, bytes) {
  const handle = await fs.promises.open(file, "r");
  try {
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    const text = buffer.subarray(0, bytesRead).toString("utf8");
    // A cut first line is partial; drop it unless the read began at byte 0.
    return start > 0 ? text.slice(text.indexOf("\n") + 1) : text;
  } finally {
    await handle.close();
  }
}

const percent = (value) => {
  const n = Number(value);
  return Number.isFinite(n) ? Math.min(100, Math.max(0, n)) : null;
};

/**
 * The newest rate-limit sample Codex wrote to its rollouts, per limit id:
 * { at, plan, limits: Map<limitId, { name, primary, secondary }>, credits }.
 * Null when no rollout of the last days carries one (API-key sign-ins never
 * do). Read-only; only the tail of the newest files is read.
 */
export async function codexRolloutLimits(dir, now = Date.now()) {
  const candidates = [];
  for (const folder of dayFolders(dir, now - LIMIT_DAYS * 86400000, now)) {
    candidates.push(...await recentFiles(folder, 0, isJsonl));
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs);
  let sample = null;
  for (const { file } of candidates.slice(0, LIMIT_FILES)) {
    let text;
    try {
      text = await fileTail(file, TAIL_BYTES);
    } catch {
      continue;
    }
    const lines = text.split("\n");
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i];
      if (!line.includes('"rate_limits"') || !line.includes('"token_count"')) continue;
      const rec = parseJson(line);
      const limits = rec?.payload?.type === "token_count" ? rec.payload.rate_limits : null;
      const at = epochMs(rec?.timestamp);
      if (!limits || typeof limits !== "object" || at === null) continue;
      if (!sample) sample = { at, plan: null, limits: new Map(), credits: null };
      const id = typeof limits.limit_id === "string" && limits.limit_id ? limits.limit_id : "codex";
      if (sample.limits.has(id)) continue;
      sample.limits.set(id, {
        name: typeof limits.limit_name === "string" && limits.limit_name ? limits.limit_name : null,
        primary: limits.primary && typeof limits.primary === "object" ? limits.primary : null,
        secondary: limits.secondary && typeof limits.secondary === "object" ? limits.secondary : null,
      });
      if (sample.plan === null && typeof limits.plan_type === "string") sample.plan = limits.plan_type;
      if (sample.credits === null && limits.credits && typeof limits.credits === "object") sample.credits = limits.credits;
    }
    // The newest file holds the main limit unless its session never got one.
    if (sample?.limits.has("codex")) break;
  }
  return sample;
}

function windowName(minutes) {
  if (minutes % 1440 === 0) return minutes === 10080 ? "Weekly" : `${minutes / 1440}d`;
  if (minutes % 60 === 0) return `${minutes / 60}h`;
  return `${minutes}m`;
}

/**
 * A rollout sample as { plan, usage } in the usage panel's shape. Windows that reset after the
 * sample was taken are left out: what they held is no longer known. The main
 * limit fills the 5h and weekly slots (other window sizes, such as a 30-day
 * free-plan window, become named rows); every other limit, such as a
 * model-specific one, becomes named rows.
 */
export function codexRolloutUsage(sample, now = Date.now()) {
  if (!sample) return null;
  let five_hour = null;
  let seven_day = null;
  const scoped = [];
  const current = (w) => {
    const used = percent(w?.used_percent);
    const minutes = Number(w?.window_minutes);
    const resets = epochMs(w?.resets_at);
    if (used === null || !Number.isFinite(minutes) || minutes <= 0) return null;
    if (resets !== null && resets <= now) return null;
    return { used, minutes, resets_at: resets === null ? null : new Date(resets).toISOString() };
  };
  for (const [id, limit] of sample.limits) {
    const windows = [current(limit.primary), current(limit.secondary)].filter(Boolean);
    for (const w of windows) {
      if (id === "codex" && w.minutes <= 360 && !five_hour) five_hour = { utilization: w.used, resets_at: w.resets_at };
      else if (id === "codex" && w.minutes === 10080 && !seven_day) seven_day = { utilization: w.used, resets_at: w.resets_at };
      else {
        const base = id === "codex" ? null : limit.name || id;
        const name = base ? (windows.length > 1 ? `${base} ${windowName(w.minutes)}` : base) : windowName(w.minutes);
        scoped.push({ name, percent: w.used, resets_at: w.resets_at });
      }
    }
  }
  const balances = [];
  const credits = sample.credits;
  const balance = Number(credits?.balance);
  if (credits?.has_credits === true && credits.unlimited !== true && credits.balance !== null && Number.isFinite(balance)) {
    balances.push({ name: "Credits", amount: balance, unit: "credits" });
  }
  if (!five_hour && !seven_day && !scoped.length && !balances.length) return null;
  return { plan: sample.plan, usage: { five_hour, seven_day, scoped, ...(balances.length ? { balances } : {}), updatedAt: sample.at } };
}

export const codexAdapter = {
  id: "codex",
  label: "Codex",
  pricingBasis: "standard-api-short-context",
  // Signed-in accounts always show their spend, zero included.
  listWhenIdle: true,
  roots: () => discoverAccounts().filter((account) => account.provider === "codex"),
  transcripts: (root) => [
    ...walkFiles(path.join(root.dir, "sessions"), isJsonl),
    ...walkFiles(path.join(root.dir, "archived_sessions"), isJsonl),
  ],
  parse,
  async sessionFiles(root, cwd, since, now) {
    const files = [];
    for (const folder of dayFolders(root.dir, since, now)) files.push(...await recentFiles(folder, since, isJsonl));
    return files;
  },
};
