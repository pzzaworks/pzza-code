import { execFile } from "node:child_process";
import { SSH_TOKEN, shQuote } from "./shell.js";

export { GIT_PROTECTION_INSTRUCTIONS } from "./git-protection-policy.js";

// This self-contained worker also runs on the destination device and from Git
// hooks. Source files and credentials stay there; only redacted findings return.
export async function gitProtectionWorker(input) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const crypto = await import("node:crypto");
  const { execFile } = await import("node:child_process");
  const version = "8.30.1";
  const hashes = {
    darwin_arm64: "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
    darwin_x64: "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
    linux_arm64: "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
    linux_x64: "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
  };
  const fail = (message) => { throw new Error(message); };
  const text = (value, max = 4096) => typeof value === "string" && value.length <= max && !/[\0\r\n]/.test(value);
  if (!input || !text(input.path) || !path.isAbsolute(input.path)) fail("An absolute repository path is required");
  if (!["commit", "push", "pull_request", "commit_create", "pull_request_create", "hook_commit", "hook_push", "hook_message"].includes(input.operation)) fail("Invalid Git protection operation");
  if (input.base !== undefined && (!text(input.base, 256) || input.base.startsWith("-"))) fail("Invalid base reference");
  if ([input.title, input.body, input.message].some((value) => value !== undefined && (typeof value !== "string" || value.includes("\0") || Buffer.byteLength(value) > 256 * 1024))) fail("Invalid Git operation text");
  const hookMode = input.operation.startsWith("hook_");
  const hookIndex = hookMode ? process.env.GIT_INDEX_FILE : undefined;
  const env = { ...process.env, GIT_TERMINAL_PROMPT: "0", GH_PROMPT_DISABLED: "1" };
  // Inherited repository selectors must not redirect a scan away from its path.
  for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_TERMINAL_PROMPT") delete env[key];
  for (const key of Object.keys(env)) if (key.startsWith("GITLEAKS_")) delete env[key];
  delete env.GH_REPO;
  const run = (command, args, options = {}) => new Promise((resolve, reject) => {
    const child = execFile(command, args, { cwd: options.cwd || input.path, env: options.env || env, timeout: 30000, maxBuffer: options.maxBuffer || 16 * 1024 * 1024, encoding: options.encoding || "utf8" }, (error, stdout) => {
      if (error && !options.allowFailure) return reject(new Error(`${path.basename(command)} could not complete the protection check`));
      resolve({ code: error ? (typeof error.code === "number" ? error.code : -1) : 0, output: stdout });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(options.stdin || "");
  });
  const git = async (...args) => (await run("git", ["-c", "core.fsmonitor=false", "-c", "diff.external=", ...args])).output.trim();
  const root = await fs.realpath(await git("rev-parse", "--show-toplevel"));
  input.path = root;
  const common = await fs.realpath(path.resolve(root, await git("rev-parse", "--git-common-dir")));
  const gitDirectory = await fs.realpath(path.resolve(root, await git("rev-parse", "--git-dir")));
  if (hookIndex) {
    const selected = path.resolve(root, hookIndex);
    if (path.dirname(selected) !== gitDirectory) fail("Cannot verify a Git index outside this worktree's private directory");
    const stat = await fs.lstat(selected);
    if (!stat.isFile() || stat.isSymbolicLink()) fail("Cannot verify this Git index");
    env.GIT_INDEX_FILE = selected;
  }
  const worktreeConfig = (await run("git", ["config", "--bool", "--get", "extensions.worktreeConfig"], { allowFailure: true })).output.trim() === "true";
  const privateDirectory = path.join(worktreeConfig ? gitDirectory : common, "pzzacode-protection");
  await fs.mkdir(privateDirectory, { recursive: true, mode: 0o700 });
  const privateStat = await fs.lstat(privateDirectory);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink() || privateStat.uid !== process.getuid()) fail("Git protection storage must be owned by this account");
  await fs.chmod(privateDirectory, 0o700);
  const privateWrite = async (destination, contents, mode = 0o600) => {
    const temporary = `${destination}.${crypto.randomUUID()}`;
    try {
      await fs.writeFile(temporary, contents, { mode, flag: "wx" });
      await fs.rename(temporary, destination);
    } finally { await fs.rm(temporary, { force: true }); }
  };
  const platform = `${process.platform}_${process.arch}`;
  if (!hashes[platform]) fail("Git protection supports macOS and Linux on arm64 or x64");
  const toolDirectory = path.join(os.homedir(), ".cache", "pzzacode", "git-protection", version, platform);
  await fs.mkdir(toolDirectory, { recursive: true, mode: 0o700 });
  if (await fs.realpath(toolDirectory) !== toolDirectory) fail("Git protection cache must not use symbolic links");
  for (let directory = toolDirectory; directory !== os.homedir(); directory = path.dirname(directory)) {
    const stat = await fs.lstat(directory);
    if (!stat.isDirectory() || stat.isSymbolicLink() || stat.uid !== process.getuid() || (stat.mode & 0o022)) fail("Git protection cache must be owned by this account and not writable by others");
  }
  const binary = path.join(toolDirectory, "gitleaks");
  const marker = path.join(toolDirectory, "verified.json");
  const digest = (bytes) => crypto.createHash("sha256").update(bytes).digest("hex");
  let installed = false;
  try {
    const stat = await fs.lstat(binary);
    const markerStat = await fs.lstat(marker);
    const verified = JSON.parse(await fs.readFile(marker, "utf8"));
    installed = stat.isFile() && !stat.isSymbolicLink() && stat.uid === process.getuid() && !(stat.mode & 0o022)
      && markerStat.isFile() && !markerStat.isSymbolicLink() && markerStat.uid === process.getuid() && !(markerStat.mode & 0o077)
      && verified.archive === hashes[platform] && verified.binary === digest(await fs.readFile(binary));
  } catch { /* A missing or modified scanner is never accepted as a clean scan. */ }
  if (!installed) {
    if (hookMode) fail("Git protection scanner is unavailable. Run git_protect before retrying");
    const filename = `gitleaks_${version}_${platform}.tar.gz`;
    const response = await fetch(`https://github.com/gitleaks/gitleaks/releases/download/v${version}/${filename}`, { signal: AbortSignal.timeout(20000) });
    if (!response.ok || !response.url.startsWith("https://")) fail("Could not download the Git protection scanner");
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      if (bytes > 32 * 1024 * 1024) fail("Git protection scanner download exceeds its size limit");
      chunks.push(chunk);
    }
    const archive = Buffer.concat(chunks);
    if (digest(archive) !== hashes[platform]) fail("Git protection scanner checksum verification failed");
    const temporary = await fs.mkdtemp(path.join(toolDirectory, ".install-"));
    try {
      const archivePath = path.join(temporary, filename);
      await fs.writeFile(archivePath, archive, { mode: 0o600, flag: "wx" });
      await run("tar", ["-xzf", archivePath, "-C", temporary, "gitleaks", "LICENSE"]);
      const candidate = path.join(temporary, "gitleaks");
      const stat = await fs.lstat(candidate);
      if (!stat.isFile() || stat.isSymbolicLink()) fail("Invalid Git protection scanner archive");
      const binaryHash = digest(await fs.readFile(candidate));
      await fs.chmod(candidate, 0o700);
      await fs.rename(candidate, binary);
      await fs.rename(path.join(temporary, "LICENSE"), path.join(toolDirectory, "LICENSE"));
      const record = path.join(temporary, "verified.json");
      await fs.writeFile(record, JSON.stringify({ archive: hashes[platform], binary: binaryHash }), { mode: 0o600 });
      await fs.rename(record, marker);
    } finally { await fs.rm(temporary, { recursive: true, force: true }); }
  }
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), "pzzacode-git-check-"));
  await fs.chmod(temporary, 0o700);
  const findings = [];
  try {
    const configuration = path.join(temporary, "rules.toml");
    const ignored = path.join(temporary, "ignore");
    await fs.writeFile(configuration, "[extend]\nuseDefault = true\n", { mode: 0o600 });
    await fs.writeFile(ignored, "", { mode: 0o600 });
    const scannerArgs = ["--config", configuration, "--gitleaks-ignore-path", ignored, "--ignore-gitleaks-allow", "--redact=100", "--no-banner", "--no-color", "--log-level", "error", "--report-format", "json", "--report-path", "-", "--timeout", "25"];
    const blobPaths = new Map();
    const scan = async (args, stdin) => {
      const result = await run(binary, [...args, ...scannerArgs], { allowFailure: true, stdin, cwd: temporary });
      if (![0, 1].includes(result.code)) fail("Secret scanning did not finish. The Git operation is blocked");
      let records;
      try { records = JSON.parse(result.output || "[]"); } catch { fail("Secret scanner returned an invalid report"); }
      if (!Array.isArray(records) || (result.code === 1 && records.length === 0)) fail("Secret scanning could not verify this operation");
      for (const record of records) {
        const sources = blobPaths.get(path.basename(record.File || "")) || ["operation text"];
        for (const source of sources) findings.push({ path: source, line: record.StartLine || 1, rule: record.RuleID || "detected-secret" });
      }
    };
    const blockedPath = (file) => file.split("/").some((part) => /^(?:\.env(?:\..*)?|\.envrc|\.netrc|\.npmrc|\.pypirc|\.?(?:credentials|secrets?)(?:(?:[._-][^.]+)*\.(?:json|ya?ml|toml|ini|conf|config|csv|txt|xml))?|auth\.json|id_(?:rsa|dsa|ecdsa|ed25519)(?:\.(?:pem|key))?|.*\.(?:pem|key|p12|pfx|jks|keystore))$/i.test(part))
      || /(?:^|\/)service[-_]?account[^/]*\.json$/i.test(file);
    const inspectPaths = (raw) => {
      const fields = raw.split("\0");
      for (let index = 0; index < fields.length; index++) {
        const entry = /^:[0-7]{6} ([0-7]{6}) [a-f0-9]+ ([a-f0-9]+) [ACMT]$/.exec(fields[index].trim());
        if (!entry) continue;
        const file = fields[++index];
        if (file && blockedPath(file)) findings.push({ path: file, line: 0, rule: "sensitive-file" });
        // Gitlinks reference another repository; regular files and symlink
        // targets have blob contents in this repository and must be scanned.
        if (entry[1] === "160000") continue;
        if (!file || !["100644", "100755", "120000"].includes(entry[1]) || !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(entry[2])) fail("Cannot verify a changed Git object");
        const name = `${entry[2]}.txt`;
        blobPaths.set(name, [...new Set([...(blobPaths.get(name) || []), file])]);
      }
    };
    const scanBlobs = async () => {
      if (!blobPaths.size) return;
      if (blobPaths.size > 5000) fail("This change exceeds the protected scan limit. Split the change before publishing");
      const ids = [...blobPaths.keys()].map((name) => name.slice(0, -4));
      const request = ids.join("\n") + "\n";
      const metadata = (await run("git", ["cat-file", "--batch-check"], { stdin: request })).output.trim().split("\n");
      let total = 0;
      for (let index = 0; index < ids.length; index++) {
        const entry = /^(\w+) blob (\d+)$/.exec(metadata[index] || "");
        if (!entry || entry[1] !== ids[index]) fail("A changed Git blob is unavailable");
        total += Number(entry[2]);
      }
      if (total > 64 * 1024 * 1024) fail("This change exceeds the protected scan size. Split the change before publishing");
      const bytes = (await run("git", ["cat-file", "--batch"], { stdin: request, encoding: "buffer", maxBuffer: 65 * 1024 * 1024 })).output;
      const snapshot = path.join(temporary, "objects");
      await fs.mkdir(snapshot, { mode: 0o700 });
      let offset = 0;
      for (const id of ids) {
        const end = bytes.indexOf(10, offset);
        const entry = /^(\w+) blob (\d+)$/.exec(bytes.subarray(offset, end).toString("ascii"));
        if (end < offset || !entry || entry[1] !== id) fail("Git returned an invalid blob snapshot");
        const size = Number(entry[2]);
        offset = end + 1;
        if (!Number.isSafeInteger(size) || offset + size >= bytes.length || bytes[offset + size] !== 10) fail("Git returned an incomplete blob snapshot");
        let content = bytes.subarray(offset, offset + size);
        if (content.subarray(0, 43).toString().startsWith("version https://git-lfs.github.com/spec/v1")) {
          const pointer = /^version https:\/\/git-lfs.github.com\/spec\/v1\r?\noid sha256:([a-f0-9]{64})\r?\nsize (\d+)\r?\n?$/.exec(content.toString("utf8"));
          let verified = false;
          if (pointer) {
            const configured = await run("git", ["config", "--path", "--get", "lfs.storage"], { allowFailure: true });
            const storage = path.resolve(common, configured.output.trim() || "lfs");
            const file = path.join(storage, "objects", pointer[1].slice(0, 2), pointer[1].slice(2, 4), pointer[1]);
            const expectedSize = Number(pointer[2]);
            if (!Number.isSafeInteger(expectedSize) || expectedSize + total > 64 * 1024 * 1024) fail("LFS content exceeds the protected scan size");
            try {
              const stat = await fs.lstat(file);
              if (stat.isFile() && !stat.isSymbolicLink() && stat.size === expectedSize) {
                const object = await fs.readFile(file);
                if (digest(object) === pointer[1]) { content = object; total += object.length; verified = true; }
              }
            } catch { /* Missing LFS data cannot be approved for upload. */ }
          }
          if (!verified) for (const source of blobPaths.get(`${id}.txt`)) findings.push({ path: source, line: 0, rule: "unverified-lfs-content" });
        }
        await fs.writeFile(path.join(snapshot, `${id}.txt`), content, { mode: 0o600, flag: "wx" });
        offset += size + 1;
      }
      // Full blobs avoid .gitattributes, textconv, binary-diff omissions and
      // repository allowlists. Private regular files also make symlinks inert.
      await scan(["dir", snapshot]);
    };
    const staged = ["commit", "commit_create", "hook_commit", "hook_message"].includes(input.operation);
    const headResult = await run("git", ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    const head = headResult.code === 0 ? headResult.output.trim() : "unborn";
    const tree = await git("write-tree");
    let range = "";
    let prRepository;
    let prBranch;
    let remoteBase;
    const remoteCommit = async (branch) => {
      const value = (await run("gh", ["api", `repos/${prRepository}/commits/${encodeURIComponent(branch)}`, "--jq", ".sha"])).output.trim();
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value)) fail("Could not verify the remote PR branch");
      return value;
    };
    if (input.operation === "pull_request_create") {
      if (!input.title?.trim() || typeof input.body !== "string" || !input.base) fail("PR title, body, and base branch are required");
      prRepository = (await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])).output.trim();
      if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(prRepository)) fail("Cannot identify the PR repository");
      prBranch = await git("symbolic-ref", "--quiet", "--short", "HEAD");
      if (await remoteCommit(prBranch) !== head) fail("Push the reviewed local branch before creating its PR");
      remoteBase = await remoteCommit(input.base);
    }
    if (staged) {
      inspectPaths((await run("git", ["diff", "--cached", "--raw", "--abbrev=64", "-z", "--no-renames", "--diff-filter=ACMT"])).output);
    } else if (input.operation === "hook_push") {
      if (typeof input.updates !== "string" || input.updates.length > 1024 * 1024 || !text(input.remote, 256) || input.remote.startsWith("-")) fail("Invalid push references");
      const ranges = [];
      for (const line of input.updates.trim().split("\n").filter(Boolean)) {
        const fields = line.split(/\s+/);
        if (fields.length !== 4 || !fields.slice(1).filter((_, i) => i !== 1).every((oid) => /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(oid))) fail("Invalid push reference update");
        const [, local, , remote] = fields;
        if (/^0+$/.test(local)) continue;
        if (!/^0+$/.test(remote)) ranges.push(`${remote}..${local}`);
        // Tracking refs may belong to a different fetch/push URL. A new
        // destination branch must pass protection for its full reachable history.
        else ranges.push(local);
      }
      for (const selected of ranges) {
        const args = ["-m", "--full-history", ...selected.split(" ")];
        inspectPaths((await run("git", ["log", "--raw", "--abbrev=64", "-z", "--format=", "--no-renames", "--diff-filter=ACMT", ...args])).output);
        await scan(["stdin"], (await run("git", ["log", "--format=%B", ...args])).output);
      }
      range = ranges.join(";");
    } else {
      let base = remoteBase || input.base;
      if (!base) {
        const candidates = input.operation === "push" ? ["@{upstream}", "refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"] : ["refs/remotes/origin/HEAD", "refs/remotes/origin/main", "refs/remotes/origin/master"];
        for (const candidate of candidates) {
          const resolved = await run("git", ["rev-parse", "--verify", `${candidate}^{commit}`], { allowFailure: true });
          if (resolved.code === 0) { base = resolved.output.trim(); break; }
        }
      }
      if (!base) fail("Specify the remote base branch to protect unpublished commits");
      const baseId = await git("rev-parse", "--verify", `${base}^{commit}`);
      if (!/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(baseId) || head === "unborn") fail("Cannot resolve the branch being protected");
      range = `${baseId}..${head}`;
      inspectPaths((await run("git", ["log", "--raw", "--abbrev=64", "-z", "--format=", "--no-renames", "--diff-filter=ACMT", "-m", "--full-history", range])).output);
      await scan(["stdin"], await git("log", "--format=%B", range));
    }
    await scanBlobs();
    const operationText = [input.message, input.title, input.body].filter((value) => value !== undefined).join("\n");
    if (operationText) await scan(["stdin"], operationText);
    const unique = [...new Map(findings.map((finding) => [JSON.stringify(finding), finding])).values()];
    if (unique.length) return { approved: false, operation: input.operation, findings: unique, scanner: `gitleaks ${version}` };
    const currentHead = await run("git", ["rev-parse", "--verify", "HEAD"], { allowFailure: true });
    if ((currentHead.code === 0 ? currentHead.output.trim() : "unborn") !== head || await git("write-tree") !== tree) fail("Repository changed during protection. Retry the check");
    if (!hookMode) {
      const hooks = path.join(privateDirectory, "hooks");
      await fs.mkdir(hooks, { recursive: true, mode: 0o700 });
      const hookStat = await fs.lstat(hooks);
      if (!hookStat.isDirectory() || hookStat.isSymbolicLink() || hookStat.uid !== process.getuid()) fail("Git hook storage must be owned by this account");
      const settingsPath = path.join(privateDirectory, "hooks.json");
      let settings;
      try { settings = JSON.parse(await fs.readFile(settingsPath, "utf8")); } catch { settings = null; }
      const configured = await run("git", ["config", "--path", "--get", "core.hooksPath"], { allowFailure: true });
      const current = configured.code === 0 ? configured.output.trim() : null;
      if (current !== hooks) settings = { previous: current || path.join(common, "hooks") };
      if (!settings || !text(settings.previous) || settings.previous === hooks) fail("Cannot preserve existing Git hooks safely");
      await privateWrite(settingsPath, JSON.stringify(settings));
      // Extensionless hook files must not inherit an ESM project's package type.
      await privateWrite(path.join(privateDirectory, "package.json"), '{"type":"commonjs"}\n');
      const workerPath = path.join(privateDirectory, "worker.cjs");
      await privateWrite(workerPath, `const worker = ${gitProtectionWorker.toString()};\nmodule.exports = worker;\n`);
      const protectedHooks = ["pre-commit", "pre-merge-commit", "pre-push", "commit-msg"];
      const hookNames = new Set([...protectedHooks, "applypatch-msg", "pre-applypatch", "post-applypatch", "prepare-commit-msg", "post-commit", "pre-rebase", "post-checkout", "post-merge", "pre-receive", "update", "proc-receive", "post-receive", "post-update", "reference-transaction", "push-to-checkout", "pre-auto-gc", "post-rewrite", "sendemail-validate", "fsmonitor-watchman", "p4-changelist", "p4-prepare-changelist", "p4-post-changelist", "p4-pre-submit", "post-index-change"]);
      try { for (const name of await fs.readdir(path.resolve(root, settings.previous))) if (!name.endsWith(".sample")) hookNames.add(name); }
      catch (error) { if (error.code !== "ENOENT") fail("Cannot preserve the existing Git hook directory"); }
      for (const hook of hookNames) {
        const oldHook = path.join(settings.previous, hook);
        const protectedHook = protectedHooks.includes(hook);
        const script = `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const previous = path.resolve(process.cwd(), ${JSON.stringify(oldHook)});
const updates = ${hook === "pre-push" ? "fs.readFileSync(0, 'utf8')" : "''"};
function prior() {
  try { fs.accessSync(previous, fs.constants.X_OK); }
  catch (error) { if (error.code === 'ENOENT' || error.code === 'EACCES') return; throw error; }
  const result = spawnSync(previous, process.argv.slice(2), ${hook === "pre-push" ? "{ stdio: ['pipe', 'inherit', 'inherit'], input: updates }" : "{ stdio: 'inherit' }"});
  if (result.error || result.status !== 0) process.exit(result.status || 1);
}
${protectedHook ? `const worker = require(${JSON.stringify(workerPath)});
async function protect() {
  const result = await worker({ path: process.cwd(), operation: ${JSON.stringify(hook === "pre-push" ? "hook_push" : hook === "commit-msg" ? "hook_message" : "hook_commit")}, updates, remote: process.argv[2] || ''${hook === "commit-msg" ? ', message: fs.readFileSync(process.argv[2], "utf8")' : ""} });
  if (!result.approved) {
    process.stderr.write('Git protection blocked sensitive content:\\n' + result.findings.map(item => JSON.stringify(item.path) + ':' + item.line + ' (' + item.rule + ')').join('\\n') + '\\n');
    process.exit(1);
  }
}
(async () => { ${hook === "pre-push" ? "await protect(); prior();" : "prior(); await protect();"} })().catch(() => { process.stderr.write('Git protection could not verify this operation. Run git_protect to diagnose it.\\n'); process.exitCode = 1; });` : "try { prior(); } catch { process.stderr.write('Cannot run the existing Git hook\\n'); process.exitCode = 1; }"}
`;
        await privateWrite(path.join(hooks, hook), script, 0o700);
      }
      await git("config", worktreeConfig ? "--worktree" : "--local", "core.hooksPath", hooks);
      if (await git("config", "--path", "--get", "core.hooksPath") !== hooks) fail("The effective Git hook configuration did not enable protection");
    }
    const result = { approved: true, operation: input.operation, findings: [], snapshot: digest(`${head}\n${tree}\n${range}\n${operationText}`), scanner: `gitleaks ${version}`, hooksInstalled: !hookMode };
    if (input.operation === "commit_create") {
      if (!input.message?.trim()) fail("A commit message is required");
      const messageFile = path.join(temporary, "message");
      await fs.writeFile(messageFile, input.message, { mode: 0o600 });
      await git("commit", "--file", messageFile);
      return { ...result, commit: await git("rev-parse", "HEAD") };
    }
    if (input.operation === "pull_request_create") {
      if (await remoteCommit(prBranch) !== head || await remoteCommit(input.base) !== remoteBase) fail("The remote branch changed during protection. Retry the check");
      const bodyFile = path.join(temporary, "body");
      await fs.writeFile(bodyFile, input.body, { mode: 0o600 });
      const created = await run("gh", ["pr", "create", "--repo", prRepository, "--base", input.base, "--head", prBranch, "--title", input.title, "--body-file", bodyFile, ...(input.draft === false ? [] : ["--draft"])]);
      const url = created.output.trim();
      if (!/^https:\/\/[^\s/]+\/[^\s]+\/pull\/\d+$/.test(url)) fail("PR creation completed without a recognizable URL; check the repository before retrying");
      return { ...result, url };
    }
    return result;
  } finally { await fs.rm(temporary, { recursive: true, force: true }); }
}

