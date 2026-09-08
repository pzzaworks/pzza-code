import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { IconButton } from "./IconButton";
import { useDelayedLoading } from "./useDelayedLoading";
import { useExclusiveMenu } from "./menuBus";

interface Props {
  icon: LucideIcon;
  title: string;
  label?: string;
  accent?: boolean;
  width?: number;
  keepMounted?: boolean;
  loading?: boolean;
  panelClassName?: string;
  onOpen?: () => void;
  children: ReactNode | ((close: () => void, open: boolean) => ReactNode);
}

// A top-bar icon button that opens an anchored dropdown panel (replaces modals
// for the top-right controls). Handles open/close, click-outside and animation.
export function Dropdown({ icon: Icon, title, label, accent, width = 300, keepMounted = false, loading = false, panelClassName = "", onOpen, children }: Props) {
  const [open, setOpen] = useState(false);
  const [visited, setVisited] = useState(false);
  const showSpinner = useDelayedLoading(loading);
  const ref = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const [rightOffset, setRightOffset] = useState(0);
  const close = useCallback(() => setOpen(false), []);

  useExclusiveMenu(title, open, close);

  useLayoutEffect(() => {
    if (!open) return;
    const position = () => {
      if (!ref.current || !panelRef.current) return;
      const anchor = ref.current.getBoundingClientRect();
      const panelWidth = panelRef.current.getBoundingClientRect().width;
      const left = Math.max(12, Math.min(anchor.right - panelWidth, window.innerWidth - panelWidth - 12));
      setRightOffset(anchor.right - left - panelWidth);
    };
    position();
    const observer = new ResizeObserver(position);
    if (panelRef.current) observer.observe(panelRef.current);
    window.addEventListener("resize", position);
    return () => { observer.disconnect(); window.removeEventListener("resize", position); };
  }, [open, width]);

  const toggle = () => {
    if (!open) onOpen?.();
    setVisited(true);
    setOpen((value) => !value);
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
  }, [open]);

  return (
    <div className="menu-wrap" ref={ref}>
      {label ? (
        <button
          type="button"
          className={`btn ${accent ? "btn-accent" : ""} ${open ? "btn-on" : ""} dropdown-label-btn`}
          onClick={toggle}
          title={title}
          aria-busy={loading}
        >
          {showSpinner ? <Loader2 size={15} className="async-spinner" aria-hidden="true" /> : <Icon size={15} strokeWidth={2} />}
          {label}
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
      {open || (keepMounted && visited) ? (
        <div ref={panelRef} className={`menu menu-panel ${panelClassName}`} style={{ width, maxWidth: "calc(100vw - 24px)", right: rightOffset, display: open ? undefined : "none" }}>
          {typeof children === "function" ? children(close, open) : children}
        </div>
      ) : null}
    </div>
  );
}
