import { useCallback, useEffect, useState, type ReactNode } from "react";
import {
  Accessibility, Beer, Check, ChevronDown, ExternalLink, HardDrive, Hexagon, Laptop, Loader2, LockOpen,
  Mic, MonitorUp, RotateCcw, SquareTerminal, Workflow, X, type LucideIcon,
} from "lucide-react";
import { restartMessage, usePermissionControls, type PermissionControls } from "../panels/Permissions";
import { PERMISSIONS, PERMISSIONS_SUPPORTED, type PermissionId, type PermissionStatus, type SetupItem } from "../state/permissions";
import { installRequirement, refreshSetup, useSetup } from "../state/setup";
import { fetchDoctor, SERVER_HTTP, type Doctor } from "../serverApi";
import { IS_MAC, NEW_SESSION_SHORTCUT } from "../shortcuts";

// The setup part of the onboarding tour: agent health, macOS permissions and
// requirements for this machine, then a closing summary. Everything re-checks
// when the window regains focus, which is how the user comes back from
// Terminal or System Settings.

type Tone = "ok" | "busy" | "action" | "fail" | "neutral";

function Pill({ tone, children }: { tone: Tone; children: ReactNode }) {
  return <span className={`tour-pill tour-pill-${tone}`}>
    {tone === "busy" ? <Loader2 size={11} className="sw-spin" aria-hidden="true" /> : null}
    {children}
  </span>;
}

interface RowProps {
  icon: LucideIcon;
  label: string;
  detail?: ReactNode;
  hint?: string;
  hintTone?: "muted" | "fail";
  pill: { tone: Tone; text: string };
  action?: ReactNode;
}

function SetupRow({ icon: Icon, label, detail, hint, hintTone = "muted", pill, action }: RowProps) {
  return <li className="tour-row">
    <span className="tour-row-icon" aria-hidden="true"><Icon size={15} strokeWidth={1.9} /></span>
    <div className="tour-row-copy">
      <span className="tour-row-label">{label}</span>
      {detail ? <span className="tour-row-detail">{detail}</span> : null}
      {hint ? <span className={`tour-row-hint tour-row-hint-${hintTone}`}>{hint}</span> : null}
    </div>
    <div className="tour-row-side">
      <Pill tone={pill.tone}>{pill.text}</Pill>
      {action}
    </div>
  </li>;
}

function SmallButton({ primary = false, loading = false, icon: Icon, disabled, onClick, children }: { primary?: boolean; loading?: boolean; icon?: LucideIcon; disabled?: boolean; onClick: () => void; children: ReactNode }) {
  return <button type="button" className={`btn btn-sm ${primary ? "btn-accent" : ""}`} disabled={disabled || loading} aria-busy={loading || undefined} onClick={onClick}>
    {loading ? <Loader2 size={12} className="sw-spin" aria-hidden="true" /> : Icon ? <Icon size={12} aria-hidden="true" /> : null}
    {children}
  </button>;
}

// Re-runs a check whenever the window comes back into focus.
function useFocusRecheck(recheck: () => void): void {
  useEffect(() => {
    const onReturn = () => { if (document.visibilityState === "visible") recheck(); };
    window.addEventListener("focus", onReturn);
    document.addEventListener("visibilitychange", onReturn);
    return () => {
      window.removeEventListener("focus", onReturn);
      document.removeEventListener("visibilitychange", onReturn);
    };
  }, [recheck]);
}

// The local agent's /doctor report. A missing agent is null, not an error:
// on a fresh Mac it starts only after Node.js is installed.
function useDoctor(): { doctor: Doctor | null; loading: boolean } {
  const [doctor, setDoctor] = useState<Doctor | null>(null);
  const [loading, setLoading] = useState(true);
  const agentRunning = useSetup(state => state.status?.agentRunning);
  const check = useCallback(() => {
    fetchDoctor().then(setDoctor, () => setDoctor(null)).finally(() => setLoading(false));
  }, []);
  useEffect(check, [check, agentRunning]);
  useFocusRecheck(check);
  return { doctor, loading };
}

const recheckAll = () => { void refreshSetup(); };
const MACHINE = PERMISSIONS_SUPPORTED ? "This Mac" : "This device";

