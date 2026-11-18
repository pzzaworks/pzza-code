import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ACTIVITY_PROBE_SCRIPT, detectSessionActivity, processAgentCommand, processStartTimes, readClaudeSessionFile } from "../lib/session-activity.js";
import { SESSION_AGENTS, agentProcessRules, matchAgentProcess } from "../lib/session-agents.js";

const node = (entrypoint, ...rest) => ({ command: "node", executable: "/usr/bin/node", entrypoint, args: ["node", entrypoint, ...rest] });
const native = (command, ...rest) => ({ command, args: [command.split("/").pop(), ...rest] });

// [expected agent id ("" for none), process as a snapshot sees it]. macOS rows
// carry ps comm (argv[0], a path or a bare name) and ps args; Linux rows also
// carry the resolved executable.
const FIXTURES = [
  ["claude", native("claude", "--permission-mode", "manual")],
  ["claude", { command: "/Users/me/.local/share/claude/versions/2.1.322" }],
  ["claude", node("/opt/lib/node_modules/@anthropic-ai/claude-code/cli.js")],
  ["", native("claude", "-p", "summarize")],
  ["codex", native("/opt/homebrew/bin/codex", "resume", "--last")],
  ["codex", node("/opt/lib/node_modules/@openai/codex/bin/codex.js")],
  ["", native("codex", "exec", "fix")],
  ["opencode", native("/Users/me/.opencode/bin/opencode", "-c")],
  ["", native("opencode", "serve")],
  ["gemini", node("/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/gemini.js", "--approval-mode", "default")],
  ["", node("/opt/homebrew/lib/node_modules/@google/gemini-cli/bundle/gemini.js", "-p", "x")],
  ["cursor", node("/Users/me/.local/share/cursor-agent/versions/2026.11.05-86047df/index.js", "--plan")],
  ["cursor", native("cursor-agent")],
  ["", native("cursor-agent", "login")],
  ["copilot", native("copilot")],
  ["copilot", node("/opt/lib/node_modules/@github/copilot/npm-loader.js")],
  ["pi", node("/opt/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", "--tools", "read,grep,find,ls")],
  ["pi", { command: "pi" }],
  ["pi", { command: "pi", executable: "/usr/bin/node", title: "pi", args: ["pi", "", ""] }],
  ["", node("/opt/lib/node_modules/@earendil-works/pi-coding-agent/dist/bundle/cli.js", "--print", "x")],
  ["cline", native("/opt/lib/node_modules/cline/bin/.cline", "--auto-approve", "false")],
  ["cline", native("/opt/lib/node_modules/@cline/cli-darwin-arm64/bin/cline")],
  ["", native("cline", "history")],
  ["goose", native("goose", "session")],
  ["goose", native("/Users/me/.local/bin/goose")],
  ["", native("goose", "up")],
  ["", native("goose", "postgres", "dbname=app", "status")],
  ["", native("/opt/homebrew/Cellar/goose/3.22.0/bin/goose")],
  ["antigravity", native("/Users/me/.local/bin/agy", "-c")],
  ["", native("agy", "mcp", "list")],
  ["qwen", node("/opt/lib/node_modules/@qwen-code/qwen-code/cli-entry.js", "--approval-mode", "default")],
  ["crush", native("crush")],
  ["crush", node("/opt/lib/node_modules/@charmland/crush/run-crush.js")],
  ["", native("crush", "run", "x")],
  ["kilo", native("/opt/lib/node_modules/@kilocode/cli/bin/.kilo")],
  ["kilo", native("/opt/lib/node_modules/@kilocode/cli-darwin-arm64/bin/kilo", "--continue")],
  ["kilo", node("/opt/lib/node_modules/@kilocode/cli/bin/kilo")],
  ["grok", native("grok", "-c")],
  ["grok", { command: "agent", executable: "/home/me/.grok/downloads/grok-linux-x64", args: ["agent"] }],
  ["grok", native("/Users/me/.grok/downloads/grok-darwin-arm64")],
  ["", native("/usr/local/bin/grok")],
  ["", native("grok", "-p", "x")],
  // The bare `agent` name belongs to both Cursor and Grok Build: never trusted.
  ["", native("agent")],
  ["", native("/Users/me/.local/bin/agent")],
  ["amp", native("/Users/me/.amp/bin/amp")],
  ["amp", native("amp", "threads", "continue")],
  ["amp", native("amp")],
  ["", native("amp", "notes.txt")],
  ["", native("/opt/homebrew/bin/amp")],
  ["", native("/Users/me/.amp/bin/amp", "-x", "do it")],
  ["droid", native("droid")],
  ["", native("droid", "exec", "x")],
  ["kiro", native("kiro-cli", "chat")],
  ["kiro", native("kiro-cli-chat")],
  ["", native("kiro-cli", "login")],
  ["codebuddy", native("codebuddy")],
  ["codebuddy", node("/opt/lib/node_modules/@tencent-ai/codebuddy-code/bin/codebuddy")],
  ["kimi", native("/Users/me/.kimi-code/bin/kimi", "--continue")],
  ["kimi", node("/opt/lib/node_modules/@moonshot-ai/kimi-code/dist/main.mjs")],
  ["", native("kimi", "acp")],
  ["devin", native("devin", "--", "fix")],
  ["", native("devin", "ls")],
  ["vibe", native("/Users/me/.local/share/uv/tools/mistral-vibe/lib/python3.12/site-packages/vibe/_bin/vibe-rs", "--agent", "ask")],
  ["vibe", native("vibe-rs")],
  ["aider", { command: "/Users/me/.local/share/uv/tools/aider-chat/bin/python3", entrypoint: "/Users/me/.local/share/uv/tools/aider-chat/bin/aider", args: ["python3", "/Users/me/.local/bin/aider"] }],
  ["aider", { command: "/opt/homebrew/Cellar/python@3.12/3.12.7/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python", entrypoint: "/opt/homebrew/bin/aider" }],
  ["", { command: "python3", entrypoint: "/srv/app/manage.py" }],
  ["warp", native("warp")],
  ["warp", native("/opt/homebrew/bin/warp-tui-stable")],
  ["", native("/Applications/Warp.app/Contents/MacOS/stable")],
  ["", native("/Applications/Warp.app/Contents/MacOS/warp")],
  ["", native("warp", "--version")],
  ["auggie", node("/opt/lib/node_modules/@augmentcode/auggie/augment.mjs")],
  ["", node("/opt/lib/node_modules/@augmentcode/auggie/auggie-v2.mjs", "--acp")],
  ["letta", node("/opt/lib/node_modules/@letta-ai/letta-code/letta.js", "--new")],
  ["qoder", native("qodercli")],
  ["qoder", node("/opt/lib/node_modules/@qoder-ai/qodercli/bundle/qodercli.js")],
  ["forgecode", native("forge", "--agent", "muse")],
  ["forgecode", native("forge")],
  ["", native("/Users/me/.foundry/bin/forge", "--agent", "muse")],
  ["", native("forge", "build")],
  ["rovodev", native("acli", "rovodev", "run")],
  ["rovodev", native("/Users/me/.local/share/acli/plugin/rovodev/atlassian_cli_rovodev")],
  ["", native("acli", "jira", "workitem", "view")],
  ["junie", native("junie", "--prompt", "x")],
  ["junie", node("/opt/lib/node_modules/@jetbrains/junie-cli/bin/index.js")],
  ["", native("zsh")],
  ["", node("/srv/app/server.js")],
];

