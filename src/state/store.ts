import { create } from "zustand";
import { DEFAULT_THEME_ID, migrateThemeId, themeById } from "../theme/themes";
import {
  loadConnection,
  saveConnection,
  listRemoteSessions,
  type Connection,
  type RemoteSession,
} from "../connection";
import { fetchSessions, fetchWindows, locateWindows, type RemoteWindow } from "../serverApi";
import { refreshedIdentity, validSessionCreatedAt, validWindowId, type LocatedWindow } from "../windowIdentity";
import { HAS_TAURI } from "../tauriEnv";
import { validHiddenBarItems, type BarItemId } from "../barItems";
import {
  ALL_WORKSPACE_ID,
  DEFAULT_WORKSPACES,
  DEFAULT_WORKSPACE_ID,
  markFor,
  wsKeyOf,
  type Workspace,
} from "../workspaces";
import { DEFAULT_DEVICES, THIS_MAC, type Device } from "../devices";
import { QUICK_CHAT_SESSION, tileTitle } from "../sessionMeta";
import { AUTO_COLUMNS } from "../grid/autoLayout";

// A tile open on the canvas. id === tmux session name. Tile order IS the grid
// arrangement - the canvas is a uniform N-column grid, never free-floating.
export interface Session {
  id: string;
  name: string; // display title
  cwd?: string;
  session?: string; // base tmux session (for window tiles)
  window?: number; // tmux window index (for window tiles)
  // Window tiles: tmux's id ("@7") of the window the tile was opened on, and
  // the creation time (ms) of the session it was read from. tmux reuses ids
  // after a server restart, so the id counts only while that session lives
  // (see windowIdentity.ts). Terminate never ends another window that took
  // the tile's index.
  windowId?: string;
  windowSessionCreatedAt?: number;
  command?: string; // window tile: active command (icon)
  path?: string; // window tile: cwd
  host?: string; // ssh target for a session that lives on another device
}

const TILES_KEY = "pzza.tiles";
const COLUMNS_KEY = "pzza.columns";
const WSCOLUMNS_KEY = "pzza.wsColumns";
const SESSIONWS_KEY = "pzza.sessionWs";
const HIDDEN_KEY = "pzza.hidden";
const DEVICES_KEY = "pzza.devices";
const DEVICE_RDP_KEY = "pzza.deviceRdp";
const TILESPAN_KEY = "pzza.tileSpan";
const TILETITLES_KEY = "pzza.tileTitles";
const TILECODE_KEY = "pzza.tileCode";
const TRANSPARENCY_KEY = "pzza.semiTransparent";
const GRAYSCALE_KEY = "pzza.grayscale";
const HIDDEN_BAR_ITEMS_KEY = "pzza.hiddenBarItems";
const SPACING_KEY = "pzza.spacing";
/** Room around and between tiles, in px: the same value everywhere. */
export const SPACING_RANGE = { min: 0, max: 24, default: 10, joined: 0, smallestGap: 4 } as const;
// 1-3px would set two tile borders (and the header line) a pixel or two
// apart, which reads as a doubled line: tiles either join (0) or keep at
// least 4px between them, so those values settle on the nearer of the two.
export function normalizeSpacing(value: number): number {
  const rounded = Math.round(Math.min(SPACING_RANGE.max, Math.max(SPACING_RANGE.min, value)));
  if (rounded > SPACING_RANGE.joined && rounded < SPACING_RANGE.smallestGap) return rounded < SPACING_RANGE.smallestGap / 2 ? SPACING_RANGE.joined : SPACING_RANGE.smallestGap;
  return rounded;
}
function validSpacing(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? normalizeSpacing(value) : SPACING_RANGE.default;
}
const TRANSPARENCY_OPTIONS_KEY = "pzza.transparencyOptions";
export interface TransparencyOptions { opacity: number; blur: number; saturation: number; surfaceOpacity: number; textVisibility: number; desktopBlur: boolean; desktopBlurRadius: number }
export const DEFAULT_TRANSPARENCY_OPTIONS: Readonly<TransparencyOptions> = {
  opacity: 55, surfaceOpacity: 50, textVisibility: 0, blur: 20, saturation: 116, desktopBlur: true, desktopBlurRadius: 20,
};
function transparencyOptions(value: Partial<TransparencyOptions>): TransparencyOptions {
  const defaults = DEFAULT_TRANSPARENCY_OPTIONS;
  const bound = (value: unknown, fallback: number, min: number, max: number) =>
    typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  return { opacity: bound(value?.opacity, defaults.opacity, 5, 95), blur: bound(value?.blur, defaults.blur, 0, 40), saturation: bound(value?.saturation, defaults.saturation, 50, 180),
    surfaceOpacity: bound(value?.surfaceOpacity, defaults.surfaceOpacity, 5, 100), desktopBlur: typeof value?.desktopBlur === "boolean" ? value.desktopBlur : defaults.desktopBlur,
    desktopBlurRadius: Math.round(bound(value?.desktopBlurRadius, defaults.desktopBlurRadius, 0, 64)), textVisibility: Math.round(bound(value?.textVisibility, defaults.textVisibility, 0, 100)) };
}
const THEME_KEY = "pzza.theme";
const FONT_KEY = "pzza.fontSize";
const CURSOR_KEY = "pzza.cursorBlink";
const OSC52_KEY = "pzza.osc52Clipboard";
const WORKSPACES_KEY = "pzza.workspaces";

function load<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw) return JSON.parse(raw) as T;
  } catch {
    /* ignore */
  }
  return fallback;
}

// Persisted values are never trusted: storage can be corrupted, edited by
// hand or written by another version of the app. Each key is checked on its
// own, entries that do not fit are dropped and a key that does not fit at all
// falls back to its default, so one bad value never stops the app from
// starting (this runs at import, before anything renders).
function loadValid<T>(key: string, parse: (value: unknown) => T | undefined, fallback: T): T {
  const value = load<unknown>(key, undefined);
  if (value === undefined) return fallback;
  try {
    return parse(value) ?? fallback;
  } catch {
    return fallback;
  }
}

