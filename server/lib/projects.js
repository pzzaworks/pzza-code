// Project sync across devices. A "project" is a git repository under the
// projects root (the same $HOME-relative folder on every device, e.g.
// ~/Projects). Sync takes the union of every device's repos: a repo missing on
// a device is cloned there from the origin URL seen elsewhere; a repo that is
// present aligns to remote development when available, otherwise remote main. Modified
// tracked and untracked files are stashed first and retained for recovery, while
// unmerged local commits are retained in durable backup refs. Afterwards every .env / .env.* file is copied from
// the device holding the newest copy to every device where it is missing or
// differs, so secrets follow the project without ever passing through git.
//
// Scans share concurrent reads; sync runs bounded batches and checks live remote
// commit IDs before touching a checkout that is already current.
import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { SSH_TOKEN, shQuote } from "./shell.js";

// How deep below the root we look for repos (root/Org/Group/repo is depth 3).
const SCAN_DEPTH = 4;
const SCAN_TIMEOUT_MS = 60_000;
const SYNC_TIMEOUT_MS = 15 * 60_000;
const DEVICE_CONCURRENCY = 4;
const REPO_CONCURRENCY = 4;
const ENV_CONCURRENCY = 4;
const MAX_OUTPUT = 8 * 1024 * 1024;
const SCAN_SKIP_DIRS = [
  "node_modules", ".cache", ".npm", ".yarn", ".pnpm-store", ".bun",
  ".venv", "venv", "__pycache__", ".pytest_cache", ".mypy_cache", ".ruff_cache",
  ".next", ".nuxt", ".turbo", ".parcel-cache", ".gradle", ".cargo", ".rustup",
  ".Trash", ".Trashes", ".ssh", ".gnupg",
];
const SCAN_OUTPUT_DIRS = ["dist", "dist-ssr", "build", "target", "out", "coverage", "vendor"];
const pendingScans = new Map();
const githubLookups = new Map();
const syncOperations = new Map();
const cancelledRequests = new Map();
const validOperationId = value => typeof value === "string" && /^[a-zA-Z0-9-]{1,80}$/.test(value);
export function cancelProjectSync(operationId) {
  if (!validOperationId(operationId)) return { error: "invalid sync operation" };
  const operation = syncOperations.get(operationId);
  if (operation) operation.cancelled = true;
  else {
    for (const [id, expires] of cancelledRequests) if (expires <= Date.now()) cancelledRequests.delete(id);
    if (cancelledRequests.size >= 128) cancelledRequests.delete(cancelledRequests.keys().next().value);
    cancelledRequests.set(operationId, Date.now() + 60_000);
  }
  return { ok: true };
}

// Where clones may come from: ssh scp-style, ssh://, https:// and git://. The
// URL is quoted before it hits the shell anyway; this guards against a URL that
// git would parse as an option ("-oProxyCommand=...") or a local path.
const REMOTE_URL = /^(?!-)(?:(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9._-]+:(?!\/\/|:)[^\s'"]+|(?:ssh|https?|git):\/\/[^\s'"]+)$/;

// Identity of a repo across devices: its origin, normalized so that
// git@github.com:org/repo.git, ssh://git@github.com/org/repo and
// https://github.com/org/repo.git all collapse to "github.com/org/repo".
export function originKey(url) {
  const value = String(url ?? "").trim();
  if (!REMOTE_URL.test(value)) return null;
  const scp = value.match(/^(?:[^@\s]+@)?([^:/\s]+):(.+)$/);
  let host;
  let repo;
  if (scp && !/^\w+:\/\//.test(value)) {
    host = scp[1].toLowerCase();
    repo = scp[2];
  } else {
    try {
      const parsed = new URL(value);
      if (!["ssh:", "http:", "https:", "git:"].includes(parsed.protocol)) return null;
      const defaultPort = { "ssh:": "22", "git:": "9418" }[parsed.protocol];
      host = parsed.hostname.toLowerCase() + (parsed.port && parsed.port !== defaultPort ? `:${parsed.port}` : "");
      repo = parsed.pathname;
    } catch {
      return null;
    }
  }
  repo = repo.replace(/^\/+|\/+$/g, "").replace(/\.git$/, "");
  return repo ? `${host}/${host === "github.com" ? repo.toLowerCase() : repo}` : null;
}

// Resolve through the authenticated CLI so private transferred repositories can
// be verified without handling credentials here. Failure leaves identity intact.
async function githubRepository(fullName, fresh = false) {
  const key = fullName.toLowerCase();
  const cached = githubLookups.get(key);
  if (cached && (!fresh || cached.expires === Infinity) && cached.expires > Date.now()) return cached.result;
  const entry = { expires: Infinity, result: null };
  entry.result = new Promise((resolve) => {
    execFile("gh", ["api", "--hostname", "github.com", `repos/${fullName}`], { timeout: 8_000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) return resolve(null);
      try {
        const data = JSON.parse(stdout);
        resolve(Number.isSafeInteger(data.id) && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(data.full_name) ? { id: data.id, fullName: data.full_name } : null);
      } catch { resolve(null); }
    });
  }).then(result => {
    entry.expires = Date.now() + (result ? 5 * 60_000 : 30_000);
    return result;
  });
  if (githubLookups.size >= 256) githubLookups.delete(githubLookups.keys().next().value);
  githubLookups.set(key, entry);
  return entry.result;
}

export async function reconcileGithubOrigins(scan, resolveRepository = githubRepository) {
  const lookups = new Map();
  const lookup = (name) => {
    const key = name.toLowerCase();
    if (!lookups.has(key)) lookups.set(key, Promise.resolve().then(() => resolveRepository(name)).catch(() => null));
    return lookups.get(key);
  };
  const repos = scan.devices.flatMap((device) => device.repos);
  // Only resolve an ownership alias when both names actually occur in the
  // scan. Unrelated repositories need no network request to identify them.
  const candidates = new Set(repos.map(repo => originKey(repo.origin)?.match(/^github\.com\/pzzaworks\/([^/]+)$/)?.[1]).filter(Boolean));
  await mapConcurrent(repos, REPO_CONCURRENCY, async (repo) => {
    const match = originKey(repo.origin)?.match(/^github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)$/);
    if (!match) return;
    const [, owner, name] = match;
    if (owner.toLowerCase() === "pzzaworks" || !candidates.has(name.toLowerCase())) return;
    const [original, candidate] = await Promise.all([lookup(`${owner}/${name}`), lookup(`pzzaworks/${name}`)]);
    if (!original || !candidate || !Number.isSafeInteger(original.id) || original.id !== candidate.id ||
        !/^pzzaworks\/[A-Za-z0-9_.-]+$/i.test(candidate.fullName)) return;
    // Preserve the transport used by this checkout, but only after identity proof.
    repo.originalProjectId = `origin:${originKey(repo.origin)}`;
    repo.canonicalOrigin = repo.origin.startsWith("https://") || repo.origin.startsWith("http://")
      ? `https://github.com/${candidate.fullName}.git` : `git@github.com:${candidate.fullName}.git`;
  });
  for (const device of scan.devices) for (const repo of device.repos) repo.projectId = projectIdFor(device.id, repo);
  return scan;
}

