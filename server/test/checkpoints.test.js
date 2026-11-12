import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access, lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  CHECKPOINT_LIMITS, CHECKPOINT_PRELUDE, captureCheckpoint, checkpointDiff, runCheckpointScript, checkpointFiles, checkpointsRouter, listCheckpoints, parseCheckpointFiles,
  previewCheckpointRestore, restoreCheckpoint, validateCheckpointCaptureRequest, validateCheckpointDiffRequest, validateCheckpointRestoreRequest,
} from "../lib/checkpoints.js";

const run = promisify(execFile);

async function tempDir(t, prefix) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeRepo(dir) {
  await mkdir(dir, { recursive: true });
  const git = async (...args) => (await run("git", ["-C", dir, ...args], { timeout: 20000, maxBuffer: 8 * 1024 * 1024 })).stdout;
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.test");
  await git("config", "commit.gpgsign", "false");
  await writeFile(path.join(dir, ".gitignore"), "*.log\nbuild/\n");
  await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\n");
  await mkdir(path.join(dir, "src"));
  await writeFile(path.join(dir, "src", "b.txt"), "bee\n");
  await git("add", ".");
  await git("commit", "-q", "-m", "init");
  return git;
}

const exists = (file) => access(file).then(() => true, () => false);
const linkExists = (file) => lstat(file).then(() => true, () => false);
// The pid of a process that has already exited.
const deadPid = async () => (await run("sh", ["-c", "sh -c 'echo $$'"])).stdout.trim();

// Everything a checkpoint must never change: the index (as a tree), the
// status, the stash, the branch and HEAD.
async function userState(git) {
  return {
    index: (await git("ls-files", "-s", "--debug")).replace(/^\s+(ctime|mtime|dev|uid|size|flags).*$/gm, ""),
    status: await git("status", "--porcelain=v1", "--untracked-files=all"),
    stash: await git("stash", "list"),
    branch: await git("symbolic-ref", "-q", "HEAD"),
    head: await git("rev-parse", "HEAD"),
    branches: await git("for-each-ref", "refs/heads", "refs/tags", "refs/remotes"),
  };
}

// Stands in for ssh: runs the exact remote command string with a local shell.
function shellDevice() {
  const calls = [];
  const execImpl = (cmd, args, options, callback) => {
    calls.push({ cmd, args });
    execFile("sh", ["-c", args[args.length - 1]], options, callback);
  };
  return { calls, execImpl };
}

async function restore(target, id, mode) {
  const preview = await previewCheckpointRestore({ ...target, id, mode });
  return { preview, result: await restoreCheckpoint({ ...target, id, mode, expect: preview.expect }) };
}

test("a capture holds tracked and untracked files, leaves ignored ones out and never touches the index, stash or branch", async (t) => {
  const dir = await tempDir(t, "pzza-cp-capture-");
  const git = await makeRepo(dir);
  await writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\n");
  await git("add", "a.txt");
  await writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
  await writeFile(path.join(dir, "notes.md"), "draft\n");
  await writeFile(path.join(dir, "debug.log"), "secret log\n");
  await mkdir(path.join(dir, "build"));
  await writeFile(path.join(dir, "build", "out.js"), "built\n");
  await writeFile(path.join(dir, "stash-me.txt"), "x\n");
  await git("stash", "push", "-q", "-u", "--", "stash-me.txt");
  const before = await userState(git);

  const first = await captureCheckpoint({ host: "", path: path.join(dir, "src"), kind: "turn", agent: "claude", session: "alpha", summary: "Added notes" });
  assert.equal(first.created, true);
  assert.equal(first.id, 1);
  assert.equal(first.root, dir);
  assert.deepEqual(await userState(git), before, "index, status, stash, branch and HEAD are unchanged");

  const refs = (await git("for-each-ref", "--format=%(refname)", "refs/pzzacode/")).trim().split("\n");
  assert.equal(refs.length, 1);
  assert.match(refs[0], /^refs\/pzzacode\/checkpoints\/[0-9a-f]{16}\/00000001$/);
  const files = (await git("ls-tree", "-r", "--name-only", refs[0])).trim().split("\n");
  assert.deepEqual(files.sort(), [".gitignore", "a.txt", "notes.md", "src/b.txt"]);
  assert.equal(await git("show", `${refs[0]}:a.txt`), "one\nTWO\nthree\nfour\n", "working tree content, not the staged one");
  assert.equal((await git("rev-parse", `${refs[0]}^`)).trim(), before.head.trim(), "parented on HEAD");
  assert.equal(await git("reflog", "show", refs[0]).catch(() => ""), "", "no reflog keeps pruned checkpoints alive");

  const { checkpoints } = await listCheckpoints({ host: "", path: dir });
  assert.equal(checkpoints.length, 1);
  assert.deepEqual({ ...checkpoints[0], commit: "", time: 0 }, {
    id: 1, commit: "", time: 0, kind: "turn", summary: "Added notes", agent: "claude", session: "alpha", branch: "main", files: 2, added: 3, removed: 1, skipped: 0,
  });

  const skipped = await captureCheckpoint({ host: "", path: dir, kind: "turn" });
  assert.deepEqual({ id: skipped.id, created: skipped.created }, { id: 1, created: false }, "unchanged since the last checkpoint: nothing saved");
  await writeFile(path.join(dir, "other.log"), "ignored changes do not count\n");
  assert.equal((await captureCheckpoint({ host: "", path: dir, kind: "turn" })).created, false);
  assert.deepEqual(await userState(git).then((state) => state.index), before.index);
});

