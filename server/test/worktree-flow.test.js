import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createDeviceSession } from "../lib/session-create.js";
import {
  approveWorktreeSetup, normalizeWorktreeConfig, saveWorktreeSetup, setupCommandLine, validateSetupSaveRequest, worktreeSetup,
} from "../lib/worktree-setup.js";
import {
  compareWebUrl, gitMessage, mergeWorktreeBranch, openWorktreePullRequest, pullRequestUrl, validateWorktreeMergeRequest, worktreeInfo,
} from "../lib/worktree-land.js";

const exec = promisify(execFile);
const git = async (dir, ...args) => (await exec("git", ["-C", dir, ...args], { timeout: 15000 })).stdout.trim();

async function tempRoot(t) {
  const root = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "pzza-wt-flow-")));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  return root;
}

async function makeRepo(dir) {
  await fs.mkdir(dir, { recursive: true });
  await git(dir, "init", "-q", "-b", "main");
  for (const [key, value] of [["user.name", "Test"], ["user.email", "test@example.test"], ["commit.gpgsign", "false"]]) await git(dir, "config", key, value);
}

// Real git and /bin/sh; the tmux session itself is stubbed, and the keys typed
// into it are captured.
function sessionRunner() {
  const typed = [];
  const run = (command, args, options, callback) => {
    if (command === "/bin/sh") return execFile(command, args, options, callback);
    if (command === "tmux") { typed.push(args[args.indexOf("-l") + 1]); callback(null, ""); return { stdin: null }; }
    return { stdin: { on() {}, end() { callback(null, JSON.stringify({ ok: true })); } } };
  };
  return { run, typed };
}

test("setup config accepts repository globs and one-line commands only", () => {
  assert.deepEqual(normalizeWorktreeConfig({}), { copy: null, run: [] });
  assert.deepEqual(normalizeWorktreeConfig({ copy: ["./.env", ".env", "config/*.json", "**/.env.local"], run: [" npm install "] }),
    { copy: [".env", "config/*.json", "**/.env.local"], run: ["npm install"] });
  for (const value of [null, [], { extra: 1 }, { copy: "x" }, { copy: ["/etc/passwd"] }, { copy: ["../up"] }, { copy: ["a/../b"] }, { copy: [".git/config"] },
    { copy: [":(top)x"] }, { copy: ["a\\b"] }, { copy: [""] }, { run: ["one\ntwo"] }, { run: [""] }, { run: [42] }, { run: Array(9).fill("x") }]) {
    assert.throws(() => normalizeWorktreeConfig(value));
  }
  assert.throws(() => validateSetupSaveRequest({ path: "/repo", run: [], extra: true }), /Unknown request field/);
  assert.throws(() => validateSetupSaveRequest({ host: "-oProxy", path: "/repo" }), /host/);
  // Each command is one quoted eval word; && stops at the first failure.
  assert.equal(setupCommandLine(["npm install", "echo 'a' # b"], "claude"), "eval 'npm install' && eval 'echo '\\''a'\\'' # b' && claude");
  assert.equal(setupCommandLine(["make"], undefined), "eval 'make'");
});

test("new worktrees copy ignored .env files by default, never through links, and start the agent", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const repo = path.join(root, "app");
  await makeRepo(repo);
  await fs.writeFile(path.join(repo, ".gitignore"), ".env*\nnested/\n");
  await git(repo, "add", ".gitignore");
  await git(repo, "commit", "-qm", "init");
  await fs.writeFile(path.join(repo, ".env"), "TOKEN=1\n", { mode: 0o600 });
  await fs.writeFile(path.join(repo, ".env.local"), "LOCAL=1\n");
  await fs.writeFile(path.join(root, "outside.txt"), "outside\n");
  await fs.symlink(path.join(root, "outside.txt"), path.join(repo, ".env.link"));
  await fs.mkdir(path.join(repo, "nested"));
  await fs.writeFile(path.join(repo, "nested", ".env"), "NESTED=1\n");
  await fs.writeFile(path.join(repo, ".envrc.big"), Buffer.alloc(1024 * 1024 + 1));
  const { run, typed } = sessionRunner();
  const result = await createDeviceSession({ name: "env copy", cwd: repo, worktree: true, agent: { id: "claude", mode: "default" } }, run, { approvalsFile: path.join(root, "approvals.json") });
  const dir = path.join(root, "app.worktrees", "env-copy");
  assert.equal(result.cwd, dir);
  assert.deepEqual(result.setup.copied.sort(), [".env", ".env.local"]);
  assert.deepEqual(result.setup.skipped.map(({ path: file, reason }) => `${file}:${reason}`).sort(), [".env.link:not-file", ".envrc.big:too-large"]);
  assert.equal(await fs.readFile(path.join(dir, ".env"), "utf8"), "TOKEN=1\n");
  assert.equal((await fs.stat(path.join(dir, ".env"))).mode & 0o777, 0o600, "permissions are kept");
  await assert.rejects(fs.lstat(path.join(dir, ".env.link")));
  await assert.rejects(fs.lstat(path.join(dir, "nested", ".env")), "only the repository root by default");
  assert.equal(result.agentStarted, true);
  assert.deepEqual(typed, ["claude --permission-mode manual"], "no setup commands: the agent alone, in its asking mode");
});

