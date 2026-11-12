// Kimi Code: <root>/sessions/<workspace id>/<session id>/agents/<agent id>/wire.jsonl
// (<root> is $KIMI_CODE_HOME, else ~/.kimi-code; the main agent is "main",
// subagents have their own folders). Each line is a wire record { type, ...,
// time (epoch ms) }. `usage.record` rows are per-request deltas { agentId,
// model (the configured model alias), usage: { inputOther (without cache),
// output, inputCacheRead?, inputCacheCreation } }, summed whatever their
// usageScope, as Kimi Code itself does. A fork copies its source's records
// and then appends a `forked` record, so everything before the last `forked`
// record of a file is a copy and is not counted again.
//
// The legacy kimi-cli (~/.kimi) is not read: it records no model name, and it
// writes subagent usage both to the subagent's file and the parent's.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addUsage, epochMs, isDirectory, localDay, noteSession, parseJson, readLines, sessionState, walkFiles } from "./records.js";

function kimiRoot() {
  return process.env.KIMI_CODE_HOME || path.join(os.homedir(), ".kimi-code");
}

// Kimi Code's implicit workspace id for a working directory.
export function kimiWorkspaceId(cwd) {
  const normalized = cwd.replaceAll("\\", "/").replace(/\/+$/, "");
  const slug = path.posix.basename(normalized).toLowerCase().replaceAll(/[^a-z0-9._-]+/g, "-").replaceAll(/^-+|-+$/g, "")
    .slice(0, 40).replaceAll(/^-+|-+$/g, "");
  const name = slug && slug !== "." && slug !== ".." ? slug : "workspace";
  return `wd_${name}_${crypto.createHash("sha256").update(normalized).digest("hex").slice(0, 12)}`;
}

const count = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

async function parse(file, start, days, state) {
  let session = sessionState(state);
  const parsedBytes = await readLines(file, start, (line) => {
    if (!line.includes('"usage.record"') && !line.includes('"forked"')) return;
    const rec = parseJson(line);
    if (!rec) return;
    if (rec.type === "forked") {
      // Everything so far was copied from the source session.
      for (const day of Object.keys(days)) delete days[day];
      session = sessionState(null);
      return;
    }
    if (rec.type !== "usage.record" || !rec.usage || typeof rec.usage !== "object") return;
    const model = typeof rec.model === "string" && rec.model ? rec.model : null;
    const at = epochMs(rec.time);
    const day = at === null ? null : localDay(at);
    if (!model || !day) return;
    const u = rec.usage;
    noteSession(session, at, undefined, model);
    // Kimi bills cache creation at the input rate, so it joins the input bucket.
    addUsage(days, day, model, [count(u.inputOther) + count(u.inputCacheCreation), u.output, u.inputCacheRead, 0, 0]);
  });
  return { parsedBytes, state: { session } };
}

const isWire = (name) => name === "wire.jsonl";

export const kimiAdapter = {
  id: "kimi",
  label: "Kimi Code",
  pricingBasis: "standard-api-short-context",
  roots() {
    const dir = kimiRoot();
    return isDirectory(path.join(dir, "sessions")) ? [{ dir, label: "Kimi Code" }] : [];
  },
  transcripts: (root) => walkFiles(path.join(root.dir, "sessions"), isWire),
  parse,
  // The main agent's wire of each session in the folder's workspace.
  async sessionFiles(root, cwd, since) {
    const workspace = path.join(root.dir, "sessions", kimiWorkspaceId(cwd));
    let sessions = [];
    try {
      sessions = await fs.promises.readdir(workspace, { withFileTypes: true });
    } catch {
      return [];
    }
    const files = [];
    for (const entry of sessions.slice(0, 2000)) {
      if (!entry.isDirectory()) continue;
      const file = path.join(workspace, entry.name, "agents", "main", "wire.jsonl");
      try {
        const { mtimeMs } = await fs.promises.stat(file);
        if (mtimeMs >= since) files.push({ file, mtimeMs });
      } catch {
        /* no main agent yet */
      }
    }
    return files;
  },
  // Subagents of a session log to agents/<agent id>/wire.jsonl beside main.
  async subagentFiles(file) {
    const agents = path.dirname(path.dirname(file));
    return walkFiles(agents, isWire, 200).filter((other) => other !== file);
  },
};
