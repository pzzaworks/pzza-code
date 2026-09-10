import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { Readable } from "node:stream";
import { EventEmitter } from "node:events";
import { createAgentsHub, createAgentsHubRouter, runHubTarget } from "../lib/agents-hub.js";
import { skillImportError } from "../lib/skill-import.js";

const skillText = "---\nname: review\ndescription: Review the current changes\n---\nRead the changes carefully.\n";
async function fixture(t, options = {}) {
  const directory = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pzza-hub-test-")));
  const home = path.join(directory, "home");
  const cwd = path.join(home, "project");
  await fs.mkdir(cwd, { recursive: true });
  const env = { ...process.env, HOME: home, PATH: "/usr/bin:/bin" };
  const stateDir = path.join(directory, "state");
  const target = (host, payload) => { assert.equal(host, ""); return runHubTarget(host, payload, { env }); };
  const hub = createAgentsHub({ stateDir, target, ...options });
  t.after(() => fs.rm(directory, { recursive: true, force: true }));
  const library = { revision: 0, documents: [{ id: "base", name: "Base", framework: "claude", content: "Use focused tests." }], skills: [{ id: "review", name: "Review", content: skillText,
    files: [{ path: "SKILL.md", contentBase64: Buffer.from("stale").toString("base64") }, { path: "assets/data.bin", contentBase64: Buffer.from([0, 255, 1]).toString("base64") }, { path: "scripts/check.sh", contentBase64: Buffer.from("#!/bin/sh\nexit 0\n").toString("base64"), executable: true }] }],
    profiles: [{ id: "reviewer", name: "Reviewer", framework: "claude", systemPrompt: "Prefer clear explanations.", instructionIds: ["base"], skillIds: ["review"] }] };
  return { hub, library, home, cwd, stateDir, directory, env, target };
}
const editable = ({ revision, documents, skills, profiles }) => ({ revision, documents, skills, profiles });

test("library is private, revisioned and rejects stale saves or invalid references", async (t) => {
  const f = await fixture(t);
  assert.equal(f.hub.state().revision, 0);
  assert.equal(f.hub.state().frameworks.length, 5);
  const saved = f.hub.save(f.library);
  assert.equal(saved.revision, 1);
  assert.equal((await fs.stat(path.join(f.stateDir, "agents-hub.json"))).mode & 0o777, 0o600);
  assert.throws(() => f.hub.save(f.library), /changed/);
  assert.throws(() => f.hub.save({ ...editable(saved), profiles: [{ ...saved.profiles[0], skillIds: ["missing"] }] }), /skills/);
  assert.equal(Buffer.from(saved.skills[0].files[0].contentBase64, "base64").toString(), skillText);
  assert.equal(createAgentsHub({ stateDir: f.stateDir }).state().profiles[0].name, "Reviewer");
});

test("preview is read-only; synchronization preserves complete assets and executable modes", async (t) => {
  const f = await fixture(t);
  f.hub.save(f.library);
  const plan = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  assert.deepEqual(await fs.readdir(f.cwd), []);
  assert.equal(plan.conflicts.length, 0);
  assert.ok(plan.files.find((file) => file.path === "CLAUDE.md").content.includes("Prefer clear explanations."));
  assert.equal(plan.files.find((file) => file.path.endsWith("data.bin")).encoding, "base64");
  const applied = await f.hub.apply(plan.previewId, "sync");
  assert.equal(applied.status, "synced", applied.error);
  assert.equal(await fs.readFile(path.join(f.cwd, ".claude/skills/review/SKILL.md"), "utf8"), skillText);
  assert.deepEqual(await fs.readFile(path.join(f.cwd, ".claude/skills/review/assets/data.bin")), Buffer.from([0, 255, 1]));
  assert.equal((await fs.stat(path.join(f.cwd, ".claude/skills/review/scripts/check.sh"))).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(f.cwd, "CLAUDE.md"))).mode & 0o777, 0o600);
  assert.equal((await f.hub.apply(plan.previewId, "sync")).id, applied.id);
});

