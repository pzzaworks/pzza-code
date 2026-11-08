import { create } from "zustand";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { HAS_TAURI } from "../tauriEnv";
import { IS_MAC } from "../shortcuts";
import { listDir } from "../serverApi";
import { requestNewSession } from "../state/newSession";
import { terminalDropTargetAt } from "./fileDrop";

// Dropping one folder from Finder onto the canvas (anywhere except a terminal,
// which keeps its own file drop) opens the new-session form for that folder.
// Only the OS drag event carries real paths, so this is desktop-app only; the
// folder is confirmed to be a directory by listing it before it is accepted.
export const useFolderDrag = create<{ folder: string | null; over: boolean }>(() => ({ folder: null, over: false }));

export type FolderDragEvent =
  | { type: "enter" | "drop"; paths: string[]; x: number; y: number }
  | { type: "over"; x: number; y: number }
  | { type: "leave" };

const validPath = (path: string) => path.startsWith("/") && path.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(path);

export function folderDropTargetAt(x: number, y: number): boolean {
  const hit = document.elementsFromPoint(x, y)[0];
  return !!hit?.closest(".canvas") && !terminalDropTargetAt(x, y);
}

let pending: { path: string; directory: Promise<boolean> } | null = null;
const clear = () => { pending = null; useFolderDrag.setState({ folder: null, over: false }); };

export async function handleFolderDrag(event: FolderDragEvent): Promise<void> {
  if (event.type === "leave") { clear(); return; }
  if (event.type !== "over") {
    const path = event.paths.length === 1 ? event.paths[0] : null;
    if (!path || !validPath(path)) { clear(); return; }
    if (pending?.path !== path) pending = { path, directory: listDir(path, "").then(() => true, () => false) };
  }
  const current = pending;
  if (!current) return;
  const over = folderDropTargetAt(event.x, event.y);
  if (event.type === "drop") {
    clear();
    if (over && await current.directory) requestNewSession(current.path, "");
    return;
  }
  // Highlight only once the path is known to be a directory.
  if (await current.directory && pending === current) useFolderDrag.setState({ folder: current.path, over });
}

export function installFolderDrops(): () => void {
  if (!HAS_TAURI) return () => {};
  let disposed = false;
  let unlisten: (() => void) | undefined;
  // macOS reports logical points; other backends report physical pixels.
  const scale = () => (IS_MAC ? 1 : window.devicePixelRatio || 1);
  void getCurrentWebview().onDragDropEvent(({ payload }) => {
    if (payload.type === "leave") { void handleFolderDrag({ type: "leave" }); return; }
    const x = payload.position.x / scale(), y = payload.position.y / scale();
    void handleFolderDrag(payload.type === "over" ? { type: "over", x, y } : { type: payload.type, paths: payload.paths, x, y });
  }).then(remove => { if (disposed) remove(); else unlisten = remove; }).catch(() => {});
  return () => { disposed = true; unlisten?.(); clear(); };
}
