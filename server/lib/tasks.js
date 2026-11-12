// Git data and actions for tasks: an agent working in its own linked worktree
// on a pzza/ branch started from a chosen base. The board lists the local
// branches to start from, sums up what a candidate changed against its base
// (committed and uncommitted, untracked files included), shows one file's
// before/after, commits the worktree, runs the repository's approved check
// commands, and discards a candidate (worktree and branch) after the user has
// reviewed exactly what would be lost. A launch that never finished is
// reclaimed: what it left behind is removed only while it holds no work.
//
// Like the other Git routes, every read and write is a fixed POSIX script
// whose inputs are positional arguments: locally through /bin/sh, on another
// device over one ssh call. Reads never write the index or the working tree
// (--no-optional-locks, no `git add -N`).
import crypto from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { deviceEnv } from "./shell.js";
import {
  GIT_REVIEW_LIMITS, GitReviewError, buildDiff, parseStatusZ, readWorkingFile, remoteGitReviewCommand, validateRepoFile,
} from "./git-review.js";
import {
  approveSetup, normalizeWorktreeConfig, readSetup, runDeviceScript, scriptSections, setupApproved,
  setupCommandLine, setupHost, validateSetupFolder,
} from "./worktree-setup.js";
import { gitMessage, validBranchName } from "./worktree-land.js";
import { worktreeSlug } from "./session-create.js";
import { normalizeSessionName } from "./session-name.js";

export const TASK_LIMITS = {
  branches: 200,
  branchScan: 1000,
  commits: 50,
  subject: 200,
  files: GIT_REVIEW_LIMITS.files,
  countedFiles: 200,
  countBytes: 1024 * 1024,
  listBytes: 1024 * 1024,
  uncommitted: 200,
  message: 300,
  exclude: 200,
  scriptMs: 30000,
  buffer: 8 * 1024 * 1024,
  commitMs: 180000,
  discardMs: 60000,
  checkMs: 10 * 60 * 1000,
  checkOutput: 8192,
  pathCaptureSeconds: 10,
  // How much earlier than the app's launch time a device clock may date the
  // branch a launch created and still count it as that launch's.
  reclaimSlackSeconds: 600,
};

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029]/;
const RS = "\u001e";
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const FINGERPRINT = /^[0-9a-f]{64}$/;

// Shell parameter expansion text for the String.raw scripts below, where a
// bare dollar-brace would be a JavaScript interpolation.
const V = (expression) => `\${${expression}}`;

const isLocal = (host) => !host && !IS_CLIENT;

// ------------------------------------------------------------------ scripts

// $1 is the folder. Sets $top and runs from it; Git variables from the
// server's environment never redirect these scripts to another repository.
const PRELUDE = String.raw`export LC_ALL=C GIT_TERMINAL_PROMPT=0
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 3
[ -n "$top" ] || exit 3
cd -- "$top" 2>/dev/null || exit 3
`;

// Exits 11 unless $top is a linked worktree (its git dir differs from the
// common one), so nothing here ever commits in or removes the main checkout.
const LINKED_SH = String.raw`gitdir=$(cd -P -- "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P)
common=$(cd -P -- "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)
{ [ -n "$gitdir" ] && [ -n "$common" ] && [ "$gitdir" != "$common" ]; } || exit 11
`;

// Subjects as single lines without control characters (they could otherwise
// forge the record framing).
const LOG = `git log -n ${TASK_LIMITS.commits + 1} --no-color --no-show-signature --format='%H %s'`;
const STRIP = String.raw`tr -d '\001-\011\013-\037\177'`;

// $1 folder. The top-level, the current branch, the default base (the local
// branch origin/HEAD names, else main, else master) and local branches, most
// recently committed first.
export const BRANCHES_SCRIPT = String.raw`${PRELUDE}printf '\036root\n%s\n\036current\n%s\n' "$top" "$(git symbolic-ref -q HEAD 2>/dev/null | sed 's|^refs/heads/||')"
remote=$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null | sed 's|^refs/remotes/origin/||')
base=""
for name in "$remote" main master; do
  if [ -n "$name" ] && git show-ref --verify -q "refs/heads/$name" 2>/dev/null; then base=$name; break; fi
done
printf '\036base\n%s\n\036branches\n' "$base"
git for-each-ref --sort=-committerdate --format='%(refname)' refs/heads/ 2>/dev/null </dev/null | sed -n 's|^refs/heads/||p' | head -n ${TASK_LIMITS.branchScan}
exit 0`;

// $1 folder, $2 base branch. Compares the merge-base of the base and HEAD
// (HEAD itself when the base is missing, the empty tree on an unborn branch)
// with the working tree. Path lists are base64 so any file name survives the
// framing. Untracked files get line counts from git's own numstat, only for
// regular files under 1 MiB and at most countedFiles of them; git never lists
// a path through a symbolic link to a folder.
export const STATS_SCRIPT = String.raw`${PRELUDE}tip=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null) || tip=""
branch=$(git symbolic-ref -q HEAD 2>/dev/null | sed 's|^refs/heads/||')
found=0 mb=""
if git show-ref --verify -q "refs/heads/$2" 2>/dev/null; then
  found=1
  if [ -n "$tip" ]; then mb=$(git merge-base "refs/heads/$2" HEAD 2>/dev/null </dev/null) || mb=""; fi
fi
from=$mb
[ -n "$from" ] || from=$tip
[ -n "$from" ] || from=$(git hash-object -t tree /dev/null 2>/dev/null)
printf '\036root\n%s\n\036head\n%s\n\036branch\n%s\n\036found\n%s\n\036mergebase\n%s\n' "$top" "$tip" "$branch" "$found" "$mb"
if [ "$found" = 1 ] && [ -n "$tip" ]; then
  printf '\036counts\n%s\n' "$(git rev-list --left-right --count "refs/heads/$2...HEAD" 2>/dev/null </dev/null)"
  printf '\036commits\n'
  ${LOG} "refs/heads/$2..HEAD" -- 2>/dev/null </dev/null | ${STRIP}
fi
printf '\036uncommitted\n%s\n' "$(git --no-optional-locks status --porcelain --untracked-files=normal 2>/dev/null </dev/null | wc -l | tr -d ' ')"
printf '\036diff\n'
git --no-optional-locks diff -M --raw --numstat -z --no-ext-diff --no-textconv --no-color "$from" -- 2>/dev/null </dev/null | head -c ${TASK_LIMITS.listBytes + 1} | base64
printf '\n\036untracked\n'
git --no-optional-locks ls-files -z --others --exclude-standard 2>/dev/null </dev/null | head -c ${TASK_LIMITS.listBytes + 1} | base64
printf '\n\036counted\n'
git --no-optional-locks ls-files -z --others --exclude-standard 2>/dev/null </dev/null | tr '\000\n' '\n\000' | head -n ${TASK_LIMITS.files} | {
  n=0
  while IFS= read -r f; do
    [ "$n" -lt ${TASK_LIMITS.countedFiles} ] || break
    { [ -f "$f" ] && [ ! -L "$f" ]; } || continue
    size=$(wc -c < "$f" 2>/dev/null) || continue
    { [ -n "$size" ] && [ $size -lt ${TASK_LIMITS.countBytes} ]; } || continue
    n=$((n + 1))
    printf '%s\000%s\000' "$(git diff --no-index --no-ext-diff --no-textconv --numstat -- /dev/null "$f" 2>/dev/null </dev/null | head -n 1)" "$f"
  done
} | base64
printf '\n'
exit 0`;

