// Automatic checkpoints of a tile's working tree: what a coding agent left
// behind at the end of each turn, kept as commits under a private ref
// namespace so any of them can be compared or restored later.
//
// Storage: the working tree (tracked files plus untracked files that are not
// ignored) is staged into a throwaway index (GIT_INDEX_FILE, seeded from a
// copy of the real index so unchanged files are not re-hashed), written with
// git write-tree and wrapped with git commit-tree, parented on HEAD. The
// commit lands at refs/pzzacode/checkpoints/<scope>/<n>, where <scope> is a
// hash of the worktree's real top-level folder (linked worktrees share refs)
// and <n> a zero-padded sequence number. The user's index, working tree,
// stash and branch are never written; refs outside refs/heads and refs/tags
// are not pushed by default. Only the newest CHECKPOINT_LIMITS.keep refs per
// worktree are kept; older ones are deleted so their objects can be gc'd.
//
// Every operation is one fixed /bin/sh script with positional arguments, run
// locally or over a single ssh call to the tile's device, like the other Git
// routes.
import { execFile, spawn } from "node:child_process";
import { DEVBOX, IS_CLIENT } from "./config.js";
import { deviceEnv } from "./shell.js";
import { GitReviewError, remoteGitReviewCommand, validateRepoFile } from "./git-review.js";
import { validateSetupFolder } from "./worktree-setup.js";

export const CHECKPOINT_LIMITS = {
  keep: 50,
  maxUntracked: 20000,
  // Untracked files larger than this are left out of a checkpoint (and so
  // never touched by a restore), keeping build output and downloads out of
  // the object store.
  bigFileBytes: 25 * 1024 * 1024,
  files: 500,
  listBytes: 256 * 1024,
  side: 512 * 1024,
  summary: 300,
  session: 120,
  reason: 2000,
  localMs: 30000,
  remoteMs: 45000,
  graceMs: 15000,
  buffer: 8 * 1024 * 1024,
};

const CONTROL = /[\u0000-\u001f\u007f]/;
const RS = "\u001e";
const SHA = /^[0-9a-f]{40}(?:[0-9a-f]{24})?$/;
const MAX_ID = 99999999;
const KINDS = ["start", "turn", "manual", "backup"];
const CLIENT_KINDS = new Set(["start", "turn", "manual"]);
const AGENT = /^[a-z0-9-]{0,32}$/;
// The summary a checkpoint gets when the caller gives none. Plain words only:
// the turn text is also compared inside the shell scripts.
const DEFAULT_SUMMARY = { start: "Baseline before the agent's next turn", turn: "Turn finished", manual: "Checkpoint", backup: "Before restore" };

// ------------------------------------------------------------------ scripts

// Shell parameter expansion text for the scripts below, which are template
// literals where a bare dollar-brace would be interpolated by JavaScript.
const V = (expression) => `\${${expression}}`;