test("a turn that changed nothing since HEAD is not saved, a baseline is, and large untracked files are left out", async (t) => {
  const dir = await tempDir(t, "pzza-cp-skip-");
  const git = await makeRepo(dir);
  assert.deepEqual(await captureCheckpoint({ host: "", path: dir, kind: "turn" }), { id: null, created: false, relabelled: false, skipped: 0, root: dir });
  const baseline = await captureCheckpoint({ host: "", path: dir, kind: "start", agent: "codex" });
  assert.equal(baseline.created, true);
  await writeFile(path.join(dir, "huge.bin"), Buffer.alloc(CHECKPOINT_LIMITS.bigFileBytes + 1));
  await writeFile(path.join(dir, "small.txt"), "fine\n");
  const next = await captureCheckpoint({ host: "", path: dir, kind: "turn" });
  assert.equal(next.skipped, 1);
  const names = await git("ls-tree", "-r", "--name-only", (await git("for-each-ref", "--sort=-refname", "--count=1", "--format=%(refname)", "refs/pzzacode/")).trim());
  assert.ok(names.includes("small.txt") && !names.includes("huge.bin"));
  const { checkpoints } = await listCheckpoints({ host: "", path: dir });
  assert.deepEqual(checkpoints.map((entry) => [entry.id, entry.kind, entry.skipped]), [[2, "turn", 1], [1, "start", 0]]);
  // A restore never deletes the skipped file: it is in neither snapshot.
  await restore({ host: "", path: dir }, 1, "restore");
  assert.ok(await exists(path.join(dir, "huge.bin")));
  assert.ok(!(await exists(path.join(dir, "small.txt"))));
});

test("a checkpoint counts every change since the one before it: edits, new untracked files, deletions, renames and binary files", async (t) => {
  const dir = await tempDir(t, "pzza-cp-counts-");
  const git = await makeRepo(dir);
  await writeFile(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3]));
  await git("add", "logo.png");
  await git("commit", "-q", "-m", "logo");
  assert.equal((await captureCheckpoint({ host: "", path: dir, kind: "start", agent: "claude" })).created, true);
  // One turn's worth of changes of every kind, all left uncommitted.
  await writeFile(path.join(dir, "a.txt"), "one\nTWO\nthree\nfour\n");
  await writeFile(path.join(dir, "src", "useAutoGrow.ts"), "export const grow = 1;\nexport const shrink = 2;\n");
  await mkdir(path.join(dir, "scripts"));
  await writeFile(path.join(dir, "scripts", "smoke.mjs"), "run();\n");
  await run("mv", [path.join(dir, "src", "b.txt"), path.join(dir, "src", "bee.txt")]);
  await writeFile(path.join(dir, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 9, 9, 9]));
  // Ignored output is left out by design.
  await writeFile(path.join(dir, "debug.log"), "log\n");
  await mkdir(path.join(dir, "build"));
  await writeFile(path.join(dir, "build", "out.js"), "built\n");
  const turn = await captureCheckpoint({ host: "", path: dir, kind: "turn", summary: "Every kind of change" });
  assert.equal(turn.created, true);

  const { checkpoints } = await listCheckpoints({ host: "", path: dir });
  const listed = checkpoints.find((entry) => entry.id === turn.id);
  const files = await checkpointFiles({ host: "", path: dir, id: turn.id, against: "previous" });
  assert.equal(files.previous, 1, "measured from the checkpoint before it");
  assert.deepEqual(files.files.map((file) => [file.path, file.status, file.added, file.removed, file.binary]).sort(), [
    ["a.txt", "modified", 2, 1, false],
    ["logo.png", "modified", null, null, true],
    ["scripts/smoke.mjs", "added", 1, 0, false],
    ["src/b.txt", "deleted", 0, 1, false],
    ["src/bee.txt", "added", 1, 0, false],
    ["src/useAutoGrow.ts", "added", 2, 0, false],
  ]);
  // The timeline's numbers are the same comparison: a rename counts as the
  // file it removed and the file it added, a binary file with no lines.
  assert.deepEqual({ files: listed.files, added: listed.added, removed: listed.removed }, { files: 6, added: 6, removed: 2 });
  const [from, to] = [(await git("rev-parse", `${listed.commit}^{tree}`)).trim(), files.to];
  assert.equal(from, to);
});

test("the agent's message names the turn checkpoint saved without it, only for that same unchanged turn", async (t) => {
  const dir = await tempDir(t, "pzza-cp-relabel-");
  const git = await makeRepo(dir);
  const target = { host: "", path: dir };
  await captureCheckpoint({ ...target, kind: "start", agent: "claude" });
  await writeFile(path.join(dir, "notes.md"), "draft\n");
  // The output watch saves the finished turn before the agent's message arrives.
  const watched = await captureCheckpoint({ ...target, kind: "turn", agent: "claude", session: "alpha" });
  assert.deepEqual({ id: watched.id, created: watched.created, relabelled: watched.relabelled }, { id: 2, created: true, relabelled: false });
  const before = (await listCheckpoints(target)).checkpoints[0];
  assert.equal(before.summary, "Turn finished");

  // Its message arrives later, naming that checkpoint: it is renamed in place.
  const named = await captureCheckpoint({ ...target, kind: "turn", agent: "claude", session: "alpha", summary: "Added the notes file", relabel: 2 });
  assert.deepEqual({ id: named.id, created: named.created, relabelled: named.relabelled }, { id: 2, created: false, relabelled: true });
  const after = (await listCheckpoints(target)).checkpoints;
  assert.equal(after.length, 2, "no second checkpoint for the same turn");
  assert.deepEqual({ ...after[0], commit: "" }, { ...before, commit: "", summary: "Added the notes file" }, "same time, kind, agent and counts");
  const [oldTree, newTree] = await Promise.all([before.commit, after[0].commit].map(async (commit) => (await git("rev-parse", `${commit}^{tree}`)).trim()));
  assert.equal(newTree, oldTree);
  assert.equal((await git("rev-parse", `${after[0].commit}^`)).trim(), (await git("rev-parse", `${before.commit}^`)).trim());

  // A labelled checkpoint is never renamed again.
  const again = await captureCheckpoint({ ...target, kind: "turn", summary: "Something else", relabel: 2 });
  assert.equal(again.relabelled, false);
  assert.equal((await listCheckpoints(target)).checkpoints[0].summary, "Added the notes file");

  // Files that changed since: the message gets a checkpoint of its own and
  // the unlabelled one keeps its default name.
  await writeFile(path.join(dir, "more.md"), "more\n");
  const plain = await captureCheckpoint({ ...target, kind: "turn" });
  await writeFile(path.join(dir, "later.md"), "later\n");
  const newer = await captureCheckpoint({ ...target, kind: "turn", summary: "Wrote later.md", relabel: plain.id });
  assert.deepEqual({ created: newer.created, relabelled: newer.relabelled }, { created: true, relabelled: false });
  const summaries = (await listCheckpoints(target)).checkpoints.map((entry) => [entry.id, entry.summary]);
  assert.deepEqual(summaries.slice(0, 2), [[newer.id, "Wrote later.md"], [plain.id, "Turn finished"]]);

  // A checkpoint that is no longer the newest is left alone.
  const stale = await captureCheckpoint({ ...target, kind: "turn", summary: "Too late", relabel: plain.id });
  assert.equal(stale.relabelled, false);
  assert.equal((await listCheckpoints(target)).checkpoints.find((entry) => entry.id === plain.id).summary, "Turn finished");

  // Only a turn with a message can rename one.
  assert.throws(() => validateCheckpointCaptureRequest({ host: "", path: dir, kind: "start", summary: "x", relabel: 2 }), /Only a turn/);
  assert.throws(() => validateCheckpointCaptureRequest({ host: "", path: dir, kind: "turn", relabel: 2 }), /Only a turn/);
  assert.throws(() => validateCheckpointCaptureRequest({ host: "", path: dir, kind: "turn", summary: "x", relabel: "2" }), /Choose a checkpoint/);
  assert.equal(validateCheckpointCaptureRequest({ host: "", path: dir, kind: "turn", summary: "x", relabel: 2 }).relabel, 2);
});

