import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Check, Columns2, LayoutPanelLeft, Rows2, Square } from "lucide-react";
import { useStore, type TileCodeLayout } from "../state/store";

const OPTIONS = [
  { value: "full", label: "Full editor", Icon: Square },
  { value: "side-by-side", label: "Side by side", Icon: Columns2 },
  { value: "stacked", label: "Stacked", Icon: Rows2 },
] satisfies Array<{ value: TileCodeLayout; label: string; Icon: typeof Square }>;

export function CodeLayoutMenu({ tileId }: { tileId: string }) {
  const layout = useStore((s) => s.tileCode[tileId]?.layout ?? "full");
  const setLayout = useStore((s) => s.setTileCodeLayout);
  const title = "Editor layout";
  const button = useRef<HTMLButtonElement>(null);
  const [rect, setRect] = useState<DOMRect | null>(null);
  const close = () => { setRect(null); button.current?.focus(); };

  useEffect(() => {
    if (!rect) return;
    const dismiss = () => setRect(null);
    window.addEventListener("resize", dismiss);
    window.addEventListener("scroll", dismiss, true);
    return () => {
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("scroll", dismiss, true);
    };
  }, [rect]);

  return (
    <>
      <button
        ref={button}
        type="button"
        className={`tile-btn ${rect ? "tile-btn-on" : ""}`}
        title={title}
        aria-label={title}
        aria-haspopup="menu"
        aria-expanded={Boolean(rect)}
        onMouseDown={(event) => event.stopPropagation()}
        onClick={(event) => setRect(rect ? null : event.currentTarget.getBoundingClientRect())}
      >
        <LayoutPanelLeft size={13} />
      </button>
      {rect ? createPortal(
        <div className="cselect-backdrop pzza-portal" onMouseDown={close}>
          <div
            className="menu code-layout-menu"
            role="menu"
            aria-label={title}
            style={{ left: Math.max(8, Math.min(rect.right - 196, window.innerWidth - 204)), top: Math.max(8, Math.min(rect.bottom + 5, window.innerHeight - 140)) }}
            onMouseDown={(event) => {
              // Keep focus inside the menu until click selects an item. WebKit
              // blurs buttons on mouse down without focusing the next button.
              event.preventDefault();
              event.stopPropagation();
            }}
            onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget)) setRect(null); }}
            onKeyDown={(event) => {
              if (event.key === "Escape") { event.stopPropagation(); close(); return; }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
              event.preventDefault();
              const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
              const index = items.indexOf(document.activeElement as HTMLButtonElement);
              const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1
                : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
              items[next]?.focus();
            }}
          >
            {OPTIONS.map(({ value, label, Icon }) => (
              <button
                key={value}
                type="button"
                role="menuitemradio"
                aria-checked={layout === value}
                autoFocus={layout === value}
                className={`menu-item ${layout === value ? "menu-item-on" : ""}`}
                onClick={() => { setLayout(tileId, value); close(); }}
              >
                <Icon size={16} strokeWidth={1.9} />{label}
                {layout === value ? <Check size={13} className="code-layout-check" /> : null}
              </button>
            ))}
          </div>
        </div>, document.body,
      ) : null}
    </>
  );
}
