import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { execFile } from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { groupProjects, migrateProjectOptions, normalizeOptions, originKey, planEnvSync, planSync, projectIdFor, rootExpr, scanProjects, syncScript } from "../lib/projects.js";

const exec = promisify(execFile);
const run = (command, args, options = {}) => exec(command, args, { timeout: 20_000, ...options });
const git = (cwd, ...args) => run("git", ["-C", cwd, ...args]);

async function fixture(t, count) {
  const root = await mkdtemp(path.join(homedir(), ".pzza-sync-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const origin = path.join(root, "origin");
  const projects = path.join(root, "projects");
  await mkdir(origin);
  await mkdir(projects);
  await git(origin, "init", "--initial-branch=main");
  await git(origin, "config", "user.name", "Sync Test");
  await git(origin, "config", "user.email", "sync-test@example.invalid");
  await writeFile(path.join(origin, "tracked.txt"), "initial\n");
  await git(origin, "add", "tracked.txt");
  await git(origin, "commit", "-m", "Initial fixture");
  const plan = [];
  for (let index = 0; index < count; index++) {
    const rel = `repo ${index}`;
    await run("git", ["clone", "--quiet", origin, path.join(projects, rel)]);
    plan.push({ rel, action: "update", origin });
  }
  return { root, origin, projects, plan };
}

const results = (stdout) => stdout.trim().split("\n").map((line) => line.split("\t")).filter(([marker]) => marker === "PZZA_R");

test("parallel scans preserve every repository and dirty/untracked counts", async (t) => {
  const { projects, plan } = await fixture(t, 6);
  await writeFile(path.join(projects, plan[0].rel, "tracked.txt"), "edited\n");
  await writeFile(path.join(projects, plan[1].rel, "untracked.txt"), "untracked\n");
  const updates = [];
  const scan = await scanProjects(
    { root: projects, devices: [{ id: "local", host: "" }, { id: "duplicate", host: "" }] },
    { onProgress: (progress) => updates.push(progress) },
  );
  assert.deepEqual(updates, [
    { completed: 0, total: 1, repos: 0, finished: [] },
    { completed: 1, total: 1, repos: 6, finished: [{ id: "local", error: false }] },
  ]);
  assert.equal(scan.devices[0].error, null);
  const repos = scan.devices[0].repos;
  assert.equal(repos.length, 6);
  assert.deepEqual(repos.map((repo) => repo.rel), plan.map((step) => step.rel));
  assert.equal(repos.find((repo) => repo.rel === plan[0].rel).modified, 1);
  assert.equal(repos.find((repo) => repo.rel === plan[1].rel).untracked, 1);
  assert.ok(repos.every((repo) => repo.branch === "main" && repo.head));
});

test("parallel sync updates all repos, leaves dirty changes alone, and reports failures", async (t) => {
  const { projects, origin, plan } = await fixture(t, 6);
  await writeFile(path.join(origin, "tracked.txt"), "updated\n");
  await git(origin, "commit", "-am", "Update fixture");
  await writeFile(path.join(projects, plan[0].rel, "tracked.txt"), "local edit\n");
  await git(path.join(projects, plan[1].rel), "remote", "set-url", "origin", path.join(projects, "missing"));
  const opts = normalizeOptions({ stashDirty: false, switchToDefault: false });
  const { stdout } = await run("sh", ["-c", syncScript(rootExpr(projects), plan, opts)]);
  const rows = results(stdout);
  assert.equal(rows.length, 6);
  assert.equal(rows.find((row) => row[1] === plan[0].rel)[2], "dirty");
  assert.equal(rows.find((row) => row[1] === plan[1].rel)[2], "failed");
  assert.equal(rows.filter((row) => row[2] === "updated").length, 4);
  assert.equal(await readFile(path.join(projects, plan[0].rel, "tracked.txt"), "utf8"), "local edit\n");
  for (const step of plan.slice(2)) {
    assert.equal(await readFile(path.join(projects, step.rel, "tracked.txt"), "utf8"), "updated\n");
  }
});

test("parallel sync retains stash, branch switching, clone and current behavior", async (t) => {
  const { projects, origin, plan } = await fixture(t, 3);
  const first = path.join(projects, plan[0].rel);
  await git(first, "checkout", "-b", "feature");
  await writeFile(path.join(first, "tracked.txt"), "local edit\n");
  await writeFile(path.join(first, "untracked.txt"), "keep\n");
  plan.push({ rel: "cloned repo", action: "clone", origin });
  const { stdout } = await run("sh", ["-c", syncScript(rootExpr(projects), plan, normalizeOptions())]);
  const rows = results(stdout);
  assert.equal(rows.find((row) => row[1] === plan[0].rel)[2], "stashed");
  assert.equal(rows.filter((row) => row[2] === "current").length, 2);
  assert.equal(rows.find((row) => row[1] === "cloned repo")[2], "cloned");
  assert.equal((await git(first, "branch", "--show-current")).stdout.trim(), "main");
  assert.match((await git(first, "stash", "show", "-p")).stdout, /local edit/);
  assert.equal(await readFile(path.join(first, "untracked.txt"), "utf8"), "keep\n");
});

test("sync runs at most four fetches together and separates nested repositories", async (t) => {
  const { root, origin, projects, plan } = await fixture(t, 6);
  const nested = `${plan[0].rel}/child`;
  await run("git", ["clone", "--quiet", origin, path.join(projects, nested)]);
  plan.splice(1, 0, { rel: nested, action: "update", origin });
  const bin = path.join(root, "bin");
  const log = path.join(root, "fetch.log");
  await mkdir(bin);
  const realGit = (await run("sh", ["-c", "command -v git"])).stdout.trim();
  await writeFile(path.join(bin, "git"), `#!/bin/sh
if [ "$3" = fetch ]; then
  printf 'start\\t%s\\n' "$2" >> "$PZZA_TEST_LOG"
  sleep 0.05
  "$PZZA_TEST_GIT" "$@"
  result=$?
  printf 'end\\t%s\\n' "$2" >> "$PZZA_TEST_LOG"
  exit "$result"
fi
exec "$PZZA_TEST_GIT" "$@"
`, { mode: 0o700 });
  await run("sh", ["-c", syncScript(rootExpr(projects), plan, normalizeOptions({ stashDirty: false, switchToDefault: false }))], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, PZZA_TEST_GIT: realGit, PZZA_TEST_LOG: log },
  });
  const active = new Set();
  let peak = 0;
  for (const line of (await readFile(log, "utf8")).trim().split("\n")) {
    const [event, rel] = line.split("\t");
    if (event === "start") {
      for (const current of active) {
        assert.ok(!rel.startsWith(`${current}/`) && !current.startsWith(`${rel}/`));
      }
      active.add(rel);
      peak = Math.max(peak, active.size);
    } else active.delete(rel);
  }
  assert.equal(active.size, 0);
  assert.ok(peak > 1, "independent repositories should fetch concurrently");
  assert.ok(peak <= 4, "fetch concurrency must remain bounded");
});

