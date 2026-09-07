import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import { githubDark } from "@uiw/codemirror-theme-github";
import { loadLanguage } from "@uiw/codemirror-extensions-langs";
import { Eye, FolderOpen, FolderTree as FolderTreeIcon, Loader2, PanelLeft, Save, X } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { fileRawUrl, readFile, writeFile } from "../serverApi";
import { useStore } from "../state/store";
import { FolderTree } from "./FileTree";
import { FilePicker } from "../panels/FilePicker";
import { Modal } from "../ui/Modal";
import { fileMutationPending, onFileMutation, registerEditorDiscard, registerEditorFile, remapFilePath } from "../editorChanges";
import { CodeLayoutMenu } from "./CodeLayoutMenu";

// file extension -> the key codemirror-extensions-langs' loadLanguage expects.
// Those keys are extension-style ("ts", "rs", "sh"), not full language names, so
// only genuine aliases need an entry here; everything else falls back to the raw
// extension (see the extensions memo below).
const EXT_LANG: Record<string, string> = {
  mts: "ts",
  cts: "ts",
  mjs: "js",
  cjs: "js",
  htm: "html",
  mdx: "md",
  markdown: "md",
  zsh: "bash",
  fish: "bash",
  yml: "yaml",
  h: "c",
  cc: "cpp",
  cxx: "cpp",
  hpp: "cpp",
  hxx: "cpp",
  svg: "xml",
  conf: "ini",
};

function baseName(p: string): string {
  return p.replace(/\/$/, "").split("/").pop() || p;
}
function dirName(p: string): string {
  const i = p.lastIndexOf("/");
  return i > 0 ? p.slice(0, i) : "";
}
function extOf(p: string): string {
  const b = baseName(p);
  const i = b.lastIndexOf(".");
  return i > 0 ? b.slice(i + 1).toLowerCase() : "";
}

