import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

test("worker scans preserve fresh requests, incremental totals, large UTF-8 records and event-loop responsiveness", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-spend-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, ".claude", "projects", "fixture");
  await mkdir(dir, { recursive: true });
  const transcript = path.join(dir, "session.jsonl");
  const script = path.join(root, "check.mjs");
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import { computeSpend } from ${JSON.stringify(new URL("../lib/spend.js", import.meta.url).href)};
    const file = ${JSON.stringify(transcript)};
    const record = (id, tokens) => JSON.stringify({ timestamp: new Date().toISOString(), requestId: id,
      message: { id, model: 'claude-sonnet-4-6', usage: { input_tokens: tokens } } });
    await fs.writeFile(file, JSON.stringify({ content: 'ı'.repeat(4 * 1024 * 1024) }) + '\\n' + record('one', 100) + '\\n');
    let ticks = 0;
    const timer = setInterval(() => ticks++, 1);
    const first = computeSpend({ fresh: true });
    assert.equal(first, computeSpend({ fresh: true }));
    const initial = await first;
    clearInterval(timer);
    assert.ok(ticks > 0, 'worker scan must allow event-loop work');
    assert.equal(initial[0].today.tokens, 100);
    await fs.appendFile(file, record('two', 200) + '\\n' + record('three', 300).slice(0, -1));
    assert.equal((await computeSpend())[0].today.tokens, 100);
    assert.equal((await computeSpend({ fresh: true }))[0].today.tokens, 300);
    await fs.appendFile(file, '}');
    assert.equal((await computeSpend({ fresh: true }))[0].today.tokens, 600);
    await fs.appendFile(file, '\\n' + record('four', 400) + '\\n');
    assert.equal((await computeSpend({ fresh: true }))[0].today.tokens, 1000);
    process.stdout.write('ok');
  `);
  const { stdout } = await execute(process.execPath, [script], {
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root }, timeout: 10_000,
  });
  assert.equal(stdout, "ok");
});
