// Crush keeps one SQLite database per project, <data dir>/crush.db, where the
// data dir is the project's .crush folder unless overridden. Its global
// projects.json ($CRUSH_GLOBAL_DATA, else <data>/crush with <data> being
// $XDG_DATA_HOME or ~/.local/share) lists every project:
// { projects: [{ path, data_dir, last_accessed }] }.
// `sessions.cost` is the running USD cost Crush computed, with each subagent
// session's cost already added into its parent, so only top-level sessions
// are summed. Its prompt/completion token columns hold the last step's
// context size rather than totals, so Crush reports cost without tokens.
// Times are epoch seconds; a session's model is its latest assistant message's.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addUsage, dataHome, isFile, localDay } from "./records.js";
import { readDatabase } from "./sqlite.js";

const MAX_PROJECTS = 200;

function globalDir() {
  return process.env.CRUSH_GLOBAL_DATA || path.join(dataHome(os.homedir()), "crush");
}

function projects(dir) {
  try {
    const list = JSON.parse(fs.readFileSync(path.join(dir, "projects.json"), "utf8"))?.projects;
    if (!Array.isArray(list)) return [];
    return list.filter((item) => item && typeof item.path === "string" && path.isAbsolute(item.path)).slice(0, MAX_PROJECTS).map((item) => ({
      path: item.path,
      file: path.join(typeof item.data_dir === "string" && path.isAbsolute(item.data_dir) ? item.data_dir : path.join(item.path, ".crush"), "crush.db"),
    }));
  } catch {
    return [];
  }
}

function model(row) {
  if (typeof row?.model !== "string" || !row.model) return null;
  return typeof row.provider === "string" && row.provider && !row.model.includes("/") ? `${row.provider}/${row.model}` : row.model;
}

// Top-level sessions created (or, with `byUpdate`, last updated) since `since`
// (epoch ms), with their latest model.
function readSessions(file, since, byUpdate = false) {
  return readDatabase(file, (db, columns) => {
    const have = columns("sessions");
    if (!have.has("id") || !have.has("cost") || !have.has("created_at")) return null;
    const updated = have.has("updated_at") ? "updated_at" : "created_at";
    const rootOnly = have.has("parent_session_id") ? "AND parent_session_id IS NULL" : "";
    const sessions = db.prepare(`SELECT id, cost, created_at AS created, ${updated} AS updated FROM sessions WHERE ${byUpdate ? updated : "created_at"} >= ? ${rootOnly}`)
      .all(Math.floor(since / 1000));
    const messages = columns("messages");
    const models = new Map();
    if (messages.has("session_id") && messages.has("model") && messages.has("created_at")) {
      const provider = messages.has("provider") ? "provider" : "NULL";
      const role = messages.has("role") ? "WHERE role = 'assistant' AND model IS NOT NULL" : "WHERE model IS NOT NULL";
      // SQLite returns the other columns of the row holding MAX().
      for (const row of db.prepare(`SELECT session_id AS id, model, ${provider} AS provider, MAX(created_at) AS at FROM messages ${role} GROUP BY session_id`).all()) {
        models.set(row.id, model(row));
      }
    }
    return sessions.map((row) => ({ ...row, model: models.get(row.id) ?? null }));
  });
}

const children = (file, id) => readDatabase(file, (db, columns) =>
  columns("sessions").has("parent_session_id") ? db.prepare("SELECT COUNT(*) AS n FROM sessions WHERE parent_session_id = ?").get(id).n : 0);

export const crushAdapter = {
  id: "crush",
  label: "Crush",
  pricingBasis: "agent-recorded",
  // Crush stores the cost of a session, not how many tokens it used.
  tracksTokens: false,
  roots() {
    const dir = globalDir();
    return isFile(path.join(dir, "projects.json")) ? [{ dir, label: "Crush" }] : [];
  },
  async records(root, horizon) {
    const days = {};
    let readable = false;
    for (const project of projects(root.dir)) {
      if (!isFile(project.file)) continue;
      const rows = await readSessions(project.file, horizon);
      if (!rows) continue;
      readable = true;
      for (const row of rows) {
        const day = localDay(Number(row.created) * 1000);
        if (day) addUsage(days, day, row.model ?? "crush", [0, 0, 0, 0, 0], Number(row.cost));
      }
    }
    return readable ? days : null;
  },
  async sessionEntry(root, cwd, since) {
    const listed = projects(root.dir).find((project) => project.path === cwd);
    const file = listed?.file ?? path.join(cwd, ".crush", "crush.db");
    if (!isFile(file)) return null;
    const rows = await readSessions(file, since, true);
    if (!rows?.length) return null;
    const main = rows.reduce((best, row) => (Number(row.updated) > Number(best.updated) ? row : best));
    const days = {};
    addUsage(days, localDay(Number(main.created) * 1000) ?? "", main.model ?? "crush", [0, 0, 0, 0, 0], Number(main.cost));
    return {
      days,
      subagents: (await children(file, main.id)) ?? 0,
      state: { session: { cwd, firstAt: Number(main.created) * 1000, lastAt: Number(main.updated) * 1000, lastModel: main.model } },
    };
  },
};
