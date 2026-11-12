// Bringing a worktree branch's work back: open a pull request for it (push,
// then gh pr create --fill, or the host's compare page when gh cannot), or
// merge it into the base branch in the main checkout with a merge commit.
// Every step refuses rather than forces: a dirty worktree, a main checkout
// that is dirty or on another branch, or a conflicting merge (which is
// aborted) all stop with a message. Fixed scripts with positional arguments,
// locally through /bin/sh and on another device over one ssh call.
import { GitReviewError, clearGitRemoteCache, parseRemoteUrl } from "./git-review.js";
import { runDeviceScript, scriptSections, validateSetupFolder } from "./worktree-setup.js";

export const WORKTREE_LAND_LIMITS = { infoMs: 10000, prMs: 120000, mergeMs: 120000, buffer: 64 * 1024 };

const CONTROL = /[\u0000-\u001f\u007f]/;

const PRELUDE = String.raw`export LC_ALL=C GIT_TERMINAL_PROMPT=0 GIT_EDITOR=: GIT_MERGE_AUTOEDIT=no
PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 3
[ -n "$top" ] || exit 3
cd -- "$top" 2>/dev/null || exit 3
gitdir=$(cd -P -- "$(git rev-parse --git-dir 2>/dev/null)" 2>/dev/null && pwd -P)
common=$(cd -P -- "$(git rev-parse --git-common-dir 2>/dev/null)" 2>/dev/null && pwd -P)
linked=0
if [ -n "$gitdir" ] && [ -n "$common" ] && [ "$gitdir" != "$common" ]; then linked=1; fi
branch=$(git symbolic-ref --short -q HEAD 2>/dev/null)
base=""
for ref in "$(git symbolic-ref -q refs/remotes/origin/HEAD 2>/dev/null)" refs/heads/main refs/heads/master; do
  if [ -n "$ref" ] && git show-ref --verify -q "$ref" 2>/dev/null; then base=$ref; break; fi
done
base=$(printf '%s' "$base" | sed -e 's|^refs/heads/||' -e 's|^refs/remotes/origin/||')
if [ -n "$branch" ]; then
  # A task worktree records the branch it started from; PRs and merges target it.
  saved=$(git config --get "branch.$branch.pzzabase" 2>/dev/null)
  case $saved in ''|-*) ;; *) git show-ref --verify -q "refs/heads/$saved" 2>/dev/null && base=$saved ;; esac
fi
main=$(git worktree list --porcelain 2>/dev/null </dev/null | sed -n '1s/^worktree //p')
`;

// $1 folder.
export const WORKTREE_INFO_SCRIPT = `${PRELUDE}printf '\\036linked\\n%s\\n\\036branch\\n%s\\n\\036base\\n%s\\n\\036main\\n%s\\n' "$linked" "$branch" "$base" "$main"
exit 0`;

// $1 worktree folder. Pushes its branch to origin with upstream tracking, then
// asks gh to open the pull request from the commit messages.
export const WORKTREE_PR_SCRIPT = String.raw`${PRELUDE}export GH_PROMPT_DISABLED=1 GH_NO_UPDATE_NOTIFIER=1 NO_COLOR=1
[ "$linked" = 1 ] || exit 11
[ -n "$branch" ] || exit 10
[ "$branch" != "$base" ] || exit 12
origin=$(git remote get-url origin 2>/dev/null </dev/null) || exit 13
printf '\036branch\n%s\n\036base\n%s\n\036origin\n%s\n' "$branch" "$base" "$(printf '%s' "$origin" | head -c 2048)"
limit() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }
if ! out=$(limit 60 git push -u origin "$branch" 2>&1 </dev/null); then
  printf '\036error\n%s\n' "$(printf '%s' "$out" | tail -c 1024)"; exit 14
fi
command -v gh >/dev/null 2>&1 || { printf '\036gh\nmissing\n'; exit 0; }
limit 15 gh auth status >/dev/null 2>&1 </dev/null || { printf '\036gh\nsigned-out\n'; exit 0; }
if [ -n "$base" ]; then out=$(limit 30 gh pr create --fill --head "$branch" --base "$base" 2>&1 </dev/null)
else out=$(limit 30 gh pr create --fill --head "$branch" 2>&1 </dev/null); fi
code=$?
printf '\036gh\nran\n\036ghcode\n%s\n\036ghout\n%s\n' "$code" "$(printf '%s' "$out" | tail -c 2048)"
exit 0`;