test("only the newest checkpoints are kept and pruned refs are gone", async (t) => {
  assert.equal(CHECKPOINT_LIMITS.keep, 50, "the default retention per worktree");
  const dir = await tempDir(t, "pzza-cp-prune-");
  const git = await makeRepo(dir);
  // A small limit keeps the test fast; the script logic is the same.
  const keep = 4;
  for (let index = 0; index < keep + 3; index += 1) {
    await writeFile(path.join(dir, "a.txt"), `version ${index}\n`);
    assert.equal((await captureCheckpoint({ host: "", path: dir, kind: "turn" }, { keep })).created, true);
  }
  const refs = (await git("for-each-ref", "--format=%(refname:lstrip=-1)", "refs/pzzacode/")).trim().split("\n");
  assert.deepEqual(refs, ["00000004", "00000005", "00000006", "00000007"], "the three oldest were pruned");
  const { checkpoints } = await listCheckpoints({ host: "", path: dir });
  assert.deepEqual(checkpoints.map((entry) => entry.id), [7, 6, 5, 4]);
  await assert.rejects(previewCheckpointRestore({ host: "", path: dir, id: 2, mode: "restore" }), { status: 404 });
  // Pruned checkpoints leave no ref or reflog behind, so gc can drop them.
  await git("gc", "-q", "--prune=now");
  assert.deepEqual((await git("for-each-ref", "--format=%(refname:lstrip=-1)", "refs/pzzacode/")).trim().split("\n"), refs);
  assert.equal((await git("rev-list", "--all")).trim().split("\n").length, 5, "HEAD plus the four kept checkpoints");
});

test("restore brings a checkpoint back, removes only files created since, and the restore itself can be undone", async (t) => {
  const dir = await tempDir(t, "pzza-cp-restore-");
  const outside = await tempDir(t, "pzza-cp-outside-");
  const git = await makeRepo(dir);
  const target = { host: "", path: dir };
  await writeFile(path.join(outside, "keep.txt"), "outside\n");
  await symlink(outside, path.join(dir, "outside-link"));
  await writeFile(path.join(dir, "a.txt"), "one\nturn one\n");
  await writeFile(path.join(dir, "early.txt"), "existed at checkpoint\n");
  const one = await captureCheckpoint({ ...target, kind: "turn", summary: "Turn one" });
  await git("add", "a.txt");
  const staged = (await userState(git)).index;

  // Turn two: edits, a new nested file, a deletion, an ignored file.
  await writeFile(path.join(dir, "a.txt"), "rewritten\n");
  await mkdir(path.join(dir, "src", "deep"), { recursive: true });
  await writeFile(path.join(dir, "src", "deep", "new.ts"), "export {};\n");
  await rm(path.join(dir, "src", "b.txt"));
  await rm(path.join(dir, "early.txt"));
  await writeFile(path.join(dir, "trace.log"), "ignored, created later\n");
  await mkdir(path.join(dir, "build"));
  await writeFile(path.join(dir, "build", "cache.bin"), "ignored dir\n");
  const two = await captureCheckpoint({ ...target, kind: "turn", summary: "Turn two" });
  await writeFile(path.join(dir, "after.txt"), "made after the last checkpoint\n");

  const { preview, result } = await restore(target, one.id, "restore");
  assert.deepEqual(preview.files.map((file) => `${file.action} ${file.path}`).sort(),
    ["create early.txt", "create src/b.txt", "delete after.txt", "delete src/deep/new.ts", "modify a.txt"]);
  assert.equal(preview.applies, true);
  assert.equal(result.backup, two.id + 1, "the state before the restore is saved first");
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "one\nturn one\n");
  assert.equal(await readFile(path.join(dir, "early.txt"), "utf8"), "existed at checkpoint\n");
  assert.equal(await readFile(path.join(dir, "src", "b.txt"), "utf8"), "bee\n");
  assert.ok(!(await exists(path.join(dir, "after.txt"))), "created after the checkpoint: removed");
  assert.ok(!(await exists(path.join(dir, "src", "deep"))), "emptied folders go too");
  assert.ok(await exists(path.join(dir, "trace.log")), "ignored files are never deleted");
  assert.ok(await exists(path.join(dir, "build", "cache.bin")));
  assert.equal(await readFile(path.join(outside, "keep.txt"), "utf8"), "outside\n", "nothing outside the repository changes");
  assert.equal((await userState(git)).index, staged, "the index is untouched by a restore");

  // Undo the restore: back to exactly where it started.
  await restore(target, result.backup, "restore");
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "rewritten\n");
  assert.equal(await readFile(path.join(dir, "after.txt"), "utf8"), "made after the last checkpoint\n");
  assert.equal(await readFile(path.join(dir, "src", "deep", "new.ts"), "utf8"), "export {};\n");
  assert.ok(!(await exists(path.join(dir, "early.txt"))) && !(await exists(path.join(dir, "src", "b.txt"))));
  assert.equal((await userState(git)).index, staged);
});