// $1 folder, $2 base branch, $3 path at the merge-base (the rename source or
// $4), $4 working-tree file, $5 "after" to also read the working-tree side
// (another device; locally readWorkingFile reads it). The after side never
// leaves the worktree: its folder is resolved and must stay under the real
// top-level, and a symbolic link is read as its target text, never followed.
export const DIFF_SCRIPT = String.raw`${PRELUDE}real=$(pwd -P)
printf '\036root\n%s\n' "$top"
tip=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null) || tip=""
mb=""
if [ -n "$tip" ] && git show-ref --verify -q "refs/heads/$2" 2>/dev/null; then mb=$(git merge-base "refs/heads/$2" HEAD 2>/dev/null </dev/null) || mb=""; fi
[ -n "$mb" ] || mb=$tip
if [ -n "$mb" ] && [ "$(git cat-file -t "$mb:$3" 2>/dev/null)" = blob ]; then
  printf '\036before\n'; git cat-file blob "$mb:$3" 2>/dev/null | head -c ${GIT_REVIEW_LIMITS.side + 1} | base64; printf '\n'
fi
[ "$5" = after ] || exit 0
dir=$(dirname -- "$4"); name=$(basename -- "$4")
if rdir=$(cd -P -- "$dir" 2>/dev/null && pwd -P); then
  case "$rdir/" in "$real"/*) ;; *) exit 6 ;; esac
  if [ -L "$rdir/$name" ]; then
    printf '\036link\n'; readlink -- "$rdir/$name" | head -c ${GIT_REVIEW_LIMITS.side + 2} | base64; printf '\n'
  elif [ -f "$rdir/$name" ]; then
    printf '\036after\n'; head -c ${GIT_REVIEW_LIMITS.side + 1} -- "$rdir/$name" | base64; printf '\n'
  fi
fi
exit 0`;

// Expects $top (a linked worktree, checked). Reads what a discard would lose:
// the main checkout, the lock, HEAD, the branch and a hash of the full
// porcelain status (untracked files listed one by one), kept in a private
// temporary folder.
const STATE_SH = String.raw`${LINKED_SH}main=$(git worktree list --porcelain 2>/dev/null </dev/null | sed -n '1s/^worktree //p')
[ -n "$main" ] || exit 17
locked=0
[ -e "$gitdir/locked" ] && locked=1
tip=$(git rev-parse -q --verify 'HEAD^{commit}' 2>/dev/null) || tip=""
branch=$(git symbolic-ref -q HEAD 2>/dev/null | sed 's|^refs/heads/||')
tmpbase=$TMPDIR
[ -d "$tmpbase" ] || tmpbase=/tmp
work=$(mktemp -d "$tmpbase/pzza-task.XXXXXX") || exit 4
trap 'rm -rf -- "$work"' EXIT
git --no-optional-locks status --porcelain=v1 -z --untracked-files=all >"$work/status" 2>/dev/null </dev/null || exit 26
st=$(git hash-object --no-filters -- "$work/status" 2>/dev/null) || exit 26
`;

// $1 folder, $2 base ("" = none given). The base is $2 when it is a local
// branch, else the base the task recorded (branch.<b>.pzzabase), else
// origin/HEAD, main or master. Without any base the commits listed are those
// on no other branch or remote branch.
export const DISCARD_PREVIEW_SCRIPT = String.raw`${PRELUDE}${STATE_SH}baseref=""
pick() { if [ -n "$1" ] && git show-ref --verify -q "refs/heads/$1" 2>/dev/null; then baseref="refs/heads/$1"; return 0; fi; return 1; }
if ! pick "$2"; then
  saved=""
  [ -n "$branch" ] && saved=$(git config --get "branch.$branch.pzzabase" 2>/dev/null)
  case $saved in -*) saved="" ;; esac
  if ! pick "$saved"; then
    for ref in "$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null)" refs/heads/main refs/heads/master; do
      if [ -n "$ref" ] && git show-ref --verify -q "$ref" 2>/dev/null; then baseref=$ref; break; fi
    done
  fi
fi
printf '\036main\n%s\n\036branch\n%s\n\036head\n%s\n\036locked\n%s\n\036base\n%s\n\036statushash\n%s\n' "$main" "$branch" "$tip" "$locked" "$baseref" "$st"
printf '\036commits\n'
if [ -n "$tip" ]; then
  if [ -n "$baseref" ]; then ${LOG} HEAD --not "$baseref" --
  else ${LOG} HEAD --not --exclude="refs/heads/$branch" --branches --remotes --
  fi 2>/dev/null </dev/null | ${STRIP}
fi
printf '\036status\n'
head -c ${GIT_REVIEW_LIMITS.statusBytes + 1} -- "$work/status" | base64
printf '\n'
exit 0`;

