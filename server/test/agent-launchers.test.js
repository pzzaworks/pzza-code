import test from "node:test";
import assert from "node:assert/strict";
import { matchLauncher, parseShellDefinitions, shellWords, definitionSections, withLaunchers } from "../lib/agent-launchers.js";

const HOME = "/Users/me";
const ID = "0b1c2d3e-4f50-4a61-8b72-9c8d7e6f5a41";

// As zsh prints them (`alias -L`, `functions`), and as bash does (`declare -f`).
const ZSH = {
  aliases: [
    "alias run-help=man",
    "alias cy='claude --dangerously-skip-permissions'",
    "alias bad='claude; rm -rf ~'",
    "alias q='CLAUDE_CONFIG_DIR=$HOME/.claude-q claude --permission-mode plan'",
    "alias it='claude --append-system-prompt '\\''hi there'\\'''",
  ].join("\n"),
  functions: [
    "ca () {",
    "\tCLAUDE_CONFIG_DIR=\"$HOME/.claude-alt\" claude --dangerously-skip-permissions --chrome \"$@\"",
    "}",
    "cb () {",
    "\tclaude --dangerously-skip-permissions --chrome \"$@\"",
    "}",
    "branchy () {",
    "\tif [ -n \"$X\" ]; then claude \"$@\"; fi",
    "}",
    "nofwd () {",
    "\tclaude --chrome",
    "}",
    "dyn () {",
    "\tclaude --model \"$MODEL\" \"$@\"",
    "}",
  ].join("\n"),
};
const BASH = {
  aliases: "alias ll='ls -l'\n",
  functions: "bb () \n{ \n    export CLAUDE_CONFIG_DIR=~/.claude-b;\n    command claude --permission-mode plan \"$@\"\n}\n",
};

test("shell words expand only the home folder and the forwarded arguments", () => {
  const FORWARD = shellWords("\"$@\"", HOME)[0];
  assert.equal(typeof FORWARD, "symbol");
  assert.deepEqual(shellWords("A=\"$HOME/x\" claude -a 'b c' ~/d \"$@\"", HOME), ["A=/Users/me/x", "claude", "-a", "b c", "/Users/me/d", FORWARD]);
  assert.deepEqual(shellWords("X=~/.claude-b claude ${HOME}", HOME), ["X=/Users/me/.claude-b", "claude", "/Users/me"]);
  for (const line of ["claude $MODEL", "claude; rm -rf ~", "claude | tee", "claude `id`", "claude $(id)", "claude 'open", "claude \"a$@\"", "a && b"]) {
    assert.equal(shellWords(line, HOME), null, line);
  }
});

test("only simple aliases and functions that pass the arguments on are launchers", () => {
  const byName = Object.fromEntries([...parseShellDefinitions(ZSH, HOME), ...parseShellDefinitions(BASH, HOME)].map((item) => [item.name, item]));
  assert.deepEqual(byName.ca, { name: "ca", kind: "function", env: ["CLAUDE_CONFIG_DIR=/Users/me/.claude-alt"], program: "claude", args: ["--dangerously-skip-permissions", "--chrome"] });
  assert.deepEqual(byName.cb.args, ["--dangerously-skip-permissions", "--chrome"]);
  assert.deepEqual(byName.cy, { name: "cy", kind: "alias", env: [], program: "claude", args: ["--dangerously-skip-permissions"] });
  assert.deepEqual(byName.q.env, ["CLAUDE_CONFIG_DIR=/Users/me/.claude-q"]);
  assert.deepEqual(byName.it.args, ["--append-system-prompt", "hi there"]);
  assert.deepEqual(byName.bb, { name: "bb", kind: "function", env: ["CLAUDE_CONFIG_DIR=/Users/me/.claude-b"], program: "claude", args: ["--permission-mode", "plan"] });
  for (const skipped of ["bad", "branchy", "nofwd", "dyn"]) assert.equal(byName[skipped], undefined, skipped);
});

test("the launcher an agent was started through is found from its arguments and account", () => {
  const launchers = [...parseShellDefinitions(ZSH, HOME), ...parseShellDefinitions(BASH, HOME)];
  const match = (argv, account) => matchLauncher(launchers, { agent: "claude", argv, account }, HOME)?.name ?? null;
  // Started exactly through it, with or without typed arguments after it.
  assert.equal(match(["claude", "--dangerously-skip-permissions", "--chrome"], ""), "cb");
  assert.equal(match(["claude", "--dangerously-skip-permissions", "--chrome", "--resume", ID], ""), "cb");
  assert.equal(match(["claude", "--dangerously-skip-permissions", "--chrome"], "/Users/me/.claude-alt"), "ca");
  assert.equal(match(["/Users/me/.local/bin/claude", "--permission-mode", "plan"], "/Users/me/.claude-b"), "bb");
  // The exact fit wins over a launcher that adds flags.
  assert.equal(match(["claude", "--dangerously-skip-permissions"], ""), "cy");
  // Resumed earlier from the catalog line: the launcher naming the same account, or the same mode.
  assert.equal(match(["claude", "--resume", ID, "--dangerously-skip-permissions"], "/Users/me/.claude-alt"), "ca");
  assert.equal(match(["claude", "-c", "--dangerously-skip-permissions"], ""), "cb");
  // Nothing that would start it another way.
  assert.equal(match(["claude"], ""), null, "no launcher passes nothing");
  assert.equal(match(["claude", "--dangerously-skip-permissions", "--chrome"], "/Users/me/.claude-work"), null, "another account");
  assert.equal(match(["claude", "--permission-mode", "acceptEdits"], ""), null, "another mode");
  assert.equal(match(["claude", "--resume", ID, "--dangerously-skip-permissions", "--model", "opus"], ""), null, "an argument no launcher passes");
  // An account not read only fits a launcher that picks none.
  assert.equal(match(["claude", "--dangerously-skip-permissions", "--chrome"], undefined), "cb");
  assert.equal(matchLauncher(launchers, { agent: "codex", argv: ["codex"], account: "" }, HOME), null);
  assert.equal(matchLauncher([{ name: "claude", env: [], program: "claude", args: ["--chrome"] }], { agent: "claude", argv: ["claude", "--chrome"], account: "" }, HOME), null, "the program's own name");
});

test("a shell's output is read between its markers only", () => {
  const mark = "\u0001pzza-launchers";
  assert.deepEqual(definitionSections(`motd\n${mark}-aliases\nalias a=b\n${mark}-functions\nf () {\n}\n${mark}-end\n`), { aliases: "alias a=b\n", functions: "f () {\n}\n" });
  assert.equal(definitionSections(`${mark}-aliases\nalias a=b\n`), null);
});

test("rows of agents started through a launcher carry it", async () => {
  const rows = [
    { session: "a", window: 0, command: "claude", launch: { mode: "bypass", account: null } },
    { session: "b", window: 1, command: "zsh" },
  ];
  const agents = new Map([["a\t0", { agent: "claude", process: { exactArgs: ["claude", "--dangerously-skip-permissions", "--chrome"], selectorsAvailable: true, accountDirectory: "" } }]]);
  const read = async () => parseShellDefinitions(ZSH, HOME);
  const out = await withLaunchers(rows, agents, read);
  assert.deepEqual(out[0].launch, { mode: "bypass", account: null, launcher: { name: "cb", env: [], program: "claude", args: ["--dangerously-skip-permissions", "--chrome"] } });
  assert.deepEqual(out[1], rows[1]);
  let reads = 0;
  assert.equal(await withLaunchers(rows, new Map(), async () => { reads++; return []; }), rows);
  assert.equal(reads, 0, "the shell is not read without agents");
});
