import test from "node:test";
import assert from "node:assert/strict";
import { BRIDGE_TOOLS } from "../../mcp/lib/bridge-tools.js";
import { toolResult } from "../../mcp/lib/results.js";
import { BRIDGE_ACTION_CAPABILITIES } from "../lib/bridge-executor.js";

test("bridge MCP uses only scoped dispatch and never exposes approvals or configuration", async () => {
  const originalFetch = globalThis.fetch;
  const originalHost = process.env.PZZA_AGENT_HOST;
  const originalToken = process.env.PZZA_AGENT_TOKEN;
  const calls = [];
  process.env.PZZA_AGENT_HOST = "must-not-connect";
  process.env.PZZA_AGENT_TOKEN = "test-bridge-token";
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  };
  try {
    const tools = BRIDGE_TOOLS.filter(tool => tool.name !== "bridge_list_devices");
    for (const tool of tools) {
      assert.equal(tool.inputSchema.additionalProperties, false);
      assert.ok(tool.inputSchema.required.includes("peerId"));
      await tool.run({ peerId: "paired-device", projectId: "project" });
      const call = calls.at(-1);
      assert.ok(call.url.endsWith("/bridge/dispatch"));
      const request = JSON.parse(call.options.body);
      assert.ok(Object.hasOwn(BRIDGE_ACTION_CAPABILITIES, request.action) || ["bridge.describe", "jobs.list", "jobs.get", "jobs.cancel"].includes(request.action));
      assert.ok(!/approve|config/.test(request.action));
      assert.equal(request.peerId, "paired-device");
    }
  } finally {
    globalThis.fetch = originalFetch;
    if (originalHost === undefined) delete process.env.PZZA_AGENT_HOST;
    else process.env.PZZA_AGENT_HOST = originalHost;
    if (originalToken === undefined) delete process.env.PZZA_AGENT_TOKEN;
    else process.env.PZZA_AGENT_TOKEN = originalToken;
  }
});

test("simulator screenshots become MCP image content with size and format checks", () => {
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).toString("base64");
  assert.deepEqual(toolResult("bridge_simulator_screenshot", { content: png, encoding: "base64", mimeType: "image/png" }), { content: [{ type: "image", data: png, mimeType: "image/png" }] });
  assert.throws(() => toolResult("bridge_simulator_screenshot", { content: "invalid", encoding: "base64", mimeType: "image/png" }), /Invalid simulator screenshot/);
  assert.equal(toolResult("bridge_jobs_get", { status: "running" }).content[0].type, "text");
});