// $1 folder, then the HEAD, status hash and branch the user reviewed. They
// are checked again right before removing, so nothing that changed since the
// preview is lost; only an unlocked worktree on an app-created pzza/ branch is
// removed (one --force: git still refuses locked worktrees), then its branch.
export const DISCARD_SCRIPT = String.raw`${PRELUDE}${STATE_SH}{ [ "$tip" = "$2" ] && [ "$st" = "$3" ] && [ "$branch" = "$4" ]; } || exit 15
[ "$locked" = 0 ] || exit 27
case $branch in pzza/?*) ;; *) exit 28 ;; esac
cd / || exit 3
if ! out=$(git -C "$main" worktree remove --force "$top" 2>&1 </dev/null); then
  printf '\036error\n%s\n' "$(printf '%s' "$out" | tail -c 1024)"; exit 7
fi
printf '\036removed\n1\n'
if git -C "$main" branch -D "$branch" >/dev/null 2>&1 </dev/null; then printf '\036branchdeleted\n1\n'; fi
exit 0`;

// $1 repository folder, $2 worktree slug, $3 the task's base branch, $4 the
// earliest time (epoch seconds) the branch of this launch can have been
// created, $5 "remove" to clean up (anything else only looks). A launch that
// failed or was cut short (app quit, agent server restart, lost connection,
// one of N candidates failing) can leave <repo>.worktrees/<slug> and its
// branch pzza/<slug> behind (session-create.js WORKTREE_SCRIPT, same path).
// They are removed only when the folder is a worktree registered on exactly
// that branch (or there is no folder and the branch is checked out nowhere),
// unlocked, the branch's reflog starts no earlier than $4 (it is this
// launch's, not an older one of the same name), it has no commit outside the
// base, and the worktree has no uncommitted or untracked change. Then the
// worktree goes with a plain `git worktree remove` (git itself refuses a
// dirty one) and the branch with an update-ref that only deletes it while it
// still points where it was checked: like `git branch -d`, but against the
// task's base instead of the main checkout's HEAD. Anything else is kept
// and named: "foreign" when it is not this launch's at all.
export const RECLAIM_SCRIPT = String.raw`${PRELUDE}dir="$(dirname "$top")/$(basename "$top").worktrees/$2"
branch="pzza/$2"
ref="refs/heads/$branch"
printf '\036dir\n%s\n\036branch\n%s\n' "$dir" "$branch"
keep() { printf '\036state\nkept\n\036reason\n%s\n' "$1"; exit 0; }
list=$(git worktree list --porcelain 2>/dev/null </dev/null) || exit 29
wt() { printf '%s\n' "$list" | d="$dir" r="$ref" awk "$1"; }
registered=$(wt '/^worktree / { cur = substr($0, 10) } cur == ENVIRON["d"] { print 1; exit }')
locked=$(wt '/^worktree / { cur = substr($0, 10); next } cur == ENVIRON["d"] && /^locked/ { print 1; exit }')
holder=$(wt '/^worktree / { cur = substr($0, 10); next } $0 == "branch " ENVIRON["r"] { print cur; exit }')
tip=$(git rev-parse -q --verify "$ref^{commit}" 2>/dev/null) || tip=""
present=0
{ [ -e "$dir" ] || [ -L "$dir" ]; } && present=1
if [ -z "$registered" ] && [ -z "$tip" ]; then
  if [ "$present" = 1 ]; then printf '\036state\nforeign\n'; else printf '\036state\nabsent\n'; fi
  exit 0
fi
if [ -n "$registered" ] && [ "$holder" != "$dir" ]; then printf '\036state\nforeign\n'; exit 0; fi
if [ -z "$registered" ] && { [ "$present" = 1 ] || [ -n "$holder" ]; }; then printf '\036state\nforeign\n'; exit 0; fi
[ -n "$registered" ] && [ "$present" = 1 ] && printf '\036worktree\n1\n'
[ "$5" = remove ] || { printf '\036state\npresent\n'; exit 0; }
[ "$locked" = 1 ] && keep locked
created=$(git reflog show --date=unix --format=%gd "$ref" -- 2>/dev/null </dev/null | tail -n 1 | sed -n 's/.*@{\([0-9][0-9]*\)}$/\1/p')
{ [ -n "$created" ] && [ "$created" -ge "$4" ]; } || keep older
git show-ref --verify -q "refs/heads/$3" 2>/dev/null || keep base
ahead=$(git rev-list -n 1 "refs/heads/$3..$ref" -- 2>/dev/null </dev/null) || keep base
[ -z "$ahead" ] || keep commits
if [ "$present" = 1 ]; then
  changes=$(git -C "$dir" --no-optional-locks status --porcelain --untracked-files=all 2>/dev/null </dev/null) || keep unreadable
  [ -z "$changes" ] || keep changes
fi
if [ -n "$registered" ] && ! out=$(git worktree remove "$dir" 2>&1 </dev/null); then
  printf '\036error\n%s\n' "$(printf '%s' "$out" | tail -c 1024)"
  keep refused
fi
if git update-ref -d "$ref" "$tip" >/dev/null 2>&1 </dev/null; then
  git config --remove-section "branch.$branch" >/dev/null 2>&1 </dev/null
  printf '\036branchdeleted\n1\n'
fi
printf '\036state\nremoved\n'
exit 0`;

// Sets PATH to the one the user's login shell builds (nvm, asdf, Homebrew
// and the like), which a desktop app or ssh command does not get. The shell
// prints it between record separators so anything else its startup files
// print is ignored; it gets pathCaptureSeconds and the current PATH stays
// when it fails. Its output goes to a file so a daemon started by a startup
// file never holds the caller's pipe open.
const LOGIN_PATH_SH = String.raw`lp_shell=$SHELL
[ -n "$lp_shell" ] || lp_shell=/bin/sh
tmpbase=$TMPDIR
[ -d "$tmpbase" ] || tmpbase=/tmp
if lp_file=$(mktemp "$tmpbase/pzza-path.XXXXXX" 2>/dev/null); then
  "$lp_shell" -lic 'printf "${RS}"; printenv PATH; printf "${RS}"' </dev/null >"$lp_file" 2>/dev/null &
  lp_pid=$!
  ( sleep ${TASK_LIMITS.pathCaptureSeconds}; kill -9 "$lp_pid" ) >/dev/null 2>&1 </dev/null &
  lp_dog=$!
  wait "$lp_pid" 2>/dev/null
  kill "$lp_dog" 2>/dev/null
  lp=$(awk -v RS="${RS}" 'NR == 2 { printf "%s", $0; exit }' "$lp_file" 2>/dev/null)
  rm -f -- "$lp_file"
  case $lp in /*) PATH=$lp; export PATH ;; esac
fi
`;

