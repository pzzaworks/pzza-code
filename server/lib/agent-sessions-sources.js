// Where each coding agent keeps its past conversations, and how one listing row
// is read from there (agent-sessions-scan.js runs them). Everything on disk is
// untrusted: every field is optional and checked, and nothing but the row
// fields below ever leaves this module (never a path or a message body).
//
// A source is { agent, roots(), ... } with one of two readers:
//   files(root, scope)  -> [{ file, mtimeMs, size }] candidate transcripts,
//                          narrowed by scope { cwd, under, since } where the
//                          layout allows (the caller filters exactly later)
//   read(ends, ctx)     -> row fields or null, from the first and last lines
//                          of one file ({ head, tail } parsed JSON records;
//                          ctx.more() reads a little past the head), or from
//                          one small JSON file ({ json }) with format "json"
//   titles?(root)       -> Map of id -> title kept outside the transcripts
// or
//   rows(root, scope, limit) -> row fields, newest first, from a database
//
// Row fields: { id, cwd?, latestCwd?, title?, prompt?, startedAt?, lastAt?,
// branch?, messages? }; `title` is a summary the agent stored, `prompt` the
// first thing the user asked, used when there is no title, `latestCwd` the
// folder it worked in last when that can change during a conversation.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { usageAdapter } from "./agent-usage/index.js";
import { claudeProjectSlug } from "./agent-usage/claude.js";
import { gooseTime } from "./agent-usage/goose.js";
import { piSessionFolder } from "./agent-usage/pi.js";
import { epochMs, isFile } from "./agent-usage/records.js";
import { columnOr, readDatabase } from "./agent-usage/sqlite.js";

// Stat calls one root may spend finding candidates, so a huge tree cannot stall
// a scan; candidates kept per root, newest first.
export const MAX_DISCOVERY = 20_000;
export const MAX_FILES_PER_ROOT = 2000;

const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const UUID_IN_NAME = /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;
const DAY_MS = 86_400_000;

const text = (value) => (typeof value === "string" ? value : "");

// The plain text of a message's content: a string, or text parts in the
// shapes agents use ({ type: "text" | "input_text", text } or { text }).
export function contentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return content && typeof content === "object" && typeof content.text === "string" ? content.text : "";
  const parts = [];
  for (const part of content.slice(0, 50)) {
    if (typeof part === "string") parts.push(part);
    else if (part && typeof part === "object" && typeof part.text === "string" && (part.type === undefined || part.type === "text" || part.type === "input_text")) parts.push(part.text);
  }
  return parts.join(" ");
}

// Text the agent itself injects into a user turn (command wrappers, context
// blocks, reminders) is not what the user asked.
export function userPrompt(value) {
  const prompt = text(value).trim();
  if (!prompt || /^<[A-Za-z][\w-]*[ >]/.test(prompt) || prompt.startsWith("# AGENTS.md instructions") || prompt.startsWith("Caveat: ")) return "";
  return prompt;
}

// Time span of the records that carry a timestamp.
function span(records, field = "timestamp") {
  let startedAt = null;
  let lastAt = null;
  for (const record of records) {
    const at = epochMs(record[field]);
    if (at === null) continue;
    if (startedAt === null || at < startedAt) startedAt = at;
    if (lastAt === null || at > lastAt) lastAt = at;
  }
  return { startedAt, lastAt };
}

