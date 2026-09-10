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
  const entry = JSON.parse(await fs.readFile(path.join(f.home, ".claude.json"), "utf8")).projects[project].mcpServers.server;
  assert.ok(path.isAbsolute(entry.command));
  assert.deepEqual(entry.args, [launcher, "serve"]);
  assert.equal(JSON.parse(await fs.readFile(path.join(project, ".mcp.json"), "utf8")).mcpServers.server.command, "pzza-node-launcher");
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

test("relative project commands resolve from their configured scope, never the repair process folder", async t => {
  const f = await fixture(t);
  const project = path.join(f.home, "project");
  const binary = path.join(project, "target/release/pzza-project-server");
  const command = "./target/release/pzza-project-server";
  await fs.mkdir(path.dirname(binary), { recursive: true, mode: 0o700 });
  await fs.writeFile(binary, "#!/bin/sh\nexit 97\n", { mode: 0o700 });
  await fs.mkdir(path.join(project, ".codex"), { mode: 0o700 });
  await fs.writeFile(path.join(project, ".mcp.json"), JSON.stringify({ mcpServers: { project: { command } } }));
  await fs.writeFile(path.join(project, ".codex/config.toml"), `[mcp_servers.project]\ncommand = ${JSON.stringify(command)}\n`);
  const file = path.join(f.home, ".claude.json");
  await fs.writeFile(file, JSON.stringify({
    projects: { [project]: { mcpServers: { scoped: { command } } } },
    mcpServers: { explicit: { command, cwd: project }, unscoped: { command } },
  }));
  const result = await f.run();
  assert.equal(result.results.filter(entry => entry.status === "repaired").length, 4);
  assert.equal(result.results.find(entry => entry.server === "unscoped").status, "unresolved");
  const updated = JSON.parse(await fs.readFile(file, "utf8"));
  assert.equal(updated.projects[project].mcpServers.scoped.command, binary);
  assert.equal(updated.mcpServers.explicit.command, binary);
  assert.equal(updated.mcpServers.unscoped.command, command);
  assert.equal(updated.projects[project].mcpServers.project.command, binary);
  assert.equal(JSON.parse(await fs.readFile(path.join(project, ".mcp.json"), "utf8")).mcpServers.project.command, command);
  assert.ok((await fs.readFile(path.join(project, ".codex/config.toml"), "utf8")).includes(JSON.stringify(binary)));
  assert.ok((await f.run()).results.every(entry => entry.server === "unscoped" || entry.status === "healthy"));
});

