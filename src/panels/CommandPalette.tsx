import { Fragment, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import {
  Bell, Blocks, CircleQuestionMark, Code2, Columns2, Columns3, Columns4, Contrast, Copy, EthernetPort, EyeOff, FolderOpen, FolderSync, GitCompare,
  HardDrive, Info, LayoutDashboard, LayoutGrid, Maximize2, MessageSquare, Mic, Minimize2, Minus, Monitor, Moon, Palette, Plus, Radio, RefreshCw, Rocket, Search,
  Server, Settings, Sparkles, SquareDashed, Sun, Type, Wand2, Wrench, type LucideIcon,
} from "lucide-react";
import { useStore } from "../state/store";
import { useModalFocus } from "../ui/Modal";
import { announceMenu } from "../ui/menuBus";
import { runLocalAppCommand } from "../appControl";
import { readAppControlRuntime } from "../appControlRuntime";
import { fuzzyMatch } from "../fuzzyMatch";
import { HELP_PAGES } from "./HelpModal";
import { HELP_SECTIONS } from "./helpTopics";
import { generalSections } from "./settingsSections";
import { readRecentFolders } from "./SessionMenu";
import { requestNewSession } from "../state/newSession";
import { DICTATION_SUPPORTED } from "../state/dictation";
import { confirmEditorDiscard } from "../editorChanges";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, wsKeyOf } from "../workspaces";
import { useWorkspaceIconSet, workspaceIcon } from "../workspaceIcons";
import { AUTO_COLUMNS } from "../grid/autoLayout";
import { deviceForHost, deviceHost, deviceNameFor } from "../devices";
import { sessionDisplayName, sessionIcon, type IconType } from "../sessionMeta";
import { compactPath } from "../grid/compactPath";
import { BUILTIN_THEMES } from "../theme/themes";
import { SPACING_RANGE } from "../state/store";
import { HAS_TAURI } from "../tauriEnv";
import { altBadge, COMMAND_PALETTE_SHORTCUT, ctrlBadge, IS_MAC, NEW_SESSION_SHORTCUT, NEW_WORKSPACE_SHORTCUT } from "../shortcuts";
import { ListPlus, ListTodo, MessageSquareText, TextSearch } from "lucide-react";
import { TASK_SURFACES } from "../lazySurfaces";
import { whenLoaded } from "../lazySurface";
import { useTasksUi } from "../tasks/taskStore";
import { TASKS_SHORTCUT } from "../shortcuts";
import { usePrompts } from "../state/prompts";
import { sendPromptToTile } from "../terminal/broadcast";
import { runningAgent } from "../ui/LiveSessionIcon";
import { openTerminalSearch } from "../terminal/terminalSearch";
import { SEARCH_TERMINALS_SHORTCUT } from "../shortcuts";

type GroupId = "sessions" | "workspaces" | "actions" | "folders" | "help";
const GROUPS: Record<GroupId, string> = { sessions: "Sessions", workspaces: "Workspaces", actions: "Actions", folders: "Recent folders", help: "Help" };
// With no query the most common jumps come first.
const RESTING_ORDER: GroupId[] = ["sessions", "workspaces", "actions", "folders", "help"];

interface PaletteItem {
  id: string;
  group: GroupId;
  icon: IconType | LucideIcon;
  label: string;
  detail?: string;
  shortcut?: string;
  /** Extra words that find the row but are not shown. */
  keywords?: string;
  run: () => unknown;
}

interface Ranked { item: PaletteItem; score: number; positions: number[] }

