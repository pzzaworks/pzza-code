import { Download, Loader2, RefreshCw, RotateCw, ServerCog } from "lucide-react";
import { useStore } from "../state/store";
import { useUpdates } from "../state/updates";
import { HAS_TAURI } from "../tauriEnv";

// Settings dropdown content: agent/devices + terminal.
export function SettingsMenu({ close }: { close?: () => void }) {
  return (
    <div className="menu-body">
      <div className="menu-title">Settings</div>
      <AgentSection close={close} />
      <TerminalSection />
      <UpdatesSection />
    </div>
  );
}

// Reopen the setup wizard (local agent health + add remote devices). The wizard
// itself lives at the app root; the store flag lets any menu raise it.
function AgentSection({ close }: { close?: () => void }) {
  const setWizardOpen = useStore((s) => s.setWizardOpen);
  return (
    <Section title="Agent & devices">
      <button
        className="btn btn-accent set-full-btn"
        onClick={() => {
          setWizardOpen(true);
          close?.();
        }}
      >
        <ServerCog size={14} strokeWidth={2} />
        Open setup wizard
      </button>
    </Section>
  );
}

// Update controls on top of the shared update state: manual check / install /
// restart, plus the automatic-updates switch.
function UpdatesSection() {
  const status = useUpdates((s) => s.status);
  const autoUpdate = useUpdates((s) => s.autoUpdate);
  const setAutoUpdate = useUpdates((s) => s.setAutoUpdate);
  const check = useUpdates((s) => s.check);
  const install = useUpdates((s) => s.install);
  const relaunch = useUpdates((s) => s.relaunch);

  if (!HAS_TAURI) return null;
  return (
    <Section title="Updates">
      <Row label={`Version ${__APP_VERSION__}`} hint="from GitHub Releases">
        {status.kind === "available" ? (
          <button className="btn btn-accent btn-sm" onClick={install}>
            <Download size={13} strokeWidth={2} />
            Update to {status.update.version}
          </button>
        ) : status.kind === "installing" ? (
          <span className="set-hint">
            {status.pct < 1 ? `Downloading ${Math.round(status.pct * 100)}%` : "Installing…"}
          </span>
        ) : status.kind === "ready" ? (
          <button className="btn btn-accent btn-sm" onClick={relaunch}>
            <RotateCw size={13} strokeWidth={2} />
            Restart for {status.update.version}
          </button>
        ) : (
          <button className="btn btn-sm" onClick={() => check(true)} disabled={status.kind === "checking"}>
            {status.kind === "checking" ? <Loader2 size={13} className="sw-spin" /> : <RefreshCw size={13} />}
            Check for updates
          </button>
        )}
      </Row>
      <Row label="Automatic updates" hint="Install new releases in the background, restart when you like">
        <button
          className={`switch ${autoUpdate ? "switch-on" : ""}`}
          onClick={() => setAutoUpdate(!autoUpdate)}
          role="switch"
          aria-checked={autoUpdate}
        >
          <span className="switch-knob" />
        </button>
      </Row>
      {status.kind === "latest" ? <p className="set-note">You are on the latest version.</p> : null}
      {status.kind === "error" ? <p className="set-note">{status.msg}</p> : null}
    </Section>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="set-section">
      <h3 className="set-title">{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="set-row">
      <div className="set-label">
        <span>{label}</span>
        {hint ? <span className="set-hint">{hint}</span> : null}
      </div>
      <div className="set-control">{children}</div>
    </div>
  );
}

function TerminalSection() {
  const fontSize = useStore((s) => s.fontSize);
  const setFontSize = useStore((s) => s.setFontSize);
  const cursorBlink = useStore((s) => s.cursorBlink);
  const setCursorBlink = useStore((s) => s.setCursorBlink);
  const osc52 = useStore((s) => s.osc52Clipboard);
  const setOsc52 = useStore((s) => s.setOsc52Clipboard);
  return (
    <Section title="Terminal">
      <Row label="Font size">
        <div className="stepper">
          <button onClick={() => setFontSize(fontSize - 1)}>−</button>
          <span className="stepper-val">{fontSize}px</span>
          <button onClick={() => setFontSize(fontSize + 1)}>+</button>
        </div>
      </Row>
      <Row label="Cursor blink">
        <button
          className={`switch ${cursorBlink ? "switch-on" : ""}`}
          onClick={() => setCursorBlink(!cursorBlink)}
          role="switch"
          aria-checked={cursorBlink}
        >
          <span className="switch-knob" />
        </button>
      </Row>
      <Row label="Programs may set clipboard" hint="OSC 52 - off by default, output is untrusted">
        <button
          className={`switch ${osc52 ? "switch-on" : ""}`}
          onClick={() => setOsc52(!osc52)}
          role="switch"
          aria-checked={osc52}
        >
          <span className="switch-knob" />
        </button>
      </Row>
    </Section>
  );
}