// $1 folder, $2 message, then repository paths to leave out. Stages
// everything else (git add -A with literal exclude pathspecs), un-stages the
// excluded paths in case they were staged before, and commits with the
// repository's hooks, with the login shell's PATH so hooks that need tools
// like node (husky, lint-staged) find them. LC_ALL is left alone so hooks run
// in the user's locale.
export const COMMIT_SCRIPT = String.raw`export GIT_TERMINAL_PROMPT=0
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS GIT_NOGLOB_PATHSPECS GIT_ICASE_PATHSPECS
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 3
[ -n "$top" ] || exit 3
cd -- "$top" 2>/dev/null || exit 3
${LINKED_SH}${LOGIN_PATH_SH}msg=$2
shift 2
n=$#
while [ "$n" -gt 0 ]; do set -- "$@" ":(exclude,literal)$1"; shift; n=$((n - 1)); done
if ! out=$(git add -A -- . "$@" 2>&1 </dev/null); then printf '\036error\n%s\n' "$(printf '%s' "$out" | tail -c 2048)"; exit 12; fi
if [ "$#" -gt 0 ]; then
  n=$#
  while [ "$n" -gt 0 ]; do set -- "$@" ":(literal)${V('1#":(exclude,literal)"')}"; shift; n=$((n - 1)); done
  if git rev-parse -q --verify HEAD >/dev/null 2>&1; then git reset -q -- "$@" >/dev/null 2>&1 </dev/null || exit 14
  else git rm -r -q --cached --ignore-unmatch -- "$@" >/dev/null 2>&1 </dev/null || exit 14; fi
fi
git diff --cached --quiet 2>/dev/null </dev/null && exit 9
if ! out=$(git commit -q -m "$msg" 2>&1 </dev/null); then printf '\036error\n%s\n' "$(printf '%s' "$out" | tail -c 2048)"; exit 13; fi
printf '\036commit\n%s\n' "$(git rev-parse HEAD 2>/dev/null)"
exit 0`;

// $1 folder, $2 the command line (setupCommandLine of the approved list), $3
// "stream" or "tail", $4 the time limit in seconds. Runs from the worktree's
// top-level in a non-interactive sh with stdin closed. "\036run" marks where
// the command's own output starts. "stream" (this machine) execs the command
// so the caller keeps the output tail, owns the time limit and kills the
// process group. "tail" (another device, where only the ssh call can be
// killed) applies the limit with timeout(1) when present, keeps the last
// checkOutput bytes and prints the exit code before them.
export const CHECK_SCRIPT = String.raw`PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE
top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 3
[ -n "$top" ] || exit 3
cd -- "$top" 2>/dev/null || exit 3
cmd=$2 mode=$3 secs=$4
${LOGIN_PATH_SH}printf '\036run\n'
[ "$mode" = tail ] || exec sh -c "$cmd" pzza-check </dev/null 2>&1
work=$(mktemp -d "$tmpbase/pzza-check.XXXXXX") || exit 4
trap 'rm -rf -- "$work"' EXIT
{
  if command -v timeout >/dev/null 2>&1; then timeout -k 10 "$secs" sh -c "$cmd" pzza-check </dev/null
  else sh -c "$cmd" pzza-check </dev/null; fi
  printf '%s' "$?" > "$work/code"
} 2>&1 | tail -c ${TASK_LIMITS.checkOutput} > "$work/out"
printf '\036code\n%s\n\036output\n' "$(cat -- "$work/code" 2>/dev/null)"
cat -- "$work/out"
exit 0`;

// ------------------------------------------------------------------ helpers

const notRepo = () => new GitReviewError("This folder is not inside a Git repository.");
const invalidResponse = () => new GitReviewError("Invalid Git response from the device.", 502);

const FAILURES = {
  3: () => notRepo(),
  4: () => new GitReviewError("Could not create a temporary folder on the device.", 500),
  6: () => new GitReviewError("That file is outside the repository."),
  11: () => new GitReviewError("This folder is the main checkout, not a task worktree. Only linked worktrees are changed here.", 409),
  15: () => new GitReviewError("The worktree changed since you reviewed it. Review it again.", 409),
  17: () => new GitReviewError("Could not find the main checkout of this repository.", 409),
  26: () => new GitReviewError("git status failed in this worktree.", 500),
  27: () => new GitReviewError("This worktree is locked. Unlock it with git worktree unlock first.", 409),
  29: () => new GitReviewError("git could not list the worktrees of this repository.", 500),
};

const failure = (code, fallback) => (FAILURES[code] ?? (() => new GitReviewError(fallback, 502)))();

function run(host, script, args, options, { timeout = TASK_LIMITS.scriptMs, maxBuffer = TASK_LIMITS.buffer } = {}) {
  const { execImpl, env } = options;
  return runDeviceScript(host, script, args, { execImpl, env, timeout, maxBuffer });
}

const decode = (body) => Buffer.from((body ?? "").replace(/\s+/g, ""), "base64");
const cleanLine = (value, max) => value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
const count = (value) => (/^\d+$/.test(value ?? "") ? Number(value) : null);
const validPath = (value) => typeof value === "string" && value.startsWith("/") && value.length <= GIT_REVIEW_LIMITS.pathLength && !CONTROL.test(value);
const validBranchOrNull = (value) => (value && validBranchName(value) ? value : null);

// "sha subject" lines, newest first, at most TASK_LIMITS.commits; the script
// asks for one more so a cut is visible.
export function parseCommits(text) {
  const commits = [];
  for (const line of (text ?? "").split("\n")) {
    const space = line.indexOf(" ");
    const sha = space < 0 ? line : line.slice(0, space);
    if (!SHA.test(sha)) continue;
    commits.push({ sha, subject: cleanLine(space < 0 ? "" : line.slice(space + 1), TASK_LIMITS.subject) });
  }
  return { commits: commits.slice(0, TASK_LIMITS.commits), more: commits.length > TASK_LIMITS.commits };
}

const RAW_STATUS = { A: "added", C: "added", D: "deleted", M: "modified", T: "modified", U: "modified", R: "renamed" };
const numstat = (value) => (value === "-" || value === undefined ? null : count(value));