// Labels in the same form as NEW_WORKSPACE_SHORTCUT: "⇧⌘N" on macOS, "Ctrl Shift N" elsewhere.
const cmdKey = (key: string) => (IS_MAC ? `⌘${key}` : `Ctrl ${key}`);
const shiftCmdKey = (key: string) => (IS_MAC ? `⇧⌘${key}` : `Ctrl Shift ${key}`);
const SETTINGS: { section: string; label: string; icon: LucideIcon; shortcut?: string }[] = [
  { section: "general", label: "General", icon: Settings, shortcut: cmdKey(",") },
  { section: "notifications", label: "Notifications", icon: Bell },
  { section: "quick-chat", label: "Quick Chat", icon: MessageSquare },
  { section: "devices", label: "Devices", icon: HardDrive },
  { section: "sync", label: "Sync", icon: FolderSync },
  { section: "mcp", label: "Connections", icon: Blocks },
  { section: "remote", label: "Remote desktop", icon: Monitor },
  { section: "ports", label: "Ports", icon: EthernetPort },
  { section: "setup", label: "Setup", icon: Wrench },
  { section: "help", label: "Help", icon: CircleQuestionMark, shortcut: shiftCmdKey("/") },
  { section: "about", label: "About", icon: Info },
];
const COLUMN_ICONS: Record<number, LucideIcon> = { 2: Columns2, 3: Columns3, 4: Columns4 };

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function rank(items: PaletteItem[], query: string): Ranked[] {
  if (!query.trim()) return items.map(item => ({ item, score: 0, positions: [] }));
  const ranked: Ranked[] = [];
  for (const item of items) {
    const label = fuzzyMatch(query, item.label);
    const extra = fuzzyMatch(query, [item.detail, item.keywords].filter(Boolean).join(" "));
    // A label hit outranks the same hit in the secondary text, and on a tie
    // something to do outranks a page to read about it.
    const bias = item.group === "help" ? -1 : 0;
    if (label && (!extra || label.score >= extra.score - 4)) ranked.push({ item, score: label.score + bias, positions: label.positions });
    else if (extra) ranked.push({ item, score: extra.score - 4 + bias, positions: [] });
  }
  return ranked;
}

function grouped(ranked: Ranked[], query: string): { group: GroupId; rows: Ranked[] }[] {
  const byGroup = new Map<GroupId, Ranked[]>();
  for (const entry of ranked) byGroup.set(entry.item.group, [...(byGroup.get(entry.item.group) ?? []), entry]);
  if (!query.trim()) return RESTING_ORDER.filter(group => byGroup.has(group)).map(group => ({ group, rows: byGroup.get(group) ?? [] }));
  // Typed queries: groups and rows by their best match; stable for ties.
  return [...byGroup].map(([group, rows]) => ({ group, rows: [...rows].sort((a, b) => b.score - a.score) }))
    .sort((a, b) => b.rows[0].score - a.rows[0].score);
}

function Highlight({ text, positions }: { text: string; positions: number[] }): ReactNode {
  if (!positions.length) return text;
  const marks = new Set(positions);
  const parts: ReactNode[] = [];
  let run = "";
  let marked = false;
  const flush = (key: number) => { if (run) parts.push(marked ? <mark key={key}>{run}</mark> : <Fragment key={key}>{run}</Fragment>); run = ""; };
  for (let index = 0; index < text.length; index++) {
    const next = marks.has(index);
    if (next !== marked) { flush(index); marked = next; }
    run += text[index];
  }
  flush(text.length);
  return parts;
}

