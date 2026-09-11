import { useCallback, useEffect, useLayoutEffect, useState, type CSSProperties } from "react";
import { createPortal } from "react-dom";
import "./OnboardingTour.css";

const SEEN_KEY = "pzza.tour.seen";
function markTourSeen() {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* private mode - the tour simply shows again next launch */
  }
}

interface Step {
  id: string;
  title: string;
  body: string;
  // Candidate anchors in preference order; the step is skipped when none is visible.
  targets?: string[];
}

const STEPS: Step[] = [
  {
    id: "welcome",
    title: "Welcome to PzzaCode",
    body: "Every terminal and every agent on one grid. This quick tour walks the whole app - one control at a time.",
  },
  {
    id: "workspaces",
    title: "Workspaces",
    body: "Browser-style tabs group your sessions into contexts, one project per workspace. All shows every tile at once.",
    targets: ['[data-tour="workspaces"]', ".ws-tabs"],
  },
  {
    id: "new-session",
    title: "New session",
    body: "Open a terminal on any device, or jump back into a tmux window you left running somewhere else.",
    targets: ['[data-tour="new-session"]'],
  },
  {
    id: "quick-chat",
    title: "Quick Chat",
    body: "A dropdown chat with your saved agent. Hiding it never stops the conversation - it keeps running on its device.",
    targets: ['[data-tour="quick-chat"]'],
  },
  {
    id: "layout",
    title: "Grid layout",
    body: "Columns per workspace, remembered per workspace. A lone tile fills the row on its own.",
    targets: ['[data-tour="layout"]'],
  },
  {
    id: "usage",
    title: "Agent usage",
    body: "Live usage windows and estimated spend per account, with a one-click fix when a token expires.",
    targets: ['[data-tour="usage"]'],
  },
  {
    id: "canvas",
    title: "Session tiles",
    body: "Every tile is a live terminal. Click to work in it, drag headers to reorder, and find every control in the tile's top-right corner.",
    targets: [".tile:not(.tile-off) .tile-head", ".empty-session-create"],
  },
  {
    id: "settings",
    title: "Settings",
    body: "Devices, sync, connections, Quick Chat and help all live here. Stuck later? Replay this tour from Settings → Help → Tips.",
    targets: ['[data-tour="settings"]'],
  },
  {
    id: "done",
    title: "You're set",
    body: "Hit + New session and open your first terminal. Close the app anytime - everything keeps running on its device.",
  },
];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

function queryRect(selectors: string[]): Rect | null {
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
      if (box.width >= 4 && box.height >= 4) return { x: box.left, y: box.top, w: box.width, h: box.height };
    }
  }
  return null;
}

const TIP_WIDTH = 300;
const GAP = 12;

export function OnboardingTour({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [index, setIndex] = useState(0);
  const [resolved, setResolved] = useState<{ number: number; step: Step; rect: Rect | null } | null>(null);

  useEffect(() => {
    if (open) setIndex(0);
    else setResolved(null);
  }, [open ]);

  const finish = useCallback(() => {
    markTourSeen();
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
      const rect = step.targets ? queryRect(step.targets) : null;
      if (!step.targets || rect) {
        setResolved({ number: next, step, rect });
        return;
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
        setIndex(next);
        return;
      }
      next += direction;
    }
    if (next >= STEPS.length) finish();
  }, [finish, index, resolved]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        finish();
      } else if (event.key === "ArrowRight" || event.key === "Enter") {
        event.stopPropagation();
        go(1);
      } else if (event.key === "ArrowLeft") {
        event.stopPropagation();
        go(-1);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, finish, go]);

  if (!open || !resolved) return null;
  const { step, number, rect } = resolved;
  const isFirst = number === 0;
  const isLast = number === STEPS.length - 1;

  // Tooltip below the anchor when it fits, above it otherwise, centered
  // fallback when there is no anchor. Horizontal position never leaves the
  // viewport.
  const placeAbove = rect !== null && rect.y + rect.h + GAP + 200 > window.innerHeight;
  const tipLeft = rect ? Math.max(12, Math.min(rect.x + rect.w / 2 - TIP_WIDTH / 2, window.innerWidth - TIP_WIDTH - 12)) : undefined;
  const tipStyle: CSSProperties = rect
    ? placeAbove
      ? { width: TIP_WIDTH, left: tipLeft, bottom: window.innerHeight - rect.y + GAP }
      : { width: TIP_WIDTH, left: tipLeft, top: rect.y + rect.h + GAP }
    : { width: Math.min(TIP_WIDTH + 20, window.innerWidth - 48), left: "50%", top: "42%", transform: "translate(-50%, -50%)" };

  return createPortal(
    <div className="tour-root pzza-portal" role="dialog" aria-modal="true" aria-label={step.title}>
      {rect ? (
        <>
          <div className="tour-dim" style={{ left: 0, top: 0, width: "100%", height: Math.max(0, rect.y) }} />
          <div className="tour-dim" style={{ left: 0, top: rect.y + rect.h, width: "100%", bottom: 0 }} />
          <div className="tour-dim" style={{ left: 0, top: rect.y, width: Math.max(0, rect.x), height: rect.h }} />
          <div className="tour-dim" style={{ left: rect.x + rect.w, top: rect.y, right: 0, height: rect.h }} />
          <div className="tour-ring" style={{ left: rect.x - 5, top: rect.y - 5, width: rect.w + 10, height: rect.h + 10 }} />
        </>
      ) : (
        <div className="tour-dim tour-dim-full" />
      )}
      <div className="menu tour-tip" style={tipStyle} key={step.id}>
        <div className="tour-tip-head">
          <strong>{step.title}</strong>
          <span className="tour-count" aria-label={`Step ${number + 1} of ${STEPS.length}`}>{number + 1} / {STEPS.length}</span>
        </div>
        <p className="tour-tip-body">{step.body}</p>
        <div className="tour-dots" aria-hidden="true">
          {STEPS.map((s, i) => <span key={s.id} className={i === number ? "on" : i < number ? "seen" : ""} />)}
        </div>
        <div className="tour-actions">
          <button type="button" className="tour-skip" onClick={finish}>Skip</button>
          <span className="tour-spacer" />
          {!isFirst ? <button type="button" className="btn btn-sm" onClick={() => go(-1)}>Back</button> : null}
          <button type="button" className="btn btn-accent btn-sm" autoFocus onClick={() => (isLast ? finish() : go(1))}>
            {isFirst ? "Start tour" : isLast ? "Done" : "Next"}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
