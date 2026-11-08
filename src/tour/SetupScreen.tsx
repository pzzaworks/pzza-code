import { useEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, Loader2, Package, ShieldCheck, type LucideIcon } from "lucide-react";
import { PERMISSIONS_SUPPORTED } from "../state/permissions";
import { useStore } from "../state/store";
import { SetupHealth, SetupPermissions, SetupRequirements, useRequirementsReady } from "./SetupSteps";
import "./OnboardingTour.css";
import "./SetupScreen.css";

// First launch opens setup before the UI tour: what PzzaCode needs on this
// machine (permissions, tmux and Node.js), one step at a time.
const DONE_KEY = "pzza.setup.done";
// Installs that finished the earlier setup wizard or onboarding count as set up.
const LEGACY_DONE_KEYS = ["pzza.setupDone", "pzza.onboarding.done"];

export function setupPending(): boolean {
  try {
    if (localStorage.getItem(DONE_KEY)) return false;
    if (LEGACY_DONE_KEYS.some(key => localStorage.getItem(key))) {
      localStorage.setItem(DONE_KEY, "1");
      return false;
    }
    return true;
  } catch {
    // Storage is unavailable: never block every launch with setup.
    return false;
  }
}

function markSetupDone() {
  try {
    localStorage.setItem(DONE_KEY, "1");
  } catch {
    /* private mode - nothing to remember */
  }
}

interface SetupStep {
  id: string;
  icon: LucideIcon;
  title: string;
  body: string;
  content: ComponentType;
}

function Requirements() {
  return <>
    <SetupHealth />
    <SetupRequirements />
  </>;
}

const STEPS: SetupStep[] = [
  ...(PERMISSIONS_SUPPORTED ? [{
    id: "permissions",
    icon: ShieldCheck,
    title: "Privacy permissions",
    body: "Allow what your tools need. Each Allow shows the macOS prompt or opens the right page in System Settings.",
    content: SetupPermissions,
  }] : []),
  {
    id: "requirements",
    icon: Package,
    title: "What PzzaCode runs on",
    body: PERMISSIONS_SUPPORTED
      ? "Node.js runs the agent and tmux keeps terminals alive. Missing ones install themselves with Homebrew."
      : "PzzaCode needs tmux on this machine for terminals that keep running.",
    content: Requirements,
  },
];

function Welcome() {
  return <div className="setup-welcome">
    <p className="setup-lead">
      Every terminal and every coding agent, on one grid. Setup allows what your tools need on this Mac and
      installs what PzzaCode runs on; it takes about a minute.
    </p>
    <ol className="setup-plan">
      {STEPS.map((step) => {
        const StepIcon = step.icon;
        return <li key={step.id} className="setup-plan-item">
          <span className="setup-plan-icon" aria-hidden="true"><StepIcon size={13} /></span>
          <span className="setup-plan-copy"><strong>{step.title}</strong><span>{step.body}</span></span>
        </li>;
      })}
    </ol>
  </div>;
}

const PAGES: SetupStep[] = [
  { id: "welcome", icon: ShieldCheck, title: "Welcome to PzzaCode", body: "A minute of setup before the first session.", content: Welcome },
  ...STEPS,
];

// Setup fills the window with one centered column: where you are in the
// steps, the current step, and its Back / Continue right below it.
// It cannot be skipped: Finish setup waits until the requirements are ready.
export function SetupScreen({ open, onDone }: { open: boolean; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const ready = useRequirementsReady();

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);
  useEffect(() => {
    useStore.getState().setSetupVisible(open);
    return () => useStore.getState().setSetupVisible(false);
  }, [open]);
  useEffect(() => {
    if (open) primaryRef.current?.focus({ preventScroll: true });
  }, [open, index]);

  if (!open) return null;
  const page = PAGES[index];
  const last = index === PAGES.length - 1;
  const go = (step: 1 | -1) => {
    if (last && step === 1) {
      if (!ready) return;
      markSetupDone();
      onDone();
      return;
    }
    setIndex(Math.min(PAGES.length - 1, Math.max(0, index + step)));
  };
  const Content = page.content;

  return createPortal(
    <div className="setup-screen pzza-portal" role="dialog" aria-modal="true" aria-label="Set up PzzaCode">
      {/* Keeps the window draggable by its top edge; nothing is drawn here. */}
      <div className="setup-drag" data-tauri-drag-region />
      <main className="setup-main">
        <div className="setup-page">
          <div className="setup-stage">
            <div key={page.id}>
                <div className="setup-count" role="group" aria-label={`Step ${index + 1} of ${PAGES.length}`}>
                  <span className="setup-dots" aria-hidden="true">
                    {PAGES.map((entry, position) => <span key={entry.id} className={position === index ? "on" : position < index ? "done" : ""} />)}
                  </span>
                  Step {index + 1} of {PAGES.length}
                </div>
                <header className="setup-page-head">
                  {page.id === "welcome" ? <img src="/pzzacode.svg" alt="" className="setup-logo" /> : null}
                  <div className="setup-head-copy">
                    <h1 className="setup-step-title">{page.title}</h1>
                    <p className="setup-step-body">{page.body}</p>
                  </div>
                </header>
                <div className="setup-step-content"><Content /></div>
            </div>
          </div>
          <div className="setup-actions">
            {last && !ready ? <span className="setup-wait" role="status"><Loader2 size={13} className="sw-spin" aria-hidden="true" />Waiting for the requirements to finish installing</span> : null}
            <span className="setup-spacer" />
            {index > 0 ? <button type="button" className="btn" onClick={() => go(-1)}>Back</button> : null}
            <button type="button" ref={primaryRef} className="btn btn-accent" disabled={last && !ready} onClick={() => go(1)}>
              {last ? "Finish setup" : "Continue"}{last ? null : <ArrowRight size={14} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </main>
    </div>,
    document.body,
  );
}
