import { useCallback, useEffect, useRef, useState } from "react";
import {
  Monitor,
  EthernetPort,
  Plus,
  Settings as SettingsIcon,
  FolderSync,
  Menu,
} from "lucide-react";
import { QuickChat } from "./panels/QuickChat";
import { NotificationsTool, countLabel } from "./panels/Notifications";
import { ContextMenu } from "./ui/ContextMenu";
import { ThemeProvider } from "./theme/ThemeProvider";
import { useStore } from "./state/store";
import { Canvas } from "./grid/Canvas";
import { WorkspaceTabs } from "./grid/WorkspaceTabs";
import { HELP_SECTIONS, type HelpRequest } from "./panels/helpTopics";
// Styles of the surfaces that load later stay in the main stylesheet, in
// their original cascade order.
import "./tour/OnboardingTour.css";
import { SettingsHub, type SettingsSection } from "./panels/SettingsHub";
import { useRemoteDesktop } from "./panels/RdpMenu";
import { hasRemoteDevice } from "./devices";
import { watchDisabledDevices } from "./deviceFallbacks";
import { PortsMenu, useForwardedCount } from "./panels/PortsMenu";
import { SessionMenu } from "./panels/SessionMenu";
import { useNewSessionRequest } from "./state/newSession";
import { Dropdown } from "./ui/Dropdown";
import { IconButton } from "./ui/IconButton";
import { Tooltip } from "./ui/Tooltip";
import { SetupWizard } from "./panels/SetupWizard";
import { onboardingPending, setupPending } from "./tour/progress";
import "./tour/SetupScreen.css";
import { startSnapshotAutosave } from "./state/workspaceSnapshots";
import { startSetupAutoInstall } from "./state/setup";
import { UsageTool } from "./panels/UsageMenu";
import { HAS_TAURI } from "./tauriEnv";
import { startUpdateChecks } from "./state/updates";
import { UpdateButton } from "./ui/UpdateButton";
import type { BarItemId } from "./barItems";
import { Modal } from "./ui/Modal";
import { ConfirmationHost } from "./ui/ConfirmDialog";
import { SessionRefreshHost } from "./ui/SessionRefreshHost";
import { confirmUnsavedWork, hasUnsavedWork, protectUnsavedUnload } from "./state/unsavedWork";
import { installTerminalDrops } from "./terminal/fileDrop";
import { startBackgroundActivityPoll } from "./terminal/backgroundActivity";
import { registerAppControlHandler, registerAppControlState } from "./appControlRuntime";
import { useAppControl } from "./appControl";
import { initializeDictation } from "./state/dictation";
import { initializePushToTalk } from "./state/pushToTalk";
import { commandPaletteShortcut, NEW_SESSION_SHORTCUT, newItemShortcut } from "./shortcuts";
import { CommandPalette, ONBOARDING, OnboardingTour, preloadWhenIdle, SetupScreen, TASK_SURFACES, TaskWindow, TerminalSearch } from "./lazySurfaces";
import { useOpenedOnce, whenLoaded } from "./lazySurface";
import { OPEN_TERMINAL_SEARCH_EVENT } from "./terminal/terminalSearch";
import { searchTerminalsShortcut, tasksShortcut } from "./shortcuts";
import { TasksButton } from "./tasks/TasksButton";
import { TaskTracker } from "./tasks/TaskTracker";
import { useTasksUi } from "./tasks/taskStore";
import { announceMenu } from "./ui/menuBus";

// The window width below which the top bar tools collapse behind a menu button (global.css).
const TOOLS_COLLAPSED = "(max-width: 1080px)";

