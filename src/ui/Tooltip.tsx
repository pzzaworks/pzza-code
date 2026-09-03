import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

interface TipState {
  text: string;
  x: number;
  y: number;
  flip: boolean; // show above the target instead of below
}

// One global custom tooltip for the whole app. It captures any element carrying
// a `title` (or `data-tip`), moves the text into `data-tip`, strips the native
// `title` so the browser's own tooltip never fires, and renders our own styled
// bubble. This way every button/control gets a consistent tooltip without
// touching each call site.
export function Tooltip() {
  const [tip, setTip] = useState<TipState | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  const elRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    const resolve = (start: Element | null): HTMLElement | null => {
      let el = start?.closest?.("[data-tip],[title]") as HTMLElement | null;
      // Skip elements that opted out (e.g. the terminal surface).
      while (el && el.getAttribute("data-tip") === "") el = el.parentElement?.closest?.("[data-tip],[title]") as HTMLElement | null;
      return el ?? null;
    };

    const show = (el: HTMLElement) => {
      const native = el.getAttribute("title");
      if (native) {
        el.setAttribute("data-tip", native);
        el.removeAttribute("title"); // suppress the browser's native tooltip
      }
      const text = el.getAttribute("data-tip");
      if (!text) return;
      clearTimeout(timer.current);
      elRef.current = el;
      timer.current = setTimeout(() => {
        if (elRef.current !== el || !el.isConnected) return;
        const r = el.getBoundingClientRect();
        const flip = r.bottom > window.innerHeight - 52;
        setTip({
          text,
          x: Math.min(Math.max(r.left + r.width / 2, 56), window.innerWidth - 56),
          y: flip ? r.top - 8 : r.bottom + 8,
          flip,
        });
      }, 340);
    };

    const hide = () => {
      clearTimeout(timer.current);
      elRef.current = null;
      setTip(null);
    };

    const onOver = (e: MouseEvent) => {
      const el = resolve(e.target as Element);
      if (el) show(el);
    };
    const onOut = (e: MouseEvent) => {
      const from = resolve(e.target as Element);
      const to = resolve(e.relatedTarget as Element);
      if (from && from !== to) hide();
    };

    document.addEventListener("mouseover", onOver);
    document.addEventListener("mouseout", onOut);
    document.addEventListener("mousedown", hide, true);
    window.addEventListener("blur", hide);
    return () => {
      document.removeEventListener("mouseover", onOver);
      document.removeEventListener("mouseout", onOut);
      document.removeEventListener("mousedown", hide, true);
      window.removeEventListener("blur", hide);
      clearTimeout(timer.current);
    };
  }, []);

  if (!tip) return null;
  return createPortal(
    <div
      className={`pzza-tooltip ${tip.flip ? "flip" : ""}`}
      style={{ left: tip.x, top: tip.y }}
      role="tooltip"
    >
      {tip.text}
    </div>,
    document.body,
  );
}
