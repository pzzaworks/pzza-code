import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { installFileEntry, mcpConfigs } from "../lib/mcp.js";
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

test("OpenCode snippet matches the local server shape with optional routing env", () => {
  const local = mcpConfigs("/opt/mcp/server.js");
  assert.deepEqual(JSON.parse(local.frameworks.opencode.config).mcp["pzzacode-mcp"], {
    type: "local",
    command: ["node", "/opt/mcp/server.js"],
  });
  const remote = mcpConfigs("/opt/mcp/server.js", { agentHost: "user@app" });
  assert.deepEqual(JSON.parse(remote.frameworks.opencode.config).mcp["pzzacode-mcp"].environment, { PZZA_AGENT_HOST: "user@app" });
});

test("file-based installs merge JSON configs with backups and stay idempotent", async (t) => {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pzza-mcp-install-"));
  t.after(() => fs.promises.rm(home, { recursive: true, force: true }));
  const read = (rel) => JSON.parse(fs.readFileSync(path.join(home, rel), "utf8"));

  const created = installFileEntry("cursor", "/opt/mcp/server.js", home);
  assert.equal(created.ok, true);
  assert.deepEqual(read(path.join(".cursor", "mcp.json")).mcpServers["pzzacode-mcp"], { command: "node", args: ["/opt/mcp/server.js"] });

  const repeated = installFileEntry("cursor", "/opt/mcp/server.js", home);
  assert.deepEqual(repeated, { framework: "cursor", ok: true, via: path.join(".cursor", "mcp.json"), unchanged: true });

  const windsurf = installFileEntry("windsurf", "/opt/mcp/server.js", home);
  assert.equal(windsurf.ok, true);
  assert.deepEqual(read(path.join(".codeium", "windsurf", "mcp_config.json")).mcpServers["pzzacode-mcp"], { command: "node", args: ["/opt/mcp/server.js"] });

  const zed = installFileEntry("zed", "/opt/mcp/server.js", home);
  assert.equal(zed.ok, true);
  assert.deepEqual(read(path.join(".config", "zed", "settings.json")).context_servers["pzzacode-mcp"], { command: { path: "node", args: ["/opt/mcp/server.js"] } });

  // Existing settings survive, and the original is backed up exactly once.
  const cursorFile = path.join(home, ".cursor", "mcp.json");
  const withOther = { mcpServers: { other: { command: "other" } } };
  fs.writeFileSync(cursorFile, `${JSON.stringify(withOther)}\n`);
  const merged = installFileEntry("cursor", "/opt/mcp/server.js", home);
  assert.equal(merged.ok, true);
  const after = read(path.join(".cursor", "mcp.json"));
  assert.deepEqual(after.mcpServers.other, { command: "other" });
  assert.deepEqual(after.mcpServers["pzzacode-mcp"], { command: "node", args: ["/opt/mcp/server.js"] });
  const backups = fs.readdirSync(path.join(home, ".cursor")).filter((name) => name.startsWith("mcp.json.pzza-backup-"));
  assert.equal(backups.length, 1);
  assert.equal(fs.readFileSync(path.join(home, ".cursor", backups[0]), "utf8"), `${JSON.stringify(withOther)}\n`);

  fs.writeFileSync(cursorFile, "{ not json");
  const invalid = installFileEntry("cursor", "/opt/mcp/server.js", home);
  assert.equal(invalid.ok, false);
  assert.match(invalid.error, /not valid JSON/);

  assert.equal(installFileEntry("unknown", "/opt/mcp/server.js", home).ok, false);
  assert.equal(installFileEntry("cursor", "", home).ok, false);
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