export function projectIdFor(deviceId, repo) {
  const origin = originKey(repo.canonicalOrigin ?? repo.origin);
  return origin ? `origin:${origin}` : `local:${JSON.stringify([deviceId, repo.rel])}`;
}

// Folder names are locations, never repository identity. Unpublished projects
// stay device-local; duplicate checkouts are retained so planning can flag them.
export function groupProjects(scan) {
  const groups = new Map();
  for (const d of scan.devices) {
    for (const r of d.repos) {
      const id = projectIdFor(d.id, r);
      let g = groups.get(id);
      if (!g) groups.set(id, (g = { id, members: new Map(), duplicates: new Map() }));
      const previous = g.members.get(d.id);
      if (previous) {
        const copies = g.duplicates.get(d.id) ?? [previous];
        copies.push(r);
        g.duplicates.set(d.id, copies);
      } else g.members.set(d.id, r);
    }
  }
  return [...groups.values()].map((g) => {
    const source = [...g.members].find(([deviceId, repo]) => !g.duplicates.has(deviceId) && originKey(repo.origin));
    const first = source?.[1] ?? g.members.values().next().value;
    return { ...g, rel: first.rel, origin: source ? (first.canonicalOrigin ?? first.origin) : null };
  });
}

// Turn git's failure text into one line that says what to do about it; the
// raw tail follows for anything the table does not know.
const GIT_HINTS = [
  [/Not possible to fast-forward/i, "diverged from origin: local commits are not on origin, push or rebase first"],
  [/refusing to merge unrelated histories/i, "origin has an unrelated history: a different repo answers behind this remote"],
  [/Repository not found|Could not read from remote|does not appear to be a git repository/i, "origin not found: deleted, renamed or no access from this device"],
  [/needs merge|not uptodate\. Cannot merge|You have unmerged paths|unmerged files/i, "an unfinished merge or rebase is in progress, finish or abort it first"],
  [/would be overwritten by checkout/i, "untracked files here would be overwritten by the checkout"],
  [/Permission denied \(publickey\)|Authentication failed/i, "no git access from this device: ssh key or token missing"],
  [/Could not resolve host|Network is unreachable|Connection timed out/i, "no network access to the remote from this device"],
];
export function explainGit(detail) {
  const text = String(detail || "");
  for (const [re, hint] of GIT_HINTS) if (re.test(text)) return `${hint} (${text.trim()})`;
  return text;
}

// Finish migrating saved path settings against the fresh scan used for sync.
// A device may have been offline when the app migrated its visible results.
export function migrateProjectOptions(raw, scan) {
  const options = normalizeOptions(raw);
  const repos = {};
  const projects = groupProjects(scan);
  const ids = new Set(projects.map((p) => p.id));
  for (const p of projects) {
    const paths = new Set([...p.members.values(), ...[...p.duplicates.values()].flat()].map((r) => r.rel));
    const aliases = [...p.members.values(), ...[...p.duplicates.values()].flat()].map((repo) => `origin:${originKey(repo.origin)}`);
    const entries = [options.repos[p.id], ...aliases.map((id) => options.repos[id]), ...[...paths].filter((rel) => !ids.has(rel)).map((rel) => options.repos[rel])].filter(Boolean);
    if (entries.length) repos[p.id] = {
      enabled: entries.every((entry) => entry.enabled !== false),
      env: entries.every((entry) => entry.env !== false),
    };
  }
  return { ...options, repos };
}

// Strip embedded credentials ("https://user:token@host/...") from anything that
// leaves the agent: origin URLs in the scan and git output quoted in results.
export function redact(text) {
  // Any http(s) userinfo is a token; for other schemes only user:password is.
  return String(text ?? "")
    .replace(/(https?:\/\/)[^\s/@]+@/g, "$1***@")
    .replace(/(\w+:\/\/)[^\s/@:]+:[^\s/@]*@/g, "$1***@");
}

