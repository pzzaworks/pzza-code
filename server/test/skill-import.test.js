import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import { inspectSkillSource } from "../lib/skill-import.js";

const commit = "a".repeat(40), root = "b".repeat(40), directory = "c".repeat(40);
const source = { sourceUrl: "https://github.com/example/skills", subpath: "demo" };
function fixture(entries = [["SKILL.md", Buffer.from("---\nname: demo\n---\nUse assets/icon.png and scripts/run.sh.")], ["assets/icon.png", Buffer.from([0, 255, 128, 14])], ["scripts/run.sh", Buffer.from("#!/bin/sh\nexit 0\n")]]) {
  const blobs = new Map();
  const files = entries.map(([path, bytes]) => {
    const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
    blobs.set(sha, { sha, size: bytes.length, encoding: "base64", content: bytes.toString("base64") });
    return { path, sha, size: bytes.length, type: "blob", mode: path.endsWith(".sh") ? "100755" : "100644" };
  });
  const calls = [];
  const responses = new Map([
    ["", { private: false, default_branch: "main", license: { name: "MIT License", spdx_id: "MIT" } }],
    ["commits/main", { sha: commit, commit: { tree: { sha: root } } }],
    [`git/trees/${root}`, { tree: [{ path: "demo", type: "tree", mode: "040000", sha: directory }] }],
    [`git/trees/${directory}?recursive=1`, { tree: files }],
    ...[...blobs].map(([sha, blob]) => [`git/blobs/${sha}`, blob]),
  ]);
  const fetch = async (url, options) => {
    calls.push(url);
    assert.equal(options.redirect, "error");
    assert.ok(["https://api.github.com", "https://raw.githubusercontent.com"].includes(new URL(url).origin));
    assert.equal(options.headers.Authorization, undefined);
    assert.ok(options.signal instanceof AbortSignal);
    if (url.startsWith("https://raw.githubusercontent.com/")) {
      const prefix = `https://raw.githubusercontent.com/example/skills/${commit}/`;
      assert.ok(url.startsWith(prefix), "Raw downloads must use the resolved immutable commit");
      const sourcePath = decodeURIComponent(url.slice(prefix.length));
      const entry = sourcePath.startsWith("demo/") ? files.find(file => file.path === sourcePath.slice(5)) : responses.get(`git/trees/${root}`).tree.find(file => file.path === sourcePath);
      assert.ok(entry, `Unexpected source path: ${sourcePath}`);
      const blob = responses.get(`git/blobs/${entry.sha}`);
      assert.ok(blob);
      return new Response(Buffer.from(blob.content, "base64"));
    }
    const key = url.replace("https://api.github.com/repos/example/skills", "").replace(/^\//, "");
    assert.ok(responses.has(key), `Unexpected request: ${key}`);
    return new Response(JSON.stringify(responses.get(key)), { headers: { "content-type": "application/json" } });
  };
  return { fetch, responses, files, blobs, calls };
}

test("imports the complete inert bundle with binary assets and pinned provenance", async () => {
  const state = fixture();
  const result = await inspectSkillSource(source, state);
  assert.equal(result.commit, commit);
  assert.equal(result.license, "Repository declared: MIT");
  assert.equal(result.name, "demo");
  assert.equal(result.sourceUrl, source.sourceUrl);
  assert.equal(result.files.length, 3);
  assert.equal(result.files.find(file => file.path === "scripts/run.sh").executable, true);
  assert.equal(result.files.find(file => file.path === "SKILL.md").executable, false);
  assert.deepEqual(Buffer.from(result.files[1].contentBase64, "base64"), Buffer.from([0, 255, 128, 14]));
  assert.match(result.content, /assets\/icon.png/);
});

test("rejects foreign hosts, URL credentials and traversal before requesting anything", async () => {
  for (const sourceUrl of ["http://github.com/example/skills", "https://github.com.evil.test/example/skills", "https://user:password@github.com/example/skills", "https://github.com/example/skills?token=x", "https://localhost/example/skills"]) {
    await assert.rejects(inspectSkillSource({ ...source, sourceUrl }, { fetch: () => assert.fail("No request allowed") }));
  }
  for (const subpath of ["../demo", "/demo", "demo/../other", "demo\\other", "demo/.env", "demo/.ssh/key", "demo\0other"]) {
    await assert.rejects(inspectSkillSource({ ...source, subpath }, { fetch: () => assert.fail("No request allowed") }));
  }
});

test("rejects symlinks, submodules, sensitive paths and case collisions", async () => {
  const additions = [
    { path: "link", type: "blob", mode: "120000", size: 1, sha: root },
    { path: "module", type: "commit", mode: "160000", sha: root },
    { path: ".env.local", type: "blob", mode: "100644", size: 1, sha: root },
    { path: "skill.md", type: "blob", mode: "100644", size: 1, sha: root },
  ];
  for (const entry of additions) {
    const state = fixture();
    state.files.push(entry);
    await assert.rejects(inspectSkillSource(source, state));
    assert.equal(state.calls.some(url => url.startsWith("https://raw.githubusercontent.com/")), false);
  }
});

test("rejects truncated trees, private repositories and corrupted blobs", async () => {
  const truncated = fixture();
  truncated.responses.get(`git/trees/${directory}?recursive=1`).truncated = true;
  await assert.rejects(inspectSkillSource(source, truncated), /incomplete/);
  const privateRepo = fixture();
  privateRepo.responses.get("").private = true;
  await assert.rejects(inspectSkillSource(source, privateRepo), /public/);
  const corrupted = fixture();
  corrupted.blobs.values().next().value.content = Buffer.from("replaced").toString("base64");
  await assert.rejects(inspectSkillSource(source, corrupted), /pinned Git identity/);
});

test("enforces limits before downloading oversized or excessive files", async () => {
  for (const entries of [Array.from({ length: 101 }, (_, i) => ({ path: `file${i}`, type: "blob", mode: "100644", size: 1, sha: root })),
    [{ path: "large", type: "blob", mode: "100644", size: 5 * 1024 * 1024 + 1, sha: root }],
    Array.from({ length: 5 }, (_, i) => ({ path: `large${i}`, type: "blob", mode: "100644", size: 5 * 1024 * 1024, sha: root }))]) {
    const state = fixture(); state.files.push(...entries);
    await assert.rejects(inspectSkillSource(source, state), /limit|at most/);
    assert.equal(state.calls.some(url => url.startsWith("https://raw.githubusercontent.com/")), false);
  }
});

test("requires a valid UTF-8 SKILL.md and does not invent missing licenses", async () => {
  await assert.rejects(inspectSkillSource(source, fixture([["README.md", Buffer.from("not a skill")]])), /SKILL.md/);
  await assert.rejects(inspectSkillSource(source, fixture([["SKILL.md", Buffer.from([255])]])), /UTF-8/);
  const state = fixture(); state.responses.get("").license = null;
  assert.equal((await inspectSkillSource(source, state)).license, undefined);
});

test("preserves ancestor license and notice files verbatim with source paths", async () => {
  const state = fixture();
  const bytes = Buffer.from("Copyright example. Full original license text.");
  const sha = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  state.responses.get(`git/trees/${root}`).tree.push({ path: "LICENSE", type: "blob", mode: "100644", sha, size: bytes.length });
  state.responses.set(`git/blobs/${sha}`, { sha, size: bytes.length, encoding: "base64", content: bytes.toString("base64") });
  const result = await inspectSkillSource(source, state);
  const license = result.files.find(file => file.path === "_source-notices/LICENSE");
  assert.ok(license);
  assert.deepEqual(Buffer.from(license.contentBase64, "base64"), bytes);
});

test("downloads at bounded concurrency, coalesces repeated SHAs and reuses only verified blobs", async () => {
  const entries = [["SKILL.md", Buffer.from("---\nname: demo\n---\nInstructions")], ...Array.from({ length: 12 }, (_, index) => [`references/${index}.txt`, Buffer.from(`Reference ${index % 6}`)])];
  const state = fixture(entries);
  const fetchOriginal = state.fetch;
  let active = 0, maximum = 0, blobRequests = 0;
  const fetch = async (url, options) => {
    if (!url.startsWith("https://raw.githubusercontent.com/")) return fetchOriginal(url, options);
    active++; maximum = Math.max(maximum, active); blobRequests++;
    await new Promise(resolve => setImmediate(resolve));
    try { return await fetchOriginal(url, options); } finally { active--; }
  };
  const result = await inspectSkillSource(source, { fetch });
  assert.equal(result.files.length, 13); assert.ok(maximum > 1); assert.ok(maximum <= 4); assert.equal(blobRequests, 7);
  assert.equal(state.calls.filter(url => url.startsWith("https://api.github.com/")).length, 4);
  assert.equal(state.calls.some(url => url.includes("/git/blobs/")), false);
  const repeated = await inspectSkillSource(source, { fetch });
  assert.equal(blobRequests, 7); assert.deepEqual(repeated.files, result.files);
  assert.equal(state.calls.filter(url => url.includes("/commits/")).length, 2);
  assert.equal(result.subpath, "demo");
  const firstBlob = state.files[0];
  firstBlob.size++;
  await assert.rejects(inspectSkillSource(source, { fetch }), /inconsistent/);
});

test("immutable raw downloads retain original ancestor notice paths and validate each Git SHA", async () => {
  const state = fixture([["SKILL.md", Buffer.from("Source instructions")]]);
  const pluginTree = "d".repeat(40);
  const rootNotice = Buffer.from("Repository license"), pluginNotice = Buffer.from("Plugin notice");
  const gitSha = bytes => createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
  state.responses.get(`git/trees/${root}`).tree = [{ path: "plugins", type: "tree", mode: "040000", sha: pluginTree }, { path: "LICENSE", type: "blob", mode: "100644", sha: gitSha(rootNotice), size: rootNotice.length }];
  state.responses.set(`git/trees/${pluginTree}`, { tree: [{ path: "demo", type: "tree", mode: "040000", sha: directory }, { path: "NOTICE", type: "blob", mode: "100644", sha: gitSha(pluginNotice), size: pluginNotice.length }] });
  const bytesByPath = new Map([["plugins/demo/SKILL.md", Buffer.from("Source instructions")], ["LICENSE", rootNotice], ["plugins/NOTICE", pluginNotice]]);
  const rawRequests = [];
  const fetch = async (url, options) => {
    if (!url.startsWith("https://raw.githubusercontent.com/")) return state.fetch(url, options);
    const prefix = `https://raw.githubusercontent.com/example/skills/${commit}/`;
    assert.ok(url.startsWith(prefix)); assert.equal(options.redirect, "error"); assert.equal(options.headers.Authorization, undefined);
    const path = url.slice(prefix.length); rawRequests.push(path);
    assert.ok(bytesByPath.has(path), path);
    return new Response(bytesByPath.get(path));
  };
  const imported = await inspectSkillSource({ ...source, subpath: "plugins/demo" }, { fetch });
  assert.deepEqual(rawRequests.sort(), ["LICENSE", "plugins/NOTICE", "plugins/demo/SKILL.md"]);
  assert.equal(Buffer.from(imported.files.find(file => file.path === "_source-notices/plugins/NOTICE").contentBase64, "base64").toString(), pluginNotice.toString());
  const corrupt = fixture();
  const fetchCorrupt = async (url, options) => url.startsWith("https://raw.githubusercontent.com/") ? new Response(Buffer.alloc(corrupt.files[0].size)) : corrupt.fetch(url, options);
  await assert.rejects(inspectSkillSource(source, { fetch: fetchCorrupt }), /pinned Git identity|size limit/);
  const tooLarge = fixture();
  await assert.rejects(inspectSkillSource(source, { fetch: async (url, options) => url.startsWith("https://raw.githubusercontent.com/") ? new Response(Buffer.alloc(10000)) : tooLarge.fetch(url, options) }), /size limit/);
});

test("known import failures are actionable without exposing network diagnostics", async () => {
  for (const [status, code] of [[403, "SOURCE_RATE_LIMIT"], [429, "SOURCE_RATE_LIMIT"], [404, "SOURCE_NOT_FOUND"], [500, "SOURCE_UNAVAILABLE"]]) {
    await assert.rejects(inspectSkillSource(source, { fetch: async () => new Response("Untrusted response details", { status }) }), error => error.code === code && !error.message.includes("Untrusted"));
  }
  await assert.rejects(inspectSkillSource(source, { fetch: async () => { throw new Error("Private network diagnostic"); } }), error => error.status === 502 && error.code === "SOURCE_UNAVAILABLE" && !error.message.includes("Private"));
  const state = fixture();
  state.responses.get(`git/trees/${root}`).tree = [];
  await assert.rejects(inspectSkillSource(source, state), error => error.status === 400 && /folder does not exist/.test(error.message));
});

test("enforces streamed response limits, forwards cancellation and disallows redirects", async () => {
  await assert.rejects(inspectSkillSource(source, { fetch: async () => new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } }) }), /size limit/);
  const signal = AbortSignal.abort();
  await assert.rejects(inspectSkillSource(source, { signal, fetch: async (_url, options) => { options.signal.throwIfAborted(); } }), { status: 499, code: "IMPORT_CANCELLED" });
  await assert.rejects(inspectSkillSource(source, { fetch: async (_url, options) => { assert.equal(options.redirect, "error"); throw new TypeError("Redirect rejected"); } }), { status: 502, code: "SOURCE_UNAVAILABLE" });
});
