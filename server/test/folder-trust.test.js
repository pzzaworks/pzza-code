import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

async function load(entry) {
  const built = await build({ entryPoints: [entry], bundle: true, write: false, format: "esm", platform: "node", logLevel: "silent" });
  return import(`data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString("base64")}`);
}
const { detectFolderTrustPrompt, folderTrustAnswer, FOLDER_TRUST_AGENTS } = await load("src/terminal/folderTrustPrompts.ts");
const { createFolderTrustResponder } = await load("src/state/folderTrust.ts");
const { detectPermissionPrompt } = await load("src/terminal/permissionPrompts.ts");

const DOWN = "\x1b[B";
const UP = "\x1b[A";
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const screen = (rows, height = 30) => ({ rows: [...rows, ...Array(Math.max(0, height - rows.length)).fill("")], cols: 100 });

// Claude Code 2.1.327's folder trust dialog as tmux drew it in a 100-column
// pane (the folder path swapped for a neutral one), decline highlighted as
// the dialog opens.
const CLAUDE_TRUST = [
  "",
  "─".repeat(100),
  " Accessing workspace:",
  "",
  " /Users/dev/projects/example-org/a-rather-long-repository-name-that-wraps/and-keeps-going-past-the-",
  " edge/project",
  "",
  " Quick safety check: Is this a project you created or one you trust? (Like your own code, a",
  " well-known open source project, or work from your team). If not, take a moment to review what's in",
  " this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files here.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
];
const FOLDER = "/Users/dev/projects/example-org/a-rather-long-repository-name-that-wraps/and-keeps-going-past-the-edge/project";
// The home folder variant in a 62-column pane.
const CLAUDE_HOME_TRUST = [
  "",
  "─".repeat(62),
  " Accessing workspace:",
  "",
  " /Users/dev",
  "",
  " Quick safety check: Is this a project you created or one you",
  " trust? (Like your own code, a well-known open source",
  " project, or work from your team). If not, take a moment to",
  " review what's in this folder first.",
  "",
  " Claude Code'll be able to read, edit, and execute files",
  " here. This is your home folder, so Yes lasts for this",
  " session only.",
  "",
  " Security guide",
  "",
  " ❯ No, exit",
  "   Yes, I trust this folder",
  "",
  " Enter to confirm · Esc to cancel",
];
const onTrust = (rows) => rows.map((row) => row === " ❯ No, exit" ? "   No, exit" : row === "   Yes, I trust this folder" ? " ❯ Yes, I trust this folder" : row);
const CLAUDE_UI = ["", " ▐▛███▛█   Claude Code", "", "─".repeat(100), "❯ ", "─".repeat(100), "  ? for shortcuts"];
// Claude Code's approval prompt for a command.
const CLAUDE_PERMISSION = [
  "─".repeat(100),
  " Bash command",
  "",
  "   npm test",
  "   Run the tests",
  "",
  " Do you want to proceed?",
  " ❯ 1. Yes",
  "   2. Yes, and don't ask again for npm test commands in /Users/dev/project",
  "   3. No, and tell Claude what to do differently (esc)",
  "",
  " Esc to cancel · Tab to amend",
];

test("the folder trust agents are the verified ones", () => {
  assert.deepEqual(FOLDER_TRUST_AGENTS, ["claude"]);
});

test("Claude Code's folder trust prompt is read with its folder, choices and highlight", () => {
  const prompt = detectFolderTrustPrompt(screen(CLAUDE_TRUST));
  assert.deepEqual(prompt, {
    agent: "claude", folder: FOLDER, options: ["No, exit", "Yes, I trust this folder"], selected: 0, trust: 1, signature: `claude\n${FOLDER}`,
  });
  const home = detectFolderTrustPrompt(screen(CLAUDE_HOME_TRUST));
  assert.equal(home?.folder, "/Users/dev");
  assert.equal(home?.selected, 0);
  // Highlighted trust choice, as older releases opened it.
  assert.equal(detectFolderTrustPrompt(screen(onTrust(CLAUDE_TRUST)))?.selected, 1);
  // The decline label used when the folder's settings pre-approve tools,
  // with the warnings those settings add above the choices.
  const permissive = CLAUDE_TRUST.flatMap((row) => row === " Security guide"
    ? [" ⚠ This folder pre-approves 2 tool permissions in .claude/settings.json:", "   Bash(npm test), Read", " These will apply without asking. Only proceed if you trust this configuration.", "", row]
    : row === " ❯ No, exit" ? [" ❯ No, continue without these permissions"] : [row]);
  assert.deepEqual(detectFolderTrustPrompt(screen(permissive))?.options, ["No, continue without these permissions", "Yes, I trust this folder"]);
});