test("manual edits, mode changes and profile ownership prevent silent overwrite", async (t) => {
  const f = await fixture(t);
  f.hub.save(f.library);
  await fs.writeFile(path.join(f.cwd, "CLAUDE.md"), "Existing instructions");
  const conflict = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  assert.ok(conflict.conflicts.some((message) => message.includes("not owned")));
  await assert.rejects(f.hub.apply(conflict.previewId, "sync"), /conflicts/);
  await fs.unlink(path.join(f.cwd, "CLAUDE.md"));
  const plan = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  await fs.writeFile(path.join(f.cwd, "CLAUDE.md"), "Racing writer");
  assert.equal((await f.hub.apply(plan.previewId, "sync")).status, "failed");
  assert.equal(await fs.readFile(path.join(f.cwd, "CLAUDE.md"), "utf8"), "Racing writer");
  await fs.unlink(path.join(f.cwd, "CLAUDE.md"));
  const clean = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  assert.equal((await f.hub.apply(clean.previewId, "sync")).status, "synced");
  const saved = f.hub.state();
  f.hub.save({ ...editable(saved), profiles: [...saved.profiles, { ...saved.profiles[0], id: "other" }] });
  const other = await f.hub.preview({ profileId: "other", host: "", cwd: f.cwd });
  assert.ok(other.conflicts.some((message) => message.includes("another profile")));
  const modePlan = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  await fs.chmod(path.join(f.cwd, "CLAUDE.md"), 0o644);
  assert.equal((await f.hub.apply(modePlan.previewId, "sync")).status, "failed");
});

test("removed skills are reviewed deletions and symlink paths cannot escape", async (t) => {
  const f = await fixture(t);
  f.hub.save(f.library);
  const plan = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  assert.equal((await f.hub.apply(plan.previewId, "sync")).status, "synced");
  const saved = f.hub.state();
  f.hub.save({ ...editable(saved), profiles: [{ ...saved.profiles[0], skillIds: [] }] });
  const removal = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  assert.ok(removal.files.some((file) => file.operation === "delete" && file.content === null));
  assert.equal((await f.hub.apply(removal.previewId, "sync")).status, "synced");
  await assert.rejects(fs.stat(path.join(f.cwd, ".claude/skills/review/SKILL.md")), { code: "ENOENT" });
  const outside = path.join(f.directory, "outside");
  await fs.mkdir(outside);
  const linked = path.join(f.home, "linked");
  await fs.symlink(outside, linked);
  await assert.rejects(f.hub.preview({ profileId: "reviewer", host: "", cwd: linked }), /real project directory/);
  await assert.rejects(f.hub.preview({ profileId: "reviewer", host: "-bad", cwd: f.cwd }), /explicit device/);
});

test("deployment launches unique sessions only with installed tools and retains failures", async (t) => {
  const f = await fixture(t);
  f.hub.save(f.library);
  const missing = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  assert.equal((await f.hub.apply(missing.previewId, "deploy")).status, "failed");
  assert.deepEqual(await fs.readdir(f.cwd), []);
  const bin = path.join(f.home, "bin");
  await fs.mkdir(bin);
  await fs.writeFile(path.join(bin, "claude"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  await fs.writeFile(path.join(bin, "tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  f.env.PATH = `${bin}:/usr/bin:/bin`;
  const first = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  const one = await f.hub.apply(first.previewId, "deploy");
  assert.equal(one.status, "launched", one.error);
  const second = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  const two = await f.hub.apply(second.previewId, "deploy");
  assert.equal(two.status, "launched", two.error);
  assert.notEqual(one.session, two.session);
  assert.equal((await f.hub.apply(second.previewId, "deploy")).session, two.session);
});

test("imports preserve full bundles and reject a concurrent library revision", async (t) => {
  let resolve;
  const pending = new Promise((done) => { resolve = done; });
  const f = await fixture(t, { inspectSkill: () => pending });
  const request = f.hub.importSkill({ revision: 0, sourceUrl: "https://github.com/example/skills", subpath: "review" });
  f.hub.save(f.library);
  resolve({ name: "Imported", content: skillText, files: [{ path: "asset.bin", contentBase64: "AA==" }], sourceUrl: "https://github.com/example/skills", commit: "a".repeat(40) });
  await assert.rejects(request, /changed during import/);
  const imported = await f.hub.importSkill({ revision: 1, sourceUrl: "https://github.com/example/skills", subpath: "review" });
  assert.equal(imported.skills.length, 2);
  assert.equal(imported.skills[1].files[0].contentBase64, undefined);
  assert.equal(imported.skills[1].files[0].bytes, 1);
  assert.equal(f.hub.state().skills[1].files[0].contentBase64, "AA==");
});

test("adopting existing files is explicit, shows prior content and keeps private backups", async (t) => {
  const f = await fixture(t);
  f.hub.save(f.library);
  await fs.writeFile(path.join(f.cwd, "CLAUDE.md"), "Existing project instructions");
  const plan = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd, adoptExisting: true });
  assert.equal(plan.conflicts.length, 0);
  assert.equal(plan.files.find((file) => file.path === "CLAUDE.md").previousContent, "Existing project instructions");
  const result = await f.hub.apply(plan.previewId, "sync");
  assert.equal(result.status, "synced", result.error);
  assert.equal(await fs.readFile(path.join(result.backupPath, "files/CLAUDE.md"), "utf8"), "Existing project instructions");
  assert.equal((await fs.stat(result.backupPath)).mode & 0o777, 0o700);
  assert.equal((await fs.stat(path.join(result.backupPath, "files/CLAUDE.md"))).mode & 0o777, 0o600);
  await assert.rejects(f.hub.apply(plan.previewId, "deploy"), /different mode/);
  const saved = f.hub.state();
  f.hub.save({ ...editable(saved), profiles: [...saved.profiles, { ...saved.profiles[0], id: "other" }] });
  const other = await f.hub.preview({ profileId: "other", host: "", cwd: f.cwd, adoptExisting: true });
  assert.ok(other.conflicts.some((message) => message.includes("another profile")));
});

test("skill frontmatter names own their directories and asset case collisions are rejected", async (t) => {
  const f = await fixture(t);
  const importedId = "12345678-1234-1234-1234-123456789abc";
  f.hub.save({ ...f.library, skills: [{ ...f.library.skills[0], id: importedId }], profiles: [{ ...f.library.profiles[0], skillIds: [importedId] }] });
  const plan = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  assert.ok(plan.files.some((file) => file.path === ".claude/skills/review/SKILL.md"));
  assert.ok(!plan.files.some((file) => file.path.includes(importedId)));
  const saved = editable(f.hub.state());
  f.hub.save({ ...saved, skills: [{ ...saved.skills[0], content: "---\ntype: example\n---\nname: review\ndescription: This is only body text" }] });
  await assert.rejects(f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd }), /frontmatter/);
  const current = editable(f.hub.state());
  assert.throws(() => f.hub.save({ ...current, skills: [{ ...current.skills[0], files: [{ path: "Asset.bin", contentBase64: "AA==" }, { path: "asset.bin", contentBase64: "AQ==" }] }] }), /case-colliding/);
});

