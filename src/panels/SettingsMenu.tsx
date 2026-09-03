import { useState } from "react";
import { useStore } from "../state/store";
import { HAS_TAURI } from "../tauriEnv";

// Settings dropdown content: terminal + connection.
export function SettingsMenu() {
  return (
    <div className="menu-body">
      <div className="menu-title">Settings</div>
      <TerminalSection />
      <ConnectionSection />
    </div>
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

function ConnectionSection() {
  const connection = useStore((s) => s.connection);
  const setHost = useStore((s) => s.setHost);
  const [port, setPort] = useState(() => {
    try {
      return localStorage.getItem("pzza.serverPort") ?? "5190";
    } catch {
      return "5190";
    }
  });
  const savePort = (v: string) => {
    setPort(v);
    try {
      localStorage.setItem("pzza.serverPort", v);
    } catch {
      /* ignore */
    }
  };

  return (
    <Section title="Connection">
      {HAS_TAURI ? (
        <Row label="Devbox host" hint="ssh Host alias, or blank for local">
          <input
            className="set-input"
            value={connection.host ?? ""}
            placeholder="devbox"
            onChange={(e) => setHost(e.target.value.trim() || null)}
          />
        </Row>
      ) : (
        <Row label="Server port" hint="reload to apply">
          <input
            className="set-input"
            value={port}
            onChange={(e) => savePort(e.target.value.replace(/[^0-9]/g, ""))}
          />
        </Row>
      )}
    </Section>
  );
}
