import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { ACTIVITY_PROBE_SCRIPT, detectSessionActivity, processAgentCommand } from "../lib/session-activity.js";
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
