import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";

test("startup prepares once, preserves the running choice, and retries failed preparation", async t => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "quick-chat-preparation-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const outfile = path.join(dir, "session.mjs");
  await build({ entryPoints: ["src/state/quickChatSession.ts"], outfile, bundle: true, format: "esm", platform: "node", logLevel: "silent" });
  const { createQuickChatPreparation } = await import(pathToFileURL(outfile).href);
  const calls = [];
  const prepare = createQuickChatPreparation(async (host, agent) => {
    calls.push(["open", host, agent]);
    return { session: "pzza-quick-chat", host, agent };
  }, async host => { calls.push(["close", host]); });
  const first = prepare("", "claude");
  assert.equal(prepare("", "claude"), first, "effect re-entry shares one startup request");
  const chat = await first;
  assert.equal(await prepare("another-device", "codex"), chat, "preference changes cannot reset an active conversation");
  assert.deepEqual(calls, [["close", ""], ["open", "", "claude"]]);
  let attempts = 0;
  const retry = createQuickChatPreparation(async (host, agent) => ({ session: "pzza-quick-chat", host, agent }), async () => {
    if (++attempts === 1) throw new Error("Device unavailable");
  });
  await assert.rejects(retry("", "claude"), /Device unavailable/);
  assert.equal((await retry("", "claude")).agent, "claude");
  assert.equal(attempts, 2);
});
