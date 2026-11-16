import type { Terminal } from "@xterm/xterm";
import { EDGE_SLACK, FRAME_ROW, blockWrapEdge, cachedRows, indentOf, lastNonSpace, type Row, type WrapEdge } from "./links";

// Copying text a program wrapped to fit the terminal. xterm only knows the
// wraps it made itself (soft wraps); tmux repaints rows one by one and agent
// TUIs wrap their own output, so a long command or path usually reaches the
// buffer as several separate rows. Copied as they are, a command split in two
// runs as two commands when pasted. Rows are joined only where the layout
// proves the program wrapped them, and every other line break is kept.

const LIST_MARKER = /^(?:[-*+•]|\d{1,3}[.)]) /;
// What only ever starts a line: a list item, a quote or a shell prompt.
const LINE_START = /^(?:[-*+•>$#%]|\d{1,3}[.)])(?: |$)/;
// Selections this long (most of the scrollback) copy with xterm's own wraps
// only, so a large copy stays instant.
const MAX_JOINED_ROWS = 400;

/** How a row continues the one above: xterm's soft wrap, a token cut at the wrap width, or a word moved down. */
export type RowJoin = "soft" | "token" | "word";

/**
 * How `lower` continues `upper`, or null when the break between them is a
 * real line end. A program wraps at its width (`wrap`): it moves a word down
 * only when the word would not fit after the row's last text, and cuts a
 * token only when the token is longer than a whole row. A break before a
 * word that would have fit was made on purpose and is kept.
 */
export function rowJoin(upper: Row, lower: Row, wrap: WrapEdge, cols: number): RowJoin | null {
  if (lower.wrapped) return "soft";
  // A frame or rule row is never part of the text around it.
  if (FRAME_ROW.test(upper.text) || FRAME_ROW.test(lower.text)) return null;
  const last = lastNonSpace(upper.text);
  const upperIndent = indentOf(upper.text);
  const lowerIndent = indentOf(lower.text);
  if (last < 0 || lowerIndent >= lower.text.length) return null;
  // Wrapped rows line up under the row they continue, or under the text of a
  // list item (past its marker). Deeper rows are nested code, not a wrap.
  const marker = LIST_MARKER.exec(upper.text.slice(upperIndent))?.[0].length ?? 0;
  if (lowerIndent !== upperIndent && (!marker || lowerIndent !== upperIndent + marker)) return null;
  // A row that opens a list item, a quote or a prompt starts a new line.
  if (LINE_START.test(lower.text.slice(lowerIndent))) return null;
  const end = upper.cells[last].x;
  const word = lower.text.slice(lowerIndent).split(" ")[0];
  const wordWidth = lower.cells[lowerIndent + word.length - 1].x - lower.cells[lowerIndent].x + 1;
  if (end + 1 + wordWidth <= wrap.column) return null;
  const tokenStart = upper.text.lastIndexOf(" ", last) + 1;
  const tailWidth = end - upper.cells[tokenStart].x + 1;
  const rowWidth = wrap.column - upper.cells[upperIndent].x + 1;
  if (end >= wrap.column - EDGE_SLACK && tailWidth + wordWidth > rowWidth) {
    // A cut token: the wrap width must be real (other rows reach it), unless
    // the row runs into the terminal edge itself.
    return wrap.shared || end >= cols - 1 - EDGE_SLACK ? "token" : null;
  }
  // A moved word: only where several rows show the width the program wraps at.
  return wrap.shared ? "word" : null;
}

/**
 * The selected text with the rows a program wrapped joined back into one
 * line (a cut token without a space, a moved word with one). Undefined when
 * nothing is selected or the selection is too long to inspect, so the caller
 * falls back to xterm's own copy.
 */
export function joinedSelection(term: Terminal): string | undefined {
  const range = term.getSelectionPosition();
  if (!range || range.end.y - range.start.y > MAX_JOINED_ROWS) return undefined;
  // xterm reports buffer cells 0-based, the end column exclusive.
  const { start, end } = range;
  const buffer = term.buffer.active;
  const read = cachedRows(term);
  let text = "";
  let previous: Row | undefined;
  for (let y = start.y; y <= end.y; y++) {
    const line = buffer.getLine(y);
    const row = read(y);
    if (!line || !row) break;
    const piece = line.translateToString(false, y === start.y ? start.x : 0, y === end.y ? end.x : term.cols);
    if (!previous) text = piece;
    else {
      const join = rowJoin(previous, row, blockWrapEdge(read, term.cols, y - 1, indentOf(previous.text)), term.cols);
      if (join === "soft") text += piece;
      else if (join === "token") text = text.trimEnd() + piece.trimStart();
      else if (join === "word") text = `${text.trimEnd()} ${piece.trimStart()}`;
      else text = `${text.trimEnd()}\n${piece}`;
    }
    previous = row;
  }
  return text.trimEnd();
}