test("bounded metadata and item updates preserve binary assets without returning their contents", async (t) => {
  const f = await fixture(t);
  f.hub.save(f.library);
  const summary = f.hub.summary();
  assert.equal(summary.skills[0].content, undefined);
  assert.equal(summary.skills[0].files[1].contentBase64, undefined);
  assert.equal(summary.skills[0].files[1].bytes, 3);
  const item = f.hub.item({ kind: "skill", id: "review" });
  assert.equal(item.item.content, skillText);
  assert.equal(item.item.files[1].contentBase64, undefined);
  const updated = f.hub.update({ revision: 1, kind: "skill", item: { id: "review", content: skillText + "Additional review guidance." } });
  assert.equal(updated.revision, 2);
  assert.equal(f.hub.state().skills[0].files[1].contentBase64, f.library.skills[0].files[1].contentBase64);
  assert.equal(Buffer.from(f.hub.state().skills[0].files[0].contentBase64, "base64").toString(), skillText + "Additional review guidance.");
});

test("atomic edits preserve four global-derived documents and asset metadata cannot overwrite bundles", async t => {
  const f = await fixture(t);
  const documents = [f.library.documents[0], ...Array.from({ length: 3 }, (_, index) => ({ ...f.library.documents[0], id: `global-${index}`, content: `Original device guidance ${index}` }))];
  f.hub.save({ ...f.library, documents });
  const original = f.hub.state();
  assert.throws(() => f.hub.update({ revision: 1, kind: "skill", item: f.hub.summary().skills[0] }), /Invalid skill/);
  assert.throws(() => f.hub.update({ revision: 1, kind: "skill", item: f.hub.item({ kind: "skill", id: "review" }).item }), /Invalid skill asset/);
  assert.throws(() => f.hub.save(editable(f.hub.summary())), /Invalid instruction/);
  const saved = f.hub.update({ revision: 1, changes: [{ op: "update", kind: "skill", item: { id: "review", content: skillText + "More checks." } }, { op: "update", kind: "profile", item: { id: "reviewer", name: "Updated reviewer" } }] });
  assert.equal(saved.revision, 2);
  assert.deepEqual(f.hub.state().documents, original.documents);
  assert.deepEqual(f.hub.state().skills[0].files.slice(1), original.skills[0].files.slice(1));
  assert.throws(() => f.hub.update({ revision: 1, kind: "document", item: { id: "base", content: "Stale" } }), /changed/);
  assert.throws(() => f.hub.update({ revision: 2, changes: [{ op: "update", kind: "document", item: { id: "base", content: "Must not persist" } }, { op: "remove", kind: "skill", id: "missing" }] }), /not found/);
  assert.deepEqual(f.hub.state().documents, original.documents);
  assert.equal(f.hub.state().revision, 2);
});

