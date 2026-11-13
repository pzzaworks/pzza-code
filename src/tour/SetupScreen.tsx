import { useEffect, useRef, useState, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { ArrowRight, FileCode, Loader2, Package, ShieldCheck, type LucideIcon } from "lucide-react";
import { PERMISSIONS_SUPPORTED } from "../state/permissions";
import { refreshDefaultEditor, useDefaultEditor } from "../state/defaultEditor";
import { useStore } from "../state/store";
import { SetupDefaultEditor, SetupHealth, SetupPermissions, SetupRequirements, useRequirementsReady } from "./SetupSteps";
import "./OnboardingTour.css";
import "./SetupScreen.css";
import { markSetupDone } from "./progress";

// First launch opens setup before the UI tour: what PzzaCode needs on this
// machine, one step at a time. Node.js and tmux install first; the privacy
// permissions come after, because macOS can only grant tmux its permissions
// once tmux exists.

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
  {
    id: "requirements",
    icon: Package,
    title: "What PzzaCode runs on",
    body: PERMISSIONS_SUPPORTED
      ? "Node.js runs the agent and tmux keeps terminals alive. Missing ones install themselves with Homebrew."
      : "PzzaCode needs tmux on this machine for terminals that keep running.",
    content: Requirements,
  },
  ...(PERMISSIONS_SUPPORTED ? [{
    id: "permissions",
    icon: ShieldCheck,
    title: "Privacy permissions",
    body: "Allow what your tools and tmux need. Each Allow shows the macOS prompt or opens the right page in System Settings.",
    content: SetupPermissions,
  }] : []),
];

// Optional, and only where the macOS app reports it can change default apps.
const DEFAULT_EDITOR_STEP: SetupStep = {
  id: "default-editor",
  icon: FileCode,
  title: "Open code files with PzzaCode",
  body: "Code and text files you open from Finder open right in the editor. Open a terminal next to one whenever you need it.",
  content: SetupDefaultEditor,
};

function useSetupSteps(): SetupStep[] {
  const editorSupported = useDefaultEditor(state => state.status?.supported === true);
  return editorSupported ? [...STEPS, DEFAULT_EDITOR_STEP] : STEPS;
}

function Welcome() {
  const steps = useSetupSteps();
  return <div className="setup-welcome">
    <p className="setup-lead">
      Every terminal and every coding agent, on one grid. Setup installs what PzzaCode runs on and allows
      what your tools need on this Mac; it takes about a minute.
    </p>
    <ol className="setup-plan">
      {steps.map((step) => {
        const StepIcon = step.icon;
        return <li key={step.id} className="setup-plan-item">
          <span className="setup-plan-icon" aria-hidden="true"><StepIcon size={13} /></span>
          <span className="setup-plan-copy"><strong>{step.title}</strong><span>{step.body}</span></span>
        </li>;
      })}
    </ol>
  </div>;
}

const WELCOME: SetupStep = { id: "welcome", icon: ShieldCheck, title: "Welcome to PzzaCode", body: "A minute of setup before the first session.", content: Welcome };

// Setup fills the window with one centered column: where you are in the
// steps, the current step, and its Back / Continue right below it.
// It cannot be skipped: the requirements step moves on (to the permissions, or
// Finish setup where there are none) only once they are installed.
export function SetupScreen({ open, onDone }: { open: boolean; onDone: () => void }) {
  const [index, setIndex] = useState(0);
  const primaryRef = useRef<HTMLButtonElement>(null);
  const ready = useRequirementsReady();
  const steps = useSetupSteps();
  const pages = [WELCOME, ...steps];

  useEffect(() => {
    if (open) setIndex(0);
  }, [open]);
  // Decides whether the default editor step is part of setup.
  useEffect(() => {
    if (open) void refreshDefaultEditor();
  }, [open]);
  useEffect(() => {
    useStore.getState().setSetupVisible(open);
    return () => useStore.getState().setSetupVisible(false);
  }, [open]);
  useEffect(() => {
    if (open) primaryRef.current?.focus({ preventScroll: true });
  }, [open, index]);

  if (!open) return null;
  const page = pages[Math.min(index, pages.length - 1)];
  const last = index === pages.length - 1;
  const waiting = page.id === "requirements" && !ready;
  const go = (step: 1 | -1) => {
    if (waiting && step === 1) return;
    if (last && step === 1) {
      markSetupDone();
      onDone();
      return;
    }
    setIndex(Math.min(pages.length - 1, Math.max(0, index + step)));
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
                <div className="setup-count" role="group" aria-label={`Step ${index + 1} of ${pages.length}`}>
                  <span className="setup-dots" aria-hidden="true">
                    {pages.map((entry, position) => <span key={entry.id} className={position === index ? "on" : position < index ? "done" : ""} />)}
                  </span>
                  Step {index + 1} of {pages.length}
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
            {waiting ? <span className="setup-wait" role="status"><Loader2 size={13} className="sw-spin" aria-hidden="true" />Waiting for the requirements to finish installing</span> : null}
            <span className="setup-spacer" />
            {index > 0 ? <button type="button" className="btn" onClick={() => go(-1)}>Back</button> : null}
            <button type="button" ref={primaryRef} className="btn btn-accent" disabled={waiting} onClick={() => go(1)}>
              {last ? "Finish setup" : "Continue"}{last ? null : <ArrowRight size={14} aria-hidden="true" />}
            </button>
          </div>
        </div>
      </main>
    </div>,
    document.body,
  );
}
