import { create } from "zustand";

// Tile header drags run on pointer events (see Canvas), not HTML drag and
// drop: a native drag session snapshots the whole tile for its drag image and
// routes every move through the OS drag pasteboard and the webview's drag
// IPC, which made dragging slow. The pointer drag moves a light header ghost
// with transforms only and hit tests cached boxes once per frame.

// A tile dropped on a top-bar workspace tab; WorkspaceTabs confirms the move.
export interface TileWorkspaceDrop {
  // The tile's workspace key (host-namespaced), exactly what the grid filters by.
  session: string;
  tileId: string;
  wsId: string;
}

interface TileDragTarget {
  // The workspace tab under a dragged tile, highlighted as a drop target.
  overWorkspace: string | null;
  drop: TileWorkspaceDrop | null;
}

export const useTileDragTarget = create<TileDragTarget>(() => ({ overWorkspace: null, drop: null }));

export interface TabBox { id: string; left: number; top: number; right: number; bottom: number }

// Workspace tabs that take a tile drop carry data-ws-tab with their id. They
// are measured once per drag, so the pointer is matched against boxes rather
// than hit tested (which would flush layout every frame and could land on an
// overlay instead of the tab).
export function workspaceTabBoxes(): TabBox[] {
  return [...document.querySelectorAll<HTMLElement>("[data-ws-tab]")].flatMap((tab) => {
    const id = tab.dataset.wsTab;
    if (!id) return [];
    const { left, top, right, bottom } = tab.getBoundingClientRect();
    return [{ id, left, top, right, bottom }];
  });
}

export function workspaceTabAt(tabs: readonly TabBox[], x: number, y: number): string | null {
  return tabs.find((tab) => x >= tab.left && x < tab.right && y >= tab.top && y < tab.bottom)?.id ?? null;
}

export interface DragGhost {
  move: (x: number, y: number) => void;
  remove: () => void;
}

// A tile's canvases as they look now: each canvas of the tile mapped to a
// copy of its pixels. A WebGL terminal keeps its pixels only for the frame it
// draws, so a plain copy of its canvas comes out blank; the terminal registers
// a capture that copies them while it draws (see Terminal.tsx).
export type TileSnapshot = () => Promise<Map<HTMLCanvasElement, CanvasImageSource>>;
const snapshots = new Map<string, TileSnapshot>();

export function registerTileSnapshot(tileId: string, capture: TileSnapshot): () => void {
  snapshots.set(tileId, capture);
  return () => { if (snapshots.get(tileId) === capture) snapshots.delete(tileId); };
}

// The box the ghost fits in: the whole tile, scaled down to fit both, so a
// tall tile shrinks as much as a wide one and its status bar stays in view.
const GHOST_MAX_WIDTH = 300;
const GHOST_MAX_HEIGHT = 220;
// The ghost's corner radius when the tile reports none.
const GHOST_RADIUS = 10;

// Draws `source` over a cloned canvas, which has the original's size but no
// pixels or context of its own.
function paint(target: HTMLCanvasElement, source: CanvasImageSource): void {
  const context = target.getContext("2d");
  if (!context) return;
  context.clearRect(0, 0, target.width, target.height);
  try { context.drawImage(source, 0, 0, target.width, target.height); } catch { /* A canvas without pixels yet stays empty. */ }
}

// A scaled-down copy of the whole tile (header, content, status bar) that
// follows the pointer. The tile is cloned once and shrunk with a transform;
// its canvases are filled with their current pixels right away, and a
// terminal's again once its capture lands a frame later. The ghost lives
// outside the React tree and only ever changes its transform, so moving it
// never lays out or re-renders anything.
export function createDragGhost(tile: HTMLElement, tileId: string, x: number, y: number): DragGhost {
  const box = tile.getBoundingClientRect();
  const scale = Math.min(1, GHOST_MAX_WIDTH / Math.max(1, box.width), GHOST_MAX_HEIGHT / Math.max(1, box.height));
  // The grab point stays under the pointer, in the shrunk tile.
  const grabX = (x - box.left) * scale;
  const grabY = (y - box.top) * scale;
  const ghost = document.createElement("div");
  ghost.className = "tile-drag-ghost";
  ghost.setAttribute("aria-hidden", "true");
  ghost.inert = true;
  ghost.style.width = `${Math.round(box.width * scale)}px`;
  ghost.style.height = `${Math.round(box.height * scale)}px`;
  // The shrunk copy keeps the tile's own corners, which shrink with it (a
  // rounded clip cannot be relied on to cut its canvases in WebKit), so the
  // ghost's frame follows them: the tile's radius at the ghost's scale, plus
  // the 1px border, puts both curves on the same arc.
  const radius = parseFloat(getComputedStyle(tile).borderTopLeftRadius) || GHOST_RADIUS;
  ghost.style.borderRadius = `${radius * scale + 1}px`;
  const copy = tile.cloneNode(true) as HTMLElement;
  copy.classList.remove("tile-dragging", "tile-over");
  copy.removeAttribute("id");
  copy.classList.add("tile-drag-ghost-tile");
  copy.style.width = `${box.width}px`;
  copy.style.height = `${box.height}px`;
  // Inline, as the tile's own motion styles (a centered origin) are inline too.
  copy.style.transformOrigin = "0 0";
  copy.style.borderRadius = `${radius}px`;
  copy.style.overflow = "hidden";
  copy.style.transform = `scale(${scale})`;
  ghost.appendChild(copy);
  const originals = [...tile.querySelectorAll("canvas")];
  const clones = [...copy.querySelectorAll("canvas")];
  originals.forEach((canvas, index) => { if (clones[index]) paint(clones[index], canvas); });
  let removed = false;
  void snapshots.get(tileId)?.().then((images) => {
    if (removed) return;
    originals.forEach((canvas, index) => {
      const image = images.get(canvas);
      if (image && clones[index]) paint(clones[index], image);
    });
  }, () => { /* The tile keeps whatever its canvases showed. */ });
  const move = (nextX: number, nextY: number) => {
    ghost.style.transform = `translate3d(${Math.round(nextX - grabX)}px, ${Math.round(nextY - grabY)}px, 0)`;
  };
  move(x, y);
  document.body.appendChild(ghost);
  return { move, remove: () => { removed = true; ghost.remove(); } };
}