test("removal and framework changes atomically detach only reviewed profile references", async t => {
  const f = await fixture(t);
  f.hub.save(f.library);
  assert.throws(() => f.hub.remove({ revision: 1, kind: "document", id: "base" }), /attachments/);
  assert.equal(f.hub.state().documents.length, 1);
  assert.throws(() => f.hub.update({ revision: 1, kind: "document", item: { id: "base", framework: "codex" } }), /attachments/);
  const updated = f.hub.update({ revision: 1, kind: "document", item: { id: "base", framework: "codex" }, detachReferences: true });
  assert.deepEqual(updated.profiles[0].instructionIds, []);
  assert.deepEqual(updated.profiles[0].skillIds, ["review"]);
  const removed = f.hub.remove({ revision: 2, kind: "skill", id: "review", detachReferences: true });
  assert.equal(removed.skills.length, 0);
  assert.deepEqual(removed.profiles[0].skillIds, []);
  assert.equal(removed.documents.length, 1);
  assert.throws(() => f.hub.remove({ revision: 2, kind: "profile", id: "reviewer" }), /changed/);
});

test("repository and folder imports are idempotent and explicit updates preserve stable IDs", async t => {
  let inspections = 0;
  const f = await fixture(t, { inspectSkill: async input => { inspections++; return { ...input, name: "Imported", content: `${skillText}${inspections}`, files: [{ path: "LICENSE", contentBase64: Buffer.from(`License ${inspections}`).toString("base64") }], commit: String(inspections).repeat(40) }; } });
  f.hub.save(f.library);
  const source = { sourceUrl: "https://github.com/Example/Skills.git/", subpath: "skills/review" };
  const first = await f.hub.importSkill({ revision: 1, ...source });
  const id = first.imported.id;
  const repeated = await f.hub.importSkill({ revision: 2, ...source });
  assert.equal(inspections, 1); assert.equal(repeated.revision, 2); assert.equal(repeated.imported.id, id); assert.equal(repeated.imported.status, "existing");
  const canonical = await f.hub.importSkill({ revision: 2, sourceUrl: "https://github.com/example/skills", subpath: "skills/review" });
  assert.equal(canonical.imported.id, id);
  f.hub.update({ revision: 2, kind: "profile", item: { id: "reviewer", skillIds: [id, "review"] } });
  const updated = await f.hub.importSkill({ revision: 3, ...source, updateId: id });
  assert.equal(updated.imported.status, "updated"); assert.equal(updated.imported.id, id); assert.equal(updated.skills.length, 2);
  assert.deepEqual(updated.profiles[0].skillIds, [id, "review"]);
  assert.equal(f.hub.state().skills.find(skill => skill.id === id).content, `${skillText}2`);
  assert.equal(f.hub.state().documents[0].content, f.library.documents[0].content);
  await assert.rejects(f.hub.importSkill({ revision: 4, ...source, subpath: "different", updateId: id }), /exact source/);
  await assert.rejects(f.hub.importSkill({ revision: 3, ...source, updateId: id }), /changed/);
});

test("simultaneous duplicate imports converge but cancelled imports and racing updates do not commit", async t => {
  let release;
  const wait = new Promise(resolve => { release = resolve; });
  const f = await fixture(t, { inspectSkill: async () => { await wait; return { name: "Imported", content: skillText, commit: "a".repeat(40) }; } });
  const source = { sourceUrl: "https://github.com/example/skills", subpath: "review" };
  const one = f.hub.importSkill({ revision: 0, ...source });
  const two = f.hub.importSkill({ revision: 0, ...source });
  release();
  const results = await Promise.all([one, two]);
  assert.equal(results[0].imported.id, results[1].imported.id); assert.equal(f.hub.state().skills.length, 1); assert.equal(f.hub.state().revision, 1);
  const update = f.hub.importSkill({ revision: 1, ...source, updateId: results[0].imported.id });
  f.hub.update({ revision: 1, kind: "skill", item: { id: results[0].imported.id, name: "Concurrent edit" } });
  await assert.rejects(update, /changed during import/);
  const cancellation = new AbortController();
  const cancelled = f.hub.importSkill({ revision: 2, ...source, subpath: "other" }, { signal: cancellation.signal });
  cancellation.abort();
  await assert.rejects(cancelled, /abort/i);
  assert.equal(f.hub.state().skills.length, 1); assert.equal(f.hub.state().revision, 2);
});

