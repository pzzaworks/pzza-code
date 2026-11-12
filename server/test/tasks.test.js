import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  approveTaskCheck, commitTaskWorktree, discardTaskWorktree, previewTaskDiscard, taskBranches, taskCheck, taskDiff, taskStats,
  validateTaskCheckApproveRequest, validateTaskCheckRequest, validateTaskCommitRequest, validateTaskDiffRequest,
  validateTaskDiscardPreviewRequest, validateTaskDiscardRequest, validateTaskStatsRequest, validateTaskBranchesRequest,
  reclaimTaskWorktree, validateTaskReclaimRequest,
} from "../lib/tasks.js";
import {
  approveSetup, normalizeWorktreeConfig, saveWorktreeSetup, serializeWorktreeConfig, setupApproved, worktreeSetup,
} from "../lib/worktree-setup.js";
import { WORKTREE_SCRIPT, createDeviceSession } from "../lib/session-create.js";
import { mergeWorktreeBranch, worktreeInfo } from "../lib/worktree-land.js";

const exec = promisify(execFile);
const git = async (dir, ...args) => (await exec("git", ["-C", dir, ...args], { timeout: 15000 })).stdout.trim();

async function tempRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pzza-tasks-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.test"], ["commit.gpgsign", "false"]]) await git(dir, "config", key, value);
}

const write = (file, content) => fs.mkdir(path.dirname(file), { recursive: true }).then(() => fs.writeFile(file, content));

// Stands in for ssh: runs the exact remote command string with a local shell,
// so the device scripts run for real, quoting included.
function shellDevice(env = process.env) {
  const calls = [];
  const execImpl = (cmd, args, options, callback) => {
    calls.push({ cmd, args });
    return execFile("sh", ["-c", args.at(-1)], { ...options, env }, callback);
  };
  return { calls, execImpl };
}

// Real git and /bin/sh; the tmux session itself is stubbed.
function sessionRunner() {
  const run = (command, args, options, callback) => {
    if (command === "/bin/sh") return execFile(command, args, options, callback);
    if (command === "tmux") { callback(null, ""); return { stdin: null }; }
    return { stdin: { on() {}, end() { callback(null, JSON.stringify({ ok: true })); } } };
  };
  return { run };
}

// A main checkout on main and a task worktree on pzza/feature with one commit
// of its own, then uncommitted work of every kind; main moves on afterwards.
async function taskRepo(t) {
  const root = await tempRoot(t);
  const main = path.join(root, "app");
  const worktree = path.join(root, "app.worktrees", "feature");
  await makeRepo(main);
  await write(path.join(main, ".gitignore"), "*.log\n");
  await write(path.join(main, "a.txt"), "one\ntwo\nthree\n");
  await write(path.join(main, "m.txt"), "m\n");
  await write(path.join(main, "del.txt"), "gone\n");
  await write(path.join(main, "old.txt"), Array.from({ length: 10 }, (_, index) => `line ${index + 1}`).join("\n") + "\n");
  await git(main, "add", ".");
  await git(main, "commit", "-qm", "init");
  const init = await git(main, "rev-parse", "HEAD");
  await git(main, "worktree", "add", "-q", "-b", "pzza/feature", worktree);
  await write(path.join(worktree, "m.txt"), "m\nmore\n");
  await write(path.join(worktree, "c.txt"), "c1\nc2\n");
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-qm", "Add feature");
  await write(path.join(worktree, "a.txt"), "one\nTWO\nthree\nfour\n");
  await fs.rm(path.join(worktree, "del.txt"));
  await git(worktree, "mv", "old.txt", "new.txt");
  await write(path.join(worktree, "u.txt"), "u1\nu2\nu3");
  await write(path.join(worktree, "bin.dat"), Buffer.from([0, 1, 2, 3]));
  await write(path.join(worktree, "huge.txt"), "x\n".repeat(600 * 1024));
  await write(path.join(worktree, "debug.log"), "ignored\n");
  await write(path.join(main, "z.txt"), "main moves\n");
  await git(main, "add", "z.txt");
  await git(main, "commit", "-qm", "Main moves");
  return { root, main, worktree, init };
}

