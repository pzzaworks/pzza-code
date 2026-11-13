// Files each editor opened most recently, newest first, so Quick Open can list
// them before anything is typed. Kept per editor (tile) across reloads.
const KEY = "pzza.codeRecentFiles";
const PER_EDITOR = 20;
const EDITORS = 40;

type RecentFiles = Record<string, string[]>;

function load(): RecentFiles {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: RecentFiles = {};
    for (const [tileId, paths] of Object.entries(value)) {
      if (Array.isArray(paths)) out[tileId] = paths.filter((path): path is string => typeof path === "string").slice(0, PER_EDITOR);
    }
    return out;
  } catch {
    return {};
  }
}

export function recentFiles(tileId: string): string[] {
  return load()[tileId] ?? [];
}

export function rememberRecentFile(tileId: string, path: string): void {
  const all = load();
  const next = [path, ...(all[tileId] ?? []).filter((entry) => entry !== path)].slice(0, PER_EDITOR);
  delete all[tileId];
  // Newest editor last, so the oldest editors are the ones dropped.
  const entries = [...Object.entries(all), [tileId, next] as const].slice(-EDITORS);
  try { localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(entries))); } catch { /* Storage full or blocked: this visit is not remembered. */ }
}
