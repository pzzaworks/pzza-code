import { useLayoutEffect, type RefObject } from "react";

/**
 * Grows a textarea with its text, one line at a time, up to `maxLines`, then
 * lets it scroll. The app's web view has no `field-sizing: content`, so a
 * textarea would otherwise keep its first height, clip the lines past it and
 * show a scrollbar beside a single wrapped sentence. `minLines` keeps room for
 * a placeholder or an empty field.
 */
export function useAutoGrow(ref: RefObject<HTMLTextAreaElement | null>, value: string, { minLines = 1, maxLines = 6 }: { minLines?: number; maxLines?: number } = {}): void {
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const fit = () => {
      const style = getComputedStyle(element);
      const line = parseFloat(style.lineHeight) || parseFloat(style.fontSize) * 1.45 || 18;
      const chrome = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom) + parseFloat(style.borderTopWidth) + parseFloat(style.borderBottomWidth);
      const min = line * minLines + chrome;
      const max = line * maxLines + chrome;
      element.style.height = "auto";
      // An empty field keeps its minimum: a long placeholder never grows it.
      const height = value ? Math.min(Math.max(element.scrollHeight, min), max) : min;
      element.style.height = `${Math.ceil(height)}px`;
      // A scrollbar only once the text is taller than the field may grow.
      element.style.overflowY = element.scrollHeight > max + 1 ? "auto" : "hidden";
    };
    fit();
    // The width decides where lines wrap, so a resized panel refits too; the
    // height changes fit() makes itself are ignored.
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth;
      fit();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [ref, value, minLines, maxLines]);
}
