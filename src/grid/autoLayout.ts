import { useLayoutEffect, useState, type RefObject } from "react";

// A workspace column setting of 0 lets the canvas pick the columns itself.
export const AUTO_COLUMNS = 0;
// Narrowest an automatically sized tile gets while it shares its row; below
// that the tiles take more rows instead. One tile per row is always allowed.
export const MIN_TILE_WIDTH = 360;
// Two 150px row tracks (global.css grid-auto-rows) make one row unit.
const MIN_ROW_HEIGHT = 300;
const MAX_AUTO_COLUMNS = 5;
// Every track adds a gap, so even splits never multiply the track count past this.
const MAX_TRACKS = 24;

// Column/row units in 0.5 steps for saved spans, whole tracks for arrangements.
export type Span = { c: number; r: number };
// Where a tile starts, in grid tracks from the top left.
export type Cell = { row: number; col: number };
export interface CanvasSize { width: number; height: number; gap: number }
export interface Arrangement {
  // Column units of the grid (what a saved span of 1 column means).
  columns: number;
  // CSS grid column tracks; each row unit is two row tracks.
  tracks: number;
  spans: Map<string, Span>;
  // The track each tile starts on, as the browser's auto placement puts it.
  cells: Map<string, Cell>;
  // Row units the auto layout fills the canvas with; a saved row span is
  // measured in these, so one unit is that tall whatever the other tiles do.
  rows: number;
  // Row tracks the placed tiles reach down to. Saved sizes can take more
  // than `rows` (a widened tile pushes its neighbour to a new row, a tall
  // one outgrows a lone row); the canvas then shrinks the tracks to fit.
  rowTracks: number;
  // Whether any tile has a saved span (the grid then sizes its rows itself).
  sized: boolean;
}

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
const lcm = (a: number, b: number): number => (a / gcd(a, b)) * b;

// `count` tiles over `rows` rows, fuller rows first: 5 over 2 is [3, 2].
export function balancedRows(count: number, rows: number): number[] {
  const base = Math.floor(count / rows);
  const extra = count % rows;
  return Array.from({ length: rows }, (_, index) => base + (index < extra ? 1 : 0));
}

// A chosen column count: full rows, then the rest share the last row evenly.
function filledRows(count: number, columns: number): number[] {
  const rows: number[] = [];
  for (let left = count; left > 0; left -= columns) rows.push(Math.min(columns, left));
  return rows;
}

// Automatic rows: the arrangement whose tiles come closest to square while
// tiles that share a row stay at least MIN_TILE_WIDTH wide. Ties keep fewer rows.
export function autoRows(count: number, size: CanvasSize | null): number[] {
  if (count <= 1) return count ? [1] : [];
  if (!size) return balancedRows(count, Math.ceil(count / 2));
  let best = balancedRows(count, count);
  let bestScore = Infinity;
  for (let perRow = Math.min(count, MAX_AUTO_COLUMNS); perRow >= 1; perRow--) {
    const rows = Math.ceil(count / perRow);
    // Only the fewest rows for this width; more would just leave rows half empty.
    if (Math.ceil(count / rows) !== perRow) continue;
    const width = (size.width - (perRow - 1) * size.gap) / perRow;
    if (perRow > 1 && width < MIN_TILE_WIDTH) continue;
    const height = Math.max(MIN_ROW_HEIGHT, (size.height - (rows - 1) * size.gap) / rows);
    const score = Math.abs(Math.log(width / height));
    if (score < bestScore - 1e-6) {
      best = balancedRows(count, rows);
      bestScore = score;
    }
  }
  return best;
}

// Splits `tracks` into `parts` spans that differ by at most one track.
function split(tracks: number, parts: number): number[] {
  return Array.from({ length: parts }, (_, index) =>
    Math.floor(((index + 1) * tracks) / parts) - Math.floor((index * tracks) / parts));
}