// Every row reuses an existing control path: app-control commands (with their
// confirmations), store actions, or the events the visible buttons dispatch.
function usePaletteItems(open: boolean): PaletteItem[] {
  const tiles = useStore(s => s.tiles);
  const tileTitles = useStore(s => s.tileTitles);
  const workspaces = useStore(s => s.workspaces);
  const activeWorkspaceId = useStore(s => s.activeWorkspaceId);
  const activeId = useStore(s => s.activeId);
  const sessionWs = useStore(s => s.sessionWs);
  const hiddenTiles = useStore(s => s.hiddenTiles);
  const devices = useStore(s => s.devices);
  const activeDevices = useStore(s => s.activeDevices);
  const allSessions = useStore(s => s.allSessions);
  const tileCode = useStore(s => s.tileCode);
  const themeId = useStore(s => s.themeId);
  const semiTransparent = useStore(s => s.semiTransparent);
  const grayscale = useStore(s => s.grayscale);
  const spacing = useStore(s => s.spacing);
  const prompts = usePrompts(s => s.prompts);
  const columns = useStore(s => s.workspaceColumns[s.activeWorkspaceId] ?? s.defaultColumns);
  const iconSet = useWorkspaceIconSet();
  return useMemo(() => {
    if (!open) return [];
    const command = (action: string, args: Record<string, unknown> = {}) => () => runLocalAppCommand(action, args);
    const workspaceOf = (tile: (typeof tiles)[number]) => sessionWs[wsKeyOf(tile)] ?? DEFAULT_WORKSPACE_ID;
    const workspaceName = (id: string) => workspaces.find(entry => entry.id === id)?.name ?? "Main";
    const visible = tiles.filter(tile => (activeWorkspaceId === ALL_WORKSPACE_ID || workspaceOf(tile) === activeWorkspaceId) &&
      !hiddenTiles.includes(tile.id) && !(tile.host && deviceForHost(devices, tile.host)?.disabled));
    const items: PaletteItem[] = [];

    for (const tile of tiles) {
      const index = visible.indexOf(tile);
      const notes = [workspaceName(workspaceOf(tile)), deviceNameFor(devices, tile.host)];
      if (tile.id === activeId) notes.unshift("Active");
      if (hiddenTiles.includes(tile.id)) notes.push("Hidden");
      items.push({ id: `tile:${tile.id}`, group: "sessions", icon: sessionIcon(tile.command), label: sessionDisplayName(tile, tileTitles), detail: notes.join(" · "),
        shortcut: index >= 0 && index < 9 ? ctrlBadge(index + 1) : undefined, keywords: `${tile.session ?? tile.name} ${tile.path ?? tile.cwd ?? ""}`, run: command("focus_tile", { tileId: tile.id }) });
    }

    const counts = new Map<string, number>();
    for (const tile of tiles) counts.set(workspaceOf(tile), (counts.get(workspaceOf(tile)) ?? 0) + 1);
    const count = (n: number) => `${n} session${n === 1 ? "" : "s"}`;
    items.push({ id: "ws:all", group: "workspaces", icon: LayoutGrid, label: "All", detail: [activeWorkspaceId === ALL_WORKSPACE_ID ? "Current" : null, count(tiles.length)].filter(Boolean).join(" · "),
      shortcut: altBadge(0), keywords: "every workspace", run: command("set_workspace", { workspaceId: ALL_WORKSPACE_ID }) });
    workspaces.forEach((workspace, index) => items.push({ id: `ws:${workspace.id}`, group: "workspaces", icon: workspaceIcon(workspace.icon), label: workspace.name,
      detail: [workspace.id === activeWorkspaceId ? "Current" : null, count(counts.get(workspace.id) ?? 0)].filter(Boolean).join(" · "),
      shortcut: index < 9 ? altBadge(index + 1) : undefined, run: command("set_workspace", { workspaceId: workspace.id }) }));

    const action = (id: string, icon: IconType | LucideIcon, label: string, run: () => unknown, extra: Partial<PaletteItem> = {}) =>
      items.push({ id: `action:${id}`, group: "actions", icon, label, run, ...extra });
    action("new-session", Plus, "New session", command("navigate", { target: "new_session" }), { shortcut: NEW_SESSION_SHORTCUT.label, keywords: "create terminal open" });
    action("new-workspace", Plus, "New workspace", command("navigate", { target: "new_workspace" }), { shortcut: NEW_WORKSPACE_SHORTCUT.label, keywords: "create" });
    action("add-device", Server, "Add a device", command("navigate", { target: "setup" }), { keywords: "ssh remote machine agent install" });
    action("quick-chat", MessageSquare, "Open Quick Chat", command("open_quick_chat"), { keywords: "agent ask" });
    action("tasks", ListTodo, "Show tasks", () => whenLoaded(TASK_SURFACES, () => useTasksUi.getState().show()), { shortcut: TASKS_SHORTCUT.label, keywords: "sidebar board worktree agents review merge" });
    action("new-task", ListPlus, "New task", () => whenLoaded(TASK_SURFACES, () => useTasksUi.getState().show({ kind: "new" })), { keywords: "agent worktree best of n compare prompt" });

    const active = tiles.find(tile => tile.id === activeId);
    if (active) {
      const name = sessionDisplayName(active, tileTitles);
      const folder = active.path ?? allSessions.find(entry => entry.name === (active.session ?? active.name))?.path ?? active.cwd;
      const fullTileId = (readAppControlRuntime().canvas as { fullTileId?: string | null } | undefined)?.fullTileId ?? null;
      const maximized = fullTileId === active.id;
      action("maximize", maximized ? Minimize2 : Maximize2, maximized ? "Restore tile" : "Maximize tile", command("set_fullscreen", { tileId: active.id, enabled: !maximized }), { detail: name, keywords: "full screen focus mode" });
      const editorOpen = tileCode[active.id]?.open ?? false;
      action("editor", Code2, editorOpen ? "Close code editor" : "Open code editor", editorOpen
        ? async () => { if (await confirmEditorDiscard([active.id])) useStore.getState().toggleTileCode(active.id); }
        : command("open_editor", { tileId: active.id }), { detail: name, keywords: "files code panel" });
      if (folder?.startsWith("/")) action("changes", GitCompare, "Show changes", async () => {
        await runLocalAppCommand("focus_tile", { tileId: active.id });
        useStore.getState().openTileChanges(active.id, folder);
      }, { detail: name, keywords: "git diff review" });
      if (DICTATION_SUPPORTED) action("dictation", Mic, "Start dictation", command("start_dictation", { tileId: active.id }), { detail: name, keywords: "voice speech microphone" });
      action("duplicate", Copy, "Duplicate session", command("duplicate_tile", { tileId: active.id }), { detail: name, keywords: "clone copy" });
      action("hide", EyeOff, "Hide tile", command("hide_tile", { tileId: active.id }), { detail: name, keywords: "keep running" });
      // Saved prompts go to the active tile's agent as one submitted line.
      for (const prompt of prompts) action(`prompt-${prompt.id}`, MessageSquareText, `Prompt: ${prompt.name}`, () => sendPromptToTile(active.id, prompt.text),
        { detail: `Send to ${name}`, keywords: `saved prompt agent ${prompt.text}` });
    }
    action("search-terminals", TextSearch, "Search all terminals", openTerminalSearch, { shortcut: SEARCH_TERMINALS_SHORTCUT.label, keywords: "find scrollback output grep every tile" });
    if (visible.length >= 2) action("broadcast", Radio, "Broadcast to visible tiles", async () => {
      const fullTileId = (readAppControlRuntime().canvas as { fullTileId?: string | null } | undefined)?.fullTileId;
      if (fullTileId) await runLocalAppCommand("set_fullscreen", { tileId: fullTileId, enabled: false });
      window.dispatchEvent(new Event("pzza:broadcast-visible"));
    }, { detail: `${visible.length} tiles`, keywords: "send line all sessions select" });
    const agents = visible.filter(tile => runningAgent(tile.session ?? tile.name, tile.window, tile.host) !== undefined);
    if (agents.length >= 2) action("broadcast-agents", Radio, "Broadcast to every agent", async () => {
      const fullTileId = (readAppControlRuntime().canvas as { fullTileId?: string | null } | undefined)?.fullTileId;
      if (fullTileId) await runLocalAppCommand("set_fullscreen", { tileId: fullTileId, enabled: false });
      window.dispatchEvent(new Event("pzza:broadcast-agents"));
    }, { detail: `${agents.length} agent tiles`, keywords: "send prompt all agents coding select multi" });

    action("auto-arrange", LayoutDashboard, "Auto arrange tiles", command("auto_arrange", { workspaceId: activeWorkspaceId }),
      { detail: columns === AUTO_COLUMNS ? "Fits the window · columns are auto" : "Fits the window, even rows", keywords: "layout grid reset sizes fit tidy balance columns" });
    for (const n of [2, 3, 4]) action(`columns-${n}`, COLUMN_ICONS[n], `Grid: ${n} columns`, command("set_columns", { columns: n }), { detail: n === columns ? "Current" : undefined, keywords: "layout width" });
    for (const theme of BUILTIN_THEMES) action(`theme-${theme.id}`, theme.appearance === "light" ? Sun : Moon, `Theme: ${theme.name}`, command("configure_appearance", { theme: theme.id }),
      { detail: theme.id === themeId ? "Current" : undefined, keywords: "appearance color mode" });
    action("transparency", Sparkles, semiTransparent ? "Turn off transparency" : "Turn on transparency", command("configure_appearance", { semiTransparent: !semiTransparent }), { keywords: "appearance glass translucent window" });
    action("grayscale", Contrast, grayscale ? "Turn off grayscale" : "Turn on grayscale", command("configure_appearance", { grayscale: !grayscale }), { keywords: "appearance monochrome color" });
    action("spacing-joined", SquareDashed, "Spacing: join tiles", () => useStore.getState().setSpacing(SPACING_RANGE.joined), { detail: spacing === SPACING_RANGE.joined ? "Current" : undefined, keywords: "gap layout none" });
    action("spacing-default", SquareDashed, "Spacing: default", () => useStore.getState().setSpacing(SPACING_RANGE.default), { detail: spacing === SPACING_RANGE.default ? "Current" : `${SPACING_RANGE.default}px`, keywords: "gap layout" });
    action("font-up", Type, "Increase terminal font size", () => { const state = useStore.getState(); state.setFontSize(state.fontSize + 1); }, { shortcut: shiftCmdKey("="), keywords: "bigger zoom text" });
    action("font-down", Minus, "Decrease terminal font size", () => { const state = useStore.getState(); state.setFontSize(state.fontSize - 1); }, { shortcut: cmdKey("-"), keywords: "smaller zoom text" });
    for (const entry of SETTINGS) action(`settings-${entry.section}`, entry.icon, `Settings: ${entry.label}`, command("open_settings", { section: entry.section }), { shortcut: entry.shortcut, keywords: "preferences" });
    for (const page of generalSections) action(`settings-general-${page.id}`, page.id === "appearance" ? Palette : Settings, `Settings: ${page.label}`,
      command("open_settings", { section: "general", page: page.id }), { keywords: "preferences general" });
    action("tour", Wand2, "Start the tour", () => window.dispatchEvent(new Event("pzza:start-tour")), { keywords: "onboarding guide walkthrough" });
    action("setup", Rocket, "Run setup", () => window.dispatchEvent(new Event("pzza:start-setup")), { keywords: "permissions requirements install tmux onboarding" });
    action("refresh", RefreshCw, "Refresh sessions", command("refresh_sessions"), { keywords: "reload tmux" });
    if (HAS_TAURI) action("updates", RefreshCw, "Check for updates", command("check_updates"), { keywords: "upgrade version" });

    const seen = new Set<string>();
    const recents = readRecentFolders();
    for (const device of activeDevices) for (const path of recents[device.id] ?? []) {
      const key = `${device.id}\n${path}`;
      if (seen.has(key)) continue;
      seen.add(key);
      items.push({ id: `folder:${key}`, group: "folders", icon: FolderOpen, label: path.split("/").filter(Boolean).pop() ?? path, detail: `${compactPath(path)} · ${device.name}`,
        keywords: "new session start", run: () => requestNewSession(path, deviceHost(device)) });
    }

    for (const section of HELP_SECTIONS) for (const topic of section.topics) items.push({ id: `help:${topic}`, group: "help", icon: HELP_PAGES[topic].icon, label: HELP_PAGES[topic].label,
      detail: section.label, keywords: `docs guide ${topic}`, run: command("open_help", { topic }) });
    return items;
  }, [open, tiles, tileTitles, workspaces, activeWorkspaceId, activeId, sessionWs, hiddenTiles, devices, activeDevices, allSessions, tileCode, themeId, semiTransparent, grayscale, spacing, columns, prompts, iconSet]);
}

