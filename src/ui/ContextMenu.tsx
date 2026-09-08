import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { copyImageToClipboard } from "../imageClipboard";
import { AsyncButton } from "./AsyncButton";

export interface ContextAction {
  label: string;
  disabled?: boolean;
  run(): void | Promise<void>;
}
const providers = new WeakMap<Element, () => ContextAction[]>();
export function registerContextMenu(element: Element, actions: () => ContextAction[]): () => void {
  providers.set(element, actions);
  return () => { providers.delete(element); };
}

export async function clipboardPaste(target: HTMLElement): Promise<void> {
  const data = new DataTransfer();
  if (navigator.clipboard?.read) {
    const items = await navigator.clipboard.read();
    for (const item of items) {
      const image = item.types.find((type) => type.startsWith("image/"));
      if (image) data.items.add(new File([await item.getType(image)], "clipboard-image", { type: image }));
      else if (item.types.includes("text/plain")) data.setData("text/plain", await (await item.getType("text/plain")).text());
    }
  } else if (navigator.clipboard?.readText) data.setData("text/plain", await navigator.clipboard.readText());
  else throw new Error("Clipboard access is unavailable. Use the keyboard paste shortcut.");
  if (!target.isConnected) throw new Error("The paste target is no longer open.");
  target.focus({ preventScroll: true });
  target.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true }));
}

export function ContextMenu() {
  const [menu, setMenu] = useState<{ x: number; y: number; actions: ContextAction[]; target: HTMLElement } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [pendingAction, setPendingAction] = useState<string | null>(null);
  const menuEpoch = useRef(0);
  const ref = useRef<HTMLDivElement>(null);
  const close = () => { menuEpoch.current++; setMenu(null); setBusy(false); setPendingAction(null); };
  useEffect(() => {
    const suppress = (event: MouseEvent) => event.preventDefault();
    const rightDown = (event: MouseEvent) => {
      // Do not send right-click mouse reports into a terminal application.
      if (event.button === 2 && event.target instanceof Element && event.target.closest(".term-surface")) {
        event.preventDefault(); event.stopPropagation();
      }
    };
    const open = (event: MouseEvent) => {
      const target = event.target instanceof HTMLElement ? event.target : null;
      if (!target || target.closest(".app-context-menu")) return;
      let actions: ContextAction[] | undefined;
      for (let node: Element | null = target; node; node = node.parentElement) {
        const provider = providers.get(node);
        if (provider) { actions = provider(); break; }
      }
      if (!actions) {
        const input = target.closest("input, textarea");
        const editor = target.closest<HTMLElement>('[contenteditable="true"]');
        const editable = input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement ? input : editor;
        const selected = input instanceof HTMLInputElement && input.type === "password" ? "" :
          input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement ? input.value.slice(input.selectionStart ?? 0, input.selectionEnd ?? 0) : window.getSelection()?.toString() || "";
        const writeable = editable && (!(editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) || (!editable.readOnly && !editable.disabled));
        const command = (name: string) => { editable?.focus(); if (!document.execCommand(name)) throw new Error("This action is unavailable here. Use its keyboard shortcut."); };
        actions = [
          { label: "Copy text", disabled: !selected, run: async () => { await navigator.clipboard.writeText(selected); } },
          ...(writeable ? [
            { label: "Cut", disabled: !selected, run: () => command("cut") },
            { label: "Paste", run: async () => {
              const text = await navigator.clipboard.readText();
              if (!editable.isConnected) throw new Error("The paste target is no longer open.");
              editable.focus();
              if (!document.execCommand("insertText", false, text)) throw new Error("Use the keyboard paste shortcut in this field.");
            } },
            { label: "Undo", run: () => command("undo") },
            { label: "Redo", run: () => command("redo") },
            { label: "Select all", run: () => { if (editable instanceof HTMLInputElement || editable instanceof HTMLTextAreaElement) editable.select(); else command("selectAll"); } },
          ] : []),
          ...(target instanceof HTMLImageElement ? [{ label: "Copy image", run: () => copyImageToClipboard(target) }] : []),
        ];
      }
      menuEpoch.current++; setError(null); setBusy(false); setPendingAction(null);
      const rect = target.getBoundingClientRect();
      setMenu({ x: event.clientX || rect.left, y: event.clientY || rect.top, actions, target });
    };
    document.addEventListener("contextmenu", suppress, true);
    document.addEventListener("contextmenu", open);
    document.addEventListener("mousedown", rightDown, true);
    document.addEventListener("mouseup", rightDown, true);
    window.addEventListener("resize", close);
    window.addEventListener("blur", close);
    return () => {
      document.removeEventListener("contextmenu", suppress, true);
      document.removeEventListener("contextmenu", open);
      document.removeEventListener("mousedown", rightDown, true);
      document.removeEventListener("mouseup", rightDown, true);
      window.removeEventListener("resize", close); window.removeEventListener("blur", close);
    };
  }, []);
  useLayoutEffect(() => {
    if (!menu || !ref.current) return;
    const element = ref.current;
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - element.offsetWidth - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - element.offsetHeight - 8))}px`;
    element.focus({ preventScroll: true });
  }, [menu, error]);
  if (!menu) return null;
  return createPortal(<div className="app-context-backdrop pzza-portal" onMouseDown={close}>
    <div ref={ref} className="menu app-context-menu" role="menu" aria-label="Context actions" tabIndex={-1}
      onMouseDown={(event) => { event.preventDefault(); event.stopPropagation(); }}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" || event.key === "Tab") { event.preventDefault(); close(); menu.target.focus({ preventScroll: true }); }
        if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) {
          event.preventDefault();
          const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button:not(:disabled)"));
          const index = items.findIndex((item) => item === document.activeElement);
          const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowUp" ? items.length - 1 : 1)) % items.length;
          items[next]?.focus();
        }
      }}>
      {menu.actions.map((action) => <AsyncButton key={action.label} className="menu-item" role="menuitem" loading={busy && pendingAction === action.label} disabled={busy || action.disabled}
        onClick={() => {
          const epoch = menuEpoch.current;
          setBusy(true); setPendingAction(action.label); setError(null);
          try {
            const result = action.run();
            void Promise.resolve(result).then(() => { if (epoch === menuEpoch.current) close(); }).catch((cause: unknown) => { if (epoch === menuEpoch.current) setError(cause instanceof Error ? cause.message : "Action failed."); }).finally(() => { if (epoch === menuEpoch.current) { setBusy(false); setPendingAction(null); } });
          } catch (cause) { setError(cause instanceof Error ? cause.message : "Action failed."); setBusy(false); setPendingAction(null); }
        }}>{action.label}</AsyncButton>)}
      {error ? <div className="context-error" role="alert">{error}</div> : null}
    </div>
  </div>, document.body);
}
