import { useEffect, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import { IconButton } from "./IconButton";

interface Props {
  open: boolean;
  onClose: () => void;
  title: string;
  icon?: ComponentType<{ size?: number | string; className?: string }>;
  size?: "sm" | "md" | "lg" | "xl";
  children: React.ReactNode;
}

// Shared modal: portal to body (escapes any transformed ancestor), Escape to
// close. Entrance is a CSS animation, not a JS one - with many WebGL terminals
// on screen a rAF-driven animation can stall mid-frame and leave the card
// translucent, so we let CSS handle it and always settle fully opaque.
export function Modal({ open, onClose, title, icon: Icon, size = "md", children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    <div className="modal-backdrop pzza-portal" onMouseDown={onClose}>
      <div
        className={`modal modal-${size}`}
        role="dialog"
        aria-label={title}
        onMouseDown={(e) => e.stopPropagation()}
      >
        <div className="modal-head">
          <span className="modal-title">
            {Icon ? <Icon size={15} className="modal-title-icon" /> : null}
            {title}
          </span>
          <IconButton icon={X} onClick={onClose} title="Close" size={15} />
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>,
    document.body,
  );
}