type Fields = Record<string, unknown>;
const isFields = (value: unknown): value is Fields => !!value && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;
const optionalText = (value: unknown): string | undefined => (typeof value === "string" ? value : undefined);
const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
const bool = (value: unknown): boolean | undefined => (typeof value === "boolean" ? value : undefined);

function listOf<T>(parse: (value: unknown) => T | undefined): (value: unknown) => T[] | undefined {
  return (value) => (Array.isArray(value) ? value.flatMap((item) => { const parsed = parse(item); return parsed === undefined ? [] : [parsed]; }) : undefined);
}

function recordOf<T>(parse: (value: unknown) => T | undefined): (value: unknown) => Record<string, T> | undefined {
  return (value) => {
    if (!isFields(value)) return undefined;
    const out: Record<string, T> = {};
    for (const [key, item] of Object.entries(value)) {
      const parsed = parse(item);
      if (parsed !== undefined) out[key] = parsed;
    }
    return out;
  };
}

// Drops every entry whose `id` was already seen (React keys and lookups need them unique).
function uniqueById<T extends { id: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => !seen.has(item.id) && !!seen.add(item.id));
}

function parseDevice(value: unknown): Device | undefined {
  if (!isFields(value) || !text(value.id) || !text(value.name) || !text(value.host)) return undefined;
  return { id: value.id, name: value.name, host: value.host, ...(text(value.user) ? { user: value.user } : {}), ...(value.disabled === true ? { disabled: true } : {}) };
}

function parseWorkspace(value: unknown): Workspace | undefined {
  if (!isFields(value) || !text(value.id) || value.id === ALL_WORKSPACE_ID || !text(value.name)) return undefined;
  return {
    id: value.id, name: value.name, short: text(value.short) ? value.short : markFor(value.name),
    ...(text(value.icon) ? { icon: value.icon } : {}), ...(text(value.color) ? { color: value.color } : {}), ...(value.system === true ? { system: true } : {}),
  };
}

// The default workspace always exists: sessions without a workspace of their
// own belong to it, and a deleted workspace's sessions move to it.
function withDefaultWorkspace(workspaces: Workspace[]): Workspace[] {
  return workspaces.some((workspace) => workspace.id === DEFAULT_WORKSPACE_ID) ? workspaces : [...DEFAULT_WORKSPACES, ...workspaces];
}

// A window tile whose window id is missing or not yet tied to its session.
const untiedWindowTile = (tile: Session): boolean => tile.window !== undefined && tile.windowSessionCreatedAt === undefined;

function parseTile(value: unknown): Session | undefined {
  if (!isFields(value) || !text(value.id) || !text(value.name)) return undefined;
  const tile: Session = { id: value.id, name: value.name };
  for (const key of ["cwd", "session", "command", "path", "host"] as const) {
    const field = optionalText(value[key]);
    if (field !== undefined) tile[key] = field;
  }
  if (Number.isInteger(value.window) && (value.window as number) >= 0) {
    tile.window = value.window as number;
    // An id not tied to its session cannot be told apart from one a later
    // terminal server reused; it is looked up again from the index instead.
    if (validWindowId(value.windowId) && validSessionCreatedAt(value.windowSessionCreatedAt)) {
      tile.windowId = value.windowId;
      tile.windowSessionCreatedAt = value.windowSessionCreatedAt;
    }
  }
  return tile;
}

function parseSpan(value: unknown): { c: number; r: number } | undefined {
  return isFields(value) && finite(value.c) && finite(value.r) && value.c > 0 && value.r > 0 ? { c: value.c, r: value.r } : undefined;
}

const CODE_LAYOUTS: readonly TileCodeLayout[] = ["full", "side-by-side", "stacked"];
function parseTileCode(value: unknown): TileCode | undefined {
  if (!isFields(value) || typeof value.open !== "boolean") return undefined;
  const layout = CODE_LAYOUTS.find((entry) => entry === value.layout);
  return {
    open: value.open,
    ...(layout ? { layout } : {}),
    ...(finite(value.split) && value.split > 0 && value.split < 1 ? { split: value.split } : {}),
    ...(finite(value.treeWidth) && value.treeWidth > 0 ? { treeWidth: value.treeWidth } : {}),
    ...(typeof value.root === "string" ? { root: value.root } : {}),
    ...(typeof value.path === "string" ? { path: value.path } : {}),
    ...(value.view === "changes" ? { view: "changes" as const } : {}),
  };
}

function parseDeviceRdp(value: unknown): DeviceRdp | undefined {
  if (!isFields(value) || typeof value.user !== "string" || !text(value.keychainService)) return undefined;
  return {
    user: value.user, keychainService: value.keychainService,
    ...(Number.isInteger(value.port) && (value.port as number) > 0 && (value.port as number) < 65536 ? { port: value.port as number } : {}),
    ...(typeof value.mode === "string" ? { mode: value.mode } : {}),
  };
}

// Grid columns: AUTO_COLUMNS (0) or a fixed count.
const parseColumns = (value: unknown): number | undefined => (Number.isInteger(value) && (value as number) >= 0 && (value as number) <= 12 ? (value as number) : undefined);

function parseConnection(value: unknown): Connection | undefined {
  return isFields(value) && (value.host === null || typeof value.host === "string") ? { host: value.host } : undefined;
}

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* preview / private mode */
  }
}

// Remove one saved tile span, returning the original map untouched when the
// id has no explicit layout (the common case: fresh tiles are auto).
function dropTileSpan(spans: Record<string, { c: number; r: number }>, id: string): Record<string, { c: number; r: number }> {
  if (!(id in spans)) return spans;
  const tileSpan = { ...spans };
  delete tileSpan[id];
  persist(TILESPAN_KEY, tileSpan);
  return tileSpan;
}

async function listSessions(conn: Connection): Promise<RemoteSession[]> {
  return HAS_TAURI ? listRemoteSessions(conn) : fetchSessions();
}

