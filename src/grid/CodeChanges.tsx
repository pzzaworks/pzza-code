import { useCallback, useEffect, useMemo, useRef, useState, type KeyboardEvent } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { EditorState, StateEffect, type Extension } from "@codemirror/state";
import { Decoration, EditorView, lineNumbers, ViewPlugin, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { getChunks, MergeView, unifiedMergeView } from "@codemirror/merge";
import { lineDiff, lineDiffStats } from "./lineDiff";
import { Columns2, FolderTree, GitCompareArrows, Loader2, MessageSquare, MessageSquarePlus, Rows2, Send, Trash2 } from "lucide-react";
import { foldLine, reviewLinesLabel, reviewMessages, useDiffReview, useTileReview, type ReviewComment, type ReviewLines } from "./diffReview";
import { fetchGitChanges, fetchGitDiff, type GitChangedFile, type GitChangeStatus, type GitChanges, type GitFileDiff } from "../serverApi";
import type { TileCodeView } from "../state/store";
import { editorLanguage } from "./editorLanguage";

const POLL_MS = 5000;

export interface GitChangesState {
  status: "idle" | "loading" | "ready" | "error";
  changes?: GitChanges;
  error?: string;
  // Bumps on every completed check, so dependents can refresh alongside it.
  checked: number;
}

// The changed files of the repository that holds `folder`. Refreshes when
// `refreshKey` changes, when the window regains focus, and every POLL_MS while
// `live`. A poll never interrupts a request still in flight (a slow ssh round
// trip would otherwise never finish); explicit refreshes replace it.
export function useGitChanges(host: string, folder: string | undefined, live: boolean, refreshKey: number): GitChangesState {
  const [state, setState] = useState<GitChangesState>({ status: folder ? "loading" : "idle", checked: 0 });
  const request = useRef<AbortController | null>(null);
  const lastKey = useRef("");

  const refresh = useCallback((force: boolean) => {
    if (!folder) return;
    if (request.current && !force) return;
    request.current?.abort();
    const controller = new AbortController();
    request.current = controller;
    fetchGitChanges(host, folder, controller.signal)
      .then((changes) => {
        if (controller.signal.aborted) return;
        const key = JSON.stringify(changes);
        const same = key === lastKey.current;
        lastKey.current = key;
        setState((current) => ({ status: "ready", changes: same && current.changes ? current.changes : changes, checked: current.checked + 1 }));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        lastKey.current = "";
        setState((current) => ({ status: "error", error: cause instanceof Error ? cause.message : "Git changes unavailable", checked: current.checked + 1 }));
      })
      .finally(() => { if (request.current === controller) request.current = null; });
  }, [host, folder]);

  useEffect(() => {
    lastKey.current = "";
    setState({ status: folder ? "loading" : "idle", checked: 0 });
    refresh(true);
    return () => { request.current?.abort(); request.current = null; };
  }, [refresh, folder]);

  const seenKey = useRef(refreshKey);
  useEffect(() => {
    if (seenKey.current === refreshKey) return;
    seenKey.current = refreshKey;
    refresh(true);
  }, [refreshKey, refresh]);

  useEffect(() => {
    const onFocus = () => refresh(true);
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  const wasLive = useRef(live);
  useEffect(() => {
    if (!live) { wasLive.current = false; return; }
    if (!wasLive.current) refresh(true);
    wasLive.current = true;
    const timer = setInterval(() => { if (document.visibilityState === "visible") refresh(false); }, POLL_MS);
    return () => clearInterval(timer);
  }, [live, refresh]);

  return state;
}

export interface GitDiffState {
  status: "idle" | "loading" | "ready" | "error";
  diff?: GitFileDiff;
  error?: string;
  // Changes whenever the diff's content changes, to remount the merge view.
  version: number;
}

// One changed file's before/after contents. `checked` re-reads the file in
// place (no loading state) and only replaces the diff when its content moved.
export function useGitDiff(host: string, folder: string | undefined, file: GitChangedFile | null, checked: number): GitDiffState {
  const [state, setState] = useState<GitDiffState & { key: string }>({ status: "idle", version: 0, key: "" });
  const fileKey = file ? JSON.stringify([host, folder, file.path, file.from]) : "";
  const lastKey = useRef("");
  const shownFile = useRef("");
  const fileRef = useRef(file);
  fileRef.current = file;

  useEffect(() => {
    const current = fileRef.current;
    if (!folder || !current) {
      shownFile.current = "";
      lastKey.current = "";
      setState((previous) => ({ status: "idle", version: previous.version, key: "" }));
      return;
    }
    const controller = new AbortController();
    if (shownFile.current !== fileKey) {
      shownFile.current = fileKey;
      lastKey.current = "";
      setState((previous) => ({ status: "loading", version: previous.version, key: fileKey }));
    }
    fetchGitDiff(host, folder, current.path, current.status === "renamed" ? current.from : undefined, controller.signal)
      .then((diff) => {
        if (controller.signal.aborted) return;
        const key = JSON.stringify(diff);
        if (key === lastKey.current) return;
        lastKey.current = key;
        setState((previous) => ({ status: "ready", diff, version: previous.version + 1, key: fileKey }));
      })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        lastKey.current = "";
        setState((previous) => ({ status: "error", error: cause instanceof Error ? cause.message : "File changes unavailable", version: previous.version, key: fileKey }));
      });
    return () => controller.abort();
  }, [host, folder, fileKey, checked]);

  // Until the effect catches up, a newly selected file is loading rather than
  // showing the previous file's diff under its name.
  if (state.key !== fileKey) return { status: fileKey ? "loading" : "idle", version: state.version };
  return state;
}

const STATUS_MARK: Record<GitChangeStatus, { letter: string; label: string }> = {
  modified: { letter: "M", label: "Modified" },
  added: { letter: "A", label: "Added" },
  untracked: { letter: "U", label: "Untracked" },
  deleted: { letter: "D", label: "Deleted" },
  renamed: { letter: "R", label: "Renamed" },
  conflicted: { letter: "!", label: "Conflicted" },
};

function splitPath(path: string): { name: string; dir: string } {
  const at = path.lastIndexOf("/");
  return at < 0 ? { name: path, dir: "" } : { name: path.slice(at + 1), dir: path.slice(0, at) };
}

export function changedFilePath(root: string, file: GitChangedFile): string {
  return `${root.replace(/\/+$/, "")}/${file.path}`;
}

// Files / Changes switch at the top of the editor's left pane.
export function CodeViewSwitch({ view, count, panelId, onChange }: {
  view: TileCodeView;
  count: string | null;
  panelId: string;
  onChange(view: TileCodeView): void;
}) {
  const tabs = useRef<Record<TileCodeView, HTMLButtonElement | null>>({ files: null, changes: null });
  const order: readonly TileCodeView[] = ["files", "changes"];
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>) => {
    const index = order.indexOf(view);
    const next = event.key === "ArrowRight" ? order[(index + 1) % order.length]
      : event.key === "ArrowLeft" ? order[(index + order.length - 1) % order.length]
      : event.key === "Home" ? order[0]
      : event.key === "End" ? order[order.length - 1]
      : undefined;
    if (!next) return;
    event.preventDefault();
    onChange(next);
    tabs.current[next]?.focus();
  };
  return (
    <div className="code-changes-switch" role="tablist" aria-label="Sidebar view" onMouseDown={(event) => event.stopPropagation()}>
      {order.map((value) => {
        const on = value === view;
        return (
          <button
            key={value}
            ref={(element) => { tabs.current[value] = element; }}
            type="button"
            role="tab"
            id={`${panelId}-${value}`}
            aria-selected={on}
            aria-controls={panelId}
            tabIndex={on ? 0 : -1}
            className={`code-changes-tab${on ? " on" : ""}`}
            title={value === "files" ? "Files" : "Changes"}
            onClick={() => onChange(value)}
            onKeyDown={onKeyDown}
          >
            {value === "files" ? <FolderTree size={13} aria-hidden="true" /> : <GitCompareArrows size={13} aria-hidden="true" />}
            <span className="code-changes-label">{value === "files" ? "Files" : "Changes"}</span>
            {value === "changes" && count !== null ? <span className="code-changes-count">{count}</span> : null}
          </button>
        );
      })}
    </div>
  );
}

