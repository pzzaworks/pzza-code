// Coding agents a new session can start in its working directory. Every command
// line is built from this fixed catalog, never from client-supplied text: a
// request only picks an agent and one of its known modes, and the one free-text
// part, an optional starting prompt, is passed as a single quoted argument.
//
// Field guide (types in session-agents.d.ts):
// - command/baseArgs: the binary typed in the shell and a subcommand that always
//   follows it (`goose session`, `kiro-cli chat`, `acli rovodev run`).
// - freshArgs: added only when not continuing (Letta continues by default).
// - modes[].args/env: fixed flags and environment variables for one permission
//   mode. `approval` says what the mode lets through without asking.
// - defaultMode: the mode a session uses when none was chosen. It must ask
//   (or be unable to change anything), whatever the CLI's own default is.
//   Where no flag can force asking, the description says the user's own
//   settings may allow more. An agent with no asking mode at all (Amp) is
//   tagged for what it does, so the app warns before starting it.
// - resume: how the last conversation continues and how wide "last" reaches.
//   Only `continue-last` with `directory` scope is resumed automatically.
// - prompt: how a starting prompt is passed (`arg`, `flag` or `none`).
// - detect: process rules for spotting the agent in a terminal (see
//   matchAgentProcess); `programs` are names tmux shows as the pane command.
// - storage: where transcripts live, for usage readers.

