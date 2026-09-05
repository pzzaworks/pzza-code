import { useState } from "react";
import { Download, Loader2, RefreshCw, ServerCog } from "lucide-react";
import { useStore } from "../state/store";
import { HAS_TAURI } from "../tauriEnv";
import { checkForUpdate, relaunchApp, type AvailableUpdate } from "../updater";

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

// Manual update check (the app also checks quietly on launch and every few
// hours). Installs and relaunches on confirmation.
function UpdatesSection() {
  const [state, setState] = useState<
    | { kind: "idle" }
    | { kind: "checking" }
    | { kind: "latest"; version: string }
    | { kind: "available"; update: AvailableUpdate }
    | { kind: "installing"; pct: number }
    | { kind: "error"; msg: string }
  >({ kind: "idle" });

  const check = async () => {
    setState({ kind: "checking" });
    try {
      const u = await checkForUpdate();
      setState(u ? { kind: "available", update: u } : { kind: "latest", version: __APP_VERSION__ });
    } catch (e) {
      setState({ kind: "error", msg: String((e as Error)?.message || e) });
    }
  };
  const install = async (u: AvailableUpdate) => {
    setState({ kind: "installing", pct: 0 });
    try {
      await u.install((f) => setState({ kind: "installing", pct: f }));
      await relaunchApp();
    } catch (e) {
      setState({ kind: "error", msg: String((e as Error)?.message || e) });
    }
  };

  if (!HAS_TAURI) return null;
  return (
    <Section title="Updates">
      <Row label={`Version ${__APP_VERSION__}`} hint="from GitHub Releases, signed">
        {state.kind === "available" ? (
          <button className="btn btn-accent btn-sm" onClick={() => install(state.update)}>
            <Download size={13} strokeWidth={2} />
            Update to {state.update.version}
          </button>
        ) : state.kind === "installing" ? (
          <span className="set-hint">
            {state.pct < 1 ? `Downloading ${Math.round(state.pct * 100)}%` : "Installing…"}
          </span>
        ) : (
          <button className="btn btn-sm" onClick={check} disabled={state.kind === "checking"}>
            {state.kind === "checking" ? <Loader2 size={13} className="sw-spin" /> : <RefreshCw size={13} />}
            Check for updates
          </button>
        )}
      </Row>
      {state.kind === "latest" ? <p className="set-note">You are on the latest version.</p> : null}
      {state.kind === "error" ? <p className="set-note">{state.msg}</p> : null}
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
