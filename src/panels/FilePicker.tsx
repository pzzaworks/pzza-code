import { useEffect, useState } from "react";
import { ChevronRight, CornerUpLeft, File, FolderOpen, Loader2 } from "lucide-react";
import { Modal } from "../ui/Modal";
import { listDir, type DirEntry } from "../serverApi";

const join = (dir: string, name: string) => (dir.endsWith("/") ? dir + name : `${dir}/${name}`);

// Browse the device's home tree. In "file" mode picking a file returns its path;
// in "folder" mode you navigate into a folder and "Open this folder" returns it.
export function FilePicker({
  open,
  onClose,
  onPick,
  mode = "file",
}: {
  open: boolean;
  onClose: () => void;
  onPick: (path: string) => void;
  mode?: "file" | "folder";
}) {
  const [dir, setDir] = useState<string | null>(null);
  const [parent, setParent] = useState("");
  const [entries, setEntries] = useState<DirEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const nav = (path?: string) => {
    setLoading(true);
    setError(null);
    listDir(path)
      .then((r) => {
        setDir(r.path);
        setParent(r.parent);
        setEntries(r.entries);
      })
      .catch((e) => setError(String(e?.message || e)))
      .finally(() => setLoading(false));
  };

  useEffect(() => {
    if (open && dir === null) nav();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const shown = mode === "folder" ? entries.filter((e) => e.dir) : entries;

  return (
    <Modal open={open} onClose={onClose} title={mode === "folder" ? "Open folder" : "Open a file"} size="md">
      <div className="fp-path" title={dir ?? ""}>
        {dir ?? "…"}
      </div>
      <div className="fp-list">
        {dir && parent && parent !== dir ? (
          <button className="fp-row" onClick={() => nav(parent)}>
            <CornerUpLeft size={14} className="muted-icon" />
            <span className="fp-name">..</span>
          </button>
        ) : null}
        {loading ? (
          <div className="code-status">
            <Loader2 size={15} className="sw-spin" /> Loading…
          </div>
        ) : error ? (
          <div className="code-status code-err">{error}</div>
        ) : shown.length === 0 ? (
          <div className="code-status muted">
            {mode === "folder" ? "No subfolders." : "Empty folder."}
          </div>
        ) : (
          shown.map((e) => (
            <button
              key={e.name}
              className="fp-row"
              onClick={() => {
                const p = join(dir ?? "", e.name);
                if (e.dir) nav(p);
                else {
                  onPick(p);
                  onClose();
                }
              }}
            >
              {e.dir ? (
                <FolderOpen size={14} className="fp-folder" />
              ) : (
                <File size={14} className="fp-file" />
              )}
              <span className="fp-name">{e.name}</span>
              {e.dir ? <ChevronRight size={14} className="fp-arrow" /> : null}
            </button>
          ))
        )}
      </div>
      {mode === "folder" && dir ? (
        <div className="modal-actions">
          <button className="btn" onClick={onClose}>
            Cancel
          </button>
          <button
            className="btn btn-accent"
            onClick={() => {
              onPick(dir);
              onClose();
            }}
          >
            <FolderOpen size={14} />
            Open this folder
          </button>
        </div>
      ) : null}
    </Modal>
  );
}
