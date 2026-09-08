import { motion } from "framer-motion";
import { Loader2, type LucideIcon } from "lucide-react";
import { useDelayedLoading } from "./useDelayedLoading";
import "./AsyncButton.css";

interface Props {
  icon: LucideIcon;
  onClick?: () => void;
  title?: string;
  active?: boolean;
  accent?: boolean;
  danger?: boolean;
  disabled?: boolean;
  loading?: boolean;
  allowWhileLoading?: boolean;
  size?: number;
  spin?: boolean;
  className?: string;
}

// One consistent, animated icon button used everywhere. Hover/press spring
// animation via framer-motion; crisp lucide glyphs.
export function IconButton({
  icon: Icon,
  onClick,
  title,
  active,
  accent,
  danger,
  disabled,
  loading = false,
  allowWhileLoading = false,
  size = 16,
  spin,
  className = "",
}: Props) {
  const showSpinner = useDelayedLoading(loading);
  const blocked = disabled || (loading && !allowWhileLoading);
  return (
    <motion.button
      type="button"
      className={`icon-btn ${active ? "icon-btn-on" : ""} ${
        accent ? "icon-btn-accent" : ""
      } ${danger ? "icon-btn-danger" : ""} ${className}`}
      onClick={() => { if (!blocked) onClick?.(); }}
      title={title}
      disabled={blocked}
      aria-busy={loading}
      whileTap={blocked ? undefined : { scale: 0.86 }}
      transition={{ type: "spring", stiffness: 500, damping: 24 }}
    >
      <motion.span
        className="icon-inner"
        animate={spin ? { rotate: 360 } : { rotate: 0 }}
        transition={
          spin ? { repeat: Infinity, duration: 0.8, ease: "linear" } : { duration: 0.15 }
        }
      >
        {showSpinner ? <Loader2 size={size} className="async-spinner" aria-hidden="true" /> : <Icon size={size} strokeWidth={1.9} />}
      </motion.span>
    </motion.button>
  );
}