async function entries(dir) {
  try {
    return await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

/**
 * Files directly in each of `dirs` that pass `accept`, with their size and
 * time, skipping those last written before `since`. `budget` ({ left }) bounds
 * the stat calls across a root.
 */
export async function statFiles(dirs, accept, since, budget) {
  const out = [];
  for (const dir of dirs) {
    for (const entry of await entries(dir)) {
      if (budget.left <= 0) return out;
      if (!entry.isFile() || !accept(entry.name)) continue;
      budget.left--;
      const file = path.join(dir, entry.name);
      try {
        const { mtimeMs, size } = await fs.promises.stat(file);
        if (mtimeMs >= since) out.push({ file, mtimeMs, size });
      } catch {
        /* removed meanwhile */
      }
    }
  }
  return out;
}

// Subfolders of `dir`, each with its name, for slug-per-folder layouts.
async function subfolders(dir) {
  return (await entries(dir)).filter((entry) => entry.isDirectory()).map((entry) => ({ name: entry.name, dir: path.join(dir, entry.name) }));
}

// The slug folders that can hold conversations of scope.cwd (or every one).
// A slug loses characters, so `under` keeps every folder whose name starts
// with the slug: a superset the exact folder filter narrows later.
async function slugFolders(dir, scope, slug) {
  if (scope.cwd && !scope.under) return [path.join(dir, slug(scope.cwd))];
  const all = await subfolders(dir);
  if (!scope.cwd) return all.map((item) => item.dir);
  const prefix = slug(scope.cwd);
  return all.filter((item) => item.name.startsWith(prefix)).map((item) => item.dir);
}

const isJsonl = (name) => name.endsWith(".jsonl");

// Claude Code: <account>/projects/<folder slug>/<session id>.jsonl. Records
// carry sessionId, cwd, gitBranch, timestamp and isSidechain; a user turn is
// { type: "user", message: { role: "user", content } } (isMeta marks
// injected ones). Titles: { type: "custom-title", customTitle } set by the
// user, { type: "ai-title", aiTitle } generated, { type: "summary", summary }
// from older versions. Subagents log under <session id>/subagents/, which is
// never listed (only files directly in the slug folder are).
const claude = {
  agent: "claude",
  roots: () => usageAdapter("claude").roots(),
  async files(root, scope, budget) {
    const dirs = await slugFolders(path.join(root.dir, "projects"), scope, claudeProjectSlug);
    return statFiles(dirs, (name) => isJsonl(name) && UUID.test(name.slice(0, -6)), scope.since, budget);
  },
  async read({ head: first, tail }, { file, more }) {
    const id = path.basename(file, ".jsonl");
    const hasCwd = (records) => records.some((record) => typeof record.cwd === "string" && record.cwd);
    const hasUser = (records) => records.some((record) => record.type === "user" && record.isMeta !== true);
    // A transcript can open with large file snapshots; then a little more is read.
    const head = (!hasCwd(first) || !hasUser(first)) && more ? [...first, ...await more()] : first;
    const titles = { custom: "", ai: "", summary: "" };
    let cwd = "";
    let latestCwd = "";
    let branch = "";
    let prompt = "";
    let lastPrompt = "";
    for (const record of [...head, ...tail]) {
      if (record.type === "custom-title" && typeof record.customTitle === "string") titles.custom = record.customTitle;
      else if (record.type === "ai-title" && typeof record.aiTitle === "string") titles.ai = record.aiTitle;
      else if (record.type === "summary" && typeof record.summary === "string") titles.summary = record.summary;
      else if (record.type === "last-prompt" && typeof record.lastPrompt === "string") lastPrompt = record.lastPrompt;
      if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
      // A conversation follows its shell's cd, so the tail knows where it ended.
      if (typeof record.cwd === "string" && record.cwd) latestCwd = record.cwd;
      if (typeof record.gitBranch === "string" && record.gitBranch && record.gitBranch !== "HEAD") branch = record.gitBranch;
    }
    for (const record of head) {
      if (record.type !== "user" || record.isMeta === true || record.message?.role !== "user") continue;
      // A sidechain transcript (an older subagent layout) is not a conversation.
      if (record.isSidechain === true) return null;
      prompt = userPrompt(contentText(record.message.content));
      if (prompt) break;
    }
    const title = titles.custom || titles.ai || titles.summary;
    // A file without anything the user asked (a bare /resume) is no conversation.
    if (!title && !prompt && !lastPrompt) return null;
    return { id, cwd, latestCwd, title, prompt: prompt || userPrompt(lastPrompt), branch, ...span([...head, ...tail]) };
  },
};

// The records of the last `bytes` of a small JSONL index file, oldest first.
async function indexTail(file, bytes) {
  let handle;
  try {
    handle = await fs.promises.open(file, "r");
    const { size } = await handle.stat();
    const start = Math.max(0, size - bytes);
    const buffer = Buffer.alloc(size - start);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, start);
    let body = buffer.subarray(0, bytesRead).toString("utf8");
    if (start > 0) body = body.slice(body.indexOf("\n") + 1);
    const records = [];
    for (const line of body.split("\n")) {
      if (!line.startsWith("{")) continue;
      try {
        const value = JSON.parse(line);
        if (value && typeof value === "object" && !Array.isArray(value)) records.push(value);
      } catch {
        /* a broken line */
      }
    }
    return records;
  } catch {
    return [];
  } finally {
    await handle?.close().catch(() => {});
  }
}

const INDEX_BYTES = 1024 * 1024;

// Codex: <account>/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl, filed by
// start date (openai/codex codex-rs/protocol/src/protocol.rs). The first line
// is { type: "session_meta", payload: { id, cwd, timestamp, source,
// parent_thread_id?, git?: { branch } } }; a user turn is an event_msg with
// payload { type: "user_message", message }. A subagent's rollout has an
// object `source` ({ subagent } or { internal }) or a parent_thread_id.
// Thread names live in <account>/session_index.jsonl ({ id, thread_name },
// last line wins). Archived conversations (archived_sessions/) and rollouts
// compressed to .jsonl.zst (an opt-in Codex feature) are not listed.
const codex = {
  agent: "codex",
  roots: () => usageAdapter("codex").roots(),
  async files(root, scope, budget) {
    const base = path.join(root.dir, "sessions");
    // Start-date folders, newest first. A conversation started up to a week
    // before `since` can still have been active since then.
    const floor = scope.since > 0 ? scope.since - 7 * DAY_MS : 0;
    const dayStart = (year, month = 1, day = 1) => new Date(year, month - 1, day).getTime();
    const out = [];
    const desc = (list) => list.filter((item) => /^\d+$/.test(item.name)).sort((a, b) => Number(b.name) - Number(a.name));
    for (const year of desc(await subfolders(base))) {
      if (dayStart(Number(year.name) + 1) <= floor) break;
      for (const month of desc(await subfolders(year.dir))) {
        if (dayStart(Number(year.name), Number(month.name) + 1) <= floor) continue;
        for (const day of desc(await subfolders(month.dir))) {
          if (dayStart(Number(year.name), Number(month.name), Number(day.name) + 1) <= floor) continue;
          out.push(...await statFiles([day.dir], (name) => name.startsWith("rollout-") && UUID_IN_NAME.test(name), scope.since, budget));
          if (out.length >= MAX_FILES_PER_ROOT || budget.left <= 0) return out;
        }
      }
    }
    return out;
  },
  async titles(root) {
    const names = new Map();
    for (const record of await indexTail(path.join(root.dir, "session_index.jsonl"), INDEX_BYTES)) {
      if (typeof record.id === "string" && typeof record.thread_name === "string") names.set(record.id, record.thread_name);
    }
    return names;
  },
  read({ head, tail }, { file }) {
    const meta = head.find((record) => record.type === "session_meta")?.payload;
    if (!meta || typeof meta !== "object") return null;
    if ((meta.source && typeof meta.source === "object") || meta.parent_thread_id) return null;
    const id = typeof meta.id === "string" ? meta.id : UUID_IN_NAME.exec(file)?.[1] ?? "";
    let prompt = "";
    for (const record of head) {
      const payload = record.payload;
      if (record.type === "event_msg" && payload?.type === "user_message") prompt = userPrompt(payload.message);
      if (prompt) break;
    }
    if (!prompt) {
      for (const record of head) {
        const payload = record.payload;
        if (record.type === "response_item" && payload?.type === "message" && payload.role === "user") prompt = userPrompt(contentText(payload.content));
        if (prompt) break;
      }
    }
    const times = span([...head, ...tail]);
    return {
      id, cwd: text(meta.cwd), prompt, branch: text(meta.git?.branch),
      startedAt: epochMs(meta.timestamp) ?? times.startedAt, lastAt: times.lastAt,
    };
  },
};

// Qwen Code: <runtime>/projects/<folder slug>/chats/<session id>.jsonl
// (QwenLM/qwen-code packages/core/src/services/chatRecordingService.ts) with
// records { sessionId, cwd, gitBranch, timestamp, type, subtype?,
// isSidechain? }. A user turn is { type: "user" } without a subtype, with
// message.parts [{ text }]; "mod_prompt" provenance is injected. A title is
// { type: "system", subtype: "custom_title", systemPayload: { customTitle } },
// the last one winning.
const qwen = {
  agent: "qwen",
  roots: () => usageAdapter("qwen").roots(),
  async files(root, scope, budget) {
    const slug = (cwd) => cwd.replace(/[^a-zA-Z0-9]/g, "-");
    const dirs = (await slugFolders(path.join(root.dir, "projects"), scope, slug)).map((dir) => path.join(dir, "chats"));
    return statFiles(dirs, (name) => isJsonl(name) && UUID.test(name.slice(0, -6)), scope.since, budget);
  },
  read({ head, tail }, { file }) {
    const id = path.basename(file, ".jsonl");
    let cwd = "";
    let branch = "";
    let title = "";
    let prompt = "";
    for (const record of [...head, ...tail]) {
      if (!cwd && typeof record.cwd === "string") cwd = record.cwd;
      if (typeof record.gitBranch === "string" && record.gitBranch) branch = record.gitBranch;
      if (record.type === "system" && record.subtype === "custom_title" && typeof record.systemPayload?.customTitle === "string") title = record.systemPayload.customTitle;
    }
    for (const record of head) {
      if (record.type !== "user" || record.subtype !== undefined || record.isSidechain === true || record.provenance === "mod_prompt") continue;
      prompt = userPrompt(contentText(record.message?.parts ?? record.message?.content));
      if (prompt) break;
    }
    if (!prompt && !title) return null;
    return { id, cwd, title, prompt, branch, ...span([...head, ...tail]) };
  },
};

// Pi: <sessions>/--<cwd>--/<time>_<id>.jsonl, or flat in a configured folder
// (earendil-works/pi packages/coding-agent/src/core/session-manager.ts). The
// first line is { type: "session", id, timestamp, cwd }; a user turn is
// { type: "message", message: { role: "user", content } }; the latest
// { type: "session_info", name } names the session.
const pi = {
  agent: "pi",
  roots: () => usageAdapter("pi").roots(),
  async files(root, scope, budget) {
    // `under` cannot be narrowed by a --<cwd>-- prefix (its closing "--").
    const dirs = root.flat ? [root.dir]
      : scope.cwd && !scope.under ? [path.join(root.dir, piSessionFolder(scope.cwd))]
        : (await subfolders(root.dir)).map((item) => item.dir);
    return statFiles(dirs, isJsonl, scope.since, budget);
  },
  read({ head, tail }) {
    const header = head[0];
    if (header?.type !== "session" || typeof header.id !== "string") return null;
    let prompt = "";
    for (const record of head) {
      if (record.type !== "message" || record.message?.role !== "user") continue;
      prompt = userPrompt(contentText(record.message.content));
      if (prompt) break;
    }
    const title = [...head, ...tail].findLast((record) => record.type === "session_info" && typeof record.name === "string")?.name ?? "";
    const times = span([...head, ...tail]);
    return { id: header.id, cwd: text(header.cwd), title, prompt, startedAt: epochMs(header.timestamp) ?? times.startedAt, lastAt: times.lastAt };
  },
};

// Gemini CLI: <home>/.gemini/tmp/<project>/chats/session-*.jsonl
// (google-gemini/gemini-cli packages/core/src/services/chatRecordingService.ts).
// The first line is { sessionId, projectHash, startTime, lastUpdated, kind? };
// user turns are { id, timestamp, type: "user", content }, and metadata
// changes are { $set: { summary?, lastUpdated?, ... } }. The folder is not
// recorded: it is <project>'s .project_root file or its projects.json entry.
// Subagents (kind "subagent") log in chats/<parent id>/, which is not listed;
// the same session can sit in a slug and a legacy hash folder (deduplicated).
async function geminiFolders(dir) {
  const folders = new Map();
  try {
    const registry = JSON.parse(await fs.promises.readFile(path.join(dir, "projects.json"), "utf8"))?.projects;
    for (const [folder, slug] of Object.entries(registry && typeof registry === "object" ? registry : {})) {
      if (typeof slug === "string" && folder.startsWith("/")) folders.set(slug, folder);
    }
  } catch {
    /* no registry */
  }
  return folders;
}

const gemini = {
  agent: "gemini",
  roots: () => usageAdapter("gemini").roots(),
  async files(root, scope, budget) {
    const out = [];
    for (const project of await subfolders(path.join(root.dir, "tmp"))) {
      out.push(...await statFiles([path.join(project.dir, "chats")], (name) => name.startsWith("session-") && isJsonl(name), scope.since, budget));
    }
    return out;
  },
  async read({ head, tail }, { file, root }) {
    const header = head[0];
    if (!header || typeof header.sessionId !== "string" || header.type !== undefined || header.kind === "subagent") return null;
    let prompt = "";
    for (const record of head) {
      if (record.type !== "user") continue;
      prompt = userPrompt(contentText(record.content));
      if (prompt) break;
    }
    const project = path.dirname(path.dirname(file));
    let cwd = (await geminiFolders(root.dir)).get(path.basename(project)) ?? "";
    if (!cwd) {
      try {
        const folder = (await fs.promises.readFile(path.join(project, ".project_root"), "utf8")).trim();
        if (folder.startsWith("/")) cwd = folder;
      } catch {
        /* a legacy hash folder: the folder is unknown */
      }
    }
    let summary = "";
    let updated = epochMs(header.lastUpdated);
    for (const record of [...head, ...tail]) {
      const set = record.$set;
      if (!set || typeof set !== "object") continue;
      if (typeof set.summary === "string") summary = set.summary;
      const at = epochMs(set.lastUpdated);
      if (at !== null && (updated === null || at > updated)) updated = at;
    }
    const times = span([...head, ...tail]);
    return {
      id: header.sessionId, cwd, title: summary, prompt,
      startedAt: epochMs(header.startTime) ?? times.startedAt,
      lastAt: Math.max(updated ?? 0, times.lastAt ?? 0) || null,
    };
  },
};

// Kimi Code: <root>/sessions/<workspace>/<session id>/state.json
// (MoonshotAI/kimi-code packages/agent-core-v2/src/session/sessionMetadata):
// { id, title?, lastPrompt?, createdAt, updatedAt (epoch ms), archived, cwd? }.
// Subagents live inside the session folder and are never listed.
const kimi = {
  agent: "kimi",
  format: "json",
  roots: () => usageAdapter("kimi").roots(),
  async files(root, scope, budget) {
    const out = [];
    for (const workspace of await subfolders(path.join(root.dir, "sessions"))) {
      for (const session of await subfolders(workspace.dir)) {
        out.push(...await statFiles([session.dir], (name) => name === "state.json", scope.since, budget));
        if (budget.left <= 0) return out;
      }
    }
    return out;
  },
  read({ json }) {
    if (!json || json.archived === true || typeof json.id !== "string") return null;
    return {
      id: json.id, cwd: text(json.cwd), title: text(json.title), prompt: userPrompt(json.lastPrompt),
      startedAt: epochMs(json.createdAt), lastAt: epochMs(json.updatedAt),
    };
  },
};

// Grok Build: <root>/sessions/<encoded cwd>/<session id>/summary.json
// (xai-org/grok-build xai-grok-shell/src/session/persistence.rs):
// { info: { id, cwd }, generated_title?, session_summary, num_messages,
// head_branch?, session_kind?, hidden?, created_at, updated_at,
// last_active_at? }. Hidden, subagent and headless (-p) sessions are left out.
const grok = {
  agent: "grok",
  format: "json",
  roots: () => usageAdapter("grok").roots(),
  async files(root, scope, budget) {
    const out = [];
    for (const project of await subfolders(root.dir)) {
      for (const session of await subfolders(project.dir)) {
        out.push(...await statFiles([session.dir], (name) => name === "summary.json", scope.since, budget));
        if (budget.left <= 0) return out;
      }
    }
    return out;
  },
  read({ json }) {
    const kind = text(json?.session_kind);
    if (!json || json.hidden === true || kind.startsWith("subagent") || kind === "headless" || typeof json.info?.id !== "string") return null;
    return {
      id: json.info.id, cwd: text(json.info.cwd), title: text(json.generated_title) || text(json.session_summary),
      branch: text(json.head_branch), messages: json.num_messages,
      startedAt: epochMs(json.created_at), lastAt: epochMs(json.last_active_at) ?? epochMs(json.updated_at),
    };
  },
};

// A folder filter for SQL: exact, or the folder and everything under it.
function folderWhere(column, scope) {
  if (!scope.cwd) return { sql: "", params: [] };
  if (!scope.under) return { sql: ` AND ${column} = ?`, params: [scope.cwd] };
  const prefix = scope.cwd === "/" ? "/" : `${scope.cwd}/`;
  return { sql: ` AND (${column} = ? OR substr(${column}, 1, ?) = ?)`, params: [scope.cwd, prefix.length, prefix] };
}

// "New session - <time>" and "Child session - <time>" are OpenCode's
// placeholders, not titles.
const OPENCODE_PLACEHOLDER = /^(?:New|Child) session - \d{4}-/;

// OpenCode and Kilo (anomalyco/opencode packages/core/src/session/sql.ts): the
// `session_v2` table of OpenCode 2, else the `session` table, each with id,
// title, directory, parent_id (subagents), time_created / time_updated (epoch
// ms) and time_archived.
function opencodeFamily(agent) {
  return {
    agent,
    roots: () => usageAdapter(agent).roots(),
    async rows(root, scope, limit) {
      return readDatabase(root.file, (db, columns) => {
        const table = columns("session_v2").has("id") ? "session_v2" : "session";
        const cols = columns(table);
        if (!cols.has("id") || !cols.has("time_created")) return [];
        const updated = columnOr(cols, "time_updated", '"time_created"');
        const folder = folderWhere('"directory"', cols.has("directory") ? scope : {});
        const where = [
          cols.has("parent_id") ? '"parent_id" IS NULL' : "1",
          cols.has("time_archived") ? '"time_archived" IS NULL' : "1",
        ].join(" AND ");
        const sql = `SELECT "id" AS id, ${columnOr(cols, "title")} AS title, ${columnOr(cols, "directory")} AS cwd,
          "time_created" AS created, ${updated} AS updated FROM "${table}" WHERE ${where}${folder.sql} ORDER BY updated DESC LIMIT ?`;
        return db.prepare(sql).all(...folder.params, limit).map((row) => ({
          id: row.id, cwd: text(row.cwd), title: OPENCODE_PLACEHOLDER.test(text(row.title)) ? "" : text(row.title),
          startedAt: epochMs(row.created), lastAt: epochMs(row.updated),
        }));
      });
    },
  };
}

// goose (aaif-goose/goose crates/goose/src/session/session_manager.rs):
// sessions.db, table `sessions` with id (YYYYMMDD_<n>), name (the title;
// description is its legacy fallback), working_dir, session_type ("user" for
// conversations), parent_session_id, archived_at, created_at / updated_at.
const goose = {
  agent: "goose",
  roots: () => usageAdapter("goose").roots(),
  async rows(root, scope, limit) {
    return readDatabase(root.file, (db, columns) => {
      const cols = columns("sessions");
      if (!cols.has("id")) return [];
      const where = [
        cols.has("session_type") ? `"session_type" = 'user'` : "1",
        cols.has("archived_at") ? '"archived_at" IS NULL' : "1",
        cols.has("parent_session_id") ? '"parent_session_id" IS NULL' : "1",
      ].join(" AND ");
      const folder = folderWhere('"working_dir"', cols.has("working_dir") ? scope : {});
      const order = cols.has("updated_at") ? '"updated_at"' : cols.has("created_at") ? '"created_at"' : '"id"';
      const sql = `SELECT "id" AS id, ${columnOr(cols, "name")} AS name, ${columnOr(cols, "description")} AS description,
        ${columnOr(cols, "working_dir")} AS cwd, ${columnOr(cols, "created_at")} AS created, ${columnOr(cols, "updated_at")} AS updated
        FROM "sessions" WHERE ${where}${folder.sql} ORDER BY ${order} DESC LIMIT ?`;
      return db.prepare(sql).all(...folder.params, limit).map((row) => ({
        id: row.id, cwd: text(row.cwd), title: text(row.name) || text(row.description),
        startedAt: gooseTime(row.created), lastAt: gooseTime(row.updated),
      }));
    });
  },
};

// Crush (charmbracelet/crush internal/db/migrations): one crush.db per
// project, listed in the global projects.json, with table `sessions` (id,
// parent_session_id for subagents, title, message_count, created_at /
// updated_at in epoch seconds). The folder is the project's.
const MAX_CRUSH_PROJECTS = 200;
function crushProjects(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, "projects.json"), "utf8"))?.projects;
    if (!Array.isArray(list)) return [];
    return list.filter((item) => item && typeof item.path === "string" && path.isAbsolute(item.path)).slice(0, MAX_CRUSH_PROJECTS).map((item) => ({
      cwd: path.resolve(item.path),
      file: path.join(typeof item.data_dir === "string" && path.isAbsolute(item.data_dir) ? item.data_dir : path.join(item.path, ".crush"), "crush.db"),
    }));
  } catch {
    return [];
  }
}

