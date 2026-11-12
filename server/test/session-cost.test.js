import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, appendFile, utimes, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { Readable } from "node:stream";
import { claudeProjectSlug } from "../lib/agent-usage/claude.js";
import { SESSION_COST_BATCH_LIMITS, findSessionCost, findSessionCosts, findSessionModel, sessionCostBatchQueries, sessionCostQuery, sessionCostRouter } from "../lib/session-cost.js";

const at = (iso) => new Date(iso).getTime();
const claudeLine = (id, iso, cwd, usage, model = "claude-opus-4-7") => JSON.stringify({
  type: "assistant", timestamp: iso, cwd, sessionId: "s", requestId: `req-${id}`,
  message: { id: `msg-${id}`, model, usage },
});
const codexLines = (iso, cwd, totals, model = "gpt-5.2") => [
  JSON.stringify({ timestamp: iso, type: "session_meta", payload: { id: "c", cwd, timestamp: iso } }),
  JSON.stringify({ timestamp: iso, type: "turn_context", payload: { cwd, model } }),
  ...totals.map(([input, cached, output], index) => JSON.stringify({
    timestamp: new Date(at(iso) + (index + 1) * 60000).toISOString(), type: "event_msg",
    payload: { type: "token_count", info: { total_token_usage: { input_tokens: input, cached_input_tokens: cached, output_tokens: output } } },
  })),
].join("\n") + "\n";

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-session-cost-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

async function touch(file, iso) {
  const time = new Date(iso);
  await utimes(file, time, time);
}

test("validates provider, folder and start time before reading anything", () => {
  const now = at("2026-09-10T12:00:00Z");
  const query = (values) => sessionCostQuery(new URLSearchParams(values), now);
  assert.deepEqual(query({ provider: "claude", cwd: "/Users/dev/app/", since: String(now - 1000) }), { provider: "claude", cwd: "/Users/dev/app", since: now - 1000 });
  assert.throws(() => query({ provider: "cursor", cwd: "/a", since: "1" }), /sessions can be priced/);
  assert.throws(() => query({ provider: "claude", cwd: "relative/app", since: "1" }), /absolute/);
  assert.throws(() => query({ provider: "claude", cwd: "/Users/dev/../root", since: "1" }), /normalized/);
  assert.throws(() => query({ provider: "claude", cwd: "/Users/dev/a\u0000b", since: "1" }), /absolute/);
  assert.throws(() => query({ provider: "claude", cwd: "/" + "a".repeat(5000), since: "1" }), /absolute/);
  assert.throws(() => query({ provider: "claude", cwd: "/a", since: "-5" }), /milliseconds/);
  assert.throws(() => query({ provider: "claude", cwd: "/a", since: "1e12" }), /milliseconds/);
  assert.throws(() => query({ provider: "claude", cwd: "/a", since: String(now + 3600000) }), /future/);
  assert.equal(claudeProjectSlug("/Users/dev/my_app.v2"), "-Users-dev-my-app-v2");
});

