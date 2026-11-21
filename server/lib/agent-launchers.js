// The user's own launchers for coding agents: shell aliases and functions
// such as `ca () { CLAUDE_CONFIG_DIR="$HOME/.claude-alt" claude
// --dangerously-skip-permissions --chrome "$@" }`. When an agent in a local
// terminal was started through one, a refresh resumes it through the same
// launcher (`ca --resume <id>`), so it comes back exactly as the user starts
// it, flags the catalog does not know included.
//
// Nothing here is a list of known launchers: the definitions are read from
// the user's login shell, and the one an agent was started through is found
// by comparing what each definition sets and passes with the agent process's
// exact arguments and account folder. Only simple definitions qualify: one
// command that runs the agent's program with literal arguments and passes
// the typed arguments on ("$@"; an alias always does). Anything dynamic
// (other variables, command substitution, pipes, conditions) is skipped.
//
// The launcher's name is the only part typed; the native restore compares
// the rest with the catalog line it would type (agent_catalog.rs
// launcher_line), so every other word still comes from the catalog.
import { execFile } from "node:child_process";
import { stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { RESUME_SESSION, matchAgentMode, sessionAgent, agentModeRules } from "./session-agents.js";

const NAME = /^[A-Za-z_][A-Za-z0-9_.+-]{0,63}$/;
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const PART_MAX = 512;
const PARTS_MAX = 64;
// Words in front of the program that do not change what it runs.
const PREFIXES = new Set(["command", "exec", "noglob", "nocorrect", "builtin"]);
const CONTROL = new Set(["if", "then", "elif", "else", "fi", "for", "while", "until", "do", "done", "case", "esac", "select", "function", "return", "[[", "[", "test"]);
const FORWARD = Symbol("forward");
const MODE_RULES = agentModeRules();

/**
 * Splits one line of shell into words the way the shell would, for the
 * simple lines a launcher is made of. `$HOME`, `${HOME}` and a leading `~`
 * are expanded to `home`; `"$@"` (and `$@`, `$*`, `"$*"`) becomes the FORWARD
 * marker. Null when the line holds anything else the shell would expand or
 * act on (another variable, a command substitution, an operator, a quote
 * left open), since its words could not be known.
 */
export function shellWords(line, home) {
  const words = [];
  let word = null;
  let index = 0;
  const text = String(line);
  const push = () => { if (word !== null) words.push(word); word = null; };
  const add = (value) => { word = (word ?? "") + value; };
  // A `$` reference at `at`: the home folder, the forwarded arguments, or null.
  const reference = (at, quoted) => {
    const rest = text.slice(at);
    const home$ = rest.match(/^\$(?:HOME\b|\{HOME\})/);
    if (home$) return { value: home, length: home$[0].length };
    const forward = rest.match(/^\$[@*]/);
    if (forward) {
      // Only a whole word ("$@" or $@) forwards the arguments.
      const before = quoted ? text[at - 1] === "\"" && word === null : word === null;
      const after = quoted ? text[at + 2] === "\"" : at + 2 >= text.length || /\s/.test(text[at + 2]);
      return before && after ? { forward: true, length: 2 } : null;
    }
    return null;
  };
  while (index < text.length) {
    const char = text[index];
    if (/\s/.test(char)) { push(); index++; continue; }
    if (char === "#" && word === null) break;
    if (";&|<>()`".includes(char)) return null;
    if (char === "\\") {
      if (index + 1 >= text.length) return null;
      add(text[index + 1]);
      index += 2;
      continue;
    }
    if (char === "'") {
      const end = text.indexOf("'", index + 1);
      if (end < 0) return null;
      add(text.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (char === "\"") {
      let at = index + 1;
      let forwarded = false;
      while (at < text.length && text[at] !== "\"") {
        const inner = text[at];
        if (inner === "\\" && at + 1 < text.length && "\"\\$`".includes(text[at + 1])) { add(text[at + 1]); at += 2; continue; }
        if (inner === "`") return null;
        if (inner === "$") {
          const found = reference(at, true);
          if (!found) return null;
          if (found.forward) { forwarded = true; at += found.length; continue; }
          add(found.value);
          at += found.length;
          continue;
        }
        add(inner);
        at++;
      }
      if (at >= text.length) return null;
      index = at + 1;
      if (forwarded) {
        if (word !== null) return null;
        words.push(FORWARD);
        continue;
      }
      // An empty quoted word is still a word.
      if (word === null) word = "";
      continue;
    }
    if (char === "$") {
      const found = reference(index, false);
      if (!found) return null;
      if (found.forward) { words.push(FORWARD); index += found.length; continue; }
      add(found.value);
      index += found.length;
      continue;
    }
    // A leading `~`, also right after an assignment's `=` (as the shell expands it).
    if (char === "~" && (word === null || /^[A-Za-z_][A-Za-z0-9_]*=$/.test(word)) && (index + 1 >= text.length || text[index + 1] === "/" || /\s/.test(text[index + 1]))) {
      add(home);
      index++;
      continue;
    }
    add(char);
    index++;
  }
  push();
  return words;
}

const plainPart = (value) => typeof value === "string" && value.length <= PART_MAX && !/[\u0000-\u001f\u007f]/.test(value);

/**
 * The command a list of words runs: its assignments (`NAME=value`, also after
 * `env`), the program and its literal arguments, and whether it ends by
 * passing on the typed arguments. Null for anything else.
 */
export function launcherCommand(words) {
  if (!Array.isArray(words) || !words.length) return null;
  const env = [];
  let at = 0;
  const assignment = (word) => typeof word === "string" && ENV_NAME.test(word.split("=", 1)[0]) && word.includes("=");
  while (at < words.length && (assignment(words[at]) || PREFIXES.has(words[at]) || (words[at] === "env" && assignment(words[at + 1])))) {
    if (assignment(words[at])) env.push(words[at]);
    at++;
  }
  const program = words[at];
  if (typeof program !== "string" || !program || program.includes("=") || CONTROL.has(program)) return null;
  const rest = words.slice(at + 1);
  const forwards = rest.at(-1) === FORWARD;
  const args = forwards ? rest.slice(0, -1) : rest;
  if (args.some((arg) => typeof arg !== "string")) return null;
  if (![...env, program, ...args].every(plainPart) || env.length > PARTS_MAX || args.length > PARTS_MAX) return null;
  return { env, program, args, forwards };
}

// The value of a single-quoted alias definition (`'a'\''b'`), or a bare one.
function aliasValue(text) {
  if (!text.startsWith("'")) return /^[^\s'"\\$`]*$/.test(text) ? text : null;
  let value = "";
  let at = 0;
  while (at < text.length) {
    if (text[at] === "'") {
      const end = text.indexOf("'", at + 1);
      if (end < 0) return null;
      value += text.slice(at + 1, end);
      at = end + 1;
    } else if (text.startsWith("\\'", at)) {
      value += "'";
      at += 2;
    } else return null;
  }
  return value;
}

/**
 * The launchers in a shell's printed definitions: `aliases` as `alias -L`
 * (zsh) or `alias -p` (bash) prints them, `functions` as `functions` (zsh) or
 * `declare -f` (bash) does. Each is { name, kind, env, program, args }.
 */
export function parseShellDefinitions({ aliases = "", functions = "" }, home) {
  const launchers = [];
  for (const line of String(aliases).split("\n")) {
    const match = line.match(/^alias (?:-- )?([^=\s]+)=(.*)$/);
    if (!match || !NAME.test(match[1])) continue;
    const value = aliasValue(match[2]);
    const command = value === null ? null : launcherCommand(shellWords(value, home));
    // An alias is text put in front of what is typed after it.
    if (command && !command.forwards) launchers.push({ name: match[1], kind: "alias", env: command.env, program: command.program, args: command.args });
  }
  const lines = String(functions).split("\n");
  for (let index = 0; index < lines.length; index++) {
    const header = lines[index].match(/^([^\s()=]+) \(\) ?(\{)?\s*$/);
    if (!header) continue;
    const name = header[1];
    let at = index + 1;
    if (!header[2]) {
      if (!/^\{\s*$/.test(lines[at] ?? "")) continue;
      at++;
    }
    const body = [];
    while (at < lines.length && !/^\}\s*;?\s*$/.test(lines[at])) body.push(lines[at++]);
    index = at;
    if (!NAME.test(name) || at >= lines.length) continue;
    const env = [];
    const invocations = [];
    let simple = true;
    for (const raw of body) {
      const text = raw.trim().replace(/;$/, "").trim();
      if (!text) continue;
      const exported = text.match(/^export\s+(.+)$/);
      const words = shellWords(exported ? exported[1] : text, home);
      if (!words || !words.length) { simple = false; break; }
      if (exported) {
        if (!words.every((word) => typeof word === "string" && ENV_NAME.test(word.split("=", 1)[0]) && word.includes("="))) { simple = false; break; }
        env.push(...words);
        continue;
      }
      if (CONTROL.has(words[0])) { simple = false; break; }
      const command = launcherCommand(words);
      if (command?.forwards) invocations.push(command);
    }
    // Exactly one command receives the typed arguments.
    if (!simple || invocations.length !== 1) continue;
    const [command] = invocations;
    launchers.push({ name, kind: "function", env: [...env, ...command.env], program: command.program, args: command.args });
  }
  return launchers;
}

const basename = (value) => String(value || "").split("/").pop().replace(/^-/, "");
const trimSlash = (value) => (value.length > 1 ? value.replace(/\/+$/, "") : value);
const envValue = (env, key) => {
  const found = [...env].reverse().find((entry) => entry.split("=", 1)[0] === key);
  return found === undefined ? undefined : found.slice(key.length + 1);
};

// Removes the first run of `run` from `words` (RESUME_SESSION matching any one word).
function withoutRun(words, run) {
  if (!run.length) return words;
  for (let start = 0; start + run.length <= words.length; start++) {
    if (run.every((item, offset) => item === RESUME_SESSION || words[start + offset] === item)) {
      return [...words.slice(0, start), ...words.slice(start + run.length)];
    }
  }
  return words;
}

/**
 * The launcher an agent process was started through, or null. `process` is
 * { agent (catalog id), argv (exact, with argv[0]), account (its account
 * folder variable as set, "" for none, undefined when not read) }.
 *
 * A launcher fits when it runs the agent's program, picks the same account
 * folder and no other mode. It started the process exactly when its
 * arguments come first in the process's arguments. Otherwise it still fits
 * when everything else the process was given is a resume or mode flag or one
 * it passes too, and it names that same account or mode itself: a process an
 * earlier refresh resumed from the catalog then comes back through the
 * launcher it was first started with. Exact fits win, then the one passing
 * the most arguments; a tie goes to the shorter, then the first name.
 */
export function matchLauncher(launchers, process, home = os.homedir()) {
  const agent = sessionAgent(process?.agent);
  if (!agent || !Array.isArray(process.argv) || !process.argv.length) return null;
  const programs = new Set([agent.command, ...(agent.binaries ?? [])]);
  const interpreter = /^(node|nodejs|bun|deno|python[0-9.]*|Python)$/.test(basename(process.argv[0]));
  const given = process.argv.slice(interpreter ? 2 : 1).map(String);
  const modes = MODE_RULES[agent.id] ?? [];
  const processMode = matchAgentMode(given, modes);
  const accountEnv = agent.account?.env;
  const defaultFolder = accountEnv ? path.join(home, agent.account.folder) : "";
  const sameFolder = (a, b) => trimSlash(a || defaultFolder) === trimSlash(b || defaultFolder);
  const accounts = [process.account, process.resolvedAccount].filter((value) => typeof value === "string");
  const resumeRuns = [agent.resume?.byId?.args ?? [], agent.resume?.args ?? []];
  const ranked = [];
  for (const launcher of launchers) {
    if (!NAME.test(launcher.name) || programs.has(launcher.name) || !programs.has(basename(launcher.program))) continue;
    const chosen = accountEnv ? envValue(launcher.env, accountEnv) : undefined;
    // The account folder must be the process's; unknown is only fine when the launcher picks none.
    if (accountEnv && (accounts.length ? !accounts.some((account) => sameFolder(chosen, account)) : chosen !== undefined)) continue;
    const launcherMode = matchAgentMode(launcher.args, modes);
    if (launcherMode !== null && launcherMode !== processMode) continue;
    const exact = launcher.args.every((arg, index) => given[index] === arg);
    if (!exact) {
      let rest = given;
      for (const run of resumeRuns) rest = withoutRun(rest, run);
      const mode = modes.find((rule) => rule.id === processMode);
      if (mode) rest = withoutRun(rest, mode.args);
      rest = rest.filter((arg) => !launcher.args.includes(arg));
      const names = (chosen !== undefined && !sameFolder(chosen, "")) || (launcherMode !== null && launcherMode === processMode);
      if (rest.length || !names) continue;
    }
    ranked.push({ launcher, exact });
  }
  ranked.sort((a, b) => Number(b.exact) - Number(a.exact) || b.launcher.args.length - a.launcher.args.length
    || b.launcher.env.length - a.launcher.env.length || a.launcher.name.length - b.launcher.name.length || a.launcher.name.localeCompare(b.launcher.name));
  const best = ranked[0]?.launcher;
  return best ? { name: best.name, env: [...best.env], program: best.program, args: [...best.args] } : null;
}

// How the definitions are printed, per shell. Markers split the output from
// anything the shell's startup files print themselves.
const MARK = "\u0001pzza-launchers";
const SCRIPTS = {
  zsh: `print -r -- '${MARK}-aliases'; alias -L; print -r -- '${MARK}-functions'; functions; print -r -- '${MARK}-end'`,
  bash: `printf '%s\\n' '${MARK}-aliases'; alias -p; printf '%s\\n' '${MARK}-functions'; declare -f; printf '%s\\n' '${MARK}-end'`,
};

/** The definitions sections of a shell's printed output, or null when it did not finish. */
export function definitionSections(output) {
  const text = String(output);
  const start = text.indexOf(`${MARK}-aliases\n`);
  const middle = text.indexOf(`${MARK}-functions\n`, start);
  const end = text.indexOf(`${MARK}-end`, middle);
  if (start < 0 || middle < 0 || end < 0) return null;
  return { aliases: text.slice(start + MARK.length + 9, middle), functions: text.slice(middle + MARK.length + 11, end) };
}

// Startup files whose change means the definitions may have changed.
const STARTUP_FILES = {
  zsh: [".zshenv", ".zprofile", ".zshrc", ".zlogin"],
  bash: [".bashrc", ".bash_profile", ".bash_login", ".profile", ".bash_aliases"],
};
// Definitions sourced from other files are read again at least this often.
const FRESH_MS = 60_000;
const READ_TIMEOUT_MS = 8_000;
let cached = null;
let reading = null;

async function startupStamp(kind, home) {
  const folder = kind === "zsh" && process.env.ZDOTDIR ? process.env.ZDOTDIR : home;
  const times = await Promise.all(STARTUP_FILES[kind].map((name) => stat(path.join(folder, name)).then((info) => info.mtimeMs, () => 0)));
  return times.join(",");
}

function readDefinitions(shell, kind) {
  return new Promise((resolve) => {
    // An interactive shell, as the user's terminals start it, so the
    // definitions its startup files make are all there. Its input is closed
    // and nothing it prints is kept but the definitions.
    const child = execFile(shell, ["-i", "-c", SCRIPTS[kind]], { timeout: READ_TIMEOUT_MS, maxBuffer: 16 * 1024 * 1024, cwd: os.homedir() }, (error, stdout) => {
      resolve(definitionSections(stdout || ""));
    });
    child.stdin?.end();
  });
}

/**
 * The launchers the user's login shell defines, read from the shell itself
 * and kept until its startup files change (and at most a minute). Empty for
 * shells whose definitions cannot be read this way.
 */
export async function shellLaunchers({ shell = process.env.SHELL, home = os.homedir() } = {}) {
  const kind = typeof shell === "string" && shell.startsWith("/") ? basename(shell) : "";
  if (kind !== "zsh" && kind !== "bash") return [];
  const stamp = await startupStamp(kind, home);
  if (cached && cached.shell === shell && cached.stamp === stamp && Date.now() - cached.at < FRESH_MS) return cached.launchers;
  if (!reading) {
    reading = readDefinitions(shell, kind).then((sections) => {
      const launchers = sections ? parseShellDefinitions(sections, home) : cached?.launchers ?? [];
      cached = { shell, stamp, at: Date.now(), launchers };
      return launchers;
    }).finally(() => { reading = null; });
  }
  return reading;
}

/**
 * Adds the launcher each detected local agent was started through to its
 * row's launch. `agents` maps "session\twindow" to the agent process
 * (detectSessionActivity's `found`).
 */
export async function withLaunchers(rows, agents, read = shellLaunchers) {
  if (!agents?.size || !rows.some((row) => agents.has(`${row.session}\t${row.window}`))) return rows;
  const launchers = await read().catch(() => []);
  if (!launchers.length) return rows;
  return rows.map((row) => {
    const found = agents.get(`${row.session}\t${row.window}`);
    if (!found || !Array.isArray(found.process.exactArgs)) return row;
    const account = found.process.selectorsAvailable ? found.process.accountDirectory || "" : undefined;
    const launcher = matchLauncher(launchers, { agent: found.agent, argv: found.process.exactArgs, account, resolvedAccount: found.process.account });
    return launcher ? { ...row, launch: { ...(row.launch ?? { mode: null, account: null }), launcher } } : row;
  });
}
