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
    assert.equal(new URL(url).origin, "https://api.github.com");
    assert.equal(options.headers.Authorization, undefined);
    assert.ok(options.signal instanceof AbortSignal);
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
    assert.equal(state.calls.some(url => url.includes("/blobs/")), false);
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
    assert.equal(state.calls.some(url => url.includes("/blobs/")), false);
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

test("enforces streamed response limits, forwards cancellation and disallows redirects", async () => {
  await assert.rejects(inspectSkillSource(source, { fetch: async () => new Response("{}", { headers: { "content-length": String(5 * 1024 * 1024) } }) }), /size limit/);
  const signal = AbortSignal.abort();
  await assert.rejects(inspectSkillSource(source, { signal, fetch: async (_url, options) => { options.signal.throwIfAborted(); } }), /abort/i);
  await assert.rejects(inspectSkillSource(source, { fetch: async (_url, options) => { assert.equal(options.redirect, "error"); throw new TypeError("Redirect rejected"); } }), /Redirect rejected/);
});
