import { AsyncButton } from "../ui/AsyncButton";
import { Download, Loader2, RefreshCw, RotateCw, ServerCog } from "lucide-react";
import { DEFAULT_TRANSPARENCY_OPTIONS, useStore } from "../state/store";
import { useUpdates } from "../state/updates";
import { HAS_TAURI } from "../tauriEnv";
import { DICTATION_SUPPORTED, useDictation } from "../state/dictation";
import dictationLicenses from "../dictation-licenses.txt?raw";
import { ThemeSettings } from "./ThemeSettings";
import { DictationLanguageSelect } from "../ui/DictationLanguageSelect";
import { Select } from "../ui/Select";
import { useEffect } from "react";

export const generalSections = [
  { id: "appearance", label: "Appearance" },
  { id: "terminal", label: "Terminal" },
  ...(DICTATION_SUPPORTED ? [{ id: "dictation" as const, label: "Dictation" }] : []),
] as const;
export type GeneralSection = "appearance" | "terminal" | "dictation";
export function SettingsMenu({ section }: { section: GeneralSection }) {
  return (
    <div className="settings-page general-settings">
      {section === "appearance" && <AppearanceSection />}
      {section === "terminal" && <TerminalSection />}
      {section === "dictation" && <DictationSection />}
    </div>
  );
}

