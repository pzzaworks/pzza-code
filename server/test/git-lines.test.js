import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { Readable } from "node:stream";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  GIT_LINES_LIMITS, gitFileBlame, gitFileHead, gitLinesRouter, parseBlame, parseTreeEntry, remoteHeadScript, validateGitFileRequest,
} from "../lib/git-lines.js";

const run = promisify(execFile);

// The editor's file guards only allow the home tree, so fixtures live there.
async function homeDir(t) {
  const dir = await realpath(await mkdtemp(path.join(os.homedir(), ".pzza-git-lines-test-")));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function makeRepo(dir) {
  await mkdir(dir, { recursive: true });
  const git = async (args, env = {}) => (await run("git", ["-C", dir, ...args], { timeout: 10000, env: { ...process.env, ...env } })).stdout;
  await git(["init", "-q", "-b", "main"]);
  await git(["config", "user.name", "Test"]);
  await git(["config", "user.email", "test@example.test"]);
  await git(["config", "commit.gpgsign", "false"]);
  return git;
}

const dated = (when, name = "Test") => ({ GIT_AUTHOR_DATE: when, GIT_COMMITTER_DATE: when, GIT_AUTHOR_NAME: name });

// Stands in for ssh: runs the exact remote command string with a local shell.
function shellDevice() {
  const calls = [];
  const execImpl = (cmd, args, options, callback) => {
    calls.push({ cmd, args });
    execFile("sh", ["-c", args[args.length - 1]], options, callback);
  };
  return { execImpl, calls };
}

test("requests take a safe host and an absolute file path only", () => {
  assert.deepEqual(validateGitFileRequest({ path: "/Users/dev/a.ts" }), { host: "", path: "/Users/dev/a.ts" });
  assert.deepEqual(validateGitFileRequest({ host: "devbox", path: "~/a.ts" }), { host: "devbox", path: "~/a.ts" });
  for (const body of [null, [], {}, { path: "a.ts" }, { path: "/a\nb" }, { path: "/a", extra: 1 }, { host: "bad host", path: "/a" },
    { host: "devbox", path: "/a/../b" }, { path: "/" + "a".repeat(GIT_LINES_LIMITS.pathLength) }]) {
    assert.throws(() => validateGitFileRequest(body), undefined, JSON.stringify(body));
  }
});

test("tree entries count only regular files at HEAD", () => {
  const sha = "a".repeat(40);
  assert.deepEqual(parseTreeEntry(`100644 blob ${sha}     12\tsrc/a.ts\n`), { blob: sha, size: 12 });
  assert.deepEqual(parseTreeEntry(`100755 blob ${sha} 3\trun.sh`), { blob: sha, size: 3 });
  assert.equal(parseTreeEntry(`120000 blob ${sha} 3\tlink`), null);
  assert.equal(parseTreeEntry(`160000 commit ${sha} -\tsub`), null);
  assert.equal(parseTreeEntry(""), null);
});

test("blame parsing maps every line to its commit and refuses gaps or oversized files", () => {
  const a = "a".repeat(40), b = "b".repeat(40);
  const text = [
    `${a} 1 1 2`, "author Ada", "author-time 100", "summary First", "filename f",
    `${a} 2 2`, "filename f",
    `${b} 3 3 1`, "author Bob", "author-time 200", "summary Second", "filename f", "",
  ].join("\n");
  assert.deepEqual(parseBlame(text), {
    commits: [{ hash: a, author: "Ada", time: 100, summary: "First" }, { hash: b, author: "Bob", time: 200, summary: "Second" }],
    lines: [0, 0, 1],
  });
  assert.equal(parseBlame(`${a} 1 1 1\nauthor A\n${a} 3 3 1\n`), null, "a missing line is not guessed");
  assert.equal(parseBlame(`${a} 1 ${GIT_LINES_LIMITS.lines + 1} 1\n`), null);
});

test("HEAD content and blame for a local file, its working edits ignored, plus non-repo, new and refused files", { timeout: 30000 }, async (t) => {
  const home = await homeDir(t);
  const repo = path.join(home, "repo");
  const git = await makeRepo(repo);
  const file = path.join(repo, "src", "a.ts");
  await mkdir(path.dirname(file));
  await writeFile(file, "one\ntwo\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "Add a"], dated("2026-01-01T00:00:00Z", "Ada"));
  await writeFile(file, "one\ntwo\nthree\n");
  await git(["commit", "-qam", "Add three"], dated("2026-02-01T00:00:00Z", "Bob"));
  await writeFile(file, "ONE\ntwo\nthree\nfour\n");

  const head = await gitFileHead({ host: "", path: file });
  assert.equal(head.repo, true);
  assert.equal(head.root, repo);
  assert.equal(head.file, "src/a.ts");
  assert.equal(head.head, "one\ntwo\nthree\n", "HEAD content, not the working file");
  assert.match(head.blob, /^[0-9a-f]{40}$/);
  assert.equal(head.tooLarge, false);

  const blame = await gitFileBlame({ host: "", path: file });
  assert.equal(blame.blob, head.blob);
  assert.deepEqual(blame.commits.map((commit) => [commit.author, commit.summary]), [["Ada", "Add a"], ["Bob", "Add three"]]);
  const byLine = blame.lines.map((at) => blame.commits[at].summary);
  assert.deepEqual(byLine, ["Add a", "Add a", "Add three"]);
  assert.equal(blame.commits.find((commit) => commit.author === "Bob").time, Date.parse("2026-02-01T00:00:00Z") / 1000);

  // A new file in the repository has no HEAD version and no blame.
  const fresh = path.join(repo, "new.ts");
  await writeFile(fresh, "x\n");
  assert.deepEqual(await gitFileHead({ host: "", path: fresh }), { repo: true, root: repo, file: "new.ts", blob: null, head: null, tooLarge: false, binary: false });
  assert.deepEqual((await gitFileBlame({ host: "", path: fresh })).lines, []);

  // Outside any repository.
  const loose = path.join(home, "loose.txt");
  await writeFile(loose, "x\n");
  assert.deepEqual(await gitFileHead({ host: "", path: loose }), { repo: false });
  assert.deepEqual(await gitFileBlame({ host: "", path: loose }), { repo: false });

  // Outside home, credential stores and directories are refused.
  await assert.rejects(gitFileHead({ host: "", path: "/etc/hosts" }), (error) => error.status === 403);
  await assert.rejects(gitFileHead({ host: "", path: path.join(os.homedir(), ".ssh", "id_ed25519") }), (error) => error.status === 403);
  await assert.rejects(gitFileHead({ host: "", path: path.join(repo, "src") }), (error) => error.status === 400);
});

test("large and binary files are skipped instead of sent", { timeout: 30000 }, async (t) => {
  const home = await homeDir(t);
  const repo = path.join(home, "repo");
  const git = await makeRepo(repo);
  await writeFile(path.join(repo, "big.txt"), "x".repeat(GIT_LINES_LIMITS.blobBytes + 10));
  await writeFile(path.join(repo, "long.txt"), "x\n".repeat(GIT_LINES_LIMITS.lines + 5));
  await writeFile(path.join(repo, "bin.dat"), Buffer.from([1, 0, 2, 0]));
  await git(["add", "."]);
  await git(["commit", "-qm", "files"]);
  const big = await gitFileHead({ host: "", path: path.join(repo, "big.txt") });
  assert.equal(big.tooLarge, true);
  assert.equal(big.head, null);
  assert.equal((await gitFileBlame({ host: "", path: path.join(repo, "big.txt") })).tooLarge, true);
  const long = await gitFileHead({ host: "", path: path.join(repo, "long.txt") });
  assert.equal(long.tooLarge, true);
  assert.equal((await gitFileBlame({ host: "", path: path.join(repo, "long.txt") })).tooLarge, true);
  const binary = await gitFileHead({ host: "", path: path.join(repo, "bin.dat") });
  assert.equal(binary.binary, true);
  assert.equal(binary.head, null);
});

test("the remote branch runs one guarded ssh call and answers like the local one", { timeout: 30000 }, async (t) => {
  const home = await homeDir(t);
  const repo = path.join(home, "repo with 'quotes'");
  const git = await makeRepo(repo);
  const file = path.join(repo, "a b.ts");
  await writeFile(file, "one\ntwo\n");
  await git(["add", "."]);
  await git(["commit", "-qm", "Initial"], dated("2026-03-01T00:00:00Z", "Ada"));
  await writeFile(file, "one\n");

  const device = shellDevice();
  const head = await gitFileHead({ host: "devbox", path: file }, { execImpl: device.execImpl });
  assert.deepEqual(head, await gitFileHead({ host: "", path: file }));
  assert.equal(head.head, "one\ntwo\n");
  assert.equal(device.calls.length, 1);
  assert.equal(device.calls[0].cmd, "ssh");
  assert.ok(device.calls[0].args.includes("devbox"));

  const blame = await gitFileBlame({ host: "devbox", path: file }, { execImpl: device.execImpl });
  assert.deepEqual(blame, await gitFileBlame({ host: "", path: file }));
  assert.deepEqual(blame.lines, [0, 0]);
  assert.equal(blame.commits[0].summary, "Initial");

  const loose = path.join(home, "loose.txt");
  await writeFile(loose, "x\n");
  assert.deepEqual(await gitFileHead({ host: "devbox", path: loose }, { execImpl: device.execImpl }), { repo: false });
  await assert.rejects(gitFileHead({ host: "devbox", path: "/etc/hosts" }, { execImpl: device.execImpl }), (error) => error.status === 403);
  await assert.rejects(gitFileBlame({ host: "devbox", path: repo }, { execImpl: device.execImpl }), (error) => error.status === 400);
  assert.match(remoteHeadScript("/x"), /PZZA_DENIED/, "the home guard runs first");
  // An unreachable device is a 503, not a "not a repository".
  const down = (_cmd, _args, _options, callback) => callback(Object.assign(new Error("ssh"), { code: 255 }), Buffer.alloc(0));
  await assert.rejects(gitFileHead({ host: "devbox", path: file }, { execImpl: down }), (error) => error.status === 503);
});

test("the router validates, answers JSON and rejects other methods", { timeout: 15000 }, async (t) => {
  const call = async (pathname, method, body) => {
    const req = Readable.from(body === undefined ? [] : [JSON.stringify(body)]);
    req.method = method;
    let result;
    const handled = await gitLinesRouter(req, {}, new URL(`http://localhost${pathname}`), (_res, status, value) => { result = { status, value }; });
    return { handled, ...result };
  };
  assert.equal((await call("/git/diff", "POST", {})).handled, false);
  assert.equal((await call("/git/file-head", "GET")).status, 405);
  assert.equal((await call("/git/file-blame", "POST", { path: "relative.ts" })).status, 400);
  assert.equal((await call("/git/file-head", "POST", { path: "/etc/hosts" })).status, 403);
  const home = await homeDir(t);
  const loose = path.join(home, "loose.txt");
  await writeFile(loose, "x\n");
  assert.deepEqual(await call("/git/file-head", "POST", { path: loose }), { handled: true, status: 200, value: { repo: false } });
});
