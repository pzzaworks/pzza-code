import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, writeFile, readFile, mkdir, rm, symlink } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { runGitProtection } from "../lib/git-protector.js";
import { toolResult } from "../../mcp/lib/results.js";

const execute = promisify(execFile);
const git = async (cwd, ...args) => (await execute("git", args, { cwd, timeout: 15000 })).stdout.trim();

async function repository(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-git-protection-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await git(root, "init", "-q", "-b", "main");
  await git(root, "config", "user.name", "Protection Test");
  await git(root, "config", "user.email", "test@example.invalid");
  await writeFile(path.join(root, "readme.txt"), "A safe repository.\n");
  await git(root, "add", "readme.txt");
  await git(root, "commit", "-qm", "Create test repository");
  return root;
}

async function stage(root, filename, content = "private configuration\n") {
  await mkdir(path.dirname(path.join(root, filename)), { recursive: true });
  await writeFile(path.join(root, filename), content);
  await git(root, "add", "--", filename);
}

test("protection rejects internal operations and invalid device/repository input", async () => {
  await assert.rejects(runGitProtection({ operation: "hook_push", path: "/tmp" }), /Invalid/);
  await assert.rejects(runGitProtection({ operation: "commit", path: "/tmp", host: "-oProxyCommand=anything" }), /Invalid/);
  assert.equal((await runGitProtection({ operation: "commit", path: "relative" })).approved, false);
  assert.equal(toolResult("git_protect", { approved: false, findings: [] }).isError, true);
});

async function remoteLaunch(t, runtime) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pzza-protection-runtime-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const home = path.join(directory, "home with 'quoted' spaces");
  const bin = path.join(directory, "bin");
  const remoteBin = path.join(directory, "remote-bin");
  for (const folder of [home, bin, remoteBin]) await mkdir(folder);
  const node = runtime === "managed" ? path.join(home, ".local/bin/node")
    : runtime === "nvm" ? path.join(home, ".nvm/versions/node/v24.15.0/bin/node")
      : runtime === "path" ? path.join(remoteBin, "node") : null;
  if (node) {
    await mkdir(path.dirname(node), { recursive: true });
    await symlink(process.execPath, node);
  }
  const profileMarker = path.join(home, "profile-ran");
  for (const filename of [".profile", ".bashrc", ".zshrc"]) await writeFile(path.join(home, filename), 'printf sourced > "$HOME/profile-ran"\n');
  const captured = path.join(directory, "ssh-args.json");
  // Hide host-system runtimes at the executable-check boundary so this fixture
  // exercises NVM even on a development machine with a system-wide Node install.
  const isolatedChecks = 'test() { case "$2" in "$HOME"/*) command test "$@" ;; *) return 1 ;; esac; }; ';
  await writeFile(path.join(bin, "ssh"), `#!${process.execPath}
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');
const args = process.argv.slice(2);
fs.writeFileSync(${JSON.stringify(captured)}, JSON.stringify(args.slice(0, -1)));
const result = spawnSync('/bin/sh', ['-c', ${JSON.stringify(isolatedChecks)} + args.at(-1)], {
  env: { ...process.env, HOME: ${JSON.stringify(home)}, PATH: ${JSON.stringify(remoteBin)} },
  input: fs.readFileSync(0), encoding: 'utf8', timeout: 5000
});
process.stdout.write(result.stdout || '');
process.exitCode = result.status ?? 1;
`, { mode: 0o700 });
  const module = new URL("../lib/git-protector.js", import.meta.url).href;
  const script = `import { runGitProtection } from ${JSON.stringify(module)};
    runGitProtection({ host: 'fixture-device', path: 'relative', operation: 'commit' })
      .then(result => process.stdout.write(JSON.stringify(result)))
      .catch(() => { process.stderr.write('Protection could not verify this device'); process.exitCode = 1; });`;
  const check = async () => {
    const { stdout } = await execute(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home, XDG_CONFIG_HOME: home, PATH: bin }, timeout: 10000,
    });
    return JSON.parse(stdout);
  };
  return { check, captured, profileMarker };
}