test("ordinary output, partial dialogs and other prompts are not folder trust prompts", () => {
  const not = (rows, why) => assert.equal(detectFolderTrustPrompt(screen(rows)), null, why);
  not(CLAUDE_PERMISSION, "an approval prompt");
  not(CLAUDE_TRUST.slice(0, -2), "no key hint yet (half drawn)");
  not(CLAUDE_TRUST.filter((row) => row !== " Accessing workspace:"), "no heading");
  not(CLAUDE_TRUST.filter((row) => !row.startsWith("─")), "no divider above the heading");
  not(CLAUDE_TRUST.filter((row) => !row.includes("Claude Code'll")), "no warning");
  not(CLAUDE_TRUST.filter((row) => row !== "   Yes, I trust this folder"), "only the No choice");
  not(CLAUDE_TRUST.map((row) => row === " ❯ No, exit" ? "   No, exit" : row), "nothing highlighted");
  not(CLAUDE_TRUST.map((row) => row === "   Yes, I trust this folder" ? " ❯ Yes, I trust this folder" : row), "two highlights");
  not(CLAUDE_TRUST.map((row) => row === " Enter to confirm · Esc to cancel" ? " Press Esc again to exit" : row), "the user is leaving");
  // The same text printed by a shell (or in scrollback), with more below it.
  not([...CLAUDE_TRUST, "", "dev@host project % "], "output with a shell prompt after it");
  not([...CLAUDE_TRUST, "", ...CLAUDE_UI], "scrollback under the agent's own screen");
  not(CLAUDE_TRUST.map((row) => row.replace("Yes, I trust this folder", "Yes, I trust this folder and more")), "a different choice");
  // Claude Code's mid-session "move to a new directory" question is not a startup trust prompt.
  not(["─".repeat(100), " Moving to a new directory:", "", " /Users/dev/other", "", " This session hasn't worked here before. Is this a directory you created or one you trust?",
    " Claude Code'll be able to read, edit, and execute files here.", "", " ❯ No, exit", "   Yes, move here", "", " Enter to confirm · Esc to cancel"], "a directory move");
  // The approval detector never takes the trust dialog for an approval prompt.
  assert.equal(detectPermissionPrompt(screen(CLAUDE_TRUST)), null);
  assert.equal(detectPermissionPrompt(screen(onTrust(CLAUDE_TRUST))), null);
  assert.ok(detectPermissionPrompt(screen(CLAUDE_PERMISSION)), "the approval fixture is a real approval prompt");
});

test("the answer moves the highlight to the trust choice and confirms with Enter", () => {
  const prompt = detectFolderTrustPrompt(screen(CLAUDE_TRUST));
  const answer = folderTrustAnswer(prompt);
  assert.equal(answer.moves, DOWN);
  assert.equal(answer.confirm, "\r");
  assert.equal(answer.ready(screen(CLAUDE_TRUST)), false);
  assert.equal(answer.ready(screen(onTrust(CLAUDE_TRUST))), true);
  // Another folder's prompt is not this one.
  assert.equal(answer.ready(screen(onTrust(CLAUDE_HOME_TRUST))), false);
  assert.equal(folderTrustAnswer(detectFolderTrustPrompt(screen(onTrust(CLAUDE_TRUST)))).moves, "");
  const reversed = CLAUDE_TRUST.map((row) => row === " ❯ No, exit" ? " ❯ Yes, I trust this folder" : row === "   Yes, I trust this folder" ? "   No, exit" : row);
  assert.equal(folderTrustAnswer(detectFolderTrustPrompt(screen(reversed))).moves, "");
  const below = reversed.map((row) => row === " ❯ Yes, I trust this folder" ? "   Yes, I trust this folder" : row === "   No, exit" ? " ❯ No, exit" : row);
  assert.equal(folderTrustAnswer(detectFolderTrustPrompt(screen(below))).moves, UP);
});

// A terminal that behaves like Claude Code's dialog: the arrows move the
// highlight (unless `stuck`), Enter takes it and the agent's screen follows.
function terminal(rows, { agent = "claude", panes = 1, stuck = false } = {}) {
  const state = { rows, sent: [], foreground: { agent, panes } };
  return {
    state,
    target: {
      screen: () => screen(state.rows),
      freshScreen: async () => screen(state.rows),
      foreground: async () => state.foreground,
      async send(data) {
        state.sent.push(data);
        if (data === DOWN && !stuck) state.rows = onTrust(state.rows);
        else if (data === "\r" && state.rows.some((row) => row === " ❯ Yes, I trust this folder")) state.rows = CLAUDE_UI;
        else if (data === "\r") state.rows = [];
      },
    },
  };
}

