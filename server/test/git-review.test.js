import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GIT_REVIEW_LIMITS, branchWebUrl, clearGitRemoteCache, failedCiRuns, gitChanges, gitCiFailures, gitDiff, gitRemote, gitRemoveWorktree, gitReviewRouter,
  gitWorktrees, parsePullRequest, parseRemoteUrl, parseStatusZ, remoteGitReviewCommand, summarizeChecks,
  validateGitCiFailuresRequest, validateGitDiffRequest, validateGitRemoveWorktreeRequest, validateGitChangesRequest, validateRepoFile,
} from "../lib/git-review.js";

const run = promisify(execFile);

async function tempDir(t, prefix) {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), prefix)));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeRepo(dir) {
  await mkdir(dir, { recursive: true });
  const git = async (...args) => (await run("git", ["-C", dir, ...args], { timeout: 10000 })).stdout;
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Test");
  await git("config", "user.email", "test@example.test");
  await git("config", "commit.gpgsign", "false");
  return git;
}

// Stands in for ssh: runs the exact remote command string with a local shell,
// so the fixed scripts are exercised for real, quoting included.
function shellDevice(extraPath = "") {
  const calls = [];
  const execImpl = (cmd, args, options, callback) => {
    calls.push({ cmd, args, options });
    const env = extraPath ? { ...process.env, PATH: `${extraPath}:${process.env.PATH}` } : process.env;
    execFile("sh", ["-c", args[args.length - 1]], { ...options, env }, callback);
  };
  return { execImpl, calls };
}

const byPath = (files) => [...files].sort((a, b) => a.path.localeCompare(b.path));

test("requests accept only safe hosts, absolute folders and repository-relative files", () => {
  assert.deepEqual(validateGitChangesRequest({ path: "/repo" }), { host: "", path: "/repo" });
  assert.equal(validateGitChangesRequest({ host: "devbox", path: "/repo" }).host, "devbox");
  for (const body of [null, [], {}, { path: "repo" }, { path: "/a\nb" }, { path: "/" + "a".repeat(GIT_REVIEW_LIMITS.pathLength) },
    { host: "-oProxyCommand=x", path: "/a" }, { host: 5, path: "/a" }, { path: "/a", extra: 1 }]) {
    assert.throws(() => validateGitChangesRequest(body), undefined, JSON.stringify(body));
  }
  assert.deepEqual(validateGitDiffRequest({ path: "/r", file: "src/a b.ts" }), { host: "", path: "/r", file: "src/a b.ts", from: "src/a b.ts" });
  assert.equal(validateGitDiffRequest({ path: "/r", file: "new.ts", from: "old.ts" }).from, "old.ts");
  for (const file of ["../x", "a/../../x", "/etc/passwd", "a//b", "./a", "a/", "", ".git/config", "sub/.GIT/HEAD", "a\u0000b", "a\nb", 7]) {
    assert.equal(validateRepoFile(file), false, String(file));
    assert.throws(() => validateGitDiffRequest({ path: "/r", file }));
  }
  assert.throws(() => validateGitDiffRequest({ path: "/r", file: "a", from: "../b" }));
  assert.deepEqual(validateGitRemoveWorktreeRequest({ path: "/r", worktree: "/r.worktrees/x", deleteBranch: true }),
    { host: "", path: "/r", worktree: "/r.worktrees/x", deleteBranch: true });
  assert.throws(() => validateGitRemoveWorktreeRequest({ path: "/r", worktree: "rel", deleteBranch: true }));
  assert.throws(() => validateGitRemoveWorktreeRequest({ path: "/r", worktree: "/w", deleteBranch: "yes" }));
});

