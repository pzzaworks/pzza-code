import { useEffect, useRef, useState } from "react";
import {
  Bell,
  Monitor,
  Plus,
  Settings as SettingsIcon,
  FolderSync,
  Gauge,
  Menu,
} from "lucide-react";
import { QuickChat } from "./panels/QuickChat";
import { LatestNotifications } from "./panels/Notifications";
import { useNotifications } from "./state/notifications";
import { useBridgeNotifications } from "./notificationEvents";
import { ContextMenu } from "./ui/ContextMenu";
import { ThemeProvider } from "./theme/ThemeProvider";
import { useStore } from "./state/store";
import { Canvas } from "./grid/Canvas";
import { WorkspaceTabs } from "./grid/WorkspaceTabs";
import { LayoutMenu } from "./grid/LayoutMenu";
import { SettingsHub, type SettingsSection } from "./panels/SettingsHub";
import { useRemoteDesktop } from "./panels/RdpMenu";
import { SessionMenu } from "./panels/SessionMenu";
import { Dropdown } from "./ui/Dropdown";
import { IconButton } from "./ui/IconButton";
import { Tooltip } from "./ui/Tooltip";
import { SetupWizard } from "./panels/SetupWizard";
import { UsageMenu } from "./panels/UsageMenu";
import { HAS_TAURI } from "./tauriEnv";
import { startUpdateChecks } from "./state/updates";
import { Modal } from "./ui/Modal";
import { confirmEditorDiscard, hasUnsavedEditors } from "./editorChanges";
import { useAppControl } from "./appControl";
import { initializeDictation } from "./state/dictation";

