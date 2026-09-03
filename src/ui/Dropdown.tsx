import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { AnimatePresence, motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import { IconButton } from "./IconButton";
import { useExclusiveMenu } from "./menuBus";

interface Props {
  icon: LucideIcon;
  title: string;
  label?: string;
  accent?: boolean;
  width?: number;
  children: ReactNode | ((close: () => void) => ReactNode);
}

// A top-bar icon button that opens an anchored dropdown panel (replaces modals
// for the top-right controls). Handles open/close, click-outside and animation.
export function Dropdown({ icon: Icon, title, label, accent, width = 300, children }: Props) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const close = useCallback(() => setOpen(false), []);

  useExclusiveMenu(title, open, close);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      const target = e.target as Element;
      // Ignore clicks inside a nested portal menu (a custom Select, etc.).
      if (target.closest?.(".pzza-portal")) return;
      if (ref.current && !ref.current.contains(target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    window.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      {label ? (
        <button
          type="button"
          className={`btn ${accent ? "btn-accent" : ""} ${open ? "btn-on" : ""} dropdown-label-btn`}
          onClick={() => setOpen((v) => !v)}
          title={title}
        >
          <Icon size={15} strokeWidth={2} />
          {label}
        </button>
      ) : (
        <IconButton
          icon={Icon}
          onClick={() => setOpen((v) => !v)}
          title={title}
          accent={accent}
          active={open}
        />
      )}
      <AnimatePresence>
        {open ? (
          <motion.div
            className="menu menu-panel"
            style={{ width }}
            initial={{ opacity: 0, y: -6, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -6, scale: 0.98 }}
            transition={{ duration: 0.12 }}
          >
            {typeof children === "function" ? children(close) : children}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}
