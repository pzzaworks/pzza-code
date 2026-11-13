import { Facet, RangeSet, RangeSetBuilder, StateEffect, StateField, type EditorState, type Extension, type Text } from "@codemirror/state";
import { Decoration, EditorView, GutterMarker, ViewPlugin, WidgetType, gutter, keymap, showTooltip, type BlockInfo, type DecorationSet, type Tooltip, type ViewUpdate } from "@codemirror/view";
import {
  GIT_LINES_MAX_CHARS, GIT_LINES_MAX_LINES, blameText, diffAgainstHead, fetchGitFileBlame, fetchGitFileHead, normalizeLines, revertEdit,
  type GitFileBlame, type GitFileHead, type LineChange, type LinesAgainstHead,
} from "./gitLines";

// Git in the editor: a change gutter against HEAD (click a mark for the old
// lines and a buffer-only revert) and inline blame on the cursor line.
//
// The buffer is diffed against HEAD here rather than on the device: one
// request per load or save fetches HEAD's content, and every edit after that
// is compared locally (debounced), so unsaved edits are marked correctly and
// typing never reaches the network. Blame is of HEAD, mapped onto the buffer
// through the same diff: lines that match HEAD take their commit, changed
// lines are "You, uncommitted".

export interface GitEditorConfig { host: string; path: string; reload: number; blame: boolean }
const gitEditorConfig = Facet.define<GitEditorConfig, GitEditorConfig | null>({ combine: (values) => values[0] ?? null });

const DIFF_DEBOUNCE_MS = 250;
const HEAD_CACHE_MS = 30000;
const CACHE_ENTRIES = 16;

type BlameData = Extract<GitFileBlame, { repo: true }>;
interface GitLinesState {
  // "repo": HEAD known (headText null for a file new to the repository).
  status: "none" | "repo";
  file: string | null;
  blob: string | null;
  headText: string | null;
  headLines: string[] | null;
  diff: LinesAgainstHead | null;
  // The buffer changed since `diff` was computed; blame waits for the next one.
  stale: boolean;
  markers: RangeSet<GutterMarker>;
  blame: BlameData | null;
}
const EMPTY: GitLinesState = { status: "none", file: null, blob: null, headText: null, headLines: null, diff: null, stale: false, markers: RangeSet.empty, blame: null };

const setHead = StateEffect.define<{ file: string; blob: string | null; head: string | null } | null>();
const setDiff = StateEffect.define<LinesAgainstHead | null>();
const setBlame = StateEffect.define<BlameData | null>();

type MarkKind = "added" | "modified" | "deleted-above" | "deleted-below";
const LABELS: Record<MarkKind, string> = { added: "Added line", modified: "Changed line", "deleted-above": "Lines deleted above", "deleted-below": "Lines deleted below" };
class ChangeMark extends GutterMarker {
  constructor(readonly kind: MarkKind) { super(); }
  eq(other: GutterMarker) { return other instanceof ChangeMark && other.kind === this.kind; }
  toDOM() {
    const mark = document.createElement("div");
    mark.className = `cm-pz-git-mark cm-pz-git-${this.kind}`;
    mark.title = `${LABELS[this.kind]}: click to see HEAD's version`;
    return mark;
  }
}
const MARKS: Record<MarkKind, ChangeMark> = {
  added: new ChangeMark("added"), modified: new ChangeMark("modified"), "deleted-above": new ChangeMark("deleted-above"), "deleted-below": new ChangeMark("deleted-below"),
};

function buildMarkers(doc: Text, diff: LinesAgainstHead): RangeSet<GutterMarker> {
  const builder = new RangeSetBuilder<GutterMarker>();
  for (const change of diff.changes) {
    if (change.kind === "deleted") {
      const below = change.from >= doc.lines;
      const line = doc.line(below ? doc.lines : change.from + 1);
      builder.add(line.from, line.from, MARKS[below ? "deleted-below" : "deleted-above"]);
      continue;
    }
    for (let at = change.from; at < change.to && at < doc.lines; at += 1) {
      const line = doc.line(at + 1);
      builder.add(line.from, line.from, MARKS[change.kind]);
    }
  }
  return builder.finish();
}

