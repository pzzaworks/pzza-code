import { AsyncButton } from "../ui/AsyncButton";
import { createContext, useContext, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Modal } from "../ui/Modal";
import { beginFileMutation, notifyFileMutation, onFileMutation } from "../editorChanges";
import {
  ChevronRight,
  File,
  FileArchive,
  FileAudio,
  FileBadge,
  FileCog,
  FileImage,
  FileKey,
  FileSpreadsheet,
  FileText,
  FileVideo,
  Folder,
  FolderOpen,
  Loader2,
  type LucideIcon,
} from "lucide-react";
import type { SimpleIcon } from "simple-icons";
import {
  siC,
  siClojure,
  siCplusplus,
  siCss,
  siDart,
  siDocker,
  siElixir,
  siGit,
  siGnubash,
  siGo,
  siGraphql,
  siHaskell,
  siHtml5,
  siJavascript,
  siJson,
  siJulia,
  siKotlin,
  siLess,
  siLua,
  siMarkdown,
  siMysql,
  siNodedotjs,
  siPerl,
  siPhp,
  siPrisma,
  siPython,
  siR,
  siReact,
  siRuby,
  siRust,
  siSass,
  siScala,
  siSvelte,
  siSwift,
  siToml,
  siTypescript,
  siVuedotjs,
  siXml,
  siYaml,
} from "simple-icons";
import { deleteFile, moveFile, listDir, type DirEntry } from "../serverApi";

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

// A brand (language) logo from simple-icons, or a lucide fallback for files that
// are not tied to a language. `color` overrides the brand hex when the official
// one is too dark to read on the dark tree background.
type IconSpec =
  | { brand: SimpleIcon; color: string }
  | { icon: LucideIcon; color: string };

function brand(icon: SimpleIcon, color?: string): IconSpec {
  return { brand: icon, color: color ?? `#${icon.hex}` };
}

