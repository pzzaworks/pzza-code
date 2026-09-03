import { useEffect, type ComponentType } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion } from "framer-motion";
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

// Shared animated modal: fade backdrop + spring-in card, Escape to close.
export function Modal({ open, onClose, title, icon: Icon, size = "md", children }: Props) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return createPortal(
    <AnimatePresence>
      {open ? (
        <motion.div
          className="modal-backdrop pzza-portal"
          onMouseDown={onClose}
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
        >
          <motion.div
            className={`modal modal-${size}`}
            role="dialog"
            aria-label={title}
            onMouseDown={(e) => e.stopPropagation()}
            initial={{ opacity: 0, scale: 0.96, y: 10 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.97, y: 8 }}
            transition={{ type: "spring", stiffness: 360, damping: 28 }}
          >
            <div className="modal-head">
              <span className="modal-title">
                {Icon ? <Icon size={15} className="modal-title-icon" /> : null}
                {title}
              </span>
              <IconButton icon={X} onClick={onClose} title="Close" size={15} />
            </div>
            <div className="modal-body">{children}</div>
          </motion.div>
        </motion.div>
      ) : null}
    </AnimatePresence>,
    document.body,
  );
}
