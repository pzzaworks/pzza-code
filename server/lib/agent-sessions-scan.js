// Lists past coding-agent conversations on this device from each agent's own
// files (agent-sessions-sources.js), newest first, for GET /agent-sessions.
// Runs inside the agent-sessions worker so a cold scan never stalls the
// terminal bridge.
//
// Cost: candidates are found with stat calls only, and a transcript is read
// only at its two ends (HEAD_BYTES and TAIL_BYTES), never in full. A file's
// row is kept per (file, size, mtime), so a rescan of unchanged files reads
// nothing but stats. A scan that runs past its budget answers with what it
// has (`partial`) and keeps going for the next request.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { sessionAgent, validAgentAccount } from "./session-agents.js";
import { redactTerminalOutput } from "./terminal-redaction.js";
import { AGENT_SESSION_SOURCES, MAX_DISCOVERY, MAX_FILES_PER_ROOT } from "./agent-sessions-sources.js";

export const HEAD_BYTES = 64 * 1024;
export const TAIL_BYTES = 32 * 1024;
// A source may read this much more after the head when the head held too
// little (a transcript that opens with large snapshots).
export const MORE_BYTES = 448 * 1024;
// Largest metadata file (format "json") a source reads whole.
const JSON_MAX_BYTES = 256 * 1024;
export const TITLE_MAX_LENGTH = 160;
const CACHE_LIMIT = 5000;
const DATABASE_ROWS = 2000;
// Transcripts read at once.
const READ_BATCH = 8;
// A finished scan answers repeated requests for the same scope this long.
const FRESH_MS = 15_000;
// Scopes whose scans are kept.
const SCAN_LIMIT = 16;
const MAX_ID_LENGTH = 128;
const MAX_CWD_LENGTH = 4096;
const MAX_BRANCH_LENGTH = 256;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;

// Complete JSON object lines of `text`, parsed; `cutStart` drops a first line
// that began before the read, `cutEnd` a last one that goes on after it.
function records(text, cutStart, cutEnd) {
  let body = text;
  if (cutStart) {
    const newline = body.indexOf("\n");
    body = newline < 0 ? "" : body.slice(newline + 1);
  }
  if (cutEnd) body = body.slice(0, body.lastIndexOf("\n") + 1);
  const out = [];
  for (const line of body.split("\n")) {
    if (!line || line[0] !== "{") continue;
    try {
      const value = JSON.parse(line);
      if (value && typeof value === "object" && !Array.isArray(value)) out.push(value);
    } catch {
      /* a broken line */
    }
  }
  return out;
}

async function readText(handle, start, length) {
  const buffer = Buffer.alloc(Math.max(0, length));
  const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
  return buffer.subarray(0, bytesRead).toString("utf8");
}

/** The complete records in bytes [start, start + length) of a JSONL file. */
export async function readRange(file, size, start, length) {
  const end = Math.min(size, start + length);
  if (start >= end) return [];
  const handle = await fs.promises.open(file, "r");
  try {
    return records(await readText(handle, start, end - start), start > 0, end < size);
  } finally {
    await handle.close();
  }
}

// The two ends of a JSONL file as parsed records: the first HEAD_BYTES and,
// past those, the last TAIL_BYTES. Only complete lines are used.
export async function readEnds(file, size) {
  const handle = await fs.promises.open(file, "r");
  try {
    const head = records(await readText(handle, 0, Math.min(size, HEAD_BYTES)), false, size > HEAD_BYTES);
    if (size <= HEAD_BYTES) return { head, tail: [] };
    const start = Math.max(HEAD_BYTES, size - TAIL_BYTES);
    return { head, tail: records(await readText(handle, start, size - start), true, false) };
  } finally {
    await handle.close();
  }
}

/** One line of at most TITLE_MAX_LENGTH characters with secrets redacted. */
export function sessionTitle(value) {
  if (typeof value !== "string" || !value.trim()) return "";
  // Redact line by line first (some rules mask a whole line), then fold.
  const { text } = redactTerminalOutput(value.slice(0, 4000));
  const line = text.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim();
  const characters = Array.from(line);
  return characters.length > TITLE_MAX_LENGTH ? `${characters.slice(0, TITLE_MAX_LENGTH - 1).join("").trimEnd()}…` : line;
}

const finiteTime = (value) => (typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.round(value) : null);

