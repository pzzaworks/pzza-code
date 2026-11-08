import { create } from "zustand";
import { TERMINAL_TEXT_MAX_BYTES } from "../appControlTerminal";

// Pending review comments on diff lines, kept per tile in memory across the
// files of its Changes view until they are sent to the tile's agent.
export interface ReviewLines { side: "old" | "new"; from: number; to: number; removed: boolean }
export interface ReviewComment { id: string; path: string; lines: ReviewLines; note: string }

interface DiffReviewState {
  comments: Record<string, ReviewComment[]>;
  add(tileId: string, comment: Omit<ReviewComment, "id">): void;
  edit(tileId: string, id: string, note: string): void;
  remove(tileId: string, id: string): void;
  clear(tileId: string): void;
}

let nextId = 0;
const NO_COMMENTS: ReviewComment[] = [];

export const useDiffReview = create<DiffReviewState>((set) => ({
  comments: {},
  add: (tileId, comment) => set((state) => ({
    comments: { ...state.comments, [tileId]: [...(state.comments[tileId] ?? []), { ...comment, id: `c${++nextId}` }] },
  })),
  edit: (tileId, id, note) => set((state) => ({
    comments: { ...state.comments, [tileId]: (state.comments[tileId] ?? []).map((comment) => (comment.id === id ? { ...comment, note } : comment)) },
  })),
  remove: (tileId, id) => set((state) => ({
    comments: { ...state.comments, [tileId]: (state.comments[tileId] ?? []).filter((comment) => comment.id !== id) },
  })),
  clear: (tileId) => set((state) => {
    const comments = { ...state.comments };
    delete comments[tileId];
    return { comments };
  }),
}));

export const useTileReview = (tileId: string): ReviewComment[] => useDiffReview((state) => state.comments[tileId] ?? NO_COMMENTS);

// Whitespace and control characters folded to single spaces, so typed text
// can never submit early or span lines.
export function foldLine(value: string): string {
  return value.replace(/[\u0000-\u001f\u007f\u2028\u2029\s]+/g, " ").trim();
}

export function reviewLinesLabel(lines: ReviewLines): string {
  const span = lines.from === lines.to ? `line ${lines.from}` : `lines ${lines.from}-${lines.to}`;
  if (lines.side === "new") return span;
  return lines.removed ? `removed ${span}` : `${span} of the previous version`;
}

const REVIEW_LEAD = "Review of current changes";
const byteLength = (text: string) => new TextEncoder().encode(text).byteLength;

// The review as one line: "Review of current changes: 1) a.ts lines 2-3: note
// 2) ...". When that would pass the terminal's single-paste limit it becomes
// several lines, "Review of current changes (1/3): ...", numbering continuing
// across them and no comment ever split between two.
export function reviewMessages(comments: readonly Pick<ReviewComment, "path" | "lines" | "note">[], maxBytes = TERMINAL_TEXT_MAX_BYTES): string[] {
  const items = comments.map((comment, index) => `${index + 1}) ${foldLine(comment.path)} ${reviewLinesLabel(comment.lines)}: ${foldLine(comment.note)}`);
  if (!items.length) return [];
  const single = `${REVIEW_LEAD}: ${items.join(" ")}`;
  if (byteLength(single) <= maxBytes) return [single];
  // Room for the longest possible part prefix, e.g. " (12/12)".
  const room = maxBytes - byteLength(`${REVIEW_LEAD} (${items.length}/${items.length}): `);
  const groups: string[][] = [];
  let size = 0;
  for (const item of items) {
    const bytes = byteLength(item) + 1;
    if (groups.length && size + bytes <= room) {
      groups[groups.length - 1].push(item);
      size += bytes;
    } else {
      groups.push([item]);
      size = bytes;
    }
  }
  return groups.map((group, index) => `${REVIEW_LEAD} (${index + 1}/${groups.length}): ${group.join(" ")}`);
}
