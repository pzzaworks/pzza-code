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
  assert.equal(f.events[0].body, "Ready for review.");
  const shell = screenFixture(["$ npm test", "PASS 3 tests"], 1);
  shell.signals.bell();
  await Promise.resolve();
  assert.equal(shell.events[0].body, "PASS 3 tests");
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

test("wrapped status footers and framed input never replace the actual result", async () => {
  const rule = "\u2500".repeat(80);
  const lines = ["The update is ready for review.", "\u2014 Worked for 3m 50s", rule, rule, rule.slice(0, 25) + " ›\u2801Ask for help", "wrapped input", ". ."];
  const f = screenFixture(lines, lines.length - 1, [3, 4, 5]);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "The update is ready for review.");
});

test("footer-only screens fall back instead of claiming status text is output", async () => {
  const f = screenFixture(["\u2500 Worked for 3m 50s \u2500", "\u2500".repeat(80), "  › Ask for help", "? for shortcuts"], 3, [2]);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "No message was provided. Open this terminal to check what needs attention.");
});

test("narrow status rows are filtered after joining and real output keeps word boundaries", async () => {
  const f = screenFixture(["The requested update is ", "ready for review.", "Worked for ", "3m 50s", "› input"], 4, [1, 3]);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "The requested update is ready for review.");
});

test("status filtering preserves real command output and complete credential blocks", async () => {
  const credential = randomBytes(32).toString("base64");
  const lines = ["$ npm test", "PASS 3 tests", "-----BEGIN PRIVATE KEY-----", credential, "-----END PRIVATE KEY-----", "Worked for 2s", "› input"];
  const f = screenFixture(lines, 6);
  f.signals.bell();
  await Promise.resolve();
  assert.ok(!f.events[0].body.includes(credential));
  assert.ok(!f.events[0].body.includes("PRIVATE KEY"));
  assert.ok(f.events[0].body.includes("[REDACTED]"));
});

test("redrawn answer paragraphs keep their first line without wrapping metadata", async () => {
  const lines = ["Read session-name.js", "", "• Before trimming: the check uses the original", "  value.length against 128, so surrounding spaces count toward the", "  limit.", "", "\u2500".repeat(76), "", "›\u2801Ask for help"];
  const f = screenFixture(lines, lines.length - 1);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "• Before trimming: the check uses the original value.length against 128, so surrounding spaces count toward the limit.");
});

test("decorated completion footers do not replace a real answer", async () => {
  const lines = ["Read 1 file", "", "⏺ The limit applies before trimming,", "  because the check uses the raw input.", "", "✻ Cogitated for 5s · done 1:39 AM", "", "\u2500".repeat(76), "❯\u00a0"];
  const f = screenFixture(lines, lines.length - 1);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "⏺ The limit applies before trimming, because the check uses the raw input.");
});

test("an indented answer survives its mode and timing footer", async () => {
  const lines = ["     Read session-name.js", "", "     Session names may contain spaces.", "     The maximum length is 128 characters.", "", "     ▣ Build · Contributor · 4.9s", "", "  ┃  "];
  const f = screenFixture(lines, lines.length - 1);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "Session names may contain spaces. The maximum length is 128 characters.");
});

test("redrawn input continuations are excluded without wrapping metadata", async () => {
  const f = screenFixture(["› user input", "  continued on the next physical row", "", "Worked for 3s", "›"], 4);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "No message was provided. Open this terminal to check what needs attention.");
});

test("named prompt dividers never replace the answer", async () => {
  for (const [footer, wrapped] of [
    [["─".repeat(48) + " macos-release-auto-update ─"], []],
    [["─".repeat(40), "─".repeat(8) + " macos-release-auto-", "update ─"], [3, 4]],
  ]) {
    const lines = ["The release is ready for review.", "", ...footer, "❯\u00a0"];
    const f = screenFixture(lines, lines.length - 1, wrapped);
    f.signals.bell();
    await Promise.resolve();
    assert.equal(f.events[0].body, "The release is ready for review.");
  }
});

test("a named divider without an answer uses the message-free fallback", async () => {
  const f = screenFixture(["─".repeat(48) + " macos-release-auto-update ─", "❯\u00a0"], 1);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "No message was provided. Open this terminal to check what needs attention.");
});

test("a new indented answer after a divider remains available", async () => {
  const f = screenFixture(["─".repeat(50), "  The checks passed.", "❯\u00a0"], 2);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "The checks passed.");
});