test("scan skips dependency/cache/output trees and preserves real nested projects and worktrees", async (t) => {
  const { projects, origin, plan } = await fixture(t, 1);
  const clone = async (rel) => {
    const dest = path.join(projects, rel);
    await mkdir(path.dirname(dest), { recursive: true });
    await run("git", ["clone", "--quiet", origin, dest]);
  };
  for (const rel of ["node_modules/dependency", ".cache/download", ".venv/package", "build/generated", "vendor/dependency"]) await clone(rel);
  const kept = ["dist", "Library/project", "AppData/project", `${plan[0].rel}/packages/nested`, "one/two/three/four"];
  for (const rel of [...kept, "one/two/three/four/five"]) await clone(rel);
  await git(path.join(projects, plan[0].rel), "worktree", "add", "--quiet", "-b", "linked", path.join(projects, "linked"));
  const scan = await scanProjects({ root: projects, devices: [{ id: "local", host: "" }] });
  assert.equal(scan.devices[0].error, null);
  assert.deepEqual(scan.devices[0].repos.map((repo) => repo.rel).sort(), [...kept, plan[0].rel, "linked"].sort());
  assert.equal(scan.devices[0].repos.find((repo) => repo.rel === "linked").branch, "linked");
});

test("consolidated scan keeps tracking, stash, rename, detached and unborn metadata accurate", async (t) => {
  const { projects, origin, plan } = await fixture(t, 2);
  const repo = path.join(projects, plan[0].rel);
  await writeFile(path.join(origin, "remote.txt"), "remote update\n");
  await git(origin, "add", "remote.txt");
  await git(origin, "commit", "-m", "Remote fixture update");
  await git(repo, "fetch", "--quiet");
  await writeFile(path.join(repo, "local.txt"), "local update\n");
  await git(repo, "add", "local.txt");
  await git(repo, "-c", "user.name=Scan Test", "-c", "user.email=scan-test@example.invalid", "commit", "-m", "Local fixture update");
  await writeFile(path.join(repo, "tracked.txt"), "stashed edit\n");
  await git(repo, "stash", "push", "--quiet");
  await git(repo, "mv", "tracked.txt", "renamed.txt");
  await writeFile(path.join(repo, "untracked\nfile.txt"), "untracked\n");
  await git(repo, "config", "status.aheadBehind", "false");
  await git(path.join(projects, plan[1].rel), "checkout", "--detach", "--quiet");
  const empty = path.join(projects, "empty");
  await mkdir(empty);
  await git(empty, "init", "--initial-branch=main");
  const scan = await scanProjects({ root: projects, devices: [{ id: "local", host: "" }] });
  const repos = scan.devices[0].repos;
  const current = repos.find((r) => r.rel === plan[0].rel);
  assert.equal(current.ahead, 1);
  assert.equal(current.behind, 1);
  assert.equal(current.stashes, 1);
  assert.equal(current.modified, 1);
  assert.equal(current.untracked, 1);
  assert.equal(current.head, (await git(repo, "rev-parse", "--short", "HEAD")).stdout.trim());
  assert.equal(current.lastCommitTs, Number((await git(repo, "log", "-1", "--format=%ct")).stdout.trim()));
  assert.equal(repos.find((r) => r.rel === plan[1].rel).branch, "HEAD");
  const unborn = repos.find((r) => r.rel === "empty");
  assert.equal(unborn.branch, "main");
  assert.equal(unborn.head, null);
  assert.equal(unborn.ahead, null);
  assert.equal(unborn.behind, null);
});

