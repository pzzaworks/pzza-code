import type { ReactNode } from "react";
import { Loader2, RefreshCw, RotateCcw } from "lucide-react";
import { PERMISSIONS, PERMISSIONS_SUPPORTED } from "../state/permissions";
import { useSetup } from "../state/setup";
import { useDefaultEditor } from "../state/defaultEditor";
import { usePermissionControls } from "./Permissions";
import { openRefreshSessions, useSessionRefresh } from "../state/sessionRefresh";
import { AllowAllButton, PermissionGuide, SetupDefaultEditor, SetupHealth, SetupPermissions, SetupRequirements, useRequirementsReady } from "../tour/SetupSteps";
import type { SecuritySection } from "./settingsSections";
import "../tour/OnboardingTour.css";

// Neutral marks a page with nothing to act on either way.
type Tone = "ok" | "busy" | "action" | "neutral";

interface Page {
  intro: string;
  summary?: string;
  tone?: Tone;
  actions?: ReactNode;
  body: ReactNode;
}

// Settings → Security: what PzzaCode needs on this machine, one page per
// group (tools, each permission list, the default editor, this device), with
// the group's state and its own actions on top.
export function SetupSettings({ page }: { page: SecuritySection }) {
  // One status source for the summaries and the rows on the permission pages.
  const controls = usePermissionControls();
  const ready = useRequirementsReady();
  const installing = useSetup((state) => state.busy !== null);
  const editor = useDefaultEditor((state) => state.status);

  const permissionPage = (subject: "app" | "tmux", intro: string): Page => {
    const { statuses, tmuxMissing } = controls;
    const items = PERMISSIONS.filter((item) => item.subject === subject);
    const known = items.every((item) => statuses[item.id] !== undefined);
    const allowed = items.filter((item) => statuses[item.id] === "granted").length;
    // tmux's permissions open once the Tools page has installed it.
    const waiting = subject === "tmux" && tmuxMissing;
    return {
      intro,
      summary: waiting ? "Waiting for tmux" : known ? `${allowed} of ${items.length} allowed` : "Checking…",
      tone: waiting || !known ? "busy" : allowed === items.length ? "ok" : "action",
      actions: <><AllowAllButton controls={controls} subject={subject} /><RefreshSessionsButton /></>,
      body: <>
        <PermissionGuide controls={controls} />
        <SetupPermissions only={subject} controls={controls} />
      </>,
    };
  };

  const current: Page = page === "permissions" && PERMISSIONS_SUPPORTED
    ? permissionPage("app", "The macOS privacy permissions PzzaCode needs. Every shell, agent and tool you start here runs as PzzaCode.")
    : page === "tmux" && PERMISSIONS_SUPPORTED
      ? permissionPage("tmux", "The macOS privacy permissions tmux needs, since it keeps your terminals running.")
      : page === "editor" && editor?.supported
        ? {
          intro: "Open code files from Finder and other apps in PzzaCode.",
          summary: editor.isDefault ? "Default for all file types" : `Default for ${editor.owned} of ${editor.total} file types`,
          tone: editor.isDefault ? "ok" : "neutral",
          body: <SetupDefaultEditor />,
        }
        : page === "device"
          ? { intro: "The agent, storage and terminals on this device.", body: <SetupHealth /> }
          : {
            intro: "The tools PzzaCode runs on. The full first-launch setup can be run again from here.",
            summary: ready ? "Installed" : installing ? "Installing…" : "Something is missing",
            tone: ready ? "ok" : installing ? "busy" : "action",
            actions: <button type="button" className="btn btn-sm" onClick={() => window.dispatchEvent(new Event("pzza:start-setup"))}>
              <RotateCcw size={13} aria-hidden="true" /> Run setup
            </button>,
            body: <SetupRequirements />,
          };

  return <div className="settings-page setup-settings">
    <div className="setup-settings-intro">
      <p>{current.intro}</p>
      {current.summary || current.actions ? <div className="setup-settings-actions">
        {current.summary ? <span className={`setup-settings-state is-${current.tone ?? "neutral"}`} role="status">{current.summary}</span> : null}
        {current.actions}
      </div> : null}
    </div>
    <div className="setup-settings-page">{current.body}</div>
  </div>;
}

// Running sessions get new permissions only once refreshed.
function RefreshSessionsButton() {
  const refreshing = useSessionRefresh((state) => state.running);
  return <button type="button" className="btn btn-sm" disabled={refreshing} aria-busy={refreshing || undefined}
    title="Choose sessions to refresh, or refresh all so every terminal gets new permissions. Output, folders and agent chats come back; programs running in them stop."
    onClick={openRefreshSessions}>
    {refreshing ? <Loader2 size={13} className="sw-spin" aria-hidden="true" /> : <RefreshCw size={13} aria-hidden="true" />}
    {refreshing ? "Refreshing sessions…" : "Refresh sessions"}
  </button>;
}
