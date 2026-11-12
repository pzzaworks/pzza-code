// OpenCode and its forks keep every session in one SQLite database whose
// `session` table carries the cost the agent computed, token totals, the
// folder, the model (JSON {"id", "providerID"}) and created/updated times in
// epoch milliseconds. Subagent sessions point at their parent via parent_id.
import os from "node:os";
import path from "node:path";
import { addUsage, dataHome, isFile, localDay } from "./records.js";
import { columnOr, readDatabase } from "./sqlite.js";

function sessionModel(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    const model = JSON.parse(value);
    if (model && typeof model === "object" && typeof model.id === "string" && model.id) {
      return typeof model.providerID === "string" && model.providerID ? `${model.providerID}/${model.id}` : model.id;
    }
  } catch {
    /* a plain model id */
  }
  return /^[\w.:/@-]{1,160}$/.test(value) ? value : null;
}

function selectList(columns) {
  return [
    `"id" AS id`,
    `${columnOr(columns, "parent_id")} AS parent`,
    `${columnOr(columns, "directory")} AS dir`,
    `${columnOr(columns, "model")} AS model`,
    `${columnOr(columns, "cost")} AS cost`,
    `${columnOr(columns, "tokens_input", "0")} AS input`,
    `${columnOr(columns, "tokens_output", "0")} AS output`,
    `${columnOr(columns, "tokens_reasoning", "0")} AS reasoning`,
    `${columnOr(columns, "tokens_cache_read", "0")} AS cacheRead`,
    `${columnOr(columns, "tokens_cache_write", "0")} AS cacheWrite`,
    `"time_created" AS created`,
    `${columnOr(columns, "time_updated", '"time_created"')} AS updated`,
  ].join(", ");
}

// Reasoning tokens are billed as output.
const rowTokens = (row) => [row.input, (Number(row.output) || 0) + (Number(row.reasoning) || 0), row.cacheRead, row.cacheWrite, 0];
const rowCost = (row) => (row.cost === null || row.cost === undefined ? null : Number(row.cost));

/**
 * An adapter for an OpenCode-family database. `databases(home)` lists the
 * candidate files, first match wins.
 */
export function opencodeFamilyAdapter({ id, label, databases }) {
  const findDb = () => databases(os.homedir()).find(isFile) ?? null;
  return {
    id,
    label,
    pricingBasis: "agent-recorded",
    roots() {
      const file = findDb();
      return file ? [{ provider: id, dir: path.dirname(file), file, label }] : [];
    },
    // Each session's recorded cost and tokens, on the day it was created.
    async records(root, horizon) {
      const rows = await readDatabase(root.file, (db, columns) => {
        const have = columns("session");
        if (!have.has("id") || !have.has("time_created")) return null;
        return db.prepare(`SELECT ${selectList(have)} FROM session WHERE time_created >= ?`).all(horizon);
      });
      if (!rows) return null;
      const days = {};
      for (const row of rows) {
        const day = localDay(Number(row.created));
        if (!day) continue;
        addUsage(days, day, sessionModel(row.model) ?? id, rowTokens(row), rowCost(row));
      }
      return days;
    },
    // The newest session in `cwd` active since `since`, with its subagent
    // sessions, as one entry.
    async sessionEntry(root, cwd, since) {
      return readDatabase(root.file, (db, columns) => {
        const have = columns("session");
        if (!have.has("id") || !have.has("time_created") || !have.has("directory")) return null;
        const select = selectList(have);
        const updated = have.has("time_updated") ? "time_updated" : "time_created";
        const parentFilter = have.has("parent_id") ? "AND parent_id IS NULL" : "";
        const main = db.prepare(`SELECT ${select} FROM session WHERE directory = ? AND ${updated} >= ? ${parentFilter} ORDER BY ${updated} DESC LIMIT 1`).get(cwd, since);
        if (!main) return null;
        const children = have.has("parent_id")
          ? db.prepare(`SELECT ${select} FROM session WHERE parent_id = ? LIMIT 200`).all(main.id)
          : [];
        const days = {};
        let lastAt = Number(main.updated);
        for (const row of [main, ...children]) {
          addUsage(days, localDay(Number(row.created)) ?? "", sessionModel(row.model) ?? id, rowTokens(row), rowCost(row));
          if (Number(row.updated) > lastAt) lastAt = Number(row.updated);
        }
        return {
          days,
          subagents: children.length,
          state: { session: { cwd, firstAt: Number(main.created), lastAt, lastModel: sessionModel(main.model) } },
        };
      });
    },
  };
}

export const opencodeAdapter = opencodeFamilyAdapter({
  id: "opencode",
  label: "OpenCode",
  databases: (home) => [
    process.env.OPENCODE_DB,
    path.join(dataHome(home), "opencode", "opencode.db"),
    path.join(home, ".opencode", "opencode.db"),
  ].filter(Boolean),
});

// Kilo Code CLI is an OpenCode fork with the same session table. Stable
// releases use kilo.db; $KILO_DB (absolute, or relative to the data folder)
// overrides it.
export const kiloAdapter = opencodeFamilyAdapter({
  id: "kilo",
  label: "Kilo Code",
  databases: (home) => {
    const dir = path.join(dataHome(home), "kilo");
    const override = process.env.KILO_DB;
    return [override ? path.resolve(dir, override) : null, path.join(dir, "kilo.db")].filter(Boolean);
  },
});
