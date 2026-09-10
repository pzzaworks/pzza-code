import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { HAS_TAURI } from "../tauriEnv";
import { notify } from "../state/notifications";

export const DROP_LIMITS = { count: 8, file: 16 * 1024 * 1024, total: 32 * 1024 * 1024 };
export interface NativeDrop {
  id: string;
  files: { name: string; path: string; size: number }[];
  x: number;
  y: number;
  error?: string | null;
}
export type TerminalDrop = { native: NativeDrop } | { files: File[] };
type DropTarget = (drop: TerminalDrop) => void;
const targets = new Map<HTMLElement, DropTarget>();

export function shellQuotePaths(paths: string[]): string {
  if (!paths.length || paths.some(path => !path.startsWith("/") || path.length > 4096 || /[\x00-\x1f\x7f-\x9f]/u.test(path))) throw new Error("The device returned an invalid file path.");
  return paths.map(path => `'${path.replace(/'/g, "'\\''")}'`).join(" ") + " ";
}

export function validateDroppedFiles(files: readonly { name: string; size: number }[]): void {
  if (!files.length || files.length > DROP_LIMITS.count) throw new Error("Drop between one and eight regular files.");
  let total = 0;
  for (const file of files) {
    if (!file.name || [".", ".."].includes(file.name) || /[\\/\x00-\x1f\x7f-\x9f]/u.test(file.name) || new TextEncoder().encode(file.name).byteLength > 255) throw new Error("Dropped filenames contain unsupported characters.");
    if (!Number.isSafeInteger(file.size) || file.size < 0 || file.size > DROP_LIMITS.file) throw new Error("Drop files up to 16 MiB each.");
    total += file.size;
  }
  if (total > DROP_LIMITS.total) throw new Error("Drop at most 32 MiB at once.");
  if (new Set(files.map(file => file.name)).size !== files.length) throw new Error("Dropped filenames must be distinct.");
}

export function internalDrop(types: readonly string[]): boolean {
  return types.some(type => type.startsWith("application/x-pzza-") || type.startsWith("application/pzza-"));
}
export function externalDrop(types: readonly string[], draggingInside = false): boolean {
  return !draggingInside && !internalDrop(types) && types.some(type => ["Files", "text/uri-list", "text/html", "text/plain", "public.file-url"].includes(type));
}

export function registerTerminalDropTarget(element: HTMLElement, accept: DropTarget): () => void {
  targets.set(element, accept);
  return () => { if (targets.get(element) === accept) targets.delete(element); };
}

export async function releaseNativeDrop(drop: NativeDrop): Promise<void> {
  if (drop.id) await invoke("release_drop", { id: drop.id });
}
export async function readNativeDrop(drop: NativeDrop, signal: AbortSignal): Promise<File[]> {
  validateDroppedFiles(drop.files);
  const files: File[] = [];
  for (const [index, info] of drop.files.entries()) {
    signal.throwIfAborted();
    const bytes = await invoke<ArrayBuffer>("read_dropped_file", { id: drop.id, index });
    signal.throwIfAborted();
    if (bytes.byteLength !== info.size) throw new Error("The dropped file changed. Drop it again.");
    files.push(new File([bytes], info.name));
  }
  return files;
}

function targetAt(x: number, y: number): DropTarget | undefined {
  // Hit testing, rather than the previously active tile, makes a drop into an
  // unfocused terminal select that exact terminal. Hidden panes cannot win.
  const hit = document.elementsFromPoint(x, y)[0];
  if (!hit) return undefined;
  for (const [element, accept] of targets) if (element === hit || element.contains(hit)) return accept;
  return undefined;
}
const report = (message: string) => notify({ category: "terminal", title: "File drop needs attention", body: message });

// Mount once at the application root. Capture external drops before an editor,
// link, or empty workspace can navigate the webview away from the application.
export function installTerminalDrops(): () => void {
  let disposed = false;
  let draggingInside = false;
  let unlisten: (() => void) | undefined;
  const start = () => { draggingInside = true; };
  const end = () => { draggingInside = false; };
  const over = (event: DragEvent) => {
    const types = Array.from(event.dataTransfer?.types ?? []);
    if (!externalDrop(types, draggingInside)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = types.includes("Files") && targetAt(event.clientX, event.clientY) ? "copy" : "none";
  };
  const drop = (event: DragEvent) => {
    const data = event.dataTransfer;
    if (!data || !externalDrop(Array.from(data.types), draggingInside)) { end(); return; }
    event.preventDefault();
    event.stopPropagation();
    end();
    if (!data.types.includes("Files")) return; // URL drops are never executed or navigated.
    if (HAS_TAURI) return; // Only the OS event is authoritative for native paths.
    const accept = targetAt(event.clientX, event.clientY);
    if (!accept) return;
    try {
      const items = Array.from(data.items).filter(item => item.kind === "file");
      if (items.some(item => item.webkitGetAsEntry?.()?.isDirectory)) throw new Error("Drop regular files only. Directories are not supported.");
      const files = items.map(item => item.getAsFile()).filter((file): file is File => file !== null);
      if (files.length !== items.length) throw new Error("Cannot read one of the dropped files.");
      validateDroppedFiles(files);
      accept({ files });
    } catch (error: unknown) { report(error instanceof Error ? error.message : "Cannot use these dropped files."); }
  };
  window.addEventListener("dragstart", start, true);
  window.addEventListener("dragend", end, true);
  window.addEventListener("dragover", over, true);
  window.addEventListener("drop", drop, true);
  window.addEventListener("blur", end);
  if (HAS_TAURI) {
    void getCurrentWindow().listen<NativeDrop>("pzza:terminal-drop", event => {
      const drop = event.payload;
      if (disposed) { void releaseNativeDrop(drop).catch(() => {}); return; }
      const accept = targetAt(drop.x, drop.y);
      if (!accept || drop.error) {
        void releaseNativeDrop(drop).catch(() => {});
        if (drop.error) report(drop.error);
        return;
      }
      accept({ native: drop });
    }).then(remove => { if (disposed) remove(); else unlisten = remove; }).catch(() => { if (!disposed) report("Native file drops are unavailable. Reopen the app to retry."); });
  }
  return () => {
    disposed = true;
    unlisten?.();
    window.removeEventListener("dragstart", start, true);
    window.removeEventListener("dragend", end, true);
    window.removeEventListener("dragover", over, true);
    window.removeEventListener("drop", drop, true);
    window.removeEventListener("blur", end);
  };
}
