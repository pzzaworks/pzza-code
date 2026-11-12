import { useEffect, useId, useMemo, useRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { BookmarkPlus, FileMinus2, FilePen, FilePlus2, History, Info, Loader2, RotateCcw, ShieldCheck, TriangleAlert, Undo2, type LucideIcon } from "lucide-react";
import {
  agentLabel, agentLooksBusy, captureManualCheckpoint, CheckpointRestoreError, fetchCheckpointDiff, fetchCheckpointFiles, previewCheckpoint, restoreCheckpoint,
  type Checkpoint, type CheckpointAgainst, type CheckpointFile, type CheckpointFiles, type CheckpointMode, type CheckpointPreview,
} from "../checkpoints";
import type { GitChangedFile } from "../serverApi";
import { sessionIcon } from "../sessionMeta";
import { useStore } from "../state/store";
import { themeById } from "../theme/themes";
import { Modal } from "../ui/Modal";
import { CodeDiffView, type GitDiffState } from "./CodeChanges";
import { useCheckpointList } from "./Checkpoints";
import { compactPath } from "./compactPath";

// A tile's checkpoint timeline: newest first on the left, the selected
// checkpoint's changes (against the one before it, or against the files as
// they are now) with a diff on the right, and the two ways back: restore
// everything to that checkpoint, or undo only that checkpoint's own changes.

const KIND_LABEL: Record<Checkpoint["kind"], string> = { start: "Baseline", turn: "Turn", manual: "Saved by hand", backup: "Before a restore" };

function title(checkpoint: Checkpoint): string {
  return checkpoint.summary || (checkpoint.kind === "turn" ? "Turn finished" : KIND_LABEL[checkpoint.kind]);
}

/**
 * A baseline saved after an earlier checkpoint marks where the agent's next
 * turn starts; the files it differs in from that checkpoint changed with no
 * turn end recorded in between (a turn that ended while the app was closed or
 * restarting, hand edits, other programs). They are labelled as changes made
 * between turns, not as the baseline's own.
 */
function betweenTurns(checkpoint: Checkpoint, previous: number | null): boolean {
  return checkpoint.kind === "start" && previous !== null && checkpoint.files > 0;
}
const BETWEEN_TURNS_HINT = "Changed after the checkpoint before it, with no finished turn recorded in between: a turn that ended while the app was closed or restarting, edits by hand, or other programs";

const pad = (value: number) => String(value).padStart(2, "0");
const clock = (time: number) => { const date = new Date(time); return `${pad(date.getHours())}:${pad(date.getMinutes())}`; };

function dayLabel(time: number, now: number): string {
  const day = new Date(time).toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now - 86400000).toDateString()) return "Yesterday";
  return new Date(time).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" });
}

export function relativeTime(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  return `${days} ${days === 1 ? "day" : "days"} ago`;
}

const filesLabel = (count: number) => `${count} ${count === 1 ? "file" : "files"}`;

function AgentMark({ agent, size = 13 }: { agent: string; size?: number }) {
  if (!agent) return <History size={size} aria-hidden="true" />;
  const Icon = sessionIcon(agent);
  return <Icon size={size} />;
}

function LineCounts({ added, removed }: { added: number | null; removed: number | null }) {
  if (added === null || removed === null) return <span className="cp-binary">binary</span>;
  return <>
    {added ? <span className="cp-add">+{added}</span> : null}
    {removed ? <span className="cp-del">−{removed}</span> : null}
  </>;
}

// ---------------------------------------------------------------- timeline

