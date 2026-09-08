import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Info, Palette, Bell, Blocks, CircleQuestionMark, FolderSync, HardDrive, Monitor, Settings, X } from "lucide-react";
import { SettingsMenu } from "./SettingsMenu";
import { DevicesMenu } from "./DevicesMenu";
import { ProjectsMenu } from "./ProjectsMenu";
import { RdpMenu } from "./RdpMenu";
import { McpMenu } from "./McpMenu";
import { BridgeSettings } from "./BridgeSettings";
import { HelpContent } from "./HelpModal";
import { About } from "./About";
import { ThemeSettings } from "./ThemeSettings";
import { NotificationsSettings } from "./Notifications";
import "./SettingsHub.css";

const sections = [
  { id: "general", label: "General", icon: Settings, description: "Appearance, terminal behavior, voice dictation and updates." },
  { id: "themes", label: "Themes", icon: Palette, description: "Choose a palette for your app and terminals. Pzza is the original default look." },
  { id: "notifications", label: "Notifications", icon: Bell, description: "Activity history, unread notifications and alert preferences." },
  { id: "devices", label: "Devices", icon: HardDrive, description: "Manage the devices where your sessions run." },
  { id: "sync", label: "Sync & repositories", icon: FolderSync, description: "Scan project folders and follow ongoing sync operations." },
  { id: "remote", label: "Remote desktop", icon: Monitor, description: "Connect to a desktop on one of your devices." },
  { id: "mcp", label: "MCP & connections", icon: Blocks, description: "Configure app control and connections for your agents." },
  { id: "about", label: "About", icon: Info, description: "PzzaCode, the people behind it, and useful links." },
  { id: "help", label: "Help & docs", icon: CircleQuestionMark, description: "Learn the controls and find your way around." },
] as const;
export type SettingsSection = typeof sections[number]["id"];

interface Props {
  open: boolean;
  section: SettingsSection;
  onSectionChange: (section: SettingsSection) => void;
  onClose: () => void;
}

export function SettingsHub({ open, section, onSectionChange, onClose }: Props) {
  const [syncVisited, setSyncVisited] = useState(false);
  const [mcpVisited, setMcpVisited] = useState(false);
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.querySelector(".settings-hub-content")?.scrollTo({ top: 0 });
  }, [section]);
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  const current = sections.find((entry) => entry.id === section) ?? sections[0];
  useEffect(() => {
    if (open && section === "sync") setSyncVisited(true);
    if (open && section === "mcp") setMcpVisited(true);
  }, [open, section]);
  useEffect(() => {
    if (!open) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialog.current?.querySelector<HTMLElement>("[aria-current='page']")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (document.querySelector(".modal-backdrop:not(.settings-hub-backdrop)")) return;
      // Portal selectors handle their own Escape and keyboard navigation.
      if (event.target instanceof Element && event.target.closest(".pzza-portal") !== dialog.current?.parentElement) return;
      if (event.key === "Escape") { event.preventDefault(); closeRef.current(); }
      if (event.key !== "Tab") return;
      const focusable = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex="0"]') ?? [])]
        .filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    window.addEventListener("keydown", onKey);
    return () => { window.removeEventListener("keydown", onKey); previous?.focus(); };
  }, [open]);

  if (!open && !syncVisited && !mcpVisited) return null;
  return createPortal(
    <div className="modal-backdrop pzza-portal settings-hub-backdrop" hidden={!open} onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <div className="modal settings-hub" role="dialog" aria-modal="true" aria-labelledby="settings-hub-title" ref={dialog}>
        <div className="modal-head">
          <span className="modal-title" id="settings-hub-title"><Settings size={16} /> App Center</span>
          <button type="button" className="icon-btn" aria-label="Close App Center" onClick={onClose}><X size={16} /></button>
        </div>
        <div className="settings-hub-layout">
          <nav className="settings-hub-nav" aria-label="App Center sections">
            {sections.map(({ id, label, icon: Icon }) => <button type="button" key={id} aria-current={section === id ? "page" : undefined} className={`settings-hub-link ${section === id ? "active" : ""}`} onClick={() => onSectionChange(id)}><Icon size={16} /><span>{label}</span></button>)}
          </nav>
          <div className="settings-hub-main">
            <header className="settings-hub-heading"><h2>{current.label}</h2><p>{current.description}</p></header>
            <div className="settings-hub-content">
              {open && section === "general" ? <SettingsMenu close={onClose} /> : null}
              {open && section === "themes" ? <ThemeSettings /> : null}
              {open && section === "notifications" ? <NotificationsSettings /> : null}
              {open && section === "devices" ? <DevicesMenu /> : null}
              {/* The same sync instance owns the scan across navigation and closing. */}
              {syncVisited || (open && section === "sync") ? <div hidden={!open || section !== "sync"}><ProjectsMenu /></div> : null}
              {open && section === "remote" ? <RdpMenu close={onClose} /> : null}
              {mcpVisited || (open && section === "mcp") ? <div hidden={!open || section !== "mcp"}><BridgeSettings active={open && section === "mcp"} />{open && section === "mcp" ? <McpMenu /> : null}</div> : null}
              {open && section === "about" ? <About /> : null}
              {open && section === "help" ? <HelpContent /> : null}
            </div>
          </div>
        </div>
      </div>
    </div>, document.body,
  );
}