interface ConsoleState {
  semiTransparent: boolean;
  grayscale: boolean;
  setGrayscale: (enabled: boolean) => void;
  // Top bar tools and status bar items turned off in Settings > Appearance.
  hiddenBarItems: BarItemId[];
  setBarItemShown: (id: BarItemId, shown: boolean) => void;
  spacing: number;
  setSpacing: (value: number) => void;
  setSemiTransparent: (enabled: boolean) => void;
  transparencyOptions: TransparencyOptions;
  setTransparencyOptions: (options: Partial<TransparencyOptions>) => void;
  transparencyNotice: string | null;
  setTransparencyNotice: (notice: string | null) => void;
  themeId: string;
  setTheme: (id: string) => void;

  connection: Connection;
  setHost: (host: string | null) => void;

  workspaces: Workspace[];
  activeWorkspaceId: string;
  setWorkspace: (id: string) => void;
  reorderWorkspace: (id: string, targetId: string, placement: "before" | "after") => void;
  addWorkspace: (name: string, icon?: string, color?: string) => void;
  removeWorkspace: (id: string) => void;
  renameWorkspace: (id: string, name: string) => void;
  setWorkspaceIcon: (id: string, icon: string) => void;
  setWorkspaceColor: (id: string, color: string) => void;

  // Which workspace a session belongs to (name -> workspace id). Unmapped
  // sessions belong to the default workspace.
  sessionWs: Record<string, string>;
  assignSession: (name: string, wsId: string) => void;

  // Hidden tiles (session names): open but not shown on the canvas.
  hiddenTiles: string[];
  hideTile: (name: string) => void;
  unhideTile: (name: string) => void;

  // Exact on-screen visibility per tile, reported by the terminal's own
  // IntersectionObserver (display:none from workspace/hide/maximize, or
  // scrolled out of view). Runtime-only, never persisted. Missing entry =
  // not measured yet, treated as visible so background polling never fires
  // on a tile that simply hasn't mounted.
  tileObserved: Record<string, boolean>;
  setTileObserved: (id: string, visible: boolean) => void;
  clearTileObserved: (id: string) => void;

  // Managed ssh devices (for RDP + forwarding server/client).
  devices: Device[];
  // `devices` without the disabled ones; everything except device management
  // reads this list.
  activeDevices: Device[];
  addDevice: (name: string, host: string, user?: string) => void;
  removeDevice: (id: string) => void;
  setDeviceDisabled: (id: string, disabled: boolean) => void;

  // Per-device RDP config, provisioned by the wizard (user + cert fingerprint +
  // the Keychain service holding the password). Absent = not set up yet.
  deviceRdp: Record<string, DeviceRdp>;
  setDeviceRdp: (id: string, cfg: DeviceRdp) => void;

  // Per-tile grid span: {c: columns, r: rows}. Capped to the column count.
  tileSpan: Record<string, { c: number; r: number }>;
  setTileSpan: (id: string, c: number, r: number) => void;
  clearTileSpan: (id: string) => void;
  // Drops every saved span in a workspace and lets the canvas pick its columns.
  autoArrange: (workspaceId: string) => number;

  // Optional per-tile display-name override (empty clears it back to default).
  tileTitles: Record<string, string>;
  renameTile: (id: string, title: string) => void;

  // Grid columns are per-workspace.
  // AUTO_COLUMNS (0) picks the columns from the tile count and window size.
  workspaceColumns: Record<string, number>;
  defaultColumns: number;
  // Columns for a workspace (the active one unless named).
  setColumns: (n: number, workspaceId?: string) => void;

  // Terminal appearance (applied live to every tile).
  fontSize: number;
  setFontSize: (n: number) => void;
  cursorBlink: boolean;
  setCursorBlink: (v: boolean) => void;
  // Let programs set the OS clipboard via OSC 52. Off by default: terminal
  // output is untrusted and a silent clipboard overwrite is a paste-jacking vector.
  osc52Clipboard: boolean;
  setOsc52Clipboard: (v: boolean) => void;

  settingsOpen: boolean;
  setSettingsOpen: (v: boolean) => void;

  // The setup/agent wizard modal. Lives in the store so it can be opened from
  // anywhere (first-run boot, the Settings menu, an empty-state prompt).
  wizardOpen: boolean;
  setWizardOpen: (v: boolean) => void;
  // The full-window setup is showing: the window blurs the desktop more under it.
  setupVisible: boolean;
  setSetupVisible: (v: boolean) => void;

  showPorts: boolean;
  togglePorts: () => void;

  allSessions: RemoteSession[];
  allWindows: RemoteWindow[];
  tiles: Session[];
  activeId: string | null;
  refreshing: boolean;
  // Bumped whenever the grid is reshaped (tile added/removed, workspace switch,
  // layout/column change). Terminals watch it and force a clean tmux redraw so a
  // resize triggered by another tile never leaves them with paint artifacts.
  refreshNonce: number;

  loadSessions: () => Promise<void>;
  openSession: (name: string, cwd?: string, host?: string) => void;
  openWindow: (w: RemoteWindow, displayName: string, host?: string) => void;
  /**
   * Keeps window tiles' window ids tied to the session they were read from:
   * tiles without one (or whose id is not yet tied) are looked up, and so is
   * every window tile on `recheckHost` (its terminal server was replaced).
   */
  recordWindowIds: (recheckHost?: string) => Promise<void>;
  closeTile: (id: string) => void;
  reorderTile: (fromId: string, toId: string) => void;
  /** Puts back a saved workspace layout (see workspaceSnapshots): these tiles
   *  in this order among the positions they hold, with their sizes, titles,
   *  hidden state and editors, and the workspace's columns. */
  applyWorkspaceLayout: (workspaceId: string, layout: { tiles: { id: string; name: string; span?: { c: number; r: number }; title?: string; hidden?: boolean; code?: TileCode }[]; columns?: number }) => void;
  moveTileToEnd: (id: string) => void;
  setActive: (id: string) => void;
  seedPreview: () => void;

  // Each window can flip into an inline code editor rooted at its own folder,
  // keyed by the tile id. The terminal stays alive underneath while it is open.
  tileCode: Record<string, TileCode>;
  toggleTileCode: (id: string, defaultRoot?: string) => void;
  setTileCodeLayout: (id: string, layout: TileCodeLayout) => void;
  setTileCodeSizes: (id: string, sizes: Pick<TileCode, "split" | "treeWidth">) => void;
  setTileCodeRoot: (id: string, root: string) => void;
  setTileCodePath: (id: string, path: string) => void;
  closeTileFile: (id: string) => void;
  setTileCodeView: (id: string, view: TileCodeView) => void;
  /** Opens the tile's editor (rooted at its current folder, else `folder`) on
   *  the Changes view. */
  openTileChanges: (id: string, folder: string) => void;
  /** Bumped by openTileChanges so a panel already on Changes shows its list again (not persisted). */
  changesReveal: Record<string, number>;
}