test("task requests are validated before anything runs", () => {
  const folder = { host: "", path: "/repo" };
  for (const body of [null, [], { ...folder, base: "main", extra: 1 }, { host: "-oProxyCommand=x", path: "/repo", base: "main" },
    { path: "repo", base: "main" }, { path: "/re\npo", base: "main" }, { path: "/repo" }, { ...folder, base: "-x" }, { ...folder, base: "a..b" },
    { ...folder, base: "a b" }, { ...folder, base: 7 }]) {
    assert.throws(() => validateTaskStatsRequest(body));
  }
  assert.deepEqual(validateTaskStatsRequest({ path: "/repo", base: "release/1.0" }), { host: "", path: "/repo", base: "release/1.0" });
  assert.throws(() => validateTaskBranchesRequest({ ...folder, base: "main" }), /Unknown request field/);
  for (const file of ["../x", "/etc/passwd", ".git/config", "a/../b", "a\u0000b", "", 3]) {
    assert.throws(() => validateTaskDiffRequest({ ...folder, base: "main", file }));
    assert.throws(() => validateTaskDiffRequest({ ...folder, base: "main", file: "ok.txt", from: file }));
  }
  assert.deepEqual(validateTaskDiffRequest({ ...folder, base: "main", file: "src/a.ts" }), { ...folder, base: "main", file: "src/a.ts", from: "src/a.ts" });
  assert.throws(() => validateTaskDiscardPreviewRequest({ ...folder, base: "--all" }));
  assert.deepEqual(validateTaskDiscardPreviewRequest(folder), { ...folder, base: null });
  for (const fingerprint of [undefined, "", "0".repeat(63), "G".repeat(64), "0".repeat(65)]) assert.throws(() => validateTaskDiscardRequest({ ...folder, fingerprint }));
  for (const message of [undefined, "", "   ", "two\nlines", "tab\there", "x".repeat(301), "\u0085"]) assert.throws(() => validateTaskCommitRequest({ ...folder, message }));
  for (const exclude of ["a.txt", ["../a"], ["/a"], [".git/x"], Array(201).fill("a.txt"), [1]]) assert.throws(() => validateTaskCommitRequest({ ...folder, message: "ok", exclude }));
  assert.deepEqual(validateTaskCommitRequest({ ...folder, message: " Fix it ", exclude: ["a.txt", "a.txt"] }), { ...folder, message: "Fix it", exclude: ["a.txt"] });
  assert.throws(() => validateTaskCheckRequest({ ...folder, run: "yes" }));
  assert.throws(() => validateTaskCheckRequest({ ...folder, run: true, check: [] }), /Unknown request field/);
  for (const check of [undefined, [], ["two\nlines"], [""], Array(9).fill("x"), "npm test"]) assert.throws(() => validateTaskCheckApproveRequest({ ...folder, check }));
  assert.deepEqual(validateTaskCheckApproveRequest({ ...folder, check: [" npm test "] }), { ...folder, check: ["npm test"] });
});

test("branches lists local branches newest first with the default base", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const repo = path.join(root, "app");
  await makeRepo(repo);
  const commitAt = async (date, message) => exec("git", ["-C", repo, "commit", "-q", "--allow-empty", "-m", message],
    { env: { ...process.env, GIT_COMMITTER_DATE: date, GIT_AUTHOR_DATE: date } });
  await commitAt("2020-01-01T00:00:00Z", "init");
  await git(repo, "branch", "old");
  await git(repo, "checkout", "-q", "-b", "develop");
  await commitAt("2030-01-01T00:00:00Z", "future");
  await git(repo, "checkout", "-q", "main");
  await commitAt("2025-01-01T00:00:00Z", "middle");
  const long = Array.from({ length: 6 }, () => "s".repeat(50)).join("/");
  await git(repo, "branch", long);
  const result = await taskBranches({ host: "", path: repo });
  assert.equal(result.root, repo);
  assert.equal(result.current, "main");
  assert.equal(result.base, "main");
  assert.deepEqual(result.branches.slice(0, 2), ["develop", "main"]);
  assert.equal(result.branches.at(-1), "old");
  assert.ok(!result.branches.includes(long), "names longer than 255 characters are dropped");
  // origin/HEAD wins when it names a local branch.
  await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/develop");
  assert.equal((await taskBranches({ host: "", path: repo })).base, "develop");
  await git(repo, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/nowhere");
  assert.equal((await taskBranches({ host: "", path: repo })).base, "main");
  await assert.rejects(taskBranches({ host: "", path: root }), { status: 400, message: /not inside a Git repository/ });
});

test("stats sums committed, uncommitted and untracked changes against the merge-base without touching the index", { timeout: 30000 }, async (t) => {
  const { main, worktree, init } = await taskRepo(t);
  const gitDir = await git(worktree, "rev-parse", "--absolute-git-dir");
  const indexBefore = await fs.readFile(path.join(gitDir, "index"));
  const statusBefore = await git(worktree, "status", "--porcelain");
  const stats = await taskStats({ host: "", path: path.join(worktree), base: "main" });
  assert.equal(stats.root, worktree);
  assert.equal(stats.branch, "pzza/feature");
  assert.equal(stats.head, await git(worktree, "rev-parse", "HEAD"));
  assert.equal(stats.baseFound, true);
  assert.equal(stats.mergeBase, init);
  assert.deepEqual(stats.commits.map((commit) => commit.subject), ["Add feature"]);
  assert.equal(stats.commits[0].sha, stats.head);
  assert.equal(stats.ahead, 1);
  assert.equal(stats.behind, 1);
  assert.deepEqual(stats.files, [
    { path: "a.txt", status: "modified", added: 2, removed: 1 },
    { path: "c.txt", status: "added", added: 2, removed: 0 },
    { path: "del.txt", status: "deleted", added: 0, removed: 1 },
    { path: "m.txt", status: "modified", added: 1, removed: 0 },
    { path: "new.txt", status: "renamed", from: "old.txt", added: 0, removed: 0 },
    { path: "bin.dat", status: "untracked", added: null, removed: null },
    { path: "huge.txt", status: "untracked", added: null, removed: null },
    { path: "u.txt", status: "untracked", added: 3, removed: 0 },
  ]);
  assert.equal(stats.truncated, false);
  assert.equal(stats.added, 8);
  assert.equal(stats.removed, 2);
  assert.equal(stats.uncommitted, 6, "R, M, D and three untracked files");
  assert.equal(stats.dirty, true);
  assert.deepEqual(await fs.readFile(path.join(gitDir, "index")), indexBefore, "the index was not written");
  assert.equal(await git(worktree, "status", "--porcelain"), statusBefore);

  // A base that is not a local branch: only the uncommitted work, against HEAD.
  const missing = await taskStats({ host: "", path: worktree, base: "nope" });
  assert.equal(missing.baseFound, false);
  assert.equal(missing.mergeBase, null);
  assert.deepEqual(missing.commits, []);
  assert.deepEqual([missing.ahead, missing.behind], [0, 0]);
  assert.deepEqual(missing.files.map((file) => `${file.status}:${file.path}`),
    ["modified:a.txt", "deleted:del.txt", "renamed:new.txt", "untracked:bin.dat", "untracked:huge.txt", "untracked:u.txt"]);

  // The main checkout compares with itself: nothing ahead, a clean tree.
  const clean = await taskStats({ host: "", path: main, base: "main" });
  assert.deepEqual([clean.files, clean.commits, clean.dirty, clean.uncommitted], [[], [], false, 0]);
  await assert.rejects(taskStats({ host: "", path: path.dirname(main), base: "main" }), { status: 400 });
});