// Shared prelude: $1 is the tile's folder. Sets top/real/scope/ns, a private
// temp dir removed on exit, and the helpers the operations build on. Process
// spawns are kept few: on some systems each one costs tens of milliseconds.
const LIB = String.raw`export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_OPTIONAL_LOCKS=0
unset GIT_DIR GIT_WORK_TREE GIT_INDEX_FILE GIT_OBJECT_DIRECTORY GIT_ALTERNATE_OBJECT_DIRECTORIES GIT_NAMESPACE GIT_LITERAL_PATHSPECS GIT_GLOB_PATHSPECS
export GIT_AUTHOR_NAME=PzzaCode GIT_AUTHOR_EMAIL=checkpoints@pzzacode.invalid GIT_COMMITTER_NAME=PzzaCode GIT_COMMITTER_EMAIL=checkpoints@pzzacode.invalid
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 3
[ -n "$top" ] || exit 3
cd -P -- "$top" 2>/dev/null || exit 3
real=$(pwd -P)
scope=$(printf '%s' "$real" | git hash-object --stdin 2>/dev/null) || exit 3
rest=${V("scope#????????????????")}
scope=${V('scope%"$rest"')}
[ -n "$scope" ] || exit 3
ns="refs/pzzacode/checkpoints/$scope"
keep=${V(`PZZA_CHECKPOINT_KEEP:-${CHECKPOINT_LIMITS.keep}`)}
case $keep in ''|*[!0-9]*|0) keep=${CHECKPOINT_LIMITS.keep} ;; esac
lockwait=${V("PZZA_CHECKPOINT_LOCK_WAIT:-20")}
case $lockwait in ''|*[!0-9]*) lockwait=20 ;; esac
tmpbase=$TMPDIR
[ -d "$tmpbase" ] || tmpbase=/tmp
work=$(mktemp -d "$tmpbase/pzza-checkpoint.XXXXXX") || exit 4
lockdir=""
takedir=""
# Only links naming this script ($$) are ever removed on the way out.
mine() { [ -n "$1" ] && [ "$(readlink "$1" 2>/dev/null)" = "$$" ]; }
cleanup() {
  rm -rf -- "$work"
  if mine "$takedir"; then rm -f -- "$takedir"; fi
  if mine "$lockdir"; then rm -f -- "$lockdir"; fi
}
trap cleanup EXIT
# PIPE too: when ssh goes away the next write ends the script (and frees the
# lock) instead of carrying on unseen.
trap 'exit 129' HUP INT TERM PIPE
alive() { kill -0 "$1" 2>/dev/null || ps -p "$1" >/dev/null 2>&1; }
# A lock link is stale when its owner is gone, or after ten minutes (no
# operation runs that long; this also covers a reused pid).
stale() { ! alive "$2" || [ -n "$(find "$1" -prune -mmin +10 2>/dev/null)" ]; }
# retire link owner: removes an abandoned takeover link only while it still
# names that owner.
# It is first renamed to a name of ours (of several racing callers only one
# rename succeeds), then checked; a link that turns out not to be the stale
# one is put back.
retire() {
  aside="$1.$$"
  mv -f -- "$1" "$aside" 2>/dev/null || return 1
  got=$(readlink "$aside" 2>/dev/null)
  if [ "$got" != "$2" ] && [ -n "$got" ]; then ln -s "$got" "$1" 2>/dev/null; fi
  rm -f -- "$aside"
  [ "$got" = "$2" ]
}
# One capture or restore per repository at a time, across processes and ssh
# sessions. The lock is a symlink whose target is the owner's pid, created in
# one step, so it never exists without an owner. A dead owner's lock is taken
# over by one waiter at a time (holding a second such link), so a waiter can
# never remove a lock another waiter has just taken. Waits up to $lockwait
# seconds (20).
lock() {
  common=$(cd -P -- "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P) || return 13
  lockdir="$common/pzzacode-checkpoints.owner"
  takedir="$common/pzzacode-checkpoints.takeover"
  waited=0
  while ! ln -s "$$" "$lockdir" 2>/dev/null; do
    owner=$(readlink "$lockdir" 2>/dev/null)
    if [ -n "$owner" ] && stale "$lockdir" "$owner"; then
      if ln -s "$$" "$takedir" 2>/dev/null; then
        # Takers are one at a time here, a dead owner never releases and no
        # one can replace an existing link: if it still names the dead owner,
        # it is safe to remove.
        if [ "$(readlink "$lockdir" 2>/dev/null)" = "$owner" ]; then rm -f -- "$lockdir"; fi
        rm -f -- "$takedir"
        continue
      fi
      taker=$(readlink "$takedir" 2>/dev/null)
      if [ -n "$taker" ] && stale "$takedir" "$taker" && retire "$takedir" "$taker"; then continue; fi
    fi
    waited=$((waited + 1))
    [ "$waited" -le "$lockwait" ] || return 15
    sleep 1
  done
}
emit() { printf '\036%s\n%s\n' "$1" "$2"; }
ref_of() { printf '%s/%08d' "$ns" "$1"; }
tree_of() { git rev-parse -q --verify "$1^{tree}" 2>/dev/null; }
empty_tree() { git hash-object -t tree /dev/null; }
# seq_of ref: its number without the zero padding, in $sq.
seq_of() {
  sq=${V("1##*/")}
  while :; do case $sq in 0?*) sq=${V("sq#0")} ;; *) break ;; esac; done
}
tdiff() { git -c core.quotePath=false diff-tree -r --no-renames --ignore-submodules=all "$@" 2>/dev/null; }

# Stages the working tree into $work/index and sets $tree and $skipped.
snapshot() {
  rm -f -- "$work/index"
  idx=$(git rev-parse --git-path index 2>/dev/null) || return 13
  if [ -f "$idx" ]; then cp -- "$idx" "$work/index" 2>/dev/null || return 13; fi
  # git add skips skip-worktree and assume-unchanged entries, so their local
  # edits would be missing from the snapshot (and lost to a restore). The bits
  # are cleared on the copy for files that are on disk; sparse entries that
  # are absent keep them and so keep their index version.
  if [ -f "$work/index" ]; then
    git ls-files -z -v 2>/dev/null | grep -z '^[a-zS] ' 2>/dev/null \
      | xargs -0 sh -c 'for e do p=${V("e#??")}; if [ -e "$p" ] || [ -L "$p" ]; then printf "%s\000" "$p"; fi; done' pzza-flags > "$work/flagged" 2>/dev/null
    if [ -s "$work/flagged" ]; then
      for flag in --no-skip-worktree --no-assume-unchanged; do
        GIT_INDEX_FILE="$work/index" git update-index -z "$flag" --stdin < "$work/flagged" >/dev/null 2>&1 || return 13
      done
    fi
  fi
  git ls-files -z -o --exclude-standard > "$work/untracked" 2>/dev/null || return 13
  skipped=0
  printf '.\000' > "$work/spec"
  if [ -s "$work/untracked" ]; then
    count=$(tr -cd '\000' < "$work/untracked" | wc -c)
    [ "$((count))" -le ${CHECKPOINT_LIMITS.maxUntracked} ] || return 12
    # "./" first so no name reads as a find option; one linear pass each.
    xargs -0 printf './%s\000' < "$work/untracked" \
      | xargs -0 sh -c '[ $# -gt 0 ] || exit 0; find "$@" -prune -type f -size +${CHECKPOINT_LIMITS.bigFileBytes}c -print0' pzza-size > "$work/big" 2>/dev/null
    if [ -s "$work/big" ]; then
      skipped=$(tr -cd '\000' < "$work/big" | wc -c)
      skipped=$((skipped))
      xargs -0 printf ':(exclude,literal)%s\000' < "$work/big" >> "$work/spec"
    fi
  fi
  GIT_INDEX_FILE="$work/index" git -c core.fsmonitor=false -c core.splitIndex=false -c advice.addEmbeddedRepo=false \
    add -A --ignore-errors --pathspec-from-file="$work/spec" --pathspec-file-nul >/dev/null 2>&1
  rc=$?
  # 1: some files could not be read; they are left out like ignored ones.
  [ "$rc" -le 1 ] || return 13
  tree=$(GIT_INDEX_FILE="$work/index" git write-tree 2>/dev/null) || return 13
  [ -n "$tree" ] || return 13
}

# relabel n summary: gives turn checkpoint n, saved without the agent's
# message, the message that arrived for the same turn after it was saved.
# Only a checkpoint still carrying the default turn summary is renamed; its
# files, parent, trailers and time stay, so the timeline keeps its order.
# Sets $relabelled to 1 when it did.
relabel() {
  ref=$(ref_of "$1")
  old=$(git rev-parse -q --verify "$ref^{commit}" 2>/dev/null) || return 0
  oldmsg=$(git log -1 --no-show-signature --format=%B "$old" 2>/dev/null) || return 0
  [ "$(printf '%s\n' "$oldmsg" | head -n 1)" = "${DEFAULT_SUMMARY.turn}" ] || return 0
  printf '%s\n' "$oldmsg" | grep -qx 'Pzza-Kind: turn' || return 0
  rest=$(printf '%s\n' "$oldmsg" | sed 1d)
  when=$(git log -1 --no-show-signature --format='%ad|%cd' --date=raw "$old" 2>/dev/null) || return 0
  parent=$(git rev-parse -q --verify "$old^1" 2>/dev/null) || parent=""
  if [ -n "$parent" ]; then
    new=$(printf '%s\n%s\n' "$2" "$rest" | GIT_AUTHOR_DATE=${V("when%%|*")} GIT_COMMITTER_DATE=${V("when#*|")} git commit-tree "$tree" -p "$parent" 2>/dev/null) || return 14
  else
    new=$(printf '%s\n%s\n' "$2" "$rest" | GIT_AUTHOR_DATE=${V("when%%|*")} GIT_COMMITTER_DATE=${V("when#*|")} git commit-tree "$tree" 2>/dev/null) || return 14
  fi
  git update-ref "$ref" "$new" "$old" 2>/dev/null || return 0
  relabelled=1
}

# record kind summary agent session [relabel]: saves $tree as the next
# checkpoint and sets $id and $created. A tree equal to the latest checkpoint
# is not saved again ($id is that checkpoint); when the caller names that
# checkpoint as the unlabelled save of this same turn, it gets the summary
# instead. A turn that changed nothing since HEAD without any earlier
# checkpoint is not saved at all ($id is 0).
record() {
  relabelled=0
  latest=$(git for-each-ref --sort=-refname --count=1 --format='%(refname) %(tree)' "$ns/")
  ltree=""
  lastn=0
  if [ -n "$latest" ]; then ltree=${V("latest#* ")}; seq_of "${V("latest%% *")}"; lastn=$sq; fi
  headinfo=$(git log -1 --no-show-signature --format='%H %T' HEAD 2>/dev/null) || headinfo=""
  head=${V("headinfo%% *")}
  htree=${V("headinfo#* ")}
  if [ -z "$headinfo" ]; then head=""; htree=$(empty_tree); fi
  if [ -n "$ltree" ] && [ "$tree" = "$ltree" ]; then
    id=$lastn; created=0
    if [ "$1" = turn ] && [ -n "$5" ] && [ "$5" = "$lastn" ]; then relabel "$lastn" "$2" || return $?; fi
    return 0
  fi
  if [ -z "$latest" ] && [ "$1" = turn ] && [ "$tree" = "$htree" ]; then id=0; created=0; return 0; fi
  base=$ltree
  [ -n "$base" ] || base=$htree
  stats=$(tdiff --numstat "$base" "$tree" | awk -F '\t' '{ f++; if ($1 != "-") a += $1; if ($2 != "-") d += $2 } END { printf "%d %d %d", f, a, d }')
  branch=$(git symbolic-ref --short -q HEAD 2>/dev/null)
  msg=$(printf '%s\n\nPzza-Kind: %s\nPzza-Agent: %s\nPzza-Session: %s\nPzza-Branch: %s\nPzza-Stats: %s\nPzza-Skipped: %s\n' "$2" "$1" "$3" "$4" "$branch" "$stats" "$skipped")
  if [ -n "$head" ]; then commit=$(printf '%s\n' "$msg" | git commit-tree "$tree" -p "$head" 2>/dev/null) || return 14
  else commit=$(printf '%s\n' "$msg" | git commit-tree "$tree" 2>/dev/null) || return 14; fi
  n=$lastn
  tries=0
  # Create-only update: a concurrent capture that took the number moves on.
  while :; do
    n=$((n + 1))
    if git update-ref "$(ref_of "$n")" "$commit" "" 2>/dev/null; then break; fi
    tries=$((tries + 1))
    [ "$tries" -lt 8 ] || return 14
  done
  id=$n
  created=1
}

# Keeps the newest $keep checkpoints. Numbers only grow, so there is nothing
# to drop while the newest number is within the limit.
prune() {
  [ "$id" -gt "$keep" ] || return 0
  git for-each-ref --sort=-refname --format='delete %(refname)' "$ns/" | tail -n +$((keep + 1)) | git update-ref --stdin >/dev/null 2>&1
  return 0
}

# prev_of n: the tree a checkpoint's own changes are measured from ($ptree):
# the newest earlier checkpoint ($pid), else the commit it was taken on
# ($pid 0), else the empty tree.
prev_of() {
  cur=$(ref_of "$1")
  pref=$(git for-each-ref --sort=-refname --format='%(refname) %(tree)' "$ns/" | awk -v cur="$cur" '$1 < cur { print; exit }')
  pid=0
  if [ -n "$pref" ]; then ptree=${V("pref#* ")}; seq_of "${V("pref%% *")}"; pid=$sq; return 0; fi
  ptree=$(git rev-parse -q --verify "$cur^1^{tree}" 2>/dev/null) && return 0
  ptree=$(empty_tree)
}

# guard from to: lists in $work/blocked (NUL separated) what moving the
# worktree from tree $1 to tree $2 would overwrite or remove although it is
# not part of the snapshot ($1). git read-tree refuses for untracked files
# (too large or unreadable ones) but treats ignored files as expendable, so
# those are checked here: an ignored file or folder at a path the change
# creates, an ignored file where it needs a folder, a folder holding ignored
# files where it needs a file, and an ignored file inside an ignored folder.
# Names are compared without case when the repository ignores case.
guard() {
  : > "$work/blocked"
  reason=""
  git -c core.quotePath=false ls-files -o -i --exclude-standard --directory > "$work/ignored" 2>/dev/null
  if [ -s "$work/ignored" ]; then
    tdiff --name-only --diff-filter=AT "$1" "$2" > "$work/created"
    icase=$(git config --bool core.ignorecase 2>/dev/null)
    # Each ignored entry is read once: it and every folder above it go into
    # hash sets, so every created path costs a few lookups (no scan of the
    # ignored list per path).
    awk -v icase="$icase" '
      function key(s) { return icase == "true" ? tolower(s) : s }
      NR == FNR {
        e = $0; dir = 0
        if (e ~ /\/$/) { dir = 1; e = substr(e, 1, length(e) - 1) }
        e = key(e); ig[e] = dir
        n = split(e, part, "/"); above = ""
        for (i = 1; i < n; i++) { above = above (i > 1 ? "/" : "") part[i]; holds[above] = 1 }
        next
      }
      {
        p = $0; k = key(p)
        if (substr(p, 1, 1) == "\"" || (k in ig)) { print "B" p; next }
        n = split(k, part, "/"); prefix = ""
        for (i = 1; i < n; i++) {
          prefix = prefix (i > 1 ? "/" : "") part[i]
          if (prefix in ig) { if (ig[prefix]) print "C" p; else print "B" substr(p, 1, length(prefix)); next }
        }
        if (k in holds) print "B" p
      }' "$work/ignored" "$work/created" > "$work/guard"
    while IFS= read -r line; do
      p=${V("line#?")}
      case $line in
        B*) printf '%s\000' "$p" >> "$work/blocked" ;;
        C*) if [ -e "$p" ] || [ -L "$p" ]; then printf '%s\000' "$p" >> "$work/blocked"; fi ;;
      esac
    done < "$work/guard"
  fi
  if ! GIT_INDEX_FILE="$work/index" git -c core.fsmonitor=false read-tree -n -m -u "$1" "$2" > /dev/null 2> "$work/refused"; then
    sed -n "s/^error: [^']*'\(.*\)'.*/\1/p" "$work/refused" | while IFS= read -r p; do printf '%s\000' "$p"; done >> "$work/blocked"
    [ -s "$work/blocked" ] || reason=$(head -c ${CHECKPOINT_LIMITS.reason} "$work/refused")
  fi
}

# undo_tree n: the current snapshot with checkpoint n's own changes reversed,
# built on a copy of the snapshot index ($rtree). 22: they no longer apply
# ($reason says why); 24: there is nothing to reverse.
undo_tree() {
  prev_of "$1"
  tdiff -p --binary "$ttree" "$ptree" > "$work/patch"
  [ -s "$work/patch" ] || return 24
  cp -- "$work/index" "$work/undo" || return 13
  if ! reason=$(GIT_INDEX_FILE="$work/undo" git apply --cached --whitespace=nowarn "$work/patch" 2>&1); then return 22; fi
  rtree=$(GIT_INDEX_FILE="$work/undo" git write-tree 2>/dev/null) || return 13
}

checkpoint_tree() {
  ttree=$(tree_of "$(ref_of "$1")") || exit 9
  [ -n "$ttree" ] || exit 9
}
`;

