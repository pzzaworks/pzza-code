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
}

// A draggable divider between two panes. Dragging only touches the DOM; the
// final size is committed once on release so the store is not written per move.
export function SplitHandle({ axis, className, label, handleRef, step, ariaValue, read, fromPointer, clamp, preview, commit }: SplitHandleProps) {
  const dragging = useRef<number | null>(null);
  const resizingClass = axis === "x" ? "is-resizing-x" : "is-resizing-y";

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
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