test("diff shows the merge-base version against the working tree, never outside it", { timeout: 30000 }, async (t) => {
  const { root, worktree } = await taskRepo(t);
  const diff = (file, extra = {}) => taskDiff({ host: "", path: worktree, base: "main", file, from: file, ...extra });
  assert.deepEqual(await diff("a.txt"), { before: "one\ntwo\nthree\n", after: "one\nTWO\nthree\nfour\n", binary: false, truncated: false });
  // Committed on the branch: before is the merge-base, not HEAD.
  assert.deepEqual(await diff("m.txt"), { before: "m\n", after: "m\nmore\n", binary: false, truncated: false });
  assert.deepEqual(await diff("c.txt"), { before: null, after: "c1\nc2\n", binary: false, truncated: false });
  assert.deepEqual(await diff("del.txt"), { before: "gone\n", after: null, binary: false, truncated: false });
  const renamed = await diff("new.txt", { from: "old.txt" });
  assert.equal(renamed.before, renamed.after);
  assert.match(renamed.before, /^line 1\n/);
  assert.deepEqual(await diff("bin.dat"), { before: null, after: "", binary: true, truncated: false });
  assert.equal((await diff("huge.txt")).truncated, true);
  // Without the base the comparison is with HEAD.
  assert.equal((await taskDiff({ host: "", path: worktree, base: "nope", file: "m.txt" })).before, "m\nmore\n");

  await write(path.join(root, "outside", "secret.txt"), "secret\n");
  await fs.symlink(path.join(root, "outside"), path.join(worktree, "out"));
  await assert.rejects(diff("out/secret.txt"), { status: 400, message: /outside the repository/ });
  await fs.symlink(path.join(root, "outside", "secret.txt"), path.join(worktree, "link.txt"));
  assert.equal((await diff("link.txt")).after, path.join(root, "outside", "secret.txt"), "a link reads as its target text");

  // Another device reads the working-tree side in the script, with the same care.
  const device = shellDevice();
  const remote = await taskDiff({ host: "devbox", path: worktree, base: "main", file: "a.txt" }, { execImpl: device.execImpl });
  assert.deepEqual(remote, { before: "one\ntwo\nthree\n", after: "one\nTWO\nthree\nfour\n", binary: false, truncated: false });
  assert.equal(device.calls[0].cmd, "ssh");
  assert.ok(device.calls[0].args.at(-1).endsWith(`'${worktree}' 'main' 'a.txt' 'a.txt' 'after'`));
  await assert.rejects(taskDiff({ host: "devbox", path: worktree, base: "main", file: "out/secret.txt" }, { execImpl: device.execImpl }), { status: 400, message: /outside/ });
  assert.equal((await taskDiff({ host: "devbox", path: worktree, base: "main", file: "link.txt" }, { execImpl: device.execImpl })).after,
    path.join(root, "outside", "secret.txt"));
});

