import { execFile } from "node:child_process";
import { SSH_TOKEN, shQuote } from "./shell.js";
import { MCP_REPAIR_TARGET } from "./mcp-repair-target.js";

export function runMcpRepair(host = "", apply = true) {
  if (host && !SSH_TOKEN.test(host)) return Promise.reject(new Error("Invalid device host"));
  const args = host ? ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "--", host, `python3 -c ${shQuote(MCP_REPAIR_TARGET)}`] : ["-c", MCP_REPAIR_TARGET];
  return new Promise((resolve, reject) => {
    const child = execFile(host ? "ssh" : "python3", args, { timeout: 12000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error("Cannot check this device. Trusted SSH access and Python 3 are required."));
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid integration health response")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ apply }));
  });
}

export function createMcpRepair({ run = runMcpRepair, now = Date.now } = {}) {
  const devices = new Map();
  return (host = "", fresh = false) => {
    if (host && !SSH_TOKEN.test(host)) return Promise.reject(new Error("Invalid device host"));
    let entry = devices.get(host);
    if (!entry) { entry = { at: 0, result: null, pending: null }; devices.set(host, entry); }
    if (entry.pending) return entry.pending;
    if (!fresh && entry.result && now() - entry.at < 60000) return Promise.resolve(entry.result);
    entry.pending = run(host).then(value => {
      entry.at = now(); entry.result = value;
      return value;
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  };
}