/** This machine's agent, storage and terminal backend, with details on demand. */
export function SetupHealth() {
  const { doctor, loading } = useDoctor();
  const nodeMissing = useSetup(state => PERMISSIONS_SUPPORTED && !!state.status && !state.status.node);
  const [expanded, setExpanded] = useState(false);
  useEffect(recheckAll, []);
  useFocusRecheck(recheckAll);

  const checks = doctor ? [
    { label: "Agent", value: `${SERVER_HTTP.replace(/^https?:\/\//, "")} · ${doctor.role}${doctor.host ? ` -> ${doctor.host}` : ""}`, ok: true },
    { label: "Storage", value: doctor.stateWritable ? doctor.stateDir : `${doctor.stateDir} is not writable`, ok: doctor.stateWritable },
    { label: "Terminal backend", value: doctor.nodePty ? "node-pty ready" : "native binding failed", ok: doctor.nodePty },
  ] : [];
  const healthy = checks.length > 0 && checks.every(check => check.ok);
  // A problem is never hidden behind the disclosure.
  const open = expanded || (checks.length > 0 && !healthy);
  const summary: { label: string; detail: string; pill: { tone: Tone; text: string } } = loading
    ? { label: `Checking ${MACHINE.toLowerCase()}`, detail: "Agent, storage and terminal backend", pill: { tone: "busy", text: "Checking" } }
    : healthy ? { label: `${MACHINE} is ready`, detail: "Agent, storage and terminal backend are working.", pill: { tone: "ok", text: "Ready" } }
    : doctor ? { label: `${MACHINE} needs attention`, detail: "One of the checks below failed.", pill: { tone: "action", text: "Needs action" } }
    : nodeMissing ? { label: "The agent starts after Node.js", detail: "Node.js is missing. PzzaCode installs it in a moment and starts the agent.", pill: { tone: "busy", text: "Waiting" } }
    : { label: "The agent is not running", detail: `Nothing answers on ${SERVER_HTTP}. Start it on this machine, or install it on another one from Settings > Devices.`, pill: { tone: "fail", text: "Offline" } };

  return <div className="tour-welcome">
    <div className={`tour-health ${open ? "is-open" : ""}`}>
      <div className="tour-health-summary">
        <span className="tour-row-icon" aria-hidden="true"><Laptop size={15} strokeWidth={1.9} /></span>
        <div className="tour-row-copy">
          <span className="tour-row-label">{summary.label}</span>
          <span className="tour-row-detail">{summary.detail}</span>
        </div>
        <div className="tour-row-side">
          <Pill tone={summary.pill.tone}>{summary.pill.text}</Pill>
          {checks.length ? <button type="button" className="tour-disclosure" aria-expanded={open} aria-label="Health details" disabled={!healthy} onClick={() => setExpanded(value => !value)}>
            <ChevronDown size={14} aria-hidden="true" />
          </button> : null}
        </div>
      </div>
      {open ? <dl className="tour-health-checks">
        {checks.map(check => <div key={check.label} className="tour-health-check">
          {check.ok ? <Check size={12} className="sw-ok" aria-hidden="true" /> : <X size={12} className="sw-fail" aria-hidden="true" />}
          <dt>{check.label}</dt>
          <dd title={check.value}>{check.value}</dd>
        </div>)}
      </dl> : null}
    </div>
  </div>;
}

const PERMISSION_ICONS: Record<PermissionId, LucideIcon> = {
  fullDiskAccess: HardDrive, microphone: Mic, screenRecording: MonitorUp, accessibility: Accessibility, automation: Workflow,
  tmuxFullDiskAccess: HardDrive, tmuxAccessibility: Accessibility, tmuxScreenRecording: MonitorUp,
};
const PERMISSION_PILLS: Record<PermissionStatus, { tone: Tone; text: string }> = {
  granted: { tone: "ok", text: "Allowed" },
  notGranted: { tone: "action", text: "Not allowed" },
  denied: { tone: "fail", text: "Denied" },
  unknown: { tone: "neutral", text: "Not checked" },
};

/** Both permission groups, or with `only` a single one without its own heading (Settings → Setup frames each group itself). Pass `controls` to share one status source with the caller. */
export function SetupPermissions({ only, controls }: { only?: "app" | "tmux"; controls?: PermissionControls } = {}) {
  return controls ? <PermissionGroups only={only} controls={controls} /> : <OwnPermissionGroups only={only} />;
}

function OwnPermissionGroups({ only }: { only?: "app" | "tmux" }) {
  return <PermissionGroups only={only} controls={usePermissionControls()} />;
}