test("asset inspection is revision checked, UTF-8 boundary safe and page bounded", async t => {
  const f = await fixture(t);
  const text = "﻿" + "a".repeat(16379) + "世界" + "z".repeat(17000);
  f.hub.save({ ...f.library, skills: [{ ...f.library.skills[0], files: [...f.library.skills[0].files, { path: "references/large.txt", contentBase64: Buffer.from(text).toString("base64") }] }] });
  const first = f.hub.asset({ revision: 1, id: "review", path: "references/large.txt" });
  assert.equal(first.encoding, "utf8"); assert.ok(first.nextOffset <= 16384); assert.equal(first.hasMore, true);
  let content = first.content, offset = first.nextOffset;
  while (offset < first.bytes) {
    const page = f.hub.asset({ revision: 1, id: "review", path: first.path, offset });
    assert.ok(page.nextOffset > offset); assert.ok(Buffer.byteLength(page.content) <= 16384);
    content += page.content; offset = page.nextOffset;
  }
  assert.equal(content, text);
  assert.equal(f.hub.asset({ revision: 1, id: "review", path: "assets/data.bin" }).content, null);
  assert.throws(() => f.hub.asset({ revision: 1, id: "review", path: first.path, length: 65537 }), /64 KiB/);
  assert.throws(() => f.hub.asset({ revision: 1, id: "review", path: "../outside" }), /not found/);
  assert.throws(() => f.hub.asset({ revision: 0, id: "review", path: first.path }), /changed/);
});

test("router retains safe known import errors and forwards client disconnect cancellation", async t => {
  const f = await fixture(t, { inspectSkill: async () => { throw skillImportError("The selected skill folder does not exist at this commit.", 404, "SOURCE_NOT_FOUND"); } });
  const call = (hub, endpoint, input, res = new EventEmitter()) => {
    let output;
    const req = Readable.from([Buffer.from(JSON.stringify(input))]);
    req.headers = { "content-type": "application/json" }; req.method = "POST";
    const route = createAgentsHubRouter(hub, (_res, status, value) => { res.writableEnded = true; output = { status, value }; });
    const done = route(req, res, new URL(`http://localhost/agents-hub/${endpoint}`)).then(() => output);
    return { res, done };
  };
  const failure = await call(f.hub, "import-skill", { revision: 0, sourceUrl: "https://github.com/example/skills", subpath: "missing" }).done;
  assert.equal(failure.status, 404); assert.equal(failure.value.code, "SOURCE_NOT_FOUND"); assert.match(failure.value.error, /folder does not exist/);
  let started;
  const ready = new Promise(resolve => { started = resolve; });
  const cancelled = await fixture(t, { inspectSkill: async (_input, { signal }) => {
    started();
    await new Promise((resolve, reject) => signal.addEventListener("abort", () => reject(skillImportError("Skill import was cancelled.", 499, "IMPORT_CANCELLED")), { once: true }));
  } });
  const pending = call(cancelled.hub, "import-skill", { revision: 0, sourceUrl: "https://github.com/example/skills", subpath: "demo" });
  await ready; pending.res.emit("close");
  assert.equal((await pending.done).value.code, "IMPORT_CANCELLED");
  assert.equal(cancelled.hub.state().revision, 0);
});

test("large valid binary assets avoid regex stack overflow and oversized library saves fail before writing", async (t) => {
  const f = await fixture(t);
  const large = Buffer.alloc(4.5 * 1024 * 1024).toString("base64");
  const saved = f.hub.save({ ...f.library, skills: [{ ...f.library.skills[0], files: [{ path: "large.bin", contentBase64: large }] }] });
  assert.equal(saved.skills[0].files[0].contentBase64.length, large.length);
  const content = "x".repeat(1024 * 1024);
  assert.throws(() => f.hub.save({ revision: 1, documents: Array.from({ length: 64 }, (_, i) => ({ id: `doc-${i}`, name: "Document", framework: "claude", content })), profiles: [], skills: [] }), /storage limit/);
  assert.equal(createAgentsHub({ stateDir: f.stateDir }).state().revision, 1);
});

