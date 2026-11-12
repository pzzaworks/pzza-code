import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, rm, stat, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { DatabaseSync } from "node:sqlite";
import { USAGE_ADAPTERS, usageAdapter } from "../lib/agent-usage/index.js";
import { bucketCost } from "../lib/agent-usage/pricing.js";
import { codexRolloutLimits, codexRolloutUsage } from "../lib/agent-usage/codex.js";
import { CLI_LIMITS, jsonOutput, runCliLimit } from "../lib/agent-usage/cli-limits.js";
import { kimiWorkspaceId } from "../lib/agent-usage/kimi.js";
import { piSessionFolder } from "../lib/agent-usage/pi.js";
import { qwenOutputTokens } from "../lib/agent-usage/qwen.js";
import { gooseTime } from "../lib/agent-usage/goose.js";
import { parseTranscript } from "../lib/spend-scan.js";
import { findSessionCost, findSessionModel, sessionCostQuery } from "../lib/session-cost.js";
import { cliLimitUsage, codexAccountUsage } from "../lib/usage.js";
import { normalizeEffectiveModel } from "../lib/session-activity.js";
import { SESSION_AGENT_IDS } from "../lib/session-agents.js";

const execute = promisify(execFile);
const FIXTURES = new URL("./fixtures/agent-usage/", import.meta.url).pathname;
const CWD = "/Users/dev/proj";
const close = (actual, expected, label) => assert.ok(Math.abs(actual - expected) < 1e-9, `${label}: ${actual} != ${expected}`);