for (const runtime of ["path", "managed", "nvm"]) {
  test(`remote protection launches its real worker with the ${runtime} runtime and a minimal SSH PATH`, async t => {
    const boundary = await remoteLaunch(t, runtime);
    const result = await boundary.check();
    assert.equal(result.approved, false);
    assert.match(result.error, /absolute repository path is required/);
    assert.deepEqual(await readFile(boundary.captured, "utf8").then(JSON.parse), [
      "-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5",
      "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "--", "fixture-device",
    ]);
    await assert.rejects(readFile(boundary.profileMarker), /ENOENT/);
  });
}

test("remote protection fails closed when no runtime can be found", async t => {
  const boundary = await remoteLaunch(t, "none");
  await assert.rejects(boundary.check(), /Protection could not verify this device/);
  await assert.rejects(readFile(boundary.profileMarker), /ENOENT/);
});

test("staged environment variants, credentials, and private-key paths block without returning contents", async (t) => {
  const root = await repository(t);
  const content = `private-content-${crypto.randomUUID()}`;
  for (const filename of [".env", ".env.example", "nested/.env.production", "credentials.json", ".credentials", "keys/private.pem", "service-account-production.json", "nested/auth.json"]) await stage(root, filename, content);
  const result = await runGitProtection({ path: root, operation: "commit" });
  assert.equal(result.approved, false);
  assert.equal(result.findings.filter((finding) => finding.rule === "sensitive-file").length, 8);
  assert.equal(JSON.stringify(result).includes(content), false);
});

test("real scanner detects a generated token despite repository allowlists and comments", async (t) => {
  const root = await repository(t);
  const token = "ghp_" + crypto.randomBytes(27).toString("hex").slice(0, 36);
  await writeFile(path.join(root, ".gitleaks.toml"), '[allowlist]\nregexes = [".*"]\n');
  await writeFile(path.join(root, ".gitleaksignore"), "settings.txt:github-pat:1\n");
  await stage(root, "settings.txt", `access_token = "${token}" # gitleaks:allow\n`);
  const result = await runGitProtection({ path: root, operation: "commit" });
  assert.equal(result.approved, false);
  assert.ok(result.findings.some((finding) => finding.path === "settings.txt"));
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("clean commits preserve existing hooks and subsequently block manual unsafe commits", async (t) => {
  const root = await repository(t);
  const original = path.join(root, ".git", "hooks", "pre-commit");
  await writeFile(original, "#!/bin/sh\nprintf ran > .git/existing-hook-ran\n", { mode: 0o700 });
  await stage(root, "safe.txt", "Another safe change.\n");
  const result = await runGitProtection({ path: root, operation: "commit_create", message: "Add safe change\n\n- Keep existing hooks active" });
  assert.equal(result.approved, true);
  assert.match(result.commit, /^[a-f0-9]{40}$/);
  assert.equal(await readFile(path.join(root, ".git", "existing-hook-ran"), "utf8"), "ran");
  assert.equal(await readFile(original, "utf8"), "#!/bin/sh\nprintf ran > .git/existing-hook-ran\n");
  await stage(root, ".env.local");
  await assert.rejects(git(root, "commit", "-qm", "Attempt blocked change"));
  assert.equal(await git(root, "rev-parse", "HEAD"), result.commit);
  assert.equal((await runGitProtection({ path: root, operation: "commit" })).approved, false);
});

test("partial commits scan Git's temporary index and leave unrelated staged files untouched", async (t) => {
  const root = await repository(t);
  await stage(root, "safe.txt", "Initial safe file.\n");
  assert.equal((await runGitProtection({ path: root, operation: "commit_create", message: "Add safe file" })).approved, true);
  await stage(root, ".env.local");
  await writeFile(path.join(root, "safe.txt"), "Updated safe file.\n");
  await git(root, "commit", "-qm", "Commit only the safe file", "--only", "--", "safe.txt");
  assert.equal(await git(root, "show", "HEAD:safe.txt"), "Updated safe file.");
  assert.equal(await git(root, "diff", "--cached", "--name-only"), ".env.local");
});

test("branch checks catch sensitive files removed by a later commit", async (t) => {
  const root = await repository(t);
  const base = await git(root, "rev-parse", "HEAD");
  await stage(root, ".env.production");
  await git(root, "commit", "-qm", "Add configuration");
  await git(root, "rm", ".env.production");
  await git(root, "commit", "-qm", "Remove configuration");
  const result = await runGitProtection({ path: root, operation: "pull_request", base });
  assert.equal(result.approved, false);
  assert.ok(result.findings.some((finding) => finding.path === ".env.production"));
});

test("pre-push blocks unpublished sensitive history, including a new remote branch", async (t) => {
  const root = await repository(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), "pzza-git-remote-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await git(remote, "init", "--bare", "-q");
  await git(root, "remote", "add", "origin", remote);
  assert.equal((await runGitProtection({ path: root, operation: "commit" })).approved, true);
  await git(root, "push", "-qu", "origin", "main");
  const approved = await git(root, "rev-parse", "HEAD");
  await stage(root, "credentials.json");
  // Construct previously unprotected history without invoking a commit hook.
  const tree = await git(root, "write-tree");
  const commit = await git(root, "commit-tree", tree, "-p", approved, "-m", "Imported history");
  await git(root, "update-ref", "refs/heads/main", commit);
  await assert.rejects(git(root, "push", "origin", "main"));
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), approved);
  await assert.rejects(git(root, "push", "origin", "HEAD:refs/heads/new-branch"));
});