test("discard previews what would be lost and removes only an unchanged, unlocked pzza worktree", { timeout: 30000 }, async (t) => {
  const { root, main, worktree } = await taskRepo(t);
  const preview = await previewTaskDiscard({ host: "", path: worktree, base: null });
  assert.equal(preview.main, main);
  assert.equal(preview.branch, "pzza/feature");
  assert.equal(preview.base, "main");
  assert.deepEqual(preview.commits.map((commit) => commit.subject), ["Add feature"]);
  assert.deepEqual(preview.uncommitted.map((file) => `${file.status}:${file.path}`).sort(),
    ["deleted:del.txt", "modified:a.txt", "renamed:new.txt", "untracked:bin.dat", "untracked:huge.txt", "untracked:u.txt"]);
  assert.equal(preview.truncated, false);
  assert.equal(preview.locked, false);
  assert.match(preview.fingerprint, /^[0-9a-f]{64}$/);
  assert.equal((await previewTaskDiscard({ host: "", path: worktree, base: null })).fingerprint, preview.fingerprint, "stable while nothing changes");
  // A given base that is a local branch wins; the commits are counted against it.
  await git(main, "branch", "release", "pzza/feature");
  const released = await previewTaskDiscard({ host: "", path: worktree, base: "release" });
  assert.equal(released.base, "release");
  assert.deepEqual(released.commits, []);

  await assert.rejects(previewTaskDiscard({ host: "", path: main, base: null }), { status: 409, message: /main checkout/ });
  await assert.rejects(discardTaskWorktree({ host: "", path: main, fingerprint: "0".repeat(64) }), { status: 409, message: /main checkout/ });

  // Anything new since the preview stops the discard.
  await write(path.join(worktree, "late.txt"), "written after the review\n");
  await assert.rejects(discardTaskWorktree({ host: "", path: worktree, fingerprint: preview.fingerprint }), { status: 409, message: /changed since you reviewed it/ });
  await fs.access(path.join(worktree, "late.txt"));

  // Locked worktrees and branches the app did not create are refused.
  await git(main, "worktree", "lock", worktree);
  const lockedPreview = await previewTaskDiscard({ host: "", path: worktree, base: null });
  assert.equal(lockedPreview.locked, true);
  await assert.rejects(discardTaskWorktree({ host: "", path: worktree, fingerprint: lockedPreview.fingerprint }), { status: 409, message: /locked/ });
  await git(main, "worktree", "unlock", worktree);
  const plain = path.join(root, "app.worktrees", "plain");
  await git(main, "worktree", "add", "-q", "-b", "feature-plain", plain);
  const plainPreview = await previewTaskDiscard({ host: "", path: plain, base: null });
  await assert.rejects(discardTaskWorktree({ host: "", path: plain, fingerprint: plainPreview.fingerprint }), { status: 409, message: /pzza\// });
  await fs.access(plain);

  const fresh = await previewTaskDiscard({ host: "", path: worktree, base: null });
  assert.deepEqual(await discardTaskWorktree({ host: "", path: worktree, fingerprint: fresh.fingerprint }), { removed: true, branchDeleted: true });
  await assert.rejects(fs.access(worktree));
  await assert.rejects(git(main, "show-ref", "--verify", "-q", "refs/heads/pzza/feature"));
  assert.ok(!(await git(main, "worktree", "list", "--porcelain")).includes(worktree));
});

test("commit stages everything but the excluded files, runs hooks and refuses the main checkout", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const main = path.join(root, "app");
  const worktree = path.join(root, "app.worktrees", "work");
  await makeRepo(main);
  await write(path.join(main, "keep.txt"), "keep\n");
  await git(main, "add", ".");
  await git(main, "commit", "-qm", "init");
  await git(main, "worktree", "add", "-q", "-b", "pzza/work", worktree);
  await write(path.join(worktree, "keep.txt"), "keep\nchanged\n");
  await write(path.join(worktree, "extra.txt"), "extra\n");
  await write(path.join(worktree, "notes.txt"), "copied by setup\n");
  await write(path.join(worktree, "staged.txt"), "staged earlier\n");
  await git(worktree, "add", "staged.txt");

  const exclude = ["notes.txt", "staged.txt"];
  const { commit } = await commitTaskWorktree({ host: "", path: worktree, message: "Finish the task", exclude });
  assert.equal(commit, await git(worktree, "rev-parse", "HEAD"));
  assert.equal(await git(worktree, "log", "-1", "--format=%s"), "Finish the task");
  assert.deepEqual((await git(worktree, "show", "--name-only", "--format=", "HEAD")).split("\n").sort(), ["extra.txt", "keep.txt"]);
  assert.equal(await git(worktree, "status", "--porcelain"), "?? notes.txt\n?? staged.txt", "excluded files stay untracked, even one staged before");

  await assert.rejects(commitTaskWorktree({ host: "", path: worktree, message: "Again", exclude }), { status: 409, message: /nothing to commit/ });
  await write(path.join(main, "keep.txt"), "main edit\n");
  await assert.rejects(commitTaskWorktree({ host: "", path: main, message: "Main", exclude: [] }), { status: 409, message: /main checkout/ });

  // Hooks run; a failure comes back as one clean line without credentials.
  const hook = path.join(main, ".git", "hooks", "pre-commit");
  await write(hook, "#!/bin/sh\necho 'lint failed for https://user:s3cret@example.test/repo.git' >&2\nexit 1\n");
  await fs.chmod(hook, 0o755);
  await write(path.join(worktree, "extra.txt"), "extra\nmore\n");
  const failed = await commitTaskWorktree({ host: "", path: worktree, message: "Blocked", exclude }).catch((error) => error);
  assert.equal(failed.status, 409);
  assert.match(failed.message, /^The commit failed: .*lint failed for https:\/\/example\.test\/repo\.git/);
  assert.ok(!failed.message.includes("s3cret"));
  assert.equal(await git(worktree, "rev-parse", "HEAD"), commit);
});

// A repository whose main checkout holds a check list, a task worktree, and a
// login shell (/bin/sh with its own HOME) whose profile adds a tool to PATH
// and prints noise that must be ignored.
async function checkRepo(t, check) {
  const root = await tempRoot(t);
  const main = path.join(root, "app");
  const worktree = path.join(root, "app.worktrees", "check");
  const home = path.join(root, "home");
  const approvalsFile = path.join(root, "approvals.json");
  await makeRepo(main);
  await write(path.join(main, "src", "index.js"), "x\n");
  await git(main, "add", ".");
  await git(main, "commit", "-qm", "init");
  await git(main, "worktree", "add", "-q", "-b", "pzza/check", worktree);
  const tools = path.join(home, "tools");
  await write(path.join(tools, "pzza-probe"), "#!/bin/sh\necho probe ok\n");
  await fs.chmod(path.join(tools, "pzza-probe"), 0o755);
  await write(path.join(home, ".profile"), `echo noise from the profile\nPATH="${tools}:$PATH"; export PATH\n`);
  const setCheck = (list) => write(path.join(main, ".pzzacode", "worktree.json"), JSON.stringify({ run: [], ...(list ? { check: list } : {}) }));
  await setCheck(check);
  const env = { ...process.env, SHELL: "/bin/sh", HOME: home, ENV: "" };
  return { root, main, worktree, approvalsFile, env, setCheck };
}

test("check runs only approved commands in the worktree with the login PATH", { timeout: 30000 }, async (t) => {
  const commands = ["pzza-probe", "printf '\\033[31mred\\033[0m\\r\\n'", "pwd > check.out"];
  const { main, worktree, approvalsFile, env, setCheck } = await checkRepo(t, commands);
  const options = { approvalsFile, env };
  const subdir = path.join(worktree, "src");

  assert.deepEqual(await taskCheck({ host: "", path: subdir, run: false }, options), { status: "unapproved", commands });
  assert.deepEqual(await taskCheck({ host: "", path: subdir, run: true }, options), { status: "unapproved", commands });
  await assert.rejects(fs.access(path.join(worktree, "check.out")), "nothing ran before approval");
  await assert.rejects(approveTaskCheck({ host: "", path: worktree, check: ["pzza-probe"] }, options), { status: 409, message: /changed since they were shown/ });
  assert.deepEqual(await approveTaskCheck({ host: "", path: worktree, check: commands }, options), { status: "ready", commands });
  assert.deepEqual(await taskCheck({ host: "", path: worktree, run: false }, options), { status: "ready", commands });
  assert.equal((await worktreeSetup({ host: "", path: worktree }, { approvalsFile })).checkApproved, true);
  assert.equal((await worktreeSetup({ host: "", path: worktree }, { approvalsFile })).approved, true, "the empty run list needs no approval");

  const passed = await taskCheck({ host: "", path: subdir, run: true }, options);
  assert.equal(passed.status, "passed");
  assert.equal(passed.code, 0);
  assert.deepEqual(passed.commands, commands);
  assert.equal(passed.output, "probe ok\nred\n", "the login PATH found the tool; escapes and the profile's noise are gone");
  assert.equal(typeof passed.durationMs, "number");
  assert.equal((await fs.readFile(path.join(worktree, "check.out"), "utf8")).trim(), worktree, "runs from the worktree's top-level");

  // A changed list needs approving again; failures keep stderr and the code.
  const failing = ["echo boom >&2; exit 3"];
  await setCheck(failing);
  assert.equal((await taskCheck({ host: "", path: worktree, run: true }, options)).status, "unapproved");
  await approveTaskCheck({ host: "", path: worktree, check: failing }, options);
  const failed = await taskCheck({ host: "", path: worktree, run: true }, options);
  assert.deepEqual([failed.status, failed.code, failed.output], ["failed", 3, "boom\n"]);

  // Another device runs the same script in its "tail" mode over one ssh call.
  const device = shellDevice(env);
  const remoteOptions = { approvalsFile, execImpl: device.execImpl };
  assert.equal((await taskCheck({ host: "devbox", path: worktree, run: false }, remoteOptions)).status, "unapproved", "approvals are per device");
  await approveTaskCheck({ host: "devbox", path: worktree, check: failing }, remoteOptions);
  const remoteFailed = await taskCheck({ host: "devbox", path: worktree, run: true }, remoteOptions);
  assert.deepEqual([remoteFailed.status, remoteFailed.code, remoteFailed.output], ["failed", 3, "boom\n"]);
  assert.ok(device.calls.every((call) => call.cmd === "ssh"));

  // No list, or no setup file at all: nothing to check.
  await setCheck(null);
  assert.deepEqual(await taskCheck({ host: "", path: worktree, run: true }, options), { status: "none", commands: [] });
  await fs.rm(path.join(main, ".pzzacode"), { recursive: true });
  assert.deepEqual(await taskCheck({ host: "", path: worktree, run: false }, options), { status: "none", commands: [] });
  await write(path.join(main, ".pzzacode", "worktree.json"), "{ broken");
  await assert.rejects(taskCheck({ host: "", path: worktree, run: false }, options), { status: 409, message: /not valid JSON/ });
});

test("a check that runs too long is stopped with its whole process group, one at a time per worktree", { timeout: 30000 }, async (t) => {
  const slow = ["sleep 20 & echo $! > sleeper.pid; echo started; wait"];
  const { worktree, approvalsFile, env } = await checkRepo(t, slow);
  const options = { approvalsFile, env, timeoutMs: 1500 };
  await approveTaskCheck({ host: "", path: worktree, check: slow }, options);
  const running = taskCheck({ host: "", path: worktree, run: true }, options);
  await new Promise((resolve) => setTimeout(resolve, 200));
  await assert.rejects(taskCheck({ host: "", path: worktree, run: true }, options), { status: 409, message: /already running/ });
  const result = await running;
  assert.equal(result.status, "timeout");
  assert.equal(result.code, null);
  assert.equal(result.output, "started\n");
  assert.ok(result.durationMs >= 1500 && result.durationMs < 10000);
  const pid = Number(await fs.readFile(path.join(worktree, "sleeper.pid"), "utf8"));
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.throws(() => process.kill(pid, 0), { code: "ESRCH" }, "the background child was killed too");
  // The slot is free again.
  assert.equal((await taskCheck({ host: "", path: worktree, run: false }, options)).status, "ready");
});

test("worktree setup keeps the check list on save and keeps run approvals compatible", { timeout: 30000 }, async (t) => {
  assert.deepEqual(normalizeWorktreeConfig({}), { copy: null, run: [] });
  assert.deepEqual(normalizeWorktreeConfig({ check: [" npm test "] }), { copy: null, run: [], check: ["npm test"] });
  for (const check of ["npm test", ["a\nb"], [""], Array(9).fill("x"), [1]]) assert.throws(() => normalizeWorktreeConfig({ check }));
  assert.equal(serializeWorktreeConfig({ copy: null, run: ["a"], check: [] }), `${JSON.stringify({ run: ["a"] }, null, 2)}\n`);
  assert.equal(serializeWorktreeConfig({ copy: [".env"], run: [], check: ["npm test"] }), `${JSON.stringify({ copy: [".env"], run: [], check: ["npm test"] }, null, 2)}\n`);

  const root = await tempRoot(t);
  const repo = path.join(root, "app");
  const approvalsFile = path.join(root, "approvals.json");
  await makeRepo(repo);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  await write(path.join(repo, ".pzzacode", "worktree.json"), JSON.stringify({ copy: [".env"], run: ["npm install"], check: ["npm test"] }));
  const saved = await saveWorktreeSetup({ host: "", path: repo, copy: [".env.local"], run: ["pnpm install"] }, { approvalsFile });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(repo, ".pzzacode", "worktree.json"), "utf8")),
    { copy: [".env.local"], run: ["pnpm install"], check: ["npm test"] });
  assert.deepEqual([saved.check, saved.checkApproved, saved.approved], [["npm test"], false, true], "saving approves the run list, not the check list");

  // An approval written before kinds existed still approves the run list.
  const legacy = crypto.createHash("sha256").update(JSON.stringify(["", repo, ["npm install"]])).digest("hex");
  await fs.writeFile(approvalsFile, JSON.stringify({ approved: [legacy] }));
  assert.equal(await setupApproved("", repo, ["npm install"], { approvalsFile }), true);
  assert.equal(await setupApproved("", repo, ["npm install"], { approvalsFile, kind: "check" }), false);
  await approveSetup("", repo, ["npm test"], { approvalsFile, kind: "check" });
  assert.equal(await setupApproved("", repo, ["npm test"], { approvalsFile, kind: "check" }), true);
  assert.equal(await setupApproved("", repo, ["npm test"], { approvalsFile }), false, "a check approval never approves setup commands");
  assert.equal(await setupApproved("", repo, ["npm install"], { approvalsFile }), true);
});