// Places the visible tiles of a workspace. Without any saved span every row
// is shared evenly (5 tiles in 3 columns: 3 + 2, each of the last two 1.5
// wide). With saved spans the grid keeps two tracks per column unit: saved
// tiles keep their size and the others share what is left.
export function arrangeTiles({ ids, saved, setting, size, maxRows }: {
  ids: readonly string[];
  saved: Readonly<Record<string, Span>>;
  setting: number;
  size: CanvasSize | null;
  maxRows: number;
}): Arrangement {
  const count = ids.length;
  const rows = setting >= 1 ? filledRows(count, Math.min(setting, Math.max(1, count))) : autoRows(count, size);
  const columns = setting >= 1 ? setting : Math.max(1, rows[0] ?? 1);
  const spans = new Map<string, Span>();
  const cells = new Map<string, Cell>();
  if (!ids.some((id) => saved[id])) {
    let tracks = rows.reduce(lcm, columns * 2);
    // Many tracks would eat the width in gaps: fall back to near-even shares.
    if (tracks > MAX_TRACKS || (size && (tracks - 1) * size.gap > size.width / 2)) tracks = columns * 2;
    let index = 0;
    rows.forEach((perRow, row) => {
      let col = 0;
      for (const c of split(tracks, perRow)) {
        spans.set(ids[index], { c, r: 2 });
        cells.set(ids[index++], { row: row * 2, col });
        col += c;
      }
    });
    return { columns, tracks, spans, cells, rows: rows.length, rowTracks: rows.length * 2, sized: false };
  }
  const tracks = columns * 2;
  const rowTracks = placeMixed(ids, saved, tracks, maxRows * 2, spans, cells);
  return { columns, tracks, spans, cells, rows: Math.max(1, rows.length), rowTracks, sized: true };
}

// Row tracks a sized grid fits into the canvas height: never fewer than the
// auto rows take (a shorter tile leaves room below it), never fewer than the
// tiles reach down to (so they all stay on screen).
export const fitRowTracks = (arrangement: Arrangement): number => Math.max(arrangement.rows * 2, arrangement.rowTracks);

// Floor of a sized grid's row track; global.css (.grid-sized) keeps the same
// floor. It only keeps a tiny window usable: the resize grips never pick a
// size whose tracks would need it.
export const MIN_SIZED_ROW_TRACK = 80;

// Height of one row track of a sized grid: `count` tracks and their gaps fill
// `height` (the canvas content height), down to the floor.
export function sizedRowTrack(height: number, gap: number, count: number): number {
  const tracks = Math.max(1, count);
  return Math.max(MIN_SIZED_ROW_TRACK, (height - gap * (tracks - 1)) / tracks);
}

// The grid as the browser lays it out: content width, the canvas content
// height the sized rows fill, and the gap between tracks.
export interface GridBox { width: number; height: number; gap: number }
// A tile's box in pixels, relative to the grid's top left corner.
export interface TileBox { left: number; top: number; width: number; height: number }

// Where a tile of a sized arrangement lands in pixels, computed the way the
// browser sizes the tracks (columns share the width, rows fit the canvas).
// `fits` tells whether the whole grid stays inside the canvas height.
export function tileBox(arrangement: Arrangement, id: string, box: GridBox): { box: TileBox; fits: boolean } | null {
  const cell = arrangement.cells.get(id);
  const span = arrangement.spans.get(id);
  if (!cell || !span) return null;
  const { gap } = box;
  const colTrack = (box.width - gap * (arrangement.tracks - 1)) / arrangement.tracks;
  const count = fitRowTracks(arrangement);
  const rowTrack = sizedRowTrack(box.height, gap, count);
  return {
    box: {
      left: cell.col * (colTrack + gap),
      top: cell.row * (rowTrack + gap),
      width: span.c * colTrack + (span.c - 1) * gap,
      height: span.r * rowTrack + (span.r - 1) * gap,
    },
    fits: count * rowTrack + (count - 1) * gap <= box.height + 0.5,
  };
}

