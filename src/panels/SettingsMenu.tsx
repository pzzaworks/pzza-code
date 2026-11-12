import { AsyncButton } from "../ui/AsyncButton";
import { Bell, Clock, Command, Copy, Download, EthernetPort, EyeOff, FileCode, Folder, FolderInput, FolderSync, Gauge, GitBranch, GitFork, HardDrive, ListTodo, Loader2, Maximize2, MessageSquare, Mic, Monitor, RefreshCw, RotateCw, SquareTerminal, type LucideIcon } from "lucide-react";
import { DEFAULT_TRANSPARENCY_OPTIONS, SPACING_RANGE, useStore } from "../state/store";
import { useUpdates } from "../state/updates";
import { HAS_TAURI } from "../tauriEnv";
import { DICTATION_SUPPORTED, MAX_MY_LANGUAGES, SILENCE_STOP_CHOICES, speechLanguages, useDictation, type SilenceStopSeconds } from "../state/dictation";
import { Slider } from "../ui/Slider";
import { Segmented } from "../ui/Segmented";
import type { TriggerMode } from "../state/keyTrigger";
import { setPushToTalk, setPushToTalkMode, usePushToTalk } from "../state/pushToTalk";
import dictationLicenses from "../dictation-licenses.txt?raw";
import { ThemeSettings } from "./ThemeSettings";
import { PromptSettings } from "./PromptSettings";
import { DictationLanguageSelect, SpeechLanguagesSelect } from "../ui/DictationLanguageSelect";
import type { GeneralSection } from "./settingsSections";
import { Select } from "../ui/Select";
import { useEffect } from "react";
import { confirmAction } from "../ui/ConfirmDialog";
import { SESSION_HEADER_ITEMS, STATUS_BAR_ID, STATUS_BAR_ITEMS, TOP_BAR_ITEMS, type BarItemId } from "../barItems";
import { hasRemoteDevice } from "../devices";

export function SettingsMenu({ section }: { section: GeneralSection }) {
  return (
    <div className="settings-page general-settings">
      {section === "appearance" && <AppearanceSection />}
      {section === "bars" && <BarsSection />}
      {section === "terminal" && <TerminalSection />}
      {section === "prompts" && <PromptSettings />}
      {section === "dictation" && <DictationSection />}
    </div>
  );
}

function DictationSection() {
  const state = useDictation();
  const pushToTalk = usePushToTalk((s) => s.enabled);
  const pushToTalkMode = usePushToTalk((s) => s.mode);
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
      Download · 1.1 GB
    </AsyncButton></Row>}
    {state.model === "ready" && state.enabled ? <div className="dictation-language-setting settings-row">
      <div className="settings-row-copy"><span>Recognition language</span><span className="set-hint">Auto-detect, or choose the language you speak.</span></div>
      <DictationLanguageSelect value={state.language} disabled={state.recording !== null} onChange={state.setLanguage} />
    </div> : null}
    {state.model === "ready" ? <div className="dictation-language-setting settings-row">
      <div className="settings-row-copy"><span>My languages</span><span className="set-hint">{state.myLanguages ? "Detection picks among these, favoring the first (your main language) when unsure." : "From your Mac's languages and region. Detection picks among these; choose your own, main language first, to change them."}</span></div>
      <span style={{ display: "flex", gap: 6, alignItems: "center", minWidth: 0 }}>
        <SpeechLanguagesSelect values={speechLanguages()} max={MAX_MY_LANGUAGES} disabled={state.recording !== null} onChange={state.setMyLanguages} />
        {state.myLanguages ? <button type="button" className="btn btn-sm" disabled={state.recording !== null} onClick={() => state.setMyLanguages(null)}>Use the Mac's</button> : null}
      </span>
    </div> : null}
    {state.model === "ready" && state.enabled ? <Row label="Stop after silence" hint={state.silenceStop ? `Ends dictation after ${state.silenceStop} seconds of quiet once you have spoken. Pauses while you talk never end it; push to talk keeps its own timing.` : "Dictation keeps listening until you stop it."}>
      <Segmented ariaLabel="Stop after silence" value={state.silenceStop} options={SILENCE_STOP_OPTIONS} onChange={state.setSilenceStop} />
    </Row> : null}
    {state.model === "ready" && state.enabled ? <Row label="Push to talk" hint={pushToTalkMode === "tap" ? "Tap Option alone to start dictating into the active terminal; tap again, or pause speaking, to stop. Typing an Option shortcut cancels it." : "Hold Option alone to dictate into the active terminal; release to stop. Typing an Option shortcut cancels it."}>
      <button type="button" className={`switch ${pushToTalk ? "switch-on" : ""}`} role="switch" aria-label="Push to talk" aria-checked={pushToTalk} onClick={() => setPushToTalk(!pushToTalk)}><span className="switch-knob" /></button>
    </Row> : null}
    {state.model === "ready" && state.enabled && pushToTalk ? <Row label="Option key" hint="Hold to talk, or tap to start and stop.">
      <Segmented ariaLabel="Push to talk mode" value={pushToTalkMode} options={TRIGGER_OPTIONS} onChange={setPushToTalkMode} />
    </Row> : null}
    {state.error ? <p className="set-note dictation-error" role="alert">{state.error}</p> : null}
    {state.error && state.model === "ready" ? <button className="btn btn-sm" disabled={state.recording !== null} onClick={() => void state.download(true)}>Re-download model</button> : null}
    <p className="set-note">One download, no subscription or API key. Audio stays on your Mac. Stopping inserts text without submitting it.</p>
    <details className="dictation-licenses settings-disclosure"><summary>Open-source licenses</summary><pre>{dictationLicenses}</pre></details>
  </Section>;
}

