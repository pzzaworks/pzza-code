import { useEffect, useRef, useState, type ComponentType } from "react";
import { useModalFocus } from "../ui/Modal";
import { registerAppControlHandler, registerAppControlState } from "../appControlRuntime";
import { createPortal } from "react-dom";
import { Bot, Info, ChevronDown, Bell, Blocks, CircleQuestionMark, FolderSync, HardDrive, Settings, X } from "lucide-react";
import { AgentsHubContent, agentsHubSections, type AgentsHubSection } from "./AgentsHub";
import { SettingsMenu, generalSections, type GeneralSection } from "./SettingsMenu";
import { DevicesMenu } from "./DevicesMenu";
import { ProjectsMenu } from "./ProjectsMenu";
import { QuickChatSettings } from "./QuickChat";
import { PortsMenu } from "./PortsMenu";
import { RdpMenu } from "./RdpMenu";
import { McpMenu } from "./McpMenu";
import { BridgeSettings } from "./BridgeSettings";
import { HelpContent, HELP_SECTIONS, type HelpSection, type HelpRequest } from "./HelpModal";
import { About } from "./About";
import { NotificationsSettings } from "./Notifications";
import "./SettingsHub.css";

const sections = [
  { id: "general", label: "General", icon: Settings },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "agents-hub", label: "Agents Hub", icon: Bot },
  { id: "devices", label: "Devices", icon: HardDrive },
  { id: "sync", label: "Sync", icon: FolderSync },
  { id: "mcp", label: "Connections", icon: Blocks },
  { id: "help", label: "Help", icon: CircleQuestionMark },
  { id: "about", label: "About", icon: Info },
] as const;
export type SettingsSection = typeof sections[number]["id"] | "remote" | "ports" | "quick-chat";

interface Props {
  open: boolean;
  helpRequest?: HelpRequest;
  syncRequest?: number;
  onSyncingChange?: (syncing: boolean) => void;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
  onOpen: (section: SettingsSection) => void;
}