test("porcelain -z parsing handles renames, untracked, conflicts, ignored entries and caps", () => {
  const text = " M a.txt\0R  new name.txt\0old name.txt\0?? fresh.txt\0UU both.txt\0AA added-both.txt\0D  gone.txt\0 D gone2.txt\0A  staged.txt\0!! ignored\0";
  assert.deepEqual(parseStatusZ(text), {
    truncated: false,
    files: [
      { path: "a.txt", status: "modified" }, { path: "new name.txt", status: "renamed", from: "old name.txt" },
      { path: "fresh.txt", status: "untracked" }, { path: "both.txt", status: "conflicted" }, { path: "added-both.txt", status: "conflicted" },
      { path: "gone.txt", status: "deleted" }, { path: "gone2.txt", status: "deleted" }, { path: "staged.txt", status: "added" },
    ],
  });
  // A cut-off stream drops the partial last entry and a rename missing its source.
  assert.deepEqual(parseStatusZ(" M a.txt\0 M b.t", true), { truncated: true, files: [{ path: "a.txt", status: "modified" }] });
  assert.deepEqual(parseStatusZ(" M a.txt\0R  b\0", true).files, [{ path: "a.txt", status: "modified" }]);
  const many = Array.from({ length: GIT_REVIEW_LIMITS.files + 3 }, (_, index) => `?? f${index}\0`).join("");
  const capped = parseStatusZ(many);
  assert.equal(capped.files.length, GIT_REVIEW_LIMITS.files);
  assert.equal(capped.truncated, true);
});

test("changes come from a real repository, locally and through the device script", { timeout: 30000 }, async (t) => {
  const root = await tempDir(t, "pzza-review-changes-");
  // A hostile folder name proves the remote script quotes its arguments.
  const repo = path.join(root, "repo'; touch injected; '");
  const git = await makeRepo(repo);
  for (const name of ["a.txt", "b.txt", "c.txt"]) await writeFile(path.join(repo, name), `${name}\n`);
  await git("add", ".");
  await git("commit", "-qm", "init");
  await writeFile(path.join(repo, "a.txt"), "changed\n");
  await git("mv", "b.txt", "renamed b.txt");
  await rm(path.join(repo, "c.txt"));
  await writeFile(path.join(repo, "new file.txt"), "new\n");
  await writeFile(path.join(repo, "d.txt"), "d\n");
  await git("add", "d.txt");
  await mkdir(path.join(repo, "sub"));
  const expected = {
    root: repo, truncated: false,
    files: byPath([
      { path: "a.txt", status: "modified" }, { path: "renamed b.txt", status: "renamed", from: "b.txt" },
      { path: "c.txt", status: "deleted" }, { path: "d.txt", status: "added" }, { path: "new file.txt", status: "untracked" },
    ]),
  };
  const local = await gitChanges({ host: "", path: path.join(repo, "sub") });
  assert.deepEqual({ ...local, files: byPath(local.files) }, expected);
  const device = shellDevice();
  const remote = await gitChanges({ host: "devbox", path: path.join(repo, "sub") }, { execImpl: device.execImpl });
  assert.deepEqual({ ...remote, files: byPath(remote.files) }, expected);
  assert.equal(device.calls.length, 1);
  assert.equal(device.calls[0].cmd, "ssh");
  assert.ok(device.calls[0].args.includes("devbox"));
  await assert.rejects(stat(path.join(root, "injected")), { code: "ENOENT" });
  await assert.rejects(stat(path.join(repo, "injected")), { code: "ENOENT" });
  await assert.rejects(gitChanges({ host: "", path: root }), /not inside a Git repository/);
  await assert.rejects(gitChanges({ host: "devbox", path: root }, { execImpl: device.execImpl }), /not inside a Git repository/);
});

