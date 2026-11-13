import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { HAS_TAURI } from "./tauriEnv";
import { IS_MAC } from "./shortcuts";
import { fileBaseName, fileFolder, isFileTile, isFolderTile, useStore, validFilePath } from "./state/store";
import { THIS_MAC } from "./devices";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID } from "./workspaces";
import { createSessionInApp, creationIdle, enqueueLaunch, sessionNameBase, takenSessionNames, uniqueSessionName } from "./sessionActions";
import { fetchDoctor, fetchGitChanges } from "./serverApi";
import { notify } from "./state/notifications";
import { confirmEditorDiscard } from "./editorChanges";

// Files opened with PzzaCode from macOS (Finder's Open With, PzzaCode as the
// default app, or File > Open File…) open as file tiles: the inline editor on
// this device's file, full-tile, with no terminal. Folders (File > Open
// Folder…) open the same way as folder tiles, on the folder's tree.
// "Open terminal here" later turns either into a session tile in the same
// place.

export interface OpenedFile {
  /** Absolute path of the file. */
  path: string;
  /** The folder holding it: where a terminal opened from it starts. */
  folder: string;
  fileName: string;
}

/** The file behind an absolute path from the native side, or null when it is not one. */
export function openedFile(path: unknown): OpenedFile | null {
  const valid = validFilePath(path);
  return valid ? { path: valid, folder: fileFolder(valid), fileName: fileBaseName(valid) } : null;
}

/**
 * The editor's folder for a file in `folder`: its Git repository when the file
 * is inside it as written (a repository found through a symlinked path would
 * leave the file outside the tree), otherwise the file's own folder.
 */
export function editorRoot(folder: string, repositoryRoot: string | null): string {
  if (!repositoryRoot?.startsWith("/")) return folder;
  const prefix = repositoryRoot.endsWith("/") ? repositoryRoot : `${repositoryRoot}/`;
  return folder === repositoryRoot || folder.startsWith(prefix) ? repositoryRoot : folder;
}

export interface OpenFileDependencies {
  /** The file tile already showing `path`, or null. */
  openTile(path: string): string | null;
  /** Switches to a tile's workspace and focuses it. */
  reveal(tileId: string): void;
  /** Resolves once this device's agent answers: the editor reads files through it. */
  ready(): Promise<void>;
  /** The Git repository holding `folder`, or null outside one. */
  repositoryRoot(folder: string): Promise<string | null>;
  /** Adds a file tile for `path` with its editor rooted at `root`; returns its id. */
  addTile(path: string, root: string): string;
}

/** Shows `file` in a file tile: the one already open for it, else a new one. Resolves to the tile id. */
export async function openFileTile(file: OpenedFile, dependencies: OpenFileDependencies): Promise<string> {
  const open = dependencies.openTile(file.path);
  if (open) {
    dependencies.reveal(open);
    return open;
  }
  await dependencies.ready();
  const repository = await dependencies.repositoryRoot(file.folder).catch(() => null);
  // The same file may have been opened again while this one waited.
  const opened = dependencies.openTile(file.path);
  if (opened) {
    dependencies.reveal(opened);
    return opened;
  }
  return dependencies.addTile(file.path, editorRoot(file.folder, repository));
}

/** The file tile showing `path`: opened on it, or with it open in its editor now. */
export function fileTileFor(path: string): string | null {
  const { tiles, tileCode } = useStore.getState();
  return tiles.find((tile) => isFileTile(tile) && (tile.file === path || tileCode[tile.id]?.path === path))?.id ?? null;
}

export interface OpenFolderDependencies {
  /** The folder tile already showing `folder`, or null. */
  openTile(folder: string): string | null;
  /** Switches to a tile's workspace and focuses it. */
  reveal(tileId: string): void;
  /** Resolves once this device's agent answers: the editor reads folders through it. */
  ready(): Promise<void>;
  /** Adds a folder tile for `folder`; returns its id. */
  addTile(folder: string): string;
}

/**
 * Shows `folder` in a folder tile: the one already open for it, else a new
 * one. The editor is rooted at the folder itself, not its Git repository: the
 * user picked that folder (say, one package of a larger repository), and Git
 * features still find the repository from inside it. Resolves to the tile id.
 */
export async function openFolderTile(folder: string, dependencies: OpenFolderDependencies): Promise<string> {
  const open = dependencies.openTile(folder);
  if (open) {
    dependencies.reveal(open);
    return open;
  }
  await dependencies.ready();
  // The same folder may have been opened again while this one waited.
  const opened = dependencies.openTile(folder);
  if (opened) {
    dependencies.reveal(opened);
    return opened;
  }
  return dependencies.addTile(folder);
}

/** The folder tile opened on `folder`, or null. */
export function folderTileFor(folder: string): string | null {
  return useStore.getState().tiles.find((tile) => isFolderTile(tile) && tile.folder === folder)?.id ?? null;
}