test("on another device the copy step is one ssh call with quoted positional arguments", async (t) => {
  const root = await tempRoot(t);
  const calls = [];
  const run = (command, args, options, callback) => {
    calls.push({ command, script: args.at(-1) });
    if (calls.length === 1) { callback(null, "/srv/app.worktrees/api\n\u001emain\n/srv/app 'x'\n"); return { stdin: null }; }
    if (calls.length === 2) { callback(null, "\u001ecopied\n.env\n"); return { stdin: null }; }
    return { stdin: { on() {}, end() { callback(null, JSON.stringify({ ok: true })); } } };
  };
  const result = await createDeviceSession({ name: "api", host: "devbox", cwd: "/srv/app 'x'", worktree: true }, run, { approvalsFile: path.join(root, "approvals.json") });
  assert.deepEqual(result.setup, { copied: [".env"], skipped: [], run: [], unapproved: false, error: null });
  assert.equal(calls[1].command, "ssh");
  assert.ok(calls[1].script.startsWith("'sh' '-c' '"));
  assert.ok(calls[1].script.endsWith("'pzza-worktree-setup' '/srv/app '\\''x'\\''' '/srv/app.worktrees/api' 'ignored' '.env*'"));
});

test("configured setup copies listed files and runs approved commands before the agent, stopping on failure", { timeout: 40000 }, async (t) => {
  const root = await tempRoot(t);
  const repo = path.join(root, "app");
  const approvalsFile = path.join(root, "state", "approvals.json");
  await makeRepo(repo);
  await fs.writeFile(path.join(repo, ".gitignore"), "config/*.local.json\n");
  await fs.mkdir(path.join(repo, ".pzzacode"));
  await fs.mkdir(path.join(repo, "config"));
  await fs.writeFile(path.join(repo, ".pzzacode", "worktree.json"), JSON.stringify({ copy: ["config/*.local.json", "notes.txt"], run: ["npm install", "printf 'step two\\n' >> steps.log # stays inside"] }));
  await git(repo, "add", ".");
  await git(repo, "commit", "-qm", "init");
  await fs.writeFile(path.join(repo, "config", "db.local.json"), "{}\n");
  await fs.writeFile(path.join(repo, "notes.txt"), "untracked, not ignored\n");

  // Not approved yet: the files are copied, the commands wait.
  const first = sessionRunner();
  const pending = await createDeviceSession({ name: "one", cwd: repo, worktree: true, agent: { id: "claude", mode: "default" } }, first.run, { approvalsFile });
  assert.deepEqual(pending.setup.copied.sort(), ["config/db.local.json", "notes.txt"]);
  assert.equal(pending.setup.unapproved, true);
  assert.deepEqual(first.typed, ["claude --permission-mode manual"]);
  assert.equal((await worktreeSetup({ host: "", path: repo }, { approvalsFile })).approved, false);

  // Approving the exact list shown lets the next worktree run it.
  const shown = await worktreeSetup({ host: "", path: repo }, { approvalsFile });
  await assert.rejects(approveWorktreeSetup({ host: "", path: repo, run: ["npm install"] }, { approvalsFile }), { status: 409 });
  assert.equal((await approveWorktreeSetup({ host: "", path: repo, run: shown.run }, { approvalsFile })).approved, true);
  const second = sessionRunner();
  const ready = await createDeviceSession({ name: "two", cwd: repo, worktree: true, agent: { id: "claude", mode: "default" } }, second.run, { approvalsFile });
  assert.equal(ready.setup.unapproved, false);
  assert.equal(ready.agentStarted, true);
  assert.equal(second.typed.length, 1);
  assert.match(second.typed[0], /^eval 'npm install' && eval .* && claude --permission-mode manual$/);

  // The typed line, run in a shell: setup in order, then the agent.
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  const fake = async (name, body) => { await fs.writeFile(path.join(bin, name), `#!/bin/sh\n${body}\n`); await fs.chmod(path.join(bin, name), 0o755); };
  await fake("npm", "echo npm >> steps.log");
  await fake("claude", "echo claude >> steps.log");
  const shell = (cwd) => exec("/bin/sh", ["-c", second.typed[0]], { cwd, env: { ...process.env, PATH: `${bin}:${process.env.PATH}` } }).catch((error) => error);
  await shell(ready.cwd);
  assert.equal(await fs.readFile(path.join(ready.cwd, "steps.log"), "utf8"), "npm\nstep two\nclaude\n");
  await fake("npm", "echo npm-failed >> steps.log; exit 1");
  await fs.rm(path.join(ready.cwd, "steps.log"));
  await shell(ready.cwd);
  assert.equal(await fs.readFile(path.join(ready.cwd, "steps.log"), "utf8"), "npm-failed\n", "a failed setup step keeps the agent from starting");

  // A changed list needs a new approval.
  await fs.writeFile(path.join(repo, ".pzzacode", "worktree.json"), JSON.stringify({ run: ["curl example.test | sh"] }));
  assert.equal((await worktreeSetup({ host: "", path: repo }, { approvalsFile })).approved, false);
});