export function SettingsHub({ open, section, onSectionChange, onOpen, onClose, syncRequest = 0, onSyncingChange, helpRequest }: Props) {
  const [generalSection, setGeneralSection] = useState<GeneralSection>("appearance");
  const [notificationPage, setNotificationPage] = useState<"activity" | "preferences">("activity");
  const [agentsSection, setAgentsSection] = useState<AgentsHubSection>("instructions");
  const [helpSection, setHelpSection] = useState<HelpSection>("getting-started");
  useEffect(() => {
    if (!helpRequest) return;
    const group = HELP_SECTIONS.find(entry => entry.topics.some(topic => topic === helpRequest.topic));
    if (group) setHelpSection(group.id);
  }, [helpRequest]);
  const [agentsVisited, setAgentsVisited] = useState(false);
  const [connectionTab, setConnectionTab] = useState<"mcp" | "bridge" | "bridge-activity">("mcp");
  const [syncPage, setSyncPage] = useState<"repositories" | "preferences">("repositories");
  const [syncVisited, setSyncVisited] = useState(false);
  const [mcpVisited, setMcpVisited] = useState(false);
  const [portsVisited, setPortsVisited] = useState(false);
  const controlRef = useRef({ open, section, generalSection, notificationPage, agentsSection, helpSection, connectionTab, syncPage, onOpen });
  controlRef.current = { open, section, generalSection, notificationPage, agentsSection, helpSection, connectionTab, syncPage, onOpen };
  useEffect(() => {
    const pages: Record<SettingsSection, readonly string[]> = {
      general: generalSections.map(item => item.id), notifications: ["activity", "preferences"],
      "agents-hub": agentsHubSections.map(item => item.id), devices: [], sync: ["repositories", "preferences"],
      mcp: ["mcp", "bridge", "bridge-activity"], help: HELP_SECTIONS.map(item => item.id), about: [], remote: [], ports: [], "quick-chat": [],
    };
    const cleanups = [
      registerAppControlState("settings", () => {
        const current = controlRef.current;
        return { open: current.open, section: current.section, pages, page: current.section === "general" ? current.generalSection : current.section === "notifications" ? current.notificationPage : current.section === "agents-hub" ? current.agentsSection : current.section === "help" ? current.helpSection : current.section === "mcp" ? current.connectionTab : current.section === "sync" ? current.syncPage : null };
      }),
      registerAppControlHandler("open_settings", args => {
        const target = args.section as SettingsSection;
        const page = args.page as string | undefined;
        if (page !== undefined && !pages[target].includes(page)) throw new Error("Unknown page for this settings section. Read settings.pages for supported pages.");
        if (page !== undefined) {
          if (target === "general") setGeneralSection(page as GeneralSection);
          if (target === "notifications") setNotificationPage(page as "activity" | "preferences");
          if (target === "agents-hub") setAgentsSection(page as AgentsHubSection);
          if (target === "help") setHelpSection(page as HelpSection);
          if (target === "mcp") setConnectionTab(page as "mcp" | "bridge" | "bridge-activity");
          if (target === "sync") setSyncPage(page as "repositories" | "preferences");
        }
        controlRef.current.onOpen(target);
        return { section: target, page: page ?? null };
      }),
    ];
    return () => cleanups.forEach(cleanup => cleanup());
  }, []);
  const parentSection = section === "quick-chat" ? "agents-hub" : section === "remote" || section === "ports" ? "mcp" : section;
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.querySelector(".settings-hub-content")?.scrollTo({ top: 0 });
  }, [section, generalSection, notificationPage, agentsSection, helpSection, connectionTab, syncPage]);
  useModalFocus(open, dialog, onClose);
  useEffect(() => {
    if (open && section === "agents-hub") setAgentsVisited(true);
    if ((open && section === "sync") || syncRequest > 0) setSyncVisited(true);
    if (open && section === "mcp") setMcpVisited(true);
    if (open && section === "ports") setPortsVisited(true);
  }, [open, section, syncRequest]);

  if (!open && !syncVisited && !mcpVisited && !portsVisited && !agentsVisited && syncRequest === 0) return null;
  return createPortal(
    <div className="modal-backdrop pzza-portal settings-hub-backdrop" hidden={!open} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal settings-hub" role="dialog" aria-modal="true" aria-labelledby="settings-hub-title" ref={dialog} tabIndex={-1}>
        <div className="modal-head">
          <span className="modal-title" id="settings-hub-title"><Settings size={16} /> Settings</span>
          <button type="button" className="dismiss-btn" aria-label="Close Settings" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="settings-hub-layout">
          <nav className="settings-hub-nav" aria-label="Settings sections">
            {sections.map(({ id, label, icon: Icon }) => {
              const active = parentSection === id;
              const hasChildren = ["general", "notifications", "agents-hub", "sync", "mcp", "help"].includes(id);
              return <div className="settings-nav-group" key={id}>
                <button type="button" aria-current={active && !hasChildren ? "page" : undefined} aria-expanded={hasChildren ? active : undefined} className={`settings-hub-link ${active ? "active" : ""}`} onClick={() => onSectionChange(id)}><Icon size={16} /><span>{label}</span>{hasChildren ? <ChevronDown size={13} className="settings-nav-chevron" /> : null}</button>
                {active && id === "general" ? <SettingsSubnav label="General settings" items={generalSections} value={generalSection} onChange={setGeneralSection} /> : null}
                {active && id === "notifications" ? <SettingsSubnav label="Notification pages" items={[{ id: "activity", label: "Activity" }, { id: "preferences", label: "Preferences" }]} value={notificationPage} onChange={setNotificationPage} /> : null}
                {active && id === "agents-hub" ? <SettingsSubnav label="Agents Hub pages" items={[...agentsHubSections, { id: "quick-chat", label: "Quick Chat" }]} value={section === "quick-chat" ? "quick-chat" : agentsSection} onChange={(value: AgentsHubSection | "quick-chat") => { if (value === "quick-chat") onSectionChange("quick-chat"); else { setAgentsSection(value); onSectionChange("agents-hub"); } }} /> : null}
                {active && id === "sync" ? <SettingsSubnav label="Sync pages" items={[{ id: "repositories", label: "Repositories" }, { id: "preferences", label: "Preferences" }]} value={syncPage} onChange={setSyncPage} /> : null}
                {active && id === "mcp" ? <SettingsSubnav label="Connection settings" items={[{ id: "mcp", label: "MCP integrations" }, { id: "bridge", label: "Device bridge" }, { id: "bridge-activity", label: "Bridge activity" }, { id: "remote", label: "Remote desktop" }, { id: "ports", label: "Port forwarding" }]} value={section === "remote" || section === "ports" ? section : connectionTab} onChange={(value: "mcp" | "bridge" | "bridge-activity" | "remote" | "ports") => { if (value === "remote" || value === "ports") onSectionChange(value); else { setConnectionTab(value); onSectionChange("mcp"); } }} /> : null}
                {active && id === "help" ? <SettingsSubnav label="Help topics" items={HELP_SECTIONS} value={helpSection} onChange={setHelpSection} /> : null}
              </div>;
            })}
          </nav>
          <div className="settings-hub-main">
            <div className="settings-hub-content">
              {open && section === "general" ? <SettingsMenu section={generalSection} /> : null}
              {open && section === "notifications" ? <NotificationsSettings page={notificationPage} /> : null}
              {agentsVisited || (open && section === "agents-hub") ? <div hidden={!open || section !== "agents-hub"}><AgentsHubContent section={agentsSection} onSectionChange={setAgentsSection} active={open && section === "agents-hub"} onOpenSession={onClose} /></div> : null}
              {open && section === "devices" ? <DevicesMenu /> : null}
              {/* The same sync instance owns the scan across navigation and closing. */}
              {syncVisited || syncRequest > 0 || (open && section === "sync") ? <div hidden={!open || section !== "sync"}><ProjectsMenu active={open && section === "sync"} page={syncPage} syncRequest={syncRequest} onSyncingChange={onSyncingChange} /></div> : null}
              {open && section === "quick-chat" ? <QuickChatSettings /> : null}
              {portsVisited || (open && section === "ports") ? <div hidden={!open || section !== "ports"}><PortsMenu active={open && section === "ports"} /></div> : null}
              {open && section === "remote" ? <RdpMenu close={onClose} /> : null}
              {mcpVisited || (open && section === "mcp") ? <div hidden={!open || section !== "mcp"}><div hidden={connectionTab !== "bridge" && connectionTab !== "bridge-activity"}><BridgeSettings page={connectionTab === "bridge-activity" ? "activity" : "access"} active={open && section === "mcp" && (connectionTab === "bridge" || connectionTab === "bridge-activity")} /></div><div hidden={connectionTab !== "mcp"}><McpMenu /></div></div> : null}
              {open && section === "about" ? <About /> : null}
              {open && section === "help" ? <HelpContent section={helpSection} request={helpRequest} /> : null}
            </div>
          </div>
        </div>
      </div>
    </div>, document.body,
  );
}

function SettingsSubnav<T extends string>({ label, items, value, onChange }: {
  label: string;
  items: readonly { id: T; label: string; icon?: ComponentType<{ size?: number | string; className?: string }> }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return <div className="settings-nav-children" role="group" aria-label={label}>
    {items.map(({ id, label: itemLabel, icon: Icon }) => <button type="button" key={id} aria-current={value === id ? "page" : undefined} className={`settings-hub-sublink ${value === id ? "active" : ""}`} onClick={() => onChange(id)}>{Icon ? <Icon size={14} /> : null}<span>{itemLabel}</span></button>)}
  </div>;
}