/** The prelude every script starts with, for tests of its helpers (the lock). */
export const CHECKPOINT_PRELUDE = LIB;

// $1 folder, $2 kind, $3 summary, $4 agent, $5 session, $6 the checkpoint
// this turn's summary may relabel (empty for none). Holds the repository lock.
export const CAPTURE_SCRIPT = `${LIB}lock || exit $?
snapshot || exit $?
record "$2" "$3" "$4" "$5" "$6" || exit $?
[ "$created" = 1 ] && prune
emit root "$real"
emit id "$id"
emit created "$created"
emit relabelled "$relabelled"
emit skipped "$skipped"
exit 0`;

// $1 folder. Newest first: name NUL commit NUL time NUL message, each record
// closed by 0x1f.
export const LIST_SCRIPT = `${LIB}emit root "$real"
printf '\\036refs\\n'
git for-each-ref --sort=-refname --count=${CHECKPOINT_LIMITS.keep * 2} --format='%(refname:lstrip=-1)%00%(objectname)%00%(creatordate:unix)%00%(contents)%1f' "$ns/" | head -c ${CHECKPOINT_LIMITS.listBytes}
exit 0`;

// $1 folder, $2 checkpoint, $3 "previous" (its own changes) or "now" (what
// changed since it). Prints both trees and the changed files.
export const FILES_SCRIPT = `${LIB}checkpoint_tree "$2"
if [ "$3" = now ]; then
  snapshot || exit $?
  from=$ttree; to=$tree
else
  prev_of "$2"; from=$ptree; to=$ttree
  emit prev "$pid"
fi
emit from "$from"
emit to "$to"
printf '\\036status\\n'; tdiff -z --name-status "$from" "$to" | head -c ${CHECKPOINT_LIMITS.listBytes}; printf '\\n'
printf '\\036numstat\\n'; tdiff -z --numstat "$from" "$to" | head -c ${CHECKPOINT_LIMITS.listBytes}; printf '\\n'
exit 0`;