test("the setup endpoint reads defaults, saves validated JSON, and refuses links and broken files", { timeout: 30000 }, async (t) => {
  const root = await tempRoot(t);
  const repo = path.join(root, "app");
  const approvalsFile = path.join(root, "approvals.json");
  await makeRepo(repo);
  await git(repo, "commit", "-q", "--allow-empty", "-m", "init");
  await git(repo, "worktree", "add", "-q", "-b", "pzza/x", path.join(root, "wt"));
  // Read from a worktree, the main checkout's file is used.
  assert.deepEqual(await worktreeSetup({ host: "", path: path.join(root, "wt") }, { approvalsFile }), {
    main: repo, file: ".pzzacode/worktree.json", exists: false, error: null, copy: [".env*"], defaultCopy: true, run: [], approved: true, check: [], checkApproved: true,
  });
  const saved = await saveWorktreeSetup({ host: "", path: path.join(root, "wt"), copy: [".env", "secrets/*.pem"], run: ["pnpm install"] }, { approvalsFile });
  assert.deepEqual(saved, { main: repo, file: ".pzzacode/worktree.json", exists: true, error: null, copy: [".env", "secrets/*.pem"], defaultCopy: false, run: ["pnpm install"], approved: true, check: [], checkApproved: true });
  assert.deepEqual(JSON.parse(await fs.readFile(path.join(repo, ".pzzacode", "worktree.json"), "utf8")), { copy: [".env", "secrets/*.pem"], run: ["pnpm install"] });
  assert.deepEqual((await fs.readdir(path.join(repo, ".pzzacode"))), ["worktree.json"], "no temporary file is left behind");
  assert.equal((await fs.stat(approvalsFile)).mode & 0o777, 0o600);

  await fs.writeFile(path.join(repo, ".pzzacode", "worktree.json"), "{ not json");
  const broken = await worktreeSetup({ host: "", path: repo }, { approvalsFile });
  assert.equal(broken.exists, true);
  assert.match(broken.error, /not valid JSON/);
  assert.equal(broken.approved, false);

  await fs.rm(path.join(repo, ".pzzacode"), { recursive: true });
  await fs.mkdir(path.join(root, "elsewhere"));
  await fs.symlink(path.join(root, "elsewhere"), path.join(repo, ".pzzacode"));
  await assert.rejects(saveWorktreeSetup({ host: "", path: repo, copy: null, run: [] }, { approvalsFile }), { status: 409, message: /symbolic link/ });
  assert.deepEqual(await fs.readdir(path.join(root, "elsewhere")), []);
  assert.match((await worktreeSetup({ host: "", path: repo }, { approvalsFile })).error, /symbolic link/);
  await assert.rejects(worktreeSetup({ host: "", path: root }, { approvalsFile }), { status: 400, message: /not inside a Git repository/ });
});