// Language logos keyed by file extension. Colors default to the official brand
// hex; a second argument overrides near-black brands so they stay visible.
const EXT_ICONS: Record<string, IconSpec> = {
  ts: brand(siTypescript),
  tsx: brand(siReact, "#61dafb"),
  mts: brand(siTypescript),
  cts: brand(siTypescript),
  js: brand(siJavascript),
  jsx: brand(siReact, "#61dafb"),
  mjs: brand(siJavascript),
  cjs: brand(siJavascript),
  json: brand(siJson, "#cbcb41"),
  jsonc: brand(siJson, "#cbcb41"),
  md: brand(siMarkdown, "#8ba7c4"),
  markdown: brand(siMarkdown, "#8ba7c4"),
  mdx: brand(siMarkdown, "#8ba7c4"),
  css: brand(siCss, "#8f5fd6"),
  scss: brand(siSass),
  sass: brand(siSass),
  less: brand(siLess, "#4c7bd0"),
  html: brand(siHtml5),
  htm: brand(siHtml5),
  vue: brand(siVuedotjs),
  svelte: brand(siSvelte),
  py: brand(siPython, "#4b93c9"),
  rs: brand(siRust, "#e0916b"),
  go: brand(siGo),
  rb: brand(siRuby),
  php: brand(siPhp, "#8892d6"),
  kt: brand(siKotlin),
  kts: brand(siKotlin),
  c: brand(siC),
  h: brand(siC),
  cpp: brand(siCplusplus, "#5c9dd6"),
  cc: brand(siCplusplus, "#5c9dd6"),
  cxx: brand(siCplusplus, "#5c9dd6"),
  hpp: brand(siCplusplus, "#5c9dd6"),
  hxx: brand(siCplusplus, "#5c9dd6"),
  swift: brand(siSwift),
  sh: brand(siGnubash),
  bash: brand(siGnubash),
  zsh: brand(siGnubash),
  fish: brand(siGnubash),
  yml: brand(siYaml, "#e0555b"),
  yaml: brand(siYaml, "#e0555b"),
  toml: brand(siToml, "#c07a56"),
  xml: brand(siXml, "#4b8fd6"),
  lua: brand(siLua, "#7a7aff"),
  pl: brand(siPerl, "#2ea1cf"),
  pm: brand(siPerl, "#2ea1cf"),
  dart: brand(siDart),
  ex: brand(siElixir, "#b492d0"),
  exs: brand(siElixir, "#b492d0"),
  hs: brand(siHaskell, "#a58bc9"),
  scala: brand(siScala),
  r: brand(siR),
  jl: brand(siJulia),
  clj: brand(siClojure),
  cljs: brand(siClojure),
  graphql: brand(siGraphql),
  gql: brand(siGraphql),
  prisma: brand(siPrisma, "#a5b0c4"),
  sql: brand(siMysql),
  // non-language files: lucide fallbacks
  svg: { icon: FileImage, color: "#ffb13b" },
  png: { icon: FileImage, color: "#a074c4" },
  jpg: { icon: FileImage, color: "#a074c4" },
  jpeg: { icon: FileImage, color: "#a074c4" },
  gif: { icon: FileImage, color: "#a074c4" },
  webp: { icon: FileImage, color: "#a074c4" },
  ico: { icon: FileImage, color: "#a074c4" },
  bmp: { icon: FileImage, color: "#a074c4" },
  mp4: { icon: FileVideo, color: "#fd971f" },
  mov: { icon: FileVideo, color: "#fd971f" },
  webm: { icon: FileVideo, color: "#fd971f" },
  mkv: { icon: FileVideo, color: "#fd971f" },
  mp3: { icon: FileAudio, color: "#22b8a6" },
  wav: { icon: FileAudio, color: "#22b8a6" },
  flac: { icon: FileAudio, color: "#22b8a6" },
  ogg: { icon: FileAudio, color: "#22b8a6" },
  zip: { icon: FileArchive, color: "#b5b81e" },
  tar: { icon: FileArchive, color: "#b5b81e" },
  gz: { icon: FileArchive, color: "#b5b81e" },
  rar: { icon: FileArchive, color: "#b5b81e" },
  "7z": { icon: FileArchive, color: "#b5b81e" },
  csv: { icon: FileSpreadsheet, color: "#1abc9c" },
  tsv: { icon: FileSpreadsheet, color: "#1abc9c" },
  xlsx: { icon: FileSpreadsheet, color: "#1abc9c" },
  pdf: { icon: FileText, color: "#e03e2f" },
  ini: { icon: FileCog, color: "#9c9c9c" },
  conf: { icon: FileCog, color: "#9c9c9c" },
  env: { icon: FileCog, color: "#d4b106" },
  lock: { icon: FileKey, color: "#8a8a8a" },
  pem: { icon: FileKey, color: "#d4b106" },
  crt: { icon: FileKey, color: "#d4b106" },
  cert: { icon: FileKey, color: "#d4b106" },
  txt: { icon: FileText, color: "#9aa0a6" },
  log: { icon: FileText, color: "#9aa0a6" },
};

// Exact filenames that should win over their extension.
const NAME_ICONS: Record<string, IconSpec> = {
  dockerfile: brand(siDocker),
  ".dockerignore": brand(siDocker),
  ".gitignore": brand(siGit),
  ".gitattributes": brand(siGit),
  ".gitmodules": brand(siGit),
  "package.json": brand(siNodedotjs),
  "package-lock.json": brand(siNodedotjs),
  "tsconfig.json": brand(siTypescript),
};

function fileIcon(name: string): IconSpec {
  const lower = name.toLowerCase();
  if (NAME_ICONS[lower]) return NAME_ICONS[lower];
  if (lower.startsWith("readme")) return brand(siMarkdown, "#8ba7c4");
  if (lower.startsWith("license") || lower.startsWith("licence"))
    return { icon: FileBadge, color: "#d4b106" };
  const dot = lower.lastIndexOf(".");
  const ext = dot > 0 ? lower.slice(dot + 1) : "";
  return EXT_ICONS[ext] ?? { icon: File, color: "var(--muted)" };
}

