import { redactTerminalOutput } from "../../server/lib/terminal-redaction.js";
import { sessionAgent, type SessionAgentId } from "../../server/lib/session-agents.js";

// Approval prompts of the coding agents PzzaCode runs, read from the visible
// terminal screen. Each agent's prompt has its own layout; a spec recognises
// it, extracts what the agent wants to do and its choices, and maps each
// choice to the keys that agent expects. Detection is strict: a prompt counts
// only when its question, its full option list and its key hint are all on
// screen, so ordinary numbered lists in an answer never match.

export type PermissionChoiceRole = "allow" | "allow-always" | "deny" | "deny-feedback";
export interface PermissionChoice {
  id: string;
  /** The option text as the agent shows it. */
  label: string;
  /** A short form for narrow places. */
  shortLabel: string;
  role: PermissionChoiceRole;
  /** The single key the agent names for this option, when it shows one. */
  key?: string;
}
export type PermissionKind = "command" | "edit" | "fetch" | "tool";
export interface PermissionPrompt {
  agent: SessionAgentId;
  kind: PermissionKind;
  /** What is asked for, as a heading: "Run command", "Edit notes.txt". */
  action: string;
  /** The agent's question, e.g. "Do you want to proceed?". */
  question: string;
  /** The command, file or tool input, redacted, rows joined. */
  subject: string;
  choices: PermissionChoice[];
  /** Index of the highlighted choice, when the agent marks one. */
  selected: number;
  /** Layout-independent identity of this prompt. */
  signature: string;
  /** Where the agent cut the input short on screen (an ellipsis there). */
  clipped?: "start" | "end";
  /** The pane width it was read at, when known. */
  cols?: number;
}
/**
 * The visible screen: one string per row, and optionally the background of
 * the cell at a string index of a row, for prompts that mark the highlighted
 * choice only with color.
 */
export interface Screen {
  rows: readonly string[];
  /** The pane width in columns, when known. */
  cols?: number;
  background?(row: number, index: number): string | undefined;
  /**
   * The foreground color and weight of the cell at a string index of a row,
   * for prompts that mark the highlighted choice only with bold or a text
   * color.
   */
  style?(row: number, index: number): string | undefined;
  /**
   * Rows right above the visible ones, oldest first, from the pane's
   * history. Only read to find where an input that starts above the screen
   * begins; see screenWithHistory.
   */
  above?: readonly string[];
}
export type AnswerStep =
  | { kind: "send"; data: string }
  | { kind: "wait"; until: (screen: Screen) => boolean; timeoutMs: number; failure: string };

interface PromptSpec {
  agent: SessionAgentId;
  detect(screen: Screen): PermissionPrompt | null;
  plan(prompt: PermissionPrompt, choice: PermissionChoice, feedback: string): AnswerStep[];
}

const SUBJECT_CHARS = 2000;
// Long enough for a sentence or two; a long burst can be folded into a
// "[Pasted text]" placeholder by an agent's input, which hides the note.
const FEEDBACK_CHARS = 300;

/** Display name of an agent from the session agent catalog. */
export function permissionAgentLabel(agent: SessionAgentId): string {
  return sessionAgent(agent)?.label ?? agent;
}

/** Notice title for a prompt: who asks and for what. */
export function permissionTitle(prompt: PermissionPrompt): string {
  return `${permissionAgentLabel(prompt.agent)}: ${prompt.action}`;
}

/**
 * Feedback typed into a terminal: one line of plain text. Control and
 * direction characters go; a leading "/", "!", "#", "&" or "@" would start a
 * command, shell mode, memory entry or file picker in an agent's input, so
 * the note is prefixed instead; "@" before a word opens a file picker, so it
 * is dropped there.
 */
