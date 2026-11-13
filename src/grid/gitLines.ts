import { useSyncExternalStore } from "react";
import { postGitReview } from "../serverApi";
import { lineHunks } from "./lineDiff";

// Per-line Git data for the editor: the file at HEAD and its blame, fetched
// once per load or save (never per keystroke), plus the pure helpers that turn
// them into gutter marks and blame text against the live buffer.

/** Files above either limit get no gutter or blame; the device applies the same caps. */
export const GIT_LINES_MAX_LINES = 10000;
export const GIT_LINES_MAX_CHARS = 1024 * 1024;

export type GitFileHead =
  | { repo: false }
  | { repo: true; root: string; file: string; blob: string | null; head: string | null; tooLarge: boolean; binary: boolean };
export interface BlameCommit { hash: string; author: string; time: number; summary: string }
export type GitFileBlame =
  | { repo: false }
  | { repo: true; root: string; file: string; blob: string | null; tooLarge: boolean; commits: BlameCommit[]; lines: number[] };

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringOrNull = (value: unknown): value is string | null => value === null || typeof value === "string";

function parseHead(value: unknown): GitFileHead {
  if (!isRecord(value)) throw new Error("Git data unavailable");
  if (value.repo === false) return { repo: false };
  const { root, file, blob, head, tooLarge, binary } = value;
  if (value.repo !== true || typeof root !== "string" || typeof file !== "string" || !isStringOrNull(blob) || !isStringOrNull(head)
    || typeof tooLarge !== "boolean" || typeof binary !== "boolean") throw new Error("Git data unavailable");
  return { repo: true, root, file, blob, head, tooLarge, binary };
}

function parseCommit(value: unknown): BlameCommit | null {
  if (!isRecord(value)) return null;
  const { hash, author, time, summary } = value;
  if (typeof hash !== "string" || !/^[0-9a-f]{40,64}$/.test(hash) || typeof author !== "string" || typeof time !== "number" || typeof summary !== "string") return null;
  return { hash, author, time, summary };
}

function parseBlame(value: unknown): GitFileBlame {
  if (!isRecord(value)) throw new Error("Git blame unavailable");
  if (value.repo === false) return { repo: false };
  const { root, file, blob, tooLarge } = value;
  if (value.repo !== true || typeof root !== "string" || typeof file !== "string" || !isStringOrNull(blob) || typeof tooLarge !== "boolean"
    || !Array.isArray(value.commits) || !Array.isArray(value.lines)) throw new Error("Git blame unavailable");
  const commits = value.commits.map(parseCommit);
  const count = commits.length;
  const lines = value.lines;
  if (commits.some((commit) => commit === null) || !lines.every((at): at is number => Number.isInteger(at) && at >= 0 && at < count)) {
    throw new Error("Git blame unavailable");
  }
  return { repo: true, root, file, blob, tooLarge, commits: commits.filter((commit): commit is BlameCommit => commit !== null), lines };
}

export async function fetchGitFileHead(host: string, path: string, signal?: AbortSignal): Promise<GitFileHead> {
  return parseHead(await postGitReview("file-head", { host, path }, "Git data unavailable", signal));
}

export async function fetchGitFileBlame(host: string, path: string, signal?: AbortSignal): Promise<GitFileBlame> {
  return parseBlame(await postGitReview("file-blame", { host, path }, "Git blame unavailable", signal));
}

// --------------------------------------------------------------- line diff

export type LineChangeKind = "added" | "modified" | "deleted";
/**
 * One changed block against HEAD, as 0-based line ranges [from, to) in the
 * buffer and [oldFrom, oldTo) in HEAD. A deletion has from === to: the lines
 * were removed just above buffer line `from` (or below the last line when
 * `from` is the line count).
 */
export interface LineChange { kind: LineChangeKind; from: number; to: number; oldFrom: number; oldTo: number }
/** The changes, and per buffer line the HEAD line it is (-1: changed). */
export interface LinesAgainstHead { changes: LineChange[]; origin: Int32Array }

/** HEAD text with the line breaks the editor uses. */
export const normalizeLines = (text: string) => text.replace(/\r\n?/g, "\n");