function Timeline({ checkpoints, selectedId, onSelect, now }: {
  checkpoints: Checkpoint[]; selectedId: number | null; onSelect(id: number): void; now: number;
}) {
  const items = useRef(new Map<number, HTMLDivElement>());
  const groups = useMemo(() => {
    const out: { label: string; entries: { checkpoint: Checkpoint; index: number }[] }[] = [];
    checkpoints.forEach((checkpoint, index) => {
      const label = dayLabel(checkpoint.time, now);
      const last = out[out.length - 1];
      if (last?.label === label) last.entries.push({ checkpoint, index });
      else out.push({ label, entries: [{ checkpoint, index }] });
    });
    return out;
  }, [checkpoints, now]);
  const move = (event: KeyboardEvent<HTMLDivElement>, index: number) => {
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1
      : event.key === "Home" ? 0 : event.key === "End" ? checkpoints.length - 1 : -1;
    if (next < 0 || next >= checkpoints.length || (event.key !== "Home" && event.key !== "End" && next === index)) return;
    event.preventDefault();
    const target = checkpoints[next];
    onSelect(target.id);
    items.current.get(target.id)?.focus();
  };
  return <div className="cp-timeline" role="listbox" aria-label="Checkpoints, newest first">
    {groups.map((group) => <div key={group.label} role="group" aria-label={group.label} className="cp-day">
      <div className="cp-day-label" aria-hidden="true">{group.label}</div>
      {group.entries.map(({ checkpoint, index }) => {
        const selected = checkpoint.id === selectedId;
        const name = title(checkpoint);
        const gap = betweenTurns(checkpoint, checkpoints[index + 1]?.id ?? null);
        const files = gap ? `${filesLabel(checkpoint.files)} changed between turns` : filesLabel(checkpoint.files);
        const label = [name, clock(checkpoint.time), KIND_LABEL[checkpoint.kind], checkpoint.agent ? agentLabel(checkpoint.agent) : "",
          files, `${checkpoint.added} lines added, ${checkpoint.removed} removed`].filter(Boolean).join(", ");
        return <div
          key={checkpoint.id}
          ref={(element) => { if (element) items.current.set(checkpoint.id, element); else items.current.delete(checkpoint.id); }}
          role="option"
          aria-selected={selected}
          aria-label={label}
          tabIndex={selected ? 0 : -1}
          className={`cp-item cp-kind-${checkpoint.kind}${selected ? " on" : ""}${index === checkpoints.length - 1 ? " is-last" : ""}`}
          style={{ "--cp-i": Math.min(index, 12) } as CSSProperties}
          onClick={() => onSelect(checkpoint.id)}
          onKeyDown={(event) => move(event, index)}
        >
          <span className="cp-rail" aria-hidden="true"><span className="cp-node" /></span>
          <span className="cp-item-main">
            <span className="cp-item-head">
              <span className="cp-item-agent" aria-hidden="true"><AgentMark agent={checkpoint.agent} size={12} /></span>
              <span className="cp-item-title" title={name}>{name}</span>
            </span>
            <span className="cp-item-meta" aria-hidden="true">
              <time dateTime={new Date(checkpoint.time).toISOString()} title={relativeTime(checkpoint.time, now)}>{clock(checkpoint.time)}</time>
              {checkpoint.kind !== "turn" ? <span className="cp-badge">{KIND_LABEL[checkpoint.kind]}</span> : null}
              {gap ? <span className="cp-between" title={BETWEEN_TURNS_HINT}>{files}</span> : <span>{files}</span>}
              <LineCounts added={checkpoint.added} removed={checkpoint.removed} />
            </span>
          </span>
        </div>;
      })}
    </div>)}
  </div>;
}

// ------------------------------------------------------------------ detail

interface FilesState { status: "loading" | "ready" | "error"; data?: CheckpointFiles; error?: string }

function useCheckpointFiles(host: string, path: string, id: number, against: CheckpointAgainst, revision: number): FilesState {
  const [state, setState] = useState<FilesState & { key: string }>({ status: "loading", key: "" });
  const key = `${id}:${against}:${revision}`;
  useEffect(() => {
    const controller = new AbortController();
    setState((current) => ({ status: "loading", data: current.key.startsWith(`${id}:${against}:`) ? current.data : undefined, key }));
    fetchCheckpointFiles(host, path, id, against, controller.signal)
      .then((data) => { if (!controller.signal.aborted) setState({ status: "ready", data, key }); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setState({ status: "error", error: cause instanceof Error ? cause.message : "Checkpoint changes unavailable", key }); });
    return () => controller.abort();
  }, [host, path, id, against, key]);
  // Until the effect catches up, another comparison is loading rather than
  // showing the previous one's files under the new label. A refresh of the
  // same comparison keeps its files on screen meanwhile.
  if (state.key !== key) return { status: "loading", data: state.key.startsWith(`${id}:${against}:`) ? state.data : undefined };
  return state;
}

