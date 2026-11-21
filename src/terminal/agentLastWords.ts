// What a coding agent last said in its terminal, read from the pane's text,
// so a notice about a finished turn can say it instead of a stock sentence.
// Agents draw their input box and hints at the bottom; everything from the
// first line of that area down is left out. Claude Code marks each of its
// messages with "⏺" (tool calls too, as `⏺ Bash(…)`); for other agents the
// last paragraph of plain text above the input area is taken.

const MAX_LENGTH = 220;
// A rule or box edge an input area is drawn with.
const RULE = /^\s*[─━═╭╮╰╯┌┐└┘│┃\s]+$/;
// Claude Code: a message line, a tool call, a tool result.
const MESSAGE = /^⏺\s+(.*)$/;
const TOOL_CALL = /^⏺\s+[\w.-]+\(/;
// Notes Claude Code prints on its own while idle (compaction, recaps): not a turn's message.
const HOUSEKEEPING = /^(Compacted\b|Conversation compacted\b|※ recap\b)/i;

function clean(line: string): string {
  return line.replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "").replace(/[\x00-\x08\x0b-\x1f\x7f]/g, "").replace(/\s+$/, "");
}

/** The pane's lines above the agent's input area (and its hints below it). */
function aboveInput(lines: readonly string[]): string[] {
  const text = lines.map(clean);
  let end = text.length;
  while (end > 0 && !text[end - 1].trim()) end--;
  // The input area is the last rule-framed block within the bottom rows.
  const floor = Math.max(0, end - 14);
  for (let at = end - 1; at >= floor; at--) {
    if (RULE.test(text[at]) && text[at].trim()) {
      // Walk up to the rule that opens it.
      let top = at - 1;
      while (top >= floor && !(RULE.test(text[top]) && text[top].trim())) top--;
      return text.slice(0, top >= floor ? top : at);
    }
  }
  return text.slice(0, end);
}

function shorten(text: string): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > MAX_LENGTH ? `${flat.slice(0, MAX_LENGTH - 1).trimEnd()}…` : flat;
}

/**
 * The last thing the agent said, shortened to one line, or null when there
 * is no message of its own (only tool output, housekeeping or nothing).
 * `agent` is the catalog id: Claude Code's own messages are marked, so for
 * it nothing else (hints, status lines) is ever taken.
 */
export function agentLastWords(lines: readonly string[], agent?: string): string | null {
  const text = aboveInput(lines);
  // Claude Code: the last "⏺" message that is not a tool call, with the
  // lines that continue it (indented, not a tool result).
  for (let at = text.length - 1; at >= 0; at--) {
    const match = text[at].match(MESSAGE);
    if (!match) continue;
    if (TOOL_CALL.test(text[at])) continue;
    const parts = [match[1]];
    for (let next = at + 1; next < text.length; next++) {
      const line = text[next];
      if (!line.trim()) { parts.push(""); continue; }
      // Continuation is indented a little; far-right status text and tool results are not.
      const indent = line.length - line.trimStart().length;
      if (indent < 1 || indent > 6 || line.trimStart().startsWith("⎿")) break;
      parts.push(line.trim());
    }
    const message = parts.join(" ");
    if (HOUSEKEEPING.test(message)) return null;
    return shorten(message) || null;
  }
  if (agent === "claude") return null;
  // Any other agent: the last paragraph of text above its input area.
  let end = text.length;
  while (end > 0 && !text[end - 1].trim()) end--;
  let start = end;
  while (start > 0 && text[start - 1].trim()) start--;
  const paragraph = text.slice(start, end).map(line => line.trim()).filter(line => !RULE.test(line) && !line.startsWith("⎿"));
  return paragraph.length ? shorten(paragraph.join(" ")) || null : null;
}

/** Whether the agent's last words ask the user something. */
export function asksUser(words: string): boolean {
  return /\?\s*(\(.*\))?$/.test(words.trim());
}

/**
 * Whether the agent's last message is a note it printed on its own while
 * idle (compacting, a recap) rather than the end of a turn.
 */
export function endsWithHousekeeping(lines: readonly string[]): boolean {
  const text = aboveInput(lines);
  for (let at = text.length - 1; at >= 0; at--) {
    const match = text[at].match(MESSAGE);
    if (match && !TOOL_CALL.test(text[at])) return HOUSEKEEPING.test(match[1]);
    if (text[at].startsWith("※ recap")) return true;
  }
  return false;
}