export type ResizeAxis = "x" | "y" | "xy";
export interface TileLayout {
  ids: readonly string[];
  saved: Readonly<Record<string, Span>>;
  setting: number;
  size: CanvasSize | null;
  maxRows: number;
  box: GridBox;
}
export interface ResizeChoice { span: Span; box: TileBox }

// The size a resize drag ends at. Every size the grip can reach (half column
// and half row steps) is laid out as it would be once saved, and the one
// whose dragged edge lands closest to the pointer wins. Saving a size changes
// the whole grid (rows fit the window, neighbours reflow), so converting the
// pointer with the tracks of the current layout previewed one size and
// produced another. Sizes that would push the grid past the canvas are left
// out while any size fits; ties keep the size closest to the current one.
// `from` is the tile's current span in units; `edge` is where the dragged
// right/bottom edge should go, relative to the grid's top left corner.
export function chooseResize(layout: TileLayout, id: string, axis: ResizeAxis, from: Span, edge: { x: number; y: number }): ResizeChoice | null {
  const { columns } = arrangeTiles(layout);
  const maxC = columns * 2;
  const maxR = layout.maxRows * 2;
  const fromC = Math.max(1, Math.min(maxC, Math.round(from.c * 2)));
  const fromR = Math.max(1, Math.min(maxR, Math.round(from.r * 2)));
  const range = (max: number) => Array.from({ length: max }, (_, index) => index + 1);
  const cs = axis === "y" ? [fromC] : range(maxC);
  const rs = axis === "x" ? [fromR] : range(maxR);
  let best: { choice: ResizeChoice; fits: boolean; distance: number; change: number } | null = null;
  for (const c of cs) {
    for (const r of rs) {
      const span = { c: c / 2, r: r / 2 };
      const placed = tileBox(arrangeTiles({ ...layout, saved: { ...layout.saved, [id]: span } }), id, layout.box);
      if (!placed) continue;
      const { box, fits } = placed;
      const distance = (axis === "y" ? 0 : Math.abs(box.left + box.width - edge.x)) +
        (axis === "x" ? 0 : Math.abs(box.top + box.height - edge.y));
      const change = Math.abs(c - fromC) + Math.abs(r - fromR);
      const better = !best ||
        (fits !== best.fits ? fits :
          Math.abs(distance - best.distance) > 0.5 ? distance < best.distance : change < best.change);
      if (better) best = { choice: { span, box }, fits, distance, change };
    }
  }
  return best?.choice ?? null;
}

const toTracks = (span: Span, tracks: number): Span => ({
  c: Math.max(1, Math.min(Math.round(span.c * 2), tracks)),
  r: Math.max(1, Math.round(span.r * 2)),
});

// An auto-sized tile's default height, in row tracks (one row).
const AUTO_ROW_TRACKS = 2;

