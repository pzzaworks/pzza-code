// Gemini CLI: <home>/.gemini/tmp/<project>/chats/session-<time>-<id>.jsonl,
// subagents under chats/<parent session id>/<subagent session id>.jsonl
// (packages/core/src/services/chatRecordingService.ts). <project> is a slug
// from <home>/.gemini/projects.json ({ projects: { "<abs path>": "<slug>" } });
// older versions used sha256(<abs path>), and the slug migration copies those
// folders, so the same session can exist twice and is deduplicated by id.
//
// The first line is the session header ({ sessionId, projectHash, ... }).
// Messages are { id, timestamp, type, model?, tokens? }, and a message is
// appended again in full (same id) when tokens or tool calls are added, so
// each id is counted once. tokens = { input (promptTokenCount, includes
// cached), output (candidates), cached, thoughts (billed as output), tool
// (tool-use prompt, separate from input), total }. Rewound messages were
// still billed and stay counted.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { addUsage, epochMs, isDirectory, isJsonl, localDay, noteSession, parseJson, readLines, recentFiles, sessionState, walkFiles } from "./records.js";

const SEEN_KEEP = 500;

function geminiDirs() {
  const home = process.env.GEMINI_CLI_HOME || os.homedir();
  // A sandboxed (seatbelt) Gemini CLI keeps its runtime data under ~/.cache.
  return [path.join(home, ".gemini"), path.join(os.homedir(), ".cache", ".gemini")];
}

const count = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

async function parse(file, start, days, state) {
  const seen = new Set(state && Array.isArray(state.seen) ? state.seen : []);
  const session = sessionState(state);
  let sessionKey = state && typeof state.sessionKey === "string" ? state.sessionKey : null;
  const parsedBytes = await readLines(file, start, (line) => {
    const rec = parseJson(line);
    if (!rec) return;
    if (!sessionKey && typeof rec.sessionId === "string" && typeof rec.projectHash === "string" && rec.id === undefined) {
      sessionKey = rec.sessionId;
      return;
    }
    if (rec.type !== "gemini" || typeof rec.id !== "string" || !rec.tokens || typeof rec.tokens !== "object") return;
    if (seen.has(rec.id)) return;
    const model = typeof rec.model === "string" && rec.model ? rec.model : null;
    const day = localDay(rec.timestamp);
    if (!model || !day) return;
    seen.add(rec.id);
    const t = rec.tokens;
    const cached = Math.min(count(t.cached), count(t.input));
    noteSession(session, epochMs(rec.timestamp), undefined, model);
    addUsage(days, day, model, [count(t.input) - cached + count(t.tool), count(t.output) + count(t.thoughts), cached, 0, 0]);
  });
  const keys = [...seen];
  return { parsedBytes, state: { seen: keys.slice(Math.max(0, keys.length - SEEN_KEEP)), session, sessionKey } };
}

// The folders that can hold `cwd`'s chats: its registry slug, any slug folder
// whose .project_root names it, and the legacy sha256 folder.
async function projectFolders(dir, cwd) {
  const tmp = path.join(dir, "tmp");
  const folders = new Set();
  try {
    const registry = JSON.parse(await fs.promises.readFile(path.join(dir, "projects.json"), "utf8"));
    const slug = registry?.projects?.[cwd];
    if (typeof slug === "string" && /^[a-z0-9-]+$/.test(slug)) folders.add(path.join(tmp, slug));
  } catch {
    /* no registry yet */
  }
  if (!folders.size) {
    let entries = [];
    try {
      entries = await fs.promises.readdir(tmp, { withFileTypes: true });
    } catch {
      /* no sessions */
    }
    for (const entry of entries.slice(0, 2000)) {
      if (!entry.isDirectory()) continue;
      try {
        const root = (await fs.promises.readFile(path.join(tmp, entry.name, ".project_root"), "utf8")).trim();
        if (root === cwd) folders.add(path.join(tmp, entry.name));
      } catch {
        /* not a slug folder */
      }
    }
  }
  folders.add(path.join(tmp, crypto.createHash("sha256").update(cwd).digest("hex")));
  return [...folders];
}

export const geminiAdapter = {
  id: "gemini",
  label: "Gemini CLI",
  pricingBasis: "standard-api-short-context",
  roots: () => geminiDirs().filter((dir) => isDirectory(path.join(dir, "tmp"))).map((dir) => ({ dir, label: "Gemini CLI" })),
  transcripts(root) {
    const files = [];
    let projects = [];
    try {
      projects = fs.readdirSync(path.join(root.dir, "tmp"), { withFileTypes: true });
    } catch {
      return files;
    }
    for (const project of projects) {
      if (project.isDirectory()) files.push(...walkFiles(path.join(root.dir, "tmp", project.name, "chats"), isJsonl, 5000));
    }
    return files;
  },
  parse,
  async sessionFiles(root, cwd, since) {
    const files = [];
    for (const folder of await projectFolders(root.dir, cwd)) {
      files.push(...await recentFiles(path.join(folder, "chats"), since, (name) => name.startsWith("session-") && isJsonl(name)));
    }
    return files;
  },
  // A session's subagents log to chats/<session id>/*.jsonl.
  async subagentFiles(file, entry) {
    const id = entry?.state?.sessionKey;
    if (typeof id !== "string" || !/^[\w-]{1,128}$/.test(id)) return [];
    return (await recentFiles(path.join(path.dirname(file), id), 0, isJsonl)).map((item) => item.file);
  },
};
