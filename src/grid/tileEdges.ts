import { useEffect, type RefObject } from "react";

// With spacing 0 the tiles fill the canvas edge to edge, and a tile's border
// on a side that meets the window or the header line would only double that
// edge. Grid placement decides which tiles touch which side, so it is read
// from the layout: each tile gets data-edge with the sides it touches ("top
// left", ...), kept current as tiles move, resize or the window changes.
const EDGE_SLACK = 1.5;

// Layout boxes (offset*), not getBoundingClientRect: tiles animate to new
// places with transforms, and only where they end up matters.
function markEdges(grid: HTMLElement): void {
  const style = getComputedStyle(grid);
  const left = parseFloat(style.paddingLeft);
  const top = parseFloat(style.paddingTop);
  const right = grid.clientWidth - parseFloat(style.paddingRight);
  const tiles = [...grid.querySelectorAll<HTMLElement>(":scope > .tile")].map((tile) => {
    // Offsets are relative to the offset parent, which may sit above the grid.
    const base = tile.offsetParent === grid ? { x: 0, y: 0 } : { x: grid.offsetLeft, y: grid.offsetTop };
    return { tile, x: tile.offsetLeft - base.x, y: tile.offsetTop - base.y };
  });
  // The last row ends where the lowest tile does; the grid itself can be
  // momentarily taller while the layout settles.
  const bottom = Math.max(0, ...tiles.map(({ tile, y }) => y + tile.offsetHeight));
  for (const { tile, x, y } of tiles) {
    const sides = [
      y - top <= EDGE_SLACK ? "top" : "",
      x - left <= EDGE_SLACK ? "left" : "",
      right - (x + tile.offsetWidth) <= EDGE_SLACK ? "right" : "",
      bottom - (y + tile.offsetHeight) <= EDGE_SLACK ? "bottom" : "",
    ].filter(Boolean).join(" ");
    if (tile.dataset.edge !== sides) tile.dataset.edge = sides;
  }
}

function clearEdges(grid: HTMLElement): void {
  for (const tile of grid.querySelectorAll<HTMLElement>(":scope > .tile")) delete tile.dataset.edge;
}

export function useTileEdges(gridRef: RefObject<HTMLElement | null>, enabled: boolean): void {
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid || !enabled) return;
    let frame = 0;
    const schedule = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => markEdges(grid));
    };
    schedule();
    const resize = new ResizeObserver(schedule);
    resize.observe(grid);
    for (const tile of grid.children) resize.observe(tile);
    // Tiles added, removed, reordered or given new spans.
    const mutations = new MutationObserver((records) => {
      for (const record of records) for (const node of record.addedNodes) if (node instanceof Element) resize.observe(node);
      schedule();
    });
    mutations.observe(grid, { childList: true, attributes: true, attributeFilter: ["style", "class"], subtree: false });
    return () => {
      cancelAnimationFrame(frame);
      resize.disconnect();
      mutations.disconnect();
      clearEdges(grid);
    };
  }, [gridRef, enabled]);
}
