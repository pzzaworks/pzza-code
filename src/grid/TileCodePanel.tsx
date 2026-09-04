import { useCallback, useEffect, useMemo, useState } from "react";
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

// file extension -> a language name known to codemirror-extensions-langs
const EXT_LANG: Record<string, string> = {
  ts: "typescript",
  tsx: "tsx",
  js: "javascript",
  jsx: "jsx",
  mjs: "javascript",
  cjs: "javascript",
  json: "json",
  css: "css",
  scss: "sass",
  sass: "sass",
  less: "less",
  html: "html",
  htm: "html",
  vue: "vue",
  md: "markdown",
  markdown: "markdown",
  py: "python",
  rs: "rust",
  go: "go",
  sh: "shell",
  bash: "shell",
  zsh: "shell",
  yml: "yaml",
  yaml: "yaml",
  toml: "toml",
  sql: "sql",
  java: "java",
  kt: "kotlin",
  c: "c",
  h: "c",
  cpp: "cpp",
  cc: "cpp",
  hpp: "cpp",
  rb: "ruby",
  php: "php",
  swift: "swift",
  xml: "xml",
  svg: "xml",
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
// own file tree, and the file open in it. Rendered over the tile body while the
// terminal stays mounted underneath.
export function TileCodePanel({ tileId }: { tileId: string }) {
  const code = useStore((s) => s.tileCode[tileId]);
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

  const root = code?.root;
  const path = code?.path;
  const isMd = !!path && /\.(md|markdown)$/i.test(path);
  const isImage = !!path && /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path);
  const isPdf = !!path && /\.pdf$/i.test(path);
  const isBinary = isImage || isPdf;

  useEffect(() => {
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
    readFile(path)
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
  }, [path]);

  const save = useCallback(async () => {
    if (!path || !dirty || saving) return;
    setSaving(true);
    try {
      await writeFile(path, content);
      setDirty(false);
    } catch (e) {
      setError(String((e as Error)?.message || e));
    } finally {
      setSaving(false);
    }
  }, [dirty, saving, content, path]);

  const extensions = useMemo(() => {
    const key = path ? EXT_LANG[extOf(path)] : undefined;
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
          onPick={(p) => setTileCodeRoot(tileId, p)}
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
            onClick={() => closeTileFile(tileId)}
          >
            <X size={14} />
          </button>
        ) : null}
      </div>

      <div className="code-split">
        {treeOpen ? (
          <div className="code-tile-tree">
            <FolderTree
              root={root}
              activePath={path}
              onOpenFile={(p) => setTileCodePath(tileId, p)}
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
              <img src={fileRawUrl(path)} alt={baseName(path)} />
            </div>
          ) : isPdf ? (
            <iframe className="code-preview-pdf" src={fileRawUrl(path)} title={baseName(path)} />
          ) : !loaded ? (
            <div className="code-status">
              <Loader2 size={16} className="sw-spin" /> Loading…
            </div>
          ) : error ? (
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
        onPick={(p) => setTileCodeRoot(tileId, p)}
      />
    </div>
  );
}