test("every catalog agent has detection fixtures, and each fixture resolves to its agent", () => {
  const covered = new Set(FIXTURES.map(([id]) => id).filter(Boolean));
  assert.deepEqual(SESSION_AGENTS.map(agent => agent.id).filter(id => !covered.has(id)), []);
  const rules = agentProcessRules();
  for (const [expected, process] of FIXTURES) {
    assert.equal(matchAgentProcess(process, rules), expected, JSON.stringify(process));
    assert.equal(processAgentCommand(process), expected, JSON.stringify(process));
  }
});

test("rules that need arguments wait for them, so a first pass still picks candidates", () => {
  // Without arguments yet, ambiguous names stay candidates; with them, they decide.
  assert.equal(processAgentCommand({ command: "goose" }), "goose");
  assert.equal(processAgentCommand({ command: "goose", args: ["goose", "up"] }), "");
  assert.equal(processAgentCommand({ command: "forge" }), "forgecode");
  assert.equal(processAgentCommand({ command: "forge", args: ["forge", "test"] }), "");
  // Paths still decide without arguments.
  assert.equal(processAgentCommand({ command: "/Users/me/.foundry/bin/forge" }), "");
  assert.equal(processAgentCommand({ command: "/opt/homebrew/bin/amp" }), "");
  // Only a JavaScript runtime is identified by its retitled name.
  assert.equal(processAgentCommand({ command: "python3", executable: "/usr/bin/python3", title: "claude" }), "");
});

