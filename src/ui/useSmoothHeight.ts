import { useLayoutEffect, type RefObject } from "react";
import { useReducedMotion } from "framer-motion";

// A symmetric ease keeps the fastest frame close to the average speed.
const EASING = "cubic-bezier(0.42, 0, 0.58, 1)";

// Longer moves get more time, so a panel that grows by a few rows and one that
// fills with a whole list both move at a calm, similar speed.
function durationFor(distance: number): number {
  return Math.round(Math.min(400, Math.max(180, 140 + distance * 0.75)));
}

/**
 * Animates `frame`'s height whenever `content`, a wrapper directly inside it,
 * changes size: data arriving after a loading row, rows expanding, or a step
 * swapped for a taller one grow and shrink instead of snapping.
 *
 * At rest the frame keeps its natural CSS height (padding, max-height and
 * scrolling still apply); only the change is animated, with the Web Animations
 * API, so no stale inline height is ever left behind. ResizeObserver callbacks
 * run after layout and before paint, so the new height never shows for a frame
 * before the animation takes over from the old one. While it runs the frame
 * clips its overflow (a scroll container keeps its scroll position), so no
 * scrollbar flashes in and content does not spill over what sits below.
 * Width changes (a window resize reflowing the content) apply at once, and with
 * reduced motion every change does.
 */
export function useSmoothHeight(frame: RefObject<HTMLElement | null>, content: RefObject<HTMLElement | null>, active = true): void {
  const reduceMotion = useReducedMotion();
  useLayoutEffect(() => {
    const frameEl = frame.current;
    const contentEl = content.current;
    if (!active || !frameEl || !contentEl) return;
    const scrolls = /auto|scroll/.test(getComputedStyle(frameEl).overflowY);
    const inlineOverflow = frameEl.style.overflowY;
    let settled: number | null = null;
    let contentWidth: number | null = null;
    let running: Animation | null = null;

    const stop = () => {
      running?.cancel();
      running = null;
      frameEl.style.overflowY = inlineOverflow;
    };
    const observer = new ResizeObserver(entries => {
      // Hidden (a kept-mounted panel while closed): start fresh when shown.
      if (!frameEl.getClientRects().length) { stop(); settled = null; contentWidth = null; return; }
      const contentChanged = entries.some(entry => entry.target === contentEl);
      // The frame resizes on every animation frame; only a resize of its own
      // at rest (a max-height that follows the window) moves the baseline.
      if (!contentChanged) { if (!running) settled = frameEl.getBoundingClientRect().height; return; }
      const from = running ? frameEl.getBoundingClientRect().height : settled;
      stop();
      const to = frameEl.getBoundingClientRect().height;
      const width = contentEl.getBoundingClientRect().width;
      const reflowed = contentWidth !== null && Math.abs(width - contentWidth) > 0.5;
      settled = to;
      contentWidth = width;
      if (from === null || reflowed || reduceMotion || Math.abs(to - from) < 1) return;
      frameEl.style.overflowY = scrolls ? "hidden" : "clip";
      const animation = frameEl.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: durationFor(Math.abs(to - from)), easing: EASING });
      running = animation;
      animation.onfinish = () => { if (running === animation) stop(); };
    });
    observer.observe(contentEl);
    observer.observe(frameEl);
    return () => { observer.disconnect(); stop(); };
  }, [frame, content, active, reduceMotion]);
}