// `git diff --raw --numstat -z`: every raw record (":modes shas X\0path\0", or
// "...R100\0from\0to\0" for a rename) comes first, then every numstat record
// ("added\tremoved\tpath\0", or "added\tremoved\t\0from\0to\0"). Binary files
// count "-". A list cut short loses its last, partial record.
export function parseRawNumstat(text, cut = false) {
  const tokens = text.split("\0");
  if (cut || tokens[tokens.length - 1] === "") tokens.pop();
  const entries = [];
  const stats = new Map();
  let index = 0;
  while (index < tokens.length) {
    const token = tokens[index];
    if (token.startsWith(":")) {
      const letter = (token.split(" ")[4] ?? "")[0];
      const pair = letter === "R" || letter === "C";
      const first = tokens[index + 1], second = tokens[index + 2];
      if (first === undefined || (pair && second === undefined)) break;
      entries.push(pair ? { letter, from: first, path: second } : { letter, path: first });
      index += pair ? 3 : 2;
      continue;
    }
    const parts = token.split("\t");
    if (parts.length < 3) { index += 1; continue; }
    const named = parts.slice(2).join("\t");
    let path = named;
    if (named === "") {
      path = tokens[index + 2];
      if (path === undefined) break;
      index += 3;
    } else index += 1;
    stats.set(path, { added: numstat(parts[0]), removed: numstat(parts[1]) });
  }
  return { entries, stats };
}

// The counted section: "numstat line\0path\0" pairs for untracked files.
function parseCounted(text) {
  const tokens = text.split("\0");
  const counts = new Map();
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const [added, removed] = tokens[index].split("\t");
    counts.set(tokens[index + 1], { added: numstat(added), removed: numstat(removed) });
  }
  return counts;
}

// The changed files of a stats read: tracked changes first (in git's order),
// then untracked files, at most TASK_LIMITS.files.
export function taskFiles({ diff, diffCut, untracked, untrackedCut, counted }) {
  const { entries, stats } = parseRawNumstat(diff, diffCut);
  const tokens = untracked.split("\0");
  if (untrackedCut || tokens[tokens.length - 1] === "") tokens.pop();
  const counts = parseCounted(counted);
  const files = [];
  let truncated = diffCut || untrackedCut;
  const push = (file) => {
    if (files.length === TASK_LIMITS.files) { truncated = true; return false; }
    files.push(file);
    return true;
  };
  for (const entry of entries) {
    if (!validateRepoFile(entry.path) || (entry.from !== undefined && !validateRepoFile(entry.from))) continue;
    const status = RAW_STATUS[entry.letter] ?? "modified";
    const stat = stats.get(entry.path) ?? { added: null, removed: null };
    const file = { path: entry.path, status, ...(status === "renamed" ? { from: entry.from } : {}), added: stat.added, removed: stat.removed };
    if (!push(file)) break;
  }
  for (const path of tokens) {
    if (!validateRepoFile(path)) continue;
    const stat = counts.get(path) ?? { added: null, removed: null };
    if (!push({ path, status: "untracked", added: stat.added, removed: stat.removed })) break;
  }
  const sum = (key) => files.reduce((total, file) => total + (file[key] ?? 0), 0);
  return { files, truncated, added: sum("added"), removed: sum("removed") };
}

// A base64 section capped at `limit` bytes; the scripts print one byte more so
// a cut is visible.
function cappedSection(found, name, limit) {
  const buffer = decode(found.get(name));
  return buffer.length > limit ? { text: buffer.subarray(0, limit).toString("utf8"), cut: true } : { text: buffer.toString("utf8"), cut: false };
}

// ---------------------------------------------------------------- validation

export const validateTaskBranchesRequest = (body) => validateSetupFolder(body);

function requireBase(value) {
  if (!validBranchName(value)) throw new Error("Choose a valid base branch.");
  return value;
}

export function validateTaskStatsRequest(body) {
  const request = validateSetupFolder(body, ["base"]);
  return { ...request, base: requireBase(body.base) };
}

export function validateTaskDiffRequest(body) {
  const request = validateSetupFolder(body, ["base", "file", "from"]);
  const base = requireBase(body.base);
  if (!validateRepoFile(body.file)) throw new Error("The file must be a path inside the repository.");
  if (body.from !== undefined && !validateRepoFile(body.from)) throw new Error("The rename source must be a path inside the repository.");
  return { ...request, base, file: body.file, from: body.from ?? body.file };
}

export function validateTaskDiscardPreviewRequest(body) {
  const request = validateSetupFolder(body, ["base"]);
  return { ...request, base: body.base === undefined ? null : requireBase(body.base) };
}

export function validateTaskDiscardRequest(body) {
  const request = validateSetupFolder(body, ["fingerprint"]);
  if (typeof body.fingerprint !== "string" || !FINGERPRINT.test(body.fingerprint)) throw new Error("Review the worktree before discarding it.");
  return { ...request, fingerprint: body.fingerprint };
}

// The candidate is named by its session name; the worktree slug comes from it
// exactly as session creation derives it.
export function validateTaskReclaimRequest(body) {
  const request = validateSetupFolder(body, ["session", "base", "startedAt", "remove"]);
  let slug = "";
  try { slug = worktreeSlug(normalizeSessionName(body.session)); } catch { slug = ""; }
  if (!slug) throw new Error("Send the candidate's session name.");
  if (!Number.isSafeInteger(body.startedAt) || body.startedAt < 0) throw new Error("Send when the candidate started.");
  if (typeof body.remove !== "boolean") throw new Error("Choose whether to remove what the launch left behind.");
  return { ...request, slug, base: requireBase(body.base), startedAt: body.startedAt, remove: body.remove };
}

export function validateTaskCommitRequest(body) {
  const request = validateSetupFolder(body, ["message", "exclude"]);
  const { message } = body;
  if (typeof message !== "string" || !message.trim() || message.length > TASK_LIMITS.message || CONTROL.test(message)) {
    throw new Error(`The commit message must be one line of 1 to ${TASK_LIMITS.message} characters without control characters.`);
  }
  const exclude = body.exclude ?? [];
  if (!Array.isArray(exclude) || exclude.length > TASK_LIMITS.exclude) throw new Error(`Exclude at most ${TASK_LIMITS.exclude} files.`);
  if (!exclude.every(validateRepoFile)) throw new Error("Every excluded file must be a path inside the repository.");
  return { ...request, message: message.trim(), exclude: [...new Set(exclude)] };
}