// $1 folder, $2 and $3 trees, $4 file. Both sides base64.
export const DIFF_SCRIPT = `${LIB}[ "$(git cat-file -t "$2" 2>/dev/null)" = tree ] || exit 9
[ "$(git cat-file -t "$3" 2>/dev/null)" = tree ] || exit 9
side() {
  if [ "$(git cat-file -t "$2:$3" 2>/dev/null)" = blob ]; then
    printf '\\036%s\\n' "$1"; git cat-file blob "$2:$3" 2>/dev/null | head -c ${CHECKPOINT_LIMITS.side + 1} | base64; printf '\\n'
  fi
}
side before "$2" "$4"
side after "$3" "$4"
exit 0`;

// $1 folder, $2 checkpoint, $3 "restore" or "undo". Prints the current
// snapshot (the restore must still match it), the files that would change,
// what blocks the change and, for undo, whether it still applies.
export const PREVIEW_SCRIPT = `${LIB}checkpoint_tree "$2"
snapshot || exit $?
emit current "$tree"
target=$ttree
if [ "$3" = undo ]; then
  undo_tree "$2"
  case $? in
    0) emit apply clean; target=$rtree ;;
    22) emit apply conflict; emit reason "$(printf '%s' "$reason" | head -c ${CHECKPOINT_LIMITS.reason})"; target="" ;;
    24) emit apply empty; target="" ;;
    *) exit 13 ;;
  esac
fi
if [ -n "$target" ]; then
  printf '\\036changes\\n'; tdiff -z --name-status "$tree" "$target" | head -c ${CHECKPOINT_LIMITS.listBytes}; printf '\\n'
  guard "$tree" "$target"
  printf '\\036blocked\\n'; head -c ${CHECKPOINT_LIMITS.listBytes} "$work/blocked"; printf '\\n'
  [ -z "$reason" ] || emit refused "$reason"
else
  printf '\\036changes\\n'; tdiff -z --name-status "$ttree" "$ptree" | head -c ${CHECKPOINT_LIMITS.listBytes}; printf '\\n'
fi
exit 0`;

