import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

const execute = promisify(execFile);

async function checkSpend(t, source) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-spend-pricing-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const dir = path.join(root, ".codex");
  await mkdir(path.join(dir, "sessions"), { recursive: true });
  // Account discovery only needs the file to exist; no login data is used.
  await writeFile(path.join(dir, "auth.json"), "{}");
  const script = path.join(root, "check.mjs");
  await writeFile(script, `
    import assert from 'node:assert/strict';
    import fs from 'node:fs/promises';
    import path from 'node:path';
    import { scanSpend } from ${JSON.stringify(new URL("../lib/spend-scan.js", import.meta.url).href)};
    const root = ${JSON.stringify(root)};
    const dir = ${JSON.stringify(dir)};
    const file = path.join(dir, 'sessions', 'session.jsonl');
    const now = new Date('2026-09-10T12:00:00Z').getTime();
    const context = (model, day = '2026-09-10') => JSON.stringify({
      timestamp: day + 'T10:00:00Z', type: 'turn_context', payload: { model }
    });
    const usage = (input, cached, output, day = '2026-09-10') => JSON.stringify({
      timestamp: day + 'T10:00:00Z', type: 'event_msg', payload: {
        type: 'token_count', info: { total_token_usage: {
          input_tokens: input, cached_input_tokens: cached, output_tokens: output,
          reasoning_output_tokens: output, total_tokens: input + output
        } }
      }
    });
    const scan = async () => {
      const accounts = await scanSpend(now);
      assert.equal(accounts.length, 1);
      return accounts[0];
    };
    ${source}
    process.stdout.write('ok');
  `);
  const { stdout } = await execute(process.execPath, [script], {
    env: { ...process.env, HOME: root, XDG_CONFIG_HOME: root, TZ: "UTC" }, timeout: 10_000,
  });
  assert.equal(stdout, "ok");
}

test("prices the reported model with official input, cache-read and output rates without double-counting totals", async (t) => {
  await checkSpend(t, `
    const yesterday = [13740370 + 848479360, 848479360, 2328635];
    const today = [4163051 + 149584256, 149584256, 631103];
    const totals = today.map((n, i) => n + yesterday[i]);
    await fs.writeFile(file, [context('gpt-6-astra'), usage(...yesterday, '2026-09-09'), usage(...totals), usage(...totals)].join('\\n') + '\\n');
    const result = await scan();
    assert.equal(result.pricingBasis, 'standard-api-short-context');
    assert.equal(result.today.tokens, 154378410);
    assert.equal(result.yesterday.tokens, 864548365);
    assert.ok(Math.abs(result.today.cost - 222.769916) < 1e-9);
    assert.ok(Math.abs(result.yesterday.cost - 1102.314810) < 1e-9);
    assert.ok(Math.abs(result.window.cost - 1325.084726) < 1e-9);
    assert.equal(result.today.pricedCost, result.today.cost);
    assert.equal(result.today.unpricedTokens, 0);
    assert.deepEqual(result.today.unpricedModels, []);
    assert.deepEqual(result.days.at(-1), { day: '2026-09-10', ...result.today });
    assert.deepEqual(result.days.at(-2), { day: '2026-09-09', ...result.yesterday });
    assert.deepEqual(await scan(), result);
    await fs.appendFile(file, context('gpt-6-astra-20260910[1m]') + '\\n' + usage(totals[0] + 1000000, totals[1] + 750000, totals[2] + 100000) + '\\n');
    const next = await scan();
    assert.equal(next.today.tokens, 155478410);
    assert.ok(Math.abs(next.today.cost - (222.769916 + 8.25)) < 1e-9);
  `);
});

test("unknown model pricing remains unavailable across cold, incremental and archived mixed-model totals", async (t) => {
  await checkSpend(t, `
    await fs.writeFile(file, [context('unlisted-model'), usage(1000000, 750000, 100000)].join('\\n') + '\\n');
    let result = await scan();
    assert.equal(result.today.cost, null);
    assert.equal(result.today.pricedCost, 0);
    assert.equal(result.today.tokens, 1100000);
    assert.equal(result.today.unpricedTokens, 1100000);
    assert.deepEqual(result.today.unpricedModels, ['unlisted-model']);
    assert.equal(result.days.at(-1).cost, null);
    assert.equal(result.yesterday.cost, 0);
    assert.equal(result.yesterday.unpricedTokens, 0);
    assert.deepEqual(await scan(), result);
    await fs.appendFile(file, context('gpt-6-astra') + '\\n' + usage(2000000, 1500000, 200000) + '\\n');
    result = await scan();
    assert.equal(result.today.cost, null);
    assert.equal(result.today.pricedCost, 8.25);
    assert.equal(result.today.tokens, 2200000);
    assert.equal(result.today.unpricedTokens, 1100000);
    assert.equal(result.days.at(-1).pricedCost, 8.25);
    const archived = path.join(dir, 'archived_sessions');
    await fs.mkdir(archived);
    await fs.writeFile(path.join(archived, 'other.jsonl'), [context('gpt-6-astra-unpublished-variant'), usage(1000000, 0, 0)].join('\\n') + '\\n');
    result = await scan();
    assert.equal(result.window.cost, null);
    assert.equal(result.window.pricedCost, 8.25);
    assert.equal(result.window.unpricedTokens, 2100000);
    assert.deepEqual(result.window.unpricedModels, ['gpt-6-astra-unpublished-variant', 'unlisted-model']);
  `);
});

test("existing parse caches are repriced without discarding their token buckets or resuming transcripts", async (t) => {
  await checkSpend(t, `
    await fs.writeFile(file, '\\n');
    const stat = await fs.stat(file);
    await fs.writeFile(path.join(root, 'pzzacode', 'spend-cache.json'), JSON.stringify({
      version: 2,
      files: { [file]: { mtimeMs: stat.mtimeMs, size: stat.size, parsedBytes: stat.size,
        days: { '2026-09-10': { 'gpt-6-astra': [250000, 100000, 750000, 0, 0] } },
        state: { model: 'gpt-6-astra', previous: [1000000, 750000, 100000] }
      } }
    }));
    const result = await scan();
    assert.equal(result.today.cost, 8.25);
    assert.equal(result.today.tokens, 1100000);
    assert.deepEqual(result.today.unpricedModels, []);
  `);
});

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