export function validateTaskCheckRequest(body) {
  const request = validateSetupFolder(body, ["run"]);
  if (typeof body.run !== "boolean") throw new Error("Choose whether to run the check.");
  return { ...request, run: body.run };
}

export function validateTaskCheckApproveRequest(body) {
  const request = validateSetupFolder(body, ["check"]);
  const { check } = normalizeWorktreeConfig({ check: body.check });
  if (!check.length) throw new Error("There are no check commands to approve.");
  return { ...request, check };
}

// ---------------------------------------------------------------- endpoints

export async function taskBranches({ host, path }, options = {}) {
  const { code, text } = await run(host, BRANCHES_SCRIPT, [path], options);
  if (code !== 0) throw failure(code, "Could not list the branches.");
  const found = new Map(scriptSections(text));
  const root = found.get("root") ?? "";
  if (!validPath(root)) throw invalidResponse();
  const branches = (found.get("branches") ?? "").split("\n").filter(validBranchName).slice(0, TASK_LIMITS.branches);
  return { root, current: validBranchOrNull(found.get("current")), base: validBranchOrNull(found.get("base")), branches };
}

export async function taskStats({ host, path, base }, options = {}) {
  const { code, text } = await run(host, STATS_SCRIPT, [path, base], options);
  if (code !== 0) throw failure(code, "Could not read this worktree's changes.");
  const found = new Map(scriptSections(text));
  const head = found.get("head") ?? "";
  if (!found.has("diff") || (head && !SHA.test(head))) throw invalidResponse();
  const root = found.get("root") ?? "";
  if (!validPath(root)) throw invalidResponse();
  const baseFound = found.get("found") === "1";
  const mergeBase = SHA.test(found.get("mergebase") ?? "") ? found.get("mergebase") : null;
  const [behind, ahead] = (found.get("counts") ?? "").split(/\s+/).map(count);
  const { commits } = parseCommits(found.get("commits"));
  const diff = cappedSection(found, "diff", TASK_LIMITS.listBytes);
  const untracked = cappedSection(found, "untracked", TASK_LIMITS.listBytes);
  const summary = taskFiles({
    diff: diff.text, diffCut: diff.cut, untracked: untracked.text, untrackedCut: untracked.cut, counted: decode(found.get("counted")).toString("utf8"),
  });
  const uncommitted = count(found.get("uncommitted")) ?? 0;
  return {
    root, branch: validBranchOrNull(found.get("branch")), head: head || null, base, baseFound, mergeBase,
    commits: baseFound ? commits : [], ahead: baseFound ? ahead ?? 0 : 0, behind: baseFound ? behind ?? 0 : 0,
    ...summary, uncommitted, dirty: uncommitted > 0,
  };
}

const capSide = (buffer) => (buffer.length > GIT_REVIEW_LIMITS.side
  ? { buffer: buffer.subarray(0, GIT_REVIEW_LIMITS.side), cut: true }
  : { buffer, cut: false });
const NONE = { buffer: null, cut: false };

export async function taskDiff({ host, path, base, file, from = file }, options = {}) {
  const local = isLocal(host);
  const { code, text } = await run(host, DIFF_SCRIPT, [path, base, from, file, local ? "" : "after"], options);
  if (code !== 0) throw failure(code, "Could not read this file's changes.");
  const found = new Map(scriptSections(text));
  const root = found.get("root") ?? "";
  if (!validPath(root)) throw invalidResponse();
  const before = found.has("before") ? capSide(decode(found.get("before"))) : NONE;
  let after;
  if (local) after = await readWorkingFile(root, file);
  else if (found.has("link")) {
    const link = decode(found.get("link"));
    after = capSide(link[link.length - 1] === 0x0a ? link.subarray(0, -1) : link);
  } else after = found.has("after") ? capSide(decode(found.get("after"))) : NONE;
  return buildDiff(before.buffer, after.buffer, before.cut || after.cut);
}

const fingerprintOf = (head, statusHash, branch) => crypto.createHash("sha256").update(JSON.stringify([head, statusHash, branch])).digest("hex");
const shortRef = (ref) => ref.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\//, "");

async function discardState({ host, path, base }, options) {
  const { code, text } = await run(host, DISCARD_PREVIEW_SCRIPT, [path, base ?? ""], options);
  if (code !== 0) throw failure(code, "Could not read this worktree.");
  const found = new Map(scriptSections(text));
  const main = found.get("main") ?? "", head = found.get("head") ?? "", statusHash = found.get("statushash") ?? "";
  const branch = found.get("branch") ?? "", baseRef = found.get("base") ?? "";
  if (!validPath(main) || (head && !SHA.test(head)) || !SHA.test(statusHash) || CONTROL.test(branch) || CONTROL.test(baseRef)) throw invalidResponse();
  const { commits, more } = parseCommits(found.get("commits"));
  const status = cappedSection(found, "status", GIT_REVIEW_LIMITS.statusBytes);
  const parsed = parseStatusZ(status.text, status.cut);
  return {
    main,
    branch: branch || null,
    base: baseRef ? shortRef(baseRef) : null,
    commits,
    uncommitted: parsed.files.slice(0, TASK_LIMITS.uncommitted).map(({ path: file, status: state }) => ({ path: file, status: state })),
    truncated: more || parsed.truncated || parsed.files.length > TASK_LIMITS.uncommitted,
    locked: found.get("locked") === "1",
    fingerprint: fingerprintOf(head, statusHash, branch),
    head,
    statusHash,
  };
}

// What discarding this worktree would lose; `fingerprint` must come back with
// the discard so it only proceeds while that is still exactly the case.
export async function previewTaskDiscard(request, options = {}) {
  const { head, statusHash, ...preview } = await discardState(request, options);
  return preview;
}

