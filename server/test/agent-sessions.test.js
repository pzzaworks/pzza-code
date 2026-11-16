import assert from "node:assert/strict";
import { appendFile, copyFile, mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { DatabaseSync } from "node:sqlite";
import { claudeProjectSlug } from "../lib/agent-usage/claude.js";
import { HEAD_BYTES, TAIL_BYTES, TITLE_MAX_LENGTH, createAgentSessionsScanner, readEnds, sessionTitle } from "../lib/agent-sessions-scan.js";
import { agentSessionsEndpoint, checkedAgentSessionsResponse, parseAgentSessionsQuery, validAgentSessionsEndpoint } from "../lib/agent-sessions-query.js";
import { createAgentSessionsRouter, createRemoteAgentSessions, listAgentSessions } from "../lib/agent-sessions.js";

const FIXTURES = fileURLToPath(new URL("./fixtures/agent-sessions/", import.meta.url));
const CLAUDE_LOGIN = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a41";
const CLAUDE_DARK = "5e6f7a8b-9c0d-4e1f-a2b3-c4d5e6f7a8b9";
const CODEX_BILLING = "7d1e2f30-4a5b-4c6d-8e7f-90a1b2c3d4e5";
const OPENCODE_DOCS = "ses_0123456789abCDEFGHIJKLMNop";
const at = (iso) => new Date(iso).getTime();
const ENV = ["HOME", "XDG_DATA_HOME", "XDG_CONFIG_HOME", "OPENCODE_DB", "KILO_DB", "GOOSE_PATH_ROOT", "CRUSH_GLOBAL_DATA", "PI_CODING_AGENT_DIR",
  "PI_CODING_AGENT_SESSION_DIR", "GEMINI_CLI_HOME", "QWEN_RUNTIME_DIR", "QWEN_HOME", "KIMI_CODE_HOME", "GROK_HOME"];

// A temporary home with nothing but what a test writes into it.
async function home(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-agent-sessions-"));
  const saved = Object.fromEntries(ENV.map((name) => [name, process.env[name]]));
  for (const name of ENV) delete process.env[name];
  process.env.HOME = root;
  t.after(async () => {
    for (const [name, value] of Object.entries(saved)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
    await rm(root, { recursive: true, force: true });
  });
  return root;
}

async function touch(file, iso) {
  await utimes(file, new Date(iso), new Date(iso));
}

const claudeDir = (root, cwd, account = ".claude") => path.join(root, account, "projects", claudeProjectSlug(cwd));

async function claudeFixture(root, id, cwd, iso, account) {
  const dir = claudeDir(root, cwd, account);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await copyFile(path.join(FIXTURES, "claude", `${id}.jsonl`), file);
  await touch(file, iso);
  return file;
}

const claudeLine = (id, iso, cwd, content, extra = {}) => JSON.stringify({ type: "user", message: { role: "user", content }, timestamp: iso, cwd, sessionId: id, ...extra });

async function claudeTranscript(root, id, cwd, lines, iso, account) {
  const dir = claudeDir(root, cwd, account);
  await mkdir(dir, { recursive: true });
  const file = path.join(dir, `${id}.jsonl`);
  await writeFile(file, `${lines.join("\n")}\n`);
  await touch(file, iso);
  return file;
}

function opencodeDatabase(root, rows) {
  const dir = path.join(root, ".local", "share", "opencode");
  return mkdir(dir, { recursive: true }).then(() => {
    const db = new DatabaseSync(path.join(dir, "opencode.db"));
    db.exec(`CREATE TABLE session (id TEXT PRIMARY KEY, parent_id TEXT, directory TEXT, title TEXT, time_created INTEGER, time_updated INTEGER)`);
    const insert = db.prepare("INSERT INTO session VALUES (?, ?, ?, ?, ?, ?)");
    for (const row of rows) insert.run(row.id, row.parent ?? null, row.directory, row.title, row.created, row.updated);
    db.close();
  });
}

// Claude (two folders, one account), Codex and OpenCode, plus noise each
// reader must skip.
async function seed(root) {
  await claudeFixture(root, CLAUDE_LOGIN, "/Users/dev/app", "2026-11-10T09:20:00Z");
  await claudeFixture(root, CLAUDE_DARK, "/Users/dev/app/web", "2026-11-11T14:30:00Z");
  await mkdir(path.join(root, ".codex", "sessions", "2026", "11", "12"), { recursive: true });
  await writeFile(path.join(root, ".codex", "auth.json"), "{}");
  const rollout = path.join(root, ".codex", "sessions", "2026", "11", "12", `rollout-2026-11-12T08-00-00-${CODEX_BILLING}.jsonl`);
  await copyFile(path.join(FIXTURES, "codex", path.basename(rollout)), rollout);
  await touch(rollout, "2026-11-12T08:45:00Z");
  await opencodeDatabase(root, [
    { id: OPENCODE_DOCS, directory: "/Users/dev/docs", title: "Rewrite the install guide", created: at("2026-11-13T10:00:00Z"), updated: at("2026-11-13T11:00:00Z") },
    { id: "ses_ffffffffffffchildCHILDchil", parent: OPENCODE_DOCS, directory: "/Users/dev/docs", title: "Subagent", created: at("2026-11-13T10:30:00Z"), updated: at("2026-11-13T12:00:00Z") },
  ]);
  // A subagent transcript and a sidechain file are never conversations of their own.
  const subagents = path.join(claudeDir(root, "/Users/dev/app"), CLAUDE_LOGIN, "subagents");
  await mkdir(subagents, { recursive: true });
  await writeFile(path.join(subagents, "agent-1.jsonl"), `${claudeLine("x", "2026-11-14T00:00:00Z", "/Users/dev/app", "subagent task")}\n`);
  await claudeTranscript(root, "11111111-2222-4333-8444-555555555555", "/Users/dev/app", [
    claudeLine("s", "2026-11-14T00:00:00Z", "/Users/dev/app", "sidechain task", { isSidechain: true }),
  ], "2026-11-14T00:00:00Z");
}

test("lists Claude, Codex and OpenCode conversations newest first with their facts", async (t) => {
  const root = await home(t);
  await seed(root);
  const scanner = createAgentSessionsScanner();
  const result = await scanner.list(parseAgentSessionsQuery({}));
  assert.equal(result.partial, false);
  assert.deepEqual(result.sessions.map((row) => row.id), [OPENCODE_DOCS, CODEX_BILLING, CLAUDE_DARK, CLAUDE_LOGIN]);
  assert.equal(result.total, 4);
  assert.deepEqual(result.agents, { opencode: 1, codex: 1, claude: 2 });
  const [opencode, codex, dark, login] = result.sessions;
  assert.deepEqual(login, {
    agent: "claude", id: CLAUDE_LOGIN, cwd: "/Users/dev/app", title: "Fix login redirect",
    startedAt: at("2026-11-10T09:00:00Z"), lastAt: at("2026-11-10T09:20:00Z"), branch: "feature/login", bytes: login.bytes, resume: "id",
  });
  assert.ok(login.bytes > 0);
  // Command wrappers and injected meta turns are skipped; the prompt is folded to one line.
  assert.equal(dark.title, "Add a dark mode toggle to the settings page");
  assert.equal(dark.branch, "main");
  assert.deepEqual({ ...codex, bytes: undefined }, {
    agent: "codex", id: CODEX_BILLING, cwd: "/Users/dev/api", title: "Write tests for the billing API",
    startedAt: at("2026-11-12T08:00:00Z"), lastAt: at("2026-11-12T08:45:00Z"), branch: "billing-tests", bytes: undefined, resume: "id",
  });
  assert.deepEqual(opencode, {
    agent: "opencode", id: OPENCODE_DOCS, cwd: "/Users/dev/docs", title: "Rewrite the install guide",
    startedAt: at("2026-11-13T10:00:00Z"), lastAt: at("2026-11-13T11:00:00Z"), resume: "id",
  });
  // Nothing but row fields leaves the scan: no paths, no message bodies.
  const text = JSON.stringify(result);
  assert.ok(!text.includes(root) && !text.includes("Looking at the router") && !text.includes("sidechain task") && !text.includes("subagent task"));
});

test("filters by agent, folder, time and text, pages, and counts agents without the agent filter", async (t) => {
  const root = await home(t);
  await seed(root);
  const scanner = createAgentSessionsScanner();
  const list = (query) => scanner.list(parseAgentSessionsQuery(query));
  const ids = (result) => result.sessions.map((row) => row.id);

  const claude = await list({ agent: "claude" });
  assert.deepEqual(ids(claude), [CLAUDE_DARK, CLAUDE_LOGIN]);
  assert.equal(claude.total, 2);
  assert.deepEqual(claude.agents, { opencode: 1, codex: 1, claude: 2 });

  assert.deepEqual(ids(await list({ cwd: "/Users/dev/app" })), [CLAUDE_LOGIN]);
  assert.deepEqual(ids(await list({ cwd: "/Users/dev/app/", under: true })), [CLAUDE_DARK, CLAUDE_LOGIN]);
  // A folder that only shares a name prefix is not under it.
  assert.deepEqual(ids(await list({ cwd: "/Users/dev/ap", under: true })), []);
  assert.deepEqual(ids(await list({ since: at("2026-11-12T00:00:00Z") })), [OPENCODE_DOCS, CODEX_BILLING]);

  assert.deepEqual(ids(await list({ q: "LOGIN" })), [CLAUDE_LOGIN]);
  assert.deepEqual(ids(await list({ q: "billing-tests" })), [CODEX_BILLING]);
  assert.deepEqual(ids(await list({ q: "/users/dev/docs" })), [OPENCODE_DOCS]);
  assert.deepEqual(ids(await list({ q: "5e6f7a8b" })), [CLAUDE_DARK]);
  // An id matches by prefix only.
  assert.deepEqual(ids(await list({ q: "9c8d7e6f5a41" })), []);

  const page = await list({ limit: 2, offset: 1 });
  assert.deepEqual(ids(page), [CODEX_BILLING, CLAUDE_DARK]);
  assert.equal(page.total, 4);
  const filtered = await list({ agent: "codex", q: "a" });
  assert.equal(filtered.total, 1);
  assert.deepEqual(filtered.agents, { opencode: 1, codex: 1, claude: 2 });
});

test("reads the other agents' stores in their own layouts and skips their subagents", async (t) => {
  const root = await home(t);
  const write = async (file, value, iso) => {
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, Array.isArray(value) ? `${value.map((item) => JSON.stringify(item)).join("\n")}\n` : JSON.stringify(value, null, 2));
    if (iso) await touch(file, iso);
  };
  const UUID = (n) => `${String(n).repeat(8)}-${String(n).repeat(4)}-4${String(n).repeat(3)}-8${String(n).repeat(3)}-${String(n).repeat(12)}`;
  // Codex: a thread name from the index wins over the prompt; a subagent's rollout is skipped.
  const day = path.join(root, ".codex", "sessions", "2026", "11", "14");
  await write(path.join(root, ".codex", "auth.json"), {});
  await write(path.join(day, `rollout-2026-11-14T08-00-00-${UUID(1)}.jsonl`), [
    { timestamp: "2026-11-14T08:00:00Z", type: "session_meta", payload: { id: UUID(1), cwd: "/Users/dev/api", timestamp: "2026-11-14T08:00:00Z", source: "cli" } },
    { timestamp: "2026-11-14T08:00:01Z", type: "event_msg", payload: { type: "user_message", message: "Speed up the build" } },
  ], "2026-11-14T08:10:00Z");
  await write(path.join(day, `rollout-2026-11-14T08-05-00-${UUID(2)}.jsonl`), [
    { timestamp: "2026-11-14T08:05:00Z", type: "session_meta", payload: { id: UUID(2), cwd: "/Users/dev/api", source: { subagent: "review" } } },
    { timestamp: "2026-11-14T08:05:01Z", type: "event_msg", payload: { type: "user_message", message: "review" } },
  ], "2026-11-14T08:06:00Z");
  await write(path.join(root, ".codex", "session_index.jsonl"), [{ id: UUID(1), thread_name: "Old name" }, { id: UUID(1), thread_name: "Faster builds" }]);
  // Gemini: the folder from projects.json, the summary from a $set record; subagent sessions skipped.
  await write(path.join(root, ".gemini", "projects.json"), { projects: { "/Users/dev/site": "site" } });
  await write(path.join(root, ".gemini", "tmp", "site", "chats", "session-2026-11-14T09-00-abcd1234.jsonl"), [
    { sessionId: UUID(3), projectHash: "h", startTime: "2026-11-14T09:00:00Z", lastUpdated: "2026-11-14T09:00:00Z" },
    { id: "m1", timestamp: "2026-11-14T09:00:05Z", type: "user", content: [{ text: "Make the hero image responsive" }] },
    { $set: { summary: "Responsive hero image", lastUpdated: "2026-11-14T09:30:00Z" } },
  ], "2026-11-14T09:30:00Z");
  await write(path.join(root, ".gemini", "tmp", "site", "chats", "session-2026-11-14T09-10-ffff0000.jsonl"), [
    { sessionId: UUID(4), projectHash: "h", startTime: "2026-11-14T09:10:00Z", kind: "subagent" },
  ], "2026-11-14T09:40:00Z");
  // Qwen: the last custom title; Pi: the session_info name.
  await write(path.join(root, ".qwen", "projects", "-Users-dev-cli", "chats", `${UUID(5)}.jsonl`), [
    { sessionId: UUID(5), cwd: "/Users/dev/cli", gitBranch: "dev", timestamp: "2026-11-14T10:00:00Z", type: "user", message: { role: "user", parts: [{ text: "Add a --json flag" }] } },
    { sessionId: UUID(5), timestamp: "2026-11-14T10:20:00Z", type: "system", subtype: "custom_title", systemPayload: { customTitle: "JSON output" } },
  ], "2026-11-14T10:20:00Z");
  await write(path.join(root, ".pi", "agent", "sessions", "--Users-dev-lib--", `2026-11-14T11-00-00-000Z_${UUID(6)}.jsonl`), [
    { type: "session", version: 3, id: UUID(6), timestamp: "2026-11-14T11:00:00Z", cwd: "/Users/dev/lib" },
    { type: "message", timestamp: "2026-11-14T11:00:05Z", message: { role: "user", content: "Bump the parser" } },
  ], "2026-11-14T11:05:00Z");
  // Kimi Code and Grok Build keep a small metadata file per session.
  await write(path.join(root, ".kimi-code", "sessions", "wd_tool_123456789abc", "kimi-1", "state.json"),
    { id: "kimi-1", title: "Fix the flaky test", cwd: "/Users/dev/tool", createdAt: at("2026-11-14T12:00:00Z"), updatedAt: at("2026-11-14T12:30:00Z"), archived: false }, "2026-11-14T12:30:00Z");
  await write(path.join(root, ".kimi-code", "sessions", "wd_tool_123456789abc", "kimi-2", "state.json"),
    { id: "kimi-2", title: "Archived", cwd: "/Users/dev/tool", createdAt: 1, updatedAt: at("2026-11-14T12:40:00Z"), archived: true }, "2026-11-14T12:40:00Z");
  await write(path.join(root, ".grok", "sessions", "%2FUsers%2Fdev%2Fgame", "grok-1", "summary.json"),
    { info: { id: "grok-1", cwd: "/Users/dev/game" }, generated_title: "Add a pause menu", session_summary: "", num_messages: 12, head_branch: "pause", session_kind: "main", created_at: "2026-11-14T13:00:00Z", updated_at: "2026-11-14T13:30:00Z" }, "2026-11-14T13:30:00Z");
  await write(path.join(root, ".grok", "sessions", "%2FUsers%2Fdev%2Fgame", "grok-2", "summary.json"),
    { info: { id: "grok-2", cwd: "/Users/dev/game" }, generated_title: "Sub", session_kind: "subagent", created_at: "2026-11-14T13:00:00Z", updated_at: "2026-11-14T13:40:00Z" }, "2026-11-14T13:40:00Z");
  // goose and Cline: SQLite with their own columns.
  await mkdir(path.join(root, ".local", "share", "goose", "sessions"), { recursive: true });
  const goose = new DatabaseSync(path.join(root, ".local", "share", "goose", "sessions", "sessions.db"));
  goose.exec("CREATE TABLE sessions (id TEXT, name TEXT, description TEXT, working_dir TEXT, session_type TEXT, created_at TEXT, updated_at TEXT, archived_at TEXT)");
  goose.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("20261114_1", "Tidy the docs", "", "/Users/dev/docs", "user", "2026-11-14 14:00:00", "2026-11-14 14:30:00", null);
  goose.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("20261114_2", "Sub", "", "/Users/dev/docs", "sub_agent", "2026-11-14 14:00:00", "2026-11-14 14:40:00", null);
  goose.close();
  await mkdir(path.join(root, ".cline", "data", "db"), { recursive: true });
  const cline = new DatabaseSync(path.join(root, ".cline", "data", "db", "sessions.db"));
  cline.exec("CREATE TABLE sessions (session_id TEXT, cwd TEXT, prompt TEXT, metadata_json TEXT, started_at TEXT, updated_at TEXT, is_subagent INTEGER, parent_session_id TEXT)");
  cline.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("1794700000000_ab12c", "/Users/dev/app", "Port the form to hooks", JSON.stringify({ git: { branch: "hooks" } }), "2026-11-14T15:00:00Z", "2026-11-14T15:30:00Z", 0, null);
  cline.prepare("INSERT INTO sessions VALUES (?, ?, ?, ?, ?, ?, ?, ?)").run("1794700000001_zz99z", "/Users/dev/app", "sub task", null, "2026-11-14T15:00:00Z", "2026-11-14T15:40:00Z", 1, "1794700000000_ab12c");
  cline.close();

  const result = await createAgentSessionsScanner().list(parseAgentSessionsQuery({}));
  assert.deepEqual(result.sessions.map((row) => [row.agent, row.id, row.cwd, row.title, row.branch, row.resume]), [
    ["cline", "1794700000000_ab12c", "/Users/dev/app", "Port the form to hooks", "hooks", "id"],
    ["goose", "20261114_1", "/Users/dev/docs", "Tidy the docs", undefined, "id"],
    ["grok", "grok-1", "/Users/dev/game", "Add a pause menu", "pause", "last"],
    ["kimi", "kimi-1", "/Users/dev/tool", "Fix the flaky test", undefined, "last"],
    ["pi", UUID(6), "/Users/dev/lib", "Bump the parser", undefined, "id"],
    ["qwen", UUID(5), "/Users/dev/cli", "JSON output", "dev", "id"],
    ["gemini", UUID(3), "/Users/dev/site", "Responsive hero image", undefined, "id"],
    ["codex", UUID(1), "/Users/dev/api", "Faster builds", undefined, "id"],
  ]);
  assert.equal(result.sessions.find((row) => row.agent === "grok").messages, 12);
  assert.equal(result.sessions.find((row) => row.agent === "gemini").lastAt, at("2026-11-14T09:30:00Z"));
});

test("titles are one redacted line of at most 160 characters", async (t) => {
  assert.equal(sessionTitle("deploy with\napi_key = sk-live-abcdef\nthen check"), "deploy with [REDACTED] then check");
  assert.equal(sessionTitle("use Bearer abc.def.ghi please"), "use [REDACTED] please");
  const long = sessionTitle(`${"word ".repeat(100)}end`);
  assert.equal(Array.from(long).length, TITLE_MAX_LENGTH);
  assert.ok(long.endsWith("…"));
  assert.equal(sessionTitle("\u0000\t  "), "");

  const root = await home(t);
  await claudeTranscript(root, "22222222-3333-4444-8555-666666666666", "/Users/dev/app", [
    claudeLine("p", "2026-11-10T09:00:00Z", "/Users/dev/app", `connect with password: hunter2-${"x".repeat(10)}\nand ${"then ".repeat(80)}`),
  ], "2026-11-10T09:00:00Z");
  const [row] = (await createAgentSessionsScanner().list(parseAgentSessionsQuery({}))).sessions;
  assert.ok(row.title.startsWith("[REDACTED] and then"));
  assert.ok(!row.title.includes("hunter2"));
  assert.ok(Array.from(row.title).length <= TITLE_MAX_LENGTH);
});

test("reads only the two ends of a large transcript, and a file once until it changes", async (t) => {
  const root = await home(t);
  const id = "33333333-4444-4555-8666-777777777777";
  const cwd = "/Users/dev/big";
  const middle = Array.from({ length: 4000 }, (_, index) => JSON.stringify({ type: "assistant", timestamp: "2026-11-10T10:00:00Z", cwd, filler: "y".repeat(1000), index }));
  // A title in the middle would only be seen by a full read.
  middle.splice(2000, 0, JSON.stringify({ type: "custom-title", customTitle: "Only in the middle" }));
  const file = await claudeTranscript(root, id, cwd, [
    claudeLine(id, "2026-11-10T09:00:00Z", cwd, "Profile the importer", { gitBranch: "perf" }),
    ...middle,
    JSON.stringify({ type: "assistant", timestamp: "2026-11-10T18:00:00Z", cwd, gitBranch: "perf-2" }),
  ], "2026-11-10T18:00:00Z");
  const ends = await readEnds(file, (await import("node:fs")).statSync(file).size);
  assert.ok(ends.head.length < 80 && ends.tail.length < 40);
  assert.ok(!JSON.stringify(ends).includes("Only in the middle"));
  assert.ok(HEAD_BYTES + TAIL_BYTES < 4_000_000);

  const scanner = createAgentSessionsScanner();
  const first = await scanner.list(parseAgentSessionsQuery({}));
  assert.equal(first.sessions[0].title, "Profile the importer");
  assert.equal(first.sessions[0].branch, "perf-2");
  assert.equal(first.sessions[0].lastAt, at("2026-11-10T18:00:00Z"));
  assert.equal(scanner.stats.reads, 1);
  // A fresh rescan of an unchanged file reads nothing but its stat.
  await scanner.list(parseAgentSessionsQuery({ fresh: true }));
  assert.equal(scanner.stats.reads, 1);
  await appendFile(file, `${JSON.stringify({ type: "custom-title", customTitle: "Importer profiling" })}\n`);
  await touch(file, "2026-11-10T19:00:00Z");
  const changed = await scanner.list(parseAgentSessionsQuery({ fresh: true }));
  assert.equal(scanner.stats.reads, 2);
  assert.equal(changed.sessions[0].title, "Importer profiling");
});

test("hides conversations started in the home folder unless it is asked for, and marks folder-newest resumes", async (t) => {
  const root = await home(t);
  await claudeTranscript(root, "44444444-5555-4666-8777-888888888888", root, [claudeLine("h", "2026-11-10T09:00:00Z", root, "quick question")], "2026-11-10T09:00:00Z");
  await claudeTranscript(root, "55555555-6666-4777-8888-999999999999", "/Users/dev/app", [claudeLine("a", "2026-11-10T08:00:00Z", "/Users/dev/app", "older work")], "2026-11-10T08:00:00Z", ".claude-work");
  const scanner = createAgentSessionsScanner();
  const all = await scanner.list(parseAgentSessionsQuery({}));
  assert.deepEqual(all.sessions.map((row) => row.title), ["older work"]);
  assert.equal(all.sessions[0].account, path.join(root, ".claude-work"));
  const inHome = await scanner.list(parseAgentSessionsQuery({ cwd: root }));
  assert.deepEqual(inHome.sessions.map((row) => row.title), ["quick question"]);
  assert.equal(inHome.sessions[0].account, undefined);

  // Without a by-id form, only a folder's newest conversation can be continued.
  const rows = [];
  const source = (agent, id, cwd, lastAt) => ({ agent, roots: () => [{ dir: "/x" }], rows: async () => [{ id, cwd, lastAt, prompt: id }] });
  for (const item of [source("droid", "older", "/Users/dev/app", 1000), source("droid", "newest", "/Users/dev/app", 2000), source("amp", "remote", "/Users/dev/app", 3000)]) rows.push(item);
  const mixed = createAgentSessionsScanner({ sources: rows });
  const result = await mixed.list(parseAgentSessionsQuery({}));
  assert.deepEqual(result.sessions.map((row) => [row.id, row.resume]), [["remote", "none"], ["newest", "last"], ["older", "none"]]);
});

test("a cold scan past its budget answers with what it has and keeps warming", async () => {
  let release;
  const gate = new Promise((resolve) => { release = resolve; });
  const fast = { agent: "goose", roots: () => [{ dir: "/x" }], rows: async () => [{ id: "20261110_1", cwd: "/Users/dev/a", lastAt: 2000, title: "fast" }] };
  const slow = { agent: "crush", roots: () => [{ dir: "/y" }], rows: async () => { await gate; return [{ id: "slow", cwd: "/Users/dev/b", lastAt: 1000, title: "slow" }]; } };
  const scanner = createAgentSessionsScanner({ sources: [fast, slow], budgetMs: 20 });
  const partial = await scanner.list(parseAgentSessionsQuery({}));
  assert.equal(partial.partial, true);
  assert.deepEqual(partial.sessions.map((row) => row.title), ["fast"]);
  release();
  await new Promise((resolve) => setTimeout(resolve, 10));
  const complete = await scanner.list(parseAgentSessionsQuery({}));
  assert.equal(complete.partial, false);
  assert.deepEqual(complete.sessions.map((row) => row.title), ["fast", "slow"]);
});

test("rejects invalid queries with readable messages", () => {
  const bad = [
    [{ agent: "vim" }, /catalog/], [{ cwd: "relative/app" }, /absolute/], [{ cwd: "/Users/dev/../root" }, /normalized/],
    [{ cwd: "/a\u0000b" }, /absolute/], [{ cwd: `/${"a".repeat(5000)}` }, /absolute/], [{ under: true }, /needs a cwd/],
    [{ under: "yes", cwd: "/a" }, /1 or 0/], [{ since: -5 }, /whole number/], [{ since: "1e12" }, /whole number/],
    [{ q: "x".repeat(201) }, /200/], [{ q: "a\nb" }, /one line/], [{ limit: 0 }, /1 to 300/], [{ limit: 301 }, /1 to 300/],
    [{ offset: 100_001 }, /0 to/], [{ fresh: "true" }, /1 or 0/], [{ limit: { toString: () => "5" } }, /whole number/],
  ];
  for (const [query, message] of bad) assert.throws(() => parseAgentSessionsQuery(query), message, JSON.stringify(query));
  assert.deepEqual(parseAgentSessionsQuery(new URLSearchParams("cwd=/Users/dev/app/&under=1&since=5&q=+fix+&limit=10&offset=2&fresh=1&agent=codex")), {
    agent: "codex", cwd: "/Users/dev/app", under: true, since: 5, q: "fix", limit: 10, offset: 2, fresh: true,
  });
  assert.deepEqual(parseAgentSessionsQuery({}), { under: false, limit: 150, offset: 0, fresh: false });
});

test("the route answers 400 for bad parameters and forwards only validated fields to another device", async () => {
  const replies = [];
  const json = (_res, status, body) => replies.push({ status, body });
  const asked = [];
  const router = createAgentSessionsRouter({
    list: async (query) => ({ sessions: [], total: 0, agents: {}, partial: false, query }),
    remote: createRemoteAgentSessions({ request: async (host, endpoint) => { asked.push([host, endpoint]); return { sessions: [], total: 0, agents: { claude: 2, bogus: 1 }, partial: false }; } }),
  });
  const get = (target, method = "GET") => router({ method }, {}, new URL(target, "http://127.0.0.1"), json);
  assert.equal(await get("/other"), false);
  await get("/agent-sessions?limit=999");
  await get("/agent-sessions?cwd=relative");
  await get("/agent-sessions?host=-oProxyCommand=x");
  await get("/agent-sessions", "POST");
  assert.deepEqual(replies.map((reply) => reply.status), [400, 400, 400, 405]);
  replies.length = 0;
  await get("/agent-sessions?agent=claude&q=fix+login&token=secret&extra=1");
  assert.equal(replies[0].status, 200);
  assert.deepEqual(replies[0].body.query, { agent: "claude", q: "fix login", under: false, limit: 150, offset: 0, fresh: false });
  await get("/agent-sessions?host=devbox&cwd=/srv/app&under=1&q=x%26host%3Devil&fresh=1");
  assert.deepEqual(asked, [["devbox", "/agent-sessions?cwd=%2Fsrv%2Fapp&under=1&q=x%26host%3Devil&fresh=1"]]);
  assert.deepEqual(replies[1], { status: 200, body: { sessions: [], total: 0, agents: { claude: 2 }, partial: false } });
});

test("remote endpoints are canonical, and remote answers are checked before they are passed on", async () => {
  assert.equal(agentSessionsEndpoint(parseAgentSessionsQuery({})), "/agent-sessions");
  for (const endpoint of ["/agent-sessions", "/agent-sessions?agent=claude&limit=20", "/agent-sessions?cwd=%2Fsrv&under=1&since=5&q=a+b&offset=3&fresh=1"]) {
    assert.ok(validAgentSessionsEndpoint(endpoint), endpoint);
  }
  for (const endpoint of ["/agent-sessions?host=devbox", "/agent-sessions?limit=20&agent=claude", "/agent-sessions?limit=150", "/agent-sessions?agent=vim",
    "/agent-sessions/../file/read", "/agent-sessions?cwd=relative", "/agent-sessions?q=a#b", "/agent-sessionsx", "/usage?x=1"]) {
    assert.equal(validAgentSessionsEndpoint(endpoint), false, endpoint);
  }
  const row = { agent: "claude", id: CLAUDE_LOGIN, cwd: "/srv/app", title: "Fix it", startedAt: 1, lastAt: 2, resume: "id", path: "/secret", account: "/Users/dev/.claude-work" };
  const checked = checkedAgentSessionsResponse({ sessions: [row, { ...row, agent: "vim" }, { ...row, id: "$(id)" }, { ...row, title: "a\u0007" }], total: 4, agents: { claude: 4 }, partial: false });
  assert.deepEqual(checked.sessions, [{ agent: "claude", id: CLAUDE_LOGIN, cwd: "/srv/app", title: "Fix it", startedAt: 1, lastAt: 2, account: "/Users/dev/.claude-work", resume: "id" }]);
  for (const value of [null, [], { sessions: {}, total: 0, agents: {}, partial: false }, { sessions: [], total: -1, agents: {}, partial: false }, { sessions: [], total: 0, agents: {}, partial: "no" }]) {
    assert.throws(() => checkedAgentSessionsResponse(value), /Invalid/);
  }
  let calls = 0;
  const remote = createRemoteAgentSessions({ request: async () => { calls++; return { sessions: [], total: 0, agents: {}, partial: false }; } });
  const query = parseAgentSessionsQuery({ agent: "codex" });
  await Promise.all([remote("devbox", query), remote("devbox", query)]);
  await remote("devbox", query);
  assert.equal(calls, 1);
  await remote("devbox", { ...query, fresh: true });
  assert.equal(calls, 2);
  await assert.rejects(remote("-x", query), /Invalid device host/);
});

test("listAgentSessions validates its query and answers from the worker", async (t) => {
  const root = await home(t);
  await assert.rejects(listAgentSessions({ limit: 0 }), /1 to 300/);
  const result = await listAgentSessions({ cwd: root });
  assert.deepEqual(result, { sessions: [], total: 0, agents: {}, partial: false });
});

test("remote rows keep only an account folder the agent could be started with", () => {
  const row = { agent: "claude", id: "11111111-2222-4333-8444-555555555555", cwd: "/srv/app", title: "Fix it", startedAt: 1, lastAt: 2, resume: "id" };
  const accounts = (account) => checkedAgentSessionsResponse({ sessions: [{ ...row, account }], total: 1, agents: { claude: 1 }, partial: false }).sessions[0].account;
  assert.equal(accounts("/Users/dev/.claude-work"), "/Users/dev/.claude-work");
  for (const bad of [".claude-work", "/Users/dev/.codex-work", "/Users/dev/../.claude-work", "/Users/dev/.claude-work;rm", "relative/.claude-work"]) assert.equal(accounts(bad), undefined, bad);
});
