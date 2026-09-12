import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const memory = new Map();
globalThis.localStorage = { getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) };
globalThis.window = Object.assign(new EventTarget(), { location: { protocol: "http:", hostname: "127.0.0.1", port: "1438" } });
const output = await build({ stdin: { contents: 'export { useMcpSettings } from "./src/state/mcpSettings.ts"; export { useIntegrationHealth } from "./src/state/integrationHealth.ts";', resolveDir: process.cwd() }, bundle: true, platform: "browser", format: "esm", write: false });
const { useMcpSettings, useIntegrationHealth } = await import(`data:text/javascript;base64,${Buffer.from(output.outputFiles[0].text).toString("base64")}`);
const tick = () => new Promise(resolve => setImmediate(resolve));

test("integration checks coalesce per device and bound the batch to three requests", async () => {
  const requests = new Map();
  let active = 0; let maximum = 0;
  globalThis.fetch = async (_url, options) => {
    const { host } = JSON.parse(options.body);
    active++; maximum = Math.max(maximum, active);
    return new Promise(resolve => requests.set(host, () => { active--; resolve(Response.json({ results: [{ framework: "integration", server: "service", file: "client.json", status: "healthy", message: "Available" }] })); }));
  };
  const store = useIntegrationHealth.getState();
  const devices = ["one", "two", "three", "four"].map(host => ({ host, name: host }));
  const batch = store.checkAll(devices);
  assert.equal(batch.status, "running");
  await tick();
  assert.equal(requests.size, 3);
  const same = store.check("one", "one");
  assert.equal(requests.size, 3);
  assert.throws(() => store.checkAll(devices), /already running/);
  requests.get("one")(); await same; await tick();
  assert.ok(requests.has("four"));
  for (const host of ["two", "three", "four"]) requests.get(host)();
  await tick(); await tick();
  assert.equal(maximum, 3);
  assert.equal(useIntegrationHealth.getState().batch.status, "complete");
  assert.ok(Object.values(useIntegrationHealth.getState().devices).every(device => !device.checking && device.checkedAt > 0));
});

test("config generation preserves the newest target and install output is never retained", async () => {
  const responses = new Map();
  globalThis.fetch = async url => new Promise(resolve => responses.set(new URL(url).searchParams.get("agentHost"), resolve));
  const store = useMcpSettings.getState();
  store.select({ agentHost: "first", mcpPath: "/app/mcp.js" });
  const first = store.load();
  store.select({ agentHost: "second" });
  const second = store.load();
  await tick();
  responses.get("second")(Response.json({ path: "/second/mcp.js", frameworks: {} })); await second;
  responses.get("first")(Response.json({ path: "/first/mcp.js", frameworks: {} })); await first;
  assert.equal(useMcpSettings.getState().config.path, "/second/mcp.js");
  store.select({ agentHost: "" });
  globalThis.fetch = async (_url, init) => {
    const { framework } = JSON.parse(init.body);
    if (framework === "unknown-framework") return Response.json({ ok: false, manual: true, error: "no installer - copy the config into your settings" });
    return Response.json({ ok: true, output: "Untrusted command output" });
  };
  await store.install("claude");
  assert.equal(useMcpSettings.getState().notes.claude, "added ✓");
  assert.ok(!JSON.stringify(useMcpSettings.getState()).includes("Untrusted command output"));
  await assert.rejects(store.install("unknown-framework"), /copy the config/);
  assert.ok(!JSON.stringify(useMcpSettings.getState()).includes("Untrusted command output"));
});