// The root must stay inside $HOME: "~", "~/x" or an absolute path, no ".." and
// no shell or glob metacharacters. Returns the shell call that resolves it on
// the device: `pz_root BASE SEG...`, where each segment is matched exactly
// first and case-insensitively second, so ~/Projects on the Mac finds
// ~/projects on a Linux box.
export function rootExpr(root) {
  const r = String(root || "").trim().replace(/\/+$/, "");
  if (!r || r.split("/").includes("..") || /['"\\$`*?[\]]/.test(r)) return null;
  let base;
  let rest;
  if (r === "~" || r.startsWith("~/")) {
    base = '"$h"';
    rest = r.slice(1);
  } else if (r.startsWith("/")) {
    base = "/";
    rest = r;
  } else return null;
  const segs = rest.split("/").filter(Boolean).map(shQuote);
  return `pz_root ${base}${segs.length ? " " + segs.join(" ") : ""}`;
}

// Shell function behind rootExpr: walks BASE/SEG/SEG..., taking an exact
// directory match when there is one and otherwise the first case-insensitive
// match, and prints the resolved path (fails if a segment matches nothing).
const ROOT_FUNC =
  `pz_root() { cur=$1; shift; for seg in "$@"; do ` +
  `if [ -d "\${cur%/}/$seg" ]; then cur="\${cur%/}/$seg"; ` +
  `else m=$(find "$cur" -mindepth 1 -maxdepth 1 -type d -iname "$seg" 2>/dev/null | head -n 1); [ -n "$m" ] || return 1; cur=$m; fi; done; ` +
  `printf '%s\\n' "$cur"; }; `;

// Linked worktrees have a per-worktree Git directory pointing at a separate
// common directory. Submodules and separate-git-dir clones use .git files too,
// but do not have this split, so they remain independent project candidates.
const WORKTREE_FUNC =
  `pz_linked_worktree() ( cd "$1" 2>/dev/null || exit 1; ` +
  `gd=$(git rev-parse --git-dir 2>/dev/null) || exit 1; ` +
  `common=$(git rev-parse --git-common-dir 2>/dev/null) || exit 1; ` +
  `gd=$(cd "$gd" 2>/dev/null && pwd -P) || exit 1; ` +
  `common=$(cd "$common" 2>/dev/null && pwd -P) || exit 1; ` +
  `[ "$gd" != "$common" ]; ); `;

// Run a script on a device: locally for "" (or via the configured devbox when
// this agent is a receiver), else over ssh.
function projectSshArgs(target, script) {
  return [
    "-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new",
    "-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/pzza-mux-%C",
    "-o", "ControlPersist=120", "-o", "ServerAliveInterval=10", "-o", "ServerAliveCountMax=2",
    target, script,
  ];
}

function runOn(host, script, timeout) {
  return new Promise((resolve) => {
    const cb = (err, stdout, stderr) =>
      resolve({
        ok: !err,
        stdout: String(stdout || ""),
        stderr: String(stderr || ""),
        error: err ? err.message : null,
      });
    const opts = { timeout, maxBuffer: MAX_OUTPUT };
    if (host || IS_CLIENT) {
      const target = host || DEVBOX;
      execFile(
        "ssh",
        projectSshArgs(target, script),
        opts,
        cb,
      );
    } else {
      execFile("sh", ["-c", script], opts, cb);
    }
  });
}

// Shell prelude shared by both phases: bounds the root to $HOME and cds into it.
function prelude(rootE) {
  return (
    `h=$(cd ~ && pwd -P); ` +
    ROOT_FUNC + WORKTREE_FUNC +
    `root=$(r=$(${rootE}) && cd "$r" 2>/dev/null && pwd -P) || { echo PZZA_NOROOT; exit 0; }; ` +
    `case "$root" in "$h"|"$h"/*) ;; *) echo PZZA_DENIED; exit 3;; esac; ` +
    `command -v git >/dev/null 2>&1 || { echo PZZA_NOGIT; exit 0; }; ` +
    `GIT_TERMINAL_PROMPT=0; GCM_INTERACTIVE=never; export GIT_TERMINAL_PROMPT GCM_INTERACTIVE; `
  );
}

// One line per repo, tab-separated:
//   rel  origin  default  branch  head  modified  untracked  ahead  behind  stash  lastCommitTs  envs
// "-" marks an unknown value. envs is "name:sha256:mtime" triples joined
// by "," for every .env / .env.* file at the repo root: the hash tells whether
// two devices hold the same content, the mtime decides which copy wins.
function scanScript(rootE) {
  const names = (dirs) => dirs.map((name) => `-name ${shQuote(name)}`).join(" -o ");
  // OS-managed home folders are skipped only at their real home paths. A
  // project elsewhere named Library or AppData remains discoverable.
  const prune = `\\( -name .git -o ${names(SCAN_SKIP_DIRS)} ` +
    `-o -path "$h/Library" -o -path "$h/AppData" ` +
    `-o -path "$h/.local/share" -o -path "$h/.local/state" -o -path "$h/.local/lib" ` +
    `-o \\( \\( ${names(SCAN_OUTPUT_DIRS)} \\) ! -exec test -e '{}/.git' \\; \\) \\)`;
  return (
    prelude(rootE) +
    `printf 'PZZA_ROOT\\t%s\\n' "$root"; ` +
    `pz_scan() { d=$1; pz_linked_worktree "$d" && return; ` +
    `rel="\${d#"$root"/}"; ` +
    `origin=$(git -C "$d" remote get-url origin 2>/dev/null || echo -); ` +
    // The selected baseline is policy, never origin/HEAD or the current checkout.
    // A stale remote-tracking ref is refreshed by Sync before it changes anything.
    `def=-; if git -C "$d" show-ref --verify --quiet refs/remotes/origin/development; then def=development; elif git -C "$d" show-ref --verify --quiet refs/remotes/origin/main; then def=main; fi; ` +
    // One status walk supplies branch, tracking counts, stash and file counts.
    // Optional index locking stays off so scans do not contend with editors.
    `read -r br mod unt ahead behind stash <<PZZA_STATUS\n` +
    `$(git --no-optional-locks -C "$d" status --porcelain=v2 --branch --show-stash --ahead-behind --untracked-files=normal 2>/dev/null | ` +
    `awk 'BEGIN { br="-"; a="-"; b="-"; m=0; u=0; s=0 } ` +
    `$1 == "#" && $2 == "branch.head" { br=($3 == "(detached)" ? "HEAD" : $3) } ` +
    `$1 == "#" && $2 == "branch.ab" { a=substr($3,2); b=substr($4,2) } ` +
    `$1 == "#" && $2 == "stash" { s=$3 } ` +
    `$1 == "1" || $1 == "2" || $1 == "u" { m++ } $1 == "?" { u++ } ` +
    `END { print br, m, u, a, b, s }')\nPZZA_STATUS\n` +
    `ab="$ahead $behind"; ` +
    `info=$(git -C "$d" log -1 --format='%h %ct' 2>/dev/null); ` +
    `head="\${info% *}"; ts="\${info##* }"; [ -n "$head" ] || head=-; [ -n "$ts" ] || ts=0; ` +
    `envs=; for f in "$d"/.env "$d"/.env.*; do [ -f "$f" ] || continue; case "$f" in *.example|*.sample|*.template) continue;; esac; ` +
    `[ ! -L "$f" ] || continue; sum=$( (sha256sum "$f" 2>/dev/null || shasum -a 256 "$f" 2>/dev/null) | cut -d ' ' -f 1); [ "\${#sum}" = 64 ] || continue; mt=$(stat -c %Y "$f" 2>/dev/null || stat -f %m "$f" 2>/dev/null || echo 0); envs="$envs\${envs:+,}\${f##*/}:$sum:$mt"; done; ` +
    `printf '%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\t%s\\n' "$rel" "$origin" "$def" "$br" "$head" "$mod" "$unt" "$ab" "$stash" "$ts" "$envs"; }; ` +
    `find "$root" -mindepth 1 -maxdepth ${SCAN_DEPTH} ${prune} -prune -o -type d -print 2>/dev/null | ` +
    `{ n=0; while IFS= read -r d; do [ -e "$d/.git" ] || continue; ` +
    `(pz_scan "$d") & n=$((n + 1)); if [ "$n" -ge ${REPO_CONCURRENCY} ]; then wait; n=0; fi; done; wait; }`
  );
}

// Every step reports "PZZA_R\t<rel>\t<status>\t<detail>". Statuses: cloned,
// updated, stashed, current, dirty, skipped, failed. The work is two shell functions
// defined once per script so each repo is a one-line call.
const SYNC_FUNCS =
  `pz_r() { printf 'PZZA_R\t%s\t%s\t%s\n' "$1" "$2" "$3"; }; ` +
  `pz_tail() { printf '%s' "$1" | grep -v '^hint:' | tail -n 3 | tr '\n' ' '; }; ` +
  // The selected baseline is deterministic. It deliberately ignores origin/HEAD
  // because hosting defaults and an individual checkout's branch are unrelated
  // to the shared Sync policy.
  `pz_pick_remote() { pz_dir=$1; pz_remote_output=$(git -C "$pz_dir" ls-remote --quiet --heads origin refs/heads/development refs/heads/main 2>&1) || { pz_remote_error="$pz_remote_output"; return 2; }; pz_development=$(printf '%s\n' "$pz_remote_output" | awk '$2 == "refs/heads/development" { print $1; exit }'); pz_main=$(printf '%s\n' "$pz_remote_output" | awk '$2 == "refs/heads/main" { print $1; exit }'); if [ -n "$pz_development" ]; then pz_baseline=development; pz_remote_head=$pz_development; return 0; fi; if [ -n "$pz_main" ]; then pz_baseline=main; pz_remote_head=$pz_main; return 0; fi; return 1; }; ` +
  `pz_pick_tracking() { pz_dir=$1; if git -C "$pz_dir" show-ref --verify --quiet refs/remotes/origin/development; then pz_baseline=development; elif git -C "$pz_dir" show-ref --verify --quiet refs/remotes/origin/main; then pz_baseline=main; else return 1; fi; pz_remote_head=$(git -C "$pz_dir" rev-parse --verify --quiet "refs/remotes/origin/$pz_baseline") || return 1; return 0; }; ` +
  // Backup refs are SHA-addressed, so running Sync again cannot make an older
  // preservation point unreachable. Each update is verified before checkout.
  `pz_keep_ref() { d=$1; sha=$2; role=$3; ref="refs/pzza-sync/backups/$sha"; git -C "$d" cat-file -e "$sha^{commit}" 2>/dev/null || return 1; existing=$(git -C "$d" rev-parse --verify --quiet "$ref" 2>/dev/null); if [ -n "$existing" ] && [ "$existing" != "$sha" ]; then return 1; fi; if [ -z "$existing" ]; then git -C "$d" update-ref "$ref" "$sha" || return 1; fi; verified=$(git -C "$d" rev-parse --verify --quiet "$ref" 2>/dev/null) || return 1; [ "$verified" = "$sha" ] || return 1; pz_recoveries="$pz_recoveries\${pz_recoveries:+, }$role $ref (git branch recover-$role-$sha $ref)"; }; ` +
  `pz_clone() { origin=$1; d=$2; if pz_linked_worktree "$d"; then pz_r "$d" skipped "linked worktree; left alone"; return; fi; [ ! -e "$d" ] || { pz_r "$d" failed "clone destination changed since scan; left alone"; return; }; parent=$(dirname "$d"); mkdir -p "$parent" || { pz_r "$d" failed "could not create clone parent"; return; }; tmp=$(mktemp -d "$parent/.pzza-sync-clone.XXXXXX") || { pz_r "$d" failed "could not reserve clone destination"; return; }; repo="$tmp/repo"; if ! out=$(git clone --quiet --no-checkout "$origin" "$repo" 2>&1); then rm -rf "$tmp"; pz_r "$d" failed "$(pz_tail "$out")"; return; fi; if ! pz_pick_tracking "$repo"; then rm -rf "$tmp"; pz_r "$d" failed "origin has neither development nor main branch"; return; fi; if ! out=$(git -C "$repo" checkout --no-overwrite-ignore --quiet -B "$pz_baseline" "origin/$pz_baseline" 2>&1); then rm -rf "$tmp"; pz_r "$d" failed "$(pz_tail "$out")"; return; fi; if [ -e "$d" ]; then rm -rf "$tmp"; pz_r "$d" failed "clone destination changed during sync; left alone"; return; fi; if mv "$repo" "$d"; then rmdir "$tmp" 2>/dev/null || true; pz_r "$d" cloned "$pz_baseline"; else rm -rf "$tmp"; pz_r "$d" failed "could not finalize clone"; fi; }; ` +
  // pz_update REL STASH ALIGN EXPECTED. ALIGN=1 makes the checkout exactly
  // match remote development when present, otherwise remote main. ALIGN=0 is an
  // explicit opt-out that leaves the checkout and its working files untouched.
  `pz_update_inner() { d=$1; do_stash=$2; do_align=$3; expected=$4; pz_recoveries=; stash_id=; stash_ref=; stash_note=; ` +
  `if pz_linked_worktree "$d"; then pz_r "$d" skipped "linked worktree; left alone"; return; fi; ` +
  `actual=$(git -C "$d" remote get-url origin 2>/dev/null); [ "$actual" = "$expected" ] || { pz_r "$d" failed "origin changed since scan; left alone"; return; }; ` +
  `gitdir=$(git -C "$d" rev-parse --absolute-git-dir) || { pz_r "$d" failed "repository no longer exists"; return; }; ` +
  `if [ -n "$(git -C "$d" ls-files --unmerged)" ] || [ -f "$gitdir/MERGE_HEAD" ] || [ -d "$gitdir/rebase-merge" ] || [ -d "$gitdir/rebase-apply" ]; then pz_r "$d" failed "unfinished merge or rebase; left alone"; return; fi; ` +
  `was=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null); before=$(git -C "$d" rev-parse HEAD 2>/dev/null); [ -n "$was" ] && [ -n "$before" ] || { pz_r "$d" failed "could not read current checkout"; return; }; ` +
  `if [ "$do_align" != 1 ]; then pz_r "$d" skipped "baseline alignment is off; $was left alone"; return; fi; ` +
  `if [ "$was" = HEAD ]; then pz_r "$d" skipped "detached HEAD; selected baseline left alone"; return; fi; ` +
  // Park tracked and untracked work before checking whether the baseline is
  // current. A disabled stash is the caller's explicit decision to leave work
  // unresolved, never a reason to overwrite it.
  `tracked=$(git -C "$d" status --porcelain --untracked-files=all 2>/dev/null); if [ -n "$tracked" ]; then n=$(printf '%s\n' "$tracked" | wc -l | tr -d ' '); if [ "$do_stash" != 1 ]; then pz_r "$d" dirty "$n uncommitted change(s) on $was, left alone (stash is off)"; return; fi; if ! out=$(git -C "$d" stash push --include-untracked --quiet -m "pzza-sync $was $(date +%Y-%m-%d_%H:%M)" 2>&1); then pz_r "$d" failed "stash: $(pz_tail "$out")"; return; fi; stash_id=$(git -C "$d" rev-parse --verify --quiet refs/stash) || { pz_r "$d" failed "stash could not be verified; left alone"; return; }; stash_ref="refs/pzza-sync/stashes/$stash_id"; if ! git -C "$d" update-ref "$stash_ref" "$stash_id" || [ "$(git -C "$d" rev-parse --verify --quiet "$stash_ref" 2>/dev/null)" != "$stash_id" ]; then pz_r "$d" failed "could not retain durable stash reference; git stash apply $stash_id to restore"; return; fi; stash_note="; stashed $n change(s) in $stash_ref (git stash apply $stash_id to restore)"; fi; ` +
  `if [ -n "$(git -C "$d" status --porcelain --untracked-files=all)" ]; then pz_r "$d" failed "working files changed during stash; left alone$stash_note"; return; fi; ` +
  `pz_pick_remote "$d"; picked=$?; if [ "$picked" != 0 ]; then if [ "$picked" = 1 ]; then pz_r "$d" failed "origin has neither development nor main branch$stash_note"; else pz_r "$d" failed "check origin: $(pz_tail "$pz_remote_error")$stash_note"; fi; return; fi; ` +
  // A clean checkout known to equal the advertised selected branch is a real
  // no-op. Dirty work has already been preserved above, so it is reported as a
  // successful informational stash instead.
  `tracking=$(git -C "$d" rev-parse --verify --quiet "refs/remotes/origin/$pz_baseline" 2>/dev/null); if [ "$was" = "$pz_baseline" ] && [ "$before" = "$pz_remote_head" ] && [ "$tracking" = "$pz_remote_head" ]; then if [ -n "$stash_id" ]; then pz_r "$d" stashed "selected baseline $pz_baseline is current$stash_note"; else pz_r "$d" current "$pz_baseline"; fi; return; fi; ` +
  `if ! out=$(git -C "$d" fetch --quiet --prune origin 2>&1); then pz_r "$d" failed "fetch: $(pz_tail "$out")$stash_note"; return; fi; ` +
  `actual=$(git -C "$d" remote get-url origin 2>/dev/null); [ "$actual" = "$expected" ] || { pz_r "$d" failed "origin changed during sync; left alone$stash_note"; return; }; ` +
  `pz_pick_tracking "$d" || { pz_r "$d" failed "origin has neither development nor main branch after fetch$stash_note"; return; }; ` +
  `now_branch=$(git -C "$d" rev-parse --abbrev-ref HEAD 2>/dev/null); now_head=$(git -C "$d" rev-parse HEAD 2>/dev/null); if [ "$now_branch" != "$was" ] || [ "$now_head" != "$before" ]; then pz_r "$d" failed "checkout changed during sync; left alone$stash_note"; return; fi; ` +
  `if [ -n "$(git -C "$d" status --porcelain --untracked-files=all)" ]; then pz_r "$d" failed "working files changed during sync; left alone$stash_note"; return; fi; ` +
  // A checkout may be ahead or diverged both on the currently checked-out
  // source branch and on the selected target branch. Keep both tips reachable
  // before moving the clean baseline, without manufacturing a merge commit.
  `if ! git -C "$d" merge-base --is-ancestor "$before" "refs/remotes/origin/$pz_baseline" 2>/dev/null; then pz_keep_ref "$d" "$before" source || { pz_r "$d" failed "could not verify recovery ref for current $was tip$stash_note"; return; }; fi; ` +
  `target_tip=$(git -C "$d" rev-parse --verify --quiet "refs/heads/$pz_baseline" 2>/dev/null); if [ -n "$target_tip" ] && ! git -C "$d" merge-base --is-ancestor "$target_tip" "refs/remotes/origin/$pz_baseline" 2>/dev/null; then pz_keep_ref "$d" "$target_tip" target || { pz_r "$d" failed "could not verify recovery ref for selected $pz_baseline tip$stash_note"; return; }; fi; ` +
  `if [ -n "$(git -C "$d" status --porcelain --untracked-files=all)" ]; then pz_r "$d" failed "working files changed before baseline alignment; left alone$stash_note"; return; fi; ` +
  `if ! out=$(git -C "$d" checkout --no-overwrite-ignore --quiet -B "$pz_baseline" "origin/$pz_baseline" 2>&1); then pz_r "$d" failed "$(pz_tail "$out")$stash_note"; return; fi; ` +
  `after=$(git -C "$d" rev-parse HEAD 2>/dev/null); [ "$after" = "$pz_remote_head" ] || { pz_r "$d" failed "selected baseline changed during checkout$stash_note"; return; }; ` +
  `recovery_note="\${pz_recoveries:+; recovery refs: $pz_recoveries}"; if [ -n "$stash_id" ]; then pz_r "$d" stashed "selected baseline $pz_baseline aligned$recovery_note$stash_note"; elif [ "$was" != "$pz_baseline" ] || [ "$before" != "$after" ]; then pz_r "$d" updated "selected baseline $pz_baseline aligned to origin$recovery_note"; else pz_r "$d" current "$pz_baseline"; fi; }; ` +
  // `mkdir` is atomic, making independently requested Sync runs serialize per
  // repository without blocking unrelated checkouts. The owner PID plus traps
  // keep cancellation from wedging later Sync calls, while stale ownership is
  // reclaimed only after its process is proven gone under a separate guard.
  `pz_lock_release() { if [ "$pz_reclaim_guard_owned" = 1 ]; then rmdir "$pz_reclaim_guard" 2>/dev/null || true; pz_reclaim_guard_owned=; fi; if [ "$pz_lock_created" = 1 ] && [ -d "$pz_lock" ]; then pz_lock_recorded=$(cat "$pz_lock/owner" 2>/dev/null); if [ "$pz_lock_recorded" = "$pz_lock_owner" ]; then rm -f "$pz_lock/owner"; rmdir "$pz_lock" 2>/dev/null || true; elif [ -z "$pz_lock_recorded" ]; then rmdir "$pz_lock" 2>/dev/null || true; fi; fi; pz_lock_created=; pz_lock=; pz_lock_owner=; }; ` +
  `pz_lock_traps() { trap 'pz_lock_release' 0; trap 'pz_lock_release; exit 129' 1; trap 'pz_lock_release; exit 130' 2; trap 'pz_lock_release; exit 143' 15; }; ` +
  `pz_lock_owner_from_handoff() { pz_handoff_file=$1; pz_handoff_attempt=0; while [ "$pz_handoff_attempt" -lt 100 ]; do pz_handoff_owner=$(cat "$pz_handoff_file" 2>/dev/null); case "$pz_handoff_owner" in ''|0|*[!0-9]*) ;; *) pz_lock_owner=$pz_handoff_owner; rm -f "$pz_handoff_file"; return 0;; esac; pz_handoff_attempt=$((pz_handoff_attempt + 1)); sleep 0.05; done; rm -f "$pz_handoff_file"; return 1; }; ` +
  `pz_lock_owner_alive() { case "$1" in ''|0|*[!0-9]*) return 1;; esac; kill -0 "$1" 2>/dev/null; }; ` +
  `pz_reclaim_stale_lock() { pz_reclaim_lock=$1; pz_reclaim_owner=$2; pz_reclaim_guard="$pz_reclaim_lock.reclaim"; if ! mkdir "$pz_reclaim_guard" 2>/dev/null; then return 2; fi; pz_reclaim_guard_owned=1; pz_reclaim_current=$(cat "$pz_reclaim_lock/owner" 2>/dev/null); if [ "$pz_reclaim_current" = "$pz_reclaim_owner" ] && ! pz_lock_owner_alive "$pz_reclaim_current"; then rm -f "$pz_reclaim_lock/owner"; if rmdir "$pz_reclaim_lock" 2>/dev/null; then rmdir "$pz_reclaim_guard" 2>/dev/null || true; pz_reclaim_guard_owned=; return 0; fi; fi; rmdir "$pz_reclaim_guard" 2>/dev/null || true; pz_reclaim_guard_owned=; return 1; }; ` +
  `pz_update() { d=$1; pz_handoff_file=$5; pz_lock_owner=; pz_lock_owner_from_handoff "$pz_handoff_file" || { pz_r "$d" failed "could not identify the Sync worker; left alone"; return; }; if pz_linked_worktree "$d"; then pz_update_inner "$@"; return; fi; gitdir=$(git -C "$d" rev-parse --absolute-git-dir 2>/dev/null) || { pz_r "$d" failed "repository no longer exists"; return; }; pz_lock="$gitdir/pzza-sync.lock"; pz_lock_created=; pz_reclaim_guard_owned=; pz_lock_traps; while :; do if mkdir "$pz_lock" 2>/dev/null; then pz_lock_created=1; if printf '%s\n' "$pz_lock_owner" > "$pz_lock/owner"; then break; fi; pz_lock_release; pz_r "$d" failed "could not record Sync lock ownership; left alone"; return; fi; pz_lock_recorded=$(cat "$pz_lock/owner" 2>/dev/null); if pz_lock_owner_alive "$pz_lock_recorded"; then pz_r "$d" failed "another Sync is updating this repository (process $pz_lock_recorded); left alone"; return; fi; case "$pz_lock_recorded" in ''|*[!0-9]*) pz_r "$d" failed "Sync lock has no verifiable owner; left alone"; return;; esac; pz_reclaim_stale_lock "$pz_lock" "$pz_lock_recorded"; pz_reclaim_status=$?; if [ "$pz_reclaim_status" = 0 ]; then continue; fi; if [ "$pz_reclaim_status" = 2 ]; then pz_r "$d" failed "a Sync lock recovery is already in progress; left alone"; else pz_r "$d" failed "stale Sync lock for exited process $pz_lock_recorded could not be cleared; inspect $pz_lock"; fi; return; done; pz_update_inner "$@"; code=$?; pz_lock_release; return "$code"; }; ` +
  // The parent shell learns the actual background child PID from `$!`; hand it
  // to that child through a private temporary file so ownership remains valid
  // even where POSIX `sh` keeps `$$` unchanged inside background subshells.
  `pz_start_update() { pz_start_rel=$1; shift; pz_start_owner=$(mktemp "\${TMPDIR:-/tmp}/pzza-sync-owner.XXXXXX") || { pz_r "$pz_start_rel" failed "could not prepare Sync ownership handoff"; return; }; (pz_update "$pz_start_rel" "$@" "$pz_start_owner") & pz_start_pid=$!; if ! printf '%s\n' "$pz_start_pid" > "$pz_start_owner"; then kill "$pz_start_pid" 2>/dev/null || true; rm -f "$pz_start_owner"; pz_r "$pz_start_rel" failed "could not record Sync worker ownership"; return; fi; wait "$pz_start_pid"; }; `;

// Repositories with overlapping paths must finish before either starts another
// batch: a parent checkout can otherwise race a nested repository's worktree.
function syncBatches(plan) {
  const batches = [];
  let batch = [];
  for (const step of plan) {
    const overlaps = batch.some(({ rel }) => rel === step.rel || rel.startsWith(`${step.rel}/`) || step.rel.startsWith(`${rel}/`));
    if (batch.length === REPO_CONCURRENCY || overlaps) {
      batches.push(batch);
      batch = [];
    }
    batch.push(step);
  }
  if (batch.length) batches.push(batch);
  return batches;
}

export function syncScript(rootE, plan, opts) {
  const flags = `${opts.stashDirty ? 1 : 0} ${opts.switchToDefault ? 1 : 0}`;
  const batches = syncBatches(plan);
  const steps = batches.map((items) => items.map(({ rel, action, origin }) => {
    const call = action === "clone" ? `pz_clone ${shQuote(origin)} ${shQuote(rel)}` : `pz_start_update ${shQuote(rel)} ${flags} ${shQuote(origin)}`;
    return `(${call}) &`;
  }).join(" ") + " wait");
  return prelude(rootE) + `cd "$root"; ` + SYNC_FUNCS + steps.join("; ");
}

async function mapConcurrent(items, limit, work) {
  const results = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await work(items[index]);
    }
  }));
  return results;
}

