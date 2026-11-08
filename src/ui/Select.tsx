import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Check, ChevronDown } from "lucide-react";

export interface Option {
  value: string;
  label: string;
  sub?: string;
  icon?: ReactNode;
}

interface Props {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  onOpen?: () => void;
  // "end" anchors the list to the trigger's right edge, for controls near the panel edge.
  align?: "start" | "end";
  className?: string;
  title?: string;
}

// Room kept between an open list and the window edge.
const EDGE = 8;

// Custom select (never a native <select>). The list renders in a portal at the
// document root, so it is never clipped by a scrolling panel and always stacks
// above everything.
export function Select({ value, options, onChange, placeholder, disabled = false, ariaLabel, onOpen, align = "start", className = "", title }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const current = options.find((o) => o.value === value);
  // Keeps the open list inside the window: a list wider than the room right
  // of its trigger moves left (or right, when anchored at the end).
  useLayoutEffect(() => {
    const menu = menuRef.current;
    if (!open || !rect || !menu) return;
    const box = menu.getBoundingClientRect();
    if (box.right > window.innerWidth - EDGE) { menu.style.left = `${Math.max(EDGE, window.innerWidth - EDGE - box.width)}px`; menu.style.right = "auto"; }
    else if (box.left < EDGE) { menu.style.left = `${EDGE}px`; menu.style.right = "auto"; }
  }, [open, rect]);
  useLayoutEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  useLayoutEffect(() => {
    if (!open) return;
    const update = () => btnRef.current && setRect(btnRef.current.getBoundingClientRect());
    update();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className={`cselect ${open ? "cselect-open" : ""} ${className}`}
        disabled={disabled}
        aria-label={ariaLabel}
        title={title}
        onClick={() => { if (!open) onOpen?.(); setOpen((v) => !v); }}
      >
        {current?.icon}
        <span className="cselect-value">{current?.label ?? placeholder ?? "Select"}</span>
        <ChevronDown size={14} className={`muted-icon ${open ? "flip" : ""}`} />
      </button>

      {open && rect
        ? createPortal(
            <div className="cselect-backdrop pzza-portal" onMouseDown={() => setOpen(false)}>
              {/* As wide as its longest option (never wrapped), at least the
                  trigger's width, and moved left when it would leave the window.
                  It opens with the shared menu animation (CSS). */}
                <div
                  ref={menuRef}
                  className="cselect-menu"
                  style={{ ...(align === "end" ? { right: window.innerWidth - rect.right } : { left: rect.left }), top: rect.bottom + 5, minWidth: rect.width, width: "max-content", maxWidth: `calc(100vw - ${2 * EDGE}px)` }}
                  onMouseDown={(e) => e.stopPropagation()}
                >
                  {options.map((o) => (
                    <button
                      key={o.value}
                      type="button"
                      className={`cselect-item ${o.value === value ? "cselect-item-on" : ""}`}
                      onClick={() => {
                        onChange(o.value);
                        setOpen(false);
                      }}
                    >
                      {o.icon}
                      <span className="cselect-item-main">
                        <span className="cselect-item-label">{o.label}</span>
                        {o.sub ? <span className="cselect-item-sub">{o.sub}</span> : null}
                      </span>
                      <span className="cselect-item-check">{o.value === value ? <Check size={14} /> : null}</span>
                    </button>
                  ))}
                </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
