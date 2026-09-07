import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

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
