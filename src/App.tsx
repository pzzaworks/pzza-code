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

export default function App() {
  const loadSessions = useStore((s) => s.loadSessions);
  const seedPreview = useStore((s) => s.seedPreview);

  const seedWorkspaces = useStore((s) => s.seedWorkspaces);

  const [wizardOpen, setWizardOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);

  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    seedWorkspaces();
    loadSessions().catch(() => {
      if (!HAS_TAURI) seedPreview();
    });
    // First run in the browser build: open the setup wizard so a fresh device
    // gets its agent configured.
    if (!HAS_TAURI) {
      try {
        if (!localStorage.getItem("pzza.setupDone")) setWizardOpen(true);
      } catch {
        /* ignore */
      }
    }
  }, [loadSessions, seedPreview, seedWorkspaces]);

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
            <LayoutMenu />
            <Dropdown icon={Monitor} title="Linux desktop (RDP)" width={300}>
              {(close) => <RdpMenu close={close} />}
            </Dropdown>
            <Dropdown icon={EthernetPort} title="Port forwarding" width={320}>
              <PortsMenu />
            </Dropdown>
            <Dropdown icon={HardDrive} title="Devices" width={300}>
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
              <SettingsMenu />
            </Dropdown>
            <Dropdown icon={Plus} title="New session" label="New session" width={340}>
              {(close) => <SessionMenu close={close} />}
            </Dropdown>
          </div>
        </header>

        <div className="body">
          <main className="canvas">
            <Canvas />
          </main>
        </div>
      </div>
      <SetupWizard open={wizardOpen} onClose={() => setWizardOpen(false)} />
      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </ThemeProvider>
  );
}
