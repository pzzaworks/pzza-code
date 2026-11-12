// Shared building blocks of the per-agent usage adapters: the day -> model ->
// token bucket accumulator, streaming JSONL reads, and the per-session facts
// (folder, first and last reply, current model) a tile lookup needs.
import fs from "node:fs";
import path from "node:path";

// Bucket layout, per day and model:
//   [input, output, cacheRead, cacheWrite5m, cacheWrite1h]            priced from PRICING
//   [..., recordedCost, tokensWithoutRecordedCost]                    cost stored by the agent
// The five token slots are the same for every agent. Agents that store their
// own cost (Pi, goose, OpenCode, ...) add the two trailing slots, so a reply
// whose cost the agent did not record stays visibly unpriced instead of $0.
export const TOKEN_SLOTS = 5;
export const COST_SLOT = 5;
export const UNRECORDED_SLOT = 6;

export const tokenSum = (buckets) => {
  let sum = 0;
  for (let i = 0; i < TOKEN_SLOTS; i++) sum += Number(buckets[i]) || 0;
  return sum;
};

export const hasRecordedCost = (buckets) => buckets.length > TOKEN_SLOTS;

const finite = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

/**
 * Adds one reply to `days[day][model]`. `cost` is undefined for agents priced
 * from the local rate table, a number for a cost the agent recorded, and null
 * when such an agent left the cost of this reply out.
 */
export function addUsage(days, day, model, tokens, cost) {
  const byModel = (days[day] = days[day] || {});
  const recorded = cost !== undefined;
  let buckets = byModel[model];
  if (!buckets) buckets = byModel[model] = recorded ? [0, 0, 0, 0, 0, 0, 0] : [0, 0, 0, 0, 0];
  else if (recorded && buckets.length === TOKEN_SLOTS) buckets.push(0, 0);
  let sum = 0;
  for (let i = 0; i < TOKEN_SLOTS; i++) {
    const n = finite(tokens[i]);
    buckets[i] += n;
    sum += n;
  }
  if (!recorded) return;
  const value = Number(cost);
  if (cost !== null && Number.isFinite(value) && value >= 0) buckets[COST_SLOT] += value;
  else buckets[UNRECORDED_SLOT] += sum;
}

// Sum one file's day -> model -> buckets into an account-wide accumulator.
export function mergeDays(into, from) {
  for (const [day, models] of Object.entries(from || {})) {
    const target = (into[day] = into[day] || {});
    for (const [model, buckets] of Object.entries(models)) {
      const current = target[model];
      if (!current) {
        target[model] = [...buckets];
        continue;
      }
      if (buckets.length > current.length) current.push(...new Array(buckets.length - current.length).fill(0));
      for (let i = 0; i < buckets.length; i++) current[i] += buckets[i];
    }
  }
}

// Local calendar day of an epoch-ms time or ISO timestamp.
export function localDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

// A timestamp given as ISO text, epoch seconds or epoch milliseconds, in ms.
export function epochMs(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value === "string" && value) {
    if (/^\d+(\.\d+)?$/.test(value)) return epochMs(Number(value));
    const parsed = Date.parse(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

// The transcript's working folder and its first and last priced reply, kept
// in the resume state so the per-session view can still read them after an
// incremental resume.
export function sessionState(state) {
  const session = state && state.session && typeof state.session === "object" ? state.session : {};
  return {
    cwd: typeof session.cwd === "string" ? session.cwd : null,
    firstAt: Number.isFinite(session.firstAt) ? session.firstAt : null,
    lastAt: Number.isFinite(session.lastAt) ? session.lastAt : null,
    // The model of the most recent reply: what the session is running now.
    lastModel: typeof session.lastModel === "string" ? session.lastModel : null,
  };
}

export function noteSession(session, at, cwd, model) {
  if (typeof cwd === "string" && cwd && !session.cwd) session.cwd = cwd;
  if (!Number.isFinite(at)) return;
  if (session.firstAt === null || at < session.firstAt) session.firstAt = at;
  if (session.lastAt === null || at >= session.lastAt) {
    session.lastAt = at;
    if (typeof model === "string" && model) session.lastModel = model;
  }
}

// Bytes per read: bounds peak memory per file and the sync work per tick.
const READ_CHUNK = 1024 * 1024;

// Stream `file` from byte `start`, calling onLine(line) for every complete
// (newline-terminated) line. Chunks are split on the raw bytes, so a multi-byte
// character straddling two reads is decoded intact and only the unfinished tail
// is carried between reads. Resolves with the byte offset just past the last
// line consumed; a trailing line without a newline is consumed only if it is
// already valid JSON (a fully written record awaiting its "\n"), otherwise it
// is left for the next scan, which resumes from the returned offset.
export async function readLines(file, start, onLine) {
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

export function parseJson(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

// Every file below `dir` whose name passes `accept`, bounded so a huge or
// looping tree cannot stall a scan.
export function walkFiles(dir, accept, limit = 50_000) {
  const out = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    let entries;
    try {
      entries = fs.readdirSync(stack.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(e.parentPath || e.path || dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.isFile() && accept(e.name, p) && out.length < limit) out.push(p);
    }
  }
  return out;
}

// Files directly in `dir` passing `accept` and written at or after `since`.
export async function recentFiles(dir, since, accept) {
  let entries;
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    if (!entry.isFile() || !accept(entry.name)) continue;
    const file = path.join(dir, entry.name);
    try {
      const { mtimeMs } = await fs.promises.stat(file);
      if (mtimeMs >= since) files.push({ file, mtimeMs });
    } catch {
      /* removed meanwhile */
    }
  }
  return files;
}

export const isJsonl = (name) => name.endsWith(".jsonl");

export function isDirectory(dir) {
  try {
    return fs.statSync(dir).isDirectory();
  } catch {
    return false;
  }
}

export function isFile(file) {
  try {
    return fs.statSync(file).isFile();
  } catch {
    return false;
  }
}

// XDG data home (~/.local/share unless overridden), which several agents use
// on macOS too.
export function dataHome(home) {
  return process.env.XDG_DATA_HOME || path.join(home, ".local", "share");
}
