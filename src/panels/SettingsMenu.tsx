import { ServerCog } from "lucide-react";
import { useStore } from "../state/store";

// Settings dropdown content: agent/devices + terminal.
export function SettingsMenu({ close }: { close?: () => void }) {
  return (
    <div className="menu-body">
      <div className="menu-title">Settings</div>
      <AgentSection close={close} />
      <TerminalSection />
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
    </Section>
  );
}