export function sanitizePermissionFeedback(text: string): string {
  const plain = text
    .replace(/\x1b(?:\[[0-?]*[ -/]*[@-~]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-_])?/gu, "")
    .replace(/\x9b[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\r\n\t]+/gu, " ")
    .replace(/[\x00-\x1f\x7f-\x9f​-‏‪-‮⁦-⁩﻿]/gu, "")
    .replace(/(^|\s)@+(?=\S)/gu, "$1")
    .replace(/ {2,}/gu, " ")
    .trim();
  const safe = /^[/!#&@]/u.test(plain) ? `Note: ${plain}` : plain;
  return Array.from(safe).slice(0, FEEDBACK_CHARS).join("").trim();
}


function redact(text: string): string {
  return redactTerminalOutput(text).text;
}

function clampSubject(text: string): string {
  const clean = redact(text.trim());
  return clean.length > SUBJECT_CHARS ? `${clean.slice(0, SUBJECT_CHARS - 1)}…` : clean;
}


function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

function signatureOf(agent: SessionAgentId, kind: PermissionKind, action: string, subject: string, choices: readonly PermissionChoice[]): string {
  return [agent, kind, compact(action), compact(subject), ...choices.map(choice => `${choice.role}:${compact(choice.label)}`)].join("\u0000");
}

function sameFrame(a: PermissionPrompt, b: PermissionPrompt): boolean {
  return a.agent === b.agent && a.kind === b.kind && compact(a.action) === compact(b.action) && a.choices.length === b.choices.length
    && a.choices.every((choice, index) => choice.role === b.choices[index].role && compact(choice.label) === compact(b.choices[index].label));
}

/**
 * Whether two reads show exactly the same prompt, as the answer requires: same
 * agent, action and options, and the input text identical row for row. A
 * prompt whose input is cut short on screen is never the same as anything:
 * part of what would be approved cannot be read.
 */
export function samePermissionPrompt(a: PermissionPrompt, b: PermissionPrompt): boolean {
  return !a.clipped && !b.clipped && sameFrame(a, b) && a.subject === b.subject;
}

/**
 * Whether two reads show the same prompt for declining it. Declining approves
 * nothing, so a prompt whose input is cut short on screen may be declined,
 * but only when both reads show the same frame, the same visible text and
 * the same cut.
 */
export function sameDeclinedPermissionPrompt(a: PermissionPrompt, b: PermissionPrompt): boolean {
  return sameFrame(a, b) && a.subject === b.subject && a.clipped === b.clipped;
}

/** Whether a choice declines the request: safe even when part of the input is unreadable. */
export function declinesPermission(choice: PermissionChoice): boolean {
  return choice.role === "deny" || choice.role === "deny-feedback";
}

const HISTORY_ROWS = 300;
function plainRow(row: string): string {
  return row.replace(/[\x00-\x1f\x7f-\x9f]/gu, "").replace(/\s+$/u, "");
}

/**
 * The screen with the rows above it, from one capture of the pane's history
 * and visible rows (oldest first, as tmux wrapped them). Null unless the
 * capture ends with exactly the rows on screen: otherwise the pane moved
 * between the two reads and the rows above could belong to another moment.
 */
export function screenWithHistory(screen: Screen, lines: readonly string[]): Screen | null {
  const trimEnd = (rows: readonly string[]) => {
    let end = rows.length;
    while (end > 0 && !plainRow(rows[end - 1])) end--;
    return rows.slice(0, end).map(plainRow);
  };
  const shown = trimEnd(screen.rows);
  const captured = trimEnd(lines);
  if (!shown.length || captured.length < shown.length) return null;
  const start = captured.length - shown.length;
  if (shown.some((row, index) => row !== captured[start + index])) return null;
  return { ...screen, above: captured.slice(Math.max(0, start - HISTORY_ROWS), start) };
}

/**
 * The prompt to keep when a new read may be a redraw of `known`, else null.
 * A redraw at another width rewraps the input (the same characters apart
 * from white space). It may also cut the input short: behind an ellipsis the
 * agent drew, or, when the pane got narrower, at the end. The kept prompt is
 * the new read, marked as cut where it is, so what is shown is what is on
 * screen. A longer input is a new prompt unless the known one was cut.
 */
export function followPermissionPrompt(known: PermissionPrompt, next: PermissionPrompt): PermissionPrompt | null {
  if (!sameFrame(known, next)) return null;
  const strip = (prompt: PermissionPrompt) => {
    const text = compact(prompt.subject);
    return prompt.clipped === "start" ? text.replace(/^…/u, "") : prompt.clipped === "end" ? text.replace(/…$/u, "") : text;
  };
  const before = strip(known);
  const now = strip(next);
  const narrower = known.cols !== undefined && next.cols !== undefined && next.cols < known.cols;
  const wider = known.cols !== undefined && next.cols !== undefined && next.cols > known.cols;
  // The same text, now shown in full or cut differently.
  if (before === now) return next;
  if (next.clipped === "start" && !known.clipped && now && before.endsWith(now)) return next;
  if ((next.clipped === "end" || narrower) && !known.clipped && now && before.startsWith(now)) return next.clipped ? next : { ...next, subject: `${next.subject}…`, clipped: "end" };
  if (known.clipped === "end" && wider && before && now.startsWith(before)) return next;
  if (known.clipped === "start" && before && now.endsWith(before)) return next;
  return null;
}

// Where clampSubject cut a long input.
function endClipped(subject: string): "end" | undefined {
  return subject.length >= SUBJECT_CHARS && subject.endsWith("…") ? "end" : undefined;
}

const SOLID_DIVIDER = /^\s*─{8,}\s*$/u;
const DASHED_DIVIDER = /^\s*╌{8,}\s*$/u;
const ARROW_UP = "\x1b[A";
const ARROW_DOWN = "\x1b[B";

function lastContentRow(rows: readonly string[]): number {
  let index = rows.length - 1;
  while (index >= 0 && !rows[index].trim()) index--;
  return index;
}

// The last `count` rows down to the last row with content: an inline TUI
// can sit above blank rows at the bottom of the pane.
function bottomRows(screen: Screen, count: number): readonly string[] {
  return screen.rows.slice(0, lastContentRow(screen.rows) + 1).slice(-count);
}

// The pane width, from a full-width divider when one is visible.
function screenWidth(rows: readonly string[]): number {
  let width = 0;
  for (const row of rows) {
    if (SOLID_DIVIDER.test(row) || DASHED_DIVIDER.test(row)) width = Math.max(width, Array.from(row.trimEnd()).length);
  }
  return width || Math.max(0, ...rows.map(row => Array.from(row).length));
}

interface Wrapped { raw: string; text: string }

// An input exactly as the agent drew it: row breaks kept, since a wrap can
// split a token anywhere and rejoining rows could show a different command;
// common indent and trailing space removed. `first` replaces the first row
// with its text after a marker such as "$ ".
function asShown(rows: readonly string[], first?: string): string {
  const rest = first === undefined ? rows : rows.slice(1);
  const indents = rest.filter(row => row.trim()).map(row => row.length - row.trimStart().length);
  const indent = indents.length ? Math.min(...indents) : 0;
  const lines = rest.map(row => row.slice(indent).trimEnd());
  return redactRows(first === undefined ? lines : [first.trim(), ...lines]).join("\n").trim();
}

// Redacts a wrapped input as one text, so a secret split across rows is
// caught as a whole, then puts the row breaks back: a masked span shows as
// one marker where it starts and its characters on later rows are dropped.
function redactRows(rows: readonly string[]): string[] {
  const MASK = "[REDACTED]";
  const joined = rows.join("");
  const { text, redacted } = redactTerminalOutput(joined);
  if (!redacted) return [...rows];
  const masked = new Array<boolean>(joined.length).fill(false);
  let source = 0;
  let index = 0;
  while (index < text.length && source <= joined.length) {
    if (!text.startsWith(MASK, index)) { index++; source++; continue; }
    while (text.startsWith(MASK, index)) index += MASK.length;
    const next = text.indexOf(MASK, index);
    const chunk = text.slice(index, next < 0 ? text.length : next);
    // Where the unmasked text resumes; unknown means mask to the end.
    const found = chunk ? joined.indexOf(chunk, source) : -1;
    const end = found < 0 ? joined.length : found;
    for (let at = source; at < end; at++) masked[at] = true;
    source = end;
  }
  const out: string[] = [];
  let offset = 0;
  for (const row of rows) {
    let line = "";
    for (let at = 0; at < row.length; at++) {
      const position = offset + at;
      if (!masked[position]) line += row[at];
      else if (position === 0 || !masked[position - 1]) line += MASK;
    }
    out.push(line);
    offset += row.length;
  }
  return out;
}

// Rows the agent wrapped at
// long for any row was split mid-token (joined as is); a row that could not
// take the next word was word-wrapped (joined with a space); anything else
// is a real line break.
function unwrap(rows: readonly Wrapped[], limit: number): string {
  const length = (text: string) => Array.from(text).length;
  let text = "";
  let previous: string | null = null;
  for (const { raw, text: content } of rows) {
    const value = content.trim();
    if (previous === null) text = value;
    else {
      const rowLength = length(previous.trimEnd());
      const lastToken = previous.trimEnd().split(/\s+/u).pop() ?? "";
      const firstToken = value.split(/\s+/u)[0] ?? "";
      if (rowLength >= limit && length(lastToken) + length(firstToken) > limit / 2) text += value;
      else if (rowLength + 1 + length(firstToken) > limit) text += ` ${value}`;
      else text += `\n${value}`;
    }
    previous = raw;
  }
  return text;
}

// The width a block was wrapped at: its longest row.
function blockLimit(rows: readonly Wrapped[]): number {
  return Math.max(0, ...rows.map(row => Array.from(row.raw.trimEnd()).length));
}

interface NumberedOptions { labels: string[]; selected: number; start: number }

// A numbered option list ending at `end` (inclusive), read bottom-up so the
// list must run 1..n without gaps. Continuation rows are indented further.
// `pattern` captures the highlight marker, the number and the label.
function numberedOptions(rows: readonly string[], end: number, width: number, pattern: RegExp): NumberedOptions | null {
  let start = -1;
  for (let index = end; index >= 0 && end - index < 40; index--) {
    const row = rows[index];
    if (!row.trim()) return null;
    const match = pattern.exec(row);
    if (match && match[2] === "1") { start = index; break; }
    if (!match && !/^\s{4,}\S/u.test(row)) return null;
  }
  if (start < 0) return null;
  const parts: Wrapped[][] = [];
  let selected = -1;
  for (let index = start; index <= end; index++) {
    const match = pattern.exec(rows[index]);
    if (match) {
      if (Number(match[2]) !== parts.length + 1) return null;
      if (match[1]) selected = parts.length;
      parts.push([{ raw: rows[index], text: match[3] }]);
    } else parts[parts.length - 1].push({ raw: rows[index], text: rows[index] });
  }
  if (parts.length < 2) return null;
  return { labels: parts.map(part => unwrap(part, Math.min(width, blockLimit(part))).replace(/\n/g, " ")), selected, start };
}

// "Yes, and don't ask again for commands that start with `ls`" reads as
// "Don't ask again" on a button; the full text stays its accessible name.
function shortLabel(label: string, max = 26): string {
  const rest = label.replace(/^Yes,\s*(?:and\s+)?/iu, "");
  if (rest === label) return label.length > max ? `${label.slice(0, max - 1).trimEnd()}…` : label;
  const head = rest.split(/\s+(?:·|—|\(|(?:from|for|in|to|at)\s+(?:this|that|these|commands|\/|~|`|"))/u)[0].trim();
  const text = head.charAt(0).toUpperCase() + head.slice(1);
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

// Claude Code: a divider, the tool heading ("Bash command", "Edit file"), the
// input inside dashed rules, "Do you want to …?", numbered options with ❯ on
// the highlighted one, and "Esc to cancel · Tab to amend". A digit picks its
// option at once. Tab on "No" opens an inline field for what to do instead,
// submitted with Enter.
const CLAUDE_OPTION = /^\s*(?:(❯)\s*)?(\d{1,2})\.\s+(\S.*)$/u;
function readClaude(screen: Screen): (PermissionPrompt & { editing: boolean }) | null {
  const rows = screen.rows.map(cleanRowRight);
  const footer = lastContentRow(rows);
  if (footer < 3 || !/^Esc to cancel(?: · Tab to amend)?$/u.test(rows[footer].trim())) return null;
  let end = footer - 1;
  while (end >= 0 && !rows[end].trim()) end--;
  const width = screenWidth(rows);
  const options = numberedOptions(rows, end, width, CLAUDE_OPTION);
  if (!options) return null;
  // The question: the rows right above the list, from "Do you want".
  let questionStart = -1;
  for (let index = options.start - 1; index >= 0 && options.start - index <= 4; index--) {
    const text = rows[index].trim();
    if (!text || DASHED_DIVIDER.test(text) || SOLID_DIVIDER.test(text)) break;
    if (/^Do you want\b/u.test(text)) { questionStart = index; break; }
  }
  if (questionStart < 0) return null;
  const question = rows.slice(questionStart, options.start).map(row => row.trim()).join(" ");
  if (!/\?$/u.test(question)) return null;
  // Input between the dashed rules above the question; the heading sits
  // under the solid divider above them. Either can be scrolled away; a long
  // input that starts above the screen is found in the rows above it, when
  // the pane's history was read.
  let bottomRule = -1;
  for (let index = questionStart - 1; index >= 0; index--) {
    if (DASHED_DIVIDER.test(rows[index])) { bottomRule = index; break; }
    if (SOLID_DIVIDER.test(rows[index])) break;
  }
  // From here on, indices are into the history rows followed by the screen.
  const above = (screen.above ?? []).map(cleanRowRight);
  const all = above.length ? [...above, ...rows] : rows;
  const shift = above.length;
  let topRule = -1;
  for (let index = shift + bottomRule - 1; bottomRule >= 0 && index >= 0; index--) {
    if (DASHED_DIVIDER.test(all[index])) { topRule = index; break; }
    if (SOLID_DIVIDER.test(all[index])) break;
  }
  let divider = -1;
  for (let index = (topRule >= 0 ? topRule : bottomRule >= 0 ? -1 : shift + questionStart) - 1; index >= (topRule >= 0 ? 0 : shift); index--) {
    if (SOLID_DIVIDER.test(all[index])) { divider = index; break; }
  }
  const heading = divider >= 0 ? all[divider + 1]?.trim() ?? "" : "";
  let subjectRows: string[] = [];
  let clipped = false;
  if (bottomRule >= 0) {
    clipped = topRule < 0;
    // Cut short: only what the screen shows.
    subjectRows = clipped ? rows.slice(0, bottomRule) : all.slice(topRule + 1, shift + bottomRule);
  } else if (divider >= 0) {
    subjectRows = all.slice(divider + 2, shift + questionStart).filter(row => !/^\s*Tip:/u.test(row));
  }
  const boxed = subjectRows.filter(row => row.trim());
  let subject = asShown(boxed.map(row => row.replace(/^\s*│\s?/u, "")));
  if (clipped && subject) subject = `…${subject}`;
  const editTarget = /^Do you want to (?:make this edit to|create|write to|overwrite)\s+(.+)\?$/u.exec(question)?.[1];
  const kind: PermissionKind = /^Bash command\b/u.test(heading) || (!heading && /^Do you want to proceed\?$/u.test(question) && bottomRule >= 0 && !editTarget) ? "command"
    : editTarget || /^(?:Edit|Create|Write|Overwrite) file\b/u.test(heading) ? "edit"
      : /^Fetch\b/u.test(heading) ? "fetch" : "tool";
  const action = kind === "command" ? "Run a command" : kind === "edit" ? `${/^Create/u.test(heading) ? "Create" : "Edit"} ${editTarget ?? "a file"}`
    : kind === "fetch" ? "Fetch a web page" : heading ? `Use ${heading}` : "Use a tool";
  // While a note is typed in the terminal, the option shows the note; the
  // buttons keep the option itself.
  const amending = !/Tab to amend/u.test(rows[footer]);
  const choices: PermissionChoice[] = options.labels.map((label, index) => {
    const role: PermissionChoiceRole = /^No\b/u.test(label) ? "deny" : index === 0 ? "allow" : "allow-always";
    const shown = amending && index === options.selected && (role === "deny" || role === "allow") ? (role === "deny" ? "No" : "Yes") : label;
    return { id: String(index + 1), label: redact(shown), shortLabel: redact(shortLabel(shown)), role };
  });
  const deny = choices.findIndex(choice => choice.role === "deny");
  if (deny < 0 || choices[0].role !== "allow") return null;
  // Tab on the highlighted "No" is how Claude Code takes a note with it.
  choices.push({ id: `${deny + 1}+note`, label: "No, and tell Claude what to do differently", shortLabel: "Tell Claude instead", role: "deny-feedback" });
  subject = clampSubject(subject);
  // Typing a note into the prompt: the footer drops "Tab to amend" and the
  // highlighted option shows the note. Keys from the app would land in it.
  const editing = !/Tab to amend/u.test(rows[footer]) && options.selected >= 0
    && (/^No,/u.test(options.labels[options.selected]) || /^Yes, and tell Claude what to do next$/u.test(options.labels[options.selected]));
  return { agent: "claude", kind, action: redact(action), question: redact(question), subject, choices, selected: options.selected, signature: signatureOf("claude", kind, action, subject, choices), clipped: clipped ? "start" : endClipped(subject), editing };
}
const claude: PromptSpec = {
  agent: "claude",
  detect(screen) {
    const prompt = readClaude(screen);
    return prompt && !prompt.editing ? prompt : null;
  },
  plan(prompt, choice, feedback) {
    if (choice.role !== "deny-feedback") return [{ kind: "send", data: choice.id }];
    const deny = prompt.choices.findIndex(option => option.role === "deny");
    if (!feedback) return [{ kind: "send", data: String(deny + 1) }];
    const selected = Math.max(0, prompt.selected);
    const moves = deny >= selected ? ARROW_DOWN.repeat(deny - selected) : ARROW_UP.repeat(selected - deny);
    const onNo = (screen: Screen) => detectPermissionPrompt(screen)?.selected === deny;
    // In the note field the footer loses "Tab to amend" and No shows the note.
    const amending = (screen: Screen) => {
      const current = readClaude(screen);
      return !!current?.editing && current.selected === deny;
    };
    // The note shows inside the highlighted "No" option as it is typed.
    const typed = (screen: Screen) => {
      const rows = screen.rows;
      if (!amending(screen)) return false;
      const marker = new RegExp(`^\\s*❯\\s*${deny + 1}\\.\\s`, "u");
      const start = rows.findIndex(row => marker.test(row));
      if (start < 0) return false;
      let end = start + 1;
      while (end < rows.length && /^\s{4,}\S/u.test(rows[end]) && !CLAUDE_OPTION.test(rows[end])) end++;
      return compact(rows.slice(start, end).join("")).includes(compact(feedback).slice(0, 24));
    };
    return [
      ...(moves ? [{ kind: "send" as const, data: moves }, { kind: "wait" as const, until: onNo, timeoutMs: 1500, failure: "Could not highlight No in the prompt. Nothing was answered." }] : []),
      { kind: "send", data: "\t" },
      { kind: "wait", until: amending, timeoutMs: 1500, failure: "The note field did not open. Nothing was answered." },
      { kind: "send", data: feedback },
      { kind: "wait", until: typed, timeoutMs: 1500, failure: "The note did not reach the prompt. Check the terminal before pressing Enter." },
      { kind: "send", data: "\r" },
    ];
  },
};

function cleanRowRight(row: string): string {
  return row.replace(/\s+$/u, "");
}

// Codex: "Would you like to run the following command?" (or "… make the
// following edits?"), optional Environment / Reason / Description /
// Destination fields, the command after "$ ", numbered options with › on the
// highlighted one and their shortcut in parentheses, then "Press enter to
// confirm or esc to cancel". Narrow panes cut the question and the footer
// short instead of wrapping them. A digit picks its option at once. "No"
// ends the turn and returns to the composer, where a message tells Codex
// what to do instead.
const CODEX_OPTION = /^\s*(?:(›)\s*)?(\d{1,2})\.\s+(\S.*)$/u;
const CODEX_COMPOSER = /^›(?:\s|$)/u;
// The rows of a "Name: value" field, the first holding the text after the name.
function codexField(rows: readonly string[], from: number, to: number, name: string): Wrapped[] {
  const label = new RegExp(`^\\s*${name}:\\s*(.*)$`, "u");
  const start = rows.slice(from, to).findIndex(row => label.test(row));
  if (start < 0) return [];
  const parts: Wrapped[] = [{ raw: rows[from + start], text: label.exec(rows[from + start])?.[1] ?? "" }];
  for (let index = from + start + 1; index < to && rows[index].trim() && !/^\s*[A-Z][a-z]+:\s/u.test(rows[index]) && !/^\s*\$\s/u.test(rows[index]); index++) parts.push({ raw: rows[index], text: rows[index] });
  return parts.filter(part => part.text.trim());
}
const codex: PromptSpec = {
  agent: "codex",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const footer = lastContentRow(rows);
    // The whole hint row, or the start of it where a narrow pane cuts it.
    const hint = rows[footer]?.trim() ?? "";
    if (footer < 3 || hint.length < 16 || !"Press enter to confirm or esc to cancel".startsWith(hint)) return null;
    let end = footer - 1;
    while (end >= 0 && !rows[end].trim()) end--;
    const width = screenWidth(rows);
    const options = numberedOptions(rows, end, width, CODEX_OPTION);
    if (!options) return null;
    let questionRow = -1;
    for (let index = options.start - 1; index >= 0 && options.start - index <= 40; index--) {
      if (/^\s*Would you like to\b/u.test(rows[index])) { questionRow = index; break; }
      if (CODEX_OPTION.test(rows[index]) || CODEX_COMPOSER.test(rows[index])) return null;
    }
    if (questionRow < 0) return null;
    const asked = rows[questionRow].trim();
    const kind: PermissionKind = /^Would you like to run\b/u.test(asked) ? "command" : /^Would you like to make\b/u.test(asked) ? "edit" : "tool";
    const question = kind === "command" ? "Would you like to run the following command?" : kind === "edit" ? "Would you like to make the following edits?" : asked;
    // The command: "$ " up to the blank row before the options.
    let subject = "";
    const dollar = rows.slice(questionRow, options.start).findIndex(row => /^\s*\$\s/u.test(row));
    if (dollar >= 0) {
      const block: string[] = [];
      for (let index = questionRow + dollar; index < options.start && rows[index].trim(); index++) block.push(rows[index]);
      subject = asShown(block, block[0].replace(/^\s*\$\s/u, ""));
    }
    const destinationParts = codexField(rows, questionRow + 1, options.start, "Destination");
    const destination = unwrap(destinationParts, Math.min(width, blockLimit(destinationParts))).replace(/\n/g, " ");
    const reasonParts = codexField(rows, questionRow + 1, options.start, "Reason");
    const reason = unwrap(reasonParts, Math.min(width, blockLimit(reasonParts))).replace(/\n/g, " ");
    if (!subject && destinationParts.length) subject = asShown(destinationParts.map(part => part.raw), destinationParts[0].text === destinationParts[0].raw ? undefined : destinationParts[0].text);
    const file = destination.split("/").filter(Boolean).pop();
    const action = kind === "command" ? "Run a command" : kind === "edit" ? `Edit ${file ?? "files"}` : "Approve a request";
    const choices: PermissionChoice[] = options.labels.map((text, index) => {
      const shortcut = /\s*\(([a-z]|esc)\)$/u.exec(text);
      const label = shortcut ? text.slice(0, shortcut.index) : text;
      const key = shortcut && shortcut[1].length === 1 ? shortcut[1] : undefined;
      const role: PermissionChoiceRole = /^No\b/u.test(label) ? "deny" : index === 0 ? "allow" : "allow-always";
      // "No" here only stops the request; the note variant is its own choice.
      return { id: String(index + 1), label: role === "deny" ? "No" : redact(label), shortLabel: role === "deny" ? "No" : role === "allow" && label.length <= 16 ? label : redact(shortLabel(label)), role, key };
    });
    const deny = choices.findIndex(choice => choice.role === "deny");
    if (deny < 0 || choices[0].role !== "allow") return null;
    choices.push({ id: `${deny + 1}+note`, label: "No, and tell Codex what to do differently", shortLabel: "Tell Codex instead", role: "deny-feedback" });
    subject = clampSubject(subject);
    const shownQuestion = redact(reason || question);
    return { agent: "codex", kind, action, question: shownQuestion, subject, choices, selected: options.selected, signature: signatureOf("codex", kind, action, subject, choices), clipped: endClipped(subject) };
  },
  plan(prompt, choice, feedback) {
    if (choice.role !== "deny-feedback") return [{ kind: "send", data: choice.role === "deny" ? choice.id : choice.key ?? choice.id }];
    const deny = String(prompt.choices.findIndex(option => option.role === "deny") + 1);
    if (!feedback) return [{ kind: "send", data: deny }];
    const composer = (screen: Screen) => !codex.detect(screen) && bottomRows(screen, 10).some(row => CODEX_COMPOSER.test(row.trim()));
    const typed = (screen: Screen) => compact(bottomRows(screen, 12).filter(row => /^\s*›/u.test(row) || /^\s{2}\S/u.test(row)).join("")).includes(compact(feedback).slice(0, 24));
    return [
      { kind: "send", data: deny },
      { kind: "wait", until: composer, timeoutMs: 3000, failure: "Codex declined, but its message box did not appear. Type your note in the terminal." },
      { kind: "send", data: feedback },
      { kind: "wait", until: typed, timeoutMs: 1500, failure: "Codex declined, but the note did not reach its message box. Check the terminal." },
      { kind: "send", data: "\r" },
    ];
  },
};

// OpenCode: a panel with a left rule, "△ Permission required", a heading
// ("# Shell command", "→ Edit notes.txt"), the input, and the buttons
// "Allow once   Allow always   Reject" with "⇆ select  enter confirm". The
// highlighted button differs only by its background. ←/→ move with wrap
// around, Enter picks, Esc rejects. "Allow always" asks to confirm once more
// ("Always allow" with Confirm highlighted). After a reject OpenCode stops
// and the next message tells it what to do instead.
const OPENCODE_RULE = /^\s*┃\s?/u;
// Whole rows only: anything else on a row means it is not OpenCode's panel.
const OPENCODE_HINTS = ["ctrl+f fullscreen  ⇆ select  enter confirm", "ctrl+f minimize  ⇆ select  enter confirm", "⇆ select  enter confirm"];
function opencodeButtons(row: string): "hint" | "plain" | null {
  const match = /^\s*┃\s+Allow once {2,}Allow always {2,}(R[a-z]*)(?: {2,}(\S.*))?$/u.exec(row);
  if (!match || !"Reject".startsWith(match[1])) return null;
  if (!match[2]) return "plain";
  // The hint, or its start where the pane edge cuts it.
  return match[2].length >= 6 && OPENCODE_HINTS.some(hint => hint.startsWith(match[2])) ? "hint" : null;
}
// The key hint on its own row under the buttons; a narrow pane cuts it short.
function opencodeHint(row: string): boolean {
  const text = /^\s*┃\s+(\S.*)$/u.exec(row)?.[1];
  return !!text && text.includes("⇆") && OPENCODE_HINTS.some(hint => hint.startsWith(text));
}
const OPENCODE_LABELS = ["Allow once", "Allow always", "R"] as const;
const ARROW_RIGHT = "\x1b[C";
function opencodeSelected(screen: Screen, row: number): number {
  if (!screen.background) return -1;
  const text = screen.rows[row];
  let from = 0;
  const keys = OPENCODE_LABELS.map(label => {
    const index = text.indexOf(label, from);
    from = index + label.length;
    return index < 0 ? undefined : screen.background?.(row, index);
  });
  if (keys.some(key => key === undefined)) return -1;
  // The highlighted button is the one whose background the other two share not.
  const [once, always, reject] = keys;
  if (always === reject && once !== always) return 0;
  if (once === reject && always !== once) return 1;
  if (once === always && reject !== once) return 2;
  return -1;
}
interface PanelButtons { labels: string[]; hint: boolean }
interface OpencodePanel { buttons: number; labels: string[]; kind: PermissionKind; action: string; subject: string }
// The permission panel OpenCode draws (and Kilo Code, which keeps it):
// `buttonsOf` reads the button row of the agent's own button set.
function readOpencodePanel(screen: Screen, buttonsOf: (row: string) => PanelButtons | null): OpencodePanel | null {
  const rows = screen.rows.map(cleanRowRight);
  const last = lastContentRow(rows);
  let buttons = -1;
  let found: PanelButtons | null = null;
  for (let index = last; index >= 0 && last - index <= 4; index--) {
    found = buttonsOf(rows[index]);
    if (found) { buttons = index; break; }
  }
  if (!found || !rows.slice(buttons, buttons + 3).some(row => opencodeHint(row) || !!buttonsOf(row)?.hint)) return null;
  let title = -1;
  for (let index = buttons - 1; index >= 0 && buttons - index <= 60; index--) {
    if (/^\s*┃\s+△ Permission required$/u.test(rows[index])) { title = index; break; }
  }
  if (title < 0) return null;
  const content = rows.slice(title + 1, buttons).map(row => row.replace(OPENCODE_RULE, ""));
  const headingAt = content.findIndex(row => row.trim());
  const heading = headingAt < 0 ? "" : content[headingAt].trim();
  const body = content.slice(headingAt + 1).filter(row => row.trim());
  const isCommand = /^#\s*Shell\b/u.test(heading) || /^\s*\$\s/u.test(body[0] ?? "");
  const named = heading.replace(/^[#→←⚙✱◇%]\s*/u, "");
  const kind: PermissionKind = isCommand ? "command" : /^(?:Edit|Write|Create|Patch)\b/u.test(named) ? "edit" : /fetch/iu.test(named) ? "fetch" : "tool";
  const subject = kind === "command" && body.length ? asShown(body, body[0]?.replace(/^\s*\$\s/u, "")) : asShown(body);
  const action = kind === "command" ? "Run a command" : named || "Approve a request";
  return { buttons, labels: found.labels, kind, action, subject };
}

const opencode: PromptSpec = {
  agent: "opencode",
  detect(screen) {
    const panel = readOpencodePanel(screen, row => {
      const shown = opencodeButtons(row);
      return shown ? { labels: [...OPENCODE_LABELS], hint: shown === "hint" } : null;
    });
    if (!panel) return null;
    const { buttons, kind, action } = panel;
    let subject = panel.subject;
    const choices: PermissionChoice[] = [
      { id: "once", label: "Allow once", shortLabel: "Allow once", role: "allow" },
      { id: "always", label: "Allow always", shortLabel: "Allow always", role: "allow-always" },
      { id: "reject", label: "Reject", shortLabel: "Reject", role: "deny" },
      { id: "reject+note", label: "Reject and tell OpenCode what to do", shortLabel: "Tell OpenCode instead", role: "deny-feedback" },
    ];
    subject = clampSubject(subject);
    const shownAction = redact(action);
    return { agent: "opencode", kind, action: shownAction, question: "Permission required", subject, choices, selected: opencodeSelected(screen, buttons), signature: signatureOf("opencode", kind, shownAction, subject, choices), clipped: endClipped(subject) };
  },
  plan(prompt, choice, feedback) {
    if (choice.role === "deny") return [{ kind: "send", data: "\x1b" }];
    if (choice.role === "deny-feedback") {
      if (!feedback) return [{ kind: "send", data: "\x1b" }];
      const gone = (screen: Screen) => !opencode.detect(screen) && !screen.rows.some(row => /△ Permission required/u.test(row));
      const typed = (screen: Screen) => compact(bottomRows(screen, 16).join("")).includes(compact(feedback).slice(0, 24));
      return [
        { kind: "send", data: "\x1b" },
        { kind: "wait", until: gone, timeoutMs: 3000, failure: "OpenCode rejected, but its message box did not come back. Type your note in the terminal." },
        { kind: "send", data: feedback },
        { kind: "wait", until: typed, timeoutMs: 1500, failure: "OpenCode rejected, but the note did not reach its message box. Check the terminal." },
        { kind: "send", data: "\r" },
      ];
    }
    if (prompt.selected < 0) throw new Error("Could not tell which OpenCode button is highlighted. Answer in the terminal.");
    const target = choice.role === "allow" ? 0 : 1;
    const moves = ARROW_RIGHT.repeat((target - prompt.selected + 3) % 3);
    const onTarget = (screen: Screen) => opencode.detect(screen)?.selected === target;
    return [
      ...(moves ? [{ kind: "send" as const, data: moves }, { kind: "wait" as const, until: onTarget, timeoutMs: 1500, failure: "Could not highlight the button in OpenCode. Nothing was answered." }] : []),
      { kind: "send", data: "\r" },
      ...(target === 1 ? [
        { kind: "wait" as const, until: opencodeConfirming, timeoutMs: 2000, failure: "OpenCode did not ask to confirm Allow always. Check the terminal." },
        { kind: "send" as const, data: "\r" },
      ] : []),
    ];
  },
};

// The second stage of "Allow always": "△ Always allow" with Confirm / Cancel.
function opencodeConfirming(screen: Screen): boolean {
  const rows = screen.rows.map(cleanRowRight);
  const last = lastContentRow(rows);
  return rows.some(row => /△ Always allow/u.test(row)) && rows.slice(Math.max(0, last - 4), last + 1).some(row => /Confirm\s+Cancel/u.test(row));
}

// Readers shared by the agents below.

// History rows (oldest first) followed by the screen, and where the screen
// starts in them. Only inline agents have useful history.
function withAbove(screen: Screen, rows: readonly string[]): { all: string[]; shift: number } {
  const above = (screen.above ?? []).map(cleanRowRight);
  return { all: [...above, ...rows], shift: above.length };
}

function trimBlank(rows: readonly string[]): string[] {
  let start = 0;
  let end = rows.length;
  while (start < end && !rows[start].trim()) start++;
  while (end > start && !rows[end - 1].trim()) end--;
  return rows.slice(start, end);
}

function baseName(path: string): string {
  return path.replace(/[`"]/gu, "").trim().split(/[\\/]/u).filter(Boolean).pop() ?? "";
}

function choiceOf(id: string, label: string, role: PermissionChoiceRole, short?: string, key?: string): PermissionChoice {
  return { id, label: redact(label), shortLabel: redact(short ?? shortLabel(label)), role, ...(key ? { key } : {}) };
}

// A prompt from what was read. An input the agent cut short, or that runs
// off the screen, carries an ellipsis where it is cut and can only be
// declined.
function promptOf(agent: SessionAgentId, kind: PermissionKind, action: string, question: string, text: string, choices: PermissionChoice[], selected: number, cut?: "start" | "end"): PermissionPrompt {
  const subject = clampSubject(cut === "start" ? `…${text}` : cut === "end" ? `${text}…` : text);
  const shownAction = redact(action);
  return { agent, kind, action: shownAction, question: redact(question), subject, choices, selected, signature: signatureOf(agent, kind, shownAction, subject, choices), clipped: cut ?? endClipped(subject) };
}

// A key hint row as the agent draws it, or its start where a narrow pane or
// the agent cut it (with or without an ellipsis).
function hintMatches(text: string, hints: readonly string[], min = 16): boolean {
  const shown = text.trim().replace(/…$/u, "").trimEnd();
  return hints.some(hint => hint === shown || (shown.length >= min && hint.startsWith(shown)));
}

// Moves the highlight from one option to another with the arrow keys and
// waits until the screen shows it there.
function arrowSteps(agent: string, from: number, to: number, reached: (screen: Screen) => boolean): AnswerStep[] {
  if (from < 0) throw new Error(`Could not tell which ${agent} option is highlighted. Answer in the terminal.`);
  if (from === to) return [];
  return [
    { kind: "send", data: to > from ? ARROW_DOWN.repeat(to - from) : ARROW_UP.repeat(from - to) },
    { kind: "wait", until: reached, timeoutMs: 1500, failure: `Could not highlight the option in ${agent}. Nothing was answered.` },
  ];
}

// Opens an agent's note field, types the note once the field shows, and
// submits it once the note shows in it.
function noteSteps(agent: string, open: readonly AnswerStep[], opened: (screen: Screen) => boolean, typed: (screen: Screen) => boolean, feedback: string): AnswerStep[] {
  return [
    ...open,
    { kind: "wait", until: opened, timeoutMs: 3000, failure: `The note field did not open in ${agent}. Check the terminal.` },
    { kind: "send", data: feedback },
    { kind: "wait", until: typed, timeoutMs: 1500, failure: `The note did not reach ${agent}. Check the terminal before pressing Enter.` },
    { kind: "send", data: "\r" },
  ];
}

// Whether a note's start shows in some rows, whitespace aside.
function showsNote(rows: readonly string[], feedback: string): boolean {
  return compact(rows.join("")).includes(compact(feedback).slice(0, 24));
}

// The one item whose cell key differs from all the others' (two items: the
// one that differs from `base`), else -1.
function oddOneOut(keys: readonly (string | undefined)[], base?: string): number {
  if (keys.some(key => key === undefined)) return -1;
  if (base !== undefined) {
    const odd = keys.flatMap((key, index) => key !== base ? [index] : []);
    return odd.length === 1 ? odd[0] : -1;
  }
  if (keys.length < 3) return -1;
  const odd = keys.flatMap((key, index) => keys.filter(other => other === key).length === 1 ? [index] : []);
  return odd.length === 1 && keys.filter(key => key !== keys[odd[0]]).every(key => key === keys[(odd[0] + 1) % keys.length]) ? odd[0] : -1;
}

interface BoxRead { top: number; content: string[] }
// The rows inside a box whose bottom border is row `bottom`, each without
// its side borders. `top` is -1 when the box runs off the top of the rows.
// An `overlay` box (a dialog drawn over other text) is read by the columns
// of its bottom border; otherwise its rows hold nothing outside the box.
function boxAbove(rows: readonly string[], bottom: number, options: { corners?: string; overlay?: boolean } = {}): BoxRead | null {
  const [tl, tr, bl, br] = Array.from(options.corners ?? "╭╮╰╯");
  const edge = Array.from(rows[bottom] ?? "");
  const left = edge.indexOf(bl);
  const right = options.overlay ? edge.indexOf(br, left + 1) : edge.length - 1;
  if (left < 0 || right - left < 9 || edge[right] !== br || edge.slice(left + 1, right).some(char => char !== "─")) return null;
  if (!options.overlay && edge.slice(0, left).some(char => char !== " ")) return null;
  const content: string[] = [];
  for (let index = bottom - 1; index >= 0; index--) {
    const chars = Array.from(rows[index]);
    const end = options.overlay ? right : chars.length - 1;
    if (!options.overlay && chars.slice(0, left).some(char => char !== " ")) return null;
    if (chars[left] === tl && chars[end] === tr && end > left && chars.slice(left + 1, end).every(char => char === "─")) return { top: index, content: content.reverse() };
    if (chars[left] !== "│" || end <= left || chars[end] !== "│") return null;
    content.push(chars.slice(left + 1, end).join(""));
  }
  return { top: -1, content: content.reverse() };
}

// A row of an inner box ("│ text │"), its text; null for any other row.
function innerBoxText(row: string): string | null {
  const text = row.trim();
  if (/^[╭╰]─*(?:.*─)?[╮╯]$/u.test(text)) return "";
  const match = /^│ ?(.*?) ?│$/u.exec(text);
  return match ? match[1] : null;
}

// Gemini and Qwen Code shorten a tall input with "... 12 hidden ...".
const HIDDEN_ROWS = /\.\.\. [^\n]*?\bhidden\b[^\n]*?\.\.\./u;

// Antigravity CLI: a heading ("Command", "Pending edit", "Create file") over
// a full-width rule, the input ("Requesting permission for:" and the
// command, or the file path and its diff), the question, numbered options
// with "> " on the highlighted one (long labels wrap back to column 0), the
// key hint and "esc to cancel". A digit picks its option at once. Tab on a
// highlighted "No" opens a field for what to do instead, sent with Enter.
// Esc is no answer here: it interrupts a command and is ignored on edits.
const AGY_QUESTIONS = new Map<string, PermissionKind>([
  ["Run this command?", "command"], ["Accept this file edit?", "edit"], ["Allow creation of this file?", "edit"],
  ["Allow access to this URL?", "fetch"], ["Allow calling this tool?", "tool"], ["Allow access to this file?", "tool"],
]);
const AGY_HEADINGS = new Map<PermissionKind, readonly string[]>([["command", ["Command"]], ["edit", ["Pending edit", "Create file"]]]);
const AGY_HINTS = ["↑/↓ Navigate · tab Amend · ctrl+g edit/expand command", "↑/↓ Navigate · tab Amend · f full diff", "↑/↓ Navigate · tab Amend"];
const AGY_OPTION = /^(?:(>)| ) (\d{1,2})\. (\S.*)$/u;
interface AgyRead { prompt: PermissionPrompt; editing: boolean; note: string }
function readAntigravity(screen: Screen): AgyRead | null {
  const rows = screen.rows.map(cleanRowRight);
  const footer = lastContentRow(rows);
  if (footer < 4 || !/^esc to cancel(?: {2,}\S.*)?$/u.test(rows[footer])) return null;
  let hintAt = footer - 1;
  if (rows[hintAt] === "Esc disabled during file edits \u2014 press 1 to accept or 2 to reject.") hintAt--;
  const hint = rows[hintAt] ?? "";
  // In the note field the hint is "enter Submit"; keys from the app would land in the field.
  const editing = hint === "  enter Submit";
  if (!editing && !(/^ {2}\S/u.test(hint) && hintMatches(hint, AGY_HINTS))) return null;
  if (hintAt < 2 || rows[hintAt - 1].trim()) return null;
  const end = hintAt - 2;
  let question = -1;
  for (let index = end; index >= 0 && end - index < 40; index--) {
    if (!rows[index].trim()) return null;
    if (AGY_QUESTIONS.has(rows[index])) { question = index; break; }
  }
  if (question < 0) return null;
  const parts: string[][] = [];
  let selected = -1;
  let note: string[] | null = null;
  for (let index = question + 1; index <= end; index++) {
    const row = rows[index];
    const match = note ? null : AGY_OPTION.exec(row);
    if (match) {
      if (Number(match[2]) !== parts.length + 1) return null;
      if (match[1]) selected = parts.length;
      parts.push([match[3]]);
    } else if (!parts.length) return null;
    else if (note) note.push(row);
    else if (editing && /^ {4}>(?: |$)/u.test(row)) note = [row.replace(/^ {4}> ?/u, "")];
    // A wrapped label goes on at column 0.
    else if (/^\S/u.test(row)) parts[parts.length - 1].push(row);
    else return null;
  }
  if (parts.length < 2) return null;
  const labels = parts.map(part => part.join(" "));
  const roles = labels.map((label, index): PermissionChoiceRole | null => /^No\b/u.test(label) ? "deny" : /^Yes\b/u.test(label) ? (index === 0 ? "allow" : "allow-always") : null);
  const deny = roles.indexOf("deny");
  if (roles[0] !== "allow" || deny < 0 || roles.some(role => role === null)) return null;
  const asked = rows[question];
  const kind = AGY_QUESTIONS.get(asked) ?? "tool";
  // The input sits under the rule below the heading; a long one can push
  // both above the screen, into the pane's history.
  const { all, shift } = withAbove(screen, rows);
  const at = shift + question;
  let rule = -1;
  for (let index = at - 1; index >= 0; index--) if (SOLID_DIVIDER.test(all[index])) { rule = index; break; }
  const heading = rule > 0 ? all[rule - 1].trim() : "";
  const headings = AGY_HEADINGS.get(kind);
  if (rule >= 0 && (headings ? !headings.includes(heading) : !heading)) return null;
  let cut: "start" | "end" | undefined = rule < 0 ? "start" : undefined;
  const body = all.slice(rule < 0 ? shift : rule + 1, at);
  let input: string[];
  if (kind === "command") {
    const label = body.indexOf("Requesting permission for:");
    if (label >= 0) { input = body.slice(label + 1); cut = undefined; } else if (rule < 0) input = body;
    else return null;
  } else input = body.filter(row => row !== "  shift+tab to auto-approve file edits");
  input = trimBlank(input);
  if (!input.length) return null;
  let action = kind === "command" ? "Run a command" : kind === "fetch" ? "Fetch a web page" : asked === "Allow access to this file?" ? "Access a file" : "Use a tool";
  if (kind === "edit") {
    // The path row is cut at the pane edge, without a mark.
    const path = rule >= 0 ? input[0] : "";
    if (path && Array.from(path).length >= (screen.cols ?? screenWidth(rows))) cut = "end";
    let tool: RegExpExecArray | null = null;
    for (let index = (rule >= 0 ? rule : at) - 1; index >= 0 && !tool && (rule >= 0 ? rule : at) - index <= 6; index--) tool = /^● (?:Edit|Create|Write)\((.+?)\)(?: \(ctrl\+o to expand\))?$/u.exec(all[index]);
    const name = baseName(tool?.[1] ?? (cut ? "" : path));
    action = `${asked === "Allow creation of this file?" ? "Create" : "Edit"} ${name || "a file"}`;
  }
  const short = (label: string) => /^Yes, and always allow in this conversation\b/u.test(label) ? "Allow in conversation" : /^Yes, and always allow for\b/u.test(label) ? "Always allow" : undefined;
  const choices = labels.map((label, index) => choiceOf(String(index + 1), label, roles[index] ?? "deny", short(label)));
  choices.push(choiceOf(`${deny + 1}+note`, "No, and tell Antigravity CLI what to do differently", "deny-feedback", "Tell Antigravity instead"));
  return { prompt: promptOf("antigravity", kind, action, asked, asShown(input), choices, selected, cut), editing, note: (note ?? []).join("") };
}
const antigravity: PromptSpec = {
  agent: "antigravity",
  detect(screen) {
    const read = readAntigravity(screen);
    return read && !read.editing ? read.prompt : null;
  },
  plan(prompt, choice, feedback) {
    if (choice.role !== "deny-feedback") return [{ kind: "send", data: choice.id }];
    const deny = prompt.choices.findIndex(option => option.role === "deny");
    if (!feedback) return [{ kind: "send", data: String(deny + 1) }];
    const onNo = (screen: Screen) => { const read = readAntigravity(screen); return !!read && !read.editing && read.prompt.selected === deny; };
    const amending = (screen: Screen) => { const read = readAntigravity(screen); return !!read && read.editing && read.prompt.selected === deny; };
    const typed = (screen: Screen) => { const read = readAntigravity(screen); return !!read && read.editing && showsNote([read.note], feedback); };
    return noteSteps("Antigravity CLI", [...arrowSteps("Antigravity CLI", prompt.selected, deny, onNo), { kind: "send", data: "\t" }], amending, typed, feedback);
  },
};

// Gemini CLI: one rounded box with "? Shell  <command>" (or "? Edit  <file>:
// …") on top, the command or diff in an inner box, "Allow execution of
// [Shell]?" or "Apply this change?", and numbered options with ● on the
// highlighted one. A digit picks its option at once. "No, suggest changes"
// ends the turn; there is no note field.
const GEMINI_OPTION = /^(?:(●)| ) (\d{1,2})\. (\S.*)$/u;
function readGeminiBox(all: readonly string[], bottom: number): PermissionPrompt | null {
  const box = boxAbove(all, bottom);
  if (!box) return null;
  const content = box.content.map(row => row.replace(/^ /u, "").trimEnd());
  let end = content.length - 1;
  while (end >= 0 && !content[end].trim()) end--;
  let start = end;
  while (start > 0 && GEMINI_OPTION.test(content[start - 1])) start--;
  const labels: string[] = [];
  let shown = -1;
  for (let index = start; index <= end; index++) {
    const match = GEMINI_OPTION.exec(content[index] ?? "");
    if (!match || Number(match[2]) !== labels.length + 1) return null;
    if (match[1]) shown = labels.length;
    labels.push(match[3].replace(/ ~\/\.gemini\/policies\/auto-saved\.toml$/u, ""));
  }
  let question = -1;
  for (let index = start - 1; index >= 0 && start - index <= 4; index--) {
    if (/^(?:Allow execution of \[.+\]\?|Apply this change\?)$/u.test(content[index])) { question = index; break; }
  }
  if (labels.length < 2 || question < 0) return null;
  const asked = content[question];
  const exec = /^Allow execution of \[(.+)\]\?$/u.exec(asked);
  const kind: PermissionKind = exec ? (exec[1] === "Shell" ? "command" : "tool") : "edit";
  const header = box.top >= 0 ? /^\? (\S+)(?: {2}(.*?))?(?: {2,}\d+ of \d+)?$/u.exec(content[0]) : null;
  if (box.top >= 0 && !header) return null;
  // The command or diff: the inner box between the header and the question.
  let cut: "start" | "end" | undefined = box.top < 0 ? "start" : undefined;
  const inner: string[] = [];
  for (const row of content.slice(box.top >= 0 ? 1 : 0, question)) {
    if (HIDDEN_ROWS.test(row)) { cut ??= "end"; continue; }
    const text = innerBoxText(row);
    if (text !== null && (text || inner.length)) inner.push(text);
  }
  if (!trimBlank(inner).length) return null;
  const description = header?.[2] ?? "";
  let action = kind === "command" ? "Run a command" : `Use ${exec?.[1] ?? "a tool"}`;
  if (kind === "edit") {
    const target = /^(?:Writing to|Create) (.+)$/u.exec(description)?.[1] ?? /^(.+?): /u.exec(description)?.[1] ?? "";
    action = `${/^Create /u.test(description) ? "Create" : "Edit"} ${baseName(target) || "a file"}`;
  }
  const choices: PermissionChoice[] = [];
  let selected = -1;
  for (const [index, label] of labels.entries()) {
    if (/^Modify with external editor\b/u.test(label)) continue;
    const role: PermissionChoiceRole | null = index === 0 ? (/^Allow once\b/u.test(label) ? "allow" : null)
      : /^Allow\b/u.test(label) ? "allow-always" : /^No, suggest changes\b/u.test(label) ? "deny" : null;
    if (!role) return null;
    if (index === shown) selected = choices.length;
    choices.push(choiceOf(String(index + 1), role === "deny" ? "No, suggest changes" : label, role,
      role === "deny" ? "No" : /all future sessions/u.test(label) ? "Always allow" : /for this session/u.test(label) ? "Allow this session" : undefined));
  }
  if (!choices.some(choice => choice.role === "deny")) return null;
  return promptOf("gemini", kind, action, asked, asShown(trimBlank(inner)), choices, selected, cut);
}
const gemini: PromptSpec = {
  agent: "gemini",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const { all, shift } = withAbove(screen, rows);
    const last = lastContentRow(rows);
    // Gemini's own input box or footer can sit below the prompt.
    for (let bottom = last; bottom >= 0 && last - bottom <= 14; bottom--) {
      if (!/^\s*╰─{8,}╯$/u.test(rows[bottom])) continue;
      const prompt = readGeminiBox(all, shift + bottom);
      if (prompt) return prompt;
    }
    return null;
  },
  plan(_prompt, choice) {
    return [{ kind: "send", data: choice.id }];
  },
};

// Qwen Code (full screen by default): under the tool row ("? Shell npm
// test"), the command or diff, "Allow execution of: 'npm'?" or "Apply this
// change?", and numbered options with › on the highlighted one. A digit
// picks its option at once. "No, suggest changes" ends the turn; there is no
// note field. Only English labels are read.
const QWEN_OPTION = /^\s*(?:(›)\s+)?(\d{1,2})\.\s+(\S.*)$/u;
const qwen: PromptSpec = {
  agent: "qwen",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const last = lastContentRow(rows);
    let end = -1;
    for (let index = last; index >= 0 && last - index <= 20; index--) {
      const match = QWEN_OPTION.exec(rows[index]);
      if (match && /^No(?:, suggest changes \(esc\))?$/u.test(match[3])) { end = index; break; }
    }
    if (end < 0) return null;
    const options = numberedOptions(rows, end, screenWidth(rows), QWEN_OPTION);
    if (!options || options.labels[0] !== "Yes, allow once") return null;
    let question = -1;
    for (let index = options.start - 1; index >= 0 && options.start - index <= 3; index--) {
      if (!rows[index].trim()) continue;
      if (/^(?:Allow execution of: '.+'\?|Apply this change\?|Do you want to proceed\?)$/u.test(rows[index].trim())) question = index;
      break;
    }
    if (question < 0) return null;
    const asked = rows[question].trim();
    const kind: PermissionKind = asked.startsWith("Allow execution") ? "command" : asked === "Apply this change?" ? "edit" : "tool";
    const tools = kind === "command" ? /^Shell$/u : kind === "edit" ? /^(?:Edit|WriteFile|NotebookEdit)$/u : /^\S+$/u;
    // The tool row heads the input; full screen, so it may be off the top.
    let head = -1;
    for (let index = question - 1; index >= 0; index--) {
      const tool = /^\s*\? (\S+)(?: (.*))?$/u.exec(rows[index]);
      if (tool && tools.test(tool[1])) { head = index; break; }
    }
    let cut: "start" | "end" | undefined = head < 0 ? "start" : undefined;
    const body: string[] = [];
    for (const row of rows.slice(head + 1, question)) {
      if (HIDDEN_ROWS.test(row)) cut ??= "end";
      else if (!/^\s*⚠ /u.test(row)) body.push(row);
    }
    if (!trimBlank(body).length) return null;
    const description = head >= 0 ? /^\s*\? \S+ (.*)$/u.exec(rows[head])?.[1] ?? "" : "";
    const target = /^(?:Writing to|Create) (.+)$/u.exec(description)?.[1] ?? description;
    const action = kind === "command" ? "Run a command" : kind === "edit" ? `${/^Create /u.test(description) ? "Create" : "Edit"} ${baseName(target) || "a file"}` : "Approve a request";
    const choices: PermissionChoice[] = [];
    let selected = -1;
    for (const [index, label] of options.labels.entries()) {
      if (/^(?:Modify with external editor|Switch to Default Mode\b)/u.test(label)) continue;
      const role: PermissionChoiceRole | null = index === 0 ? "allow" : /^(?:Yes, allow always|Always allow\b|Allow always$)/u.test(label) ? "allow-always" : /^No\b/u.test(label) ? "deny" : null;
      if (!role) return null;
      if (index === options.selected) selected = choices.length;
      choices.push(choiceOf(String(index + 1), role === "deny" ? "No, suggest changes" : label, role,
        role === "deny" ? "No" : role === "allow" ? "Allow once" : / in this project$/u.test(label) ? "Allow in project" : / for this user$/u.test(label) ? "Allow for user" : "Always allow"));
    }
    if (!choices.some(choice => choice.role === "deny")) return null;
    return promptOf("qwen", kind, action, asked, asShown(trimBlank(body)), choices, selected, cut);
  },
  plan(_prompt, choice) {
    return [{ kind: "send", data: choice.id }];
  },
};

// Cursor Agent: under a rule, the command after "$" (or the file and its
// diff), the question, options with "→ " on the highlighted one and their
// key in parentheses, and the message box saying "Waiting for decision
// (y/n/p)...". y approves, Tab adds the command to the allowlist, and n
// declines and turns the message box into a field for what to do instead,
// where Enter with nothing typed skips the note.
const CURSOR_WAITING = /^\s*→\s+Waiting for decision \(y\/n\/p\)\.\.\.$/u;
const CURSOR_REASON = /Tell the agent what to do instead \(Enter to send, empty to skip, Esc to cancel\)/u;
const CURSOR_OPTION = /^\s*(?:(→)\s+)?(\S.*?)\s+\((y|tab|shift\+tab|esc or n|esc or n or p)\)$/u;
const CURSOR_QUESTIONS = new Map<string, PermissionKind>([["Run this command?", "command"], ["Run this command outside the sandbox?", "command"], ["Write to this file?", "edit"]]);
const cursor: PromptSpec = {
  agent: "cursor",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const last = lastContentRow(rows);
    let waiting = -1;
    for (let index = last; index >= 0 && last - index <= 3; index--) if (CURSOR_WAITING.test(rows[index])) { waiting = index; break; }
    if (waiting < 0) return null;
    let end = waiting - 1;
    while (end >= 0 && !rows[end].trim()) end--;
    const options: { label: string; key: string }[] = [];
    let selected = -1;
    let index = end;
    for (; index >= 0 && end - index < 8; index--) {
      const match = CURSOR_OPTION.exec(rows[index]);
      if (!match) break;
      options.unshift({ label: match[2], key: match[3] });
      if (match[1]) selected = index;
    }
    // A dim reason row ("in <path>") can sit between the question and the options.
    let question = index;
    let reason = "";
    if (!CURSOR_QUESTIONS.has(rows[question]?.trim() ?? "")) { reason = rows[question]?.trim() ?? ""; question--; }
    const asked = rows[question]?.trim() ?? "";
    const kind = CURSOR_QUESTIONS.get(asked);
    if (!kind || options.length < 2) return null;
    const { all, shift } = withAbove(screen, rows);
    const at = shift + question;
    let rule = -1;
    for (let row = at - 1; row >= 0; row--) {
      // The edit header has a rule of its own under the file name.
      if (SOLID_DIVIDER.test(all[row]) && !(kind === "edit" && /^\s/u.test(all[row]) && row > 0 && /\s[+-]\d+/u.test(all[row - 1]))) { rule = row; break; }
    }
    const body = trimBlank(all.slice(rule < 0 ? shift : rule + 1, at)).filter(row => !SOLID_DIVIDER.test(row));
    if (!body.length) return null;
    const cut = rule < 0 ? "start" : kind === "edit" && body.length > 40 ? "end" : undefined;
    const path = /^in (.+)$/u.exec(reason)?.[1] ?? "";
    const action = kind === "command" ? "Run a command" : `Edit ${baseName(path) || baseName(body[0].trim().split(/\s+/u)[0] ?? "") || "a file"}`;
    const choices: PermissionChoice[] = [];
    let shown = -1;
    for (const [position, option] of options.entries()) {
      const role: PermissionChoiceRole | null = option.key === "y" ? "allow" : option.key === "tab" && /^Add .+ to allowlist\?$/u.test(option.label) ? "allow-always"
        : option.key.startsWith("esc or n") ? "deny" : null;
      if (!role) continue;
      if (index + 1 + position === selected) shown = choices.length;
      choices.push(choiceOf(role === "allow" ? "y" : role === "allow-always" ? "tab" : "n", role === "deny" ? "No" : option.label, role,
        role === "allow" ? option.label : role === "allow-always" ? "Add to allowlist" : "No", role === "allow" ? "y" : role === "allow-always" ? "tab" : "n"));
    }
    if (choices[0]?.role !== "allow" || !choices.some(choice => choice.role === "deny")) return null;
    choices.push(choiceOf("n+note", "No, and tell Cursor Agent what to do instead", "deny-feedback", "Tell Cursor instead"));
    const dollar = kind === "command" && /^\s*\$\s/u.test(body[0]) ? body[0].replace(/^\s*\$\s+/u, "") : undefined;
    return promptOf("cursor", kind, action, asked, asShown(body, dollar), choices, shown, cut);
  },
  plan(_prompt, choice, feedback) {
    if (choice.role === "allow") return [{ kind: "send", data: "y" }];
    if (choice.role === "allow-always") return [{ kind: "send", data: "\t" }];
    const field = (screen: Screen) => !cursor.detect(screen) && bottomRows(screen, 6).some(row => CURSOR_REASON.test(row));
    if (choice.role === "deny" || !feedback) {
      return [
        { kind: "send", data: "n" },
        { kind: "wait", until: field, timeoutMs: 3000, failure: "Cursor Agent declined, but its note field did not show. Check the terminal." },
        { kind: "send", data: "\r" },
      ];
    }
    const typed = (screen: Screen) => !cursor.detect(screen) && showsNote(bottomRows(screen, 8), feedback);
    return noteSteps("Cursor Agent", [{ kind: "send", data: "n" }], field, typed, feedback);
  },
};

// GitHub Copilot CLI (full screen): a rounded box with a title, a rule, the
// command or diff, "Do you want to …?", numbered options with ❯ on the
// highlighted one, and "↑/↓ to navigate · enter to select · esc to cancel".
// A digit picks Yes options at once; on the last option, "No, and tell
// Copilot what to do differently", the row turns into a field (a digit only
// highlights it) and Enter sends the note. Esc declines.
const COPILOT_HINTS = ["↑/↓ to navigate · enter to select · esc to cancel"];
const COPILOT_OPTION = /^(?:(❯)| ) (\d{1,2})\. (\S.*)$/u;
const COPILOT_ESCAPE = "No, and tell Copilot what to do differently";
interface CopilotRead { prompt: PermissionPrompt; editing: boolean; note: string }
function readCopilot(screen: Screen): CopilotRead | null {
  const rows = screen.rows.map(cleanRowRight);
  const last = lastContentRow(rows);
  for (let bottom = last; bottom >= 0 && last - bottom <= 6; bottom--) {
    if (!/^\s*╰─{8,}╯$/u.test(rows[bottom])) continue;
    const box = boxAbove(rows, bottom);
    if (!box) continue;
    const content = box.content.map(row => row.replace(/^ /u, "").trimEnd());
    let end = content.length - 1;
    while (end >= 0 && !content[end].trim()) end--;
    if (end < 0 || !hintMatches(content[end], COPILOT_HINTS)) continue;
    end--;
    while (end >= 0 && !content[end].trim()) end--;
    let start = end;
    while (start > 0 && content[start - 1].trim()) start--;
    const parts: string[][] = [];
    let selected = -1;
    for (let index = start; index <= end; index++) {
      const match = COPILOT_OPTION.exec(content[index]);
      if (match && Number(match[2]) === parts.length + 1) {
        if (match[1]) selected = parts.length;
        parts.push([match[3]]);
      } else if (parts.length && /^ {2,}\S/u.test(content[index]) && !match) parts[parts.length - 1].push(content[index].trim());
      else { parts.length = 0; break; }
    }
    if (parts.length < 2) continue;
    const labels = parts.map(part => part.join(" ").replace(/ \(Esc to stop\)$/u, ""));
    const escape = labels.length - 1;
    // The highlighted last row is a text field: what it shows is typed text.
    const editing = selected === escape;
    if (labels[0] !== "Yes" || (!editing && labels[escape] !== COPILOT_ESCAPE && labels[escape] !== "No")) continue;
    if (labels.slice(1, escape).some(label => !/^Yes, /u.test(label))) continue;
    let question = start - 1;
    while (question >= 0 && !content[question].trim()) question--;
    const asked = content[question] ?? "";
    const verb = /^Do you want to (create|delete|edit|move and update|update|write|modify) (.+)\?$/u.exec(asked);
    const kind: PermissionKind | null = /^Do you want to run this command(?: outside the sandbox)?\?$/u.test(asked) ? "command"
      : verb || /^Do you want to move .+ to .+\?$/u.test(asked) ? "edit" : asked === "Do you want to use this tool?" || asked === "Do you want to allow this?" ? "tool"
        : asked === "Do you want to allow this access?" ? "fetch" : null;
    if (!kind) continue;
    // Under the title and its rule; the top of the box may be off the screen.
    const hasTitle = box.top >= 0 && /^─+$/u.test(content[1]?.trim() ?? "");
    if (box.top >= 0 && !hasTitle) continue;
    const body = trimBlank(content.slice(hasTitle ? 2 : 0, question)).flatMap(row => {
      const inner = innerBoxText(row);
      return inner === "" ? [] : [inner ?? row];
    });
    if (!body.length) continue;
    const name = baseName(verb?.[2] ?? "");
    const action = kind === "command" ? "Run a command" : kind === "edit" ? `${verb?.[1] === "create" ? "Create" : verb?.[1] === "delete" ? "Delete" : verb ? "Edit" : "Move"} ${name || "a file"}`
      : kind === "fetch" ? "Fetch a web page" : `Use ${content[0]?.trim() || "a tool"}`;
    const choices = labels.slice(0, escape).map((label, index) => choiceOf(String(index + 1), label, index === 0 ? "allow" : "allow-always",
      index === 0 ? "Yes" : /for the rest of the running session$/u.test(label) ? "Allow this session" : /don't ask again/u.test(label) ? "Don't ask again" : undefined));
    choices.push(choiceOf("esc", "No", "deny", "No"), choiceOf("note", COPILOT_ESCAPE, "deny-feedback", "Tell Copilot instead"));
    const prompt = promptOf("copilot", kind, action, asked, asShown(body), choices, editing ? -1 : selected, box.top < 0 ? "start" : undefined);
    return { prompt, editing, note: editing ? labels[escape] : "" };
  }
  return null;
}
const copilot: PromptSpec = {
  agent: "copilot",
  detect(screen) {
    const read = readCopilot(screen);
    return read && !read.editing ? read.prompt : null;
  },
  plan(prompt, choice, feedback) {
    if (choice.role === "allow" || choice.role === "allow-always") return [{ kind: "send", data: choice.id }];
    if (choice.role === "deny" || !feedback) return [{ kind: "send", data: "\x1b" }];
    const field = String(prompt.choices.filter(option => option.role === "allow" || option.role === "allow-always").length + 1);
    const opened = (screen: Screen) => !!readCopilot(screen)?.editing;
    const typed = (screen: Screen) => { const read = readCopilot(screen); return !!read?.editing && showsNote([read.note], feedback); };
    return noteSteps("GitHub Copilot CLI", [{ kind: "send", data: field }], opened, typed, feedback);
  },
};

// Crush (full screen): a dialog over the chat, "Permission Required" with a
// run of ╱, Tool / Path / Desc (or File) rows, the command or diff, the
// buttons "Allow", "Allow for Session" and "Deny" (the highlighted one only
// colored) and "←/→ choose • enter confirm • esc exit". a, s and d pick their
// button whichever is highlighted. A dialog whose content scrolls lists
// "shift+←↓↑→ scroll" in its hint: part of it is not on screen.
const CRUSH_HINTS = new Set(["←/→ choose", "enter confirm", "esc exit", "shift+←↓↑→ scroll", "t toggle diff view", "f toggle fullscreen"]);
const crush: PromptSpec = {
  agent: "crush",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const title = rows.findIndex(row => /│\s*Permission Required ╱+\s*│/u.test(row));
    if (title < 1) return null;
    const head = Array.from(rows[title]);
    const named = Array.from(rows[title].slice(0, rows[title].indexOf("Permission Required")));
    const left = named.lastIndexOf("│");
    const right = head.indexOf("│", named.length);
    let bottom = -1;
    for (let index = title + 1; index < rows.length; index++) {
      const chars = Array.from(rows[index]);
      if (chars[left] === "╰" && chars[right] === "╯") { bottom = index; break; }
      if (chars[left] !== "│" || chars[right] !== "│") return null;
    }
    const box = bottom > 0 ? boxAbove(rows, bottom, { overlay: true }) : null;
    if (!box || box.top !== title - 1) return null;
    const content = box.content.slice(1).map(row => row.trimEnd());
    const filled = content.flatMap((row, index) => row.trim() ? [index] : []);
    const hintAt = filled[filled.length - 1] ?? -1;
    const items = (content[hintAt] ?? "").trim().split(" • ");
    const cutHint = /…$/u.test(items[items.length - 1] ?? "");
    if (items[0] !== "←/→ choose" || items.slice(0, cutHint ? -1 : undefined).some(item => !CRUSH_HINTS.has(item))) return null;
    // The buttons on one row, or stacked when the dialog is narrow.
    const before = filled.filter(index => index < hintAt);
    let buttons = before[before.length - 1] ?? -1;
    let stacked = false;
    if (!/^\s*Allow {2,}Allow for Session {2,}Deny$/u.test(content[buttons] ?? "")) {
      const three = before.slice(-3).map(index => content[index].trim());
      if (three.join("|") !== "Allow|Allow for Session|Deny") return null;
      buttons = before[before.length - 3];
      stacked = true;
    }
    const lines = content.slice(0, buttons);
    const fields = new Map<string, string>();
    let last = -1;
    // The Tool / Path / Desc / File rows come one after another.
    for (const [index, row] of lines.entries()) {
      const field = /^\s*(Tool|Path|Desc|File) (.*)$/u.exec(row);
      if (field && (last < 0 || index === last + 1)) { fields.set(field[1], field[2].trim()); last = index; } else if (last >= 0) break;
    }
    const tool = fields.get("Tool");
    if (!tool) return null;
    const danger = lines.slice(0, last).filter(row => row.trim() && !/^\s*(Tool|Path|Desc|File) /u.test(row)).map(row => row.trim()).join(" ");
    const kind: PermissionKind = tool === "bash" ? "command" : /^(?:edit|write|multiedit|replace_symbol)$/u.test(tool) ? "edit" : /fetch/u.test(tool) ? "fetch" : "tool";
    const body = trimBlank(lines.slice(last + 1)).map(row => kind === "edit" ? row.replace(/\s*[┃│]$/u, "") : row);
    const file = fields.get("File") ?? "";
    const text = kind === "edit" ? [file, asShown(body)].filter(Boolean).join("\n") : asShown(body);
    if (!text) return null;
    const action = kind === "command" ? "Run a command" : kind === "edit" ? `Edit ${baseName(file) || "a file"}` : kind === "fetch" ? "Fetch a web page" : `Use ${tool}`;
    const scrolls = cutHint || items.includes("shift+←↓↑→ scroll");
    // The highlighted button differs only by its background.
    let selected = -1;
    if (screen.background) {
      const at = box.top + 2 + buttons;
      const labels = ["Allow", "Allow for Session", "Deny"];
      // Read inside the dialog only: the chat around it can hold the same words.
      let from = Array.from(rows[at]).slice(0, left + 1).join("").length;
      const keys = labels.map((label, step) => {
        const row = stacked ? at + step : at;
        const index = rows[row].indexOf(label, stacked ? Array.from(rows[row]).slice(0, left + 1).join("").length : from);
        if (!stacked) from = index + label.length;
        return index < 0 ? undefined : screen.background?.(row, index);
      });
      selected = oddOneOut(keys);
    }
    const choices = [
      choiceOf("a", "Allow", "allow", "Allow", "a"),
      choiceOf("s", "Allow for Session", "allow-always", "Allow for session", "s"),
      choiceOf("d", "Deny", "deny", "Deny", "d"),
    ];
    return promptOf("crush", kind, action, danger || "Permission Required", text, choices, selected, scrolls ? "end" : undefined);
  },
  plan(_prompt, choice) {
    return [{ kind: "send", data: choice.id }];
  },
};

// Kilo Code: OpenCode's panel, with "Allow" or "Allow once" alone for some
// requests, and a note field on every reject: Esc (its reject key) opens
// "△ Reject permission", where Enter sends the reject with or without a
// note.
function kiloButtons(row: string): PanelButtons | null {
  const match = /^\s*┃\s+(Allow once|Allow)(?: {2,}(Allow always))? {2,}(R[a-z]*)(?: {2,}(\S.*))?$/u.exec(row);
  if (!match || !"Reject".startsWith(match[3]) || (match[2] && match[1] !== "Allow once")) return null;
  const labels = [match[1], ...(match[2] ? [match[2]] : []), match[3]];
  if (!match[4]) return { labels, hint: false };
  return match[4].length >= 6 && OPENCODE_HINTS.some(hint => hint.startsWith(match[4])) ? { labels, hint: true } : null;
}
// The highlighted button: the one whose background differs from the bar's,
// read in the gap between the first two buttons.
function kiloSelected(screen: Screen, row: number, labels: readonly string[]): number {
  if (!screen.background) return -1;
  const text = screen.rows[row];
  let from = 0;
  const places = labels.map(label => {
    const index = text.indexOf(label, from);
    from = index + label.length;
    return index;
  });
  if (places.some(index => index < 0)) return -1;
  const gap = places[0] + labels[0].length + 1;
  return oddOneOut(places.map(index => screen.background?.(row, index)), screen.background(row, gap));
}
const kilo: PromptSpec = {
  agent: "kilo",
  detect(screen) {
    const panel = readOpencodePanel(screen, kiloButtons);
    if (!panel) return null;
    const [once, ...rest] = panel.labels;
    const always = rest.length === 2;
    const choices = [
      choiceOf("once", once, "allow", once),
      ...(always ? [choiceOf("always", "Allow always", "allow-always", "Allow always")] : []),
      choiceOf("reject", "Reject", "deny", "Reject"),
      choiceOf("reject+note", "Reject and tell Kilo Code what to do", "deny-feedback", "Tell Kilo instead"),
    ];
    return promptOf("kilo", panel.kind, panel.action, "Permission required", panel.subject, choices, kiloSelected(screen, panel.buttons, panel.labels));
  },
  plan(prompt, choice, feedback) {
    const rejecting = (screen: Screen) => !kilo.detect(screen) && screen.rows.some(row => /△ Reject permission/u.test(row)) && screen.rows.some(row => /Tell Kilo what to do differently/u.test(row));
    if (choice.role === "deny" || choice.role === "deny-feedback") {
      if (choice.role === "deny" || !feedback) {
        return [
          { kind: "send", data: "\x1b" },
          { kind: "wait", until: rejecting, timeoutMs: 3000, failure: "Kilo Code did not open its reject panel. Check the terminal." },
          { kind: "send", data: "\r" },
        ];
      }
      return noteSteps("Kilo Code", [{ kind: "send", data: "\x1b" }], rejecting, screen => rejecting(screen) && showsNote(bottomRows(screen, 16), feedback), feedback);
    }
    if (prompt.selected < 0) throw new Error("Could not tell which Kilo Code button is highlighted. Answer in the terminal.");
    const count = prompt.choices.filter(option => option.role !== "deny-feedback").length;
    const target = choice.role === "allow" ? 0 : 1;
    const moves = ARROW_RIGHT.repeat((target - prompt.selected + count) % count);
    const onTarget = (screen: Screen) => kilo.detect(screen)?.selected === target;
    return [
      ...(moves ? [{ kind: "send" as const, data: moves }, { kind: "wait" as const, until: onTarget, timeoutMs: 1500, failure: "Could not highlight the button in Kilo Code. Nothing was answered." }] : []),
      { kind: "send", data: "\r" },
      ...(target === 1 ? [
        { kind: "wait" as const, until: opencodeConfirming, timeoutMs: 2000, failure: "Kilo Code did not ask to confirm Allow always. Check the terminal." },
        { kind: "send" as const, data: "\r" },
      ] : []),
    ];
  },
};

// goose (approve and smart_approve modes): "Tool approval request" with the
// call as JSON, then a list: "◆  Goose would like to call the above tool, do
// you allow?", "│  ● Allow (…)", "│  ○ Always Allow", "│  ○ Deny",
// "│  ○ Cancel", "└". Only the arrows and Enter answer, and the list does not
// wrap. Esc cancels the whole reply, so Deny is picked from the list.
const GOOSE_QUESTIONS = ["Goose would like to call the above tool, do you allow?", "Do you allow this tool call?"];
const goose: PromptSpec = {
  agent: "goose",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const last = lastContentRow(rows);
    if (last < 3 || rows[last] !== "└") return null;
    const labels: string[] = [];
    let selected = -1;
    let index = last - 1;
    for (; index >= 0 && last - index <= 4; index--) {
      const match = /^│ {2}([●○]) (Allow|Always Allow|Deny|Cancel)(?: \((.+)\))?$/u.exec(rows[index]);
      if (!match) break;
      // Only the focused item shows its hint.
      if (match[3] && match[1] !== "●") return null;
      labels.unshift(match[2]);
      if (match[1] === "●") selected = selected < 0 ? last - index : -2;
    }
    const list = labels.join("|");
    if (selected < 0 || (list !== "Allow|Always Allow|Deny|Cancel" && list !== "Allow|Deny|Cancel")) return null;
    selected = labels.length - selected;
    const header = /^◆ {2}(.+)$/u.exec(rows[index] ?? "");
    if (!header || !GOOSE_QUESTIONS.includes(header[1])) return null;
    const { all, shift } = withAbove(screen, rows);
    const at = shift + index;
    let start = -1;
    for (let row = at - 1; row >= 0 && at - row <= 400; row--) if (all[row] === "  Tool approval request") { start = row; break; }
    const json = trimBlank(all.slice(start < 0 ? shift : start + 1, at));
    if (!json.length) return null;
    const text = json.join("\n");
    const tool = /"tool_name": "([^"]+)"/u.exec(text)?.[1] ?? "";
    const kind: PermissionKind = /(?:^|__)(?:shell|bash)$/u.test(tool) ? "command" : /(?:^|__)(?:edit|write|text_editor)$/u.test(tool) ? "edit" : "tool";
    const action = kind === "command" ? "Run a command" : kind === "edit" ? `Edit ${baseName(/"path": "([^"]+)"/u.exec(text)?.[1] ?? "") || "a file"}` : `Use ${tool || "a tool"}`;
    const choices = [
      choiceOf("allow", "Allow", "allow", "Allow"),
      ...(labels.includes("Always Allow") ? [choiceOf("always", "Always Allow", "allow-always", "Always allow")] : []),
      choiceOf("deny", "Deny", "deny", "Deny"),
    ];
    // `selected` is the row in the list; the choices are its first rows, Cancel after them.
    return promptOf("goose", kind, action, header[1], asShown(json), choices, selected, start < 0 ? "start" : undefined);
  },
  plan(prompt, choice) {
    const target = prompt.choices.indexOf(choice);
    const reached = (screen: Screen) => goose.detect(screen)?.selected === target;
    return [...arrowSteps("goose", prompt.selected, target, reached), { kind: "send", data: "\r" }];
  },
};

