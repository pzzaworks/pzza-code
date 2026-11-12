import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import test from "node:test";
import { promisify } from "node:util";
import {
  SESSION_AGENTS, SESSION_AGENT_IDS, agentCanAutoResume, agentCanContinue, agentForProgram, agentTakesPrompt,
  defaultSessionAgentMode, sessionAgent, sessionAgentCommand, sessionAgentMode, sessionAgentResumeAllowlist,
  agentBinaryAllowed, agentBinaryPathRules, sessionAgentResumeCommand, sessionPromptError, validSessionPrompt,
} from "../lib/session-agents.js";
import { NATIVE_CATALOG_PATH, nativeAgentCatalog } from "../../scripts/agent-catalog.mjs";

const execFileAsync = promisify(execFile);

// [agent, mode, new session, continuing, with the prompt "fix it"]; null where
// the agent cannot continue or take a prompt.
const COMMANDS = [
  ["claude","default","claude --permission-mode manual","claude -c --permission-mode manual","claude --permission-mode manual 'fix it'"],
  ["claude","acceptEdits","claude --permission-mode acceptEdits","claude -c --permission-mode acceptEdits","claude --permission-mode acceptEdits 'fix it'"],
  ["claude","plan","claude --permission-mode plan","claude -c --permission-mode plan","claude --permission-mode plan 'fix it'"],
  ["claude","auto","claude --permission-mode auto","claude -c --permission-mode auto","claude --permission-mode auto 'fix it'"],
  ["claude","dontAsk","claude --permission-mode dontAsk","claude -c --permission-mode dontAsk","claude --permission-mode dontAsk 'fix it'"],
  ["claude","bypass","claude --dangerously-skip-permissions","claude -c --dangerously-skip-permissions","claude --dangerously-skip-permissions 'fix it'"],
  ["codex","readOnly","codex --sandbox read-only --ask-for-approval on-request","codex resume --last --sandbox read-only --ask-for-approval on-request","codex --sandbox read-only --ask-for-approval on-request 'fix it'"],
  ["codex","default","codex --sandbox workspace-write --ask-for-approval on-request","codex resume --last --sandbox workspace-write --ask-for-approval on-request","codex --sandbox workspace-write --ask-for-approval on-request 'fix it'"],
  ["codex","auto","codex --approve-for-me","codex resume --last --approve-for-me","codex --approve-for-me 'fix it'"],
  ["codex","bypass","codex --dangerously-bypass-approvals-and-sandbox","codex resume --last --dangerously-bypass-approvals-and-sandbox","codex --dangerously-bypass-approvals-and-sandbox 'fix it'"],
  ["opencode","default","env 'OPENCODE_CONFIG_CONTENT={\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"},\"agent\":{\"build\":{\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"}}}}' opencode --agent build","env 'OPENCODE_CONFIG_CONTENT={\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"},\"agent\":{\"build\":{\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"}}}}' opencode -c --agent build","env 'OPENCODE_CONFIG_CONTENT={\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"},\"agent\":{\"build\":{\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"}}}}' opencode --agent build --prompt 'fix it'"],
  ["opencode","plan","opencode --agent plan","opencode -c --agent plan","opencode --agent plan --prompt 'fix it'"],
  ["opencode","auto","opencode --auto","opencode -c --auto","opencode --auto --prompt 'fix it'"],
  ["gemini","default","gemini --approval-mode default","gemini --resume latest --approval-mode default","gemini --approval-mode default -i 'fix it'"],
  ["gemini","autoEdit","gemini --approval-mode auto_edit","gemini --resume latest --approval-mode auto_edit","gemini --approval-mode auto_edit -i 'fix it'"],
  ["gemini","plan","gemini --approval-mode plan","gemini --resume latest --approval-mode plan","gemini --approval-mode plan -i 'fix it'"],
  ["gemini","yolo","gemini --approval-mode yolo","gemini --resume latest --approval-mode yolo","gemini --approval-mode yolo -i 'fix it'"],
  ["cursor","ask","cursor-agent --mode ask","cursor-agent --continue --mode ask","cursor-agent --mode ask 'fix it'"],
  ["cursor","default","cursor-agent","cursor-agent --continue","cursor-agent 'fix it'"],
  ["cursor","plan","cursor-agent --plan","cursor-agent --continue --plan","cursor-agent --plan 'fix it'"],
  ["cursor","force","cursor-agent --force","cursor-agent --continue --force","cursor-agent --force 'fix it'"],
  ["copilot","default","copilot","copilot --continue","copilot -i 'fix it'"],
  ["copilot","plan","copilot --plan","copilot --continue --plan","copilot --plan -i 'fix it'"],
  ["copilot","autopilot","copilot --autopilot","copilot --continue --autopilot","copilot --autopilot -i 'fix it'"],
  ["copilot","allowTools","copilot --allow-all-tools","copilot --continue --allow-all-tools","copilot --allow-all-tools -i 'fix it'"],
  ["copilot","yolo","copilot --yolo","copilot --continue --yolo","copilot --yolo -i 'fix it'"],
  ["pi","readOnly","pi --tools read,grep,find,ls","pi --continue --tools read,grep,find,ls","pi --tools read,grep,find,ls -- 'fix it'"],
  ["pi","default","pi","pi --continue","pi -- 'fix it'"],
  ["cline","ask","cline --auto-approve false",null,"cline --auto-approve false -i 'fix it'"],
  ["cline","plan","cline --auto-approve false -p",null,"cline --auto-approve false -p -i 'fix it'"],
  ["cline","yolo","cline -y",null,"cline -y -i 'fix it'"],
  ["goose","approve","env GOOSE_MODE=approve goose session","env GOOSE_MODE=approve goose session --resume","env GOOSE_MODE=approve goose run -s -t 'fix it'"],
  ["goose","smartApprove","env GOOSE_MODE=smart_approve goose session","env GOOSE_MODE=smart_approve goose session --resume","env GOOSE_MODE=smart_approve goose run -s -t 'fix it'"],
  ["goose","chat","env GOOSE_MODE=chat goose session","env GOOSE_MODE=chat goose session --resume","env GOOSE_MODE=chat goose run -s -t 'fix it'"],
  ["goose","auto","env GOOSE_MODE=auto goose session","env GOOSE_MODE=auto goose session --resume","env GOOSE_MODE=auto goose run -s -t 'fix it'"],
  ["antigravity","default","agy","agy -c","agy -i 'fix it'"],
  ["antigravity","acceptEdits","agy --mode accept-edits","agy -c --mode accept-edits","agy --mode accept-edits -i 'fix it'"],
  ["antigravity","plan","agy --mode plan","agy -c --mode plan","agy --mode plan -i 'fix it'"],
  ["antigravity","bypass","agy --dangerously-skip-permissions","agy -c --dangerously-skip-permissions","agy --dangerously-skip-permissions -i 'fix it'"],
  ["qwen","default","qwen --approval-mode default","qwen --continue --approval-mode default","qwen --approval-mode default -i 'fix it'"],
  ["qwen","plan","qwen --approval-mode plan","qwen --continue --approval-mode plan","qwen --approval-mode plan -i 'fix it'"],
  ["qwen","autoEdit","qwen --approval-mode auto-edit","qwen --continue --approval-mode auto-edit","qwen --approval-mode auto-edit -i 'fix it'"],
  ["qwen","auto","qwen --approval-mode auto","qwen --continue --approval-mode auto","qwen --approval-mode auto -i 'fix it'"],
  ["qwen","yolo","qwen --approval-mode yolo","qwen --continue --approval-mode yolo","qwen --approval-mode yolo -i 'fix it'"],
  ["crush","default","crush","crush --continue",null],
  ["crush","yolo","crush -y","crush --continue -y",null],
  ["kilo","default","env 'KILO_CONFIG_CONTENT={\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"},\"agent\":{\"code\":{\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"}}}}' kilo","env 'KILO_CONFIG_CONTENT={\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"},\"agent\":{\"code\":{\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"}}}}' kilo --continue","env 'KILO_CONFIG_CONTENT={\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"},\"agent\":{\"code\":{\"permission\":{\"edit\":\"ask\",\"bash\":\"ask\",\"webfetch\":\"ask\"}}}}' kilo --prompt 'fix it'"],
  ["kilo","auto","kilo --auto","kilo --continue --auto","kilo --auto --prompt 'fix it'"],
  ["grok","default","grok","grok -c","grok 'fix it'"],
  ["grok","alwaysApprove","grok --always-approve","grok -c --always-approve","grok --always-approve 'fix it'"],
  ["amp","default","amp",null,null],
  ["droid","default","droid","droid --resume --last","droid 'fix it'"],
  ["droid","autoLow","droid --auto low","droid --resume --last --auto low","droid --auto low 'fix it'"],
  ["droid","autoMedium","droid --auto medium","droid --resume --last --auto medium","droid --auto medium 'fix it'"],
  ["droid","autoHigh","droid --auto high","droid --resume --last --auto high","droid --auto high 'fix it'"],
  ["kiro","default","kiro-cli chat","kiro-cli chat --resume",null],
  ["kiro","trustAll","kiro-cli chat --trust-all-tools","kiro-cli chat --resume --trust-all-tools",null],
  ["codebuddy","default","codebuddy --permission-mode default","codebuddy -c --permission-mode default","codebuddy --permission-mode default 'fix it'"],
  ["codebuddy","acceptEdits","codebuddy --permission-mode acceptEdits","codebuddy -c --permission-mode acceptEdits","codebuddy --permission-mode acceptEdits 'fix it'"],
  ["codebuddy","plan","codebuddy --permission-mode plan","codebuddy -c --permission-mode plan","codebuddy --permission-mode plan 'fix it'"],
  ["codebuddy","bypass","codebuddy -y","codebuddy -c -y","codebuddy -y 'fix it'"],
  ["kimi","default","kimi","kimi --continue",null],
  ["kimi","plan","kimi --plan","kimi --continue --plan",null],
  ["kimi","yolo","kimi --yolo","kimi --continue --yolo",null],
  ["kimi","auto","kimi --auto","kimi --continue --auto",null],
  ["devin","normal","devin --permission-mode normal","devin --continue --permission-mode normal","devin --permission-mode normal -- 'fix it'"],
  ["devin","acceptEdits","devin --permission-mode accept-edits","devin --continue --permission-mode accept-edits","devin --permission-mode accept-edits -- 'fix it'"],
  ["devin","smart","devin --permission-mode smart","devin --continue --permission-mode smart","devin --permission-mode smart -- 'fix it'"],
  ["devin","dangerous","devin --permission-mode dangerous","devin --continue --permission-mode dangerous","devin --permission-mode dangerous -- 'fix it'"],
  ["vibe","ask","vibe --agent ask","vibe --continue --agent ask","vibe --agent ask 'fix it'"],
  ["vibe","default","vibe","vibe --continue","vibe 'fix it'"],
  ["vibe","smartApprove","vibe --agent smart-approve","vibe --continue --agent smart-approve","vibe --agent smart-approve 'fix it'"],
  ["vibe","autoApprove","vibe --auto-approve","vibe --continue --auto-approve","vibe --auto-approve 'fix it'"],
  ["aider","ask","aider --chat-mode ask","aider --restore-chat-history --chat-mode ask",null],
  ["aider","default","aider","aider --restore-chat-history",null],
  ["aider","architect","aider --architect --no-auto-accept-architect","aider --restore-chat-history --architect --no-auto-accept-architect",null],
  ["aider","yes","aider --yes-always","aider --restore-chat-history --yes-always",null],
  ["warp","default","warp",null,null],
  ["warp","autoApprove","warp --auto-approve",null,null],
  ["auggie","default","auggie","auggie --continue","auggie 'fix it'"],
  ["letta","standard","letta --new --permission-mode standard","letta --permission-mode standard",null],
  ["letta","acceptEdits","letta --new --permission-mode acceptEdits","letta --permission-mode acceptEdits",null],
  ["letta","yolo","letta --new --yolo","letta --yolo",null],
  ["qoder","default","qodercli --permission-mode default","qodercli -c --permission-mode default","qodercli --permission-mode default -i 'fix it'"],
  ["qoder","plan","qodercli --permission-mode plan","qodercli -c --permission-mode plan","qodercli --permission-mode plan -i 'fix it'"],
  ["qoder","acceptEdits","qodercli --permission-mode accept_edits","qodercli -c --permission-mode accept_edits","qodercli --permission-mode accept_edits -i 'fix it'"],
  ["qoder","bypass","qodercli --yolo","qodercli -c --yolo","qodercli --yolo -i 'fix it'"],
  ["forgecode","muse","forge --agent muse",null,null],
  ["forgecode","sage","forge --agent sage",null,null],
  ["forgecode","forge","forge --agent forge",null,null],
  ["rovodev","default","acli rovodev run","acli rovodev run --restore",null],
  ["rovodev","yolo","acli rovodev run --yolo","acli rovodev run --restore --yolo",null],
  ["junie","default","junie","junie --resume","junie --prompt 'fix it'"],
  ["junie","brave","junie --brave","junie --resume --brave","junie --brave --prompt 'fix it'"],
];

