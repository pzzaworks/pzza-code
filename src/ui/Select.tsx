import { useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
import { Check, ChevronDown } from "lucide-react";

export interface Option {
  value: string;
  label: string;
  sub?: string;
}

interface Props {
  value: string;
  options: Option[];
  onChange: (value: string) => void;
  placeholder?: string;
}

// Custom select (never a native <select>). The list renders in a portal at the
// document root, so it is never clipped by a scrolling panel and always stacks
// above everything.
export function Select({ value, options, onChange, placeholder }: Props) {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const current = options.find((o) => o.value === value);

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
        className={`cselect ${open ? "cselect-open" : ""}`}
        onClick={() => setOpen((v) => !v)}
      >
        <span className="cselect-value">{current?.label ?? placeholder ?? "Select"}</span>
        <ChevronDown size={14} className={`muted-icon ${open ? "flip" : ""}`} />
      </button>

      {open && rect
        ? createPortal(
            <div className="cselect-backdrop pzza-portal" onMouseDown={() => setOpen(false)}>
              <AnimatePresence>
                <motion.div
                  className="cselect-menu"
                  style={{ left: rect.left, top: rect.bottom + 5, minWidth: rect.width }}
                  onMouseDown={(e) => e.stopPropagation()}
                  initial={{ opacity: 0, y: -6, scale: 0.98 }}
                  animate={{ opacity: 1, y: 0, scale: 1 }}
                  transition={{ duration: 0.12 }}
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
                      <span className="cselect-item-main">
                        <span className="cselect-item-label">{o.label}</span>
                        {o.sub ? <span className="cselect-item-sub">{o.sub}</span> : null}
                      </span>
                      {o.value === value ? <Check size={14} /> : null}
                    </button>
                  ))}
                </motion.div>
              </AnimatePresence>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