test("undo this turn reverts one turn's changes and keeps later ones, and refuses when they no longer apply", async (t) => {
  const dir = await tempDir(t, "pzza-cp-undo-");
  await makeRepo(dir);
  const target = { host: "", path: dir };
  await captureCheckpoint({ ...target, kind: "start" });
  await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\nturn one\n");
  await writeFile(path.join(dir, "made-by-one.txt"), "new\n");
  const one = await captureCheckpoint({ ...target, kind: "turn" });
  await writeFile(path.join(dir, "src", "b.txt"), "bee\nturn two\n");
  await captureCheckpoint({ ...target, kind: "turn" });

  const own = await checkpointFiles({ ...target, id: one.id, against: "previous" });
  assert.equal(own.previous, 1);
  assert.deepEqual(own.files, [
    { path: "a.txt", status: "modified", added: 1, removed: 0, binary: false },
    { path: "made-by-one.txt", status: "added", added: 1, removed: 0, binary: false },
  ]);
  const diff = await checkpointDiff({ ...target, from: own.from, to: own.to, file: "a.txt" });
  assert.deepEqual(diff, { before: "one\ntwo\nthree\n", after: "one\ntwo\nthree\nturn one\n", binary: false, truncated: false });
  const since = await checkpointFiles({ ...target, id: one.id, against: "now" });
  assert.deepEqual(since.files.map((file) => file.path), ["src/b.txt"]);

  const { preview, result } = await restore(target, one.id, "undo");
  assert.equal(preview.applies, true);
  assert.deepEqual(preview.files.map((file) => `${file.action} ${file.path}`), ["modify a.txt", "delete made-by-one.txt"]);
  assert.ok(result.backup > one.id);
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "one\ntwo\nthree\n");
  assert.ok(!(await exists(path.join(dir, "made-by-one.txt"))));
  assert.equal(await readFile(path.join(dir, "src", "b.txt"), "utf8"), "bee\nturn two\n", "the later turn stays");

  // Turn one's line was rewritten since: its reverse no longer applies.
  await writeFile(path.join(dir, "a.txt"), "one\ntwo\nthree\nturn one, edited again\n");
  await writeFile(path.join(dir, "made-by-one.txt"), "new\n");
  const stuck = await previewCheckpointRestore({ ...target, id: one.id, mode: "undo" });
  assert.equal(stuck.applies, false);
  assert.match(stuck.reason, /a\.txt/);
  await assert.rejects(restoreCheckpoint({ ...target, id: one.id, mode: "undo", expect: stuck.expect }), (error) => error.status === 409 && /no longer be undone/.test(error.message));
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "one\ntwo\nthree\nturn one, edited again\n", "a refused undo changes nothing");
});

test("restores are refused when files changed after the preview or an ignored file is in the way", async (t) => {
  const dir = await tempDir(t, "pzza-cp-refuse-");
  await makeRepo(dir);
  const target = { host: "", path: dir };
  // keep.log is not ignored when the first checkpoint is taken.
  await writeFile(path.join(dir, ".gitignore"), "build/\n");
  await writeFile(path.join(dir, "keep.log"), "not ignored at first\n");
  const one = await captureCheckpoint({ ...target, kind: "manual" });
  await rm(path.join(dir, "keep.log"));
  await writeFile(path.join(dir, ".gitignore"), "*.log\nbuild/\n");
  await writeFile(path.join(dir, "a.txt"), "changed\n");
  await captureCheckpoint({ ...target, kind: "turn" });

  const preview = await previewCheckpointRestore({ ...target, id: one.id, mode: "restore" });
  await writeFile(path.join(dir, "a.txt"), "the agent kept writing\n");
  await assert.rejects(restoreCheckpoint({ ...target, id: one.id, mode: "restore", expect: preview.expect }), { status: 409, message: /changed after the preview/ });
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "the agent kept writing\n");

  // keep.log is ignored now and exists again: restoring would overwrite it.
  await writeFile(path.join(dir, "keep.log"), "user data\n");
  const blocked = await previewCheckpointRestore({ ...target, id: one.id, mode: "restore" });
  assert.deepEqual(blocked.blocked, ["keep.log"]);
  assert.equal(blocked.applies, false);
  await assert.rejects(restoreCheckpoint({ ...target, id: one.id, mode: "restore", expect: blocked.expect }), { status: 409, message: /not in any checkpoint.*keep\.log/ });
  assert.equal(await readFile(path.join(dir, "keep.log"), "utf8"), "user data\n");

  const plain = await tempDir(t, "pzza-cp-plain-");
  await assert.rejects(captureCheckpoint({ host: "", path: plain, kind: "manual" }), { status: 400, message: /not inside a Git repository/ });
  await assert.rejects(previewCheckpointRestore({ ...target, id: 999, mode: "restore" }), { status: 404 });
});

