// Single-quotes one shell argument. Kept local (same as shell.js shQuote) because
// the web UI imports this catalog, and shell.js pulls in Node-only modules.
const quote = value => `'${String(value).replace(/'/g, `'\\''`)}'`;

// Coding agents a new session can start in its working directory. The command
// line is always built from this fixed catalog, never from client-supplied text,
// so a request can only pick an agent and one of its known permission modes. The
// only free text, an optional starting prompt, is passed as one quoted argument.
export const SESSION_AGENTS = [
  {
    id: "claude",
    label: "Claude Code",
    command: "claude",
    resumeArgs: ["-c"],
    promptFlag: null,
    modes: [
      { id: "default", label: "Default", description: "Ask before edits and commands", args: [] },
      { id: "acceptEdits", label: "Accept edits", description: "Edit files without asking", args: ["--permission-mode", "acceptEdits"] },
      { id: "plan", label: "Plan", description: "Read and plan only", args: ["--permission-mode", "plan"] },
      { id: "auto", label: "Auto", description: "A classifier approves safe actions", args: ["--permission-mode", "auto"] },
      { id: "bypass", label: "Bypass", description: "Skip every permission check", args: ["--dangerously-skip-permissions"] },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    command: "codex",
    resumeArgs: ["resume", "--last"],
    promptFlag: null,
    modes: [
      { id: "default", label: "Default", description: "Use the configured approval policy", args: [] },
      { id: "readOnly", label: "Read only", description: "Sandboxed, no file writes", args: ["--sandbox", "read-only"] },
      { id: "auto", label: "Auto review", description: "Approvals reviewed automatically", args: ["--approve-for-me"] },
      { id: "bypass", label: "Bypass", description: "No approvals and no sandbox", args: ["--dangerously-bypass-approvals-and-sandbox"] },
    ],
  },
  {
    id: "opencode",
    label: "OpenCode",
    command: "opencode",
    resumeArgs: ["-c"],
    promptFlag: "--prompt",
    modes: [
      { id: "default", label: "Build", description: "Default build agent", args: [] },
      { id: "plan", label: "Plan", description: "Planning agent, no edits", args: ["--agent", "plan"] },
      { id: "auto", label: "Auto", description: "Approve permissions not denied", args: ["--auto"] },
    ],
  },
];

export const SESSION_PROMPT_MAX_LENGTH = 4000;

export function sessionAgent(id) {
  return SESSION_AGENTS.find(agent => agent.id === id);
}

// A starting prompt is typed into a shell as one argument: it must be a single
// line (a newline would submit the command early) without control characters.
export function validSessionPrompt(value) {
  return typeof value === "string" && value.trim().length > 0 && value.length <= SESSION_PROMPT_MAX_LENGTH && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
}

// Returns the shell line typed into the new session, or throws for anything
// outside the catalog. Every token except the quoted prompt is a fixed literal.
export function sessionAgentCommand(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["id", "mode", "resume", "prompt"].includes(key))) {
    throw new Error("Choose a supported agent.");
  }
  const agent = sessionAgent(value.id);
  const mode = agent?.modes.find(item => item.id === value.mode);
  if (!agent || !mode) throw new Error("Choose a supported agent and mode.");
  if (value.resume !== undefined && typeof value.resume !== "boolean") throw new Error("Choose whether to continue the last conversation.");
  if (value.prompt !== undefined && !validSessionPrompt(value.prompt)) throw new Error(`Starting prompts are one line of at most ${SESSION_PROMPT_MAX_LENGTH} characters.`);
  const prompt = value.prompt === undefined ? [] : agent.promptFlag ? [agent.promptFlag, quote(value.prompt.trim())] : [quote(value.prompt.trim())];
  return [agent.command, ...(value.resume ? agent.resumeArgs : []), ...mode.args, ...prompt].join(" ");
}