test("prices the newest Claude session for the folder, with its subagents, and ignores older and foreign transcripts", async (t) => {
  const root = await fixture(t);
  const cwd = "/Users/dev/app";
  const dir = path.join(root, ".claude");
  const project = path.join(dir, "projects", claudeProjectSlug(cwd));
  await mkdir(path.join(project, "new-session", "subagents"), { recursive: true });
  const usage = { input_tokens: 1_000_000, output_tokens: 100_000, cache_read_input_tokens: 2_000_000, cache_creation_input_tokens: 400_000 };
  const current = path.join(project, "new-session.jsonl");
  // A retried request is logged twice and counted once.
  await writeFile(current, [
    JSON.stringify({ type: "user", timestamp: "2026-09-10T09:00:00Z", cwd, message: { role: "user", content: "hi" } }),
    claudeLine(1, "2026-09-10T09:01:00Z", cwd, usage),
    claudeLine(1, "2026-09-10T09:01:00Z", cwd, usage),
    claudeLine(2, "2026-09-10T09:31:00Z", cwd, { input_tokens: 0, output_tokens: 100_000 }),
  ].join("\n") + "\n");
  const sidechain = path.join(project, "new-session", "subagents", "agent-a.jsonl");
  await writeFile(sidechain, claudeLine(3, "2026-09-10T09:40:00Z", `${cwd}/src`, { input_tokens: 200_000, output_tokens: 0 }) + "\n");
  // Finished before the tile started: never the tile's session.
  const old = path.join(project, "old-session.jsonl");
  await writeFile(old, claudeLine(4, "2026-09-09T09:00:00Z", cwd, usage) + "\n");
  await touch(old, "2026-09-09T10:00:00Z");
  // Same slug, other folder (/Users/dev-app): rejected by its recorded cwd.
  const foreign = path.join(project, "foreign.jsonl");
  await writeFile(foreign, claudeLine(5, "2026-09-10T09:50:00Z", "/Users/dev-app", usage) + "\n");
  await touch(current, "2026-09-10T09:45:00Z");
  await touch(sidechain, "2026-09-10T09:40:00Z");
  await touch(foreign, "2026-09-10T09:59:00Z");

  const result = await findSessionCost({
    provider: "claude", cwd, since: at("2026-09-10T08:55:00Z"), now: at("2026-09-10T10:00:00Z"),
    accounts: [{ provider: "claude", dir, label: "Claude" }, { provider: "codex", dir: path.join(root, ".codex"), label: "Codex" }],
  });
  assert.equal(result.found, true);
  assert.equal(result.startedAt, at("2026-09-10T09:01:00Z"));
  assert.equal(result.lastAt, at("2026-09-10T09:40:00Z"));
  assert.equal(result.subagents, 1);
  assert.deepEqual(result.tokens, { input: 1_200_000, output: 200_000, cacheRead: 2_000_000, cacheWrite: 400_000 });
  assert.deepEqual(result.models, ["claude-opus-4-7"]);
  // Opus 4.7: $5 in, $25 out, cache read 10% of input, 5m cache write 125%.
  const expected = 1.2 * 5 + 0.2 * 25 + 2 * 0.5 + 0.4 * 6.25;
  assert.ok(Math.abs(result.cost - expected) < 1e-9, `${result.cost} != ${expected}`);
  assert.equal(JSON.stringify(result).includes(root), false, "no local paths are returned");

  // Growth is picked up on the next lookup (incremental resume).
  await appendFile(current, claudeLine(6, "2026-09-10T09:50:00Z", cwd, { input_tokens: 0, output_tokens: 40_000 }) + "\n");
  await touch(current, "2026-09-10T09:50:00Z");
  const grown = await findSessionCost({ provider: "claude", cwd, since: at("2026-09-10T08:55:00Z"), accounts: [{ provider: "claude", dir }] });
  assert.equal(grown.tokens.output, 240_000);
  assert.equal(grown.lastAt, at("2026-09-10T09:50:00Z"));

  // A tile that started after every transcript was last written finds nothing.
  assert.deepEqual(await findSessionCost({ provider: "claude", cwd, since: at("2026-09-10T11:00:00Z"), accounts: [{ provider: "claude", dir }] }), { found: false, provider: "claude" });
});