// Cline (full screen, with auto-approve off): "Cline needs permission",
// "Approve tool call?", the tool name, its input, and "[y] Approve   [n]
// Deny" (the highlighted one only colored). y and n answer whichever is
// highlighted. The panel is at most 14 rows tall and cuts what does not fit.
const cline: PromptSpec = {
  agent: "cline",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const last = lastContentRow(rows);
    let buttons = -1;
    for (let index = last; index >= 0 && last - index <= 4; index--) if (/^\s*\[y\] Approve\s+\[n\] Deny$/u.test(rows[index])) { buttons = index; break; }
    if (buttons < 0) return null;
    let title = -1;
    for (let index = buttons - 1; index >= 0 && buttons - index <= 16; index--) if (rows[index].trim() === "Cline needs permission") { title = index; break; }
    if (title < 0) return null;
    const inside = rows.slice(title + 1, buttons).filter(row => row.trim());
    if (inside[0]?.trim() !== "Approve tool call?" || !/^\s*[A-Za-z0-9_.-]+$/u.test(inside[1] ?? "") || inside.length < 3) return null;
    const tool = inside[1].trim();
    const params = inside.slice(2);
    const cap = Math.max(7, Math.min(14, Math.floor(screen.rows.length * 0.38)));
    const cut = buttons - title + 3 > cap || /\.\.\.$/u.test(params[params.length - 1].trim()) ? "end" : undefined;
    const kind: PermissionKind = tool === "run_commands" ? "command" : /^(?:editor|edit|write|apply_patch)$/u.test(tool) ? "edit" : "tool";
    const action = kind === "command" ? "Run a command" : tool === "apply_patch" ? "Apply a patch" : kind === "edit" ? `Edit ${baseName(params[0]) || "a file"}` : `Use ${tool}`;
    let selected = -1;
    if (screen.background) {
      const row = rows[buttons];
      const approve = row.indexOf("[y] Approve");
      const deny = row.indexOf("[n] Deny");
      selected = oddOneOut([screen.background(buttons, approve), screen.background(buttons, deny)], screen.background(buttons, approve + "[y] Approve".length + 1));
    }
    const choices = [choiceOf("y", "Approve", "allow", "Approve", "y"), choiceOf("n", "Deny", "deny", "Deny", "n")];
    return promptOf("cline", kind, action, "Approve tool call?", asShown(params), choices, selected, cut);
  },
  plan(_prompt, choice) {
    return [{ kind: "send", data: choice.id }];
  },
};