export function changesCount(state: GitChangesState): string | null {
  if (state.status !== "ready" || !state.changes) return null;
  return `${state.changes.files.length}${state.changes.truncated ? "+" : ""}`;
}

const NOT_A_REPO = /not inside a Git repository/i;

export function CodeChangesList({ state, selectedPath, onSelect }: {
  state: GitChangesState;
  selectedPath: string | undefined;
  onSelect(file: GitChangedFile, root: string): void;
}) {
  if (state.status === "idle" || (state.status === "loading" && !state.changes)) {
    return <div className="ft-loading"><Loader2 size={12} className="sw-spin" /></div>;
  }
  if (state.status === "error" || !state.changes) {
    const message = state.error ?? "Git changes unavailable";
    return NOT_A_REPO.test(message)
      ? <div className="code-changes-note">Not a Git repository</div>
      : <div className="code-changes-note code-err" role="alert">{message}</div>;
  }
  const { files, truncated, root } = state.changes;
  if (!files.length) return <div className="code-changes-note">No changes</div>;
  return (
    <div className="code-changes-list">
      {files.map((file) => {
        const mark = STATUS_MARK[file.status];
        const { name, dir } = splitPath(file.path);
        const absolute = changedFilePath(root, file);
        const renamed = file.status === "renamed" && file.from ? ` (from ${file.from})` : "";
        return (
          <button
            key={`${file.status}:${file.path}`}
            type="button"
            className={`ft-row code-changes-row${absolute === selectedPath ? " on" : ""}`}
            title={`${mark.label}: ${file.path}${renamed}`}
            aria-label={`${file.path}, ${mark.label.toLowerCase()}${renamed}`}
            aria-current={absolute === selectedPath ? "true" : undefined}
            onMouseDown={(event) => event.stopPropagation()}
            onClick={() => onSelect(file, root)}
          >
            <span className={`code-changes-status code-changes-status-${file.status}`} aria-hidden="true">{mark.letter}</span>
            <span className="ft-name">
              <span className="code-changes-name">{name}</span>
              {dir ? <span className="code-changes-dir">{dir}</span> : null}
            </span>
          </button>
        );
      })}
      {truncated ? <div className="code-changes-note">Showing the first {files.length}</div> : null}
    </div>
  );
}

