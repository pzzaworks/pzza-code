import { useRef, type KeyboardEvent, type PointerEvent, type Ref } from "react";

interface SplitHandleProps {
  // "x" drags left/right across a vertical divider, "y" up/down across a horizontal one.
  axis: "x" | "y";
  className: string;
  label: string;
  handleRef?: Ref<HTMLDivElement>;
  // Arrow-key step, in the same unit as the size.
  step: number;
  ariaValue?: { now: number; min: number; max: number };
  // Current size, read from the live layout.
  read: (handle: HTMLElement) => number;
  // Size for a pointer position, already clamped.
  fromPointer: (clientX: number, clientY: number, handle: HTMLElement) => number;
  clamp: (size: number, handle: HTMLElement) => number;
  // Applies a size to the DOM while dragging, without persisting it.
  preview: (size: number, handle: HTMLElement) => void;
  commit: (size: number) => void;
  // Size a double-click snaps to (for example centered, or fitted to content).
  reset?: (handle: HTMLElement) => number | null;
}

// Pointer capture and a prevented pointerdown make native dblclick unreliable
// across engines, so two presses close in time and space count as one.
const DOUBLE_PRESS_MS = 400;
const DOUBLE_PRESS_PX = 6;

// A draggable divider between two panes. Dragging only touches the DOM; the
// final size is committed once on release so the store is not written per move.
export function SplitHandle({ axis, className, label, handleRef, step, ariaValue, read, fromPointer, clamp, preview, commit, reset }: SplitHandleProps) {
  const dragging = useRef<number | null>(null);
  const lastPress = useRef<{ time: number; x: number; y: number } | null>(null);
  const resizingClass = axis === "x" ? "is-resizing-x" : "is-resizing-y";

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    const previous = lastPress.current;
    const now = performance.now();
    lastPress.current = { time: now, x: event.clientX, y: event.clientY };
    if (reset && previous && now - previous.time <= DOUBLE_PRESS_MS &&
        Math.abs(event.clientX - previous.x) <= DOUBLE_PRESS_PX && Math.abs(event.clientY - previous.y) <= DOUBLE_PRESS_PX) {
      lastPress.current = null;
      const handle = event.currentTarget;
      const target = reset(handle);
      if (target !== null) {
        const size = clamp(target, handle);
        preview(size, handle);
        commit(size);
      }
      return;
    }
    // Capture keeps the drag alive over the terminal, editor and PDF iframes.
    event.currentTarget.setPointerCapture(event.pointerId);
    dragging.current = read(event.currentTarget);
    document.documentElement.classList.add(resizingClass);
  };
  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (dragging.current === null) return;
    const size = fromPointer(event.clientX, event.clientY, event.currentTarget);
    dragging.current = size;
    preview(size, event.currentTarget);
  };
  const onLostPointerCapture = () => {
    const size = dragging.current;
    dragging.current = null;
    document.documentElement.classList.remove(resizingClass);
    if (size !== null) commit(size);
  };
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const back = axis === "x" ? "ArrowLeft" : "ArrowUp";
    const forward = axis === "x" ? "ArrowRight" : "ArrowDown";
    if (event.key !== back && event.key !== forward) return;
    event.preventDefault();
    event.stopPropagation();
    const handle = event.currentTarget;
    const size = clamp(read(handle) + (event.key === forward ? step : -step), handle);
    preview(size, handle);
    commit(size);
  };

  return (
    <div
      ref={handleRef}
      role="separator"
      tabIndex={0}
      aria-label={label}
      aria-orientation={axis === "x" ? "vertical" : "horizontal"}
      aria-valuenow={ariaValue?.now}
      aria-valuemin={ariaValue?.min}
      aria-valuemax={ariaValue?.max}
      className={`split-handle split-handle-${axis} ${className}`}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onLostPointerCapture={onLostPointerCapture}
      onKeyDown={onKeyDown}
    />
  );
}
