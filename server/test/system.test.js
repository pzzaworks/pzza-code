import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import { test } from "node:test";
import { deviceOs, normalizeDeviceOs } from "../lib/system.js";

test("recognizes real Unix and Windows system output", () => {
  for (const [output, expected] of [
    ["Darwin\n", "macos"], ["Linux\n", "linux"], ["FreeBSD\n", "freebsd"],
    ["Microsoft Windows [Version 10.0.26100.1]\r\n", "windows"],
    ["MINGW64_NT-10.0-26100", "windows"], ["SunOS", "unknown"],
  ]) assert.equal(normalizeDeviceOs(output), expected);
});

test("local OS comes from the backend without SSH", async () => {
  assert.deepEqual(await deviceOs(), { os: normalizeDeviceOs(os.type()) });
});

test("remote probes are bounded, deduplicated, cached and reject unsafe hosts", async (t) => {
  let calls = 0;
  const probe = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls++;
    assert.equal(command, "ssh");
    assert.equal(options.timeout, 7000);
    assert.equal(options.maxBuffer, 4096);
    assert.ok(args.includes("BatchMode=yes"));
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.equal(args.at(-1), "uname -s || ver");
    queueMicrotask(() => callback(null, "Linux\n"));
  });
  syncBuiltinESMExports();
  try {
    const results = await Promise.all([deviceOs("test@device"), deviceOs("test@device")]);
    assert.deepEqual(results, [{ os: "linux" }, { os: "linux" }]);
    assert.equal(calls, 1);
    assert.deepEqual(await deviceOs("test@device"), { os: "linux" });
    assert.equal(calls, 1);
    for (const host of ["-ProxyCommand=bad", "host; echo bad", "host\nother"]) {
      assert.deepEqual(await deviceOs(host), { os: "unknown" });
    }
    assert.equal(calls, 1);
    probe.mock.mockImplementation((command, args, options, callback) => {
      calls++;
      queueMicrotask(() => callback(new Error("unreachable"), ""));
    });
    syncBuiltinESMExports();
    assert.deepEqual(await deviceOs("unreachable-device"), { os: "unknown" });
    assert.deepEqual(await deviceOs("unreachable-device"), { os: "unknown" });
    assert.equal(calls, 2);
  } finally {
    probe.mock.restore();
    syncBuiltinESMExports();
  }
});
