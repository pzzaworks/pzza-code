import { useEffect, useId, useMemo, useState } from "react";
import { FileSearch, FileText, Loader2 } from "lucide-react";
import { fetchCodeFiles, type CodeFileList } from "../serverApi";
import { onFileMutation } from "../editorChanges";
import { rankFiles } from "./fileRank";
import { recentFiles } from "./recentFiles";
import { MarkedText, PickerFrame } from "./PickerFrame";
import { CODE_PICKERS } from "./pickerBus";

// File lists by device and folder, reused while fresh so reopening Quick Open
// is instant; refreshed in the background after FRESH_MS, and dropped when the
// app moves or deletes files on that device.
const FRESH_MS = 30_000;
const lists = new Map<string, { at: number; list: CodeFileList }>();
const listKey = (host: string | undefined, root: string) => `${host ?? ""}\n${root}`;
onFileMutation((mutation) => {
  for (const key of lists.keys()) if (key.startsWith(`${mutation.host ?? ""}\n`)) lists.delete(key);
});

export const joinRoot = (root: string, rel: string) => `${root.replace(/\/+$/, "")}/${rel}`;

export function QuickOpen({ tileId, host, root, path, onOpen, onClose }: {
  tileId: string;
  host?: string;
  root: string;
  path?: string;
  onOpen(path: string): void;
  onClose(restoreFocus: boolean): void;
}) {
  const listId = useId();
  const cached = lists.get(listKey(host, root));
  const [list, setList] = useState<CodeFileList | null>(cached?.list ?? null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);

  useEffect(() => {
    const key = listKey(host, root);
    const entry = lists.get(key);
    if (entry && Date.now() - entry.at < FRESH_MS) return;
    const controller = new AbortController();
    fetchCodeFiles(root, host, controller.signal)
      .then((next) => { lists.set(key, { at: Date.now(), list: next }); setList(next); setError(null); })
      .catch((cause: unknown) => { if (!controller.signal.aborted) setError(cause instanceof Error ? cause.message : "The file list is unavailable"); });
    return () => controller.abort();
  }, [host, root]);

  // Recently opened files of this editor, relative to the listed folder; the
  // file already open is not a place to go.
  const recent = useMemo(() => {
    if (!list) return [];
    const prefix = `${list.root.replace(/\/+$/, "")}/`;
    return recentFiles(tileId).filter((entry) => entry !== path && entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length));
  }, [list, tileId, path]);
  const rows = useMemo(() => (list ? rankFiles(list.files, query, recent) : []), [list, query, recent]);
  const recentSet = useMemo(() => new Set(recent), [recent]);
  const current = Math.min(cursor, Math.max(0, rows.length - 1));
  const optionId = (index: number) => `${listId}-${index}`;

  const status = error ? <span className="code-picker-error">{error}</span>
    : !list ? <><Loader2 size={12} className="sw-spin" aria-hidden="true" /> Listing files…</>
    : list.truncated ? `Showing the first ${list.files.length.toLocaleString()} files of this folder.`
    : null;

  return (
    <PickerFrame
      label={CODE_PICKERS.files.label}
      icon={FileSearch}
      placeholder="Go to file by name"
      query={query}
      onQuery={(value) => { setQuery(value); setCursor(0); }}
      count={rows.length}
      cursor={current}
      onCursor={setCursor}
      onPick={(index) => { const row = rows[index]; if (row && list) onOpen(joinRoot(list.root, row.path)); }}
      onClose={onClose}
      listId={listId}
      activeId={rows.length ? optionId(current) : undefined}
      status={status}
      className="code-picker-files"
    >
      {rows.map((row, index) => (
        <div
          key={row.path}
          id={optionId(index)}
          role="option"
          aria-selected={index === current}
          className={`cmdk-row code-picker-row ${index === current ? "cmdk-row-active" : ""}`}
          title={row.path}
          onMouseMove={() => { if (index !== current) setCursor(index); }}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => list && onOpen(joinRoot(list.root, row.path))}
        >
          <FileText size={14} className="cmdk-row-icon" aria-hidden="true" />
          <span className="cmdk-row-label"><MarkedText text={row.name} positions={row.namePositions} /></span>
          <span className="cmdk-row-detail code-picker-dir"><MarkedText text={row.dir} positions={row.dirPositions} /></span>
          {!query && recentSet.has(row.path) ? <span className="code-picker-tag">recent</span> : null}
        </div>
      ))}
      {list && !rows.length ? (
        <div className="cmdk-empty" role="status">{list.files.length ? `No file matches “${query.trim()}”.` : "This folder has no files."}</div>
      ) : null}
    </PickerFrame>
  );
}
