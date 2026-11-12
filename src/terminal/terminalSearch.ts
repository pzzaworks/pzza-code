// Search across every open terminal's scrollback. Each mounted terminal
// registers a target that reads its xterm buffer as logical lines (wrapped
// rows joined) and can reveal one match: scroll to it, select it and mark
// every match with the find decorations. Searching runs one terminal at a
// time, yields to the UI between chunks and stops as soon as its signal aborts.

// Opens the search panel (App listens), from the command palette or elsewhere.
export const OPEN_TERMINAL_SEARCH_EVENT = "pzza:search-terminals";
export function openTerminalSearch(): void {
  window.dispatchEvent(new Event(OPEN_TERMINAL_SEARCH_EVENT));
}

export interface SearchLine { text: string; row: number }
export interface RevealRequest { row: number; col: number; length: number; query: string; regex: boolean }
export interface SearchTarget {
  lines(): Promise<SearchLine[]>;
  cols(): number;
  reveal(request: RevealRequest): void;
}

const targets = new Map<string, SearchTarget>();

export function registerSearchTarget(tileId: string, target: SearchTarget): () => void {
  targets.set(tileId, target);
  return () => { if (targets.get(tileId) === target) targets.delete(tileId); };
}

export function revealInTerminal(tileId: string, request: RevealRequest): boolean {
  const target = targets.get(tileId);
  if (!target) return false;
  target.reveal(request);
  return true;
}

export interface TerminalMatch {
  tileId: string;
  /** 1-based logical line number in the terminal's buffer. */
  line: number;
  row: number;
  col: number;
  length: number;
  text: string;
  start: number;
  end: number;
  before: string;
  after: string;
}

export interface TileMatches { tileId: string; matches: TerminalMatch[]; capped: boolean }

export const MAX_TOTAL_MATCHES = 200;
export const MAX_TILE_MATCHES = 50;
// Bounds a single pattern run: very long lines (minified output) are searched
// up to this length, so a costly expression cannot stall on one line.
const MAX_LINE_LENGTH = 20000;
const CONTEXT_LENGTH = 240;
const CHUNK_LINES = 2000;

const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

// Case-insensitive; plain text is matched literally. Throws on an invalid
// regular expression, with the reason for the panel to show.
export function compileQuery(query: string, regex: boolean): RegExp | null {
  if (!query) return null;
  try {
    return new RegExp(regex ? query : escapeRegExp(query), "gi");
  } catch (error) {
    throw new Error(error instanceof SyntaxError ? `Invalid regular expression: ${error.message.replace(/^Invalid regular expression: /, "")}` : "Invalid regular expression.");
  }
}

const yieldToUi = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

function clip(text: string): string {
  const trimmed = text.trimEnd();
  return trimmed.length > CONTEXT_LENGTH ? `${trimmed.slice(0, CONTEXT_LENGTH)}…` : trimmed;
}

// Matches in one terminal's lines, at most `limit`. Positions map back to
// buffer cells through the column count; wide characters can shift the column
// estimate left, and the reveal's search then lands on the real match.
export async function matchLines(tileId: string, lines: SearchLine[], cols: number, pattern: RegExp, limit: number, signal?: AbortSignal): Promise<{ matches: TerminalMatch[]; capped: boolean }> {
  const matches: TerminalMatch[] = [];
  const re = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
  for (let index = 0; index < lines.length; index++) {
    if (index && index % CHUNK_LINES === 0) {
      await yieldToUi();
      if (signal?.aborted) return { matches, capped: false };
    }
    const { text, row } = lines[index];
    const haystack = text.length > MAX_LINE_LENGTH ? text.slice(0, MAX_LINE_LENGTH) : text;
    re.lastIndex = 0;
    for (let found = re.exec(haystack); found; found = re.exec(haystack)) {
      if (!found[0].length) { re.lastIndex++; continue; }
      if (matches.length >= limit) return { matches, capped: true };
      const start = found.index;
      const width = Math.max(1, cols);
      matches.push({
        tileId, line: index + 1, row: row + Math.floor(start / width), col: start % width, length: found[0].length,
        text, start, end: start + found[0].length,
        before: index > 0 ? clip(lines[index - 1].text) : "", after: index + 1 < lines.length ? clip(lines[index + 1].text) : "",
      });
    }
  }
  return { matches, capped: false };
}

// Searches the given tiles in order and reports the growing result after each
// one. Resolves with the final groups, or early when `signal` aborts.
export async function searchTerminals(tileIds: readonly string[], pattern: RegExp, signal: AbortSignal, onProgress: (groups: TileMatches[], done: boolean) => void): Promise<TileMatches[]> {
  const groups: TileMatches[] = [];
  let total = 0;
  for (const tileId of tileIds) {
    if (signal.aborted) return groups;
    const target = targets.get(tileId);
    if (!target) continue;
    let lines: SearchLine[];
    try {
      lines = await target.lines();
    } catch {
      continue;
    }
    if (signal.aborted) return groups;
    const room = Math.min(MAX_TILE_MATCHES, MAX_TOTAL_MATCHES - total);
    const { matches, capped } = await matchLines(tileId, lines, target.cols(), pattern, room, signal);
    if (signal.aborted) return groups;
    if (matches.length) {
      groups.push({ tileId, matches, capped });
      total += matches.length;
      onProgress([...groups], false);
    }
    if (total >= MAX_TOTAL_MATCHES) break;
    await yieldToUi();
  }
  if (!signal.aborted) onProgress([...groups], true);
  return groups;
}