// Kimi Code: between rules, "▶ Run this command?" (or "Apply these edits?",
// "Write this file?"), the command or diff, the options "▶ 1. Approve once",
// "2. Approve for this session", "3. Reject", "4. Reject with feedback" and
// "↑/↓ select · 1/2/3/4 choose · ↵ confirm". A digit answers at once; 4 turns
// its row into a field for the note, sent with Enter.
const KIMI_HINTS = [
  "↑/↓ select · 1/2/3/4 choose · ↵ confirm · ctrl+e preview · shift+↑/↓ scroll",
  "↑/↓ select · 1/2/3/4 choose · ↵ confirm · shift+↑/↓ scroll",
  "↑/↓ select · 1/2/3/4 choose · ↵ confirm · ctrl+e preview",
  "↑/↓ select · 1/2/3/4 choose · ↵ confirm",
];
const KIMI_FEEDBACK_HINT = "Type feedback · ↵ submit.";
const KIMI_OPTION = /^\s*(?:(▶)\s)?\s*(\d)\. (\S.*)$/u;
interface KimiRead { prompt: PermissionPrompt; editing: boolean; note: string }
function readKimi(screen: Screen): KimiRead | null {
  const rows = screen.rows.map(cleanRowRight);
  const last = lastContentRow(rows);
  let hint = -1;
  for (let index = last; index >= 0 && last - index <= 4; index--) {
    const text = rows[index].trim();
    if (text === KIMI_FEEDBACK_HINT || hintMatches(text, KIMI_HINTS)) { hint = index; break; }
  }
  if (hint < 0) return null;
  const editing = rows[hint].trim() === KIMI_FEEDBACK_HINT;
  let end = hint - 1;
  while (end >= 0 && !rows[end].trim()) end--;
  const options = numberedOptions(rows, end, screenWidth(rows), KIMI_OPTION);
  if (!options || options.labels.length !== 4) return null;
  const [once, session, reject, feedback] = options.labels;
  if (once !== "Approve once" || session !== "Approve for this session" || reject !== "Reject" || !feedback.startsWith("Reject with feedback")) return null;
  if (!editing && feedback !== "Reject with feedback") return null;
  const { all, shift } = withAbove(screen, rows);
  const at = shift + options.start;
  let heading = -1;
  for (let index = at - 1; index >= 0; index--) {
    if (/^\s*▶ \S.*\?(?: {2}\S+)?$/u.test(all[index])) { heading = index; break; }
    if (SOLID_DIVIDER.test(all[index])) return null;
  }
  const asked = heading >= 0 ? /^\s*▶ (.*?\?)(?: {2}\S+)?$/u.exec(all[heading])?.[1] ?? "" : "";
  const kind: PermissionKind = asked === "Run this command?" ? "command" : asked === "Apply these edits?" || asked === "Write this file?" ? "edit" : "tool";
  let cut: "start" | "end" | undefined = heading < 0 ? "start" : undefined;
  const body: string[] = [];
  for (const row of all.slice(heading < 0 ? shift : heading + 1, at)) {
    if (/^\s*… \d+ more (?:change|line)/u.test(row)) cut ??= "end";
    else body.push(row);
  }
  const input = trimBlank(body);
  if (!input.length) return null;
  const path = asked === "Apply these edits?" ? /^\s*\+\d+ -\d+ (.+)$/u.exec(input[0])?.[1] ?? "" : asked === "Write this file?" ? input[0].trim() : "";
  const action = kind === "command" ? "Run a command" : kind === "edit" ? `${asked === "Write this file?" ? "Write" : "Edit"} ${baseName(path) || "a file"}`
    : /^Approve (.+)\?$/u.exec(asked) ? `Use ${/^Approve (.+)\?$/u.exec(asked)?.[1]}` : "Approve a request";
  const choices = [
    choiceOf("1", "Approve once", "allow", "Approve once"),
    choiceOf("2", "Approve for this session", "allow-always", "Approve this session"),
    choiceOf("3", "Reject", "deny", "Reject"),
    choiceOf("4", "Reject with feedback", "deny-feedback", "Tell Kimi instead"),
  ];
  const prompt = promptOf("kimi", kind, action, asked || "Approval required", asShown(input), choices, options.selected, cut);
  return { prompt, editing, note: editing ? feedback.replace(/^Reject with feedback\s*/u, "") : "" };
}
const kimi: PromptSpec = {
  agent: "kimi",
  detect(screen) {
    const read = readKimi(screen);
    return read && !read.editing ? read.prompt : null;
  },
  plan(_prompt, choice, feedback) {
    if (choice.role !== "deny-feedback") return [{ kind: "send", data: choice.id }];
    if (!feedback) return [{ kind: "send", data: "3" }];
    const opened = (screen: Screen) => !!readKimi(screen)?.editing;
    const typed = (screen: Screen) => { const read = readKimi(screen); return !!read?.editing && showsNote([read.note], feedback); };
    return noteSteps("Kimi Code", [{ kind: "send", data: "4" }], opened, typed, feedback);
  },
};

