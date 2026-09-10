import type { Session, TileCodeLayout, TransparencyOptions, useStore } from "./state/store";
import { APP_COMMANDS, validateAppCommand } from "../server/lib/app-control-schema.js";

export type AppControlStore = Pick<ReturnType<typeof useStore.getState>,
  | "tiles" | "activeId" | "activeWorkspaceId" | "connection" | "sessionWs" | "hiddenTiles" | "tileTitles" | "tileCode" | "workspaceColumns" | "defaultColumns"
  | "setActive" | "setWorkspace" | "unhideTile" | "toggleTileCode" | "setTileCodeRoot" | "setTileCodePath" | "setTileCodeLayout" | "setColumns" | "openSession" | "openWindow"
  | "workspaces" | "addWorkspace" | "removeWorkspace" | "renameWorkspace" | "setWorkspaceIcon" | "setWorkspaceColor" | "reorderWorkspace" | "assignSession"
  | "hideTile" | "closeTile" | "renameTile" | "reorderTile" | "setTileSpan" | "tileSpan" | "devices" | "addDevice" | "removeDevice" | "setHost" | "loadSessions"
  | "refreshing"
  | "themeId" | "setTheme" | "fontSize" | "setFontSize" | "cursorBlink" | "setCursorBlink" | "osc52Clipboard" | "setOsc52Clipboard"
  | "semiTransparent" | "setSemiTransparent" | "transparencyOptions" | "setTransparencyOptions"
>;
export interface AppControlContext {
  getState(): AppControlStore;
  hasUnsavedEditor(tileId: string): boolean;
  defaultWorkspaceId: string;
  allWorkspaceId: string;
  isWorkspaceIcon?(icon: string): boolean;
  executeRuntime?(action: string, args: Record<string, unknown>): unknown;
  readRuntime?(): Record<string, unknown>;
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
    actions: Object.keys(APP_COMMANDS),
    runtime: context.readRuntime?.() ?? {},
    workspaces: state.workspaces ?? [],
    devices: state.devices?.map(({ id, name, host, user }) => ({ id, name, host, user })) ?? [],
    appearance: { theme: state.themeId, fontSize: state.fontSize, cursorBlink: state.cursorBlink, osc52Clipboard: state.osc52Clipboard, semiTransparent: state.semiTransparent, ...state.transparencyOptions },
    sessionsRefreshing: state.refreshing ?? false,
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
        span: state.tileSpan?.[tile.id] ?? { c: 1, r: 1 },
        editor: { open: editor?.open ?? false, layout: editor?.layout ?? "full", path: editor?.path, root: editor?.root, unsaved: context.hasUnsavedEditor(tile.id), loadState: "not_reported" },
      };
    }),
  };
}