test("replacing the reviewed project directory cannot redirect an approved deployment", async (t) => {
  const f = await fixture(t);
  f.hub.save(f.library);
  const plan = await f.hub.preview({ profileId: "reviewer", host: "", cwd: f.cwd });
  await fs.rename(f.cwd, path.join(f.home, "original-project"));
  await fs.mkdir(f.cwd);
  const result = await f.hub.apply(plan.previewId, "sync");
  assert.equal(result.status, "failed");
  assert.match(result.error, /directory was replaced/);
  assert.deepEqual(await fs.readdir(f.cwd), []);
});


test("global discovery reads live content and timestamps without importing or scanning projects", async t => {
  const f = await fixture(t);
  await fs.mkdir(path.join(f.home, ".claude"));
  await fs.mkdir(path.join(f.home, ".codex"));
  await fs.writeFile(path.join(f.home, "AGENTS.md"), "Home guidance");
  await fs.writeFile(path.join(f.home, ".claude/CLAUDE.md"), "Personal guidance");
  await fs.writeFile(path.join(f.home, ".codex/AGENTS.md"), "Agent guidance");
  await fs.writeFile(path.join(f.cwd, "CLAUDE.md"), "Do not discover projects");
  await fs.symlink(path.join(f.cwd, "CLAUDE.md"), path.join(f.home, "CLAUDE.md"));
  const input = { devices: [{ host: "", name: "Local" }] };
  const found = await f.hub.globalDiscover(input);
  assert.deepEqual(found.devices[0].files.map(file => file.path).sort(), [".claude/CLAUDE.md", ".codex/AGENTS.md", "AGENTS.md"]);
  assert.match(found.devices[0].error, /CLAUDE.md/);
  const file = found.devices[0].files.find(file => file.path === ".claude/CLAUDE.md");
  assert.equal(file.content, "Personal guidance");
  assert.equal(file.modifiedAt, Math.floor((await fs.stat(path.join(f.home, file.path))).mtimeMs));
  assert.match(file.sha256, /^[a-f0-9]{64}$/);
  assert.equal(f.hub.state().revision, 0);
  assert.deepEqual(f.hub.state().documents, []);
  await fs.writeFile(path.join(f.home, ".claude/CLAUDE.md"), "Changed on device");
  const again = await f.hub.globalDiscover(input);
  assert.equal(again.devices[0].files.find(item => item.path === file.path).content, "Changed on device");
  assert.equal(f.hub.state().revision, 0);
});

test("instruction-only sync copies identical bytes and preserves existing destination backups", async t => {
  const f = await fixture(t);
  const content = "# Exact instruction\n\nKeep original spacing.\n";
  f.hub.save({ ...f.library, documents: [{ ...f.library.documents[0], content }] });
  const second = path.join(f.home, "second");
  await fs.mkdir(second);
  for (const cwd of [f.cwd, second]) {
    await fs.writeFile(path.join(cwd, "CLAUDE.md"), "Previous guidance");
    const preview = await f.hub.preview({ documentId: "base", host: "", cwd, adoptExisting: true });
    assert.equal(preview.files[0].content, content);
    assert.equal(preview.launch.supported, false);
    await assert.rejects(f.hub.apply(preview.previewId, "deploy"), /only support sync/);
    const result = await f.hub.apply(preview.previewId, "sync");
    assert.equal(result.status, "synced", result.error);
    assert.ok(result.backupPath);
    assert.equal(await fs.readFile(path.join(cwd, "CLAUDE.md"), "utf8"), content);
  }
});


async function globalFixture(t, options = {}) {
  const f = await fixture(t);
  const homes = { "": f.home, alpha: path.join(f.directory, "alpha-home"), beta: path.join(f.directory, "beta-home") };
  await Promise.all(Object.values(homes).map(home => fs.mkdir(home, { recursive: true })));
  const target = async (host, payload) => {
    if (!Object.hasOwn(homes, host)) throw new Error("Device offline");
    return runHubTarget("", payload, { env: { ...f.env, HOME: homes[host] } });
  };
  const hub = createAgentsHub({ stateDir: f.stateDir, target, ...options });
  return { ...f, hub, homes, target };
}

async function sourceFile(hub, host = "", name = "CLAUDE.md") {
  const discovered = await hub.globalDiscover({ devices: [{ host, name: "Source" }] });
  const file = discovered.devices[0].files.find(file => file.path === name);
  return { host, path: name, sha256: file.sha256 };
}