test("diff returns before and after sides, flags binary and size caps, and never leaves the repository", { timeout: 30000 }, async (t) => {
  const root = await tempDir(t, "pzza-review-diff-");
  const repo = path.join(root, "repo");
  const outside = path.join(root, "outside");
  await mkdir(outside);
  await writeFile(path.join(outside, "secret.txt"), "secret\n");
  const git = await makeRepo(repo);
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await writeFile(path.join(repo, "gone.txt"), "bye\n");
  await writeFile(path.join(repo, "old.txt"), "moved\n");
  await writeFile(path.join(repo, "bin.dat"), Buffer.from([1, 0, 2, 3]));
  await git("add", ".");
  await git("commit", "-qm", "init");
  await writeFile(path.join(repo, "a.txt"), "two\n");
  await rm(path.join(repo, "gone.txt"));
  await git("mv", "old.txt", "new.txt");
  await writeFile(path.join(repo, "fresh.txt"), "hello\n");
  await writeFile(path.join(repo, "big.txt"), "x".repeat(GIT_REVIEW_LIMITS.side + 10));
  await symlink(outside, path.join(repo, "escape"));
  await symlink(path.join(outside, "secret.txt"), path.join(repo, "link.txt"));
  const device = shellDevice();
  for (const [label, options, host] of [["local", {}, ""], ["remote", { execImpl: device.execImpl }, "devbox"]]) {
    const diff = (file, from) => gitDiff({ host, path: repo, file, from: from ?? file }, options);
    assert.deepEqual(await diff("a.txt"), { before: "one\n", after: "two\n", binary: false, truncated: false }, label);
    assert.deepEqual(await diff("fresh.txt"), { before: null, after: "hello\n", binary: false, truncated: false }, label);
    assert.deepEqual(await diff("gone.txt"), { before: "bye\n", after: null, binary: false, truncated: false }, label);
    assert.deepEqual(await diff("new.txt", "old.txt"), { before: "moved\n", after: "moved\n", binary: false, truncated: false }, label);
    assert.deepEqual(await diff("bin.dat"), { before: "", after: "", binary: true, truncated: false }, label);
    const big = await diff("big.txt");
    assert.equal(big.truncated, true, label);
    assert.equal(big.after.length, GIT_REVIEW_LIMITS.side, label);
    // A symlinked directory pointing outside is refused; a symlinked file is
    // shown as its link text (what Git stores), never the target's contents.
    await assert.rejects(diff("escape/secret.txt"), /outside the repository/, label);
    assert.deepEqual(await diff("link.txt"), { before: null, after: path.join(outside, "secret.txt"), binary: false, truncated: false }, label);
    assert.deepEqual(await diff("missing/dir/file.txt"), { before: null, after: null, binary: false, truncated: false }, label);
  }
});

test("remote URLs become branch pages for GitHub, GitLab and Bitbucket only", () => {
  assert.equal(branchWebUrl("git@github.com:pzza/code.git", "main"), "https://github.com/pzza/code/tree/main");
  assert.equal(branchWebUrl("https://github.com/pzza/code.git", "pzza/a b#1"), "https://github.com/pzza/code/tree/pzza/a%20b%231");
  assert.equal(branchWebUrl("https://user:secret-token@github.com/pzza/code", "dev"), "https://github.com/pzza/code/tree/dev");
  assert.equal(branchWebUrl("ssh://git@github.com:22/pzza/code.git", "dev"), "https://github.com/pzza/code/tree/dev");
  assert.equal(branchWebUrl("https://gitlab.com/group/sub/proj.git/", "feat/x"), "https://gitlab.com/group/sub/proj/-/tree/feat/x");
  assert.equal(branchWebUrl("git@gitlab.com:group/proj.git", "dev"), "https://gitlab.com/group/proj/-/tree/dev");
  assert.equal(branchWebUrl("https://berke@bitbucket.org/team/repo.git", "dev"), "https://bitbucket.org/team/repo/branch/dev");
  assert.equal(branchWebUrl("git@bitbucket.org:team/repo.git", "dev"), "https://bitbucket.org/team/repo/branch/dev");
  for (const remote of ["git@example.com:o/r.git", "https://example.com/o/r", "file:///tmp/repo", "/tmp/repo", "github.com:o/r", "https://github.com/onlyowner", "", "https://github.com/o\n/r", "https://github.com/a/b/c"]) {
    assert.equal(branchWebUrl(remote, "main"), null, remote);
  }
  assert.equal(branchWebUrl("git@github.com:o/r.git", null), null, "detached HEAD has no branch page");
  assert.equal(parseRemoteUrl("https://user:token@github.com/o/r").base.includes("token"), false);
});

