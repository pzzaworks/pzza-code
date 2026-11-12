// Grok Build: <root>/sessions/<encoded cwd>/<session id>/usage.json (<root> is
// $GROK_HOME, else ~/.grok; the folder name is the URL-encoded cwd, or a slug
// with the real path in a .cwd file when that is too long). usage.json is
// rewritten whole at the end of every turn: { sessionId, updatedAt, session,
// turns: [{ turnNumber, endedAt, inputTokens (includes cache reads and
// writes), outputTokens, cachedReadTokens, cacheCreationTokens,
// costUsdTicks? (1e10 per USD, as the server reported it), costIsPartial?,
// primaryModelId?, modelUsage?: { <model>: same fields } }] }.
// summary.json beside it names the session kind and fork time: subagent spend
// is already folded into its parent's ledger, and a fork's copied turns
// (ended before forked_at) belong to its source.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addUsage, epochMs, isDirectory, localDay, noteSession, parseJson, sessionState } from "./records.js";

const TICKS_PER_USD = 1e10;
const MAX_SESSIONS = 20_000;

function grokRoot() {
  return process.env.GROK_HOME || path.join(os.homedir(), ".grok");
}

const count = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

function addTurnUsage(days, day, model, usage) {
  const input = count(usage.inputTokens);
  const cached = Math.min(count(usage.cachedReadTokens), input);
  const created = Math.min(count(usage.cacheCreationTokens), input - cached);
  const ticks = Number(usage.costUsdTicks);
  const cost = usage.costIsPartial !== true && Number.isFinite(ticks) && ticks >= 0 ? ticks / TICKS_PER_USD : null;
  addUsage(days, day, model, [input - cached - created, usage.outputTokens, cached, created, 0], cost);
}

async function readJson(file) {
  try {
    return parseJson(await fs.promises.readFile(file, "utf8"));
  } catch {
    return null;
  }
}

// usage.json is not appended to, so it is always read whole (see `wholeFile`).
async function parse(file, _start, days) {
  const text = await fs.promises.readFile(file, "utf8");
  const ledger = parseJson(text);
  const session = sessionState(null);
  const summary = await readJson(path.join(path.dirname(file), "summary.json"));
  const kind = typeof summary?.session_kind === "string" ? summary.session_kind : "";
  const forkedAt = epochMs(summary?.forked_at);
  if (typeof summary?.info?.cwd === "string") session.cwd = summary.info.cwd;
  if (ledger && Array.isArray(ledger.turns) && !kind.startsWith("subagent")) {
    for (const turn of ledger.turns) {
      if (!turn || typeof turn !== "object") continue;
      const at = epochMs(turn.endedAt);
      const day = at === null ? null : localDay(at);
      if (!day || (forkedAt !== null && at <= forkedAt)) continue;
      const perModel = turn.modelUsage && typeof turn.modelUsage === "object" ? Object.entries(turn.modelUsage) : [];
      const primary = typeof turn.primaryModelId === "string" && turn.primaryModelId ? turn.primaryModelId : null;
      if (perModel.length) {
        for (const [model, usage] of perModel) if (usage && typeof usage === "object") addTurnUsage(days, day, model, usage);
      } else if (primary) {
        addTurnUsage(days, day, primary, turn);
      } else continue;
      noteSession(session, at, undefined, primary ?? perModel[0]?.[0]);
    }
  }
  return { parsedBytes: Buffer.byteLength(text), state: { session } };
}

// The working folder a session folder name stands for.
async function folderCwd(dir, name) {
  try {
    const decoded = decodeURIComponent(name);
    if (decoded.startsWith("/")) return decoded;
  } catch {
    /* not URL-encoded: a slug with a .cwd file */
  }
  try {
    return (await fs.promises.readFile(path.join(dir, name, ".cwd"), "utf8")).trim();
  } catch {
    return null;
  }
}

function usageFiles(dir, limit) {
  const files = [];
  let projects = [];
  try {
    projects = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const project of projects) {
    if (!project.isDirectory()) continue;
    let sessions = [];
    try {
      sessions = fs.readdirSync(path.join(dir, project.name), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of sessions) {
      if (entry.isDirectory()) files.push(path.join(dir, project.name, entry.name, "usage.json"));
      if (files.length >= limit) return files;
    }
  }
  return files;
}

export const grokAdapter = {
  id: "grok",
  label: "Grok Build",
  pricingBasis: "agent-recorded",
  // The ledger is rewritten in place, never appended to.
  wholeFile: true,
  roots() {
    const dir = path.join(grokRoot(), "sessions");
    return isDirectory(dir) ? [{ dir, label: "Grok Build" }] : [];
  },
  transcripts: (root) => usageFiles(root.dir, MAX_SESSIONS),
  parse,
  async sessionFiles(root, cwd, since) {
    let projects = [];
    try {
      projects = await fs.promises.readdir(root.dir, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = [];
    for (const project of projects.slice(0, 5000)) {
      if (!project.isDirectory() || (await folderCwd(root.dir, project.name)) !== cwd) continue;
      let sessions = [];
      try {
        sessions = await fs.promises.readdir(path.join(root.dir, project.name), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of sessions) {
        if (!entry.isDirectory()) continue;
        const file = path.join(root.dir, project.name, entry.name, "usage.json");
        try {
          const { mtimeMs } = await fs.promises.stat(file);
          if (mtimeMs >= since) files.push({ file, mtimeMs });
        } catch {
          /* no turn finished yet */
        }
      }
    }
    return files;
  },
};
