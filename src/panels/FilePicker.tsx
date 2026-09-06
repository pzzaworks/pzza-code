import { useEffect, useMemo, useRef, useState } from "react";
import {
  ArrowUp,
  ChevronRight,
  Eye,
  EyeOff,
  File,
  FileCode2,
  FileImage,
  FileKey,
  FileText,
  Folder,
  FolderOpen,
  House,
  Loader2,
  Pencil,
  Search,
} from "lucide-react";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { listDir, type DirEntry } from "../serverApi";

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

export interface PickerHost {
  label: string;
  host: string; // "" = this Mac, else ssh target
  sub?: string;
}

const HIDDEN_KEY = "pzza.picker.hidden";
function loadHidden(): boolean {
  try {
    return localStorage.getItem(HIDDEN_KEY) === "1";
  } catch {
    return false;
  }
}

// Icon by file type, so a key or an image reads at a glance.
function fileIcon(name: string) {
  const n = name.toLowerCase();
  if (/\.(pub|pem|key)$/.test(n) || /^id_(rsa|ed25519|ecdsa|dsa)/.test(n)) return FileKey;
  if (/\.(png|jpe?g|gif|webp|svg|avif|bmp|ico)$/.test(n)) return FileImage;
  if (/\.(md|txt|log|env|toml|ya?ml|json|ini|cfg|conf)$/.test(n) || n.startsWith(".env")) return FileText;
  if (/\.(ts|tsx|js|jsx|mjs|cjs|rs|py|go|rb|java|kt|swift|c|cc|cpp|h|hpp|cs|sh|zsh|bash|css|scss|html|vue|svelte|sql)$/.test(n))
    return FileCode2;
  return File;
}

// Breadcrumb segments for a path; the home prefix collapses to "~".
function crumbs(dir: string, home: string): { label: string; path: string }[] {
  const out: { label: string; path: string }[] = [];
  let rest = dir;
  if (home && (dir === home || dir.startsWith(home + "/"))) {
    out.push({ label: "~", path: home });
    rest = dir.slice(home.length);
  } else {
    out.push({ label: "/", path: "/" });
  }
  let acc = out[0].path;
  for (const seg of rest.split("/").filter(Boolean)) {
    acc = join(acc, seg);
    out.push({ label: seg, path: acc });
  }
  return out;
}