function DictationSection() {
  const state = useDictation();
  useEffect(() => {
    const refresh = () => { void useDictation.getState().refreshInputDevices(); };
    refresh();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, []);
  if (!DICTATION_SUPPORTED) return null;
  const progress = state.totalBytes ? Math.min(100, Math.round(state.downloadedBytes / state.totalBytes * 100)) : 0;
  const defaultInput = state.inputDevices.find((device) => device.isDefault);
  const missingInput = state.inputDevice && !state.inputDevicesLoading && !state.inputDevicesError && !state.inputDevices.some((device) => device.id === state.inputDevice?.id);
  const inputOptions = [
    { value: "", label: "System default", sub: defaultInput?.name ?? "Follow the macOS input setting" },
    ...state.inputDevices.map((device) => ({ value: device.id, label: device.name, sub: device.isDefault ? "Current system default" : undefined })),
    ...(state.inputDevice && !state.inputDevices.some((device) => device.id === state.inputDevice?.id)
      ? [{ value: state.inputDevice.id, label: state.inputDevice.name, sub: missingInput ? "Unavailable - reconnect or choose another microphone" : "Saved microphone" }] : []),
  ];
  return <Section title="Voice dictation">
    <div className="dictation-language-setting settings-row">
      <div className="settings-row-copy"><span>Microphone input</span><span className="set-hint">{state.recording ? "Stop dictation before changing the microphone." : state.inputDevicesLoading ? "Finding microphones…" : "Choose an input for voice dictation on this Mac."}</span></div>
      <Select value={state.inputDevice?.id ?? ""} options={inputOptions} ariaLabel="Microphone input" disabled={state.recording !== null}
        onOpen={() => void state.refreshInputDevices()} onChange={(id) => state.setInputDevice(id || null)} />
    </div>
    {state.inputDevicesError ? <p className="set-note dictation-error" role="alert">{state.inputDevicesError} <button type="button" className="btn btn-sm" onClick={() => void state.refreshInputDevices()}>Retry</button></p> : null}
    {missingInput ? <p className="set-note dictation-error" role="alert">The saved microphone is unavailable. Reconnect it or choose another input.</p> : null}
    {state.model === "ready" ? <Row label="Enable dictation" hint={state.warming ? "Warming up the model…" : "A microphone button appears on each terminal"}>
      <button type="button" className={`switch ${state.enabled ? "switch-on" : ""}`} role="switch" aria-label="Enable dictation" aria-checked={state.enabled} onClick={() => state.setEnabled(!state.enabled)}><span className="switch-knob" /></button>
    </Row> : state.model === "downloading" ? <div className="dictation-download" role="status">
      <span><Loader2 size={13} className="sw-spin" /> Downloading model · {progress}%</span>
      <progress aria-label="Speech model download" value={state.downloadedBytes} max={state.totalBytes} />
      <small>You can close Settings while this finishes.</small>
    </div> : <Row label="Speech recognition model" hint="Download once to enable dictation on this Mac."><AsyncButton className="btn btn-sm" loading={state.model === "checking"} icon={Download} onClick={() => void state.download()}>
      Download · 574 MB
    </AsyncButton></Row>}
    {state.model === "ready" && state.enabled ? <div className="dictation-language-setting settings-row">
      <div className="settings-row-copy"><span>Recognition language</span><span className="set-hint">Auto-detect, or choose the language you speak.</span></div>
      <DictationLanguageSelect value={state.language} disabled={state.recording !== null} onChange={state.setLanguage} />
    </div> : null}
    {state.error ? <p className="set-note dictation-error" role="alert">{state.error}</p> : null}
    {state.error && state.model === "ready" ? <button className="btn btn-sm" disabled={state.recording !== null} onClick={() => void state.download(true)}>Re-download model</button> : null}
    <p className="set-note">One download, no subscription or API key. Audio stays on your Mac. Stopping inserts text without submitting it.</p>
    <details className="dictation-licenses settings-disclosure"><summary>Open-source licenses</summary><pre>{dictationLicenses}</pre></details>
  </Section>;
}

// Reopen the setup wizard (local agent health + add remote devices). The wizard
// itself lives at the app root; the store flag lets any menu raise it.
export function DeviceSetupSection({ close }: { close?: () => void }) {
  const setWizardOpen = useStore((s) => s.setWizardOpen);
  return (
    <Section title="Device setup">
      <Row label="Set up a device" hint="Check your local agent or connect a remote device."><button
        className="btn btn-accent btn-sm"
        onClick={() => {
          setWizardOpen(true);
          close?.();
        }}
      >
        <ServerCog size={14} strokeWidth={2} />
        Open setup wizard
      </button></Row>
    </Section>
  );
}

// Update controls on top of the shared update state: manual check / install /
// restart, plus the automatic-updates switch.
export function UpdatesSection() {
  const status = useUpdates((s) => s.status);
  const autoUpdate = useUpdates((s) => s.autoUpdate);
  const setAutoUpdate = useUpdates((s) => s.setAutoUpdate);
  const check = useUpdates((s) => s.check);
  const install = useUpdates((s) => s.install);
  const relaunch = useUpdates((s) => s.relaunch);

  if (!HAS_TAURI) return null;
  return (
    <Section title="Updates">
      <Row label="Software updates" hint="Check for the latest release.">
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
          <AsyncButton className="btn btn-sm" onClick={() => check(true)} loading={status.kind === "checking"} icon={RefreshCw} iconSize={13}>
            Check for updates
          </AsyncButton>
        )}
      </Row>
      <Row label="Automatic updates" hint="Install new releases in the background, restart when you like">
        <button
          className={`switch ${autoUpdate ? "switch-on" : ""}`}
          onClick={() => setAutoUpdate(!autoUpdate)}
          role="switch"
          aria-label="Automatic updates"
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
    <section className="set-section settings-section" aria-label={title}>
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
  const enabled = useStore((state) => state.semiTransparent);
  const options = useStore((state) => state.transparencyOptions);
  const setOptions = useStore((state) => state.setTransparencyOptions);
  const setEnabled = useStore((state) => state.setSemiTransparent);
  const notice = useStore((state) => state.transparencyNotice);
  return <Section title="Appearance">
    <div className="appearance-choice"><ThemeSettings /></div>
    <Row label="Semi-transparent mode" hint="Translucent surfaces and a blurred background">
      <button className={`switch ${enabled ? "switch-on" : ""}`} type="button"
        role="switch" aria-label="Semi-transparent mode" aria-checked={enabled}
        onClick={() => setEnabled(!enabled)}>
        <span className="switch-knob" />
      </button>
    </Row>
    <details className="settings-disclosure transparency-details">
      <summary>Transparency controls</summary>
      <div className="settings-disclosure-body">
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
      <div className="settings-actions">
        <button type="button" className="btn btn-sm" onClick={() => setOptions(DEFAULT_TRANSPARENCY_OPTIONS)}>
          <RotateCw size={13} /> Reset to defaults
        </button>
      </div>
      </div>
    </details>
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
      <div className="terminal-type-preview" aria-label="Terminal font preview" style={{ fontSize }}>
        <span>Aa Bb Cc 0123456789</span><span className={`terminal-preview-cursor ${cursorBlink ? "blink" : ""}`} aria-hidden="true" />
        <small>Terminal text · {fontSize}px</small>
      </div>
      <Row label="Font size" hint="Applies to every terminal.">
        <div className="stepper">
          <button aria-label="Decrease terminal font size" onClick={() => setFontSize(fontSize - 1)}>−</button>
          <span className="stepper-val">{fontSize}px</span>
          <button aria-label="Increase terminal font size" onClick={() => setFontSize(fontSize + 1)}>+</button>
        </div>
      </Row>
      <Row label="Cursor blink" hint="Animate the active terminal cursor.">
        <button
          className={`switch ${cursorBlink ? "switch-on" : ""}`}
          onClick={() => setCursorBlink(!cursorBlink)}
          role="switch"
          aria-label="Cursor blink"
          aria-checked={cursorBlink}
        >
          <span className="switch-knob" />
        </button>
      </Row>
      <Row label="Programs may set clipboard" hint="Allow clipboard writes through OSC 52. Enable only for trusted programs.">
        <button
          className={`switch ${osc52 ? "switch-on" : ""}`}
          onClick={() => setOsc52(!osc52)}
          role="switch"
          aria-label="Programs may set clipboard"
          aria-checked={osc52}
        >
          <span className="switch-knob" />
        </button>
      </Row>
    </Section>
  );
}