test("new task worktrees start from a chosen base branch and record it", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const repo = path.join(root, "app");
  const approvalsFile = path.join(root, "approvals.json");
  await makeRepo(repo);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  await git(repo, "tag", "develop");
  await git(repo, "checkout", "-q", "-b", "develop");
  await write(path.join(repo, "dev.txt"), "dev\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "Develop work");
  const developTip = await git(repo, "rev-parse", "refs/heads/develop");
  await git(repo, "checkout", "-q", "main");

  const { run } = sessionRunner();
  const result = await createDeviceSession({ name: "based task", cwd: repo, worktree: true, base: "develop" }, run, { approvalsFile });
  const dir = path.join(root, "app.worktrees", "based-task");
  assert.equal(result.cwd, dir);
  assert.equal(await git(dir, "rev-parse", "HEAD"), developTip, "the branch, not the tag of the same name");
  assert.equal(await git(dir, "symbolic-ref", "--short", "HEAD"), "pzza/based-task");
  assert.equal(await git(repo, "config", "--get", "branch.pzza/based-task.pzzabase"), "develop");

  // Without a base nothing is recorded and HEAD is the start point, as before.
  await createDeviceSession({ name: "plain task", cwd: repo, worktree: true }, run, { approvalsFile });
  assert.equal(await git(path.join(root, "app.worktrees", "plain-task"), "rev-parse", "HEAD"), await git(repo, "rev-parse", "main"));
  await assert.rejects(git(repo, "config", "--get", "branch.pzza/plain-task.pzzabase"));

  await assert.rejects(createDeviceSession({ name: "missing", cwd: repo, worktree: true, base: "nope" }, run, { approvalsFile }),
    { status: 400, message: "The base branch nope does not exist in this repository." });
  await assert.rejects(fs.access(path.join(root, "app.worktrees", "missing")));
  for (const body of [{ name: "x", cwd: repo, base: "develop" }, { name: "x", cwd: repo, worktree: false, base: "develop" }, { name: "x", cwd: repo, worktree: true, base: "-x" }]) {
    await assert.rejects(createDeviceSession(body, run, { approvalsFile }), { status: 400 });
  }
});

