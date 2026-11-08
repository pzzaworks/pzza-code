import { Change, diff } from "@codemirror/merge";

// A line-first diff for the Changes view. CodeMirror's own diff compares
// characters, which takes seconds on a large, heavily edited file and blocks
// the window meanwhile. Here every distinct line becomes one character, the
// same diff runs over those (a few thousand instead of a few hundred thousand),
// and only small changed blocks are then compared character by character to
// mark the words that changed.

// Blocks up to this size get word-level detail; larger ones show as whole lines.
const REFINE_CHARS = 4000;
// Codes for distinct lines skip the surrogate range, so each stays one UTF-16 unit.
const MAX_LINE_CODES = 0xffff - 0x800;
const LIMITS = { scanLimit: 2000, timeout: 50 };

function encode(lines: string[], ids: Map<string, number>): string | null {
  const codes: number[] = [];
  for (const line of lines) {
    let id = ids.get(line);
    if (id === undefined) {
      id = ids.size;
      if (id >= MAX_LINE_CODES) return null;
      ids.set(line, id);
    }
    codes.push(id < 0xd800 ? id : id + 0x800);
  }
  let out = "";
  for (let index = 0; index < codes.length; index += 4096) out += String.fromCharCode(...codes.slice(index, index + 4096));
  return out;
}

function lineStarts(lines: string[]): number[] {
  const starts = [0];
  for (const line of lines) starts.push(starts[starts.length - 1] + line.length + 1);
  return starts;
}

/** Changed blocks as line ranges: [start, end) in a and in b. */
export function lineHunks(a: string, b: string): Array<{ a: [number, number]; b: [number, number] }> | null {
  const ids = new Map<string, number>();
  const linesA = a.split("\n");
  const linesB = b.split("\n");
  const encodedA = encode(linesA, ids);
  const encodedB = encodedA === null ? null : encode(linesB, ids);
  if (encodedA === null || encodedB === null) return null;
  return diff(encodedA, encodedB, LIMITS).map((change) => ({ a: [change.fromA, change.toA], b: [change.fromB, change.toB] }));
}

export function lineDiff(a: string, b: string): readonly Change[] {
  const hunks = lineHunks(a, b);
  // More distinct lines than codes: fall back to a time-limited character diff.
  if (!hunks) return diff(a, b, LIMITS);
  const startsA = lineStarts(a.split("\n"));
  const startsB = lineStarts(b.split("\n"));
  const lastA = startsA.length - 1;
  const lastB = startsB.length - 1;
  const changes: Change[] = [];
  for (const hunk of hunks) {
    let fromA = startsA[hunk.a[0]];
    let toA = startsA[hunk.a[1]];
    let fromB = startsB[hunk.b[0]];
    let toB = startsB[hunk.b[1]];
    // A block that runs to the end of the text has no newline after its last
    // line: take the newline before it instead, so both sides stay aligned.
    if (hunk.a[1] === lastA && hunk.b[1] === lastB) {
      if (hunk.a[0] > 0 && hunk.b[0] > 0) { fromA -= 1; fromB -= 1; }
      toA = a.length;
      toB = b.length;
    }
    if (toA - fromA + (toB - fromB) <= REFINE_CHARS && toA > fromA && toB > fromB) {
      for (const inner of diff(a.slice(fromA, toA), b.slice(fromB, toB), LIMITS)) {
        changes.push(new Change(fromA + inner.fromA, fromA + inner.toA, fromB + inner.fromB, fromB + inner.toB));
      }
    } else {
      changes.push(new Change(fromA, toA, fromB, toB));
    }
  }
  return changes;
}

/** Lines removed from `a` and added in `b`. */
export function lineDiffStats(a: string, b: string): { added: number; removed: number } {
  const hunks = lineHunks(a, b);
  if (!hunks) return { added: 0, removed: 0 };
  let added = 0;
  let removed = 0;
  for (const hunk of hunks) {
    removed += hunk.a[1] - hunk.a[0];
    added += hunk.b[1] - hunk.b[0];
  }
  return { added, removed };
}
