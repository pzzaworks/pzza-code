import { useState } from "react";
import { Check, Eye, EyeOff, Trash2 } from "lucide-react";
import { useStore } from "../state/store";
import { Modal } from "../ui/Modal";
import { tileTitle, sessionIcon, iconColor } from "../sessionMeta";
import { DEFAULT_WORKSPACE_ID, WORKSPACE_COLORS } from "../workspaces";
import { workspaceIcon } from "../workspaceIcons";
import { IconPicker } from "../ui/IconPicker";

// Workspace settings: a compact chip (click the icon for icon & color, click the
// name to rename), the workspace's sessions (visible + hidden) with a per-row
// show/hide toggle, and delete.
export function WorkspaceSettings({ id, close }: { id: string; close: () => void }) {
  const workspaces = useStore((s) => s.workspaces);
  const renameWorkspace = useStore((s) => s.renameWorkspace);
  const setWorkspaceIcon = useStore((s) => s.setWorkspaceIcon);
  const setWorkspaceColor = useStore((s) => s.setWorkspaceColor);
  const removeWorkspace = useStore((s) => s.removeWorkspace);
  const hiddenTiles = useStore((s) => s.hiddenTiles);
  const hideTile = useStore((s) => s.hideTile);
  const unhideTile = useStore((s) => s.unhideTile);
  const sessionWs = useStore((s) => s.sessionWs);
  const tiles = useStore((s) => s.tiles);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  const ws = workspaces.find((w) => w.id === id);
  if (!ws) return null;

  const IconComp = workspaceIcon(ws.icon);
  const color = ws.color ?? "var(--accent)";
  const sessions = tiles.filter(
    (t) => (sessionWs[t.session ?? t.name] ?? DEFAULT_WORKSPACE_ID) === id,
  );

  const startRename = () => {
    setDraft(ws.name);
    setEditing(true);
  };
  const commitRename = () => {
    renameWorkspace(id, draft);
    setEditing(false);
  };

  return (
    <div className="menu-body">
      <div className="ws-chip">
        <button
          className={`ws-chip-avatar ${pickerOpen ? "on" : ""}`}
          style={{ color }}
          onClick={() => setPickerOpen((v) => !v)}
          title="Icon & color"
        >
          <IconComp size={16} />
        </button>
        {editing ? (
          <input
            className="ws-name-input"
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onFocus={(e) => e.currentTarget.select()}
            onKeyDown={(e) => {
              if (e.key === "Enter") commitRename();
              else if (e.key === "Escape") setEditing(false);
            }}
            onBlur={commitRename}
          />
        ) : (
          <span className="ws-name" title="Click to rename" onClick={startRename}>
            {ws.name}
          </span>
        )}
      </div>

      {pickerOpen ? (
        <div className="ws-picker">
          <IconPicker value={ws.icon} onSelect={(key) => setWorkspaceIcon(id, key)} />
          <div className="color-grid">
            {WORKSPACE_COLORS.map((c) => (
              <button
                key={c}
                className="color-choice"
                style={{ background: c }}
                onClick={() => setWorkspaceColor(id, c)}
              >
                {ws.color === c ? <Check size={13} color="#fff" /> : null}
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="field">
        <span className="field-label">
          Sessions
          {sessions.length ? <span className="field-hint">{sessions.length}</span> : null}
        </span>
        {sessions.length === 0 ? (
          <p className="set-note" style={{ margin: 0 }}>
            No sessions in this workspace.
          </p>
        ) : (
          <div className="ws-sess-list">
            {sessions.map((t) => {
              const base = t.session ?? t.name;
              const isHidden = hiddenTiles.includes(t.id);
              const Icon = sessionIcon(base, t.command);
              const col = iconColor(base, t.command);
              return (
                <div key={t.id} className={`ws-sess-row ${isHidden ? "hidden" : ""}`}>
                  <span className="ws-sess-icon" style={col ? { color: col } : undefined}>
                    <Icon size={14} />
                  </span>
                  <span className="ws-sess-name">{tileTitle(t.name)}</span>
                  <button
                    className="ws-sess-toggle"
                    title={isHidden ? "Show" : "Hide"}
                    onClick={() => (isHidden ? unhideTile(t.id) : hideTile(t.id))}
                  >
                    {isHidden ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {workspaces.length > 1 && !ws.system ? (
        <button className="btn btn-danger ws-delete" onClick={() => setConfirmDelete(true)}>
          <Trash2 size={14} strokeWidth={2} />
          Delete workspace
        </button>
      ) : null}

      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        title="Delete workspace"
        size="sm"
      >
        <p className="move-q">
          Delete <b>{ws.name}</b>? Its sessions move back to the default workspace - nothing
          running is terminated.
        </p>
        <div className="modal-actions">
          <button className="btn" onClick={() => setConfirmDelete(false)}>
            Cancel
          </button>
          <button
            className="btn btn-danger"
            onClick={() => {
              removeWorkspace(id);
              setConfirmDelete(false);
              close();
            }}
          >
            <Trash2 size={14} strokeWidth={2} />
            Delete
          </button>
        </div>
      </Modal>
    </div>
  );
}