interface Props {
  open: boolean;
  onClose: () => void;
  onError: (message: string) => void;
}

export function CommandPalette({ open, onClose, onError }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const listId = useId();
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  // Reset while rendering the opening frame, so the first keystroke never
  // lands on the previous query.
  const [shown, setShown] = useState(open);
  if (shown !== open) {
    setShown(open);
    if (open) { setQuery(""); setCursor(0); }
  }
  useModalFocus(open, dialog, onClose, false, input);
  useEffect(() => { if (open) announceMenu("command-palette"); }, [open]);
  const items = usePaletteItems(open);
  const groups = useMemo(() => grouped(rank(items, query), query), [items, query]);
  const rows = useMemo(() => groups.flatMap(group => group.rows), [groups]);
  const current = rows[Math.min(cursor, rows.length - 1)];
  useLayoutEffect(() => {
    if (!current) return;
    list.current?.querySelector(`[data-palette-id="${CSS.escape(current.item.id)}"]`)?.scrollIntoView({ block: "nearest" });
  }, [current]);
  if (!open) return null;

  const run = (entry: Ranked | undefined) => {
    if (!entry) return;
    onClose();
    // After the palette is gone, so focus lands where the action puts it.
    window.setTimeout(() => {
      try { void Promise.resolve(entry.item.run()).catch((error: unknown) => onError(message(error))); }
      catch (error) { onError(message(error)); }
    }, 0);
  };
  const move = (step: number) => { if (rows.length) setCursor(index => (Math.min(index, rows.length - 1) + step + rows.length) % rows.length); };
  const optionId = (entry: Ranked) => `${listId}-${rows.indexOf(entry)}`;

  return createPortal(
    <div className="modal-backdrop pzza-portal cmdk-backdrop" onMouseDown={event => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="cmdk" ref={dialog} role="dialog" aria-modal="true" aria-label="Command palette" tabIndex={-1}>
        <div className="cmdk-search">
          <Search size={16} strokeWidth={1.9} aria-hidden="true" />
          <input ref={input} className="cmdk-input" value={query} placeholder="Search actions, sessions, workspaces and help" spellCheck={false} autoComplete="off"
            role="combobox" aria-expanded="true" aria-controls={listId} aria-autocomplete="list" aria-label="Search commands"
            aria-activedescendant={current ? optionId(current) : undefined}
            onChange={event => { setQuery(event.target.value); setCursor(0); }}
            onKeyDown={event => {
              if (event.nativeEvent.isComposing) return;
              if (event.key === "ArrowDown" || event.key === "ArrowUp") { event.preventDefault(); move(event.key === "ArrowDown" ? 1 : -1); }
              else if (event.key === "Enter") { event.preventDefault(); run(current); }
            }} />
          <kbd className="kbd" aria-hidden="true">{COMMAND_PALETTE_SHORTCUT.label}</kbd>
        </div>
        <div className="cmdk-list" id={listId} ref={list} role="listbox" aria-label="Commands">
          {groups.map(({ group, rows: groupRows }) => (
            <div className="cmdk-group" role="group" aria-label={GROUPS[group]} key={group}>
              <div className="cmdk-group-title" aria-hidden="true">{GROUPS[group]}</div>
              {groupRows.map(entry => {
                const Icon = entry.item.icon;
                const selected = entry === current;
                return (
                  <div key={entry.item.id} id={optionId(entry)} data-palette-id={entry.item.id} role="option" aria-selected={selected}
                    className={`cmdk-row ${selected ? "cmdk-row-active" : ""}`}
                    onMouseMove={() => { if (!selected) setCursor(rows.indexOf(entry)); }}
                    onMouseDown={event => event.preventDefault()}
                    onClick={() => run(entry)}>
                    <Icon size={15} className="cmdk-row-icon" />
                    <span className="cmdk-row-label"><Highlight text={entry.item.label} positions={entry.positions} /></span>
                    <span className="cmdk-row-detail">{entry.item.detail}</span>
                    {entry.item.shortcut ? <kbd className="kbd" aria-hidden="true">{entry.item.shortcut}</kbd> : null}
                  </div>
                );
              })}
            </div>
          ))}
          {!rows.length ? (
            <div className="cmdk-empty" role="status">
              <Search size={15} aria-hidden="true" />
              <span>Nothing matches “{query.trim()}”.</span>
            </div>
          ) : null}
        </div>
        <div className="cmdk-foot" aria-hidden="true">
          <span><kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> move</span>
          <span><kbd className="kbd">↵</kbd> run</span>
          <span><kbd className="kbd">esc</kbd> close</span>
        </div>
      </div>
    </div>, document.body,
  );
}