const inScope = (cwd, scope) => !scope.cwd || cwd === scope.cwd || (scope.under && cwd.startsWith(scope.cwd === "/" ? "/" : `${scope.cwd}/`));

const crush = {
  agent: "crush",
  roots: () => usageAdapter("crush").roots(),
  async rows(root, scope, limit) {
    const out = [];
    for (const project of crushProjects(root.dir)) {
      if (!inScope(project.cwd, scope) || !isFile(project.file)) continue;
      const rows = await readDatabase(project.file, (db, columns) => {
        const cols = columns("sessions");
        if (!cols.has("id")) return [];
        const order = cols.has("updated_at") ? '"updated_at"' : '"id"';
        const sql = `SELECT "id" AS id, ${columnOr(cols, "title")} AS title, ${columnOr(cols, "message_count")} AS messages,
          ${columnOr(cols, "created_at")} AS created, ${columnOr(cols, "updated_at")} AS updated FROM "sessions"
          WHERE ${cols.has("parent_session_id") ? '"parent_session_id" IS NULL' : "1"} ORDER BY ${order} DESC LIMIT ?`;
        return db.prepare(sql).all(limit);
      });
      for (const row of rows ?? []) {
        out.push({ id: row.id, cwd: project.cwd, title: text(row.title), messages: row.messages, startedAt: epochMs(row.created), lastAt: epochMs(row.updated) });
      }
    }
    return out;
  },
};