// $1 worktree folder, $2 the branch and $3 the base the caller confirmed.
// Merges in the main checkout with --no-ff; a conflicted merge is aborted.
export const WORKTREE_MERGE_SCRIPT = String.raw`${PRELUDE}[ "$linked" = 1 ] || exit 11
[ -n "$branch" ] || exit 10
[ "$branch" = "$2" ] || exit 15
[ -n "$base" ] || exit 18
[ "$base" = "$3" ] || exit 15
[ "$branch" != "$base" ] || exit 12
[ -z "$(git --no-optional-locks status --porcelain --untracked-files=normal 2>/dev/null </dev/null | head -c 1)" ] || exit 16
{ [ -n "$main" ] && [ "$(git -C "$main" rev-parse --is-inside-work-tree 2>/dev/null </dev/null)" = true ]; } || exit 17
printf '\036main\n%s\n' "$main"
current=$(git -C "$main" symbolic-ref --short -q HEAD 2>/dev/null </dev/null)
[ "$current" = "$base" ] || { printf '\036current\n%s\n' "$current"; exit 19; }
git -C "$main" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 </dev/null && exit 20
[ -z "$(git -C "$main" --no-optional-locks status --porcelain --untracked-files=no 2>/dev/null </dev/null | head -c 1)" ] || exit 20
git -C "$main" merge-base --is-ancestor "refs/heads/$branch" HEAD 2>/dev/null </dev/null && exit 21
if out=$(git -C "$main" merge --no-ff --no-edit "$branch" 2>&1 </dev/null); then
  printf '\036commit\n%s\n' "$(git -C "$main" rev-parse HEAD 2>/dev/null </dev/null)"; exit 0
fi
if git -C "$main" rev-parse -q --verify MERGE_HEAD >/dev/null 2>&1 </dev/null; then
  printf '\036conflicts\n%s\n' "$(git -C "$main" diff --name-only --diff-filter=U 2>/dev/null </dev/null | head -n 20)"
  git -C "$main" merge --abort >/dev/null 2>&1 </dev/null && exit 22
  exit 23
fi
printf '\036error\n%s\n' "$(printf '%s' "$out" | tail -c 1024)"
exit 24`;

// ------------------------------------------------------------------ helpers