export function diffAgainstHead(head: string, buffer: string): LinesAgainstHead | null {
  const hunks = lineHunks(head, buffer);
  if (!hunks) return null;
  let lines = 1;
  for (let at = buffer.indexOf("\n"); at >= 0; at = buffer.indexOf("\n", at + 1)) lines += 1;
  const origin = new Int32Array(lines);
  const changes: LineChange[] = [];
  let a = 0;
  let b = 0;
  for (const hunk of hunks) {
    for (; b < hunk.b[0]; b += 1, a += 1) origin[b] = a;
    for (; b < hunk.b[1]; b += 1) origin[b] = -1;
    a = hunk.a[1];
    const added = hunk.b[1] - hunk.b[0];
    const removed = hunk.a[1] - hunk.a[0];
    const kind: LineChangeKind = !removed ? "added" : !added ? "deleted" : "modified";
    changes.push({ kind, from: hunk.b[0], to: hunk.b[1], oldFrom: hunk.a[0], oldTo: hunk.a[1] });
  }
  for (; b < lines; b += 1, a += 1) origin[b] = a;
  return { changes, origin };
}

/**
 * The edit that puts HEAD's lines back in place of a change, as one document
 * change over a buffer of `lineCount` lines and `length` characters, whose
 * 0-based line starts and ends come from `lineStart` and `lineEnd`.
 */
export function revertEdit(change: LineChange, headLines: readonly string[], lineStart: (line: number) => number, lineEnd: (line: number) => number, lineCount: number, length: number): { from: number; to: number; insert: string } {
  const old = headLines.slice(change.oldFrom, change.oldTo).join("\n");
  if (change.kind === "modified") return { from: lineStart(change.from), to: lineEnd(change.to - 1), insert: old };
  if (change.kind === "deleted") {
    if (change.from < lineCount) return { from: lineStart(change.from), to: lineStart(change.from), insert: `${old}\n` };
    return { from: length, to: length, insert: `\n${old}` };
  }
  // Added lines: remove them with one of their surrounding line breaks.
  if (change.to < lineCount) return { from: lineStart(change.from), to: lineStart(change.to), insert: "" };
  return { from: change.from > 0 ? lineEnd(change.from - 1) : 0, to: length, insert: "" };
}

// ------------------------------------------------------------------- blame

const plural = (count: number, unit: string) => `${count} ${unit}${count === 1 ? "" : "s"} ago`;

/** "just now", "5 minutes ago", "2 days ago", "3 years ago". */
export function relativeTime(seconds: number, now = Date.now()): string {
  const elapsed = Math.max(0, now / 1000 - seconds);
  const minutes = Math.round(elapsed / 60);
  const hours = Math.round(elapsed / 3600);
  const days = Math.round(elapsed / 86400);
  if (elapsed < 45) return "just now";
  if (minutes < 45) return plural(Math.max(1, minutes), "minute");
  if (hours < 22) return plural(Math.max(1, hours), "hour");
  if (days < 26) return plural(Math.max(1, days), "day");
  if (days < 320) return plural(Math.max(1, Math.round(days / 30.44)), "month");
  return plural(Math.max(1, Math.round(days / 365.25)), "year");
}

const SUMMARY_CHARS = 60;
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text);

export const UNCOMMITTED_LABEL = "You, uncommitted";

/** The dim text after the cursor line, and its hover details. */
export function blameText(commit: BlameCommit | null, now = Date.now()): { label: string; detail: string } {
  if (!commit) return { label: UNCOMMITTED_LABEL, detail: "Not committed yet: this line differs from HEAD." };
  const date = new Date(commit.time * 1000);
  const when = Number.isNaN(date.getTime()) ? "" : date.toLocaleString();
  return {
    label: `${clip(commit.author || "Unknown", 40)}, ${relativeTime(commit.time, now)} · ${clip(commit.summary, SUMMARY_CHARS)}`,
    detail: `${commit.hash}\n${commit.author}${when ? ` · ${when}` : ""}\n${commit.summary}`,
  };
}

// --------------------------------------------------------- inline blame pref

const BLAME_KEY = "pzza.editor.inlineBlame";
const listeners = new Set<() => void>();
function readBlamePref(): boolean {
  try { return localStorage.getItem(BLAME_KEY) !== "off"; } catch { return true; }
}
let blamePref = readBlamePref();

export function setInlineBlame(on: boolean): void {
  blamePref = on;
  try { localStorage.setItem(BLAME_KEY, on ? "on" : "off"); } catch { /* Kept for this session only. */ }
  for (const listener of listeners) listener();
}

/** Whether inline blame shows on the cursor line (on by default, remembered). */
export function useInlineBlame(): boolean {
  return useSyncExternalStore((listener) => { listeners.add(listener); return () => { listeners.delete(listener); }; }, () => blamePref);
}
