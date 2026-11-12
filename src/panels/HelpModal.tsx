import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  ArrowDown,
  ArrowUp,
  AudioLines,
  Bell,
  BellOff,
  Blocks,
  Bot,
  Boxes,
  Check,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  CircleCheck,
  CircleQuestionMark,
  CircleX,
  ClipboardPaste,
  Columns2,
  Columns3,
  Copy,
  CornerDownLeft,
  Download,
  ExternalLink,
  Eye,
  EyeOff,
  EthernetPort,
  FileCode,
  FilePen,
  FileUp,
  Focus,
  FolderGit2,
  FolderInput,
  FolderOpen,
  FolderSync,
  FolderTree,
  Gauge,
  GitBranch,
  GitCompareArrows,
  GitMerge,
  GitPullRequest,
  GitPullRequestCreateArrow,
  HardDrive,
  Hexagon,
  History,
  Image as ImageIcon,
  Info,
  Keyboard,
  Laptop,
  Layers,
  LayoutGrid,
  Lightbulb,
  Link2,
  ListChecks,
  Loader2,
  Maximize2,
  MessageSquare,
  MessageSquarePlus,
  MessageSquareText,
  Mic,
  Monitor,
  MousePointerClick,
  MoveDiagonal2,
  Package,
  PanelLeft,
  Plus,
  Radio,
  RefreshCw,
  Regex,
  Rocket,
  RotateCcw,
  Rows2,
  Save,
  Search,
  Send,
  SendHorizontal,
  ServerCog,
  Settings as SettingsIcon,
  ShieldCheck,
  ShieldOff,
  Sparkles,
  Square,
  SquareDashed,
  SquareTerminal,
  TextSearch,
  Trash2,
  TriangleAlert,
  UsersRound,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { ListTodo, Trophy } from "lucide-react";
import { ALT_LABEL, altBadge, COMMAND_PALETTE_SHORTCUT, ctrlBadge, IS_MAC, NEW_SESSION_SHORTCUT, NEW_WORKSPACE_SHORTCUT, SEARCH_TERMINALS_SHORTCUT, TASKS_SHORTCUT } from "../shortcuts";
import { ClaudeIcon, CodexIcon } from "../icons/BrandIcons";
import { AgentIcon } from "../icons/AgentIcon";
import { SESSION_AGENTS, SESSION_PROMPT_MAX_LENGTH, defaultSessionAgentMode, type SessionAgentDefinition, type SessionAgentMode } from "../../server/lib/session-agents.js";
import { agentStartNotes, agentsByTier } from "../agentChoices";
import { SESSION_NAME_MAX_LENGTH } from "../../server/lib/session-name.js";
import { HELP_ORDER, HELP_SECTIONS, sectionOf, type HelpRequest, type HelpTopic } from "./helpTopics";
// The demos reuse these components' own classes; load their styles here too.
import "../ui/Dictation.css";
import "../tour/OnboardingTour.css";
import "../tasks/Tasks.css";

const CMD = IS_MAC ? "⌘" : "Ctrl";
const SHIFT = IS_MAC ? "⇧" : "Shift";
const CLAUDE_COLOR = "#D97757";
const CODEX_COLOR = "#10A37F";

// --- building blocks reusing the app's real classes, so the docs show the exact
// controls the user clicks --------------------------------------------------
const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

const IB = ({ icon: Icon }: { icon: LucideIcon }) => (
  <span className="icon-btn doc-ib">
    <Icon size={16} strokeWidth={1.9} />
  </span>
);

const TB = ({ icon: Icon, on, danger }: { icon: LucideIcon; on?: boolean; danger?: boolean }) => (
  <span className={`tile-btn ${on ? "tile-btn-on" : ""} ${danger ? "tile-btn-danger" : ""}`}>
    <Icon size={danger ? 14 : 13} />
  </span>
);

// One named control and what it does, on a single compact line where it fits.
function Row({ ui, name, children }: { ui: ReactNode; name: string; children: ReactNode }) {
  return (
    <div className="doc-row">
      <div className="doc-row-ui">{ui}</div>
      <div className="doc-row-body">
        <span className="doc-row-name">{name}</span> <span className="doc-row-desc">{children}</span>
      </div>
    </div>
  );
}

const P = ({ children }: { children: ReactNode }) => <p className="doc-p">{children}</p>;
const Code = ({ children }: { children: ReactNode }) => <code className="doc-code">{children}</code>;

// A framed stage that shows the exact control a page is about, larger and
// non-interactive.
const Hero = ({ children, caption }: { children: ReactNode; caption: string }) => (
  <div className="doc-hero">
    <div className="doc-hero-stage">{children}</div>
    <span className="doc-hero-cap">{caption}</span>
  </div>
);

// A numbered "how to" checklist so a page tells you what to do, not just what a
// thing is.
const Steps = ({ children }: { children: ReactNode }) => <ol className="doc-steps">{children}</ol>;
// One wrapper so mixed text and bold words flow as a paragraph inside the
// flex row next to the step number.
const Step = ({ children }: { children: ReactNode }) => <li><span>{children}</span></li>;

// A realistic, non-interactive preview of a dropdown or panel, built from the
// app's own classes, with where it lives as its caption.
const Panel = ({ children, caption, wide }: { children: ReactNode; caption: string; wide?: boolean }) => (
  <figure className="doc-panelwrap">
    <figcaption className="doc-hero-cap">{caption}</figcaption>
    <div className={`doc-panel ${wide ? "doc-panel-wide" : ""}`}>{children}</div>
  </figure>
);

const Switch = ({ on, small }: { on?: boolean; small?: boolean }) => (
  <span className={`switch ${on ? "switch-on" : ""} ${small ? "switch-sm" : ""}`}>
    <span className="switch-knob" />
  </span>
);

// A select trigger as the app draws it (Select renders a .cselect button).
const Pick = ({ icon, label, className = "" }: { icon?: ReactNode; label: string; className?: string }) => (
  <span className={`cselect ${className}`}>
    {icon}
    <span className="cselect-value">{label}</span>
    <ChevronDown size={14} className="muted-icon" />
  </span>
);

// Several states of one control side by side, each with its name under it.
const States = ({ items }: { items: { ui: ReactNode; label: string }[] }) => (
  <div className="doc-states">
    {items.map((item) => (
      <div className="doc-state" key={item.label}>
        <div className="doc-state-ui">{item.ui}</div>
        <span className="doc-state-cap">{item.label}</span>
      </div>
    ))}
  </div>
);

const ClaudeTileIcon = () => (
  <span className="tile-icon" style={{ color: CLAUDE_COLOR }}>
    <ClaudeIcon size={14} />
  </span>
);

const TileHeadDemo = ({ title = "api", shortcut = 1, selected = false, actions = true }: { title?: string; shortcut?: number; selected?: boolean; actions?: boolean }) => (
  <div className={`tile-head doc-tilehead ${selected ? "doc-tilehead-selected" : ""}`}>
    <span className="stat stat-notify" />
    <ClaudeTileIcon />
    <span className="tile-title">{title}</span>
    <kbd className="kbd tile-kbd">{ctrlBadge(shortcut)}</kbd>
    <span className="tile-device">
      <Monitor size={11} className="device-os-icon" />
      Devbox
    </span>
    <div className="tile-head-spacer" />
    {actions ? (
      <div className="tile-actions">
        <TB icon={Mic} />
        <TB icon={FileCode} />
        <TB icon={FolderInput} />
        <TB icon={Copy} />
        <TB icon={Maximize2} />
        <TB icon={EyeOff} />
        <TB icon={X} danger />
      </div>
    ) : null}
  </div>
);

// The Git part of a tile's footer in its different states.
type StripGit = "plain" | "status" | "failing" | "shared" | "worktree";
const StripGitDemo = ({ git }: { git: StripGit }) => (
  <span className="tile-strip-git">
    <span className="tile-strip-git-icon">
      <GitBranch size={11} aria-hidden="true" />
      {git === "plain" || git === "status" ? <span className="tile-strip-dirty" /> : null}
    </span>
    <span className="tile-strip-branch-btn">
      <code className="tile-strip-branch">{git === "worktree" ? "pzza/fix-login" : "main"}</code>
      {git === "status" ? <span className="tile-strip-ab"><ArrowUp size={9} strokeWidth={2.4} aria-hidden="true" />2</span> : null}
      {git === "status" ? <span className="tile-strip-ab"><ArrowDown size={9} strokeWidth={2.4} aria-hidden="true" />1</span> : null}
      {git === "status" || git === "failing" ? <span className="tile-strip-pr">
        <GitPullRequest size={10} aria-hidden="true" />42
        {git === "status"
          ? <CircleCheck size={10} className="tile-strip-check is-passing" aria-hidden="true" />
          : <CircleX size={10} className="tile-strip-check is-failing" aria-hidden="true" />}
      </span> : null}
    </span>
    {git === "failing" ? <span className="tile-strip-ci-send"><Send size={10} aria-hidden="true" /></span> : null}
    {git === "shared" ? <span className="tile-strip-shared"><TriangleAlert size={11} aria-hidden="true" /></span> : null}
    {git === "worktree" ? <span className="tile-strip-wt">
      <span className="tile-strip-wt-action"><GitPullRequestCreateArrow size={11} aria-hidden="true" /></span>
      <span className="tile-strip-wt-action"><GitMerge size={11} aria-hidden="true" /></span>
    </span> : null}
  </span>
);

// The one-line footer under every terminal.
const TileStripDemo = ({ git = "plain" }: { git?: StripGit }) => (
  <div className="tile-strip doc-tile-strip">
    <span className="tile-strip-target">api</span>
    <StripGitDemo git={git} />
    <span className="tile-strip-path">
      <span>~/…/api</span>
    </span>
    <span className="tile-strip-time">started 16:33</span>
  </div>
);

// A whole tile: header, a few terminal lines and the footer strip.
const TileDemo = ({ children, git }: { children: ReactNode; git?: StripGit }) => (
  <div className="doc-demo">
    <div className="doc-tile">
      <TileHeadDemo />
      <div className="doc-tile-body">{children}</div>
      <TileStripDemo git={git} />
    </div>
  </div>
);

const Line = ({ children }: { children: ReactNode }) => <div className="doc-term-line">{children}</div>;
const Dim = ({ children }: { children: ReactNode }) => <span className="doc-term-dim">{children}</span>;
// Text the app typed into the terminal for you.
const Typed = ({ children }: { children: ReactNode }) => <span className="doc-term-typed">{children}</span>;


const DictationMic = ({ state }: { state: "idle" | "listening" | "error" }) =>
  state === "listening" ? (
    <span className="tile-btn dictation-mic-on">
      <span className="dictation-wave">
        {[0.5, 0.85, 1, 0.85, 0.5].map((height, index) => <span key={index} style={{ transform: `scaleY(${height})` }} />)}
      </span>
      <Square size={12} />
    </span>
  ) : (
    <span className={`tile-btn ${state === "error" ? "dictation-mic-error" : ""}`}>
      <Mic size={13} />
    </span>
  );

const ToolbarBadge = ({ icon: Icon, count, chip }: { icon: LucideIcon; count?: string; chip?: ReactNode }) => (
  <span className={`icon-btn doc-ib ${chip ? "toolbar-chip" : ""}`}>
    <span className="toolbar-icon-anchor">
      <Icon size={16} strokeWidth={1.9} />
      {count ? <span className="corner-badge">{count}</span> : null}
    </span>
    {chip ? <span className="toolbar-chip-info">{chip}</span> : null}
  </span>
);

const UsageChip = () => (
  <span className="usage-chip">
    <span className="usage-chip-meter">
      <span className="usage-chip-fill" style={{ width: "38%", background: "#e0a33e" }} />
    </span>
    <span className="usage-chip-pct">38%</span>
  </span>
);

const NewSessionButton = () => (
  <span className="btn dropdown-label-btn doc-ib">
    <Plus size={15} strokeWidth={2} />
    New session
    <kbd className="kbd">{NEW_SESSION_SHORTCUT.label}</kbd>
  </span>
);