// Checks and shapes the fields a source read; null drops the row.
function finishRow(source, root, fields, fallback) {
  if (!fields || typeof fields !== "object") return null;
  const id = typeof fields.id === "string" ? fields.id : typeof fields.id === "number" ? String(fields.id) : "";
  if (!id || id.length > MAX_ID_LENGTH || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(id)) return null;
  let cwd = typeof fields.cwd === "string" ? fields.cwd : "";
  if (cwd.length > 1) cwd = cwd.replace(/\/+$/, "");
  if (!cwd.startsWith("/") || cwd.length > MAX_CWD_LENGTH || CONTROL.test(cwd) || path.posix.normalize(cwd) !== cwd) cwd = "";
  const lastAt = finiteTime(fields.lastAt) ?? fallback.lastAt;
  const startedAt = Math.min(finiteTime(fields.startedAt) ?? lastAt, lastAt);
  const branch = typeof fields.branch === "string" && fields.branch.length <= MAX_BRANCH_LENGTH && !CONTROL.test(fields.branch) ? fields.branch : "";
  const messages = Number.isSafeInteger(fields.messages) && fields.messages >= 0 ? fields.messages : null;
  const account = root.account ?? accountName(source.agent, root.dir);
  return {
    agent: source.agent, id, cwd,
    title: sessionTitle(fields.title) || sessionTitle(fields.prompt),
    startedAt, lastAt,
    ...(branch ? { branch } : {}),
    ...(messages !== null ? { messages } : {}),
    ...(fallback.bytes !== undefined ? { bytes: fallback.bytes } : {}),
    ...(account ? { account } : {}),
  };
}

// The absolute folder of a non-default account ("/Users/me/.claude-work"), if
// any: the app resumes the conversation with exactly that account.
function accountName(agent, dir) {
  const choice = sessionAgent(agent);
  const folder = choice?.account?.folder;
  if (!folder || typeof dir !== "string") return "";
  return path.basename(dir) !== folder && validAgentAccount(choice, dir) ? dir : "";
}

// How a row can be reopened: by id, as the newest of its folder, or not.
function resumeKinds(rows) {
  const newest = new Set();
  const seen = new Set();
  for (const row of rows) {
    const key = `${row.agent}\n${row.account ?? ""}\n${row.cwd}`;
    if (!seen.has(key)) {
      seen.add(key);
      newest.add(row);
    }
  }
  return rows.map((row) => {
    const resume = sessionAgent(row.agent)?.resume;
    const kind = resume?.byId ? "id"
      : resume?.kind === "continue-last" && resume.scope === "directory" && row.cwd && newest.has(row) ? "last" : "none";
    return { ...row, resume: kind };
  });
}