test("concurrent scans share work while completed refreshes see new edits", async (t) => {
  const { root, projects, plan } = await fixture(t, 1);
  const bin = path.join(root, "bin");
  const log = path.join(root, "status.log");
  const realGit = (await run("sh", ["-c", "command -v git"])).stdout.trim();
  await mkdir(bin);
  await writeFile(path.join(bin, "git"), `#!/bin/sh
if [ "$4" = status ]; then
  printf 'status\\n' >> "$PZZA_TEST_LOG"
  sleep 0.05
fi
exec "$PZZA_TEST_GIT" "$@"
`, { mode: 0o700 });
  const original = { PATH: process.env.PATH, PZZA_TEST_GIT: process.env.PZZA_TEST_GIT, PZZA_TEST_LOG: process.env.PZZA_TEST_LOG };
  Object.assign(process.env, { PATH: `${bin}:${original.PATH}`, PZZA_TEST_GIT: realGit, PZZA_TEST_LOG: log });
  try {
    const scans = await Promise.all(Array.from({ length: 4 }, (_, index) => scanProjects({ root: projects, devices: [{ id: `local-${index}`, host: "" }] })));
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 1);
    assert.deepEqual(scans.map((scan) => scan.devices[0].id), ["local-0", "local-1", "local-2", "local-3"]);
    scans[0].devices[0].repos[0].branch = "changed report";
    assert.equal(scans[1].devices[0].repos[0].branch, "main");
    await writeFile(path.join(projects, plan[0].rel, "tracked.txt"), "new edit\n");
    const refreshed = await scanProjects({ root: projects, devices: [{ id: "local", host: "" }] });
    assert.equal(refreshed.devices[0].repos[0].modified, 1);
    assert.equal((await readFile(log, "utf8")).trim().split("\n").length, 2);
  } finally {
    for (const [key, value] of Object.entries(original)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
});

test("remote scans reuse the terminal SSH control socket and retry after failures", async (t) => {
  let calls = 0;
  const probe = t.mock.method(childProcess, "execFile", (command, args, options, callback) => {
    calls++;
    assert.equal(command, "ssh");
    assert.ok(args.includes("ControlMaster=auto"));
    assert.ok(args.includes("ControlPath=~/.ssh/pzza-mux-%C"));
    assert.ok(args.includes("ControlPersist=120"));
    assert.ok(args.includes("BatchMode=yes"));
    assert.equal(args.at(-2), "scan-test-device");
    assert.equal(options.timeout, 60000);
    queueMicrotask(() => calls === 1
      ? callback(new Error("connection interrupted"), "", "connection interrupted")
      : callback(null, "PZZA_ROOT\t/home/test/projects\n", ""));
  });
  syncBuiltinESMExports();
  try {
    const body = { root: "~/projects", devices: [{ id: "remote", host: "scan-test-device" }] };
    const failed = await scanProjects(body);
    assert.match(failed.devices[0].error, /connection interrupted/);
    const retried = await scanProjects(body);
    assert.equal(retried.devices[0].error, null);
    assert.equal(calls, 2);
  } finally {
    probe.mock.restore();
    syncBuiltinESMExports();
  }
});

const repoMetadata = (rel, origin, envs = []) => ({ rel, origin, envs });
const deviceMetadata = (id, repos) => ({ id, name: id, host: id, error: null, repos });
const successfulResults = (scan) => new Map(scan.devices.map((device) => [device.id, device.repos.map((repo) => ({
  projectId: projectIdFor(device.id, repo), rel: repo.rel, status: "current",
}))]));
const envMetadata = (hash, mtime) => ({ name: ".env", hash, mtime });

test("repository identity normalizes transport and host, preserving path case and non-default ports", () => {
  const variants = [
    "git@EXAMPLE.com:Org/Repo.git",
    "ssh://git@example.com/Org/Repo",
    "ssh://git@example.com:22/Org/Repo.git",
    "https://example.com/Org/Repo.git",
    "https://example.com:443/Org/Repo.git/",
  ];
  for (const origin of variants) assert.equal(originKey(origin), "example.com/Org/Repo");
  assert.notEqual(originKey(variants[0]), originKey("https://example.com/org/repo.git"));
  assert.notEqual(originKey(variants[0]), originKey("ssh://git@example.com:2222/Org/Repo.git"));
  for (const origin of ["/local/repo", "file:///local/repo", "ftp://example.com/team/repo", "ext::command"]) {
    assert.equal(originKey(origin), null);
  }
  assert.equal(originKey(null), null);
});

test("matching origins in different folders update their own paths and clone the first source path", () => {
  const first = repoMetadata("work/alpha", "git@example.com:team/app.git");
  const second = repoMetadata("personal/different-name", "https://example.com/team/app.git");
  const scan = { devices: [deviceMetadata("a", [first]), deviceMetadata("b", [second]), deviceMetadata("c", [])] };
  const groups = groupProjects(scan);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].members.size, 2);
  const id = projectIdFor("a", first);
  assert.equal(projectIdFor("b", second), id);
  const plans = planSync(scan);
  assert.deepEqual(plans.map((device) => device.plan.map(({ projectId, rel, action }) => ({ projectId, rel, action }))), [
    [{ projectId: id, rel: first.rel, action: "update" }],
    [{ projectId: id, rel: second.rel, action: "update" }],
    [{ projectId: id, rel: first.rel, action: "clone" }],
  ]);
});

