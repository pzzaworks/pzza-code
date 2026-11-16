// Runs agent session scans off the main thread (see agent-sessions.js). The
// scanner and its caches live as long as the worker, so repeated requests
// read only what changed.
import { parentPort } from "node:worker_threads";
import { parseAgentSessionsQuery } from "./agent-sessions-query.js";
import { createAgentSessionsScanner } from "./agent-sessions-scan.js";

const scanner = createAgentSessionsScanner();

parentPort.on("message", async ({ id, query }) => {
  try {
    parentPort.postMessage({ id, data: await scanner.list(parseAgentSessionsQuery(query)) });
  } catch {
    // Do not expose transcript contents or local paths in errors.
    parentPort.postMessage({ id, error: "Unable to list agent sessions" });
  }
});
