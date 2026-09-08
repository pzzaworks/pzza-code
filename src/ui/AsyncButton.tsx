import type { ButtonHTMLAttributes } from "react";
import { Loader2, type LucideIcon } from "lucide-react";
import { useDelayedLoading } from "./useDelayedLoading";
import "./AsyncButton.css";

interface Props extends ButtonHTMLAttributes<HTMLButtonElement> {
  loading: boolean;
  icon?: LucideIcon;
  iconSize?: number;
}

// Keep the label constant while the reserved icon slot shows pending work.
// The caller owns the request and its error state; no errors are intercepted here.
export function AsyncButton({ loading, icon: Icon, iconSize = 14, disabled, className = "btn", children, onClick, type = "button", ...props }: Props) {
  const showSpinner = useDelayedLoading(loading);
  return <button {...props} type={type} className={`${className} async-button`} disabled={disabled || loading} aria-busy={loading} onClick={event => { if (!loading) onClick?.(event); }}>
    <span className="async-button-icon" style={{ width: iconSize, height: iconSize }} aria-hidden="true">
      {showSpinner ? <Loader2 size={iconSize} className="async-spinner" /> : Icon ? <Icon size={iconSize} strokeWidth={2} /> : null}
    </span>
    {children}
  </button>;
}