// CodeBuddy Code: a rule, the tool title ("Bash command", "Edit file"), the
// command (at most three rows) or the diff in a box, another rule, "Do you
// want to …?" and numbered options with "> " on the highlighted one and
// their shortcut in parentheses. A digit picks its option at once. "No"
// ends the turn; there is no note field.
const CODEBUDDY_OPTION = /^\s*(?:(>)\s+)?(\d{1,2})\.\s+(\S.*)$/u;
const CODEBUDDY_DENY = "No, and tell CodeBuddy what to do differently";
const CODEBUDDY_TITLE = /^(Bash command|PowerShell command|Edit file|Create file|Multi Edit file|Fetch|Tool use|Confirm)(?: \(\d+\/\d+\))?(?: · @\S+)?$/u;
const codebuddy: PromptSpec = {
  agent: "codebuddy",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const last = lastContentRow(rows);
    const plain = (label: string) => label.replace(/\s+\((?:shift \+ tab|escape)\)$/u, "");
    let end = -1;
    for (let index = last; index >= 0 && last - index <= 3; index--) {
      const match = CODEBUDDY_OPTION.exec(rows[index]);
      if (match && plain(match[3]) === CODEBUDDY_DENY) { end = index; break; }
    }
    if (end < 0) return null;
    const options = numberedOptions(rows, end, screenWidth(rows), CODEBUDDY_OPTION);
    if (!options) return null;
    const labels = options.labels.map(plain);
    if (labels[0] !== "Yes" || labels.slice(1, -1).some(label => !/^Yes, /u.test(label))) return null;
    let question = options.start - 1;
    while (question >= 0 && options.start - question <= 3 && !rows[question].trim()) question--;
    const asked = rows[question]?.trim() ?? "";
    const edit = /^Do you want to (make this edit to|create|multi edit) (.+)\?$/u.exec(asked);
    if (!edit && !/^Do you want to (?:proceed(?:\(.*\))?|allow CodeBuddy to fetch this content)\?$/u.test(asked)) return null;
    let rule = question - 1;
    while (rule >= 0 && !rows[rule].trim()) rule--;
    if (rule < 0 || !SOLID_DIVIDER.test(rows[rule])) return null;
    const { all, shift } = withAbove(screen, rows);
    let top = -1;
    for (let index = shift + rule - 1; index >= 0; index--) if (SOLID_DIVIDER.test(all[index])) { top = index; break; }
    const title = top >= 0 ? all[top + 1]?.trim() ?? "" : "";
    const named = CODEBUDDY_TITLE.exec(title);
    if (top >= 0 && !named) return null;
    const heading = named?.[1] ?? "";
    const kind: PermissionKind = edit || /file$/u.test(heading) ? "edit" : /command$/u.test(heading) ? "command" : heading === "Fetch" ? "fetch" : "tool";
    const body = trimBlank(all.slice(top < 0 ? shift : top + 2, shift + rule)).flatMap(row => {
      const inner = kind === "edit" ? innerBoxText(row) : null;
      return inner === "" ? [] : [inner ?? row];
    });
    if (!body.length) return null;
    // A command is cut to three rows without a mark, and a description row may follow it.
    const cut = top < 0 ? "start" : kind === "command" && body.filter(row => row.trim()).length >= 3 ? "end" : undefined;
    const action = kind === "command" ? "Run a command" : kind === "edit" ? `${edit?.[1] === "create" ? "Create" : "Edit"} ${baseName(edit?.[2] ?? "") || "a file"}`
      : kind === "fetch" ? "Fetch a web page" : "Approve a request";
    const choices = labels.map((label, index) => {
      if (index === labels.length - 1) return choiceOf(String(index + 1), "No", "deny", "No");
      return choiceOf(String(index + 1), label, index === 0 ? "allow" : "allow-always", index === 0 ? "Yes" : /don't ask again (?:for |this )?session$/u.test(label) ? "Allow this session" : undefined);
    });
    return promptOf("codebuddy", kind, action, asked, asShown(body), choices, options.selected, cut);
  },
  plan(_prompt, choice) {
    return [{ kind: "send", data: choice.id }];
  },
};