// Single-quotes one shell word unless it is plainly safe. Kept local (same as
// shell.js shQuote) because the web UI imports this catalog, and shell.js pulls
// in Node-only modules. The line is typed into the user's login shell, and
// csh/tcsh expand history on "!" even inside single quotes, so each "!" is
// written as \! between quoted runs: csh, sh, bash, zsh and fish all read
// that as a literal "!".
const shellWord = value => /^[A-Za-z0-9_@%+=:,./-]+$/.test(String(value)) ? String(value)
  : `'${String(value).replace(/'/g, `'\\''`).replace(/!/g, `'\\!'`)}'`;

const ASK = "ask";
const RESTRICTED = "restricted";
const AUTO = "auto";
const BYPASS = "bypass";

const mode = (id, label, description, args = [], approval = ASK, env) => ({ id, label, description, args, approval, ...(env ? { env } : {}) });

// OpenCode and Kilo append an agent's own permission rules after the global
// ones and the last matching rule wins, so a user's `agent.<name>.permission`
// would override a global "ask". The inline config loads after the user and
// project files and sets both. Kilo renamed OpenCode's `build` agent to `code`.
const ASK_RULES = { edit: "ask", bash: "ask", webfetch: "ask" };
const OPENCODE_ASK = JSON.stringify({ permission: ASK_RULES, agent: { build: { permission: ASK_RULES } } });
const KILO_ASK = JSON.stringify({ permission: ASK_RULES, agent: { code: { permission: ASK_RULES } } });

export const SESSION_AGENTS = [
  {
    id: "claude", label: "Claude Code", vendor: "Anthropic", tier: 1,
    homepage: "https://code.claude.com/docs",
    command: "claude", binaries: ["claude"], installDirs: [".local/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      // Plain `claude` starts in auto mode since 2.1.283, so asking is explicit.
      mode("default", "Ask", "Asks before edits and commands", ["--permission-mode", "manual"]),
      mode("acceptEdits", "Accept edits", "Edits files without asking", ["--permission-mode", "acceptEdits"], AUTO),
      mode("plan", "Plan", "Reads and plans only", ["--permission-mode", "plan"], RESTRICTED),
      mode("auto", "Auto", "A classifier approves safe actions", ["--permission-mode", "auto"], AUTO),
      // Pre-approved tools can include Bash, and they run without asking.
      mode("dontAsk", "Don't ask", "Runs pre-approved tools without asking and denies the rest", ["--permission-mode", "dontAsk"], AUTO),
      mode("bypass", "Bypass", "Skips every permission check", ["--dangerously-skip-permissions"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["-c"] },
    prompt: { style: "arg" },
    install: [
      { method: "curl", command: "curl -fsSL https://claude.ai/install.sh | bash" },
      { method: "brew", command: "brew install --cask claude-code" },
    ],
    detect: {
      names: ["claude"],
      paths: ["/\\.local/share/claude/versions/\\d+\\.\\d+\\.\\d+", "/Caskroom/claude-code/"],
      entries: ["/node_modules/@anthropic-ai/claude-code/cli\\.js$"],
      titles: ["claude"],
      excludeFlags: ["-p", "--print", "--chrome-native-host"],
      programs: ["claude"], versionProgram: true,
    },
    storage: { paths: ["~/.claude/projects/<cwd slug>/<session>.jsonl"], format: "jsonl", tokens: true, cost: "computed", limits: "api" },
  },
  {
    id: "codex", label: "Codex", vendor: "OpenAI", tier: 1,
    homepage: "https://github.com/openai/codex",
    command: "codex", binaries: ["codex"], installDirs: [],
    baseArgs: [], freshArgs: [],
    // Codex's own default (workspace-write) edits the folder without asking,
    // and Quick Chat starts in the home folder, so the safe start is read-only.
    // Mode ids stay as saved choices and snapshots recorded them.
    defaultMode: "readOnly",
    modes: [
      // Approval is explicit so a config with approval_policy = "never" cannot make them silent.
      mode("readOnly", "Ask", "Read-only sandbox; asks before edits and other commands", ["--sandbox", "read-only", "--ask-for-approval", "on-request"]),
      mode("default", "Workspace write", "Edits files in this folder without asking; asks before anything outside it", ["--sandbox", "workspace-write", "--ask-for-approval", "on-request"], AUTO),
      mode("auto", "Auto review", "Approvals reviewed automatically", ["--approve-for-me"], AUTO),
      mode("bypass", "Bypass", "No approvals and no sandbox", ["--dangerously-bypass-approvals-and-sandbox"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["resume", "--last"] },
    prompt: { style: "arg" },
    install: [
      { method: "brew", command: "brew install --cask codex" },
      { method: "npm", command: "npm install -g @openai/codex" },
    ],
    detect: {
      names: ["codex"],
      entries: ["/node_modules/@openai/codex/bin/codex\\.js$"],
      titles: ["codex"],
      excludeSubcommands: ["exec", "e", "app-server", "exec-server", "mcp-server", "mcp", "remote-control"],
      programs: ["codex"],
    },
    storage: { paths: ["~/.codex/sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl"], format: "jsonl", tokens: true, cost: "computed", limits: "files" },
  },
  {
    id: "opencode", label: "OpenCode", vendor: "Anomaly", tier: 1,
    homepage: "https://opencode.ai",
    command: "opencode", binaries: ["opencode"], installDirs: [".opencode/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      // The build agent allows everything unless the permission config says ask.
      // Named explicitly so a configured default_agent cannot swap it out.
      mode("default", "Ask", "Build agent; asks before edits, commands and web fetches", ["--agent", "build"], ASK, { OPENCODE_CONFIG_CONTENT: OPENCODE_ASK }),
      mode("plan", "Plan", "Planning agent, no edits", ["--agent", "plan"], RESTRICTED),
      mode("auto", "Auto", "Approves permissions that are not denied", ["--auto"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["-c"] },
    prompt: { style: "flag", flag: "--prompt" },
    install: [
      { method: "curl", command: "curl -fsSL https://opencode.ai/install | bash" },
      { method: "brew", command: "brew install anomalyco/tap/opencode" },
      { method: "npm", command: "npm install -g opencode-ai" },
    ],
    detect: {
      names: ["opencode", "opencode2"],
      titles: ["opencode"],
      excludeSubcommands: ["serve", "web", "acp", "run", "attach", "mcp", "debug", "stats", "export", "session", "models", "providers", "upgrade", "db"],
      programs: ["opencode"],
    },
    storage: { paths: ["~/.local/share/opencode/opencode.db"], format: "sqlite", tokens: true, cost: "stored", limits: "api" },
  },
  {
    id: "gemini", label: "Gemini CLI", vendor: "Google", tier: 1,
    homepage: "https://github.com/google-gemini/gemini-cli",
    command: "gemini", binaries: ["gemini"], installDirs: [],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      mode("default", "Ask", "Asks before edits and commands", ["--approval-mode", "default"]),
      mode("autoEdit", "Auto edit", "Edits files without asking", ["--approval-mode", "auto_edit"], AUTO),
      mode("plan", "Plan", "Reads and plans only", ["--approval-mode", "plan"], RESTRICTED),
      mode("yolo", "YOLO", "Approves every action", ["--approval-mode", "yolo"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--resume", "latest"] },
    prompt: { style: "flag", flag: "-i" },
    install: [
      { method: "npm", command: "npm install -g @google/gemini-cli" },
      { method: "brew", command: "brew install gemini-cli" },
    ],
    detect: {
      names: ["gemini"],
      entries: ["/@google/gemini-cli/"],
      titles: ["gemini"],
      excludeFlags: ["-p", "--prompt"],
      programs: ["gemini"],
    },
    storage: { paths: ["~/.gemini/tmp/<project hash>/chats/session-*.jsonl"], format: "jsonl", tokens: true, cost: "computed", limits: null },
  },
  {
    id: "cursor", label: "Cursor Agent", vendor: "Cursor", tier: 1,
    homepage: "https://cursor.com/cli",
    // The installer links both `agent` and `cursor-agent`; Grok Build also
    // installs an `agent`, so only the unambiguous name is ever typed.
    command: "cursor-agent", binaries: ["cursor-agent"], installDirs: [".local/bin"],
    baseArgs: [], freshArgs: [],
    // Agent mode edits files without asking; read-only Ask mode is the safe start.
    // --mode, --plan and --continue need a CLI from January 2026 or later.
    defaultMode: "ask",
    modes: [
      mode("ask", "Ask", "Read-only questions, no changes", ["--mode", "ask"], RESTRICTED),
      mode("default", "Agent", "Edits files without asking; asks before running commands", [], AUTO),
      mode("plan", "Plan", "Designs an approach before coding", ["--plan"], RESTRICTED),
      mode("force", "Force", "Runs commands unless denied", ["--force"], BYPASS),
    ],
    // `--continue` picks the previous session; whether it is per folder is undocumented.
    resume: { kind: "continue-last", scope: "global", args: ["--continue"] },
    prompt: { style: "arg" },
    install: [{ method: "curl", command: "curl https://cursor.com/install -fsS | bash" }],
    detect: {
      names: ["cursor-agent"],
      entries: ["/cursor-agent/versions/[^/]+/index\\.js$"],
      excludeSubcommands: ["login", "logout", "status", "whoami", "about", "models", "mcp", "update", "upgrade", "ls", "create-chat", "generate-rule", "worker", "acp", "install-shell-integration"],
      excludeFlags: ["-p", "--print"],
      programs: ["cursor-agent"],
    },
    storage: { paths: ["~/.cursor/chats/<workspace hash>/<chat>/store.db"], format: "sqlite", tokens: false, cost: "none", limits: null },
  },
  {
    id: "copilot", label: "GitHub Copilot CLI", vendor: "GitHub", tier: 1,
    homepage: "https://github.com/github/copilot-cli",
    command: "copilot", binaries: ["copilot"], installDirs: [],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      // No flag forces asking; tools allowed in its settings run without it.
      mode("default", "Ask", "Asks before tools unless your settings allow them"),
      mode("plan", "Plan", "Plans before making changes", ["--plan"], RESTRICTED),
      mode("autopilot", "Autopilot", "Works through the task on its own", ["--autopilot"], AUTO),
      mode("allowTools", "Allow all tools", "Runs every tool without asking", ["--allow-all-tools"], BYPASS),
      mode("yolo", "YOLO", "Allows all tools, paths and URLs", ["--yolo"], BYPASS),
    ],
    // `--continue` falls back to the newest session from any folder.
    resume: { kind: "continue-last", scope: "global", args: ["--continue"] },
    prompt: { style: "flag", flag: "-i" },
    install: [
      { method: "brew", command: "brew install copilot-cli" },
      { method: "npm", command: "npm install -g @github/copilot" },
      { method: "curl", command: "curl -fsSL https://gh.io/copilot-install | bash" },
    ],
    detect: {
      names: ["copilot"],
      entries: ["/@github/copilot/"],
      excludeFlags: ["-p", "--prompt"],
      programs: ["copilot"],
    },
    storage: { paths: ["~/.copilot/session-state/<session>/events.jsonl"], format: "jsonl", tokens: false, cost: "none", limits: null },
  },
  {
    id: "pi", label: "Pi", vendor: "Earendil", tier: 1,
    homepage: "https://pi.dev",
    command: "pi", binaries: ["pi"], installDirs: [],
    baseArgs: [], freshArgs: [],
    // Pi never asks for approval, so the safe start cannot change files.
    defaultMode: "readOnly",
    modes: [
      mode("readOnly", "Read only", "Read and search tools only", ["--tools", "read,grep,find,ls"], RESTRICTED),
      mode("default", "Full access", "Every tool, never asks", [], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--continue"] },
    prompt: { style: "arg", separator: "--" },
    install: [
      { method: "curl", command: "curl -fsSL https://pi.dev/install.sh | sh" },
      { method: "npm", command: "npm install -g --ignore-scripts @earendil-works/pi-coding-agent" },
    ],
    detect: {
      names: ["pi"],
      entries: ["/@earendil-works/pi-coding-agent/", "/@mariozechner/pi-coding-agent/"],
      titles: ["pi"],
      excludeFlags: ["-p", "--print", "--mode"],
      programs: ["pi"],
    },
    storage: { paths: ["~/.pi/agent/sessions/--<cwd>--/<time>_<session>.jsonl"], format: "jsonl", tokens: true, cost: "stored", limits: null },
  },
  {
    id: "cline", label: "Cline", vendor: "Cline", tier: 1,
    homepage: "https://cline.bot/cli",
    command: "cline", binaries: ["cline"], installDirs: [],
    baseArgs: [], freshArgs: [],
    defaultMode: "ask",
    modes: [
      // Cline approves everything at startup unless told otherwise.
      mode("ask", "Ask", "Asks before edits and commands", ["--auto-approve", "false"]),
      mode("plan", "Plan", "Plans first, asks before acting", ["--auto-approve", "false", "-p"], RESTRICTED),
      mode("yolo", "YOLO", "Approves every action", ["-y"], BYPASS),
    ],
    resume: { kind: "by-id", scope: "global", args: ["--id"] },
    // A bare prompt runs headless and exits; -i keeps the session open.
    prompt: { style: "flag", flag: "-i" },
    install: [{ method: "npm", command: "npm install -g cline" }],
    detect: {
      names: ["cline", ".cline"],
      paths: ["/(cline|@cline/cli-[a-z0-9-]+)/bin/\\.?cline$"],
      entries: ["/(cline|@cline/cli-[a-z0-9-]+)/bin/\\.?cline$"],
      excludeSubcommands: ["auth", "history", "mcp", "hub", "kanban", "schedule"],
      excludeFlags: ["--acp", "--json", "-z", "--zen"],
      programs: ["cline", ".cline"],
    },
    storage: { paths: ["~/.cline/data/db/sessions.db", "~/.cline/data/sessions/<session>/"], format: "sqlite", tokens: false, cost: "none", limits: null },
  },
  {
    id: "goose", label: "goose", vendor: "Block", tier: 1,
    homepage: "https://goose-docs.ai",
    command: "goose", binaries: ["goose"], installDirs: [".local/bin"],
    baseArgs: ["session"], freshArgs: [],
    // Modes are environment-only, and goose's own default is auto.
    defaultMode: "approve",
    modes: [
      mode("approve", "Ask", "Asks before every tool and file change", [], ASK, { GOOSE_MODE: "approve" }),
      mode("smartApprove", "Smart approve", "Approves low-risk actions, asks for the rest", [], AUTO, { GOOSE_MODE: "smart_approve" }),
      mode("chat", "Chat only", "No tools or file changes", [], RESTRICTED, { GOOSE_MODE: "chat" }),
      mode("auto", "Auto", "Approves every action", [], BYPASS, { GOOSE_MODE: "auto" }),
    ],
    // `goose session --resume` takes the newest session from any folder.
    resume: { kind: "continue-last", scope: "global", args: ["--resume"] },
    prompt: { style: "flag", flag: "-t", baseArgs: ["run", "-s"] },
    install: [
      { method: "brew", command: "brew install block-goose-cli" },
      { method: "curl", command: "curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | CONFIGURE=false bash" },
    ],
    detect: {
      names: ["goose"],
      // Homebrew's `goose` formula is a database migration tool.
      excludePaths: ["/Cellar/goose/"],
      requireArgs: { goose: "^(session|s|run)?$" },
      programs: [],
    },
    storage: { paths: ["~/.local/share/goose/sessions/sessions.db"], format: "sqlite", tokens: true, cost: "stored", limits: null },
  },
  {
    id: "antigravity", label: "Antigravity CLI", vendor: "Google", tier: 1,
    homepage: "https://antigravity.google",
    command: "agy", binaries: ["agy"], installDirs: [".local/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      // --mode takes only accept-edits or plan; nothing forces asking.
      mode("default", "Ask", "Asks before edits and commands unless your settings allow more"),
      mode("acceptEdits", "Accept edits", "Edits files without asking", ["--mode", "accept-edits"], AUTO),
      mode("plan", "Plan", "Reads and plans only", ["--mode", "plan"], RESTRICTED),
      mode("bypass", "Skip permissions", "Approves every tool request", ["--dangerously-skip-permissions"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["-c"] },
    prompt: { style: "flag", flag: "-i" },
    install: [{ method: "curl", command: "curl -fsSL https://antigravity.google/cli/install.sh | bash" }],
    detect: {
      names: ["agy"],
      excludeSubcommands: ["mcp", "plugin", "plugins", "models", "agent", "agents", "remote-control", "mic-serve", "update", "install", "changelog", "help"],
      excludeFlags: ["-p", "--print", "--prompt"],
      programs: ["agy"],
    },
    storage: { paths: ["~/.gemini/antigravity-cli/conversations/<conversation>.db", "~/.gemini/antigravity-cli/history.jsonl"], format: "sqlite", tokens: false, cost: "none", limits: null },
  },
  {
    id: "qwen", label: "Qwen Code", vendor: "Alibaba", tier: 1,
    homepage: "https://github.com/QwenLM/qwen-code",
    command: "qwen", binaries: ["qwen"], installDirs: [],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      mode("default", "Ask", "Asks before edits and commands", ["--approval-mode", "default"]),
      mode("plan", "Plan", "Reads and plans only", ["--approval-mode", "plan"], RESTRICTED),
      mode("autoEdit", "Auto edit", "Edits files without asking", ["--approval-mode", "auto-edit"], AUTO),
      mode("auto", "Auto", "Approves safe actions automatically", ["--approval-mode", "auto"], AUTO),
      mode("yolo", "YOLO", "Approves every action", ["--approval-mode", "yolo"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--continue"] },
    prompt: { style: "flag", flag: "-i" },
    install: [
      { method: "npm", command: "npm install -g @qwen-code/qwen-code@latest" },
      { method: "brew", command: "brew install qwen-code" },
    ],
    detect: {
      names: ["qwen"],
      entries: ["/@qwen-code/qwen-code/"],
      titles: ["qwen"],
      excludeFlags: ["-p", "--prompt"],
      programs: ["qwen"],
    },
    storage: { paths: ["~/.qwen/projects/<cwd slug>/chats/<session>.jsonl"], format: "jsonl", tokens: true, cost: "computed", limits: null },
  },
  {
    id: "crush", label: "Crush", vendor: "Charm", tier: 1,
    homepage: "https://github.com/charmbracelet/crush",
    command: "crush", binaries: ["crush"], installDirs: [],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      mode("default", "Ask", "Asks before tools unless your permissions allow them"),
      mode("yolo", "YOLO", "Approves every action", ["-y"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--continue"] },
    prompt: { style: "none" },
    install: [
      { method: "brew", command: "brew install charmbracelet/tap/crush" },
      { method: "npm", command: "npm install -g @charmland/crush" },
    ],
    detect: {
      names: ["crush"],
      entries: ["/@charmland/crush/run-crush\\.js$"],
      excludeSubcommands: ["run", "server"],
      programs: ["crush"],
    },
    storage: { paths: ["<project>/.crush/crush.db"], format: "sqlite", tokens: true, cost: "stored", limits: null },
  },
  {
    id: "kilo", label: "Kilo Code", vendor: "Kilo Code", tier: 1,
    homepage: "https://kilo.ai/docs/cli",
    command: "kilo", binaries: ["kilo"], installDirs: [],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      // Same lineage as OpenCode: most tools are allowed unless config says ask.
      mode("default", "Ask", "Code agent; asks before edits, commands and web fetches", [], ASK, { KILO_CONFIG_CONTENT: KILO_ASK }),
      mode("auto", "Auto", "Approves permissions that are not denied", ["--auto"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--continue"] },
    prompt: { style: "flag", flag: "--prompt" },
    install: [{ method: "npm", command: "npm install -g @kilocode/cli" }],
    detect: {
      names: ["kilo", "kilocode", ".kilo"],
      paths: ["/@kilocode/cli(-[a-z0-9-]+)?/bin/\\.?kilo$"],
      entries: ["/@kilocode/cli(-[a-z0-9-]+)?/bin/\\.?kilo$"],
      excludeSubcommands: ["run", "serve"],
      programs: ["kilo", ".kilo"],
    },
    storage: { paths: ["~/.local/share/kilo/kilo.db"], format: "sqlite", tokens: true, cost: "stored", limits: "cli" },
  },
  {
    id: "grok", label: "Grok Build", vendor: "xAI", tier: 1,
    homepage: "https://docs.x.ai/build/overview",
    command: "grok", binaries: ["grok"], installDirs: [".grok/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      // Plan and auto are in-session toggles; there is no flag that forces asking.
      mode("default", "Ask", "Asks unless your config sets another permission mode or allows the tool"),
      mode("alwaysApprove", "Always approve", "Approves every action", ["--always-approve"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["-c"] },
    prompt: { style: "arg" },
    install: [
      { method: "curl", command: "curl -fsSL https://x.ai/cli/install.sh | bash" },
      { method: "npm", command: "npm install -g @xai-official/grok" },
    ],
    detect: {
      names: ["grok"],
      // Its `agent` alias is never matched by name alone: Cursor uses it too.
      paths: ["/\\.grok/downloads/grok-", "/@xai-official/grok/", "/grok-native$"],
      requirePaths: ["/\\.grok/", "/@xai-official/grok/", "/grok-native$"],
      excludeSubcommands: ["leader", "agent", "usage", "sessions"],
      excludeFlags: ["-p"],
      programs: ["grok"],
    },
    storage: { paths: ["~/.grok/sessions/<cwd>/<session>/"], format: "jsonl", tokens: true, cost: "cli", limits: null },
  },
  {
    id: "amp", label: "Amp", vendor: "Amp", tier: 1,
    homepage: "https://ampcode.com",
    command: "amp", binaries: ["amp"], installDirs: [".amp/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    // Amp runs tools without asking unless its settings opt into permissions,
    // and no flag turns asking on, so its only mode is tagged for that.
    modes: [mode("default", "Allow all", "Runs tools without asking unless your Amp settings turn on permissions", [], BYPASS)],
    // Threads live on the account; continuing the last one needs its id.
    resume: { kind: "by-id", scope: "account", args: ["threads", "continue"] },
    prompt: { style: "none" },
    install: [
      { method: "curl", command: "curl -fsSL https://ampcode.com/install.sh | bash" },
      { method: "brew", command: "brew install ampcode/tap/ampcode" },
      { method: "npm", command: "npm install -g @ampcode/cli" },
    ],
    detect: {
      names: ["amp"],
      // Homebrew's `amp` formula is a text editor; Amp's own tap installs `ampcode`.
      requirePaths: ["/\\.amp/bin/amp$", "/@ampcode/cli/", "/Cellar/ampcode/"],
      requireArgs: { amp: "^(threads|-.*)?$" },
      excludeFlags: ["-x", "--execute", "--no-tui"],
      programs: [],
    },
    storage: { paths: [], format: "remote", tokens: false, cost: "none", limits: "cli" },
  },
  {
    id: "droid", label: "Factory Droid", vendor: "Factory", tier: 1,
    homepage: "https://docs.factory.ai/cli",
    command: "droid", binaries: ["droid"], installDirs: [".local/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    // Interactive droid takes only --auto low|medium|high. Its
    // --skip-permissions-unsafe belongs to `droid exec` only, so no mode
    // offers it. No flag forces the asking level (Off).
    modes: [
      mode("default", "Ask", "Asks before edits and commands unless your settings raise autonomy"),
      mode("autoLow", "Auto low", "Approves file edits and low-risk commands", ["--auto", "low"], AUTO),
      mode("autoMedium", "Auto medium", "Approves edits, low-risk commands and reversible workspace changes", ["--auto", "medium"], AUTO),
      mode("autoHigh", "Auto high", "Approves high-risk actions unless a safety check asks", ["--auto", "high"], AUTO),
    ],
    // A bare --resume opens a session picker; --last skips it and resumes the
    // most recent session in the current folder.
    resume: { kind: "continue-last", scope: "directory", args: ["--resume", "--last"] },
    prompt: { style: "arg" },
    install: [
      { method: "curl", command: "curl -fsSL https://app.factory.ai/cli | sh" },
      { method: "brew", command: "brew install --cask droid" },
      { method: "npm", command: "npm install -g droid" },
    ],
    detect: {
      names: ["droid"],
      paths: ["/node_modules/@factory/cli-[a-z0-9-]+/", "/node_modules/droid/bin/droid$"],
      excludeSubcommands: ["exec"],
      programs: ["droid"],
    },
    storage: { paths: ["~/.factory/sessions/<cwd slug>/<session>.jsonl"], format: "jsonl", tokens: true, cost: "none", limits: null },
  },
  {
    id: "kiro", label: "Kiro CLI", vendor: "Amazon Web Services", tier: 1,
    homepage: "https://kiro.dev/cli",
    command: "kiro-cli", binaries: ["kiro-cli"], installDirs: [".local/bin"],
    baseArgs: ["chat"], freshArgs: [],
    defaultMode: "default",
    modes: [
      mode("default", "Ask", "Asks before tools your permissions do not allow"),
      mode("trustAll", "Trust all tools", "Runs every tool without asking", ["--trust-all-tools"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--resume"] },
    prompt: { style: "none" },
    install: [
      { method: "curl", command: "curl -fsSL https://cli.kiro.dev/install | bash" },
      { method: "brew", command: "brew install --cask kiro-cli" },
    ],
    detect: {
      names: ["kiro-cli", "kiro-cli-chat", "kiro", "qchat"],
      excludeSubcommands: ["acp", "login", "logout", "whoami", "settings", "doctor", "update", "mcp", "translate", "inline", "integrations", "diagnostic", "issue", "version"],
      programs: ["kiro-cli", "kiro"],
    },
    storage: { paths: ["~/.kiro/"], format: "sqlite", tokens: false, cost: "none", limits: null },
  },
  {
    id: "codebuddy", label: "CodeBuddy Code", vendor: "Tencent", tier: 1,
    homepage: "https://www.codebuddy.ai/cli",
    command: "codebuddy", binaries: ["codebuddy"], installDirs: [".local/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      // Explicit so a configured permissions.defaultMode cannot skip asking.
      mode("default", "Ask", "Asks before edits and commands", ["--permission-mode", "default"]),
      mode("acceptEdits", "Accept edits", "Edits files without asking", ["--permission-mode", "acceptEdits"], AUTO),
      mode("plan", "Plan", "Reads and plans only", ["--permission-mode", "plan"], RESTRICTED),
      mode("bypass", "Bypass", "Skips permission checks", ["-y"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "global", args: ["-c"] },
    prompt: { style: "arg" },
    install: [
      { method: "npm", command: "npm install -g @tencent-ai/codebuddy-code" },
      { method: "brew", command: "brew install Tencent-CodeBuddy/tap/codebuddy-code" },
    ],
    detect: {
      names: ["codebuddy", "cbc", "codebuddy-code"],
      entries: ["/@tencent-ai/codebuddy-code/"],
      excludeFlags: ["-p", "--print"],
      programs: ["codebuddy", "cbc"],
    },
    storage: { paths: ["~/.codebuddy/projects/"], format: "jsonl", tokens: false, cost: "none", limits: null },
  },
  {
    id: "kimi", label: "Kimi Code", vendor: "Moonshot AI", tier: 1,
    homepage: "https://github.com/MoonshotAI/kimi-code",
    command: "kimi", binaries: ["kimi"], installDirs: [".kimi-code/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      mode("default", "Always ask", "Asks before edits and commands"),
      mode("plan", "Plan", "Reads and plans only", ["--plan"], RESTRICTED),
      mode("yolo", "Ask when needed", "Approves routine actions", ["--yolo"], AUTO),
      mode("auto", "Never ask", "Approves every action", ["--auto"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--continue"] },
    prompt: { style: "none" },
    install: [
      { method: "curl", command: "curl -fsSL https://code.kimi.com/kimi-code/install.sh | bash" },
      { method: "npm", command: "npm install -g @moonshot-ai/kimi-code" },
    ],
    detect: {
      names: ["kimi"],
      paths: ["/\\.kimi-code/bin/kimi$"],
      entries: ["/@moonshot-ai/kimi-code/"],
      excludeSubcommands: ["acp", "web", "login", "doctor", "export", "vis", "provider", "migrate", "upgrade", "update", "app"],
      programs: ["kimi"],
    },
    storage: { paths: ["~/.kimi-code/sessions/<workspace>/<session>/agents/main/wire.jsonl"], format: "jsonl", tokens: true, cost: "computed", limits: "api" },
  },
  {
    id: "devin", label: "Devin CLI", vendor: "Cognition", tier: 1,
    homepage: "https://docs.devin.ai/cli",
    command: "devin", binaries: ["devin"], installDirs: [".local/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "normal",
    modes: [
      // Explicit so a configured permission_mode cannot skip asking.
      mode("normal", "Ask", "Asks before edits and commands", ["--permission-mode", "normal"]),
      mode("acceptEdits", "Accept edits", "Edits files without asking", ["--permission-mode", "accept-edits"], AUTO),
      mode("smart", "Smart", "Approves low-risk actions", ["--permission-mode", "smart"], AUTO),
      mode("dangerous", "Dangerous", "Approves every action", ["--permission-mode", "dangerous"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--continue"] },
    prompt: { style: "arg", separator: "--" },
    install: [
      { method: "curl", command: "curl -fsSL https://cli.devin.ai/install.sh | bash" },
      { method: "brew", command: "brew install --cask devin-cli" },
    ],
    detect: {
      names: ["devin"],
      excludeSubcommands: ["list", "ls", "ssh"],
      excludeFlags: ["-p", "--print", "--cloud"],
      programs: ["devin"],
    },
    storage: { paths: ["~/.local/share/devin/cli/sessions.db"], format: "sqlite", tokens: false, cost: "none", limits: null },
  },
  {
    id: "vibe", label: "Mistral Vibe", vendor: "Mistral AI", tier: 2,
    homepage: "https://github.com/mistralai/mistral-vibe",
    command: "vibe", binaries: ["vibe"], installDirs: [".local/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "ask",
    modes: [
      mode("ask", "Ask", "Asks before edits and commands", ["--agent", "ask"]),
      mode("default", "Accept edits", "Edits files without asking", [], AUTO),
      mode("smartApprove", "Smart approve", "Approves low-risk actions", ["--agent", "smart-approve"], AUTO),
      mode("autoApprove", "Auto approve", "Approves every action", ["--auto-approve"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--continue"] },
    prompt: { style: "arg" },
    install: [
      { method: "curl", command: "curl -LsSf https://mistral.ai/vibe/install.sh | bash" },
      { method: "brew", command: "brew install mistral-vibe" },
      { method: "uv", command: "uv tool install mistral-vibe" },
    ],
    detect: {
      // The Python launcher replaces itself with the native vibe-rs binary.
      names: ["vibe-rs"],
      paths: ["/vibe/_bin/vibe-rs$", "/cli-rust/target/release/vibe-rs$"],
      programs: ["vibe-rs"],
    },
    storage: { paths: ["~/.vibe/logs/session/<session>/messages.jsonl"], format: "jsonl", tokens: false, cost: "none", limits: null },
  },
  {
    id: "aider", label: "Aider", vendor: "Aider-AI", tier: 2,
    homepage: "https://aider.chat",
    command: "aider", binaries: ["aider"], installDirs: [".local/bin"],
    baseArgs: [], freshArgs: [],
    // Code mode applies edits without asking, so the safe start is Ask mode.
    defaultMode: "ask",
    modes: [
      mode("ask", "Ask", "Answers questions, no edits", ["--chat-mode", "ask"], RESTRICTED),
      mode("default", "Code", "Edits files without asking (each change is a Git commit); asks before commands", [], AUTO),
      // Architect accepts the editor's changes by default; this makes it ask first.
      mode("architect", "Architect", "Plans with one model; asks before another applies the edits", ["--architect", "--no-auto-accept-architect"]),
      mode("yes", "Yes always", "Confirms every question", ["--yes-always"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--restore-chat-history"] },
    prompt: { style: "none" },
    install: [
      { method: "curl", command: "curl -LsSf https://aider.chat/install.sh | sh" },
      { method: "brew", command: "brew install aider" },
      { method: "uv", command: "uv tool install --force --python python3.12 --with pip aider-chat@latest" },
    ],
    detect: {
      names: [],
      // A Python console script: the interpreter runs .../bin/aider.
      entries: ["(^|/)aider$"],
      programs: ["aider", "python", "python3", "Python"],
    },
    storage: { paths: ["<git root>/.aider.chat.history.md"], format: "markdown", tokens: false, cost: "none", limits: null },
  },
  {
    id: "warp", label: "Warp Agent", vendor: "Warp", tier: 2,
    homepage: "https://docs.warp.dev/agents/cli/",
    command: "warp", binaries: ["warp"], installDirs: [],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      mode("default", "Ask", "Asks unless your default execution profile always allows the action"),
      mode("autoApprove", "Auto approve", "Approves every action", ["--auto-approve"], BYPASS),
    ],
    // Conversations are saved to the Warp account and resume only by token.
    resume: { kind: "by-id", scope: "account", args: ["--resume"] },
    prompt: { style: "none" },
    install: [
      { method: "brew", command: "brew install --cask warp-agent-cli" },
      { method: "curl", command: "curl -fsSL https://app.warp.dev/download/agent-cli | bash" },
    ],
    detect: {
      names: ["warp", "warp-tui-stable", "warp-tui-preview"],
      // Never the Warp terminal app itself.
      excludePaths: ["Warp\\.app/"],
      excludeFlags: ["--help", "--version"],
      programs: ["warp-tui-stable", "warp-tui-preview"],
    },
    storage: { paths: [], format: "remote", tokens: false, cost: "none", limits: null },
  },
  {
    id: "auggie", label: "Auggie", vendor: "Augment Code", tier: 2,
    homepage: "https://docs.augmentcode.com/cli/overview",
    command: "auggie", binaries: ["auggie"], installDirs: [],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    // Its default for tools without a permission rule is not documented.
    modes: [mode("default", "Default", "Follows your Auggie permission rules")],
    resume: { kind: "continue-last", scope: "global", args: ["--continue"] },
    prompt: { style: "arg" },
    install: [{ method: "npm", command: "npm install -g @augmentcode/auggie" }],
    detect: {
      names: ["auggie"],
      entries: ["/@augmentcode/auggie/"],
      excludeFlags: ["--acp", "--mcp", "--print", "-p"],
      programs: ["auggie"],
    },
    storage: { paths: ["~/.augment/sessions/"], format: "jsonl", tokens: true, cost: "stored", limits: "cli" },
  },
  {
    id: "letta", label: "Letta Code", vendor: "Letta", tier: 2,
    homepage: "https://docs.letta.com/letta-code",
    command: "letta", binaries: ["letta"], installDirs: [],
    // Plain `letta` continues the last agent's conversation.
    baseArgs: [], freshArgs: ["--new"],
    defaultMode: "standard",
    modes: [
      mode("standard", "Ask", "Asks before edits and commands", ["--permission-mode", "standard"]),
      mode("acceptEdits", "Accept edits", "Edits files without asking", ["--permission-mode", "acceptEdits"], AUTO),
      mode("yolo", "Unrestricted", "Approves every action", ["--yolo"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "account", args: [] },
    prompt: { style: "none" },
    install: [{ method: "npm", command: "npm install -g @letta-ai/letta-code" }],
    detect: {
      names: ["letta"],
      entries: ["/@letta-ai/letta-code/"],
      programs: ["letta"],
    },
    storage: { paths: ["~/.letta/"], format: "remote", tokens: false, cost: "none", limits: null },
  },
  {
    id: "qoder", label: "Qoder CLI", vendor: "Qoder", tier: 2,
    homepage: "https://docs.qoder.com/cli",
    command: "qodercli", binaries: ["qodercli", "qoder"], installDirs: [],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      // Explicit so a configured general.defaultPermissionMode cannot skip asking.
      mode("default", "Ask", "Asks before edits and commands", ["--permission-mode", "default"]),
      mode("plan", "Plan", "Reads and plans only", ["--permission-mode", "plan"], RESTRICTED),
      mode("acceptEdits", "Accept edits", "Edits files without asking", ["--permission-mode", "accept_edits"], AUTO),
      mode("bypass", "YOLO", "Skips permission checks", ["--yolo"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "global", args: ["-c"] },
    prompt: { style: "flag", flag: "-i" },
    install: [{ method: "npm", command: "npm install -g @qoder-ai/qodercli" }],
    detect: {
      names: ["qodercli", "qoder"],
      entries: ["/@qoder-ai/qodercli/"],
      excludeFlags: ["-p", "--print"],
      programs: ["qodercli", "qoder"],
    },
    storage: { paths: ["~/.qoder/"], format: "unknown", tokens: false, cost: "none", limits: null },
  },
  {
    id: "forgecode", label: "ForgeCode", vendor: "Tailcall", tier: 2,
    homepage: "https://forgecode.dev",
    command: "forge", binaries: ["forge"], installDirs: [],
    baseArgs: [], freshArgs: [],
    // Forge never asks for approval; its planning agent is the safe start.
    defaultMode: "muse",
    modes: [
      mode("muse", "Muse (plan)", "Writes a plan, no code changes", ["--agent", "muse"], RESTRICTED),
      mode("sage", "Sage (research)", "Reads and answers, no changes", ["--agent", "sage"], RESTRICTED),
      mode("forge", "Forge", "Edits and runs commands, never asks", ["--agent", "forge"], BYPASS),
    ],
    resume: { kind: "by-id", scope: "global", args: ["--conversation-id"] },
    prompt: { style: "none" },
    install: [
      { method: "curl", command: "curl -fsSL https://forgecode.dev/cli | sh" },
      { method: "npm", command: "npm install -g forgecode" },
    ],
    detect: {
      names: ["forge"],
      // Foundry ships a `forge` too, always with a subcommand.
      excludePaths: ["/\\.foundry/"],
      requireArgs: { forge: "^(-.*)?$" },
      entries: ["/node_modules/forgecode/"],
      programs: [],
    },
    storage: { paths: ["~/.forge/"], format: "unknown", tokens: false, cost: "none", limits: null },
  },
  {
    id: "rovodev", label: "Rovo Dev", vendor: "Atlassian", tier: 2,
    homepage: "https://support.atlassian.com/rovo/docs/use-rovo-dev-cli/",
    command: "acli", binaries: ["acli"], installDirs: [],
    baseArgs: ["rovodev", "run"], freshArgs: [],
    defaultMode: "default",
    modes: [
      mode("default", "Ask", "Asks before tools unless your config allows them"),
      mode("yolo", "YOLO", "Approves every action", ["--yolo"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "directory", args: ["--restore"] },
    prompt: { style: "none" },
    install: [{ method: "brew", command: "brew tap atlassian/homebrew-acli && brew install acli" }],
    detect: {
      names: ["acli", "atlassian_cli_rovodev"],
      requireArgs: { acli: "^rovodev$" },
      excludeFlags: ["--web"],
      programs: ["atlassian_cli_rovodev"],
    },
    storage: { paths: ["~/.rovodev/sessions/<session>/session_context.json"], format: "json", tokens: false, cost: "none", limits: null },
  },
  {
    id: "junie", label: "Junie", vendor: "JetBrains", tier: 2,
    homepage: "https://junie.jetbrains.com",
    command: "junie", binaries: ["junie"], installDirs: [".local/bin"],
    baseArgs: [], freshArgs: [],
    defaultMode: "default",
    modes: [
      mode("default", "Ask", "Asks before commands unless your config enables Brave mode or allows them"),
      mode("brave", "Brave", "Runs actions without asking", ["--brave"], BYPASS),
    ],
    resume: { kind: "continue-last", scope: "global", args: ["--resume"] },
    prompt: { style: "flag", flag: "--prompt" },
    install: [{ method: "curl", command: "curl -fsSL https://junie.jetbrains.com/install.sh | bash" }],
    detect: {
      names: ["junie"],
      entries: ["/@jetbrains/junie-cli/"],
      programs: ["junie"],
    },
    storage: { paths: ["<session>/events.jsonl"], format: "jsonl", tokens: false, cost: "none", limits: null },
  },
];

export const SESSION_AGENT_IDS = SESSION_AGENTS.map(agent => agent.id);
export const SESSION_PROMPT_MAX_LENGTH = 4000;

export function sessionAgent(id) {
  return typeof id === "string" ? SESSION_AGENTS.find(agent => agent.id === id) : undefined;
}

/** The mode a session starts in when none was picked. */
export function defaultSessionAgentMode(agent) {
  return agent.modes.find(item => item.id === agent.defaultMode) ?? agent.modes[0];
}

/** A known mode of the agent by id, else its default mode. */
export function sessionAgentMode(agent, modeId) {
  return agent.modes.find(item => item.id === modeId) ?? defaultSessionAgentMode(agent);
}

/** Whether a new session can be asked to continue the agent's last conversation. */
export function agentCanContinue(agent) {
  return agent?.resume.kind === "continue-last";
}

/**
 * Whether a restarted terminal can continue the agent's conversation by itself:
 * only when "last" means the last one in that folder, so a restore never picks
 * up a conversation from somewhere else.
 */
export function agentCanAutoResume(agent) {
  return agent?.resume.kind === "continue-last" && agent.resume.scope === "directory";
}

/** Whether the agent accepts a starting prompt on its command line. */
export function agentTakesPrompt(agent) {
  return agent?.prompt.style !== "none";
}

// A starting prompt is typed into a shell as one argument: it must be a single
// line (a newline would submit the command early) without control characters,
// and must not start with "-", which an agent would read as a flag. Backslashes
// are refused because fish treats \' inside single quotes as an escaped quote,
// so a prompt like x\' ; cmd would end the quoting there and run cmd.
/** Why a starting prompt cannot be typed, or null when it can. */
export function sessionPromptError(value) {
  if (typeof value === "string" && value.includes("\\")) return "The starting prompt can't contain backslashes.";
  const valid = typeof value === "string" && value.trim().length > 0 && value.length <= SESSION_PROMPT_MAX_LENGTH &&
    !value.trim().startsWith("-") && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(value);
  return valid ? null : `Starting prompts are one line of at most ${SESSION_PROMPT_MAX_LENGTH} characters and cannot start with "-".`;
}

export function validSessionPrompt(value) {
  return sessionPromptError(value) === null;
}

/**
 * The launch for a catalog choice as environment entries and argv, before shell
 * quoting. Throws for anything outside the catalog.
 */
export function sessionAgentLaunch(value) {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).some(key => !["id", "mode", "resume", "prompt"].includes(key))) {
    throw new Error("Choose a supported agent.");
  }
  const agent = sessionAgent(value.id);
  const selected = agent?.modes.find(item => item.id === value.mode);
  if (!agent || !selected) throw new Error("Choose a supported agent and mode.");
  if (value.resume !== undefined && typeof value.resume !== "boolean") throw new Error("Choose whether to continue the last conversation.");
  if (value.resume && !agentCanContinue(agent)) throw new Error(`${agent.label} cannot continue its last conversation from the command line.`);
  if (value.prompt !== undefined) {
    if (!agentTakesPrompt(agent)) throw new Error(`${agent.label} does not take a starting prompt.`);
    const promptError = sessionPromptError(value.prompt);
    if (promptError) throw new Error(promptError);
    if (value.resume && agent.prompt.baseArgs) throw new Error(`${agent.label} cannot continue a conversation with a starting prompt.`);
  }
  const prompting = value.prompt !== undefined;
  const base = prompting && agent.prompt.baseArgs ? agent.prompt.baseArgs : agent.baseArgs;
  const prompt = !prompting ? []
    : agent.prompt.style === "flag" ? [agent.prompt.flag, value.prompt.trim()]
      : [...(agent.prompt.separator ? [agent.prompt.separator] : []), value.prompt.trim()];
  return {
    env: Object.entries(selected.env ?? {}),
    argv: [agent.command, ...base, ...(value.resume ? agent.resume.args : agent.freshArgs), ...selected.args, ...prompt],
  };
}

// Returns the shell line typed into the new session, or throws for anything
// outside the catalog. Every token except the quoted prompt is a fixed literal.
export function sessionAgentCommand(value) {
  const { env, argv } = sessionAgentLaunch(value);
  const words = argv.map(shellWord);
  return env.length ? ["env", ...env.map(([key, item]) => shellWord(`${key}=${item}`)), ...words].join(" ") : words.join(" ");
}

/**
 * The command that continues an agent's conversation in a restarted terminal,
 * or null when it cannot do that by itself (see agentCanAutoResume). It uses
 * the mode the session was started with when it is the same agent, otherwise
 * the agent's default mode. Throws for an agent outside the catalog.
 */
export function sessionAgentResumeCommand(id, recorded) {
  const agent = sessionAgent(id);
  if (!agent) throw new Error("Choose a supported agent.");
  if (!agentCanAutoResume(agent)) return null;
  const selected = recorded?.id === agent.id && agent.modes.some(item => item.id === recorded.mode) ? recorded.mode : agent.defaultMode;
  return sessionAgentCommand({ id: agent.id, mode: selected, resume: true });
}

/**
 * Every command a restarted terminal may type, with the program names tmux can
 * show while that agent runs. The native session restore accepts only these.
 */
export function sessionAgentResumeAllowlist() {
  return SESSION_AGENTS.filter(agentCanAutoResume).flatMap(agent => agent.modes.map(item => ({
    agent: agent.id,
    command: sessionAgentCommand({ id: agent.id, mode: item.id, resume: true }),
    programs: [...agent.detect.programs],
    versionProgram: agent.detect.versionProgram === true,
  })));
}

/** The catalog agent tmux's pane command names, if one is unambiguous. */
export function agentForProgram(value) {
  const name = String(value || "").split("/").pop().replace(/^-/, "");
  return name ? SESSION_AGENTS.find(agent => agent.detect.programs.includes(name) && !["python", "python3", "Python"].includes(name))?.id : undefined;
}

/** Plain-data process rules, safe to serialize into a remote probe script. */
export function agentProcessRules() {
  return SESSION_AGENTS.map(({ id, detect }) => ({
    id,
    names: detect.names ?? [],
    paths: detect.paths ?? [],
    requirePaths: detect.requirePaths ?? [],
    excludePaths: detect.excludePaths ?? [],
    entries: detect.entries ?? [],
    titles: detect.titles ?? [],
    requireArgs: detect.requireArgs ?? {},
    excludeSubcommands: detect.excludeSubcommands ?? [],
    excludeFlags: detect.excludeFlags ?? [],
  }));
}

// A detect path pattern as plain text: path characters with only "\." escapes
// and an optional trailing "$". The native setup check and the Quick Chat shell
// script match these without a regex engine, so anything else is refused.
function plainPathPattern(pattern) {
  const end = pattern.endsWith("$");
  const body = end ? pattern.slice(0, -1) : pattern;
  if (!/^(?:[A-Za-z0-9_@/-]|\\\.)+$/.test(body)) throw new Error(`Agent path pattern ${pattern} is not a plain path fragment.`);
  return { text: body.replace(/\\\./g, "."), end };
}

/**
 * Where an installed binary of the agent may live, from its detect rules: a
 * path containing an `exclude` fragment is another tool with the same name
 * (Foundry's forge, Homebrew's goose), and when `require` is not empty the
 * path must contain one of its fragments. `end` anchors a fragment at the end.
 */
export function agentBinaryPathRules(agent) {
  return {
    exclude: (agent.detect.excludePaths ?? []).map(plainPathPattern),
    require: (agent.detect.requirePaths ?? []).map(plainPathPattern),
  };
}

/**
 * Whether a binary found by name can be the agent. `paths` are the path it was
 * found at and the path it resolves to: either may show the other tool.
 */
export function agentBinaryAllowed(agent, paths) {
  const { exclude, require } = agentBinaryPathRules(agent);
  const matches = (rule, path) => (rule.end ? path.endsWith(rule.text) : path.includes(rule.text));
  if (paths.some(path => exclude.some(rule => matches(rule, path)))) return false;
  return require.length === 0 || paths.some(path => require.some(rule => matches(rule, path)));
}

/**
 * The catalog agent a process is, or "". `process` carries what a snapshot
 * knows: `command` (ps comm: argv[0] as a path or a bare name), `executable`
 * (the resolved binary, Linux), `entrypoint` (the script an interpreter runs),
 * `title` (a retitled interpreter) and `args` (argv, when read). Rules that
 * need arguments apply only once they are known, so an early pass can pick
 * candidates and a later one, with arguments, decides.
 *
 * Self-contained on purpose: it is serialized into the remote probe script.
 */
export function matchAgentProcess(process, rules) {
  const basename = value => String(value || "").split("/").pop().replace(/^-/, "");
  const test = (patterns, value) => patterns.some(pattern => new RegExp(pattern).test(value));
  const executable = String(process.executable || process.command || "");
  const name = basename(executable);
  const absolute = executable.includes("/");
  const interpreter = /^(node|nodejs|bun|deno|python[0-9.]*|Python)$/.test(name);
  const args = Array.isArray(process.args) ? process.args : null;
  const argsAllowed = rule => {
    if (!args) return true;
    const rest = interpreter ? args.slice(2) : args.slice(1);
    if (rule.excludeSubcommands.includes(rest[0] ?? "")) return false;
    if (rest.some(argument => rule.excludeFlags.includes(argument))) return false;
    const required = Object.prototype.hasOwnProperty.call(rule.requireArgs, name) ? rule.requireArgs[name] : null;
    return required === null || new RegExp(required).test(rest[0] ?? "");
  };
  for (const rule of rules) {
    let matched = false;
    if (interpreter) {
      const entry = String(process.entrypoint || "");
      matched = (entry !== "" && (test(rule.entries, entry) || rule.names.includes(basename(entry)))) || (/^(node|nodejs|bun|deno)$/.test(name) && rule.titles.includes(process.title));
    } else {
      if (test(rule.excludePaths, executable)) continue;
      if (absolute && rule.requirePaths.length && !test(rule.requirePaths, executable)) continue;
      matched = rule.names.includes(name) || (absolute && test(rule.paths, executable));
    }
    if (matched && argsAllowed(rule)) return rule.id;
  }
  return "";
}
