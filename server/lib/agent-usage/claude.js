// Claude Code: ~/.claude*/projects/<folder slug>/<session>.jsonl, one file per
// session, subagents under <session>/subagents/. Assistant lines carry the
// model and token usage; cost is priced from the local rate table.
import fs from "node:fs";
import path from "node:path";
import { discoverAccounts } from "../accounts.js";
import { addUsage, epochMs, isJsonl, localDay, noteSession, parseJson, readLines, recentFiles, sessionState, walkFiles } from "./records.js";

// Cap on the dedup keys persisted per file for incremental resumes. A retry is
// logged right next to its original, so the last few hundred keys are all a
// resume ever needs; a cold parse still dedups the whole file.
const SEEN_KEEP = 200;
const MAX_SIDECHAINS = 200;

// Claude Code stores a folder's sessions under projects/<folder with every
// character other than a letter or digit replaced by "-">.
export function claudeProjectSlug(cwd) {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

// Parse a Claude transcript (from byte `start`, continuing `state`) into
// day -> model -> buckets. Deduplicates by (message id, requestId) within the
// file (retries are logged twice); cross-file duplicates do not occur since a
// session appends to its own file.
async function parse(file, start, days, state) {
  const seen = new Set(state && Array.isArray(state.seen) ? state.seen : []);
  const session = sessionState(state);
  const parsedBytes = await readLines(file, start, (line) => {
    if (!line.includes('"usage"')) return;
    const rec = parseJson(line);
    const msg = rec?.message;
    if (!msg || typeof msg !== "object") return;
    const usage = msg.usage;
    const model = msg.model;
    if (!usage || typeof usage !== "object" || !model || String(model).startsWith("<")) return;
    const key = `${msg.id} ${rec.requestId}`;
    if (seen.has(key)) return;
    seen.add(key);
    const day = localDay(rec.timestamp);
    if (!day) return;
    noteSession(session, epochMs(rec.timestamp), rec.cwd, model);
    const created = usage.cache_creation || {};
    let five = created.ephemeral_5m_input_tokens;
    const hour = created.ephemeral_1h_input_tokens;
    if (five == null && hour == null) five = usage.cache_creation_input_tokens;
    addUsage(days, day, model, [usage.input_tokens, usage.output_tokens, usage.cache_read_input_tokens, five, hour]);
  });
  // Sets iterate in insertion order, so the slice keeps the most recent keys.
  const keys = [...seen];
  return { parsedBytes, state: { seen: keys.slice(Math.max(0, keys.length - SEEN_KEEP)), session } };
}

export const claudeAdapter = {
  id: "claude",
  label: "Claude",
  pricingBasis: "standard-api-short-context",
  // Signed-in accounts always show their spend, zero included.
  listWhenIdle: true,
  roots: () => discoverAccounts().filter((account) => account.provider === "claude"),
  transcripts: (root) => walkFiles(path.join(root.dir, "projects"), isJsonl),
  parse,
  async sessionFiles(root, cwd, since) {
    return recentFiles(path.join(root.dir, "projects", claudeProjectSlug(cwd)), since, isJsonl);
  },
  // Subagents of a session log to <session id>/subagents/*.jsonl.
  async subagentFiles(file) {
    const dir = file.replace(/\.jsonl$/, "");
    try {
      if (!(await fs.promises.stat(dir)).isDirectory()) return [];
    } catch {
      return [];
    }
    return walkFiles(dir, isJsonl, MAX_SIDECHAINS);
  },
};
