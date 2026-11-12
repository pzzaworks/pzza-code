import { useEffect, useRef, useState } from "react";
import { useModalFocus } from "../ui/Modal";
import { registerAppControlHandler, registerAppControlState } from "../appControlRuntime";
import { createPortal } from "react-dom";
import { Info, ChevronDown, Bell, Blocks, CircleQuestionMark, FolderSync, HardDrive, MessageSquare, Settings, Wrench, X } from "lucide-react";
import { generalSections, type GeneralSection } from "./settingsSections";
import { QuickChatSettings } from "./QuickChat";
import { PortsMenu } from "./PortsMenu";
import { RdpMenu } from "./RdpMenu";
import { useStore } from "../state/store";
import { hasRemoteDevice } from "../devices";
import { HELP_SECTIONS, isHelpTopic, type HelpTopic, type HelpRequest } from "./helpTopics";
import { About, DevicesMenu, HelpContent, HelpNav, McpMenu, ProjectsMenu, SETTINGS_PAGES, SettingsMenu, SetupSettings } from "../lazySurfaces";
import { useSurfacesLoaded } from "../lazySurface";
import { NotificationsSettings } from "./Notifications";
// Styles of the pages that load later (see lazySurfaces), kept in the main
// stylesheet in their original cascade order.
import "../ui/Slider.css";
import "../ui/Segmented.css";
import "./SettingsHub.css";