// Per-device RDP account (the password lives in the Keychain under
// keychainService) plus what the last launch found on the device.
export interface DeviceRdp {
  user: string;
  keychainService: string;
  port?: number; // RDP port on the device (the headless daemon uses its own)
  mode?: string; // "headless" or "session"
}

export type TileCodeLayout = "full" | "side-by-side" | "stacked";

export interface TileCode {
  open: boolean;
  layout?: TileCodeLayout;
  split?: number; // terminal share of the tile body when split, 0-1
  treeWidth?: number; // file tree width in px
  root?: string;
  path?: string;
  view?: TileCodeView; // left pane: absent means "files"
}

export type TileCodeView = "files" | "changes";
// Stored entries are unvalidated JSON, so anything but "changes" is the file tree.
export function tileCodeView(code: TileCode | undefined): TileCodeView {
  return code?.view === "changes" ? "changes" : "files";
}

// Always keep a "This Mac" local device (the machine running the app), and
// make it the first entry so it is the default current device. Drop any stale
// pre-seeded "devbox" placeholder that was never actually added by the user.
const initialDevices = ((): Device[] => {
  const loaded = uniqueById(loadValid(DEVICES_KEY, listOf(parseDevice), DEFAULT_DEVICES)).filter(
    (d) => d.id !== "devbox",
  );
  const withoutMac = loaded.filter((d) => d.id !== THIS_MAC.id);
  return [THIS_MAC, ...withoutMac];
})();

// The saved workspaces, always with the default one (installs that deleted it
// before it was protected get it back, with the sessions that pointed to it).
const initialWorkspaces = withDefaultWorkspace(
  uniqueById(loadValid(WORKSPACES_KEY, listOf(parseWorkspace), DEFAULT_WORKSPACES))
    .map((w) => (w.name === "main" ? { ...w, name: "Main", short: "M" } : w)),
);

// Session assignments to workspaces that no longer exist would hide those
// tiles from every workspace but All: they belong to the default one instead.
const initialSessionWs = ((): Record<string, string> => {
  const known = new Set(initialWorkspaces.map((workspace) => workspace.id));
  const saved = loadValid(SESSIONWS_KEY, recordOf((value) => (text(value) ? value : undefined)), {});
  return Object.fromEntries(Object.entries(saved).filter(([, workspaceId]) => known.has(workspaceId)));
})();

// Both lists are stored together so selectors return stable references.
function deviceLists(devices: Device[]): Pick<ConsoleState, "devices" | "activeDevices"> {
  return { devices, activeDevices: devices.filter((device) => !device.disabled) };
}

