import type { SessionAgentId } from "../../server/lib/session-agents.js";
import type { Screen } from "./permissionPrompts";

// Folder trust prompts: the question a coding agent asks when it starts in a
// folder it has not been told to trust ("Is this a project you created or one
// you trust?"). They are read from the visible screen like approval prompts,
// but kept apart from them: only these may ever be answered automatically,
// never a tool or command approval. Detection is strict: the dialog's
// heading, its question and warning, exactly its two choices and its key hint
// must all be on screen, with the hint as the last row, so the same words in
// ordinary output or scrollback never match. Only prompts verified against
// the agent's own CLI are listed.

export interface FolderTrustPrompt {
  agent: SessionAgentId;
  /** The folder the agent asks about, as shown. */
  folder: string;
  /** The choices as the agent shows them, top to bottom. */
  options: string[];
  /** Index of the highlighted choice. */
  selected: number;
  /** Index of the choice that trusts the folder. */
  trust: number;
  /** Identity of this prompt: the agent and the folder. */
  signature: string;
}

/** The keys that trust the folder of a prompt, and how to see they took. */
export interface FolderTrustAnswer {
  /** Arrow keys that highlight the trust choice; empty when it already is. */
  moves: string;
  /** Whether a screen shows this same prompt with its trust choice highlighted. */
  ready(screen: Screen): boolean;
  /** The key that confirms the highlighted choice. */
  confirm: string;
}

interface TrustSpec {
  agent: SessionAgentId;
  detect(screen: Screen): FolderTrustPrompt | null;
}

const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";
const ENTER = "\r";
const SOLID_DIVIDER = /^\s*─{8,}\s*$/u;
// How far above its choices the dialog's heading may be: its own text, the
// folder path and the warnings a folder's settings add.
const MAX_DIALOG_ROWS = 60;

function lastContentRow(rows: readonly string[]): number {
  let index = rows.length - 1;
  while (index >= 0 && !rows[index].trim()) index--;
  return index;
}

function compact(text: string): string {
  return text.replace(/\s+/gu, " ").trim();
}

// Claude Code (verified on 2.1.327): under a full-width divider,
//
//   Accessing workspace:
//
//   /path/to/folder
//
//   Quick safety check: Is this a project you created or one you trust? (…)
//
//   Claude Code'll be able to read, edit, and execute files here.[ This is
//   your home folder, so Yes lasts for this session only.]
//
//   Security guide
//
//   ❯ No, exit
//     Yes, I trust this folder
//
//   Enter to confirm · Esc to cancel
//
// The decline choice comes first and is highlighted when the dialog opens
// ("No, continue without these permissions" when the folder's settings
// pre-approve tools); the arrows move the highlight and Enter takes it.
// Settings warnings may sit between the text and the choices. Keys sent the
// moment the dialog opens are ignored, so the highlight is checked before
// Enter goes out.
const CLAUDE_HEADING = "Accessing workspace:";
const CLAUDE_QUESTION = "Quick safety check: Is this a project you created or one you trust?";
const CLAUDE_WARNING = "Claude Code'll be able to read, edit, and execute files here.";
const CLAUDE_TRUST = "Yes, I trust this folder";
const CLAUDE_DECLINE = new Set(["No, exit", "No, continue without these permissions"]);
const CLAUDE_FOOTER = "Enter to confirm · Esc to cancel";
const CLAUDE_OPTION = /^\s*(?:(❯)\s+)?(\S.*)$/u;

function readClaude(screen: Screen): FolderTrustPrompt | null {
  const rows = screen.rows.map(row => row.replace(/\s+$/u, ""));
  const footer = lastContentRow(rows);
  if (footer < 8 || rows[footer].trim() !== CLAUDE_FOOTER) return null;
  let end = footer - 1;
  while (end >= 0 && !rows[end].trim()) end--;
  // Exactly two choice rows right above the hint: one trusts, one declines.
  const choices: { label: string; marked: boolean }[] = [];
  let start = end;
  for (; start >= 0 && rows[start].trim(); start--) {
    const match = CLAUDE_OPTION.exec(rows[start]);
    if (!match || (match[2] !== CLAUDE_TRUST && !CLAUDE_DECLINE.has(match[2]))) break;
    choices.unshift({ label: match[2], marked: !!match[1] });
  }
  start++;
  if (choices.length !== 2 || (start > 0 && rows[start - 1].trim())) return null;
  const trust = choices.findIndex(choice => choice.label === CLAUDE_TRUST);
  const decline = choices.findIndex(choice => CLAUDE_DECLINE.has(choice.label));
  const selected = choices.findIndex(choice => choice.marked);
  if (trust < 0 || decline < 0 || selected < 0 || choices.filter(choice => choice.marked).length !== 1) return null;
  // The heading, right under the divider, a bounded way above the choices.
  let heading = -1;
  for (let index = start - 1; index >= Math.max(1, start - MAX_DIALOG_ROWS); index--) {
    if (rows[index].trim() === CLAUDE_HEADING) { heading = index; break; }
  }
  if (heading < 0 || !SOLID_DIVIDER.test(rows[heading - 1])) return null;
  // The folder: the rows from the heading to the question, which a narrow
  // pane wraps mid-path, so they join without spaces.
  const body = rows.slice(heading + 1, start);
  const question = body.findIndex(row => row.trim().startsWith("Quick safety check:"));
  if (question < 1) return null;
  const folder = body.slice(0, question).map(row => row.trim()).join("");
  const text = compact(body.slice(question).join(" "));
  if (!folder || !text.startsWith(CLAUDE_QUESTION) || !text.includes(CLAUDE_WARNING)) return null;
  return { agent: "claude", folder, options: choices.map(choice => choice.label), selected, trust, signature: `claude\n${folder}` };
}

const claude: TrustSpec = { agent: "claude", detect: readClaude };

const SPECS: readonly TrustSpec[] = [claude];

/** The agents whose folder trust prompt can be answered from the app. */
export const FOLDER_TRUST_AGENTS: readonly SessionAgentId[] = SPECS.map(spec => spec.agent);

/**
 * The folder trust prompt on screen, if any. `agent`, the agent known to run
 * in the pane, is tried first.
 */
export function detectFolderTrustPrompt(screen: Screen, agent?: string): FolderTrustPrompt | null {
  const specs = agent ? [...SPECS.filter(spec => spec.agent === agent), ...SPECS.filter(spec => spec.agent !== agent)] : SPECS;
  for (const spec of specs) {
    const prompt = spec.detect(screen);
    if (prompt) return prompt;
  }
  return null;
}

/**
 * How to trust the folder of `prompt` as it is on screen now: move the
 * highlight to the trust choice, then confirm it once the screen shows it
 * there.
 */
export function folderTrustAnswer(prompt: FolderTrustPrompt): FolderTrustAnswer {
  const distance = prompt.trust - prompt.selected;
  return {
    moves: distance > 0 ? ARROW_DOWN.repeat(distance) : ARROW_UP.repeat(-distance),
    ready(screen) {
      const current = detectFolderTrustPrompt(screen, prompt.agent);
      return !!current && current.signature === prompt.signature && current.selected === current.trust;
    },
    confirm: ENTER,
  };
}