export default function App() {
  useEffect(() => startUpdateChecks(), []);
  useAppControl();
  useBridgeNotifications();
  const unreadNotifications = useNotifications(state => state.items.filter(item => !item.read).length);
  useEffect(() => { void initializeDictation().catch(() => {}); }, []);
  const loadSessions = useStore((s) => s.loadSessions);
  const seedPreview = useStore((s) => s.seedPreview);

  const wizardOpen = useStore((s) => s.wizardOpen);
  const setWizardOpen = useStore((s) => s.setWizardOpen);

  const [syncRequest, setSyncRequest] = useState(0);
  const [syncing, setSyncing] = useState(false);
  const [sessionDialogOpen, setSessionDialogOpen] = useState(false);
  const remoteDesktop = useRemoteDesktop();
  const [menuError, setMenuError] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [settingsSection, setSettingsSection] = useState<SettingsSection>("general");
  const openSettings = (section: SettingsSection) => {
    setSettingsSection(section);
    setSettingsOpen(true);
    setToolsOpen(false);
  };
  useEffect(() => {
    if (!HAS_TAURI) return;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    void import("@tauri-apps/api/event").then(({ listen }) => listen<string>("app-menu-action", ({ payload }) => {
      if (disposed) return;
      if (payload === "new-session") { setSettingsOpen(false); setSessionDialogOpen(true); return; }
      if (["general", "about", "notifications", "devices", "sync", "remote", "mcp", "help", "agents-hub"].includes(payload)) {
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
  }, []);
  useEffect(() => {
    const section = (event: Event) => {
      const value: unknown = (event as CustomEvent).detail;
      if (value === "agents-hub" || value === "sync" || value === "mcp" || value === "devices" || value === "general") openSettings(value);
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
        if (!hasUnsavedEditors() && !confirming) return;
        event.preventDefault();
        if (confirming || disposed) return;
        confirming = true;
        try {
          if (await confirmEditorDiscard() && !disposed) await appWindow.destroy();
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

  // On macOS the app uses an overlay title bar, so the traffic-light buttons sit
  // on top of the top bar's left edge. Tag the root so CSS can inset the brand
  // clear of them (and keep the whole bar draggable).
  useEffect(() => {
    const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform || navigator.userAgent || "");
    if (HAS_TAURI && isMac) document.documentElement.classList.add("tauri-mac");
    return () => document.documentElement.classList.remove("tauri-mac");
  }, []);

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    loadSessions().catch(() => {
      if (!HAS_TAURI) seedPreview();
    });
    // First run: open the setup wizard so a fresh install gets its local agent
    // verified and can add remote devices. Runs in both the app and the browser
    // build - the wizard adapts its checks to whichever backend it is talking to.
    try {
      if (!localStorage.getItem("pzza.setupDone")) setWizardOpen(true);
    } catch {
      /* ignore */
    }
  }, [loadSessions, seedPreview, setWizardOpen]);

  return (
    <ThemeProvider>
      <ContextMenu />
      <Modal open={menuError !== null} onClose={() => setMenuError(null)} title="Application menu" size="sm">
        <p role="alert">{menuError}</p>
      </Modal>
      <Modal open={sessionDialogOpen} onClose={() => setSessionDialogOpen(false)} title="New session" size="sm">
        <SessionMenu close={() => setSessionDialogOpen(false)} />
      </Modal>
      <Tooltip />
      <Modal open={nativeCloseError !== null} onClose={() => setNativeCloseError(null)} title="Window close protection" size="sm">
        <p className="move-q" role="alert">{nativeCloseError}</p>
        <p className="set-note">Save your editor changes before closing the window again.</p>
        <div className="modal-actions"><button className="btn" onClick={() => setNativeCloseError(null)}>Dismiss</button></div>
      </Modal>
      <div className="app">
        <header className="topbar" data-tauri-drag-region>
          <div className="brand">
            <span className="brand-mark">
              <img src="/pzzacode.svg" alt="" className="brand-logo" />
            </span>
            <span className="brand-name">PzzaCode</span>
            <span className="brand-version">v{__APP_VERSION__}</span>
          </div>

          <WorkspaceTabs />

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
                <QuickChat onOpenSettings={() => openSettings("quick-chat")} />
                <LayoutMenu />
                <div className="toolbar-action-status">
                  <IconButton icon={FolderSync} title="Sync projects" disabled={syncing} onClick={() => {
                    setToolsOpen(false);
                    setSyncRequest(value => value + 1);
                  }} />
                  {syncing ? <span className="toolbar-sync-indicator" role="status" aria-label="Sync in progress" /> : null}
                </div>
                <IconButton icon={Monitor} title="Remote desktop" loading={remoteDesktop.busy} onClick={() => { void remoteDesktop.openSaved(); }} />
                <Dropdown icon={Gauge} title="Agent usage" width={320}>
                  <UsageMenu />
                </Dropdown>
                <div className="notification-toolbar">
                  <Dropdown icon={Bell} title="Notifications" width={380} panelClassName="notifications-panel">
                    {(close) => <LatestNotifications viewAll={() => { close(); openSettings("notifications"); }} />}
                  </Dropdown>
                  {unreadNotifications ? <span className="notification-badge" aria-label={`${unreadNotifications} unread notifications`} /> : null}
                </div>
                <IconButton icon={SettingsIcon} title="Settings" onClick={() => openSettings("general")} />
                <Dropdown icon={Plus} title="New session" label="New session" width={340}>
                  {(close) => <SessionMenu close={close} />}
                </Dropdown>
              </div>
            </div>

          </div>
        </header>


        <div className="body">
          <main className="canvas">
            <Canvas />
          </main>
        </div>
      </div>
      <SetupWizard
        open={wizardOpen}
        onClose={() => {
          setWizardOpen(false);
          // Remember it was seen so it does not auto-open on every load.
          try {
            localStorage.setItem("pzza.setupDone", "1");
          } catch {
            /* ignore */
          }
        }}
      />
      <SettingsHub open={settingsOpen} section={settingsSection} onSectionChange={setSettingsSection} onClose={() => setSettingsOpen(false)} syncRequest={syncRequest} onSyncingChange={setSyncing} />
    </ThemeProvider>
  );
}
