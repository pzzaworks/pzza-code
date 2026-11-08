import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";

// Rows a tile may span; the canvas auto layout clamps to the same limit.
export const MAX_TILE_ROWS = 4;

type Axis = "x" | "y" | "xy";
// Column/row units in 0.5 steps.
type Span = { c: number; r: number };
interface Drag {
  axis: Axis;
  pointer: number;
  x: number;
  y: number;
  left: number;
  top: number;
  width: number;
  height: number;
  // Size of one grid track: half a column, half a row.
  colTrack: number;
  rowTrack: number;
  gapX: number;
  gapY: number;
  moved: boolean;
}

// Two presses close in time and space count as a double-click: pointer capture
// on a prevented pointerdown makes native dblclick unreliable across engines.
const DOUBLE_PRESS_MS = 400;
const DOUBLE_PRESS_PX = 6;
const CURSOR: Record<Axis, string> = { x: "is-resizing-x", y: "is-resizing-y", xy: "is-resizing-xy" };

// Edge and corner grips that resize a tile by dragging. The drag previews the
// snapped span (half column / half row steps) as an outline and writes it once
// on release, so terminals reflow a single time. Double-click resets to auto.
export function TileResizeHandles({ span, columns, onCommit, onReset }: {
  span: Span;
  columns: number;
  onCommit: (c: number, r: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<Drag | null>(null);
  const lastPress = useRef<{ time: number; x: number; y: number } | null>(null);
  const [ghost, setGhost] = useState<{ axis: Axis; left: number; top: number; width: number; height: number; c: number; r: number } | null>(null);
  // Work in whole tracks, report in units.
  const clampSpan = (cTracks: number, rTracks: number): Span => ({
    c: Math.max(1, Math.min(columns * 2, Math.round(cTracks))) / 2,
    r: Math.max(1, Math.min(MAX_TILE_ROWS * 2, Math.round(rTracks))) / 2,
  });
  const target = (state: Drag, clientX: number, clientY: number): Span => clampSpan(
    state.axis === "y" ? span.c * 2 : (state.width + clientX - state.x + state.gapX) / state.colTrack,
    state.axis === "x" ? span.r * 2 : (state.height + clientY - state.y + state.gapY) / state.rowTrack,
  );

  const onPointerDown = (event: PointerEvent<HTMLElement>, axis: Axis) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const previous = lastPress.current;
    const now = performance.now();
    lastPress.current = { time: now, x: event.clientX, y: event.clientY };
    if (previous && now - previous.time <= DOUBLE_PRESS_MS &&
        Math.abs(event.clientX - previous.x) <= DOUBLE_PRESS_PX && Math.abs(event.clientY - previous.y) <= DOUBLE_PRESS_PX) {
      lastPress.current = null;
      onReset();
      return;
    }
    const tile = event.currentTarget.closest(".tile");
    const grid = tile?.parentElement;
    if (!(tile instanceof HTMLElement) || !grid) return;
    // Measure the live grid tracks so snapping matches the browser's layout:
    // a column track is the grid width split evenly, a row track is this
    // tile's height divided by the tracks it spans (rows stretch to fill).
    const rect = tile.getBoundingClientRect();
    const style = getComputedStyle(grid);
    const gapX = parseFloat(style.columnGap) || 0;
    const gapY = parseFloat(style.rowGap) || 0;
    drag.current = {
      axis, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top, width: rect.width, height: rect.height,
      colTrack: (grid.getBoundingClientRect().width + gapX) / Math.max(1, columns * 2),
      rowTrack: (rect.height + gapY) / Math.max(1, span.r * 2),
      gapX, gapY, moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.classList.add(CURSOR[axis]);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointer) return;
    if (!state.moved && Math.hypot(event.clientX - state.x, event.clientY - state.y) < 3) return;
    state.moved = true;
    const next = target(state, event.clientX, event.clientY);
    setGhost({
      axis: state.axis, left: state.left, top: state.top, c: next.c, r: next.r,
      width: next.c * 2 * state.colTrack - state.gapX,
      height: next.r * 2 * state.rowTrack - state.gapY,
    });
  };
  const finish = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointer) return;
    drag.current = null;
    setGhost(null);
    document.documentElement.classList.remove(CURSOR[state.axis]);
    if (!commit || !state.moved) return;
    const next = target(state, event.clientX, event.clientY);
    if (next.c !== span.c || next.r !== span.r) onCommit(next.c, next.r);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const delta: Record<string, [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    const step = delta[event.key];
    if (!step) return;
    event.preventDefault();
    event.stopPropagation();
    const next = clampSpan(span.c * 2 + step[0], span.r * 2 + step[1]);
    if (next.c !== span.c || next.r !== span.r) onCommit(next.c, next.r);
  };
  const grip = (axis: Axis) => ({
    onPointerDown: (event: PointerEvent<HTMLElement>) => onPointerDown(event, axis),
    onPointerMove,
    onPointerUp: (event: PointerEvent<HTMLElement>) => finish(event, true),
    onPointerCancel: (event: PointerEvent<HTMLElement>) => finish(event, false),
    onMouseDown: (event: { stopPropagation: () => void }) => event.stopPropagation(),
  });
  // Automatic rows can share a row in thirds; name the nearest half step.
  const label = `Resize tile (${Math.round(span.c * 2) / 2} × ${Math.round(span.r * 2) / 2}). Drag or use arrow keys; double-click for auto size`;
  const dragging = (axis: Axis) => (ghost?.axis === axis ? "is-dragging" : "");

  return <>
    <div className={`tile-resize tile-resize-x ${dragging("x")}`} title="Drag to resize the width · double-click for auto size" aria-hidden="true" {...grip("x")} />
    <div className={`tile-resize tile-resize-y ${dragging("y")}`} title="Drag to resize the height · double-click for auto size" aria-hidden="true" {...grip("y")} />
    <button type="button" className={`tile-resize tile-resize-xy ${dragging("xy")}`} title={label} aria-label={label} onKeyDown={onKeyDown} {...grip("xy")}>
      {/* Two short arcs concentric with the tile's rounded corner, so the grip
          sits inside the radius instead of being clipped by it. */}
      <svg viewBox="0 0 12 12" aria-hidden="true">
        <path d="M7.99 2.91A8.5 8.5 0 0 1 2.91 7.99M4.7 1.71A5 5 0 0 1 1.71 4.7" />
      </svg>
    </button>
    {ghost ? createPortal(
      <div className="tile-resize-ghost" style={{ left: ghost.left, top: ghost.top, width: ghost.width, height: ghost.height }} aria-hidden="true">
        <span>{ghost.c} × {ghost.r}</span>
      </div>, document.body,
    ) : null}
  </>;
}