test("global sync previews exact content, keeps durable backups and replays idempotently", async t => {
  const f = await globalFixture(t);
  const content = "# Chosen source\n\nPreserve spacing and UTF-8: café.\n";
  await fs.writeFile(path.join(f.home, "CLAUDE.md"), content);
  await fs.writeFile(path.join(f.homes.alpha, "CLAUDE.md"), "Previous alpha guidance");
  const input = { source: await sourceFile(f.hub), targets: [{ host: "alpha", path: "CLAUDE.md" }, { host: "beta", path: ".claude/CLAUDE.md" }, { host: "", path: "CLAUDE.md" }] };
  const preview = await f.hub.globalPreview(input);
  assert.equal(preview.source.content, content);
  assert.equal(preview.targets[0].previousContent, "Previous alpha guidance");
  assert.equal(preview.targets[1].previousContent, null);
  assert.equal(preview.targets[2].status, "unchanged");
  assert.equal(await fs.readFile(path.join(f.homes.alpha, "CLAUDE.md"), "utf8"), "Previous alpha guidance");
  const [first, concurrent] = await Promise.all([f.hub.globalSync({ previewId: preview.previewId }), f.hub.globalSync({ previewId: preview.previewId })]);
  assert.deepEqual(concurrent, first);
  assert.deepEqual(first.results.map(result => result.status), ["synced", "synced", "unchanged"]);
  assert.equal(await fs.readFile(path.join(first.results[0].backupPath, "files/CLAUDE.md"), "utf8"), "Previous alpha guidance");
  assert.equal((await fs.stat(first.results[0].backupPath)).mode & 0o777, 0o700);
  assert.equal(await fs.readFile(path.join(f.homes.alpha, "CLAUDE.md"), "utf8"), content);
  assert.equal(await fs.readFile(path.join(f.homes.beta, ".claude/CLAUDE.md"), "utf8"), content);
  assert.deepEqual(await f.hub.globalSync({ previewId: preview.previewId }), first);
  assert.equal(f.hub.state().revision, 0);
});

test("global source changes invalidate selection and every pending target", async t => {
  const f = await globalFixture(t);
  await fs.writeFile(path.join(f.home, "CLAUDE.md"), "First source");
  const source = await sourceFile(f.hub);
  await fs.writeFile(path.join(f.home, "CLAUDE.md"), "Changed source");
  await assert.rejects(f.hub.globalPreview({ source, targets: [{ host: "alpha", path: "CLAUDE.md" }] }), /Source changed/);
  const preview = await f.hub.globalPreview({ source: await sourceFile(f.hub), targets: [{ host: "alpha", path: "CLAUDE.md" }, { host: "beta", path: "CLAUDE.md" }] });
  await fs.writeFile(path.join(f.home, "CLAUDE.md"), "Changed after preview");
  const result = await f.hub.globalSync({ previewId: preview.previewId });
  assert.ok(result.results.every(item => item.status === "failed" && /Source changed/.test(item.error)));
  for (const home of [f.homes.alpha, f.homes.beta]) await assert.rejects(fs.stat(path.join(home, "CLAUDE.md")), { code: "ENOENT" });
});

test("global sync reports stale and offline destinations while completing safe copies", async t => {
  const f = await globalFixture(t);
  await fs.writeFile(path.join(f.home, "CLAUDE.md"), "Chosen source");
  await fs.writeFile(path.join(f.homes.alpha, "CLAUDE.md"), "Old alpha");
  const preview = await f.hub.globalPreview({ source: await sourceFile(f.hub), targets: [{ host: "alpha", path: "CLAUDE.md" }, { host: "offline", path: "CLAUDE.md" }, { host: "beta", path: "CLAUDE.md" }] });
  assert.equal(preview.targets[1].status, "failed");
  await fs.writeFile(path.join(f.homes.alpha, "CLAUDE.md"), "Unreviewed alpha edit");
  const result = await f.hub.globalSync({ previewId: preview.previewId });
  assert.deepEqual(result.results.map(item => item.status), ["failed", "failed", "synced"]);
  assert.equal(await fs.readFile(path.join(f.homes.alpha, "CLAUDE.md"), "utf8"), "Unreviewed alpha edit");
  assert.equal(await fs.readFile(path.join(f.homes.beta, "CLAUDE.md"), "utf8"), "Chosen source");
});

