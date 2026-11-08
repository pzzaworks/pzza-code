export interface FuzzyMatch {
  score: number;
  /** Indexes into the text of the matched query characters, in order. */
  positions: number[];
}

const SEPARATOR = /[\s\-_/.:,()&·…]/;
const NONE = Number.NEGATIVE_INFINITY;

function wordStart(text: string, index: number): boolean {
  if (index === 0) return true;
  const before = text[index - 1];
  return SEPARATOR.test(before) || (/[a-z0-9]/.test(before) && /[A-Z]/.test(text[index]));
}

// Subsequence match: every query character must appear in order. The best
// alignment favors characters at word starts and consecutive runs, so "ns"
// ranks "New session" above "Notifications".
export function fuzzyMatch(query: string, text: string): FuzzyMatch | null {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  if (!needle) return { score: 0, positions: [] };
  const haystack = text.toLowerCase();
  const n = text.length;
  const m = needle.length;
  if (m > n) return null;
  let previous: number[] = new Array<number>(n).fill(NONE);
  const back: Int32Array[] = [];
  for (let i = 0; i < m; i++) {
    const current: number[] = new Array<number>(n).fill(NONE);
    const from = new Int32Array(n).fill(-1);
    // The best previous-character score at least two positions back (a gap).
    let gapBest = NONE;
    let gapAt = -1;
    for (let j = 0; j < n; j++) {
      if (i > 0 && j >= 2 && previous[j - 2] > gapBest) { gapBest = previous[j - 2]; gapAt = j - 2; }
      if (haystack[j] !== needle[i]) continue;
      const bonus = 1 + (wordStart(text, j) ? 8 : 0);
      if (i === 0) { current[j] = bonus + (j === 0 ? 6 : 0) - Math.min(j, 10) * 0.2; continue; }
      const chained = j >= 1 && previous[j - 1] > NONE ? previous[j - 1] + 5 : NONE;
      const jumped = gapBest > NONE ? gapBest - 1 : NONE;
      if (chained === NONE && jumped === NONE) continue;
      if (chained >= jumped) { current[j] = chained + bonus; from[j] = j - 1; }
      else { current[j] = jumped + bonus; from[j] = gapAt; }
    }
    back.push(from);
    previous = current;
  }
  let end = -1;
  let score = NONE;
  for (let j = 0; j < n; j++) if (previous[j] > score) { score = previous[j]; end = j; }
  if (end < 0) return null;
  const positions = new Array<number>(m);
  for (let i = m - 1, j = end; i >= 0; i--) { positions[i] = j; j = back[i][j]; }
  // Among equal alignments, the shorter text is the closer match.
  return { score: score - (n - m) * 0.01, positions };
}