// Copy one env file between devices through this agent: read it from the
// source, stream it into the target. Content lives in memory only for the
// duration of the copy and is never logged or persisted here.
export function envWriteScript(rootE, rel, name, expectedHash) {
  const verify = expectedHash === undefined ? "" : expectedHash === null
    ? `[ ! -e "$file" ] || { echo 'destination changed since scan' >&2; exit 1; }; `
    : `current=$( (sha256sum "$file" 2>/dev/null || shasum -a 256 "$file" 2>/dev/null) | cut -d ' ' -f 1); [ "$current" = ${shQuote(expectedHash)} ] || { echo 'destination changed since scan' >&2; exit 1; }; `;
  return prelude(rootE) + `cd "$root" && ! pz_linked_worktree ${shQuote(rel)} && cd ${shQuote(rel)} || exit 1; ` +
    `case "$(pwd -P)" in "$root"|"$root"/*) ;; *) exit 1;; esac; umask 077; ` +
    `file=${shQuote(name)}; [ ! -L "$file" ] || exit 1; ` +
    `tmp=$(mktemp "./.pzza-env.XXXXXX") || exit 1; trap 'rm -f "$tmp"' EXIT HUP INT TERM; cat > "$tmp" || exit 1; ` +
    `[ ! -L "$file" ] || exit 1; if [ -f "$file" ] && cmp -s "$tmp" "$file"; then exit 0; fi; ` + verify +
    `gitdir=$(git rev-parse --absolute-git-dir) || exit 1; ` +
    `[ ! -L "$gitdir/pzza-env-backups" ] && mkdir -p "$gitdir/pzza-env-backups" && chmod 700 "$gitdir/pzza-env-backups" || exit 1; ` +
    `if [ -e "$file" ]; then [ -f "$file" ] && [ ! -L "$file" ] || exit 1; backup=$(mktemp "$gitdir/pzza-env-backups/$file.XXXXXX") || exit 1; mv "$file" "$backup" && chmod 600 "$backup" || exit 1; fi; ` +
    `ln "$tmp" "$file"`;

}