const gitLinesField = StateField.define<GitLinesState>({
  create: () => EMPTY,
  update(value, tr) {
    let next = value;
    if (tr.docChanged && next.status === "repo") next = { ...next, markers: next.markers.map(tr.changes), stale: true };
    for (const effect of tr.effects) {
      if (effect.is(setHead)) {
        const head = effect.value;
        if (!head) next = EMPTY;
        else {
          const headText = head.head === null ? null : normalizeLines(head.head);
          // Blame of the same HEAD version stays while it is fetched again (after a save).
          const blame = next.file === head.file && next.blob === head.blob ? next.blame : null;
          next = { ...EMPTY, status: "repo", file: head.file, blob: head.blob, headText, headLines: headText?.split("\n") ?? null, blame };
        }
      } else if (effect.is(setDiff)) {
        next = { ...next, diff: effect.value, stale: false, markers: effect.value ? buildMarkers(tr.state.doc, effect.value) : RangeSet.empty };
      } else if (effect.is(setBlame)) {
        next = { ...next, blame: effect.value };
      }
    }
    return next;
  },
});

/** The open file's path inside its repository, once known. */
export function gitRepoFile(state: EditorState): string | null {
  return state.field(gitLinesField, false)?.file ?? null;
}

const tooLarge = (doc: Text) => doc.lines > GIT_LINES_MAX_LINES || doc.length > GIT_LINES_MAX_CHARS;

// ---------------------------------------------------------- hunk popover

const openHunk = StateEffect.define<LineChange | null>();

function changeAtLine(diff: LinesAgainstHead, line: number, lines: number): LineChange | null {
  for (const change of diff.changes) {
    if (change.kind === "deleted" ? change.from === line || (change.from >= lines && line === lines - 1) : line >= change.from && line < change.to) return change;
  }
  return null;
}

function hunkTitle(change: LineChange): string {
  const span = (from: number, to: number) => (to - from === 1 ? `line ${from + 1}` : `lines ${from + 1}-${to}`);
  if (change.kind === "added") return `Added ${span(change.from, change.to)}`;
  if (change.kind === "modified") return `Changed ${span(change.from, change.to)}`;
  const count = change.oldTo - change.oldFrom;
  return `Deleted ${count} ${count === 1 ? "line" : "lines"}`;
}

function revertHunk(view: EditorView, change: LineChange): void {
  const state = view.state.field(gitLinesField);
  if (!state.headLines) return;
  const doc = view.state.doc;
  const edit = revertEdit(change, state.headLines, (line) => doc.line(line + 1).from, (line) => doc.line(line + 1).to, doc.lines, doc.length);
  view.dispatch({ changes: edit, effects: openHunk.of(null), userEvent: "input.revert", scrollIntoView: true });
  view.focus();
}

function hunkTooltip(change: LineChange, pos: number): Tooltip {
  return {
    pos,
    above: false,
    create: (view) => {
      const dom = document.createElement("div");
      dom.className = "cm-pz-hunk";
      dom.setAttribute("role", "dialog");
      dom.setAttribute("aria-label", hunkTitle(change));
      const head = dom.appendChild(document.createElement("div"));
      head.className = "cm-pz-hunk-head";
      const title = head.appendChild(document.createElement("span"));
      title.className = "cm-pz-hunk-title";
      title.textContent = hunkTitle(change);
      const revert = head.appendChild(document.createElement("button"));
      revert.type = "button";
      revert.className = "cm-pz-hunk-btn";
      revert.textContent = "Revert hunk";
      revert.title = "Put HEAD's version back in the editor. Nothing is saved until you save.";
      revert.addEventListener("mousedown", (event) => event.preventDefault());
      revert.addEventListener("click", () => revertHunk(view, change));
      const close = head.appendChild(document.createElement("button"));
      close.type = "button";
      close.className = "cm-pz-hunk-btn cm-pz-hunk-close";
      close.textContent = "×";
      close.setAttribute("aria-label", "Close");
      close.addEventListener("mousedown", (event) => event.preventDefault());
      close.addEventListener("click", () => view.dispatch({ effects: openHunk.of(null) }));
      const lines = view.state.field(gitLinesField).headLines?.slice(change.oldFrom, change.oldTo) ?? [];
      if (lines.length) {
        const old = dom.appendChild(document.createElement("pre"));
        old.className = "cm-pz-hunk-old";
        old.textContent = lines.join("\n");
      } else {
        const note = dom.appendChild(document.createElement("p"));
        note.className = "cm-pz-hunk-note";
        note.textContent = "These lines are new: HEAD has nothing here.";
      }
      // Pinned just inside the text area at the hunk's first line, so a line
      // start scrolled out of view sideways never hides it. The few pixels
      // keep it clear of the gutter edge, which the editor rounds up.
      const getCoords = (at: number) => {
        const block = view.lineBlockAt(at);
        const top = view.documentTop + block.top;
        const left = (view.dom.querySelector(".cm-gutters")?.getBoundingClientRect().right ?? view.scrollDOM.getBoundingClientRect().left) + 4;
        return { left, right: left, top, bottom: top + block.height };
      };
      return { dom, getCoords };
    },
  };
}