const pane = (overrides = {}) => ({ session: "work", window: 0, active: true, paneActive: true, pid: 10, tty: "/dev/ttys001", command: "zsh", ...overrides });
const row = (overrides = {}) => ({ pid: 10, ppid: 1, pgid: 10, tpgid: 20, tty: "ttys001", command: "zsh", ...overrides });

test("detected sessions report the catalog id of the deepest foreground agent", () => {
  // Kilo's node wrapper starts the native binary: either way it is Kilo.
  const processes = [row(),
    row({ pid: 20, ppid: 10, pgid: 20, ...node("/opt/lib/node_modules/@kilocode/cli/bin/kilo") }),
    row({ pid: 21, ppid: 20, pgid: 20, ...native("/opt/lib/node_modules/@kilocode/cli/bin/.kilo") })];
  assert.equal(detectSessionActivity([pane()], processes)[0].command, "kilo");
  // A Cursor session with an OpenAI model is still Cursor.
  const cursor = [row(), row({ pid: 20, ppid: 10, pgid: 20, ...node("/Users/me/.local/share/cursor-agent/versions/1/index.js", "--model", "gpt-5"), argv: ["node", "/x/index.js", "--model", "gpt-5"] })];
  assert.equal(detectSessionActivity([pane()], cursor)[0].command, "cursor");
  // Same-named tools in the foreground are not agents.
  assert.equal(detectSessionActivity([pane()], [row(), row({ pid: 20, ppid: 10, pgid: 20, ...native("/Users/me/.foundry/bin/forge", "build") })])[0].command, "zsh");
  assert.equal(detectSessionActivity([pane()], [row(), row({ pid: 20, ppid: 10, pgid: 20, ...native("goose", "up") })])[0].command, "zsh");
});