// $1 folder, $2 checkpoint, $3 mode, $4 the snapshot the preview showed,
// $5 backup summary, $6 session. Under the repository lock: the target tree
// is prepared (the checkpoint, or the current snapshot with the checkpoint's
// own changes reversed), everything it would clobber is refused, the current
// state is saved as a checkpoint, and then one git read-tree -m -u moves the
// worktree from the snapshot to the target. git checks every path before it
// writes any, on a throwaway index, so the real index is untouched.
export const RESTORE_SCRIPT = `${LIB}checkpoint_tree "$2"
lock || exit $?
snapshot || exit $?
[ "$tree" = "$4" ] || exit 20
target=$ttree
if [ "$3" = undo ]; then
  undo_tree "$2"
  rc=$?
  case $rc in
    0) target=$rtree ;;
    22|24) emit reason "$(printf '%s' "$reason" | head -c ${CHECKPOINT_LIMITS.reason})"; exit 22 ;;
    *) exit $rc ;;
  esac
fi
guard "$tree" "$target"
if [ -s "$work/blocked" ]; then printf '\\036blocked\\n'; head -c ${CHECKPOINT_LIMITS.listBytes} "$work/blocked"; printf '\\n'; exit 21; fi
if [ -n "$reason" ]; then emit reason "$reason"; exit 21; fi
record backup "$5" "" "$6" || exit $?
emit backup "$id"
emit applying 1
# From here a stop request waits: the files are written in one step, and it
# is reported in full.
trap "" TERM
if ! GIT_INDEX_FILE="$work/index" git -c core.fsmonitor=false read-tree -m -u "$tree" "$target" > /dev/null 2> "$work/refused"; then
  emit reason "$(head -c ${CHECKPOINT_LIMITS.reason} "$work/refused")"; prune; exit 23
fi
prune
emit done 1
exit 0`;

// ------------------------------------------------------------------ runners

const isLocal = (host) => !host && !IS_CLIENT;

// The local environment for a script. `keep` and `lockWait` (tests only)
// lower retention and the lock wait; they never reach another device, whose
// scripts use the defaults.
function localScriptEnv(keep, lockWait) {
  const env = deviceEnv("");
  delete env.PZZA_CHECKPOINT_KEEP;
  delete env.PZZA_CHECKPOINT_LOCK_WAIT;
  if (Number.isSafeInteger(keep) && keep > 0) env.PZZA_CHECKPOINT_KEEP = String(keep);
  if (Number.isSafeInteger(lockWait) && lockWait >= 0) env.PZZA_CHECKPOINT_LOCK_WAIT = String(lockWait);
  return env;
}

// Runs a script with no shell between us and its arguments. On a timeout a
// local script is asked to stop between steps (SIGTERM to the shell) and its
// process group is killed only if it is still running after a grace period;
// on another device, closing ssh ends it at its next write. With `partial`,
// a timeout resolves with what the script printed so far ({ timedOut: true })
// instead of failing. With `gentle` the caller waits through the grace period
// for that outcome: a restore is never cut in the middle of writing files.
export function runCheckpointScript(host, script, args, { execImpl, timeout, keep, lockWait, partial = false, gentle = false } = {}) {
  const timedOut = () => new GitReviewError("Git did not finish in time.", 503);
  if (!isLocal(host) || execImpl) {
    const [cmd, cmdArgs] = isLocal(host) ? ["/bin/sh", ["-c", script, "pzza-checkpoint", ...args]] : remoteGitReviewCommand(host, script, args);
    const exec = execImpl ?? execFile;
    return new Promise((resolve, reject) => {
      exec(cmd, cmdArgs, { env: isLocal(host) ? localScriptEnv(keep, lockWait) : deviceEnv(host || DEVBOX), timeout: timeout ?? CHECKPOINT_LIMITS.remoteMs, maxBuffer: CHECKPOINT_LIMITS.buffer, encoding: "buffer" }, (error, stdout) => {
        const code = error ? error.code : 0;
        if (error?.killed && partial) { resolve({ code: null, stdout: Buffer.from(stdout ?? ""), timedOut: true }); return; }
        if (error && (typeof code !== "number" || code === 255 || error.killed)) {
          reject(error.killed ? timedOut() : new GitReviewError(isLocal(host) ? "Git could not be started on this device." : "Could not reach the device to run Git.", 503));
          return;
        }
        resolve({ code, stdout: Buffer.from(stdout ?? ""), timedOut: false });
      });
    });
  }
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0, settled = false, closed = false, grace;
    const child = spawn("/bin/sh", ["-c", script, "pzza-checkpoint", ...args], { env: localScriptEnv(keep, lockWait), stdio: ["ignore", "pipe", "ignore"], detached: true });
    const kill = () => { if (!closed) try { process.kill(-child.pid, "SIGKILL"); } catch { /* already gone */ } };
    const finish = (fn) => { if (settled) return; settled = true; clearTimeout(timer); clearTimeout(grace); fn(); };
    const partialResult = () => ({ code: null, stdout: Buffer.concat(chunks), timedOut: true });
    const timer = setTimeout(() => {
      // SIGTERM to the shell alone: it stops at the next step boundary, after
      // a running git command (never inside one), and its EXIT trap frees the
      // lock. Only a script still running after the grace period is killed
      // outright (its lock is then taken over as a dead owner's).
      try { process.kill(child.pid, "SIGTERM"); } catch { /* already gone */ }
      if (!gentle) {
        setTimeout(kill, CHECKPOINT_LIMITS.graceMs).unref();
        finish(() => (partial ? resolve(partialResult()) : reject(timedOut())));
        return;
      }
      // What a restore printed by then says how far it got.
      grace = setTimeout(() => finish(() => resolve(partialResult())), CHECKPOINT_LIMITS.graceMs);
    }, timeout ?? CHECKPOINT_LIMITS.localMs);
    child.stdout.on("data", (chunk) => {
      size += chunk.length;
      if (size > CHECKPOINT_LIMITS.buffer) { kill(); finish(() => reject(new GitReviewError("Git returned too much data.", 502))); return; }
      chunks.push(chunk);
    });
    child.on("error", () => finish(() => reject(new GitReviewError("Git could not be started on this device.", 503))));
    child.on("close", (code) => { closed = true; finish(() => resolve({ code: code ?? 1, stdout: Buffer.concat(chunks), timedOut: grace !== undefined })); });
  });
}

