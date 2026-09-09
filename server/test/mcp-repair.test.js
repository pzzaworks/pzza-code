import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { MCP_REPAIR_TARGET } from "../lib/mcp-repair-target.js";
import { createMcpRepair, runMcpRepair } from "../lib/mcp-repair.js";

async function fixture(t) {
  const home = await fs.mkdtemp(path.join(os.homedir(), ".pzza-mcp-test-"));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  await fs.mkdir(path.join(home, ".local/bin"), { recursive: true, mode: 0o700 });
  await fs.mkdir(path.join(home, ".codex"), { mode: 0o700 });
  const launcher = path.join(home, ".local/bin/pzza-test-launcher");
  await fs.writeFile(launcher, "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  const run = (apply = true) => new Promise((resolve, reject) => {
    const child = execFile("python3", ["-c", MCP_REPAIR_TARGET], { env: { ...process.env, HOME: home }, timeout: 5000 }, (error, stdout) => {
      if (error) reject(new Error("Repair target failed"));
      else resolve(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify({ apply }));
  });
  return { home, launcher, run };
}

test("repairs both client configurations while preserving unrelated settings and a private backup", async t => {
  const f = await fixture(t);
  const toml = '# Preserve this comment\nmodel = "configured-model"\n[mcp_servers."test.server"]\ncommand = "pzza-test-launcher"\nargs = ["first", "second"]\n[mcp_servers."test.server".env]\nDISPLAY_MODE = "private"\n';
  const config = { preference: { active: true }, mcpServers: { railway: { command: "pzza-test-launcher", args: ["serve"], env: { DISPLAY_MODE: "private" } } } };
  await fs.writeFile(path.join(f.home, ".codex/config.toml"), toml);
  await fs.writeFile(path.join(f.home, ".claude.json"), JSON.stringify(config));
  const dry = await f.run(false);
  assert.equal(dry.results.filter(result => result.status === "repairable").length, 2);
  assert.equal(await fs.readFile(path.join(f.home, ".codex/config.toml"), "utf8"), toml);
  const result = await f.run();
  assert.equal(result.results.filter(entry => entry.status === "repaired").length, 2);
  const updated = JSON.parse(await fs.readFile(path.join(f.home, ".claude.json"), "utf8"));
  assert.deepEqual(updated, { ...config, mcpServers: { railway: { ...config.mcpServers.railway, command: f.launcher } } });
  assert.ok((await fs.readFile(path.join(f.home, ".codex/config.toml"), "utf8")).includes('# Preserve this comment'));
  for (const entry of result.results) assert.equal((await fs.stat(path.join(f.home, entry.backup))).mode & 0o777, 0o600);
  assert.ok((await f.run()).results.every(entry => entry.status === "healthy"));
});

test("splits a mistakenly combined command without running it or changing its arguments", async t => {
  const f = await fixture(t);
  const file = path.join(f.home, ".claude.json");
  await fs.writeFile(file, JSON.stringify({ mcpServers: { service: { command: 'pzza-test-launcher --mode "two words"', args: ["last"] } } }));
  assert.equal((await f.run()).results[0].status, "repaired");
  const entry = JSON.parse(await fs.readFile(file, "utf8")).mcpServers.service;
  assert.deepEqual(entry, { command: f.launcher, args: ["--mode", "two words", "last"] });
});

test("repairs a registered project's server and binds script runtimes without executing them", async t => {
  const f = await fixture(t);
  const project = path.join(f.home, "project");
  await fs.mkdir(project, { mode: 0o700 });
  const launcher = path.join(f.home, ".local/bin/pzza-node-launcher");
  await fs.writeFile(launcher, "#!/usr/bin/env node\nprocess.exit(97);\n", { mode: 0o700 });
  await fs.writeFile(path.join(f.home, ".claude.json"), JSON.stringify({ projects: { [project]: { allowedTools: [] } } }));
  await fs.writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { server: { command: "pzza-node-launcher", args: ["serve"] } } }));
  await fs.writeFile(path.join(f.home, ".codex/config.toml"), '[mcp_servers.server]\ncommand = "pzza-node-launcher"\nargs = [\n "serve",\n]\n');
  const result = await f.run();
  assert.equal(result.results.filter(entry => entry.status === "repaired").length, 2);
  const entry = JSON.parse(await fs.readFile(path.join(project, ".mcp.json"), "utf8")).mcpServers.server;
  assert.ok(path.isAbsolute(entry.command));
  assert.deepEqual(entry.args, [launcher, "serve"]);
  assert.ok((await f.run()).results.every(entry => entry.status === "healthy"));
});

test("version-managed executables prefer numeric Node versions and skip unsafe candidates", async t => {
  const f = await fixture(t);
  const servers = {};
  const expected = {};
  for (const [manager, directory, prefix] of [["nvm", ".nvm/versions/node", "v"], ["mise", ".local/share/mise/installs/node", ""]]) {
    const command = `pzza-version-check-${manager}`;
    for (const version of ["9.99.99", "24.9.0", "24.10.0-rc.1", "24.10.0", "30.0.0"]) {
      const binary = path.join(f.home, directory, `${prefix}${version}`, "bin", command);
      await fs.mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
      await fs.writeFile(binary, "#!/bin/sh\nexit 97\n", { mode: 0o700 });
      if (version === "30.0.0") await fs.chmod(binary, 0o777);
      if (version === "24.10.0") expected[manager] = binary;
    }
    servers[manager] = { command, args: [] };
  }
  const file = path.join(f.home, ".claude.json");
  await fs.writeFile(file, JSON.stringify({ mcpServers: servers }));
  const result = await f.run();
  assert.equal(result.results.filter(entry => entry.status === "repaired").length, 2);
  const updated = JSON.parse(await fs.readFile(file, "utf8")).mcpServers;
  for (const manager of ["nvm", "mise"]) assert.equal(updated[manager].command, expected[manager]);
});

test("unknown commands, disabled servers, parser failures and symlinked files are left intact", async t => {
  const f = await fixture(t);
  const file = path.join(f.home, ".claude.json");
  const original = JSON.stringify({ mcpServers: { missing: { command: "pzza-unavailable-92837" }, disabled: { command: "pzza-test-launcher", disabled: true } } });
  await fs.writeFile(file, original);
  await fs.symlink(file, path.join(f.home, ".claude-other.json"));
  await fs.writeFile(path.join(f.home, ".codex/config.toml"), 'invalid = "unterminated-value');
  const result = await f.run();
  assert.equal(await fs.readFile(file, "utf8"), original);
  assert.equal(result.results.filter(entry => entry.status === "unresolved").length, 3);
  assert.ok(!JSON.stringify(result).includes("unterminated-value"));
  assert.ok(result.results.some(entry => entry.status === "disabled"));
});

test("concurrent health checks coalesce and invalid hosts never execute", async () => {
  let calls = 0;
  const repair = createMcpRepair({ run: async () => { calls++; return { results: [] }; } });
  await Promise.all([repair("host"), repair("host", true), repair("host")]);
  assert.equal(calls, 1);
  await repair("host");
  assert.equal(calls, 1);
  await assert.rejects(runMcpRepair("--proxy-command"), /Invalid device/);
});
