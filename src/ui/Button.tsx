import type { ButtonHTMLAttributes, ReactNode } from "react";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: "ghost" | "accent" | "danger";
  size?: "sm" | "md";
  children: ReactNode;
}

// The single button component. Everything is ghost (transparent + border);
// `variant` only tints (accent = subtle emphasis, danger = red). Use this for
// every new button so they stay identical.
export function Button({
  variant = "ghost",
  size = "md",
  className = "",
  children,
  ...rest
}: Props) {
  const cls = [
    "btn",
    variant === "accent" ? "btn-accent" : "",
    variant === "danger" ? "btn-danger" : "",
    size === "sm" ? "btn-sm" : "",
    className,
  ]
    .filter(Boolean)
    .join(" ");
  return (
    <button className={cls} {...rest}>
      {children}
    </button>
  );
}