test("a delayed bell retains the complete answer after its opening is clipped", async () => {
  const opening = "No dude, a name that's only spaces gets rejected, because !value.trim()";
  const ending = 'at server/lib/session-name.js:8 throws "Enter a session name." for it. The max length is 128 characters (SESSION_NAME_MAX_LENGTH at server/lib/session-name.js:1), and it is checked before trimming.';
  const lines = [opening, ending, "─".repeat(40) + " named-session ─", "❯"];
  const f = screenFixture(lines, 3);
  f.signals.captureOutput();
  lines.shift();
  f.move(2);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, `${opening}\n${ending}`);
  assert.ok(f.events[0].body.length > 220);
});

test("new input and expired snapshots cannot resurrect an old answer", async () => {
  for (const reset of [f => f.signals.input("\r"), f => f.advance(300_001)]) {
    const lines = ["This complete answer must not appear in the next turn.", "❯"];
    const f = screenFixture(lines, 1);
    f.signals.captureOutput();
    reset(f);
    lines[0] = "";
    f.signals.bell();
    await Promise.resolve();
    assert.equal(f.events[0].body, "No message was provided. Open this terminal to check what needs attention.");
  }
});

test("overlapping redraws are never stitched into unobserved output", async () => {
  const overlap = 'the validation rejects a name containing only spaces';
  const lines = ['No dude, ' + overlap, "❯"];
  const f = screenFixture(lines, 1);
  f.signals.captureOutput();
  lines[0] = overlap + ', and the limit is 128 characters.';
  f.signals.captureOutput();
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, overlap + ', and the limit is 128 characters.');
});

test("a tiny intermediate redraw cannot destroy a complete matching answer", async () => {
  const opening = "The opening sentence explains why this name is rejected. ";
  const ending = "The maximum length is 128 characters and the limit applies to the raw input before trimming.";
  const lines = [opening + ending, "❯"];
  const f = screenFixture(lines, 1);
  f.signals.captureOutput();
  lines[0] = ending.slice(-20);
  f.signals.captureOutput();
  lines[0] = ending;
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, opening + ending);
});

test("all paragraphs of the latest marked response are preserved", async () => {
  const f = screenFixture(["Earlier tool output.", "", "⏺ Names containing only spaces are rejected.", "", "The limit is checked before trimming.", "─".repeat(40), "❯"], 6);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "⏺ Names containing only spaces are rejected.\n\nThe limit is checked before trimming.");
});


test("reordered redraws cannot amplify repeated text", async () => {
  const a = "The first sentence explains the validation of whitespace. ";
  const b = "The second sentence explains the raw input length check.";
  const lines = [a + b, "❯"];
  const f = screenFixture(lines, 1);
  f.signals.captureOutput();
  lines[0] = b + a;
  f.signals.captureOutput();
  lines[0] = a + b;
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, a + b);
});

test("the prompt separates the answer from terminal status rows", async () => {
  const lines = ["The actual complete response.", "❯", "", "Check - C 1:2.1.268 03:05 13 Sep"];
  const f = screenFixture(lines, 3);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, lines[0]);
});

test("an older marked answer cannot cross the next input boundary", async () => {
  const f = screenFixture(["⏺ An older answer.", "❯ Explain validation", "", "The new answer.", "❯"], 4);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "The new answer.");
});


test("a response is captured before the next prompt is rendered", async () => {
  const f = screenFixture(["❯ Explain validation", "", "⏺ The complete answer is available before the prompt."], 2);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "⏺ The complete answer is available before the prompt.");
});


test("cursor-home before erasure preserves the response below the submitted question", async () => {
  const lines = ["❯ Explain validation", "", "⏺ The complete answer remains available after cursor-home."];
  const events = [];
  const signals = createTerminalSignals("tile-id", event => events.push(event), {
    attachment: true,
    cursorRow: () => 0,
    lastRow: () => lines.length - 1,
    readRow: row => lines[row] ?? null,
  });
  signals.captureOutput(true);
  lines.splice(0, lines.length, "❯");
  signals.bell();
  await Promise.resolve();
  assert.equal(events[0].body, "⏺ The complete answer remains available after cursor-home.");
});


test("background process status cannot replace the response", async () => {
  const f = screenFixture(["The response is complete.", "", "1 background terminal running · /ps to view · /stop to close"], 2);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "The response is complete.");
});


test("redrawn file references keep their hyphen and slash boundaries", async () => {
  const f = screenFixture(["See server/lib/session-", "  name.js:9 and server/lib/", "  session-name.js:11 for validation.", "❯"], 3);
  f.signals.bell();
  await Promise.resolve();
  assert.equal(f.events[0].body, "See server/lib/session-name.js:9 and server/lib/session-name.js:11 for validation.");
});
