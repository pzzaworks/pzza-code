import { AsyncButton } from "../ui/AsyncButton";
import { themeById } from "../theme/themes";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodeMirror from "@uiw/react-codemirror";
import type { EditorView } from "@codemirror/view";
import { githubDark, githubLight } from "@uiw/codemirror-theme-github";
import { loadLanguage } from "@uiw/codemirror-extensions-langs";
import { Eye, FolderOpen, FolderTree as FolderTreeIcon, Loader2, PanelLeft, Save, X } from "lucide-react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import { deleteFile, fileRawUrl, listDir, moveFile, readFile, writeFile } from "../serverApi";
import { useStore } from "../state/store";
import { FolderTree } from "./FileTree";
import { FilePicker } from "../panels/FilePicker";
import { Modal } from "../ui/Modal";
import { beginFileMutation, fileMutationPending, notifyFileMutation, onFileMutation, registerEditorDiscard, registerEditorFile, remapFilePath } from "../editorChanges";
import { copyImageToClipboard } from "../imageClipboard";
import { CodeLayoutMenu } from "./CodeLayoutMenu";
import { createEditorAppController, registerEditorAppControl } from "../appControlEditor";

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

// ---- Cmd/Ctrl/Alt+click go-to-definition ----

// Exported for unit tests.
export function wordAtLine(text: string, offset: number): string | null {
  let start = offset;
  let end = offset;
  while (start > 0 && /[\w$]/.test(text[start - 1] ?? "")) start--;
  while (end < text.length && /[\w$]/.test(text[end] ?? "")) end++;
  return end > start ? text.slice(start, end) : null;
}

// Module specifier quoted on an import/export line, with the quoted range so a
// click on the path itself opens the file instead of searching for a symbol.
// Exported for unit tests.
export function lineModuleSpec(text: string): { spec: string; from: number; to: number } | null {
  const match = /(?:import|export)[^'"]*?['"]([^'"]+)['"]/.exec(text);
  const spec = match?.[1];
  if (!match || spec === undefined) return null;
  const start = match.index + match[0].indexOf(spec);
  return { spec, from: start, to: start + spec.length };
}

// Local names an import clause binds: default, namespace and named bindings.
// Exported for unit tests.
export function importClauseNames(text: string): string[] {
  const from = text.indexOf(" from ");
  const clause = (from >= 0 ? text.slice(0, from) : text).replace(/^\s*import\s*/, "");
  const names: string[] = [];
  const namespace = /\*\s*as\s+([\w$]+)/.exec(clause)?.[1];
  if (namespace) names.push(namespace);
  const braced = /\{([^}]*)\}/.exec(clause)?.[1];
  if (braced) {
    for (const part of braced.split(",")) {
      const local = part.trim().split(/\s+as\s+/).pop()?.trim();
      if (local && /^[\w$]+$/.test(local)) names.push(local);
    }
  }
  const head = clause.split("{")[0]?.replace(/\*\s*as\s+[\w$]+/, "").trim().replace(/^type(?:\s+|$)/, "") ?? "";
  for (const part of head.split(",")) {
    const id = part.trim();
    if (id && /^[\w$]+$/.test(id)) names.push(id);
  }
  return [...new Set(names)];
}

