// HTTP client for the local PzzaCode device agent (127.0.0.1:5190). Every tool
// drives the same guarded backend the app uses, so nothing here runs shell
// directly. The agent's per-launch bearer token is taken from the environment
// or the 0600 token file it writes for local tools.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";

const BASE = process.env.PZZA_SERVER_URL || "http://127.0.0.1:5190";

function responseError(status, body) {
  try {
    const value = JSON.parse(body);
    if (typeof value?.error === "string") return new Error(`Agent request failed (${status}): ${value.error.slice(0, 4096)}`);
  } catch { /* Non-JSON responses use the status-only error. */ }
  return new Error(`Agent request failed (${status})`);
}

// Execute inside the destination account: its credential never leaves that host.
async function remoteRequest() {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { endpoint, options } = JSON.parse(input);
  const dir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  const token = fs.readFileSync(path.join(dir, "pzzacode", "agent-token"), "utf8").trim();
  const response = await fetch(`http://127.0.0.1:5190${endpoint}`, {
    ...options, redirect: "error", signal: AbortSignal.timeout(endpoint === "/git/protect" ? 58000 : 25000),
    headers: { ...options.headers, Authorization: `Bearer ${token}` },
  });
  process.stdout.write(JSON.stringify({ status: response.status, body: await response.text() }));
}

export function sshApi(host, endpoint, options = {}) {
  if (!/^[A-Za-z0-9._][A-Za-z0-9._@-]{0,127}$/.test(host)) return Promise.reject(new Error("Invalid SSH agent host"));
  if (!endpoint.startsWith("/") || endpoint.startsWith("//")) return Promise.reject(new Error("Invalid agent endpoint"));
  const script = `(${remoteRequest.toString()})().catch(() => { process.stderr.write("Remote agent request failed"); process.exitCode = 1; });`;
  const quoted = `'${script.replace(/'/g, `'\\''`)}'`;
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes",
      "-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/pzza-mux-%C", "-o", "ControlPersist=120", host, `node -e ${quoted}`],
    { timeout: endpoint === "/git/protect" ? 60000 : 30000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
      if (error) return reject(new Error("Cannot reach the app agent over SSH. Check SSH access, Node.js and that the app is running."));
      try {
        const result = JSON.parse(stdout);
        if (result.status < 200 || result.status >= 300) return reject(responseError(result.status, result.body));
        try { resolve(JSON.parse(result.body)); } catch { resolve(result.body); }
      } catch { reject(new Error("Invalid response from the remote agent")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ endpoint, options }));
  });
}

function agentToken() {
  const env = (process.env.PZZA_AGENT_TOKEN || "").trim();
  if (env) return env;
  const dir = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
  try {
    return fs.readFileSync(path.join(dir, "pzzacode", "agent-token"), "utf8").trim();
  } catch {
    return "";
  }
}

async function api(p, opts) {
  const host = (process.env.PZZA_AGENT_HOST || "").trim();
  if (host) return sshApi(host, p, opts);
  return localApi(p, opts);
}

async function localApi(p, opts) {
  const token = agentToken();
  const headers = { ...(opts && opts.headers ? opts.headers : {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, { ...(opts || {}), headers, redirect: "error", signal: AbortSignal.timeout(p === "/git/protect" ? 60000 : 30000) });
  const text = await res.text();
  if (!res.ok) throw responseError(res.status, text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export const get = (p) => api(p);
export const post = (p, body) =>
  api(p, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body ?? {}),
  });
export const qs = (params) => {
  const u = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) {
    if (v !== undefined && v !== null && `${v}` !== "") u.set(k, `${v}`);
  }
  const s = u.toString();
  return s ? `?${s}` : "";
};

// Bridge calls always begin at this device, even when ordinary tools target
// another app host. Remote peers only receive signed, scoped bridge requests.
export const localGet = (endpoint) => localApi(endpoint);
export const localPost = (endpoint, body) => localApi(endpoint, {
  method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}),
});
