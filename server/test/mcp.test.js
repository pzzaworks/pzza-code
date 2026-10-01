import assert from "node:assert/strict";
import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { syncBuiltinESMExports } from "node:module";
import test from "node:test";
import { installFileEntry, mcpConfigs, mcpInstall, resolveCli } from "../lib/mcp.js";
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

// A fake agent CLI on a private PATH plus a scripted `run` that mimics the real
// CLIs: claude refuses duplicate names, codex/opencode overwrite in place.
async function cliFixture(t, names) {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pzza-mcp-cli-"));
  t.after(() => fs.promises.rm(home, { recursive: true, force: true }));
  const bin = path.join(home, "bin");
  fs.mkdirSync(bin);
  for (const name of names) fs.writeFileSync(path.join(bin, name), "#!/bin/sh\n", { mode: 0o755 });
  const calls = [];
  const servers = new Map();
  const exec = async (cmd, args) => {
    calls.push([path.basename(cmd), ...args]);
    const name = args.includes("-s") ? args[4] : args[2];
    if (args[1] === "remove") return servers.delete(name) ? { ok: true, output: "Removed", error: null } : { ok: false, output: `No MCP server named "${name}"`, error: "Command failed" };
    if (path.basename(cmd) === "claude" && servers.has(name)) return { ok: false, output: `MCP server ${name} already exists in user config`, error: `Command failed: claude ${args.join(" ")}` };
    servers.set(name, args.slice(args.indexOf("--") + 1));
    return { ok: true, output: "Added", error: null };
  };
  return { home, env: { PATH: bin }, exec, calls, servers };
}

test("CLI installs are idempotent, replace stale paths, and report a missing CLI plainly", async (t) => {
  const fx = await cliFixture(t, ["claude", "codex", "opencode"]);
  const options = { exec: fx.exec, home: fx.home, env: fx.env, systemDirs: [] };

  assert.equal((await mcpInstall("claude", "/old/mcp/server.js", options)).ok, true);
  // Claude already has a stale entry from a moved app: remove, then add again.
  const moved = await mcpInstall("claude", "/Applications/PzzaCode.app/mcp/server.js", options);
  assert.equal(moved.ok, true);
  assert.deepEqual(fx.servers.get("pzzacode-mcp"), ["node", "/Applications/PzzaCode.app/mcp/server.js"]);
  assert.deepEqual(fx.calls.slice(-2).map((call) => call[2]), ["remove", "add"]);
  assert.deepEqual(fx.calls.at(-2), ["claude", "mcp", "remove", "-s", "user", "pzzacode-mcp"]);

  // A matching user-scope entry is kept without touching the CLI at all.
  fs.writeFileSync(path.join(fx.home, ".claude.json"), JSON.stringify({ mcpServers: { "pzzacode-mcp": { type: "stdio", command: "node", args: ["/same/server.js"], env: {} } } }));
  const before = fx.calls.length;
  assert.deepEqual(await mcpInstall("claude", "/same/server.js", options), { framework: "claude", ok: true, via: "claude mcp add", unchanged: true });
  assert.equal(fx.calls.length, before);

  // Codex and OpenCode overwrite natively, so a repeat add simply succeeds.
  for (const framework of ["codex", "opencode"]) {
    assert.equal((await mcpInstall(framework, "/a/server.js", options)).ok, true);
    assert.equal((await mcpInstall(framework, "/b/server.js", options)).ok, true);
    assert.deepEqual(fx.calls.at(-1), [framework, "mcp", "add", "pzzacode-mcp", "--", "node", "/b/server.js"]);
  }

  const missing = await mcpInstall("codex", "/a/server.js", { ...options, env: { PATH: path.join(fx.home, "nowhere") } });
  assert.equal(missing.ok, false);
  assert.equal(missing.missing, true);
  assert.match(missing.error, /Codex is not installed/);
  assert.doesNotMatch(missing.error, /ENOENT/);
});

test("CLI resolution finds installs outside the inherited PATH", async (t) => {
  const home = await fs.promises.mkdtemp(path.join(os.tmpdir(), "pzza-mcp-resolve-"));
  t.after(() => fs.promises.rm(home, { recursive: true, force: true }));
  const local = path.join(home, ".local", "bin");
  fs.mkdirSync(local, { recursive: true });
  fs.writeFileSync(path.join(local, "claude"), "#!/bin/sh\n", { mode: 0o755 });
  fs.writeFileSync(path.join(local, "codex"), "not executable", { mode: 0o644 });
  assert.equal(resolveCli("claude", { home, env: { PATH: "/usr/bin" }, systemDirs: [] }), path.join(local, "claude"));
  assert.equal(resolveCli("codex", { home, env: { PATH: local }, systemDirs: [] }), null);
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