// New tiles go to the active workspace; All stands for the default one.
function targetWorkspace(): string {
  const { activeWorkspaceId, workspaces } = useStore.getState();
  const selected = activeWorkspaceId === ALL_WORKSPACE_ID ? DEFAULT_WORKSPACE_ID : activeWorkspaceId;
  return workspaces.some((workspace) => workspace.id === selected) ? selected : DEFAULT_WORKSPACE_ID;
}

const AGENT_WAIT_MS = 120000;
const AGENT_POLL_MS = 1000;
const GIT_ROOT_TIMEOUT_MS = 5000;

const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

// A file opened at launch can arrive before the local agent answers (on a
// fresh Mac, setup may still be installing Node.js).
async function localAgentReady(): Promise<void> {
  const deadline = Date.now() + AGENT_WAIT_MS;
  for (;;) {
    try {
      await fetchDoctor();
      return;
    } catch {
      if (Date.now() >= deadline) throw new Error("The PzzaCode agent on this Mac is not running.");
      await delay(AGENT_POLL_MS);
    }
  }
}

const APP_DEPENDENCIES: OpenFileDependencies = {
  openTile: fileTileFor,
  reveal: id => useStore.getState().revealTile(id),
  ready: localAgentReady,
  repositoryRoot: async folder => (await fetchGitChanges("", folder, AbortSignal.timeout(GIT_ROOT_TIMEOUT_MS))).root,
  addTile: (path, root) => useStore.getState().openFileTile(path, root, targetWorkspace()),
};

const FOLDER_DEPENDENCIES: OpenFolderDependencies = {
  openTile: folderTileFor,
  reveal: id => useStore.getState().revealTile(id),
  ready: localAgentReady,
  addTile: folder => useStore.getState().openFolderTile(folder, targetWorkspace()),
};

const failure = (error: unknown, fallback: string) => error instanceof Error ? error.message : typeof error === "string" && error ? error : fallback;

// Files and folders opened together open one after another, in the order they came.
let opening: Promise<unknown> = Promise.resolve();

function openFiles(paths: unknown): void {
  if (!Array.isArray(paths)) return;
  for (const path of paths) {
    const file = openedFile(path);
    if (!file) {
      notify({ category: "app", source: "Open with PzzaCode", title: "Could not open a file", body: "PzzaCode received a path that is not an absolute file path." });
      continue;
    }
    opening = opening.then(() => openFileTile(file, APP_DEPENDENCIES)).catch((error: unknown) => notify({
      category: "app", source: "Open with PzzaCode", dedupeKey: `open-file-failed:${file.path}`,
      title: `Could not open ${file.fileName}`,
      body: failure(error, "The file could not be opened."),
    }));
  }
}

function openFolders(paths: unknown): void {
  if (!Array.isArray(paths)) return;
  for (const path of paths) {
    const folder = validFilePath(path);
    if (!folder) {
      notify({ category: "app", source: "Open with PzzaCode", title: "Could not open a folder", body: "PzzaCode received a path that is not an absolute folder path." });
      continue;
    }
    opening = opening.then(() => openFolderTile(folder, FOLDER_DEPENDENCIES)).catch((error: unknown) => notify({
      category: "app", source: "Open with PzzaCode", dedupeKey: `open-folder-failed:${folder}`,
      title: `Could not open ${fileBaseName(folder)}`,
      body: failure(error, "The folder could not be opened."),
    }));
  }
}

// What arrived before the page listened: files and folders, queued natively.
function openQueued(queued: unknown): void {
  if (typeof queued !== "object" || queued === null) return;
  const { files, folders } = queued as { files?: unknown; folders?: unknown };
  openFiles(files);
  openFolders(folders);
}

let started = false;

/**
 * Starts receiving files and folders opened with PzzaCode, once per launch.
 * The listeners come first; paths that arrived before them are then taken
 * from the native side, so none is missed and none is opened twice.
 */
export function startOpenFiles(): void {
  if (started || !HAS_TAURI) return;
  started = true;
  void Promise.all([
    listen<unknown>("open-files", ({ payload }) => openFiles(payload)),
    listen<unknown>("open-folders", ({ payload }) => openFolders(payload)),
  ])
    .then(() => invoke<unknown>("take_opened_files"))
    .then(openQueued)
    .catch((error: unknown) => notify({
      category: "app", source: "Open with PzzaCode", dedupeKey: "open-files-unavailable",
      title: "Files opened with PzzaCode cannot be received",
      body: failure(error, "The connection to the macOS app failed."),
    }));
}

/** File > Open File… and Open Folder…: the native macOS panels. */
export const NATIVE_OPEN_PANELS = HAS_TAURI && IS_MAC;

/**
 * Shows the native open panel for files or a folder. The choice arrives later
 * through the open-files and open-folders events; cancelling does nothing.
 */
export async function showOpenPanel(kind: "file" | "folder"): Promise<void> {
  await invoke("pick_and_open", { kind });
}

// ----------------------------------------------------- open terminal here