const McpDemo = () => (
  <Panel caption="Settings · Connections · MCP integrations" wide>
    <div className="settings-page mcp-settings">
      <div className="settings-row">
        <div className="settings-row-copy">
          <span>Allow app window control</span>
          <small>Control sessions, workspaces, editors, and app settings.</small>
        </div>
        <Switch on />
      </div>
      <div className="mcp-list">
        {["Claude Code", "Codex"].map((label) => (
          <div key={label} className="settings-row mcp-row">
            <div className="settings-row-copy"><span>{label}</span></div>
            <div className="settings-actions">
              <span className="btn btn-sm"><Download size={13} strokeWidth={2} /> Add</span>
              <span className="btn btn-sm"><Copy size={13} strokeWidth={2} /> Copy</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </Panel>
);

const PortsDemo = () => (
  <Panel caption="Menu bar · Port manager">
    <div className="menu-body">
      <div className="ports-tabs">
        <div className="usage-seg">
          <span className="on">Forwarded</span>
          <span>This device</span>
        </div>
      </div>
      <div className="settings-row ports-status">
        <span className="ports-route-inline">Devbox → This Mac</span>
        <span className="dot dot-up" />
        <span className="small muted ports-status-text">forwarding 2 ports</span>
        <div className="ports-status-spacer" />
      </div>
      <div className="ports-box">
        {[
          { port: 5173, name: "web", process: "node" },
          { port: 8080, name: "api", process: "docker · api-1" },
        ].map((row) => (
          <div key={row.port} className="settings-row port-row">
            <div className="port-identity">
              <span className="port-project">{row.name}</span>
              <span className="port-num">{row.port}<span className="port-state on">live</span></span>
              <span className="port-process">{row.process}</span>
            </div>
            <div className="port-actions">
              <span className="btn btn-sm"><ExternalLink size={13} /> Open</span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </Panel>
);

const UsageBar = ({ label, pct, color, reset, pin }: { label: string; pct: number; color: string; reset: string; pin: "auto" | "on" | "off" }) => (
  <div className="usage-bar-row">
    <div className="usage-bar-top">
      <span className="usage-bar-text">
        <span className="usage-bar-label">{label}</span>
        <span className="usage-bar-pct">{pct}%</span>
        <span className="usage-bar-reset">· {reset}</span>
      </span>
      <span className={`usage-pin ${pin === "on" ? "on" : ""} ${pin === "auto" ? "is-auto" : ""}`}>
        {pin === "auto" ? <span className="usage-pin-auto">Auto</span> : null}
        <span className="usage-radio" />
      </span>
    </div>
    <div className="usage-bar">
      <div className="usage-bar-fill" style={{ width: `${pct}%`, background: color }} />
    </div>
  </div>
);

const UsageCard = ({ brand, name, plan, email, children }: { brand: "claude" | "codex"; name: string; plan: string; email?: string; children: ReactNode }) => (
  <div className="usage-card">
    <div className="usage-card-head">
      <span className="usage-brand" style={{ color: brand === "claude" ? CLAUDE_COLOR : CODEX_COLOR }}>{brand === "claude" ? <ClaudeIcon size={15} /> : <CodexIcon size={15} />}</span>
      <span className="usage-name">{name}</span>
      <span className="usage-plan">{plan}</span>
      {email ? <span className="usage-email">{email}</span> : null}
    </div>
    {children}
  </div>
);

// `accounts` shows two Claude accounts side by side, each with its email.
const UsageDemo = ({ accounts }: { accounts?: boolean }) => (
  <Panel caption="Menu bar · Agent usage">
    <div className="menu-body usage-menu">
      <div className="usage-head menu-head">
        <span className="menu-head-title">Agent usage</span>
        <div className="usage-tools">
          <span className="usage-seg">
            <span className="on">Left</span>
            <span>Used</span>
          </span>
          <span className="usage-refresh"><RefreshCw size={13} /></span>
        </div>
      </div>
      {accounts ? <>
        <UsageCard brand="claude" name="Claude" plan="max 20x" email="me@example.com">
          <UsageBar label="5h" pct={38} color="#e0a33e" reset="2h 10m" pin="on" />
        </UsageCard>
        <UsageCard brand="claude" name="Claude" plan="team" email="me@work.example">
          <UsageBar label="5h" pct={12} color="#5fb37f" reset="4h 30m" pin="off" />
        </UsageCard>
      </> : <>
        <UsageCard brand="claude" name="Claude" plan="max 20x">
          <UsageBar label="5h" pct={38} color="#e0a33e" reset="2h 10m" pin="auto" />
          <UsageBar label="Weekly" pct={71} color="#5fb37f" reset="3d" pin="off" />
        </UsageCard>
        <UsageCard brand="codex" name="Codex" plan="pro">
          <UsageBar label="5h" pct={92} color="#5fb37f" reset="4h" pin="off" />
        </UsageCard>
      </>}
    </div>
  </Panel>
);

const NotificationsDemo = () => (
  <Panel caption="Menu bar · Notifications" wide>
    <div className="menu-body latest-notifications">
      <div className="notification-list">
        {[
          { title: "api finished · 12 files changed", body: "The agent stopped and its folder has uncommitted changes. Review them before you commit.", unread: true, review: true },
          { title: "web - Claude is waiting for you", body: "Do you want to make this edit to server.ts?", unread: false, review: false },
        ].map((item) => (
          <article key={item.title} className={`notification-row ${item.unread ? "unread" : ""}`}>
            <span className="notification-content">
              <span className="notification-title">
                <strong>{item.title}</strong>
                {item.unread ? <span className="notification-new">New</span> : null}
              </span>
              <span className="notification-body">{item.body}</span>
            </span>
            <div className="notification-row-actions">
              {item.review ? <span className="btn btn-sm notification-action">Review changes</span> : null}
              <span className="dismiss-btn notification-dismiss"><X size={16} /></span>
            </div>
          </article>
        ))}
      </div>
    </div>
  </Panel>
);

const DevicesDemo = () => (
  <Panel caption="Settings · Devices" wide>
    <div className="settings-page device-info-panel">
      <section className="settings-section device-list">
        {[
          { name: "This Mac", sub: "localhost", kind: "Local", local: true },
          { name: "Devbox", sub: "berke@devbox", kind: "SSH", local: false },
        ].map((device) => (
          <div key={device.name} className="managed-device">
            <div className="managed-device-header">
              <span className="managed-device-toggle">
                <ChevronRight size={14} className="muted-icon" />
                <Monitor size={15} />
                <span className="device-main">
                  <span className="device-name">
                    {device.name}
                    {device.local ? <span className="device-tag">current</span> : null}
                  </span>
                  <span className="device-sub">{device.sub}</span>
                </span>
                <span className="managed-device-kind">{device.kind}</span>
              </span>
              {device.local ? null : <Switch on small />}
              {device.local ? null : <span className="icon-btn icon-btn-danger"><Trash2 size={14} /></span>}
            </div>
          </div>
        ))}
      </section>
      <div className="settings-actions">
        <span className="btn btn-sm"><Plus size={14} strokeWidth={2.2} /> Add device</span>
        <span className="btn btn-sm"><ServerCog size={14} strokeWidth={2} /> Install agent over SSH</span>
      </div>
    </div>
  </Panel>
);

const LayoutDemo = () => (
  <Panel caption="Workspace menu · Layout">
    <div className="menu-body">
      <div className="field">
        <span className="field-label">Layout</span>
        <div className="usage-seg ws-columns">
          {["Auto", "2", "3", "4"].map((label) => <button key={label} type="button" tabIndex={-1} aria-hidden="true" className={label === "3" ? "on" : ""}>{label}</button>)}
        </div>
      </div>
    </div>
  </Panel>
);

const RdpDemo = () => (
  <Panel caption="Settings · Connections · Remote desktop" wide>
    <div className="settings-page">
      <div className="settings-field"><span>Remote server</span><Pick icon={<Monitor size={13} />} label="Devbox" /></div>
      <div className="settings-actions"><span className="btn btn-sm"><Monitor size={14} /> Open desktop</span><span className="set-hint">SSH-tunneled RDP</span></div>
    </div>
  </Panel>
);

// The new-session form as it opens from the top bar, with Claude Code chosen.
const NewSessionDemo = () => (
  <Panel caption="Menu bar · New session" wide>
    <div className="menu-body new-session-form">
      <div className="ns-composer has-prompt">
        <div className="ns-composer-line">
          <SquareTerminal size={16} className="muted-icon" />
          <span className="ns-input">api-tests</span>
          <span className="btn btn-accent ns-create">Create <CornerDownLeft size={12} strokeWidth={2.2} /></span>
        </div>
        <div className="ns-prompt doc-ns-placeholder">First prompt for Claude Code (optional)…</div>
      </div>
      <AgentPills />
    </div>
  </Panel>
);

// The device | folder | agent bar and the agent's options, as in the form.
const AgentPills = () => (
  <>
    <div className="ns-seg">
      <Pick className="ns-pill" icon={<Monitor size={13} />} label="Devbox" />
      <span className="ns-pill-path has-value">
        <span className="path-field ns-pill">
          <FolderOpen size={13} className="path-field-icon" />
          <span className="path-field-value">~/api</span>
        </span>
        <span className="ns-clear"><X size={11} /></span>
      </span>
      <Pick className="ns-pill" icon={<AgentIcon id="claude" size={13} />} label="Claude Code" />
    </div>
    <AgentOptions />
  </>
);

// The chosen agent's mode and start options.
const AgentOptions = () => (
  <div className="ns-seg ns-seg-extra">
    <Pick className="ns-pill ns-mode" icon={<FilePen size={13} />} label="Accept edits" />
    <span className="ns-toggle"><History size={12} /> Continue</span>
    <span className="ns-toggle on"><GitBranch size={12} /> Worktree</span>
  </div>
);

const SnapshotRow = ({ name, meta, on }: { name: string; meta: string; on?: boolean }) => (
  <div className="snap-row">
    <div className="snap-row-copy">
      <span className="snap-name">{name}</span>
      <span className="snap-meta">{meta}</span>
    </div>
    <span className={`snap-icon ${on ? "is-on" : ""}`}><RotateCcw size={14} /></span>
    <span className="snap-icon"><Copy size={14} /></span>
    <span className="snap-icon"><Trash2 size={14} /></span>
  </div>
);

const SnapshotDemo = () => (
  <Panel caption="Workspace settings · Snapshots">
    <div className="menu-body">
      <div className="field snap-section">
        <div className="snap-body">
          <div className="snap-actions">
            <span className="btn btn-sm"><Save size={13} strokeWidth={2} /> Save current</span>
            <span className="btn btn-sm"><ClipboardPaste size={13} /> Paste snapshot</span>
          </div>
          <div className="snap-list">
            <div className="snap-item"><SnapshotRow name="Release week" meta="3 sessions · Nov 6" /></div>
            <div className="snap-item"><SnapshotRow name="Auto-saved" meta="Auto · 4 sessions · Nov 8, 16:40" /></div>
          </div>
        </div>
      </div>
    </div>
  </Panel>
);

const RestoreDemo = () => (
  <Panel caption="Snapshots · Restore preview">
    <div className="menu-body">
      <div className="snap-list">
        <div className="snap-item">
          <SnapshotRow name="Release week" meta="3 sessions · Nov 6" on />
          <div className="snap-preview">
            {[
              { name: "api", status: "start", label: "Will start", can: true },
              { name: "web", status: "resume", label: "Agent restarts", can: true },
              { name: "logs", status: "running", label: "Running", can: false },
            ].map((entry) => (
              <label key={entry.name} className={`snap-preview-row ${entry.can ? "" : "is-off"}`}>
                <input type="checkbox" defaultChecked={entry.can} disabled={!entry.can} tabIndex={-1} />
                <span className="snap-preview-name">{entry.name}</span>
                <span className={`snap-preview-status is-${entry.status}`}>{entry.label}</span>
              </label>
            ))}
            <label className="snap-preview-option">
              <input type="checkbox" defaultChecked tabIndex={-1} />
              Continue agent conversations
            </label>
            <div className="snap-preview-actions">
              <span className="btn btn-sm">Cancel</span>
              <span className="btn btn-sm"><RotateCcw size={13} /> Restore 2</span>
            </div>
          </div>
        </div>
      </div>
    </div>
  </Panel>
);

const SetupDemo = () => (
  <Panel caption="First launch · What PzzaCode runs on" wide>
    <div className="tour-stack">
      <ul className="tour-list">
        {[
          { Icon: Hexagon, label: "Node.js", detail: "v22.11.0", pill: "ok", text: "Ready" },
          { Icon: SquareTerminal, label: "tmux", detail: "Keeps terminals running after you quit", pill: "busy", text: "Installing" },
        ].map(({ Icon, label, detail, pill, text }) => (
          <li key={label} className="tour-row">
            <span className="tour-row-icon"><Icon size={15} strokeWidth={1.9} /></span>
            <div className="tour-row-copy">
              <span className="tour-row-label">{label}</span>
              <span className="tour-row-detail">{detail}</span>
            </div>
            <div className="tour-row-side">
              <span className={`tour-pill tour-pill-${pill}`}>{pill === "busy" ? <Loader2 size={11} className="sw-spin" /> : null}{text}</span>
            </div>
          </li>
        ))}
      </ul>
      <section className="tour-group">
        <div className="tour-group-head">
          <span className="tour-group-title">Coding agents</span>
          <span className="tour-group-meta">optional · 2 of {SESSION_AGENTS.length} installed</span>
        </div>
        <div className="tour-chips">
          {SESSION_AGENTS.slice(0, 2).map((agent) => (
            <span key={agent.id} className="tour-chip is-found">
              <Check size={11} /><AgentIcon id={agent.id} size={12} />{agent.label}
              <span className="tour-chip-state">found</span>
            </span>
          ))}
        </div>
        <details className="tour-agent-missing"><summary>Not installed ({SESSION_AGENTS.length - 2})</summary></details>
      </section>
    </div>
  </Panel>
);

// Settings → Setup, one row per group with its state.
const SetupGroupsDemo = () => (
  <Panel caption="Settings · Setup" wide>
    <div className="setup-settings-groups">
      {[
        { Icon: Package, title: "Tools PzzaCode runs on", state: "Installed", tone: "ok" },
        { Icon: ShieldCheck, title: "PzzaCode permissions", state: "5 of 5 allowed", tone: "ok" },
        { Icon: ShieldCheck, title: "tmux permissions", state: "2 of 3 allowed", tone: "action" },
      ].map(({ Icon, title, state, tone }) => (
        <section key={title} className="setup-settings-group">
          <span className="setup-settings-head">
            <Icon size={15} className="setup-settings-icon" aria-hidden="true" />
            <span className="setup-settings-title">{title}</span>
            <span className={`setup-settings-state is-${tone}`}>{state}</span>
            <ChevronRight size={14} className="setup-settings-chevron" aria-hidden="true" />
          </span>
        </section>
      ))}
    </div>
  </Panel>
);

const BroadcastDemo = () => (
  <div className="doc-demo doc-stack">
    <TileHeadDemo title="api" shortcut={1} selected actions={false} />
    <TileHeadDemo title="web" shortcut={2} selected actions={false} />
    <div className="broadcast-bar doc-broadcast">
      <div className="broadcast-head">
        <span className="broadcast-title"><Radio size={14} className="broadcast-icon" />Broadcast</span>
        <span className="broadcast-targets">
          <span className="broadcast-chip"><AgentIcon id="claude" size={12} /><span className="broadcast-chip-name">api</span><span className="broadcast-chip-remove"><X size={11} /></span></span>
          <span className="broadcast-chip"><AgentIcon id="codex" size={12} /><span className="broadcast-chip-name">web</span><span className="broadcast-chip-remove"><X size={11} /></span></span>
        </span>
        <span className="tile-btn broadcast-close"><X size={14} /></span>
      </div>
      <div className="broadcast-compose">
        <span className="broadcast-prompts"><span className="tile-btn"><MessageSquareText size={14} /></span></span>
        <span className="broadcast-input doc-broadcast-input">Run the tests and fix what fails</span>
        <span className="tile-btn broadcast-send"><SendHorizontal size={15} /></span>
      </div>
    </div>
  </div>
);

const CodeBarDemo = () => (
  <div className="doc-demo">
    <div className="tile-code-bar doc-codebar">
      <TB icon={PanelLeft} on />
      <div className="code-file-tab">
        <span className="tile-code-name">server.ts</span>
        <span className="code-dirty" />
        <span className="tile-btn code-file-tab-save"><Save size={12} /></span>
        <span className="tile-btn code-file-tab-close"><X size={12} /></span>
      </div>
      <div className="tile-head-spacer" />
      <TB icon={Columns2} />
      <TB icon={Maximize2} />
      <TB icon={X} />
    </div>
  </div>
);

const WorkspaceTabsDemo = () => (
  <div className="doc-demo">
    <div className="doc-tabs">
      <span className="ws-tab">
        <span className="ws-tab-icon-anchor"><LayoutGrid size={13} className="ws-tab-icon" /></span>
        <span className="ws-tab-name">All</span>
        <kbd className="kbd ws-kbd">{altBadge(0)}</kbd>
      </span>
      <span className="ws-tab ws-tab-active">
        <span className="ws-tab-icon-anchor"><Layers size={13} className="ws-tab-icon" style={{ color: "#7aa2f7" }} /></span>
        <span className="ws-tab-name">Main</span>
        <kbd className="kbd ws-kbd">{altBadge(1)}</kbd>
      </span>
      <span className="ws-tab">
        <span className="ws-tab-icon-anchor">
          <Rocket size={13} className="ws-tab-icon" style={{ color: "#e0a33e" }} />
          <span className="corner-badge ws-tab-count">2</span>
        </span>
        <span className="ws-tab-name">Release</span>
        <kbd className="kbd ws-kbd">{altBadge(2)}</kbd>
      </span>
      <span className="ws-tab-add-demo">+</span>
    </div>
  </div>
);

// Four tiles at a given gap, to compare spacing values at a glance.
const MiniGrid = ({ gap }: { gap: number }) => (
  <span className={`doc-minigrid ${gap === 0 ? "is-joined" : ""}`} style={{ gap, padding: gap }}>
    {[0, 1, 2, 3].map((tile) => <span key={tile} />)}
  </span>
);

// The command palette with a query typed, built from its own classes.
const PaletteRow = ({ icon: Icon, label, detail, shortcut, active }: { icon: LucideIcon; label: string; detail?: string; shortcut?: string; active?: boolean }) => (
  <div className={`cmdk-row ${active ? "cmdk-row-active" : ""}`}>
    <Icon size={15} className="cmdk-row-icon" />
    <span className="cmdk-row-label">{label}</span>
    <span className="cmdk-row-detail">{detail}</span>
    {shortcut ? <kbd className="kbd">{shortcut}</kbd> : null}
  </div>
);

const PaletteDemo = () => (
  <div className="doc-demo doc-dialog-demo">
    <div className="cmdk">
      <div className="cmdk-search">
        <Search size={16} strokeWidth={1.9} aria-hidden="true" />
        <span className="cmdk-input">work</span>
        <kbd className="kbd">{COMMAND_PALETTE_SHORTCUT.label}</kbd>
      </div>
      <div className="cmdk-list">
        <div className="cmdk-group">
          <div className="cmdk-group-title">Workspaces</div>
          <PaletteRow icon={Rocket} label="Release" detail="2 sessions" shortcut={altBadge(2)} active />
        </div>
        <div className="cmdk-group">
          <div className="cmdk-group-title">Actions</div>
          <PaletteRow icon={Plus} label="New workspace" shortcut={NEW_WORKSPACE_SHORTCUT.label} />
        </div>
        <div className="cmdk-group">
          <div className="cmdk-group-title">Help</div>
          <PaletteRow icon={FolderGit2} label="Worktrees" detail="Git & review" />
        </div>
      </div>
    </div>
  </div>
);

const SearchDemo = () => (
  <div className="doc-demo doc-dialog-demo">
    <div className="cmdk term-search">
      <div className="cmdk-search">
        <TextSearch size={16} strokeWidth={1.9} aria-hidden="true" />
        <span className="cmdk-input">ECONNREFUSED</span>
        <span className="tile-btn"><Regex size={14} aria-hidden="true" /></span>
        <kbd className="kbd">{SEARCH_TERMINALS_SHORTCUT.label}</kbd>
      </div>
      <div className="cmdk-list term-search-list">
        {[
          { tile: "api", line: 214, before: "> node server.js", text: "Error: connect ECONNREFUSED 127.0.0.1:5432", active: true },
          { tile: "worker", line: 88, before: "retrying queue connection", text: "redis ECONNREFUSED 127.0.0.1:6379", active: false },
        ].map((match) => (
          <div className="cmdk-group" key={match.tile}>
            <div className="cmdk-group-title term-search-group"><span>{match.tile}</span><span>1</span></div>
            <div className={`cmdk-row term-search-row ${match.active ? "cmdk-row-active" : ""}`}>
              <span className="term-search-number">{match.line}</span>
              <span className="term-search-context">
                <span className="term-search-near">{match.before}</span>
                <span className="term-search-line">{match.text.slice(0, match.text.indexOf("ECONNREFUSED"))}<mark>ECONNREFUSED</mark>{match.text.slice(match.text.indexOf("ECONNREFUSED") + 12)}</span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </div>
);

// A terminal with its find bar open.
const FindDemo = () => (
  <div className="doc-demo">
    <div className="doc-tile">
      <div className="doc-tile-body doc-find-body">
        <Line><Dim>✓</Dim> 212 tests passed</Line>
        <Line><Dim>✗</Dim> 1 <span className="doc-term-match">failed</span>: session API › rejects long names</Line>
        <Line><Dim>›</Dim> Fix the one that <span className="doc-term-match is-active">failed</span></Line>
        <div className="term-find-bar">
          <span className="term-find-input">failed</span>
          <span className="tile-btn"><span className="term-find-aa">Aa</span></span>
          <span className="tile-btn"><ChevronDown size={13} /></span>
          <span className="term-find-count">2 / 2</span>
          <span className="tile-btn"><X size={13} /></span>
        </div>
      </div>
    </div>
  </div>
);

// The editor's sidebar on Changes next to one file's diff.
const ChangesDemo = () => (
  <div className="doc-demo doc-changes">
    <div className="doc-changes-side">
      <div className="code-changes-switch">
        <span className="code-changes-tab"><FolderTree size={13} aria-hidden="true" /><span className="code-changes-label">Files</span></span>
        <span className="code-changes-tab on"><GitCompareArrows size={13} aria-hidden="true" /><span className="code-changes-label">Changes</span><span className="code-changes-count">3</span></span>
      </div>
      <div className="code-changes-list">
        {[
          { status: "modified", letter: "M", name: "server.ts", dir: "src", on: true },
          { status: "untracked", letter: "U", name: "limits.ts", dir: "src" },
          { status: "deleted", letter: "D", name: "old-api.md", dir: "docs" },
        ].map((file) => (
          <span key={file.name} className={`ft-row code-changes-row ${file.on ? "on" : ""}`}>
            <span className={`code-changes-status code-changes-status-${file.status}`}>{file.letter}</span>
            <span className="ft-name"><span className="code-changes-name">{file.name}</span><span className="code-changes-dir">{file.dir}</span></span>
          </span>
        ))}
      </div>
    </div>
    <div className="doc-changes-main">
      <div className="code-diff-bar">
        <span className="code-diff-legend"><span className="code-diff-legend-del">− removed</span><span className="code-diff-legend-add">+ added</span></span>
        <span className="code-diff-mode">
          <span className="on"><Rows2 size={12} aria-hidden="true" /><span className="code-diff-mode-label">Unified</span></span>
          <span><Columns2 size={12} aria-hidden="true" /><span className="code-diff-mode-label">Split</span></span>
        </span>
      </div>
      <div className="doc-tile-body">
        <Line><Dim>  </Dim>if (name.length &gt; MAX) {"{"}</Line>
        <Line><span className="doc-diff-del">−   throw new Error("long");</span></Line>
        <Line><span className="doc-diff-add">+   return reject(res, 400);</span></Line>
        <Line><Dim>  </Dim>{"}"}</Line>
      </div>
    </div>
  </div>
);

// A diff with lines selected, the question box open and a pending review.
const ReviewDemo = () => (
  <div className="doc-demo">
    <div className="code-diff code-diff-unified doc-review">
      <div className="code-diff-bar">
        <span className="code-diff-legend"><span className="code-diff-legend-del">− removed</span><span className="code-diff-legend-add">+ added</span></span>
        <span className="btn btn-sm code-diff-ask-btn"><MessageSquare size={12} aria-hidden="true" />Ask agent</span>
        <span className="btn btn-sm code-diff-ask-btn"><MessageSquarePlus size={12} aria-hidden="true" />Add comment</span>
        <span className="code-diff-review">
          <span className="code-diff-review-count">2 comments</span>
          <span className="code-diff-review-dot">·</span>
          <span className="btn btn-sm code-diff-ask-btn"><Send size={12} aria-hidden="true" />Send review</span>
        </span>
      </div>
      <div className="code-diff-ask">
        <span className="code-diff-ask-target">lines 14-15</span>
        <span className="doc-review-input">Why return 400 instead of 422 here?</span>
      </div>
      <div className="doc-tile-body">
        <Line><span className="doc-diff-add doc-diff-picked">+   if (name.length &gt; MAX)</span></Line>
        <Line><span className="doc-diff-add doc-diff-picked">+     return reject(res, 400);</span></Line>
      </div>
    </div>
  </div>
);

// Workspace settings → Worktrees with one merged and one open worktree.

// The Tasks dropdown's list, built from its own classes, non-interactive.
const TasksDemo = () => (
  <Panel caption="Menu bar · Tasks">
    <div className="menu-body tasks-panel doc-tasks-menu">
      <div className="usage-head menu-head tasks-head">
        <span className="menu-head-title">Tasks</span>
        <div className="usage-tools">
          <span className="perm-waiting-count"><span className="usage-dot task-tone-needs-you" />1 needs you</span>
          <span className="usage-refresh"><Plus size={15} /></span>
        </div>
      </div>
      <div className="tasks-sections">
        {([
          ["needs-you", "Needs you", "Add rate limiting to checkout", ["claude", "codex", "gemini"], "Approval needed", null, "2m"],
        ] as const).map(([tone, section, title, agents, reason, stats, ago]) => (
          <div key={tone} className="usage-others tasks-section">
            <div className="usage-section-title"><span>{section}</span><span className="usage-section-note">1</span></div>
            <div className="usage-agent">
              <span className={`task-row task-tone-${tone}`}>
                <span className="usage-agent-head"><span className={`usage-dot task-tone-${tone}`} /><span className="usage-agent-name">{title}</span><span className="usage-agent-total muted">{ago}</span></span>
                <span className="task-row-meta">
                  <span className="task-agents">{agents.map((id) => <span key={id} className="usage-brand"><AgentIcon id={id} size={12} /></span>)}</span>
                  {stats ? <span className="task-diffstat"><span className="task-add">+{stats[0]}</span><span className="task-del">−{stats[1]}</span></span> : <span className="task-row-reason">{reason}</span>}
                </span>
              </span>
            </div>
          </div>
        ))}
      </div>
    </div>
  </Panel>
);

// The new-task form in Chain mode: the mode switch and the editable steps.
const TaskModesDemo = () => (
  <Panel caption="Menu bar · Tasks · New task">
    <div className="menu-body tasks-panel doc-tasks-menu">
      <div className="new-session-form task-form">
        <div className="usage-seg task-mode-seg">
          {["One", "Parallel", "Chain", "Race"].map((mode) => <span key={mode} className={mode === "Chain" ? "on" : ""}>{mode}</span>)}
        </div>
        {([["Plan", "claude", "Claude Code"], ["Build", "codex", "Codex"], ["Review", "gemini", "Gemini CLI"]] as const).map(([role, id, name]) => (
          <div key={role} className="ns-seg ns-seg-extra task-agent-seg">
            <Pick label={role} className="ns-pill task-step-role" />
            <Pick icon={<AgentIcon id={id} size={13} />} label={name} className="ns-pill task-agent-pick" />
          </div>
        ))}
      </div>
    </div>
  </Panel>
);

const WorktreesDemo = () => (
  <Panel caption="Workspace settings · Worktrees" wide>
    <div className="menu-body">
      <div className="field snap-section">
        <div className="snap-body">
          <div className="snap-actions"><span className="btn btn-sm"><Trash2 size={13} /> Clean up 1 merged</span></div>
          <div className="snap-list">
            <span className="wt-setup-head"><ChevronRight size={12} className="snap-chevron" aria-hidden="true" />Setup for new worktrees</span>
            {[
              { branch: "pzza/fix-login", meta: "Squash-merged into main · ~/api.worktrees/fix-login", merged: true },
              { branch: "pzza/api-tests", meta: "Not merged · ~/api.worktrees/api-tests", merged: false },
            ].map((worktree) => (
              <div key={worktree.branch} className="snap-row">
                <div className="snap-row-copy">
                  <span className="snap-name wt-branch">{worktree.branch}</span>
                  <span className="snap-meta"><span className={worktree.merged ? "wt-merged" : undefined}>{worktree.meta}</span></span>
                </div>
                <span className="snap-icon"><GitPullRequestCreateArrow size={14} /></span>
                <span className="snap-icon"><GitMerge size={14} /></span>
                <span className="snap-icon"><Trash2 size={14} /></span>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  </Panel>
);

const QuickChatDemo = () => (
  <Panel caption="Menu bar · Quick Chat" wide>
    <div className="doc-quickchat">
      <div className="quick-chat-header">
        <div><span className="menu-head-title">Quick Chat</span><span className="muted">This Mac · Claude</span></div>
        <div className="quick-chat-actions"><span className="icon-btn"><X size={15} /></span></div>
      </div>
      <div className="doc-tile-body">
        <Line><Dim>›</Dim> What does git rebase --onto do?</Line>
        <Line><Dim>⏺</Dim> It replays a range of commits onto a new base…</Line>
      </div>
      <div className="quick-chat-footer"><span className="muted">Connected. Hiding keeps your chat running.</span></div>
    </div>
  </Panel>
);

const SyncDemo = () => (
  <Panel caption="Settings · Sync · Repositories" wide>
    <div className="settings-page">
      {[
        { name: "api", detail: "This Mac, Devbox · development", on: true },
        { name: "web", detail: "This Mac, Devbox · main", on: true },
        { name: "notes", detail: "This Mac", on: false },
      ].map((repo) => (
        <div key={repo.name} className="settings-row">
          <div className="settings-row-copy"><span>{repo.name}</span><small>{repo.detail}</small></div>
          <Switch on={repo.on} small />
        </div>
      ))}
    </div>
  </Panel>
);

const LanguagesDemo = () => (
  <Panel caption="Settings · General · Dictation" wide>
    <div className="settings-page">
      <div className="settings-row"><div className="settings-row-copy"><span>Recognition language</span></div><Pick label="Auto-detect" /></div>
      <div className="settings-row"><div className="settings-row-copy"><span>My languages</span><small>English (main), Turkish</small></div></div>
      <div className="settings-row"><div className="settings-row-copy"><span>Microphone input</span></div><Pick label="MacBook Pro Microphone" /></div>
    </div>
  </Panel>
);

const APPROVAL_ICONS: Record<SessionAgentMode["approval"], LucideIcon> = { ask: ShieldCheck, restricted: Eye, auto: Sparkles, bypass: ShieldOff };

// The agents shown before the rest of the catalog is unfolded.
const FEATURED_AGENTS = 4;

const AgentModeRows = ({ agents }: { agents: readonly SessionAgentDefinition[] }) => (
  <table className="doc-keys doc-modes">
    <tbody>
      {agents.map((agent) => {
        const modes = [defaultSessionAgentMode(agent), ...agent.modes.filter((mode) => mode.id !== agent.defaultMode)];
        return (
          <tr key={agent.id}>
            <td><span className="doc-inline"><AgentIcon id={agent.id} size={13} /> {agent.label}</span></td>
            <td>
              {modes.map((mode, index) => {
                const ModeIcon = APPROVAL_ICONS[mode.approval];
                return (
                  <span key={mode.id} className={`doc-inline ${mode.approval === "bypass" ? "doc-danger" : ""}`} title={mode.description}>
                    {index > 0 ? " · " : null}<ModeIcon size={12} /> {index === 0 ? <b>{mode.label}</b> : mode.label}
                  </span>
                );
              })}
            </td>
            <td>{agentStartNotes(agent)}</td>
          </tr>
        );
      })}
    </tbody>
  </table>
);

// Each agent's permission modes, read from the same catalog the form uses.
// The default mode comes first; red modes never ask. The long tail of the
// catalog folds away so the page stays one focused screen.
const AgentModes = () => {
  const agents = agentsByTier();
  const rest = agents.slice(FEATURED_AGENTS);
  return (
    <>
      <AgentModeRows agents={agents.slice(0, FEATURED_AGENTS)} />
      {rest.length ? (
        <details className="doc-more">
          <summary>{rest.length} more agents</summary>
          <AgentModeRows agents={rest} />
        </details>
      ) : null}
    </>
  );
};

// One focused page: what you can do and why (blurb), a demo, the steps and
// details, then a couple of tips.
interface HelpPage {
  label: string;
  blurb: string;
  icon: LucideIcon;
  demo: ReactNode;
  body: ReactNode;
  tips?: ReactNode[];
}

export const HELP_PAGES: Record<HelpTopic, HelpPage> = {
  // --- Getting started -------------------------------------------------------
  start: {
    label: "Overview",
    blurb: "Run every terminal and coding agent side by side, on all your machines, and pick up exactly where you left off.",
    icon: Rocket,
    demo: (
      <TileDemo>
        <Line><Dim>›</Dim> Add tests for the session API</Line>
        <Line><Dim>⏺</Dim> Wrote 14 tests in <span className="doc-term-path">~/api/test/session.test.ts</span></Line>
      </TileDemo>
    ),
    body: (
      <>
        <div className="help-tour-banner">
          <Sparkles size={15} />
          <div><strong>New here?</strong><span>Take the tour of every control, or run setup again.</span></div>
          <span className="help-tour-actions">
            <button type="button" className="btn btn-sm" onClick={() => window.dispatchEvent(new Event("pzza:start-setup"))}>Run setup</button>
            <button type="button" className="btn btn-sm" onClick={() => window.dispatchEvent(new Event("pzza:start-tour"))}>Start tour</button>
          </span>
        </div>
        <Steps>
          <Step>Press <b>New session</b> (<Kbd>{NEW_SESSION_SHORTCUT.label}</Kbd>), name it, and pick the device, the folder and a terminal or an agent.</Step>
          <Step>Press <Kbd>Enter</Kbd>. Hop between tiles with <Kbd>{ctrlBadge(1)}</Kbd>–<Kbd>{ctrlBadge(9)}</Kbd>.</Step>
          <Step>Quit whenever: tiles run in <b>tmux</b> on their device, so closing the app or losing the connection only detaches your view.</Step>
        </Steps>
      </>
    ),
    tips: [
      <>Press <Kbd>{COMMAND_PALETTE_SHORTCUT.label}</Kbd> to find any action, session or help page.</>,
      <><b>Next</b> at the bottom of every page walks the whole guide in order.</>,
    ],
  },
  setup: {
    label: "Setup & tour",
    blurb: "A short first-launch setup gets tools and permissions in place, then a guided tour shows every control where it lives.",
    icon: ListChecks,
    demo: <SetupDemo />,
    body: (
      <Steps>
        <Step><b>What PzzaCode runs on</b>: Node.js and tmux install themselves with Homebrew; <b>Install Homebrew</b> opens Terminal for your password.</Step>
        <Step><b>Privacy permissions</b> (Mac), once tmux is installed: each <b>Allow</b> shows the macOS prompt or opens the right page in System Settings.</Step>
        <Step><b>Finish setup</b> starts the tour the first time; <Kbd>Esc</Kbd> skips it.</Step>
      </Steps>
    ),
    tips: [
      <>Replay either from the Overview page or with <b>Start the tour</b> / <b>Run setup</b> in <Kbd>{COMMAND_PALETTE_SHORTCUT.label}</Kbd>.</>,
    ],
  },
  permissions: {
    label: "Permissions & tools",
    blurb: "Settings → Setup shows at a glance whether this machine has every permission and tool PzzaCode needs, and fixes what is missing.",
    icon: Wrench,
    demo: <SetupGroupsDemo />,
    body: (
      <>
        <Row ui={<Package size={15} className="muted-icon" />} name="Tools">
          Homebrew, Node.js, tmux.
        </Row>
        <Row ui={<ShieldCheck size={15} className="muted-icon" />} name="PzzaCode permissions">
          Full Disk Access, Microphone, Screen Recording, Accessibility, Automation (Mac).
        </Row>
        <Row ui={<ShieldCheck size={15} className="muted-icon" />} name="tmux permissions">
          tmux runs your terminals and needs three of them too: drag it from Finder into the list. They wait until tmux is installed.
        </Row>
        <Row ui={<Laptop size={15} className="muted-icon" />} name="This device">
          Agent, storage and terminal backend.
        </Row>
      </>
    ),
    tips: [
      <>A group that needs you opens on its own. Full Disk Access and Screen Recording apply after a restart.</>,
    ],
  },
  topbar: {
    label: "The menu bar",
    blurb: "Every tool sits one click away above the grid, so you rarely need a menu.",
    icon: LayoutGrid,
    demo: (
      <Hero caption="Menu bar · tools (right side)">
        <span className="doc-hero-cluster">
          <IB icon={LayoutGrid} />
          <IB icon={MessageSquare} />
          <IB icon={FolderSync} />
          <IB icon={Monitor} />
          <ToolbarBadge icon={EthernetPort} count="2" />
          <ToolbarBadge icon={Gauge} chip={<UsageChip />} />
          <ToolbarBadge icon={Bell} count="3" />
          <IB icon={SettingsIcon} />
          <NewSessionButton />
        </span>
      </Hero>
    ),
    body: (
      <>
        <Row ui={<IB icon={MessageSquare} />} name="Quick Chat">A dropdown chat with your agent.</Row>
        <Row ui={<IB icon={FolderSync} />} name="Sync projects">With a remote device: align repositories.</Row>
        <Row ui={<IB icon={Monitor} />} name="Remote desktop">With a remote device: its Linux desktop.</Row>
        <Row ui={<ToolbarBadge icon={EthernetPort} count="2" />} name="Port manager">Forwarded and local ports.</Row>
        <Row ui={<IB icon={Gauge} />} name="Agent usage">Live limits and spend.</Row>
        <Row ui={<ToolbarBadge icon={Bell} count="3" />} name="Notifications">The latest activity.</Row>
      </>
    ),
    tips: [
      <>Hover any icon for its name; in a narrow window the tools fold behind <b>Tools</b>.</>,
    ],
  },
  "new-session": {
    label: "New session",
    blurb: "Start a shell or a coding agent in any folder on any device from one compact form, with a first prompt if you like.",
    icon: Plus,
    demo: <NewSessionDemo />,
    body: (
      <>
        <Steps>
          <Step>Press <b>New session</b> or <Kbd>{NEW_SESSION_SHORTCUT.label}</Kbd> and type a name (up to {SESSION_NAME_MAX_LENGTH} characters).</Step>
          <Step>Pick the <b>device</b>, the <b>folder</b> (home when empty) and <b>Terminal</b> or an agent.</Step>
          <Step>Optionally add a <b>first prompt</b> (one line, up to {SESSION_PROMPT_MAX_LENGTH} characters), then press <Kbd>Enter</Kbd>.</Step>
        </Steps>
        <P><b>Recent</b> offers recent folders in one click, with the agent and mode you last used there.</P>
      </>
    ),
    tips: [
      <>Drop a folder from Finder onto the canvas, not a terminal, to open this form for it.</>,
      <><b>Open a terminal</b> below the form attaches tmux windows that are not on the grid yet.</>,
    ],
  },
  agents: {
    label: "Agents & modes",
    blurb: "Pick the agent and how much it may do without asking, before it starts.",
    icon: Bot,
    demo: (
      <Panel caption="New session · agent options" wide><div className="menu-body new-session-form"><AgentOptions /></div></Panel>
    ),
    body: (
      <>
        <P>Each agent starts in its bold mode unless you pick another. That mode asks before changes, or cannot make any for agents that never ask. The mode list is hidden for agents with only one mode, and the prompt box for agents that take no starting prompt.</P>
        <AgentModes />
      </>
    ),
    tips: [
      <><b>Continue</b> resumes the last conversation; red modes never ask.</>,
      <>Install agents yourself: <b>Settings → Setup</b> lists the install command for each one that is missing.</>,
    ],
  },
  palette: {
    label: "Command palette",
    blurb: "Do anything from the keyboard: jump to a session or workspace, run an action, start in a recent folder or open help.",
    icon: Search,
    demo: <PaletteDemo />,
    body: (
      <Steps>
        <Step>Press <Kbd>{COMMAND_PALETTE_SHORTCUT.label}</Kbd>{IS_MAC ? ", even while typing in a terminal" : ""}.</Step>
        <Step>Type a few letters; matches are fuzzy, so <b>work</b> finds workspaces and Worktrees.</Step>
        <Step>Arrow keys move, <Kbd>Enter</Kbd> runs, <Kbd>Esc</Kbd> closes.</Step>
      </Steps>
    ),
    tips: [
      <>Actions follow the active tile: maximize, open its editor, show changes, duplicate, hide, or send a saved prompt.</>,
      ...(IS_MAC ? [] : [<>A focused terminal keeps Ctrl K for the shell; click outside it first.</>]),
    ],
  },
  settings: {
    label: "Settings map",
    blurb: "Find any preference fast: Settings keeps everything in a handful of sections.",
    icon: SettingsIcon,
    demo: (
      <Hero caption={`Menu bar · Settings · ${CMD} ,`}>
        <IB icon={SettingsIcon} />
      </Hero>
    ),
    body: (
      <>
        <Row ui={<IB icon={SettingsIcon} />} name="General">Appearance (theme, grayscale, spacing, transparency), Terminal, Saved prompts{IS_MAC ? " and Dictation" : ""}.</Row>
        <Row ui={<IB icon={Bell} />} name="Notifications">Activity history and alert preferences.</Row>
        <Row ui={<IB icon={Wrench} />} name="Setup">Permissions, tools and this device's health.</Row>
        <Row ui={<IB icon={MessageSquare} />} name="Quick Chat">The agent and device it uses.</Row>
        <Row ui={<IB icon={HardDrive} />} name="Devices">Your machines and their sessions.</Row>
        <Row ui={<IB icon={FolderSync} />} name="Sync">Repositories and sync preferences.</Row>
        <Row ui={<IB icon={Blocks} />} name="Connections">MCP, remote desktop, port forwarding.</Row>
        <Row ui={<IB icon={Info} />} name="About">Version and updates.</Row>
      </>
    ),
  },
  // --- Workspace ---------------------------------------------------------------
  tiles: {
    label: "Sessions & tiles",
    blurb: "Every tile tells you what runs, where, on which branch and since when, without typing a command.",
    icon: SquareTerminal,
    demo: (
      <TileDemo>
        <Line><Dim>›</Dim> Add tests for the session API</Line>
      </TileDemo>
    ),
    body: (
      <>
        <Row ui={<span className="doc-dots"><span className="stat stat-idle" /><span className="stat stat-notify" /><span className="stat stat-failed" /></span>} name="Status dot">
          Grey idle, green waiting on you, red exited.
        </Row>
        <Row ui={<ClaudeTileIcon />} name="Type icon">What runs right now, in its own color.</Row>
        <Row ui={<span className="tile-title">api</span>} name="Title">Click to rename; tmux keeps its own name.</Row>
        <Row ui={<GitBranch size={15} className="muted-icon" />} name="Footer">Session, branch, running program and agent mode, folder and start time.</Row>
      </>
    ),
    tips: [
      <>Click the folder in the footer to copy its full path.</>,
      <>Drag a header onto another tile to reorder; sessions you opened in your own terminal can be attached too.</>,
    ],
  },
  controls: {
    label: "Tile controls",
    blurb: "Each tile carries its own buttons, so you can edit, move, copy or park a session without leaving it.",
    icon: Boxes,
    demo: (
      <Hero caption="Tile actions · top-right of every tile">
        <span className="tile-actions">
          <TB icon={Mic} />
          <TB icon={FileCode} />
          <TB icon={FolderInput} />
          <TB icon={Copy} />
          <TB icon={Maximize2} />
          <TB icon={EyeOff} />
          <TB icon={X} danger />
        </span>
      </Hero>
    ),
    body: (
      <>
        <Row ui={<TB icon={Mic} />} name="Dictation">Speak into this terminal (Mac).</Row>
        <Row ui={<TB icon={FileCode} />} name="Code editor">Open the editor beside the terminal.</Row>
        <Row ui={<TB icon={FolderInput} />} name="Move">Send the session to another workspace.</Row>
        <Row ui={<TB icon={Copy} />} name="Duplicate">A fresh terminal in the same folder and device.</Row>
        <Row ui={<TB icon={Maximize2} />} name="Maximize">Fill the canvas; <Kbd>Esc</Kbd> restores.</Row>
        <Row ui={<TB icon={EyeOff} />} name="Hide">Out of sight, still running.</Row>
        <Row ui={<TB icon={X} danger />} name="Terminate">Ends the session, after a confirmation.</Row>
      </>
    ),
    tips: [<>Buttons on other tiles appear when you hover or tab into them.</>],
  },
  focus: {
    label: "Focus & attention",
    blurb: "Background agents never steal your scroll or keystrokes, and the one that needs you is a key away.",
    icon: Focus,
    demo: (
      <Hero caption="Attention at a glance">
        <States
          items={[
            { ui: <span className="stat stat-notify" />, label: "Waiting on you" },
            { ui: <span className="tile-actions"><TB icon={Maximize2} on /></span>, label: "Maximized" },
            { ui: <Kbd>{CMD} J</Kbd>, label: "Jump to it" },
          ]}
        />
      </Hero>
    ),
    body: (
      <>
        <P>Click a tile to make it <b>active</b>: the others get a light wash, and only the active one scrolls and takes your typing.</P>
        <Row ui={<span className="stat stat-notify" />} name="Waiting on you">
          An agent rings the bell or a process exits: the dot turns green, a notification is added and the workspace tab shows a count.
        </Row>
        <Row ui={<Kbd>{CMD} J</Kbd>} name="Jump">
          Activates the next tile waiting on you, across workspaces, revealing it if hidden.
        </Row>
        <Row ui={<TB icon={Maximize2} on />} name="Maximize">Double-click a header for the whole canvas; again or <Kbd>Esc</Kbd> restores.</Row>
      </>
    ),
    tips: [<><Kbd>{ctrlBadge(1)}</Kbd>–<Kbd>{ctrlBadge(9)}</Kbd> also scrolls the tile to the center.</>],
  },
  layout: {
    label: "Layout & grid",
    blurb: "Size the grid per workspace and give any tile more room, without terminals ever re-attaching or garbling.",
    icon: Columns3,
    demo: <LayoutDemo />,
    body: (
      <>
        <Steps>
          <Step>Click the active workspace tab and set <b>Layout</b>: <b>Auto</b> fits columns to the window and shares rows evenly (5 tiles: 3 + 2), or pick <b>2</b>-<b>4</b> for that workspace.</Step>
          <Step>Drag a tile's header to move it: the grid shows where it will land, the others make room, and <Kbd>Esc</Kbd> cancels.</Step>
          <Step>Drag a tile's right edge, bottom edge or corner to span more or less, in half steps; double-click any of them to return the tile to automatic size.</Step>
        </Steps>
        <Row ui={<span className="tile-btn"><MoveDiagonal2 size={13} /></span>} name="Keyboard">
          <Kbd>{IS_MAC ? "⌃⌥" : "Ctrl+Alt+"}</Kbd> + arrows move the active tile; add <Kbd>{IS_MAC ? "⇧" : "Shift"}</Kbd> to resize it by half a column or row.
        </Row>
      </>
    ),
    tips: [<><b>Auto arrange</b> in the command palette clears the sizes you set and returns the workspace to Auto.</>],
  },
  spacing: {
    label: "Spacing",
    blurb: "Choose how much room sits around and between tiles, from airy to edge to edge, for the screen you are on.",
    icon: SquareDashed,
    demo: (
      <Hero caption="Settings · General · Appearance · Spacing">
        <States
          items={[
            { ui: <MiniGrid gap={10} />, label: "10 px · default" },
            { ui: <MiniGrid gap={4} />, label: "4 px" },
            { ui: <MiniGrid gap={0} />, label: "0 · joined" },
          ]}
        />
      </Hero>
    ),
    body: (
      <Steps>
        <Step>Open <b>Settings → General → Appearance</b>.</Step>
        <Step>Drag <b>Spacing</b> from 0 to 24 px; the mark is the default, and the slider snaps to it.</Step>
        <Step>At <b>0</b> tiles join edge to edge and drop their borders at the window edges.</Step>
      </Steps>
    ),
    tips: [<>The palette has <b>Spacing: join tiles</b> and <b>Spacing: default</b> for a quick switch.</>],
  },
  workspaces: {
    label: "Workspaces",
    blurb: "Group sessions into tabbed contexts, one per project, and switch between them with a key.",
    icon: Layers,
    demo: <WorkspaceTabsDemo />,
    body: (
      <>
        <Steps>
          <Step>Press <span className="ws-tab-add-demo">+</span> or <Kbd>{NEW_WORKSPACE_SHORTCUT.label}</Kbd>; name it and pick an icon and color.</Step>
          <Step>Drag a tile's header onto a tab to move the session there.</Step>
          <Step>Switch with <Kbd>{altBadge(1)}</Kbd>–<Kbd>{altBadge(9)}</Kbd>; <Kbd>{altBadge(0)}</Kbd> shows <b>All</b>.</Step>
        </Steps>
        <P>Click the active tab, or right-click any tab, for its settings: name and icon, its <b>Sessions</b> (show or hide each), <b>Snapshots</b> and <b>Worktrees</b>.</P>
      </>
    ),
    tips: [
      <>A count on a tab means sessions there are waiting on you.</>,
      <>Deleting a workspace moves its sessions to the default one; nothing is terminated.</>,
    ],
  },
  snapshots: {
    label: "Snapshots",
    blurb: "Save a workspace's sessions and layout, bring them back after a reboot, or share the setup with another machine.",
    icon: Save,
    demo: <SnapshotDemo />,
    body: (
      <>
        <Steps>
          <Step>Open the workspace's settings and unfold <b>Snapshots</b>.</Step>
          <Step><b>Save current</b> saves at once (like "Main · 16:40"); click the name to rename it.</Step>
          <Step><Copy size={12} className="doc-inline-icon" /> copies it; <b>Paste snapshot</b> adds it on another machine.</Step>
        </Steps>
        <P>A snapshot holds each session's device, folder, agent, mode and branch, plus tile order, sizes, titles, hidden tiles, open editors and columns.</P>
      </>
    ),
    tips: [
      <>Each workspace keeps an <b>Auto-saved</b> snapshot, and deleting one saves <b>Before deleting …</b> first.</>,
    ],
  },
  restore: {
    label: "Restore snapshots",
    blurb: "See exactly what a restore will do before anything starts, and keep only what you want.",
    icon: RotateCcw,
    demo: <RestoreDemo />,
    body: (
      <>
        <table className="doc-keys">
          <tbody>
            <tr><td><span className="snap-preview-status is-start">Will start</span></td><td>Created again in its folder, with its agent.</td></tr>
            <tr><td><span className="snap-preview-status is-resume">Agent restarts</span></td><td>Open but back at its shell: the agent starts again.</td></tr>
            <tr><td><span className="snap-preview-status is-running">Running</span></td><td>Already running, left alone.</td></tr>
            <tr><td><span className="snap-preview-status is-no-device">Device missing</span></td><td>Its device is not enabled.</td></tr>
          </tbody>
        </table>
        <P><b>Continue agent conversations</b> picks up each agent's last conversation; the layout comes back too. Changed branches are reported, never switched.</P>
      </>
    ),
  },
  broadcast: {
    label: "Broadcast",
    blurb: "Write one message once and send it to several sessions, or every agent, at the same time.",
    icon: Radio,
    demo: <BroadcastDemo />,
    body: (
      <Steps>
        <Step><b>Shift+click</b> the headers of two or more tiles; they tint and a composer rises under the grid with each one as a chip. <b>All agents</b> adds every tile running a coding agent.</Step>
        <Step>Type a message, or pick a saved prompt with <MessageSquareText size={12} className="doc-inline-icon" />. <Kbd>Shift</Kbd>+<Kbd>Enter</Kbd> adds a line; agents take it as one prompt, while a plain shell refuses it instead of running each line.</Step>
        <Step>Press <Kbd>Enter</Kbd> or <b>Send</b>: each session gets the message and Enter, and the composer reports any that failed.</Step>
      </Steps>
    ),
    tips: [
      <>A session waiting on an approval prompt is skipped, so your message never answers it by accident.</>,
      <><b>Broadcast to every agent</b> and <b>Broadcast to visible tiles</b> in the palette select them at once; <Kbd>Esc</Kbd> clears the selection.</>,
    ],
  },
  // --- Git & review -----------------------------------------------------------
  git: {
    label: "Branch & PR",
    blurb: "Each tile's footer shows its branch, what is left to push or pull, and its pull request with live checks.",
    icon: GitBranch,
    demo: (
      <TileDemo git="status">
        <Line><Dim>⏺</Dim> Pushed 2 commits to main</Line>
      </TileDemo>
    ),
    body: (
      <>
        <Row ui={<span className="doc-strip-ui"><span className="tile-strip-ab"><ArrowUp size={10} />2</span> <span className="tile-strip-ab"><ArrowDown size={10} />1</span></span>} name="Push and pull">Commits to push (↑) and to pull (↓).</Row>
        <Row ui={<span className="doc-strip-ui tile-strip-pr"><GitPullRequest size={10} />42</span>} name="Pull request">With <Code>gh</Code> signed in on the device: the branch's PR and whether checks pass, fail or run.</Row>
        <Row ui={<span className="tile-strip-git-icon doc-strip-ui"><GitBranch size={11} /><span className="tile-strip-dirty" /></span>} name="Dot">Uncommitted changes; click it to review them.</Row>
      </>
    ),
    tips: [<>Click the branch to open its pull request, or the branch page on GitHub, GitLab or Bitbucket.</>],
  },
  ci: {
    label: "Fix failing CI",
    blurb: "When checks fail, hand the logs to the agent in one click instead of copying them out of the browser.",
    icon: CircleX,
    demo: (
      <TileDemo git="failing">
        <Line><Dim>›</Dim> <Typed>CI failed on main (test, lint). Logs: ~/api/.git/… Please fix.</Typed></Line>
      </TileDemo>
    ),
    body: (
      <Steps>
        <Step>A red check next to the pull request means a check failed.</Step>
        <Step>Press <Send size={11} className="doc-inline-icon" /> beside it. The failed CI logs are saved to a file in the repository's <Code>.git</Code> folder.</Step>
        <Step>The tile's agent gets one line naming the branch, the failed jobs and the log file, and starts fixing.</Step>
      </Steps>
    ),
    tips: [<>The button works while an agent runs in the tile; the logs never flood the terminal.</>],
  },
  "shared-branch": {
    label: "Shared branch",
    blurb: "PzzaCode warns when two agents work on the same branch of one checkout, and moves one aside before they collide.",
    icon: TriangleAlert,
    demo: (
      <TileDemo git="shared">
        <Line><Dim>⏺</Dim> Editing src/session.ts</Line>
      </TileDemo>
    ),
    body: (
      <Steps>
        <Step>The <TriangleAlert size={11} className="doc-inline-icon" /> warning shows when another tile's agent is on the same branch; hover it to see which.</Step>
        <Step>Click it: this tile's agent starts in its own worktree, in a new tile next to it.</Step>
        <Step>The original session keeps running, so nothing is lost.</Step>
      </Steps>
    ),
    tips: [<>Hidden tiles running an agent count too, even in other workspaces.</>],
  },
  worktrees: {
    label: "Worktrees",
    blurb: "Run agents in parallel on one repository, each with its own checkout and branch, so they never overwrite each other.",
    icon: FolderGit2,
    demo: <WorktreesDemo />,
    body: (
      <>
        <P>Tick <b>Worktree</b> in New session: the agent gets <Code>{"<repo>.worktrees/<name>"}</Code> on a new <Code>{"pzza/<name>"}</Code> branch, with ignored <Code>.env*</Code> files copied in.</P>
        <Row ui={<ChevronRight size={14} className="muted-icon" />} name="Setup for new worktrees">Files to copy and commands to run first (like <Code>npm install</Code>), saved in <Code>.pzzacode/worktree.json</Code>.</Row>
        <Row ui={<Trash2 size={14} className="muted-icon" />} name="Clean up">Removes merged worktrees with their branches, squash and rebase merges included.</Row>
      </>
    ),
    tips: [<>Setup commands changed elsewhere wait for <b>Approve commands</b> before they run.</>],
  },
  land: {
    label: "Open PR & merge",
    blurb: "Bring a worktree's work home from the tile itself: open a pull request or merge it, with safe guards.",
    icon: GitPullRequestCreateArrow,
    demo: (
      <TileDemo git="worktree">
        <Line><Dim>⏺</Dim> Fixed the login redirect; all tests pass.</Line>
      </TileDemo>
    ),
    body: (
      <>
        <Row ui={<GitPullRequestCreateArrow size={14} className="muted-icon" />} name="Open PR">Pushes the branch and runs <Code>gh pr create --fill</Code>; without <Code>gh</Code>, the compare page opens.</Row>
        <Row ui={<GitMerge size={14} className="muted-icon" />} name="Merge">After a confirmation, <Code>git merge --no-ff</Code> in the main checkout.</Row>
        <P>Merge runs only when the worktree and the main checkout are clean and the main checkout is on the base branch. A conflicting merge is aborted.</P>
      </>
    ),
    tips: [<>The same buttons sit on each row of Workspace settings → Worktrees.</>],
  },
  changes: {
    label: "Changes view",
    blurb: "See what an agent changed, file by file, right next to its terminal.",
    icon: GitCompareArrows,
    demo: <ChangesDemo />,
    body: (
      <Steps>
        <Step>Click the dot on the footer branch, or <b>Show changes</b> in the palette.</Step>
        <Step><b>Changes</b> lists files: M modified, A added, U untracked, D deleted, R renamed, ! conflicted.</Step>
        <Step>Pick one for its diff: <b>Unified</b> or <b>Split</b>, unchanged stretches folded. <b>Edit file</b> opens it.</Step>
      </Steps>
    ),
    tips: [<>The layout you pick is remembered for next time.</>],
  },
  review: {
    label: "Review with agent",
    blurb: "Point at exact lines in a diff and ask the agent, or collect comments and send them as one review.",
    icon: MessageSquarePlus,
    demo: <ReviewDemo />,
    body: (
      <>
        <Row ui={<MessageSquare size={14} className="muted-icon" />} name="Ask agent">Select lines, ask, <Kbd>Enter</Kbd>: the question goes to the tile's agent with the file and lines.</Row>
        <Row ui={<MessageSquarePlus size={14} className="muted-icon" />} name="Add comment">Collects comments across files; commented lines get a colored edge.</Row>
        <Row ui={<Send size={14} className="muted-icon" />} name="Send review">Types every comment to the agent as one numbered review.</Row>
      </>
    ),
    tips: [<>In Split, select on the left to ask about removed lines; the comment count opens the list to edit.</>],
  },
  // --- Terminal & editor ------------------------------------------------------
  links: {
    label: "Open links",
    blurb: `${CMD}+click any web address in a terminal to open it in your browser, even one an agent wrapped across lines.`,
    icon: Link2,
    demo: (
      <TileDemo>
        <Line><Dim>⏺</Dim> Opened the pull request:</Line>
        <Line>{"  "}<span className="doc-term-link">https://github.com/pzzaworks/pzza-code/pull/</span></Line>
        <Line>{"  "}<span className="doc-term-link">1287</span></Line>
      </TileDemo>
    ),
    body: (
      <Steps>
        <Step>Point at an <Code>http</Code> or <Code>https</Code> address: it underlines.</Step>
        <Step><Kbd>{CMD} Click</Kbd>: it opens in this computer's default browser, whichever device the session runs on.</Step>
        <Step>A URL broken over several lines, even with an indent, opens whole.</Step>
      </Steps>
    ),
    tips: [
      <>A plain click stays a terminal click, so links never open by accident.</>,
      <>Double-click a link to select all of it; copying gives the joined address.</>,
    ],
  },
  paths: {
    label: "Open file paths",
    blurb: `${CMD}+click a file path an agent printed to jump straight to it in Finder.`,
    icon: FolderOpen,
    demo: (
      <TileDemo>
        <Line><Dim>⏺</Dim> Wrote the report to <span className="doc-term-path">~/Projects/api/report.md</span></Line>
        <Line><Dim>⏺</Dim> Screenshots are in <span className="doc-term-path">/Users/me/Desktop/shots</span></Line>
      </TileDemo>
    ),
    body: (
      <>
        <Steps>
          <Step>Point at an absolute path (<Code>/Users/me/x.ts</Code>) or a home path (<Code>~/notes</Code>).</Step>
          <Step><Kbd>{CMD} Click</Kbd>: a <b>file</b> is selected in its folder, a <b>folder</b> opens.</Step>
        </Steps>
        <P>Paths wrapped across lines work too. If the path does not exist, PzzaCode says so instead of guessing.</P>
      </>
    ),
    tips: [<>This works for sessions on this Mac in the desktop app; a remote device's paths stay plain text.</>],
  },
  paste: {
    label: "Paste images",
    blurb: "Paste a screenshot straight into a terminal and the agent can see it, on this machine or a remote one.",
    icon: ImageIcon,
    demo: (
      <TileDemo>
        <Line><Dim>›</Dim> Make the header match this <Typed>'/Users/me/.cache/pzzacode/paste/7f3a91c2.png'</Typed></Line>
      </TileDemo>
    ),
    body: (
      <>
        <Steps>
          <Step>Copy an image: a screenshot (<Kbd>{IS_MAC ? "⌃⇧⌘4" : "PrtSc"}</Kbd>), an image file or one from the web.</Step>
          <Step>Click the terminal and press <Kbd>{CMD} V</Kbd>, or right-click → <b>Paste text or image</b>.</Step>
          <Step>The image is saved on the session's device and its quoted path is typed in, without Enter. Add your words and send.</Step>
        </Steps>
        <P>Agents that read images from a path, like Claude Code and Codex, open it from there. Over SSH the image travels with it.</P>
      </>
    ),
    tips: [
      <>PNG, JPEG, GIF, WebP and BMP, up to 20 MB each.</>,
      <>Images are saved where only you can read them, under <Code>pzzacode/paste</Code> in the device's cache folder.</>,
    ],
  },
  drop: {
    label: "Drop files",
    blurb: "Drag files from Finder onto a terminal to hand them to the agent, even when the session runs on another machine.",
    icon: FileUp,
    demo: (
      <TileDemo>
        <Line><Dim>›</Dim> Summarize <Typed>'/tmp/pzzacode-drop-4e1c/spec.pdf' '/tmp/pzzacode-drop-4e1c/notes.md'</Typed></Line>
      </TileDemo>
    ),
    body: (
      <>
        <Steps>
          <Step>Drag one or more files onto the terminal you want.</Step>
          <Step>They are copied to a private temporary folder on the session's device.</Step>
          <Step>Their quoted paths are typed in, without Enter, ready for the agent to read.</Step>
        </Steps>
        <P>Up to 8 files at once, 16 MB each and 32 MB in total. A folder is refused in a terminal; dropped on the empty canvas, it starts a new session there instead.</P>
      </>
    ),
    tips: [<>If a drop fails, PzzaCode says why and removes its temporary copy.</>],
  },
  find: {
    label: "Find & copy",
    blurb: "Search a terminal's output and copy exactly what you need, without leaving the keyboard.",
    icon: Search,
    demo: <FindDemo />,
    body: (
      <>
        <Row ui={<Kbd>{CMD} F</Kbd>} name="Find">Opens the find bar; the selection seeds it. <Kbd>Enter</Kbd> next, <Kbd>Shift Enter</Kbd> previous, <b>Aa</b> matches case.</Row>
        <Row ui={<Kbd>{IS_MAC ? "⌘ C" : "Ctrl Shift C"}</Kbd>} name="Copy">Copies the selection.</Row>
        <Row ui={<ClipboardPaste size={15} className="muted-icon" />} name="Right-click">Copy text, Paste text or image, Select all, Clear selection.</Row>
      </>
    ),
    tips: [<>Programs may set the clipboard only once you allow it in Settings → General → Terminal; terminal output is untrusted.</>],
  },
  search: {
    label: "Search terminals",
    blurb: "Find that one error in any terminal at once, then jump right to the line.",
    icon: TextSearch,
    demo: <SearchDemo />,
    body: (
      <Steps>
        <Step>Press <Kbd>{SEARCH_TERMINALS_SHORTCUT.label}</Kbd> or pick <b>Search all terminals</b> in the palette.</Step>
        <Step>Type; matches from every open terminal's scrollback appear grouped by tile, with the lines around them. <Regex size={12} className="doc-inline-icon" /> switches to a regular expression.</Step>
        <Step><Kbd>Enter</Kbd> or a click activates the tile, scrolls to the line and highlights it.</Step>
      </Steps>
    ),
    tips: [<>Plain text ignores case.</>],
  },
  prompts: {
    label: "Saved prompts",
    blurb: "Keep the instructions you send every day one click away, for one tile or many.",
    icon: MessageSquareText,
    demo: (
      <div className="doc-demo doc-dialog-demo">
        <div className="cmdk">
          <div className="cmdk-list">
            <div className="cmdk-group">
              <div className="cmdk-group-title">Actions</div>
              <PaletteRow icon={MessageSquareText} label="Prompt: Run the tests" detail="Send to api" active />
              <PaletteRow icon={MessageSquareText} label="Prompt: Review my changes" detail="Send to api" />
            </div>
          </div>
        </div>
      </div>
    ),
    body: (
      <Steps>
        <Step>Add them in <b>Settings → General → Saved prompts</b>: one line each, reorder as you like.</Step>
        <Step>In <Kbd>{COMMAND_PALETTE_SHORTCUT.label}</Kbd>, a <b>Prompt: …</b> row sends it to the active tile with Enter.</Step>
        <Step>In the broadcast bar, <MessageSquareText size={12} className="doc-inline-icon" /> fills the input so you can check it first.</Step>
      </Steps>
    ),
  },
  code: {
    label: "Code editor",
    blurb: "Read and edit files beside the terminal, local or remote, with a file tree and go-to-definition.",
    icon: FileCode,
    demo: <CodeBarDemo />,
    body: (
      <>
        <Steps>
          <Step>Press a tile's <TB icon={FileCode} />: the editor opens beside the terminal, at its live folder.</Step>
          <Step>Pick files from the tree; a dot marks unsaved changes and <Kbd>{CMD} S</Kbd> saves.</Step>
        </Steps>
        <Row ui={<TB icon={PanelLeft} on />} name="Tree">Show or hide it; right-click to rename or delete, drag to move.</Row>
        <Row ui={<TB icon={Columns2} />} name="Split">Side by side or stacked; drag the divider, double-click to center.</Row>
        <Row ui={<MousePointerClick size={15} className="muted-icon" />} name="Definition">Hold {IS_MAC ? "⌘, ⌃ or ⌥" : "Ctrl or Alt"} and click a symbol; imports open their file.</Row>
      </>
    ),
    tips: [<><Kbd>{CMD} F</Kbd> finds and replaces; Markdown has a Preview, images and PDFs open as previews.</>],
  },
  // --- Agents & activity ------------------------------------------------------
  tasks: {
    label: "Tasks",
    blurb: "Hand a prompt to an agent in its own worktree and follow it from start to merge, from one menu bar dropdown.",
    icon: ListTodo,
    demo: <TasksDemo />,
    body: (
      <>
        <Steps>
          <Step><IB icon={ListTodo} /> or <Kbd>{TASKS_SHORTCUT.label}</Kbd> opens Tasks, <IB icon={Plus} /> a new task. Write the prompt, press <Kbd>{CMD} ↩</Kbd>: it starts in a tile on a fresh <Code>{"pzza/"}</Code> worktree.</Step>
          <Step>Tasks sort themselves into <b>Needs you</b>, <b>Working</b>, <b>Review</b> and <b>Done</b>; the count jumps to one waiting.</Step>
          <Step>Click a task for where it stands and its next step (<b>Send prompt</b>, <b>Commit</b>, <b>Land</b>); <b>Open details</b> shows its attempts or steps, the diff and every action.</Step>
        </Steps>
      </>
    ),
    tips: [<>Land waits for an idle agent, committed work and any <Code>{'"check"'}</Code> in <Code>.pzzacode/worktree.json</Code>; <b>Discard</b> lists unmerged work.</>],
  },
  "best-of-n": {
    label: "Task modes",
    blurb: "Start one task, several at once, a chain of agents on one branch, or a race where you keep the best.",
    icon: Trophy,
    demo: <TaskModesDemo />,
    body: (
      <Steps>
        <Step><b>One</b>: one agent. <b>Parallel</b>: one task per line, each with its own agent, worktree and branch, all started together.</Step>
        <Step><b>Chain</b>: steps one after another in one worktree. Start from a preset, then add, remove or reorder steps, each with a role or your own instruction. A step starts when the one before goes quiet; one that needs approval pauses the chain until you <b>Resume</b>, <b>Skip</b> or <b>Stop</b>.</Step>
        <Step><b>Race</b>: the same prompt to as many agents as you add. Compare them in the task window, <b>Land</b> your pick, and the rest go once you confirm.</Step>
      </Steps>
    ),
  },
  "quick-chat": {
    label: "Quick Chat",
    blurb: "Ask your agent a quick question from a dropdown, without opening a session or losing your place.",
    icon: MessageSquare,
    demo: <QuickChatDemo />,
    body: (
      <Steps>
        <Step>Press <IB icon={MessageSquare} /> <b>Quick Chat</b> in the menu bar; your saved agent is ready.</Step>
        <Step>Click outside or <X size={11} className="doc-inline-icon" /> to hide it; the chat keeps running until the app closes.</Step>
        <Step>Pick its agent (any of the {SESSION_AGENTS.length} the new-session form offers) and device in <b>Settings → Quick Chat</b>.</Step>
      </Steps>
    ),
  },
  "agent-tools": {
    label: "Agent automation",
    blurb: "Let a coding agent work the app for you: open sessions, arrange tiles, save snapshots and more.",
    icon: Sparkles,
    demo: (
      <div className="doc-demo">
        <div className="doc-tile">
          <div className="doc-tile-body">
            <Line><Dim>›</Dim> Open a Codex session in ~/web and use 3 columns</Line>
            <Line><Dim>⏺</Dim> app_create_session <Dim>· name "web", agent codex</Dim></Line>
            <Line><Dim>⏺</Dim> app_set_columns <Dim>· columns 3</Dim></Line>
          </div>
        </div>
      </div>
    ),
    body: (
      <>
        <Row ui={<IB icon={SquareTerminal} />} name="Sessions & tiles">Create with an agent, focus, rename, hide, resize, move, terminate.</Row>
        <Row ui={<IB icon={Layers} />} name="Workspaces">Create, switch, reorder; save and restore snapshots.</Row>
        <Row ui={<IB icon={Keyboard} />} name="Terminals">Read output (credentials redacted), type, press keys, scroll.</Row>
        <Row ui={<IB icon={FileCode} />} name="Editors">Open, edit by revision, save; manage the file tree.</Row>
      </>
    ),
    tips: [
      <>Turn it on in Settings → Connections (see MCP). Deleting and terminating still ask you first.</>,
    ],
  },
  notifications: {
    label: "Notifications",
    blurb: "Know the moment an agent finishes or needs you, with what changed and a button to review it.",
    icon: Bell,
    demo: <NotificationsDemo />,
    body: (
      <>
        <Steps>
          <Step>The <IB icon={Bell} /> badge counts unread items; open it for the latest five.</Step>
          <Step>Click one to jump to its tile. <b>Review changes</b> opens the finished agent's Changes.</Step>
          <Step><b>View all notifications</b> filters the history by category or unread.</Step>
        </Steps>
        <Row ui={<BellOff size={15} className="muted-icon" />} name="Preferences">System alerts while unfocused, pause for an hour, categories and single events.</Row>
      </>
    ),
    tips: [<>Terminal alerts need a bell or a process exit. A hidden tile also alerts once its agent stops working, or when a plain shell in it prints.</>],
  },
  usage: {
    label: "Usage limits",
    blurb: "See every account's live limits at a glance, so a reset never catches you mid-task.",
    icon: Gauge,
    demo: <UsageDemo />,
    body: (
      <Steps>
        <Step>Open <IB icon={Gauge} /> <b>Agent usage</b> (accounts are found automatically): Claude and Codex show <b>5h</b> and <b>Weekly</b>, OpenCode adds <b>Monthly</b> and <b>Credits</b>, and <b>Other agents</b> lists the rest from the last 30 days with their cost.</Step>
        <Step><b>Left / Used</b> flips the bars; <b>Show percentage</b> keeps one limit in the menu bar: the tightest (<b>Auto</b>), or the one you pin.</Step>
      </Steps>
    ),
  },
  multiaccount: {
    label: "Multi-account",
    blurb: "Track several Claude or Codex accounts side by side and run agents under any of them.",
    icon: UsersRound,
    demo: <UsageDemo accounts />,
    body: (
      <Steps>
        <Step>Log in to each account once with its own config folder, like <Code>CLAUDE_CONFIG_DIR=~/.claude-work claude</Code> or <Code>CODEX_HOME=~/.codex-work codex</Code>.</Step>
        <Step><b>Agent usage</b> lists each account with its plan, email and limits.</Step>
        <Step>Start an agent under another account the same way, in any tile.</Step>
      </Steps>
    ),
    tips: [<>New session uses each agent's default account in the desktop app; the browser shows an <b>Account</b> pill.</>],
  },
  // --- Dictation ----------------------------------------------------------------
  dictation: {
    label: "Dictation",
    blurb: "Speak instead of typing into any terminal; recognition runs on this Mac and audio never leaves it.",
    icon: Mic,
    demo: (
      <Hero caption="Tile microphone · push to talk">
        <States
          items={[
            { ui: <DictationMic state="idle" />, label: "Ready" },
            { ui: <DictationMic state="listening" />, label: "Listening" },
            { ui: <DictationMic state="error" />, label: "Failed, retry" },
            { ui: <Kbd>Hold {ALT_LABEL}</Kbd>, label: "Push to talk" },
          ]}
        />
      </Hero>
    ),
    body: (
      <Steps>
        <Step>In <b>Settings → General → Dictation</b>, download the speech model once (Whisper large-v3, 1.1 GB) and turn on <b>Enable dictation</b>.</Step>
        <Step>Click a tile's <TB icon={Mic} />, or <b>hold Option</b> on its own, and speak; dots at the cursor show you are heard and turn into words as they are recognized.</Step>
        <Step>Release Option or click stop; a clicked recording also ends on its own after <b>Stop after silence</b> (5 seconds by default) of quiet. The text is inserted without Enter, so you can check it.</Step>
      </Steps>
    ),
    tips: [
      <>Set <b>Option key</b> to <b>Tap</b> to start and stop with a tap, or a pause in speech.</>,
      <>No subscription or API key; an Option shortcut never starts a recording.</>,
    ],
  },
  languages: {
    label: "Languages & mic",
    blurb: "Dictate in your own languages, mixed if you like, with clear audio from the right microphone.",
    icon: AudioLines,
    demo: <LanguagesDemo />,
    body: (
      <>
        <Row ui={<Sparkles size={15} className="muted-icon" />} name="Recognition language">Auto-detect, or the one language you speak.</Row>
        <Row ui={<UsersRound size={15} className="muted-icon" />} name="My languages">Up to six, main first; detection favors it when unsure.</Row>
        <Row ui={<Mic size={15} className="muted-icon" />} name="Microphone input">The macOS input or one you pick.</Row>
      </>
    ),
    tips: [<>With Bluetooth headphones, dictation records from the built-in microphone so their sound stays clear.</>],
  },
  // --- Connections ------------------------------------------------------------
  devices: {
    label: "Devices",
    blurb: "Add your other machines over SSH and run sessions on all of them from one grid.",
    icon: HardDrive,
    demo: <DevicesDemo />,
    body: (
      <Steps>
        <Step>In <b>Settings → Devices</b>, pick a host from <Code>~/.ssh/config</Code> or type one, then <b>Add device</b>.</Step>
        <Step>No agent there yet? <b>Install agent over SSH</b> installs it over the connection you already have.</Step>
        <Step>Expand a device for its live tmux sessions; the switch turns it off without removing it.</Step>
      </Steps>
    ),
    tips: [<>Each device's agent keeps its own state, so your layout follows you to any client.</>],
  },
  sync: {
    label: "Sync",
    blurb: "Keep your Git projects aligned across devices in one reviewed step.",
    icon: FolderSync,
    demo: <SyncDemo />,
    body: (
      <>
        <Steps>
          <Step>Press <IB icon={FolderSync} /> <b>Sync projects</b> in the menu bar; PzzaCode scans each device.</Step>
          <Step>Review, then confirm <b>Sync projects</b>. <b>Cancel sync</b> stops what has not started.</Step>
        </Steps>
        <P>In <b>Settings → Sync</b>: devices in sync, cloning missing projects, aligning to the remote baseline, stashing uncommitted changes and syncing env files (with private backups).</P>
      </>
    ),
    tips: [<>A failed sync shows up in Notifications with the reason.</>],
  },
  ports: {
    label: "Ports",
    blurb: "Open a remote dev server on localhost, so OAuth callbacks and cookies keep working.",
    icon: EthernetPort,
    demo: <PortsDemo />,
    body: (
      <Steps>
        <Step>In <b>Settings → Connections → Port forwarding</b>, pick the <b>Source device</b> and the <b>Receiver</b> and turn it on.</Step>
        <Step>Ports appear under <b>Forwarded</b> in the Port manager; <b>Open</b> opens one in the browser.</Step>
        <Step><b>This device</b> lists local listeners; <Square size={11} className="doc-inline-icon" /> <b>Stop</b> ends one after a confirmation.</Step>
      </Steps>
    ),
    tips: [<>System services and the agent itself can never be stopped from here.</>],
  },
  rdp: {
    label: "Remote desktop",
    blurb: "Open a remote Linux desktop over SSH in one click, without exposing it to the network.",
    icon: Monitor,
    demo: <RdpDemo />,
    body: (
      <Steps>
        <Step>Choose the <b>Remote server</b> in <b>Settings → Connections → Remote desktop</b>.</Step>
        <Step>Press <IB icon={Monitor} /> <b>Remote desktop → Open</b> in the menu bar.</Step>
      </Steps>
    ),
    tips: [<>The password comes from your keychain at launch and is never stored in the app.</>],
  },
  mcp: {
    label: "MCP",
    blurb: "Connect Claude Code, Codex and other agents to PzzaCode in one click.",
    icon: Blocks,
    demo: <McpDemo />,
    body: (
      <Steps>
        <Step>Open <b>Settings → Connections</b>; turn on <b>Allow app window control</b> to let agents drive this window.</Step>
        <Step>Press <b>Add</b> next to a client (Claude Code, Codex, OpenCode, Cursor, Windsurf, Zed), or <b>Copy</b> its configuration.</Step>
        <Step>For an agent on another device, set the <b>App SSH host</b> and <b>MCP script path</b> first.</Step>
      </Steps>
    ),
    tips: [<>File, device and session tools work even with window control off, except ending a session, which is confirmed in an app window with window control on; <b>Check now</b> repairs installed configurations.</>],
  },
  // --- Shortcuts & tips -------------------------------------------------------
  shortcuts: {
    label: "Shortcuts",
    blurb: "The keys that move you around the app fastest.",
    icon: Keyboard,
    demo: (
      <Hero caption="Command palette">
        <Kbd>{COMMAND_PALETTE_SHORTCUT.label}</Kbd>
      </Hero>
    ),
    body: (
      <table className="doc-keys">
        <tbody>
          <tr><td><Kbd>{COMMAND_PALETTE_SHORTCUT.label}</Kbd></td><td>Command palette</td></tr>
          <tr><td><Kbd>{NEW_SESSION_SHORTCUT.label}</Kbd> / <Kbd>{NEW_WORKSPACE_SHORTCUT.label}</Kbd></td><td>New session / new workspace</td></tr>
          <tr><td><Kbd>{CMD} ,</Kbd></td><td>Settings</td></tr>
          <tr><td><Kbd>{CMD} {SHIFT} /</Kbd></td><td>PzzaCode Help</td></tr>
          <tr><td><Kbd>{altBadge(0)}</Kbd> – <Kbd>{altBadge(9)}</Kbd></td><td>All, then the Nth workspace</td></tr>
          <tr><td><Kbd>{ctrlBadge(1)}</Kbd> – <Kbd>{ctrlBadge(9)}</Kbd></td><td>Activate the Nth visible tile</td></tr>
          <tr><td><Kbd>{CMD} J</Kbd></td><td>Next tile waiting on you</td></tr>
          <tr><td><Kbd>{TASKS_SHORTCUT.label}</Kbd></td><td>Show or hide Tasks</td></tr>
          <tr><td><Kbd>Shift Click</Kbd></td><td>Select tiles to broadcast</td></tr>
          <tr><td><Kbd>Esc</Kbd></td><td>Close, cancel, restore a maximized tile</td></tr>
        </tbody>
      </table>
    ),
    tips: [<>On macOS ⌥ is Option and ⌃ is Control; elsewhere they read Alt and Ctrl.</>],
  },
  "terminal-keys": {
    label: "Terminal shortcuts",
    blurb: "Keys and clicks for working inside terminals and the editor.",
    icon: MousePointerClick,
    demo: (
      <Hero caption="Terminal">
        <Kbd>{CMD} Click</Kbd>
        <Kbd>{CMD} V</Kbd>
        <Kbd>{SEARCH_TERMINALS_SHORTCUT.label}</Kbd>
      </Hero>
    ),
    body: (
      <table className="doc-keys">
        <tbody>
          <tr><td><Kbd>{CMD} Click</Kbd> a link</td><td>Open it in your browser, even wrapped</td></tr>
          <tr><td><Kbd>{CMD} Click</Kbd> a path</td><td>Reveal a file or open a folder in Finder</td></tr>
          <tr><td><Kbd>{CMD} V</Kbd></td><td>Paste text or an image</td></tr>
          <tr><td><Kbd>{IS_MAC ? "⌘ C" : "Ctrl Shift C"}</Kbd></td><td>Copy the selection</td></tr>
          <tr><td><Kbd>{CMD} F</Kbd> / <Kbd>{SEARCH_TERMINALS_SHORTCUT.label}</Kbd></td><td>Find here / in every terminal</td></tr>
          <tr><td><Kbd>{CMD} S</Kbd></td><td>Save the open file</td></tr>
          <tr><td><Kbd>{CMD} {SHIFT} =</Kbd> / <Kbd>{CMD} -</Kbd></td><td>Terminal font size up / down</td></tr>
          {IS_MAC ? <tr><td><Kbd>Hold {ALT_LABEL}</Kbd></td><td>Push to talk into the active terminal</td></tr> : null}
        </tbody>
      </table>
    ),
  },
  tips: {
    label: "Tips",
    blurb: "Small habits that save time every day.",
    icon: Lightbulb,
    demo: (
      <Hero caption="Settings · Help">
        <IB icon={CircleQuestionMark} />
      </Hero>
    ),
    body: (
      <ul className="doc-list">
        <li>Several agents on one repository? Tick <b>Worktree</b> so each gets its own checkout and branch.</li>
        <li>Rebooting a device? <b>Save current</b> in Snapshots first, then restore with <b>Continue agent conversations</b>.</li>
        <li>A stale session somewhere? <IB icon={HardDrive} /> Devices → expand the device → terminate it.</li>
        <li>Renaming a tile, workspace or snapshot is a click on its name; <Kbd>Esc</Kbd> cancels.</li>
        <li>Agents can open any page here with the <Code>open_help</Code> app command and a page id such as <Code>paste</Code>.</li>
      </ul>
    ),
  },
};

// The Help part of the Settings sidebar: sections that unfold into their pages.
// The section of the open page is unfolded; a click on another section opens
// its first page, and a click on the open section folds it.
export function HelpNav({ value, onChange }: { value: HelpTopic; onChange: (topic: HelpTopic) => void }) {
  const current = sectionOf(value);
  // A fold lasts until another page opens; it is reset while rendering so the
  // newly opened section never shows folded for a frame.
  const [folded, setFolded] = useState(false);
  const [foldedOn, setFoldedOn] = useState(value);
  if (foldedOn !== value) {
    setFoldedOn(value);
    setFolded(false);
  }
  const activeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => { activeRef.current?.scrollIntoView({ block: "nearest" }); }, [value]);
  return <div className="settings-nav-children help-nav" role="group" aria-label="Help topics">
    {HELP_SECTIONS.map((section) => {
      const here = section.id === current.id;
      const open = here && !folded;
      return <div className="help-nav-section" key={section.id}>
        <button type="button" className={`settings-hub-sublink help-nav-head ${here ? "is-current" : ""}`} aria-expanded={open}
          onClick={() => { if (here) setFolded(open); else onChange(section.topics[0]); }}>
          <ChevronRight size={12} className="help-nav-chevron" aria-hidden="true" />
          <span className="settings-hub-sublabel">{section.label}</span>
        </button>
        {open ? <div className="help-nav-pages" role="group" aria-label={`${section.label} pages`}>
          {section.topics.map((topic) => {
            const page = HELP_PAGES[topic];
            const active = topic === value;
            return <button type="button" key={topic} ref={active ? activeRef : undefined} title={page.label}
              aria-current={active ? "page" : undefined} className={`settings-hub-sublink help-nav-page ${active ? "active" : ""}`} onClick={() => onChange(topic)}>
              <span className="settings-hub-sublabel">{page.label}</span>
            </button>;
          })}
        </div> : null}
      </div>;
    })}
  </div>;
}

// One Help page with previous / next links that run through every section.
export function HelpContent({ topic, request, onNavigate }: { topic: HelpTopic; request?: HelpRequest; onNavigate: (topic: HelpTopic) => void }) {
  const head = useRef<HTMLDivElement>(null);
  // Focus follows a page opened from elsewhere (menu, palette, an agent) or
  // through previous / next, so keyboard and screen reader users land on it.
  const handled = useRef<number | undefined>(undefined);
  const paged = useRef(false);
  useEffect(() => {
    if (request && request.topic === topic && handled.current !== request.serial) {
      handled.current = request.serial;
      head.current?.focus({ preventScroll: true });
    } else if (paged.current) head.current?.focus({ preventScroll: true });
    paged.current = false;
  }, [request, topic]);
  const page = HELP_PAGES[topic];
  const section = sectionOf(topic);
  const index = HELP_ORDER.indexOf(topic);
  const prev = HELP_ORDER[index - 1];
  const next = HELP_ORDER[index + 1];
  const position = section.topics.findIndex((id) => id === topic);
  const go = (target: HelpTopic) => { paged.current = true; onNavigate(target); };
  const Icon = page.icon;
  return <div className="settings-page help-page"><div className="doc-content">
    <article className="help-article" key={topic} data-help-topic={topic}>
      <span className="help-crumb">{section.label} · {position + 1} of {section.topics.length}</span>
      <div className="help-article-head" tabIndex={-1} ref={head}>
        <Icon size={17} strokeWidth={1.9} />
        <div>
          <h3>{page.label}</h3>
          <p className="help-benefit">{page.blurb}</p>
        </div>
      </div>
      <div className="help-demo">{page.demo}</div>
      <div className="help-article-body">{page.body}</div>
      {page.tips?.length ? <div className="doc-note doc-note-tip help-tips">
        <Lightbulb size={14} />
        <ul>{page.tips.map((tip, tipIndex) => <li key={tipIndex}>{tip}</li>)}</ul>
      </div> : null}
      <nav className="help-pager" aria-label="Previous and next help pages">
        {prev ? <button type="button" className="help-pager-link" aria-label={`Previous: ${HELP_PAGES[prev].label}`} onClick={() => go(prev)}>
          <span className="help-pager-dir"><ChevronLeft size={13} aria-hidden="true" />Previous</span>
          <span className="help-pager-title">{HELP_PAGES[prev].label}</span>
        </button> : <span />}
        {next ? <button type="button" className="help-pager-link is-next" aria-label={`Next: ${HELP_PAGES[next].label}`} onClick={() => go(next)}>
          <span className="help-pager-dir">Next<ChevronRight size={13} aria-hidden="true" /></span>
          <span className="help-pager-title">{HELP_PAGES[next].label}</span>
        </button> : null}
      </nav>
    </article>
  </div></div>;
}