test("linked worktrees keep their own timeline", async (t) => {
  const dir = await tempDir(t, "pzza-cp-main-");
  const git = await makeRepo(dir);
  const wt = path.join(path.dirname(dir), `${path.basename(dir)}-wt`);
  t.after(() => rm(wt, { recursive: true, force: true }));
  await git("worktree", "add", "-q", "-b", "feature", wt);
  const wtGit = async (...args) => (await run("git", ["-C", wt, ...args])).stdout;
  await writeFile(path.join(wt, "a.txt"), "worktree change\n");
  await writeFile(path.join(wt, "wt-only.txt"), "new\n");
  const before = await userState(wtGit);
  const mainBefore = await userState(git);
  const one = await captureCheckpoint({ host: "", path: wt, kind: "turn", summary: "In the worktree" });
  assert.equal(one.id, 1);
  assert.equal(one.root, await realpath(wt));
  assert.deepEqual(await userState(wtGit), before);
  assert.deepEqual(await userState(git), mainBefore);
  assert.equal((await listCheckpoints({ host: "", path: dir })).checkpoints.length, 0, "the main checkout has its own scope");
  const listed = await listCheckpoints({ host: "", path: wt });
  assert.deepEqual(listed.checkpoints.map((entry) => [entry.id, entry.summary, entry.branch]), [[1, "In the worktree", "feature"]]);
  await writeFile(path.join(wt, "a.txt"), "later\n");
  await restore({ host: "", path: wt }, 1, "restore");
  assert.equal(await readFile(path.join(wt, "a.txt"), "utf8"), "worktree change\n");
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "one\ntwo\nthree\n", "the main checkout is untouched");
});

test("checkpoint refs are never pushed", async (t) => {
  const dir = await tempDir(t, "pzza-cp-push-");
  const bare = await tempDir(t, "pzza-cp-bare-");
  const git = await makeRepo(dir);
  await run("git", ["init", "-q", "--bare", bare]);
  await git("remote", "add", "origin", bare);
  await git("push", "-q", "-u", "origin", "main");
  await writeFile(path.join(dir, "a.txt"), "agent work\n");
  await captureCheckpoint({ host: "", path: dir, kind: "turn" });
  await git("commit", "-qam", "more");
  for (const args of [["push", "--dry-run", "--porcelain"], ["push", "--dry-run", "--porcelain", "--all"], ["push", "--dry-run", "--porcelain", "--tags"], ["push", "--dry-run", "--porcelain", "origin"]]) {
    const out = (await run("git", ["-C", dir, ...args], { env: { ...process.env, LC_ALL: "C" } })).stdout;
    assert.doesNotMatch(out, /pzzacode/, `${args.join(" ")} sends no checkpoint ref`);
  }
  await git("push", "-q");
  assert.doesNotMatch((await run("git", ["ls-remote", bare])).stdout, /pzzacode/);
  assert.match(await git("for-each-ref", "refs/pzzacode/"), /checkpoints/, "the refs exist locally");
});

test("another device runs the same scripts over one ssh command with every argument quoted", async (t) => {
  const dir = await tempDir(t, "pzza-cp-remote-");
  await makeRepo(dir);
  const { calls, execImpl } = shellDevice();
  const target = { host: "devbox", path: dir };
  await writeFile(path.join(dir, "it's here.txt"), "quoted 'name'\n");
  const summary = "Fix `rm -rf /` $(touch pwned) 'quotes' \"double\"";
  const one = await captureCheckpoint({ ...target, kind: "turn", agent: "codex", session: "s; echo x", summary }, { execImpl });
  assert.equal(one.created, true);
  assert.equal(calls[0].cmd, "ssh");
  assert.ok(calls[0].args.includes("devbox"));
  assert.ok(!(await exists(path.join(dir, "pwned"))) && !(await exists("pwned")));
  const listed = await listCheckpoints(target, { execImpl });
  assert.equal(listed.checkpoints[0].summary, summary);
  assert.equal(listed.checkpoints[0].session, "s; echo x");
  await writeFile(path.join(dir, "it's here.txt"), "changed\n");
  const preview = await previewCheckpointRestore({ ...target, id: one.id, mode: "restore" }, { execImpl });
  assert.deepEqual(preview.files, [{ path: "it's here.txt", action: "modify" }]);
  await restoreCheckpoint({ ...target, id: one.id, mode: "restore", expect: preview.expect }, { execImpl });
  assert.equal(await readFile(path.join(dir, "it's here.txt"), "utf8"), "quoted 'name'\n");
});

test("concurrent captures from tiles in different folders of one repository never overwrite each other", async (t) => {
  const dir = await tempDir(t, "pzza-cp-race-");
  const git = await makeRepo(dir);
  const folders = [dir, path.join(dir, "src")];
  for (let round = 0; round < 3; round += 1) {
    await writeFile(path.join(dir, `f${round}.txt`), `${round}\n`);
    // Different folders are not queued together, so these really race.
    const results = await Promise.all(folders.flatMap((folder) => [
      captureCheckpoint({ host: "", path: folder, kind: "manual" }),
      captureCheckpoint({ host: "", path: folder, kind: "manual" }),
    ]));
    for (const result of results) assert.ok(result.id > 0);
  }
  const refs = (await git("for-each-ref", "--format=%(refname:lstrip=-1) %(objectname)", "refs/pzzacode/")).trim().split("\n");
  const ids = refs.map((line) => Number(line.split(" ")[0]));
  assert.deepEqual(ids, [...ids].sort((a, b) => a - b));
  assert.equal(new Set(ids).size, ids.length, "every saved checkpoint kept its own number");
  const trees = await Promise.all(refs.map((line) => git("rev-parse", `${line.split(" ")[1]}^{tree}`)));
  assert.ok(trees.length >= 3);
});