function useDiff(host: string, path: string, files: CheckpointFiles | undefined, file: CheckpointFile | null): GitDiffState {
  const [state, setState] = useState<GitDiffState>({ status: "idle", version: 0 });
  const from = files?.from, to = files?.to, name = file?.path;
  useEffect(() => {
    if (!from || !to || !name) { setState((current) => ({ status: "idle", version: current.version })); return; }
    const controller = new AbortController();
    setState((current) => ({ status: "loading", version: current.version }));
    fetchCheckpointDiff(host, path, from, to, name, controller.signal)
      .then((diff) => { if (!controller.signal.aborted) setState((current) => ({ status: "ready", diff, version: current.version + 1 })); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setState((current) => ({ status: "error", error: cause instanceof Error ? cause.message : "File changes unavailable", version: current.version })); });
    return () => controller.abort();
  }, [host, path, from, to, name]);
  return state;
}

const FILE_MARK: Record<CheckpointFile["status"], { letter: string; label: string; changes: GitChangedFile["status"] }> = {
  added: { letter: "A", label: "Added", changes: "added" },
  deleted: { letter: "D", label: "Deleted", changes: "deleted" },
  modified: { letter: "M", label: "Modified", changes: "modified" },
};

function FileList({ files, selected, onSelect }: { files: CheckpointFile[]; selected: string | null; onSelect(path: string): void }) {
  const rows = useRef(new Map<string, HTMLButtonElement>());
  const move = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = event.key === "ArrowDown" ? index + 1 : event.key === "ArrowUp" ? index - 1 : -1;
    if (next < 0 || next >= files.length) return;
    event.preventDefault();
    onSelect(files[next].path);
    rows.current.get(files[next].path)?.focus();
  };
  return <div className="cp-files" role="list" aria-label="Changed files">
    {files.map((file, index) => {
      const mark = FILE_MARK[file.status];
      const at = file.path.lastIndexOf("/");
      const name = at < 0 ? file.path : file.path.slice(at + 1);
      const dir = at < 0 ? "" : file.path.slice(0, at);
      const on = file.path === selected;
      return <div role="listitem" key={file.path}>
        <button
          type="button"
          ref={(element) => { if (element) rows.current.set(file.path, element); else rows.current.delete(file.path); }}
          className={`cp-file${on ? " on" : ""}`}
          aria-current={on ? "true" : undefined}
          aria-label={`${file.path}, ${mark.label.toLowerCase()}${file.added === null ? ", binary" : `, ${file.added} lines added, ${file.removed} removed`}`}
          title={`${mark.label}: ${file.path}`}
          onClick={() => onSelect(file.path)}
          onKeyDown={(event) => move(event, index)}
        >
          <span className={`code-changes-status code-changes-status-${mark.changes}`} aria-hidden="true">{mark.letter}</span>
          <span className="cp-file-name">{name}</span>
          {dir ? <span className="cp-file-dir">{dir}</span> : null}
          <span className="cp-file-lines" aria-hidden="true"><LineCounts added={file.added} removed={file.removed} /></span>
        </button>
      </div>;
    })}
  </div>;
}

