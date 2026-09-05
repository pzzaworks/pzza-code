// Agent usage (Claude / Codex accounts on this device). Reads the same OAuth
// usage the official apps show, from locally-stored creds, and caches it so the
// panel is instant and the provider endpoints are not polled too hard.
import fs from "node:fs";
import path from "node:path";
import { discoverAccounts, readClaudeOAuth, readClaudeIdentity, readCodexCreds } from "./accounts.js";

export const USAGE_FRESH_MS = 5 * 60 * 1000; // the endpoints 429 if polled harder
let usageCache = { at: 0, data: null };

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

// Fetch every account's usage from the provider APIs (in parallel) and cache it.
async function refreshUsage() {
  const accounts = discoverAccounts();
  const data = (
    await Promise.all(
      accounts.map(async (acc) => {
        try {
          if (acc.provider === "claude") {
            const oauth = readClaudeOAuth(acc.dir) || {};
            // No usable creds on this device (e.g. a devbox-only account seen
            // from the Mac): hide it rather than showing a "not signed in" row.
            if (!oauth.accessToken) return null;
            const identity = readClaudeIdentity(acc.dir);
            const usage = await fetchClaudeUsage(oauth.accessToken);
            return { provider: "claude", label: acc.label, ...identity, usage, error: null };
          }
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
  usageCache = { at: Date.now(), data };
  return data;
}

let usageScan = null;
// Serve usage without ever blocking on the network once warm: a fresh cache is
// returned as-is, a stale one is returned immediately and refreshed in the
// background, and only a cold start waits for the first fetch (sharing one
// in-flight scan). The cache is warmed at boot, so the menu is instant.
export function collectUsage() {
  const now = Date.now();
  if (usageCache.data) {
    if (now - usageCache.at >= USAGE_FRESH_MS && !usageScan) {
      usageScan = refreshUsage()
        .catch(() => usageCache.data)
        .finally(() => {
          usageScan = null;
        });
    }
    return Promise.resolve(usageCache.data);
  }
  if (!usageScan) {
    usageScan = refreshUsage().finally(() => {
      usageScan = null;
    });
  }
  return usageScan;
}