test("macOS system application permissions do not weaken other directory checks", async () => {
  const source = String.raw`
import ast, json, os, sys, types
source = json.load(sys.stdin)
tree = ast.parse(source)
definition = next(node for node in tree.body if isinstance(node, ast.FunctionDef) and node.name == 'trusted_directory_mode')
namespace = {'os': os, 'sys': types.SimpleNamespace(platform='darwin'), 'grp': types.SimpleNamespace(getgrgid=lambda gid: types.SimpleNamespace(gr_name='admin' if gid == 80 else 'staff'))}
exec(compile(ast.Module(body=[definition], type_ignores=[]), '<directory-check>', 'exec'), namespace)
check = namespace['trusted_directory_mode']
meta = lambda owner, group, mode: types.SimpleNamespace(st_uid=owner, st_gid=group, st_mode=mode)
assert check('/Applications', meta(0, 80, 0o775))
assert not check('/Applications', meta(0, 80, 0o777))
assert not check('/Applications', meta(0, 20, 0o775))
assert not check('/Applications/App.app/Contents', meta(os.getuid(), 80, 0o775))
assert not check('/Users/example/.local/bin', meta(os.getuid(), 80, 0o775))
namespace['sys'].platform = 'linux'
assert not check('/Applications', meta(0, 80, 0o775))
`;
  await new Promise((resolve, reject) => {
    const child = execFile("python3", ["-c", source], { timeout: 5000 }, error => error ? reject(error) : resolve());
    child.stdin.end(JSON.stringify(MCP_REPAIR_TARGET));
  });
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

test("apply restricts writable private configurations without touching shared files or hard links", async t => {
  const f = await fixture(t);
  const file = path.join(f.home, ".claude.json");
  const original = JSON.stringify({ mcpServers: { service: { command: f.launcher } } });
  await fs.writeFile(file, original, { mode: 0o664 });
  await fs.chmod(file, 0o664);
  assert.ok((await f.run(false)).results.some(entry => entry.status === "unresolved"));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o664);
  assert.ok((await f.run()).results.some(entry => entry.status === "repaired"));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.equal(await fs.readFile(file, "utf8"), original);
  await fs.link(file, path.join(f.home, ".claude-other.json"));
  await fs.chmod(file, 0o664);
  assert.ok((await f.run()).results.every(entry => entry.status === "unresolved"));
  assert.equal((await fs.stat(file)).mode & 0o777, 0o664);
});

test("Railway provisioning verifies archives, publishes a private cache and never downloads unknown commands", async t => {
  const f = await fixture(t);
  const harness = String.raw`
import hashlib, io, json, os, sys, tarfile, types
source = json.load(sys.stdin)
os.umask(0o002)
namespace = {}
exec(source.split('files = []')[0].replace('request = json.load(sys.stdin)', "request = {'apply': True}"), namespace)
def archive(name='railway', kind=tarfile.REGTYPE, extra=False):
    data = io.BytesIO()
    with tarfile.open(fileobj=data, mode='w:gz') as bundle:
        item = tarfile.TarInfo(name)
        item.type = kind
        item.linkname = 'elsewhere' if kind != tarfile.REGTYPE else ''
        item.size = 8 if kind == tarfile.REGTYPE else 0
        bundle.addfile(item, io.BytesIO(b'checked!') if item.size else None)
        if extra:
            bundle.addfile(tarfile.TarInfo('extra'))
    return data.getvalue()
valid = archive()
extract = namespace['railway_binary']
assert extract(valid, hashlib.sha256(valid).hexdigest()) == b'checked!'
for data, digest in [(valid, '0' * 64)] + [(value, hashlib.sha256(value).hexdigest()) for value in [archive('../railway'), archive(kind=tarfile.SYMTYPE), archive(kind=tarfile.LNKTYPE), archive(extra=True)]]:
    try:
        extract(data, digest)
        raise AssertionError('Unsafe archive accepted')
    except ValueError:
        pass
calls = []
def download(url, timeout):
    calls.append(url)
    assert url.startswith('https://github.com/railwayapp/cli/releases/download/v5.51.0/')
    assert timeout <= 8
    return io.BytesIO(valid)
namespace['urllib'].request.urlopen = download
namespace['RAILWAY_ASSETS'] = {(namespace['platform'].system(), namespace['platform'].machine()): ('test-platform', hashlib.sha256(valid).hexdigest())}
namespace['directories'] = []
repair = namespace['repair_entry']
for entry in [{'command': 'unknown-package', 'args': ['mcp']}, {'command': 'railway', 'args': ['deploy']}, {'command': 'railway', 'args': ['mcp'], 'disabled': True}, {'command': 'railway', 'args': 'mcp'}]:
    assert repair(entry)[0] is None
assert calls == []
namespace['apply'] = False
assert repair({'command': 'railway', 'args': ['mcp']})[1] == 'repairable'
assert calls == []
namespace['apply'] = True
candidate, status, _ = repair({'command': 'railway', 'args': ['mcp']})
assert status == 'repairable' and candidate['args'] == ['mcp']
binary = candidate['command']
assert os.path.isabs(binary) and os.stat(binary).st_mode & 0o777 == 0o700
assert namespace['provision_railway']() == binary and len(calls) == 1
assert os.stat(os.path.join(os.path.dirname(binary), 'checksum.json')).st_mode & 0o777 == 0o600
with open(binary, 'wb') as target:
    target.write(b'tampered')
try:
    namespace['provision_railway']()
    raise AssertionError('Modified cached executable accepted')
except ValueError:
    pass
assert len(calls) == 1
`;
  await new Promise((resolve, reject) => {
    const child = execFile("python3", ["-c", harness], { env: { ...process.env, HOME: f.home }, timeout: 5000 }, error => error ? reject(error) : resolve());
    child.stdin.end(JSON.stringify(MCP_REPAIR_TARGET));
  });
});