async function copyEnv(rootE, src, dst, srcRel, rel, name, expected) {
  const read = await runOn(src, prelude(rootE) + `cd "$root" && ! pz_linked_worktree ${shQuote(srcRel)} && cd ${shQuote(srcRel)} || exit 1; ` +
    `case "$(pwd -P)" in "$root"|"$root"/*) ;; *) exit 1;; esac; [ ! -L ${shQuote(name)} ] && cat ${shQuote(name)}`, SCAN_TIMEOUT_MS);
  if (!read.ok || deviceError(read)) return deviceError(read) || read.stderr.trim() || "read failed";
  // A newest-but-empty file must not wipe a populated copy elsewhere.
  if (read.stdout.trim() === "") return "source file is empty, not copied";
  if (expected?.sourceHash && createHash("sha256").update(read.stdout).digest("hex") !== expected.sourceHash) return "source changed since scan; scan again before copying";
  const script = envWriteScript(rootE, rel, name, expected?.targetHash);
  return new Promise((resolve) => {
    const useSsh = dst || IS_CLIENT;
    const child = useSsh
      ? spawn("ssh", projectSshArgs(dst || DEVBOX, script))
      : spawn("sh", ["-c", script]);
    let err = "";
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, SCAN_TIMEOUT_MS);
    const finish = (error) => { clearTimeout(timer); resolve(error); };
    child.stderr.on("data", (c) => { err = (err + c).slice(-4096); });
    child.stdout.resume();
    child.stdin.on("error", () => { /* The close event reports a refused or interrupted write. */ });
    child.on("error", (e) => finish(e.message));
    child.on("close", (code) => finish(timedOut ? "environment transfer timed out" : code === 0 ? null : err.trim() || `exit ${code}`));
    child.stdin.end(read.stdout);
  });
}