// The inline code editor for a single terminal window: its own folder root, its
// own file tree, and the file open in it. Layout changes resize the mounted
// editor and terminal without discarding the editor's unsaved buffer.
export function TileCodePanel({ tileId }: { tileId: string }) {
  const code = useStore((s) => s.tileCode[tileId]);
  // A remote tile edits files on its own device over ssh.
  const host = useStore((s) => s.tiles.find((t) => t.id === tileId)?.host);
  const setTileCodeRoot = useStore((s) => s.setTileCodeRoot);
  const setTileCodePath = useStore((s) => s.setTileCodePath);
  const closeTileFile = useStore((s) => s.closeTileFile);

  const [treeOpen, setTreeOpen] = useState(true);
  const [pickerOpen, setPickerOpen] = useState(false);

  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);

  const [discardOpen, setDiscardOpen] = useState(false);
  const discardResolve = useRef<((answer: boolean) => void) | null>(null);
  const snapshot = useRef({ dirty, saving, content, loaded, path: code?.path });
  snapshot.current = { dirty, saving, content, loaded, path: code?.path };
  const preservedPath = useRef<string | null>(null);
  const answerDiscard = (answer: boolean) => {
    discardResolve.current?.(answer);
    discardResolve.current = null;
    setDiscardOpen(false);
  };
  const requestDiscard = useCallback((): Promise<boolean> => {
    if (!snapshot.current.dirty && !snapshot.current.saving) return Promise.resolve(true);
    return new Promise((resolve) => {
      discardResolve.current?.(false);
      discardResolve.current = resolve;
      setDiscardOpen(true);
    });
  }, []);
  const navigate = async (action: () => void) => { if (await requestDiscard()) action(); };
  useEffect(() => registerEditorDiscard(tileId, requestDiscard), [tileId, requestDiscard]);
  useEffect(() => registerEditorFile(tileId, () => ({ host, path: snapshot.current.path, saving: snapshot.current.saving, dirty: snapshot.current.dirty })), [tileId, host]);
  useEffect(() => () => { discardResolve.current?.(false); }, []);
  useEffect(() => {
    const protect = (event: BeforeUnloadEvent) => {
      if (snapshot.current.dirty || snapshot.current.saving) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", protect);
    return () => window.removeEventListener("beforeunload", protect);
  }, []);
  useEffect(() => onFileMutation((mutation) => {
    if ((mutation.host || "") !== (host || "")) return;
    const current = useStore.getState().tileCode[tileId];
    const nextRoot = remapFilePath(current?.root, mutation.path, mutation.destination);
    const nextPath = remapFilePath(current?.path, mutation.path, mutation.destination);
    if (nextRoot !== current?.root) setTileCodeRoot(tileId, nextRoot ?? "");
    if (nextPath !== current?.path) {
      if (nextPath) {
        preservedPath.current = snapshot.current.loaded ? nextPath : null;
        setTileCodePath(tileId, nextPath);
      } else {
        closeTileFile(tileId);
      }
    } else if (nextRoot !== current?.root && nextPath) {
      preservedPath.current = snapshot.current.loaded ? nextPath : null;
      setTileCodePath(tileId, nextPath);
    }
  }), [tileId, host, setTileCodeRoot, setTileCodePath, closeTileFile]);

  const root = code?.root;
  const path = code?.path;
  const isMd = !!path && /\.(md|markdown)$/i.test(path);
  const isImage = !!path && /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path);
  const isPdf = !!path && /\.pdf$/i.test(path);
  const isBinary = isImage || isPdf;

  useEffect(() => {
    if (path && preservedPath.current === path) {
      preservedPath.current = null;
      return;
    }
    preservedPath.current = null;
    if (!path || isBinary) {
      // Binary files are previewed straight from their raw URL - no text load.
      setLoaded(true);
      setContent("");
      setError(null);
      setDirty(false);
      return;
    }
    let alive = true;
    setLoaded(false);
    setError(null);
    setDirty(false);
    setPreview(false);
    readFile(path, host)
      .then((r) => {
        if (!alive) return;
        if (r.tooLarge) setError("File is too large to open here.");
        else setContent(r.content);
      })
      .catch((e) => alive && setError(String(e?.message || e)))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [path, host]);

  const save = useCallback(async () => {
    if (!path || !dirty || saving) return;
    if (fileMutationPending(host, path)) { setError("Wait for the file operation to finish before saving."); return; }
    snapshot.current.saving = true;
    setSaving(true);
    try {
      await writeFile(path, content, host);
      if (snapshot.current.path === path && snapshot.current.content === content) setDirty(false);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, content, path, host]);

  const extensions = useMemo(() => {
    const ext = path ? extOf(path) : "";
    // loadLanguage keys are extension-style, so try the raw extension and only
    // remap the handful of aliases that differ.
    const key = ext ? EXT_LANG[ext] ?? ext : "";
    const lang = key ? loadLanguage(key as Parameters<typeof loadLanguage>[0]) : null;
    return lang ? [lang] : [];
  }, [path]);

  const html = useMemo(
    () => (preview && isMd ? DOMPurify.sanitize(marked.parse(content) as string) : ""),
    [preview, isMd, content],
  );

  if (!root) {
    return (
      <div className="tile-code">
        <div className="tile-code-bar">
          <span className="tile-code-name">Code editor</span>
          <div className="tile-head-spacer" />
          <CodeLayoutMenu tileId={tileId} />
        </div>
        <div className="code-open">
          <FolderOpen size={28} className="code-open-icon" />
          <p className="code-open-title">Open a folder to edit here</p>
          <button
            className="btn btn-accent"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setPickerOpen(true)}
          >
            <FolderOpen size={14} />
            Open folder
          </button>
        </div>
        <FilePicker
          open={pickerOpen}
          mode="folder"
          onClose={() => setPickerOpen(false)}
          onPick={(p) => void navigate(() => setTileCodeRoot(tileId, p))}
          host={host}
        />
      </div>
    );
  }

  return (
    <div className="tile-code">
      <div className="tile-code-bar">
        <button
          className={`tile-btn ${treeOpen ? "tile-btn-on" : ""}`}
          title={treeOpen ? "Hide tree" : "Show tree"}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setTreeOpen((v) => !v)}
        >
          <PanelLeft size={13} />
        </button>
        <span className="tile-code-name">
          {path ? baseName(path) : baseName(root)}
          {dirty ? <span className="code-dirty" title="Unsaved changes" /> : null}
        </span>
        <span className="tile-code-path" title={path || root}>
          {path ? dirName(path) : root}
        </span>
        <div className="tile-head-spacer" />
        <button
          className="tile-btn"
          title="Change folder"
          onMouseDown={(e) => e.stopPropagation()}
          onClick={() => setPickerOpen(true)}
        >
          <FolderTreeIcon size={13} />
        </button>
        {isMd ? (
          <button
            className={`tile-btn ${preview ? "tile-btn-on" : ""}`}
            title={preview ? "Edit" : "Preview"}
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => setPreview((v) => !v)}
          >
            <Eye size={13} />
          </button>
        ) : null}
        <button
          className="tile-btn"
          title="Save"
          disabled={!path || !dirty || saving}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={save}
        >
          {saving ? <Loader2 size={13} className="sw-spin" /> : <Save size={13} />}
        </button>
        {path ? (
          <button
            className="tile-btn"
            title="Close file"
            onMouseDown={(e) => e.stopPropagation()}
            onClick={() => void navigate(() => closeTileFile(tileId))}
          >
            <X size={14} />
          </button>
        ) : null}
        <CodeLayoutMenu tileId={tileId} />
      </div>

      {error && dirty ? <div className="code-status code-err" role="alert">{error}</div> : null}
      <div className="code-split">
        {treeOpen ? (
          <div className="code-tile-tree">
            <FolderTree
              root={root}
              host={host}
              activePath={path}
              onOpenFile={(p) => { if (p !== path) void navigate(() => setTileCodePath(tileId, p)); }}
            />
          </div>
        ) : null}
        <div
          className="code-editor-pane"
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "s") {
              e.preventDefault();
              save();
            }
          }}
        >
          {!path ? (
            <div className="code-status muted">Pick a file from the tree to edit it.</div>
          ) : isImage ? (
            <div className="code-preview code-preview-img">
              <img src={fileRawUrl(path, host)} alt={baseName(path)} />
            </div>
          ) : isPdf ? (
            <iframe className="code-preview-pdf" src={fileRawUrl(path, host)} title={baseName(path)} />
          ) : !loaded ? (
            <div className="code-status">
              <Loader2 size={16} className="sw-spin" /> Loading…
            </div>
          ) : error && !dirty ? (
            <div className="code-status code-err">{error}</div>
          ) : preview && isMd ? (
            <div className="md-preview" dangerouslySetInnerHTML={{ __html: html }} />
          ) : (
            <CodeMirror
              value={content}
              theme={githubDark}
              extensions={extensions}
              height="100%"
              style={{ height: "100%" }}
              onChange={(v) => {
                setContent(v);
                setDirty(true);
              }}
            />
          )}
        </div>
      </div>

      <FilePicker
        open={pickerOpen}
        mode="folder"
        onClose={() => setPickerOpen(false)}
        onPick={(p) => void navigate(() => setTileCodeRoot(tileId, p))}
        host={host}
      />
      <Modal open={discardOpen} onClose={() => answerDiscard(false)} title="Discard unsaved changes?" size="sm">
        <p>Your edits to {baseName(path || root)} have not been saved.</p>
        {saving ? <p>Wait for the current save to finish before continuing.</p> : null}
        <div className="modal-actions">
          <button className="btn" autoFocus onClick={() => answerDiscard(false)}>Keep editing</button>
          <button className="btn btn-danger" disabled={saving} onClick={() => answerDiscard(true)}>Discard and continue</button>
        </div>
      </Modal>
    </div>
  );
}