const newestFirst = (a, b) => b.lastAt - a.lastAt || (a.agent < b.agent ? -1 : a.agent > b.agent ? 1 : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

const underFolder = (cwd, folder, under) => cwd === folder || (under && cwd.startsWith(folder === "/" ? "/" : `${folder}/`));

/**
 * Filters, counts and pages `rows` (newest first, deduplicated) for a
 * validated query. Conversations started in the home folder itself (headless
 * runs, quick chats) are left out unless that folder is asked for.
 */
export function selectAgentSessions(rows, query, home = os.homedir()) {
  const q = query.q ? query.q.toLowerCase() : "";
  const matches = (row) => {
    if (row.cwd === home && query.cwd !== home) return false;
    if (query.cwd && !(row.cwd && underFolder(row.cwd, query.cwd, query.under))) return false;
    if (query.since && row.lastAt < query.since) return false;
    if (q && !(row.title.toLowerCase().includes(q) || row.cwd.toLowerCase().includes(q) || (row.branch ?? "").toLowerCase().includes(q) || row.id.toLowerCase().startsWith(q))) return false;
    return true;
  };
  const agents = {};
  const selected = [];
  for (const row of rows) {
    if (!matches(row)) continue;
    agents[row.agent] = (agents[row.agent] ?? 0) + 1;
    if (!query.agent || row.agent === query.agent) selected.push(row);
  }
  const offset = query.offset ?? 0;
  const limit = query.limit ?? 150;
  return { sessions: selected.slice(offset, offset + limit), total: selected.length, agents };
}

/**
 * A scanner with its own caches. `sources` and `home` are injectable for
 * tests; `budgetMs` bounds how long one request waits for a cold scan.
 */
export function createAgentSessionsScanner({ sources = AGENT_SESSION_SOURCES, home = () => os.homedir(), budgetMs = 8000, freshMs = FRESH_MS, now = Date.now } = {}) {
  const fileRows = new Map();
  const scans = new Map();
  const stats = { reads: 0 };

  function cached(file, size, mtimeMs) {
    const entry = fileRows.get(file);
    if (!entry || entry.size !== size || entry.mtimeMs !== mtimeMs) return undefined;
    fileRows.delete(file);
    fileRows.set(file, entry);
    return entry.row;
  }

  function remember(file, size, mtimeMs, row) {
    fileRows.delete(file);
    fileRows.set(file, { size, mtimeMs, row });
    while (fileRows.size > CACHE_LIMIT) fileRows.delete(fileRows.keys().next().value);
  }

  async function readFile(source, root, candidate) {
    const known = cached(candidate.file, candidate.size, candidate.mtimeMs);
    if (known !== undefined) return known;
    let row = null;
    try {
      stats.reads++;
      const fallback = { lastAt: Math.round(candidate.mtimeMs), bytes: candidate.size };
      if (source.format === "json") {
        // A small metadata file, read whole; a large one is not what it should be.
        if (candidate.size <= JSON_MAX_BYTES) {
          const json = JSON.parse(await fs.promises.readFile(candidate.file, "utf8"));
          row = finishRow(source, root, await source.read({ json: json && typeof json === "object" && !Array.isArray(json) ? json : null }, { file: candidate.file, root }), { lastAt: fallback.lastAt });
        }
      } else {
        const ends = await readEnds(candidate.file, candidate.size);
        const more = () => readRange(candidate.file, candidate.size, HEAD_BYTES, MORE_BYTES);
        row = finishRow(source, root, await source.read(ends, { file: candidate.file, root, more }), fallback);
      }
    } catch {
      row = null;
    }
    remember(candidate.file, candidate.size, candidate.mtimeMs, row);
    return row;
  }

  // One scan of every source for a scope; rows land in `scan.rows` as they
  // are read, so a request that stops waiting can answer with them.
  async function run(scan, scope) {
    const found = new Map();
    const add = (row) => {
      if (!row) return;
      const key = `${row.agent}\n${row.id}`;
      const known = found.get(key);
      if (!known || row.lastAt > known.lastAt) found.set(key, row);
    };
    // A row without any time (a database row missing both times) is left out.
    const publish = () => { scan.rows = resumeKinds([...found.values()].filter((row) => row.lastAt > 0).sort(newestFirst)); };
    const candidates = [];
    for (const source of sources) {
      let roots = [];
      try {
        roots = source.roots();
      } catch {
        /* one agent's unreadable folder never hides the others */
      }
      for (const root of roots) {
        try {
          if (source.rows) {
            for (const fields of (await source.rows(root, scope, DATABASE_ROWS)) ?? []) add(finishRow(source, root, fields, { lastAt: 0 }));
            publish();
          } else {
            const files = await source.files(root, scope, { left: MAX_DISCOVERY });
            files.sort((a, b) => b.mtimeMs - a.mtimeMs);
            // Titles kept beside the transcripts change without them, so they
            // are read every scan and never cached with a file's row.
            const titles = source.titles ? await source.titles(root).catch(() => null) : null;
            for (const candidate of files.slice(0, MAX_FILES_PER_ROOT)) candidates.push({ source, root, candidate, titles });
          }
        } catch {
          /* skip this root */
        }
      }
    }
    publish();
    // Newest first across agents, so a partial answer holds the newest rows.
    candidates.sort((a, b) => b.candidate.mtimeMs - a.candidate.mtimeMs);
    let publishedAt = Date.now();
    const titled = (row, titles) => {
      const title = row && titles?.get(row.id);
      return title && sessionTitle(title) ? { ...row, title: sessionTitle(title) } : row;
    };
    for (let index = 0; index < candidates.length; index += READ_BATCH) {
      const batch = candidates.slice(index, index + READ_BATCH);
      const rows = await Promise.all(batch.map(async ({ source, root, candidate, titles }) => titled(await readFile(source, root, candidate), titles)));
      for (const row of rows) add(row);
      // Sorting every batch would cost more than the reads; a few times a second is enough.
      if (Date.now() - publishedAt > 250) {
        publish();
        publishedAt = Date.now();
      }
    }
    publish();
  }

  function scopeOf(query) {
    // `since` narrows discovery only to the hour, so one scan serves the
    // requests of a modal that asks again a few seconds later.
    const since = query.since ? Math.floor(query.since / 3_600_000) * 3_600_000 : 0;
    return { cwd: query.cwd ?? "", under: query.under === true, since };
  }

  function start(scope, key, previous) {
    const scan = { at: now(), rows: previous?.rows ?? [], done: false, previous: previous?.done ? previous : null, promise: null };
    scan.promise = run(scan, scope).catch(() => {}).finally(() => {
      scan.done = true;
      scan.at = now();
      scan.previous = null;
    });
    scans.delete(key);
    scans.set(key, scan);
    while (scans.size > SCAN_LIMIT) scans.delete(scans.keys().next().value);
    return scan;
  }

  /** Answers a validated query (see agent-sessions.js parseAgentSessionsQuery). */
  async function list(query) {
    const scope = scopeOf(query);
    const key = JSON.stringify(scope);
    let scan = scans.get(key);
    if (!scan || (scan.done && (query.fresh || now() - scan.at > freshMs))) scan = start(scope, key, scan);
    if (!scan.done) {
      let timer;
      await Promise.race([scan.promise, new Promise((resolve) => { timer = setTimeout(resolve, budgetMs); })]);
      clearTimeout(timer);
    }
    // While a rescan of a scope runs past the budget, the previous complete
    // answer is better than a half-read one.
    const rows = scan.done ? scan.rows : scan.previous?.rows ?? scan.rows;
    return { ...selectAgentSessions(rows, query, home()), partial: !scan.done };
  }

  return { list, stats };
}