test("pull requests and merges target the base a task recorded", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const repo = path.join(root, "app");
  await makeRepo(repo);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  await git(repo, "branch", "develop");
  const { run } = sessionRunner();
  const { cwd: worktree } = await createDeviceSession({ name: "land", cwd: repo, worktree: true, base: "develop" }, run, { approvalsFile: path.join(root, "a.json") });
  await write(path.join(worktree, "feature.txt"), "feature\n");
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-qm", "Feature");
  assert.deepEqual(await worktreeInfo({ host: "", path: worktree }), { linked: true, branch: "pzza/land", base: "develop", main: repo });

  await assert.rejects(mergeWorktreeBranch({ host: "", path: worktree, branch: "pzza/land", base: "main" }), { status: 409, message: /changed since it was shown/ });
  await git(repo, "checkout", "-q", "develop");
  const merged = await mergeWorktreeBranch({ host: "", path: worktree, branch: "pzza/land", base: "develop" });
  assert.equal(merged.merged, true);
  assert.equal(await fs.readFile(path.join(repo, "feature.txt"), "utf8"), "feature\n");
  assert.equal(await git(repo, "rev-parse", "develop"), merged.commit);
  await assert.rejects(git(repo, "cat-file", "-e", "main:feature.txt"), "main is untouched");

  // A recorded base that no longer exists, or looks like an option, is ignored.
  await git(repo, "config", "branch.pzza/land.pzzabase", "gone");
  assert.equal((await worktreeInfo({ host: "", path: worktree })).base, "main");
  await git(repo, "config", "branch.pzza/land.pzzabase", "-x");
  assert.equal((await worktreeInfo({ host: "", path: worktree })).base, "main");
});

