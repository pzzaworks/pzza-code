import { useState, type ReactNode } from "react";
import {
  Blocks,
  Boxes,
  CircleQuestionMark,
  EthernetPort,
  EyeOff,
  Focus,
  Gauge,
  HardDrive,
  Image as ImageIcon,
  Keyboard,
  LayoutGrid,
  Maximize2,
  Monitor,
  Moon,
  Plus,
  Rocket,
  Settings as SettingsIcon,
  Sparkles,
  SquareTerminal,
  Layers,
  X,
  type LucideIcon,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { altBadge, ctrlBadge, IS_MAC } from "../shortcuts";

const CMD = IS_MAC ? "⌘" : "Ctrl";

// --- small building blocks that reuse the app's real classes so the docs show
// the exact UI the user will click ---------------------------------------------
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

// A realistic tile header replica.
const TileHeadDemo = () => (
  <div className="tile-head doc-tilehead">
    <span className="stat stat-active" />
    <span className="tile-icon" style={{ color: "#D97757" }}>
      <Sparkles size={14} />
    </span>
    <span className="tile-title">Claude</span>
    <kbd className="kbd tile-kbd">{ctrlBadge(1)}</kbd>
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

interface Sec {
  id: string;
  label: string;
  icon: LucideIcon;
  body: ReactNode;
}

export function HelpModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [active, setActive] = useState("start");

  const sections: Sec[] = [
    {
      id: "start",
      label: "Getting started",
      icon: Rocket,
      body: (
        <>
          <H>What PzzaCode is</H>
          <P>
            A grid terminal manager for agentic coding. Every tile is a live terminal - a shell
            or a coding agent (Claude Code, Codex). You see and drive all of them from one screen.
          </P>
          <P>
            Tiles are backed by <b>tmux</b> sessions on the device, so closing the app just
            detaches - everything keeps running and comes back exactly where you left it. It runs
            in the browser (talking to a small agent on the device) or as a desktop app.
          </P>
          <H>The shape of the app</H>
          <P>
            The <b>top bar</b> holds the brand, the <b>workspace tabs</b> in the middle, and the
            tool buttons on the right. The rest is the <b>grid</b> of terminal tiles.
          </P>
        </>
      ),
    },
    {
      id: "topbar",
      label: "Top bar",
      icon: LayoutGrid,
      body: (
        <>
          <H>Top-bar tools (right side)</H>
          <Row ui={<IB icon={LayoutGrid} />} name="Layout">
            Grid columns (2/3/4) for the <i>active workspace</i> - each workspace remembers its own.
          </Row>
          <Row ui={<IB icon={Monitor} />} name="Remote desktop">
            Open the device's Linux desktop over an SSH-tunneled RDP session.
          </Row>
          <Row ui={<IB icon={EthernetPort} />} name="Ports">
            Auto-forwarded ports from the device, mirrored to your machine.
          </Row>
          <Row ui={<IB icon={HardDrive} />} name="Devices">
            The machines you've added and their agents.
          </Row>
          <Row ui={<IB icon={Blocks} />} name="MCP">
            Expose your sessions and ports to AI agents.
          </Row>
          <Row ui={<IB icon={Gauge} />} name="Agent usage">
            Live Claude / Codex usage (5h + weekly windows) for the accounts on the device.
          </Row>
          <Row ui={<IB icon={CircleQuestionMark} />} name="Help">
            This page.
          </Row>
          <Row ui={<IB icon={SettingsIcon} />} name="Settings">
            Font size, cursor blink, and other preferences.
          </Row>
          <Row ui={<IB icon={Plus} />} name="New session">
            Open a new terminal as a tile (pick device and workspace).
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
          <H>A tile's header</H>
          <P>Every tile shows this header. Here is exactly what each part is:</P>
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
          <Row ui={<kbd className="kbd tile-kbd">{ctrlBadge(1)}</kbd>} name="Shortcut badge">
            The <Kbd>{ctrlBadge(1)}</Kbd> chip shows the key that activates this tile.
          </Row>
          <Row
            ui={<span className="tile-title" style={{ cursor: "text" }}>Claude</span>}
            name="Title (rename)"
          >
            Click the title to edit it inline. The name is yours - it doesn't touch the tmux
            session.
          </Row>
          <Row ui={<span className="tile-device">Devbox</span>} name="Device / path badges">
            Which device the session runs on and its current folder.
          </Row>
        </>
      ),
    },
    {
      id: "controls",
      label: "Tile controls",
      icon: Boxes,
      body: (
        <>
          <H>The buttons on each tile</H>
          <Row ui={<TB icon={Moon} />} name="Dim">
            Darkens just this one window. Click again to undim.
          </Row>
          <Row ui={<TB icon={Focus} />} name="Focus">
            Spotlights this tile and dims every other one. Click any dimmed tile to exit.
          </Row>
          <Row ui={<TB icon={LayoutGrid} />} name="Tile layout">
            Make this tile wide, tall, or big within the grid.
          </Row>
          <Row ui={<TB icon={Maximize2} />} name="Maximize">
            Blow the tile up to fill the canvas; the button restores it.
          </Row>
          <Row ui={<TB icon={EyeOff} />} name="Hide">
            Hide the tile without stopping it. Bring it back from the workspace's Sessions list.
          </Row>
          <Row
            ui={
              <span className="tile-btn tile-btn-danger">
                <X size={14} />
              </span>
            }
            name="Close"
          >
            Opens a choice: <b>Close</b> just detaches your view (keeps running), <b>Terminate</b>{" "}
            ends the session and everything in it.
          </Row>
        </>
      ),
    },
    {
      id: "focus",
      label: "Focus & attention",
      icon: Focus,
      body: (
        <>
          <H>Keeping your eyes on the right tile</H>
          <P>
            Click a tile to make it <b>active</b> - the others get a light grey wash so the one
            you're on stands out. Only the active tile scrolls or takes keystrokes, so hovering a
            background tile never steals your scroll.
          </P>
          <Row ui={<TB icon={Moon} on />} name="Dim (moon)">
            A manual, per-window darken - independent of anything else.
          </Row>
          <Row ui={<TB icon={Focus} on />} name="Focus">
            Spotlight one, dim the rest. The corner accents of the dimmed tiles darken too.
          </Row>
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
            Browser-style tabs group your sessions. <b>All</b> shows every workspace at once.
          </P>
          <Row ui={<span className="ws-tab-add-demo">+</span>} name="Add a workspace">
            Give it a name, icon and color.
          </Row>
          <P>
            <b>Move a session:</b> drag a tile onto a tab to move it there (with a confirm).{" "}
            <b>Settings:</b> click the active tab to rename it, change icon/color, and show or hide
            its sessions.
          </P>
        </>
      ),
    },
    {
      id: "layout",
      label: "Layout",
      icon: LayoutGrid,
      body: (
        <>
          <H>Grid layout is per-workspace</H>
          <P>
            The <IB icon={LayoutGrid} /> Layout menu sets 2, 3, or 4 columns for the{" "}
            <i>active</i> workspace - each workspace keeps its own. The menu header shows which
            workspace you're changing.
          </P>
          <P>
            Per tile, the <TB icon={LayoutGrid} /> tile-layout button makes one tile wide / tall /
            big, and <TB icon={Maximize2} /> maximizes it.
          </P>
        </>
      ),
    },
    {
      id: "shortcuts",
      label: "Keyboard shortcuts",
      icon: Keyboard,
      body: (
        <>
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
          <P>On macOS ⌥ is Option and ⌃ is Control.</P>
        </>
      ),
    },
    {
      id: "paste",
      label: "Image paste",
      icon: ImageIcon,
      body: (
        <>
          <H>Paste images to your agent</H>
          <P>
            Press <Kbd>{CMD} V</Kbd> with an image in your clipboard while a terminal is focused.
            The image is uploaded to the device and its file path is typed into the terminal, so
            the coding agent can read it - even over SSH.
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
          <H>Port forwarding</H>
          <P>
            The <IB icon={EthernetPort} /> Ports menu mirrors the device's listening ports to your
            machine automatically. On the device itself ports are local; on a client machine the
            agent forwards them over SSH, and you get a global enable/disable.
          </P>
        </>
      ),
    },
    {
      id: "rdp",
      label: "Remote desktop",
      icon: Monitor,
      body: (
        <>
          <H>Linux desktop (RDP)</H>
          <P>
            The <IB icon={Monitor} /> menu opens the device's Linux desktop over an SSH-tunneled
            RDP session.
          </P>
        </>
      ),
    },
    {
      id: "devices",
      label: "Devices & agent",
      icon: HardDrive,
      body: (
        <>
          <H>The agent, per device</H>
          <P>
            A small <b>agent</b> runs on each device and serves its terminals, ports, saved state
            and usage. State lives on the device, not just your browser.
          </P>
          <P>
            <b>Add a device</b> from the setup wizard: give it the SSH details of a machine you can
            already reach, and the agent installs itself there over that connection. You handle
            SSH; PzzaCode does the rest.
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
          <H>Model Context Protocol</H>
          <P>
            The <IB icon={Blocks} /> MCP menu exposes your sessions and ports to Claude / Codex /
            Zed / Cursor / Windsurf, and can auto-add it to the CLIs or copy the config.
          </P>
        </>
      ),
    },
    {
      id: "usage",
      label: "Agent usage",
      icon: Gauge,
      body: (
        <>
          <H>Live usage</H>
          <P>
            The <IB icon={Gauge} /> Usage menu shows each Claude / Codex account on the device with
            its 5-hour and weekly windows, reset countdowns, and plan - read live from the same
            usage the official apps show.
          </P>
        </>
      ),
    },
  ];

  const current = sections.find((s) => s.id === active) ?? sections[0];

  return (
    <Modal open={open} onClose={onClose} title="Help & docs" icon={CircleQuestionMark} size="xl">
      <div className="doc-layout">
        <nav className="doc-nav">
          {sections.map((s) => {
            const Icon = s.icon;
            return (
              <button
                key={s.id}
                className={`doc-nav-item ${active === s.id ? "on" : ""}`}
                onClick={() => setActive(s.id)}
              >
                <Icon size={14} />
                {s.label}
              </button>
            );
          })}
        </nav>
        <div className="doc-content" key={current.id}>
          <div className="doc-title">{current.label}</div>
          {current.body}
        </div>
      </div>
    </Modal>
  );
}
