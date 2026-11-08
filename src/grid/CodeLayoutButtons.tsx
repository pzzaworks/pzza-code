import { useEffect, useRef } from "react";
import { Columns2, Maximize2, Minimize2, Rows2, X } from "lucide-react";
import { confirmEditorDiscard } from "../editorChanges";
import { useStore } from "../state/store";

type SplitLayout = "side-by-side" | "stacked";

// Direct editor layout controls: one button flips the split orientation (its
// icon shows the current one), the other enters or leaves the full editor.
// Leaving full returns to the last split orientation used in this tile. The x
// closes the editor (back to the terminal), asking first about unsaved changes.
export function CodeLayoutButtons({ tileId }: { tileId: string }) {
  const layout = useStore((s) => s.tileCode[tileId]?.layout ?? "side-by-side");
  const setLayout = useStore((s) => s.setTileCodeLayout);
  const toggleTileCode = useStore((s) => s.toggleTileCode);
  const lastSplit = useRef<SplitLayout>(layout === "stacked" ? "stacked" : "side-by-side");
  useEffect(() => { if (layout !== "full") lastSplit.current = layout; }, [layout]);
  const split = layout === "full" ? lastSplit.current : layout;
  const full = layout === "full";
  const flipLabel = full
    ? `Split ${split === "stacked" ? "stacked" : "side by side"}`
    : split === "stacked" ? "Stacked: switch to side by side" : "Side by side: switch to stacked";
  const fullLabel = full ? "Exit full editor" : "Full editor";
  return <>
    <button
      type="button"
      className="tile-btn"
      title={flipLabel}
      aria-label={flipLabel}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => setLayout(tileId, full ? split : split === "stacked" ? "side-by-side" : "stacked")}
    >
      {split === "stacked" ? <Rows2 size={13} /> : <Columns2 size={13} />}
    </button>
    <button
      type="button"
      className={`tile-btn ${full ? "tile-btn-on" : ""}`}
      title={fullLabel}
      aria-label={fullLabel}
      aria-pressed={full}
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => setLayout(tileId, full ? split : "full")}
    >
      {full ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
    </button>
    <button
      type="button"
      className="tile-btn"
      title="Close editor"
      aria-label="Close editor"
      onMouseDown={(event) => event.stopPropagation()}
      onClick={() => { void confirmEditorDiscard([tileId]).then((confirmed) => { if (confirmed) toggleTileCode(tileId); }); }}
    >
      <X size={13} />
    </button>
  </>;
}