test("check rollups summarize to passing, failing, pending or none", () => {
  assert.equal(summarizeChecks([]), "none");
  assert.equal(summarizeChecks(undefined), "none");
  assert.equal(summarizeChecks([{ __typename: "CheckRun", status: "COMPLETED", conclusion: "SUCCESS" }, { __typename: "StatusContext", state: "SUCCESS" }, { status: "COMPLETED", conclusion: "SKIPPED" }]), "passing");
  assert.equal(summarizeChecks([{ status: "IN_PROGRESS", conclusion: "" }, { status: "COMPLETED", conclusion: "SUCCESS" }]), "pending");
  assert.equal(summarizeChecks([{ state: "PENDING" }]), "pending");
  assert.equal(summarizeChecks([{ status: "IN_PROGRESS" }, { status: "COMPLETED", conclusion: "FAILURE" }]), "failing");
  assert.equal(summarizeChecks([{ state: "ERROR" }]), "failing");
  assert.deepEqual(parsePullRequest(JSON.stringify({ number: 12, url: "https://github.com/o/r/pull/12", state: "OPEN", isDraft: true, statusCheckRollup: [] })),
    { number: 12, url: "https://github.com/o/r/pull/12", state: "OPEN", draft: true, checks: "none" });
  for (const bad of ["nope", "{}", JSON.stringify({ number: 1, url: "javascript:alert(1)", state: "OPEN" }), JSON.stringify({ number: 1, url: "https://x", state: "WEIRD" })]) {
    assert.equal(parsePullRequest(bad), null, bad);
  }
});

test("remote info reads origin, branch and gh, caches per folder, and tolerates gh failures", { timeout: 30000 }, async (t) => {
  const root = await tempDir(t, "pzza-review-remote-");
  const repo = path.join(root, "repo");
  const git = await makeRepo(repo);
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await git("add", ".");
  await git("commit", "-qm", "init");
  await git("checkout", "-qb", "feature/x");
  await git("remote", "add", "origin", "git@github.com:pzza/code.git");
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const fakeGh = path.join(bin, "gh");
  const pr = { number: 7, url: "https://github.com/pzza/code/pull/7", state: "OPEN", isDraft: false, statusCheckRollup: [{ status: "COMPLETED", conclusion: "SUCCESS" }] };
  await writeFile(fakeGh, `#!/bin/sh\necho call >> ${JSON.stringify(path.join(root, "gh-calls"))}\nprintf '%s' '${JSON.stringify(pr)}'\n`);
  await chmod(fakeGh, 0o755);
  const expected = { web: "https://github.com/pzza/code/tree/feature/x", pr: { number: 7, url: pr.url, state: "OPEN", draft: false, checks: "passing" }, ghAvailable: true };
  clearGitRemoteCache();
  assert.deepEqual(await gitRemote({ host: "", path: repo }, { ghCommand: fakeGh }), expected);
  assert.deepEqual(await gitRemote({ host: "", path: repo }, { ghCommand: fakeGh }), expected);
  assert.equal((await run("wc", ["-l", path.join(root, "gh-calls")])).stdout.trim().split(/\s+/)[0], "1", "second call is served from the cache");
  // An hour later the entry has expired.
  const later = () => Date.now() + 3600 * 1000;
  assert.deepEqual(await gitRemote({ host: "", path: repo }, { ghCommand: path.join(bin, "missing-gh"), now: later }), { ...expected, pr: null, ghAvailable: false });
  // gh exit 4 means it is not logged in.
  const authGh = path.join(bin, "gh-auth");
  await writeFile(authGh, "#!/bin/sh\nexit 4\n");
  await chmod(authGh, 0o755);
  clearGitRemoteCache();
  assert.deepEqual(await gitRemote({ host: "", path: repo }, { ghCommand: authGh }), { ...expected, pr: null, ghAvailable: false });
  // The device script finds gh on PATH the same way.
  clearGitRemoteCache();
  const device = shellDevice(bin);
  assert.deepEqual(await gitRemote({ host: "devbox", path: repo }, { execImpl: device.execImpl }), expected);
  await git("checkout", "-q", "--detach");
  clearGitRemoteCache();
  assert.equal((await gitRemote({ host: "devbox", path: repo }, { execImpl: device.execImpl })).web, null);
  clearGitRemoteCache();
  await assert.rejects(gitRemote({ host: "", path: root }, { ghCommand: fakeGh }), /not inside a Git repository/);
});

