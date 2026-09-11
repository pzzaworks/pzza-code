// Agent usage (Claude / Codex accounts on this device). Reads the same OAuth
// usage the official apps show, from locally-stored creds, and caches it so the
// panel is instant and the provider endpoints are not polled too hard.
import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { discoverAccounts, readClaudeOAuth, readClaudeIdentity, readCodexCreds, readOpencodeKey } from "./accounts.js";

export const USAGE_FRESH_MS = 5 * 60 * 1000; // the endpoints 429 if polled harder
// A failed entry (expired token, provider hiccup) is retried much sooner, so the
// panel recovers right after the CLI refreshes its token instead of showing the
// stale failure for the whole cache window.
const USAGE_RETRY_MS = 30 * 1000;
let usageCache = { at: 0, data: null, failed: false };

export function usageResponseError(res, now = Date.now()) {
  const error = new Error(res.status === 429 ? "Usage rate limited; retrying automatically after cooldown." : `usage ${res.status}`);
  error.status = res.status;
  const retry = res.headers.get("retry-after");
  const seconds = retry === null ? NaN : Number(retry);
  error.retryAfterMs = Number.isFinite(seconds)
    ? Math.max(0, seconds * 1000)
    : Math.max(0, (Date.parse(retry || "") || now) - now);
  return error;
}

// Share calls across duplicate account directories and enforce provider cooldowns
// even when the UI requests a refresh. Keep the last successful sample on outages.
export function createUsageLimiter(now = Date.now) {
  const entries = new Map();
  return function limitedUsage(key, fetchUsage, { fresh = false } = {}) {
    let entry = entries.get(key);
    if (!entry) {
      entry = { value: null, error: null, nextAt: 0, failures: 0, pending: null };
      entries.set(key, entry);
    }
    const cached = () => entry.value
      ? { ...entry.value, stale: !!entry.error, retryAt: entry.error ? entry.nextAt : null }
      : Promise.reject(entry.error);
    if (entry.pending) return entry.pending;
    if (now() < entry.nextAt && (!fresh || entry.error)) return Promise.resolve(cached());
    entry.pending = Promise.resolve().then(fetchUsage).then((value) => {
      entry.value = { ...value, updatedAt: now() };
      entry.error = null;
      entry.failures = 0;
      entry.nextAt = now() + USAGE_FRESH_MS;
      return cached();
    }).catch((error) => {
      entry.error = error;
      entry.failures++;
      const backoff = error.status === 429
        ? Math.max(error.retryAfterMs || 0, Math.min(60 * 60 * 1000, USAGE_FRESH_MS * 2 ** Math.min(entry.failures - 1, 4)))
        : USAGE_RETRY_MS;
      entry.nextAt = now() + backoff;
      // Rejected credentials must not appear signed in using an old sample.
      if (error.status === 401 || error.status === 403) entry.value = null;
      return cached();
    }).finally(() => { entry.pending = null; });
    return entry.pending;
  };
}

const limitedUsage = createUsageLimiter();
const credentialKey = (provider, token, accountId = "") =>
  crypto.createHash("sha256").update(`${provider}\0${token}\0${accountId}`).digest("hex");

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
  if (!res.ok) throw usageResponseError(res);
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
  if (!res.ok) throw usageResponseError(res);
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
const OPENCODE_SIGNIN_HINT = "reconnect OpenCode Zen with /connect in opencode";

// Usage for one Claude account. Claude Code refreshes the OAuth token itself
// whenever it runs and the agent never refreshes on its behalf (a refresh
// rotates the token and could sign the CLI out), so an expired or rejected
// token is reported as exactly that instead of a bare "usage 401".
async function claudeAccountUsage(acc, fresh) {
  const oauth = await readClaudeOAuth(acc.dir);
  // No usable creds on this device (e.g. a devbox-only account seen from the
  // Mac): hide it rather than showing a "not signed in" row.
  if (!oauth?.accessToken) return null;
  const entry = { provider: "claude", label: acc.label, ...readClaudeIdentity(acc.dir), usage: null, error: null };
  if (oauth.expiresAt && Number(oauth.expiresAt) <= Date.now()) {
    return { ...entry, error: `Session token expired - ${CLAUDE_SIGNIN_HINT}` };
  }
  try {
    return { ...entry, usage: await limitedUsage(credentialKey("claude", oauth.accessToken), () => fetchClaudeUsage(oauth.accessToken), { fresh }) };
  } catch (e) {
    if (!/\b401\b/.test(String(e.message))) throw e;
    // The CLI may have rotated the token between our read and the call: re-read
    // once and retry with the new one before giving up.
    const again = await readClaudeOAuth(acc.dir);
    if (again?.accessToken && again.accessToken !== oauth.accessToken) {
      return { ...entry, usage: await limitedUsage(credentialKey("claude", again.accessToken), () => fetchClaudeUsage(again.accessToken), { fresh }) };
    }
    return { ...entry, error: `Session token rejected - ${CLAUDE_SIGNIN_HINT}` };
  }
}

