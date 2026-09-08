import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createAgentsHub, runHubTarget } from "../lib/agents-hub.js";

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
  assert.equal(imported.skills[1].files[0].contentBase64, "AA==");
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


test("instruction discovery is bounded, read-only and refuses symlink escapes", async t => {
  const f = await fixture(t);
  await fs.writeFile(path.join(f.cwd, "CLAUDE.md"), "Existing project guidance\n");
  await fs.mkdir(path.join(f.cwd, ".cursor/rules"), { recursive: true });
  await fs.writeFile(path.join(f.cwd, ".cursor/rules/style.mdc"), "---\nalwaysApply: true\n---\nRules\n");
  await fs.mkdir(path.join(f.cwd, "node_modules/hidden"), { recursive: true });
  await fs.writeFile(path.join(f.cwd, "node_modules/hidden/AGENTS.md"), "Ignore dependency");
  await fs.symlink(path.join(f.cwd, "CLAUDE.md"), path.join(f.cwd, "AGENTS.md"));
  const found = await f.hub.discover({ root: "~/project", devices: [{ host: "", name: "Local" }] });
  assert.deepEqual(found.devices[0].files.map(file => file.path).sort(), [".cursor/rules/style.mdc", "CLAUDE.md"]);
  const file = found.devices[0].files.find(file => file.path === "CLAUDE.md");
  const imported = await f.hub.readInstruction({ host: "", root: "~/project", path: file.path, sha256: file.sha256 });
  assert.equal(imported.content, "Existing project guidance\n");
  assert.equal(f.hub.state().revision, 0);
  await fs.writeFile(path.join(f.cwd, "CLAUDE.md"), "Changed after discovery");
  await assert.rejects(f.hub.readInstruction({ host: "", root: "~/project", path: file.path, sha256: file.sha256 }), /changed/);
  const denied = await f.hub.discover({ root: "~", devices: [{ host: "", name: "Local" }] });
  assert.match(denied.devices[0].error, /project folder/);
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