// Tiles without a saved span share the row evenly, except the last one which
// stretches across whatever is left in its row. Every tile is placed the way
// the browser's auto placement does it (each one at the first free spot after
// the previous one), against a row-span aware occupancy grid, so the result
// matches the browser even when tall tiles occupy cells below the cursor.
// Auto tiles start one row tall and then grow down into the free cells under
// them, so they never leave a hole beside a taller tile; growing only into
// cells no tile took keeps every placement as it was. A tall tile thus gets
// its neighbours stacked beside it, and a tile made as tall as all of them
// fills the window. All units are tracks. Fills `spans` and `cells`; returns
// the row tracks the placed tiles reach down to.
function placeMixed(ids: readonly string[], saved: Readonly<Record<string, Span>>, tracks: number, maxR: number,
  spans: Map<string, Span>, cells: Map<string, Cell>): number {
  const columns = tracks / 2;
  const even = (ids.length <= 1 ? columns : Math.max(1, Math.floor(columns / ids.length))) * 2;
  const grid: boolean[][] = [];
  const ensure = (row: number) => {
    while (grid.length <= row) grid.push(new Array<boolean>(tracks).fill(false));
  };
  const fits = (row: number, col: number, w: number, h: number): boolean => {
    if (col + w > tracks) return false;
    ensure(row + h - 1);
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) if (grid[row + dr][col + dc]) return false;
    }
    return true;
  };
  const occupy = (row: number, col: number, w: number, h: number) => {
    ensure(row + h - 1);
    for (let dr = 0; dr < h; dr++) {
      for (let dc = 0; dc < w; dc++) grid[row + dr][col + dc] = true;
    }
  };
  const maxSearchRows = ids.length * maxR + 4;
  const find = (w: number, h: number, fromR: number, fromC: number): [number, number] => {
    for (let r = fromR; r < fromR + maxSearchRows; r++) {
      const startC = r === fromR ? Math.min(fromC, tracks - 1) : 0;
      for (let c = startC; c + w <= tracks; c++) if (fits(r, c, w, h)) return [r, c];
    }
    return [fromR, fromC];
  };
  let cursorR = 0;
  let cursorC = 0;
  let bottom = 0;
  const place = (id: string, w: number, h: number, row: number, col: number) => {
    occupy(row, col, w, h);
    cells.set(id, { row, col });
    bottom = Math.max(bottom, row + h);
    spans.set(id, { c: w, r: h });
    cursorR = row;
    cursorC = col + w;
    if (cursorC >= tracks) {
      cursorR = row + 1;
      cursorC = 0;
    }
  };
  ids.forEach((id, index) => {
    const span = saved[id];
    if (span) {
      const { c: w, r } = toTracks(span, tracks);
      const h = Math.min(r, maxR);
      const [pr, pc] = find(w, h, cursorR, cursorC);
      place(id, w, h, pr, pc);
      return;
    }
    const w = Math.max(1, Math.min(even, tracks));
    const [pr, pc] = find(w, AUTO_ROW_TRACKS, cursorR, cursorC);
    const stretch = pc === 0 ? tracks : tracks - pc;
    if (index === ids.length - 1 && stretch >= w && fits(pr, pc, stretch, AUTO_ROW_TRACKS)) place(id, stretch, AUTO_ROW_TRACKS, pr, pc);
    else place(id, w, AUTO_ROW_TRACKS, pr, pc);
  });
  // Grow auto tiles, in order, into the free cells under them.
  for (const id of ids) {
    if (saved[id]) continue;
    const cell = cells.get(id);
    const span = spans.get(id);
    if (!cell || !span) continue;
    let h = span.r;
    while (cell.row + h < bottom && fits(cell.row + h, cell.col, span.c, 1)) {
      occupy(cell.row + h, cell.col, span.c, 1);
      h += 1;
    }
    spans.set(id, { c: span.c, r: h });
  }
  return bottom;
}

// The canvas content box, re-read as the window resizes. State only changes
// when the automatic arrangement for the current tile count would change, so
// a window drag re-renders the grid only at the sizes where tiles reflow.
export function useCanvasSize(gridRef: RefObject<HTMLElement | null>, count: number, gap: number, enabled: boolean): CanvasSize | null {
  const [size, setSize] = useState<CanvasSize | null>(null);
  // Measured before paint, so the first frame already has the right columns.
  useLayoutEffect(() => {
    const canvas = gridRef.current?.parentElement;
    if (!enabled || !canvas) return;
    const measure = () => {
      const style = getComputedStyle(canvas);
      const box = canvas.getBoundingClientRect();
      const next = {
        width: Math.round(box.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight)),
        height: Math.round(box.height - parseFloat(style.paddingTop) - parseFloat(style.paddingBottom)),
        gap,
      };
      setSize((current) => current && current.gap === next.gap &&
        autoRows(count, current).join() === autoRows(count, next).join() ? current : next);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(canvas);
    return () => observer.disconnect();
  }, [gridRef, count, gap, enabled]);
  return enabled ? size : null;
}