test("unrelated same-path origins remain separate and all occupied or competing clones are blocked", () => {
  const first = repoMetadata("same", "https://example.com/team/one.git");
  const second = repoMetadata("same", "https://example.com/team/two.git");
  const scan = { devices: [deviceMetadata("a", [first]), deviceMetadata("b", [second]), deviceMetadata("c", [])] };
  assert.equal(groupProjects(scan).length, 2);
  const plans = planSync(scan);
  assert.deepEqual(plans.map((device) => device.plan.map((step) => step.action)), [["update"], ["update"], []]);
  assert.deepEqual(plans.map((device) => device.skipped.length), [1, 1, 2]);
  assert.ok(plans.every((device) => device.skipped.every((result) => result.status === "failed" && /clone path conflict/.test(result.detail))));
  assert.equal(new Set(plans[2].skipped.map((result) => result.projectId)).size, 2);
});

test("unpublished and unsupported origins at the same path stay device-local and never exchange env files", () => {
  for (const origin of [null, "/local/origin"]) {
    const first = repoMetadata("same", origin, [envMetadata("first", 20)]);
    const second = repoMetadata("same", origin, [envMetadata("second", 10)]);
    const scan = { devices: [deviceMetadata("a", [first]), deviceMetadata("b", [second])] };
    assert.equal(groupProjects(scan).length, 2);
    assert.notEqual(projectIdFor("a", first), projectIdFor("b", second));
    assert.ok(projectIdFor("a", first).startsWith("local:"));
    assert.ok(planSync(scan).every((device) => device.plan.length === 0 && device.skipped.length === 1));
    assert.deepEqual(planEnvSync(scan, successfulResults(scan)), []);
  }
});

