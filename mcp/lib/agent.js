// HTTP client for the local PzzaCode device agent (127.0.0.1:5190). Every tool
// drives the same guarded backend the app uses, so nothing here runs shell
// directly. The agent's per-launch bearer token is taken from the environment
// or the 0600 token file it writes for local tools.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const BASE = process.env.PZZA_SERVER_URL || "http://127.0.0.1:5190";

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
  const token = agentToken();
  const headers = { ...(opts && opts.headers ? opts.headers : {}) };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${BASE}${p}`, { ...(opts || {}), headers });
  if (!res.ok) throw new Error(`${p} -> ${res.status}`);
  const text = await res.text();
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
