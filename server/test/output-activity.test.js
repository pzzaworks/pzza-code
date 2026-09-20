import assert from "node:assert/strict";
import test from "node:test";
import { paneOutputActivity, parsePaneOutputActivity } from "../lib/tmux.js";

test("output activity rows keep session, window, epoch and command", () => {
  assert.deepEqual(
    parsePaneOutputActivity("Devbox - Shell\t0\t1789895803\tbash\nTreasury\t2\t0\tbtop\n"),
    [
      { session: "Devbox - Shell", window: 0, activity: 1789895803, command: "bash" },
      { session: "Treasury", window: 2, activity: 0, command: "btop" },
    ],
  );
});

test("output activity parsing drops malformed and hostile rows", () => {
  assert.deepEqual(parsePaneOutputActivity(""), []);
  assert.deepEqual(parsePaneOutputActivity("only-two\tfields\n"), []);
  assert.deepEqual(parsePaneOutputActivity("s\tNaN\t12\tbash\n"), []);
  assert.deepEqual(parsePaneOutputActivity("s\t0\t-3\tbash\n"), []);
  assert.deepEqual(parsePaneOutputActivity("s\t1.5\t12\tbash\n"), []);
  assert.deepEqual(parsePaneOutputActivity("bad\x01name\t0\t12\tbash\n"), []);
  assert.deepEqual(parsePaneOutputActivity("s\t0\t12\n"), [{ session: "s", window: 0, activity: 12, command: "" }]);
});

test("output activity rejects an invalid host without spawning", () => {
  assert.rejects(paneOutputActivity("-bad host"), /invalid host/);
});
