// Short, plain-language Git facts about a folder, for the git_status
// command's summary.

export type GitFactsChecks = "passing" | "failing" | "pending" | "none";
export interface GitFactsPullRequest { number: number; state: "OPEN" | "MERGED" | "CLOSED"; draft: boolean; checks: GitFactsChecks }
export interface GitFacts {
  /** The branch, or the short commit when detached. */
  branch: string;
  detached: boolean;
  dirty: boolean;
  /** Commits not pushed / not pulled; null when the branch has no upstream. */
  ahead: number | null;
  behind: number | null;
  /** Uncommitted files, when they were counted. */
  files?: number;
  truncated?: boolean;
  /** The branch's pull request: null when it has none, undefined when unknown. */
  pullRequest?: GitFactsPullRequest | null;
}

const CHECKS: Record<Exclude<GitFactsChecks, "none">, string> = { passing: "passing", failing: "failing", pending: "running" };
const plural = (count: number, word: string) => `${count} ${word}${count === 1 ? "" : "s"}`;

/** "feature/x, 3 files changed, 2 commits not pushed, PR 42 open, checks failing" (after the branch phrase). */
function details(facts: GitFacts): string[] {
  const parts: string[] = [];
  if (facts.files !== undefined) parts.push(facts.files === 0 ? "no uncommitted changes" : facts.truncated ? `${facts.files}+ files changed` : `${plural(facts.files, "file")} changed`);
  else parts.push(facts.dirty ? "uncommitted changes" : "no uncommitted changes");
  if (!facts.detached) {
    // No upstream: the branch was never pushed.
    if (facts.ahead === null) parts.push("not pushed");
    else parts.push(facts.ahead > 0 ? `${plural(facts.ahead, "commit")} not pushed` : "pushed");
    if (facts.behind) parts.push(`${facts.behind} behind`);
  }
  const pr = facts.pullRequest;
  if (pr) parts.push(`PR ${pr.number} ${pr.state === "OPEN" && pr.draft ? "draft" : pr.state.toLowerCase()}${pr.checks === "none" ? "" : `, checks ${CHECKS[pr.checks]}`}`);
  else if (pr === null) parts.push("no PR");
  return parts;
}


/** A short sentence to say: "You're on feature/x, 3 files changed, 2 commits not pushed, PR 42 open, checks failing." */
export function gitFactsSentence(facts: GitFacts): string {
  return `${[facts.detached ? `Detached at ${facts.branch}` : `You're on ${facts.branch}`, ...details(facts)].join(", ")}.`;
}