const hunkField = StateField.define<Tooltip | null>({
  create: () => null,
  update(value, tr) {
    for (const effect of tr.effects) {
      if (!effect.is(openHunk)) continue;
      const change = effect.value;
      if (!change) return null;
      const doc = tr.state.doc;
      const line = doc.line(Math.min(doc.lines, change.from + 1));
      return hunkTooltip(change, line.from);
    }
    // Any edit or cursor move closes it: the hunk it shows may no longer exist.
    return tr.docChanged || tr.selection ? null : value;
  },
  provide: (field) => showTooltip.from(field),
});

function openHunkAt(view: EditorView, block: BlockInfo): boolean {
  const state = view.state.field(gitLinesField);
  if (state.status !== "repo" || state.headText === null) return false;
  const doc = view.state.doc;
  const line = doc.lineAt(block.from).number - 1;
  // A click right after typing uses the buffer as it is now, not the last debounced diff.
  const diff = state.stale ? diffAgainstHead(state.headText, doc.toString()) : state.diff;
  const change = diff ? changeAtLine(diff, line, doc.lines) : null;
  if (!change) return false;
  view.dispatch({ effects: [...(state.stale ? [setDiff.of(diff)] : []), openHunk.of(change)] });
  return true;
}

const changeGutter = gutter({
  class: "cm-pz-git-gutter",
  markers: (view) => view.state.field(gitLinesField).markers,
  domEventHandlers: {
    mousedown: (view, block, event) => {
      if (!(event instanceof MouseEvent) || event.button !== 0) return false;
      if (!openHunkAt(view, block)) return false;
      event.preventDefault();
      return true;
    },
  },
});

// ---------------------------------------------------------- inline blame

class BlameWidget extends WidgetType {
  constructor(readonly label: string, readonly detail: string) { super(); }
  eq(other: BlameWidget) { return other.label === this.label && other.detail === this.detail; }
  toDOM() {
    const span = document.createElement("span");
    span.className = "cm-pz-blame";
    span.textContent = this.label;
    span.title = this.detail;
    span.setAttribute("aria-hidden", "true");
    return span;
  }
}

function blameDecorations(state: EditorState): DecorationSet {
  const config = state.facet(gitEditorConfig);
  const git = state.field(gitLinesField);
  if (!config?.blame || git.status !== "repo" || git.stale) return Decoration.none;
  const selection = state.selection.main;
  if (!selection.empty) return Decoration.none;
  const line = state.doc.lineAt(selection.head);
  let text: { label: string; detail: string } | null = null;
  if (git.headText === null) text = blameText(null);
  else {
    const origin = git.diff?.origin[line.number - 1];
    if (origin === undefined) return Decoration.none;
    if (origin < 0) text = blameText(null);
    else {
      const at = git.blame?.lines[origin];
      const commit = at === undefined ? undefined : git.blame?.commits[at];
      if (commit) text = blameText(commit);
    }
  }
  if (!text) return Decoration.none;
  return Decoration.set([Decoration.widget({ widget: new BlameWidget(text.label, text.detail), side: 1 }).range(line.to)]);
}

const inlineBlame = EditorView.decorations.compute(["selection", gitLinesField, gitEditorConfig], blameDecorations);

// ---------------------------------------------------------------- loading

// Results are kept briefly, so remounting the editor (a preview toggle, a
// layout change) does not ask the device again; a save changes `reload`.
const heads = new Map<string, { at: number; value: GitFileHead }>();
const blames = new Map<string, BlameData>();
function remember<T>(cache: Map<string, T>, key: string, value: T) {
  cache.delete(key);
  cache.set(key, value);
  while (cache.size > CACHE_ENTRIES) cache.delete(cache.keys().next().value ?? key);
}

