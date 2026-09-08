import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Download, Loader2, RefreshCw, RotateCw, ServerCog, SlidersHorizontal } from "lucide-react";
import { DEFAULT_TRANSPARENCY_OPTIONS, useStore } from "../state/store";
import { useUpdates } from "../state/updates";
import { HAS_TAURI } from "../tauriEnv";

// Settings dropdown content: agent/devices + terminal.
export function SettingsMenu({ close }: { close?: () => void }) {
  return (
    <div className="menu-body">
      <div className="menu-title">Settings</div>
      <AgentSection close={close} />
      <AppearanceSection />
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

function AppearanceSection() {
  const [optionsOpen, setOptionsOpen] = useState(false);
  const optionsButton = useRef<HTMLButtonElement>(null);
  const optionsMenu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: 0, top: 0 });
  const closeOptions = () => { setOptionsOpen(false); optionsButton.current?.focus(); };
  useLayoutEffect(() => {
    if (!optionsOpen) return;
    const place = () => {
      const button = optionsButton.current?.getBoundingClientRect();
      const menu = optionsMenu.current?.getBoundingClientRect();
      if (!button || !menu) return;
      setPosition({ left: Math.max(12, Math.min(button.right - menu.width, window.innerWidth - menu.width - 12)),
        top: Math.max(12, Math.min(button.bottom + 6, window.innerHeight - menu.height - 12)) });
    };
    place();
    optionsMenu.current?.focus();
    window.addEventListener("resize", place);
    return () => window.removeEventListener("resize", place);
  }, [optionsOpen]);
  const enabled = useStore((state) => state.semiTransparent);
  const options = useStore((state) => state.transparencyOptions);
  const setOptions = useStore((state) => state.setTransparencyOptions);
  const setEnabled = useStore((state) => state.setSemiTransparent);
  const notice = useStore((state) => state.transparencyNotice);
  return <Section title="Appearance">
    <Row label="Semi-transparent mode" hint="Translucent surfaces and a blurred background">
      <button ref={optionsButton} type="button" className={`btn btn-icon btn-sm ${optionsOpen ? "btn-on" : ""}`} title="Transparency settings" aria-label="Transparency settings" aria-haspopup="dialog" aria-expanded={optionsOpen}
        onClick={() => setOptionsOpen(!optionsOpen)}><SlidersHorizontal size={15} /></button>
      <button className={`switch ${enabled ? "switch-on" : ""}`} type="button"
        role="switch" aria-label="Semi-transparent mode" aria-checked={enabled}
        onClick={() => setEnabled(!enabled)}>
        <span className="switch-knob" />
      </button>
    </Row>
    {optionsOpen ? createPortal(<div className="cselect-backdrop pzza-portal" onMouseDown={closeOptions}>
      <div ref={optionsMenu} className="menu transparency-options" style={position} role="dialog" aria-label="Transparency settings" tabIndex={-1}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => { if (event.key === "Escape") { event.stopPropagation(); closeOptions(); } }}>
      <div className="menu-title">Transparency</div>
      <Row label="App background opacity" hint={`${options.opacity}%`}>
        <input aria-label="App background opacity" type="range" min={5} max={95} value={options.opacity}
          onChange={(event) => setOptions({ opacity: Number(event.target.value) })} />
      </Row>
      <Row label="Desktop background blur" hint="Native blur behind the app window">
        <button type="button" className={`switch ${options.desktopBlur ? "switch-on" : ""}`} role="switch"
          aria-label="Desktop background blur" aria-checked={options.desktopBlur} onClick={() => setOptions({ desktopBlur: !options.desktopBlur })}>
          <span className="switch-knob" />
        </button>
      </Row>
      <Row label="Panel background opacity" hint={`${options.surfaceOpacity}% · text stays opaque`}>
        <input aria-label="Panel background opacity" type="range" min={5} max={100} value={options.surfaceOpacity}
          onChange={(event) => setOptions({ surfaceOpacity: Number(event.target.value) })} />
      </Row>
      {/mac/i.test(navigator.platform || navigator.userAgent) ? <Row label="Desktop blur strength" hint={`${options.desktopBlurRadius}px · macOS window background`}>
        <input aria-label="Desktop blur strength" type="range" min={0} max={64} value={options.desktopBlurRadius}
          disabled={!options.desktopBlur} onChange={(event) => setOptions({ desktopBlurRadius: Number(event.target.value) })} />
      </Row> : null}
      <Row label="Panel backdrop blur" hint={options.blur ? `${options.blur}px` : "Blur off"}>
        <input aria-label="Panel backdrop blur" type="range" min={0} max={40} value={options.blur}
          onChange={(event) => setOptions({ blur: Number(event.target.value) })} />
      </Row>
      <Row label="Saturation" hint={`${options.saturation}%`}>
        <input aria-label="Saturation" type="range" min={50} max={180} value={options.saturation}
          onChange={(event) => setOptions({ saturation: Number(event.target.value) })} />
      </Row>
      <div className="set-control">
        <button type="button" className="btn btn-sm" onClick={() => setOptions(DEFAULT_TRANSPARENCY_OPTIONS)}>
          <RotateCw size={13} /> Reset to defaults
        </button>
      </div>
      </div>
    </div>, document.body) : null}
    {enabled && notice ? <p className="set-note" role="status">{notice}</p> : null}
  </Section>;
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
