import { useState, type ReactNode } from "react";
import {
  Blocks,
  Boxes,
  CircleQuestionMark,
  EthernetPort,
  Eye,
  EyeOff,
  Focus,
  Gauge,
  HardDrive,
  Image as ImageIcon,
  Info,
  Keyboard,
  Layers,
  LayoutGrid,
  Lightbulb,
  Maximize2,
  Monitor,
  Moon,
  MousePointerClick,
  Plus,
  Rocket,
  Settings as SettingsIcon,
  Sparkles,
  SquareTerminal,
  UsersRound,
  X,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { altBadge, ctrlBadge, IS_MAC } from "../shortcuts";

const CMD = IS_MAC ? "⌘" : "Ctrl";

// --- building blocks reusing the app's real classes, so the docs show the exact
// controls the user clicks --------------------------------------------------
const Kbd = ({ children }: { children: ReactNode }) => <kbd className="kbd">{children}</kbd>;

const IB = ({ icon: Icon }: { icon: LucideIcon }) => (
  <span className="icon-btn doc-ib">
    <Icon size={16} strokeWidth={1.9} />
  </span>
);

const TB = ({ icon: Icon, on }: { icon: LucideIcon; on?: boolean }) => (
  <span className={`tile-btn ${on ? "tile-btn-on" : ""}`}>
    <Icon size={13} />
  </span>
);

function Row({ ui, name, children }: { ui: ReactNode; name: string; children: ReactNode }) {
  return (
    <div className="doc-row">
      <div className="doc-row-ui">{ui}</div>
      <div className="doc-row-body">
        <div className="doc-row-name">{name}</div>
        <div className="doc-row-desc">{children}</div>
      </div>
    </div>
  );
}

const P = ({ children }: { children: ReactNode }) => <p className="doc-p">{children}</p>;
const H = ({ children }: { children: ReactNode }) => <div className="doc-h">{children}</div>;
const Note = ({ children }: { children: ReactNode }) => (
  <div className="doc-note">
    <Info size={14} />
    <div>{children}</div>
  </div>
);
const Tip = ({ children }: { children: ReactNode }) => (
  <div className="doc-note doc-note-tip">
    <Lightbulb size={14} />
    <div>{children}</div>
  </div>
);

const TileHeadDemo = () => (
  <div className="tile-head doc-tilehead">
    <span className="stat stat-active" />
    <span className="tile-icon" style={{ color: "#D97757" }}>
      <Sparkles size={14} />
    </span>
    <span className="tile-title">Claude</span>
    <kbd className="kbd tile-kbd">{ctrlBadge(1)}</kbd>
    <span className="tile-device">Devbox</span>
    <div className="tile-head-spacer" />
    <div className="tile-actions">
      <TB icon={Moon} />
      <TB icon={Focus} />
      <TB icon={LayoutGrid} />
      <TB icon={Maximize2} />
      <TB icon={EyeOff} />
      <span className="tile-btn tile-btn-danger">
        <X size={14} />
      </span>
    </div>
  </div>
);

// A framed stage at the top of a page that shows the exact control the page is
// about, larger and non-interactive, so every doc page opens with its component.
const Hero = ({ children, caption }: { children: ReactNode; caption: string }) => (
  <div className="doc-hero">
    <div className="doc-hero-stage">{children}</div>
    <span className="doc-hero-cap">{caption}</span>
  </div>
);

interface Sec {
  id: string;
  label: string;
  icon: LucideIcon;
  body: ReactNode;
}
interface Group {
  title: string;
  sections: Sec[];
}

export function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [active, setActive] = useState("start");

  const groups: Group[] = [
    {
      title: "Basics",
      sections: [
        {
          id: "start",
          label: "Overview",
          icon: Rocket,
          body: (
            <>
              <Hero caption="New session · top bar">
                <IB icon={Plus} />
              </Hero>
              <H>What PzzaCode is</H>
              <P>
                A grid terminal manager for agentic coding. Every tile on the grid is a live
                terminal - a plain shell, or a coding agent like <b>Claude Code</b> or{" "}
                <b>Codex</b>. Instead of hunting through tmux windows or a stack of terminal tabs,
                you see and drive all of them from one screen.
              </P>
              <H>Persistent by design</H>
              <P>
                Tiles are backed by <b>tmux</b> sessions running on the device, not by the app
                window. Closing PzzaCode - or losing the connection - just detaches your view:
                every agent keeps running and comes back exactly where you left it when you
                reopen. Nothing is lost between sessions.
              </P>
              <H>Where it runs</H>
              <P>
                In the browser it talks to a small <b>agent</b> on the device over a local
                HTTP/WebSocket API; as a native desktop app the same primitives run in Rust. The
                grid, workspaces and shortcuts are identical either way.
              </P>
              <Tip>
                New here? Hit <IB icon={Plus} /> in the top bar to open your first session, then
                skim <b>Tile controls</b> and <b>Keyboard shortcuts</b> below.
              </Tip>
            </>
          ),
        },
        {
          id: "topbar",
          label: "The top bar",
          icon: LayoutGrid,
          body: (
            <>
              <Hero caption="Top bar · tools (right side)">
                <span className="doc-hero-cluster">
                  <IB icon={LayoutGrid} />
                  <IB icon={Monitor} />
                  <IB icon={EthernetPort} />
                  <IB icon={HardDrive} />
                  <IB icon={Blocks} />
                  <IB icon={Gauge} />
                  <IB icon={CircleQuestionMark} />
                  <IB icon={SettingsIcon} />
                </span>
              </Hero>
              <H>Left to right</H>
              <P>
                The <b>brand</b> and version sit on the left, the <b>workspace tabs</b> in the
                middle, and the tool buttons on the right:
              </P>
              <Row ui={<IB icon={LayoutGrid} />} name="Layout">
                Grid columns (2 / 3 / 4) for the <i>active</i> workspace - each workspace keeps its
                own; the menu header shows which one you're changing.
              </Row>
              <Row ui={<IB icon={Monitor} />} name="Remote desktop">
                Open the device's Linux desktop over an SSH-tunneled RDP session.
              </Row>
              <Row ui={<IB icon={EthernetPort} />} name="Ports">
                The device's listening ports, mirrored to your machine.
              </Row>
              <Row ui={<IB icon={HardDrive} />} name="Devices">
                Your machines and their agents; click one to scan its live sessions.
              </Row>
              <Row ui={<IB icon={Blocks} />} name="MCP">
                Expose your sessions and ports to AI agents.
              </Row>
              <Row ui={<IB icon={Gauge} />} name="Agent usage">
                Live Claude / Codex usage and estimated spend.
              </Row>
              <Row ui={<IB icon={CircleQuestionMark} />} name="Help">
                This page.
              </Row>
              <Row ui={<IB icon={SettingsIcon} />} name="Settings">
                Font size, cursor blink and other preferences.
              </Row>
              <Row ui={<IB icon={Plus} />} name="New session">
                Open a new terminal - pick the device, workspace and (optionally) which account.
              </Row>
            </>
          ),
        },
        {
          id: "tiles",
          label: "Sessions & tiles",
          icon: SquareTerminal,
          body: (
            <>
              <H>Anatomy of a tile</H>
              <P>Every tile carries this header. Here is exactly what each part means:</P>
              <div className="doc-demo">
                <TileHeadDemo />
              </div>
              <Row
                ui={
                  <span className="doc-dots">
                    <span className="stat stat-idle" />
                    <span className="stat stat-active" />
                    <span className="stat stat-failed" />
                  </span>
                }
                name="Status dot"
              >
                Grey = idle, green blink = producing output, red = the process exited.
              </Row>
              <Row
                ui={
                  <span className="tile-icon" style={{ color: "#D97757" }}>
                    <Sparkles size={14} />
                  </span>
                }
                name="Type icon"
              >
                Colored by what's running - Claude, Codex, Docker, a shell, and so on.
              </Row>
              <Row ui={<kbd className="kbd tile-kbd">{ctrlBadge(1)}</kbd>} name="Shortcut badge">
                The key that activates this tile (see Keyboard shortcuts).
              </Row>
              <Row
                ui={
                  <span className="tile-title" style={{ cursor: "text" }}>
                    Claude
                  </span>
                }
                name="Title"
              >
                Click it to rename inline. The name is yours - it never touches the underlying tmux
                session.
              </Row>
              <Row ui={<span className="tile-device">Devbox</span>} name="Device & path">
                Which device the session runs on, and its current folder (the folder end stays
                visible when space is tight).
              </Row>
              <Note>
                Sessions are shared with your real tmux server, so a tab you opened in your
                terminal shows up here too, and vice versa.
              </Note>
            </>
          ),
        },
      ],
    },
    {
      title: "Windows",
      sections: [
        {
          id: "controls",
          label: "Tile controls",
          icon: Boxes,
          body: (
            <>
              <Hero caption="Tile actions · top-right of every tile">
                <span className="tile-actions">
                  <TB icon={Moon} />
                  <TB icon={Focus} />
                  <TB icon={LayoutGrid} />
                  <TB icon={Maximize2} />
                  <TB icon={EyeOff} />
                  <span className="tile-btn tile-btn-danger">
                    <X size={14} />
                  </span>
                </span>
              </Hero>
              <H>The buttons on each tile</H>
              <Row ui={<TB icon={Moon} />} name="Dim">
                Darkens just this one window. Click again - or click the dimmed tile - to undim.
              </Row>
              <Row ui={<TB icon={Focus} />} name="Focus">
                Spotlights this tile and dims every other one, corner accents and all. Click any
                dimmed tile to exit.
              </Row>
              <Row ui={<TB icon={LayoutGrid} />} name="Tile layout">
                Make this tile wide, tall, or big (2×2) within the grid.
              </Row>
              <Row ui={<TB icon={Maximize2} />} name="Maximize">
                Blow the tile up to fill the canvas; the same button restores it.
              </Row>
              <Row ui={<TB icon={EyeOff} />} name="Hide">
                Hide the tile without stopping it. Bring it back from the workspace's Sessions list
                with <Eye size={12} style={{ verticalAlign: "-2px" }} />.
              </Row>
              <Row
                ui={
                  <span className="tile-btn tile-btn-danger">
                    <X size={14} />
                  </span>
                }
                name="Close"
              >
                Opens a choice: <b>Close</b> just detaches your view (the session keeps running),
                <b> Terminate</b> ends the session and everything in it.
              </Row>
              <Note>
                <b>Close vs Terminate</b> is the important one - Close is always safe and
                reversible, Terminate is not.
              </Note>
            </>
          ),
        },
        {
          id: "focus",
          label: "Focus & attention",
          icon: Focus,
          body: (
            <>
              <Hero caption="Focus · dims every other tile">
                <span className="tile-actions">
                  <TB icon={Moon} on />
                  <TB icon={Focus} on />
                </span>
              </Hero>
              <H>Keeping your eyes on the right tile</H>
              <P>
                Click a tile to make it <b>active</b> - every other tile gets a light grey wash so
                the one you're working in stands out. Only the active tile scrolls or takes
                keystrokes, so moving the mouse over a background agent never steals your scroll or
                types into the wrong place.
              </P>
              <Row ui={<TB icon={Moon} on />} name="Dim (manual)">
                Darken any windows you pick, one by one - independent of focus.
              </Row>
              <Row ui={<TB icon={Focus} on />} name="Focus (spotlight)">
                Darken everything except one. Great when a single agent needs your full attention.
              </Row>
              <Tip>
                Activating a tile with the keyboard (<Kbd>{ctrlBadge(1)}</Kbd>–
                <Kbd>{ctrlBadge(9)}</Kbd>) also scrolls it to the center of the screen.
              </Tip>
            </>
          ),
        },
        {
          id: "workspaces",
          label: "Workspaces",
          icon: Layers,
          body: (
            <>
              <H>Grouping your sessions</H>
              <div className="doc-demo">
                <div className="doc-tabs">
                  <span className="ws-tab ws-tab-active">
                    <LayoutGrid size={13} /> All <kbd className="kbd">{altBadge(0)}</kbd>
                  </span>
                  <span className="ws-tab">
                    <Layers size={13} style={{ color: "#7aa2f7" }} /> Main{" "}
                    <kbd className="kbd">{altBadge(1)}</kbd>
                  </span>
                </div>
              </div>
              <P>
                Browser-style tabs group your sessions into contexts - one project per workspace,
                say. <b>All</b> shows every workspace's tiles at once.
              </P>
              <Row ui={<span className="ws-tab-add-demo">+</span>} name="Add a workspace">
                Give it a name, an icon and a color from the searchable icon picker.
              </Row>
              <Row
                ui={
                  <span className="tile-icon">
                    <SettingsIcon size={14} />
                  </span>
                }
                name="Workspace settings"
              >
                Click the <i>active</i> tab to rename it, change its icon / color, and show or hide
                each of its sessions.
              </Row>
              <Row ui={<MousePointerClick size={15} className="muted-icon" />} name="Move a session">
                Drag a tile's header onto a tab to move it to that workspace (with a confirm).
              </Row>
              <Note>
                Grid columns are stored per workspace, so Main can be 3 columns while another is 2.
              </Note>
            </>
          ),
        },
        {
          id: "layout",
          label: "Layout & grid",
          icon: LayoutGrid,
          body: (
            <>
              <Hero caption="Layout · top bar">
                <IB icon={LayoutGrid} />
              </Hero>
              <H>Sizing the grid</H>
              <P>
                <IB icon={LayoutGrid} /> in the top bar sets 2, 3 or 4 columns for the active
                workspace. Every tile stays mounted when you switch workspaces or resize, so
                terminals never re-attach or garble.
              </P>
              <Row ui={<TB icon={LayoutGrid} />} name="Per-tile size">
                The tile-layout button makes one tile wide, tall, or big within the grid.
              </Row>
              <Row ui={<TB icon={Maximize2} />} name="Maximize">
                Fill the whole canvas with one tile, then restore it.
              </Row>
            </>
          ),
        },
        {
          id: "shortcuts",
          label: "Keyboard shortcuts",
          icon: Keyboard,
          body: (
            <>
              <Hero caption="Activate a tile">
                <Kbd>{ctrlBadge(1)}</Kbd>
                <Kbd>{ctrlBadge(2)}</Kbd>
                <Kbd>{ctrlBadge(3)}</Kbd>
              </Hero>
              <H>Shortcuts</H>
              <table className="doc-keys">
                <tbody>
                  <tr>
                    <td>
                      <Kbd>{altBadge(0)}</Kbd>
                    </td>
                    <td>Switch to the All workspace</td>
                  </tr>
                  <tr>
                    <td>
                      <Kbd>{altBadge(1)}</Kbd> – <Kbd>{altBadge(9)}</Kbd>
                    </td>
                    <td>Switch to the Nth workspace</td>
                  </tr>
                  <tr>
                    <td>
                      <Kbd>{ctrlBadge(1)}</Kbd> – <Kbd>{ctrlBadge(9)}</Kbd>
                    </td>
                    <td>Activate the Nth visible tile (and center it)</td>
                  </tr>
                  <tr>
                    <td>
                      <Kbd>{CMD} V</Kbd>
                    </td>
                    <td>Paste an image into the focused terminal</td>
                  </tr>
                  <tr>
                    <td>
                      <Kbd>Esc</Kbd>
                    </td>
                    <td>Close a modal / cancel an inline rename</td>
                  </tr>
                </tbody>
              </table>
              <Note>On macOS ⌥ is Option and ⌃ is Control; elsewhere they read as Alt and Ctrl.</Note>
            </>
          ),
        },
      ],
    },
    {
      title: "Agents & devices",
      sections: [
        {
          id: "usage",
          label: "Agent usage",
          icon: Gauge,
          body: (
            <>
              <Hero caption="Agent usage · top bar">
                <IB icon={Gauge} />
              </Hero>
              <H>Live usage</H>
              <P>
                <IB icon={Gauge} /> shows each Claude / Codex account on the device with its{" "}
                <b>5-hour</b> and <b>weekly</b> windows, reset countdowns and plan - read live from
                the same usage endpoints the official apps use. Accounts are discovered
                automatically; nothing is configured by hand.
              </P>
              <Row
                ui={
                  <span className="usage-seg">
                    <span className="on">Left</span>
                    <span>Used</span>
                  </span>
                }
                name="Left / Used"
              >
                Toggle whether the bars read how much is <b>left</b> or how much you've <b>used</b>.
                The color always reflects the risk, so a nearly-spent window is red either way.
              </Row>
              <H>Estimated spend</H>
              <P>
                Under each account, <b>Spend</b> estimates today's and the last 30 days' cost in
                USD, computed locally from your Claude / Codex transcripts at published token
                rates. It's an estimate (marked <i>est.</i>), not a bill.
              </P>
            </>
          ),
        },
        {
          id: "multiaccount",
          label: "Multi-account",
          icon: UsersRound,
          body: (
            <>
              <Hero caption="New session · Account picker">
                <span className="doc-mini-select">
                  <UsersRound size={13} /> Default account
                </span>
              </Hero>
              <H>One session, one account</H>
              <P>
                A device can hold several Claude or Codex accounts (each is a config directory like{" "}
                <code className="doc-code">~/.claude</code> or{" "}
                <code className="doc-code">~/.codex-work</code>). When you open a{" "}
                <IB icon={Plus} /> new session, an <b>Account</b> picker lets you choose which one
                it runs under - the session is launched bound to that account's config.
              </P>
              <Tip>
                To add another account, log into it in a terminal with a different config dir (e.g.
                <code className="doc-code">CLAUDE_CONFIG_DIR=~/.claude-work claude</code>). It then
                shows up in the picker automatically.
              </Tip>
            </>
          ),
        },
        {
          id: "devices",
          label: "Devices & the agent",
          icon: HardDrive,
          body: (
            <>
              <Hero caption="Devices · top bar">
                <IB icon={HardDrive} />
              </Hero>
              <H>The agent, per device</H>
              <P>
                A small <b>agent</b> runs on each device and serves its terminals, ports, saved
                state and usage over a loopback API. Your state lives on the device, not only in
                the browser, so it survives clearing site data.
              </P>
              <H>Add a device</H>
              <P>
                The setup wizard (<IB icon={CircleQuestionMark} />-adjacent, and on first run) takes
                the SSH details of a machine you can already reach and installs the agent on it{" "}
                <i>over that connection</i> - you set up SSH, PzzaCode drives the rest.
              </P>
              <H>Scan a device's sessions</H>
              <P>
                In <IB icon={HardDrive} /> Devices, click a device to scan every tmux session on
                it - even leftovers the app never opened. From there you can add one to a
                workspace, move it, or terminate it.
              </P>
            </>
          ),
        },
        {
          id: "paste",
          label: "Image paste",
          icon: ImageIcon,
          body: (
            <>
              <Hero caption="Focused terminal">
                <ImageIcon size={20} className="muted-icon" />
                <Kbd>{CMD} V</Kbd>
              </Hero>
              <H>Paste images to your agent</H>
              <P>
                Press <Kbd>{CMD} V</Kbd> with an image in your clipboard while a terminal is
                focused. The image is uploaded to the device and its file path is typed into the
                terminal, so the coding agent can read it - <b>even over SSH</b>, where a normal
                paste couldn't carry the file.
              </P>
            </>
          ),
        },
        {
          id: "ports",
          label: "Ports",
          icon: EthernetPort,
          body: (
            <>
              <Hero caption="Ports · top bar">
                <IB icon={EthernetPort} />
              </Hero>
              <H>Port forwarding</H>
              <P>
                <IB icon={EthernetPort} /> mirrors the device's listening ports to your machine
                automatically - start a server on the device and it appears on your{" "}
                <code className="doc-code">localhost</code> at the same port. On the device itself
                ports are local; on a client machine the agent forwards them over SSH and you get a
                global enable / disable.
              </P>
              <Note>
                Keeping the origin on <code className="doc-code">localhost</code> also keeps OAuth
                callbacks and cookies working, which a raw LAN address would break.
              </Note>
            </>
          ),
        },
        {
          id: "rdp",
          label: "Remote desktop",
          icon: Monitor,
          body: (
            <>
              <Hero caption="Remote desktop · top bar">
                <IB icon={Monitor} />
              </Hero>
              <H>Linux desktop (RDP)</H>
              <P>
                <IB icon={Monitor} /> opens the device's Linux desktop over an SSH-tunneled RDP
                session, with the password read from your OS keychain at launch - never stored in
                the app.
              </P>
            </>
          ),
        },
        {
          id: "mcp",
          label: "MCP",
          icon: Blocks,
          body: (
            <>
              <Hero caption="MCP · top bar">
                <IB icon={Blocks} />
              </Hero>
              <H>Model Context Protocol</H>
              <P>
                <IB icon={Blocks} /> exposes your sessions and ports to Claude / Codex / Zed /
                Cursor / Windsurf, and can auto-add the server to the CLIs or copy the config for
                editors - so an agent can list and open terminals for you.
              </P>
            </>
          ),
        },
      ],
    },
    {
      title: "More",
      sections: [
        {
          id: "tips",
          label: "Tips",
          icon: Lightbulb,
          body: (
            <>
              <Hero caption="Help · top bar">
                <IB icon={CircleQuestionMark} />
              </Hero>
              <H>Handy to know</H>
              <Tip>Hover almost anything for a tooltip - the icons don't need labels once you know them.</Tip>
              <Tip>
                Renaming a tile or workspace is just a click on its name; press <Kbd>Esc</Kbd> to
                cancel.
              </Tip>
              <Tip>
                Left a stale session running somewhere? Open <IB icon={HardDrive} /> Devices, scan
                the device, and terminate it.
              </Tip>
              <Tip>
                Everything you set - workspaces, layouts, names, hidden tiles - is saved on the
                device by its agent, so it follows you to any browser pointed at that device.
              </Tip>
            </>
          ),
        },
      ],
    },
  ];

  const all = groups.flatMap((g) => g.sections);
  const current = all.find((s) => s.id === active) ?? all[0];

  return (
    <Modal open={open} onClose={onClose} title="Help & docs" icon={CircleQuestionMark} size="xl">
      <div className="doc-layout">
        <nav className="doc-nav">
          {groups.map((g) => (
            <div className="doc-nav-group" key={g.title}>
              <div className="doc-nav-group-title">{g.title}</div>
              {g.sections.map((s) => {
                const Icon = s.icon;
                return (
                  <button
                    key={s.id}
                    className={`doc-nav-item ${active === s.id ? "on" : ""}`}
                    onClick={() => setActive(s.id)}
                  >
                    <Icon size={16} />
                    {s.label}
                  </button>
                );
              })}
            </div>
          ))}
        </nav>
        <div className="doc-content" key={current.id}>
          <div className="doc-title">{current.label}</div>
          {current.body}
        </div>
      </div>
    </Modal>
  );
}