function Detail({ host, path, checkpoint, previous, revision, busy, onRestore, onUndo, undoState }: {
  host: string; path: string; checkpoint: Checkpoint; previous: number | null; revision: number; busy: CheckpointMode | null;
  onRestore(): void; onUndo(): void; undoState: UndoState;
}) {
  const [against, setAgainst] = useState<CheckpointAgainst>("previous");
  const files = useCheckpointFiles(host, path, checkpoint.id, against, revision);
  const [selected, setSelected] = useState<string | null>(null);
  const list = files.data?.files ?? [];
  const file = list.find((entry) => entry.path === selected) ?? list[0] ?? null;
  useEffect(() => { setSelected(null); }, [checkpoint.id, against]);
  const diff = useDiff(host, path, files.status === "ready" ? files.data : undefined, file);
  const themeId = useStore((state) => state.themeId);
  const editorTheme = themeById(themeId).appearance === "light" ? githubLight : githubDark;
  const headingId = useId();
  const gap = betweenTurns(checkpoint, previous);
  const note = against === "now" ? "Compared with the files as they are now"
    : files.data?.previous ? (gap ? `Changed since checkpoint #${files.data.previous}, outside a recorded turn` : `Compared with checkpoint #${files.data.previous}`)
      : files.data ? "Compared with the commit it was taken on" : "";
  const isTurn = checkpoint.kind === "turn";
  const undoTitle = undoState.status === "blocked" ? `${isTurn ? "Undo this turn" : "Undo these changes"}\n${undoState.reason}`
    : `${isTurn ? "Undo this turn" : "Undo these changes"}\nReverts only this checkpoint's own changes and keeps everything after it`;
  return <section className="cp-detail" aria-labelledby={headingId}>
    <header className="cp-detail-head">
      <div className="cp-detail-heading">
        <h3 id={headingId} className="cp-detail-title">{title(checkpoint)}</h3>
        <span className="cp-detail-id">#{checkpoint.id}</span>
      </div>
      <div className="cp-detail-meta">
        <span className="cp-detail-agent"><AgentMark agent={checkpoint.agent} size={12} />{checkpoint.agent ? agentLabel(checkpoint.agent) : KIND_LABEL[checkpoint.kind]}</span>
        {checkpoint.session ? <span>{checkpoint.session}</span> : null}
        {checkpoint.branch ? <code className="cp-detail-branch">{checkpoint.branch}</code> : null}
        <time dateTime={new Date(checkpoint.time).toISOString()} title={new Date(checkpoint.time).toLocaleString()}>
          {`${new Date(checkpoint.time).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" })}, ${clock(checkpoint.time)}`}
        </time>
      </div>
      {gap ? <p className="cp-detail-info"><Info size={12} aria-hidden="true" />
        {`${filesLabel(checkpoint.files)} changed after checkpoint #${previous} with no finished turn recorded in between: a turn that ended while the app was closed or restarting, edits by hand, or other programs. The baseline itself changed nothing.`}
      </p> : null}
      {checkpoint.skipped ? <p className="cp-detail-warn"><TriangleAlert size={12} aria-hidden="true" />{checkpoint.skipped} large untracked {checkpoint.skipped === 1 ? "file was" : "files were"} left out of this checkpoint.</p> : null}
      <div className="cp-detail-actions">
        <button type="button" className="btn btn-sm cp-action" onClick={onUndo}
          disabled={busy !== null || !checkpoint.files || undoState.status === "blocked"}
          aria-busy={busy === "undo" || undefined} title={undoTitle}>
          {busy === "undo" ? <Loader2 size={13} className="async-spinner" aria-hidden="true" /> : <Undo2 size={13} aria-hidden="true" />}
          {isTurn ? "Undo this turn" : "Undo these changes"}
        </button>
        <button type="button" className="btn btn-sm btn-accent cp-action" onClick={onRestore} disabled={busy !== null} aria-busy={busy === "restore" || undefined}
          title={"Restore to here\nMakes every file match this checkpoint, after saving the current files as a new checkpoint"}>
          {busy === "restore" ? <Loader2 size={13} className="async-spinner" aria-hidden="true" /> : <RotateCcw size={13} aria-hidden="true" />}
          Restore to here
        </button>
        {undoState.status === "blocked" ? <span className="cp-undo-note" role="note">{undoState.short}</span> : null}
      </div>
    </header>
    <div className="cp-compare">
      <div className="cp-segment" role="radiogroup" aria-label="Compare">
        {(["previous", "now"] as const).map((value) => <button key={value} type="button" role="radio" aria-checked={against === value}
          className={against === value ? "on" : ""} onClick={() => setAgainst(value)}
          onKeyDown={(event) => { if (event.key === "ArrowLeft" || event.key === "ArrowRight") { event.preventDefault(); const next = value === "now" ? "previous" : "now"; setAgainst(next); event.currentTarget.parentElement?.querySelector<HTMLElement>(`[data-value="${next}"]`)?.focus(); } }}
          data-value={value} tabIndex={against === value ? 0 : -1}>
          {value === "previous" ? (isTurn ? "This turn" : gap ? "Between turns" : "Its changes") : "Since then"}
        </button>)}
      </div>
      <span className="cp-compare-note" aria-live="polite">{note}</span>
    </div>
    <div className="cp-body">
      {files.status === "error" ? <div className="cp-note cp-err" role="alert">{files.error}</div>
        : !files.data ? <div className="cp-note"><Loader2 size={14} className="sw-spin" aria-hidden="true" /> Loading changes…</div>
          : !list.length ? <div className="cp-note">{against === "now" ? "Nothing changed since this checkpoint." : "No files changed in this checkpoint."}</div>
            : <>
              <div className="cp-files-pane">
                <FileList files={list} selected={file?.path ?? null} onSelect={setSelected} />
                {files.data.truncated ? <div className="cp-note">Showing the first {list.length} files</div> : null}
              </div>
              <div className="cp-diff">
                {file ? <CodeDiffView state={diff} file={{ path: file.path, status: FILE_MARK[file.status].changes }} theme={editorTheme} /> : null}
              </div>
            </>}
    </div>
  </section>;
}

