// Window termination by stable id and the orphan-view sweep, against an
// isolated tmux server on a private socket (never the user's own servers).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { listWindows, terminateSession, terminationCommand } from "../lib/tmux.js";
import { staleOrphanViews, sweepOrphanViews } from "../lib/pty.js";

const exec = promisify(execFile);

async function isolatedServer(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-window-"));
  const socket = path.join(root, "s");
  const tmux = async (...args) => (await exec("tmux", ["-S", socket, ...args], { timeout: 5000, env: { ...process.env, TMUX: "" } })).stdout.trim();
  const previous = process.env.PZZA_TMUX_SOCKET;
  process.env.PZZA_TMUX_SOCKET = socket;
  t.after(async () => {
    if (previous === undefined) delete process.env.PZZA_TMUX_SOCKET;
    else process.env.PZZA_TMUX_SOCKET = previous;
    await tmux("kill-server").catch(() => {});
    await rm(root, { recursive: true, force: true });
  });
  await tmux("-f", "/dev/null", "new-session", "-d", "-s", "work", "-n", "A", "sleep 300");
  await tmux("new-window", "-t", "=work:", "-n", "B", "sleep 300");
  await tmux("new-window", "-t", "=work:", "-n", "C", "sleep 300");
  return { tmux };
}

const windows = async (tmux) => (await tmux("list-windows", "-t", "=work", "-F", "#{window_index}:#{window_name}:#{window_id}")).split("\n");

test("terminating a window tile by its id kills that window even after renumbering", async (t) => {
  const { tmux } = await isolatedServer(t);
  await tmux("set-option", "-t", "work", "renumber-windows", "on");
  const [, b] = await windows(tmux);
  const tileWindow = b.split(":")[2];
  // The tile shows B at index 1; window A closes and B and C shift down.
  await tmux("kill-window", "-t", "=work:0");
  assert.deepEqual((await windows(tmux)).map(row => row.split(":").slice(0, 2).join(":")), ["0:B", "1:C"]);
  await terminateSession("work", 1, "", tileWindow);
  assert.deepEqual((await windows(tmux)).map(row => row.split(":")[1]), ["C"], "B was killed and C, now at the saved index, survived");
});

test("a window id that left the session is refused instead of killing whatever holds the index", async (t) => {
  const { tmux } = await isolatedServer(t);
  const [, b] = await windows(tmux);
  const tileWindow = b.split(":")[2];
  await tmux("kill-window", "-t", tileWindow);
  // A new window reuses index 1.
  await tmux("new-window", "-t", "=work:1", "-n", "D", "sleep 300");
  await assert.rejects(terminateSession("work", 1, "", tileWindow), { status: 409, message: /already closed/ });
  assert.deepEqual((await windows(tmux)).map(row => row.split(":")[1]), ["A", "D", "C"]);
  // An id from another session is not this session's window.
  await tmux("new-session", "-d", "-s", "other", "sleep 300");
  const foreign = await tmux("display-message", "-p", "-t", "=other:", "#{window_id}");
  await assert.rejects(terminateSession("work", undefined, "", foreign), { status: 409 });
  await tmux("has-session", "-t", "=other");
  assert.throws(() => terminationCommand("work", undefined, "", "@1; rm -rf /"), /invalid window/);
  assert.throws(() => terminationCommand("work", undefined, "", "1"), /invalid window/);
});

test("window listings carry each window's stable id", async (t) => {
  const { tmux } = await isolatedServer(t);
  const listed = (await listWindows()).filter(row => row.session === "work");
  assert.deepEqual(listed.map(row => `${row.window}:${row.windowName}:${row.windowId}`), await windows(tmux));
  // The same rows for this device named explicitly (as a tile on it asks).
  assert.deepEqual((await listWindows("")).filter(row => row.session === "work"), listed);
  await assert.rejects(listWindows("bad host"), /invalid host/);
});

test("the orphan-view sweep spares views younger than the grace period and attached ones", async (t) => {
  const { tmux } = await isolatedServer(t);
  await tmux("new-session", "-d", "-t", "=work", "-s", "pzza-v-fresh");
  await tmux("new-session", "-d", "-t", "=work", "-s", "pzza-v-other");
  assert.deepEqual(await sweepOrphanViews(), [], "views just created for a tile are about to be attached");
  await tmux("has-session", "-t", "=pzza-v-fresh");
  assert.deepEqual((await sweepOrphanViews({ graceSeconds: 0 })).sort(), ["pzza-v-fresh", "pzza-v-other"]);
  await assert.rejects(tmux("has-session", "-t", "=pzza-v-fresh"));
  await tmux("has-session", "-t", "=work");

  const now = 1_000_000;
  assert.deepEqual(staleOrphanViews([
    `pzza-v-old\t0\t${now - 61}`,
    `pzza-v-new\t0\t${now - 5}`,
    `pzza-v-attached\t1\t${now - 600}`,
    `work\t0\t${now - 600}`,
    `pzza-v-unknown\t0\t`,
  ].join("\n"), now), ["pzza-v-old"]);
});
