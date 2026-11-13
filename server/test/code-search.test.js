import assert from "node:assert/strict";
import { execFile, spawn, spawnSync } from "node:child_process";
import { createServer } from "node:http";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

// A private home, so the credential stores the guards protect can be planted
// without touching the real ones. os.homedir() reads HOME on every call.
const home = await realpath(await mkdtemp(path.join(tmpdir(), "pzza-code-search-home-")));
process.env.HOME = home;
process.env.XDG_CONFIG_HOME = path.join(home, ".config");
const {
  CODE_SEARCH_LIMITS, clipLine, codeSearchRouter, compileQuery, listFilesLocal, listFilesRemote, matchRanges,
  parseGitGrepRecord, parseGrepRecord, parseRgRecord, remoteListScript, remoteSearchScript, searchLocal, searchRemote, validateSearchRequest,
} = await import("../lib/code-search.js");
const { json } = await import("../lib/http.js");
const { shQuote } = await import("../lib/shell.js");

const run = promisify(execFile);
const NO_RG = "pzza-missing-ripgrep";
const HAS_RG = spawnSync("rg", ["--version"]).status === 0;

const server = createServer((req, res) => {
  codeSearchRouter(req, res, new URL(req.url, "http://localhost"), json).then((handled) => {
    if (!handled) res.writeHead(404).end();
  }).catch(() => res.writeHead(500).end());
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const endpoint = `http://127.0.0.1:${server.address().port}`;
test.after(async () => {
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
  await rm(home, { recursive: true, force: true });
});

async function project(t, name = "project") {
  const root = await mkdtemp(path.join(home, `${name}-`));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}
async function put(root, rel, content) {
  await mkdir(path.dirname(path.join(root, rel)), { recursive: true });
  await writeFile(path.join(root, rel), content);
}
async function gitRepo(root) {
  await run("git", ["init", "-q"], { cwd: root });
  await run("git", ["-c", "user.email=t@example.com", "-c", "user.name=t", "add", "-A"], { cwd: root });
}
async function getJson(url) {
  const response = await fetch(url);
  return { status: response.status, body: await response.json() };
}
async function postJson(url, body) {
  const response = await fetch(url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
  return { status: response.status, body: await response.json() };
}

test("a repository lists tracked and untracked files, minus ignored ones and node_modules", async (t) => {
  const root = await project(t);
  await put(root, ".gitignore", "ignored/\n*.log\n");
  await put(root, "src/app.ts", "export const app = 1;\n");
  await put(root, "README.md", "# Readme\n");
  await put(root, "ignored/secret.txt", "x\n");
  await put(root, "debug.log", "x\n");
  await put(root, "node_modules/pkg/index.js", "x\n");
  await gitRepo(root);
  await put(root, "src/untracked.ts", "export {};\n");
  const result = await listFilesLocal(root, { rg: NO_RG });
  assert.equal(result.tool, "git");
  assert.equal(result.root, root);
  assert.equal(result.truncated, false);
  assert.deepEqual(result.files, [".gitignore", "README.md", "src/app.ts", "src/untracked.ts"]);
});

test("outside a repository the bounded walk skips heavy folders and never follows symlinks", async (t) => {
  const root = await project(t);
  const outside = await project(t, "outside");
  await put(outside, "elsewhere.txt", "x\n");
  await put(root, "a.txt", "x\n");
  await put(root, "deep/b.txt", "x\n");
  await put(root, "node_modules/c.js", "x\n");
  await put(root, "dist/bundle.js", "x\n");
  await put(root, ".git/config", "x\n");
  await symlink(outside, path.join(root, "linked"));
  await symlink(path.join(outside, "elsewhere.txt"), path.join(root, "file-link.txt"));
  const result = await listFilesLocal(root, { rg: NO_RG });
  assert.equal(result.tool, "walk");
  assert.deepEqual(result.files, ["a.txt", "deep/b.txt"]);
});

test("listing stops at the file cap and says it was truncated", async (t) => {
  const root = await project(t);
  for (let index = 0; index < 8; index++) await put(root, `f${index}.txt`, "x\n");
  const saved = CODE_SEARCH_LIMITS.files;
  CODE_SEARCH_LIMITS.files = 5;
  t.after(() => { CODE_SEARCH_LIMITS.files = saved; });
  const walked = await listFilesLocal(root, { rg: NO_RG });
  assert.equal(walked.files.length, 5);
  assert.equal(walked.truncated, true);
  await gitRepo(root);
  const listed = await listFilesLocal(root, { rg: NO_RG });
  assert.equal(listed.tool, "git");
  assert.equal(listed.files.length, 5);
  assert.equal(listed.truncated, true);
});

test("credential stores never appear in a listing or a search, even with home as the root", async () => {
  await put(home, ".ssh/id_ed25519", "PRIVATE needle\n");
  await put(home, ".aws/credentials", "needle\n");
  await put(home, ".config/pzzacode/agent-token", "needle\n");
  await put(home, ".claude/.credentials.json", "needle\n");
  await put(home, "notes/todo.txt", "needle in notes\n");
  const listed = await listFilesLocal(home, { rg: NO_RG });
  assert.ok(listed.files.includes("notes/todo.txt"));
  for (const file of listed.files) assert.ok(!/^(\.ssh|\.aws)\/|agent-token|\.credentials\.json/.test(file), file);
  const found = await searchLocal({ root: home, query: "needle", caseSensitive: false, regex: false }, { rg: NO_RG });
  assert.deepEqual(found.files.map((file) => file.path), ["notes/todo.txt"]);
});

test("roots are held to the editor's guards", async (t) => {
  const root = await project(t);
  await put(root, "file.txt", "x\n");
  await mkdir(path.join(home, ".ssh"), { recursive: true });
  const outside = await mkdtemp(path.join(tmpdir(), "pzza-code-search-outside-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  for (const [candidate, status] of [[outside, 403], ["/", 403], [path.join(home, ".ssh"), 403], [path.join(root, "missing"), 404], [path.join(root, "file.txt"), 400]]) {
    const listed = await getJson(`${endpoint}/code/files?root=${encodeURIComponent(candidate)}`);
    assert.equal(listed.status, status, candidate);
    const searched = await postJson(`${endpoint}/code/search`, { root: candidate, query: "x" });
    assert.equal(searched.status, status, candidate);
  }
  // A link inside home that leads to a credential store is refused by its real path.
  await symlink(path.join(home, ".ssh"), path.join(root, "keys"));
  assert.equal((await getJson(`${endpoint}/code/files?root=${encodeURIComponent(path.join(root, "keys"))}`)).status, 403);
});

test("requests are validated before anything runs", async (t) => {
  const root = await project(t);
  assert.equal((await fetch(`${endpoint}/code/files?root=${encodeURIComponent(root)}`, { method: "POST" })).status, 405);
  assert.equal((await fetch(`${endpoint}/code/search`)).status, 405);
  assert.equal((await getJson(`${endpoint}/code/files?root=${encodeURIComponent(root)}&host=-oProxyCommand=x`)).status, 400);
  assert.equal((await getJson(`${endpoint}/code/files?root=relative&host=devbox`)).status, 400);
  assert.equal((await getJson(`${endpoint}/code/files?root=${encodeURIComponent("/a/../b")}&host=devbox`)).status, 400);
  for (const body of [
    null, [], { root, query: "" }, { root, query: "a\nb" }, { root, query: "x".repeat(CODE_SEARCH_LIMITS.query + 1) },
    { root, query: "(", regex: true }, { root, query: "x", host: "a b" }, { root: "", query: "x" }, { root: `${root}\u0000`, query: "x" },
  ]) assert.throws(() => validateSearchRequest(body), (error) => error.status === 400, JSON.stringify(body));
  assert.deepEqual(validateSearchRequest({ root, query: "(", host: "" }), { host: "", root, query: "(", caseSensitive: false, regex: false });
  const invalid = await postJson(`${endpoint}/code/search`, { root, query: "[", regex: true });
  assert.deepEqual(invalid, { status: 400, body: { error: "Invalid regular expression" } });
});

async function searchFixture(t) {
  const root = await project(t);
  await put(root, "src/app.ts", "import x from './x';\n  const Needle = 1;\nconst needle = Needle + 2;\n");
  await put(root, "src/other.ts", "nothing here\n");
  await put(root, "notes.md", "a needle (literal)\n");
  await put(root, "ignored/hit.ts", "needle\n");
  await put(root, "node_modules/pkg/hit.js", "needle\n");
  await put(root, "image.bin", Buffer.from([0, 1, 2, 110, 101, 101, 100, 108, 101]));
  await put(root, ".gitignore", "ignored/\n");
  return root;
}

for (const [label, prepare, tool] of [
  ["git grep in a repository", gitRepo, "git"],
  ["a direct scan outside one", async () => {}, "scan"],
]) {
  test(`search by ${label}: grouped, highlighted, case and regex aware`, async (t) => {
    const root = await searchFixture(t);
    await prepare(root);
    const insensitive = await searchLocal({ root, query: "needle", caseSensitive: false, regex: false }, { rg: NO_RG });
    assert.equal(insensitive.tool, tool);
    assert.equal(insensitive.truncated, false);
    assert.deepEqual(insensitive.files.map((file) => file.path), tool === "git" ? ["notes.md", "src/app.ts"] : ["ignored/hit.ts", "notes.md", "src/app.ts"]);
    const app = insensitive.files.find((file) => file.path === "src/app.ts");
    assert.deepEqual(app.matches, [
      { line: 2, text: "const Needle = 1;", ranges: [[6, 12]] },
      { line: 3, text: "const needle = Needle + 2;", ranges: [[6, 12], [15, 21]] },
    ]);
    const sensitive = await searchLocal({ root, query: "Needle", caseSensitive: true, regex: false }, { rg: NO_RG });
    assert.deepEqual(sensitive.files.flatMap((file) => file.matches.map((match) => [file.path, match.line, match.ranges])),
      [["src/app.ts", 2, [[6, 12]]], ["src/app.ts", 3, [[15, 21]]]]);
    const literal = await searchLocal({ root, query: "(literal)", caseSensitive: false, regex: false }, { rg: NO_RG });
    assert.deepEqual(literal.files.map((file) => [file.path, file.matches[0].ranges]), [["notes.md", [[9, 18]]]]);
    const pattern = await searchLocal({ root, query: "const \\w+ = \\d", caseSensitive: true, regex: true }, { rg: NO_RG });
    assert.deepEqual(pattern.files.flatMap((file) => file.matches.map((match) => match.line)), [2]);
    const none = await searchLocal({ root, query: "absent-text", caseSensitive: false, regex: false }, { rg: NO_RG });
    assert.deepEqual(none, { root, tool, files: [], matchCount: 0, truncated: false });
  });
}

test("search stops at the match caps", async (t) => {
  const root = await project(t);
  await put(root, "many.txt", Array.from({ length: 80 }, (_, index) => `hit ${index}`).join("\n"));
  await put(root, "more.txt", "hit\nhit\nhit\n");
  const saved = CODE_SEARCH_LIMITS.matches;
  CODE_SEARCH_LIMITS.matches = 60;
  t.after(() => { CODE_SEARCH_LIMITS.matches = saved; });
  const perFile = await searchLocal({ root, query: "hit", caseSensitive: false, regex: false }, { rg: NO_RG });
  assert.equal(perFile.files.find((file) => file.path === "many.txt").matches.length, CODE_SEARCH_LIMITS.matchesPerFile);
  assert.equal(perFile.truncated, true);
  CODE_SEARCH_LIMITS.matches = 10;
  const total = await searchLocal({ root, query: "hit", caseSensitive: false, regex: false }, { rg: NO_RG });
  assert.equal(total.matchCount, 10);
  assert.equal(total.truncated, true);
});

test("a cancelled search stops without answering", async (t) => {
  const root = await searchFixture(t);
  const controller = new AbortController();
  controller.abort();
  await assert.rejects(searchLocal({ root, query: "needle", caseSensitive: false, regex: false }, { rg: NO_RG, signal: controller.signal }), { status: 499 });
  await assert.rejects(listFilesLocal(root, { rg: NO_RG, signal: controller.signal }), { status: 499 });
});

test("search over HTTP returns the same grouped result", async (t) => {
  const root = await searchFixture(t);
  await gitRepo(root);
  const { status, body } = await postJson(`${endpoint}/code/search`, { root, query: "NEEDLE", caseSensitive: true });
  assert.equal(status, 200);
  assert.deepEqual(body.files, []);
  const listed = await getJson(`${endpoint}/code/files?root=${encodeURIComponent(root)}`);
  assert.equal(listed.status, 200);
  assert.ok(listed.body.files.includes("src/app.ts"));
});

test("ripgrep, git grep and grep records parse into lines with character ranges", () => {
  const line = "const café = needle; // needle\n";
  const bytes = Buffer.from(line);
  const start = bytes.indexOf("needle");
  const second = bytes.lastIndexOf("needle");
  const record = Buffer.from(JSON.stringify({ type: "match", data: {
    path: { text: "./src/a.ts" }, lines: { text: line }, line_number: 7,
    submatches: [{ match: { text: "needle" }, start, end: start + 6 }, { match: { text: "needle" }, start: second, end: second + 6 }],
  } }));
  assert.deepEqual(parseRgRecord(record), { path: "./src/a.ts", line: 7, text: line, ranges: [[13, 19], [24, 30]] });
  for (const other of [{ type: "begin", data: {} }, { type: "match", data: { path: { bytes: "AA==" }, lines: { text: "x" }, line_number: 1 } }, "not json"]) {
    assert.equal(parseRgRecord(Buffer.from(typeof other === "string" ? other : JSON.stringify(other))), null);
  }
  assert.deepEqual(parseGitGrepRecord(Buffer.from("src/a b.ts\u000012\u0000text: with\u0000nul")), { path: "src/a b.ts", line: 12, text: "text: with\u0000nul" });
  assert.equal(parseGitGrepRecord(Buffer.from("no separators")), null);
  assert.deepEqual(parseGrepRecord(Buffer.from("./x.txt\u00003:a: b")), { path: "./x.txt", line: 3, text: "a: b" });
  assert.equal(parseGrepRecord(Buffer.from("./x.txt\u0000abc")), null);
});

test("long lines are clipped around the first match and ranges follow", () => {
  const text = `${"    "}${"a".repeat(300)}needle${"b".repeat(300)}`;
  const ranges = matchRanges(compileQuery("needle", { caseSensitive: true, regex: false }), text);
  const clipped = clipLine(text, ranges);
  assert.ok(clipped.text.length <= CODE_SEARCH_LIMITS.lineChars);
  assert.ok(clipped.text.startsWith("…"));
  assert.equal(clipped.text.slice(clipped.ranges[0][0], clipped.ranges[0][1]), "needle");
  assert.deepEqual(clipLine("\tshort hit\r\n", [[7, 10]]), { text: "short hit", ranges: [[6, 9]] });
  assert.deepEqual(matchRanges(compileQuery("^", { caseSensitive: true, regex: true }), "abc"), []);
});

test("remote scripts quote every value and run behind the home guard", () => {
  const hostile = "x'; touch /tmp/pwned; echo '";
  const script = remoteSearchScript("~/project", { query: hostile, caseSensitive: false, regex: true });
  assert.ok(script.includes(shQuote(hostile)));
  assert.ok(!script.includes(`-e ${hostile}`));
  assert.ok(script.startsWith("h=$(cd ~ && pwd -P);"));
  assert.ok(script.includes("PZZA_DENIED"));
  assert.ok(script.includes("'-P'") && script.includes("'-E'"));
  assert.ok(remoteListScript("~/p").includes("-prune -o -type f -print0"));
});

// Stands in for ssh: runs the given shell text locally instead of the script.
const fakeSsh = (output) => (_command, _args, options) => spawn("sh", ["-c", output], options);

test("remote listings and searches parse the device's answer and drop credential stores", async () => {
  const listing = await listFilesRemote("devbox", "~", {
    spawnImpl: fakeSsh(`printf '/home/u\\0/home/u\\0git\\0src/a.ts\\0.ssh/id_rsa\\0node_modules/x.js\\0../escape\\0README.md\\0'`),
  });
  assert.deepEqual(listing, { root: "/home/u", tool: "git", files: ["README.md", "src/a.ts"], truncated: false });
  const record = (file, text) => JSON.stringify({ type: "match", data: { path: { text: file }, lines: { text }, line_number: 1, submatches: [{ start: 0, end: 4 }] } });
  const searched = await searchRemote("devbox", { root: "~", query: "key1", caseSensitive: false, regex: false }, {
    spawnImpl: fakeSsh(`printf '%s\\n' /home/u /home/u rg ${shQuote(record("./.ssh/id_rsa", "key1"))} ${shQuote(record("./src/a.ts", "key1 = 2"))}`),
  });
  assert.deepEqual(searched.files, [{ path: "src/a.ts", matches: [{ line: 1, text: "key1 = 2", ranges: [[0, 4]] }] }]);
  const grep = await searchRemote("devbox", { root: "~/p", query: "b", caseSensitive: false, regex: false }, {
    spawnImpl: fakeSsh(`printf '/home/u/p\\n/home/u\\ngrep\\n./x.txt\\0004:a b\\n'`),
  });
  assert.deepEqual(grep.files, [{ path: "x.txt", matches: [{ line: 4, text: "a b", ranges: [[2, 3]] }] }]);
});

test("a remote guard refusal, missing folder or unreachable device is an error, not an empty list", async () => {
  await assert.rejects(listFilesRemote("devbox", "~/.ssh", { spawnImpl: fakeSsh("echo PZZA_DENIED; exit 3") }), { status: 403 });
  await assert.rejects(searchRemote("devbox", { root: "~/.ssh", query: "x" }, { spawnImpl: fakeSsh("echo PZZA_DENIED; exit 3") }), { status: 403 });
  await assert.rejects(listFilesRemote("devbox", "~/missing", { spawnImpl: fakeSsh("exit 4") }), { status: 404 });
  await assert.rejects(listFilesRemote("devbox", "~/p", { spawnImpl: fakeSsh("exit 255") }), { status: 502 });
});

test("ripgrep is used for search when it is installed", { skip: !HAS_RG && "ripgrep is not installed" }, async (t) => {
  const root = await searchFixture(t);
  await gitRepo(root);
  const result = await searchLocal({ root, query: "needle", caseSensitive: false, regex: false });
  assert.equal(result.tool, "rg");
  assert.deepEqual(result.files.map((file) => file.path), ["notes.md", "src/app.ts"]);
});