export const useStore = create<ConsoleState>((set, get) => ({
  // On unless the user turned it off: a saved false is kept.
  semiTransparent: load<unknown>(TRANSPARENCY_KEY, true) !== false,
  setSemiTransparent: (enabled) => {
    persist(TRANSPARENCY_KEY, enabled);
    set({ semiTransparent: enabled, transparencyNotice: null });
  },
  transparencyNotice: null,
  grayscale: load<unknown>(GRAYSCALE_KEY, false) === true,
  setGrayscale: (enabled) => {
    persist(GRAYSCALE_KEY, enabled);
    set({ grayscale: enabled });
  },
  hiddenBarItems: validHiddenBarItems(load<unknown>(HIDDEN_BAR_ITEMS_KEY, [])),
  setBarItemShown: (id, shown) => {
    const hidden = get().hiddenBarItems.filter(item => item !== id);
    const next = shown ? hidden : [...hidden, id];
    persist(HIDDEN_BAR_ITEMS_KEY, next);
    set({ hiddenBarItems: next });
  },
  spacing: validSpacing(load<unknown>(SPACING_KEY, SPACING_RANGE.default)),
  setSpacing: (value) => {
    const next = validSpacing(value);
    persist(SPACING_KEY, next);
    set({ spacing: next });
  },
  transparencyOptions: transparencyOptions(loadValid<Partial<TransparencyOptions>>(TRANSPARENCY_OPTIONS_KEY, (value) => (isFields(value) ? value : undefined), {})),
  setTransparencyOptions: (options) => {
    const next = transparencyOptions({ ...get().transparencyOptions, ...options });
    persist(TRANSPARENCY_OPTIONS_KEY, next);
    set({ transparencyOptions: next });
  },
  setTransparencyNotice: (notice) => set({ transparencyNotice: notice }),
  themeId: (() => {
    const saved = loadValid(THEME_KEY, (value) => (text(value) ? value : undefined), DEFAULT_THEME_ID);
    const mode = migrateThemeId(saved);
    if (mode !== saved) persist(THEME_KEY, mode);
    return mode;
  })(),
  setTheme: (id) => {
    const selected = themeById(id).id;
    persist(THEME_KEY, selected);
    set({ themeId: selected });
  },

  connection: parseConnection(loadConnection()) ?? { host: null },
  setHost: (host) => {
    const connection = { host };
    saveConnection(connection);
    set({ connection });
  },

  workspaces: initialWorkspaces,
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  setWorkspace: (id) => {
    set((state) => {
      // Switching workspaces with nothing focused there feels dead: when the
      // active tile is not visible in the target workspace, focus its first
      // visible tile (same visibility rule as the canvas).
      const visible = state.tiles.filter(
        (t) =>
          (id === ALL_WORKSPACE_ID || (state.sessionWs[wsKeyOf(t)] ?? DEFAULT_WORKSPACE_ID) === id) &&
          !state.hiddenTiles.includes(t.id),
      );
      const first = visible.length ? visible[0] : undefined;
      return {
        activeWorkspaceId: id,
        refreshNonce: state.refreshNonce + 1,
        ...(first && !visible.some((t) => t.id === state.activeId) ? { activeId: first.id } : {}),
      };
    });
  },
  reorderWorkspace: (id, targetId, placement) => set((state) => {
    const source = state.workspaces.find((workspace) => workspace.id === id);
    if (!source || id === targetId || !state.workspaces.some((workspace) => workspace.id === targetId)) return state;
    const workspaces = state.workspaces.filter((workspace) => workspace.id !== id);
    const target = workspaces.findIndex((workspace) => workspace.id === targetId);
    workspaces.splice(target + (placement === "after" ? 1 : 0), 0, source);
    if (workspaces.every((workspace, index) => workspace.id === state.workspaces[index].id)) return state;
    persist(WORKSPACES_KEY, workspaces);
    return { workspaces };
  }),
  addWorkspace: (name, icon, color) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const id = `ws-${Date.now().toString(36)}`;
    const ws: Workspace = { id, name: trimmed, short: markFor(trimmed), icon, color };
    const workspaces = [...get().workspaces, ws];
    persist(WORKSPACES_KEY, workspaces);
    set({ workspaces });
    get().setWorkspace(id);
  },
  removeWorkspace: (id) => {
    // Built-in workspaces and the default one (where unassigned and moved
    // sessions belong) are undeletable, as in app control.
    if (id === DEFAULT_WORKSPACE_ID || get().workspaces.find((w) => w.id === id)?.system) return;
    const workspaces = get().workspaces.filter((w) => w.id !== id);
    if (workspaces.length === 0) return; // always keep at least one
    // Move any sessions that were in the removed workspace back to the default.
    const sessionWs = { ...get().sessionWs };
    for (const k of Object.keys(sessionWs)) {
      if (sessionWs[k] === id) sessionWs[k] = DEFAULT_WORKSPACE_ID;
    }
    persist(WORKSPACES_KEY, workspaces);
    persist(SESSIONWS_KEY, sessionWs);
    set({ workspaces, sessionWs });
    if (get().activeWorkspaceId === id) get().setWorkspace(workspaces[0].id);
  },

  renameWorkspace: (id, name) => {
    const trimmed = name.trim();
    if (!trimmed) return;
    const workspaces = get().workspaces.map((w) =>
      w.id === id ? { ...w, name: trimmed, short: markFor(trimmed) } : w,
    );
    persist(WORKSPACES_KEY, workspaces);
    set({ workspaces });
  },
  setWorkspaceIcon: (id, icon) => {
    const workspaces = get().workspaces.map((w) =>
      w.id === id ? { ...w, icon } : w,
    );
    persist(WORKSPACES_KEY, workspaces);
    set({ workspaces });
  },
  setWorkspaceColor: (id, color) => {
    const workspaces = get().workspaces.map((w) =>
      w.id === id ? { ...w, color } : w,
    );
    persist(WORKSPACES_KEY, workspaces);
    set({ workspaces });
  },

  sessionWs: initialSessionWs,
  assignSession: (name, wsId) => {
    const sessionWs = { ...get().sessionWs, [name]: wsId };
    persist(SESSIONWS_KEY, sessionWs);
    set({ sessionWs });
  },

  hiddenTiles: loadValid(HIDDEN_KEY, listOf((value) => (typeof value === "string" ? value : undefined)), []),
  hideTile: (name) => {
    const hiddenTiles = [...new Set([...get().hiddenTiles, name])];
    persist(HIDDEN_KEY, hiddenTiles);
    set({ hiddenTiles });
  },
  unhideTile: (name) => {
    const hiddenTiles = get().hiddenTiles.filter((n) => n !== name);
    persist(HIDDEN_KEY, hiddenTiles);
    set({ hiddenTiles });
  },
  tileObserved: {},
  setTileObserved: (id, visible) => {
    if (get().tileObserved[id] === visible) return;
    set((state) => ({ tileObserved: { ...state.tileObserved, [id]: visible } }));
  },
  clearTileObserved: (id) => {
    if (!(id in get().tileObserved)) return;
    set((state) => {
      const tileObserved = { ...state.tileObserved };
      delete tileObserved[id];
      return { tileObserved };
    });
  },

  ...deviceLists(initialDevices),
  addDevice: (name, host, user) => {
    const trimmed = name.trim();
    const h = host.trim();
    if (!trimmed || !h) return;
    const device: Device = {
      id: `dev-${Date.now().toString(36)}`,
      name: trimmed,
      host: h,
      user: user?.trim() || undefined,
    };
    const devices = [...get().devices, device];
    persist(DEVICES_KEY, devices);
    set(deviceLists(devices));
  },
  removeDevice: (id) => {
    if (id === "this-mac") return; // the local machine is always present
    if (!get().devices.some(device => device.id === id)) return;
    const devices = get().devices.filter((d) => d.id !== id);
    persist(DEVICES_KEY, devices);
    set(deviceLists(devices));
  },
  setDeviceDisabled: (id, disabled) => {
    if (id === THIS_MAC.id) return; // the local machine always stays enabled
    const current = get().devices.find(device => device.id === id);
    if (!current || !!current.disabled === disabled) return;
    const devices = get().devices.map((d) => d.id !== id ? d : disabled ? { ...d, disabled: true } : { id: d.id, name: d.name, host: d.host, user: d.user });
    persist(DEVICES_KEY, devices);
    set(deviceLists(devices));
  },

  deviceRdp: loadValid(DEVICE_RDP_KEY, recordOf(parseDeviceRdp), {}),
  setDeviceRdp: (id, cfg) => {
    const deviceRdp = { ...get().deviceRdp, [id]: cfg };
    persist(DEVICE_RDP_KEY, deviceRdp);
    set({ deviceRdp });
  },

  tileTitles: loadValid(TILETITLES_KEY, recordOf((value) => (text(value) ? value : undefined)), {}),
  renameTile: (id, title) => {
    const tileTitles = { ...get().tileTitles };
    const trimmed = title.trim();
    if (trimmed) tileTitles[id] = trimmed;
    else delete tileTitles[id];
    persist(TILETITLES_KEY, tileTitles);
    set({ tileTitles });
  },

  tileSpan: loadValid(TILESPAN_KEY, recordOf(parseSpan), {}),
  setTileSpan: (id, c, r) => {
    const tileSpan = { ...get().tileSpan, [id]: { c, r } };
    persist(TILESPAN_KEY, tileSpan);
    set((state) => ({ tileSpan, refreshNonce: state.refreshNonce + 1 }));
  },
  clearTileSpan: (id) => {
    const tileSpan = { ...get().tileSpan };
    if (!(id in tileSpan)) return;
    delete tileSpan[id];
    persist(TILESPAN_KEY, tileSpan);
    set((state) => ({ tileSpan, refreshNonce: state.refreshNonce + 1 }));
  },
  autoArrange: (workspaceId) => {
    const state = get();
    const tileSpan = { ...state.tileSpan };
    let cleared = 0;
    for (const tile of state.tiles) {
      const inWorkspace = workspaceId === ALL_WORKSPACE_ID || (state.sessionWs[wsKeyOf(tile)] ?? DEFAULT_WORKSPACE_ID) === workspaceId;
      if (inWorkspace && tile.id in tileSpan) {
        delete tileSpan[tile.id];
        cleared++;
      }
    }
    const workspaceColumns = { ...state.workspaceColumns, [workspaceId]: AUTO_COLUMNS };
    persist(TILESPAN_KEY, tileSpan);
    persist(WSCOLUMNS_KEY, workspaceColumns);
    set((current) => ({ tileSpan, workspaceColumns, refreshNonce: current.refreshNonce + 1 }));
    return cleared;
  },

  // Fall back to the old global columns value for workspaces without their own;
  // without either the canvas arranges itself.
  defaultColumns: loadValid(COLUMNS_KEY, parseColumns, AUTO_COLUMNS),
  workspaceColumns: loadValid(WSCOLUMNS_KEY, recordOf(parseColumns), {}),
  setColumns: (n, workspaceId) => {
    const id = workspaceId ?? get().activeWorkspaceId;
    const workspaceColumns = { ...get().workspaceColumns, [id]: n };
    persist(WSCOLUMNS_KEY, workspaceColumns);
    set((state) => ({ workspaceColumns, refreshNonce: state.refreshNonce + 1 }));
  },

  fontSize: loadValid(FONT_KEY, (value) => (finite(value) ? Math.max(9, Math.min(20, Math.round(value))) : undefined), 13),
  setFontSize: (n) => {
    const clamped = Math.max(9, Math.min(20, n));
    persist(FONT_KEY, clamped);
    set({ fontSize: clamped });
  },
  cursorBlink: loadValid(CURSOR_KEY, bool, true),
  setCursorBlink: (v) => {
    persist(CURSOR_KEY, v);
    set({ cursorBlink: v });
  },
  osc52Clipboard: loadValid(OSC52_KEY, bool, false),
  setOsc52Clipboard: (v) => {
    persist(OSC52_KEY, v);
    set({ osc52Clipboard: v });
  },

  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),

  wizardOpen: false,
  setWizardOpen: (v) => set({ wizardOpen: v }),
  setupVisible: false,
  setSetupVisible: (v) => set({ setupVisible: v }),

  showPorts: false,
  togglePorts: () => set((s) => ({ showPorts: !s.showPorts })),

  allSessions: [],
  allWindows: [],
  tiles: uniqueById(loadValid(TILES_KEY, listOf(parseTile), [])).filter(tile => (tile.session ?? tile.name) !== QUICK_CHAT_SESSION),
  activeId: null,
  refreshing: false,
  refreshNonce: 0,

  loadSessions: async () => {
    set({ refreshing: true });
    try {
      // Retry a few times: the devbox server may be briefly unreachable (e.g.
      // autoforward still catching up), and a single failed fetch must not
      // leave the sidebar stuck on "no sessions".
      let all: RemoteSession[] | null = null;
      for (let attempt = 0; attempt < 4; attempt++) {
        try {
          all = await listSessions(get().connection);
          break;
        } catch {
          await new Promise((r) => setTimeout(r, 700));
        }
      }
      if (all === null) return; // keep whatever was shown before

      // Quick Chat owns its terminal in the dropdown, outside the workspace grid.
      all = all.filter(session => session.name !== QUICK_CHAT_SESSION);
      set({ allSessions: all });

      if (!HAS_TAURI) {
        try {
          const wins = (await fetchWindows()).filter(window => window.session !== QUICK_CHAT_SESSION);
          set({ allWindows: wins });

          // One-time: surface the extra windows of multi-window sessions
          // (agent codex/claude tabs) as their own tiles.
          if (!localStorage.getItem("pzza.seed.windows.v1")) {
            const counts: Record<string, number> = {};
            for (const w of wins) counts[w.session] = (counts[w.session] ?? 0) + 1;
            const tiles = [...get().tiles];
            const has = (id: string) => tiles.some((t) => t.id === id);
            for (const w of wins) {
              if ((counts[w.session] ?? 1) <= 1) continue; // single window: session tile covers it
              if (w.active && has(w.session)) continue; // active window shown by the session tile
              const id = `${w.session}::w::${w.window}`;
              if (has(id)) continue;
              tiles.push({
                id,
                name: `${tileTitle(w.session)} · ${w.windowName}`,
                session: w.session,
                window: w.window,
                ...(validWindowId(w.windowId) ? { windowId: w.windowId } : {}),
                command: w.command,
                path: w.path,
              });
            }
            persist(TILES_KEY, tiles);
            set({ tiles });
            localStorage.setItem("pzza.seed.windows.v1", "1");
          }
        } catch {
          /* windows optional */
        }
      }

      // First run with nothing saved: open every session so the whole devbox is
      // visible at a glance.
      if (get().tiles.length === 0 && all.length > 0) {
        const tiles: Session[] = all.map((s) => ({ id: s.name, name: s.name }));
        persist(TILES_KEY, tiles);
        set({ tiles, activeId: tiles[0]?.id ?? null });
      }
      if (get().tiles.some(untiedWindowTile)) void get().recordWindowIds();
    } finally {
      set({ refreshing: false });
    }
  },

  openSession: (name, cwd, host) =>
    set((state) => {
      if (name === QUICK_CHAT_SESSION) return state;
      // A remote session's tile id is namespaced by host so the same session
      // name on two devices never collides on the grid.
      const id = host ? `${host}::${name}` : name;
      if (state.tiles.some((t) => t.id === id)) return { activeId: id };
      const tile: Session = host !== undefined ? { id, name, session: name, host, cwd } : { id, name, cwd };
      const tiles = [...state.tiles, tile];
      persist(TILES_KEY, tiles);
      // Fresh tiles always start on the automatic grid layout: drop any span
      // saved by an earlier tile with the same id so an old explicit size
      // never leaks into a newly created session.
      const tileSpan = dropTileSpan(state.tileSpan, id);
      return { tiles, tileSpan, activeId: id, refreshNonce: state.refreshNonce + 1 };
    }),

  openWindow: (w, displayName, host) =>
    set((state) => {
      if (w.session === QUICK_CHAT_SESSION) return state;
      const id = `${host ? `${host}::` : ""}${w.session}::w::${w.window}`;
      if (state.tiles.some((t) => t.id === id)) return { activeId: id };
      const tile: Session = {
        id,
        name: displayName,
        session: w.session,
        window: w.window,
        ...(validWindowId(w.windowId) ? { windowId: w.windowId } : {}),
        ...(host !== undefined ? { host } : {}),
        command: w.command,
        path: w.path,
      };
      const tiles = [...state.tiles, tile];
      persist(TILES_KEY, tiles);
      // Its id is tied to the window's session (or, opened by index alone by
      // app control, looked up) right away.
      queueMicrotask(() => void get().recordWindowIds());
      // Fresh tiles always start on the automatic grid layout (see openSession).
      const tileSpan = dropTileSpan(state.tileSpan, id);
      return { tiles, tileSpan, activeId: id, refreshNonce: state.refreshNonce + 1 };
    }),

  // A window tile opened by index alone (app control, or saved without a
  // tied id) gets the id of the window at that index together with its
  // session's creation time, read from its device. After its terminal server
  // was replaced, ids read under the old one are replaced the same way. An
  // unreachable device is tried again on the next load.
  recordWindowIds: async (recheckHost) => {
    const hostOf = (tile: Session, state: ConsoleState) => tile.host ?? state.connection.host ?? "";
    const pending = get().tiles.filter((tile) => tile.window !== undefined &&
      (untiedWindowTile(tile) || (recheckHost !== undefined && hostOf(tile, get()) === recheckHost)));
    const hosts = [...new Set(pending.map((tile) => hostOf(tile, get())))];
    await Promise.all(hosts.map(async (host) => {
      let windows: LocatedWindow[];
      try { windows = await locateWindows(host); } catch { return; }
      set((state) => {
        let changed = false;
        const tiles = state.tiles.map((tile) => {
          if (tile.window === undefined || hostOf(tile, state) !== host) return tile;
          const row = windows.find((window) => window.session === (tile.session ?? tile.name) && window.window === tile.window);
          const identity = refreshedIdentity(tile, row);
          if (!identity || (identity.windowId === tile.windowId && identity.windowSessionCreatedAt === tile.windowSessionCreatedAt)) return tile;
          changed = true;
          return { ...tile, ...identity };
        });
        if (!changed) return state;
        persist(TILES_KEY, tiles);
        return { tiles };
      });
    }));
  },

  closeTile: (id) =>
    set((state) => {
      const tiles = state.tiles.filter((t) => t.id !== id);
      const activeId =
        state.activeId === id ? (tiles.at(-1)?.id ?? null) : state.activeId;
      persist(TILES_KEY, tiles);
      const tileObserved = { ...state.tileObserved };
      delete tileObserved[id];
      return { tiles, activeId, tileObserved, refreshNonce: state.refreshNonce + 1 };
    }),

  // Move one tile to another tile's position (drag-to-reorder in the grid).
  reorderTile: (fromId, toId) =>
    set((state) => {
      const arr = [...state.tiles];
      const from = arr.findIndex((t) => t.id === fromId);
      const to = arr.findIndex((t) => t.id === toId);
      if (from < 0 || to < 0 || from === to) return {};
      const [moved] = arr.splice(from, 1);
      arr.splice(to, 0, moved);
      persist(TILES_KEY, arr);
      return { tiles: arr };
    }),

  applyWorkspaceLayout: (workspaceId, layout) =>
    set((state) => {
      const wanted = layout.tiles.filter((entry) => state.tiles.some((tile) => tile.id === entry.id));
      if (!wanted.length && layout.columns === undefined) return {};
      // The snapshot's tiles take the positions they already hold, in its order;
      // every other tile stays where it is.
      const ids = new Set(wanted.map((entry) => entry.id));
      const slots = state.tiles.flatMap((tile, index) => (ids.has(tile.id) ? [index] : []));
      const tiles = [...state.tiles];
      wanted.forEach((entry, position) => { tiles[slots[position]] = state.tiles.find((tile) => tile.id === entry.id)!; });
      const tileSpan = { ...state.tileSpan };
      const tileTitles = { ...state.tileTitles };
      const hidden = new Set(state.hiddenTiles);
      const tileCode = { ...state.tileCode };
      for (const entry of wanted) {
        if (entry.span) tileSpan[entry.id] = entry.span;
        else delete tileSpan[entry.id];
        if (entry.title) tileTitles[entry.id] = entry.title;
        else delete tileTitles[entry.id];
        if (entry.hidden) hidden.add(entry.name);
        else hidden.delete(entry.name);
        // A snapshot without a view restores the file tree, not whatever view is showing now.
        tileCode[entry.id] = entry.code ? { ...tileCode[entry.id], ...entry.code, view: entry.code.view } : { ...tileCode[entry.id], open: false, path: undefined };
      }
      const hiddenTiles = [...hidden];
      const workspaceColumns = layout.columns ? { ...state.workspaceColumns, [workspaceId]: layout.columns } : state.workspaceColumns;
      persist(TILES_KEY, tiles);
      persist(TILESPAN_KEY, tileSpan);
      persist(TILETITLES_KEY, tileTitles);
      persist(HIDDEN_KEY, hiddenTiles);
      persist(TILECODE_KEY, tileCode);
      persist(WSCOLUMNS_KEY, workspaceColumns);
      return { tiles, tileSpan, tileTitles, hiddenTiles, tileCode, workspaceColumns, refreshNonce: state.refreshNonce + 1 };
    }),

  moveTileToEnd: (id) =>
    set((state) => {
      const moved = state.tiles.find((t) => t.id === id);
      if (!moved) return {};
      const tiles = [...state.tiles.filter((t) => t.id !== id), moved];
      persist(TILES_KEY, tiles);
      return { tiles };
    }),

  setActive: (id) => set({ activeId: id }),

  seedPreview: () =>
    set(() => ({
      tiles: [
        { id: "preview-1", name: "preview 1" },
        { id: "preview-2", name: "preview 2" },
      ],
      activeId: "preview-1",
    })),

  tileCode: loadValid(TILECODE_KEY, recordOf(parseTileCode), {}),
  toggleTileCode: (id, defaultRoot) =>
    set((state) => {
      const cur = state.tileCode[id];
      const opening = !cur?.open;
      // Closing the editor also closes the file that was open in it; reopening
      // starts back at the folder tree with nothing selected.
      const next: TileCode = opening
        ? { ...cur, open: true, layout: cur?.layout ?? "side-by-side", root: cur?.root ?? defaultRoot, path: undefined, view: undefined }
        : { ...cur, open: false, layout: cur?.layout ?? "side-by-side", root: cur?.root, path: undefined };
      const tileCode = { ...state.tileCode, [id]: next };
      persist(TILECODE_KEY, tileCode);
      return { tileCode, activeId: id };
    }),
  setTileCodeLayout: (id, layout) =>
    set((state) => {
      const cur = state.tileCode[id];
      if (!cur || cur.layout === layout) return {};
      const tileCode = { ...state.tileCode, [id]: { ...cur, layout } };
      persist(TILECODE_KEY, tileCode);
      return { tileCode };
    }),
  setTileCodeSizes: (id, sizes) =>
    set((state) => {
      const cur = state.tileCode[id];
      if (!cur) return {};
      const tileCode = { ...state.tileCode, [id]: { ...cur, ...sizes } };
      persist(TILECODE_KEY, tileCode);
      return { tileCode };
    }),
  setTileCodeRoot: (id, root) =>
    set((state) => {
      const cur = state.tileCode[id] ?? { open: true };
      const tileCode = { ...state.tileCode, [id]: { ...cur, open: true, root, path: undefined } };
      persist(TILECODE_KEY, tileCode);
      return { tileCode };
    }),
  setTileCodePath: (id, filePath) =>
    set((state) => {
      const cur = state.tileCode[id] ?? { open: true };
      const tileCode = { ...state.tileCode, [id]: { ...cur, open: true, path: filePath } };
      persist(TILECODE_KEY, tileCode);
      return { tileCode, activeId: id };
    }),
  closeTileFile: (id) =>
    set((state) => {
      const cur = state.tileCode[id];
      if (!cur) return {};
      const tileCode = { ...state.tileCode, [id]: { ...cur, path: undefined } };
      persist(TILECODE_KEY, tileCode);
      return { tileCode };
    }),
  setTileCodeView: (id, view) =>
    set((state) => {
      const cur = state.tileCode[id];
      if (!cur || tileCodeView(cur) === view) return {};
      const tileCode = { ...state.tileCode, [id]: { ...cur, view: view === "changes" ? view : undefined } };
      persist(TILECODE_KEY, tileCode);
      return { tileCode };
    }),
  changesReveal: {},
  openTileChanges: (id, folder) =>
    set((state) => {
      const cur = state.tileCode[id];
      // An open editor keeps its file; a closed one opens like toggleTileCode.
      const next: TileCode = cur?.open
        ? { ...cur, root: cur.root || folder, view: "changes" }
        : { ...cur, open: true, layout: cur?.layout ?? "side-by-side", root: cur?.root || folder, path: undefined, view: "changes" };
      const tileCode = { ...state.tileCode, [id]: next };
      persist(TILECODE_KEY, tileCode);
      return { tileCode, activeId: id, changesReveal: { ...state.changesReveal, [id]: (state.changesReveal[id] ?? 0) + 1 } };
    }),
}));

