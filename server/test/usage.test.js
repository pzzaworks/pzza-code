import assert from "node:assert/strict";
import test from "node:test";
import { createUsageLimiter, usageResponseError, USAGE_FRESH_MS } from "../lib/usage.js";

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