// Real git and /bin/sh; the tmux session of the names in `failing` cannot be
// created, as when the terminal service or the device goes away mid-launch.
function failingSessionRunner(failing) {
  const run = (command, args, options, callback) => {
    if (command === "/bin/sh") return execFile(command, args, options, callback);
    if (command === "tmux") { callback(null, ""); return { stdin: null }; }
    return {
      stdin: {
        on() {},
        end(data) {
          const { name } = JSON.parse(data);
          if (failing.includes(name)) callback(Object.assign(new Error("unreachable"), { code: 1 }));
          else callback(null, JSON.stringify({ ok: true }));
        },
      },
    };
  };
  return { run };
}

const exists = (file) => fs.access(file).then(() => true, () => false);
const hasBranch = (repo, branch) => git(repo, "show-ref", "--verify", "-q", `refs/heads/${branch}`).then(() => true, () => false);

test("reclaim requests are validated before anything runs", () => {
  const ok = { host: "", path: "/repo", session: "fix login-codex", base: "main", startedAt: 1700000000000, remove: true };
  assert.deepEqual(validateTaskReclaimRequest(ok), { host: "", path: "/repo", slug: "fix-login-codex", base: "main", startedAt: 1700000000000, remove: true });
  for (const change of [{ session: "" }, { session: "../x" }, { session: "a/b" }, { session: "---" }, { session: 4 }, { base: "-x" }, { base: "a..b" },
    { startedAt: -1 }, { startedAt: 1.5 }, { startedAt: "1" }, { remove: "yes" }, { extra: 1 }]) {
    assert.throws(() => validateTaskReclaimRequest({ ...ok, ...change }));
  }
});

test("a partial best of N failure cleans up only the candidate that failed", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const repo = path.join(root, "app");
  const approvalsFile = path.join(root, "approvals.json");
  await makeRepo(repo);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  const startedAt = Date.now();
  const names = ["fix-login-claude", "fix-login-codex", "fix-login-gemini"];
  const { run } = failingSessionRunner(["fix-login-codex"]);
  const results = [];
  for (const name of names) {
    results.push(await createDeviceSession({ name, cwd: repo, worktree: true, base: "main" }, run, { approvalsFile }).then((value) => value, (error) => error));
  }
  assert.equal(results[1].status, 503, "the session of the second candidate could not be created");
  const dirs = names.map((name) => path.join(root, "app.worktrees", name));
  assert.ok(await exists(dirs[1]), "its worktree was left behind by the failed launch");
  // The first candidate already has work of its own.
  await write(path.join(dirs[0], "done.txt"), "done\n");
  await git(dirs[0], "add", ".");
  await git(dirs[0], "commit", "-qm", "Claude work");
  await write(path.join(dirs[2], "draft.txt"), "draft\n");

  const reclaimed = await reclaimTaskWorktree({ host: "", path: repo, slug: "fix-login-codex", base: "main", startedAt, remove: true });
  assert.deepEqual(reclaimed, { state: "removed", worktree: null, branch: "pzza/fix-login-codex", branchDeleted: true });
  assert.equal(await exists(dirs[1]), false);
  assert.equal(await hasBranch(repo, "pzza/fix-login-codex"), false);
  await assert.rejects(git(repo, "config", "--get", "branch.pzza/fix-login-codex.pzzabase"), "its branch settings went with it");
  assert.ok(!(await git(repo, "worktree", "list", "--porcelain")).includes(dirs[1]));

  // The candidates that started keep their worktrees, branches and work.
  assert.equal(await fs.readFile(path.join(dirs[0], "done.txt"), "utf8"), "done\n");
  assert.equal(await fs.readFile(path.join(dirs[2], "draft.txt"), "utf8"), "draft\n");
  for (const branch of ["pzza/fix-login-claude", "pzza/fix-login-gemini"]) assert.ok(await hasBranch(repo, branch));
  // Reclaiming again finds nothing left.
  assert.equal((await reclaimTaskWorktree({ host: "", path: repo, slug: "fix-login-codex", base: "main", startedAt, remove: true })).state, "absent");
});