// Cline (cline/cline sdk shared/src/db/sqlite-db.ts): ~/.cline/data/db/
// sessions.db (older builds: data/sessions/sessions.db), table `sessions` with
// session_id, cwd, prompt, started_at, updated_at (ISO text), is_subagent,
// parent_session_id and metadata_json ({ title?, git?: { branch } }).
const cline = {
  agent: "cline",
  roots() {
    const data = path.join(os.homedir(), ".cline", "data");
    const file = [path.join(data, "db", "sessions.db"), path.join(data, "sessions", "sessions.db")].find(isFile);
    return file ? [{ dir: path.dirname(file), file }] : [];
  },
  async rows(root, scope, limit) {
    return readDatabase(root.file, (db, columns) => {
      const cols = columns("sessions");
      if (!cols.has("session_id")) return [];
      const where = [
        cols.has("is_subagent") ? '"is_subagent" = 0' : "1",
        cols.has("parent_session_id") ? '"parent_session_id" IS NULL' : "1",
      ].join(" AND ");
      const folder = folderWhere('"cwd"', cols.has("cwd") ? scope : {});
      const order = cols.has("updated_at") ? '"updated_at"' : '"session_id"';
      const sql = `SELECT "session_id" AS id, ${columnOr(cols, "cwd")} AS cwd, ${columnOr(cols, "prompt")} AS prompt,
        ${columnOr(cols, "metadata_json")} AS metadata, ${columnOr(cols, "started_at")} AS created, ${columnOr(cols, "updated_at")} AS updated
        FROM "sessions" WHERE ${where}${folder.sql} ORDER BY ${order} DESC LIMIT ?`;
      return db.prepare(sql).all(...folder.params, limit).map((row) => {
        let metadata = null;
        try {
          metadata = typeof row.metadata === "string" && row.metadata.length <= 65_536 ? JSON.parse(row.metadata) : null;
        } catch {
          /* no metadata */
        }
        return {
          id: row.id, cwd: text(row.cwd), title: text(metadata?.title), prompt: userPrompt(row.prompt), branch: text(metadata?.git?.branch),
          startedAt: epochMs(row.created), lastAt: epochMs(row.updated),
        };
      });
    });
  },
};

// In catalog order.
export const AGENT_SESSION_SOURCES = [
  claude, codex, opencodeFamily("opencode"), gemini, pi, cline, goose, qwen, crush, opencodeFamily("kilo"), grok, kimi,
];
