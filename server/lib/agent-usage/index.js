// Per-agent usage adapters. Each coding agent whose local data says what it
// used plugs in here with one object, and the spend scan (spend-scan.js), the
// per-tile cost and model lookup (session-cost.js) pick it up without any
// agent-specific branches.
//
// Every adapter has:
//   id, label        catalog agent id (session-agents.js) and display name
//   pricingBasis     "standard-api-short-context" when tokens are priced from
//                    the local rate table (pricing.js), "agent-recorded" when
//                    the agent stores the cost it computed itself
//   roots()          this device's data roots: [{ provider, dir, label, file? }]
//   listWhenIdle?    list its spend even with nothing in the window
//   tracksTokens?    false when the agent records cost but no token counts
//   wholeFile?       its transcript files are rewritten whole, never appended
// and one of two readers:
//   Transcript files (JSONL, one file per session, parsed incrementally and
//   cached across scans by spend-scan.js):
//     transcripts(root)                      every transcript file
//     parse(file, start, days, state)        -> { parsedBytes, state }; fills
//                                               days[day][model] buckets and
//                                               state.session (records.js)
//     sessionFiles(root, cwd, since, now)    -> [{ file, mtimeMs }] candidates
//                                               for the session in `cwd`
//     subagentFiles?(file, entry)            extra files belonging to a session
//   A database (cheap aggregate queries, no file cache needed):
//     records(root, horizon)                 -> days, or null when unreadable
//     sessionEntry(root, cwd, since)         -> { days, state, subagents } | null
import { claudeAdapter } from "./claude.js";
import { codexAdapter } from "./codex.js";
import { crushAdapter } from "./crush.js";
import { geminiAdapter } from "./gemini.js";
import { gooseAdapter } from "./goose.js";
import { grokAdapter } from "./grok.js";
import { kimiAdapter } from "./kimi.js";
import { kiloAdapter, opencodeAdapter } from "./opencode.js";
import { piAdapter } from "./pi.js";
import { qwenAdapter } from "./qwen.js";

// In catalog order, which is also the order the usage panel lists them in.
export const USAGE_ADAPTERS = [
  claudeAdapter,
  codexAdapter,
  opencodeAdapter,
  geminiAdapter,
  piAdapter,
  gooseAdapter,
  qwenAdapter,
  crushAdapter,
  kiloAdapter,
  grokAdapter,
  kimiAdapter,
];

const byId = new Map(USAGE_ADAPTERS.map((adapter) => [adapter.id, adapter]));

export function usageAdapter(id) {
  return typeof id === "string" ? byId.get(id) : undefined;
}

/** Agent ids whose sessions can be priced and their model read. */
export const SESSION_USAGE_AGENTS = USAGE_ADAPTERS.filter((adapter) => adapter.sessionFiles || adapter.sessionEntry).map((adapter) => adapter.id);

/** Every data root of every adapter on this device. */
export function usageRoots() {
  const roots = [];
  for (const adapter of USAGE_ADAPTERS) {
    try {
      for (const root of adapter.roots()) roots.push({ ...root, provider: adapter.id });
    } catch {
      /* one agent's unreadable folder never hides the others */
    }
  }
  return roots;
}
