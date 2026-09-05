import { useEffect, useRef, useState } from "react";
import {
  Blocks,
  HardDrive,
  Monitor,
  Plus,
  Settings as SettingsIcon,
  EthernetPort,
  CircleQuestionMark,
  Gauge,
  Menu,
} from "lucide-react";
import { ThemeProvider } from "./theme/ThemeProvider";
import { useStore } from "./state/store";
import { Canvas } from "./grid/Canvas";
import { WorkspaceTabs } from "./grid/WorkspaceTabs";
import { LayoutMenu } from "./grid/LayoutMenu";
import { SettingsMenu } from "./panels/SettingsMenu";
import { PortsMenu } from "./panels/PortsMenu";
import { SessionMenu } from "./panels/SessionMenu";
import { RdpMenu } from "./panels/RdpMenu";
import { DevicesMenu } from "./panels/DevicesMenu";
import { McpMenu } from "./panels/McpMenu";
import { Dropdown } from "./ui/Dropdown";
import { IconButton } from "./ui/IconButton";
import { Tooltip } from "./ui/Tooltip";
import { SetupWizard } from "./panels/SetupWizard";
import { HelpModal } from "./panels/HelpModal";
import { UsageMenu } from "./panels/UsageMenu";
import { HAS_TAURI } from "./tauriEnv";
import { UpdateBanner } from "./panels/UpdateBanner";

export default function App() {
  const loadSessions = useStore((s) => s.loadSessions);
  const seedPreview = useStore((s) => s.seedPreview);

  const wizardOpen = useStore((s) => s.wizardOpen);
  const setWizardOpen = useStore((s) => s.setWizardOpen);

  const [helpOpen, setHelpOpen] = useState(false);
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
      <Tooltip />
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
                <LayoutMenu />
                <Dropdown icon={Monitor} title="Linux desktop (RDP)" width={300}>
                  {(close) => <RdpMenu close={close} />}
                </Dropdown>
                <Dropdown icon={EthernetPort} title="Port forwarding" width={320}>
                  <PortsMenu />
                </Dropdown>
                <Dropdown icon={HardDrive} title="Devices" width={380}>
                  <DevicesMenu />
                </Dropdown>
                <Dropdown icon={Blocks} title="MCP" width={320}>
                  <McpMenu />
                </Dropdown>
                <Dropdown icon={Gauge} title="Agent usage" width={320}>
                  <UsageMenu />
                </Dropdown>
                <IconButton
                  icon={CircleQuestionMark}
                  title="Help & docs"
                  onClick={() => setHelpOpen(true)}
                />
                <Dropdown icon={SettingsIcon} title="Settings" width={320}>
                  {(close) => <SettingsMenu close={close} />}
                </Dropdown>
                <Dropdown icon={Plus} title="New session" label="New session" width={340}>
                  {(close) => <SessionMenu close={close} />}
                </Dropdown>
              </div>
            </div>
          </div>
        </header>

        <UpdateBanner />

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
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </ThemeProvider>
  );
}