// One-time migration: "full" used to be the default editor layout, so existing
// stored entries carry it without the user ever choosing it. Move those to the
// new side-by-side default once; explicit choices made afterwards are kept.
(function migrateTileCodeLayout() {
  const FLAG = "pzza.tileCodeLayoutMigrated";
  try {
    if (localStorage.getItem(FLAG)) return;
    const state = useStore.getState();
    let changed = false;
    const tileCode: Record<string, TileCode> = {};
    for (const [id, entry] of Object.entries(state.tileCode)) {
      if (entry && entry.layout === "full") {
        tileCode[id] = { ...entry, layout: "side-by-side" };
        changed = true;
      } else if (entry) {
        tileCode[id] = entry;
      }
    }
    if (changed) {
      persist(TILECODE_KEY, tileCode);
      useStore.setState({ tileCode });
    }
    localStorage.setItem(FLAG, "1");
  } catch {
    /* preview / private mode - defaults apply */
  }
})();

// One-time cleanup: explicit tile sizes used to survive their tile, so a span
// saved long ago could leak into a newly created session with the same id.
// Fresh tiles always start auto now (see openSession/openWindow); drop spans
// whose tile is no longer open, keep the ones still on the grid.
(function migrateStaleTileSpans() {
  const FLAG = "pzza.tileSpanStaleCleaned";
  try {
    if (localStorage.getItem(FLAG)) return;
    const state = useStore.getState();
    const open = new Set(state.tiles.map((tile) => tile.id));
    const tileSpan: Record<string, { c: number; r: number }> = {};
    let changed = false;
    for (const [id, span] of Object.entries(state.tileSpan)) {
      if (open.has(id)) tileSpan[id] = span;
      else changed = true;
    }
    if (changed) {
      persist(TILESPAN_KEY, tileSpan);
      useStore.setState({ tileSpan });
    }
    localStorage.setItem(FLAG, "1");
  } catch {
    /* preview / private mode - defaults apply */
  }
})();