// Core state changes use the same store actions as the UI. Mounted controls
// provide typed adapters for their asynchronous operations.
export function executeAppControl(action: string, args: Record<string, unknown>, context: AppControlContext): unknown {
  args = validateAppCommand(action, args);
  const state = context.getState();
  const workspace = (id: unknown, allowAll = false) => {
    const key = text(id, "workspaceId");
    if (allowAll && key === context.allWorkspaceId) return key;
    if (!state.workspaces.some(item => item.id === key)) throw new Error("Unknown workspace.");
    return key;
  };
  const requireTile = (id: unknown) => {
    const found = state.tiles.find(item => item.id === id);
    if (!found) throw new Error("Unknown open tile.");
    return found;
  };
  const icon = args.icon === undefined ? undefined : text(args.icon, "icon");
  if (icon !== undefined && !context.isWorkspaceIcon?.(icon)) throw new Error("Unknown workspace icon.");
  switch (action) {
    case "set_workspace": state.setWorkspace(workspace(args.workspaceId, true)); return appControlSnapshot(context);
    case "create_workspace":
      state.addWorkspace(text(args.name, "name"), icon, args.color as string | undefined);
      return appControlSnapshot(context);
    case "configure_workspace": {
      const id = workspace(args.workspaceId);
      if (args.name !== undefined) state.renameWorkspace(id, args.name as string);
      if (icon !== undefined) state.setWorkspaceIcon(id, icon);
      if (args.color !== undefined) state.setWorkspaceColor(id, args.color as string);
      return appControlSnapshot(context);
    }
    case "delete_workspace": {
      const id = workspace(args.workspaceId);
      if (id === context.defaultWorkspaceId || state.workspaces.find(item => item.id === id)?.system || state.workspaces.length < 2) throw new Error("The default or system workspace cannot be deleted.");
      state.removeWorkspace(id);
      return appControlSnapshot(context);
    }
    case "reorder_workspace": {
      const id = workspace(args.workspaceId); const target = workspace(args.targetId);
      state.reorderWorkspace(id, target, args.placement as "before" | "after");
      return appControlSnapshot(context);
    }
    case "assign_tile": {
      const target = requireTile(args.tileId); const id = workspace(args.workspaceId);
      state.assignSession((target.host ? `${target.host}::` : "") + (target.session ?? target.name), id);
      return appControlSnapshot(context);
    }
    case "rename_tile": state.renameTile(requireTile(args.tileId).id, args.name as string); return appControlSnapshot(context);
    case "hide_tile": state.hideTile(requireTile(args.tileId).id); return appControlSnapshot(context);
    case "show_tile": state.unhideTile(requireTile(args.tileId).id); return appControlSnapshot(context);
    case "close_tile": {
      const target = requireTile(args.tileId);
      if (context.hasUnsavedEditor(target.id)) throw new Error("The target editor has unsaved changes or is saving. Save or discard them in the app first.");
      state.closeTile(target.id);
      return appControlSnapshot(context);
    }
    case "reorder_tile": { const source = requireTile(args.tileId); const target = requireTile(args.targetId); state.reorderTile(source.id, target.id); return appControlSnapshot(context); }
    case "set_tile_span": state.setTileSpan(requireTile(args.tileId).id, args.columns as number, args.rows as number); return appControlSnapshot(context);
    case "configure_appearance": {
      if (args.theme !== undefined) state.setTheme(args.theme as string);
      if (args.fontSize !== undefined) state.setFontSize(args.fontSize as number);
      if (args.cursorBlink !== undefined) state.setCursorBlink(args.cursorBlink as boolean);
      if (args.osc52Clipboard !== undefined) state.setOsc52Clipboard(args.osc52Clipboard as boolean);
      if (args.semiTransparent !== undefined) state.setSemiTransparent(args.semiTransparent as boolean);
      const options: Partial<TransparencyOptions> = {};
      for (const key of ["opacity", "blur", "saturation", "surfaceOpacity", "desktopBlurRadius"] as const) if (args[key] !== undefined) options[key] = args[key] as number;
      if (args.desktopBlur !== undefined) options.desktopBlur = args.desktopBlur as boolean;
      if (Object.keys(options).length) state.setTransparencyOptions(options);
      return appControlSnapshot(context);
    }
    case "add_device": {
      const host = args.user ? `${args.user}@${args.host}` : args.host as string;
      if (!/^[A-Za-z0-9._][A-Za-z0-9._@-]{0,127}$/.test(host)) throw new Error("Unsupported SSH host or user@host.");
      state.addDevice(args.name as string, args.host as string, args.user as string | undefined);
      return appControlSnapshot(context);
    }
    case "remove_device":
    case "set_connection": {
      const device = state.devices.find(item => item.id === args.deviceId);
      if (!device) throw new Error("Unknown device.");
      if (action === "remove_device") {
        if (device.id === "this-mac") throw new Error("The local device cannot be removed.");
        state.removeDevice(device.id);
      } else {
        const host = device.user ? `${device.user}@${device.host}` : device.host;
        if (device.id !== "this-mac" && !/^[A-Za-z0-9._][A-Za-z0-9._@-]{0,127}$/.test(host)) throw new Error("This device has an unsupported SSH host.");
        state.setHost(device.id === "this-mac" ? null : host);
      }
      return appControlSnapshot(context);
    }
    case "refresh_sessions":
      if (!state.refreshing) void state.loadSessions().catch(() => {});
      return { accepted: true, ...appControlSnapshot(context) };
  }
  if (action === "get_state") return appControlSnapshot(context);
  if (action === "open_session") {
    const session = text(args.session, "session");
    const cwd = text(args.cwd, "cwd");
    if (!/^[A-Za-z0-9_-]{1,128}$/.test(session) || !cwd.startsWith("/")) throw new Error("Invalid local session or directory.");
    const host = args.host as string | undefined ?? "";
    const window = args.window as number | undefined;
    const id = `${host ? `${host}::` : ""}${session}${window === undefined ? "" : `::w::${window}`}`;
    const existing = state.tiles.find(tile => (tile.session ?? tile.name) === session && (tile.host ?? state.connection.host ?? "") === host && tile.window === window);
    if (!existing) {
      if (state.tiles.some(tile => tile.id === id)) throw new Error("A different device already uses this tile ID.");
      if (window === undefined) state.openSession(session, cwd, host);
      else state.openWindow({ session, window, windowName: String(window), active: false, command: "", path: cwd }, `${session}:${window}`, host);
    }
    return executeAppControl("focus_tile", { tileId: existing?.id ?? id }, context);
  }
  if (action === "set_columns") {
    if (typeof args.columns !== "number" || !Number.isInteger(args.columns) || args.columns < 1 || args.columns > 8) {
      throw new Error("columns must be an integer from 1 to 8.");
    }
    state.setColumns(args.columns);
    return appControlSnapshot(context);
  }
  if (!["focus_tile", "open_editor", "close_editor", "set_layout"].includes(action)) {
    if (context.executeRuntime) return context.executeRuntime(action, args);
    throw new Error("The requested app capability is not available in this window.");
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
