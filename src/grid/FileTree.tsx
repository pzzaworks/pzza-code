import { useEffect, useState } from "react";
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
import { listDir, type DirEntry } from "../serverApi";

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

function TreeNode({
  path,
  name,
  isDir,
  depth,
  activePath,
  onOpenFile,
}: {
  path: string;
  name: string;
  isDir: boolean;
  depth: number;
  activePath?: string;
  onOpenFile: (p: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [children, setChildren] = useState<DirEntry[] | null>(null);
  const [loading, setLoading] = useState(false);

  const toggle = () => {
    if (!isDir) {
      onOpenFile(path);
      return;
    }
    if (!expanded && children === null) {
      setLoading(true);
      listDir(path)
        .then((r) => setChildren(r.entries))
        .catch(() => setChildren([]))
        .finally(() => setLoading(false));
    }
    setExpanded((v) => !v);
  };

  return (
    <>
      <button
        className={`ft-row ${!isDir && activePath === path ? "on" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        onClick={toggle}
        onMouseDown={(e) => e.stopPropagation()}
        title={name}
      >
        {isDir ? (
          <ChevronRight size={13} className={`ft-chevron ${expanded ? "open" : ""}`} />
        ) : (
          <span className="ft-chevron-spacer" />
        )}
        {isDir ? (
          expanded ? (
            <FolderOpen size={15} className="ft-folder" />
          ) : (
            <Folder size={15} className="ft-folder" />
          )
        ) : (
          <FileIcon spec={fileIcon(name)} size={15} />
        )}
        <span className="ft-name">{name}</span>
      </button>
      {isDir && expanded
        ? loading
          ? (
            <div className="ft-loading" style={{ paddingLeft: 8 + (depth + 1) * 12 }}>
              <Loader2 size={12} className="sw-spin" />
            </div>
          )
          : (children ?? []).map((c) => (
              <TreeNode
                key={c.name}
                path={join(path, c.name)}
                name={c.name}
                isDir={c.dir}
                depth={depth + 1}
                activePath={activePath}
                onOpenFile={onOpenFile}
              />
            ))
        : null}
    </>
  );
}

// The file tree for a single folder root - lives inside one code tile.
export function FolderTree({
  root,
  activePath,
  onOpenFile,
}: {
  root: string;
  activePath?: string;
  onOpenFile: (p: string) => void;
}) {
  const [children, setChildren] = useState<DirEntry[] | null>(null);

  useEffect(() => {
    setChildren(null);
    listDir(root)
      .then((r) => setChildren(r.entries))
      .catch(() => setChildren([]));
  }, [root]);

  return (
    <div className="ft-body">
      {children === null ? (
        <div className="ft-loading" style={{ paddingLeft: 12 }}>
          <Loader2 size={12} className="sw-spin" />
        </div>
      ) : children.length === 0 ? (
        <div className="ft-loading" style={{ paddingLeft: 12 }}>
          empty
        </div>
      ) : (
        children.map((c) => (
          <TreeNode
            key={c.name}
            path={join(root, c.name)}
            name={c.name}
            isDir={c.dir}
            depth={0}
            activePath={activePath}
            onOpenFile={onOpenFile}
          />
        ))
      )}
    </div>
  );
}