test("reads a Codex session by its recorded folder and reports unknown models without a cost", async (t) => {
  const root = await fixture(t);
  const dir = path.join(root, ".codex");
  const now = at("2026-09-10T12:00:00Z");
  const [y, m, d] = (() => { const date = new Date(now); return [date.getFullYear(), String(date.getMonth() + 1).padStart(2, "0"), String(date.getDate()).padStart(2, "0")]; })();
  const folder = path.join(dir, "sessions", String(y), m, d);
  await mkdir(folder, { recursive: true });
  const mine = path.join(folder, "rollout-mine.jsonl");
  await writeFile(mine, codexLines("2026-09-10T10:00:00Z", "/Users/dev/api", [[1_000_000, 400_000, 50_000], [2_000_000, 1_000_000, 100_000]]));
  const other = path.join(folder, "rollout-other.jsonl");
  await writeFile(other, codexLines("2026-09-10T10:30:00Z", "/Users/dev/web", [[9_000_000, 0, 9_000]]));
  await touch(mine, "2026-09-10T11:00:00Z");
  await touch(other, "2026-09-10T11:30:00Z");
  const accounts = [{ provider: "codex", dir, label: "Codex" }];

  const result = await findSessionCost({ provider: "codex", cwd: "/Users/dev/api", since: at("2026-09-10T09:00:00Z"), now, accounts });
  assert.equal(result.found, true);
  assert.equal(result.startedAt, at("2026-09-10T10:01:00Z"));
  assert.equal(result.lastAt, at("2026-09-10T10:02:00Z"));
  assert.deepEqual(result.tokens, { input: 1_000_000, output: 100_000, cacheRead: 1_000_000, cacheWrite: 0 });
  // gpt-5.2: $1.75 in, $14 out, cached input at 10%.
  assert.ok(Math.abs(result.cost - (1.75 + 1.4 + 0.175)) < 1e-9, String(result.cost));

  const unknown = path.join(folder, "rollout-unknown.jsonl");
  await writeFile(unknown, codexLines("2026-09-10T11:40:00Z", "/Users/dev/api", [[1000, 0, 10]], "gpt-unlisted-preview"));
  await touch(unknown, "2026-09-10T11:45:00Z");
  const unpriced = await findSessionCost({ provider: "codex", cwd: "/Users/dev/api", since: at("2026-09-10T09:00:00Z"), now, accounts });
  assert.equal(unpriced.cost, null);
  assert.equal(unpriced.pricedCost, 0);
  assert.deepEqual(unpriced.unpricedModels, ["gpt-unlisted-preview"]);
});

test("the route answers 400 for bad queries and remote hosts and 405 for writes", async () => {
  const calls = [];
  const json = (res, status, body) => calls.push([status, body]);
  const route = (target, method = "GET") => sessionCostRouter({ method }, {}, new URL(target, "http://127.0.0.1"), json);
  assert.equal(await route("/sessions"), false);
  assert.equal(await route("/session/cost?provider=claude&cwd=/a&since=1", "POST"), true);
  assert.equal(await route("/session/cost?provider=claude&cwd=/a&since=1&host=devbox"), true);
  assert.equal(await route("/session/cost?provider=claude&cwd=a&since=1"), true);
  assert.deepEqual(calls.map(([status]) => status), [405, 400, 400]);
});

test("the session model is the one its newest reply used", async (t) => {
  const root = await fixture(t);
  const cwd = "/Users/dev/app";
  const dir = path.join(root, ".claude");
  const project = path.join(dir, "projects", claudeProjectSlug(cwd));
  await mkdir(project, { recursive: true });
  const usage = { input_tokens: 10, output_tokens: 10 };
  const file = path.join(project, "s.jsonl");
  // The session switched models halfway; the latest reply decides.
  await writeFile(file, [
    claudeLine(1, "2026-09-10T09:01:00Z", cwd, usage, "claude-sonnet-5-5"),
    claudeLine(2, "2026-09-10T09:05:00Z", cwd, usage, "claude-opus-5-5"),
  ].join("\n") + "\n");
  await touch(file, "2026-09-10T09:06:00Z");
  const accounts = [{ provider: "claude", dir }];
  assert.equal(await findSessionModel({ provider: "claude", cwd, since: at("2026-09-10T08:00:00Z"), accounts }), "claude-opus-5-5");
  // Grows with the session: a later reply on another model takes over.
  await appendFile(file, claudeLine(3, "2026-09-10T09:10:00Z", cwd, usage, "claude-haiku-5-5") + "\n");
  await touch(file, "2026-09-10T09:11:00Z");
  assert.equal(await findSessionModel({ provider: "claude", cwd, since: at("2026-09-10T08:00:00Z"), accounts }), "claude-haiku-5-5");
  // Nothing for a folder without a transcript, or a bad folder.
  assert.equal(await findSessionModel({ provider: "claude", cwd: "/Users/dev/other", since: 0, accounts }), null);
  assert.equal(await findSessionModel({ provider: "claude", cwd: "relative", since: 0, accounts }), null);
});

