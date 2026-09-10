import { useId, useLayoutEffect, useRef, type ComponentType, type RefObject } from "react";
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
  pending?: boolean;
  initialFocusRef?: RefObject<HTMLElement>;
  role?: "dialog" | "alertdialog";
  describedBy?: string;
  className?: string;
}

const layers: HTMLElement[] = [];
const topLayer = () => [...layers].reverse().find(element => element.getAttribute("role") === "alertdialog") ?? layers[layers.length - 1];
const focusSelector = 'button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), a[href], [tabindex]:not([tabindex="-1"])';
const visible = (element: HTMLElement) => !element.closest('[hidden], [inert]') && element.getClientRects().length > 0;

// Settings keeps its content mounted, but participates in the same focus stack.
export function useModalFocus(open: boolean, dialog: RefObject<HTMLElement>, onClose: () => void, pending = false, initialFocusRef?: RefObject<HTMLElement>) {
  const latest = useRef({ onClose, pending });
  latest.current = { onClose, pending };
  useLayoutEffect(() => {
    const element = dialog.current;
    if (!open || !element) return;
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    layers.push(element);
    const backdrop = element.parentElement;
    if (backdrop) backdrop.style.zIndex = String((element.getAttribute("role") === "alertdialog" ? 1000 : 400) + layers.length);
    const topmost = () => topLayer() === element;
    const focusFirst = () => {
      const target = initialFocusRef?.current ?? [...element.querySelectorAll<HTMLElement>(focusSelector)].find(visible) ?? element;
      target.focus({ preventScroll: true });
    };
    focusFirst();
    // Custom selects are portaled above their owning dialog. Keep them usable,
    // but never allow a background select into a confirmation's focus scope.
    const selectPortal = () => element.getAttribute("role") === "alertdialog" ? null :
      [...document.querySelectorAll<HTMLElement>(".cselect-backdrop")].find(portal => visible(portal) && !!(element.compareDocumentPosition(portal) & Node.DOCUMENT_POSITION_FOLLOWING)) ?? null;
    const onFocus = (event: FocusEvent) => {
      if (!topmost() || !(event.target instanceof Node) || element.contains(event.target) || selectPortal()?.contains(event.target)) return;
      focusFirst();
    };
    const onKey = (event: KeyboardEvent) => {
      if (!topmost()) return;
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const select = selectPortal();
        if (select) { select.dispatchEvent(new MouseEvent("mousedown", { bubbles: true })); focusFirst(); return; }
        if (!latest.current.pending) latest.current.onClose();
      } else if (event.key === "Tab") {
        const scope = selectPortal() ?? element;
        const targets = [...scope.querySelectorAll<HTMLElement>(focusSelector)].filter(visible);
        const first = targets[0];
        const last = targets[targets.length - 1];
        const active = document.activeElement;
        if (!first || !scope.contains(active) || (event.shiftKey ? active === first : active === last)) {
          event.preventDefault();
          (event.shiftKey ? last ?? element : first ?? element).focus();
        }
      }
    };
    window.addEventListener("keydown", onKey, true);
    document.addEventListener("focusin", onFocus);
    return () => {
      const wasTop = topmost();
      const index = layers.indexOf(element);
      if (index >= 0) layers.splice(index, 1);
      window.removeEventListener("keydown", onKey, true);
      document.removeEventListener("focusin", onFocus);
      if (wasTop && previous?.isConnected && visible(previous)) previous.focus({ preventScroll: true });
    };
  }, [open, dialog, initialFocusRef]);
}

export function Modal({ open, onClose, title, icon: Icon, size = "md", children, pending = false, initialFocusRef, role = "dialog", describedBy, className = "" }: Props) {
  const dialog = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useModalFocus(open, dialog, onClose, pending, initialFocusRef);
  if (!open) return null;
  const close = () => { if (!pending && topLayer() === dialog.current) onClose(); };
  return createPortal(
    <div className={`modal-backdrop pzza-portal ${role === "alertdialog" ? "confirmation-backdrop" : ""}`} onMouseDown={event => { if (event.target === event.currentTarget) close(); }}>
      <div className={`modal modal-${size} ${className}`} ref={dialog} tabIndex={-1} role={role} aria-modal="true" aria-labelledby={titleId} aria-describedby={describedBy} aria-busy={pending || undefined} onMouseDown={event => event.stopPropagation()}>
        <div className="modal-head">
          <span className="modal-title" id={titleId}>{Icon ? <Icon size={15} className="modal-title-icon" /> : null}{title}</span>
          <IconButton icon={X} onClick={close} disabled={pending} title="Close" size={15} />
        </div>
        <div className="modal-body">{children}</div>
      </div>
    </div>, document.body,
  );
}