function PermissionGroups({ only, controls }: { only?: "app" | "tmux"; controls: PermissionControls }) {
  const { statuses, busy, error, allow, openSettings, restartNeeded, restarting, restart } = controls;
  const group = (subject: "app" | "tmux", title: string, note: string) => {
    const items = PERMISSIONS.filter(item => item.subject === subject);
    const allowed = items.filter(item => statuses[item.id] === "granted").length;
    return <section className="tour-group" aria-label={`${title} permissions`}>
      {only ? null : <div className="tour-group-head">
        <span className="tour-group-title">{title}</span>
        <span className="tour-group-meta">{allowed} of {items.length} allowed</span>
      </div>}
      <p className="tour-group-note">{note}</p>
      <ul className="tour-list">
        {items.map(({ id, label, short }) => {
          const status = statuses[id];
          const others = busy !== null && busy !== id;
          return <SetupRow key={id} icon={PERMISSION_ICONS[id]} label={label} detail={short}
            pill={status ? PERMISSION_PILLS[status] : { tone: "busy", text: "Checking" }}
            action={status === "granted" ? null : status === "denied"
              ? <SmallButton icon={ExternalLink} loading={busy === id} disabled={others} onClick={() => openSettings(id)}>Open Settings</SmallButton>
              : <SmallButton primary icon={LockOpen} loading={busy === id} disabled={!status || others} onClick={() => allow(id)}>Allow</SmallButton>} />;
        })}
      </ul>
    </section>;
  };
  return <div className="tour-stack">
    {only !== "tmux" ? group("app", "PzzaCode", "Every shell, agent and tool you start here runs as PzzaCode.") : null}
    {only !== "app" ? group("tmux", "tmux", "Only these lists accept command-line tools. Allow tmux again after a Homebrew upgrade.") : null}
    {error ? <p className="tour-callout tour-callout-fail" role="alert">{error}</p> : null}
    {restartNeeded.length ? <div className="tour-callout" role="status">
      <span>{restartMessage(restartNeeded)}</span>
      <SmallButton icon={RotateCcw} loading={restarting} onClick={restart}>Restart</SmallButton>
    </div> : null}
  </div>;
}

const AGENT_NAMES: Record<string, string> = { claude: "Claude Code", codex: "Codex", opencode: "OpenCode" };

function Checking({ label }: { label: string }) {
  return <ul className="tour-list"><SetupRow icon={Laptop} label={label} pill={{ tone: "busy", text: "Checking" }} /></ul>;
}

export function SetupRequirements() {
  const { doctor, loading } = useDoctor();
  const { status, checked, busy, errors, attempted } = useSetup();
  useEffect(recheckAll, []);
  useFocusRecheck(recheckAll);
  // Homebrew installs in Terminal; keep looking for it until it shows up.
  const waitingForHomebrew = PERMISSIONS_SUPPORTED && checked && !status?.homebrew;
  useEffect(() => {
    if (!waitingForHomebrew) return;
    const poll = window.setInterval(recheckAll, 4000);
    return () => window.clearInterval(poll);
  }, [waitingForHomebrew]);

  if (!PERMISSIONS_SUPPORTED) {
    if (loading) return <Checking label="Looking for tmux" />;
    return <ul className="tour-list">
      <SetupRow icon={SquareTerminal} label="tmux" detail={doctor?.tmux ?? "Keeps terminals running when you close the app"}
        hint={doctor?.tmux ? undefined : "Install it with sudo apt install tmux or brew install tmux."}
        pill={doctor?.tmux ? { tone: "ok", text: "Ready" } : { tone: "action", text: "Needs action" }} />
    </ul>;
  }
  if (!status) return checked
    ? <ul className="tour-list"><SetupRow icon={Laptop} label="Requirements" detail="This Mac's setup could not be read." pill={{ tone: "fail", text: "Failed" }}
        action={<SmallButton icon={RotateCcw} onClick={recheckAll}>Check again</SmallButton>} /></ul>
    : <Checking label="Checking this Mac" />;

  const retry = (item: SetupItem) => <SmallButton icon={RotateCcw} disabled={busy !== null} onClick={() => void installRequirement(item)}>Retry</SmallButton>;
  // One Homebrew-installed requirement: found, installing, failed (retry),
  // waiting for Homebrew, or queued behind the install that is running now.
  const brewRow = (item: "node" | "tmux", icon: LucideIcon, label: string, purpose: string) => {
    const found = status[item];
    const error = errors[item];
    const pill: RowProps["pill"] = found ? { tone: "ok", text: "Ready" }
      : busy === item ? { tone: "busy", text: "Installing" }
      : error ? { tone: "fail", text: "Failed" }
      : !status.homebrew ? { tone: "neutral", text: "Waiting" }
      : attempted.includes(item) ? { tone: "action", text: "Needs action" }
      : { tone: "neutral", text: "Queued" };
    const detail = found ?? (error ? "Not installed" : !status.homebrew ? "Installs once Homebrew is ready" : busy !== item && attempted.includes(item) ? "Not found after installing" : purpose);
    return <SetupRow key={item} icon={icon} label={label} detail={detail} hint={error} hintTone="fail" pill={pill}
      action={!found && busy !== item && (error || (status.homebrew && attempted.includes(item))) ? retry(item) : null} />;
  };
  return <div className="tour-stack">
    <ul className="tour-list">
      {status.homebrew
        ? <SetupRow icon={Beer} label="Homebrew" detail={status.homebrew} pill={{ tone: "ok", text: "Ready" }} />
        : <SetupRow icon={Beer} label="Homebrew" detail="Installs Node.js and tmux for you"
            hint={errors.homebrew ?? "Opens in Terminal and asks for your Mac password. Setup continues here on its own."}
            hintTone={errors.homebrew ? "fail" : "muted"}
            pill={errors.homebrew ? { tone: "fail", text: "Failed" } : { tone: "action", text: "Needs action" }}
            action={<SmallButton primary loading={busy === "homebrew"} disabled={busy !== null} onClick={() => void installRequirement("homebrew")}>Install Homebrew</SmallButton>} />}
      {brewRow("node", Hexagon, "Node.js", "Runs the PzzaCode agent")}
      {brewRow("tmux", SquareTerminal, "tmux", "Keeps terminals running after you quit")}
    </ul>
    <section className="tour-group" aria-label="Coding agents">
      <div className="tour-group-head">
        <span className="tour-group-title">Coding agents</span>
        <span className="tour-group-meta">optional</span>
      </div>
      <div className="tour-chips">
        {status.agents.map(agent => <span key={agent.id} className={`tour-chip ${agent.path ? "is-found" : ""}`} title={agent.path ?? "Not installed"}>
          {agent.path ? <Check size={11} aria-hidden="true" /> : null}{AGENT_NAMES[agent.id] ?? agent.id}
          <span className="tour-chip-state">{agent.path ? "found" : "not found"}</span>
        </span>)}
      </div>
      {status.agents.some(agent => agent.path) ? null : <p className="tour-group-note">Install the CLIs you use; new sessions can start them in a folder for you.</p>}
    </section>
  </div>;
}