// Letta Code: a rule, "Run this command?" (or "Update <file>?" and a diff
// between dotted rules), the command, then "❯ 1. Yes", "2. Yes, and don't
// ask again …" and a last row that is a field: "No, and tell Letta Code what
// to do differently". 1 and 2 answer at once. Declining takes a note: the
// field is reached with the arrows and sent with Enter (empty is ignored).
// Esc is no answer here: it cancels every pending approval.
const LETTA_FIELD = "No, and tell Letta Code what to do differently";
const LETTA_OPTION = /^(?:(❯)| ) (\d)\. ?(.*)$/u;
interface LettaRead { prompt: PermissionPrompt; editing: boolean; note: string; field: number }
function readLetta(screen: Screen): LettaRead | null {
  const rows = screen.rows.map(cleanRowRight);
  const last = lastContentRow(rows);
  const hint = rows[last]?.trim() ?? "";
  const editing = hint === "Type reason · Esc to cancel" || hint === "Enter to submit · Esc to clear";
  if (!editing && hint !== "Enter to select · Esc to cancel") return null;
  let end = last - 1;
  while (end >= 0 && !rows[end].trim()) end--;
  let start = end;
  while (start > 0 && LETTA_OPTION.test(rows[start - 1])) start--;
  const labels: string[] = [];
  let selected = -1;
  for (let index = start; index <= end; index++) {
    const match = LETTA_OPTION.exec(rows[index]);
    if (!match || Number(match[2]) !== labels.length + 1) return null;
    if (match[1]) selected = labels.length;
    labels.push(match[3]);
  }
  const field = labels.length - 1;
  if ((labels.length !== 2 && labels.length !== 3) || labels[0] !== "Yes" || (labels.length === 3 && !/^Yes, /u.test(labels[1]))) return null;
  // Outside the field, its row shows the placeholder (with a cursor while highlighted).
  const placeholder = labels[field].replace(/█$/u, "").trimEnd();
  if (!editing && placeholder !== LETTA_FIELD) return null;
  const { all, shift } = withAbove(screen, rows);
  const at = shift + start;
  let rule = -1;
  for (let index = at - 1; index >= 0; index--) if (SOLID_DIVIDER.test(all[index])) { rule = index; break; }
  const heading = rule >= 0 ? all[rule + 1]?.trim() ?? "" : "";
  const edit = /^(?:(Update|Write to|Overwrite|Edit|Delete) (.+)|Apply patch(?: to \d+ files)?)\?$/u.exec(heading);
  if (rule >= 0 && heading !== "Run this command?" && !edit) return null;
  const kind: PermissionKind = rule < 0 ? "tool" : edit ? "edit" : "command";
  let cut: "start" | "end" | undefined = rule < 0 ? "start" : undefined;
  const body: string[] = [];
  for (const row of all.slice(rule < 0 ? shift : rule + 2, at)) {
    if (DASHED_DIVIDER.test(row)) continue;
    if (/^\s*… \+\d+ more lines$/u.test(row)) cut ??= "end";
    else body.push(row);
  }
  const input = trimBlank(body);
  if (!input.length) return null;
  const action = kind === "command" ? "Run a command" : kind === "edit" ? (edit?.[2] ? `${edit[1] === "Delete" ? "Delete" : edit[1] === "Write to" ? "Write" : "Edit"} ${baseName(edit[2])}` : "Apply a patch") : "Approve a request";
  const choices = labels.slice(0, field).map((label, index) => choiceOf(String(index + 1), label, index === 0 ? "allow" : "allow-always", index === 0 ? "Yes" : /^Yes, and don't ask again\b/u.test(label) ? "Don't ask again" : undefined));
  choices.push(choiceOf("note", LETTA_FIELD, "deny-feedback", "Tell Letta instead"));
  const prompt = promptOf("letta", kind, action, heading || "Approval required", asShown(input), choices, selected, cut);
  return { prompt, editing, note: editing ? placeholder : "", field };
}
const letta: PromptSpec = {
  agent: "letta",
  detect(screen) {
    const read = readLetta(screen);
    return read && !read.editing ? read.prompt : null;
  },
  plan(prompt, choice, feedback) {
    if (choice.role !== "deny-feedback") return [{ kind: "send", data: choice.id }];
    if (!feedback) throw new Error("Letta Code declines only with a note. Type what to do instead.");
    const field = prompt.choices.length - 1;
    const opened = (screen: Screen) => { const read = readLetta(screen); return !!read?.editing && read.prompt.selected === read.field; };
    const typed = (screen: Screen) => { const read = readLetta(screen); return !!read?.editing && showsNote([read.note], feedback); };
    // The highlight stops at the ends, so Down reaches the field from anywhere above it.
    const from = prompt.selected < 0 ? 0 : prompt.selected;
    return noteSteps("Letta Code", from < field ? [{ kind: "send", data: ARROW_DOWN.repeat(field - from) }] : [], opened, typed, feedback);
  },
};

// Factory Droid: "Command to approve" and "↳ <command>" (or "Edit <file>:
// (+1 added, -1 removed)" over the diff), a rounded box of options, the
// highlighted one only bold, and "↑↓ navigate · Enter select · Esc cancel".
// Only the arrows and Enter pick a Yes option; Esc declines.
const DROID_HINTS = [
  "↑↓ navigate · Enter select · Esc cancel · Alt/Option+E to inspect approval details",
  "↑↓ navigate · Enter select · Esc cancel · Ctrl+O expand diff · Alt/Option+E to inspect approval details",
  "↑↓ navigate · Enter select · Esc cancel · Ctrl+O collapse · Alt/Option+E to inspect approval details",
];
const droid: PromptSpec = {
  agent: "droid",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const last = lastContentRow(rows);
    if (last < 3 || !/^ {2}↑↓ /u.test(rows[last]) || !hintMatches(rows[last], DROID_HINTS)) return null;
    const box = boxAbove(rows, last - 1);
    if (!box || box.top < 0) return null;
    const options: { label: string; row: number }[] = [];
    for (const [index, row] of box.content.entries()) {
      const text = row.trim();
      if (/^(?:Yes, |No, |Always allow )/u.test(text)) options.push({ label: text, row: box.top + 1 + index });
      else if (text && options.length) options[options.length - 1].label += ` ${text}`;
      else if (text) return null;
    }
    const labels = options.map(option => option.label);
    if (labels.length < 2 || labels[0] !== "Yes, allow" || labels[labels.length - 1] !== "No, cancel") return null;
    if (labels.slice(1, -1).some(label => !/^(?:Yes, and always allow |Always allow )/u.test(label))) return null;
    const { all, shift } = withAbove(screen, rows);
    const top = shift + box.top;
    let kind: PermissionKind | null = null;
    let input: string[] = [];
    let cut: "start" | "end" | undefined;
    let action = "Run a command";
    let question = "Command to approve";
    for (let index = top - 1; index >= 0 && top - index <= 8 && !kind; index--) {
      const command = /^ {2}↳ (.*)$/u.exec(all[index]);
      if (command && /^ {2}Command to approve(?: \(allowlisted\))?(?: · (?:low|medium|high) risk)?$/u.test(all[index - 1] ?? "")) {
        kind = "command";
        question = all[index - 1].trim();
        input = [command[1]];
        // The command is one row cut to the pane width.
        if (/…$/u.test(command[1]) || Array.from(all[index]).length >= (screen.cols ?? screenWidth(rows)) - 1) cut = "end";
      }
    }
    if (!kind) {
      for (let index = top - 1; index >= 0 && top - index <= 40; index--) {
        const header = /^(Edit|Create) (.+?): \((?:no changes|[+-]\d+ (?:added|removed)(?:, -\d+ removed)?)\)(?: → .+)?$/u.exec(all[index]);
        if (!header) continue;
        kind = "edit";
        question = all[index];
        action = `${header[1]} ${baseName(header[2]) || "a file"}`;
        for (const row of all.slice(index + 1, top)) {
          if (/^\s*│?\s*\.\.\. \d+ more lines, press Ctrl\+O to expand/u.test(row)) { cut = "end"; continue; }
          const inner = innerBoxText(row);
          if (inner) input.push(inner);
        }
        input = [header[2], ...input];
        break;
      }
    }
    if (!kind) return null;
    // The highlighted option is the only bold one.
    let selected = -1;
    if (screen.style) {
      const bold = options.map(option => {
        const index = rows[option.row].indexOf(option.label.slice(0, 6));
        return index < 0 ? undefined : screen.style?.(option.row, index)?.endsWith(":bold");
      });
      const marked = bold.flatMap((value, index) => value ? [index] : []);
      selected = bold.every(value => value !== undefined) && marked.length === 1 ? marked[0] : -1;
    }
    const choices = labels.map((label, index) => index === 0 ? choiceOf("1", label, "allow", "Yes, allow")
      : index === labels.length - 1 ? choiceOf("esc", "No, cancel", "deny", "No")
        : choiceOf(String(index + 1), label, "allow-always", /^Yes, and always allow (\w+) impact/u.exec(label) ? `Allow ${/^Yes, and always allow (\w+) impact/u.exec(label)?.[1]} impact` : undefined));
    return promptOf("droid", kind, action, question, asShown(input), choices, selected, cut);
  },
  plan(prompt, choice) {
    if (choice.role === "deny") return [{ kind: "send", data: "\x1b" }];
    const target = prompt.choices.indexOf(choice);
    const reached = (screen: Screen) => droid.detect(screen)?.selected === target;
    return [...arrowSteps("Factory Droid", prompt.selected, target, reached), { kind: "send", data: "\r" }];
  },
};

// Kiro CLI: "<tool> requires approval", the "<capability> → <resource>"
// row, options with ❯ on the highlighted one, and "esc to close · ↑↓ to
// navigate · ↵ to select · Tab to edit". Only the arrows and Enter answer;
// Tab on "No" opens a field ("Modify request") sent with Enter. Esc is no
// answer here: it cancels the whole turn. Trust rows open more options, so
// they are not offered.
const KIRO_ALLOW = ["Yes, single permission", "Allow once"];
const KIRO_DENY = ["No (Tab to edit)", "Deny once"];
const KIRO_OTHER = ["Trust, always allow in this session", "Trust, allow all for this session", "Create allow rule to approve future similar actions", "Create deny rule to block future similar actions"];
interface KiroRead { prompt: PermissionPrompt; editing: boolean }
function readKiro(screen: Screen): KiroRead | null {
  const rows = screen.rows.map(cleanRowRight);
  const last = lastContentRow(rows);
  let footer = -1;
  for (let index = last; index >= 0 && last - index <= 1; index--) {
    const text = rows[index].trim();
    if (text.startsWith("esc to close") && text.includes("to navigate") && text.includes("to select")) { footer = index; break; }
  }
  if (footer < 0) return null;
  let end = footer - 1;
  if (end >= 0 && SOLID_DIVIDER.test(rows[end])) end--;
  while (end >= 0 && !rows[end].trim()) end--;
  const labels: string[] = [];
  let selected = -1;
  let index = end;
  for (; index >= 0 && end - index < 6; index--) {
    const match = /^\s*(❯|>)?\s+(\S.*)$/u.exec(rows[index]);
    if (!match || ![...KIRO_ALLOW, ...KIRO_DENY, ...KIRO_OTHER].includes(match[2])) break;
    labels.unshift(match[2]);
    if (match[1]) selected = selected < 0 ? end - index : -2;
  }
  if (labels.length < 2 || selected < 0) return null;
  selected = labels.length - 1 - selected;
  while (index >= 0 && !rows[index].trim()) index--;
  const context = /^\s*(\S+) → (.+)$/u.exec(rows[index] ?? "");
  if (context) index--;
  const title = /^\s*(.+?) requires approval(?: · (Modify request|trust options))?$/u.exec(rows[index] ?? "");
  if (!title || title[2] === "trust options") return null;
  const allow = labels.findIndex(label => KIRO_ALLOW.includes(label));
  const deny = labels.findIndex(label => KIRO_DENY.includes(label));
  if (allow < 0 || deny < 0) return null;
  const tool = title[1].split(/\s+/u).pop() ?? "";
  const resource = context?.[2].trim() ?? "";
  const kind: PermissionKind = /shell|bash|execute/iu.test(tool) ? "command" : /write|edit|replace/iu.test(tool) ? "edit" : "tool";
  const action = kind === "command" ? "Run a command" : kind === "edit" ? `Edit ${baseName(resource) || "a file"}` : `Use ${tool}`;
  // Without the resource row, or with a long one cut to its first line, the request is not readable in full.
  const cut = !resource || /…$|\bexpand\b/u.test(resource) ? "end" : undefined;
  const choices = [
    choiceOf(String(allow), labels[allow], "allow", "Allow once"),
    choiceOf(String(deny), labels[deny], "deny", "No"),
    choiceOf(`${deny}+note`, "No, and tell Kiro what to do instead", "deny-feedback", "Tell Kiro instead"),
  ];
  return { prompt: promptOf("kiro", kind, action, `${title[1]} requires approval`, resource, choices, selected, cut), editing: title[2] === "Modify request" };
}
const kiro: PromptSpec = {
  agent: "kiro",
  detect(screen) {
    const read = readKiro(screen);
    return read && !read.editing ? read.prompt : null;
  },
  plan(prompt, choice, feedback) {
    const row = (id: string) => Number(id.replace(/\+note$/u, ""));
    const target = row(choice.id);
    const reached = (screen: Screen) => kiro.detect(screen)?.selected === target;
    const moves = arrowSteps("Kiro CLI", prompt.selected, target, reached);
    if (choice.role !== "deny-feedback" || !feedback) return [...moves, { kind: "send", data: "\r" }];
    const drilled = (screen: Screen) => bottomRows(screen, 16).some(row => /requires approval · Modify request$/u.test(row.trim()));
    return noteSteps("Kiro CLI", [...moves, { kind: "send", data: "\t" }], drilled, screen => drilled(screen) && showsNote(bottomRows(screen, 12), feedback), feedback);
  },
};

// Warp (full screen): "■ Is it OK if I run this command and read the
// output?" (or "… make these file edits?"), the command (an editor of up to
// four rows) or the diff, "(1) yes", "(2) no", "(3) Other" (the highlighted
// one only colored) and "Esc to cancel  Enter to run". A digit answers at
// once; 3 opens a field for what to do instead, sent with Enter.
const WARP_QUESTIONS = new Map<string, PermissionKind>([["Is it OK if I run this command and read the output?", "command"], ["Is it OK if I make these file edits?", "edit"]]);
interface WarpRead { prompt: PermissionPrompt; editing: boolean; note: string }
function readWarp(screen: Screen): WarpRead | null {
  const rows = screen.rows.map(cleanRowRight);
  const last = lastContentRow(rows);
  if (last < 4 || rows[last].trim() !== "Esc to cancel  Enter to run") return null;
  let end = last - 1;
  while (end >= 0 && !rows[end].trim()) end--;
  const other = /^\s*\(3\) Other(?:: ?(.*))?$/u.exec(rows[end] ?? "");
  if (!other || !/^\s*\(2\) no$/u.test(rows[end - 1] ?? "") || !/^\s*\(1\) yes$/u.test(rows[end - 2] ?? "")) return null;
  const editing = other[1] !== undefined;
  const first = end - 2;
  let header = -1;
  let asked = "";
  for (let index = first - 1; index >= 0 && first - index <= 40; index--) {
    const match = /^\s*■ (.+?\?)(?: {2,}(?:e to edit command|e to expand\/collapse))?$/u.exec(rows[index]);
    if (match && WARP_QUESTIONS.has(match[1])) { header = index; asked = match[1]; break; }
  }
  const kind = WARP_QUESTIONS.get(asked) ?? "tool";
  const input = trimBlank(rows.slice(header + 1, first));
  if (!input.length) return null;
  const cut = header < 0 ? "start" : kind === "command" && input.length >= 4 ? "end" : undefined;
  let selected = -1;
  if (screen.style) {
    const keys = [0, 1, 2].map(step => {
      const row = first + step;
      const index = rows[row].indexOf(`(${step + 1})`);
      return index < 0 ? undefined : screen.style?.(row, index);
    });
    selected = oddOneOut(keys);
  }
  const files = input.map(row => /^\s*(?:Created|Deleted|Updated) (.+?)(?: → .+)?$/u.exec(row)?.[1]).filter(Boolean);
  const action = kind === "command" ? "Run a command" : kind === "edit" ? (files.length === 1 ? `Edit ${baseName(files[0] ?? "")}` : "Edit files") : "Approve a request";
  const choices = [choiceOf("1", "Yes", "allow", "Yes"), choiceOf("2", "No", "deny", "No"), choiceOf("3", "Other: tell Warp what to do instead", "deny-feedback", "Tell Warp instead")];
  return { prompt: promptOf("warp", kind, action, asked || "Approval required", asShown(input), choices, selected, cut), editing, note: other[1] ?? "" };
}
const warp: PromptSpec = {
  agent: "warp",
  detect(screen) {
    const read = readWarp(screen);
    return read && !read.editing ? read.prompt : null;
  },
  plan(_prompt, choice, feedback) {
    if (choice.role !== "deny-feedback") return [{ kind: "send", data: choice.id }];
    if (!feedback) return [{ kind: "send", data: "2" }];
    const opened = (screen: Screen) => !!readWarp(screen)?.editing;
    const typed = (screen: Screen) => { const read = readWarp(screen); return !!read?.editing && showsNote([read.note], feedback); };
    return noteSteps("Warp", [{ kind: "send", data: "3" }], opened, typed, feedback);
  },
};

// Aider: a line prompt under the command, path or URL (printed in reverse
// video): "Run shell command? (Y)es/(N)o/(D)on't ask again [Yes]: ". Answers
// are typed and sent with Enter; a bare Enter means the default (Yes), so
// every answer is sent as its letter.
const AIDER_QUESTIONS = new Map<string, PermissionKind>([
  ["Run shell command?", "command"], ["Run shell commands?", "command"],
  ["Allow edits to file that has not been added to the chat?", "edit"], ["Create new file?", "edit"],
  ["Add file to the chat?", "tool"], ["Add URL to the chat?", "fetch"],
]);
const AIDER_SUFFIX = /^(.+?\?)\(Y\)es\/\(N\)o(\/\(A\)ll)?(?:\/\(S\)kipall)?(?:\/\(D\)on'taskagain)?\[(?:Yes|No)\]:$/u;
const aider: PromptSpec = {
  agent: "aider",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const last = lastContentRow(rows);
    const width = screen.cols ?? screenWidth(rows);
    // The question wraps at the pane edge; it is read without white space,
    // which a wrap can drop.
    let first = -1;
    let asked = "";
    let all = false;
    for (let count = 1; count <= 4 && last - count + 1 >= 0 && first < 0; count++) {
      const from = last - count + 1;
      if (rows.slice(from, last).some(row => Array.from(row).length < width - 2)) break;
      const match = AIDER_SUFFIX.exec(compact(rows.slice(from, last + 1).join("")));
      const question = match ? [...AIDER_QUESTIONS.keys()].find(text => compact(text) === match[1]) : undefined;
      if (question && match) { first = from; asked = question; all = !!match[2]; }
    }
    if (first < 1) return null;
    // The input: the reverse video rows right above, or the rows up to the blank row above them.
    const inverse = (row: number) => !!screen.background?.(row, 0)?.startsWith("inverse:");
    let top = first - 1;
    const marked = inverse(top);
    while (top > 0 && (marked ? inverse(top - 1) : !!rows[top - 1].trim())) top--;
    const input = rows.slice(top, first).map(row => row.trimEnd());
    if (!input.some(row => row.trim())) return null;
    const cut = top === 0 && (marked || !!rows[0].trim()) ? "start" : undefined;
    const kind = AIDER_QUESTIONS.get(asked) ?? "tool";
    const name = baseName(input[0]);
    const action = kind === "command" ? (asked === "Run shell commands?" ? "Run commands" : "Run a command")
      : asked === "Create new file?" ? `Create ${name}` : kind === "edit" ? `Edit ${name}` : kind === "fetch" ? "Add a web page to the chat" : `Add ${name} to the chat`;
    const choices = [
      choiceOf("y", "Yes", "allow", "Yes", "y"),
      ...(all ? [choiceOf("a", "Yes to all", "allow-always", "Yes to all", "a")] : []),
      choiceOf("n", "No", "deny", "No", "n"),
    ];
    return promptOf("aider", kind, action, asked, asShown(input), choices, -1, cut);
  },
  plan(_prompt, choice) {
    return [{ kind: "send", data: `${choice.id}\r` }];
  },
};

// Auggie 0.x (with an ask-user rule): a rounded box "Tool Approval
// Required" naming the call ("Terminal: npm test", "Edit File: <path>")
// over the tool's own description, and "[A]llow [D]eny" under it. a and d
// answer.
const AUGGIE_LABELS = new Map<string, PermissionKind>([["Terminal", "command"], ["Edit File", "edit"], ["Save File", "edit"], ["Remove Files", "edit"], ["Web Fetch", "fetch"]]);
const auggie: PromptSpec = {
  agent: "auggie",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const last = lastContentRow(rows);
    if (last < 3 || rows[last].trim() !== "[A]llow [D]eny") return null;
    const { all, shift } = withAbove(screen, rows);
    const box = boxAbove(all, shift + last - 1);
    if (!box) return null;
    const content = box.content.filter(row => row.trim());
    if (box.top >= 0 && content[0]?.trim() !== "Tool Approval Required") return null;
    // The call: "Terminal: <command>", "Edit File: <path>", or "<path>: read file".
    const call = box.top >= 0 ? content[1] ?? "" : "";
    const labeled = /^ {2}([A-Z][A-Za-z]*(?: [A-Z][A-Za-z]*)?): (.+)$/u.exec(call.trimEnd());
    const read = /^ {2}(.+): read file$/u.exec(call.trimEnd());
    const label = labeled && AUGGIE_LABELS.has(labeled[1]) ? labeled[1] : "";
    if (box.top >= 0 && !label && !read) return null;
    const value = label ? labeled?.[2] ?? "" : read?.[1] ?? "";
    const kind = AUGGIE_LABELS.get(label) ?? "tool";
    // A call too long for its row wraps into the description below it.
    const cut = box.top < 0 ? "start" : Array.from(call.trimEnd()).length >= Array.from(call).length - 2 ? "end" : undefined;
    const subject = box.top < 0 ? asShown(content) : value;
    const action = box.top < 0 ? "Approve a request" : kind === "command" ? "Run a command" : kind === "fetch" ? "Fetch a web page"
      : label === "Save File" ? `Save ${baseName(value)}` : label === "Remove Files" ? "Remove files" : kind === "edit" ? `Edit ${baseName(value)}` : `Read ${baseName(value)}`;
    const choices = [choiceOf("a", "Allow", "allow", "Allow", "a"), choiceOf("d", "Deny", "deny", "Deny", "d")];
    return promptOf("auggie", kind, action, "Tool Approval Required", subject, choices, -1, cut);
  },
  plan(_prompt, choice) {
    return [{ kind: "send", data: choice.id }];
  },
};