const sections = [
  { id: "general", label: "General", icon: Settings },
  { id: "notifications", label: "Notifications", icon: Bell },
  { id: "quick-chat", label: "Quick Chat", icon: MessageSquare },
  { id: "devices", label: "Devices", icon: HardDrive },
  { id: "sync", label: "Sync", icon: FolderSync },
  { id: "mcp", label: "Connections", icon: Blocks },
  { id: "setup", label: "Setup", icon: Wrench },
  { id: "help", label: "Help", icon: CircleQuestionMark },
  { id: "about", label: "About", icon: Info },
] as const;
export type SettingsSection = typeof sections[number]["id"] | "remote" | "ports";

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
  const hasRemote = useStore((state) => hasRemoteDevice(state.devices));
  const [generalSection, setGeneralSection] = useState<GeneralSection>("appearance");
  const [notificationPage, setNotificationPage] = useState<"activity" | "preferences">("activity");
  const [helpTopic, setHelpTopic] = useState<HelpTopic>("start");
  useEffect(() => {
    if (helpRequest && isHelpTopic(helpRequest.topic)) setHelpTopic(helpRequest.topic);
  }, [helpRequest]);
  const [syncPage, setSyncPage] = useState<"repositories" | "preferences">("repositories");
  const [syncVisited, setSyncVisited] = useState(false);
  const [mcpVisited, setMcpVisited] = useState(false);
  const [portsVisited, setPortsVisited] = useState(false);
  const controlRef = useRef({ open, section, generalSection, notificationPage, helpTopic, syncPage, onOpen });
  controlRef.current = { open, section, generalSection, notificationPage, helpTopic, syncPage, onOpen };
  useEffect(() => {
    const pages: Record<SettingsSection, readonly string[]> = {
      general: generalSections.map(item => item.id), notifications: ["activity", "preferences"],
      setup: [], "quick-chat": [], devices: [], sync: ["repositories", "preferences"],
      mcp: ["mcp"], help: HELP_SECTIONS.flatMap(item => item.topics), about: [], remote: [], ports: [],
    };
    const cleanups = [
      registerAppControlState("settings", () => {
        const current = controlRef.current;
        return { open: current.open, section: current.section, pages, page: current.section === "general" ? current.generalSection : current.section === "notifications" ? current.notificationPage : current.section === "help" ? current.helpTopic : current.section === "mcp" ? "mcp" : current.section === "sync" ? current.syncPage : null };
      }),
      registerAppControlHandler("open_settings", args => {
        const target = args.section as SettingsSection;
        const page = args.page as string | undefined;
        if (page !== undefined && !pages[target].includes(page)) throw new Error("Unknown page for this settings section. Read settings.pages for supported pages.");
        if (page !== undefined) {
          if (target === "general") setGeneralSection(page as GeneralSection);
          if (target === "notifications") setNotificationPage(page as "activity" | "preferences");
          if (target === "help") setHelpTopic(page as HelpTopic);
          if (target === "sync") setSyncPage(page as "repositories" | "preferences");
        }
        controlRef.current.onOpen(target);
        return { section: target, page: page ?? null };
      }),
    ];
    return () => cleanups.forEach(cleanup => cleanup());
  }, []);
  const parentSection = section === "remote" || section === "ports" ? "mcp" : section;
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.querySelector(".settings-hub-content")?.scrollTo({ top: 0 });
  }, [section, generalSection, notificationPage, helpTopic, syncPage]);
  // Settings shows once all of its pages are loaded (usually already, see
  // preloadWhenIdle), so it never opens on an empty page.
  const pagesReady = useSurfacesLoaded(SETTINGS_PAGES, open);
  const shown = open && pagesReady;
  useModalFocus(shown, dialog, onClose);
  useEffect(() => {
    if ((open && section === "sync") || syncRequest > 0) setSyncVisited(true);
    if (open && section === "mcp") setMcpVisited(true);
    if (open && section === "ports") setPortsVisited(true);
  }, [open, section, syncRequest]);

  if (!shown && !syncVisited && !mcpVisited && !portsVisited && syncRequest === 0) return null;
  return createPortal(
    <div className="modal-backdrop pzza-portal settings-hub-backdrop" hidden={!shown} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal settings-hub" role="dialog" aria-modal="true" aria-labelledby="settings-hub-title" ref={dialog} tabIndex={-1}>
        <div className="modal-head">
          <span className="modal-title" id="settings-hub-title"><Settings size={16} /> Settings</span>
          <button type="button" className="dismiss-btn" aria-label="Close Settings" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="settings-hub-layout">
          <nav className="settings-hub-nav" aria-label="Settings sections">
            {sections.map(({ id, label, icon: Icon }) => {
              const active = parentSection === id;
              const hasChildren = ["general", "notifications", "sync", "mcp", "help"].includes(id);
              return <div className="settings-nav-group" key={id}>
                <button type="button" aria-current={active && !hasChildren ? "page" : undefined} aria-expanded={hasChildren ? active : undefined} className={`settings-hub-link ${active ? "active" : ""}`} onClick={() => onSectionChange(id)}><Icon size={16} /><span>{label}</span>{hasChildren ? <ChevronDown size={13} className="settings-nav-chevron" /> : null}</button>
                {active && id === "general" ? <SettingsSubnav label="General settings" items={generalSections} value={generalSection} onChange={setGeneralSection} /> : null}
                {active && id === "notifications" ? <SettingsSubnav label="Notification pages" items={[{ id: "activity", label: "Activity" }, { id: "preferences", label: "Preferences" }]} value={notificationPage} onChange={setNotificationPage} /> : null}
                {active && id === "sync" ? <SettingsSubnav label="Sync pages" items={[{ id: "repositories", label: "Repositories" }, { id: "preferences", label: "Preferences" }]} value={syncPage} onChange={setSyncPage} /> : null}
                {active && id === "mcp" ? <SettingsSubnav label="Connection settings" items={[{ id: "mcp" as const, label: "MCP integrations" }, ...(hasRemote ? [{ id: "remote" as const, label: "Remote desktop" }] : []), { id: "ports" as const, label: "Port forwarding" }]} value={section === "remote" || section === "ports" ? section : "mcp"} onChange={(value: "mcp" | "remote" | "ports") => onSectionChange(value)} /> : null}
                {active && id === "help" ? <HelpNav value={helpTopic} onChange={setHelpTopic} /> : null}
              </div>;
            })}
          </nav>
          <div className="settings-hub-main">
            <div className="settings-hub-content">
              {shown && section === "general" ? <SettingsMenu section={generalSection} /> : null}
              {shown && section === "notifications" ? <NotificationsSettings page={notificationPage} /> : null}
              {shown && section === "setup" ? <SetupSettings /> : null}
              {shown && section === "quick-chat" ? <QuickChatSettings /> : null}
              {shown && section === "devices" ? <DevicesMenu /> : null}
              {/* The same sync instance owns the scan across navigation and closing. */}
              {syncVisited || syncRequest > 0 || (shown && section === "sync") ? <div hidden={!shown || section !== "sync"}><ProjectsMenu active={shown && section === "sync"} page={syncPage} syncRequest={syncRequest} onSyncingChange={onSyncingChange} /></div> : null}
              {portsVisited || (shown && section === "ports") ? <div hidden={!shown || section !== "ports"}><PortsMenu active={shown && section === "ports"} /></div> : null}
              {shown && section === "remote" ? <RdpMenu close={onClose} /> : null}
              {mcpVisited || (shown && section === "mcp") ? <div hidden={!shown || section !== "mcp"}><McpMenu /></div> : null}
              {shown && section === "about" ? <About /> : null}
              {shown && section === "help" ? <HelpContent topic={helpTopic} request={helpRequest} onNavigate={setHelpTopic} /> : null}
            </div>
          </div>
        </div>
      </div>
    </div>, document.body,
  );
}

function SettingsSubnav<T extends string>({ label, items, value, onChange }: {
  label: string;
  items: readonly { id: T; label: string }[];
  value: T;
  onChange: (value: T) => void;
}) {
  return <div className="settings-nav-children" role="group" aria-label={label}>
    {items.map(({ id, label: itemLabel }) => <button type="button" key={id} aria-current={value === id ? "page" : undefined} className={`settings-hub-sublink ${value === id ? "active" : ""}`} onClick={() => onChange(id)}>
      <span className="settings-hub-sublabel">{itemLabel}</span>
    </button>)}
  </div>;
}
