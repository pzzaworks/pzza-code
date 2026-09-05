import { create } from "zustand";
import { DEFAULT_THEME_ID } from "../theme/themes";
import {
  loadConnection,
  saveConnection,
  listRemoteSessions,
  type Connection,
  type RemoteSession,
} from "../connection";
import { fetchSessions, fetchWindows, type RemoteWindow } from "../serverApi";
import { HAS_TAURI } from "../tauriEnv";
import {
  DEFAULT_WORKSPACES,
  DEFAULT_WORKSPACE_ID,
  markFor,
  type Workspace,
} from "../workspaces";
import { DEFAULT_DEVICES, THIS_MAC, type Device } from "../devices";
import { tileTitle } from "../sessionMeta";

// A tile open on the canvas. id === tmux session name. Tile order IS the grid
// arrangement - the canvas is a uniform N-column grid, never free-floating.
export interface Session {
  id: string;
  name: string; // display title
  cwd?: string;
  session?: string; // base tmux session (for window tiles)
  window?: number; // tmux window index (for window tiles)
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

function persist(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* preview / private mode */
  }
}

async function listSessions(conn: Connection): Promise<RemoteSession[]> {
  return HAS_TAURI ? listRemoteSessions(conn) : fetchSessions();
}

interface ConsoleState {
  themeId: string;
  setTheme: (id: string) => void;

  connection: Connection;
  setHost: (host: string | null) => void;

  workspaces: Workspace[];
  activeWorkspaceId: string;
  setWorkspace: (id: string) => void;
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

  // Managed ssh devices (for RDP + forwarding server/client).
  devices: Device[];
  addDevice: (name: string, host: string, user?: string) => void;
  removeDevice: (id: string) => void;

  // Per-device RDP config, provisioned by the wizard (user + cert fingerprint +
  // the Keychain service holding the password). Absent = not set up yet.
  deviceRdp: Record<string, { user: string; certFingerprint: string; keychainService: string }>;
  setDeviceRdp: (
    id: string,
    cfg: { user: string; certFingerprint: string; keychainService: string },
  ) => void;

  // Per-tile grid span: {c: columns, r: rows}. Capped to the column count.
  tileSpan: Record<string, { c: number; r: number }>;
  setTileSpan: (id: string, c: number, r: number) => void;

  // Optional per-tile display-name override (empty clears it back to default).
  tileTitles: Record<string, string>;
  renameTile: (id: string, title: string) => void;

  // Grid columns are per-workspace. `setColumns` applies to the active one.
  workspaceColumns: Record<string, number>;
  defaultColumns: number;
  setColumns: (n: number) => void;

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
  openWindow: (w: RemoteWindow, displayName: string) => void;
  closeTile: (id: string) => void;
  reorderTile: (fromId: string, toId: string) => void;
  moveTileToEnd: (id: string) => void;
  setActive: (id: string) => void;
  seedPreview: () => void;

  // Each window can flip into an inline code editor rooted at its own folder,
  // keyed by the tile id. The terminal stays alive underneath while it is open.
  tileCode: Record<string, TileCode>;
  toggleTileCode: (id: string, defaultRoot?: string) => void;
  setTileCodeRoot: (id: string, root: string) => void;
  setTileCodePath: (id: string, path: string) => void;
  closeTileFile: (id: string) => void;
}

export interface TileCode {
  open: boolean;
  root?: string;
  path?: string;
}