// One operation at a time per device and folder: a turn's capture and a
// restore on the same tree never interleave.
const queues = new Map();
function serialized(key, task) {
  const previous = queues.get(key) ?? Promise.resolve();
  const next = previous.catch(() => undefined).then(task);
  const tail = next.catch(() => undefined);
  queues.set(key, tail);
  void tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
  return next;
}

// ------------------------------------------------------------------ parsing

// Splits "\x1ename\nbody" records; the newline printed after a body is dropped.
function sections(buffer) {
  const out = new Map();
  for (const record of buffer.toString("utf8").split(RS).slice(1)) {
    const newline = record.indexOf("\n");
    const name = newline < 0 ? record : record.slice(0, newline);
    const body = newline < 0 ? "" : record.slice(newline + 1);
    out.set(name, body.endsWith("\n") ? body.slice(0, -1) : body);
  }
  return out;
}

const zList = (text) => (text ? text.split("\0").filter((entry, index, all) => entry !== "" || index < all.length - 1) : []);

const SCRIPT_ERRORS = {
  3: () => new GitReviewError("This folder is not inside a Git repository."),
  4: () => new GitReviewError("Could not create a temporary folder on the device.", 500),
  9: () => new GitReviewError("That checkpoint no longer exists. It may have been pruned; the newest 50 are kept.", 404),
  12: () => new GitReviewError(`This folder has more than ${CHECKPOINT_LIMITS.maxUntracked} untracked files, so it is not checkpointed. Add build output and dependencies to .gitignore.`, 409),
  13: () => new GitReviewError("Git could not take a snapshot of this folder.", 500),
  14: () => new GitReviewError("Git could not save the checkpoint.", 500),
  20: () => new GitReviewError("Files changed after the preview. Review the restore again.", 409),
  15: () => new GitReviewError("Another checkpoint operation is still running in this repository. Try again in a moment.", 409),
};

function scriptFailure(code) {
  const make = SCRIPT_ERRORS[code];
  return make ? make() : new GitReviewError("Checkpoint data is unavailable for this folder.", 502);
}

const seq = (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) && number >= 0 && number <= MAX_ID ? number : null;
};

// The message written by record(): a summary line, then Pzza-* trailers.
export function parseCheckpointMessage(text) {
  const lines = text.split("\n");
  const fields = new Map();
  for (const line of lines.slice(1)) {
    const match = /^Pzza-([A-Za-z]+): ?(.*)$/.exec(line);
    if (match) fields.set(match[1].toLowerCase(), match[2]);
  }
  const [files = 0, added = 0, removed = 0] = (fields.get("stats") ?? "").split(" ").map((part) => seq(part) ?? 0);
  const kind = fields.get("kind");
  const agent = fields.get("agent") ?? "";
  return {
    kind: KINDS.includes(kind) ? kind : "manual",
    summary: cleanText(lines[0] ?? "", CHECKPOINT_LIMITS.summary),
    agent: AGENT.test(agent) ? agent : "",
    session: cleanText(fields.get("session") ?? "", CHECKPOINT_LIMITS.session),
    branch: cleanText(fields.get("branch") ?? "", 256),
    files, added, removed,
    skipped: seq(fields.get("skipped")) ?? 0,
  };
}

export function parseCheckpointList(buffer) {
  const found = sections(buffer);
  const root = found.get("root") ?? "";
  if (!root.startsWith("/") || CONTROL.test(root)) throw new GitReviewError("Invalid Git response from the device.", 502);
  const checkpoints = [];
  for (const record of (found.get("refs") ?? "").split("\u001f")) {
    const [name, commit, time, ...rest] = record.replace(/^\n/, "").split("\0");
    const id = seq(name);
    if (!id || !SHA.test(commit ?? "") || !/^\d+$/.test(time ?? "")) continue;
    checkpoints.push({ id, commit, time: Number(time) * 1000, ...parseCheckpointMessage(rest.join("\0")) });
  }
  return { root, checkpoints: checkpoints.slice(0, CHECKPOINT_LIMITS.keep * 2), keep: CHECKPOINT_LIMITS.keep };
}

const STATUS = { A: "added", D: "deleted", M: "modified", T: "modified" };

// name-status -z: "X\0path\0"; numstat -z: "added\tremoved\tpath\0". Either
// may have been cut short, so a trailing partial entry is dropped.
export function parseCheckpointFiles(statusText, numstatText) {
  const stats = new Map();
  for (const entry of zList(numstatText)) {
    const [added, removed, ...file] = entry.split("\t");
    if (!file.length) continue;
    stats.set(file.join("\t"), { added: added === "-" ? null : seq(added) ?? 0, removed: removed === "-" ? null : seq(removed) ?? 0 });
  }
  const tokens = zList(statusText);
  const files = [];
  let truncated = Buffer.byteLength(statusText) >= CHECKPOINT_LIMITS.listBytes;
  // The last path of a list cut by head -c may itself be cut.
  if (truncated) tokens.pop();
  for (let index = 0; index + 1 < tokens.length; index += 2) {
    const status = STATUS[tokens[index][0]];
    const path = tokens[index + 1];
    if (!status || !validateRepoFile(path)) continue;
    if (files.length === CHECKPOINT_LIMITS.files) { truncated = true; break; }
    const stat = stats.get(path);
    files.push({ path, status, added: stat ? stat.added : 0, removed: stat ? stat.removed : 0, binary: stat ? stat.added === null : false });
  }
  return { files, truncated };
}

