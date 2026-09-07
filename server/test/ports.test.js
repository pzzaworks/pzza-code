import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { inspectPortProcesses, listPortDetails, parsePorts } from "../lib/ports.js";

test("port parser deduplicates IPv4 and IPv6 listeners", () => {
  assert.deepEqual(parsePorts("127.0.0.1:3000\n[::]:3000\n*:4100\n"), [3000, 4100]);
});

test("listener identity uses its actual project name, then working folder", { skip: !["linux", "darwin"].includes(os.platform()) }, async (t) => {
  const root = await mkdtemp(path.join(os.homedir(), ".pzza-port-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cwd = path.join(root, "service");
  await mkdir(cwd);
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "actual-preview-project" }));
  const child = spawn(process.execPath, ["-e", "require('node:http').createServer((req,res)=>res.end()).listen(0,'127.0.0.1',function(){console.log(this.address().port)})"], { cwd, stdio: ["ignore", "pipe", "ignore"] });
  t.after(async () => { if (child.exitCode === null) { child.kill(); await once(child, "exit"); } });
  const [chunk] = await once(child.stdout, "data");
  const port = Number(String(chunk).trim());
  const find = async () => (await inspectPortProcesses()).find((entry) => entry.port === port)?.processes.find((entry) => entry.pid === child.pid);
  const project = await find();
  assert.equal(project?.name, "actual-preview-project");
  assert.equal(project?.source, "package");
  assert.ok(project.process);
  assert.equal("arguments" in project, false);
  assert.equal("environment" in project, false);
  await rm(path.join(root, "package.json"));
  const folder = await find();
  assert.equal(folder?.name, "service");
  assert.equal(folder?.source, "folder");
});

test("invalid SSH targets fail before process probing", async () => {
  await assert.rejects(listPortDetails("-oProxyCommand=bad"), /Invalid device host/);
});
