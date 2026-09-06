// Agent usage (Claude / Codex accounts on this device). Reads the same OAuth
// usage the official apps show, from locally-stored creds, and caches it so the
// panel is instant and the provider endpoints are not polled too hard.
import fs from "node:fs";
import path from "node:path";
import { discoverAccounts, readClaudeOAuth, readClaudeIdentity, readCodexCreds } from "./accounts.js";

export const USAGE_FRESH_MS = 5 * 60 * 1000; // the endpoints 429 if polled harder
// A failed entry (expired token, provider hiccup) is retried much sooner, so the
// panel recovers right after the CLI refreshes its token instead of showing the
// stale failure for the whole cache window.
const USAGE_RETRY_MS = 30 * 1000;
let usageCache = { at: 0, data: null, failed: false };

const winShape = (w) =>
  w && (w.utilization != null || w.used_percent != null)
    ? { utilization: Number(w.utilization ?? w.used_percent), resets_at: w.resets_at ?? null }
    : null;

async function fetchClaudeUsage(accessToken) {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "pzza-code/1.0",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`usage ${res.status}`);
  const j = await res.json();
  const scoped = (j.limits || [])
    .filter((l) => l.kind === "weekly_scoped")
    .map((l) => ({
      name: l.scope?.model?.display_name || "weekly",
      percent: Number(l.percent ?? l.utilization ?? 0),
      resets_at: l.resets_at ?? null,
    }));
  return { five_hour: winShape(j.five_hour), seven_day: winShape(j.seven_day), scoped };
}

async function fetchCodexUsage(creds) {
  const headers = { Authorization: `Bearer ${creds.accessToken}`, "User-Agent": "pzza-code/1.0" };
  if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`usage ${res.status}`);
  const j = await res.json();
  const rl = j.rate_limit || j;
  const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);
  let five_hour = null;
  let seven_day = null;
  for (const w of [rl.primary_window, rl.secondary_window].filter(Boolean)) {
    const entry = { utilization: Number(w.used_percent ?? 0), resets_at: iso(w.reset_at) };
    if ((w.limit_window_seconds || 0) <= 6 * 3600) five_hour = entry;
    else seven_day = entry;
  }
  const scoped = (rl.additional_rate_limits || []).map((w) => ({
    name: w.name || "limit",
    percent: Number(w.used_percent ?? 0),
    resets_at: iso(w.reset_at),
  }));
  return { five_hour, seven_day, scoped };
}

const CLAUDE_SIGNIN_HINT = "run claude once in a terminal to refresh it";

// Usage for one Claude account. Claude Code refreshes the OAuth token itself
// whenever it runs and the agent never refreshes on its behalf (a refresh
// rotates the token and could sign the CLI out), so an expired or rejected
// token is reported as exactly that instead of a bare "usage 401".
async function claudeAccountUsage(acc) {
  const oauth = readClaudeOAuth(acc.dir);
  // No usable creds on this device (e.g. a devbox-only account seen from the
  // Mac): hide it rather than showing a "not signed in" row.
  if (!oauth?.accessToken) return null;
  const entry = { provider: "claude", label: acc.label, ...readClaudeIdentity(acc.dir), usage: null, error: null };
  if (oauth.expiresAt && Number(oauth.expiresAt) <= Date.now()) {
    return { ...entry, error: `Session token expired - ${CLAUDE_SIGNIN_HINT}` };
  }
  try {
    return { ...entry, usage: await fetchClaudeUsage(oauth.accessToken) };
  } catch (e) {
    if (!/\b401\b/.test(String(e.message))) throw e;
    // The CLI may have rotated the token between our read and the call: re-read
    // once and retry with the new one before giving up.
    const again = readClaudeOAuth(acc.dir);
    if (again?.accessToken && again.accessToken !== oauth.accessToken) {
      return { ...entry, usage: await fetchClaudeUsage(again.accessToken) };
    }
    return { ...entry, error: `Session token rejected - ${CLAUDE_SIGNIN_HINT}` };
  }
}

// Fetch every account's usage from the provider APIs (in parallel) and cache it.
async function refreshUsage() {
  const accounts = discoverAccounts();
  const data = (
    await Promise.all(
      accounts.map(async (acc) => {
        try {
          if (acc.provider === "claude") return await claudeAccountUsage(acc);
          if (!fs.existsSync(path.join(acc.dir, "auth.json"))) return null;
          const creds = readCodexCreds(acc.dir);
          if (!creds.accessToken) return null;
          const usage = await fetchCodexUsage(creds);
          return { provider: "codex", label: acc.label, email: creds.email, plan: creds.plan, usage, error: null };
        } catch (e) {
          return { provider: acc.provider, label: acc.label, usage: null, error: String(e.message || e) };
        }
      }),
    )
  ).filter(Boolean);
  usageCache = { at: Date.now(), data, failed: data.some((a) => a.error) };
  return data;
}

let usageScan = null;
function startScan() {
  usageScan = refreshUsage().finally(() => {
    usageScan = null;
  });
  return usageScan;
}

// Serve usage without ever blocking on the network once warm: a fresh cache is
// returned as-is, a stale one is returned immediately and refreshed in the
// background, and only a cold start waits for the first fetch (sharing one
// in-flight scan). The cache is warmed at boot, so the menu is instant. `fresh`
// (the panel's refresh button) skips the cache and waits for a real fetch.
export function collectUsage({ fresh = false } = {}) {
  if (fresh || !usageCache.data) {
    return (usageScan ?? startScan()).catch(() => usageCache.data ?? Promise.reject(new Error("usage unavailable")));
  }
  const ttl = usageCache.failed ? USAGE_RETRY_MS : USAGE_FRESH_MS;
  if (Date.now() - usageCache.at >= ttl && !usageScan) startScan().catch(() => undefined);
  return Promise.resolve(usageCache.data);
}
