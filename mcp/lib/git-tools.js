import { post } from "./agent.js";

const location = {
  path: { type: "string", description: "Absolute repository path on the selected device" },
  host: { type: "string", description: "Explicit SSH device alias; empty means the app host" },
};
const base = { type: "string", description: "Remote target/base branch. Required when no remote default is available." };

export const GIT_TOOLS = [
  {
    name: "git_protect",
    description: "Required before every commit, push, and PR. Scan the exact staged content or all unpublished branch changes for secrets and sensitive files, and install enforcing Git hooks while preserving existing hooks. Only approved:true permits proceeding. Findings never include secret values. Recheck after changes.",
    inputSchema: { type: "object", properties: { ...location, operation: { type: "string", enum: ["commit", "push", "pull_request"] }, base, title: { type: "string" }, body: { type: "string" } }, required: ["path", "operation"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    run: (input) => post("/git/protect", input),
  },
  {
    name: "git_commit",
    description: "Create a commit from the current index only after Git protection approves the staged files and commit message. Does not stage files or bypass existing hooks. Blocks environment files, credentials, private keys, and detected secrets.",
    inputSchema: { type: "object", properties: { ...location, message: { type: "string", description: "Complete commit message with real newlines" } }, required: ["path", "message"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: (input) => post("/git/protect", { ...input, operation: "commit_create" }),
  },
  {
    name: "git_create_pull_request",
    description: "Create a protected pull request after scanning all branch changes and PR text. Requires an already pushed branch matching the reviewed local commit. Defaults to draft. Does not push, merge, or bypass protection.",
    inputSchema: { type: "object", properties: { ...location, base, title: { type: "string" }, body: { type: "string" }, draft: { type: "boolean", default: true } }, required: ["path", "base", "title", "body"], additionalProperties: false },
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    run: (input) => post("/git/protect", { ...input, operation: "pull_request_create" }),
  },
];
