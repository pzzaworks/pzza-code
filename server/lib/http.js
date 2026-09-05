// Access control and HTTP helpers.
//
// The agent is loopback-only, but a hostile web page in a browser on this
// machine can still reach 127.0.0.1, and DNS rebinding can even make such a
// request same-origin. So: (1) every request except /health must carry the
// per-launch bearer token (the app gets it from the process that spawned the
// agent; local tools read it from a 0600 file in STATE_DIR); (2) the Host
// header must be a loopback address on our port; (3) CORS headers are only
// issued to the app's own origins, never "*".
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { PORT, STATE_DIR } from "./config.js";

export const AGENT_TOKEN =
  (process.env.PZZA_AGENT_TOKEN || "").trim() || crypto.randomBytes(24).toString("hex");
// Non-secret per-launch instance id, echoed by /health so the app can confirm
// it is talking to the agent it spawned and not to another process that took
// the port first.
export const AGENT_ID = (process.env.PZZA_AGENT_ID || "").trim() || crypto.randomBytes(8).toString("hex");
const TOKEN_FILE = path.join(STATE_DIR, "agent-token");
try {
  fs.writeFileSync(TOKEN_FILE, AGENT_TOKEN, { mode: 0o600 });
  fs.chmodSync(TOKEN_FILE, 0o600);
} catch {
  /* best effort - the app still passes the token in-process */
}

export function tokenOk(candidate) {
  if (typeof candidate !== "string" || !candidate) return false;
  const a = Buffer.from(candidate);
  const b = Buffer.from(AGENT_TOKEN);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function requestToken(req, url) {
  const auth = String(req.headers.authorization || "");
  if (auth.startsWith("Bearer ")) return auth.slice(7).trim();
  return url ? url.searchParams.get("token") || "" : "";
}

export function hostOk(req) {
  const h = String(req.headers.host || "").toLowerCase();
  return h === `127.0.0.1:${PORT}` || h === `localhost:${PORT}` || h === `[::1]:${PORT}`;
}

// Origins that may read responses cross-origin: the desktop app's webview and
// a browser build served from this machine. Anything else gets no CORS headers.
export function originOk(origin) {
  if (!origin) return false;
  return (
    origin === "tauri://localhost" ||
    origin === "http://tauri.localhost" ||
    origin === "https://tauri.localhost" ||
    /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin)
  );
}

export function cors(res) {
  const origin = res.req && res.req.headers ? res.req.headers.origin : undefined;
  if (!originOk(origin)) return;
  res.setHeader("Access-Control-Allow-Origin", origin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
}

export function json(res, code, body) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

export function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

export function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}
