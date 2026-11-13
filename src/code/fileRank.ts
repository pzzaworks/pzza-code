// Quick Open ranking: fuzzy matches on the file name outrank matches that need
// the folder, consecutive runs and word starts score higher (fuzzyMatch), and
// with no query the editor's recently opened files come first.
import { fuzzyMatch } from "../fuzzyMatch";

export interface RankedFile {
  path: string;
  name: string;
  dir: string;
  namePositions: number[];
  dirPositions: number[];
  score: number;
}

// Applied on top of fuzzyMatch scores: a whole match inside the name beats
// one spread over folders, and a recent file wins a close tie.
const NAME_BONUS = 24;
const RECENT_BONUS = 6;

function split(path: string): { name: string; dir: string } {
  const slash = path.lastIndexOf("/");
  return slash < 0 ? { name: path, dir: "" } : { name: path.slice(slash + 1), dir: path.slice(0, slash) };
}

// Cheap rejection before the full alignment: every query character in order.
function isSubsequence(needle: string, haystack: string): boolean {
  let at = 0;
  for (let index = 0; index < haystack.length && at < needle.length; index++) if (haystack[index] === needle[at]) at++;
  return at === needle.length;
}

/**
 * The best `limit` files for `query`. `recent` holds root-relative paths,
 * most recent first.
 */
export function rankFiles(files: readonly string[], query: string, recent: readonly string[], limit = 60): RankedFile[] {
  const needle = query.toLowerCase().replace(/\s+/g, "");
  const recency = new Map(recent.map((path, index) => [path, index]));
  if (!needle) {
    const known = new Set(files);
    const first = recent.filter((path) => known.has(path));
    const seen = new Set(first);
    const rest = files.filter((path) => !seen.has(path)).slice(0, Math.max(0, limit - first.length));
    return [...first, ...rest].slice(0, limit).map((path) => ({ path, ...split(path), namePositions: [], dirPositions: [], score: 0 }));
  }
  const ranked: RankedFile[] = [];
  for (const path of files) {
    if (!isSubsequence(needle, path.toLowerCase())) continue;
    const { name, dir } = split(path);
    const bonus = recency.has(path) ? RECENT_BONUS - Math.min(recency.get(path) ?? 0, RECENT_BONUS) * 0.5 : 0;
    // A query with a slash names folders on purpose: match the whole path.
    const inName = needle.includes("/") ? null : fuzzyMatch(needle, name);
    if (inName) {
      ranked.push({ path, name, dir, namePositions: inName.positions, dirPositions: [], score: inName.score + NAME_BONUS + bonus });
      continue;
    }
    const whole = fuzzyMatch(needle, path);
    if (!whole) continue;
    const offset = dir ? dir.length + 1 : 0;
    ranked.push({
      path, name, dir,
      namePositions: whole.positions.filter((at) => at >= offset).map((at) => at - offset),
      dirPositions: whole.positions.filter((at) => at < dir.length),
      score: whole.score + bonus,
    });
  }
  ranked.sort((a, b) => b.score - a.score || a.path.length - b.path.length || (a.path < b.path ? -1 : 1));
  return ranked.slice(0, limit);
}