// ----------------------------------------------------------------- confirm

const ACTION: Record<CheckpointPreview["files"][number]["action"], { Icon: LucideIcon; label: string; tone: string }> = {
  modify: { Icon: FilePen, label: "Modified", tone: "modify" },
  create: { Icon: FilePlus2, label: "Brought back", tone: "create" },
  delete: { Icon: FileMinus2, label: "Deleted", tone: "delete" },
};

function RestoreConfirm({ preview, root, agentBusy, onCancel, onConfirm }: {
  preview: CheckpointPreview; root: string; agentBusy: boolean; onCancel(): void; onConfirm(): void;
}) {
  const cancel = useRef<HTMLButtonElement>(null);
  const description = useId();
  const [override, setOverride] = useState(false);
  const undo = preview.mode === "undo";
  const counts = (["modify", "create", "delete"] as const).map((action) => [action, preview.files.filter((file) => file.action === action).length] as const).filter(([, count]) => count);
  const blocked = preview.blocked.length > 0;
  const nothing = !preview.files.length;
  const refused = blocked || !preview.applies;
  const ready = !nothing && !refused && (!agentBusy || override);
  const folder = root.split("/").filter(Boolean).pop() ?? root;
  return <Modal open onClose={onCancel} title={undo ? `Undo checkpoint #${preview.id}?` : `Restore to checkpoint #${preview.id}?`} role="alertdialog" size="md"
    describedBy={description} initialFocusRef={cancel} className="cp-confirm">
    <p id={description} className="cp-confirm-lead">
      {nothing ? (undo ? "This checkpoint has no changes left to undo." : "Your files already match this checkpoint, so nothing would change.")
        : undo ? `These files in ${folder} go back to how they were before this checkpoint. Changes made after it stay.`
          : `These files in ${folder} will be changed to match the checkpoint.`}
    </p>
    {nothing ? null : <>
      <div className="cp-confirm-counts" aria-hidden="true">
        {counts.map(([action, count]) => <span key={action} className={`cp-tone-${ACTION[action].tone}`}>{count} {ACTION[action].label.toLowerCase()}</span>)}
      </div>
      <ul className="cp-confirm-files" aria-label="Files that will change">
        {preview.files.map((file) => {
          const { Icon, label, tone } = ACTION[file.action];
          return <li key={file.path} className={`cp-tone-${tone}`}>
            <Icon size={13} aria-hidden="true" /><span className="cp-confirm-path" title={file.path}>{file.path}</span><span className="cp-confirm-action">{label}</span>
          </li>;
        })}
        {preview.truncated ? <li className="cp-confirm-more">More files are not listed.</li> : null}
      </ul>
    </>}
    {blocked ? <div className="cp-confirm-alert" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>{preview.blocked.length === 1 ? "This file is" : "These files are"} not in any checkpoint (Git ignores {preview.blocked.length === 1 ? "it" : "them"}, or {preview.blocked.length === 1 ? "it is" : "they are"} too large), and the change would overwrite or remove {preview.blocked.length === 1 ? "it" : "them"}: <strong>{preview.blocked.slice(0, 4).join(", ")}</strong>{preview.blocked.length > 4 ? ` and ${preview.blocked.length - 4} more` : ""}. Move {preview.blocked.length === 1 ? "it" : "them"} out of the way first.</span>
    </div> : null}
    {!blocked && !nothing && !preview.applies ? <div className="cp-confirm-alert" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>{undo && preview.reason && !preview.reason.startsWith("Git refused")
        ? `These changes no longer undo cleanly on their own, because later changes touch the same lines (${preview.reason}). Restore to the checkpoint before it instead.`
        : `${preview.reason ?? "Git refused this change"}.`}</span>
    </div> : null}
    {agentBusy && !nothing && !refused ? <div className="cp-confirm-alert cp-confirm-busy" role="alert">
      <TriangleAlert size={14} aria-hidden="true" />
      <span>The agent in this tile looks busy: its output changed in the last few seconds. Restoring now can mix with the files it is writing.</span>
      <label className="cp-confirm-override">
        <input type="checkbox" checked={override} onChange={(event) => setOverride(event.target.checked)} />
        Restore while the agent is working
      </label>
    </div> : null}
    {nothing || refused ? null : <p className="cp-confirm-safe"><ShieldCheck size={13} aria-hidden="true" />Your current files are saved as a checkpoint first, so this can be undone. Ignored files and staged changes are left alone.</p>}
    <div className="modal-actions">
      <button type="button" className="btn" ref={cancel} onClick={onCancel}>{nothing || refused ? "Close" : "Cancel"}</button>
      {nothing || refused ? null : <button type="button" className="btn btn-danger" disabled={!ready} onClick={onConfirm}>
        {undo ? "Undo changes" : "Restore files"}
      </button>}
    </div>
  </Modal>;
}