// Browse a device's home tree. In "file" mode picking a file returns its path;
// in "folder" mode you navigate into a folder and "Use this folder" returns it.
// Breadcrumbs jump up the tree, the pencil (or typing a path) jumps anywhere,
// and the arrow keys / Enter / Backspace drive it from the keyboard. With
// `hosts` a device switcher lets you browse another device's files.
export function FilePicker({
  open,
  onClose,
  onPick,
  mode = "file",
  start,
  host = "",
  hosts,
  title,
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string, host: string) => void;
  mode?: "file" | "folder";
  start?: string; // initial directory (falls back to the device's home)
  host?: string; // ssh target when browsing another device's files
  hosts?: PickerHost[]; // offer a device switcher
  title?: string;
}) {
  const [curHost, setCurHost] = useState(host);
  const [home, setHome] = useState("");
  const [dir, setDir] = useState<string | null>(null);
  const [parent, setParent] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);
  const [typed, setTyped] = useState("");
  const [filter, setFilter] = useState("");
  const [showHidden, setShowHidden] = useState(loadHidden);
  const [cursor, setCursor] = useState(-1);
  const listRef = useRef<HTMLDivElement>(null);
  const filterRef = useRef<HTMLInputElement>(null);
  const editRef = useRef<HTMLInputElement>(null);

  const nav = (path: string | undefined, h: string) => {
    setLoading(true);
    setError(null);
    setEditing(false);
    listDir(path, h)
      .then((r) => {
        setDir(r.path);
        setParent(r.parent);
        setEntries(r.entries);
        setFilter("");
        setCursor(-1);
        listRef.current?.scrollTo({ top: 0 });
      })
      .catch((e) => {
        // A missing start directory should not dead-end: fall back to home.
        if (path) {
          nav(undefined, h);
          return;
        }
        setError(String(e?.message || e));
      })
      .finally(() => setLoading(false));
  };

  const loadHome = (h: string) =>
    listDir(undefined, h)
      .then((r) => setHome(r.path))
      .catch(() => setHome(""));

  useEffect(() => {
    if (open) {
      setCurHost(host);
      void loadHome(host);
      nav(start, host);
      setTimeout(() => filterRef.current?.focus(), 50);
    } else {
      setDir(null);
      setFilter("");
      setEditing(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  useEffect(() => {
    if (editing) setTimeout(() => editRef.current?.select(), 0);
  }, [editing]);

  const switchHost = (h: string) => {
    setCurHost(h);
    void loadHome(h);
    nav(undefined, h);
  };

  const toggleHidden = () => {
    setShowHidden((v) => {
      try {
        localStorage.setItem(HIDDEN_KEY, v ? "0" : "1");
      } catch {
        /* ignore */
      }
      return !v;
    });
  };

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return entries
      .filter((e) => mode === "file" || e.dir)
      .filter((e) => showHidden || !e.name.startsWith("."))
      .filter((e) => !q || e.name.toLowerCase().includes(q));
  }, [entries, mode, showHidden, filter]);

  const hiddenCount = entries.filter((e) => (mode === "file" || e.dir) && e.name.startsWith(".")).length;

  const pick = (p: string) => {
    onPick(p, curHost);
    onClose();
  };
  const openEntry = (e: DirEntry) => {
    const p = join(dir ?? "", e.name);
    if (e.dir) nav(p, curHost);
    else pick(p);
  };
  const goUp = () => {
    if (dir && parent && parent !== dir) nav(parent, curHost);
  };

  // Keyboard: arrows move the cursor, Enter opens/picks, Backspace goes up
  // when the filter is empty, Escape is handled by the modal.
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => Math.min(shown.length - 1, c + 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => Math.max(-1, c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor >= 0 && shown[cursor]) openEntry(shown[cursor]);
      else if (shown.length === 1) openEntry(shown[0]);
      else if (mode === "folder" && dir) pick(dir);
    } else if (e.key === "Backspace" && !filter) {
      e.preventDefault();
      goUp();
    }
  };

  useEffect(() => {
    if (cursor < 0) return;
    const el = listRef.current?.children[cursor] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [cursor]);

  const trail = dir ? crumbs(dir, home) : [];
  const crumbRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = crumbRef.current;
    if (el) el.scrollLeft = el.scrollWidth;
  }, [dir, home]);
  const shortDir = dir && home && (dir === home || dir.startsWith(home + "/")) ? "~" + dir.slice(home.length) : dir;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={title ?? (mode === "folder" ? "Choose a folder" : "Choose a file")}
      icon={mode === "folder" ? FolderOpen : File}
      size="md"
    >
      <div className="fp" onKeyDown={onKey}>
        <div className="fp-bar">
          {hosts && hosts.length > 1 ? (
            <div className="fp-host">
              <Select
                value={curHost}
                onChange={switchHost}
                options={hosts.map((h) => ({ value: h.host, label: h.label, sub: h.sub ?? (h.host || "local") }))}
              />
            </div>
          ) : null}
          <div className="fp-search">
            <Search size={13} className="muted-icon" />
            <input
              ref={filterRef}
              value={filter}
              placeholder="Filter…"
              spellCheck={false}
              onChange={(e) => {
                setFilter(e.target.value);
                setCursor(-1);
              }}
            />
          </div>
          <button
            type="button"
            className={`fp-tool ${showHidden ? "on" : ""}`}
            onClick={toggleHidden}
            title={showHidden ? "Hide dotfiles" : `Show dotfiles${hiddenCount ? ` (${hiddenCount})` : ""}`}
          >
            {showHidden ? <Eye size={14} /> : <EyeOff size={14} />}
          </button>
        </div>

        <div className="fp-crumbs">
          <button type="button" className="fp-tool" onClick={goUp} disabled={!dir || !parent || parent === dir} title="Up one level (Backspace)">
            <ArrowUp size={14} />
          </button>
          {editing ? (
            <input
              ref={editRef}
              className="fp-crumb-edit"
              value={typed}
              spellCheck={false}
              onChange={(e) => setTyped(e.target.value)}
              onBlur={() => setEditing(false)}
              onKeyDown={(e) => {
                e.stopPropagation();
                if (e.key === "Enter") nav(typed.trim() || undefined, curHost);
                if (e.key === "Escape") setEditing(false);
              }}
            />
          ) : (
            <div ref={crumbRef} className="fp-crumb-list" onDoubleClick={() => { setTyped(shortDir ?? ""); setEditing(true); }}>
              {trail.map((c, i) => (
                <span key={c.path} className="fp-crumb-wrap">
                  {i > 0 ? <ChevronRight size={12} className="fp-crumb-sep" /> : null}
                  <button
                    type="button"
                    className={`fp-crumb ${i === trail.length - 1 ? "fp-crumb-cur" : ""}`}
                    onClick={() => (i < trail.length - 1 ? nav(c.path, curHost) : undefined)}
                    title={c.path}
                  >
                    {c.label === "~" ? <House size={12} /> : c.label}
                  </button>
                </span>
              ))}
              {!dir ? <span className="muted small">…</span> : null}
            </div>
          )}
          <button
            type="button"
            className="fp-tool"
            onClick={() => {
              setTyped(shortDir ?? "");
              setEditing(true);
            }}
            title="Type a path"
          >
            <Pencil size={13} />
          </button>
        </div>

        <div className="fp-list" ref={listRef}>
          {loading ? (
            <div className="fp-status">
              <Loader2 size={15} className="sw-spin" /> Loading…
            </div>
          ) : error ? (
            <div className="fp-status fp-status-err">{error}</div>
          ) : shown.length === 0 ? (
            <div className="fp-status muted">
              {filter
                ? "Nothing matches."
                : mode === "folder"
                  ? hiddenCount && !showHidden
                    ? "Only hidden folders here."
                    : "No subfolders."
                  : hiddenCount && !showHidden
                    ? "Only hidden files here."
                    : "Empty folder."}
            </div>
          ) : (
            shown.map((e, i) => {
              const Icon = e.dir ? Folder : fileIcon(e.name);
              return (
                <button
                  key={e.name}
                  type="button"
                  className={`fp-row ${i === cursor ? "fp-row-cur" : ""} ${e.name.startsWith(".") ? "fp-row-hidden" : ""}`}
                  onClick={() => openEntry(e)}
                  onMouseEnter={() => setCursor(i)}
                >
                  <Icon size={15} className={e.dir ? "fp-folder" : "fp-file"} />
                  <span className="fp-name">{e.name}</span>
                  {e.dir ? <ChevronRight size={14} className="fp-arrow" /> : null}
                </button>
              );
            })
          )}
        </div>

        <div className="fp-foot">
          <span className="fp-foot-path" title={dir ?? ""}>
            {mode === "folder" ? shortDir ?? "" : "Pick a file"}
          </span>
          <span className="fp-foot-hint muted small">{shown.length} item{shown.length === 1 ? "" : "s"}</span>
          <button className="btn btn-sm" onClick={onClose}>
            Cancel
          </button>
          {mode === "folder" ? (
            <button className="btn btn-sm btn-accent" onClick={() => dir && pick(dir)} disabled={!dir}>
              <FolderOpen size={13} />
              Use this folder
            </button>
          ) : null}
        </div>
      </div>
    </Modal>
  );
}
