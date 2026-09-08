import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { mcpConfigs } from "../lib/mcp.js";
import { sshApi } from "../../mcp/lib/agent.js";

test("MCP configurations preserve local setup and support authenticated SSH routing", () => {
  const local = mcpConfigs("/Applications/App/mcp/server.js");
  assert.equal(JSON.parse(local.frameworks.claude.config).mcpServers["pzzacode-mcp"].env, undefined);
  const remote = mcpConfigs('/home/user/a"b/mcp/server.js', { agentHost: "user@app" });
  const entry = JSON.parse(remote.frameworks.claude.config).mcpServers["pzzacode-mcp"];
  assert.deepEqual(entry.env, { PZZA_AGENT_HOST: "user@app" });
  assert.match(remote.frameworks.codex.config, /PZZA_AGENT_HOST = "user@app"/);
  assert.throws(() => mcpConfigs("/script", { agentHost: "-oProxyCommand=bad" }), /Invalid/);
});

test("SSH transport uses trusted host keys and sends request body only through stdin", async (t) => {
  let input;
  const transport = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    assert.equal(command, "ssh");
    assert.ok(args.includes("StrictHostKeyChecking=yes"));
    assert.equal(args.at(-2), "user@app");
    assert.ok(options.timeout <= 30000);
    assert.ok(!args.join(" ").includes("test-session"));
    queueMicrotask(() => callback(null, JSON.stringify({ status: 200, body: '{"ok":true}' })));
    return { stdin: { on() {}, end(value) { input = JSON.parse(value); } } };
  });
  syncBuiltinESMExports();
  try {
    assert.deepEqual(await sshApi("user@app", "/kill", { method: "POST", body: '{"name":"test-session"}' }), { ok: true });
    assert.equal(input.endpoint, "/kill");
    assert.equal(input.options.body, '{"name":"test-session"}');
    await assert.rejects(sshApi("-oBad", "/sessions"), /Invalid SSH/);
    await assert.rejects(sshApi("user@app", "//external"), /Invalid agent/);
    assert.equal(transport.mock.callCount(), 1);
  } finally { transport.mock.restore(); syncBuiltinESMExports(); }
});

test("SSH transport preserves actionable app-control failures", async (t) => {
  const transport = t.mock.method(childProcess, "execFile", (_command, _args, _options, callback) => {
    queueMicrotask(() => callback(null, JSON.stringify({ status: 422, body: JSON.stringify({ error: "Save unsaved changes before closing the editor" }) })));
    return { stdin: { on() {}, end() {} } };
  });
  syncBuiltinESMExports();
  try {
    await assert.rejects(sshApi("user@app", "/app/control/command", { method: "POST" }), /422.*Save unsaved changes/);
  } finally { transport.mock.restore(); syncBuiltinESMExports(); }
});