export default function App() {
  useEffect(() => startUpdateChecks(), []);
  useEffect(() => installTerminalDrops(), []);
  useEffect(() => startBackgroundActivityPoll(), []);
  useEffect(() => {
    window.addEventListener("beforeunload", protectUnsavedUnload);
    return () => window.removeEventListener("beforeunload", protectUnsavedUnload);
  }, []);
  useAppControl();
  useEffect(() => { void initializeDictation().catch(() => {}); }, []);
  useEffect(() => initializePushToTalk(), []);
  const loadSessions = useStore((s) => s.loadSessions);
  const seedPreview = useStore((s) => s.seedPreview);

  const wizardOpen = useStore((s) => s.wizardOpen);
  // Top bar tools can be turned off in Settings > Appearance.
  const hiddenBarItems = useStore((s) => s.hiddenBarItems);
  const barShown = (id: BarItemId) => !hiddenBarItems.includes(id);
  const setWizardOpen = useStore((s) => s.setWizardOpen);

  const [syncRequest, setSyncRequest] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const [newWorkspaceRequest, setNewWorkspaceRequest] = useState(0);
  const remoteDesktop = useRemoteDesktop();
  // Sync and remote desktop only make sense with an enabled remote device.
  const hasRemote = useStore((state) => hasRemoteDevice(state.devices));
  // Forwarding needs an enabled remote source, the same gate the port panel uses.
  const forwardedPorts = useForwardedCount(hasRemote);
  useEffect(() => watchDisabledDevices(), []);
  const [portsLoading, setPortsLoading] = useState(false);
  const [menuError, setMenuError] = useState<string | null>(null);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [terminalSearchOpen, setTerminalSearchOpen] = useState(false);
  const [terminalSearchError, setTerminalSearchError] = useState<string | null>(null);
  const [paletteError, setPaletteError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // The canvas scrollbar's width while it scrolls vertically, so the bar takes
  // the place of the right spacing instead of adding to it (see .canvas).
  const canvasRef = useRef<HTMLElement>(null);
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    // The bar's real width: it is 0 where scrollbars overlay the content.
    const update = () => canvas.style.setProperty("--canvas-bar", `${canvas.scrollHeight > canvas.clientHeight + 1 ? canvas.offsetWidth - canvas.clientWidth : 0}px`);
    const sizes = new ResizeObserver(update);
    const watch = () => { sizes.disconnect(); sizes.observe(canvas); for (const child of Array.from(canvas.children)) sizes.observe(child); update(); };
    const children = new MutationObserver(watch);
    children.observe(canvas, { childList: true });
    watch();
    return () => { sizes.disconnect(); children.disconnect(); };
  }, []);
  const [helpRequest, setHelpRequest] = useState<HelpRequest | undefined>();
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  // Onboarding (machine setup plus the UI tour) opens on first launch and runs
  // to the end. Finished installs replay it from Settings → Help.
  // First launch: setup (requirements, then permissions), then the UI tour.
  const [setupOpen, setSetupOpen] = useState(setupPending);
  const [tourOpen, setTourOpen] = useState(() => !setupPending() && onboardingPending());
  // These load on first use and then stay mounted, keeping their state between openings.
  const paletteMounted = useOpenedOnce(paletteOpen);
  const terminalSearchMounted = useOpenedOnce(terminalSearchOpen);
  const setupMounted = useOpenedOnce(setupOpen);
  const tourMounted = useOpenedOnce(tourOpen);
  // Missing requirements on this Mac install in the background on every launch.
  useEffect(() => { startSetupAutoInstall(); }, []);
  // Every workspace keeps an auto-saved snapshot (see workspaceSnapshots).
  useEffect(() => startSnapshotAutosave(), []);
  // Settings, the palette, terminal search and the editor load once the window settles.
  useEffect(() => preloadWhenIdle(), []);
  useEffect(() => {
    const replay = () => whenLoaded(ONBOARDING, () => {
      setSettingsOpen(false);
      setSessionDialogOpen(false);
      setWizardOpen(false);
      setTourOpen(true);
    });
    // Setup can be run again from Settings → Help, e.g. after granting permissions.
    const rerunSetup = () => whenLoaded(ONBOARDING, () => {
      setSettingsOpen(false);
      setSessionDialogOpen(false);
      setWizardOpen(false);
      setTourOpen(false);
      setSetupOpen(true);
    });
    window.addEventListener("pzza:start-tour", replay);
    window.addEventListener("pzza:start-setup", rerunSetup);
    return () => {
      window.removeEventListener("pzza:start-tour", replay);
      window.removeEventListener("pzza:start-setup", rerunSetup);
    };
  }, [setWizardOpen]);
  const openSettings = (section: SettingsSection) => {
    announceMenu("settings");
    setSessionDialogOpen(false);
    setWizardOpen(false);
    setSettingsSection(section);
    setSettingsOpen(true);
    setToolsOpen(false);
  };
  const openPalette = () => whenLoaded([CommandPalette], () => setPaletteOpen(true));
  const openTerminalSearch = () => whenLoaded([TerminalSearch], () => { setPaletteOpen(false); setTerminalSearchOpen(true); });
  const openNewSession = useCallback(() => {
    announceMenu("new-session-dialog");
    setSettingsOpen(false);
    setToolsOpen(false);
    setSessionDialogOpen(true);
  }, []);
  const openNewWorkspace = useCallback(() => {
    announceMenu("ws-tabs");
    setSettingsOpen(false);
    setToolsOpen(false);
    setSessionDialogOpen(false);
    setNewWorkspaceRequest(request => request + 1);
  }, []);
  // A folder dropped on the canvas opens the new-session form; the form reads the folder.
  const newSessionRequest = useNewSessionRequest((s) => s.request);
  useEffect(() => { if (newSessionRequest) openNewSession(); }, [newSessionRequest, openNewSession]);
  const navigationRef = useRef({ settingsOpen, settingsSection, sessionDialogOpen, wizardOpen, openSettings, openNewSession, openNewWorkspace });
  navigationRef.current = { settingsOpen, settingsSection, sessionDialogOpen, wizardOpen, openSettings, openNewSession, openNewWorkspace };
  useEffect(() => {
    const cleanups = [
      registerAppControlState("navigation", () => {
        const state = navigationRef.current;
        return { settingsOpen: state.settingsOpen, settingsSection: state.settingsSection, sessionDialogOpen: state.sessionDialogOpen, setupOpen: state.wizardOpen };
      }),
      registerAppControlHandler("navigate", args => {
        announceMenu("app-navigation");
        setSettingsOpen(false); setSessionDialogOpen(false); setToolsOpen(false); setWizardOpen(false);
        if (args.target === "new_session") navigationRef.current.openNewSession();
        if (args.target === "new_workspace") navigationRef.current.openNewWorkspace();
        if (args.target === "setup") setWizardOpen(true);
        // The same events as the command palette's tour and setup rows.
        if (args.target === "tour") window.dispatchEvent(new Event("pzza:start-tour"));
        if (args.target === "requirements") window.dispatchEvent(new Event("pzza:start-setup"));
        return { target: args.target };
      }),
      registerAppControlHandler("open_help", args => {
        const topic = args.topic;
        if (typeof topic !== "string" || !HELP_SECTIONS.some(group => group.topics.some(id => id === topic))) throw new Error(`Unknown help topic. Topics: ${HELP_SECTIONS.flatMap(group => group.topics).join(", ")}.`);
        setHelpRequest({ topic, serial: Date.now() });
        navigationRef.current.openSettings("help");
        return { topic };
      }),
    ];
    return () => cleanups.forEach(cleanup => cleanup());
  }, [setWizardOpen]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const item = newItemShortcut(event);
      if (!item) return;
      event.preventDefault();
      event.stopPropagation();
      if (!event.repeat) (item === "session" ? openNewSession : openNewWorkspace)();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [openNewSession, openNewWorkspace]);
  // Capture phase, like the shortcuts above, so a focused terminal never sees it.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!commandPaletteShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      openPalette();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // The Tasks dropdown: its shortcut toggles it from anywhere (capture phase).
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (!tasksShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (useTasksUi.getState().open) useTasksUi.getState().close();
      else whenLoaded(TASK_SURFACES, () => useTasksUi.getState().show());
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
  // Search all terminals: the shortcut (capture phase, before a focused
  // terminal or editor) and the command palette's event open the same panel.
  useEffect(() => {
    const show = openTerminalSearch;
    const onKey = (event: KeyboardEvent) => {
      if (!searchTerminalsShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      show();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener(OPEN_TERMINAL_SEARCH_EVENT, show);
    return () => { window.removeEventListener("keydown", onKey, true); window.removeEventListener(OPEN_TERMINAL_SEARCH_EVENT, show); };
  }, []);
  useEffect(() => {
    if (!HAS_TAURI) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<string>("app-menu-action", ({ payload }) => {
      if (disposed) return;
      if (payload.startsWith("help:")) {
        const topic = payload.slice(5);
        if (HELP_SECTIONS.some(group => group.topics.some(id => id === topic))) {
          setHelpRequest(previous => ({ topic, serial: (previous?.serial ?? 0) + 1 }));
          setSessionDialogOpen(false);
          openSettings("help");
        }
        return;
      }
      if (payload === "new-session") { openNewSession(); return; }
      if (payload === "new-workspace") { openNewWorkspace(); return; }
      if (payload === "command-palette") { openPalette(); return; }
      if (payload === "search-terminals") { whenLoaded([TerminalSearch], () => setTerminalSearchOpen(true)); return; }
      if (["general", "about", "notifications", "devices", "sync", "remote", "mcp", "help", "quick-chat"].includes(payload)) {
        setSessionDialogOpen(false);
        openSettings(payload as SettingsSection);
      } else if (payload === "font-increase" || payload === "font-decrease") {
        const state = useStore.getState();
        state.setFontSize(state.fontSize + (payload === "font-increase" ? 1 : -1));
      }
    })).then((stop) => { if (disposed) stop(); else unlisten = stop; }).catch((error: unknown) => {
      if (!disposed) setMenuError(error instanceof Error ? error.message : "Could not connect the application menu.");
    });
    return () => { disposed = true; unlisten?.(); };
  }, [openNewSession, openNewWorkspace]);
  useEffect(() => {
    const section = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (value === "quick-chat" || value === "sync" || value === "mcp" || value === "devices" || value === "general") openSettings(value);
    };
    const terminal = () => setSettingsOpen(false);
    window.addEventListener("pzza-notification-section", section);
    window.addEventListener("pzza-notification-terminal", terminal);
    return () => { window.removeEventListener("pzza-notification-section", section); window.removeEventListener("pzza-notification-terminal", terminal); };
  }, []);
  const [nativeCloseError, setNativeCloseError] = useState<string | null>(null);
  useEffect(() => {
    if (!HAS_TAURI) return;
    let disposed = false;
    let confirming = false;
    let unlisten: (() => void) | undefined;
    const reportError = (error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      if (!disposed) setNativeCloseError(message);
      else console.error("Could not finish removing the window close listener.", message);
    };
    void import("@tauri-apps/api/window").then(async ({ getCurrentWindow }) => {
      if (disposed) return;
      const appWindow = getCurrentWindow();
      const stop = await appWindow.onCloseRequested(async (event) => {
        if (!hasUnsavedWork() && !confirming) { window.dispatchEvent(new Event("pzza:quick-chat-cancel")); return; }
        event.preventDefault();
        if (confirming || disposed) return;
        confirming = true;
        try {
          if (await confirmUnsavedWork() && !disposed) { window.dispatchEvent(new Event("pzza:quick-chat-cancel")); await appWindow.destroy(); }
        } catch (error) {
          reportError(error);
        } finally {
          confirming = false;
        }
      });
      if (disposed) stop();
      else unlisten = stop;
    }).catch(reportError);
    return () => {
      disposed = true;
      try { unlisten?.(); } catch (error) { reportError(error); }
    };
  }, []);
  // On narrow windows the tool buttons collapse behind a menu button and open
  // as a bar under the top bar; close that bar on an outside click or Escape.
  const [toolsOpen, setToolsOpen] = useState(false);
  const toolsRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!toolsOpen) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      // A tool's own portaled layer (a Select list, a menu) belongs to the tool.
      if (t instanceof Element && t.closest(".pzza-portal")) return;
      if (toolsRef.current && !toolsRef.current.contains(t)) setToolsOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setToolsOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [toolsOpen]);
  // Tasks opens from the shortcut, the palette or a notice too: on a narrow
  // window its button sits in the collapsed bar, which opens with it, and the
  // dropdown closes with that bar.
  const tasksOpen = useTasksUi((state) => state.open);
  const taskWindowOpen = useTasksUi((state) => state.details !== null);
  const toolsWereOpen = useRef(false);
  useEffect(() => {
    if (tasksOpen && !toolsOpen && window.matchMedia(TOOLS_COLLAPSED).matches) setToolsOpen(true);
  }, [tasksOpen]);
  useEffect(() => {
    if (toolsWereOpen.current && !toolsOpen && window.matchMedia(TOOLS_COLLAPSED).matches) useTasksUi.getState().close();
    toolsWereOpen.current = toolsOpen;
  }, [toolsOpen]);

  // On macOS the app uses an overlay title bar, so the traffic-light buttons sit
  // on top of the top bar's left edge. Tag the root so CSS can inset the brand
  // clear of them (and keep the whole bar draggable).
  useEffect(() => {
    const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");
    if (HAS_TAURI && isMac) document.documentElement.classList.add("tauri-mac");
    return () => document.documentElement.classList.remove("tauri-mac");
  }, []);

  // In macOS fullscreen the traffic lights leave the window (they live in the
  // hover menu bar), so drop the brand inset and let the logo slide left.
  // A resize fires on every fullscreen transition, which is when we re-check.
  useEffect(() => {
    if (!HAS_TAURI) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    const sync = async () => {
      try {
        const { getCurrentWindow } = await import("@tauri-apps/api/window");
        if (disposed) return;
        const fullscreen = await getCurrentWindow().isFullscreen();
        if (!disposed) document.documentElement.classList.toggle("tauri-fullscreen", fullscreen);
      } catch {
        /* offline or shutting down - keep the last state */
      }
    };
    void sync();
    void import("@tauri-apps/api/window")
      .then(({ getCurrentWindow }) => getCurrentWindow().onResized(() => { void sync(); }))
      .then(stop => { if (disposed) stop(); else unlisten = stop; })
      .catch(() => {});
    return () => {
      disposed = true;
      try { unlisten?.(); } catch { /* ignore */ }
      document.documentElement.classList.remove("tauri-fullscreen");
    };
  }, []);

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    loadSessions().catch(() => {
      if (!HAS_TAURI) seedPreview();
    });
  }, [loadSessions, seedPreview]);

  return (
    <ThemeProvider>
      <ConfirmationHost />
      <ContextMenu />
      <SessionRefreshHost />
      <Modal open={menuError !== null} onClose={() => setMenuError(null)} title="Application menu" size="sm">
        <p role="alert">{menuError}</p>
      </Modal>
      <Modal open={sessionDialogOpen} onClose={() => setSessionDialogOpen(false)} title="New session" size="md" className="creation-dialog">
        <SessionMenu close={() => setSessionDialogOpen(false)} />
      </Modal>
      <Tooltip />
      <TaskTracker />
      {taskWindowOpen ? <TaskWindow /> : null}
      {paletteMounted ? <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onError={setPaletteError} /> : null}
      {terminalSearchMounted ? <TerminalSearch open={terminalSearchOpen} onClose={() => setTerminalSearchOpen(false)} onError={setTerminalSearchError} /> : null}
      <Modal open={terminalSearchError !== null} onClose={() => setTerminalSearchError(null)} title="Search all terminals" size="sm">
        <p className="move-q" role="alert">{terminalSearchError}</p>
        <div className="modal-actions"><button className="btn" onClick={() => setTerminalSearchError(null)}>Dismiss</button></div>
      </Modal>
      <Modal open={paletteError !== null} onClose={() => setPaletteError(null)} title="Command palette" size="sm">
        <p className="move-q" role="alert">{paletteError}</p>
        <div className="modal-actions"><button className="btn" onClick={() => setPaletteError(null)}>Dismiss</button></div>
      </Modal>
      <Modal open={nativeCloseError !== null} onClose={() => setNativeCloseError(null)} title="Window close protection" size="sm">
        <p className="move-q" role="alert">{nativeCloseError}</p>
        <p className="set-note">Save your editor changes before closing the window again.</p>
        <div className="modal-actions"><button className="btn" onClick={() => setNativeCloseError(null)}>Dismiss</button></div>
      </Modal>
      {/* Hidden, not unmounted, behind setup: terminals keep running, and a
          transparent window shows the desktop through setup rather than tiles. */}
      <div className={`app ${setupOpen ? "app-behind-setup" : ""}`}>
        <header className="topbar" data-tauri-drag-region>
          <div className="brand">
            <span className="brand-mark">
              <img src="/pzzacode.svg" alt="" className="brand-logo" />
            </span>
            <span className="brand-name">PzzaCode</span>
            <span className="brand-version">v{__APP_VERSION__}</span>
            <UpdateButton />
          </div>

            <WorkspaceTabs openRequest={newWorkspaceRequest} />

          <div className="topbar-spacer" />

          <div className="topbar-right">
            {/* The tool cluster renders once. Wide: inline. Narrow: hidden behind
                the menu button and shown as a full-width bar under the top bar,
                so each tool's dropdown still anchors to its own button. */}
            <div className="topbar-tools-wrap" ref={toolsRef}>
              <IconButton
                icon={Menu}
                title="Tools"
                className="topbar-tools-toggle"
                active={toolsOpen}
                onClick={() => setToolsOpen((v) => !v)}
              />
              <div className={`topbar-tools ${toolsOpen ? "open" : ""}`}>
                {barShown("top:tasks") ? <TasksButton /> : null}
                {barShown("top:quick-chat") ? <QuickChat onOpenSettings={() => openSettings("quick-chat")} /> : null}
                {(hasRemote || syncing) && barShown("top:sync") ? <div className="toolbar-action-status">
                  <IconButton icon={FolderSync} title={syncing ? "Sync in progress" : "Sync projects"} onClick={() => {
                    setToolsOpen(false);
                    setSyncRequest(value => value + 1);
                  }} />
                  {syncing ? <span className="toolbar-sync-indicator" role="status" aria-label="Sync in progress" /> : null}
                </div> : null}
                {hasRemote && barShown("top:remote") ? <Dropdown icon={Monitor} title="Remote desktop" controlId="remote_desktop" loading={remoteDesktop.busy} width={180} align="end" compact tourId="remote">
                  {(close) => <>
                    <button type="button" className="menu-item" disabled={remoteDesktop.busy} onClick={() => { close(); void remoteDesktop.openSaved(); }}>
                      <Monitor size={16} strokeWidth={1.9} />
                      Open
                    </button>
                    <button type="button" className="menu-item" onClick={() => { close(); openSettings("remote"); }}>
                      <SettingsIcon size={16} strokeWidth={1.9} />
                      Settings
                    </button>
                  </>}
                </Dropdown> : null}
                {barShown("top:ports") ? <Dropdown icon={EthernetPort} title="Port manager" controlId="port_forwarding" width={320} loading={portsLoading} align="end" compact tourId="ports"
                  badgeLabel={forwardedPorts ? `Port manager: ${forwardedPorts} forwarded port${forwardedPorts === 1 ? "" : "s"}` : undefined}
                  cornerBadge={forwardedPorts ? countLabel(forwardedPorts) : null}>
                  {(close, open) => <PortsMenu active={open && !settingsOpen} onLoadingChange={setPortsLoading} onOpenSettings={() => { close(); openSettings("ports"); }} />}
                </Dropdown> : null}
                {barShown("top:usage") || barShown("top:notifications") ? <span className="topbar-tools-sep" aria-hidden="true" /> : null}
                {barShown("top:usage") ? <UsageTool /> : null}
                {barShown("top:notifications") ? <NotificationsTool viewAll={() => openSettings("notifications")} /> : null}
                <span className="topbar-tools-sep" aria-hidden="true" />
                <IconButton icon={SettingsIcon} title="Settings" tourId="settings" onClick={() => openSettings("general")} />
                <Dropdown icon={Plus} title="New session" controlId="new_session" width={380} panelClassName="creation-panel" shortcut={NEW_SESSION_SHORTCUT} tourId="new-session">
                  {(close) => <SessionMenu close={close} />}
                </Dropdown>
              </div>
            </div>

          </div>
        </header>


        <div className="body">
          <main className="canvas" ref={canvasRef}>
            <Canvas onNewSession={openNewSession} />
          </main>
        </div>
      </div>
      <SetupWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      {/* The tour follows setup only while it is still to come: running setup again from Settings never replays a finished tour. */}
      {setupMounted ? <SetupScreen open={setupOpen} onDone={() => {
        if (onboardingPending()) whenLoaded(ONBOARDING, () => { setSetupOpen(false); setTourOpen(true); });
        else setSetupOpen(false);
      }} /> : null}
      {tourMounted ? <OnboardingTour open={tourOpen} onClose={() => setTourOpen(false)} /> : null}
      <SettingsHub onOpen={openSettings} helpRequest={helpRequest} open={settingsOpen} section={settingsSection} onSectionChange={setSettingsSection} onClose={() => setSettingsOpen(false)} syncRequest={syncRequest} onSyncingChange={setSyncing} />
    </ThemeProvider>
  );
}
