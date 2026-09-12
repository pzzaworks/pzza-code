import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { randomBytes } from "node:crypto";
import os from "node:os";
import path from "node:path";
import test from "node:test";

test("importing HTTP helpers preserves the active credential until explicit publication", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-http-credential-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = path.join(root, "pzzacode");
  const file = path.join(directory, "agent-token");
  await mkdir(directory);
  const previous = randomBytes(24).toString("hex");
  const next = randomBytes(24).toString("hex");
  await writeFile(file, previous, { mode: 0o600 });
  const module = new URL("../lib/http.js", import.meta.url).href;
  const run = promisify(execFile);
  const options = { env: { ...process.env, XDG_CONFIG_HOME: root, PZZA_AGENT_TOKEN: next }, timeout: 5000 };
  await run(process.execPath, ["--input-type=module", "-e", `await import(${JSON.stringify(module)})`], options);
  assert.ok(await readFile(file, "utf8") === previous, "Imports must leave the live credential unchanged");
  await run(process.execPath, ["--input-type=module", "-e", `const { publishAgentToken } = await import(${JSON.stringify(module)}); publishAgentToken();`], options);
  assert.ok(await readFile(file, "utf8") === next, "Explicit publication must update the credential");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  assert.equal((await readdir(directory)).some(name => name.startsWith(".agent-token-")), false);
});

test("project scan streams expose CORS only to trusted app origins", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "pzza-http-test-"));
  const previous = process.env.XDG_CONFIG_HOME;
  process.env.XDG_CONFIG_HOME = dir;
  t.after(async () => {
    if (previous === undefined) delete process.env.XDG_CONFIG_HOME;
    else process.env.XDG_CONFIG_HOME = previous;
    await rm(dir, { recursive: true, force: true });
  });
  const { ndjson } = await import("../lib/http.js");
  for (const origin of ["tauri://localhost", "http://localhost:5173", "https://untrusted.example"]) {
    const headers = new Map();
    const chunks = [];
    const res = {
      req: { headers: { origin } }, destroyed: false,
      setHeader: (name, value) => headers.set(name, value),
      writeHead: (status, values) => { assert.equal(status, 200); Object.entries(values).forEach(([name, value]) => headers.set(name, value)); },
      write: (value) => chunks.push(value),
    };
    const send = ndjson(res);
    send({ type: "progress", progress: { completed: 0 } });
    send({ type: "result", result: { devices: [] } });
    assert.equal(headers.get("Content-Type"), "application/x-ndjson");
    assert.equal(headers.get("Access-Control-Allow-Origin"), origin.includes("untrusted") ? undefined : origin);
    assert.equal(chunks.length, 2);
    assert.deepEqual(chunks.map((line) => JSON.parse(line).type), ["progress", "result"]);
  }
});