export interface FileTileTerminal {
  /** What the terminal is for: a file tile's file, or a folder tile's folder. */
  kind: "file" | "folder";
  /** Where the session starts: the folder holding the file open in a file
   *  tile's editor (else the tile's own file), or a folder tile's folder. */
  cwd: string;
  /** The file or folder name the session is named after. */
  name: string;
  workspaceId: string;
}

/** The terminal a file or folder tile opens, or null when `tileId` is not one. */
export function fileTileTerminal(tileId: string): FileTileTerminal | null {
  const state = useStore.getState();
  const tile = state.tiles.find((entry) => entry.id === tileId);
  if (!tile || !isFileTile(tile)) return null;
  const workspaceId = state.sessionWs[tileId] ?? DEFAULT_WORKSPACE_ID;
  if (isFolderTile(tile)) return { kind: "folder", cwd: tile.folder, name: tile.name, workspaceId };
  const file = validFilePath(state.tileCode[tileId]?.path) ?? tile.file;
  return { kind: "file", cwd: fileFolder(file), name: fileBaseName(file), workspaceId };
}

export interface TerminalDependencies {
  /** The file or folder tile's terminal, or null when it is not an open file or folder tile. */
  fileTile(tileId: string): FileTileTerminal | null;
  /** Asks before unsaved editor changes are dropped; false keeps them. */
  confirmDiscard(tileId: string): Promise<boolean>;
  /** Runs a session creation in turn with every other one. */
  launch<T>(work: () => Promise<T>): Promise<T>;
  /** Brings the list of sessions on this device up to date. */
  refreshSessions(): Promise<void>;
  /** Session names already used on this device. */
  takenNames(): ReadonlySet<string>;
  /** Creates the session and its tile in `workspaceId`; resolves to the tile id. */
  createSession(name: string, cwd: string, workspaceId: string): Promise<string>;
  /** Puts the session tile in the file or folder tile's place, with its editor. */
  replace(fileTileId: string, sessionTileId: string): void;
}

/**
 * Turns a file or folder tile into a session tile in place: a new session on
 * this device in the file's folder (or the folder itself) takes the tile's
 * position and workspace and keeps its editor, split so the terminal shows.
 * Resolves to the session tile id, or null when the user kept unsaved
 * changes. A failure throws and leaves the tile as it was.
 */
export async function convertFileTile(tileId: string, dependencies: TerminalDependencies): Promise<string | null> {
  if (!dependencies.fileTile(tileId)) throw new Error("This tile is no longer open.");
  // The editor is mounted anew in the session tile, so an unsaved buffer would be lost.
  if (!await dependencies.confirmDiscard(tileId)) return null;
  const sessionId = await dependencies.launch(async () => {
    const target = dependencies.fileTile(tileId);
    if (!target) throw new Error("This tile is no longer open.");
    await dependencies.refreshSessions().catch(() => {});
    // The name is chosen right before creating, so creations never pick the same one.
    const name = uniqueSessionName(sessionNameBase(target.name, target.kind), dependencies.takenNames());
    return dependencies.createSession(name, target.cwd, target.workspaceId);
  });
  // Edits made while the session started are asked about again; kept, both tiles stay.
  if (dependencies.fileTile(tileId) && await dependencies.confirmDiscard(tileId)) dependencies.replace(tileId, sessionId);
  return sessionId;
}

const TERMINAL_DEPENDENCIES: TerminalDependencies = {
  fileTile: fileTileTerminal,
  confirmDiscard: tileId => confirmEditorDiscard([tileId]),
  launch: work => enqueueLaunch(async () => {
    await creationIdle();
    return work();
  }),
  refreshSessions: () => useStore.getState().loadSessions(),
  takenNames: () => takenSessionNames(""),
  createSession: (name, cwd, workspaceId) => createSessionInApp({ name, deviceId: THIS_MAC.id, cwd, workspaceId }),
  replace: (fileTileId, sessionTileId) => useStore.getState().replaceFileTile(fileTileId, sessionTileId),
};

/** File and folder tiles whose terminal is being opened. */
export const useFileTileConversions = create<{ converting: readonly string[] }>(() => ({ converting: [] }));

/** "Open terminal here" on a file or folder tile. Never rejects: a failure is reported and the tile stays. */
export async function openTerminalInFileTile(tileId: string): Promise<string | null> {
  if (useFileTileConversions.getState().converting.includes(tileId)) return null;
  useFileTileConversions.setState(({ converting }) => ({ converting: [...converting, tileId] }));
  try {
    return await convertFileTile(tileId, TERMINAL_DEPENDENCIES);
  } catch (error) {
    notify({
      category: "app", source: "Open terminal here", dedupeKey: `open-terminal-failed:${tileId}`,
      title: "Could not open a terminal",
      body: error instanceof Error ? error.message : typeof error === "string" && error ? error : "The session for this file could not be created.",
      target: { tileId },
    });
    return null;
  } finally {
    useFileTileConversions.setState(({ converting }) => ({ converting: converting.filter((id) => id !== tileId) }));
  }
}
