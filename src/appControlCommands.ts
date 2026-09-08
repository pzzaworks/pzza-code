import type { Session, TileCode, TileCodeLayout } from "./state/store";

export interface AppControlStore {
  tiles: Session[];
  activeId: string | null;
  activeWorkspaceId: string;
  connection: { host: string | null };
  sessionWs: Record<string, string>;
  hiddenTiles: string[];
  tileTitles: Record<string, string>;
  tileCode: Record<string, TileCode>;
  workspaceColumns: Record<string, number>;
  defaultColumns: number;
  setActive(id: string): void;
  setWorkspace(id: string): void;
  unhideTile(id: string): void;
  toggleTileCode(id: string, root?: string): void;
  setTileCodeRoot(id: string, root: string): void;
  setTileCodePath(id: string, path: string): void;
  setTileCodeLayout(id: string, layout: TileCodeLayout): void;
  setColumns(columns: number): void;
  openSession(name: string, cwd?: string, host?: string): void;
}
export interface AppControlContext {
  getState(): AppControlStore;
  hasUnsavedEditor(tileId: string): boolean;
  defaultWorkspaceId: string;
  allWorkspaceId: string;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 4096 || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new Error(`${field} must be a nonempty string without control characters.`);
  }
  return value;
}
function layout(value: unknown): TileCodeLayout {
  if (value !== "full" && value !== "side-by-side" && value !== "stacked") throw new Error("Unknown panel layout.");
  return value;
}
function workspaceFor(state: AppControlStore, tile: Session, fallback: string): string {
  const key = (tile.host ? `${tile.host}::` : "") + (tile.session ?? tile.name);
  return state.sessionWs[key] ?? fallback;
}

export function appControlSnapshot(context: AppControlContext) {
  const state = context.getState();
  return {
    activeId: state.activeId,
    workspaceId: state.activeWorkspaceId,
    columns: state.workspaceColumns[state.activeWorkspaceId] ?? state.defaultColumns,
    tiles: state.tiles.map((tile) => {
      const editor = state.tileCode[tile.id];
      return {
        id: tile.id,
        name: state.tileTitles[tile.id] || tile.name,
        session: tile.session ?? tile.name,
        window: tile.window,
        host: tile.host ?? state.connection.host ?? "",
        workspaceId: workspaceFor(state, tile, context.defaultWorkspaceId),
        hidden: state.hiddenTiles.includes(tile.id),
        editor: { open: editor?.open ?? false, layout: editor?.layout ?? "full", path: editor?.path, root: editor?.root, unsaved: context.hasUnsavedEditor(tile.id), loadState: "not_reported" },
      };
    }),
  };
}

// Commands select app state. They do not execute terminal input, read files,
// confirm discard dialogs, or claim that an iframe/file has finished loading.
export function executeAppControl(action: string, args: Record<string, unknown>, context: AppControlContext) {
  const state = context.getState();
  if (action === "get_state") return appControlSnapshot(context);
  if (action === "open_session") {
    const session = text(args.session, "session");
    const cwd = text(args.cwd, "cwd");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session) || !cwd.startsWith("/")) throw new Error("Invalid local session or directory.");
    const existing = state.tiles.find((tile) => (tile.session ?? tile.name) === session && !(tile.host ?? state.connection.host));
    if (!existing) {
      if (state.tiles.some((tile) => tile.id === session)) throw new Error("A different device already uses this tile ID.");
      state.openSession(session, cwd, "");
    }
    return executeAppControl("focus_tile", { tileId: existing?.id ?? session }, context);
  }
  if (action === "set_columns") {
    if (typeof args.columns !== "number" || !Number.isInteger(args.columns) || args.columns < 1 || args.columns > 8) {
      throw new Error("columns must be an integer from 1 to 8.");
    }
    state.setColumns(args.columns);
    return appControlSnapshot(context);
  }
  if (!["focus_tile", "open_editor", "close_editor", "set_layout"].includes(action)) {
    throw new Error("Unknown app control action.");
  }
  const id = text(args.tileId, "tileId");
  if (id.length > 512) throw new Error("tileId is too long.");
  const tile = state.tiles.find((candidate) => candidate.id === id);
  if (!tile) throw new Error("Unknown open tile.");
  const nextLayout = args.layout === undefined ? undefined : layout(args.layout);
  const focus = () => {
    const workspace = workspaceFor(state, tile, context.defaultWorkspaceId);
    if (state.activeWorkspaceId !== context.allWorkspaceId && state.activeWorkspaceId !== workspace) state.setWorkspace(workspace);
    if (state.hiddenTiles.includes(id)) state.unhideTile(id);
    state.setActive(id);
  };
  switch (action) {
    case "focus_tile": focus(); break;
    case "open_editor": {
      const root = args.root === undefined ? undefined : text(args.root, "root");
      const path = args.path === undefined ? undefined : text(args.path, "path");
      const current = state.tileCode[id];
      const rootChanges = root !== undefined && root !== current?.root;
      const pathChanges = path !== undefined && path !== current?.path;
      if ((!current?.open || rootChanges || pathChanges) && context.hasUnsavedEditor(id)) {
        throw new Error("The target editor has unsaved changes or is saving. Save or discard them in the app first.");
      }
      if (!current?.open) state.toggleTileCode(id, root ?? tile.path ?? tile.cwd);
      if (rootChanges) state.setTileCodeRoot(id, root);
      if (path !== undefined && (!current?.open || pathChanges || rootChanges)) state.setTileCodePath(id, path);
      if (nextLayout) state.setTileCodeLayout(id, nextLayout);
      focus();
      break;
    }
    case "close_editor":
      if (state.tileCode[id]?.open) {
        if (context.hasUnsavedEditor(id)) throw new Error("The target editor has unsaved changes or is saving. Save or discard them in the app first.");
        state.toggleTileCode(id);
      }
      break;
    case "set_layout":
      if (!nextLayout) throw new Error("layout is required.");
      if (!state.tileCode[id]?.open) throw new Error("The editor panel is closed.");
      state.setTileCodeLayout(id, nextLayout);
      break;
  }
  return appControlSnapshot(context);
}
