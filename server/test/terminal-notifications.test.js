import test from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
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
function screenFixture(lines, cursor, wrapped = []) {
  const state = { cursor };
  const events = [];
  let clock = 0;
  const signals = createTerminalSignals("tile-id", (event) => events.push(event), {
    attachment: true,
    now: () => clock,
    cursorRow: () => state.cursor,
    readRow: (row) => lines[row] ?? null,
    isWrappedRow: (row) => wrapped.includes(row),
  });
  return { signals, events, advance: (ms) => { clock += ms; }, move: (row) => { state.cursor = row; } };
}

test("explicit terminal bells are rate limited and routed to their originating tile", async () => {
  const f = fixture();
  f.signals.bell();
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].title, "Terminal rang its bell");
  assert.deepEqual(f.events[0].target, { tileId: "tile-id" });
  assert.equal(f.events[0].dedupeKey, "terminal-bell:tile-id");
  f.advance(10_000);
  f.signals.bell();
  await Promise.resolve();
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

test("bell previews show output without treating input prompts as the reason", async () => {
  const f = screenFixture(["Ready for review.", "", "› Ask for help ⠂", "wrapped input"], 3, [3]);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "Recent output: Ready for review.");
  const shell = screenFixture(["$ npm test", "PASS 3 tests"], 1);
  shell.signals.bell();
  await Promise.resolve();
  assert.equal(shell.events[0].body, "Recent output: PASS 3 tests");
  for (const line of ["› Ask for help ⠂", "~", "password input"]) {
    const empty = screenFixture([line], 0);
    empty.signals.bell();
    await Promise.resolve();
    assert.equal(empty.events[0].body, "No message was provided. Open this terminal to check what needs attention.");
    assert.ok(!empty.events[0].body.includes(line));
  }
});

test("focused terminal bells stay quiet without delaying later background alerts", async () => {
  let focused = true;
  const events = [];
  const signals = createTerminalSignals("tile-id", event => events.push(event), {
    attachment: true, now: () => 0, isFocused: () => focused,
  });
  signals.bell();
  await Promise.resolve();
  assert.equal(events.length, 0);
  focused = false;
  signals.bell();
  await Promise.resolve();
  assert.equal(events.length, 1);
  focused = true;
  signals.osc133("C");
  signals.osc133("D;2");
  assert.equal(events[1].event, "terminal-command");
  signals.processExit(1);
  assert.equal(events[2].event, "terminal-exit");
});

test("missing screen rows explain why there is no message", async () => {
  const f = screenFixture([], 0);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "No message was provided. Open this terminal to check what needs attention.");
  f.signals.osc133("C");
  f.signals.osc133("D;0");
  assert.equal(f.events[1].body, "Shell integration reported that a command finished successfully.");
  const exited = screenFixture([], 0);
  exited.signals.processExit(3);
  assert.equal(exited.events[0].body, "The terminal process exited with status 3.");
});

test("program messages retain their actual title and body, including semicolons", async () => {
  const f = fixture();
  f.signals.bell();
  assert.equal(f.signals.osc777("notify;Approval required;Allow the migration; the database will be updated?"), true);
  await Promise.resolve();
  assert.equal(f.events.length, 1);
  assert.equal(f.events[0].title, "Approval required");
  assert.equal(f.events[0].body, "Allow the migration; the database will be updated?");
  assert.equal(f.signals.osc9("The build finished successfully."), true);
  assert.equal(f.events[1].body, "The build finished successfully.");
  assert.notEqual(f.events[0].dedupeKey, f.events[1].dedupeKey);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events.length, 2);
});

test("progress, shell metadata, unsupported and oversized messages do not alert", () => {
  const f = fixture();
  for (const text of ["4;1;75", "9;/private/project", "", "x".repeat(4097)]) assert.equal(f.signals.osc9(text), false);
  for (const text of ["command;start", "notify;" + "x".repeat(4097)]) assert.equal(f.signals.osc777(text), false);
  f.signals.osc777("notify;;");
  f.signals.osc9("   ");
  assert.equal(f.events.length, 0);
});

test("notification messages and screen previews redact credentials before truncation", async () => {
  const credential = randomBytes(32).toString("hex");
  const f = screenFixture(["A request failed.", "password=" + credential, "› input"], 2);
  f.signals.bell();
  await Promise.resolve();
  assert.ok(f.events[0].body.includes("[REDACTED]"));
  assert.ok(!JSON.stringify(f.events).includes(credential));
  f.signals.osc777("notify;Request failed;pass\x1b[31mword=" + credential);
  assert.equal(f.events[1].body, "[REDACTED]");
  f.signals.osc9("x".repeat(1000));
  assert.ok(f.events[2].body.length <= 220);
});

test("pending bells cannot outlive focus changes, exit or disposal", async () => {
  for (const action of ["dispose", "processExit"]) {
    const f = fixture();
    f.signals.bell();
    f.signals[action](0);
    await Promise.resolve();
    assert.equal(f.events.length, 0);
  }
  let focused = false;
  const events = [];
  const signals = createTerminalSignals("tile", event => events.push(event), { attachment: true, isFocused: () => focused });
  signals.bell();
  focused = true;
  signals.osc9("Ready for review");
  await Promise.resolve();
  assert.equal(events.length, 0);
});