// Lines removed from `before` and added in `after`, by changed chunk.
export function diffLineStats(diff: GitFileDiff): { added: number; removed: number } {
  return lineDiffStats(diff.before ?? "", diff.after ?? "");
}

type DiffMode = "unified" | "split";
const DIFF_MODE_KEY = "pzza.diff.mode";
function savedDiffMode(): DiffMode {
  try { return localStorage.getItem(DIFF_MODE_KEY) === "split" ? "split" : "unified"; } catch { return "unified"; }
}
const COLLAPSE = { margin: 3, minSize: 4 };
const READ_ONLY = [EditorView.editable.of(false), EditorState.readOnly.of(true)];

// Old on the left, new on the right, unchanged stretches folded on both sides.
function SplitDiff({ before, after, extensions, sides }: { before: string; after: string; extensions: Extension[]; sides: { a: Extension; b: Extension } }) {
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const parent = host.current;
    if (!parent) return;
    const side = [lineNumbers(), ...READ_ONLY, ...extensions];
    const view = new MergeView({
      a: { doc: before, extensions: [...side, sides.a] },
      b: { doc: after, extensions: [...side, sides.b] },
      parent,
      collapseUnchanged: COLLAPSE,
      diffConfig: { override: lineDiff },
    });
    return () => view.destroy();
  }, [before, after, extensions, sides]);
  return <div className="code-diff-split" ref={host} />;
}

