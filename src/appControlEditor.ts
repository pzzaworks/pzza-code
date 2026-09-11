import { registerAppControlHandler, registerAppControlState } from "./appControlRuntime";
import { EDITOR_APP_COMMANDS } from "../server/lib/app-control-editor-schema.js";

export interface EditorBufferSnapshot {
  path?: string;
  root?: string;
  host?: string;
  content: string;
  revision: string;
  loaded: boolean;
  dirty: boolean;
  saving: boolean;
  binary: boolean;
  markdown: boolean;
  failed: boolean;
  tree: boolean;
  preview: boolean;
  folderPicker: boolean;
}
export interface EditorControlAdapter {
  read(): EditorBufferSnapshot;
  change(content: string, dirty: boolean): void;
  busy(saving: boolean): void;
  save(path: string, content: string): Promise<void>;
  reload(path: string): Promise<string>;
  close(): void;
  view(settings: { tree?: boolean; preview?: boolean; folderPicker?: boolean }): void;
  copyImage(): Promise<void>;
  list(path?: string): Promise<unknown>;
  move(path: string, destination: string): Promise<unknown>;
  remove(path: string): Promise<unknown>;
  treeAction(path?: string, expanded?: boolean): Promise<void>;
}

export function createEditorAppController(adapter: EditorControlAdapter) {
  const state = () => {
    const current = adapter.read();
    return { path: current.path, root: current.root, host: current.host, revision: current.revision,
      loaded: current.loaded, dirty: current.dirty, saving: current.saving, binary: current.binary,
      markdown: current.markdown, failed: current.failed, tree: current.tree, preview: current.preview,
      folderPicker: current.folderPicker, length: current.content.length };
  };
  const textBuffer = (expectedRevision?: string) => {
    const current = adapter.read();
    if (!current.path || !current.loaded || current.binary || current.failed) throw new Error("A readable text file must finish loading first.");
    if (expectedRevision !== undefined && current.revision !== expectedRevision) throw new Error("Editor revision changed. Read the current buffer before retrying.");
    return { ...current, path: current.path };
  };
  const idle = () => { if (adapter.read().saving) throw new Error("Wait for the current editor operation to finish."); };
  return {
    state,
    async execute(action: string, args: Readonly<Record<string, unknown>>): Promise<unknown> {
      switch (action) {
        case "editor_get_state": return state();
        case "editor_read_buffer": {
          const current = textBuffer();
          const offset = (args.offset as number | undefined) ?? 0;
          const length = (args.length as number | undefined) ?? 32768;
          if (offset > current.content.length) throw new Error("Buffer offset is outside the document.");
          return { ...state(), offset, content: current.content.slice(offset, offset + length), hasMore: offset + length < current.content.length };
        }
        case "editor_edit_buffer": {
          idle();
          const current = textBuffer(args.expectedRevision as string);
          const start = args.start as number;
          const end = start + (args.deleteCount as number);
          if (start > current.content.length || end > current.content.length) throw new Error("Edit range is outside the current buffer.");
          const content = current.content.slice(0, start) + (args.text as string) + current.content.slice(end);
          if (content.length > 2097152) throw new Error("Editor buffer exceeds the 2 MiB text limit.");
          adapter.change(content, true);
          return state();
        }
        case "editor_save": {
          idle();
          const current = textBuffer(args.expectedRevision as string);
          if (!current.dirty) return state();
          adapter.busy(true);
          try {
            await adapter.save(current.path, current.content);
            const next = adapter.read();
            if (next.path === current.path && next.revision === current.revision) adapter.change(current.content, false);
          } finally { adapter.busy(false); }
          return state();
        }
        case "editor_discard": {
          idle();
          const current = textBuffer(args.expectedRevision as string);
          adapter.busy(true);
          try {
            const content = await adapter.reload(current.path);
            const next = adapter.read();
            if (next.path !== current.path || next.revision !== current.revision) throw new Error("Editor changed while reloading. Its newer buffer was preserved.");
            adapter.change(content, false);
          } finally { adapter.busy(false); }
          return state();
        }
        case "editor_close_file":
          idle();
          if (adapter.read().dirty) throw new Error("Save or explicitly discard the current buffer before closing it.");
          adapter.close(); return { closed: true };
        case "editor_set_view": {
          if (args.preview === true && !adapter.read().markdown) throw new Error("Preview is available for Markdown files only.");
          adapter.view(args as { tree?: boolean; preview?: boolean; folderPicker?: boolean }); return state();
        }
        case "editor_copy_image": await adapter.copyImage(); return { copied: true };
        case "editor_list_directory": return adapter.list(args.path as string | undefined);
        case "editor_move_file": return adapter.move(args.path as string, args.destination as string);
        case "editor_delete_file": return adapter.remove(args.path as string);
        case "editor_refresh_tree": await adapter.treeAction(); return { refreshed: true };
        case "editor_expand_directory": await adapter.treeAction(args.path as string, args.expanded as boolean); return { updated: true };
        default: throw new Error("Unknown editor action.");
      }
    },
  };
}
type EditorController = ReturnType<typeof createEditorAppController>;
const editors = new Map<string, EditorController>();
export function registerEditorAppControl(tileId: string, controller: EditorController): () => void {
  editors.set(tileId, controller);
  return () => { if (editors.get(tileId) === controller) editors.delete(tileId); };
}
export function initEditorAppControlHandlers(): () => void {
  const cleanups = Object.keys(EDITOR_APP_COMMANDS).map(action => registerAppControlHandler(action, args => {
    const editor = editors.get(args.tileId as string);
    if (!editor) throw new Error("Open and reveal the tile editor before controlling its buffer.");
    return editor.execute(action, args);
  }));
  cleanups.push(registerAppControlState("editors", () => [...editors].map(([tileId, editor]) => ({ tileId, ...editor.state() }))));
  return () => { for (const cleanup of cleanups.reverse()) cleanup(); };
}
