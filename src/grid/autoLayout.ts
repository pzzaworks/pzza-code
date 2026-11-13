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
export interface CanvasSize { width: number; height: number; gap: number }
export interface Arrangement {
  // Column units of the grid (what a saved span of 1 column means).
  columns: number;
  // CSS grid column tracks; each row unit is two row tracks.
  tracks: number;
  spans: Map<string, Span>;
  // Row units the auto layout fills the canvas with; a saved row span is
  // measured in these, so one unit is that tall whatever the other tiles do.
  rows: number;
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
  if (!ids.some((id) => saved[id])) {
    let tracks = rows.reduce(lcm, columns * 2);
    // Many tracks would eat the width in gaps: fall back to near-even shares.
    if (tracks > MAX_TRACKS || (size && (tracks - 1) * size.gap > size.width / 2)) tracks = columns * 2;
    let index = 0;
    for (const perRow of rows) {
      for (const c of split(tracks, perRow)) spans.set(ids[index++], { c, r: 2 });
    }
    return { columns, tracks, spans, rows: rows.length, sized: false };
  }
  const tracks = columns * 2;
  placeMixed(ids, saved, tracks, maxRows * 2, spans);
  return { columns, tracks, spans, rows: Math.max(1, rows.length), sized: true };
}

const toTracks = (span: Span, tracks: number): Span => ({
  c: Math.max(1, Math.min(Math.round(span.c * 2), tracks)),
  r: Math.max(1, Math.round(span.r * 2)),
});

// Tiles without a saved span share the row evenly, except the last one which
// stretches across whatever is left in its row. They also match the tallest
// saved height, so an auto tile next to a 2-row tile becomes 2 rows tall
// instead of leaving a hole. Placement is simulated against a row-span aware
// occupancy grid so widths match the browser's placement even when tall tiles
// occupy cells below the cursor. All units are tracks.
function placeMixed(ids: readonly string[], saved: Readonly<Record<string, Span>>, tracks: number, maxR: number, spans: Map<string, Span>): void {
  const columns = tracks / 2;
  const even = (ids.length <= 1 ? columns : Math.max(1, Math.floor(columns / ids.length))) * 2;
  let autoR = 2;
  for (const id of ids) {
    if (saved[id]) autoR = Math.max(autoR, Math.min(toTracks(saved[id], tracks).r, maxR));
  }
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
  const place = (id: string, w: number, h: number, row: number, col: number) => {
    occupy(row, col, w, h);
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
      spans.set(id, { c: w, r });
      return;
    }
    const w = Math.max(1, Math.min(even, tracks));
    const [pr, pc] = find(w, autoR, cursorR, cursorC);
    const stretch = pc === 0 ? tracks : tracks - pc;
    if (index === ids.length - 1 && stretch >= w && fits(pr, pc, stretch, autoR)) place(id, stretch, autoR, pr, pc);
    else place(id, w, autoR, pr, pc);
  });
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