// ------------------------------------------------------------------- panel

type UndoState = { status: "unknown" | "clean" } | { status: "blocked"; reason: string; short: string };
type Banner = { tone: "ok" | "error"; text: string; undo?: number };

export function CheckpointsPanel({ tileId, host, path, onClose }: { tileId: string; host: string; path: string | undefined; onClose(): void }) {
  const state = useCheckpointList(host, path, true);
  const checkpoints = state.list?.checkpoints ?? [];
  const root = state.list?.root ?? path ?? "";
  const [selectedId, setSelectedId] = useState<number | null>(null);
  const selected = checkpoints.find((entry) => entry.id === selectedId) ?? checkpoints[0] ?? null;
  const [revision, setRevision] = useState(0);
  const [banner, setBanner] = useState<Banner | null>(null);
  const [saving, setSaving] = useState(false);
  const [busy, setBusy] = useState<CheckpointMode | null>(null);
  const [confirm, setConfirm] = useState<{ preview: CheckpointPreview; agentBusy: boolean } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  const [undoState, setUndoState] = useState<UndoState>({ status: "unknown" });
  const session = useStore((store) => {
    const tile = store.tiles.find((entry) => entry.id === tileId);
    return tile ? store.tileTitles[tileId] ?? tile.session ?? tile.name : "";
  });
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);
  const listKey = checkpoints.map((entry) => entry.id).join(",");
  useEffect(() => { setRevision((value) => value + 1); }, [listKey]);

  // Whether the selected checkpoint's own changes still undo cleanly, checked
  // in the background so the button can say so before it is pressed.
  useEffect(() => {
    setUndoState({ status: "unknown" });
    if (!path || !selected || !selected.files) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      previewCheckpoint(host, path, selected.id, "undo", controller.signal).then((preview) => {
        if (controller.signal.aborted) return;
        // Only an overlap disables the button; files in the way are explained when it is pressed.
        if (preview.applies || !preview.files.length || preview.blocked.length || !preview.reason || preview.reason.startsWith("Git refused")) setUndoState({ status: "clean" });
        else setUndoState({ status: "blocked", reason: `Later changes touch the same lines: ${preview.reason ?? "conflict"}`, short: "Later changes overlap; restore instead." });
      }).catch(() => { /* Checked again when pressed. */ });
    }, 350);
    return () => { clearTimeout(timer); controller.abort(); };
  }, [host, path, selected?.id, selected?.files, revision]);

  const start = async (checkpoint: Checkpoint, mode: CheckpointMode) => {
    if (!path || busy) return;
    setBusy(mode);
    setBanner(null);
    try {
      const [preview, agentBusy] = await Promise.all([previewCheckpoint(host, path, checkpoint.id, mode), agentLooksBusy(tileId)]);
      setConfirm({ preview, agentBusy });
    } catch (cause) {
      setBanner({ tone: "error", text: cause instanceof Error ? cause.message : "Could not prepare the restore." });
    } finally {
      setBusy(null);
    }
  };

  const apply = async () => {
    if (!confirm || !path) return;
    const { preview } = confirm;
    setConfirm(null);
    setBusy(preview.mode);
    try {
      const { backup } = await restoreCheckpoint(host, path, preview, session, root);
      setBanner({
        tone: "ok", undo: backup,
        text: preview.mode === "undo" ? `Undid checkpoint #${preview.id}. Your files from before are saved as #${backup}.`
          : `Restored to checkpoint #${preview.id}. Your files from before are saved as #${backup}.`,
      });
    } catch (cause) {
      setBanner({ tone: "error", text: cause instanceof Error ? cause.message : "Could not restore the checkpoint.", undo: cause instanceof CheckpointRestoreError && cause.backup ? cause.backup : undefined });
    } finally {
      setBusy(null);
    }
  };

  const save = async () => {
    if (!path || saving) return;
    setSaving(true);
    setBanner(null);
    try {
      const result = await captureManualCheckpoint(tileId, host, path);
      if (result.created && result.id) { setSelectedId(result.id); setBanner({ tone: "ok", text: `Saved checkpoint #${result.id}.` }); }
      else setBanner({ tone: "ok", text: result.id ? `Nothing changed since checkpoint #${result.id}.` : "Nothing changed since the last commit." });
      state.reload();
    } catch (cause) {
      setBanner({ tone: "error", text: cause instanceof Error ? cause.message : "Could not save a checkpoint." });
    } finally {
      setSaving(false);
    }
  };

  const undoRestore = (id: number) => {
    const target = checkpoints.find((entry) => entry.id === id);
    if (target) { setSelectedId(id); void start(target, "restore"); }
  };

  return <Modal open onClose={onClose} title="Checkpoints" icon={History} size="xl" className="cp-modal" pending={busy !== null && !confirm}>
    <div className="cp">
      <div className="cp-bar">
        <span className="cp-root" title={root}>{root ? compactPath(root) : "Unknown folder"}</span>
        {state.list ? <span className="cp-count" title={`The newest ${state.list.keep} are kept`}>{checkpoints.length} of {state.list.keep} kept</span> : null}
        <span className="cp-bar-spacer" />
        <button type="button" className="btn btn-sm" onClick={() => void save()} disabled={!path || saving || state.status === "error"} aria-busy={saving || undefined}
          title={"Save a checkpoint now\nKeeps the current files so you can come back to them"}>
          {saving ? <Loader2 size={13} className="async-spinner" aria-hidden="true" /> : <BookmarkPlus size={13} aria-hidden="true" />}
          Save checkpoint
        </button>
      </div>
      <div className="cp-banner-slot" aria-live="polite">
        {banner ? <div className={`cp-banner is-${banner.tone}`} role={banner.tone === "error" ? "alert" : "status"}>
          <span>{banner.text}</span>
          {banner.undo && checkpoints.some((entry) => entry.id === banner.undo) ? <button type="button" className="btn btn-sm" onClick={() => undoRestore(banner.undo ?? 0)}>
            <Undo2 size={13} aria-hidden="true" />Undo restore
          </button> : null}
        </div> : null}
      </div>
      {!path ? <Empty title="This tile's folder is not known yet" text="Checkpoints appear once the session reports its folder." />
        : state.status === "error" ? <Empty title={/not inside a Git repository/i.test(state.error ?? "") ? "Not a Git repository" : "Checkpoints are unavailable"}
          text={/not inside a Git repository/i.test(state.error ?? "") ? "Checkpoints are kept in the folder's Git repository. Run git init to start one." : state.error ?? ""} alert />
          : !state.list ? <div className="cp-note cp-loading"><Loader2 size={14} className="sw-spin" aria-hidden="true" /> Loading checkpoints…</div>
            : !selected ? <Empty title="No checkpoints yet" text="A checkpoint is saved each time the agent in this tile finishes a turn, and before every restore. Save one now to start." />
              : <div className="cp-layout">
                <Timeline checkpoints={checkpoints} selectedId={selected.id} onSelect={setSelectedId} now={now} />
                <Detail key={selected.id} host={host} path={path} checkpoint={selected} previous={checkpoints[checkpoints.indexOf(selected) + 1]?.id ?? null} revision={revision} busy={busy}
                  undoState={undoState} onRestore={() => void start(selected, "restore")} onUndo={() => void start(selected, "undo")} />
              </div>}
    </div>
    {confirm ? <RestoreConfirm preview={confirm.preview} root={root} agentBusy={confirm.agentBusy} onCancel={() => setConfirm(null)} onConfirm={() => void apply()} /> : null}
  </Modal>;
}

function Empty({ title: heading, text, alert = false }: { title: string; text: string; alert?: boolean }) {
  return <div className="cp-empty" role={alert ? "alert" : undefined}>
    <span className="cp-empty-icon" aria-hidden="true"><History size={20} /></span>
    <strong>{heading}</strong>
    <p>{text}</p>
  </div>;
}
