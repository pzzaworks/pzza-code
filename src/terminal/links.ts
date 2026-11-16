import type { IDisposable, Terminal } from "@xterm/xterm";

// Plain-text URL detection that survives line breaks. tmux repaints every row
// on its own and TUIs (agents) hard-wrap their output, so a long URL usually
// arrives as several rows without xterm's soft-wrap flag. A row continues the
// URL on the next row when the URL runs into the right edge and the next row
// (after an optional hanging indent) carries on with URL characters.

// Same URL shape as xterm's web-links addon.
const URL_PATTERN = /(https?|HTTPS?):[/]{2}[^\s"'!*(){}|\\^<>`]*[^\s"':,.!?{}|\\^~[\]`()<>]/g;
const URL_START = /(https?|HTTPS?):[/]{2}/;
const URL_CHAR = /[^\s"'!*(){}|\\^<>`]/;
const URL_PIECE = /[/?=&#%._~:+-]/;
const TRAILING_PUNCTUATION = /[.,;:!?'")\]}]+$/;
// Absolute and home-relative file paths ("/Users/me/x.ts", "~/notes"), not
// preceded by text that would make them part of a word or a URL. Spaces end a
// path; at least one character must follow the slash.
const PATH_PATTERN = /(?<![\w:/.~@-])~?\/[A-Za-z0-9._@%+=,~-][A-Za-z0-9._@%+=,~/-]*/g;
const PATH_START = /^["'`(\[]?~?\/[A-Za-z0-9._@%+=,~-]/;
// TUIs wrap at their own width, which can sit a couple of cells inside the
// terminal edge (padding, scrollbar gutters).
export const EDGE_SLACK = 2;
// Hanging indent an agent puts before continuation rows.
const MAX_INDENT = 8;
// Bound how far a single lookup walks so hovering stays cheap.
const MAX_ROWS = 16;

/** A buffer cell, 0-based. */
export interface TerminalCell { x: number; y: number }

export interface TerminalLink {
  text: string;
  /** A web address, or a file path that opens in Finder. */
  kind: "url" | "path";
  start: TerminalCell;
  end: TerminalCell;
  /** Every cell the link text occupies, excluding indents between rows. */
  cells: TerminalCell[];
}

export interface Row { text: string; cells: TerminalCell[]; wrapped: boolean }

export function readRow(term: Terminal, y: number): Row | undefined {
  const line = term.buffer.active.getLine(y);
  if (!line) return;
  const cells: TerminalCell[] = [];
  let text = "";
  const reuse = line.getCell(0);
  for (let x = 0; x < term.cols; x++) {
    const cell = line.getCell(x, reuse);
    if (!cell) break;
    // The trailing half of a wide character carries no text of its own.
    if (cell.getWidth() === 0) continue;
    const chars = cell.getChars() || " ";
    for (let i = 0; i < chars.length; i++) cells.push({ x, y });
    text += chars;
  }
  return { text, cells, wrapped: line.isWrapped };
}

export function lastNonSpace(text: string): number {
  for (let i = text.length - 1; i >= 0; i--) if (text[i] !== " ") return i;
  return -1;
}

export const indentOf = (text: string): number => text.length - text.trimStart().length;

export type RowReader = (y: number) => Row | undefined;

/** Reads each buffer row once per lookup: a hover or a copy reads the same rows many times. */
export function cachedRows(term: Terminal): RowReader {
  const rows = new Map<number, Row | undefined>();
  return (y) => {
    if (!rows.has(y)) rows.set(y, readRow(term, y));
    return rows.get(y);
  };
}

// Continuation rows of a wrapped list item sit under the item's text, past its
// marker ("- ", "* ", "1. "), so up to this many cells right of its first row.
export const MAX_HANGING_INDENT = 4;
// Rows drawn only with box characters (an agent's input frame, rules) span
// the whole terminal and say nothing about the width text wraps at.
export const FRAME_ROW = /^[\s─-▟]*$/;

// The column text wraps at around row `y`: a TUI's own width (agents keep a
// right margin), read from nearby rows of the same block: the same indent, or
// up to a hanging indent less (the first row of a wrapped list item), never
// deeper (other output, such as a diff, often runs to the terminal edge). It
// is their widest end, and counts as a real wrap width (`shared`) only when at
// least two rows reach it: wrapped text keeps running into its width, while a
// list or a log has one longest line. Rows xterm wrapped itself end at the
// terminal edge whatever the program's width, and frame rows span the
// terminal, so neither is read.
export interface WrapEdge { column: number; shared: boolean }
export function blockWrapEdge(read: RowReader, cols: number, y: number, indent: number): WrapEdge {
  const ends: number[] = [];
  let below = read(Math.max(0, y - MAX_ROWS));
  for (let row = Math.max(0, y - MAX_ROWS); row <= y + MAX_ROWS && below; row++) {
    const current = below;
    below = read(row + 1);
    const last = lastNonSpace(current.text);
    const rowIndent = indentOf(current.text);
    if (last < 0 || rowIndent > indent || rowIndent < indent - MAX_HANGING_INDENT || FRAME_ROW.test(current.text) || current.wrapped || below?.wrapped) continue;
    ends.push(current.cells[last].x);
  }
  if (!ends.length) return { column: cols - 1, shared: false };
  const widest = Math.max(...ends);
  return { column: widest, shared: ends.filter((end) => end >= widest - EDGE_SLACK).length > 1 };
}

// Geometry only: the upper row's content touches the wrap edge with a URL
// character and the lower row resumes with URL characters. Returns how many
// leading cells of the lower row to drop, or undefined when the rows do not join.
function continuation(term: Terminal, read: RowReader, upper: Row, lower: Row): number | undefined {
  if (lower.wrapped) return 0;
  const last = lastNonSpace(upper.text);
  if (last < 0 || !URL_CHAR.test(upper.text[last])) return;
  const wrap = blockWrapEdge(read, term.cols, upper.cells[last].y, indentOf(upper.text));
  if (upper.cells[last].x < wrap.column - EDGE_SLACK) return;
  // Short of the terminal edge, the wrap width must be real: other rows reach
  // it too, or this row is a single token too long to fit, so it was cut.
  const atTerminalEdge = upper.cells[last].x >= term.cols - 1 - EDGE_SLACK;
  if (!atTerminalEdge && !wrap.shared && upper.text.trim().includes(" ")) return;
  const indent = lower.text.length - lower.text.trimStart().length;
  if (indent > MAX_INDENT || !URL_CHAR.test(lower.text[indent] ?? " ")) return;
  // Word-wrapped prose also breaks near the edge, so the resumed token must
  // read as part of a URL: it carries path or query punctuation, or it is too
  // long for a word and runs into the edge itself. An upper row that is one
  // bare token without the URL start, cut at the very last column, is
  // already mid-URL, so any tail follows.
  const token = lower.text.slice(indent).split(" ")[0];
  const fillsRow = lower.cells[indent + token.length - 1].x >= wrap.column - EDGE_SLACK;
  const midUrl = upper.cells[last].x >= wrap.column && !upper.text.trim().includes(" ") && !URL_START.test(upper.text);
  if (!midUrl && !fillsRow && !URL_PIECE.test(token.replace(TRAILING_PUNCTUATION, ""))) return;
  return indent;
}

function trailingToken(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.slice(trimmed.lastIndexOf(" ") + 1);
}

/** URLs and file paths on buffer row `y` (0-based), each joined across the rows it spans. */
export function terminalLinksAt(term: Terminal, y: number): TerminalLink[] {
  const read = cachedRows(term);
  const here = read(y);
  if (!here) return [];
  // Walk up while rows could be one URL, then build segments downward, only
  // joining a hard break when the text before it really ends inside a URL.
  let first = y;
  let lower = here;
  while (first > 0 && y - first < MAX_ROWS) {
    const upper = read(first - 1);
    if (!upper || continuation(term, read, upper, lower) === undefined) break;
    first--;
    lower = upper;
  }
  let segment: Row | undefined;
  let previous: Row | undefined;
  for (let row = first; row <= y + MAX_ROWS; row++) {
    const current = row === y ? here : read(row);
    if (!current) break;
    const indent = segment && previous ? continuation(term, read, previous, current) : undefined;
    const joins = segment !== undefined && indent !== undefined &&
      (current.wrapped || URL_START.test(trailingToken(segment.text)) || PATH_START.test(trailingToken(segment.text)));
    if (segment && joins && indent !== undefined) {
      // Hard breaks drop the trailing blanks above and the indent below.
      if (!current.wrapped) {
        const keep = lastNonSpace(segment.text) + 1;
        segment.text = segment.text.slice(0, keep);
        segment.cells = segment.cells.slice(0, keep);
      }
      segment.text += current.text.slice(indent);
      segment.cells = segment.cells.concat(current.cells.slice(indent));
    } else {
      if (row > y) break;
      segment = { text: current.text, cells: current.cells.slice(), wrapped: current.wrapped };
    }
    previous = current;
  }
  if (!segment) return [];
  const links: TerminalLink[] = [];
  const urlSpans: Array<[number, number]> = [];
  for (const match of segment.text.matchAll(URL_PATTERN)) {
    const index = match.index ?? 0;
    urlSpans.push([index, index + match[0].length]);
    const cells = segment.cells.slice(index, index + match[0].length);
    if (!cells.some(cell => cell.y === y)) continue;
    try { new URL(match[0]); } catch { continue; }
    links.push({ text: match[0], kind: "url", start: cells[0], end: cells[cells.length - 1], cells });
  }
  // File paths, outside any URL; trailing sentence punctuation is not part of them.
  for (const match of segment.text.matchAll(PATH_PATTERN)) {
    const index = match.index ?? 0;
    const text = match[0].replace(TRAILING_PUNCTUATION, "");
    if (text.replace(/^~/, "").length < 2 || urlSpans.some(([start, end]) => index < end && index + text.length > start)) continue;
    const cells = segment.cells.slice(index, index + text.length);
    if (!cells.some(cell => cell.y === y)) continue;
    links.push({ text, kind: "path", start: cells[0], end: cells[cells.length - 1], cells });
  }
  return links;
}

/** The link covering buffer cell (x, y), 0-based. */
export function terminalLinkAt(term: Terminal, x: number, y: number): TerminalLink | undefined {
  return terminalLinksAt(term, y).find(link => link.cells.some(cell => cell.x === x && cell.y === y));
}

export function registerTerminalLinks(term: Terminal, activate: (event: MouseEvent, text: string, kind: TerminalLink["kind"]) => void): IDisposable {
  return term.registerLinkProvider({
    provideLinks(bufferLineNumber, callback) {
      const links = terminalLinksAt(term, bufferLineNumber - 1);
      callback(links.length ? links.map(link => ({
        text: link.text,
        range: { start: { x: link.start.x + 1, y: link.start.y + 1 }, end: { x: link.end.x + 1, y: link.end.y + 1 } },
        activate: (event: MouseEvent) => activate(event, link.text, link.kind),
      })) : undefined);
    },
  });
}