// Lines selected in one side of a diff: `old` is the previous version (the
// left of Split), `new` the current file. `removed` marks old lines that are
// all gone from the current file.
export type DiffLineSelection = ReviewLines;

function selectedDiffLines(state: EditorState, side: DiffLineSelection["side"]): DiffLineSelection | null {
  const range = state.selection.main;
  if (range.empty) return null;
  const first = state.doc.lineAt(range.from);
  let last = state.doc.lineAt(range.to);
  // A selection that ends at the very start of a line does not include it.
  if (last.number > first.number && range.to === last.from) last = state.doc.line(last.number - 1);
  let removed = false;
  if (side === "old") {
    const chunks = getChunks(state)?.chunks ?? [];
    removed = true;
    for (let number = first.number; number <= last.number && removed; number++) {
      const start = state.doc.line(number).from;
      removed = chunks.some((chunk) => chunk.toA > chunk.fromA && start >= chunk.fromA && start < chunk.toA);
    }
  }
  return { side, from: first.number, to: last.number, removed };
}

const diffLinesLabel = reviewLinesLabel;

// The one line typed into the agent's prompt: the repository-relative file,
// the line range and the question, with whitespace and control characters
// folded so it can never submit early or span lines.
export function diffQuestion(path: string, selection: DiffLineSelection, note: string): string {
  return `About ${foldLine(path)} ${diffLinesLabel(selection)} (current changes): ${foldLine(note)}`;
}

export interface DiffAsk {
  // The tile whose agent gets questions and whose review collects comments.
  tileId: string;
  // False when no coding agent runs in the tile's terminal.
  available: boolean;
  send(line: string): Promise<void>;
}

const refreshReviewMarks = StateEffect.define<null>();
const commentedLine = Decoration.line({ class: "code-diff-commented" });

// Highlights this file's lines on one side that carry pending review
// comments, following the tile's review as comments come and go.
function reviewMarks(tileId: string, path: string, side: DiffLineSelection["side"]): Extension {
  const build = (view: EditorView): DecorationSet => {
    const doc = view.state.doc;
    const marked = new Set<number>();
    for (const comment of useDiffReview.getState().comments[tileId] ?? []) {
      if (comment.path !== path || comment.lines.side !== side) continue;
      for (let line = Math.max(1, comment.lines.from); line <= Math.min(comment.lines.to, doc.lines); line++) marked.add(line);
    }
    return Decoration.set([...marked].sort((a, b) => a - b).map((line) => commentedLine.range(doc.line(line).from)));
  };
  return ViewPlugin.fromClass(class {
    decorations: DecorationSet;
    unsubscribe: () => void;
    constructor(view: EditorView) {
      this.decorations = build(view);
      this.unsubscribe = useDiffReview.subscribe((state, previous) => {
        if (state.comments[tileId] !== previous.comments[tileId]) view.dispatch({ effects: refreshReviewMarks.of(null) });
      });
    }
    update(update: ViewUpdate) {
      if (update.docChanged || update.transactions.some((tr) => tr.effects.some((effect) => effect.is(refreshReviewMarks)))) this.decorations = build(update.view);
    }
    destroy() { this.unsubscribe(); }
  }, { decorations: (plugin) => plugin.decorations });
}

