import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ComponentType, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import { motion, useReducedMotion } from "framer-motion";
import { PartyPopper, type LucideIcon } from "lucide-react";
import { SetupSummary } from "./SetupSteps";
import "./OnboardingTour.css";
import { markOnboardingDone } from "./progress";

// The UI tour: a spotlight on each part of the window, then a summary. It
// runs on first launch after setup (SetupScreen) and can be skipped any time.

type Phase = "tour" | "done";

interface Step {
  id: string;
  phase: Phase;
  title: string;
  // The tooltip text, or the line under the title of the closing card.
  body: string;
  // Candidate anchors in preference order; the step is skipped when none is visible.
  targets?: string[];
  // The closing card's header icon.
  icon?: LucideIcon;
  // Interactive content shown in the wide, centered card.
  content?: ComponentType;
}

const ALL_STEPS: Step[] = [
  {
    id: "workspaces",
    phase: "tour",
    title: "Workspaces",
    body: "Browser-style tabs group your sessions into contexts, one project per workspace. All shows every tile at once. Click a tab for its name, color and grid columns.",
    targets: ['[data-tour="workspaces"]', ".ws-tabs"],
  },
  {
    id: "new-session",
    phase: "tour",
    title: "New session",
    body: "Open a terminal on any device, or jump back into a tmux window you left running somewhere else.",
    targets: ['[data-tour="new-session"]'],
  },
  {
    id: "quick-chat",
    phase: "tour",
    title: "Quick Chat",
    body: "A dropdown chat with your saved agent. Hiding it never stops the conversation - it keeps running on its device.",
    targets: ['[data-tour="quick-chat"]'],
  },
  {
    id: "usage",
    phase: "tour",
    title: "Agent usage",
    body: "Live usage windows and estimated spend per account, with a one-click fix when a token expires.",
    targets: ['[data-tour="usage"]'],
  },
  {
    id: "canvas",
    phase: "tour",
    title: "Session tiles",
    body: "Every tile is a live terminal. Click to work in it, drag headers to reorder, and find every control in the tile's top-right corner.",
    // File tiles are editors, not terminals: the step points at a session tile.
    targets: [".tile:not(.tile-off):not(.tile-file) .tile-head", ".empty-session-create"],
  },
  {
    id: "settings",
    phase: "tour",
    title: "Settings",
    body: "Devices, sync, connections, Quick Chat and help all live here. Replay this tour any time from Settings → Help.",
    targets: ['[data-tour="settings"]'],
  },
  {
    id: "done",
    phase: "done",
    icon: PartyPopper,
    title: "You're all set",
    body: "Open your first terminal with New session. Close the app any time - everything keeps running on its device.",
    content: SetupSummary,
  },
];
const STEPS = ALL_STEPS;

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function queryTarget(selectors: string[]): HTMLElement | null {
  for (const selector of selectors) {
    let elements: NodeListOf<Element>;
    try {
      elements = document.querySelectorAll(selector);
    } catch {
      continue;
    }
    for (const element of elements) {
      if (!(element instanceof HTMLElement)) continue;
      const box = element.getBoundingClientRect();
      if (box.width >= 4 && box.height >= 4) return element;
    }
  }
  return null;
}

function rectOf(element: HTMLElement): Rect {
  const box = element.getBoundingClientRect();
  return { x: box.left, y: box.top, w: box.width, h: box.height };
}

function queryRect(selectors: string[]): Rect | null {
  const element = queryTarget(selectors);
  return element ? rectOf(element) : null;
}

const TIP_WIDTH = 340;
const SETUP_WIDTH = 540;
const GAP = 12;

