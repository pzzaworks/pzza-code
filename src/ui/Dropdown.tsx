import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { IconButton } from "./IconButton";
import { useDelayedLoading } from "./useDelayedLoading";
import { useExclusiveMenu } from "./menuBus";
import { registerAppControlMenu } from "../appControlRuntime";

interface Props {
  icon: LucideIcon;
  title: string;
  label?: string;
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
  onOpen?: () => void;
  controlledOpen?: boolean;
  onOpenChange?: (open: boolean) => void;
  children: ReactNode | ((close: () => void, open: boolean) => ReactNode);
}

// A top-bar icon button that opens an anchored dropdown panel (replaces modals
// for the top-right controls). Handles open/close, click-outside and animation.
export function Dropdown({ icon: Icon, title, label, accent, width = 300, keepMounted = false, preload = false, loading = false, panelClassName = "", align = "start", compact = false, shortcut, onOpen, controlledOpen, onOpenChange, controlId, children }: Props) {
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

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!ref.current || !panelRef.current) return;
      const anchor = ref.current.getBoundingClientRect();
      const panelWidth = panelRef.current.getBoundingClientRect().width;
      const desiredLeft = align === "end" ? anchor.right - panelWidth : anchor.left;
      const left = Math.max(12, Math.min(desiredLeft, window.innerWidth - panelWidth - 12));
      setLeftOffset(left - anchor.left);
    };
    position();
    const observer = new ResizeObserver(position);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); };
  }, [open, width, align]);

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
    <div className="menu-wrap" ref={ref}>
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
