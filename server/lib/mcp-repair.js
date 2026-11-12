import { execFile } from "node:child_process";
import { SSH_TOKEN, shQuote } from "./shell.js";
import { MCP_REPAIR_TARGET } from "./mcp-repair-target.js";

export function runMcpRepair(host = "", apply = true) {
  if (host && !SSH_TOKEN.test(host)) return Promise.reject(new Error("Invalid device host"));
  const args = host ? ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "--", host, `python3 -c ${shQuote(MCP_REPAIR_TARGET)}`] : ["-c", MCP_REPAIR_TARGET];
  return new Promise((resolve, reject) => {
    const child = execFile(host ? "ssh" : "python3", args, { timeout: apply ? 45000 : 12000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error("Cannot check this device. Trusted SSH access and Python 3 are required."));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid integration health response")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ apply }));
  });
}

// Identity of one server entry across runs.
const entryKey = (result) => JSON.stringify([result.file ?? "", result.scope ?? "", result.server ?? ""]);
// Findings only an applied run can fix: a launcher path to repair, or a client
// file others can modify (an applied run restricts it to its owner).
const needsApply = (result) => result?.status === "repairable" ||
  (result?.status === "unresolved" && /others cannot modify/.test(String(result.message ?? "")));
const REVERTED = "A running client wrote its previous command back after this entry was repaired. Close that client, then use Check now to repair it again.";

// Integration maintenance. The background check (at launch and every minute)
// reads only: client configuration files are written only when that read
// finds something to repair, never on a timer for its own sake. A repair that
// a running client then wrote back over (clients keep their configuration in
// memory and save the whole file) is not applied again in the background, so
// PzzaCode and the client never take turns rewriting the file; it is
// reported instead. A fresh check is the user's explicit request and applies
// every repair.
export function createMcpRepair({ run = runMcpRepair, now = Date.now } = {}) {
  const devices = new Map();
  const apply = async (host, entry) => {
    const report = await run(host, true);
    for (const result of Array.isArray(report?.results) ? report.results : []) {
      if (result?.status === "repaired" && result.server) entry.repaired.add(entryKey(result));
    }
    return report;
  };
  const background = async (host, entry) => {
    const report = await run(host, false);
    const results = Array.isArray(report?.results) ? report.results : [];
    if (!results.some(needsApply)) return report;
    const reverted = new Set(results.filter((result) => result?.status === "repairable" && entry.repaired.has(entryKey(result))));
    if (!reverted.size) return apply(host, entry);
    return { ...report, results: results.map((result) => (reverted.has(result) ? { ...result, message: REVERTED } : result)) };
  };
  return (host = "", fresh = false) => {
    if (host && !SSH_TOKEN.test(host)) return Promise.reject(new Error("Invalid device host"));
    let entry = devices.get(host);
    if (!entry) { entry = { at: 0, result: null, pending: null, applying: false, repaired: new Set() }; devices.set(host, entry); }
    // An explicit check that arrives during a background read still applies.
    if (entry.pending && (!fresh || entry.applying)) return entry.pending;
    if (!fresh && entry.result && now() - entry.at < 60000) return Promise.resolve(entry.result);
    const previous = entry.pending ?? Promise.resolve();
    entry.applying = fresh;
    const pending = previous.catch(() => undefined).then(() => (fresh ? apply(host, entry) : background(host, entry))).then((value) => {
      entry.at = now(); entry.result = value;
      return value;
    }).finally(() => {
      if (entry.pending === pending) { entry.pending = null; entry.applying = false; }
    });
    entry.pending = pending;
    return pending;
  };
}