test("global preview refuses arbitrary paths, cross-framework targets and symlink escapes", async t => {
  const f = await globalFixture(t);
  await fs.writeFile(path.join(f.home, "CLAUDE.md"), "Source");
  const source = await sourceFile(f.hub);
  for (const name of ["project/CLAUDE.md", "../CLAUDE.md", "/tmp/CLAUDE.md", ".ssh/config", "AGENTS.md"]) {
    await assert.rejects(f.hub.globalPreview({ source, targets: [{ host: "alpha", path: name }] }), /allowed|same framework/);
  }
  await fs.symlink(f.cwd, path.join(f.homes.alpha, ".claude"));
  const preview = await f.hub.globalPreview({ source, targets: [{ host: "alpha", path: ".claude/CLAUDE.md" }] });
  assert.equal(preview.targets[0].status, "failed");
  assert.equal((await f.hub.globalSync({ previewId: preview.previewId })).results[0].status, "failed");
  assert.deepEqual(await fs.readdir(f.cwd), []);
  const rejected = await f.target("", { operation: "global-write", path: "project/CLAUDE.md", content: "Wrong", baselineSha256: null, baselineMode: null });
  assert.equal(rejected.ok, false);
  assert.deepEqual(await fs.readdir(f.cwd), []);
});

test("global previews expire before applying", async t => {
  let timestamp = 1;
  const f = await globalFixture(t, { now: () => timestamp });
  await fs.writeFile(path.join(f.home, "CLAUDE.md"), "Source");
  const preview = await f.hub.globalPreview({ source: await sourceFile(f.hub), targets: [{ host: "alpha", path: "CLAUDE.md" }] });
  timestamp = preview.expiresAt;
  await assert.rejects(f.hub.globalSync({ previewId: preview.previewId }), /expired/);
  await assert.rejects(fs.stat(path.join(f.homes.alpha, "CLAUDE.md")), { code: "ENOENT" });
});


test("global sync rereads the source between device writes", async t => {
  const f = await globalFixture(t);
  await fs.writeFile(path.join(f.home, "CLAUDE.md"), "Reviewed source");
  let written = false;
  const hub = createAgentsHub({ stateDir: f.stateDir, target: async (host, payload) => {
    const result = await f.target(host, payload);
    if (!written && payload.operation === "global-write") {
      written = true;
      await fs.writeFile(path.join(f.home, "CLAUDE.md"), "Source changed during sync");
    }
    return result;
  } });
  const preview = await hub.globalPreview({ source: await sourceFile(hub), targets: [{ host: "alpha", path: "CLAUDE.md" }, { host: "beta", path: "CLAUDE.md" }] });
  const result = await hub.globalSync({ previewId: preview.previewId });
  assert.deepEqual(result.results.map(item => item.status), ["synced", "failed"]);
  assert.equal(await fs.readFile(path.join(f.homes.alpha, "CLAUDE.md"), "utf8"), "Reviewed source");
  await assert.rejects(fs.stat(path.join(f.homes.beta, "CLAUDE.md")), { code: "ENOENT" });
});

test("a destination replaced by a symlink after global preview is never followed", async t => {
  const f = await globalFixture(t);
  await fs.writeFile(path.join(f.home, "CLAUDE.md"), "Source");
  const outside = path.join(f.cwd, "untouched.md");
  await fs.writeFile(outside, "Keep outside content");
  const preview = await f.hub.globalPreview({ source: await sourceFile(f.hub), targets: [{ host: "alpha", path: "CLAUDE.md" }] });
  await fs.symlink(outside, path.join(f.homes.alpha, "CLAUDE.md"));
  const result = await f.hub.globalSync({ previewId: preview.previewId });
  assert.equal(result.results[0].status, "failed");
  assert.equal(await fs.readFile(outside, "utf8"), "Keep outside content");
  assert.ok((await fs.lstat(path.join(f.homes.alpha, "CLAUDE.md"))).isSymbolicLink());
});

test("global backups remain available beyond project backup retention", async t => {
  const f = await globalFixture(t);
  await fs.writeFile(path.join(f.home, "CLAUDE.md"), "Original guidance");
  const backups = [];
  for (let index = 0; index < 11; index++) {
    const previous = await f.target("", { operation: "global-read", path: "CLAUDE.md" });
    const result = await f.target("", { operation: "global-write", path: "CLAUDE.md", baselineSha256: previous.sha256, baselineMode: previous.mode, content: `Guidance ${index}` });
    assert.equal(result.ok, true, result.error);
    backups.push(result.backupPath);
  }
  assert.equal(await fs.readFile(path.join(backups[0], "files/CLAUDE.md"), "utf8"), "Original guidance");
  assert.equal((await fs.readdir(path.dirname(backups[0]))).length, 11);
});
