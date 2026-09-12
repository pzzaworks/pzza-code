import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transform } from "esbuild";
const source = await fs.readFile(new URL("../src/usageFallback.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { accountSpendKey, loadDeviceSpend, mergeDeviceUsage, loadDeviceUsage } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const account = (provider, email, good = true) => ({ provider, label: provider, email, usage: good ? { scoped: [] } : null, error: good ? null : "Unavailable" });

test("healthy local providers win while remote devices fill missing providers and deduplicate accounts", () => {
  const local = [account("claude", "local@example.test"), account("codex", "other@example.test", false)];
  const remote = [account("claude", "remote@example.test"), account("codex", "other@example.test"), account("codex", "other@example.test")];
  assert.deepEqual(mergeDeviceUsage(local, remote), [local[0], remote[1]]);
});

test("publishes a healthy remote device while another connected device is still pending", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const updates = [];
  const work = loadDeviceUsage([{ host: "fast", name: "Fast device" }, { host: "slow", name: "Slow device" }], async host => {
    if (!host) return [];
    if (host === "slow") { await blocked; throw new Error("Offline"); }
    return [account("claude", "account@example.test")];
  }, value => updates.push(value));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.at(-1)[0].sourceName, "Fast device");
  release();
  await work;
});

test("does not contact devices when all local providers already have usage", async () => {
  const calls = [];
  await loadDeviceUsage([{ host: "remote", name: "Remote" }], async host => {
    calls.push(host); return [account("claude", "a@example.test"), account("codex", "b@example.test"), account("opencode", "c@example.test")];
  }, () => {});
  assert.deepEqual(calls, [""]);
});

test("spend for matching local and remote account labels remains separate", async () => {
  const updates = [];
  const calls = [];
  const spend = host => ({ provider: "claude", label: "Default", today: { tokens: host ? 200 : 100 } });
  await loadDeviceSpend([{ host: "remote", name: "Remote" }, { host: "remote", name: "Duplicate" }], async host => {
    calls.push(host); return [spend(host)];
  }, value => updates.push(value));
  const local = { provider: "claude", label: "Default" };
  const remote = { ...local, sourceHost: "remote" };
  assert.equal(updates.at(-1)[accountSpendKey(local)].today.tokens, 100);
  assert.equal(updates.at(-1)[accountSpendKey(remote)].today.tokens, 200);
  assert.deepEqual(calls.sort(), ["", "remote"]);
});

test("remote spend publishes before a slow local scan and survives another device failing", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const updates = [];
  const remote = { provider: "claude", label: "Default", sourceHost: "fast", today: { tokens: 300 } };
  const work = loadDeviceSpend([{ host: "slow", name: "Offline" }, { host: "fast", name: "Fast" }], async host => {
    if (!host) { await blocked; return []; }
    if (host === "slow") throw new Error("Offline");
    return [remote];
  }, value => updates.push(value));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(updates.at(-1)[accountSpendKey(remote)].today.tokens, 300);
  release();
  await work;
  assert.equal(updates.at(-1)[accountSpendKey(remote)].today.tokens, 300);
});