// For every env file, the device with the newest copy is the source; every
// other device that has (or just got) the repo and lacks that content is a
// target. Returns { deviceId: [{ rel, name, from, status, detail }] }.
export function planEnvSync(scan, gitResults, opts = normalizeOptions()) {
  if (!opts.syncEnvs) return [];
  const ok = new Set(scan.devices.filter((d) => !d.error).map((d) => d.id));
  const jobs = [];
  for (const p of groupProjects(scan)) {
    if (!p.origin || !repoOn(opts, p.id) || !repoEnvOn(opts, p.id)) continue;
    // Where the project lives on each device: its member repo, or the path it
    // was just cloned to.
    const where = new Map();
    for (const d of scan.devices) {
      if (!ok.has(d.id) || p.duplicates.has(d.id)) continue;
      const m = p.members.get(d.id);
      const result = (gitResults.get(d.id) ?? []).find((r) => r.projectId === p.id && r.rel === (m?.rel ?? p.rel));
      if (!result || !["cloned", "updated", "stashed", "current"].includes(result.status)) continue;
      if (m) where.set(d.id, { rel: m.rel, envs: m.envs, device: d });
      else if (result.status === "cloned") where.set(d.id, { rel: result.rel, envs: [], device: d });
    }
    const names = new Set();
    for (const w of where.values()) for (const e of w.envs) names.add(e.name);
    for (const name of names) {
      if (envExcluded(opts, name)) continue;
      let best = null;
      for (const w of where.values()) {
        const e = w.envs.find((x) => x.name === name);
        if (e && (!best || e.mtime > best.env.mtime)) best = { ...w, env: e };
      }
      if (!best) continue;
      for (const w of where.values()) {
        if (w.device.id === best.device.id) continue;
        const e = w.envs.find((x) => x.name === name);
        if (e && e.hash === best.env.hash) continue;
        jobs.push({ projectId: p.id, target: w.device, rel: w.rel, srcRel: best.rel, name, from: best.device, sourceHash: best.env.hash, targetHash: e?.hash ?? null });
      }
    }
  }
  return jobs;
}