// ForgeCode (restricted mode): "How would you like to proceed? ❯" (after
// "Modify file: `<path>`." and the like), a count row, and "▌ Accept",
// "▌ Reject", "▌ Accept and Remember", the highlighted one only colored.
// Typed letters filter the list, so only the arrows and Enter pick Accept;
// Esc rejects.
const FORGE_LABELS = ["Accept", "Reject", "Accept and Remember"];
const forgecode: PromptSpec = {
  agent: "forgecode",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const last = lastContentRow(rows);
    const list = last - 2;
    if (list < 2 || FORGE_LABELS.some((label, index) => rows[list + index] !== `▌ ${label}`)) return null;
    if (!/^ {2}3\/3(?: ─*)?$/u.test(rows[list - 1])) return null;
    const asked = /^(?:(.+)\. )?How would you like to proceed\? ❯$/u.exec(rows[list - 2]);
    if (!asked) return null;
    const message = asked[1] ?? "";
    const path = /`(.+)`/u.exec(message)?.[1] ?? "";
    let kind: PermissionKind = "tool";
    let action = "Approve a request";
    let input = message;
    let cut: "start" | "end" | undefined = Array.from(rows[list - 2]).length >= (screen.cols ?? screenWidth(rows)) ? "end" : undefined;
    if (!message) {
      // A command: the title line printed right above the question.
      const { all, shift } = withAbove(screen, rows);
      const at = shift + list - 2;
      let title = -1;
      for (let index = at - 1; index >= 0 && at - index <= 40; index--) if (/^● \[\d{2}:\d{2}:\d{2}\] Execute \[[^\]]+\] /u.test(all[index])) { title = index; break; }
      kind = "command";
      action = "Run a command";
      const shown = all.slice(title < 0 ? shift : title, at);
      input = asShown(shown, title < 0 ? undefined : shown[0].replace(/^● \[\d{2}:\d{2}:\d{2}\] Execute \[[^\]]+\] /u, ""));
      if (title < 0) cut = "start";
    } else if (/^(?:Modify file(?: with \d+ edits)?|Create\/overwrite file|Remove file): /u.test(message)) {
      kind = "edit";
      action = `${/^Remove/u.test(message) ? "Remove" : /^Create/u.test(message) ? "Write" : "Edit"} ${baseName(path) || "a file"}`;
    } else if (/^Fetch content from URL: /u.test(message)) {
      kind = "fetch";
      action = "Fetch a web page";
    } else if (/^Read file: /u.test(message)) action = `Read ${baseName(path) || "a file"}`;
    if (!input.trim()) return null;
    const selected = screen.background ? oddOneOut([0, 1, 2].map(step => screen.background?.(list + step, 0))) : -1;
    const choices = [choiceOf("accept", "Accept", "allow", "Accept"), choiceOf("reject", "Reject", "deny", "Reject"), choiceOf("remember", "Accept and Remember", "allow-always", "Accept and remember")];
    return promptOf("forgecode", kind, action, "How would you like to proceed?", input, choices, selected, cut);
  },
  plan(prompt, choice) {
    if (choice.role === "deny") return [{ kind: "send", data: "\x1b" }];
    const target = prompt.choices.indexOf(choice);
    const reached = (screen: Screen) => forgecode.detect(screen)?.selected === target;
    return [...arrowSteps("ForgeCode", prompt.selected, target, reached), { kind: "send", data: "\r" }];
  },
};