test("detected agents report how they were started: catalog mode and account folder only", () => {
  // `pz` as a shell function: CLAUDE_CONFIG_DIR="$HOME/.claude-pz" claude --dangerously-skip-permissions
  const exact = ["claude", "--dangerously-skip-permissions"];
  const claude = (overrides) => [row(), row({ pid: 20, ppid: 10, pgid: 20, ...native(...exact), exactArgs: exact, ...overrides })];
  const launch = (overrides) => detectSessionActivity([pane()], claude(overrides))[0].launch;
  assert.deepEqual(launch({ accountDirectory: "/Users/me/.claude-pz", account: "/Users/me/.claude-pz" }), { mode: "bypass", account: "/Users/me/.claude-pz" });
  // A folder that cannot be passed back is reported, so nothing restarts the agent on the default account.
  assert.deepEqual(launch({ accountDirectory: "/Users/me/my folder/.claude-x", account: "" }), { mode: "bypass", account: null, accountUnusable: true });
  // The default folder named explicitly is the default account.
  assert.deepEqual(launch({ accountDirectory: "/Users/me/.claude", account: "/Users/me/.claude" }), { mode: "bypass", account: null });
  assert.deepEqual(launch({ exactArgs: ["claude", "--permission-mode", "plan", "--model", "opus"] }), { mode: "plan", account: null });
  // Only exact arguments name a mode: a prompt quoting a flag, ps output split on spaces, or anything after "--" do not.
  assert.equal(launch({ exactArgs: ["claude", "why is --dangerously-skip-permissions risky"] }), undefined);
  assert.equal(launch({ exactArgs: ["claude", "--", "--dangerously-skip-permissions"] }), undefined);
  assert.equal(launch({ exactArgs: undefined, args: ["claude", "why", "is", "--dangerously-skip-permissions", "risky"] }), undefined);
  assert.equal(launch({ exactArgs: ["claude"] }), undefined, "nothing known, nothing reported");
  assert.equal("launch" in detectSessionActivity([pane()], [row()])[0], false, "a shell has no launch");
  // A remote device's row brings its launch; only catalog values survive.
  const remote = (value) => detectSessionActivity([pane({ command: "claude", launch: value })], [])[0].launch;
  assert.deepEqual(remote({ mode: "bypass", account: "/home/me/.claude-work" }), { mode: "bypass", account: "/home/me/.claude-work" });
  assert.deepEqual(remote({ mode: null, account: null, accountUnusable: true }), { mode: null, account: null, accountUnusable: true });
  assert.equal(remote({ mode: "rm -rf", account: "/home/me/.claude-work; id" }), undefined);
  assert.equal(remote("bad"), undefined);
});

const CONVERSATION = "0f1e2d3c-4b5a-4968-8776-655443322110";
const PROCESS_START = "Wed Nov 18 05:54:42 2026";
const sessionFile = (overrides = {}) => ({ pid: 20, sessionId: CONVERSATION, cwd: "/Users/me/app", procStart: PROCESS_START, kind: "interactive", status: "busy", updatedAt: 1794981283270, tmux: "work:@0.%0", ...overrides });

test("a Claude Code session file is read only when it is a small regular file naming this interactive process", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "pzza-claude-sessions-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await mkdir(path.join(directory, "sessions"));
  const write = (pid, content) => writeFile(path.join(directory, "sessions", `${pid}.json`), typeof content === "string" ? content : JSON.stringify(content));
  const read = (pid) => readClaudeSessionFile(fs, path, directory, pid);

  await write(20, sessionFile());
  assert.deepEqual(await read(20), { conversation: CONVERSATION, status: "busy", procStart: PROCESS_START });
  // ps pads a one-digit day; the start time is compared in a single-spaced form.
  await write(21, sessionFile({ pid: 21, status: "idle", procStart: "Thu Nov  5 05:54:42 2026" }));
  assert.deepEqual(await read(21), { conversation: CONVERSATION, status: "idle", procStart: "Thu Nov 5 05:54:42 2026" });
  // An unknown state keeps the conversation and reports no status.
  await write(22, sessionFile({ pid: 22, status: "shell" }));
  assert.deepEqual(await read(22), { conversation: CONVERSATION, procStart: PROCESS_START });

  const rejected = {
    30: sessionFile(), // another process's file
    31: sessionFile({ pid: 31, kind: "background" }),
    32: sessionFile({ pid: 32, kind: undefined }),
    33: sessionFile({ pid: 33, sessionId: CONVERSATION.toUpperCase() }),
    34: sessionFile({ pid: 34, sessionId: "not-a-session" }),
    35: sessionFile({ pid: 35, sessionId: `${CONVERSATION}/../x` }),
    36: sessionFile({ pid: 36, procStart: undefined }),
    37: sessionFile({ pid: 37, procStart: "1794981282000" }),
    38: sessionFile({ pid: "38" }),
    39: "{\"pid\": 39, \"sessionId\":",
    40: "[]",
    41: JSON.stringify({ ...sessionFile({ pid: 41 }), padding: "x".repeat(16 * 1024) }),
  };
  for (const [pid, content] of Object.entries(rejected)) await write(pid, content);
  for (const pid of Object.keys(rejected)) assert.equal(await read(Number(pid)), null, `file ${pid}`);
  assert.equal(await read(50), null, "a missing file");

  // A symlink to a valid file, a FIFO and a folder are never read.
  await write("target", sessionFile({ pid: 51 }));
  await symlink(path.join(directory, "sessions", "target.json"), path.join(directory, "sessions", "51.json"));
  assert.equal(await read(51), null, "a symlink");
  await promisify(execFile)("mkfifo", [path.join(directory, "sessions", "52.json")]);
  assert.equal(await read(52), null, "a FIFO");
  await mkdir(path.join(directory, "sessions", "53.json"));
  assert.equal(await read(53), null, "a folder");

  assert.equal(await readClaudeSessionFile(fs, path, "relative/folder", 20), null);
  assert.equal(await readClaudeSessionFile(fs, path, "", 20), null);
  assert.equal(await readClaudeSessionFile(fs, path, directory, 0), null);
});