test("every catalog agent and mode builds the expected launch, continue and prompt commands", () => {
  const covered = SESSION_AGENTS.flatMap(agent => agent.modes.map(mode => `${agent.id}/${mode.id}`));
  assert.deepEqual(COMMANDS.map(([agent, mode]) => `${agent}/${mode}`), covered);
  for (const [id, mode, launch, resume, prompt] of COMMANDS) {
    const agent = sessionAgent(id);
    assert.equal(sessionAgentCommand({ id, mode }), launch, `${id}/${mode}`);
    if (resume === null) assert.throws(() => sessionAgentCommand({ id, mode, resume: true }), `${id} cannot continue`);
    else assert.equal(sessionAgentCommand({ id, mode, resume: true }), resume, `${id}/${mode} continue`);
    if (prompt === null) assert.throws(() => sessionAgentCommand({ id, mode, prompt: "fix it" }), `${id} takes no prompt`);
    else assert.equal(sessionAgentCommand({ id, mode, prompt: "fix it" }), prompt, `${id}/${mode} prompt`);
    assert.equal(agentCanContinue(agent), resume !== null);
    assert.equal(agentTakesPrompt(agent), prompt !== null);
  }
});

test("the safe default mode of every agent asks, or cannot change anything", () => {
  const safe = mode => ["ask", "restricted"].includes(mode.approval);
  for (const agent of SESSION_AGENTS) {
    const mode = defaultSessionAgentMode(agent);
    assert.equal(mode.id, agent.defaultMode, `${agent.id} names a real default mode`);
    // Amp has no mode that asks, so its only mode is tagged for what it does.
    if (!agent.modes.some(safe)) {
      assert.equal(agent.id, "amp", `${agent.id} has no safe mode`);
      assert.equal(mode.approval, "bypass");
      continue;
    }
    assert.ok(safe(mode), `${agent.id} default is ${mode.approval}`);
    const words = [...mode.args, ...Object.values(mode.env ?? {})].join(" ");
    assert.doesNotMatch(words, /dangerous|bypass|skip-permissions|yolo|--force|--auto(?![-\w])|always-approve|trust-all|--brave|-y\b|"allow"/i, agent.id);
  }
  // CLIs whose own default does not ask get it spelled out on the command line.
  assert.equal(sessionAgentCommand({ id: "claude", mode: "default" }), "claude --permission-mode manual");
  assert.equal(sessionAgentCommand({ id: "codex", mode: sessionAgent("codex").defaultMode }), "codex --sandbox read-only --ask-for-approval on-request");
  assert.equal(sessionAgentCommand({ id: "cline", mode: "ask" }), "cline --auto-approve false");
  assert.equal(sessionAgentCommand({ id: "goose", mode: "approve" }), "env GOOSE_MODE=approve goose session");
  assert.equal(sessionAgentCommand({ id: "codebuddy", mode: "default" }), "codebuddy --permission-mode default");
  assert.equal(sessionAgentCommand({ id: "qoder", mode: "default" }), "qodercli --permission-mode default");
  assert.equal(sessionAgentCommand({ id: "devin", mode: "normal" }), "devin --permission-mode normal");
  // A per-agent permission in the user's config would outrank a global "ask",
  // so the inline config sets the default agent's rules too.
  const inline = (id, key) => JSON.parse(sessionAgent(id).modes.find(mode => mode.id === sessionAgent(id).defaultMode).env[key]);
  const ask = { edit: "ask", bash: "ask", webfetch: "ask" };
  assert.deepEqual(inline("opencode", "OPENCODE_CONFIG_CONTENT"), { permission: ask, agent: { build: { permission: ask } } });
  assert.match(sessionAgentCommand({ id: "opencode", mode: "default" }), / opencode --agent build$/);
  assert.deepEqual(inline("kilo", "KILO_CONFIG_CONTENT"), { permission: ask, agent: { code: { permission: ask } } });
  // Agents whose own default edits without asking start in a mode that cannot.
  assert.equal(sessionAgentCommand({ id: "cursor", mode: sessionAgent("cursor").defaultMode }), "cursor-agent --mode ask");
  assert.equal(sessionAgentCommand({ id: "aider", mode: sessionAgent("aider").defaultMode }), "aider --chat-mode ask");
  for (const [id, mode] of [["cursor", "default"], ["aider", "default"], ["codex", "default"], ["claude", "dontAsk"]]) {
    assert.equal(sessionAgentMode(sessionAgent(id), mode).approval, "auto", `${id}/${mode}`);
  }
  assert.equal(sessionAgentMode(sessionAgent("aider"), "architect").approval, "ask");
  assert.match(sessionAgentCommand({ id: "aider", mode: "architect" }), /--no-auto-accept-architect$/);
  // Agents without approval prompts start where they cannot change files.
  assert.equal(sessionAgent("pi").defaultMode, "readOnly");
  assert.equal(sessionAgent("forgecode").defaultMode, "muse");
});