test("requests are validated before any Git runs", async () => {
  assert.throws(() => validateCheckpointCaptureRequest({ host: "", path: "/x", kind: "backup" }), /Unknown checkpoint kind/);
  assert.throws(() => validateCheckpointCaptureRequest({ host: "", path: "relative", kind: "turn" }), /absolute/);
  assert.throws(() => validateCheckpointCaptureRequest({ host: "-oProxyCommand=x", path: "/x", kind: "turn" }), /Invalid device host/);
  assert.throws(() => validateCheckpointCaptureRequest({ host: "", path: "/x", kind: "turn", agent: "Claude Code" }), /Invalid agent/);
  assert.throws(() => validateCheckpointCaptureRequest({ host: "", path: "/x", kind: "turn", ref: "refs/heads/main" }), /Unknown request field/);
  assert.equal(validateCheckpointCaptureRequest({ host: "", path: "/x", kind: "turn", summary: "line\none\u0007 " }).summary, "line one");
  assert.throws(() => validateCheckpointDiffRequest({ host: "", path: "/x", from: "a".repeat(40), to: "b".repeat(40), file: "../etc/passwd" }), /inside the repository/);
  assert.throws(() => validateCheckpointDiffRequest({ host: "", path: "/x", from: "HEAD", to: "b".repeat(40), file: "a" }), /Invalid comparison/);
  assert.throws(() => validateCheckpointRestoreRequest({ host: "", path: "/x", id: 1.5, mode: "restore", expect: "a".repeat(40) }), /Choose a checkpoint/);
  assert.throws(() => validateCheckpointRestoreRequest({ host: "", path: "/x", id: 1, mode: "restore" }), /Preview the restore first/);
  assert.throws(() => validateCheckpointRestoreRequest({ host: "", path: "/x", id: 1, mode: "reset", expect: "a".repeat(40) }), /restore or undo/);

  const responses = [];
  const json = (res, status, body) => responses.push([status, body]);
  const get = { method: "GET" };
  assert.equal(await checkpointsRouter(get, {}, new URL("http://x/git/checkpoints"), json), true);
  assert.equal(await checkpointsRouter(get, {}, new URL("http://x/git/other"), json), false);
  assert.deepEqual(responses, [[405, { error: "Use POST for checkpoint requests" }]]);
});

test("a cut-off file list drops its partial last entry", () => {
  const full = "M\u0000a.txt\u0000A\u0000b.txt\u0000";
  assert.deepEqual(parseCheckpointFiles(full, "1\t2\ta.txt\u0000-\t-\tb.txt\u0000").files, [
    { path: "a.txt", status: "modified", added: 1, removed: 2, binary: false },
    { path: "b.txt", status: "added", added: null, removed: null, binary: true },
  ]);
  const cut = `M\u0000a.txt\u0000A\u0000${"x".repeat(CHECKPOINT_LIMITS.listBytes)}`;
  const parsed = parseCheckpointFiles(cut, "");
  assert.equal(parsed.truncated, true);
  assert.deepEqual(parsed.files.map((file) => file.path), ["a.txt"]);
});

test("the routes validate the body, run the operation and answer JSON errors", async (t) => {
  const { Readable } = await import("node:stream");
  const dir = await tempDir(t, "pzza-cp-route-");
  await makeRepo(dir);
  const call = async (pathname, body) => {
    const req = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), { method: "POST", headers: {} });
    let answer;
    await checkpointsRouter(req, {}, new URL(`http://x${pathname}`), (res, status, payload) => { answer = [status, payload]; });
    return answer;
  };
  assert.deepEqual(await call("/git/checkpoints/capture", { host: "", path: dir, kind: "backup" }), [400, { error: "Unknown checkpoint kind." }]);
  const [status, saved] = await call("/git/checkpoints/capture", { host: "", path: dir, kind: "manual", summary: "From the route" });
  assert.equal(status, 200);
  assert.equal(saved.created, true);
  const [listed, list] = await call("/git/checkpoints", { host: "", path: dir });
  assert.equal(listed, 200);
  assert.equal(list.checkpoints[0].summary, "From the route");
  assert.deepEqual(await call("/git/checkpoints/preview", { host: "", path: dir, id: 42, mode: "restore" }), [404, { error: "That checkpoint no longer exists. It may have been pruned; the newest 50 are kept." }]);
  assert.deepEqual((await call("/git/checkpoints", { host: "", path: path.dirname(dir) }))[0], 400);
});

// ------------------------------------------------- data-loss regressions

const refs = async (git) => (await git("for-each-ref", "--format=%(refname:lstrip=-1)", "refs/pzzacode/")).trim().split("\n").filter(Boolean);

test("a restore never removes an ignored file or folder in the way of what it brings back", async (t) => {
  const dir = await tempDir(t, "pzza-cp-ignored-way-");
  const git = await makeRepo(dir);
  const target = { host: "", path: dir };
  // The checkpoint has a folder "secrets" and a file "cache"; both paths are
  // ignored now, as a file and as a folder holding ignored files.
  await mkdir(path.join(dir, "secrets"));
  await writeFile(path.join(dir, "secrets", "a.txt"), "x\n");
  await writeFile(path.join(dir, "cache"), "was a file\n");
  const one = await captureCheckpoint({ ...target, kind: "manual" });
  await rm(path.join(dir, "secrets"), { recursive: true });
  await rm(path.join(dir, "cache"));
  await writeFile(path.join(dir, ".gitignore"), "/secrets\n/cache/\n");
  await git("add", ".gitignore");
  await git("commit", "-qm", "ignore");
  await writeFile(path.join(dir, "secrets"), "API_KEY=only-copy\n");
  await mkdir(path.join(dir, "cache"));
  await writeFile(path.join(dir, "cache", "blob.bin"), "ignored data\n");
  const before = await refs(git);

  const preview = await previewCheckpointRestore({ ...target, id: one.id, mode: "restore" });
  assert.deepEqual(preview.blocked.sort(), ["cache", "secrets"]);
  assert.equal(preview.applies, false);
  await assert.rejects(restoreCheckpoint({ ...target, id: one.id, mode: "restore", expect: preview.expect }), (error) => error.status === 409 && /not in any checkpoint.*secrets/.test(error.message));
  assert.equal(await readFile(path.join(dir, "secrets"), "utf8"), "API_KEY=only-copy\n");
  assert.equal(await readFile(path.join(dir, "cache", "blob.bin"), "utf8"), "ignored data\n");
  assert.deepEqual(await refs(git), before, "a refused restore saves nothing and changes nothing");
});

test("a restore never removes a large untracked file that was left out of the snapshot", async (t) => {
  const dir = await tempDir(t, "pzza-cp-big-way-");
  await makeRepo(dir);
  const target = { host: "", path: dir };
  await mkdir(path.join(dir, "data"));
  await writeFile(path.join(dir, "data", "x"), "x\n");
  const one = await captureCheckpoint({ ...target, kind: "manual" });
  await rm(path.join(dir, "data"), { recursive: true });
  await writeFile(path.join(dir, "data"), Buffer.alloc(CHECKPOINT_LIMITS.bigFileBytes + 1, 1));
  assert.equal((await captureCheckpoint({ ...target, kind: "manual" })).skipped, 1);
  const preview = await previewCheckpointRestore({ ...target, id: one.id, mode: "restore" });
  assert.deepEqual(preview.blocked, ["data"]);
  await assert.rejects(restoreCheckpoint({ ...target, id: one.id, mode: "restore", expect: preview.expect }), { status: 409 });
  assert.equal((await readFile(path.join(dir, "data"))).length, CHECKPOINT_LIMITS.bigFileBytes + 1);
});