// Shortcuts worth knowing on day one. Push to talk needs voice input, which
// only the macOS app has.
const SHORTCUTS: { keys: string; label: string }[] = [
  { keys: NEW_SESSION_SHORTCUT.label, label: "New session" },
  ...(IS_MAC ? [{ keys: "⌥", label: "Hold to talk, once voice input is on" }] : []),
  { keys: IS_MAC ? "⌘J" : "Ctrl J", label: "Jump to the next tile waiting on you" },
];

/** Whether what PzzaCode runs on is installed: Node.js and tmux on a Mac, tmux elsewhere. */
export function useRequirementsReady(): boolean {
  const { doctor } = useDoctor();
  const status = useSetup(state => state.status);
  return PERMISSIONS_SUPPORTED ? !!status?.node && !!status.tmux : !!doctor?.tmux;
}

// Final summary: what is ready, what still needs attention, and shortcuts.
export function SetupSummary() {
  const { doctor, loading } = useDoctor();
  const status = useSetup(state => state.status);
  const busy = useSetup(state => state.busy);
  const ready = PERMISSIONS_SUPPORTED ? !!status?.node && !!status.tmux : !!doctor?.tmux;
  return <div className="tour-stack">
    <ul className="tour-list">
      <SetupRow icon={Laptop} label="Device agent" detail={loading ? "Checking" : doctor ? SERVER_HTTP : "Not reachable yet"}
        pill={loading ? { tone: "busy", text: "Checking" } : doctor ? { tone: "ok", text: "Ready" } : { tone: "fail", text: "Offline" }} />
      <SetupRow icon={SquareTerminal} label="Requirements"
        detail={ready ? (PERMISSIONS_SUPPORTED ? "Node.js and tmux are installed" : "tmux is installed")
          : busy ? "Finishing in the background" : "Some requirements are still missing"}
        pill={ready ? { tone: "ok", text: "Ready" } : busy ? { tone: "busy", text: "Installing" } : { tone: "action", text: "Needs action" }} />
    </ul>
    <section className="tour-group" aria-label="Shortcuts">
      <div className="tour-group-head"><span className="tour-group-title">Good to know</span></div>
      <ul className="tour-shortcuts">
        {SHORTCUTS.map(shortcut => <li key={shortcut.label}><kbd>{shortcut.keys}</kbd><span>{shortcut.label}</span></li>)}
      </ul>
    </section>
  </div>;
}
