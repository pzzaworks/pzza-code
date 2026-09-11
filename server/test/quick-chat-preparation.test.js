import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ entryPoints: ["src/state/quickChatSession.ts"], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const { createQuickChatPreparation, createAttachmentRecovery } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
const settle = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

function clock() {
  let id = 0;
  const timers = new Map();
  return {
    schedule: (callback, delay) => { timers.set(++id, { callback, delay }); return id; },
    unschedule: id => timers.delete(id),
    next: () => {
      const next = Array.from(timers).sort((a, b) => a[1].delay - b[1].delay)[0];
      assert.ok(next, "a retry must be scheduled");
      timers.delete(next[0]); next[1].callback();
      return next[1].delay;
    },
    timers,
  };
}

test("startup reuses the conversation without closing it and deduplicates matching launches", async () => {
  const calls = [];
  const prepare = createQuickChatPreparation(async (host, agent) => {
    calls.push([host, agent]);
    return { session: "pzza-quick-chat", host, agent, launcher: agent, identity: "$1:100:200" };
  });
  const first = prepare("", "claude");
  assert.equal(prepare("", "claude"), first);
  const chat = await first;
  assert.equal(await prepare("", "claude"), chat);
  assert.equal((await prepare("another-device", "codex")).host, "another-device");
  assert.deepEqual(calls, [["", "claude"], ["another-device", "codex"]]);
  let attempts = 0;
  const retry = createQuickChatPreparation(async (host, agent) => {
    if (++attempts === 1) throw new Error("Device unavailable");
    return { session: "pzza-quick-chat", host, agent, launcher: agent, identity: "$1:100:200" };
  });
  await assert.rejects(retry("", "claude"), /Device unavailable/);
  assert.equal((await retry("", "claude")).agent, "claude");
});

test("failed verification backs off with bounded jitter, never attaches, and pauses after six attempts", async () => {
  const time = clock();
  const statuses = [];
  let verifies = 0;
  const recovery = createAttachmentRecovery({
    ...time, random: () => 0.5, status: state => statuses.push(state), detach: () => {},
    verify: async () => { verifies++; throw new Error("Offline"); },
    attach: async () => assert.fail("unverified session must not be attached"),
  });
  recovery.start();
  await settle();
  const delays = [];
  for (let attempt = 1; attempt < 6; attempt++) { delays.push(time.next()); await settle(); }
  assert.deepEqual(delays, [500, 1000, 2000, 4000, 8000]);
  assert.equal(verifies, 6);
  assert.equal(statuses.at(-1).phase, "disconnected");
  assert.equal(time.timers.size, 0);
  recovery.retry();
  await settle();
  assert.equal(verifies, 7);
  recovery.stop();
  assert.equal(time.timers.size, 0);
});

test("late verification is cancelled on reconfigure/shutdown, with no attachment or input replay", async () => {
  const time = clock();
  let resolve;
  let verifySignal;
  let attaches = 0;
  const recovery = createAttachmentRecovery({ ...time, status: () => {}, detach: () => {},
    verify: signal => { verifySignal = signal; return new Promise(done => { resolve = done; }); },
    attach: async () => { attaches++; },
  });
  recovery.start();
  recovery.stop();
  resolve();
  await settle();
  assert.equal(verifySignal.aborted, true);
  assert.equal(attaches, 0);
  assert.equal(time.timers.size, 0);
});

test("attachment loss retries the same verified session while preserving a single recovery controller", async () => {
  const time = clock();
  const statuses = [];
  let attaches = 0;
  let detached = 0;
  const signals = [];
  const recovery = createAttachmentRecovery({ ...time, random: () => 1, status: value => statuses.push(value),
    verify: async signal => { signals.push(signal); }, attach: async () => { attaches++; }, detach: () => { detached++; },
  });
  recovery.start(); await settle();
  recovery.ready();
  assert.equal(statuses.at(-1).phase, "connected");
  // Merely hiding/reopening does not call any controller method.
  assert.equal(attaches, 1);
  recovery.failed("SSH connection lost");
  assert.equal(signals[0].aborted, true);
  assert.equal(detached, 1);
  assert.equal(time.next(), 600);
  await settle();
  assert.equal(attaches, 2);
  assert.equal(statuses.at(-1).attempt, 2);
  recovery.ready();
  assert.equal(time.next(), 15000, "only sustained connection resets the budget");
  recovery.failed("Disconnected again");
  assert.equal(statuses.at(-1).attempt, 0);
  recovery.stop();
});