test("project ID options isolate unrelated projects sharing a folder name", () => {
  const first = repoMetadata("same", "https://example.com/team/one.git");
  const second = repoMetadata("same", "https://example.com/team/two.git");
  const scan = { devices: [deviceMetadata("a", [first]), deviceMetadata("b", [second])] };
  const options = normalizeOptions({ repos: { [projectIdFor("a", first)]: { enabled: false } } });
  const plans = planSync(scan, options);
  assert.equal(plans[0].plan.length, 0);
  assert.ok(plans[0].skipped.some((result) => result.projectId === projectIdFor("a", first) && result.status === "skipped"));
  assert.equal(plans[1].plan.length, 1);
  assert.equal(plans[1].plan[0].projectId, projectIdFor("b", second));
});

test("duplicate checkouts are all reported, excluded from env sync, and cannot supply a clone path", () => {
  const first = repoMetadata("one", "https://example.com/team/app.git", [envMetadata("newest", 30)]);
  const duplicate = repoMetadata("two", "git@example.com:team/app.git", [envMetadata("other", 40)]);
  const unambiguous = repoMetadata("safe", first.origin, [envMetadata("safe", 10)]);
  const scan = { devices: [deviceMetadata("a", [first, duplicate]), deviceMetadata("b", [unambiguous]), deviceMetadata("c", [])] };
  assert.equal(groupProjects(scan)[0].duplicates.get("a").length, 2);
  const plans = planSync(scan);
  assert.equal(plans[0].plan.length, 0);
  assert.deepEqual(plans[0].skipped.map((result) => result.rel).sort(), ["one", "two"]);
  assert.ok(plans[0].skipped.every((result) => result.status === "failed"));
  assert.equal(plans[2].plan[0].rel, "safe");
  assert.deepEqual(planEnvSync(scan, successfulResults(scan)), []);
  const onlyDuplicates = { devices: [scan.devices[0], scan.devices[2]] };
  assert.ok(planSync(onlyDuplicates).every((device) => device.plan.length === 0));
  assert.equal(planSync(onlyDuplicates)[1].skipped[0].status, "failed");
});

test("env sync routes only successful matching projects using each device's own relative path", () => {
  const first = repoMetadata("source/path", "https://example.com/team/app.git", [envMetadata("new", 20)]);
  const second = repoMetadata("target/path", "git@example.com:team/app.git", [envMetadata("old", 10)]);
  const scan = { devices: [deviceMetadata("a", [first]), deviceMetadata("b", [second]), deviceMetadata("c", [])] };
  const id = projectIdFor("a", first);
  const gitResults = successfulResults(scan);
  gitResults.set("c", [{ projectId: id, rel: first.rel, status: "cloned" }]);
  const jobs = planEnvSync(scan, gitResults);
  assert.deepEqual(jobs.map((job) => [job.projectId, job.from.id, job.srcRel, job.target.id, job.rel]), [
    [id, "a", first.rel, "b", second.rel],
    [id, "a", first.rel, "c", first.rel],
  ]);
  for (const status of ["failed", "dirty", "skipped"]) {
    const unsuccessful = new Map(gitResults);
    unsuccessful.set("a", [{ projectId: id, rel: first.rel, status }]);
    assert.ok(planEnvSync(scan, unsuccessful).every((job) => job.from.id !== "a" && job.target.id !== "a"));
    unsuccessful.set("a", gitResults.get("a"));
    unsuccessful.set("b", [{ projectId: id, rel: second.rel, status }]);
    assert.ok(planEnvSync(scan, unsuccessful).every((job) => job.target.id !== "b"));
  }
  assert.deepEqual(planEnvSync(scan, gitResults, normalizeOptions({ repos: { [id]: { env: false } } })), []);
});

