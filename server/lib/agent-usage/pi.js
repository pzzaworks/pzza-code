// Pi: <agent dir>/sessions/--<cwd>--/<time>_<id>.jsonl (agent dir is
// $PI_CODING_AGENT_DIR, else ~/.pi/agent; $PI_CODING_AGENT_SESSION_DIR or the
// sessionDir setting replaces the sessions folder, with files directly in it).
// The first line is { type: "session", version, id, timestamp, cwd,
// parentSession? }. Assistant messages (and usage, tool result, compaction
// and branch summary entries) carry usage { input (without cache), output
// (with reasoning), cacheRead, cacheWrite (with cacheWrite1h), cost: { total } }:
// the cost Pi computed from its model registry. Pi sums every entry in a file,
// abandoned branches included; a fork (parentSession set) starts with verbatim
// copies of its parent's entries, which predate the fork's own header and are
// skipped so they are not counted twice.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addUsage, epochMs, isDirectory, isJsonl, localDay, noteSession, parseJson, readLines, recentFiles, sessionState, walkFiles } from "./records.js";

function agentDir() {
  return process.env.PI_CODING_AGENT_DIR || path.join(os.homedir(), ".pi", "agent");
}

function sessionsDir() {
  if (process.env.PI_CODING_AGENT_SESSION_DIR) return { dir: process.env.PI_CODING_AGENT_SESSION_DIR, flat: true };
  try {
    const settings = JSON.parse(fs.readFileSync(path.join(agentDir(), "settings.json"), "utf8"));
    if (typeof settings?.sessionDir === "string" && path.isAbsolute(settings.sessionDir)) return { dir: settings.sessionDir, flat: true };
  } catch {
    /* default location */
  }
  return { dir: path.join(agentDir(), "sessions"), flat: false };
}

// Pi's folder name for a working directory.
export function piSessionFolder(cwd) {
  return `--${path.resolve(cwd).replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`;
}

const count = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// The usage an entry carries and the model it is billed to, or null.
function entryUsage(rec) {
  if (rec.type === "message" && rec.message && typeof rec.message === "object") {
    const msg = rec.message;
    if (!msg.usage || typeof msg.usage !== "object") return null;
    const model = typeof msg.responseModel === "string" && msg.responseModel ? msg.responseModel : msg.model;
    return { usage: msg.usage, provider: msg.provider, model };
  }
  if (rec.type === "usage") return rec.usage && typeof rec.usage === "object" ? { usage: rec.usage, provider: rec.provider, model: rec.model } : null;
  if ((rec.type === "compaction" || rec.type === "branch_summary") && rec.usage && typeof rec.usage === "object") {
    return { usage: rec.usage, provider: rec.provider, model: rec.model };
  }
  return null;
}

async function parse(file, start, days, state) {
  const session = sessionState(state);
  let forkedAt = state && Number.isFinite(state.forkedAt) ? state.forkedAt : null;
  let seenHeader = state?.seenHeader === true;
  const parsedBytes = await readLines(file, start, (line) => {
    const rec = parseJson(line);
    if (!rec) return;
    if (!seenHeader && rec.type === "session") {
      seenHeader = true;
      if (typeof rec.cwd === "string") session.cwd = rec.cwd;
      if (rec.parentSession) forkedAt = epochMs(rec.timestamp);
      return;
    }
    const found = entryUsage(rec);
    if (!found) return;
    const at = epochMs(rec.timestamp);
    const day = localDay(rec.timestamp);
    if (at === null || !day || (forkedAt !== null && at < forkedAt)) return;
    const name = typeof found.model === "string" && found.model ? found.model : null;
    if (!name) return;
    const model = typeof found.provider === "string" && found.provider && !name.includes("/") ? `${found.provider}/${name}` : name;
    const u = found.usage;
    const hour = Math.min(count(u.cacheWrite1h), count(u.cacheWrite));
    const total = Number(u.cost?.total);
    noteSession(session, at, undefined, model);
    addUsage(days, day, model, [u.input, u.output, u.cacheRead, count(u.cacheWrite) - hour, hour], Number.isFinite(total) && total >= 0 ? total : null);
  });
  return { parsedBytes, state: { session, forkedAt, seenHeader } };
}

export const piAdapter = {
  id: "pi",
  label: "Pi",
  pricingBasis: "agent-recorded",
  roots() {
    const { dir, flat } = sessionsDir();
    return isDirectory(dir) ? [{ dir, flat, label: "Pi" }] : [];
  },
  transcripts: (root) => walkFiles(root.dir, isJsonl),
  parse,
  async sessionFiles(root, cwd, since) {
    return recentFiles(root.flat ? root.dir : path.join(root.dir, piSessionFolder(cwd)), since, isJsonl);
  },
};