test("local edits to skip-worktree and assume-unchanged files are captured, so a restore keeps them in its backup", async (t) => {
  const dir = await tempDir(t, "pzza-cp-skipwt-");
  const git = await makeRepo(dir);
  const target = { host: "", path: dir };
  await writeFile(path.join(dir, "config.json"), "v1\n");
  await writeFile(path.join(dir, "flags.txt"), "f1\n");
  await git("add", ".");
  await git("commit", "-qm", "cfg");
  await writeFile(path.join(dir, "config.json"), "v-agent\n");
  const one = await captureCheckpoint({ ...target, kind: "manual" });
  await git("checkout", "--", "config.json");
  await git("update-index", "--skip-worktree", "config.json");
  await git("update-index", "--assume-unchanged", "flags.txt");
  await writeFile(path.join(dir, "config.json"), "v-local-only-copy\n");
  await writeFile(path.join(dir, "flags.txt"), "f-local\n");
  const bits = await git("ls-files", "-v");

  const now = await captureCheckpoint({ ...target, kind: "manual" });
  assert.equal(now.created, true, "the local edits count as a change");
  const last = (await refs(git)).pop();
  const ns = (await git("for-each-ref", "--format=%(refname)", "refs/pzzacode/")).trim().split("\n")[0].replace(/\/\d+$/, "");
  assert.equal(await git("show", `${ns}/${last}:config.json`), "v-local-only-copy\n");
  assert.equal(await git("show", `${ns}/${last}:flags.txt`), "f-local\n");

  const { result } = await restore(target, one.id, "restore");
  assert.equal(await readFile(path.join(dir, "config.json"), "utf8"), "v-agent\n");
  assert.equal(await git("show", `${ns}/${String(result.backup).padStart(8, "0")}:config.json`), "v-local-only-copy\n", "the backup holds the local edit");
  assert.equal(await git("ls-files", "-v"), bits, "the real index keeps its bits");
});

test("a case-only rename is restored on a case-insensitive file system", async (t) => {
  const dir = await tempDir(t, "pzza-cp-case-");
  const git = await makeRepo(dir);
  if ((await git("config", "--bool", "core.ignorecase").catch(() => "")).trim() !== "true") { t.skip("this file system is case-sensitive"); return; }
  const target = { host: "", path: dir };
  await writeFile(path.join(dir, "README.md"), "old\n");
  const one = await captureCheckpoint({ ...target, kind: "manual" });
  await rm(path.join(dir, "README.md"));
  await writeFile(path.join(dir, "Readme.md"), "new\n");
  await captureCheckpoint({ ...target, kind: "manual" });
  const { preview } = await restore(target, one.id, "restore");
  assert.deepEqual(preview.blocked, []);
  assert.equal(preview.applies, true);
  const { readdir } = await import("node:fs/promises");
  assert.ok((await readdir(dir)).includes("README.md"));
  assert.equal(await readFile(path.join(dir, "README.md"), "utf8"), "old\n");
});

test("captures and restores of one repository wait for each other across processes, and a dead owner's lock is taken over", async (t) => {
  const dir = await tempDir(t, "pzza-cp-lock-");
  const git = await makeRepo(dir);
  const lock = path.join(dir, ".git", "pzzacode-checkpoints.owner");
  await symlink(String(process.pid), lock);
  await writeFile(path.join(dir, "a.txt"), "changed\n");
  await assert.rejects(captureCheckpoint({ host: "", path: dir, kind: "manual" }, { lockWait: 1 }), { status: 409, message: /still running/ });
  assert.deepEqual(await refs(git), []);
  // A process that has exited cannot hold the lock.
  await rm(lock);
  await symlink(await deadPid(), lock);
  assert.equal((await captureCheckpoint({ host: "", path: dir, kind: "manual" }, { lockWait: 1 })).created, true);
  assert.ok(!(await linkExists(lock)), "the lock is released");
});

test("waiters that find the same dead owner take the lock one at a time", async (t) => {
  const dir = await tempDir(t, "pzza-cp-lock-race-");
  await makeRepo(dir);
  const log = path.join(dir, ".git", "lock-log");
  await symlink(await deadPid(), path.join(dir, ".git", "pzzacode-checkpoints.owner"));
  // Each holder writes "in" and, a moment later, "out"; two holders at once
  // would interleave.
  const probe = `${CHECKPOINT_PRELUDE}lock || exit $?
printf 'in %s\\n' "$$" >> "$2"
sleep 1
printf 'out %s\\n' "$$" >> "$2"
exit 0`;
  // Reading the owner answers late (by a varying delay after the read), so
  // some waiters act on a dead owner they saw before another waiter had
  // already taken the lock over: the double-takeover window is open.
  const shims = await tempDir(t, "pzza-cp-lock-shims-");
  for (const tool of ["cat", "readlink"]) {
    const real = (await run("sh", ["-c", `command -v ${tool}`])).stdout.trim();
    await writeFile(path.join(shims, tool), `#!/bin/sh
out=$(${real} "$@") || exit $?
case $(($PPID % 3)) in 0) sleep 0.1 ;; 1) sleep 0.4 ;; *) sleep 0.7 ;; esac
printf '%s\\n' "$out"
`, { mode: 0o755 });
  }
  const savedPath = process.env.PATH;
  process.env.PATH = `${shims}:${savedPath}`;
  t.after(() => { process.env.PATH = savedPath; });
  const results = await Promise.all(Array.from({ length: 6 }, () => runCheckpointScript("", probe, [dir, log], { lockWait: 30 })));
  process.env.PATH = savedPath;
  assert.deepEqual(results.map((result) => result.code), [0, 0, 0, 0, 0, 0]);
  const lines = (await readFile(log, "utf8")).trim().split("\n");
  assert.equal(lines.length, 12);
  for (let index = 0; index < lines.length; index += 2) {
    assert.match(lines[index], /^in \d+$/, `holder ${index / 2} starts alone: ${lines.join(" | ")}`);
    assert.equal(lines[index + 1], lines[index].replace("in", "out"), `holder ${index / 2} ends before the next starts: ${lines.join(" | ")}`);
  }
  assert.ok(!(await linkExists(path.join(dir, ".git", "pzzacode-checkpoints.owner"))));
  assert.ok(!(await linkExists(path.join(dir, ".git", "pzzacode-checkpoints.takeover"))));
});