test("a launch cut short is reconciled on the next load: reattached while its session runs, otherwise removed", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const repo = path.join(root, "app");
  await makeRepo(repo);
  // Files the setup copies in are ignored, so they never count as work.
  await write(path.join(repo, ".gitignore"), ".env\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  await git(repo, "branch", "develop");
  const startedAt = Date.now();
  // The app quit right after the worktree step: no session, no record of the folder.
  await exec("/bin/sh", ["-c", WORKTREE_SCRIPT, "pzza-worktree", repo, "crash-task", "develop"], { timeout: 15000 });
  const dir = path.join(root, "app.worktrees", "crash-task");
  await write(path.join(dir, ".env"), "TOKEN=copied\n");

  // Looking never changes anything and names the folder to reattach.
  const device = shellDevice();
  const inspected = await reclaimTaskWorktree({ host: "devbox", path: repo, slug: "crash-task", base: "develop", startedAt, remove: false }, { execImpl: device.execImpl });
  assert.deepEqual(inspected, { state: "present", worktree: dir, branch: "pzza/crash-task", branchDeleted: false });
  assert.equal(device.calls[0].cmd, "ssh");
  assert.ok(await exists(dir));

  // A candidate queued behind it never got anywhere.
  assert.equal((await reclaimTaskWorktree({ host: "", path: repo, slug: "crash-task-2", base: "develop", startedAt, remove: true })).state, "absent");

  const removed = await reclaimTaskWorktree({ host: "devbox", path: repo, slug: "crash-task", base: "develop", startedAt, remove: true }, { execImpl: device.execImpl });
  assert.deepEqual(removed, { state: "removed", worktree: null, branch: "pzza/crash-task", branchDeleted: true });
  assert.equal(await exists(dir), false);
  assert.equal(await hasBranch(repo, "pzza/crash-task"), false);
  assert.ok(await hasBranch(repo, "develop"), "the base stays");
});

test("reclaim never deletes a worktree with changes, commits, a lock, or one that is not this launch's", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const repo = path.join(root, "app");
  await makeRepo(repo);
  await write(path.join(repo, "a.txt"), "a\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  const startedAt = Date.now();
  const create = (slug) => exec("/bin/sh", ["-c", WORKTREE_SCRIPT, "pzza-worktree", repo, slug, "main"], { timeout: 15000 }).then(() => path.join(root, "app.worktrees", slug));
  const reclaim = (slug, extra = {}) => reclaimTaskWorktree({ host: "", path: repo, slug, base: "main", startedAt, remove: true, ...extra });

  const untracked = await create("untracked");
  await write(path.join(untracked, "notes.txt"), "agent notes\n");
  assert.deepEqual(await reclaim("untracked"), { state: "kept", worktree: untracked, branch: "pzza/untracked", reason: "changes", branchDeleted: false });

  const modified = await create("modified");
  await write(path.join(modified, "a.txt"), "changed\n");
  assert.equal((await reclaim("modified")).reason, "changes");

  const committed = await create("committed");
  await write(path.join(committed, "b.txt"), "b\n");
  await git(committed, "add", ".");
  await git(committed, "commit", "-qm", "Agent commit");
  assert.deepEqual(await reclaim("committed"), { state: "kept", worktree: committed, branch: "pzza/committed", reason: "commits", branchDeleted: false });

  const locked = await create("locked");
  await git(repo, "worktree", "lock", locked);
  assert.equal((await reclaim("locked")).reason, "locked");

  // Created before this launch: an older worktree of the same name.
  const older = await create("older");
  assert.equal((await reclaim("older", { startedAt: startedAt + 3600 * 1000 })).reason, "older");

  // A folder of that name that is no worktree on its branch, and a branch checked out elsewhere.
  const stray = path.join(root, "app.worktrees", "stray");
  await write(path.join(stray, "keep.txt"), "mine\n");
  assert.deepEqual(await reclaim("stray"), { state: "foreign", worktree: null, branch: "pzza/stray", branchDeleted: false });
  await git(repo, "worktree", "add", "-q", "-b", "pzza/moved", path.join(root, "elsewhere"));
  assert.equal((await reclaim("moved")).state, "foreign");
  await git(repo, "worktree", "add", "-q", "--detach", path.join(root, "app.worktrees", "detached"));
  assert.equal((await reclaim("detached")).state, "foreign");

  for (const [slug, dir] of [["untracked", untracked], ["modified", modified], ["committed", committed], ["locked", locked], ["older", older]]) {
    assert.ok(await exists(dir), `${slug} is still there`);
    assert.ok(await hasBranch(repo, `pzza/${slug}`), `pzza/${slug} is still there`);
  }
  assert.equal(await fs.readFile(path.join(untracked, "notes.txt"), "utf8"), "agent notes\n");
  assert.equal(await fs.readFile(path.join(modified, "a.txt"), "utf8"), "changed\n");
  assert.equal(await fs.readFile(path.join(stray, "keep.txt"), "utf8"), "mine\n");
  assert.ok(await exists(path.join(root, "elsewhere")));
  assert.ok(await hasBranch(repo, "pzza/moved"));

  // A kept worktree stays reachable through the regular discard.
  const preview = await previewTaskDiscard({ host: "", path: committed, base: "main" });
  assert.deepEqual(preview.commits.map((commit) => commit.subject), ["Agent commit"]);
});
