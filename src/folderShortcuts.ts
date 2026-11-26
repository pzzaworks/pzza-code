// One-click folders, kept per device id since a path only means something on
// its own device: recent session folders and the folders starred in the picker.

const RECENT_FOLDERS_KEY = "pzza.session.recentFolders.v1";
const RECENT_FOLDERS_MAX = 5;
const FAVORITE_FOLDERS_KEY = "pzza.picker.favoriteFolders.v1";
const FAVORITE_FOLDERS_MAX = 12;
const PATH_MAX = 4096;
const DEVICE_ID_MAX = 256;

const isFolderPath = (value: unknown): value is string =>
  typeof value === "string" && value.startsWith("/") && value.length <= PATH_MAX && !/[\0\r\n]/.test(value);

// Stored lists are untrusted: keep absolute, unique paths under the cap.
function readFolderLists(key: string, max: number): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, string[]> = {};
    for (const [device, paths] of Object.entries(value)) {
      if (!device || device.length > DEVICE_ID_MAX || !Array.isArray(paths)) continue;
      out[device] = [...new Set(paths.filter(isFolderPath))].slice(0, max);
    }
    return out;
  } catch {
    return {};
  }
}

function writeFolderLists(key: string, lists: Record<string, string[]>) {
  try {
    localStorage.setItem(key, JSON.stringify(lists));
  } catch {
    /* ignore */
  }
}

export function readRecentFolders(): Record<string, string[]> {
  return readFolderLists(RECENT_FOLDERS_KEY, RECENT_FOLDERS_MAX);
}

export function recentFolders(deviceId: string): string[] {
  return readRecentFolders()[deviceId] ?? [];
}

export function rememberFolder(deviceId: string, path: string) {
  if (!deviceId || !isFolderPath(path)) return;
  const all = readRecentFolders();
  all[deviceId] = [path, ...(all[deviceId] ?? []).filter((p) => p !== path)].slice(0, RECENT_FOLDERS_MAX);
  writeFolderLists(RECENT_FOLDERS_KEY, all);
}

export function readFavoriteFolders(): Record<string, string[]> {
  return readFolderLists(FAVORITE_FOLDERS_KEY, FAVORITE_FOLDERS_MAX);
}

/** Stars or unstars a device folder and returns that device's favorites, newest first. */
export function toggleFavoriteFolder(deviceId: string, path: string): string[] {
  const all = readFavoriteFolders();
  const current = all[deviceId] ?? [];
  if (!deviceId || deviceId.length > DEVICE_ID_MAX || !isFolderPath(path)) return current;
  const next = current.includes(path) ? current.filter((p) => p !== path) : [path, ...current].slice(0, FAVORITE_FOLDERS_MAX);
  if (next.length) all[deviceId] = next;
  else delete all[deviceId];
  writeFolderLists(FAVORITE_FOLDERS_KEY, all);
  return next;
}

export const folderLabel = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;