// A bare "origin", a main checkout on main and a worktree on pzza/feature.
async function landingRepos(t) {
  const root = await tempRoot(t);
  const origin = path.join(root, "origin.git");
  const main = path.join(root, "app");
  const worktree = path.join(root, "app.worktrees", "feature");
  await exec("git", ["init", "-q", "--bare", "-b", "main", origin]);
  await makeRepo(main);
  await fs.writeFile(path.join(main, "a.txt"), "one\ntwo\nthree\n");
  await git(main, "add", ".");
  await git(main, "commit", "-qm", "init");
  // Fetch and push go to the bare repository; the URL shown is GitHub's.
  await git(main, "remote", "add", "origin", "git@github.com:acme/app.git");
  await git(main, "config", "remote.origin.pushurl", origin);
  await git(main, "push", "-q", origin, "main:main");
  await git(main, "update-ref", "refs/remotes/origin/main", "main");
  await git(main, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
  await git(main, "worktree", "add", "-q", "-b", "pzza/feature", worktree);
  await fs.writeFile(path.join(worktree, "b.txt"), "feature\n");
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-qm", "Add feature");
  const bin = path.join(root, "bin");
  await fs.mkdir(bin);
  const ghLog = path.join(root, "gh.log");
  const gh = async (body) => { await fs.writeFile(path.join(bin, "gh"), `#!/bin/sh\necho "$*" >> '${ghLog}'\n${body}\n`); await fs.chmod(path.join(bin, "gh"), 0o755); };
  const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
  return { root, origin, main, worktree, gh, ghLog, env };
}

test("worktree info tells a linked worktree from the main checkout", { timeout: 30000 }, async (t) => {
  const { main, worktree } = await landingRepos(t);
  assert.deepEqual(await worktreeInfo({ host: "", path: path.join(worktree) }), { linked: true, branch: "pzza/feature", base: "main", main });
  assert.deepEqual(await worktreeInfo({ host: "", path: main }), { linked: false, branch: "main", base: "main", main });
  // Another device runs the same script over ssh, every input quoted.
  const calls = [];
  const execImpl = (cmd, args, options, callback) => { calls.push({ cmd, args }); execFile("sh", ["-c", args.at(-1)], options, callback); };
  assert.equal((await worktreeInfo({ host: "devbox", path: worktree }, { execImpl })).linked, true);
  assert.equal(calls[0].cmd, "ssh");
  assert.ok(calls[0].args.includes("devbox"));
  assert.ok(calls[0].args.at(-1).endsWith(`'pzza-git' '${worktree}'`));
});

test("open PR pushes the branch and runs gh pr create --fill, falling back to the compare page", { timeout: 40000 }, async (t) => {
  const { origin, main, worktree, gh, ghLog, env } = await landingRepos(t);
  await gh(`case "$1" in auth) exit 0 ;; pr) echo 'Creating pull request'; echo 'https://github.com/acme/app/pull/12' ;; esac`);
  const created = await openWorktreePullRequest({ host: "", path: worktree }, { env });
  assert.deepEqual(created, {
    pushed: true, branch: "pzza/feature", base: "main", url: "https://github.com/acme/app/pull/12", created: true,
    compareUrl: "https://github.com/acme/app/compare/main...pzza/feature?expand=1", message: null,
  });
  assert.equal(await git(origin, "rev-parse", "refs/heads/pzza/feature"), await git(worktree, "rev-parse", "HEAD"), "the branch was pushed");
  assert.equal(await git(worktree, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/pzza/feature", "with upstream tracking");
  assert.deepEqual((await fs.readFile(ghLog, "utf8")).trim().split("\n"), ["auth status", "pr create --fill --head pzza/feature --base main"]);

  await gh(`case "$1" in auth) exit 0 ;; pr) echo 'a pull request for branch "pzza/feature" into branch "main" already exists:' >&2; echo 'https://github.com/acme/app/pull/12' >&2; exit 1 ;; esac`);
  const existing = await openWorktreePullRequest({ host: "", path: worktree }, { env });
  assert.equal(existing.url, "https://github.com/acme/app/pull/12");
  assert.equal(existing.created, false);
  assert.match(existing.message, /already exists/);

  await gh(`case "$1" in auth) exit 1 ;; *) echo unexpected; exit 2 ;; esac`);
  const signedOut = await openWorktreePullRequest({ host: "", path: worktree }, { env });
  assert.equal(signedOut.url, null);
  assert.equal(signedOut.compareUrl, "https://github.com/acme/app/compare/main...pzza/feature?expand=1");
  assert.match(signedOut.message, /gh auth login/);

  await assert.rejects(openWorktreePullRequest({ host: "", path: main }, { env }), { status: 409, message: /main checkout, not a worktree/ });
  await git(main, "config", "remote.origin.pushurl", path.join(path.dirname(origin), "missing.git"));
  await assert.rejects(openWorktreePullRequest({ host: "", path: worktree }, { env }), { status: 502, message: /git push failed/ });
});

test("merge runs in the main checkout only when both are clean and it is on the base, and aborts conflicts", { timeout: 40000 }, async (t) => {
  const { root, main, worktree } = await landingRepos(t);
  const merge = (overrides = {}) => mergeWorktreeBranch({ host: "", path: worktree, branch: "pzza/feature", base: "main", ...overrides });
  const before = await git(main, "rev-parse", "HEAD");

  await assert.rejects(merge({ branch: "pzza/other" }), { status: 409, message: /changed since it was shown/ });
  await fs.writeFile(path.join(worktree, "scratch.txt"), "wip\n");
  await assert.rejects(merge(), { status: 409, message: /worktree has uncommitted or untracked changes/ });
  await fs.rm(path.join(worktree, "scratch.txt"));
  await fs.appendFile(path.join(main, "a.txt"), "local edit\n");
  await assert.rejects(merge(), { status: 409, message: /main checkout .* has uncommitted changes/ });
  await git(main, "checkout", "-q", "--", "a.txt");
  await git(main, "checkout", "-q", "-b", "elsewhere");
  await assert.rejects(merge(), { status: 409, message: /main checkout is on elsewhere, not main/ });
  await git(main, "checkout", "-q", "main");
  assert.equal(await git(main, "rev-parse", "HEAD"), before, "nothing was merged while refusing");

  const result = await merge();
  assert.equal(result.merged, true);
  assert.equal(result.commit, await git(main, "rev-parse", "HEAD"));
  assert.equal((await git(main, "rev-list", "--parents", "-n", "1", "HEAD")).split(" ").length, 3, "a merge commit (--no-ff)");
  assert.equal(await fs.readFile(path.join(main, "b.txt"), "utf8"), "feature\n");
  await assert.rejects(merge(), { status: 409, message: /Nothing to merge/ });

  // A conflicting branch: the merge is aborted and main is left as it was.
  const other = path.join(root, "app.worktrees", "clash");
  await git(main, "worktree", "add", "-q", "-b", "pzza/clash", other);
  await fs.writeFile(path.join(other, "a.txt"), "one\nTWO from clash\nthree\n");
  await git(other, "commit", "-qam", "Clash");
  await fs.writeFile(path.join(main, "a.txt"), "one\ntwo from main\nthree\n");
  await git(main, "commit", "-qam", "Main edit");
  const head = await git(main, "rev-parse", "HEAD");
  await assert.rejects(mergeWorktreeBranch({ host: "", path: other, branch: "pzza/clash", base: "main" }), { status: 409, message: /stopped on conflicts in a\.txt\. The merge was aborted/ });
  assert.equal(await git(main, "rev-parse", "HEAD"), head);
  assert.equal(await git(main, "status", "--porcelain"), "");
  await assert.rejects(git(main, "rev-parse", "-q", "--verify", "MERGE_HEAD"));
});

test("land requests validate branches, and helpers build compare pages and clean messages", () => {
  for (const branch of ["-x", "a b", "a..b", "a~1", "", "x".repeat(256), "refs/../x", "a\nb"]) {
    assert.throws(() => validateWorktreeMergeRequest({ path: "/repo", branch, base: "main" }));
  }
  assert.throws(() => validateWorktreeMergeRequest({ path: "/repo", branch: "pzza/x", base: "main", force: true }), /Unknown request field/);
  assert.deepEqual(validateWorktreeMergeRequest({ path: "/repo", branch: "pzza/x", base: "main" }), { host: "", path: "/repo", branch: "pzza/x", base: "main" });
  assert.equal(compareWebUrl("https://gitlab.com/group/sub/app.git", "pzza/x", "main"), "https://gitlab.com/group/sub/app/-/merge_requests/new?merge_request%5Bsource_branch%5D=pzza%2Fx&merge_request%5Btarget_branch%5D=main");
  assert.equal(compareWebUrl("git@bitbucket.org:team/app.git", "pzza/x", null), "https://bitbucket.org/team/app/pull-requests/new?source=pzza%2Fx");
  assert.equal(compareWebUrl("/srv/git/app.git", "pzza/x", "main"), null);
  assert.equal(pullRequestUrl("Creating...\nhttps://github.com/a/b/pull/3\n"), "https://github.com/a/b/pull/3");
  assert.equal(gitMessage("fatal: unable to access 'https://user:tok3n@github.com/a/b/': denied\n"), "unable to access 'https://github.com/a/b/': denied");
});