test("a pane reports its Claude Code conversation only from a session file this process wrote", () => {
  const claude = (overrides) => [row(), row({ pid: 20, ppid: 10, pgid: 20, ...native("claude"), exactArgs: ["claude"], started: PROCESS_START, claudeSession: { conversation: CONVERSATION, status: "busy", procStart: PROCESS_START }, ...overrides })];
  const launch = (overrides) => detectSessionActivity([pane()], claude(overrides))[0].launch;
  assert.deepEqual(launch(), { mode: null, account: null, conversation: CONVERSATION, status: "busy" });
  assert.deepEqual(launch({ exactArgs: ["claude", "--dangerously-skip-permissions"], accountDirectory: "/Users/me/.claude-pz", account: "/Users/me/.claude-pz" }),
    { mode: "bypass", account: "/Users/me/.claude-pz", conversation: CONVERSATION, status: "busy" });
  assert.deepEqual(launch({ claudeSession: { conversation: CONVERSATION, procStart: PROCESS_START } }), { mode: null, account: null, conversation: CONVERSATION });
  // A file left by a crashed process whose pid was reused by this one.
  assert.equal(launch({ started: "Wed Nov 18 05:54:43 2026" }), undefined, "pid reuse");
  assert.equal(launch({ started: undefined }), undefined, "no start time to compare");
  assert.equal(launch({ claudeSession: { conversation: "bad", status: "busy", procStart: PROCESS_START } }), undefined);
  assert.deepEqual(launch({ claudeSession: { conversation: CONVERSATION, status: "rm -rf", procStart: PROCESS_START } }), { mode: null, account: null, conversation: CONVERSATION });
  // Only Claude Code writes these files.
  assert.equal(detectSessionActivity([pane()], claude({ ...native("codex") }))[0].launch, undefined);

  // A remote device verified its own file; only a UUID and a known state pass through.
  const remote = (command, value) => detectSessionActivity([pane({ command, launch: value })], [])[0].launch;
  assert.deepEqual(remote("claude", { mode: null, account: null, conversation: CONVERSATION, status: "idle" }), { mode: null, account: null, conversation: CONVERSATION, status: "idle" });
  assert.deepEqual(remote("claude", { mode: "bypass", account: null, conversation: CONVERSATION, status: "asleep" }), { mode: "bypass", account: null, conversation: CONVERSATION });
  assert.equal(remote("claude", { mode: null, account: null, conversation: "../../etc/passwd", status: "busy" }), undefined);
  assert.equal(remote("codex", { mode: null, account: null, conversation: CONVERSATION, status: "busy" }), undefined);
});

