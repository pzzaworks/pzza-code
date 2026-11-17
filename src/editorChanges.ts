type DiscardCheck = () => Promise<boolean>;
const checks = new Map<string, DiscardCheck>();

export function registerEditorDiscard(id: string, check: DiscardCheck): () => void {
  checks.set(id, check);
  return () => { if (checks.get(id) === check) checks.delete(id); };
}

export async function confirmEditorDiscard(ids?: string[]): Promise<boolean> {
  if (hasSavingEditors(ids)) return false;
  const snapshot = () => [...files.entries()].filter(([id]) => !ids || ids.includes(id)).map(([id, read]) => ({ id, ...read() }));
  const before = JSON.stringify(snapshot());
  for (const [id, check] of checks) {
    if ((!ids || ids.includes(id)) && !await check()) return false;
    if (hasSavingEditors(ids) || JSON.stringify(snapshot()) !== before) return false;
  }
  return true;
}

export interface FileMutation {
  host?: string;
  path: string;
  destination?: string;
}

const listeners = new Set<(mutation: FileMutation) => void>();
export function onFileMutation(listener: (mutation: FileMutation) => void): () => void {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}
export function notifyFileMutation(mutation: FileMutation): void {
  for (const listener of listeners) listener(mutation);
}
export function remapFilePath(value: string | undefined, source: string, destination?: string): string | undefined {
  if (!value || (value !== source && !value.startsWith(source + "/"))) return value;
  return destination ? destination + value.slice(source.length) : undefined;
}

interface EditorFileState { host?: string; path?: string; saving: boolean; dirty?: boolean; revision?: string | number }
const files = new Map<string, () => EditorFileState>();
const mutations = new Set<FileMutation>();
export function registerEditorFile(id: string, read: () => EditorFileState): () => void {
  files.set(id, read);
  return () => { if (files.get(id) === read) files.delete(id); };
}
function affects(mutation: FileMutation, file: EditorFileState): boolean {
  return (mutation.host || "") === (file.host || "") && !!file.path &&
    (file.path === mutation.path || file.path.startsWith(mutation.path + "/"));
}
export function beginFileMutation(mutation: FileMutation, { allowDirty = true }: { allowDirty?: boolean } = {}): () => void {
  if (!allowDirty && [...files.values()].some((read) => { const file = read(); return file.dirty && affects(mutation, file); })) {
    throw new Error("Save or discard affected editor buffers before deleting their files.");
  }
  if ([...files.values()].some((read) => { const file = read(); return file.saving && affects(mutation, file); })) {
    throw new Error("Wait for the file to finish saving before moving or deleting it.");
  }
  mutations.add(mutation);
  return () => { mutations.delete(mutation); };
}
export function fileMutationPending(host: string | undefined, path: string): boolean {
  return [...mutations].some((mutation) => affects(mutation, { host, path, saving: false }));
}

export function hasSavingEditors(ids?: readonly string[]): boolean {
  return [...files.entries()].some(([id, read]) => (!ids || ids.includes(id)) && read().saving);
}

export function hasUnsavedEditors(ids?: readonly string[]): boolean {
  return [...files.entries()].some(([id, read]) => {
    if (ids && !ids.includes(id)) return false;
    const file = read();
    return file.dirty || file.saving;
  });
}

// Editors kept read-only while their tile's session is renamed on its device:
// the tile then reopens under the new name, and an edit typed meanwhile would
// be lost with the old editor.
const locked = new Map<string, number>();
const lockListeners = new Set<() => void>();

/** Locks the editors of these tiles until the returned function is called. */
export function lockEditors(ids: readonly string[]): () => void {
  for (const id of ids) locked.set(id, (locked.get(id) ?? 0) + 1);
  lockListeners.forEach((listener) => listener());
  let released = false;
  return () => {
    if (released) return;
    released = true;
    for (const id of ids) {
      const count = (locked.get(id) ?? 1) - 1;
      if (count > 0) locked.set(id, count);
      else locked.delete(id);
    }
    lockListeners.forEach((listener) => listener());
  };
}

export function editorLocked(id: string): boolean {
  return locked.has(id);
}

/** Subscribes to lock changes (for useSyncExternalStore). */
export function onEditorLocks(listener: () => void): () => void {
  lockListeners.add(listener);
  return () => lockListeners.delete(listener);
}