function deviceError(res) {
  const out = res.stdout.trim();
  if (out.startsWith("PZZA_NOROOT")) return "projects root does not exist";
  if (out.startsWith("PZZA_DENIED")) return "projects root is outside home";
  if (out.startsWith("PZZA_NOGIT")) return "git is not installed";
  if (!res.ok) return (res.stderr.trim() || res.error || "command failed").split("\n").slice(-2).join(" ");
  return null;
}

const num = (v) => (v === undefined || v === "-" || v === "" || Number.isNaN(Number(v)) ? null : Number(v));

function parseScan(stdout) {
  const repos = [];
  let root = null;
  for (const line of stdout.split("\n")) {
    if (line.startsWith("PZZA_ROOT\t")) {
      root = line.slice("PZZA_ROOT\t".length);
      continue;
    }
    if (!line.includes("\t")) continue;
    const [rel, origin, def, branch, head, mod, unt, ab, stash, ts, envs] = line.split("\t");
    if (!rel) continue;
    const [ahead, behind] = String(ab || "- -").split(" ");
    repos.push({
      rel,
      origin: origin && origin !== "-" ? origin : null,
      defaultBranch: def && def !== "-" ? def : null,
      branch: branch && branch !== "-" ? branch : null,
      head: head && head !== "-" ? head : null,
      modified: num(mod) ?? 0,
      untracked: num(unt) ?? 0,
      ahead: num(ahead),
      behind: num(behind),
      stashes: num(stash) ?? 0,
      lastCommitTs: num(ts) ?? 0,
      envs: (envs || "")
        .split(",")
        .filter(Boolean)
        .map((triple) => {
          const j = triple.lastIndexOf(":");
          const i = triple.lastIndexOf(":", j - 1);
          return { name: triple.slice(0, i), hash: triple.slice(i + 1, j), mtime: num(triple.slice(j + 1)) ?? 0 };
        }),
    });
  }
  // Worker completion order must not change project grouping or the UI order.
  repos.sort((a, b) => a.rel.localeCompare(b.rel));
  return { root, repos };
}

// Sync options from the client, with safe defaults. `repos` holds per-repo
// overrides keyed by project identity: { enabled, env }. envExclude are glob-ish patterns
// (* wildcard) matched against the env file name.
export function normalizeOptions(raw) {
  const o = raw && typeof raw === "object" ? raw : {};
  const bool = (v, d) => (typeof v === "boolean" ? v : d);
  const repos = {};
  if (o.repos && typeof o.repos === "object") {
    for (const [rel, v] of Object.entries(o.repos)) {
      if (typeof rel !== "string" || rel.split("/").includes("..")) continue;
      repos[rel] = { enabled: bool(v?.enabled, true), env: bool(v?.env, true) };
    }
  }
  const envExclude = Array.isArray(o.envExclude)
    ? o.envExclude.filter((x) => typeof x === "string" && x.trim()).map((x) => x.trim()).slice(0, 50)
    : [];
  return {
    cloneMissing: bool(o.cloneMissing, true),
    switchToDefault: bool(o.switchToDefault, true),
    stashDirty: bool(o.stashDirty, true),
    syncEnvs: bool(o.syncEnvs, true),
    envExclude,
    repos,
  };
}