test("worktrees report merged, dirty, locked and current, and removal is guarded", { timeout: 60000 }, async (t) => {
  const root = await tempDir(t, "pzza-review-worktrees-");
  const repo = path.join(root, "repo");
  const git = await makeRepo(repo);
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await git("add", ".");
  await git("commit", "-qm", "init");
  const wt = (name) => path.join(root, "repo.worktrees", name);
  for (const name of ["merged", "work", "dirty", "locked", "remote"]) await git("worktree", "add", "-q", "-b", `pzza/${name}`, wt(name));
  await writeFile(path.join(wt("work"), "w.txt"), "w\n");
  await run("git", ["-C", wt("work"), "add", "."]);
  await run("git", ["-C", wt("work"), "commit", "-qm", "work"]);
  await writeFile(path.join(wt("dirty"), "untracked.txt"), "u\n");
  await git("worktree", "lock", wt("locked"));
  const device = shellDevice();
  for (const [host, options] of [["", {}], ["devbox", { execImpl: device.execImpl }]]) {
    const listed = await gitWorktrees({ host, path: wt("work") }, options);
    assert.equal(listed.base, "main");
    const byName = Object.fromEntries(listed.worktrees.map((entry) => [entry.branch, entry]));
    assert.equal(listed.worktrees[0].path, repo);
    assert.equal(listed.worktrees[0].main, true);
    assert.equal(byName["pzza/merged"].merged, true, host);
    assert.equal(byName["pzza/merged"].dirty, false, host);
    assert.equal(byName["pzza/work"].merged, false, host);
    assert.equal(byName["pzza/work"].current, true, host);
    assert.equal(byName["pzza/merged"].current, false, host);
    assert.equal(byName["pzza/dirty"].dirty, true, host);
    assert.equal(byName["pzza/locked"].locked, true, host);
    assert.match(byName["pzza/work"].head, /^[0-9a-f]{40}$/);
  }
  const remove = (worktree, deleteBranch, host = "", options = {}) => gitRemoveWorktree({ host, path: repo, worktree, deleteBranch }, options);
  await assert.rejects(remove(wt("dirty"), true), /uncommitted or untracked changes/);
  await assert.rejects(remove(wt("locked"), true), /locked/);
  await assert.rejects(remove(repo, true), /main worktree cannot be removed/);
  await assert.rejects(remove(path.join(root, "elsewhere"), true), /not one of this repository's worktrees/);
  assert.deepEqual(await remove(wt("merged"), true), { removed: true, branchDeleted: true });
  await assert.rejects(stat(wt("merged")), { code: "ENOENT" });
  await assert.rejects(git("rev-parse", "--verify", "-q", "refs/heads/pzza/merged"));
  // git branch -d refuses the unmerged branch, so it survives the removal.
  assert.deepEqual(await remove(wt("work"), true), { removed: true, branchDeleted: false });
  assert.match(await git("rev-parse", "--verify", "-q", "refs/heads/pzza/work"), /^[0-9a-f]{40}/);
  await assert.rejects(remove(wt("dirty"), false, "devbox", { execImpl: device.execImpl }), /uncommitted/);
  assert.deepEqual(await remove(wt("remote"), false, "devbox", { execImpl: device.execImpl }), { removed: true, branchDeleted: false });
  assert.match(await git("rev-parse", "--verify", "-q", "refs/heads/pzza/remote"), /^[0-9a-f]{40}/, "branch kept when not asked to delete");
  await stat(path.join(wt("dirty"), "untracked.txt"));
});

test("squash and rebase merges count as merged and delete their branch; unmerged work is never deleted", { timeout: 60000 }, async (t) => {
  const root = await tempDir(t, "pzza-review-squash-");
  const repo = path.join(root, "repo");
  const git = await makeRepo(repo);
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await git("add", ".");
  await git("commit", "-qm", "init");
  const wt = (name) => path.join(root, "repo.worktrees", name);
  const commit = async (name, file, text) => {
    await writeFile(path.join(wt(name), file), text);
    await run("git", ["-C", wt(name), "add", "."]);
    await run("git", ["-C", wt(name), "commit", "-qm", `${name} ${file}`]);
    return (await run("git", ["-C", wt(name), "rev-parse", "HEAD"])).stdout.trim();
  };
  const names = ["squash", "rebase", "open", "partial", "squash-remote", "rebase-remote", "empty"];
  for (const name of names) await git("worktree", "add", "-q", "-b", `pzza/${name}`, wt(name));
  // Squash merges: two commits land on main as one new commit with the net change.
  for (const name of ["squash", "squash-remote"]) {
    await commit(name, `${name}.txt`, "1\n");
    await commit(name, `${name}.txt`, "2\n");
    await git("merge", "--squash", "-q", `pzza/${name}`);
    await git("commit", "-qm", `Squash ${name}`);
  }
  // Rebase merges: the same patches are replayed on main as new commits.
  for (const name of ["rebase", "rebase-remote"]) {
    await git("cherry-pick", await commit(name, `${name}.txt`, "r\n"));
  }
  await commit("open", "open.txt", "o\n");
  // Only the first of two commits reached main.
  const first = await commit("partial", "p1.txt", "1\n");
  await commit("partial", "p2.txt", "2\n");
  await git("cherry-pick", first);
  await run("git", ["-C", wt("empty"), "commit", "-q", "--allow-empty", "-m", "nothing"]);
  await writeFile(path.join(repo, "later.txt"), "later\n");
  await git("add", ".");
  await git("commit", "-qm", "later work on main");

  const device = shellDevice();
  for (const [host, options] of [["", {}], ["devbox", { execImpl: device.execImpl }]]) {
    const listed = await gitWorktrees({ host, path: repo }, options);
    const by = Object.fromEntries(listed.worktrees.map((entry) => [entry.branch, entry]));
    assert.deepEqual([by["pzza/squash"].merged, by["pzza/squash"].mergedBy], [true, "squash"], host);
    assert.deepEqual([by["pzza/rebase"].merged, by["pzza/rebase"].mergedBy], [true, "patch"], host);
    for (const name of ["open", "partial", "empty"]) {
      assert.deepEqual([by[`pzza/${name}`].merged, by[`pzza/${name}`].mergedBy], [false, null], `${host} ${name}`);
    }
    assert.equal(by.main.mergedBy, "ancestor", host);
  }

  const remove = (name, host = "", options = {}) => gitRemoveWorktree({ host, path: repo, worktree: wt(name), deleteBranch: true }, options);
  const branchExists = async (name) => git("rev-parse", "--verify", "-q", `refs/heads/pzza/${name}`).then(() => true, () => false);
  assert.deepEqual(await remove("squash"), { removed: true, branchDeleted: true });
  assert.deepEqual(await remove("rebase"), { removed: true, branchDeleted: true });
  assert.deepEqual(await remove("squash-remote", "devbox", { execImpl: device.execImpl }), { removed: true, branchDeleted: true });
  assert.deepEqual(await remove("rebase-remote", "devbox", { execImpl: device.execImpl }), { removed: true, branchDeleted: true });
  for (const name of ["squash", "rebase", "squash-remote", "rebase-remote"]) assert.equal(await branchExists(name), false, name);
  // Unmerged work keeps its branch even when deletion is asked for.
  assert.deepEqual(await remove("open"), { removed: true, branchDeleted: false });
  assert.deepEqual(await remove("partial", "devbox", { execImpl: device.execImpl }), { removed: true, branchDeleted: false });
  assert.deepEqual(await remove("empty"), { removed: true, branchDeleted: false });
  for (const name of ["open", "partial", "empty"]) assert.equal(await branchExists(name), true, name);
});

test("the remote command is one ssh call with every argument single-quoted", () => {
  const [cmd, args] = remoteGitReviewCommand("devbox", "echo \"$1\"", ["/tmp/x'; rm -rf /; '"]);
  assert.equal(cmd, "ssh");
  assert.deepEqual(args.slice(0, 7), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "devbox"]);
  assert.equal(args[7], `'sh' '-c' 'echo "$1"' 'pzza-git' '/tmp/x'\\''; rm -rf /; '\\'''`);
});