// OpenCode Zen usage. Two endpoints cover the two account kinds, and neither
// is universal: the credits API answers quota accounts but returns 200 with a
// non-JSON body otherwise, while the Zen usage API reports rolling, weekly
// and monthly windows. Each side degrades to null on its own; only when both
// come back empty does the account stay hidden instead of erroring.
// Exported for unit tests.
export async function fetchOpencodeUsage(apiKey) {
  const get = async (url) => {
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": "pzza-code/1.0" },
      signal: AbortSignal.timeout(8000),
    });
    if (!res.ok) throw usageResponseError(res);
    if (!(res.headers.get("content-type") || "").includes("json")) return null;
    return res.json();
  };
  const credits = await (async () => {
    const j = await get("https://api.opencode.ai/v1/credits");
    if (!j) return null;
    const total = Number(j?.data?.total_credits);
    const used = Number(j?.data?.used_credits);
    if (!Number.isFinite(total) || !Number.isFinite(used) || total <= 0) return null;
    return { name: "Credits", percent: Math.min(100, Math.max(0, (used / total) * 100)), resets_at: null };
  })();
  const windows = await (async () => {
    const j = await get("https://opencode.ai/zen/go/v1/usage");
    return j && typeof j === "object" && j.usage && typeof j.usage === "object" ? j.usage : null;
  })();
  const win = (w) => w && Number.isFinite(Number(w?.percent))
    ? { utilization: Math.min(100, Math.max(0, Number(w.percent))), resets_at: w.resetsAt ?? null }
    : null;
  const weekly = windows ? win(windows.weekly) : null;
  const scoped = [
    ...(credits ? [credits] : []),
    ...(windows && win(windows.rolling) ? [{ name: "Rolling", ...win(windows.rolling) }] : []),
    ...(windows && win(windows.monthly) ? [{ name: "Monthly", ...win(windows.monthly) }] : []),
  ];
  if (!weekly && scoped.length === 0) {
    throw Object.assign(new Error("Zen usage is unavailable for this account."), { unsupported: true });
  }
  return { five_hour: null, seven_day: weekly, scoped };
}

async function opencodeAccountUsage(acc, fresh) {
  const apiKey = readOpencodeKey();
  // No usable key on this device: hide it rather than showing a row that can
  // never load (mirrors the Claude behavior above).
  if (!apiKey) return null;
  const entry = { provider: "opencode", label: acc.label, plan: "Zen", usage: null, error: null };
  try {
    return { ...entry, usage: await limitedUsage(credentialKey("opencode", apiKey), () => fetchOpencodeUsage(apiKey), { fresh }) };
  } catch (e) {
    if (e?.unsupported) return null;
    if (e?.status === 401 || e?.status === 403) return { ...entry, error: `Zen API key rejected - ${OPENCODE_SIGNIN_HINT}` };
    throw e;
  }
}

// Fetch every account's usage from the provider APIs (in parallel) and cache it.
async function refreshUsage(fresh) {
  const accounts = discoverAccounts();
  const data = (
    await Promise.all(
      accounts.map(async (acc) => {
        try {
          if (acc.provider === "claude") return await claudeAccountUsage(acc, fresh);
          if (acc.provider === "opencode") return await opencodeAccountUsage(acc, fresh);
          if (!fs.existsSync(path.join(acc.dir, "auth.json"))) return null;
          const creds = readCodexCreds(acc.dir);
          if (!creds.accessToken) return null;
          const usage = await limitedUsage(credentialKey("codex", creds.accessToken, creds.accountId), () => fetchCodexUsage(creds), { fresh });
          return { provider: "codex", label: acc.label, email: creds.email, plan: creds.plan, usage, error: null };
        } catch (e) {
          return { provider: acc.provider, label: acc.label, usage: null, error: String(e.message || e) };
        }
      }),
    )
  ).filter(Boolean);
  usageCache = { at: Date.now(), data, failed: data.some((a) => a.error || a.usage?.stale) };
  return data;
}

let usageScan = null;
function startScan(fresh = false) {
  usageScan = refreshUsage(fresh).finally(() => {
    usageScan = null;
  });
  return usageScan;
}

// Serve usage without ever blocking on the network once warm: a fresh cache is
// returned as-is, a stale one is returned immediately and refreshed in the
// background, and only a cold start waits for the first fetch (sharing one
// in-flight scan). The cache is warmed at boot, so the menu is instant. `fresh`
// (the panel's refresh button) re-reads credentials, respecting provider cooldowns.
export function collectUsage({ fresh = false } = {}) {
  if (fresh || !usageCache.data) {
    return (usageScan ?? startScan(fresh)).catch(() => usageCache.data ?? Promise.reject(new Error("usage unavailable")));
  }
  const ttl = usageCache.failed ? USAGE_RETRY_MS : USAGE_FRESH_MS;
  if (Date.now() - usageCache.at >= ttl && !usageScan) startScan().catch(() => undefined);
  return Promise.resolve(usageCache.data);
}

// One-shot Claude token repair behind an explicit Fix action. Running the CLI
// itself is the only safe refresh: minting tokens here would rotate the CLI's
// credentials out from under it. A minimal non-interactive prompt keeps the
// cost negligible, and the caller re-reads usage afterwards.
export function fixClaudeToken({ run = execFile } = {}) {
  return new Promise((resolve) => {
    run("claude", ["--print", "Reply with exactly: ok"], { timeout: 90000, maxBuffer: 1024 * 1024 }, (error) => {
      if (error) return resolve({ ok: false, error: "Claude could not refresh the token. Run claude once in a terminal." });
      resolve({ ok: true });
    });
  });
}
