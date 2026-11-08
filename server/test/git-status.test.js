import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { mkdtemp, mkdir, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { shQuote } from "../lib/shell.js";
import {
  GIT_STATUS_LIMITS, gitStatus, localGitStatus, parseRemoteGitStatus, parseStatusHeaders,
  remoteGitStatusCommand, remoteGitStatusScript, validateGitStatusRequest,
} from "../lib/git-status.js";

const run = promisify(execFile);

test("git status requests accept only bounded absolute folder paths and safe hosts", () => {
  assert.deepEqual(validateGitStatusRequest({ paths: ["/a", "/a", "/b c"] }), { host: "", paths: ["/a", "/b c"] });
  assert.equal(validateGitStatusRequest({ host: "devbox", paths: ["/a"] }).host, "devbox");
  for (const body of [
    null, [], "x", {}, { paths: [] }, { paths: "/a" }, { paths: ["relative"] }, { paths: ["/a\nb"] }, { paths: ["/a\u0000"] },
    { paths: [42] }, { paths: ["/" + "a".repeat(GIT_STATUS_LIMITS.pathLength)] },
    { paths: Array.from({ length: GIT_STATUS_LIMITS.paths + 1 }, (_, index) => `/p${index}`) },
    { host: "-oProxyCommand=x", paths: ["/a"] }, { host: "a b", paths: ["/a"] }, { host: 7, paths: ["/a"] },
  ]) assert.throws(() => validateGitStatusRequest(body), undefined, JSON.stringify(body));
});

test("porcelain headers become branch, dirty and upstream counts", () => {
  assert.deepEqual(parseStatusHeaders(["# branch.oid abcdef1234", "# branch.head main", "# branch.upstream origin/main", "# branch.ab +2 -1"]),
    { branch: "main", detached: false, dirty: false, ahead: 2, behind: 1 });
  assert.deepEqual(parseStatusHeaders(["# branch.oid abcdef1234", "# branch.head (detached)", "1 .M N... 100644 100644 100644 a b file"]),
    { branch: "abcdef1", detached: true, dirty: true, ahead: null, behind: null });
  assert.equal(parseStatusHeaders([]), null);
});

test("remote status runs one fixed script with every path single-quoted", () => {
  const hostile = "/tmp/x'; touch /tmp/pwned; '";
  const script = remoteGitStatusScript(["/a", hostile]);
  assert.ok(script.startsWith(`for d in '/a' ${shQuote(hostile)}; do`));
  const [cmd, args] = remoteGitStatusCommand("devbox", ["/a"]);
  assert.equal(cmd, "ssh");
  assert.deepEqual(args.slice(0, 7), ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", "devbox"]);
  assert.equal(args[7], `sh -c ${shQuote(remoteGitStatusScript(["/a"]))}`);
  const output = `\u001e/a\n# branch.oid 1\n# branch.head dev\ndirty\n\u001e${hostile}\n`;
  assert.deepEqual(parseRemoteGitStatus(output, ["/a", hostile, "/missing"]), {
    "/a": { branch: "dev", detached: false, dirty: true, ahead: null, behind: null }, [hostile]: null, "/missing": null,
  });
});

test("the remote script quotes hostile paths literally when a shell runs it", async (t) => {
  const root = await mkdtemp("/tmp/pzza-git-script-");
  t.after(() => rm(root, { recursive: true, force: true }));
  // A stand-in git prints the folder it was asked about as a branch name.
  await writeFile(path.join(root, "git"), "#!/bin/sh\nprintf '# branch.oid 1\\n# branch.head %s\\n' \"$(basename \"$2\")\"\n", { mode: 0o700 });
  const hostile = path.join(root, "x'; touch injected; '");
  const { stdout } = await run("sh", ["-c", remoteGitStatusScript([hostile])], { cwd: root, env: { ...process.env, PATH: `${root}:${process.env.PATH}` }, timeout: 5000 });
  assert.equal(parseRemoteGitStatus(stdout, [hostile])[hostile].branch, path.basename(hostile));
  await assert.rejects(stat(path.join(root, "injected")), { code: "ENOENT" });
});

test("a remote device is reached with one bounded ssh call", async () => {
  const calls = [];
  const execImpl = (cmd, args, options, callback) => { calls.push({ cmd, args, options }); callback(null, "\u001e/w\n# branch.oid 1\n# branch.head main\n"); };
  assert.deepEqual(await gitStatus({ host: "devbox", paths: ["/w"] }, { execImpl }), { "/w": { branch: "main", detached: false, dirty: false, ahead: null, behind: null } });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.timeout, GIT_STATUS_LIMITS.remoteMs);
  assert.equal(calls[0].options.maxBuffer, GIT_STATUS_LIMITS.buffer);
  const failing = (_cmd, _args, _options, callback) => callback(new Error("unreachable"));
  await assert.rejects(gitStatus({ host: "devbox", paths: ["/w"] }, { execImpl: failing }), /Could not read Git status/);
});

test("local folders report a real branch and dirty state without a shell", { timeout: 15000 }, async (t) => {
  const root = await mkdtemp("/tmp/pzza-git-local-");
  t.after(() => rm(root, { recursive: true, force: true }));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const git = (...args) => run("git", ["-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.test", ...args], { timeout: 5000 });
  await git("init", "-q", "-b", "feature/footer");
  await writeFile(path.join(repo, "a.txt"), "one\n");
  await git("add", "a.txt");
  await git("commit", "-qm", "init");
  assert.deepEqual(await localGitStatus(repo), { branch: "feature/footer", detached: false, dirty: false, ahead: null, behind: null });
  await writeFile(path.join(repo, "b.txt"), "new\n");
  assert.equal((await localGitStatus(repo)).dirty, true);
  assert.equal(await localGitStatus(path.join(root)), null, "a plain folder is not a repo");
  assert.equal(await localGitStatus(path.join(root, "missing")), null);
  // git receives the path as its own argument, never through a shell.
  const seen = [];
  const spawnImpl = (cmd, args) => { seen.push([cmd, args]); throw new Error("stop"); };
  assert.equal(await localGitStatus("/x; rm -rf /", { spawnImpl }), null);
  assert.deepEqual(seen[0].slice(0, 1), ["git"]);
  assert.deepEqual(seen[0][1].slice(0, 2), ["-C", "/x; rm -rf /"]);
});