test("the router validates, answers JSON and rejects other methods", { timeout: 15000 }, async () => {
  const call = async (pathname, method, body) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    let result;
    const handled = await gitReviewRouter(req, {}, new URL(`http://localhost${pathname}`), (_res, status, value) => { result = { status, value }; });
    return { handled, ...result };
  };
  assert.equal((await call("/git/other", "POST", {})).handled, false);
  assert.equal((await call("/git/changes", "GET")).status, 405);
  const invalid = await call("/git/diff", "POST", { path: "/tmp", file: "../etc/passwd" });
  assert.equal(invalid.status, 400);
  assert.equal(typeof invalid.value.error, "string");
  const notRepo = await call("/git/changes", "POST", { path: "/" });
  assert.equal(notRepo.status, 400);
  assert.match(notRepo.value.error, /not inside a Git repository/);
});

test("failing CI logs are fetched with gh, trimmed per job and saved inside the git dir on both paths", { timeout: 60000 }, async (t) => {
  const root = await tempDir(t, "pzza-ci-");
  const repo = path.join(root, "repo");
  const git = await makeRepo(repo);
  await writeFile(path.join(repo, "a.txt"), "a\n");
  await git("add", ".");
  await git("commit", "-qm", "init");
  await git("checkout", "-qb", "feature/ci");
  const sha = "a".repeat(40), older = "b".repeat(40);
  // Newest first, like gh: the newest commit has a failed and a passing run;
  // the older commit's failure is superseded.
  const runs = [
    { databaseId: 11, workflowName: "CI", headSha: sha, conclusion: "failure" },
    { databaseId: 12, workflowName: "Lint", headSha: sha, conclusion: "success" },
    { databaseId: 13, workflowName: "Deploy\u0007", headSha: sha, conclusion: "timed_out" },
    { databaseId: 9, workflowName: "CI", headSha: older, conclusion: "failure" },
  ];
  const testLines = Array.from({ length: 250 }, (_, index) => `test\tRun tests\t﻿2026-11-08T10:00:00Z line ${index + 1}\r`);
  const fixtures = path.join(root, "fixtures");
  await mkdir(fixtures);
  await writeFile(path.join(fixtures, "runs.json"), JSON.stringify(runs));
  await writeFile(path.join(fixtures, "logs-11.txt"), [`build\tCompile\t\u001b[31merror TS2322\u001b[0m: bad type`, "", ...testLines, ""].join("\n"));
  const bin = path.join(root, "bin");
  await mkdir(bin);
  const calls = path.join(root, "gh-calls");
  const fakeGh = path.join(bin, "gh");
  // Run 13 has no failed-step logs yet (gh fails); any other command is unexpected.
  await writeFile(fakeGh, `#!/bin/sh
printf '%s\\n' "$*" >> ${JSON.stringify(calls)}
case "$1 $2" in
  "run list") cat ${JSON.stringify(path.join(fixtures, "runs.json"))} ;;
  "run view") [ -f ${JSON.stringify(fixtures)}/logs-$3.txt ] || { echo "run $3 is still in progress" >&2; exit 1; }; cat ${JSON.stringify(fixtures)}/logs-$3.txt ;;
  *) exit 2 ;;
esac
`);
  await chmod(fakeGh, 0o755);

  const local = await gitCiFailures({ host: "", path: repo }, { ghCommand: fakeGh });
  const logFile = path.join(repo, ".git", "pzzacode", "ci-failure.log");
  assert.deepEqual(local, { branch: "feature/ci", sha, path: logFile, checks: ["build", "test"] });
  const expected = [
    `CI failure logs for feature/ci at ${sha}`,
    "Failed steps only: the last 200 lines of each failed job.",
    "",
    "=== CI (run 11) ===",
    "--- job: build ---",
    "Compile\terror TS2322: bad type",
    "--- job: test (last 200 of 250 lines) ---",
    ...Array.from({ length: 200 }, (_, index) => `Run tests\t2026-11-08T10:00:00Z line ${index + 51}`),
    "",
    "=== Deploy (run 13) ===",
    "(failed step logs unavailable)",
    "",
  ].join("\n");
  assert.equal(await readFile(logFile, "utf8"), expected);
  assert.equal((await stat(logFile)).mode & 0o777, 0o600, "the log file is private");
  assert.equal((await git("status", "--porcelain")).trim(), "", "the log never shows up as a change");
  const listCall = (await readFile(calls, "utf8")).split("\n")[0];
  assert.equal(listCall, "run list --branch=feature/ci --limit 30 --json databaseId,workflowName,headSha,conclusion");

  // The device script finds gh on PATH and writes the same file.
  await rm(logFile);
  const device = shellDevice(bin);
  const remote = await gitCiFailures({ host: "devbox", path: repo }, { execImpl: device.execImpl });
  assert.deepEqual(remote, local);
  assert.equal(await readFile(logFile, "utf8"), expected);
  assert.equal(device.calls.length, 2);

  // A symlinked pzzacode folder is never written through.
  const elsewhere = path.join(root, "elsewhere");
  await mkdir(elsewhere);
  await rm(path.join(repo, ".git", "pzzacode"), { recursive: true });
  await symlink(elsewhere, path.join(repo, ".git", "pzzacode"));
  await assert.rejects(gitCiFailures({ host: "", path: repo }, { ghCommand: fakeGh }), /Could not save the CI logs/);
  await assert.rejects(gitCiFailures({ host: "devbox", path: repo }, { execImpl: device.execImpl }), /Could not save the CI logs/);
  await rm(path.join(repo, ".git", "pzzacode"));

  // gh missing, signed out, nothing failed, not on a branch: clear messages.
  await assert.rejects(gitCiFailures({ host: "", path: repo }, { ghCommand: path.join(bin, "missing-gh") }), /GitHub CLI \(gh\) is not installed/);
  const authGh = path.join(bin, "gh-auth");
  await writeFile(authGh, "#!/bin/sh\nexit 4\n");
  await chmod(authGh, 0o755);
  await assert.rejects(gitCiFailures({ host: "", path: repo }, { ghCommand: authGh }), /not signed in.*gh auth login/);
  await writeFile(path.join(fixtures, "runs.json"), JSON.stringify(runs.map((run) => ({ ...run, conclusion: run.headSha === sha ? "success" : "failure" }))));
  await assert.rejects(gitCiFailures({ host: "", path: repo }, { ghCommand: fakeGh }), /latest GitHub Actions runs of feature\/ci have no failed jobs/);
  await assert.rejects(gitCiFailures({ host: "devbox", path: repo }, { execImpl: device.execImpl }), /no failed jobs/);
  await writeFile(path.join(fixtures, "runs.json"), "[]");
  await assert.rejects(gitCiFailures({ host: "", path: repo }, { ghCommand: fakeGh }), /No GitHub Actions runs found for feature\/ci/);
  const noGhDevice = shellDevice(path.join(root, "no-bin"));
  await git("checkout", "-q", "--detach");
  await assert.rejects(gitCiFailures({ host: "", path: repo }, { ghCommand: fakeGh }), /not on a branch/);
  await assert.rejects(gitCiFailures({ host: "devbox", path: repo }, { execImpl: noGhDevice.execImpl }), /not on a branch/);
  await assert.rejects(gitCiFailures({ host: "", path: root }, { ghCommand: fakeGh }), /not inside a Git repository/);
});

test("CI run selection keeps the newest commit's failed runs only and caps them", () => {
  const sha = "c".repeat(40);
  assert.equal(failedCiRuns("not json"), null);
  assert.equal(failedCiRuns("{}"), null);
  assert.deepEqual(failedCiRuns("[]"), { sha: null, runs: [] });
  const many = Array.from({ length: 6 }, (_, index) => ({ databaseId: index + 1, workflowName: `W${index}`, headSha: sha, conclusion: "failure" }));
  assert.deepEqual(failedCiRuns(JSON.stringify(many)).runs.map((run) => run.id), [1, 2, 3, 4]);
  assert.deepEqual(failedCiRuns(JSON.stringify([{ databaseId: "1; rm", headSha: sha, conclusion: "failure" }])), { sha: null, runs: [] });
  assert.throws(() => validateGitCiFailuresRequest({ path: "/r", run: 1 }));
  assert.deepEqual(validateGitCiFailuresRequest({ host: "devbox", path: "/r" }), { host: "devbox", path: "/r" });
});
