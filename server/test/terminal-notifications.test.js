import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const built = await build({ entryPoints: ["src/terminal/notificationSignals.ts"], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
const { createTerminalSignals } = await import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);

function fixture(attachment = true) {
  const events = [];
  let clock = 0;
  const signals = createTerminalSignals("tile-id", (event) => events.push(event), { attachment, now: () => clock });
  return { signals, events, advance: (ms) => { clock += ms; } };
}

test("explicit terminal bells are rate limited and routed to their originating tile", () => {
  const f = fixture();
  f.signals.bell();
  f.signals.bell();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].title, "Terminal needs attention");
  assert.deepEqual(f.events[0].target, { tileId: "tile-id" });
  assert.equal(f.events[0].dedupeKey, "terminal-bell:tile-id");
  f.advance(10_000);
  f.signals.bell();
  assert.equal(f.events.length, 2);
});

test("completion requires an explicit command start and bounded numeric completion status", () => {
  const f = fixture();
  f.signals.osc133("D;0");
  f.advance(60_000);
  assert.equal(f.events.length, 0);
  assert.equal(f.signals.osc133("C"), false);
  assert.equal(f.signals.osc133("D;0"), false);
  f.signals.osc133("D;0");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].title, "Terminal reported completion");
  f.signals.osc133("C");
  f.signals.osc133("D;2");
  assert.equal(f.events[1].title, "Terminal reported failure");
  for (const status of ["D", "D;256", "D;0;private-output", "D;-1", "D;invalid", "D;" + "x".repeat(1000)]) {
    f.signals.osc133("C");
    f.signals.osc133(status);
    assert.equal(f.events.length, 2);
  }
  f.signals.osc133("A");
  f.signals.osc133("D;0");
  assert.equal(f.events.length, 2);
  assert.ok(!JSON.stringify(f.events).includes("private-output"));
});

test("real process exit is distinct from successful attachment detach and cleanup", () => {
  const attached = fixture();
  attached.signals.processExit(0);
  assert.equal(attached.events.length, 0);
  attached.signals.bell();
  assert.equal(attached.events.length, 0);
  const failed = fixture();
  failed.signals.processExit(255);
  failed.signals.processExit(255);
  assert.equal(failed.events.length, 1);
  assert.equal(failed.events[0].title, "Terminal process failed");
  const direct = fixture(false);
  direct.signals.processExit(0);
  assert.equal(direct.events[0].title, "Terminal process finished");
  const detached = fixture();
  detached.signals.osc133("C");
  detached.signals.dispose();
  detached.signals.processExit(1);
  detached.signals.bell();
  detached.signals.osc133("D;0");
  assert.equal(detached.events.length, 0);
});
