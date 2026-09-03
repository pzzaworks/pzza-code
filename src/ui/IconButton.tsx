import { motion } from "framer-motion";
import type { LucideIcon } from "lucide-react";

interface Props {
  icon: LucideIcon;
  onClick?: () => void;
  title?: string;
  active?: boolean;
  accent?: boolean;
  danger?: boolean;
  disabled?: boolean;
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
  size = 16,
  spin,
  className = "",
}: Props) {
  return (
    <motion.button
      type="button"
      className={`icon-btn ${active ? "icon-btn-on" : ""} ${
        accent ? "icon-btn-accent" : ""
      } ${danger ? "icon-btn-danger" : ""} ${className}`}
      onClick={onClick}
      title={title}
      disabled={disabled}
      whileTap={disabled ? undefined : { scale: 0.86 }}
      transition={{ type: "spring", stiffness: 500, damping: 24 }}
    >
      <motion.span
        className="icon-inner"
        animate={spin ? { rotate: 360 } : { rotate: 0 }}
        transition={
          spin ? { repeat: Infinity, duration: 0.8, ease: "linear" } : { duration: 0.15 }
        }
      >
        <Icon size={size} strokeWidth={1.9} />
      </motion.span>
    </motion.button>
  );
}