// A branch name as Git allows it, never an option.
export function validBranchName(name) {
  return typeof name === "string" && name.length > 0 && name.length <= 255 && !CONTROL.test(name) && !name.startsWith("-")
    && !/[\s~^:?*[\\]|\.\.|@\{|\/\/|^\/|\/$|\.lock$|^\.|\/\./.test(name);
}

// Git output for a message: one line, no credentials from a remote URL.
export function gitMessage(text) {
  return String(text).replace(/(\w+:\/\/)[^\s/@]+@/g, "$1").replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\b(?:fatal|error|hint): /g, "").replace(/\s+/g, " ").trim().slice(0, 300);
}

const COMPARE = {
  "github.com": (base, from, into) => `${base}/compare/${into ? `${segments(into)}...` : ""}${segments(from)}?expand=1`,
  "gitlab.com": (base, from, into) => `${base}/-/merge_requests/new?merge_request%5Bsource_branch%5D=${encodeURIComponent(from)}${into ? `&merge_request%5Btarget_branch%5D=${encodeURIComponent(into)}` : ""}`,
  "bitbucket.org": (base, from, into) => `${base}/pull-requests/new?source=${encodeURIComponent(from)}${into ? `&dest=${encodeURIComponent(into)}` : ""}`,
};
const segments = (branch) => branch.split("/").map(encodeURIComponent).join("/");

// The host's "open a pull request" page for a branch (GitHub compare, GitLab
// new merge request, Bitbucket new pull request), or null for other remotes.
export function compareWebUrl(remote, branch, base) {
  if (!validBranchName(branch) || (base && !validBranchName(base))) return null;
  const parsed = parseRemoteUrl(remote);
  return parsed ? COMPARE[parsed.host](parsed.base, branch, base || null) : null;
}

// gh prints the new pull request's URL; when one already exists for the
// branch it fails with a message that ends in that URL.
export function pullRequestUrl(output) {
  const urls = String(output).match(/https:\/\/[^\s'"<>]+\/(?:pull|merge_requests|pull-requests)\/\d+/g);
  return urls ? urls[urls.length - 1] : null;
}

const fail = (message, status = 409) => new GitReviewError(message, status);

const COMMON_FAILURES = {
  3: () => fail("This folder is not inside a Git repository.", 400),
  10: () => fail("This worktree is on a detached HEAD. Check out its branch first."),
  11: () => fail("This folder is the main checkout, not a worktree."),
  12: () => fail("This worktree is on the base branch itself."),
  13: () => fail("This repository has no origin remote to push to."),
  15: () => fail("The worktree changed since it was shown. Refresh and try again."),
  16: () => fail("The worktree has uncommitted or untracked changes. Commit or discard them first."),
  17: () => fail("Could not find the main checkout of this repository."),
  18: () => fail("Could not tell the base branch: there is no origin/HEAD, main or master."),
};

// ---------------------------------------------------------------- endpoints

export const validateWorktreeInfoRequest = (body) => validateSetupFolder(body);
export const validateWorktreePrRequest = (body) => validateSetupFolder(body);

export function validateWorktreeMergeRequest(body) {
  const request = validateSetupFolder(body, ["branch", "base"]);
  if (!validBranchName(body.branch)) throw new Error("Choose the worktree branch to merge.");
  if (!validBranchName(body.base)) throw new Error("Choose the base branch to merge into.");
  return { ...request, branch: body.branch, base: body.base };
}

export async function worktreeInfo({ host, path }, options = {}) {
  const { code, text } = await runDeviceScript(host, WORKTREE_INFO_SCRIPT, [path], { timeout: WORKTREE_LAND_LIMITS.infoMs, maxBuffer: WORKTREE_LAND_LIMITS.buffer, ...options });
  if (code !== 0) throw (COMMON_FAILURES[code] ?? (() => fail("Could not read this worktree.", 502)))();
  const found = new Map(scriptSections(text));
  const field = (name) => {
    const value = found.get(name) ?? "";
    return value && !CONTROL.test(value) ? value : null;
  };
  return { linked: found.get("linked") === "1", branch: field("branch"), base: field("base"), main: field("main") };
}

export async function openWorktreePullRequest({ host, path }, options = {}) {
  const { code, text } = await runDeviceScript(host, WORKTREE_PR_SCRIPT, [path], { timeout: WORKTREE_LAND_LIMITS.prMs, maxBuffer: WORKTREE_LAND_LIMITS.buffer, ...options });
  const found = new Map(scriptSections(text));
  if (code === 14) throw fail(`git push failed: ${gitMessage(found.get("error") ?? "") || "unknown error"}`, 502);
  if (code !== 0) throw (COMMON_FAILURES[code] ?? (() => fail("Could not push this worktree's branch.", 502)))();
  const branch = found.get("branch") ?? "";
  const base = found.get("base") || null;
  if (!validBranchName(branch)) throw fail("Invalid Git response from the device.", 502);
  // The footer chip and the worktree list read the new pull request next.
  clearGitRemoteCache();
  const compareUrl = compareWebUrl(found.get("origin") ?? "", branch, base);
  const result = { pushed: true, branch, base, url: null, created: false, compareUrl, message: null };
  const gh = found.get("gh");
  if (gh === "missing") return { ...result, message: "Pushed. The GitHub CLI (gh) is not installed, so open the pull request on the web page." };
  if (gh === "signed-out") return { ...result, message: "Pushed. gh is not signed in (run gh auth login), so open the pull request on the web page." };
  const output = found.get("ghout") ?? "";
  const url = pullRequestUrl(output);
  if (found.get("ghcode") === "0" && url) return { ...result, url, created: true };
  if (url && /already exists/i.test(output)) return { ...result, url, message: "A pull request for this branch already exists." };
  return { ...result, message: `Pushed, but gh could not open the pull request: ${gitMessage(output) || "unknown error"}` };
}

export async function mergeWorktreeBranch({ host, path, branch, base }, options = {}) {
  const { code, text } = await runDeviceScript(host, WORKTREE_MERGE_SCRIPT, [path, branch, base], { timeout: WORKTREE_LAND_LIMITS.mergeMs, maxBuffer: WORKTREE_LAND_LIMITS.buffer, ...options });
  const found = new Map(scriptSections(text));
  const main = found.get("main") ?? "the main checkout";
  if (code === 0) {
    const commit = found.get("commit") ?? "";
    return { merged: true, branch, base, main, commit: /^[0-9a-f]{40,64}$/.test(commit) ? commit : null };
  }
  if (code === 19) {
    const current = found.get("current");
    throw fail(`The main checkout is ${current ? `on ${gitMessage(current)}` : "on a detached HEAD"}, not ${base}. Switch it to ${base} first.`);
  }
  if (code === 20) throw fail(`The main checkout (${main}) has uncommitted changes or a merge in progress. Commit or stash them first.`);
  if (code === 21) throw fail(`Nothing to merge: ${branch} is already in ${base}.`);
  const conflicts = (found.get("conflicts") ?? "").split("\n").filter((file) => file && !CONTROL.test(file)).slice(0, 5);
  const where = conflicts.length ? ` in ${conflicts.join(", ")}` : "";
  if (code === 22) throw fail(`Merging ${branch} into ${base} stopped on conflicts${where}. The merge was aborted, so ${base} is unchanged.`);
  if (code === 23) throw fail(`Merging ${branch} into ${base} stopped on conflicts${where}, and git merge --abort failed. Resolve it in ${main}.`, 500);
  if (code === 24) throw fail(`git refused the merge: ${gitMessage(found.get("error") ?? "") || "unknown error"}`);
  throw (COMMON_FAILURES[code] ?? (() => fail("Could not merge this worktree.", 502)))();
}

const ROUTES = {
  "/git/worktree/info": [validateWorktreeInfoRequest, worktreeInfo],
  "/git/worktree/pr": [validateWorktreePrRequest, openWorktreePullRequest],
  "/git/worktree/merge": [validateWorktreeMergeRequest, mergeWorktreeBranch],
};

export async function worktreeLandRouter(req, res, url, json) {
  if (!Object.hasOwn(ROUTES, url.pathname)) return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST for worktree requests" }); return true; }
  const [validate, handle] = ROUTES[url.pathname];
  const { readBody } = await import("./http.js");
  let request;
  try { request = validate(await readBody(req)); }
  catch (error) { json(res, 400, { error: error.message }); return true; }
  try { json(res, 200, await handle(request)); }
  catch (error) {
    if (error instanceof GitReviewError) json(res, error.status, { error: error.message });
    else json(res, 500, { error: "This worktree action is unavailable." });
  }
  return true;
}