// Deletes unmerged work on purpose: the client showed the preview (commits
// and uncommitted files) and the user confirmed it, and the fingerprint and
// the script's own re-check guarantee nothing changed since.
export async function discardTaskWorktree({ host, path, fingerprint }, options = {}) {
  const state = await discardState({ host, path, base: null }, options);
  if (state.fingerprint !== fingerprint) throw failure(15);
  if (state.locked) throw failure(27);
  if (!state.branch || !state.branch.startsWith("pzza/") || !validBranchName(state.branch)) {
    throw new GitReviewError(`Only worktrees on branches the app created (pzza/...) are discarded with their branch; this one is on ${state.branch ?? "a detached HEAD"}. Remove it from the worktree list instead.`, 409);
  }
  const { code, text } = await run(host, DISCARD_SCRIPT, [path, state.head, state.statusHash, state.branch], options, { timeout: TASK_LIMITS.discardMs });
  const found = new Map(scriptSections(text));
  if (code === 7) throw new GitReviewError(`git refused to remove the worktree: ${gitMessage(found.get("error") ?? "") || "unknown error"}`, 409);
  if (code === 28) throw new GitReviewError("Only worktrees on branches the app created (pzza/...) are discarded with their branch.", 409);
  if (code !== 0) throw failure(code, "Could not discard this worktree.");
  if (found.get("removed") !== "1") throw invalidResponse();
  return { removed: true, branchDeleted: found.get("branchdeleted") === "1" };
}

const RECLAIM_STATES = new Set(["absent", "removed", "kept", "foreign", "present"]);
const RECLAIM_REASONS = new Set(["locked", "older", "base", "commits", "unreadable", "changes", "refused"]);

// What a candidate whose launch never finished left behind, removed when
// `remove` is set and nothing of value is in it (see RECLAIM_SCRIPT).
// `worktree` is its folder while it still exists, so a kept one can be
// reviewed and discarded like any other candidate.
export async function reclaimTaskWorktree({ host, path, slug, base, startedAt, remove }, options = {}) {
  const since = Math.max(0, Math.floor(startedAt / 1000) - TASK_LIMITS.reclaimSlackSeconds);
  const { code, text } = await run(host, RECLAIM_SCRIPT, [path, slug, base, String(since), remove ? "remove" : "inspect"], options, { timeout: TASK_LIMITS.discardMs });
  if (code !== 0) throw failure(code, "Could not look for the candidate's worktree.");
  const found = new Map(scriptSections(text));
  const state = found.get("state") ?? "";
  const dir = found.get("dir") ?? "";
  if (!RECLAIM_STATES.has(state) || !validPath(dir) || found.get("branch") !== `pzza/${slug}`) throw invalidResponse();
  const reason = found.get("reason") ?? "";
  const error = gitMessage(found.get("error") ?? "");
  return {
    state,
    worktree: found.get("worktree") === "1" && state !== "removed" ? dir : null,
    branch: `pzza/${slug}`,
    ...(state === "kept" ? { reason: RECLAIM_REASONS.has(reason) ? reason : "refused" } : {}),
    ...(error ? { error } : {}),
    branchDeleted: found.get("branchdeleted") === "1",
  };
}

// The end of git or hook output as one line. A tail that was cut loses its
// first, partial line, so a cut never leaves half a URL whose credentials the
// cleanup would no longer recognise.
function outputTail(text, cut) {
  const lines = String(text).split("\n");
  if (cut && lines.length > 1) lines.shift();
  const cleaned = lines.map(gitMessage).filter(Boolean).join(" ");
  return cleaned.length > 300 ? cleaned.slice(-300).trim() : cleaned;
}

export async function commitTaskWorktree({ host, path, message, exclude = [] }, options = {}) {
  const { code, text } = await run(host, COMMIT_SCRIPT, [path, message, ...exclude], options, { timeout: TASK_LIMITS.commitMs });
  const found = new Map(scriptSections(text));
  const error = found.get("error") ?? "";
  const cut = Buffer.byteLength(error) >= 2048;
  if (code === 9) throw new GitReviewError("There is nothing to commit.", 409);
  if (code === 12) throw new GitReviewError(`git could not stage the changes: ${outputTail(error, cut) || "unknown error"}`, 409);
  if (code === 13) throw new GitReviewError(`The commit failed: ${outputTail(error, cut) || "unknown error"}`, 409);
  if (code === 14) throw new GitReviewError("git could not leave the excluded files out of the commit.", 409);
  if (code !== 0) throw failure(code, "Could not commit in this worktree.");
  const commit = found.get("commit") ?? "";
  if (!SHA.test(commit)) throw invalidResponse();
  return { commit };
}

// ------------------------------------------------------------------- checks

// Test output for display: escape sequences and control characters other than
// newline and tab removed, a character cut at the start of the tail dropped.
export function cleanCheckOutput(buffer) {
  return buffer.toString("utf8").replace(/^\uFFFD+/, "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").replace(/\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g, "")
    .replace(/\r\n/g, "\n").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
}

const RUN_MARK = Buffer.from(`${RS}run\n`);

// This machine: the script runs detached in its own process group, and the
// whole group is killed at the time limit. Only the last checkOutput bytes of
// the command's output are kept.
function runLocalCheck(path, line, { env, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const started = Date.now();
    let head = Buffer.alloc(0), tail = Buffer.alloc(0), marked = false, timedOut = false, settled = false, exit = null, grace = null;
    const child = spawn("/bin/sh", ["-c", CHECK_SCRIPT, "pzza-check", path, line, "stream", String(Math.ceil(timeoutMs / 1000))], {
      detached: true, stdio: ["ignore", "pipe", "ignore"], env: env ?? deviceEnv(""),
    });
    const killGroup = () => { try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(grace);
      child.stdout.destroy();
      if (!marked) {
        reject(exit?.code === 3 ? notRepo() : new GitReviewError("The check could not start in this worktree.", 500));
        return;
      }
      const durationMs = Date.now() - started;
      const code = timedOut ? null : exit?.code ?? null;
      resolve({ status: timedOut ? "timeout" : code === 0 ? "passed" : "failed", code, output: cleanCheckOutput(tail), durationMs });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      killGroup();
      // A process that left the group could keep the pipe open; stop waiting.
      grace = setTimeout(finish, 2000);
    }, timeoutMs);
    child.stdout.on("data", (chunk) => {
      if (!marked) {
        head = Buffer.concat([head, chunk]);
        if (head.length < RUN_MARK.length) return;
        if (!head.subarray(0, RUN_MARK.length).equals(RUN_MARK)) { killGroup(); return; }
        marked = true;
        chunk = head.subarray(RUN_MARK.length);
      }
      tail = Buffer.concat([tail, chunk]);
      if (tail.length > TASK_LIMITS.checkOutput) tail = tail.subarray(tail.length - TASK_LIMITS.checkOutput);
    });
    child.on("error", () => finish());
    child.on("exit", (code, signal) => {
      exit = { code, signal };
      // Background processes the command left behind may hold the pipe; the
      // output that is already written arrives well within this.
      if (!timedOut) grace = setTimeout(finish, 1000);
    });
    child.on("close", finish);
  });
}