// One pending comment in the review list: its file and lines, the note as an
// editable field (Enter or leaving it keeps the edit, Escape restores it, an
// emptied note is restored) and a delete button.
function ReviewCommentRow({ comment, onEdit, onRemove }: {
  comment: ReviewComment; onEdit(note: string): void; onRemove(): void;
}) {
  const [draft, setDraft] = useState(comment.note);
  useEffect(() => setDraft(comment.note), [comment.note]);
  const where = `${comment.path} ${diffLinesLabel(comment.lines)}`;
  const commit = () => {
    if (draft.trim()) { if (draft !== comment.note) onEdit(draft); }
    else setDraft(comment.note);
  };
  return (
    <li className="code-diff-review-item">
      <span className="code-diff-review-where" title={where}>{where}</span>
      <input
        className="code-diff-ask-input"
        value={draft}
        aria-label={`Comment on ${where}`}
        spellCheck={false}
        maxLength={2000}
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); commit(); }
          else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); setDraft(comment.note); }
        }}
      />
      <button type="button" className="btn btn-sm code-diff-ask-btn code-diff-review-delete" aria-label={`Delete comment on ${where}`} title="Delete this comment" onClick={onRemove}>
        <Trash2 size={12} aria-hidden="true" />
      </button>
    </li>
  );
}