test("the catalog is plain fixed data that types safely into a shell", () => {
  assert.equal(new Set(SESSION_AGENT_IDS).size, SESSION_AGENTS.length);
  assert.equal(SESSION_AGENTS.length, 29);
  assert.deepEqual(SESSION_AGENTS.filter(agent => agent.tier === 2).map(agent => agent.id), ["vibe", "aider", "warp", "auggie", "letta", "qoder", "forgecode", "rovodev", "junie"]);
  const word = /^[A-Za-z0-9_@%+=:,./-]+$/;
  for (const agent of SESSION_AGENTS) {
    assert.match(agent.id, /^[a-z][a-z0-9-]*$/);
    assert.match(agent.command, /^[a-z][a-z0-9-]*$/);
    assert.ok(agent.binaries.includes(agent.command), `${agent.id} looks for the binary it types`);
    assert.match(agent.homepage, /^https:\/\//);
    assert.ok(agent.install.length > 0, `${agent.id} has an install hint`);
    assert.ok(agent.vendor && agent.label);
    assert.equal(new Set(agent.modes.map(mode => mode.id)).size, agent.modes.length);
    for (const token of [...agent.baseArgs, ...agent.freshArgs, ...agent.resume.args, ...agent.modes.flatMap(mode => mode.args), ...(agent.prompt.baseArgs ?? [])]) {
      assert.match(token, word, `${agent.id}: ${token}`);
    }
    for (const mode of agent.modes) for (const [key, value] of Object.entries(mode.env ?? {})) {
      assert.match(key, /^[A-Z][A-Z0-9_]*$/);
      assert.doesNotMatch(value, /['\n\r]/);
    }
    if (agent.prompt.style === "flag") assert.match(agent.prompt.flag, /^-/);
    for (const name of [...agent.detect.names, ...agent.detect.programs]) assert.match(name, /^[A-Za-z0-9._-]+$/);
    for (const pattern of [...(agent.detect.paths ?? []), ...(agent.detect.entries ?? []), ...Object.values(agent.detect.requireArgs ?? {})]) assert.doesNotThrow(() => new RegExp(pattern));
    for (const path of agent.storage.paths) assert.ok(path.length > 0);
  }
  // `agent` is both Cursor's and Grok Build's binary: neither types or detects it by that name.
  assert.ok(SESSION_AGENTS.every(agent => agent.command !== "agent" && !agent.detect.names.includes("agent")));
});

test("starting prompts are one line and can never become a flag", () => {
  assert.ok(validSessionPrompt("fix the login bug"));
  for (const prompt of ["", "   ", "two\nlines", "tab\tinside", "x".repeat(4001), 42, "--dangerously-skip-permissions", " -p x", "line separator"]) {
    assert.ok(!validSessionPrompt(prompt), JSON.stringify(prompt));
    assert.throws(() => sessionAgentCommand({ id: "claude", mode: "default", prompt }));
  }
  assert.equal(sessionAgentCommand({ id: "codex", mode: "default", prompt: "it's $(whoami) `id`" }), "codex --sandbox workspace-write --ask-for-approval on-request 'it'\\''s $(whoami) `id`'");
  // fish reads \' inside single quotes as an escaped quote, which would end the
  // quoting early and run the rest, so no backslash ever reaches the shell.
  for (const prompt of ["x\\' ; touch /tmp/pwned ; echo \\'", "C:\\Users\\me", "trailing\\", "\\"]) {
    assert.ok(!validSessionPrompt(prompt), prompt);
    assert.equal(sessionPromptError(prompt), "The starting prompt can't contain backslashes.");
    assert.throws(() => sessionAgentCommand({ id: "claude", mode: "default", prompt }), /can't contain backslashes/);
  }
  assert.equal(sessionPromptError("fix the login bug"), null);
  assert.match(sessionPromptError("--yolo"), /cannot start with "-"/);
  assert.throws(() => sessionAgentCommand({ id: "goose", mode: "approve", resume: true, prompt: "x" }), /cannot continue a conversation with a starting prompt/);
  for (const value of [null, "claude", { id: "claude" }, { id: "claude", mode: "yolo" }, { id: "bash", mode: "default" }, { id: "codex", mode: "default", args: "--x" }, { id: "claude", mode: "default", resume: "yes" }]) {
    assert.throws(() => sessionAgentCommand(value));
  }
});

// csh and tcsh expand history on "!" even inside single quotes, and do so for
// `-c` too, so a login shell of that family would rewrite or reject the prompt.
const LOGIN_SHELLS = [["/bin/sh"], ["/bin/dash"], ["/bin/bash"], ["/bin/zsh", "-f"], ["/bin/tcsh", "-f"], ["/bin/csh", "-f"]].filter(([file]) => existsSync(file));
const CSH_SHELLS = LOGIN_SHELLS.filter(([file]) => /csh$/.test(file));

test("starting prompts with ! reach the agent unchanged in every login shell", { skip: CSH_SHELLS.length === 0 && "no csh-family shell installed" }, async () => {
  const prompts = ["fix it!", "it's !ls and !! and !$ then !-1", "a!b", "!important"];
  assert.equal(sessionAgentCommand({ id: "claude", mode: "default", prompt: "fix it!" }), "claude --permission-mode manual 'fix it'\\!''");
  // The plain single-quoted form is what history expansion breaks.
  await assert.rejects(execFileAsync(CSH_SHELLS[0][0], [...CSH_SHELLS[0].slice(1), "-c", "printf '%s\\n' 'a!b'"]), /Event not found/);
  for (const prompt of prompts) {
    const command = sessionAgentCommand({ id: "claude", mode: "default", prompt });
    const line = command.replace(/^claude /, "printf '%s\\n' ");
    for (const [file, ...flags] of LOGIN_SHELLS) {
      const { stdout } = await execFileAsync(file, [...flags, "-c", line], { timeout: 5000 });
      assert.deepEqual(stdout.split("\n").slice(0, -1), ["--permission-mode", "manual", prompt], `${file}: ${prompt}`);
    }
  }
});

test("restarted terminals resume only agents whose last conversation is per folder", () => {
  for (const agent of SESSION_AGENTS) {
    const command = sessionAgentResumeCommand(agent.id);
    if (!agentCanAutoResume(agent)) {
      assert.equal(command, null, agent.id);
      continue;
    }
    assert.equal(agent.resume.scope, "directory");
    assert.equal(command, sessionAgentCommand({ id: agent.id, mode: agent.defaultMode, resume: true }));
    for (const mode of agent.modes) assert.equal(sessionAgentResumeCommand(agent.id, { id: agent.id, mode: mode.id }), sessionAgentCommand({ id: agent.id, mode: mode.id, resume: true }));
    // Recorded as another agent, or with a mode the catalog no longer has: the default mode.
    assert.equal(sessionAgentResumeCommand(agent.id, { id: agent.id === "claude" ? "codex" : "claude", mode: "bypass" }), command);
    assert.equal(sessionAgentResumeCommand(agent.id, { id: agent.id, mode: "unknown" }), command);
  }
  for (const id of ["goose", "cline", "amp", "warp", "forgecode", "cursor", "letta", "copilot"]) assert.equal(sessionAgentResumeCommand(id), null, id);
  assert.equal(sessionAgentResumeCommand("gemini"), "gemini --resume latest --approval-mode default");
  assert.throws(() => sessionAgentResumeCommand("bash"));
});

test("saved choices with the original agent and mode ids still resolve", () => {
  const saved = { claude: ["default", "acceptEdits", "plan", "auto", "bypass"], codex: ["default", "readOnly", "auto", "bypass"], opencode: ["default", "plan", "auto"] };
  for (const [id, modes] of Object.entries(saved)) {
    const agent = sessionAgent(id);
    assert.ok(agent, id);
    for (const mode of modes) assert.equal(sessionAgentMode(agent, mode).id, mode, `${id}/${mode}`);
    assert.equal(sessionAgentMode(agent, "gone").id, agent.defaultMode);
  }
  assert.equal(sessionAgentResumeCommand("claude", { id: "claude", mode: "default" }), "claude -c --permission-mode manual");
  assert.equal(sessionAgentResumeCommand("codex", { id: "codex", mode: "readOnly" }), "codex resume --last --sandbox read-only --ask-for-approval on-request");
  assert.equal(sessionAgent("cursor-agent"), undefined);
});

test("the native restore allowlist matches the catalog and fits its length limit", () => {
  assert.equal(readFileSync(NATIVE_CATALOG_PATH, "utf8"), nativeAgentCatalog(), "run node scripts/agent-catalog.mjs");
  const allowlist = sessionAgentResumeAllowlist();
  assert.ok(allowlist.length > 0);
  for (const entry of allowlist) {
    assert.ok(entry.command.length <= 256, entry.command);
    assert.ok(entry.programs.length > 0, entry.command);
    assert.ok(agentCanAutoResume(sessionAgent(entry.agent)));
  }
  assert.ok(!allowlist.some(entry => entry.command === "claude -c"), "plain claude starts in auto mode");
});

test("tmux pane commands map to an agent only when unambiguous", () => {
  assert.equal(agentForProgram("claude"), "claude");
  assert.equal(agentForProgram("kiro-cli"), "kiro");
  assert.equal(agentForProgram("vibe-rs"), "vibe");
  assert.equal(agentForProgram("/opt/homebrew/bin/codex"), "codex");
  for (const name of ["agent", "goose", "forge", "amp", "python3", "zsh", "", undefined]) assert.equal(agentForProgram(name), undefined, String(name));
});

test("binary lookups tell agents from same-named tools with plain path fragments", () => {
  // Every detect path rule converts to a fragment that matches like its regex.
  const samples = ["/Users/me/.foundry/bin/forge", "/opt/homebrew/Cellar/goose/3.26.0/bin/goose", "/opt/homebrew/Cellar/ampcode/1/bin/amp",
    "/Users/me/.amp/bin/amp", "/Users/me/.amp/bin/amp-old", "/opt/homebrew/lib/node_modules/@ampcode/cli/bin/amp", "/Applications/Warp.app/Contents/MacOS/warp",
    "/Users/me/.grok/bin/grok", "/usr/local/lib/grok-native", "/opt/homebrew/bin/forge", "/WarpXapp/warp"];
  for (const agent of SESSION_AGENTS) {
    const rules = agentBinaryPathRules(agent);
    for (const [patterns, fragments] of [[agent.detect.excludePaths ?? [], rules.exclude], [agent.detect.requirePaths ?? [], rules.require]]) {
      assert.equal(fragments.length, patterns.length, agent.id);
      patterns.forEach((pattern, index) => {
        const fragment = fragments[index];
        for (const sample of samples) {
          const plain = fragment.end ? sample.endsWith(fragment.text) : sample.includes(fragment.text);
          assert.equal(plain, new RegExp(pattern).test(sample), `${agent.id}: ${pattern} on ${sample}`);
        }
      });
    }
  }
  const forge = sessionAgent("forgecode");
  assert.ok(!agentBinaryAllowed(forge, ["/Users/me/.foundry/bin/forge", "/Users/me/.foundry/bin/forge"]));
  assert.ok(agentBinaryAllowed(forge, ["/opt/homebrew/bin/forge", "/opt/homebrew/lib/node_modules/forgecode/bin/forge"]));
  // The resolved path counts as well as the one on PATH.
  assert.ok(!agentBinaryAllowed(sessionAgent("goose"), ["/opt/homebrew/bin/goose", "/opt/homebrew/Cellar/goose/3.26.0/bin/goose"]));
  assert.ok(!agentBinaryAllowed(sessionAgent("amp"), ["/opt/homebrew/bin/amp", "/opt/homebrew/Cellar/amp/0.7.0/bin/amp"]));
  assert.ok(agentBinaryAllowed(sessionAgent("amp"), ["/opt/homebrew/bin/amp", "/opt/homebrew/Cellar/ampcode/1/bin/amp"]));
  assert.ok(agentBinaryAllowed(sessionAgent("claude"), ["/anywhere/claude"]));
  // The native catalog carries the same fragments.
  const native = JSON.parse(nativeAgentCatalog()).agents.find(agent => agent.id === "forgecode");
  assert.deepEqual(native.excludePaths, [{ text: "/.foundry/", end: false }]);
});
