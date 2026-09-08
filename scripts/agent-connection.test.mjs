import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { transform } from "esbuild";
const { code } = await transform(await readFile(new URL("../src/agentConnection.ts", import.meta.url), "utf8"), { loader: "ts", format: "esm" });
const { createAgentConnection } = await import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
const credentials = async () => ({ token: "test-credential", instance: "current" });
const pause = async () => {};

test("rejects a foreign agent without exposing credentials, then recovers", async () => {
  let id = "foreign";
  const connection = createAgentConnection({ credentials, pause, health: async () => ({ id }) });
  await assert.rejects(connection.ready(), /unavailable/);
  assert.equal(connection.token(), "");
  id = "current";
  assert.equal(await connection.ready(), "test-credential");
});
test("waits through a stale owner and shares one verification between callers", async () => {
  let calls = 0;
  const connection = createAgentConnection({ credentials, pause, health: async () => ({ id: ++calls < 3 ? "old" : "current" }) });
  const first = connection.ready();
  assert.equal(first, connection.ready());
  await first;
  assert.equal(calls, 3);
});
test("invalidating a connection clears URL credentials and requires verification", async () => {
  let up = true;
  const connection = createAgentConnection({ credentials, pause, health: async () => { if (!up) throw Error("offline"); return { id: "current" }; } });
  await connection.ready();
  connection.invalidate();
  assert.equal(connection.token(), "");
  up = false;
  await assert.rejects(connection.ready());
  up = true;
  assert.equal(await connection.ready(), "test-credential");
});
test("an invalidated in-flight check cannot publish stale credentials", async () => {
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const connection = createAgentConnection({ credentials, pause, health: async () => { await gate; return { id: "current" }; } });
  const pending = connection.ready();
  connection.invalidate();
  release();
  await assert.rejects(pending, /changed/);
  assert.equal(connection.token(), "");
  assert.equal(await connection.ready(), "test-credential");
});
