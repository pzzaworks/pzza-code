import { useEffect, type RefObject } from "react";

// A horizontally scrolling row marks the sides that have content scrolled out
// of view with data-more-start / data-more-end, so CSS can fade those edges
// instead of showing a scrollbar. A vertical wheel scrolls the row sideways,
// since a mouse has no horizontal wheel.
export function useScrollEdges(ref: RefObject<HTMLElement | null>, active = true): void {
  useEffect(() => {
    const row = ref.current;
    if (!row || !active) return;
    const mark = () => {
      row.toggleAttribute("data-more-start", row.scrollLeft > 1);
      row.toggleAttribute("data-more-end", row.scrollLeft + row.clientWidth < row.scrollWidth - 1);
    };
    const wheel = (event: WheelEvent) => {
      if (row.scrollWidth <= row.clientWidth || Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      row.scrollLeft += event.deltaY;
    };
    mark();
    row.addEventListener("scroll", mark, { passive: true });
    row.addEventListener("wheel", wheel, { passive: false });
    // The row's own size changes with its container; its content (chips
    // added, removed or relabeled) changes how far it scrolls.
    const resize = new ResizeObserver(mark);
    resize.observe(row);
    const content = new MutationObserver(mark);
    content.observe(row, { childList: true, subtree: true, characterData: true });
    return () => {
      resize.disconnect();
      content.disconnect();
      row.removeEventListener("scroll", mark);
      row.removeEventListener("wheel", wheel);
    };
  }, [ref, active]);
}
