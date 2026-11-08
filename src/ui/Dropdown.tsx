import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { motion } from "framer-motion";
import { Loader2, type LucideIcon } from "lucide-react";
import { IconButton } from "./IconButton";
import { useDelayedLoading } from "./useDelayedLoading";
import { useExclusiveMenu } from "./menuBus";
import { registerAppControlMenu } from "../appControlRuntime";

interface Props {
  icon: LucideIcon;
  title: string;
  label?: string;
  // Live info shown beside the icon (a count, a meter). When null the trigger
  // stays a plain icon button. badgeLabel is its tooltip and accessible name.
  badge?: ReactNode;
  // A small count pinned to the icon's top-right corner, like an app icon badge.
  cornerBadge?: ReactNode;
  badgeLabel?: string;
  accent?: boolean;
  width?: number;
  keepMounted?: boolean;
  preload?: boolean;
  loading?: boolean;
  panelClassName?: string;
  align?: "start" | "end";
  compact?: boolean;
  shortcut?: { label: string; keys: string };
  controlId?: string;
  tourId?: string;
  onOpen?: () => void;
  controlledOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode | ((close: () => void, open: boolean) => ReactNode);
}

// A top-bar icon button that opens an anchored dropdown panel (replaces modals
// for the top-right controls). Handles open/close, click-outside and animation.
export function Dropdown({ icon: Icon, title, label, badge, cornerBadge, badgeLabel, accent, width = 300, keepMounted = false, preload = false, loading = false, panelClassName = "", align = "start", compact = false, shortcut, onOpen, controlledOpen, onOpenChange, controlId, tourId, children }: Props) {
  const [internalOpen, setInternalOpen] = useState(false);
  const open = controlledOpen ?? internalOpen;
  const setOpen = useCallback((value: boolean) => { setInternalOpen(value); onOpenChange?.(value); }, [onOpenChange]);
  const [visited, setVisited] = useState(false);
  const showSpinner = useDelayedLoading(loading);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [leftOffset, setLeftOffset] = useState(0);
  const close = useCallback(() => setOpen(false), [setOpen]);

  useExclusiveMenu(title, open, close);
  useEffect(() => {
    if (!controlId) return;
    return registerAppControlMenu(controlId, value => { if (value) { setVisited(true); onOpen?.(); } setOpen(value); });
  }, [controlId, onOpen, setOpen]);

  // An open panel never moves on screen. Its left edge is chosen once when it
  // opens and then held, even when the trigger changes width underneath it (a
  // chip showing or hiding its value shifts a right-aligned trigger). It only
  // shifts if the window becomes too narrow to contain it. The offset is written
  // straight to the DOM inside the observer callback, which runs before paint,
  // so there is never a frame at a stale position.
  const pinnedLeft = useRef<number | null>(null);
  const reposition = useRef<(() => void) | null>(null);
  useLayoutEffect(() => {
    if (!open) { pinnedLeft.current = null; return; }
    const position = () => {
      if (!ref.current || !panelRef.current) return;
      const anchor = ref.current.getBoundingClientRect();
      const panelWidth = panelRef.current.getBoundingClientRect().width;
      const desiredLeft = pinnedLeft.current ?? (align === "end" ? anchor.right - panelWidth : anchor.left);
      const left = Math.max(12, Math.min(desiredLeft, window.innerWidth - panelWidth - 12));
      pinnedLeft.current = left;
      const offset = left - anchor.left;
      panelRef.current.style.left = `${offset}px`;
      setLeftOffset(offset);
    };
    reposition.current = position;
    position();
    const observer = new ResizeObserver(position);
    observer.observe(panelRef.current ?? document.body);
    if (ref.current) observer.observe(ref.current);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); };
  }, [open, width, align]);
  // A re-render (for example the trigger chip changing width) is corrected in
  // the same commit, before any frame can see the panel moved with its trigger.
  useLayoutEffect(() => { if (open) reposition.current?.(); });

  const toggle = () => {
    if (!open) onOpen?.();
    setVisited(true);
    setOpen(!open);
  };

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
  }, [open, setOpen]);

  return (
    <div className="menu-wrap" ref={ref} data-tour={tourId}>
      {label ? (
        <button
          type="button"
          className={`btn ${accent ? "btn-accent" : ""} ${open ? "btn-on" : ""} dropdown-label-btn`}
          onClick={toggle}
          title={title}
          aria-keyshortcuts={shortcut?.keys}
          aria-busy={loading}
        >
          {showSpinner ? <Loader2 size={15} className="async-spinner" aria-hidden="true" /> : <Icon size={15} strokeWidth={2} />}
          {label}
          {shortcut ? <kbd className="kbd" aria-hidden="true">{shortcut.label}</kbd> : null}
        </button>
      ) : badge != null || cornerBadge != null ? (
        <motion.button
          type="button"
          className={`icon-btn ${badge != null ? "toolbar-chip" : ""} ${open ? "icon-btn-on" : ""} ${accent ? "icon-btn-accent" : ""}`}
          onClick={toggle}
          title={badgeLabel ?? title}
          aria-label={badgeLabel ?? title}
          aria-busy={loading}
          whileTap={{ scale: 0.92 }}
          transition={{ type: "spring", stiffness: 500, damping: 24 }}
        >
          <span className="toolbar-icon-anchor">
            {showSpinner ? <Loader2 size={16} className="async-spinner" aria-hidden="true" /> : <Icon size={16} strokeWidth={1.9} aria-hidden="true" />}
            {cornerBadge != null ? <span className="corner-badge" aria-hidden="true">{cornerBadge}</span> : null}
          </span>
          {badge != null ? <span className="toolbar-chip-info" aria-hidden="true">{badge}</span> : null}
        </motion.button>
      ) : (
        <IconButton
          icon={Icon}
          onClick={toggle}
          title={title}
          accent={accent}
          active={open}
          loading={loading}
          allowWhileLoading
        />
      )}
      {open || (keepMounted && (visited || preload)) ? (
        <div ref={panelRef} className={`menu menu-panel ${compact ? "menu-compact" : ""} ${panelClassName}`} style={{ width, maxWidth: "calc(100vw - 24px)", left: leftOffset, right: "auto", display: open ? undefined : "none" }}>
          {typeof children === "function" ? children(close, open) : children}
        </div>
      ) : null}
    </div>
  );
}
