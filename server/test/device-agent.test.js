import test from "node:test";
import assert from "node:assert/strict";
import { createRemoteUsage, deviceAgentRequest } from "../lib/device-agent.js";

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
});