test("a takeover abandoned by a killed waiter does not block the repository", async (t) => {
  const dir = await tempDir(t, "pzza-cp-lock-taker-");
  await makeRepo(dir);
  const dead = await deadPid();
  await symlink(dead, path.join(dir, ".git", "pzzacode-checkpoints.owner"));
  await symlink(dead, path.join(dir, ".git", "pzzacode-checkpoints.takeover"));
  await writeFile(path.join(dir, "a.txt"), "changed\n");
  const started = Date.now();
  assert.equal((await captureCheckpoint({ host: "", path: dir, kind: "manual" }, { lockWait: 5 })).created, true);
  assert.ok(Date.now() - started < 5000);
});

test("the restore guard stays fast with many ignored files and many files to bring back", { timeout: 120000 }, async (t) => {
  const dir = await tempDir(t, "pzza-cp-guard-perf-");
  const git = await makeRepo(dir);
  const target = { host: "", path: dir };
  await writeFile(path.join(dir, ".gitignore"), "*.pyc\n");
  // 300 folders with 100 ignored files each (30,000), and 2,000 files that a
  // restore brings back into those folders.
  for (let folder = 0; folder < 300; folder += 1) {
    await mkdir(path.join(dir, `p${folder}`));
    await writeFile(path.join(dir, `p${folder}`, "keep.txt"), "");
    await Promise.all(Array.from({ length: 100 }, (_, index) => writeFile(path.join(dir, `p${folder}`, `f${index}.pyc`), "")));
  }
  await git("add", "-A");
  await git("commit", "-qm", "folders");
  await Promise.all(Array.from({ length: 2000 }, (_, index) => writeFile(path.join(dir, `p${index % 300}`, `n${index}.txt`), `${index}\n`)));
  const captureStarted = Date.now();
  const full = await captureCheckpoint({ ...target, kind: "manual" });
  const captureElapsed = Date.now() - captureStarted;
  await Promise.all(Array.from({ length: 2000 }, (_, index) => rm(path.join(dir, `p${index % 300}`, `n${index}.txt`))));
  await captureCheckpoint({ ...target, kind: "manual" });
  const started = Date.now();
  const preview = await previewCheckpointRestore({ ...target, id: full.id, mode: "restore" });
  const elapsed = Date.now() - started;
  assert.equal(preview.files.length, CHECKPOINT_LIMITS.files);
  assert.equal(preview.truncated, true, "2,000 files, the first 500 listed");
  assert.deepEqual(preview.blocked, []);
  assert.equal(preview.applies, true);
  assert.ok(elapsed < 5000, `the preview took ${elapsed} ms`);
  assert.ok(captureElapsed < 10000, `saving 2,000 new files took ${captureElapsed} ms`);
});

test("a restore that runs out of time stops between steps and never claims more than it did", async (t) => {
  const dir = await tempDir(t, "pzza-cp-slow-");
  const git = await makeRepo(dir);
  const target = { host: "", path: dir };
  const one = await captureCheckpoint({ ...target, kind: "manual" });
  await writeFile(path.join(dir, "a.txt"), "later\n");
  const preview = await previewCheckpointRestore({ ...target, id: one.id, mode: "restore" });
  const before = await refs(git);
  await assert.rejects(restoreCheckpoint({ ...target, id: one.id, mode: "restore", expect: preview.expect }, { timeout: 1 }),
    (error) => error.status === 503 && /did not start in time\. No files were changed\./.test(error.message));
  assert.equal(await readFile(path.join(dir, "a.txt"), "utf8"), "later\n");
  assert.deepEqual(await refs(git), before);
  assert.ok(!(await linkExists(path.join(dir, ".git", "pzzacode-checkpoints.owner"))), "the stopped script freed the lock");
});

test("a restore that runs out of time while writing files finishes that step instead of leaving it half done", async (t) => {
  const dir = await tempDir(t, "pzza-cp-midway-");
  const git = await makeRepo(dir);
  const target = { host: "", path: dir };
  // Each restored .slow file takes a second to write (a smudge filter), so
  // the apply step is still running when the time runs out.
  await git("config", "filter.slow.smudge", "sleep 1; cat");
  await writeFile(path.join(dir, ".gitattributes"), "*.slow filter=slow\n");
  for (const name of ["a", "b", "c", "d"]) await writeFile(path.join(dir, `${name}.slow`), `${name} original\n`);
  const one = await captureCheckpoint({ ...target, kind: "manual" });
  for (const name of ["a", "b", "c", "d"]) await writeFile(path.join(dir, `${name}.slow`), `${name} edited\n`);
  const preview = await previewCheckpointRestore({ ...target, id: one.id, mode: "restore" });
  const result = await restoreCheckpoint({ ...target, id: one.id, mode: "restore", expect: preview.expect }, { timeout: 2500 }).catch((error) => error);
  const contents = await Promise.all(["a", "b", "c", "d"].map((name) => readFile(path.join(dir, `${name}.slow`), "utf8")));
  assert.deepEqual(contents, ["a original\n", "b original\n", "c original\n", "d original\n"], "every file of the step was written");
  assert.equal(result.restored, true, `the restore reports success: ${result.message ?? ""}`);
  assert.ok(!(await linkExists(path.join(dir, ".git", "pzzacode-checkpoints.owner"))));
});