// Another device: one ssh call, killed after the limit (plus room for
// timeout(1) on the device to stop the command first and report it).
function runRemoteCheck(host, path, line, { execImpl = execFile, timeoutMs }) {
  const seconds = Math.max(1, Math.ceil(timeoutMs / 1000));
  const [cmd, args] = remoteGitReviewCommand(host, CHECK_SCRIPT, [path, line, "tail", String(seconds)]);
  return new Promise((resolve, reject) => {
    const started = Date.now();
    execImpl(cmd, args, {
      env: deviceEnv(host || DEVBOX), timeout: timeoutMs + 30000, killSignal: "SIGKILL", maxBuffer: 256 * 1024, encoding: "buffer",
    }, (error, stdout) => {
      const durationMs = Date.now() - started;
      if (error?.killed) { resolve({ status: "timeout", code: null, output: "", durationMs }); return; }
      const exitCode = error ? error.code : 0;
      if (typeof exitCode !== "number" || exitCode === 255) { reject(new GitReviewError("Could not reach the device to run the check.", 503)); return; }
      if (exitCode === 3) { reject(notRepo()); return; }
      const output = Buffer.from(stdout ?? "");
      const at = output.indexOf(RUN_MARK);
      const rest = at < 0 ? "" : output.subarray(at + RUN_MARK.length).toString("latin1");
      const framed = /^\u001ecode\n(\d*)\n\u001eoutput\n/.exec(rest);
      if (exitCode !== 0 || !framed) { reject(new GitReviewError("The check could not start in this worktree.", 500)); return; }
      const code = count(framed[1]);
      const body = output.subarray(at + RUN_MARK.length + framed[0].length);
      // timeout(1) reports 124 when it stopped the command.
      const status = code === 124 ? "timeout" : code === 0 ? "passed" : "failed";
      resolve({ status, code: status === "timeout" ? null : code, output: cleanCheckOutput(body), durationMs });
    });
  });
}

// The check list of the repository's main checkout and whether it is
// approved on this device. A setup file that cannot be read stops here rather
// than quietly skipping the check it may hold.
async function checkState(host, path, options) {
  const setup = await readSetup({ host, path }, { execImpl: options.execImpl, env: options.env });
  if (!setup.config) throw new GitReviewError(setup.error ?? "The worktree setup file cannot be read.", 409);
  const commands = setup.config.check ?? [];
  if (!commands.length) return { setup, status: "none", commands: [] };
  const approved = await setupApproved(setupHost(host), setup.main, commands, { approvalsFile: options.approvalsFile, kind: "check" });
  return { setup, status: approved ? "ready" : "unapproved", commands };
}

const runningChecks = new Set();

// options: approvalsFile, execImpl, env, and timeoutMs (tests shorten the
// TASK_LIMITS.checkMs limit).
export async function taskCheck({ host, path, run: start }, options = {}) {
  if (!start) {
    const { status, commands } = await checkState(host, path, options);
    return { status, commands };
  }
  const key = `${setupHost(host)}\u0000${path.replace(/\/+$/, "") || "/"}`;
  if (runningChecks.has(key)) throw new GitReviewError("A check is already running in this worktree.", 409);
  runningChecks.add(key);
  try {
    const { status, commands } = await checkState(host, path, options);
    if (status !== "ready") return { status, commands };
    const line = setupCommandLine(commands);
    const timeoutMs = options.timeoutMs ?? TASK_LIMITS.checkMs;
    const result = isLocal(host)
      ? await runLocalCheck(path, line, { env: options.env, timeoutMs })
      : await runRemoteCheck(host, path, line, { execImpl: options.execImpl, timeoutMs });
    return { status: result.status, commands, code: result.code, output: result.output, durationMs: result.durationMs };
  } finally {
    runningChecks.delete(key);
  }
}

// Approves only the list the caller was shown: it must still be what the file
// holds right now.
export async function approveTaskCheck({ host, path, check }, options = {}) {
  const { setup, commands } = await checkState(host, path, options);
  if (JSON.stringify(commands) !== JSON.stringify(check)) {
    throw new GitReviewError("The check commands changed since they were shown. Review them again.", 409);
  }
  await approveSetup(setupHost(host), setup.main, check, { approvalsFile: options.approvalsFile, kind: "check" });
  return { status: "ready", commands };
}

// ------------------------------------------------------------------- router

const ROUTES = {
  "/git/task/branches": [validateTaskBranchesRequest, taskBranches],
  "/git/task/stats": [validateTaskStatsRequest, taskStats],
  "/git/task/diff": [validateTaskDiffRequest, taskDiff],
  "/git/task/discard/preview": [validateTaskDiscardPreviewRequest, previewTaskDiscard],
  "/git/task/discard": [validateTaskDiscardRequest, discardTaskWorktree],
  "/git/task/reclaim": [validateTaskReclaimRequest, reclaimTaskWorktree],
  "/git/task/commit": [validateTaskCommitRequest, commitTaskWorktree],
  "/git/task/check": [validateTaskCheckRequest, taskCheck],
  "/git/task/check/approve": [validateTaskCheckApproveRequest, approveTaskCheck],
};

export async function tasksRouter(req, res, url, json) {
  if (!Object.hasOwn(ROUTES, url.pathname)) return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST for task requests" }); return true; }
  const [validate, handle] = ROUTES[url.pathname];
  const { readBody } = await import("./http.js");
  let request;
  try { request = validate(await readBody(req)); }
  catch (error) { json(res, 400, { error: error.message }); return true; }
  try { json(res, 200, await handle(request)); }
  catch (error) {
    if (error instanceof GitReviewError) json(res, error.status, { error: error.message });
    else json(res, 500, { error: "This task action is unavailable." });
  }
  return true;
}