// Mistral Vibe (full screen): a box with "Permission for the <tool> tool",
// the command or diff, "1. Allow once", "2. Allow for remainder of this
// session", "3. Always allow", "4. Deny" (the highlighted one only colored)
// and "↑↓/jk navigate  Enter select  Esc reject". A digit answers at once.
// The box is at most 70% of the screen and scrolls what does not fit.
const VIBE_OPTIONS = ["1. Allow once", "2. Allow for remainder of this session", "3. Always allow", "4. Deny"];
const vibe: PromptSpec = {
  agent: "vibe",
  detect(screen) {
    const rows = screen.rows.map(cleanRowRight);
    const last = lastContentRow(rows);
    let bottom = -1;
    for (let index = last; index >= 0 && last - index <= 2; index--) if (/^\s*└─{8,}┘$/u.test(rows[index])) { bottom = index; break; }
    const box = bottom > 0 ? boxAbove(rows, bottom, { corners: "┌┐└┘" }) : null;
    if (!box) return null;
    const content = box.content.map(row => row.replace(/^ /u, "").trimEnd());
    let end = content.length - 1;
    while (end >= 0 && !content[end].trim()) end--;
    if (end < 5 || !hintMatches(content[end], ["↑↓/jk navigate  Enter select  Esc reject"])) return null;
    end--;
    while (end >= 0 && !content[end].trim()) end--;
    const start = end - 3;
    if (start < 0 || VIBE_OPTIONS.some((option, index) => content[start + index].trim() !== option)) return null;
    let detail = 0;
    let title = "";
    let match: RegExpExecArray | null = null;
    if (box.top >= 0) {
      for (; detail < Math.min(4, start) && !match; detail++) {
        title = `${title} ${content[detail].trim()}`.trim();
        match = /^Permission for the (\S+) tool(?: \((.*)\))?$/u.exec(title);
      }
      if (!match) return null;
    }
    const input = trimBlank(content.slice(detail, start));
    if (!input.length) return null;
    const cut = box.top < 0 ? "start" : bottom - box.top + 1 >= Math.floor(screen.rows.length * 0.7) ? "end" : undefined;
    const tool = match?.[1] ?? "";
    const kind: PermissionKind = /^(?:file_system\.)?bash$|^shell$/u.test(tool) ? "command" : /^(?:file_system\.)?(?:edit|write_file)$/u.test(tool) ? "edit" : "tool";
    const file = /^File: (.+)$/u.exec(input[0].trim())?.[1] ?? "";
    const action = kind === "command" ? "Run a command" : kind === "edit" ? `Edit ${baseName(file) || "a file"}` : tool ? `Use ${tool}` : "Approve a request";
    const selected = screen.background ? oddOneOut([0, 1, 2, 3].map(step => {
      const row = box.top + 1 + start + step;
      return screen.background?.(row, Math.max(0, rows[row].indexOf(VIBE_OPTIONS[step])));
    })) : -1;
    const choices = [
      choiceOf("1", "Allow once", "allow", "Allow once"),
      choiceOf("2", "Allow for remainder of this session", "allow-always", "Allow this session"),
      choiceOf("3", "Always allow", "allow-always", "Always allow"),
      choiceOf("4", "Deny", "deny", "Deny"),
    ];
    return promptOf("vibe", kind, action, title || "Permission required", asShown(input), choices, selected, cut);
  },
  plan(_prompt, choice) {
    return [{ kind: "send", data: choice.id }];
  },
};

// Kilo Code after OpenCode: without a hint, OpenCode's panel reads as
// OpenCode's; the pane's agent decides (see detectPermissionPrompt).
const SPECS: PromptSpec[] = [claude, codex, opencode, kilo, antigravity, gemini, qwen, cursor, copilot, crush, goose, cline, kimi, codebuddy, letta, droid, kiro, warp, aider, auggie, forgecode, vibe];

// A tmux window split side by side draws a pane border down one column. Its
// rows mix two panes, and keys would reach only one of them. The rows of a
// box an agent draws (a border at both ends) are not a pane border.
function splitSideBySide(rows: readonly string[]): boolean {
  if (rows.length < 4) return false;
  const counts = new Map<number, number>();
  for (const row of rows) {
    const text = row.trim();
    if (text.length > 1 && text.startsWith("│") && text.endsWith("│")) continue;
    const chars = Array.from(row);
    for (let index = 2; index < chars.length; index++) if (chars[index] === "│") counts.set(index, (counts.get(index) ?? 0) + 1);
  }
  return [...counts.values()].some(count => count >= rows.length * 0.8);
}

/**
 * The approval prompt on screen, if any. Some agents draw the very same
 * prompt (Kilo Code keeps OpenCode's panel); `agent`, the agent known to run
 * in the pane, reads such a screen as that agent's prompt.
 */
export function detectPermissionPrompt(screen: Screen, agent?: string): PermissionPrompt | null {
  if (splitSideBySide(screen.rows)) return null;
  const specs = agent ? [...SPECS.filter(spec => spec.agent === agent), ...SPECS.filter(spec => spec.agent !== agent)] : SPECS;
  for (const spec of specs) {
    const prompt = spec.detect(screen);
    if (prompt) return screen.cols === undefined ? prompt : { ...prompt, cols: screen.cols };
  }
  return null;
}

/** The keys (and checks between them) that answer `prompt` with a choice. */
export function permissionAnswerPlan(prompt: PermissionPrompt, choiceId: string, feedback = ""): AnswerStep[] {
  const spec = SPECS.find(candidate => candidate.agent === prompt.agent);
  const choice = prompt.choices.find(candidate => candidate.id === choiceId);
  if (!spec || !choice) throw new Error("That answer is not offered by this prompt.");
  return spec.plan(prompt, choice, sanitizePermissionFeedback(feedback));
}


