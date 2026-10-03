import { useLayoutEffect, useRef } from "react";
import { useStore } from "../state/store";
import { SplitHandle } from "../ui/SplitHandle";

const MIN_SPLIT = 0.15;
const MAX_SPLIT = 0.85;
const clampSplit = (split: number) => Math.min(MAX_SPLIT, Math.max(MIN_SPLIT, split));

// Sets the tile body's --code-split, which positions the terminal, the editor
// and this handle in the side-by-side and stacked layouts.
function applySplit(body: HTMLElement | null, split: number) {
  body?.style.setProperty("--code-split", `${split * 100}%`);
}

// Divider between a tile's terminal and its inline code editor.
export function CodeSplitHandle({ tileId }: { tileId: string }) {
  const layout = useStore((s) => s.tileCode[tileId]?.layout ?? "side-by-side");
  const split = clampSplit(useStore((s) => s.tileCode[tileId]?.split ?? 0.5));
  const setTileCodeSizes = useStore((s) => s.setTileCodeSizes);
  const ref = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const body = ref.current?.parentElement ?? null;
    applySplit(body, split);
    return () => { body?.style.removeProperty("--code-split"); };
  }, [split, layout]);

  if (layout === "full") return null;
  const axis = layout === "stacked" ? "y" : "x";
  const fromPointer = (x: number, y: number, handle: HTMLElement) => {
    const rect = handle.parentElement?.getBoundingClientRect();
    if (!rect || rect.width === 0 || rect.height === 0) return split;
    return clampSplit(axis === "x" ? (x - rect.left) / rect.width : (y - rect.top) / rect.height);
  };
  const read = (handle: HTMLElement) => {
    const value = parseFloat(handle.parentElement?.style.getPropertyValue("--code-split") ?? "");
    return Number.isFinite(value) ? value / 100 : split;
  };

  return (
    <SplitHandle
      axis={axis}
      className="code-split-handle"
      label="Resize terminal and editor"
      handleRef={ref}
      step={0.05}
      ariaValue={{ now: Math.round(split * 100), min: MIN_SPLIT * 100, max: MAX_SPLIT * 100 }}
      read={read}
      fromPointer={fromPointer}
      clamp={clampSplit}
      preview={(value, handle) => applySplit(handle.parentElement, value)}
      commit={(value) => setTileCodeSizes(tileId, { split: value })}
    />
  );
}
