// goose: <data>/goose/sessions/sessions.db (<data> is $XDG_DATA_HOME or
// ~/.local/share, also on macOS; $GOOSE_PATH_ROOT, when absolute, moves it to
// <root>/data/sessions/sessions.db). Each `sessions` row holds that session's
// own running totals: accumulated_{input,output,total,cache_read,cache_write}_tokens
// and accumulated_cost (USD as goose computed or the provider reported it;
// NULL when no turn had a cost), with working_dir, model_config_json
// ({ "model_name": ... }), parent_session_id for subagents, and created_at /
// updated_at as UTC "YYYY-MM-DD HH:MM:SS" (or RFC 3339 for imported rows).
// Subagent rows carry only their own usage, so summing every row is exact.
import os from "node:os";
import path from "node:path";
import { addUsage, dataHome, isFile, localDay } from "./records.js";
import { columnOr, readDatabase } from "./sqlite.js";

function databaseFile() {
  const root = process.env.GOOSE_PATH_ROOT;
  if (root && path.isAbsolute(root)) return path.join(root, "data", "sessions", "sessions.db");
  return path.join(dataHome(os.homedir()), "goose", "sessions", "sessions.db");
}

// SQLite CURRENT_TIMESTAMP text is UTC without a zone marker.
export function gooseTime(value) {
  if (typeof value === "number" && Number.isFinite(value)) return value < 1e11 ? value * 1000 : value;
  if (typeof value !== "string" || !value) return null;
  const text = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
  const ms = Date.parse(text);
  return Number.isFinite(ms) ? ms : null;
}

function modelName(json, provider) {
  let name = null;
  try {
    const config = JSON.parse(json);
    if (typeof config?.model_name === "string" && config.model_name) name = config.model_name;
  } catch {
    /* no model recorded */
  }
  if (!name) return null;
  return typeof provider === "string" && provider && !name.includes("/") ? `${provider}/${name}` : name;
}

const count = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Token buckets whose sum is the recorded total: input may or may not include
// cache traffic depending on the provider, so the uncached input is what the
// total leaves after output and cache.
function rowTokens(row) {
  const output = count(row.output);
  const cacheRead = count(row.cacheRead);
  const cacheWrite = count(row.cacheWrite);
  const total = count(row.total);
  const input = total ? Math.max(0, total - output - cacheRead - cacheWrite) : count(row.input);
  return [input, output, cacheRead, cacheWrite, 0];
}

const rowCost = (row) => (row.cost === null || row.cost === undefined ? null : Number(row.cost));

function selectList(columns) {
  return [
    `"id" AS id`,
    `${columnOr(columns, "working_dir")} AS dir`,
    `${columnOr(columns, "parent_session_id")} AS parent`,
    `${columnOr(columns, "created_at")} AS created`,
    `${columnOr(columns, "updated_at", columnOr(columns, "created_at"))} AS updated`,
    `${columnOr(columns, "accumulated_input_tokens", columnOr(columns, "input_tokens", "0"))} AS input`,
    `${columnOr(columns, "accumulated_output_tokens", columnOr(columns, "output_tokens", "0"))} AS output`,
    `${columnOr(columns, "accumulated_total_tokens", columnOr(columns, "total_tokens", "0"))} AS total`,
    `${columnOr(columns, "accumulated_cache_read_tokens", "0")} AS cacheRead`,
    `${columnOr(columns, "accumulated_cache_write_tokens", "0")} AS cacheWrite`,
    `${columnOr(columns, "accumulated_cost")} AS cost`,
    `${columnOr(columns, "provider_name")} AS provider`,
    `${columnOr(columns, "model_config_json")} AS model`,
  ].join(", ");
}

function readSessions(file) {
  return readDatabase(file, (db, columns) => {
    const have = columns("sessions");
    if (!have.has("id") || !have.has("created_at")) return null;
    return db.prepare(`SELECT ${selectList(have)} FROM sessions`).all();
  });
}

export const gooseAdapter = {
  id: "goose",
  label: "goose",
  pricingBasis: "agent-recorded",
  roots() {
    const file = databaseFile();
    return isFile(file) ? [{ dir: path.dirname(file), file, label: "goose" }] : [];
  },
  async records(root, horizon) {
    const rows = await readSessions(root.file);
    if (!rows) return null;
    const days = {};
    for (const row of rows) {
      const at = gooseTime(row.created);
      if (at === null || at < horizon) continue;
      addUsage(days, localDay(at), modelName(row.model, row.provider) ?? "goose", rowTokens(row), rowCost(row));
    }
    return days;
  },
  async sessionEntry(root, cwd, since) {
    const rows = await readSessions(root.file);
    if (!rows) return null;
    let main = null;
    for (const row of rows) {
      if (row.dir !== cwd || row.parent) continue;
      const updated = gooseTime(row.updated);
      if (updated === null || updated < since) continue;
      if (!main || updated > gooseTime(main.updated)) main = row;
    }
    if (!main) return null;
    const children = rows.filter((row) => row.parent === main.id).slice(0, 200);
    const days = {};
    let lastAt = gooseTime(main.updated);
    for (const row of [main, ...children]) {
      addUsage(days, localDay(gooseTime(row.created) ?? lastAt) ?? "", modelName(row.model, row.provider) ?? "goose", rowTokens(row), rowCost(row));
      const updated = gooseTime(row.updated);
      if (updated !== null && updated > lastAt) lastAt = updated;
    }
    return {
      days,
      subagents: children.length,
      state: { session: { cwd, firstAt: gooseTime(main.created), lastAt, lastModel: modelName(main.model, main.provider) } },
    };
  },
};