const loader = ViewPlugin.fromClass(class {
  private key = "";
  private blameKey = "";
  private headController: AbortController | null = null;
  private blameController: AbortController | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private destroyed = false;
  private head: GitFileHead | null = null;

  constructor(readonly view: EditorView) { this.sync(); }

  update(update: ViewUpdate) {
    if (update.docChanged && update.state.field(gitLinesField).status === "repo") {
      clearTimeout(this.timer);
      this.timer = setTimeout(() => this.recompute(), DIFF_DEBOUNCE_MS);
    }
    if (update.startState.facet(gitEditorConfig) !== update.state.facet(gitEditorConfig)) this.sync();
  }

  destroy() {
    this.destroyed = true;
    clearTimeout(this.timer);
    this.headController?.abort();
    this.blameController?.abort();
  }

  private dispatch(...effects: StateEffect<unknown>[]) {
    if (!this.destroyed) this.view.dispatch({ effects });
  }

  private sync() {
    const config = this.view.state.facet(gitEditorConfig);
    if (!config) return;
    const key = `${config.host}\u0000${config.path}\u0000${config.reload}`;
    if (key !== this.key) {
      this.key = key;
      this.blameKey = "";
      void this.load(config);
    } else if (config.blame) {
      void this.loadBlame(config);
    } else {
      this.blameController?.abort();
      this.blameKey = "";
    }
  }

  private async load(config: GitEditorConfig) {
    this.headController?.abort();
    this.blameController?.abort();
    this.head = null;
    const controller = new AbortController();
    this.headController = controller;
    // Never dispatch from inside the update that started this.
    await Promise.resolve();
    if (controller.signal.aborted || this.destroyed) return;
    if (tooLarge(this.view.state.doc)) { this.dispatch(setHead.of(null)); return; }
    let head: GitFileHead;
    const cached = heads.get(this.key);
    try {
      if (cached && Date.now() - cached.at < HEAD_CACHE_MS) head = cached.value;
      else {
        head = await fetchGitFileHead(config.host, config.path, controller.signal);
        remember(heads, this.key, { at: Date.now(), value: head });
      }
    } catch {
      if (!controller.signal.aborted) this.dispatch(setHead.of(null));
      return;
    }
    if (controller.signal.aborted || this.destroyed) return;
    if (!head.repo || head.tooLarge || head.binary) { this.dispatch(setHead.of(null)); return; }
    this.head = head;
    this.dispatch(setHead.of({ file: head.file, blob: head.blob, head: head.head }));
    this.recompute();
    if (config.blame) await this.loadBlame(config);
  }

  private async loadBlame(config: GitEditorConfig) {
    const blob = this.head;
    if (!blob?.repo || blob.blob === null || blob.head === null) return;
    const key = `${config.host}\u0000${config.path}\u0000${blob.blob}`;
    if (key === this.blameKey) return;
    this.blameKey = key;
    this.blameController?.abort();
    const controller = new AbortController();
    this.blameController = controller;
    let blame = blames.get(key) ?? null;
    if (!blame) {
      try {
        const result = await fetchGitFileBlame(config.host, config.path, controller.signal);
        // A commit landing between the two reads: keep only blame of the HEAD diffed against.
        blame = result.repo && !result.tooLarge && result.blob === blob.blob ? result : null;
        if (blame) remember(blames, key, blame);
      } catch {
        blame = null;
      }
    }
    if (controller.signal.aborted || this.destroyed) return;
    if (!blame) this.blameKey = "";
    this.dispatch(setBlame.of(blame));
  }

  private recompute() {
    if (this.destroyed) return;
    const state = this.view.state.field(gitLinesField);
    if (state.status !== "repo") return;
    const doc = this.view.state.doc;
    if (tooLarge(doc)) { this.dispatch(setHead.of(null)); return; }
    // A file new to the repository has nothing to mark; blame calls it uncommitted.
    this.dispatch(setDiff.of(state.headText === null ? null : diffAgainstHead(state.headText, doc.toString())));
  }
});

const closeHunkKey = keymap.of([{
  key: "Escape",
  run: (view) => {
    if (!view.state.field(hunkField)) return false;
    view.dispatch({ effects: openHunk.of(null) });
    return true;
  },
}]);

// The gutter column only takes room for files in a repository.
const IN_REPO: Record<string, string> = { class: "cm-pz-git-repo" };
const NOT_IN_REPO: Record<string, string> = {};
const repoClass = EditorView.editorAttributes.compute([gitLinesField], (state) =>
  (state.field(gitLinesField).status === "repo" ? IN_REPO : NOT_IN_REPO));

/** The change gutter and inline blame for one file. */
export function gitEditor(config: GitEditorConfig): Extension {
  return [gitEditorConfig.of(config), gitLinesField, hunkField, changeGutter, inlineBlame, repoClass, loader, closeHunkKey];
}
