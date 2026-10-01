import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { transform } from "esbuild";
const source = await fs.readFile(new URL("../src/usageFallback.ts", import.meta.url), "utf8");
const { code } = await transform(source, { loader: "ts", format: "esm" });
const { accountSpendKey, loadDeviceSpend, mergeDeviceUsage, loadDeviceUsage } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const account = (provider, email, good = true) => ({ provider, label: provider, email, usage: good ? { scoped: [] } : null, error: good ? null : "Unavailable" });

test("free-plan cards are hidden no matter which device reported them", () => {
  const free = { ...account("codex", "free@example.test"), plan: "Free" };
  const paid = account("codex", "paid@example.test");
  assert.deepEqual(mergeDeviceUsage([], [free, paid]), [paid]);
  assert.deepEqual(mergeDeviceUsage([free], [paid]), [paid]);
  assert.deepEqual(mergeDeviceUsage([{ ...free, plan: "free" }], []), []);
});

test("every device's accounts are merged and the freshest sample of a shared account wins", () => {
  const stamp = (value, updatedAt, stale = false) => ({ ...value, usage: { scoped: [], updatedAt, stale } });
  const local = [account("claude", "local@example.test"), stamp(account("claude", "shared@example.test"), 5, true), account("codex", "other@example.test", false)];
  const remote = [account("claude", "remote@example.test"), stamp(account("claude", "Shared@example.test"), 1), account("codex", "other@example.test"), account("codex", "other@example.test")];
  assert.deepEqual(mergeDeviceUsage(local, remote), [local[0], remote[1], remote[2], remote[0]]);
  const newer = stamp(account("claude", "shared@example.test"), 9);
  assert.equal(mergeDeviceUsage([stamp(account("claude", "shared@example.test"), 3)], [newer])[0], newer);
});

test("remote opencode cards with different key fingerprints are kept side by side", () => {
  const a = { ...account("opencode"), keyHint: "aaaa…1111" };
  const b = { ...account("opencode"), keyHint: "bbbb…2222" };
  assert.deepEqual(mergeDeviceUsage([], [a, b]), [a, b]);
  assert.equal(mergeDeviceUsage([], [a, { ...b, keyHint: "aaaa…1111" }]).length, 1);
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

test("always queries every device so accounts signed in elsewhere are shown", async () => {
  const calls = [];
  const updates = [];
  await loadDeviceUsage([{ host: "remote", name: "Remote" }], async host => {
    calls.push(host);
    return host ? [account("claude", "elsewhere@example.test")] : [account("claude", "a@example.test"), account("codex", "b@example.test")];
  }, value => updates.push(value));
  assert.deepEqual(calls.sort(), ["", "remote"]);
  assert.deepEqual(updates.at(-1).map(value => value.email), ["a@example.test", "b@example.test", "elsewhere@example.test"]);
});

test("previous cards stay visible until every device has answered", async () => {
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const updates = [];
  const previous = [{ ...account("claude", "remote@example.test"), sourceHost: "remote" }];
  const work = loadDeviceUsage([{ host: "remote", name: "Remote" }], async host => {
    if (host) { await blocked; return []; }
    return [account("claude", "local@example.test")];
  }, value => updates.push(value), previous);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(updates.at(-1).map(value => value.email), ["local@example.test", "remote@example.test"]);
  release();
  await work;
  assert.deepEqual(updates.at(-1).map(value => value.email), ["local@example.test"]);
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
