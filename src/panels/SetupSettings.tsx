import { useState, type ReactNode } from "react";
import { ChevronRight, Laptop, Loader2, Package, RefreshCw, RotateCcw, ShieldCheck, type LucideIcon } from "lucide-react";
import { PERMISSIONS, PERMISSIONS_SUPPORTED } from "../state/permissions";
import { useSetup } from "../state/setup";
import { usePermissionControls } from "./Permissions";
import { refreshLocalSessions, useSessionRefresh } from "../state/sessionRefresh";
import { AllowAllButton, PermissionGuide, SetupHealth, SetupPermissions, SetupRequirements, useRequirementsReady } from "../tour/SetupSteps";
import { confirmAction } from "../ui/ConfirmDialog";
import "../tour/OnboardingTour.css";

type Tone = "ok" | "busy" | "action";

// Restarting the terminal server stops every program in this Mac's sessions,
// so it only runs when asked for and confirmed.
async function confirmRefresh(): Promise<void> {
  const accepted = await confirmAction({
    title: "Refresh this Mac's sessions?",
    message: "The terminal server restarts so running sessions get new permissions. Sessions, folders, recent output and agent chats come back, but programs running in them stop: dev servers, watchers, and an agent in the middle of a turn.",
    confirmLabel: "Refresh sessions",
    danger: true,
  });
  if (accepted) await refreshLocalSessions().catch(() => undefined);
}

interface Group {
  id: string;
  icon: LucideIcon;
  title: string;
  summary: string;
  tone: Tone;
  body: ReactNode;
}

// Settings → Setup: what PzzaCode needs on this machine, one short row per
// group with its state. Groups that need something open on their own; the
// rest stay folded so the page stays short. The full first-launch setup can
// be run again from here.
export function SetupSettings() {
  // One status source for the summaries and the rows inside the groups.
  const controls = usePermissionControls();
  const { statuses, tmuxMissing } = controls;
  const ready = useRequirementsReady();
  const installing = useSetup((state) => state.busy !== null);
  const refreshing = useSessionRefresh((state) => state.running);
  const [toggled, setToggled] = useState<Record<string, boolean>>({});

  const permissionGroup = (subject: "app" | "tmux", title: string): Group => {
    const items = PERMISSIONS.filter((item) => item.subject === subject);
    const known = items.every((item) => statuses[item.id] !== undefined);
    const allowed = items.filter((item) => statuses[item.id] === "granted").length;
    // tmux's permissions open once the tools group has installed it.
    const waiting = subject === "tmux" && tmuxMissing;
    return {
      id: subject,
      icon: ShieldCheck,
      title,
      summary: waiting ? "Waiting for tmux" : known ? `${allowed} of ${items.length} allowed` : "Checking…",
      tone: waiting || !known ? "busy" : allowed === items.length ? "ok" : "action",
      body: <SetupPermissions only={subject} controls={controls} />,
    };
  };
  // Same order as first-launch setup: the tools first, since tmux must be
  // installed before macOS can grant it permissions.
  const groups: Group[] = [
    {
      id: "requirements",
      icon: Package,
      title: "Tools PzzaCode runs on",
      summary: ready ? "Installed" : installing ? "Installing…" : "Something is missing",
      tone: ready ? "ok" : installing ? "busy" : "action",
      body: <SetupRequirements />,
    },
    ...(PERMISSIONS_SUPPORTED ? [permissionGroup("app", "PzzaCode permissions"), permissionGroup("tmux", "tmux permissions")] : []),
    { id: "health", icon: Laptop, title: "This device", summary: "Agent, storage and terminals", tone: "ok", body: <SetupHealth /> },
  ];
  // Until toggled, a group is open exactly when it needs action.
  const isOpen = (group: Group) => toggled[group.id] ?? group.tone === "action";

  return <div className="settings-page setup-settings">
    <div className="setup-settings-intro">
      <p>The tools and permissions PzzaCode needs on this machine. Anything that needs you opens here.</p>
      <div className="setup-settings-actions">
        {PERMISSIONS_SUPPORTED ? <AllowAllButton controls={controls} /> : null}
        {PERMISSIONS_SUPPORTED ? <button type="button" className="btn btn-sm" disabled={refreshing} aria-busy={refreshing || undefined}
          title="Restart this Mac's terminals so they get new permissions. Sessions, folders, recent output and agent chats come back; programs running in them stop."
          onClick={() => { void confirmRefresh(); }}>
          {refreshing ? <Loader2 size={13} className="sw-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
          {refreshing ? "Refreshing sessions…" : "Refresh sessions"}
        </button> : null}
        <button type="button" className="btn btn-sm" onClick={() => window.dispatchEvent(new Event("pzza:start-setup"))}>
          <RotateCcw size={13} aria-hidden="true" /> Run setup
        </button>
      </div>
    </div>
    {PERMISSIONS_SUPPORTED ? <PermissionGuide controls={controls} /> : null}
    <div className="setup-settings-groups">
      {groups.map((group) => {
        const open = isOpen(group);
        const Icon = group.icon;
        return <section key={group.id} className={`setup-settings-group ${open ? "is-open" : ""}`}>
          <button type="button" className="setup-settings-head" aria-expanded={open}
            onClick={() => setToggled((current) => ({ ...current, [group.id]: !open }))}>
            <Icon size={15} className="setup-settings-icon" aria-hidden="true" />
            <span className="setup-settings-title">{group.title}</span>
            <span className={`setup-settings-state is-${group.tone}`}>{group.summary}</span>
            <ChevronRight size={14} className="setup-settings-chevron" aria-hidden="true" />
          </button>
          {open ? <div className="setup-settings-body">{group.body}</div> : null}
        </section>;
      })}
    </div>
  </div>;
}
