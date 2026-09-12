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

// Fake screen: absolute rows of trimmed line text, with a movable cursor.
function screenFixture(lines, cursor) {
  const state = { cursor };
  const events = [];
  let clock = 0;
  const signals = createTerminalSignals("tile-id", (event) => events.push(event), {
    attachment: true,
    now: () => clock,
    cursorRow: () => state.cursor,
    readRow: (row) => lines[row] ?? null,
  });
  return { signals, events, advance: (ms) => { clock += ms; }, move: (row) => { state.cursor = row; } };
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

test("real process exit is distinct from successful attachment detach and cleanup", () => {  const attached = fixture();
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

test("command and exit notifications quote real screen lines when a screen is attached", () => {
  // At D time the shell has not drawn the next prompt yet, so the cursor sits
  // on the last output line.
  const lines = ["", "$ npm test", "", "PASS 3 tests"];
  const f = screenFixture(lines, 1);
  f.signals.osc133("C");
  f.move(3);
  f.signals.osc133("D;0");
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].title, "Terminal reported completion");
  assert.ok(f.events[0].body.includes('"$ npm test"'), f.events[0].body);
  assert.ok(f.events[0].body.includes('"PASS 3 tests"'), f.events[0].body);

  const failed = screenFixture(["$ npm test", "FAIL boom"], 0);
  failed.signals.osc133("C");
  failed.move(1);
  failed.signals.osc133("D;2");
  assert.equal(failed.events[0].title, "Terminal reported failure");
  assert.ok(failed.events[0].body.includes("exited with status 2"), failed.events[0].body);
  assert.ok(failed.events[0].body.includes('"$ npm test"'), failed.events[0].body);

  const exited = screenFixture(["$ npm test", "FAIL boom"], 1);
  exited.signals.processExit(1);
  assert.ok(exited.events[0].body.includes("status 1"), exited.events[0].body);
  assert.ok(exited.events[0].body.includes('"FAIL boom"'), exited.events[0].body);
});

test("bell notifications do not infer their reason from terminal prompts or output", () => {
  for (const line of ["› Ask for help ⠂", "~", "PASS 3 tests", "password input"]) {
    const f = screenFixture([line], 0);
    f.signals.bell();
    assert.equal(f.events[0].body, "This terminal emitted an attention signal.");
    assert.ok(!f.events[0].body.includes(line));
  }
});

test("focused terminal bells stay quiet without delaying later background alerts", () => {
  let focused = true;
  const events = [];
  const signals = createTerminalSignals("tile-id", event => events.push(event), {
    attachment: true, now: () => 0, isFocused: () => focused,
  });
  signals.bell();
  assert.equal(events.length, 0);
  focused = false;
  signals.bell();
  assert.equal(events.length, 1);
  focused = true;
  signals.osc133("C");
  signals.osc133("D;2");
  assert.equal(events[1].event, "terminal-command");
  signals.processExit(1);
  assert.equal(events[2].event, "terminal-exit");
});

test("missing screen rows fall back to generic text", () => {
  const f = screenFixture([], 0);
  f.signals.bell();
  assert.equal(f.events[0].body, "This terminal emitted an attention signal.");
  f.signals.osc133("C");
  f.signals.osc133("D;0");
  assert.equal(f.events[1].body, "Shell integration reported that a command finished successfully.");
  const exited = screenFixture([], 0);
  exited.signals.processExit(3);
  assert.equal(exited.events[0].body, "The terminal process exited with status 3.");
});