test("an enabled responder trusts the folder once: arrow to Yes, then Enter", async () => {
  const { state, target } = terminal(CLAUDE_TRUST);
  const responder = createFolderTrustResponder(target, { enabled: () => true });
  try {
    responder.check();
    assert.deepEqual(state.sent, [], "nothing goes out on first sight");
    await sleep(700);
    assert.deepEqual(state.sent, [DOWN, "\r"]);
    assert.deepEqual(state.rows, CLAUDE_UI);
    responder.check();
    await sleep(400);
    assert.deepEqual(state.sent, [DOWN, "\r"], "no further keys into what comes next");
  } finally {
    responder.dispose();
  }
});

test("a prompt that stays after the answer gets no second answer; a new appearance does", async () => {
  const { state, target } = terminal(onTrust(CLAUDE_HOME_TRUST));
  // Enter is taken but the dialog is still drawn, as during a slow redraw.
  target.send = async (data) => { state.sent.push(data); };
  const responder = createFolderTrustResponder(target, { enabled: () => true });
  try {
    responder.check();
    await sleep(600);
    assert.deepEqual(state.sent, ["\r"], "already highlighted: Enter only");
    for (let index = 0; index < 4; index++) { responder.check(); await sleep(150); }
    assert.deepEqual(state.sent, ["\r"], "the same appearance is never answered twice");
    // A blank frame shorter than a redraw keeps it the same appearance.
    state.rows = [];
    responder.check();
    state.rows = onTrust(CLAUDE_HOME_TRUST);
    responder.check();
    await sleep(500);
    assert.deepEqual(state.sent, ["\r"]);
    // Gone for a while, then asked again (the agent started anew): answered again.
    state.rows = CLAUDE_UI;
    responder.check();
    await sleep(800);
    state.rows = onTrust(CLAUDE_HOME_TRUST);
    responder.check();
    await sleep(600);
    assert.deepEqual(state.sent, ["\r", "\r"]);
  } finally {
    responder.dispose();
  }
});

test("nothing is sent while the setting is off, and switching it on answers", async () => {
  let enabled = false;
  const { state, target } = terminal(CLAUDE_TRUST);
  const responder = createFolderTrustResponder(target, { enabled: () => enabled });
  try {
    responder.check();
    await sleep(500);
    responder.check();
    await sleep(100);
    assert.deepEqual(state.sent, []);
    enabled = true;
    responder.check();
    await sleep(700);
    assert.deepEqual(state.sent, [DOWN, "\r"]);
  } finally {
    responder.dispose();
  }
});

test("switching the setting off mid-answer stops before Enter", async () => {
  let enabled = true;
  const { state, target } = terminal(CLAUDE_TRUST, { stuck: true });
  const responder = createFolderTrustResponder(target, { enabled: () => enabled });
  try {
    responder.check();
    await sleep(450);
    assert.deepEqual(state.sent, [DOWN]);
    enabled = false;
    await sleep(1600);
    assert.ok(!state.sent.includes("\r"));
  } finally {
    responder.dispose();
  }
});

test("no keys reach a pane that does not run the agent alone, or a screen that changed", async () => {
  for (const foreground of [{ agent: undefined, panes: 1 }, { agent: "claude", panes: 2 }, { agent: "codex", panes: 1 }, null]) {
    const { state, target } = terminal(CLAUDE_TRUST);
    state.foreground = foreground;
    const responder = createFolderTrustResponder(target, { enabled: () => true });
    try {
      responder.check();
      await sleep(600);
      assert.deepEqual(state.sent, [], JSON.stringify(foreground));
    } finally {
      responder.dispose();
    }
  }
  // The prompt left the screen between the check and the send.
  const { state, target } = terminal(CLAUDE_TRUST);
  const fresh = target.freshScreen;
  target.freshScreen = async () => { state.rows = ["dev@host project % "]; return fresh(); };
  const responder = createFolderTrustResponder(target, { enabled: () => true });
  try {
    responder.check();
    await sleep(600);
    assert.deepEqual(state.sent, []);
  } finally {
    responder.dispose();
  }
});

test("Enter never goes out while the highlight is not on the trust choice", async () => {
  const { state, target } = terminal(CLAUDE_TRUST, { stuck: true });
  const responder = createFolderTrustResponder(target, { enabled: () => true });
  try {
    responder.check();
    await sleep(2200);
    assert.ok(state.sent.length >= 1 && state.sent.every((data) => data === DOWN), JSON.stringify(state.sent));
  } finally {
    responder.dispose();
  }
});
