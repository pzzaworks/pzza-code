import assert from "node:assert/strict";
import test from "node:test";
import { createUsageLimiter, fetchOpencodeUsage, fixClaudeToken, usageResponseError, USAGE_FRESH_MS } from "../lib/usage.js";

test("duplicate accounts and refresh requests share calls and respect freshness", async () => {
  let now = 0;
  let calls = 0;
  const limited = createUsageLimiter(() => now);
  const fetchUsage = async () => { calls++; return { five_hour: { utilization: 12 } }; };
  const values = await Promise.all([limited("account", fetchUsage), limited("account", fetchUsage)]);
  assert.deepEqual(values[0], values[1]);
  await limited("account", fetchUsage);
  assert.equal(calls, 1);
  now += USAGE_FRESH_MS;
  await limited("account", fetchUsage);
  assert.equal(calls, 2);
});

test("429 preserves last successful usage and honors Retry-After despite refreshes", async () => {
  let now = 0;
  let calls = 0;
  const limited = createUsageLimiter(() => now);
  const fetchUsage = async () => {
    calls++;
    if (calls === 2) throw usageResponseError(new Response(null, { status: 429, headers: { "Retry-After": "900" } }), now);
    return { five_hour: { utilization: calls } };
  };
  await limited("account", fetchUsage);
  now = USAGE_FRESH_MS;
  const stale = await limited("account", fetchUsage);
  assert.equal(stale.stale, true);
  assert.equal(stale.five_hour.utilization, 1);
  assert.equal(stale.retryAt, now + 900_000);
  now += 899_999;
  await limited("account", fetchUsage);
  assert.equal(calls, 2);
  now++;
  assert.equal((await limited("account", fetchUsage)).stale, false);
  assert.equal(calls, 3);
});

test("cold rate limits back off exponentially and HTTP-date Retry-After is parsed", async () => {
  let now = Date.parse("2026-01-01T00:00:00Z");
  let calls = 0;
  const limited = createUsageLimiter(() => now);
  const fetchUsage = async () => { calls++; throw usageResponseError(new Response(null, { status: 429 }), now); };
  await assert.rejects(limited("account", fetchUsage), /rate limited/);
  await assert.rejects(limited("account", fetchUsage), /rate limited/);
  assert.equal(calls, 1);
  now += USAGE_FRESH_MS;
  await assert.rejects(limited("account", fetchUsage), /rate limited/);
  now += USAGE_FRESH_MS;
  await assert.rejects(limited("account", fetchUsage), /rate limited/);
  assert.equal(calls, 2);
  const error = usageResponseError(new Response(null, { status: 429, headers: { "Retry-After": new Date(now + 600_000).toUTCString() } }), now);
  assert.equal(error.retryAfterMs, 600_000);
});

test("rejected credentials do not keep displaying a previous successful sample", async () => {
  let now = 0;
  const limited = createUsageLimiter(() => now);
  await limited("account", async () => ({ five_hour: { utilization: 1 } }));
  now += USAGE_FRESH_MS;
  await assert.rejects(limited("account", async () => { throw usageResponseError(new Response(null, { status: 401 })); }), /401/);
});

test("manual refresh bypasses successful cache and deduplicates concurrent requests", async () => {
  let calls = 0;
  const limited = createUsageLimiter(() => 0);
  const fetchUsage = async () => ({ five_hour: { utilization: ++calls } });
  await limited("account", fetchUsage);
  const results = await Promise.all([
    limited("account", fetchUsage, { fresh: true }),
    limited("account", fetchUsage, { fresh: true }),
  ]);
  assert.equal(calls, 2);
  assert.equal(results[0].five_hour.utilization, 2);
  assert.deepEqual(results[0], results[1]);
  await limited("account", fetchUsage);
  assert.equal(calls, 2);
});

test("manual refresh still honors provider error cooldown", async () => {
  let calls = 0;
  const limited = createUsageLimiter(() => 0);
  const fetchUsage = async () => {
    calls++;
    throw usageResponseError(new Response(null, { status: 429, headers: { "Retry-After": "900" } }), 0);
  };
  await assert.rejects(limited("account", fetchUsage), /rate limited/);
  await assert.rejects(limited("account", fetchUsage, { fresh: true }), /rate limited/);
  assert.equal(calls, 1);
});

test("opencode credits map to a quota window while unsupported accounts stay hidden", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url, init) => {
      if (String(url).includes("zen/go")) {
        return new Response(JSON.stringify({}), { headers: { "Content-Type": "application/json" } });
      }
      assert.equal(url, "https://api.opencode.ai/v1/credits");
      assert.equal(init.headers.Authorization, "Bearer sk-test");
      return new Response(JSON.stringify({ data: { total_credits: 100, used_credits: 25, remaining_credits: 75 } }), {
        headers: { "Content-Type": "application/json" },
      });
    };
    assert.deepEqual(await fetchOpencodeUsage("sk-test"), {
      five_hour: null,
      seven_day: null,
      scoped: [{ name: "Credits", percent: 25, resets_at: null }],
    });
    globalThis.fetch = async () => new Response("Not Found", { headers: { "Content-Type": "text/html" } });
    await assert.rejects(fetchOpencodeUsage("sk-test"), /unavailable for this account/);
    globalThis.fetch = async () => new Response("{}", { status: 401 });
    await assert.rejects(fetchOpencodeUsage("sk-test"), /401/);
    globalThis.fetch = async () => new Response(JSON.stringify({ data: {} }), { headers: { "Content-Type": "application/json" } });
    await assert.rejects(fetchOpencodeUsage("sk-test"), /unavailable for this account/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("opencode zen windows map without a credits quota", async () => {
  const realFetch = globalThis.fetch;
  try {
    globalThis.fetch = async (url) => {
      if (String(url).includes("/v1/credits")) return new Response("Not Found", { headers: { "Content-Type": "text/html" } });
      return new Response(JSON.stringify({ usage: {
        rolling: { status: "ok", percent: 12, resetsAt: "2026-09-11T10:00:00Z" },
        weekly: { status: "ok", percent: 34, resetsAt: "2026-09-16T10:00:00Z" },
        monthly: { status: "ok", percent: 56, resetsAt: "2026-10-01T10:00:00Z" },
      } }), { headers: { "Content-Type": "application/json" } });
    };
    assert.deepEqual(await fetchOpencodeUsage("sk-test"), {
      five_hour: null,
      seven_day: { utilization: 34, resets_at: "2026-09-16T10:00:00Z" },
      scoped: [
        { name: "Rolling", percent: 12, resets_at: "2026-09-11T10:00:00Z" },
        { name: "Monthly", percent: 56, resets_at: "2026-10-01T10:00:00Z" },
      ],
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("claude token repair runs the CLI once and reports the outcome", async () => {
  const calls = [];
  const run = (cmd, args, options, callback) => {
    calls.push([cmd, args, options.timeout]);
    queueMicrotask(() => callback(null, "ok\n"));
  };
  assert.deepEqual(await fixClaudeToken({ run }), { ok: true });
  assert.deepEqual(calls, [["claude", ["--print", "Reply with exactly: ok"], 90000]]);
  const failing = (_cmd, _args, _options, callback) => queueMicrotask(() => callback(new Error("no auth")));
  const result = await fixClaudeToken({ run: failing });
  assert.equal(result.ok, false);
  assert.match(result.error, /Run claude once in a terminal/);
});