// ---------------------------------------------------------------- validation

export function cleanText(value, max) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max).trim();
}

function folder(body, extra) {
  return validateSetupFolder(body, extra);
}

function checkpointId(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_ID) throw new Error("Choose a checkpoint.");
  return value;
}

export const validateCheckpointListRequest = (body) => folder(body, []);

export function validateCheckpointCaptureRequest(body) {
  const request = folder(body, ["kind", "agent", "session", "summary", "relabel"]);
  if (!CLIENT_KINDS.has(body.kind)) throw new Error("Unknown checkpoint kind.");
  const agent = body.agent ?? "";
  if (typeof agent !== "string" || !AGENT.test(agent)) throw new Error("Invalid agent.");
  for (const key of ["session", "summary"]) if (body[key] !== undefined && typeof body[key] !== "string") throw new Error(`Invalid ${key}.`);
  const summary = cleanText(body.summary ?? "", CHECKPOINT_LIMITS.summary);
  // Only a turn with the agent's message can rename the checkpoint saved for it.
  if (body.relabel !== undefined && (body.kind !== "turn" || !summary)) throw new Error("Only a turn with a summary can relabel a checkpoint.");
  const result = { ...request, kind: body.kind, agent, session: cleanText(body.session ?? "", CHECKPOINT_LIMITS.session), summary };
  if (body.relabel !== undefined) result.relabel = checkpointId(body.relabel);
  return result;
}

export function validateCheckpointFilesRequest(body) {
  const request = folder(body, ["id", "against"]);
  if (body.against !== "previous" && body.against !== "now") throw new Error("Compare with the previous checkpoint or with now.");
  return { ...request, id: checkpointId(body.id), against: body.against };
}

export function validateCheckpointDiffRequest(body) {
  const request = folder(body, ["from", "to", "file"]);
  if (typeof body.from !== "string" || !SHA.test(body.from) || typeof body.to !== "string" || !SHA.test(body.to)) throw new Error("Invalid comparison.");
  if (!validateRepoFile(body.file)) throw new Error("The file must be a path inside the repository.");
  return { ...request, from: body.from, to: body.to, file: body.file };
}

export function validateCheckpointPreviewRequest(body) {
  const request = folder(body, ["id", "mode"]);
  if (body.mode !== "restore" && body.mode !== "undo") throw new Error("Choose restore or undo.");
  return { ...request, id: checkpointId(body.id), mode: body.mode };
}

export function validateCheckpointRestoreRequest(body) {
  const request = folder(body, ["id", "mode", "expect", "session"]);
  if (body.mode !== "restore" && body.mode !== "undo") throw new Error("Choose restore or undo.");
  if (typeof body.expect !== "string" || !SHA.test(body.expect)) throw new Error("Preview the restore first.");
  if (body.session !== undefined && typeof body.session !== "string") throw new Error("Invalid session.");
  return { ...request, id: checkpointId(body.id), mode: body.mode, expect: body.expect, session: cleanText(body.session ?? "", CHECKPOINT_LIMITS.session) };
}

// --------------------------------------------------------------- operations

const key = (host, path) => `${host || DEVBOX || ""}\u0000${path}`;

export async function listCheckpoints({ host, path }, options = {}) {
  const { code, stdout } = await runCheckpointScript(host, LIST_SCRIPT, [path], options);
  if (code !== 0) throw scriptFailure(code);
  return parseCheckpointList(stdout);
}

/**
 * Saves the working tree as a checkpoint. `relabel` names the turn checkpoint
 * this app saved for the same turn before the agent's message arrived: when
 * nothing changed since, that checkpoint takes `summary` instead of a new one
 * being saved (`relabelled`).
 */
export function captureCheckpoint({ host, path, kind, agent = "", session = "", summary = "", relabel }, options = {}) {
  const text = summary || DEFAULT_SUMMARY[kind];
  const target = kind === "turn" && summary && Number.isSafeInteger(relabel) && relabel > 0 ? String(relabel) : "";
  return serialized(key(host, path), async () => {
    const { code, stdout } = await runCheckpointScript(host, CAPTURE_SCRIPT, [path, kind, text, agent, session, target], options);
    if (code !== 0) throw scriptFailure(code);
    const found = sections(stdout);
    const id = seq(found.get("id"));
    if (id === null || !found.has("created")) throw new GitReviewError("Invalid Git response from the device.", 502);
    return { id: id || null, created: found.get("created") === "1", relabelled: found.get("relabelled") === "1", skipped: seq(found.get("skipped")) ?? 0, root: found.get("root") ?? "" };
  });
}

export async function checkpointFiles({ host, path, id, against }, options = {}) {
  const { code, stdout } = await runCheckpointScript(host, FILES_SCRIPT, [path, String(id), against], options);
  if (code !== 0) throw scriptFailure(code);
  const found = sections(stdout);
  const from = found.get("from") ?? "", to = found.get("to") ?? "";
  if (!SHA.test(from) || !SHA.test(to)) throw new GitReviewError("Invalid Git response from the device.", 502);
  const prev = found.has("prev") ? seq(found.get("prev")) : null;
  return { id, against, from, to, previous: prev || null, ...parseCheckpointFiles(found.get("status") ?? "", found.get("numstat") ?? "") };
}