const repoOn = (opts, rel) => opts.repos[rel]?.enabled !== false;
const repoEnvOn = (opts, rel) => opts.repos[rel]?.env !== false;
const globToRe = (g) => new RegExp("^" + g.split("*").map((x) => x.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*") + "$");
const envExcluded = (opts, name) => opts.envExclude.some((g) => globToRe(g).test(name));

// Normalize the client's device list: [{ id, name, host }] with host "" = local.
function normalizeDevices(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const d of list) {
    const host = String(d?.host || "");
    if (host && !SSH_TOKEN.test(host)) continue;
    if (seen.has(host)) continue;
    seen.add(host);
    out.push({ id: String(d?.id || host || "local"), name: String(d?.name || host || "This device"), host });
  }
  return out;
}

// Scan every device in parallel: { root, devices: [{ id, name, host, error, root, repos }] }
// where the device root is the path the requested root resolved to there.
// The HTTP route passes `redact` so credentials in origin URLs never reach the
// app; the sync keeps the raw URL because the clone needs it.
export async function scanProjects(body, { redact: strip = false, onProgress, freshOrigins = false } = {}) {
  const rootE = rootExpr(body.root);
  if (!rootE) return { error: "invalid projects root" };
  const devices = normalizeDevices(body.devices);
  if (devices.length === 0) return { error: "no devices" };
  const finished = [];
  let repos = 0;
  const report = () => onProgress?.({ completed: finished.length, total: devices.length, repos, finished: [...finished] });
  report();
  const results = await mapConcurrent(
    devices, DEVICE_CONCURRENCY, async (d) => {
      // Share only in-flight reads. Every completed refresh scans again so
      // filesystem changes and post-sync results are never hidden by a TTL.
      const key = JSON.stringify([d.host || (IS_CLIENT ? DEVBOX : ""), rootE]);
      let pending = pendingScans.get(key);
      if (!pending) {
        pending = runOn(d.host, scanScript(rootE), SCAN_TIMEOUT_MS)
          .finally(() => pendingScans.delete(key));
        pendingScans.set(key, pending);
      }
      const res = await pending;
      const error = deviceError(res);
      const parsed = error ? { root: null, repos: [] } : parseScan(res.stdout);
      for (const r of parsed.repos) {
        r.projectId = projectIdFor(d.id, r);
        if (strip && r.origin) r.origin = redact(r.origin);
      }
      finished.push({ id: d.id, error: Boolean(error) });
      repos += parsed.repos.length;
      report();
      return { ...d, error, root: parsed.root, repos: parsed.repos };
    },
  );
  return reconcileGithubOrigins({ root: String(body.root), devices: results }, freshOrigins ? name => githubRepository(name, true) : undefined);
}

// Decide what each device has to do for every repo in the union. A repo only
// travels between devices when some device knows its origin URL.
export function planSync(scan, opts = normalizeOptions()) {
  const projects = groupProjects(scan);
  return scan.devices.map((d) => {
    if (d.error) return { ...d, plan: [], skipped: [] };
    const plan = [];
    const skipped = [];
    const clonePaths = new Map();
    for (const p of projects) {
      if (p.origin && !p.members.has(d.id) && opts.cloneMissing && repoOn(opts, p.id)) {
        clonePaths.set(p.rel, (clonePaths.get(p.rel) ?? 0) + 1);
      }
    }
    for (const p of projects) {
      const local = p.members.get(d.id);
      const copies = p.duplicates.get(d.id);
      const report = (rel, status, detail) => skipped.push({ projectId: p.id, rel, status, detail });
      if (!repoOn(opts, p.id)) {
        for (const repo of copies ?? (local ? [local] : [])) report(repo.rel, "skipped", "sync is off for this project");
      } else if (copies) {
        for (const repo of copies) report(repo.rel, "failed", "multiple checkouts of this remote on this device; choose a single copy before syncing");
      } else if (!p.origin) {
        if (local) report(local.rel, "skipped", local.origin ? "unsupported origin url" : "no origin remote");
        else if (p.duplicates.size) report(p.rel, "failed", "multiple source checkouts; clone location is ambiguous");
      } else if (!local) {
        if (!opts.cloneMissing) report(p.rel, "skipped", "missing here, cloning is off");
        else if (d.repos.some((r) => r.rel === p.rel) || clonePaths.get(p.rel) > 1) {
          report(p.rel, "failed", "clone path conflict: this folder belongs to another project; nothing was cloned");
        } else plan.push({ projectId: p.id, rel: p.rel, action: "clone", origin: p.origin });
      } else plan.push({ projectId: p.id, rel: local.rel, action: "update", origin: local.origin });
    }
    plan.sort((a, b) => a.rel.localeCompare(b.rel));
    return { ...d, plan, skipped };
  });
}

// Scan, plan and run the sync on every device in parallel: git first (clone /
// stash / checkout / merge), then the env files. Returns
// { root, devices: [{ id, name, host, error, results: [...], envs: [...] }] }.
export async function syncProjects(body, { scan = scanProjects, run = runOn, copy = copyEnv } = {}) {
  const operationId = body.operationId;
  if (operationId !== undefined && !validOperationId(operationId)) return { error: "invalid sync operation" };
  if (syncOperations.size) return { error: "a sync operation is already running" };
  const operation = { cancelled: (cancelledRequests.get(operationId) ?? 0) > Date.now() };
  cancelledRequests.delete(operationId);
  syncOperations.set(operationId, operation);
  try {
    return await performSync(body, operation, { scan, run, copy });
  } finally { syncOperations.delete(operationId); }
}

async function performSync(body, operation, { scan: scanDevices, run, copy }) {
  const rootE = rootExpr(body.root);
  if (!rootE) return { error: "invalid projects root" };
  // Cached aliases speed up browsing, but a sync must revalidate redirects
  // before using repository identity to copy files between devices.
  const scan = await scanDevices(body, { freshOrigins: true });
  if (scan.error) return scan;
  const opts = migrateProjectOptions(body.options, scan);
  const planned = planSync(scan, opts);
  const devices = await mapConcurrent(
    planned, DEVICE_CONCURRENCY, async (d) => {
      const base = { id: d.id, name: d.name, host: d.host, envs: [] };
      if (d.error) return { ...base, error: d.error, results: [] };
      if (d.plan.length === 0) return { ...base, error: null, results: d.skipped };
      const chunks = [];
      const started = new Set();
      let unavailable = null;
      for (const batch of syncBatches(d.plan)) {
        if (operation.cancelled) break;
        for (const step of batch) started.add(step.rel);
        const chunk = await run(d.host, syncScript(rootE, batch, opts), SYNC_TIMEOUT_MS);
        chunks.push(chunk);
        // A disconnected device cannot run later batches. Keep reports from
        // completed repositories and stop paying the connection timeout again.
        unavailable = deviceError(chunk);
        if (unavailable) break;
      }
      const res = { ok: chunks.every(item => item.ok), stdout: chunks.map(item => item.stdout).join("\n"), stderr: chunks.map(item => item.stderr).join("\n"), error: chunks.find(item => item.error)?.error };
      const error = deviceError(res);
      const results = [];
      for (const line of res.stdout.split("\n")) {
        if (!line.startsWith("PZZA_R\t")) continue;
        const [, rel, status, detail] = line.split("\t");
        const step = d.plan.find((p) => p.rel === rel);
        if (step) results.push({ projectId: step.projectId, rel, status, detail: status === "failed" ? explainGit(redact(detail || "")) : redact(detail || "") });
      }
      // A step that produced no report line (killed by the timeout, ssh dropped)
      // must not silently vanish from the summary.
      const seen = new Set(results.map((r) => r.rel));
      for (const p of d.plan) if (!seen.has(p.rel)) {
        const skipped = operation.cancelled && !started.has(p.rel);
        results.push({ projectId: p.projectId, rel: p.rel, status: skipped ? "skipped" : "failed", detail: skipped ? "cancelled before this repository started" : redact(unavailable || error || "repository did not finish before the connection closed or timed out") });
      }
      results.push(...d.skipped);
      results.sort((a, b) => a.rel.localeCompare(b.rel));
      return { ...base, error: results.length ? null : error, results };
    },
  );

  const gitResults = new Map(devices.map((d) => [d.id, d.results]));
  const jobs = operation.cancelled ? [] : planEnvSync(scan, gitResults, opts);
  // Bound concurrent SSH sessions and retain plan order in the report even
  // when smaller transfers complete before earlier ones.
  const copied = await mapConcurrent(jobs, ENV_CONCURRENCY, async (job) => {
    if (operation.cancelled) return { projectId: job.projectId, rel: job.rel, name: job.name, from: job.from.name, status: "skipped", detail: "cancelled" };
    const err = await copy(rootE, job.from.host, job.target.host, job.srcRel, job.rel, job.name, { sourceHash: job.sourceHash, targetHash: job.targetHash });
    return { projectId: job.projectId, rel: job.rel, name: job.name, from: job.from.name, status: err ? "failed" : "copied", detail: redact(err || "") };
  });
  for (let i = 0; i < jobs.length; i++) {
    devices.find((d) => d.id === jobs[i].target.id)?.envs.push(copied[i]);
  }
  return { root: scan.root, devices, cancelled: operation.cancelled };
}