test("coincident clone paths and wrong relative-path reports cannot transfer another project's env files", () => {
  const first = repoMetadata("same", "https://example.com/team/one.git", [envMetadata("one", 20)]);
  const second = repoMetadata("same", "https://example.com/team/two.git", [envMetadata("two", 10)]);
  const scan = { devices: [deviceMetadata("a", [first]), deviceMetadata("b", [second]), deviceMetadata("c", [])] };
  const gitResults = successfulResults(scan);
  gitResults.set("c", [{ projectId: projectIdFor("b", second), rel: "same", status: "cloned" }]);
  const jobs = planEnvSync(scan, gitResults);
  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].from.id, "b");
  assert.equal(jobs[0].target.id, "c");
  assert.equal(jobs[0].projectId, projectIdFor("b", second));
  gitResults.set("c", [{ projectId: projectIdFor("a", first), rel: "wrong", status: "cloned" }]);
  assert.deepEqual(planEnvSync(scan, gitResults), []);
});

test("saved path exclusions migrate against newly available repos without crossing project identities", () => {
  const first = repoMetadata("same", "https://example.com/team/one.git");
  const second = repoMetadata("same", "https://example.com/team/two.git");
  const relocated = repoMetadata("other/path", first.origin);
  const scan = { devices: [deviceMetadata("a", [first]), deviceMetadata("b", [second]), deviceMetadata("c", [relocated])] };
  const firstId = projectIdFor("a", first);
  const secondId = projectIdFor("b", second);
  const options = { repos: { same: { enabled: false, env: true }, "other/path": { env: false }, [firstId]: { enabled: true, env: true } } };
  const migrated = migrateProjectOptions(options, scan);
  assert.deepEqual(migrated.repos[firstId], { enabled: false, env: false });
  assert.deepEqual(migrated.repos[secondId], { enabled: false, env: true });
  assert.equal(migrated.repos.same, undefined);
  assert.equal(options.repos.same.enabled, false);
  assert.deepEqual(migrateProjectOptions(migrated, scan), migrated);
  const identityOnly = migrateProjectOptions({ repos: { [firstId]: { enabled: false } } }, scan);
  assert.equal(identityOnly.repos[secondId], undefined);
});

test("sync refuses an origin changed after planning without touching the worktree", async (t) => {
  const { projects, origin, plan } = await fixture(t, 1);
  const repo = path.join(projects, plan[0].rel);
  await writeFile(path.join(repo, "tracked.txt"), "keep this edit\n");
  await git(repo, "remote", "set-url", "origin", path.join(origin, "changed"));
  const { stdout } = await run("sh", ["-c", syncScript(rootExpr(projects), plan, normalizeOptions())]);
  const rows = results(stdout);
  assert.equal(rows[0][2], "failed");
  assert.match(rows[0][3], /origin changed since scan/);
  assert.equal(await readFile(path.join(repo, "tracked.txt"), "utf8"), "keep this edit\n");
  assert.equal((await git(repo, "stash", "list")).stdout, "");
});

test("scan progress counts failed devices and does not fabricate repositories", async (t) => {
  const { root } = await fixture(t, 0);
  const updates = [];
  const result = await scanProjects(
    { root: path.join(root, "missing"), devices: [{ id: "local", host: "" }] },
    { onProgress: (progress) => updates.push(progress) },
  );
  assert.ok(result.devices[0].error);
  assert.deepEqual(updates.at(-1), {
    completed: 1, total: 1, repos: 0, finished: [{ id: "local", error: true }],
  });
});
