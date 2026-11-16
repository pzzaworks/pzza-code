import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { HAS_TAURI } from "../tauriEnv";
import { IS_MAC } from "../shortcuts";
import { listDir } from "../serverApi";
import { requestNewSession } from "../state/newSession";
import { openFiles, openFolders } from "../openFiles";
import { terminalDropTargetAt } from "./fileDrop";

// Files and folders dragged in from Finder. On a terminal they paste their
// paths (fileDrop.ts handles that drop); anywhere else they open: one folder
// on its own opens the new-session form for it, every other folder opens as a
// folder tile and every file as a file tile. Only the OS drag event carries
// real paths, so this is desktop-app only; a path counts as a folder once
// listing it succeeds.
// "none" is a dialog in front: a drop there neither pastes nor opens.
export type PathDragTarget = "terminal" | "open" | "none";
export interface PathDrag {
  /** What the drag shows: the one item's name, or how many items there are. */
  label: string | null;
  /** True when the drop would start a session (a single folder). */
  session: boolean;
  target: PathDragTarget;
}
export const usePathDrag = create<PathDrag>(() => ({ label: null, session: false, target: "open" }));

export type PathDragEvent =
  | { type: "enter" | "drop"; paths: string[]; x: number; y: number }
  | { type: "over"; x: number; y: number }
  | { type: "leave" };

const validPath = (path: string) => path.startsWith("/") && path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(path);
const baseName = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;

export function pathDropTargetAt(x: number, y: number): PathDragTarget {
  if (terminalDropTargetAt(x, y)) return "terminal";
  const hit = document.elementsFromPoint(x, y)[0];
  return hit?.closest("[aria-modal='true'], .modal-backdrop") ? "none" : "open";
}

interface Classified { folders: string[]; files: string[] }
let pending: { key: string; paths: string[]; kinds: Promise<Classified> } | null = null;
const clear = () => { pending = null; usePathDrag.setState({ label: null, session: false, target: "open" }); };

function classify(paths: string[]): Promise<Classified> {
  return Promise.all(paths.map(path => listDir(path, "").then(() => true, () => false))).then(isFolder => ({
    folders: paths.filter((_, index) => isFolder[index]),
    files: paths.filter((_, index) => !isFolder[index]),
  }));
}

const startsSession = ({ folders, files }: Classified) => folders.length === 1 && files.length === 0;

function open(kinds: Classified): void {
  if (startsSession(kinds)) { requestNewSession(kinds.folders[0], ""); return; }
  openFolders(kinds.folders);
  openFiles(kinds.files);
}

export async function handlePathDrag(event: PathDragEvent): Promise<void> {
  if (event.type === "leave") { clear(); return; }
  if (event.type !== "over") {
    if (!event.paths.length || !event.paths.every(validPath)) { clear(); return; }
    const key = event.paths.join("\0");
    if (pending?.key !== key) pending = { key, paths: event.paths, kinds: classify(event.paths) };
  }
  const current = pending;
  if (!current) return;
  const target = pathDropTargetAt(event.x, event.y);
  if (event.type === "drop") {
    clear();
    // A terminal pastes the paths itself (see fileDrop.ts).
    if (target === "open") open(await current.kinds);
    return;
  }
  // The hint appears once the folders are told apart from the files.
  const kinds = await current.kinds;
  if (pending !== current) return;
  const label = current.paths.length === 1 ? baseName(current.paths[0]) : `${current.paths.length} items`;
  usePathDrag.setState({ label, session: startsSession(kinds), target });
}

export function installPathDrops(): () => void {
  if (!HAS_TAURI) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  // macOS reports logical points; other backends report physical pixels.
  const scale = () => (IS_MAC ? 1 : window.devicePixelRatio || 1);
  void getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "leave") { void handlePathDrag({ type: "leave" }); return; }
    const x = payload.position.x / scale(), y = payload.position.y / scale();
    void handlePathDrag(payload.type === "over" ? { type: "over", x, y } : { type: payload.type, paths: payload.paths, x, y });
  }).then(remove => { if (disposed) remove(); else unlisten = remove; }).catch(() => {});
  return () => { disposed = true; unlisten?.(); clear(); };
}
