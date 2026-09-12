import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { randomUUID } from "node:crypto";
import { syncBuiltinESMExports } from "node:module";
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

test("pairing can check and withdraw a receiving-device approval through trusted SSH", async t => {
  const requests = [];
  const approvalId = randomUUID();
  const transport = t.mock.method(childProcess, "execFile", (command, args, _options, callback) => {
    assert.equal(command, "ssh");
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.ok(args.includes("ForwardAgent=no"));
    assert.ok(args.includes("PermitLocalCommand=no"));
    assert.equal(args.at(-2), "trusted-device");
    return { stdin: {
      on() {},
      end(input) {
        const request = JSON.parse(input);
        requests.push(request);
        callback(null, JSON.stringify({ id: approvalId, status: request.endpoint === "/bridge/approval-status" ? "waiting_approval" : "cancelled" }));
      },
    } };
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await deviceAgentRequest("trusted-device", "/bridge/approval-status", { approvalId }), { id: approvalId, status: "waiting_approval" });
    assert.deepEqual(await deviceAgentRequest("trusted-device", "/bridge/approval-cancel", { approvalId }), { id: approvalId, status: "cancelled" });
    assert.deepEqual(requests, [
      { endpoint: "/bridge/approval-status", body: { approvalId } },
      { endpoint: "/bridge/approval-cancel", body: { approvalId } },
    ]);
  } finally {
    transport.mock.restore();
    syncBuiltinESMExports();
  }
});

test("approval transport cannot approve access or call unrelated endpoints", async t => {
  const transport = t.mock.method(childProcess, "execFile", () => { assert.fail("Rejected routes must never start SSH"); });
  syncBuiltinESMExports();
  try {
    for (const endpoint of ["/bridge/approve", "/bridge/local-decision", "/bridge/configure", "/bridge/dispatch", "/bridge/revoke", "/bridge/approval-status?approved=true", "/bridge/approval-cancel/../local-decision"]) {
      await assert.rejects(deviceAgentRequest("trusted-device", endpoint, { approvalId: randomUUID(), approved: true }), /Invalid device agent request/);
    }
    for (const endpoint of ["/bridge/approval-status", "/bridge/approval-cancel"]) {
      await assert.rejects(deviceAgentRequest("trusted-device", endpoint), /Invalid device agent request/);
      await assert.rejects(deviceAgentRequest("-x", endpoint, { approvalId: randomUUID() }), /Invalid device agent request/);
    }
    assert.equal(transport.mock.callCount(), 0);
  } finally {
    transport.mock.restore();
    syncBuiltinESMExports();
  }
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
