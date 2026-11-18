import { useRef, useState, type KeyboardEvent, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import type { ResizeAxis } from "./autoLayout";

// Rows a tile may span; the canvas auto layout clamps to the same limit.
export const MAX_TILE_ROWS = 4;

type Axis = ResizeAxis;
// Column/row units in 0.5 steps.
type Span = { c: number; r: number };
// A resolved drag: the span to save and the tile's box (viewport pixels) once saved.
export interface ResizeTarget { c: number; r: number; left: number; top: number; width: number; height: number }
// Turns the wanted right/bottom edge (viewport pixels) into the size the tile
// ends at. Made by the canvas when a drag starts, from the grid as laid out then.
export type TileResizer = (axis: Axis, edgeX: number, edgeY: number) => ResizeTarget | null;
interface Drag {
  axis: Axis;
  pointer: number;
  x: number;
  y: number;
  // The tile's box when the drag started.
  left: number;
  top: number;
  right: number;
  bottom: number;
  resolve: TileResizer;
  moved: boolean;
}
// Two clicks (presses released without dragging) close in time and space count
// as a double-click: pointer capture on a prevented pointerdown makes native
// dblclick unreliable across engines. Only clicks count, and only on release:
// a press that might start a drag always starts one, so a quick retry right
// after a drag that stayed under the snap step is never taken for a reset.
const DOUBLE_CLICK_MS = 400;
const DOUBLE_CLICK_PX = 6;
// Movement under this is still a click, not a drag.
const DRAG_THRESHOLD_PX = 3;
const CURSOR: Record<Axis, string> = { x: "is-resizing-x", y: "is-resizing-y", xy: "is-resizing-xy" };

// Edge and corner grips that resize a tile by dragging. The outline shows the
// tile exactly as it will be once the size is saved (the canvas lays the
// whole grid out for each reachable size, see chooseResize), and the size is
// written once on release, so terminals reflow a single time. Double-click
// resets to auto.
export function TileResizeHandles({ span, columns, resizer, onCommit, onReset }: {
  span: Span;
  columns: number;
  resizer: () => TileResizer | null;
  onCommit: (c: number, r: number) => void;
  onReset: () => void;
}) {
  const drag = useRef<Drag | null>(null);
  const lastClick = useRef<{ time: number; x: number; y: number } | null>(null);
  const [ghost, setGhost] = useState<(ResizeTarget & { axis: Axis }) | null>(null);
  // Work in whole tracks, report in units.
  const clampSpan = (cTracks: number, rTracks: number): Span => ({
    c: Math.max(1, Math.min(columns * 2, Math.round(cTracks))) / 2,
    r: Math.max(1, Math.min(MAX_TILE_ROWS * 2, Math.round(rTracks))) / 2,
  });
  // The grip follows the pointer: the dragged edge moves as far as the pointer did.
  const target = (state: Drag, clientX: number, clientY: number): ResizeTarget | null =>
    state.resolve(state.axis, state.right + clientX - state.x, state.bottom + clientY - state.y);

  const onPointerDown = (event: PointerEvent<HTMLElement>, axis: Axis) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const tile = event.currentTarget.closest(".tile");
    const resolve = resizer();
    if (!(tile instanceof HTMLElement) || !resolve) return;
    const rect = tile.getBoundingClientRect();
    drag.current = {
      axis, pointer: event.pointerId, x: event.clientX, y: event.clientY,
      left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom, resolve, moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    document.documentElement.classList.add(CURSOR[axis]);
  };
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointer) return;
    if (!state.moved && Math.hypot(event.clientX - state.x, event.clientY - state.y) < DRAG_THRESHOLD_PX) return;
    state.moved = true;
    const next = target(state, event.clientX, event.clientY);
    if (next) setGhost({ ...next, axis: state.axis });
  };
  const finish = (event: PointerEvent<HTMLElement>, commit: boolean) => {
    const state = drag.current;
    if (!state || event.pointerId !== state.pointer) return;
    drag.current = null;
    setGhost(null);
    document.documentElement.classList.remove(CURSOR[state.axis]);
    if (!commit) return;
    if (!state.moved) {
      // A click: the second one in a row resets the tile to its auto size.
      const previous = lastClick.current;
      const now = performance.now();
      const repeat = previous !== null && now - previous.time <= DOUBLE_CLICK_MS &&
        Math.abs(state.x - previous.x) <= DOUBLE_CLICK_PX && Math.abs(state.y - previous.y) <= DOUBLE_CLICK_PX;
      lastClick.current = repeat ? null : { time: now, x: state.x, y: state.y };
      if (repeat) onReset();
      return;
    }
    lastClick.current = null;
    const next = target(state, event.clientX, event.clientY);
    if (!next) return;
    // An auto tile keeps its auto size when the drag ends where it already is.
    const moves = Math.abs(next.left - state.left) > 1 || Math.abs(next.top - state.top) > 1 ||
      Math.abs(next.left + next.width - state.right) > 1 || Math.abs(next.top + next.height - state.bottom) > 1;
    if (next.c !== span.c || next.r !== span.r || moves) onCommit(next.c, next.r);
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