export function runGitProtection(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload) || !["commit", "push", "pull_request", "commit_create", "pull_request_create"].includes(payload.operation)) return Promise.reject(new Error("Invalid Git protection request"));
  const { host = "", ...input } = payload;
  if (typeof host !== "string" || (host && !SSH_TOKEN.test(host))) return Promise.reject(new Error("Invalid device host"));
  const source = `const worker = ${gitProtectionWorker.toString()}; let input = ''; process.stdin.on('data', chunk => { input += chunk; if (input.length > 1024 * 1024) process.exit(1); }); process.stdin.on('end', () => worker(JSON.parse(input)).then(result => process.stdout.write(JSON.stringify(result))).catch(error => { process.stdout.write(JSON.stringify({ approved: false, error: error.message })); process.exitCode = 1; }));`;
  const command = host ? "ssh" : process.execPath;
  const args = host ? ["-T", "-o", "BatchMode=yes", "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=5", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "--", host, `node -e ${shQuote(source)}`] : ["-e", source];
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: 55000, maxBuffer: 1024 * 1024 }, (error, stdout) => {
      try { resolve(JSON.parse(stdout)); } catch { reject(new Error(error ? "Git protection could not reach or verify this device" : "Invalid Git protection response")); }
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify(input));
  });
}

export async function gitProtectorRouter(req, res, url, json) {
  if (url.pathname !== "/git/protect") return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST for Git protection" }); return true; }
  try {
    const { readBody } = await import("./http.js");
    json(res, 200, await runGitProtection(await readBody(req)));
  }
  catch (error) { json(res, 400, { approved: false, error: error.message }); }
  return true;
}