const TRIGGER_OPTIONS: readonly { value: TriggerMode; label: string }[] = [{ value: "hold", label: "Hold" }, { value: "tap", label: "Tap" }];
const SILENCE_STOP_OPTIONS: readonly { value: SilenceStopSeconds; label: string }[] = SILENCE_STOP_CHOICES.map((seconds) => ({ value: seconds, label: seconds ? `${seconds} s` : "Off" }));

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
          <button className="btn btn-accent btn-sm" onClick={relaunch} disabled={status.restarting}>
            <RotateCw size={13} strokeWidth={2} />
            {status.restarting ? "Restarting…" : `Restart for ${status.update.version}`}
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
      {status.kind === "ready" && status.error ? <p className="set-note" role="alert">{status.error}</p> : null}
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

function Row({ label, hint, children }: { label: React.ReactNode; hint?: string; children: React.ReactNode }) {
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
  const gray = useStore((state) => state.grayscale);
  const setGray = useStore((state) => state.setGrayscale);
  const spacing = useStore((state) => state.spacing);
  const setSpacing = useStore((state) => state.setSpacing);
  return <Section title="Appearance">
    <div className="appearance-choice"><ThemeSettings /></div>
    <Row label="Grayscale mode" hint="Neutral gray interface; status and terminal colors stay">
      <button className={`switch ${gray ? "switch-on" : ""}`} type="button"
        role="switch" aria-label="Grayscale mode" aria-checked={gray}
        onClick={() => setGray(!gray)}>
        <span className="switch-knob" />
      </button>
    </Row>
    <Row label="Spacing" hint="Room around and between tiles; 0 joins them edge to edge. The mark is the default.">
      <Slider label="Spacing" min={SPACING_RANGE.min} max={SPACING_RANGE.max} unit="px" value={spacing} snap={{ value: SPACING_RANGE.default, within: 1 }} onChange={setSpacing} />
    </Row>
    <Row label="Semi-transparent mode" hint="Translucent surfaces and a blurred background">
      <button className={`switch ${enabled ? "switch-on" : ""}`} type="button"
        role="switch" aria-label="Semi-transparent mode" aria-checked={enabled}
        onClick={() => setEnabled(!enabled)}>
        <span className="switch-knob" />
      </button>
    </Row>
    {/* The mode's main controls stay in view; the fine-tuning folds under More. */}
    {enabled ? <>
      <Row label="Text visibility" hint="Raises text contrast over the background; 100% is maximum. Filled controls keep contrast-safe text.">
        <Slider label="Text visibility" min={0} max={100} value={options.textVisibility} valueText={`${options.textVisibility}% visibility boost`}
          onChange={(value) => setOptions({ textVisibility: value })} />
      </Row>
      <Row label="App background opacity" hint="How solid the window background is">
        <Slider label="App background opacity" min={5} max={95} value={options.opacity} onChange={(value) => setOptions({ opacity: value })} />
      </Row>
      <Row label="Desktop background blur" hint="Native blur behind the app window">
        <button type="button" className={`switch ${options.desktopBlur ? "switch-on" : ""}`} role="switch"
          aria-label="Desktop background blur" aria-checked={options.desktopBlur} onClick={() => setOptions({ desktopBlur: !options.desktopBlur })}>
          <span className="switch-knob" />
        </button>
      </Row>
      <details className="settings-disclosure transparency-details">
        <summary>More transparency controls</summary>
        <div className="settings-disclosure-body">
        <Row label="Panel background opacity" hint="Text stays opaque">
          <Slider label="Panel background opacity" min={5} max={100} value={options.surfaceOpacity} onChange={(value) => setOptions({ surfaceOpacity: value })} />
        </Row>
        {/mac/i.test(navigator.platform || navigator.userAgent) ? <Row label="Desktop blur strength" hint="macOS window background">
          <Slider label="Desktop blur strength" min={0} max={64} value={options.desktopBlurRadius} unit="px" disabled={!options.desktopBlur}
            onChange={(value) => setOptions({ desktopBlurRadius: value })} />
        </Row> : null}
        <Row label="Panel backdrop blur" hint="Blur behind menus and panels">
          <Slider label="Panel backdrop blur" min={0} max={40} value={options.blur} format={(value) => (value ? `${value}px` : "Off")} onChange={(value) => setOptions({ blur: value })} />
        </Row>
        <Row label="Saturation" hint="Color strength behind panels">
          <Slider label="Saturation" min={50} max={180} value={options.saturation} onChange={(value) => setOptions({ saturation: value })} />
        </Row>
        <div className="settings-actions">
          <button type="button" className="btn btn-sm" onClick={() => setOptions(DEFAULT_TRANSPARENCY_OPTIONS)}>
            <RotateCw size={13} /> Reset to defaults
          </button>
        </div>
        </div>
      </details>
    </> : null}
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
          onClick={async () => {
            if (osc52 || await confirmAction({ title: "Allow terminal clipboard writes?", message: "Programs running in your terminals will be able to replace your clipboard using OSC 52. Enable this only for programs you trust.", confirmLabel: "Allow clipboard writes" })) setOsc52(!osc52);
          }}
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

// The icon each menu bar tool or session bar item shows (see barItems).
const BAR_ITEM_ICONS: Record<Exclude<BarItemId, typeof STATUS_BAR_ID>, LucideIcon> = {
  "top:tasks": ListTodo, "top:quick-chat": MessageSquare, "top:sync": FolderSync, "top:remote": Monitor,
  "top:ports": EthernetPort, "top:usage": Gauge, "top:notifications": Bell,
  "header:device": HardDrive, "header:shortcut": Command, "header:mic": Mic, "header:code": FileCode,
  "header:move": FolderInput, "header:duplicate": Copy, "header:fullscreen": Maximize2, "header:hide": EyeOff,
  "status:session": SquareTerminal, "status:git": GitBranch, "status:worktree": GitFork,
  "status:path": Folder, "status:started": Clock,
};

// Settings > General > Menu buttons: one card per bar with a switch for each
// item. New session and Settings always stay in the menu bar, a session's
// title and Close in its top bar. The status bar card's own switch turns the
// whole bar off; its item switches rest disabled meanwhile.
function BarsSection() {
  const remote = useStore((state) => hasRemoteDevice(state.devices));
  const statusBar = useStore((state) => !state.hiddenBarItems.includes(STATUS_BAR_ID));
  const setShown = useStore((state) => state.setBarItemShown);
  return <Section title="Menu buttons">
    <BarItemList title="Menu bar" place="menu bar" hint="New session and Settings always stay." items={TOP_BAR_ITEMS} remote={remote} />
    <BarItemList title="Session top bar" place="session top bar" hint="The title and Close always stay." items={SESSION_HEADER_ITEMS} remote={remote} />
    <BarItemList title="Session status bar" place="status bar" hint="The line under each session." items={STATUS_BAR_ITEMS} remote={remote} disabled={!statusBar}
      control={<button className={`switch ${statusBar ? "switch-on" : ""}`} type="button" role="switch" aria-label="Session status bar" aria-checked={statusBar}
        onClick={() => setShown(STATUS_BAR_ID, !statusBar)}><span className="switch-knob" /></button>} />
  </Section>;
}

function BarItemList({ title, place, hint, items, remote, disabled = false, control }: {
  title: string;
  place: string;
  hint: string;
  items: readonly { id: Exclude<BarItemId, typeof STATUS_BAR_ID>; label: string; needsRemote?: boolean }[];
  remote: boolean;
  disabled?: boolean;
  control?: React.ReactNode;
}) {
  const hidden = useStore((state) => state.hiddenBarItems);
  const setShown = useStore((state) => state.setBarItemShown);
  const group = `${place[0].toUpperCase()}${place.slice(1)} items`;
  return <div className="bar-item-settings">
    <div className="bar-item-settings-head">
      <div className="set-label"><span>{title}</span><span className="set-hint">{hint}</span></div>
      {control}
    </div>
    <div className={`bar-item-list ${disabled ? "is-disabled" : ""}`} role="group" aria-label={group} aria-disabled={disabled || undefined}>
      {items.map((item) => {
        const Icon = BAR_ITEM_ICONS[item.id];
        const shown = !hidden.includes(item.id);
        // Shown or not, Sync and Remote desktop need a remote device to appear.
        const waiting = item.needsRemote && !remote;
        return <div key={item.id} className="bar-item-row">
          <Icon size={15} className="bar-item-icon" aria-hidden="true" />
          <span className="bar-item-label">{item.label}{waiting ? <span className="set-hint">Appears once you add a remote device</span> : null}</span>
          <button className={`switch ${shown ? "switch-on" : ""}`} type="button" role="switch" disabled={disabled}
            aria-label={`Show ${item.label} in the ${place}`} aria-checked={shown} onClick={() => setShown(item.id, !shown)}>
            <span className="switch-knob" />
          </button>
        </div>;
      })}
    </div>
  </div>;
}
