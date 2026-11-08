// While a tile drag previews where it will land, tiles change size on every
// hover. Terminals hold their current size meanwhile and fit once when the
// preview ends, so the PTYs see one resize instead of one per hover.
const END_EVENT = "pzza:layout-preview-end";
let active = false;

export function layoutPreviewActive(): boolean {
  return active;
}

export function setLayoutPreview(next: boolean): void {
  if (active === next) return;
  active = next;
  if (!next) window.dispatchEvent(new Event(END_EVENT));
}

export function onLayoutPreviewEnd(listener: () => void): () => void {
  window.addEventListener(END_EVENT, listener);
  return () => window.removeEventListener(END_EVENT, listener);
}