async function fixture(t, name) {
  const root = await mkdtemp(path.join(os.tmpdir(), `pzza-agent-usage-${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  await cp(path.join(FIXTURES, name), root, { recursive: true });
  return root;
}

async function touch(file, iso) {
  const time = new Date(iso);
  await utimes(file, time, time);
}

async function parsedFile(provider, file) {
  return parseTranscript(provider, file, await stat(file), undefined);
}

// Every token of every bucket, per model, summed over days.
function byModel(days) {
  const out = {};
  for (const models of Object.values(days)) {
    for (const [model, buckets] of Object.entries(models)) {
      const total = (out[model] = out[model] || buckets.map(() => 0));
      buckets.forEach((value, i) => { total[i] += value; });
    }
  }
  return out;
}

const SQL = {
  goose: `CREATE TABLE sessions (id TEXT PRIMARY KEY, working_dir TEXT NOT NULL,
      created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP, updated_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      accumulated_total_tokens INTEGER, accumulated_input_tokens INTEGER, accumulated_output_tokens INTEGER,
      accumulated_cache_read_tokens INTEGER, accumulated_cache_write_tokens INTEGER, accumulated_cost REAL,
      provider_name TEXT, model_config_json TEXT, parent_session_id TEXT);
    INSERT INTO sessions VALUES ('20261110_1','/Users/x/proj','2026-11-10 09:00:00','2026-11-10 09:30:00',
      15000,12000,3000,8000,500,0.0421,'anthropic','{"model_name":"claude-sonnet-4-5","temperature":null}',NULL);
    INSERT INTO sessions VALUES ('20261110_2','/Users/x/proj','2026-11-10T10:00:00+00:00','2026-11-10 10:05:00',
      900,700,200,NULL,NULL,NULL,'ollama','{"model_name":"qwen3"}','20261110_1');`,
  crush: `CREATE TABLE sessions (id TEXT PRIMARY KEY, parent_session_id TEXT, title TEXT NOT NULL,
      prompt_tokens INTEGER NOT NULL DEFAULT 0, completion_tokens INTEGER NOT NULL DEFAULT 0,
      cost REAL NOT NULL DEFAULT 0.0, updated_at INTEGER NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT NOT NULL, role TEXT NOT NULL,
      parts TEXT NOT NULL DEFAULT '[]', model TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
      finished_at INTEGER, provider TEXT);
    INSERT INTO sessions VALUES ('s1',NULL,'Fix bug',42000,1800,0.37,1794300000,1794290000);
    INSERT INTO sessions VALUES ('s2','s1','Subagent',9000,400,0.05,1794299000,1794298000);
    INSERT INTO messages VALUES ('m0','s1','assistant','[]','gpt-5',1794290050,1794290050,1794290060,'openai');
    INSERT INTO messages VALUES ('m1','s1','assistant','[]','claude-sonnet-4-5',1794290100,1794290100,1794290150,'anthropic');
    INSERT INTO messages VALUES ('m2','s2','assistant','[]','gpt-5',1794298100,1794298100,1794298120,'openai');`,
  kilo: `CREATE TABLE session (id text PRIMARY KEY, parent_id text, directory text NOT NULL, title text NOT NULL,
      cost real DEFAULT 0 NOT NULL, tokens_input integer DEFAULT 0 NOT NULL, tokens_output integer DEFAULT 0 NOT NULL,
      tokens_reasoning integer DEFAULT 0 NOT NULL, tokens_cache_read integer DEFAULT 0 NOT NULL,
      tokens_cache_write integer DEFAULT 0 NOT NULL, model text, time_created integer NOT NULL, time_updated integer NOT NULL);
    INSERT INTO session VALUES ('ses_a',NULL,'/Users/x/proj','Refactor',0.0123,1500,300,50,20000,1000,
      '{"id":"claude-sonnet-4-5","providerID":"anthropic"}',1794290000000,1794290500000);
    INSERT INTO session VALUES ('ses_b','ses_a','/Users/x/proj','Sub',0,10,5,0,0,0,NULL,1794290100000,1794290200000);`,
};

function database(file, sql) {
  const db = new DatabaseSync(file);
  db.exec(sql);
  db.close();
}

test("every adapter is a catalog agent with one complete reader", () => {
  for (const adapter of USAGE_ADAPTERS) {
    assert.ok(SESSION_AGENT_IDS.includes(adapter.id), adapter.id);
    assert.ok(["standard-api-short-context", "agent-recorded"].includes(adapter.pricingBasis), adapter.id);
    const files = typeof adapter.transcripts === "function" && typeof adapter.parse === "function" && typeof adapter.sessionFiles === "function";
    const db = typeof adapter.records === "function" && typeof adapter.sessionEntry === "function";
    assert.ok(files !== db, `${adapter.id} has exactly one reader`);
  }
});

test("Gemini CLI counts each message id once, keeps rewound replies, adds subagents and ignores migrated copies", async (t) => {
  const root = await fixture(t, "gemini");
  const adapter = usageAdapter("gemini");
  const main = path.join(root, "tmp", "proj", "chats", "session-2026-11-10T09-14-5f0c2a9e.jsonl");
  const entry = await parsedFile("gemini", main);
  // The session is named by the transcript's own sessionId record.
  const sessionId = "5f0c2a9e-7b1d-4c3e-9a51-2d8e6f4b1c07";
  assert.equal(entry.state.sessionKey, sessionId);
  // input - cached + tool, output + thoughts, cached.
  assert.deepEqual(byModel(entry.days), { "gemini-3.6-flash": [4648, 310, 8192, 0, 0], "gemini-2.5-pro": [20100, 500, 0, 0, 0] });
  const files = adapter.transcripts({ dir: root });
  assert.equal(files.length, 3, "main, subagent and the legacy copy are all listed");

  const accounts = [{ provider: "gemini", dir: root }];
  const cost = await findSessionCost({ provider: "gemini", cwd: CWD, since: 0, accounts });
  assert.equal(cost.found, true);
  assert.equal(cost.subagents, 1);
  assert.deepEqual(cost.models, ["gemini-2.5-flash", "gemini-2.5-pro", "gemini-3.6-flash"]);
  assert.deepEqual(cost.tokens, { input: 25748, output: 910, cacheRead: 8192, cacheWrite: 0 });
  // 3.6 Flash at its rate until 2026-12-31, 2.5 Pro and 2.5 Flash at list rates.
  close(cost.cost, (4648 * 0.75 + 310 * 3.75 + 8192 * 0.075 + 20100 * 1.25 + 500 * 10 + 1000 * 0.3 + 100 * 2.5) / 1e6, "gemini cost");
  assert.equal(cost.pricingBasis, "standard-api-short-context");
  assert.equal(await findSessionModel({ provider: "gemini", cwd: CWD, since: 0, accounts }), "gemini-2.5-pro");
  assert.deepEqual(await findSessionCost({ provider: "gemini", cwd: "/Users/dev/other", since: 0, accounts }), { found: false, provider: "gemini" });
});

test("Qwen Code reads its own api_response telemetry once per response and skips fork copies", async (t) => {
  const root = await fixture(t, "qwen");
  const file = path.join(root, "projects", "-Users-dev-proj", "chats", "a3c9e1f2-5b7d-4e8a-9c0b-1d2e3f4a5b6c.jsonl");
  const entry = await parsedFile("qwen", file);
  assert.deepEqual(byModel(entry.days), { "qwen3.7-plus": [3032, 412, 12288, 0, 0], "qwen3-coder-flash": [1000, 70, 0, 0, 0] });
  // OpenAI-style output already includes thoughts; Gemini-style adds them.
  assert.equal(qwenOutputTokens({ input_token_count: 10, output_token_count: 5, thoughts_token_count: 3, total_token_count: 0, auth_type: "openai" }), 5);
  assert.equal(qwenOutputTokens({ input_token_count: 10, output_token_count: 5, thoughts_token_count: 3, total_token_count: 0, auth_type: "gemini" }), 8);
  const accounts = [{ provider: "qwen", dir: root }];
  const cost = await findSessionCost({ provider: "qwen", cwd: CWD, since: 0, accounts });
  // qwen3-coder-flash's lowest tier ends at 32k tokens, so it stays unpriced.
  assert.equal(cost.cost, null);
  close(cost.pricedCost, (3032 * 0.4 + 412 * 1.6 + 12288 * 0.08) / 1e6, "qwen priced subtotal");
  assert.deepEqual(cost.unpricedModels, ["qwen3-coder-flash"]);
  assert.equal(await findSessionModel({ provider: "qwen", cwd: CWD, since: 0, accounts }), "qwen3-coder-flash");
});

test("Pi takes the cost it recorded, keeps unrecorded replies unpriced and skips a fork's copied entries", async (t) => {
  const root = await fixture(t, "pi");
  const folder = path.join(root, "sessions", piSessionFolder(CWD));
  assert.equal(piSessionFolder(CWD), "--Users-dev-proj--");
  const original = path.join(folder, "2026-11-10T09-14-02-511Z_019a7c2e-5b1a-7f3c-9d2e-3f4a5b6c7d8e.jsonl");
  const fork = path.join(folder, "2026-11-10T10-00-00-000Z_019a7c40-1111-7222-8333-444455556666.jsonl");
  const first = byModel((await parsedFile("pi", original)).days);
  assert.deepEqual(first["anthropic/claude-sonnet-4-5"].slice(0, 5), [12, 420, 68000, 2100, 0]);
  close(first["anthropic/claude-sonnet-4-5"][5], 0.034611, "pi recorded cost");
  assert.deepEqual(first["openai/gpt-5"], [100, 10, 0, 0, 0, 0, 110]);
  assert.deepEqual(byModel((await parsedFile("pi", fork)).days), { "anthropic/claude-sonnet-4-5": [5, 100, 0, 0, 0, 0.01, 0] });

  await touch(original, "2026-11-10T09:30:00Z");
  await touch(fork, "2026-11-10T10:06:00Z");
  const accounts = [{ provider: "pi", dir: path.join(root, "sessions"), flat: false }];
  const cost = await findSessionCost({ provider: "pi", cwd: CWD, since: 0, accounts });
  assert.equal(cost.pricingBasis, "agent-recorded");
  assert.equal(cost.cost, 0.01);
  assert.deepEqual(cost.tokens, { input: 5, output: 100, cacheRead: 0, cacheWrite: 0 });
  await touch(original, "2026-11-10T11:00:00Z");
  const older = await findSessionCost({ provider: "pi", cwd: CWD, since: 0, accounts });
  assert.equal(older.cost, null, "a reply without a recorded cost is not $0");
  close(older.pricedCost, 0.034611, "pi priced subtotal");
  assert.deepEqual(older.unpricedModels, ["openai/gpt-5"]);
});

test("Kimi Code sums usage records of every scope, adds subagents and drops what a fork copied", async (t) => {
  const root = await fixture(t, "kimi");
  assert.equal(kimiWorkspaceId(CWD), "wd_proj_75ff31d92333");
  const workspace = path.join(root, "sessions", kimiWorkspaceId(CWD));
  const main = path.join(workspace, "s1", "agents", "main", "wire.jsonl");
  const forked = path.join(workspace, "s2", "agents", "main", "wire.jsonl");
  assert.deepEqual(byModel((await parsedFile("kimi", main)).days), { "kimi-k3.1-pro": [7144, 508, 20480, 0, 0] });
  assert.deepEqual(byModel((await parsedFile("kimi", forked)).days), { "kimi-k3.1-pro": [50, 5, 0, 0, 0] });

  await touch(forked, "2026-11-10T10:30:00Z");
  await touch(main, "2026-11-10T11:00:00Z");
  const accounts = [{ provider: "kimi", dir: root }];
  const cost = await findSessionCost({ provider: "kimi", cwd: CWD, since: 0, accounts });
  assert.equal(cost.subagents, 1);
  assert.equal(cost.cost, null, "the subscription alias has no per-token price");
  close(cost.pricedCost, (7144 * 2 + 508 * 10 + 20480 * 0.2) / 1e6, "kimi priced subtotal");
  assert.deepEqual(cost.unpricedModels, ["kimi-code/kimi-for-coding"]);
});

test("Grok Build reads per-turn ledgers with the server's cost, skipping fork copies and subagent sessions", async (t) => {
  const root = await fixture(t, "grok");
  const project = path.join(root, "sessions", encodeURIComponent(CWD));
  const one = byModel((await parsedFile("grok", path.join(project, "sess-1", "usage.json"))).days);
  assert.deepEqual(one["grok-4.6"].slice(0, 5), [7250, 1320, 40960, 0, 0]);
  close(one["grok-4.6"][5], 0.0429, "grok recorded cost");
  assert.deepEqual(one["grok-4.5"], [1000, 100, 0, 0, 0, 0, 1100], "a partial cost is not a recorded cost");
  assert.deepEqual(byModel((await parsedFile("grok", path.join(project, "sess-fork", "usage.json"))).days), { "grok-4.6": [1000, 200, 1000, 0, 0, 0.002, 0] });
  assert.deepEqual((await parsedFile("grok", path.join(project, "sess-sub", "usage.json"))).days, {});
  // The ledger is rewritten whole: a grown file is parsed again, never resumed.
  assert.equal(usageAdapter("grok").wholeFile, true);

  await touch(path.join(project, "sess-1", "usage.json"), "2026-11-10T09:40:00Z");
  await touch(path.join(project, "sess-fork", "usage.json"), "2026-11-10T10:00:00Z");
  await touch(path.join(project, "sess-sub", "usage.json"), "2026-11-10T10:10:00Z");
  const accounts = [{ provider: "grok", dir: path.join(root, "sessions") }];
  const cost = await findSessionCost({ provider: "grok", cwd: CWD, since: 0, accounts });
  close(cost.cost, 0.002, "grok fork cost");
  assert.equal(await findSessionModel({ provider: "grok", cwd: CWD, since: 0, accounts }), "grok-4.6");
});

test("goose, Crush and Kilo read their own databases read-only, with recorded costs and subagents", async (t) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-agent-usage-db-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const gooseFile = path.join(root, "sessions.db");
  database(gooseFile, SQL.goose);
  const crushData = path.join(root, "proj", ".crush");
  await mkdir(crushData, { recursive: true });
  database(path.join(crushData, "crush.db"), SQL.crush);
  await writeFile(path.join(root, "projects.json"), JSON.stringify({ projects: [{ path: "/Users/x/proj", data_dir: crushData, last_accessed: "2026-11-10T09:00:00Z" }] }));
  const kiloFile = path.join(root, "kilo.db");
  database(kiloFile, SQL.kilo);
  const horizon = Date.parse("2026-11-01T00:00:00Z");

  assert.equal(gooseTime("2026-11-10 09:00:00"), Date.parse("2026-11-10T09:00:00Z"), "SQLite timestamps are UTC");
  const goose = byModel(await usageAdapter("goose").records({ file: gooseFile }, horizon));
  // The uncached input is what the recorded total leaves after output and cache.
  assert.deepEqual(goose["anthropic/claude-sonnet-4-5"], [3500, 3000, 8000, 500, 0, 0.0421, 0]);
  assert.deepEqual(goose["ollama/qwen3"], [700, 200, 0, 0, 0, 0, 900]);
  const gooseSession = await findSessionCost({ provider: "goose", cwd: "/Users/x/proj", since: 0, accounts: [{ provider: "goose", file: gooseFile }] });
  assert.equal(gooseSession.subagents, 1);
  assert.equal(gooseSession.cost, null);
  close(gooseSession.pricedCost, 0.0421, "goose priced subtotal");

  const crush = byModel(await usageAdapter("crush").records({ dir: root }, horizon));
  assert.deepEqual(crush, { "anthropic/claude-sonnet-4-5": [0, 0, 0, 0, 0, 0.37, 0] }, "subagent cost is already in its parent's");
  const crushSession = await findSessionCost({ provider: "crush", cwd: "/Users/x/proj", since: 0, accounts: [{ provider: "crush", dir: root }] });
  assert.equal(crushSession.cost, 0.37);
  assert.equal(crushSession.tokens, null, "Crush records no token totals");
  assert.equal(crushSession.subagents, 1);

  const kilo = byModel(await usageAdapter("kilo").records({ file: kiloFile }, horizon));
  assert.deepEqual(kilo["anthropic/claude-sonnet-4-5"], [1500, 350, 20000, 1000, 0, 0.0123, 0]);
  const kiloSession = await findSessionCost({ provider: "kilo", cwd: "/Users/x/proj", since: 0, accounts: [{ provider: "kilo", file: kiloFile }] });
  assert.equal(kiloSession.subagents, 1);
  assert.equal(kiloSession.cost, 0.0123);
  assert.equal(await findSessionModel({ provider: "kilo", cwd: "/Users/x/proj", since: 0, accounts: [{ provider: "kilo", file: kiloFile }] }), "anthropic/claude-sonnet-4-5");

  // Read-only: the reader can never write to an agent's database.
  const before = (await stat(kiloFile)).mtimeMs;
  await usageAdapter("kilo").records({ file: kiloFile }, horizon);
  assert.equal((await stat(kiloFile)).mtimeMs, before);
  assert.equal(await usageAdapter("kilo").records({ file: path.join(root, "missing.db") }, horizon), null);
});

test("the spend scan lists every agent with local usage on its own data roots, and only those", async (t) => {
  const home = await mkdtemp(path.join(os.tmpdir(), "pzza-agent-usage-home-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const data = path.join(home, ".local", "share");
  await cp(path.join(FIXTURES, "gemini"), path.join(home, ".gemini"), { recursive: true });
  await cp(path.join(FIXTURES, "qwen"), path.join(home, ".qwen"), { recursive: true });
  await cp(path.join(FIXTURES, "pi"), path.join(home, ".pi", "agent"), { recursive: true });
  await cp(path.join(FIXTURES, "kimi"), path.join(home, ".kimi-code"), { recursive: true });
  await cp(path.join(FIXTURES, "grok"), path.join(home, ".grok"), { recursive: true });
  await mkdir(path.join(data, "goose", "sessions"), { recursive: true });
  database(path.join(data, "goose", "sessions", "sessions.db"), SQL.goose);
  await mkdir(path.join(data, "kilo"), { recursive: true });
  database(path.join(data, "kilo", "kilo.db"), SQL.kilo);
  const crushData = path.join(home, "proj", ".crush");
  await mkdir(crushData, { recursive: true });
  database(path.join(crushData, "crush.db"), SQL.crush);
  await mkdir(path.join(data, "crush"), { recursive: true });
  await writeFile(path.join(data, "crush", "projects.json"), JSON.stringify({ projects: [{ path: path.join(home, "proj"), data_dir: crushData }] }));
  // An installed but idle agent (no sessions in the window) adds no row.
  await mkdir(path.join(home, ".qwen", "projects", "-idle", "chats"), { recursive: true });

  const script = path.join(home, "check.mjs");
  await writeFile(script, `
    import { scanSpend } from ${JSON.stringify(new URL("../lib/spend-scan.js", import.meta.url).href)};
    const now = new Date('2026-11-10T12:00:00Z').getTime();
    const first = await scanSpend(now);
    const again = await scanSpend(now);
    process.stdout.write(JSON.stringify({ first, same: JSON.stringify(first) === JSON.stringify(again) }));
  `);
  const env = { ...process.env, HOME: home, XDG_CONFIG_HOME: path.join(home, ".config"), XDG_DATA_HOME: data, TZ: "UTC" };
  for (const name of ["GEMINI_CLI_HOME", "QWEN_HOME", "QWEN_RUNTIME_DIR", "PI_CODING_AGENT_DIR", "PI_CODING_AGENT_SESSION_DIR", "KIMI_CODE_HOME", "GROK_HOME", "GOOSE_PATH_ROOT", "CRUSH_GLOBAL_DATA", "KILO_DB", "OPENCODE_DB"]) delete env[name];
  const { stdout } = await execute(process.execPath, [script], { env, timeout: 20_000 });
  const { first, same } = JSON.parse(stdout);
  assert.equal(same, true, "a cached rescan reports the same totals");
  const rows = Object.fromEntries(first.map((row) => [row.provider, row]));
  assert.deepEqual(first.map((row) => row.provider), ["gemini", "pi", "goose", "qwen", "crush", "kilo", "grok", "kimi"]);
  assert.equal(rows.gemini.window.tokens, 13150 + 20600 + 1100, "the migrated copy of a Gemini session is counted once");
  close(rows.gemini.window.cost, 0.0052629 + 0.030125 + 0.00055, "gemini window cost");
  assert.equal(rows.qwen.window.tokens, 15732 + 1070);
  assert.equal(rows.qwen.window.cost, null);
  assert.deepEqual(rows.qwen.window.unpricedModels, ["qwen3-coder-flash"]);
  assert.equal(rows.pi.pricingBasis, "agent-recorded");
  assert.equal(rows.pi.window.tokens, 70532 + 110 + 105);
  close(rows.pi.window.pricedCost, 0.044611, "pi window recorded cost");
  assert.equal(rows.kimi.window.tokens, 28132 + 110 + 55);
  close(rows.grok.window.pricedCost, 0.0429 + 0.002, "grok window recorded cost");
  assert.deepEqual(rows.grok.window.unpricedModels, ["grok-4.5"]);
  assert.equal(rows.goose.window.tokens, 15900);
  assert.equal(rows.crush.tokensTracked, false);
  assert.equal(rows.crush.window.cost, 0.37);
  assert.equal(rows.kilo.window.cost, 0.0123);
  assert.equal(rows.kilo.days.at(-1).day, "2026-11-10");
  for (const row of first) assert.equal(JSON.stringify(row).includes(home), false, `${row.provider} leaks no local paths`);
});

test("Codex rate limits come from the newest rollout, per limit, dropping windows that already reset", async (t) => {
  const root = await fixture(t, "codex");
  const now = Date.parse("2026-11-10T12:00:00Z");
  const sample = await codexRolloutLimits(root, now);
  assert.equal(sample.plan, "pro");
  assert.deepEqual([...sample.limits.keys()], ["codex", "codex_bengalfox"]);
  const { plan, usage } = codexRolloutUsage(sample, now);
  assert.equal(plan, "pro");
  assert.deepEqual(usage.five_hour, { utilization: 42, resets_at: "2026-11-10T16:00:00.000Z" });
  assert.deepEqual(usage.seven_day, { utilization: 12.5, resets_at: "2026-11-15T09:00:00.000Z" });
  assert.deepEqual(usage.scoped.map((row) => [row.name, row.percent]), [["GPT-5.3-Codex-Spark 5h", 5], ["GPT-5.3-Codex-Spark Weekly", 1]]);
  assert.deepEqual(usage.balances, [{ name: "Credits", amount: 37.5, unit: "credits" }]);
  assert.equal(usage.updatedAt, Date.parse("2026-11-10T10:03:00Z"));
  // After the 5h reset the old percentage says nothing about the new window.
  const later = codexRolloutUsage(sample, Date.parse("2026-11-10T17:00:00Z")).usage;
  assert.equal(later.five_hour, null);
  assert.deepEqual(later.seven_day, { utilization: 12.5, resets_at: "2026-11-15T09:00:00.000Z" });
  assert.equal(await codexRolloutLimits(path.join(root, "missing"), now), null);
});

test("a Codex account falls back to its rollout limits only when the usage endpoint fails", async (t) => {
  const root = await fixture(t, "codex");
  const token = `x.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_plan_type: "pro" }, "https://api.openai.com/profile": { email: "dev@example.test" } })).toString("base64url")}.y`;
  await writeFile(path.join(root, "auth.json"), JSON.stringify({ tokens: { access_token: `${token}${Math.random()}`, account_id: "acct" } }));
  const acc = { provider: "codex", dir: root, label: "Codex" };
  const now = () => Date.parse("2026-11-10T12:00:00Z");
  const down = await codexAccountUsage(acc, true, { now, fetchUsage: async () => { throw Object.assign(new Error("usage 503"), { status: 503 }); } });
  assert.equal(down.usage.source, "session");
  assert.equal(down.usage.stale, true);
  assert.equal(down.usage.five_hour.utilization, 42);
  assert.equal(down.plan, "pro");
  // Rejected credentials still hide the card instead of showing old windows.
  await writeFile(path.join(root, "auth.json"), JSON.stringify({ tokens: { access_token: `${token}${Math.random()}`, account_id: "acct" } }));
  assert.equal(await codexAccountUsage(acc, true, { now, fetchUsage: async () => { throw Object.assign(new Error("usage 401"), { status: 401 }); } }), null);
  await writeFile(path.join(root, "auth.json"), JSON.stringify({ tokens: { access_token: `${token}${Math.random()}`, account_id: "acct" } }));
  const live = await codexAccountUsage(acc, true, { now, fetchUsage: async () => ({ five_hour: { utilization: 50, resets_at: null }, seven_day: null, scoped: [] }) });
  assert.equal(live.usage.source, undefined);
  assert.equal(live.usage.five_hour.utilization, 50);
});

test("CLI balances run a fixed argv without a shell and keep nothing but the numbers", async () => {
  const kilo = CLI_LIMITS.find((item) => item.id === "kilo");
  const auggie = CLI_LIMITS.find((item) => item.id === "auggie");
  assert.deepEqual(jsonOutput('notice\n{"balance": 12.34}\n'), { balance: 12.34 });
  assert.deepEqual(kilo.parse(JSON.stringify({ name: "Jane", email: "jane@example.test", team: "Personal", organizationId: null, balance: 12.34 })).usage.balances, [{ name: "Balance", amount: 12.34, unit: "usd" }]);
  assert.equal(kilo.parse('{"balance": 0}'), null, "a zero balance is also what a failed lookup prints");
  const status = auggie.parse(JSON.stringify({ planName: "Developer", usageUnit: "credits", amountRemaining: "15000", amountIncludedPerCycle: "20000", billingCycleEndDate: "2026-12-01T00:00:00Z" }));
  assert.equal(status.plan, "Developer");
  assert.deepEqual(status.usage.scoped, [{ name: "Plan", percent: 25, resets_at: "2026-12-01T00:00:00.000Z" }]);
  assert.deepEqual(status.usage.balances, [{ name: "Remaining", amount: 15000, unit: "credits" }]);
  assert.equal(auggie.parse("You are not currently logged in to Augment."), null);

  const calls = [];
  const run = (file, args, options, done) => { calls.push({ file, args, options }); done(null, '{"balance": 3.5, "email": "jane@example.test"}', ""); };
  const parsed = await runCliLimit(kilo, "/opt/kilo/bin/kilo", run);
  assert.deepEqual(calls.map(({ file, args }) => [file, args]), [["/opt/kilo/bin/kilo", ["profile", "--json"]]]);
  assert.ok(calls[0].options.timeout <= 10_000);
  assert.equal(JSON.stringify(parsed).includes("jane"), false, "the account name never leaves the parser");
  await assert.rejects(runCliLimit(kilo, "/opt/kilo/bin/kilo", (file, args, options, done) => done(new Error("Error: Not authenticated with Kilo Gateway"), "", "")), (error) => !String(error.message).includes("Gateway"));

  const entries = await cliLimitUsage(true, { binaries: async () => new Map([["kilo", `/opt/kilo-${Math.random()}/kilo`]]), run });
  assert.deepEqual(entries.map((entry) => [entry.provider, entry.label, entry.usage.balances]), [["kilo", "Kilo Code", [{ name: "Balance", amount: 3.5, unit: "usd" }]]]);
  assert.deepEqual(await cliLimitUsage(true, { binaries: async () => new Map(), run }), [], "nothing runs for agents that are not installed");
});

test("pricing honors dated rates and refuses cached tokens without a published cache rate", () => {
  close(bucketCost([1e6, 0, 0, 0, 0], "gemini-3.6-flash", "2026-12-31"), 0.75, "until the published change");
  close(bucketCost([1e6, 0, 0, 0, 0], "gemini-3.6-flash", "2027-01-01"), 1.5, "after it");
  close(bucketCost([0, 0, 1e6, 0, 0], "models/gemini-2.5-pro", "2026-11-10"), 0.125, "provider prefixes are ignored");
  assert.equal(bucketCost([10, 10, 5, 0, 0], "qwen3.8-max", "2026-11-10"), null);
  close(bucketCost([1e6, 1e6, 0, 0, 0], "qwen3.8-max", "2026-11-10"), 8, "uncached use is priced");
  assert.equal(bucketCost([1, 1, 0, 0, 0], "constructor", "2026-11-10"), null);
});

test("session cost and model queries accept every agent with a usage adapter", () => {
  const now = Date.parse("2026-11-10T12:00:00Z");
  for (const adapter of USAGE_ADAPTERS) {
    assert.equal(sessionCostQuery(new URLSearchParams({ provider: adapter.id, cwd: CWD, since: "1" }), now).provider, adapter.id);
  }
  assert.throws(() => sessionCostQuery(new URLSearchParams({ provider: "warp", cwd: CWD, since: "1" }), now), /sessions can be priced/);
});

test("a reported model is kept under the agent that reported it", () => {
  assert.deepEqual(normalizeEffectiveModel("anthropic/claude-sonnet-4-5", "goose"), { model: "anthropic/claude-sonnet-4-5", provider: "goose" });
  assert.deepEqual(normalizeEffectiveModel("Gemini-2.5-Pro", "gemini"), { model: "gemini-2.5-pro", provider: "gemini" });
  assert.equal(normalizeEffectiveModel("bad model", "gemini"), null);
  assert.equal(normalizeEffectiveModel("x".repeat(200), "gemini"), null);
  // Claude and Codex still classify by name, and unknown agents are not trusted.
  assert.deepEqual(normalizeEffectiveModel("gpt-5.2", "claude"), { model: "gpt-5.2", provider: "codex" });
  assert.equal(normalizeEffectiveModel("anthropic/claude-sonnet-4-5", "not-an-agent"), null);
});