test("start times for a snapshot without them are ps lstart in the C locale and UTC", async () => {
  let call;
  const execute = async (command, args, environment) => {
    call = { command, args, locale: environment.LC_ALL, zone: environment.TZ };
    return `   20 Thu Nov  5 05:54:42 2026\n   21 garbage\n  999 Wed Nov 18 05:54:42 2026\n`;
  };
  assert.deepEqual([...await processStartTimes(execute, [20, 21, 20, -1])], [[20, "Thu Nov 5 05:54:42 2026"]]);
  assert.deepEqual(call, { command: "ps", args: ["-o", "pid=,lstart=", "-p", "20,21"], locale: "C", zone: "UTC" });
  assert.deepEqual([...await processStartTimes(async () => "", [20])], []);
  assert.deepEqual([...await processStartTimes(execute, [])], []);
});

test("without a process snapshot, unambiguous pane commands name the agent and ambiguous ones do not", () => {
  const label = (command) => detectSessionActivity([pane({ command })], [])[0].command;
  assert.equal(label("kiro-cli"), "kiro");
  assert.equal(label("cursor-agent"), "cursor");
  assert.equal(label("vibe-rs"), "vibe");
  assert.equal(label("/Users/me/.opencode/bin/opencode"), "opencode");
  for (const ambiguous of ["goose", "amp", "forge", "agent", "acli"]) assert.equal(label(ambiguous), "", ambiguous);
  // A shell process behind an agent label: the label is stale.
  assert.equal(detectSessionActivity([pane({ command: "kiro-cli" })], [row()])[0].command, "");
});

test("the remote activity probe script is self-contained and runs", async (t) => {
  assert.doesNotThrow(() => new Function(ACTIVITY_PROBE_SCRIPT));
  assert.ok(ACTIVITY_PROBE_SCRIPT.includes("const AGENT_PROCESS_RULES = ["));
  // A stand-in tmux with no panes: the probe runs end to end and reports none.
  const root = await mkdtemp(path.join(os.tmpdir(), "pzza-probe-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(path.join(root, "tmux"), "#!/bin/sh\nexit 0\n", { mode: 0o700 });
  const { stdout } = await promisify(execFile)(process.execPath, ["-e", ACTIVITY_PROBE_SCRIPT], { timeout: 10_000, env: { ...process.env, PATH: `${root}:${process.env.PATH}` } });
  assert.equal(stdout, "[]");
});

test("the doctor reports installed catalog agents without running agent names as code", async () => {
  const { installedAgents } = await import("../lib/system.js");
  let call;
  const result = await installedAgents((command, args, options, callback) => {
    call = { command, args };
    callback(null, "claude\t/Users/me/.local/bin/claude\ncodex\t\nforgecode\t/Users/me/.foundry/bin/forge\ncursor\t/Users/me/.local/bin/cursor-agent\n");
  });
  assert.equal(call.command, "sh");
  assert.equal(call.args[0], "-c");
  // Binary names and folders are positional arguments, never part of the script.
  assert.ok(!call.args[1].includes("claude") && !call.args[1].includes(".local/bin"));
  assert.deepEqual(call.args.slice(3, 6), ["claude", "claude", ".local/bin"]);
  assert.deepEqual(result.map(agent => agent.id), SESSION_AGENTS.map(agent => agent.id));
  const found = Object.fromEntries(result.filter(agent => agent.path).map(agent => [agent.id, agent.path]));
  // Foundry's forge is not ForgeCode.
  assert.deepEqual(found, { claude: "/Users/me/.local/bin/claude", cursor: "/Users/me/.local/bin/cursor-agent" });
  const failed = await installedAgents((command, args, options, callback) => callback(new Error("no shell"), ""));
  assert.ok(failed.every(agent => agent.path === null));
});