function FileIcon({ spec, size }: { spec: IconSpec; size: number }) {
  if ("brand" in spec) {
    return (
      <svg
        className="ft-file"
        width={size}
        height={size}
        viewBox="0 0 24 24"
        fill={spec.color}
        aria-hidden
      >
        <path d={spec.brand.path} />
      </svg>
    );
  }
  const Ic = spec.icon;
  return <Ic size={size} className="ft-file" style={{ color: spec.color }} />;
}

interface TreeItem { path: string; name: string; isDir: boolean }
type Operation = { kind: "rename" | "delete" | "move"; item: TreeItem; destination?: string };
interface TreeActions {
  revision: number;
  expanded: ReadonlySet<string>;
  toggle: (path: string) => void;
  busy: boolean;
  menu: (item: TreeItem, x: number, y: number) => void;
  drag: (item: TreeItem | null) => void;
  drop: (directory: string) => void;
  canDrop: (directory: string) => boolean;
}
const TreeContext = createContext<TreeActions | null>(null);
const FILE_DRAG = "application/x-pzza-file";

function TreeNode({ path, name, isDir, depth, activePath, onOpenFile, host }: {
  path: string; name: string; isDir: boolean; depth: number; activePath?: string;
  onOpenFile: (path: string) => void; host?: string;
}) {
  const actions = useContext(TreeContext);
  const expanded = actions?.expanded.has(path) ?? false;
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [error, setError] = useState("");
  const [over, setOver] = useState(false);
  useEffect(() => {
    if (!isDir || !expanded) return;
    let alive = true;
    setError("");
    listDir(path, host).then((result) => { if (alive) setChildren(result.entries); })
      .catch(() => { if (alive) { setError("Could not read this folder."); setChildren([]); } });
    return () => { alive = false; };
  }, [path, host, isDir, expanded, actions?.revision]);
  const item = { path, name, isDir };
  return <>
    <button
      className={`ft-row ${!isDir && activePath === path ? "on" : ""} ${over ? "ft-drop-target" : ""}`}
      style={{ paddingLeft: 8 + depth * 12 }}
      title={name}
      disabled={actions?.busy}
      aria-expanded={isDir ? expanded : undefined}
      onClick={() => isDir ? actions?.toggle(path) : onOpenFile(path)}
      onMouseDown={(event) => event.stopPropagation()}
      onContextMenu={(event) => { event.preventDefault(); event.stopPropagation(); actions?.menu(item, event.clientX, event.clientY); }}
      onKeyDown={(event) => {
        if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          actions?.menu(item, rect.left, rect.bottom);
        }
      }}
      draggable={!actions?.busy}
      onDragStart={(event) => {
        event.stopPropagation();
        actions?.drag(item);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData(FILE_DRAG, path);
      }}
      onDragEnd={() => { actions?.drag(null); setOver(false); }}
      onDragOver={(event) => {
        if (isDir && actions?.canDrop(path)) {
          event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(event) => {
        event.preventDefault(); event.stopPropagation(); setOver(false);
        if (isDir) actions?.drop(path);
      }}
    >
      {isDir ? <ChevronRight size={13} className={`ft-chevron ${expanded ? "open" : ""}`} /> : <span className="ft-chevron-spacer" />}
      {isDir ? expanded ? <FolderOpen size={15} className="ft-folder" /> : <Folder size={15} className="ft-folder" /> : <FileIcon spec={fileIcon(name)} size={15} />}
      <span className="ft-name">{name}</span>
    </button>
    {isDir && expanded ? children === null
      ? <div className="ft-loading"><Loader2 size={12} className="sw-spin" /></div>
      : error ? <div className="ft-loading" role="alert">{error}</div>
      : children.map((child) => <TreeNode key={child.name} host={host} path={join(path, child.name)} name={child.name} isDir={child.dir} depth={depth + 1} activePath={activePath} onOpenFile={onOpenFile} />)
      : null}
  </>;
}

export function FolderTree({ root, activePath, onOpenFile, host, control }: {
  root: string; activePath?: string; onOpenFile: (path: string) => void; host?: string;
  control?: { revision: number; path?: string; expanded?: boolean };
}) {
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [resolvedRoot, setResolvedRoot] = useState(root);
  const [revision, setRevision] = useState(0);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  useEffect(() => { setExpanded(new Set()); }, [root, host]);
  useEffect(() => {
    if (!control?.revision) return;
    setRevision(value => value + 1);
    const selectedPath = control.path;
    if (!selectedPath) return;
    setExpanded(current => {
      const next = new Set(current);
      if (control.expanded) {
        let path = selectedPath;
        while (path && path !== resolvedRoot && path.startsWith(resolvedRoot + "/")) { next.add(path); path = path.slice(0, path.lastIndexOf("/")); }
      } else next.delete(selectedPath);
      return next;
    });
  }, [control, resolvedRoot]);
  const [listingError, setListingError] = useState("");
  const [menu, setMenu] = useState<{ item: TreeItem; x: number; y: number } | null>(null);
  const [operation, setOperation] = useState<Operation | null>(null);
  const [name, setName] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const dragged = useRef<TreeItem | null>(null);
  const menuElement = useRef<HTMLDivElement>(null);
  const listingKey = useRef("");

  useEffect(() => onFileMutation((mutation) => {
    if ((mutation.host || "") === (host || "")) setRevision((value) => value + 1);
  }), [host]);
  useEffect(() => {
    let alive = true;
    const key = JSON.stringify([root, host]);
    if (listingKey.current !== key) { setChildren(null); listingKey.current = key; }
    setListingError("");
    listDir(root, host).then((result) => {
      if (alive) { setResolvedRoot(result.path); setChildren(result.entries); }
    }).catch(() => { if (alive) { setChildren([]); setListingError("Could not read this folder."); } });
    return () => { alive = false; };
  }, [root, host, revision]);
  useEffect(() => {
    if (!menu) return;
    menuElement.current?.querySelector<HTMLButtonElement>("button")?.focus();
    const close = () => setMenu(null);
    window.addEventListener("resize", close);
    window.addEventListener("scroll", close, true);
    return () => { window.removeEventListener("resize", close); window.removeEventListener("scroll", close, true); };
  }, [menu]);
  const start = (next: Operation) => { setMenu(null); setError(""); setName(next.item.name); setOperation(next); };
  const canDrop = (directory: string) => {
    const source = dragged.current;
    return !!source && !busy && directory !== source.path && !directory.startsWith(source.path + "/") && join(directory, source.name) !== source.path;
  };
  const actions: TreeActions = {
    revision, busy, expanded,
    toggle: path => setExpanded(current => { const next = new Set(current); if (next.has(path)) next.delete(path); else next.add(path); return next; }),
    menu: (item, x, y) => { if (!busy) setMenu({ item, x, y }); },
    drag: (item) => { dragged.current = item; setMenu(null); },
    canDrop,
    drop: (directory) => {
      if (canDrop(directory) && dragged.current) start({ kind: "move", item: dragged.current, destination: join(directory, dragged.current.name) });
      dragged.current = null;
    },
  };
  const submit = async () => {
    if (!operation || busy) return;
    const destination = operation.kind === "rename" ? join(operation.item.path.slice(0, operation.item.path.lastIndexOf("/")), name) : operation.destination;
    if (operation.kind === "rename" && (!name.trim() || name === "." || name === ".." || /[/\\\x00-\x1f]/.test(name))) {
      setError("Enter a single file or folder name without path separators."); return;
    }
    if (destination === operation.item.path) { setOperation(null); return; }
    setBusy(true); setError("");
    let release: (() => void) | undefined;
    try {
      release = beginFileMutation({ host, path: operation.item.path }, { allowDirty: operation.kind !== "delete" });
      if (operation.kind === "delete") {
        await deleteFile(resolvedRoot, operation.item.path, host);
        notifyFileMutation({ host, path: operation.item.path });
      } else if (destination) {
        const result = await moveFile(resolvedRoot, operation.item.path, destination, host);
        notifyFileMutation({ host, path: operation.item.path, destination: result.path });
      }
      setOperation(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "File operation failed.");
      setRevision((value) => value + 1);
    }
    finally { release?.(); setBusy(false); }
  };
  return <TreeContext.Provider value={actions}>
    <div className="ft-body">
      <button className="ft-row ft-root" title="Drop here to move into the root folder" disabled={busy}
        onClick={() => setRevision((value) => value + 1)}
        onDragOver={(event) => { if (canDrop(resolvedRoot)) { event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = "move"; } }}
        onDrop={(event) => { event.preventDefault(); event.stopPropagation(); actions.drop(resolvedRoot); }}>
        <FolderOpen size={15} /><span className="ft-name">{resolvedRoot.split("/").pop() || resolvedRoot}</span>
      </button>
      {children === null ? <div className="ft-loading"><Loader2 size={12} className="sw-spin" /></div>
        : listingError ? <div className="ft-loading" role="alert">{listingError}</div>
        : !children.length ? <div className="ft-loading">empty</div>
        : children.map((child) => <TreeNode key={child.name} host={host} path={join(resolvedRoot, child.name)} name={child.name} isDir={child.dir} depth={0} activePath={activePath} onOpenFile={onOpenFile} />)}
    </div>
    {menu ? createPortal(<div className="cselect-backdrop pzza-portal" onMouseDown={() => setMenu(null)} onContextMenu={(event) => { event.preventDefault(); setMenu(null); }}>
      <div ref={menuElement} className="menu ft-context-menu" role="menu" aria-label="File actions"
        style={{ left: Math.max(8, Math.min(menu.x, window.innerWidth - 188)), top: Math.max(8, Math.min(menu.y, window.innerHeight - 112)) }}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          if (event.key === "Escape" || event.key === "Tab") { setMenu(null); return; }
          if (event.key === "ArrowDown" || event.key === "ArrowUp") {
            event.preventDefault();
            const items = Array.from(event.currentTarget.querySelectorAll<HTMLButtonElement>("button"));
            const index = items.indexOf(document.activeElement as HTMLButtonElement);
            items[(index + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length]?.focus();
          }
        }}>
        <button className="menu-item" role="menuitem" onClick={() => start({ kind: "rename", item: menu.item })}>Rename…</button>
        <button className="menu-item" role="menuitem" onClick={() => start({ kind: "delete", item: menu.item })}>Delete…</button>
      </div>
    </div>, document.body) : null}
    <Modal open={!!operation} onClose={() => { if (!busy) setOperation(null); }} title={operation?.kind === "delete" ? "Delete permanently?" : operation?.kind === "move" ? "Move item?" : "Rename item"} size="sm">
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        <p className="ft-operation-path">{operation?.item.path}</p>
        {operation?.kind === "rename" ? <label>New name<input className="input" aria-label="New name" autoFocus value={name} disabled={busy} onChange={(event) => setName(event.target.value)} /></label>
          : operation?.kind === "move" ? <p className="ft-operation-path">Move to: {operation.destination}</p>
          : <p>This permanently deletes {operation?.item.isDir ? "this folder and everything inside it" : "this file"}, including unsaved editor changes. This cannot be undone.</p>}
        {error ? <p role="alert">{error}</p> : null}
        <div className="modal-actions">
          <button className="btn" type="button" disabled={busy} onClick={() => setOperation(null)}>Cancel</button>
          <AsyncButton className={`btn ${operation?.kind === "delete" ? "btn-danger" : "btn-accent"}`} type="submit" loading={busy}>{operation?.kind === "delete" ? "Delete permanently" : operation?.kind === "move" ? "Move" : "Rename"}</AsyncButton>
        </div>
      </form>
    </Modal>
  </TreeContext.Provider>;
}