export function OnboardingTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  // Which way the last move went, so step content slides in from that side.
  const [direction, setDirection] = useState<1 | -1>(1);
  const reduceMotion = useReducedMotion();
  const [resolved, setResolved] = useState<{ number: number; step: Step; rect: Rect | null } | null>(null);
  const primaryRef = useRef<HTMLButtonElement>(null);

  // Keyboard focus follows the step like autoFocus, but never scrolls: the
  // browser scrolling a newly focused button into view would move the anchor
  // and make the tooltip jump after it first painted.
  useEffect(() => {
    if (open && resolved) primaryRef.current?.focus({ preventScroll: true });
  }, [open, resolved?.number]);

  useEffect(() => {
    if (open) setIndex(0);
    else setResolved(null);
  }, [open ]);

  const finish = useCallback(() => {
    markOnboardingDone();
    onClose();
  }, [onClose]);

  // Resolve the requested step, skipping forward past anchors that are not
  // visible (collapsed toolbar, missing tiles). Runs out of steps → done.
  useLayoutEffect(() => {
    if (!open) return;
    let next = index;
    while (next < STEPS.length) {
      const step = STEPS[next];
      if (!step) break;
      const target = step.targets ? queryTarget(step.targets) : null;
      if (!step.targets || target) {
        // Bring an anchor that lives in a scroll region into view before we
        // measure it. Without this the ring and tooltip land outside the
        // viewport for an off-screen target and the tour looks frozen.
        target?.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
        if (!target) {
          setResolved({ number: next, step, rect: null });
          return;
        }
        const rect = rectOf(target);
        setResolved({ number: next, step, rect });
        // Same-commit unmounts (e.g. the tour replayed from Settings) can
        // shift the anchor right after this paint; confirm the measurement on
        // the next frame instead of letting the tooltip visibly jump later.
        const raf = requestAnimationFrame(() => {
          const fresh = queryTarget(step.targets ?? []);
          if (!fresh) return;
          const r = rectOf(fresh);
          if (Math.abs(r.x - rect.x) > 1 || Math.abs(r.y - rect.y) > 1 || Math.abs(r.w - rect.w) > 1 || Math.abs(r.h - rect.h) > 1) {
            setResolved({ number: next, step, rect: r });
          }
        });
        return () => cancelAnimationFrame(raf);
      }
      next++;
    }
    finish();
  }, [open, index, finish]);

  // Keep the highlight glued to its anchor across resizes and scrolling.
  // Never skips here: a mid-tour layout shift keeps the last placement.
  useEffect(() => {
    if (!open || !resolved?.step.targets) return;
    const remeasure = () => {
      const rect = queryRect(resolved.step.targets ?? []);
      if (rect) setResolved((current) => (current ? { ...current, rect } : current));
    };
    window.addEventListener("resize", remeasure);
    window.addEventListener("scroll", remeasure, true);
    return () => {
      window.removeEventListener("resize", remeasure);
      window.removeEventListener("scroll", remeasure, true);
    };
  }, [open, resolved?.step, resolved?.number]);

  const go = useCallback((direction: 1 | -1) => {
    const from = resolved?.number ?? index;
    let next = from + direction;
    while (next >= 0 && next < STEPS.length) {
      const step = STEPS[next];
      if (step && (!step.targets || queryRect(step.targets))) {
        setDirection(direction);
        setIndex(next);
        return;
      }
      next += direction;
    }
    if (next >= STEPS.length) finish();
  }, [finish, index, resolved]);

  useEffect(() => {
    if (!open) return;
    // Captured first so nothing behind the tour reacts to its keys. Escape
    // skips the tour, like its Skip button.
    const onKey = (event: KeyboardEvent) => {
      const control = event.target instanceof Element ? event.target.closest("button, a, input, select, textarea, [contenteditable='true']") : null;
      if (event.key === "Escape") {
        event.stopPropagation();
        event.preventDefault();
        finish();
      } else if (event.key === "Enter" && !control) {
        // A focused button handles Enter itself (the primary button is Next).
        event.stopPropagation();
        go(1);
      } else if ((event.key === "ArrowRight" || event.key === "ArrowLeft") && !(control && control.matches("input, select, textarea, [contenteditable='true']"))) {
        event.stopPropagation();
        go(event.key === "ArrowRight" ? 1 : -1);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open, go, finish]);

  if (!open || !resolved) return null;
  const { step, number, rect } = resolved;
  const isFirst = number === 0;
  const isLast = number === STEPS.length - 1;
  const Content = step.content;
  const primaryLabel = isLast ? "Finish" : "Next";
  const motionProps = {
    initial: { opacity: 0, x: reduceMotion ? 0 : 14 * direction },
    animate: { opacity: 1, x: 0 },
    transition: { duration: reduceMotion ? 0.12 : 0.22, ease: [0.2, 0.8, 0.2, 1] as const },
  };
  const actions = <footer className="tour-foot">
    {step.phase === "tour" ? <TourCount step={step} /> : null}
    <span className="tour-spacer" />
    {step.phase === "tour" ? <button type="button" className="tour-btn tour-btn-ghost tour-btn-skip" onClick={finish}>Skip</button> : null}
    {!isFirst ? <button type="button" className="tour-btn tour-btn-ghost" onClick={() => go(-1)}>Back</button> : null}
    <button type="button" ref={primaryRef} className="tour-btn tour-btn-primary" onClick={() => (isLast ? finish() : go(1))}>{primaryLabel}</button>
  </footer>;

  // Spotlight steps: a compact card below the anchor when it fits, above it
  // otherwise. Horizontal position never leaves the viewport.
  if (rect) {
    const placeAbove = rect.y + rect.h + GAP + 200 > window.innerHeight;
    const tipLeft = Math.max(12, Math.min(rect.x + rect.w / 2 - TIP_WIDTH / 2, window.innerWidth - TIP_WIDTH - 12));
    const tipStyle: CSSProperties = placeAbove
      ? { width: TIP_WIDTH, left: tipLeft, bottom: window.innerHeight - rect.y + GAP }
      : { width: TIP_WIDTH, left: tipLeft, top: rect.y + rect.h + GAP };
    return createPortal(
      <div className="tour-root pzza-portal" role="dialog" aria-modal="true" aria-label={step.title}>
        <div className="tour-dim" style={{ left: 0, top: 0, width: "100%", height: Math.max(0, rect.y) }} />
        <div className="tour-dim" style={{ left: 0, top: rect.y + rect.h, width: "100%", bottom: 0 }} />
        <div className="tour-dim" style={{ left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h }} />
        <div className="tour-dim" style={{ left: rect.x + rect.w, top: rect.y, right: 0, height: rect.h }} />
        <div className="tour-ring" style={{ left: rect.x - 5, top: rect.y - 5, width: rect.w + 10, height: rect.h + 10 }} />
        <motion.div className="tour-card tour-card-tip" style={tipStyle} key={step.id}
          initial={{ opacity: 0, y: reduceMotion ? 0 : placeAbove ? -6 : 6 }} animate={{ opacity: 1, y: 0 }} transition={motionProps.transition}>
          <h2 className="tour-tip-title">{step.title}</h2>
          <p className="tour-tip-text">{step.body}</p>
          {actions}
        </motion.div>
      </div>,
      document.body,
    );
  }

  // Setup and closing steps: one wide card that stays put while its content
  // slides between steps.
  const Icon = step.icon;
  return createPortal(
    <div className="tour-root pzza-portal" role="dialog" aria-modal="true" aria-label={step.title}>
      <div className="tour-dim tour-dim-full" />
      <div className="tour-center">
        <motion.div className={`tour-card tour-card-wide tour-card-${step.phase}`} style={{ width: Math.min(SETUP_WIDTH, window.innerWidth - 32) }}
          initial={{ opacity: 0, scale: reduceMotion ? 1 : 0.98 }} animate={{ opacity: 1, scale: 1 }} transition={motionProps.transition}>
          <motion.div className="tour-card-main" key={step.id} {...motionProps}>
            <header className="tour-head">
              {Icon ? <span className="tour-head-icon" aria-hidden="true"><Icon size={step.phase === "done" ? 24 : 18} strokeWidth={1.9} /></span> : null}
              <div className="tour-head-copy">
                <h2 className="tour-head-title">{step.title}</h2>
                <p className="tour-head-text">{step.body}</p>
              </div>
            </header>
            {Content ? <div className="tour-body"><Content /></div> : null}
          </motion.div>
          {actions}
        </motion.div>
      </div>
    </div>,
    document.body,
  );
}

// Position within the UI walkthrough, counting only the anchors on screen.
function TourCount({ step }: { step: Step }) {
  const visible = STEPS.filter(entry => entry.phase === "tour" && entry.targets && queryTarget(entry.targets));
  const position = visible.indexOf(step);
  if (position < 0) return null;
  return <span className="tour-foot-count">
    <span className="tour-foot-dots" aria-hidden="true">{visible.map(entry => <span key={entry.id} className={entry === step ? "on" : ""} />)}</span>
    {position + 1} of {visible.length}
  </span>;
}