test("batch queries are validated one by one and malformed batches are refused whole", () => {
  const now = at("2026-09-10T12:00:00Z");
  const good = { provider: "claude", cwd: "/Users/dev/app/", since: String(now - 1000) };
  const [first, bad, number, notObject] = sessionCostBatchQueries({ queries: [good, { ...good, cwd: "/Users/dev/../root" }, { ...good, since: now - 1000 }, "x"] }, now);
  assert.deepEqual(first, { provider: "claude", cwd: "/Users/dev/app", since: now - 1000 });
  assert.match(bad.error, /normalized/);
  // Fields are strings exactly as in the GET query; anything else is rejected.
  assert.match(number.error, /milliseconds/);
  assert.match(notObject.error, /object/);
  assert.throws(() => sessionCostBatchQueries([good], now), /JSON object/);
  assert.throws(() => sessionCostBatchQueries({ queries: [] }, now), /between 1 and 64/);
  assert.throws(() => sessionCostBatchQueries({ queries: Array(SESSION_COST_BATCH_LIMITS.queries + 1).fill(good) }, now), /between 1 and 64/);
  assert.throws(() => sessionCostBatchQueries({ host: "devbox", queries: [good] }, now), /this device/);
});

test("a batch answers in order, looks identical sessions up once and isolates failures", async () => {
  const calls = [];
  const find = async (query) => {
    calls.push(query);
    if (query.cwd === "/broken") throw new Error("disk error with /private/path");
    return { found: true, provider: query.provider, cost: query.since };
  };
  const query = (cwd, since = 5) => ({ provider: "claude", cwd, since });
  const results = await findSessionCosts([query("/a"), query("/a"), { error: "bad" }, query("/broken"), query("/a", 6)], { accounts: [], find });
  assert.deepEqual(results.map((result) => result.cost ?? result.error), [5, 5, "bad", "Session cost is unavailable on this device", 6]);
  assert.deepEqual(calls.map((call) => `${call.cwd}@${call.since}`), ["/a@5", "/broken@5", "/a@6"]);
  assert.equal(JSON.stringify(results).includes("/private/path"), false, "lookup errors never leak details");
});

test("the batch route matches single lookups and refuses wrong methods and oversized bodies", async (t) => {
  const root = await fixture(t);
  const cwd = "/Users/dev/app";
  const project = path.join(root, ".claude", "projects", claudeProjectSlug(cwd));
  await mkdir(project, { recursive: true });
  await writeFile(path.join(project, "s.jsonl"), claudeLine(1, new Date().toISOString(), cwd, { input_tokens: 1000, output_tokens: 10 }) + "\n");
  const home = process.env.HOME;
  process.env.HOME = root;
  t.after(() => { process.env.HOME = home; });
  const since = Date.now() - 60000;
  const calls = [];
  const json = (res, status, body) => calls.push([status, body]);
  const route = (method, body, headers = {}) => {
    const req = Readable.from(body === undefined ? [] : [Buffer.from(typeof body === "string" ? body : JSON.stringify(body))]);
    Object.assign(req, { method, headers });
    return sessionCostRouter(req, {}, new URL("/session/cost/batch", "http://127.0.0.1"), json);
  };
  const query = { provider: "claude", cwd, since: String(since) };
  assert.equal(await route("POST", { queries: [query, query, { ...query, cwd: "relative" }] }), true);
  const [status, body] = calls.at(-1);
  assert.equal(status, 200);
  const single = await findSessionCost({ provider: "claude", cwd, since });
  assert.equal(single.found, true);
  assert.deepEqual(body.results[0], single);
  assert.deepEqual(body.results[1], single);
  assert.match(body.results[2].error, /absolute/);
  await route("GET");
  await route("POST", "x".repeat(SESSION_COST_BATCH_LIMITS.bodyBytes + 1));
  await route("POST", "{}", { "content-length": String(SESSION_COST_BATCH_LIMITS.bodyBytes + 1) });
  await route("POST", "not json");
  assert.deepEqual(calls.slice(1).map(([code]) => code), [405, 413, 413, 400]);
});