export const useStore = create<ConsoleState>((set, get) => ({
  themeId: load<string>(THEME_KEY, DEFAULT_THEME_ID),
  setTheme: (id) => {
    persist(THEME_KEY, id);
    set({ themeId: id });
  },

  connection: loadConnection(),
  setHost: (host) => {
    const connection = { host };
    saveConnection(connection);
    set({ connection });
  },

  workspaces: load<Workspace[]>(WORKSPACES_KEY, DEFAULT_WORKSPACES).map((w) =>
    w.name === "main" ? { ...w, name: "Main", short: "M" } : w,
  ),
  activeWorkspaceId: DEFAULT_WORKSPACE_ID,
  setWorkspace: (id) => {
    set((state) => ({ activeWorkspaceId: id, refreshNonce: state.refreshNonce + 1 }));
  },
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
    if (get().workspaces.find((w) => w.id === id)?.system) return; // built-in, undeletable
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

  sessionWs: load<Record<string, string>>(SESSIONWS_KEY, {}),
  assignSession: (name, wsId) => {
    const sessionWs = { ...get().sessionWs, [name]: wsId };
    persist(SESSIONWS_KEY, sessionWs);
    set({ sessionWs });
  },

  hiddenTiles: load<string[]>(HIDDEN_KEY, []),
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

  // Always keep a "This Mac" local device (the machine running the app), and
  // make it the first entry so it is the default current device. Drop any stale
  // pre-seeded "devbox" placeholder that was never actually added by the user.
  devices: ((): Device[] => {
    const loaded = load<Device[]>(DEVICES_KEY, DEFAULT_DEVICES).filter(
      (d) => d.id !== "devbox",
    );
    const withoutMac = loaded.filter((d) => d.id !== "this-mac");
    return [THIS_MAC, ...withoutMac];
  })(),
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
    set({ devices });
  },
  removeDevice: (id) => {
    if (id === "this-mac") return; // the local machine is always present
    const devices = get().devices.filter((d) => d.id !== id);
    persist(DEVICES_KEY, devices);
    set({ devices });
  },

  deviceRdp: load<Record<string, { user: string; certFingerprint: string; keychainService: string }>>(
    DEVICE_RDP_KEY,
    {},
  ),
  setDeviceRdp: (id, cfg) => {
    const deviceRdp = { ...get().deviceRdp, [id]: cfg };
    persist(DEVICE_RDP_KEY, deviceRdp);
    set({ deviceRdp });
  },

  tileTitles: load<Record<string, string>>(TILETITLES_KEY, {}),
  renameTile: (id, title) => {
    const tileTitles = { ...get().tileTitles };
    const trimmed = title.trim();
    if (trimmed) tileTitles[id] = trimmed;
    else delete tileTitles[id];
    persist(TILETITLES_KEY, tileTitles);
    set({ tileTitles });
  },

  tileSpan: load<Record<string, { c: number; r: number }>>(TILESPAN_KEY, {}),
  setTileSpan: (id, c, r) => {
    const tileSpan = { ...get().tileSpan, [id]: { c, r } };
    persist(TILESPAN_KEY, tileSpan);
    set((state) => ({ tileSpan, refreshNonce: state.refreshNonce + 1 }));
  },

  // Fall back to the old global columns value for workspaces without their own.
  defaultColumns: load<number>(COLUMNS_KEY, 2),
  workspaceColumns: load<Record<string, number>>(WSCOLUMNS_KEY, {}),
  setColumns: (n) => {
    const id = get().activeWorkspaceId;
    const workspaceColumns = { ...get().workspaceColumns, [id]: n };
    persist(WSCOLUMNS_KEY, workspaceColumns);
    set((state) => ({ workspaceColumns, refreshNonce: state.refreshNonce + 1 }));
  },

  fontSize: load<number>(FONT_KEY, 13),
  setFontSize: (n) => {
    const clamped = Math.max(9, Math.min(20, n));
    persist(FONT_KEY, clamped);
    set({ fontSize: clamped });
  },
  cursorBlink: load<boolean>(CURSOR_KEY, true),
  setCursorBlink: (v) => {
    persist(CURSOR_KEY, v);
    set({ cursorBlink: v });
  },
  osc52Clipboard: load<boolean>(OSC52_KEY, false),
  setOsc52Clipboard: (v) => {
    persist(OSC52_KEY, v);
    set({ osc52Clipboard: v });
  },

  settingsOpen: false,
  setSettingsOpen: (v) => set({ settingsOpen: v }),

  wizardOpen: false,
  setWizardOpen: (v) => set({ wizardOpen: v }),

  showPorts: false,
  togglePorts: () => set((s) => ({ showPorts: !s.showPorts })),

  allSessions: [],
  allWindows: [],
  tiles: load<Session[]>(TILES_KEY, []),
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

      set({ allSessions: all });

      if (!HAS_TAURI) {
        try {
          const wins = await fetchWindows();
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
    } finally {
      set({ refreshing: false });
    }
  },

  openSession: (name, cwd, host) =>
    set((state) => {
      // A remote session's tile id is namespaced by host so the same session
      // name on two devices never collides on the grid.
      const id = host ? `${host}::${name}` : name;
      if (state.tiles.some((t) => t.id === id)) return { activeId: id };
      const tile: Session = host ? { id, name, session: name, host } : { id, name, cwd };
      const tiles = [...state.tiles, tile];
      persist(TILES_KEY, tiles);
      return { tiles, activeId: id, refreshNonce: state.refreshNonce + 1 };
    }),

  openWindow: (w, displayName) =>
    set((state) => {
      const id = `${w.session}::w::${w.window}`;
      if (state.tiles.some((t) => t.id === id)) return { activeId: id };
      const tile: Session = {
        id,
        name: displayName,
        session: w.session,
        window: w.window,
        command: w.command,
        path: w.path,
      };
      const tiles = [...state.tiles, tile];
      persist(TILES_KEY, tiles);
      return { tiles, activeId: id, refreshNonce: state.refreshNonce + 1 };
    }),

  closeTile: (id) =>
    set((state) => {
      const tiles = state.tiles.filter((t) => t.id !== id);
      const activeId =
        state.activeId === id ? (tiles.at(-1)?.id ?? null) : state.activeId;
      persist(TILES_KEY, tiles);
      return { tiles, activeId, refreshNonce: state.refreshNonce + 1 };
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

  tileCode: load<Record<string, TileCode>>(TILECODE_KEY, {}),
  toggleTileCode: (id, defaultRoot) =>
    set((state) => {
      const cur = state.tileCode[id];
      const opening = !cur?.open;
      // Closing the editor also closes the file that was open in it; reopening
      // starts back at the folder tree with nothing selected.
      const next: TileCode = opening
        ? { open: true, root: cur?.root ?? defaultRoot, path: undefined }
        : { open: false, root: cur?.root, path: undefined };
      const tileCode = { ...state.tileCode, [id]: next };
      persist(TILECODE_KEY, tileCode);
      return { tileCode, activeId: id };
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
}));