test("protection rejects symbolic-link hook directories without overwriting their target", async (t) => {
  const root = await repository(t);
  const outside = await mkdtemp(path.join(os.tmpdir(), "pzza-hook-target-"));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const storage = path.join(root, ".git", "pzzacode-protection");
  await mkdir(storage);
  await symlink(outside, path.join(storage, "hooks"));
  const result = await runGitProtection({ path: root, operation: "commit" });
  assert.equal(result.approved, false);
  await assert.rejects(readFile(path.join(outside, "pre-commit")), /ENOENT/);
});

test("full staged blobs remain protected when binary attributes suppress Git patches", async t => {
  const root = await repository(t);
  const token = "ghp_" + crypto.randomBytes(27).toString("hex").slice(0, 36);
  await stage(root, ".gitattributes", "settings.txt -diff\n");
  await stage(root, "settings.txt", `access_token = "${token}"\n`);
  const result = await runGitProtection({ path: root, operation: "commit" });
  assert.equal(result.approved, false);
  assert.ok(result.findings.some(finding => finding.path === "settings.txt"));
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("symlink-to-file type changes scan the newly staged blob", async t => {
  const root = await repository(t);
  await symlink("readme.txt", path.join(root, "settings.txt"));
  await git(root, "add", "settings.txt");
  await git(root, "commit", "-qm", "Add linked settings");
  await rm(path.join(root, "settings.txt"));
  const token = "ghp_" + crypto.randomBytes(27).toString("hex").slice(0, 36);
  await stage(root, "settings.txt", `access_token = "${token}"\n`);
  assert.match(await git(root, "diff", "--cached", "--name-status"), /^T\s/);
  const result = await runGitProtection({ path: root, operation: "commit" });
  assert.equal(result.approved, false);
  assert.ok(result.findings.some(finding => finding.path === "settings.txt"));
  assert.equal(JSON.stringify(result).includes(token), false);
});

test("merge-resolution changes are inspected even when neither parent contains them", async t => {
  const root = await repository(t);
  const base = await git(root, "rev-parse", "HEAD");
  const clean = await git(root, "write-tree");
  const left = await git(root, "commit-tree", clean, "-p", base, "-m", "Left branch");
  const right = await git(root, "commit-tree", clean, "-p", base, "-m", "Right branch");
  await stage(root, ".env.production");
  const tree = await git(root, "write-tree");
  const merged = await git(root, "commit-tree", tree, "-p", left, "-p", right, "-m", "Resolve merge");
  await git(root, "update-ref", "refs/heads/main", merged);
  const result = await runGitProtection({ path: root, operation: "pull_request", base });
  assert.equal(result.approved, false);
  assert.ok(result.findings.some(finding => finding.path === ".env.production"));
});

test("new push destinations cannot use tracking refs from a different fetch URL to skip history", async t => {
  const root = await repository(t);
  const directory = await mkdtemp(path.join(os.tmpdir(), "pzza-push-targets-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const original = path.join(directory, "original.git");
  const destination = path.join(directory, "destination.git");
  for (const remote of [original, destination]) { await mkdir(remote); await git(remote, "init", "--bare", "-q"); }
  await stage(root, ".env.production");
  await git(root, "commit", "-qm", "Previously private configuration");
  await git(root, "rm", ".env.production");
  await git(root, "commit", "-qm", "Remove configuration from tip");
  await git(root, "remote", "add", "origin", original);
  await git(root, "push", "-qu", "origin", "main");
  assert.equal((await runGitProtection({ path: root, operation: "commit" })).approved, true);
  await git(root, "remote", "set-url", "--push", "origin", destination);
  await assert.rejects(git(root, "push", "origin", "main"));
  assert.equal(await git(destination, "for-each-ref", "--format=%(objectname)"), "");
});

test("worktree-specific hooks configuration enables the effective guard and preserves existing hooks", async t => {
  const root = await repository(t);
  const previous = path.join(root, ".custom-hooks");
  await mkdir(previous);
  await writeFile(path.join(previous, "pre-commit"), "#!/bin/sh\nprintf preserved > .git/worktree-hook-ran\n", { mode: 0o700 });
  await git(root, "config", "extensions.worktreeConfig", "true");
  await git(root, "config", "--worktree", "core.hooksPath", ".custom-hooks");
  const result = await runGitProtection({ path: root, operation: "commit" });
  assert.equal(result.approved, true);
  assert.equal(result.hooksInstalled, true);
  assert.notEqual(await git(root, "config", "--path", "--get", "core.hooksPath"), ".custom-hooks");
  await stage(root, "safe.txt", "Safe worktree change.\n");
  await git(root, "commit", "-qm", "Preserve worktree hooks");
  assert.equal(await readFile(path.join(root, ".git/worktree-hook-ran"), "utf8"), "preserved");
  await stage(root, ".env.local");
  await assert.rejects(git(root, "commit", "-qm", "Block unsafe worktree change"));
});

test("linked worktrees protect their own partial-commit index", async t => {
  const root = await repository(t);
  await stage(root, "safe.txt", "Initial safe contents.\n");
  await git(root, "commit", "-qm", "Add tracked file");
  const linked = await mkdtemp(path.join(os.tmpdir(), "pzza-linked-worktree-"));
  t.after(() => rm(linked, { recursive: true, force: true }));
  await git(root, "worktree", "add", "-qb", "linked", linked);
  assert.equal((await runGitProtection({ path: linked, operation: "commit" })).approved, true);
  await stage(linked, ".env.local");
  await writeFile(path.join(linked, "safe.txt"), "Updated safe contents.\n");
  await git(linked, "commit", "-qm", "Commit the linked worktree file", "--only", "--", "safe.txt");
  assert.equal(await git(linked, "show", "HEAD:safe.txt"), "Updated safe contents.");
  assert.equal(await git(linked, "diff", "--cached", "--name-only"), ".env.local");
  await assert.rejects(git(linked, "commit", "-qm", "Block remaining staged configuration"));
  assert.equal(await git(root, "diff", "--cached", "--name-only"), "");
});

test("prepare-message and post-commit hooks continue running after protection is installed", async t => {
  const root = await repository(t);
  await writeFile(path.join(root, ".git/hooks/prepare-commit-msg"), '#!/bin/sh\nprintf "\\nPrepared by existing hook\\n" >> "$1"\n', { mode: 0o700 });
  await writeFile(path.join(root, ".git/hooks/post-commit"), "#!/bin/sh\nprintf completed > .git/post-commit-ran\n", { mode: 0o700 });
  await stage(root, "safe.txt", "Safe change.\n");
  const result = await runGitProtection({ path: root, operation: "commit_create", message: "Commit with existing hooks" });
  assert.equal(result.approved, true);
  assert.match(await git(root, "log", "-1", "--format=%B"), /Prepared by existing hook/);
  assert.equal(await readFile(path.join(root, ".git/post-commit-ran"), "utf8"), "completed");
});

test("protected commits work inside repositories using ESM package metadata", async t => {
  const root = await repository(t);
  await stage(root, "package.json", JSON.stringify({ name: "protection-fixture", type: "module", private: true }));
  const result = await runGitProtection({ path: root, operation: "commit_create", message: "Configure module package" });
  assert.equal(result.approved, true);
  assert.match(result.commit, /^[a-f0-9]{40}$/);
  await stage(root, "safe.txt", "A later safe change.\n");
  await git(root, "commit", "-qm", "Run installed hooks inside module package");
  assert.equal(await git(root, "show", "HEAD:safe.txt"), "A later safe change.");
  await stage(root, ".env.local");
  await assert.rejects(git(root, "commit", "-qm", "Block unsafe module-package change"));
});

test("blocked pushes never call an existing upload hook", async t => {
  const root = await repository(t);
  const remote = await mkdtemp(path.join(os.tmpdir(), "pzza-upload-order-"));
  t.after(() => rm(remote, { recursive: true, force: true }));
  await git(remote, "init", "--bare", "-q");
  await git(root, "remote", "add", "origin", remote);
  await writeFile(path.join(root, ".git/hooks/pre-push"), "#!/bin/sh\nprintf uploaded > .git/upload-hook-ran\n", { mode: 0o700 });
  assert.equal((await runGitProtection({ path: root, operation: "commit" })).approved, true);
  await git(root, "push", "-q", "origin", "main");
  assert.equal(await readFile(path.join(root, ".git/upload-hook-ran"), "utf8"), "uploaded");
  await rm(path.join(root, ".git/upload-hook-ran"));
  const previous = await git(root, "rev-parse", "HEAD");
  await stage(root, "credentials.json");
  const tree = await git(root, "write-tree");
  const commit = await git(root, "commit-tree", tree, "-p", previous, "-m", "Imported unsafe history");
  await git(root, "update-ref", "refs/heads/main", commit);
  await assert.rejects(git(root, "push", "origin", "main"));
  await assert.rejects(readFile(path.join(root, ".git/upload-hook-ran")), /ENOENT/);
  assert.equal(await git(remote, "rev-parse", "refs/heads/main"), previous);
});

test("LFS pointers require verified local content and that content receives the real secret scan", async t => {
  const root = await repository(t);
  const token = "ghp_" + crypto.randomBytes(27).toString("hex").slice(0, 36);
  const content = Buffer.from(`access_token = "${token}"\n`);
  const hash = crypto.createHash("sha256").update(content).digest("hex");
  const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${hash}\nsize ${content.length}\n`;
  await stage(root, "payload.txt", pointer);
  let result = await runGitProtection({ path: root, operation: "commit" });
  assert.equal(result.approved, false);
  assert.ok(result.findings.some(finding => finding.rule === "unverified-lfs-content"));
  const object = path.join(root, ".git/lfs/objects", hash.slice(0, 2), hash.slice(2, 4), hash);
  await mkdir(path.dirname(object), { recursive: true });
  await writeFile(object, content);
  result = await runGitProtection({ path: root, operation: "commit" });
  assert.equal(result.approved, false);
  assert.ok(result.findings.some(finding => finding.path === "payload.txt" && finding.rule !== "unverified-lfs-content"));
  assert.equal(JSON.stringify(result).includes(token), false);
  await writeFile(object, Buffer.alloc(content.length, 65));
  result = await runGitProtection({ path: root, operation: "commit" });
  assert.equal(result.approved, false);
  assert.ok(result.findings.some(finding => finding.rule === "unverified-lfs-content"));
});

async function githubBoundary(root, state) {
  const directory = path.join(root, ".git/github-boundary");
  await mkdir(directory, { recursive: true });
  const stateFile = path.join(directory, "state.json");
  await writeFile(stateFile, JSON.stringify({ ...state, headReads: 0, created: false }));
  await writeFile(path.join(directory, "gh"), `#!${process.execPath}
const fs = require('node:fs');
const file = process.env.PZZA_GITHUB_TEST_STATE;
const state = JSON.parse(fs.readFileSync(file, 'utf8'));
const args = process.argv.slice(2);
if (process.env.GH_REPO) process.exit(91);
if (args[0] === 'repo' && args[1] === 'view') process.stdout.write('example/project');
else if (args[0] === 'api') {
  const branch = decodeURIComponent(args[1].split('/').at(-1));
  if (branch === 'feature') {
    state.headReads++;
    process.stdout.write(state.changeAfterFirstRead && state.headReads > 1 ? state.base : state.head);
  } else if (branch === 'main') process.stdout.write(state.base);
  else process.exit(92);
} else if (args[0] === 'pr' && args[1] === 'create') {
  state.created = true;
  state.draft = args.includes('--draft');
  process.stdout.write('https://github.com/example/project/pull/123');
} else process.exit(93);
fs.writeFileSync(file, JSON.stringify(state));
`, { mode: 0o700 });
  return {
    state: async () => JSON.parse(await readFile(stateFile, "utf8")),
    async protect(payload) {
      const module = new URL("../lib/git-protector.js", import.meta.url).href;
      const script = `import { runGitProtection } from ${JSON.stringify(module)}; let input = ''; for await (const chunk of process.stdin) input += chunk; process.stdout.write(JSON.stringify(await runGitProtection(JSON.parse(input))));`;
      return new Promise((resolve, reject) => {
        const child = execFile(process.execPath, ["--input-type=module", "-e", script], {
          cwd: root, timeout: 30000,
          env: { ...process.env, PATH: `${directory}${path.delimiter}${process.env.PATH}`, GH_REPO: "unrelated/repository", PZZA_GITHUB_TEST_STATE: stateFile },
        }, (error, stdout) => {
          if (error) return reject(new Error("Protected PR boundary check failed"));
          try { resolve(JSON.parse(stdout)); } catch { reject(new Error("Invalid protected PR response")); }
        });
        child.stdin.end(JSON.stringify(payload));
      });
    },
  };
}

test("protected PR creation checks the published head, scans its body, and rechecks remote revisions", async t => {
  const root = await repository(t);
  const base = await git(root, "rev-parse", "HEAD");
  await git(root, "switch", "-qc", "feature");
  await stage(root, "safe.txt", "Safe branch change.\n");
  await git(root, "commit", "-qm", "Add safe branch content");
  const head = await git(root, "rev-parse", "HEAD");
  const input = { path: root, operation: "pull_request_create", base: "main", title: "Review safe branch", body: "Review the change." };
  let boundary = await githubBoundary(root, { head: base, base });
  let result = await boundary.protect(input);
  assert.equal(result.approved, false);
  assert.match(result.error, /Push the reviewed local branch/);
  assert.equal((await boundary.state()).created, false);

  boundary = await githubBoundary(root, { head, base });
  const token = "ghp_" + crypto.randomBytes(27).toString("hex").slice(0, 36);
  result = await boundary.protect({ ...input, body: `access_token = "${token}"` });
  assert.equal(result.approved, false);
  assert.ok(result.findings.length > 0);
  assert.equal(JSON.stringify(result).includes(token), false);
  assert.equal((await boundary.state()).created, false);

  boundary = await githubBoundary(root, { head, base, changeAfterFirstRead: true });
  result = await boundary.protect(input);
  assert.equal(result.approved, false);
  assert.match(result.error, /remote branch changed/);
  assert.equal((await boundary.state()).created, false);

  boundary = await githubBoundary(root, { head, base });
  result = await boundary.protect(input);
  assert.equal(result.approved, true);
  assert.equal(result.url, "https://github.com/example/project/pull/123");
  assert.equal((await boundary.state()).draft, true);
});
