import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import os from "node:os";
import test from "node:test";
import { collectDeviceInfo, deviceInfo } from "../lib/device-info.js";

const info = {
  os: "linux", osName: "Fixture Linux", osVersion: "1", kernelVersion: "1.0", arch: "x64", hostname: "fixture",
  addresses: [{ interface: "eth0", address: "192.0.2.10", family: "IPv4" }], uptimeSeconds: 123,
  cpu: { model: "Fixture CPU", logicalCores: 4, loadAverage: [0.1, 0.2, 0.3] },
  memory: { totalBytes: 1024, freeBytes: 512, availableBytes: 768 },
};

test("local information contains real OS, uptime, CPU and memory observations", async () => {
  const observed = await collectDeviceInfo();
  assert.equal(observed.arch, os.arch());
  assert.equal(observed.hostname, os.hostname());
  assert.equal(observed.kernelVersion, os.release());
  assert.equal(observed.cpu.logicalCores, os.cpus().length);
  assert.equal(observed.memory.totalBytes, os.totalmem());
  assert.ok(Math.abs(observed.uptimeSeconds - os.uptime()) < 3);
  assert.ok(observed.memory.freeBytes >= 0);
  const result = await deviceInfo("");
  assert.equal(result.health, "reachable");
  assert.equal(result.connection, "local");
  assert.equal(result.error, null);
  assert.equal(result.info.hostname, os.hostname());
  assert.ok(result.connectionMs >= 0 && result.connectionMs < 8000);
  assert.ok(Math.abs(result.checkedAt - Date.now()) < 1000);
  assert.ok(!("env" in result.info) && !("processes" in result.info));
});

test("remote probe uses selected host, bounded shared SSH transport and real native observations", async (t) => {
  const execute = childProcess.execFile;
  const transport = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    assert.equal(command, "ssh");
    assert.equal(args.at(-2), "info-remote-fixture");
    assert.ok(args.includes("ControlPath=~/.ssh/pzza-mux-%C"));
    assert.ok(options.timeout <= 8000);
    return execute("sh", ["-c", args.at(-1)], options, callback);
  });
  syncBuiltinESMExports();
  try {
    const result = await deviceInfo("info-remote-fixture");
    assert.equal(result.health, "reachable");
    assert.equal(result.connection, "ssh");
    assert.equal(result.error, null);
    assert.equal(result.info.arch, os.arch());
    assert.equal(result.info.hostname, os.hostname());
  } finally {
    transport.mock.restore();
    syncBuiltinESMExports();
  }
});

test("pending requests deduplicate, successful snapshots cache and explicit refresh bypasses the cache", async (t) => {
  const callbacks = [];
  const transport = t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) => { callbacks.push(callback); });
  syncBuiltinESMExports();
  try {
    const first = deviceInfo("info-cache-fixture");
    const shared = deviceInfo("info-cache-fixture");
    assert.equal(first, shared);
    callbacks[0](null, JSON.stringify(info));
    const snapshot = await first;
    assert.deepEqual(snapshot.info, info);
    assert.equal(await deviceInfo("info-cache-fixture"), snapshot);
    assert.equal(callbacks.length, 1);
    const fresh = deviceInfo("info-cache-fixture", { fresh: true });
    callbacks[1](null, JSON.stringify({ ...info, uptimeSeconds: 456 }));
    assert.equal((await fresh).info.uptimeSeconds, 456);
    assert.equal(callbacks.length, 2);
  } finally {
    transport.mock.restore();
    syncBuiltinESMExports();
  }
});

test("timeouts are explicit and uncached while unavailable runtime stays reachable", async (t) => {
  let calls = 0;
  const transport = t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) => {
    calls++;
    if (calls === 1) callback(Object.assign(new Error("fixture timeout"), { killed: true }));
    else callback(null, JSON.stringify({ error: "Node.js is required on this device to inspect system details" }));
  });
  syncBuiltinESMExports();
  try {
    const failed = await deviceInfo("info-failed-fixture");
    assert.equal(failed.health, "unreachable");
    assert.equal(failed.info, null);
    assert.match(failed.error, /timed out/);
    const missingRuntime = await deviceInfo("info-failed-fixture");
    assert.equal(missingRuntime.health, "reachable");
    assert.equal(missingRuntime.info, null);
    assert.match(missingRuntime.error, /Node.js is required/);
    assert.equal(calls, 2);
    await assert.rejects(deviceInfo("-oBad host"), /invalid host/);
    assert.equal(calls, 2);
  } finally {
    transport.mock.restore();
    syncBuiltinESMExports();
  }
});

test("malformed remote observations never become guessed metrics or expose arbitrary fields", async (t) => {
  let calls = 0;
  const transport = t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) => {
    calls++;
    callback(null, calls === 1 ? JSON.stringify({ ...info, memory: { totalBytes: "unknown" } })
      : JSON.stringify({ ...info, extra: "private fixture", addresses: [...info.addresses, { interface: "invalid", address: "private fixture", family: "IPv4" }] }));
  });
  syncBuiltinESMExports();
  try {
    const malformed = await deviceInfo("info-malformed-fixture");
    assert.equal(malformed.health, "reachable");
    assert.equal(malformed.info, null);
    assert.match(malformed.error, /unavailable/);
    const valid = await deviceInfo("info-malformed-fixture");
    assert.equal(valid.info.addresses.length, 1);
    assert.ok(!JSON.stringify(valid).includes("private fixture"));
  } finally {
    transport.mock.restore();
    syncBuiltinESMExports();
  }
});
