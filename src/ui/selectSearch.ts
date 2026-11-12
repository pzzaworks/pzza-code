// Ranking for the searchable Select: forgiving enough for "cc" -> Claude Code
// or "gem" -> Gemini CLI, strict enough that every query word must match.

export interface Searchable {
  value: string;
  label: string;
  sub?: string;
  keywords?: readonly string[];
}

const fold = (text: string) => text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

// Words split on spaces, punctuation and camelCase humps ("OpenCode" -> open, code).
const words = (text: string, humps: boolean) =>
  (humps ? text.replace(/([a-z0-9])([A-Z])/g, "$1 $2") : text).split(/[^\p{L}\p{N}]+/u).map(fold).filter(Boolean);

interface Field {
  full: string;
  compact: string;
  words: string[];
  initials: string[];
}

function field(text: string): Field {
  const split = words(text, true);
  const plain = words(text, false);
  return {
    full: fold(text),
    compact: plain.join(""),
    words: [...new Set([...split, ...plain])],
    initials: [...new Set([split.map((word) => word[0]).join(""), plain.map((word) => word[0]).join("")])],
  };
}

const isSubsequence = (needle: string, haystack: string) => {
  let at = 0;
  for (const char of haystack) if (char === needle[at]) at += 1;
  return at === needle.length;
};

// 0 means no match; higher is better.
function tokenScore(token: string, target: Field, loose: boolean): number {
  if (target.full === token || target.compact === token) return 100;
  if (target.full.startsWith(token) || target.compact.startsWith(token)) return 90;
  if (target.words.some((word) => word.startsWith(token))) return 80;
  if (token.length >= 2 && target.initials.some((initials) => initials.startsWith(token))) return 75;
  if (target.full.includes(token) || target.compact.includes(token)) return 60;
  if (loose && token.length >= 3 && isSubsequence(token, target.compact)) return 30;
  return 0;
}

/** Scores one option against a query; 0 when any query word fails to match. */
export function scoreOption(option: Searchable, query: string): number {
  const tokens = words(query, false);
  if (tokens.length === 0) return 1;
  // Hidden terms (keywords, the value) rank a little under the label, the
  // secondary line further under, so a label hit always sorts first.
  const fields: { target: Field; penalty: number; loose: boolean }[] = [
    { target: field(option.label), penalty: 0, loose: true },
    ...(option.keywords ?? []).map((keyword) => ({ target: field(keyword), penalty: 5, loose: true })),
    { target: field(option.value), penalty: 5, loose: false },
    ...(option.sub ? [{ target: field(option.sub), penalty: 15, loose: false }] : []),
  ];
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (const { target, penalty, loose } of fields) {
      const score = tokenScore(token, target, loose);
      if (score > 0) best = Math.max(best, score - penalty);
    }
    if (best <= 0) return 0;
    total += best;
  }
  return total;
}

/** The options matching a query, best first; ties keep their original order. */
export function rankOptions<T extends Searchable>(options: readonly T[], query: string): T[] {
  if (words(query, false).length === 0) return [...options];
  return options
    .map((option, index) => ({ option, index, score: scoreOption(option, query) }))
    .filter((entry) => entry.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index)
    .map((entry) => entry.option);
}
