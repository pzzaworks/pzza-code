import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteSpend, createRemoteUsage, deviceAgentRequest } from "../lib/device-agent.js";

test("remote usage shares requests and immediately serves warm samples", async () => {
  let clock = 1;
  let calls = 0;
  let release;
  const usage = createRemoteUsage({ now: () => clock, request: async () => {
    calls++;
    if (calls === 2) await new Promise(resolve => { release = resolve; });
    return [{ provider: "claude", usage: { five_hour: { utilization: calls } } }];
  } });
  await Promise.all([usage("host"), usage("host")]);
  assert.equal(calls, 1);
  clock += 300001;
  assert.equal((await usage("host"))[0].usage.five_hour.utilization, 1);
  assert.equal(calls, 2);
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal((await usage("host"))[0].usage.five_hour.utilization, 2);
});

test("unavailable devices are cooled down and host or endpoint injection is rejected", async () => {
  let calls = 0;
  const usage = createRemoteUsage({ request: async () => { calls++; throw new Error("offline"); } });
  await assert.rejects(usage("host"), /offline/);
  await assert.rejects(usage("host"), /offline/);
  assert.equal(calls, 1);
  await assert.rejects(deviceAgentRequest("-x", "/usage"), /Invalid/);
  await assert.rejects(deviceAgentRequest("host", "/file/read?path=private"), /Invalid/);
  await assert.rejects(deviceAgentRequest("host", "/spend?host=other"), /Invalid/);
  await assert.rejects(deviceAgentRequest("host", "/spend", {}), /Invalid/);
});

test("remote spend caches each device, deduplicates requests, and forwards explicit refresh", async () => {
  const calls = [];
  const spend = createRemoteSpend({ request: async (host, endpoint) => {
    calls.push([host, endpoint]);
    return [{ provider: "claude", label: "Default", today: { tokens: calls.length } }];
  } });
  const [first, shared] = await Promise.all([spend("first"), spend("first")]);
  assert.deepEqual(first, shared);
  assert.equal((await spend("second"))[0].today.tokens, 2);
  assert.equal((await spend("first"))[0].today.tokens, 1);
  assert.equal((await spend("first", true))[0].today.tokens, 3);
  assert.deepEqual(calls, [["first", "/spend"], ["second", "/spend"], ["first", "/spend?fresh=1"]]);
});

test("remote spend preserves warm totals during refresh failures and cools down unavailable devices", async () => {
  let clock = 1;
  let calls = 0;
  const spend = createRemoteSpend({ now: () => clock, request: async () => {
    calls++;
    if (calls > 1) throw new Error("Offline");
    return [{ provider: "claude", label: "Default", today: { tokens: 200 } }];
  } });
  const first = await spend("warm");
  assert.deepEqual(await spend("warm", true), first);
  assert.deepEqual(await spend("warm"), first);
  assert.equal(calls, 2);
  await assert.rejects(spend("offline"), /Offline/);
  await assert.rejects(spend("offline"), /Offline/);
  assert.equal(calls, 3);
  clock += 30001;
  await assert.rejects(spend("offline"), /Offline/);
  assert.equal(calls, 4);
});

test("remote spend rejects invalid hosts and non-account responses", async () => {
  let calls = 0;
  const spend = createRemoteSpend({ request: async () => { calls++; return {}; } });
  await assert.rejects(spend("-x"), /Invalid device host/);
  assert.equal(calls, 0);
  await assert.rejects(spend("host"), /Invalid device account response/);
});

test("shared remote caching still marks quota samples stale after a failed refresh", async () => {
  let calls = 0;
  const usage = createRemoteUsage({ request: async () => {
    if (calls++) throw new Error("Offline");
    return [{ provider: "claude", usage: { five_hour: { utilization: 25 } } }];
  } });
  await usage("host");
  const [account] = await usage("host", true);
  assert.equal(account.usage.stale, true);
  assert.equal(account.usage.five_hour.utilization, 25);
});
