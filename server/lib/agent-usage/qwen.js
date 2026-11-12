// Qwen Code: <runtime>/projects/<folder slug>/chats/<session id>.jsonl (and
// chats/archive/), where <runtime> is $QWEN_RUNTIME_DIR, else $QWEN_HOME, else
// ~/.qwen, and the slug replaces every character other than a letter or digit
// with "-". Records are append-only { uuid, sessionId, timestamp, type, cwd, ... }.
//
// Usage is read from the `system` / `ui_telemetry` records Qwen Code writes for
// every model response ("qwen-code.api_response" events with model, token
// counts, response_id and auth_type): the same records its own usage summary
// counts, including subagent calls, so the assistant records' copies of the
// same counts are not added again. Records copied into a fork carry
// `forkedFrom` and are skipped; response ids are deduplicated.
import os from "node:os";
import path from "node:path";
import fs from "node:fs";
import { addUsage, epochMs, isDirectory, localDay, noteSession, parseJson, readLines, recentFiles, sessionState, walkFiles } from "./records.js";

const SEEN_KEEP = 500;
const SESSION_FILE = /^[0-9a-fA-F-]{32,36}\.jsonl$/;
// Providers whose output count already includes reasoning tokens.
const OUTPUT_INCLUDES_THOUGHTS = new Set(["openai", "openai-responses", "qwen-oauth"]);

function qwenRuntimeDir() {
  const home = os.homedir();
  const expand = (value) => (value.startsWith("~/") ? path.join(home, value.slice(2)) : value);
  if (process.env.QWEN_RUNTIME_DIR) return expand(process.env.QWEN_RUNTIME_DIR);
  if (process.env.QWEN_HOME) return expand(process.env.QWEN_HOME);
  return path.join(home, ".qwen");
}

const count = (value) => {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
};

// Billable output, as Qwen Code computes it: thoughts are part of the output
// count on OpenAI-style providers and separate on Gemini-style ones.
export function qwenOutputTokens(event) {
  const input = count(event.input_token_count);
  const output = count(event.output_token_count);
  const thoughts = count(event.thoughts_token_count);
  const total = count(event.total_token_count);
  const derived = total - input;
  if (total > 0 && output <= derived && derived <= output + thoughts) return derived;
  return OUTPUT_INCLUDES_THOUGHTS.has(event.auth_type) ? output : output + thoughts;
}

async function parse(file, start, days, state) {
  const seen = new Set(state && Array.isArray(state.seen) ? state.seen : []);
  const session = sessionState(state);
  const parsedBytes = await readLines(file, start, (line) => {
    if (!line.includes("qwen-code.api_response")) return;
    const rec = parseJson(line);
    if (!rec || rec.type !== "system" || rec.subtype !== "ui_telemetry" || rec.forkedFrom) return;
    const event = rec.systemPayload?.uiEvent;
    if (!event || event["event.name"] !== "qwen-code.api_response") return;
    const model = typeof event.model === "string" && event.model ? event.model : null;
    const key = typeof event.response_id === "string" && event.response_id ? event.response_id : rec.uuid;
    const at = epochMs(rec.timestamp);
    const day = localDay(rec.timestamp);
    if (!model || !day || typeof key !== "string" || seen.has(key)) return;
    seen.add(key);
    const input = count(event.input_token_count);
    const cached = Math.min(count(event.cached_content_token_count), input);
    noteSession(session, at, rec.cwd, model);
    addUsage(days, day, model, [input - cached, qwenOutputTokens(event), cached, 0, 0]);
  });
  const keys = [...seen];
  return { parsedBytes, state: { seen: keys.slice(Math.max(0, keys.length - SEEN_KEEP)), session } };
}

const isSessionFile = (name) => SESSION_FILE.test(name);

export const qwenAdapter = {
  id: "qwen",
  label: "Qwen Code",
  pricingBasis: "standard-api-short-context",
  roots() {
    const dir = qwenRuntimeDir();
    return isDirectory(path.join(dir, "projects")) ? [{ dir, label: "Qwen Code" }] : [];
  },
  transcripts(root) {
    const files = [];
    let projects = [];
    try {
      projects = fs.readdirSync(path.join(root.dir, "projects"), { withFileTypes: true });
    } catch {
      return files;
    }
    for (const project of projects) {
      if (project.isDirectory()) files.push(...walkFiles(path.join(root.dir, "projects", project.name, "chats"), isSessionFile, 5000));
    }
    return files;
  },
  parse,
  async sessionFiles(root, cwd, since) {
    return recentFiles(path.join(root.dir, "projects", cwd.replace(/[^a-zA-Z0-9]/g, "-"), "chats"), since, isSessionFile);
  },
};