// One changed file, read-only, in the editor's theme and language. Unified
// shows removed lines (−) above the lines that replaced them (+); Split puts
// the old file beside the new one. Long unchanged stretches fold away.
// Selected lines can be sent as a question to the tile's agent right away, or
// commented on: comments collect per tile across files (marked on their
// lines, listed for editing) until "Send review" types them as one review.
export function CodeDiffView({ state, file, theme, ask }: {
  state: GitDiffState;
  file: GitChangedFile;
  theme: Extension;
  ask?: DiffAsk;
}) {
  const diff = state.diff;
  const [mode, setMode] = useState<DiffMode>(savedDiffMode);
  const choose = (next: DiffMode) => {
    setMode(next);
    try { localStorage.setItem(DIFF_MODE_KEY, next); } catch { /* not remembered */ }
  };
  const [selection, setSelection] = useState<DiffLineSelection | null>(null);
  // The lines a question or comment is being written about, fixed when the
  // box opens; `boxMode` says whether Enter asks now or adds a comment.
  const [asking, setAsking] = useState<DiffLineSelection | null>(null);
  const [boxMode, setBoxMode] = useState<"ask" | "comment">("ask");
  const [note, setNote] = useState("");
  const [sending, setSending] = useState(false);
  const [askError, setAskError] = useState<string | null>(null);
  useEffect(() => { setSelection(null); setAsking(null); setAskError(null); }, [mode, state.version, file.path]);
  const tileId = ask?.tileId ?? "";
  const comments = useTileReview(tileId);
  const addComment = useDiffReview((s) => s.add);
  const editComment = useDiffReview((s) => s.edit);
  const removeComment = useDiffReview((s) => s.remove);
  const [listOpen, setListOpen] = useState(false);
  const [reviewing, setReviewing] = useState(false);
  const [reviewError, setReviewError] = useState<string | null>(null);
  const listId = `code-diff-review-${tileId}`;
  useEffect(() => { if (!comments.length) setListOpen(false); }, [comments.length]);
  const sides = useMemo(() => {
    const listen = (side: DiffLineSelection["side"]) => EditorView.updateListener.of((update) => {
      if (update.selectionSet || update.docChanged) setSelection(selectedDiffLines(update.state, side));
    });
    return { a: listen("old"), b: listen("new") };
  }, []);
  const marks = useMemo(() => (tileId ? { old: reviewMarks(tileId, file.path, "old"), new: reviewMarks(tileId, file.path, "new") } : null), [tileId, file.path]);
  const splitSides = useMemo(() => (marks ? { a: [sides.a, marks.old], b: [sides.b, marks.new] } : sides), [sides, marks]);
  const language = useMemo(() => editorLanguage(file.path), [file.path]);
  const extensions = useMemo(() => {
    if (!diff || diff.binary) return [];
    const merge = unifiedMergeView({ original: diff.before ?? "", mergeControls: false, collapseUnchanged: COLLAPSE, diffConfig: { override: lineDiff } });
    return [merge, ...(language ? [language] : []), sides.b, ...(marks ? [marks.new] : [])];
  }, [diff, language, sides, marks]);
  const splitExtensions = useMemo(() => [theme, ...(language ? [language] : [])], [theme, language]);
  const closeAsk = () => { setAsking(null); setNote(""); setAskError(null); };
  const openBox = (next: "ask" | "comment") => {
    if (!selection) return;
    setAsking(selection);
    setBoxMode(next);
    setAskError(null);
  };
  const sendAsk = async () => {
    if (!ask || !asking || sending || !note.trim()) return;
    if (boxMode === "comment") {
      addComment(ask.tileId, { path: file.path, lines: asking, note });
      setReviewError(null);
      closeAsk();
      return;
    }
    setSending(true);
    setAskError(null);
    try {
      await ask.send(diffQuestion(file.path, asking, note));
      closeAsk();
    } catch (reason) {
      setAskError(reason instanceof Error ? reason.message : "Sending failed.");
    } finally {
      setSending(false);
    }
  };
  // Types the review (several numbered lines only when one would be too
  // long). Sent comments leave the review; a failure keeps them all.
  const sendReview = async () => {
    if (!ask || reviewing || !comments.length) return;
    const sent = comments;
    const messages = reviewMessages(sent);
    setReviewing(true);
    setReviewError(null);
    let parts = 0;
    try {
      for (const message of messages) {
        await ask.send(message);
        parts += 1;
      }
      for (const comment of sent) removeComment(ask.tileId, comment.id);
      setListOpen(false);
    } catch (reason) {
      const message = reason instanceof Error ? reason.message : "Sending failed.";
      setReviewError(parts ? `Sent ${parts} of ${messages.length} parts, then: ${message}` : message);
    } finally {
      setReviewing(false);
    }
  };
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  const boxLabel = (lines: DiffLineSelection) => (boxMode === "comment" ? `Comment on ${diffLinesLabel(lines)}` : `Ask the agent about ${diffLinesLabel(lines)}`);

  if (state.status === "idle" || state.status === "loading") {
    return <div className="code-status"><Loader2 size={16} className="sw-spin" /> Loading changes…</div>;
  }
  if (state.status === "error" || !diff) return <div className="code-status code-err" role="alert">{state.error ?? "File changes unavailable"}</div>;
  if (diff.binary) return <div className="code-status muted">Binary file - no preview</div>;
  if (diff.before === (diff.after ?? "") && diff.after !== null) return <div className="code-status muted">No changes in this file</div>;
  return (
    <div className={`code-diff code-diff-${mode}`}>
      <div className="code-diff-bar">
        <span className="code-diff-legend" aria-hidden="true">
          <span className="code-diff-legend-del">− removed</span>
          <span className="code-diff-legend-add">+ added</span>
        </span>
        {ask && selection ? (
          <button type="button" className="btn btn-sm code-diff-ask-btn" disabled={!ask.available}
            title={ask.available ? `Ask the agent in this tile about ${diffLinesLabel(selection)}` : "No agent running in this tile"}
            onMouseDown={stop} onClick={() => openBox("ask")}>
            <MessageSquare size={12} aria-hidden="true" />Ask agent
          </button>
        ) : null}
        {ask && selection ? (
          <button type="button" className="btn btn-sm code-diff-ask-btn"
            title={`Add a review comment on ${diffLinesLabel(selection)}; Send review types every comment to the agent at once`}
            onMouseDown={stop} onClick={() => openBox("comment")}>
            <MessageSquarePlus size={12} aria-hidden="true" />Add comment
          </button>
        ) : null}
        {ask && comments.length ? (
          <span className="code-diff-review" role="group" aria-label="Pending review">
            <button type="button" className="code-diff-review-count" aria-expanded={listOpen} aria-controls={listId}
              title={listOpen ? "Hide the pending comments" : "Show the pending comments to edit or delete them"}
              onMouseDown={stop} onClick={() => setListOpen((open) => !open)}>
              {comments.length === 1 ? "1 comment" : `${comments.length} comments`}
            </button>
            <span className="code-diff-review-dot" aria-hidden="true">·</span>
            <button type="button" className="btn btn-sm code-diff-ask-btn" disabled={!ask.available || reviewing} aria-busy={reviewing || undefined}
              title={ask.available ? "Type every pending comment to the agent in this tile as one review" : "No agent running in this tile"}
              onMouseDown={stop} onClick={() => void sendReview()}>
              {reviewing ? <Loader2 size={12} className="async-spinner" aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}Send review
            </button>
          </span>
        ) : null}
        <span className="code-diff-mode" role="radiogroup" aria-label="Diff layout">
          {(["unified", "split"] as const).map((value) => (
            <button key={value} type="button" role="radio" aria-checked={mode === value} className={mode === value ? "on" : ""}
              onMouseDown={(event) => event.stopPropagation()} onClick={() => choose(value)}>
              {value === "unified" ? <Rows2 size={12} aria-hidden="true" /> : <Columns2 size={12} aria-hidden="true" />}
              <span className="code-diff-mode-label">{value === "unified" ? "Unified" : "Split"}</span>
            </button>
          ))}
        </span>
      </div>
      {ask && asking ? (
        <div className="code-diff-ask" role="group" aria-label={boxMode === "comment" ? "Add a review comment" : "Ask the agent"} onMouseDown={stop}>
          <span className="code-diff-ask-target" title={`${file.path}, ${diffLinesLabel(asking)}`}>{diffLinesLabel(asking)}</span>
          <input
            key={boxMode}
            className="code-diff-ask-input"
            value={note}
            placeholder={boxMode === "comment" ? "Comment on these lines…" : "Ask about these lines…"}
            aria-label={boxLabel(asking)}
            spellCheck={false}
            maxLength={2000}
            autoFocus
            disabled={sending}
            onChange={(event) => { setNote(event.target.value); setAskError(null); }}
            onKeyDown={(event) => {
              if (event.key === "Enter" && !event.nativeEvent.isComposing) { event.preventDefault(); void sendAsk(); }
              else if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeAsk(); }
            }}
          />
          {boxMode === "comment" ? (
            <button type="button" className="btn btn-sm code-diff-ask-btn" disabled={!note.trim()}
              title="Add to the review (Enter)" onClick={() => void sendAsk()}>
              <MessageSquarePlus size={12} aria-hidden="true" />Add
            </button>
          ) : (
            <button type="button" className="btn btn-sm code-diff-ask-btn" disabled={sending || !note.trim() || !ask.available}
              title={ask.available ? "Send to the agent (Enter)" : "No agent running in this tile"} onClick={() => void sendAsk()}>
              {sending ? <Loader2 size={12} className="async-spinner" aria-hidden="true" /> : <Send size={12} aria-hidden="true" />}Send
            </button>
          )}
          {askError ? <span className="code-diff-ask-error" role="alert">{askError}</span> : null}
        </div>
      ) : null}
      {ask && listOpen && comments.length ? (
        <ul className="code-diff-review-list" id={listId} aria-label="Pending review comments" onMouseDown={stop}>
          {comments.map((comment) => (
            <ReviewCommentRow key={comment.id} comment={comment}
              onEdit={(next) => editComment(ask.tileId, comment.id, next)} onRemove={() => removeComment(ask.tileId, comment.id)} />
          ))}
        </ul>
      ) : null}
      {reviewError ? <div className="code-diff-note code-diff-review-error" role="alert">{reviewError}</div> : null}
      {diff.truncated ? <div className="code-diff-note" role="status">This file is too large to compare in full; only its beginning is shown.</div> : null}
      {mode === "split" ? (
        <SplitDiff key={state.version} before={diff.before ?? ""} after={diff.after ?? ""} extensions={splitExtensions} sides={splitSides} />
      ) : (
        <CodeMirror
          key={state.version}
          className="code-diff-editor"
          value={diff.after ?? ""}
          editable={false}
          readOnly
          theme={theme}
          extensions={extensions}
          basicSetup={{ highlightActiveLine: false, highlightActiveLineGutter: false, foldGutter: false }}
          height="100%"
          style={{ height: "100%" }}
        />
      )}
    </div>
  );
}