export async function checkpointDiff({ host, path, from, to, file }, options = {}) {
  const { code, stdout } = await runCheckpointScript(host, DIFF_SCRIPT, [path, from, to, file], options);
  if (code !== 0) throw scriptFailure(code);
  const found = sections(stdout);
  const side = (name) => {
    if (!found.has(name)) return { buffer: null, cut: false };
    const buffer = Buffer.from(found.get(name).replace(/\s+/g, ""), "base64");
    return buffer.length > CHECKPOINT_LIMITS.side ? { buffer: buffer.subarray(0, CHECKPOINT_LIMITS.side), cut: true } : { buffer, cut: false };
  };
  const before = side("before"), after = side("after");
  const probe = (buffer) => buffer !== null && buffer.subarray(0, 8192).includes(0);
  const binary = probe(before.buffer) || probe(after.buffer);
  const text = (buffer) => (buffer === null ? null : binary ? "" : buffer.toString("utf8"));
  return { before: text(before.buffer), after: text(after.buffer), binary, truncated: before.cut || after.cut };
}

const ACTION = { added: "create", deleted: "delete", modified: "modify" };

export async function previewCheckpointRestore({ host, path, id, mode }, options = {}) {
  return serialized(key(host, path), async () => {
    const { code, stdout } = await runCheckpointScript(host, PREVIEW_SCRIPT, [path, String(id), mode], options);
    if (code !== 0) throw scriptFailure(code);
    const found = sections(stdout);
    const current = found.get("current") ?? "";
    if (!SHA.test(current)) throw new GitReviewError("Invalid Git response from the device.", 502);
    const { files, truncated } = parseCheckpointFiles(found.get("changes") ?? "", "");
    const blocked = zList(found.get("blocked") ?? "").filter(validateRepoFile).slice(0, CHECKPOINT_LIMITS.files);
    const apply = found.get("apply");
    const refused = found.has("refused") ? `Git refused the change: ${cleanReason(found.get("refused"))}` : null;
    const reason = mode === "undo" && apply === "conflict" ? cleanReason(found.get("reason") ?? "")
      : mode === "undo" && apply === "empty" ? "This turn changed no files." : refused;
    return {
      id, mode, expect: current, truncated, blocked,
      files: files.map((file) => ({ path: file.path, action: ACTION[file.status] })),
      applies: blocked.length === 0 && !refused && files.length > 0 && (mode === "restore" || apply === "clean"),
      reason,
    };
  });
}

function cleanReason(text) {
  const lines = text.split("\n").map((line) => line.replace(/^(?:error|fatal): /, "").replace(/[\u0000-\u001f\u007f]/g, " ").trim()).filter(Boolean);
  return lines.slice(0, 4).join(". ").slice(0, 500) || "The changes no longer apply cleanly.";
}

// A restore error that still says which checkpoint holds the files from
// before it, so the user can always undo.
function restoreFailure(message, status, backup) {
  const error = new GitReviewError(backup ? `${message} Your files from before it are saved as checkpoint #${backup}.` : message, status);
  if (backup) error.backup = backup;
  return error;
}

export async function restoreCheckpoint({ host, path, id, mode, expect, session = "" }, options = {}) {
  const summary = mode === "undo" ? `Before undoing turn #${id}` : `Before restoring to #${id}`;
  return serialized(key(host, path), async () => {
    // A slow restore is stopped between steps, never halfway through writing
    // files, and the outcome names the backup it saved.
    const { code, stdout, timedOut } = await runCheckpointScript(host, RESTORE_SCRIPT, [path, String(id), mode, expect, summary, session], { ...options, partial: true, gentle: true });
    const found = sections(stdout);
    const backup = found.has("backup") ? seq(found.get("backup")) || null : null;
    if (found.get("done") === "1" && backup) return { restored: true, id, mode, backup };
    if (timedOut) {
      throw restoreFailure(!backup ? "The restore did not start in time. No files were changed."
        : found.get("applying") === "1" ? "The restore is taking longer than expected and may still be writing files."
          : "The restore was stopped in time before it changed any files.", 503, backup);
    }
    if (code === 21) {
      const blocked = zList(found.get("blocked") ?? "").filter(validateRepoFile).slice(0, 5);
      throw new GitReviewError(blocked.length
        ? `Restoring would overwrite or remove files that are not in any checkpoint (ignored, too large or unreadable): ${blocked.join(", ")}. Move them away first.`
        : `Git refused the restore: ${cleanReason(found.get("reason") ?? "")}.`, 409);
    }
    if (code === 22) throw new GitReviewError(`This turn can no longer be undone on its own: ${cleanReason(found.get("reason") ?? "")}. Restore to an earlier checkpoint instead.`, 409);
    if (code === 23) throw restoreFailure(`Git stopped the restore: ${cleanReason(found.get("reason") ?? "")}.`, 500, backup);
    if (code !== 0) throw restoreFailure(scriptFailure(code).message, scriptFailure(code).status, backup);
    if (found.get("done") !== "1" || !backup) throw restoreFailure("Invalid Git response from the device.", 502, backup);
    return { restored: true, id, mode, backup };
  });
}

// ------------------------------------------------------------------- router

const ROUTES = {
  "/git/checkpoints": [validateCheckpointListRequest, listCheckpoints],
  "/git/checkpoints/capture": [validateCheckpointCaptureRequest, captureCheckpoint],
  "/git/checkpoints/files": [validateCheckpointFilesRequest, checkpointFiles],
  "/git/checkpoints/diff": [validateCheckpointDiffRequest, checkpointDiff],
  "/git/checkpoints/preview": [validateCheckpointPreviewRequest, previewCheckpointRestore],
  "/git/checkpoints/restore": [validateCheckpointRestoreRequest, restoreCheckpoint],
};

export async function checkpointsRouter(req, res, url, json) {
  if (!Object.hasOwn(ROUTES, url.pathname)) return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST for checkpoint requests" }); return true; }
  const [validate, handle] = ROUTES[url.pathname];
  const { readBody } = await import("./http.js");
  let request;
  try { request = validate(await readBody(req)); }
  catch (error) { json(res, 400, { error: error.message }); return true; }
  try { json(res, 200, await handle(request)); }
  catch (error) {
    if (error instanceof GitReviewError) json(res, error.status, error.backup ? { error: error.message, backup: error.backup } : { error: error.message });
    else json(res, 500, { error: "Checkpoints are unavailable for this folder." });
  }
  return true;
}