const DECL_PATTERNS = [
  /(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s+([\w$]+)/,
  /(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+([\w$]+)/,
  /(?:export\s+)?(?:const|let|var)\s+([\w$]+)\s*[:=]/,
  /(?:export\s+)?(?:interface|type|enum)\s+([\w$]+)\b/,
];

function isModuleEdge(line: string): boolean {
  return /^\s*import(?:\s|\(|["'])/.test(line) || /export\s+[^;]*\sfrom\s*["']/.test(line);
}

// Exported for unit tests.
export function findLocalDecl(lines: string[], name: string, skipLine?: number): number | null {
  let fallback: number | null = null;
  const consider = (lineNo: number): number | "skip" | null => {
    if (lineNo === skipLine) {
      fallback ??= lineNo;
      return "skip";
    }
    return lineNo;
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (isModuleEdge(line)) continue;
    // `export default Name;` re-exports a local binding - the declaration
    // itself is found below, not on this line.
    if (/export\s+default\s+/.test(line) && !/export\s+default\s+(?:async\s+)?(?:function|class|abstract)/.test(line)) continue;
    // Destructured bindings: `const [open, setOpen] = useState(...)`.
    const binding = /(?:export\s+)?(?:const|let|var)\s*([[{][^=]*?[\]}])\s*=/.exec(line)?.[1];
    if (binding && new RegExp(`(^|[^\\w$])${name}([^\\w$]|$)`).test(binding)) {
      const hit = consider(i + 1);
      if (hit !== "skip") return hit;
      continue;
    }
    for (const pattern of DECL_PATTERNS) {
      if (pattern.exec(line)?.[1] === name) {
        const hit = consider(i + 1);
        if (hit !== "skip") return hit;
        break;
      }
    }
  }
  return fallback;
}

// 1-based line of `name`'s definition, following `export { Local as Name }`
// aliases to the local declaration. Prefers another line over `skipLine`.
// Exported for unit tests.
export function findDefinitionLine(lines: string[], name: string, skipLine?: number): number | null {
  for (let i = 0; i < lines.length; i++) {
    const body = /export\s*\{([^}]*)\}/.exec(lines[i] ?? "")?.[1];
    if (!body) continue;
    for (const part of body.split(",")) {
      const [rawLocal, rawAlias] = part.split(/\s+as\s+/).map((s) => s.trim());
      const exported = rawAlias || rawLocal;
      if (exported === name && rawLocal && /^[\w$]+$/.test(rawLocal)) {
        if (rawLocal !== name) {
          const localLine = findLocalDecl(lines, rawLocal, skipLine);
          if (localLine !== null) return localLine;
        }
        return i + 1;
      }
    }
  }
  return findLocalDecl(lines, name, skipLine);
}

// Exported for unit tests.
export function normalizeAbsolute(p: string): string {
  const out: string[] = [];
  for (const part of p.split("/")) {
    if (part === "" || part === ".") {
      if (out.length === 0) out.push("");
      continue;
    }
    if (part === "..") {
      if (out.length > 1) out.pop();
      continue;
    }
    out.push(part);
  }
  return out.join("/") || "/";
}

// Exported for unit tests.
export function resolveRelativeImport(fromFile: string, spec: string): string | null {
  if (!spec.startsWith(".")) return null;
  return normalizeAbsolute(`${fromFile.slice(0, fromFile.lastIndexOf("/"))}/${spec}`);
}

const PROBE_EXTS = ["", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs", ".css", ".json"];
const PROBE_INDEX = ["/index.ts", "/index.tsx", "/index.js", "/index.jsx"];

// Candidate files for a resolved import base: the path itself, common source
// extensions, then directory indexes. A base that already names a file is
// only tried as-is.
// Exported for unit tests.
export function probeCandidates(base: string): string[] {
  if (/\/[^/]+\.\w+$/.test(base)) return [base];
  const out = PROBE_EXTS.map((ext) => base + ext);
  for (const index of PROBE_INDEX) out.push(base + index);
  return [...new Set(out)];
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
  const [treeControl, setTreeControl] = useState<{ revision: number; path?: string; expanded?: boolean }>({ revision: 0 });
  const [pickerOpen, setPickerOpen] = useState(false);

  const [content, setContent] = useState("");
  const [loaded, setLoaded] = useState(false);
  const themeId = useStore(state => state.themeId);
  const imageRef = useRef<HTMLImageElement>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [copyingImage, setCopyingImage] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [preview, setPreview] = useState(false);

  const [discardOpen, setDiscardOpen] = useState(false);
  const discardResolve = useRef<((answer: boolean) => void) | null>(null);
  const [jump, setJump] = useState<{ token: number; path: string; line: number } | null>(null);
  const [jumpStatus, setJumpStatus] = useState<string | null>(null);
  const jumpTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(jumpTimer.current), []);
  const flashJump = useCallback((message: string) => {
    setJumpStatus(message);
    clearTimeout(jumpTimer.current);
    jumpTimer.current = setTimeout(() => setJumpStatus(null), 3000);
  }, []);
  const loadedKey = useRef("");
  const bufferKey = JSON.stringify([host, code?.path]);
  const revision = useRef({ key: bufferKey, value: crypto.randomUUID() });
  if (revision.current.key !== bufferKey) revision.current = { key: bufferKey, value: crypto.randomUUID() };
  const snapshot = useRef({ dirty, saving, content, loaded, error, path: code?.path });
  snapshot.current = { dirty, saving, content, loaded: loaded && loadedKey.current === bufferKey, error, path: code?.path };
  const viewSnapshot = useRef({ tree: treeOpen, preview, folderPicker: pickerOpen });
  viewSnapshot.current = { tree: treeOpen, preview, folderPicker: pickerOpen };
  const copying = useRef(false);
  const changeContent = useCallback((value: string, changed: boolean) => {
    snapshot.current.content = value;
    snapshot.current.dirty = changed;
    revision.current.value = crypto.randomUUID();
    setContent(value);
    setDirty(changed);
  }, []);
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
  const viewRef = useRef<EditorView | null>(null);
  useEffect(() => registerEditorDiscard(tileId, requestDiscard), [tileId, requestDiscard]);
  useEffect(() => registerEditorFile(tileId, () => ({ host, path: snapshot.current.path, saving: snapshot.current.saving, dirty: snapshot.current.dirty, revision: revision.current.value })), [tileId, host]);
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
  const locRef = useRef({ host, path });
  locRef.current = { host, path };
  const isMd = !!path && /\.(md|markdown)$/i.test(path);
  const isImage = !!path && /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i.test(path);
  const isPdf = !!path && /\.pdf$/i.test(path);
  const isBinary = isImage || isPdf;

  useEffect(() => {
    if (path && preservedPath.current === path) {
      preservedPath.current = null;
      loadedKey.current = bufferKey;
      snapshot.current.loaded = true;
      return;
    }
    preservedPath.current = null;
    if (!path || isBinary) {
      // Binary files are previewed straight from their raw URL - no text load.
      setLoaded(true);
      loadedKey.current = bufferKey;
      changeContent("", false);
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
        else { loadedKey.current = bufferKey; changeContent(r.content, false); }
      })
      .catch((e) => alive && setError(String(e?.message || e)))
      .finally(() => alive && setLoaded(true));
    return () => {
      alive = false;
    };
  }, [path, host]);

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

  const copyImage = useCallback(async () => {
    const image = imageRef.current;
    if (!image || !image.complete || image.naturalWidth === 0) throw new Error("Wait for an image preview to finish loading.");
    if (copying.current) throw new Error("Image copy is already running.");
    copying.current = true;
    setCopyingImage(true); setCopyStatus(null);
    try {
      await copyImageToClipboard(image);
      setCopyStatus("Image copied to this device's clipboard.");
    } catch (cause) {
      setCopyStatus(cause instanceof Error ? cause.message : "Image copy failed.");
      throw cause;
    } finally { copying.current = false; setCopyingImage(false); }
  }, []);
  const controller = useMemo(() => {
    const scopedPath = async (requested?: string) => {
      const root = useStore.getState().tileCode[tileId]?.root;
      if (!root) throw new Error("Open an editor folder first.");
      const resolved = (await listDir(root, host)).path;
      let path = requested ?? resolved;
      if (root.startsWith("~") && (path === root || path.startsWith(root + "/"))) path = resolved + path.slice(root.length);
      if (path.split("/").includes("..") || (path !== resolved && !path.startsWith(resolved + "/"))) throw new Error("File operations must stay inside the editor folder.");
      return { root: resolved, path };
    };
    return createEditorAppController({
      read: () => {
        const current = snapshot.current;
        const path = current.path;
        return { ...current, revision: revision.current.value, root: useStore.getState().tileCode[tileId]?.root, host,
          binary: !!path && /\.(png|jpe?g|gif|webp|avif|bmp|ico|svg|pdf)$/i.test(path),
          markdown: !!path && /\.(md|markdown)$/i.test(path), failed: !!current.error && !current.dirty, ...viewSnapshot.current };
      },
      change: changeContent,
      busy: value => { snapshot.current.saving = value; setSaving(value); },
      save: async (path, content) => {
        if (fileMutationPending(host, path)) throw new Error("Wait for the file operation to finish before saving.");
        try {
          await writeFile(path, content, host);
          snapshot.current.error = null; setError(null);
        } catch (cause) {
          const message = cause instanceof Error ? cause.message : "File save failed.";
          snapshot.current.error = message; setError(message);
          throw cause;
        }
      },
      reload: async path => {
        const result = await readFile(path, host);
        if (result.tooLarge) throw new Error("File is too large to open here.");
        snapshot.current.error = null; setError(null);
        return result.content;
      },
      close: () => closeTileFile(tileId),
      view: settings => {
        if (settings.tree !== undefined) { viewSnapshot.current.tree = settings.tree; setTreeOpen(settings.tree); }
        if (settings.preview !== undefined) { viewSnapshot.current.preview = settings.preview; setPreview(settings.preview); }
        if (settings.folderPicker !== undefined) { viewSnapshot.current.folderPicker = settings.folderPicker; setPickerOpen(settings.folderPicker); }
      },
      copyImage,
      list: async path => listDir((await scopedPath(path)).path, host),
      move: async (path, destination) => {
        const source = await scopedPath(path);
        const target = await scopedPath(destination);
        const release = beginFileMutation({ host, path: source.path });
        try {
          const result = await moveFile(source.root, source.path, target.path, host);
          notifyFileMutation({ host, path: source.path, destination: result.path });
          return result;
        } finally { release(); }
      },
      remove: async path => {
        const source = await scopedPath(path);
        const release = beginFileMutation({ host, path: source.path }, { allowDirty: false });
        try {
          const result = await deleteFile(source.root, source.path, host);
          notifyFileMutation({ host, path: source.path });
          return result;
        } finally { release(); }
      },
      treeAction: async (path, expanded) => {
        const selected = await scopedPath(path);
        if (path) await listDir(selected.path, host);
        viewSnapshot.current.tree = true; setTreeOpen(true);
        setTreeControl(current => ({ revision: current.revision + 1, path: path ? selected.path : undefined, expanded }));
      },
    });
  }, [tileId, host, changeContent, closeTileFile, copyImage]);
  useEffect(() => registerEditorAppControl(tileId, controller), [tileId, controller]);
  const save = useCallback(async () => {
    try { await controller.execute("editor_save", { expectedRevision: revision.current.value }); }
    catch (cause) { setError(cause instanceof Error ? cause.message : "File save failed."); }
  }, [controller]);

  // Cmd/Ctrl/Alt+click a symbol to jump to its definition: across files
  // through relative imports, or within this file. Cross-file moves keep the
  // unsaved-changes guard; same-file jumps only move the cursor.
  const goRef = useRef<(x: number, y: number) => void>(() => {});
  goRef.current = async (x, y) => {
    const view = viewRef.current;
    if (!view) return;
    let pos: number | null = null;
    try {
      pos = view.posAtCoords({ x, y });
    } catch {
      pos = null;
    }
    if (pos === null || pos === undefined) return;
    const line = view.state.doc.lineAt(pos);
    const offset = pos - line.from;
    const { path: currentPath, host: currentHost } = locRef.current;
    if (!currentPath) return;
    const module = lineModuleSpec(line.text);
    const inSpec = module !== null && offset >= module.from && offset <= module.to;
    const word = wordAtLine(line.text, offset);
    const openTarget = async (spec: string, symbol?: string) => {
      if (!spec.startsWith(".")) {
        flashJump(symbol ? `'${symbol}' comes from the '${spec}' package` : "External packages open outside the editor");
        return;
      }
      const base = resolveRelativeImport(currentPath, spec);
      if (!base) return;
      for (const candidate of probeCandidates(base)) {
        try {
          const result = await readFile(candidate, currentHost);
          if (result.tooLarge) {
            flashJump("File is too large to open here.");
            return;
          }
          const at = symbol ? findDefinitionLine(result.content.split("\n"), symbol) ?? 1 : 1;
          await navigate(() => {
            setTileCodePath(tileId, candidate);
            setJump({ token: Math.random(), path: candidate, line: at });
          });
          return;
        } catch {
          /* try the next candidate */
        }
      }
      flashJump(`Cannot resolve '${spec}'`);
    };
    // Clicked the module path itself: open the file at the top.
    if (module && inSpec) {
      await openTarget(module.spec);
      return;
    }
    if (!word) return;
    if (module && importClauseNames(line.text).includes(word)) {
      // Imported symbol: jump to its definition in the target file.
      await openTarget(module.spec, word);
      return;
    }
    const at = findDefinitionLine(snapshot.current.content.split("\n"), word, line.number);
    if (at === null) {
      flashJump(`No definition found for '${word}'`);
      return;
    }
    setJump({ token: Math.random(), path: currentPath, line: at });
  };
  const onEditorClick = useCallback((event: MouseEvent) => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) return;
    void goRef.current(event.clientX, event.clientY);
  }, []);
  const handleCreateEditor = useCallback((view: EditorView) => {
    if (viewRef.current && viewRef.current !== view) viewRef.current.dom.removeEventListener("click", onEditorClick);
    viewRef.current = view;
    view.dom.addEventListener("click", onEditorClick);
  }, [onEditorClick]);
  useEffect(() => () => {
    viewRef.current?.dom.removeEventListener("click", onEditorClick);
  }, [onEditorClick]);

  useEffect(() => {
    if (!jump || !loaded || jump.path !== path) return;
    const view = viewRef.current;
    if (!view || view.state.doc.lines === 0) return;
    const at = view.state.doc.line(Math.max(1, Math.min(jump.line, view.state.doc.lines)));
    view.dispatch({ selection: { anchor: at.from }, scrollIntoView: true });
    view.focus();
    setJump(null);
  }, [jump, loaded, path, content]);

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
        <AsyncButton
          className="tile-btn"
          title="Save"
          aria-label="Save"
          loading={saving}
          icon={Save}
          iconSize={13}
          disabled={!path || !dirty}
          onMouseDown={(e) => e.stopPropagation()}
          onClick={save}
        />
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
      {jumpStatus ? <div className="code-status muted" role="status">{jumpStatus}</div> : null}
      <div className="code-split">
        {treeOpen ? (
          <div className="code-tile-tree">
            <FolderTree
              root={root}
              control={treeControl}
              host={host}
              activePath={path}
              onOpenFile={(p) => { if (p !== path) void navigate(() => setTileCodePath(tileId, p)); }}
            />
          </div>
        ) : null}
        <div
          className="code-editor-pane"
          title="Cmd/Ctrl/Alt+Click a symbol to jump to its definition"
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
              <img ref={imageRef} crossOrigin="anonymous" src={fileRawUrl(path, host)} alt={baseName(path)} />
              <div className="image-copy-actions">
                <button className="btn btn-sm" type="button" disabled={copyingImage} onClick={() => { void copyImage().catch(() => {}); }}>{copyingImage ? "Copying image…" : "Copy image"}</button>
                {copyStatus ? <span role="status">{copyStatus}</span> : null}
              </div>
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
              theme={themeById(themeId).appearance === "light" ? githubLight : githubDark}
              extensions={extensions}
              height="100%"
              style={{ height: "100%" }}
              onCreateEditor={handleCreateEditor}
              onChange={(v) => {
                changeContent(v, true);
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
