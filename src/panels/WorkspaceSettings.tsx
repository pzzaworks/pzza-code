import { LiveSessionIcon } from "../ui/LiveSessionIcon";
import { DeviceIcon } from "../ui/DeviceIcon";
import { useEffect, useState } from "react";
import { Check, ChevronRight, ClipboardPaste, Copy, Eye, EyeOff, FileText, Folder, RotateCcw, Save, Trash2 } from "lucide-react";
import { AsyncButton } from "../ui/AsyncButton";
import { deleteWorkspaceSnapshot, exportWorkspaceSnapshot, importWorkspaceSnapshot, relaunchWorkspaceSnapshot, renameWorkspaceSnapshot, saveWorkspaceSnapshot, snapshotPreview, useWorkspaceSnapshots, type PreviewStatus, type RelaunchResult } from "../state/workspaceSnapshots";
import type { WorkspaceSnapshot } from "../workspaceSnapshots";
import { isFileTile, isFolderTile, useStore } from "../state/store";
import { Modal } from "../ui/Modal";
import { sessionDisplayName } from "../sessionMeta";
import { DEFAULT_WORKSPACE_ID, WORKSPACE_COLORS, wsKeyOf } from "../workspaces";
import { deviceNameFor } from "../devices";
import { workspaceIcon } from "../workspaceIcons";
import { IconPicker } from "../ui/IconPicker";
import { AUTO_COLUMNS } from "../grid/autoLayout";

// Grid columns for the workspace: Auto fits them to the window and tile count.
const COLUMN_CHOICES = [
  { value: AUTO_COLUMNS, label: "Auto" },
  { value: 2, label: "2" },
  { value: 3, label: "3" },
  { value: 4, label: "4" },
] as const;

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
  const tileTitles = useStore((s) => s.tileTitles);
  const devices = useStore((s) => s.devices);

  const [pickerOpen, setPickerOpen] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const columns = useStore((s) => s.workspaceColumns[id] ?? s.defaultColumns);
  const setColumns = useStore((s) => s.setColumns);

  const ws = workspaces.find((w) => w.id === id);
  if (!ws) return null;

  const IconComp = workspaceIcon(ws.icon);
  const color = ws.color ?? "var(--accent)";
  const sessions = tiles.filter(
    (t) => (sessionWs[wsKeyOf(t)] ?? DEFAULT_WORKSPACE_ID) === id,
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
        <span className="field-label">Layout</span>
        {/* The same segmented switch as the usage panel. */}
        <div className="usage-seg ws-columns" role="group" aria-label="Grid columns">
          {COLUMN_CHOICES.map(({ value, label }) => (
            <button key={value} type="button" className={columns === value ? "on" : ""} aria-pressed={columns === value} onClick={() => setColumns(value, id)}>{label}</button>
          ))}
        </div>
      </div>

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
              const file = isFileTile(t);
              const isHidden = hiddenTiles.includes(t.id);
              return (
                <div key={t.id} className={`ws-sess-row ${isHidden ? "hidden" : ""}`}>
                  <span className="ws-sess-icon">
                    {file ? (isFolderTile(t) ? <Folder size={14} aria-hidden="true" /> : <FileText size={14} aria-hidden="true" />) : <LiveSessionIcon session={t.session ?? t.name} window={t.window} host={t.host} />}
                  </span>
                  <span className="ws-sess-name">{sessionDisplayName(t, tileTitles)}</span>
                  <span className="ws-sess-device" title="Running on">
                    <DeviceIcon host={file ? undefined : t.host} size={11} />{deviceNameFor(devices, file ? undefined : t.host)}
                  </span>
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

      <SnapshotSection workspaceId={id} workspaceName={ws.name} hasSessions={sessions.length > 0} />

      {/* The default workspace stays: unassigned sessions and those of deleted workspaces belong to it. */}
      {workspaces.length > 1 && !ws.system && ws.id !== DEFAULT_WORKSPACE_ID ? (
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

function relaunchSummary(result: RelaunchResult): string {
  const parts = [
    result.createdWorkspace ? `Recreated the ${result.createdWorkspace} workspace` : "",
    result.started.length ? `Started ${result.started.join(", ")}` : "",
    result.resumed.length ? `continued the agent in ${result.resumed.join(", ")}` : "",
    result.running.length ? `already running: ${result.running.join(", ")}` : "",
    result.failed.length ? `failed: ${result.failed.map(item => `${item.session} (${item.error})`).join("; ")}` : "",
    result.branches.length ? `now on another branch: ${result.branches.map(item => `${item.session} is on ${item.now} (saved on ${item.saved})`).join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `${parts.join("; ")}.` : "Nothing to relaunch.";
}

const PREVIEW_LABELS: Record<PreviewStatus, string> = { start: "Will start", resume: "Agent restarts", running: "Running", "no-device": "Device missing" };

// What restoring a snapshot will do, session by session, with a checkbox for
// each one that would change; nothing runs until Restore is pressed.
function SnapshotPreview({ snapshotId, onDone, onCancel }: { snapshotId: string; onDone: (result: RelaunchResult) => void; onCancel: () => void }) {
  const relaunching = useWorkspaceSnapshots((s) => s.relaunching);
  const [continueChats, setContinueChats] = useState(true);
  const entries = snapshotPreview(snapshotId, continueChats);
  const [unchecked, setUnchecked] = useState<Set<string>>(() => new Set());
  const chosen = entries.filter((entry) => (entry.status === "start" || entry.status === "resume") && !unchecked.has(entry.key));
  const toggle = (key: string) => setUnchecked((current) => { const next = new Set(current); if (next.has(key)) next.delete(key); else next.add(key); return next; });
  const run = async () => onDone(await relaunchWorkspaceSnapshot(snapshotId, { continueChats, only: chosen.map((entry) => entry.key) }));
  return (
    <div className="snap-preview" role="group" aria-label="Restore preview">
      {entries.map((entry) => {
        const can = entry.status === "start" || entry.status === "resume";
        return (
          <label key={entry.key} className={`snap-preview-row ${can ? "" : "is-off"}`}>
            <input type="checkbox" checked={can && !unchecked.has(entry.key)} disabled={!can || relaunching !== null} onChange={() => toggle(entry.key)} aria-label={`Restore ${entry.session}`} />
            <span className="snap-preview-name">{entry.session}</span>
            <span className={`snap-preview-status is-${entry.status}`}>{PREVIEW_LABELS[entry.status]}</span>
            {entry.agent || entry.branch ? <span className="snap-preview-meta">{[entry.agent, entry.branch ? `⎇ ${entry.branch}` : ""].filter(Boolean).join(" · ")}</span> : null}
          </label>
        );
      })}
      <label className="snap-preview-option">
        <input type="checkbox" checked={continueChats} onChange={() => setContinueChats(!continueChats)} disabled={relaunching !== null} />
        Continue agent conversations
      </label>
      <div className="snap-preview-actions">
        <button type="button" className="btn btn-sm" onClick={onCancel} disabled={relaunching !== null}>Cancel</button>
        <AsyncButton className="btn btn-sm btn-accent" icon={RotateCcw} iconSize={13} loading={relaunching === snapshotId} disabled={relaunching !== null || chosen.length === 0} onClick={() => void run()}>
          {chosen.length ? `Restore ${chosen.length}` : "Nothing to restore"}
        </AsyncButton>
      </div>
    </div>
  );
}

// One snapshot: its name (click to rename), what it holds, and its actions.
function SnapshotRow({ snapshot, open, busy, onToggle, onCopy, onError }: { snapshot: WorkspaceSnapshot; open: boolean; busy: boolean; onToggle: () => void; onCopy: () => void; onError: (message: string) => void }) {
  const [renaming, setRenaming] = useState(false);
  const [draft, setDraft] = useState(snapshot.name);
  const finish = (save: boolean) => {
    try {
      if (save) renameWorkspaceSnapshot(snapshot.id, draft);
    } catch (error) {
      onError(error instanceof Error ? error.message : "Could not rename the snapshot.");
    }
    setRenaming(false);
  };
  const when = new Date(snapshot.createdAt).toLocaleString([], snapshot.auto ? { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" } : { month: "short", day: "numeric" });
  return (
    <div className="snap-row">
      <div className="snap-row-copy">
        {renaming ? (
          <input className="snap-rename" aria-label="Snapshot name" autoFocus maxLength={80} value={draft}
            onChange={(e) => setDraft(e.target.value)} onBlur={() => finish(true)}
            onKeyDown={(e) => { if (e.key === "Enter") finish(true); else if (e.key === "Escape") finish(false); }} />
        ) : (
          <button type="button" className="snap-name" title="Rename" onClick={() => { setDraft(snapshot.name); setRenaming(true); }}>{snapshot.name}</button>
        )}
        <span className="snap-meta" title={snapshot.sessions.map((entry) => entry.session).join(", ")}>
          {snapshot.auto ? "Auto · " : ""}{snapshot.sessions.length} session{snapshot.sessions.length === 1 ? "" : "s"} · {when}
        </span>
      </div>
      <button type="button" className={`snap-icon ${open ? "is-on" : ""}`} title="Restore" aria-label={`Restore ${snapshot.name}`} aria-expanded={open} disabled={busy} onClick={onToggle}><RotateCcw size={14} /></button>
      <button type="button" className="snap-icon" title="Copy to share" aria-label={`Copy ${snapshot.name}`} onClick={onCopy}><Copy size={14} /></button>
      <button type="button" className="snap-icon" title="Delete" aria-label={`Delete ${snapshot.name}`} disabled={busy} onClick={() => deleteWorkspaceSnapshot(snapshot.id)}><Trash2 size={14} /></button>
    </div>
  );
}

// Snapshots of this workspace, folded away until needed: each one keeps its
// sessions (device, folder, agent, branch) and layout, plus one kept up to
// date automatically. Restore previews what it will do first; snapshots are
// shared by copying and pasting them, with no text to handle.
function SnapshotSection({ workspaceId, workspaceName, hasSessions }: { workspaceId: string; workspaceName: string; hasSessions: boolean }) {
  const all = useWorkspaceSnapshots((s) => s.snapshots);
  const relaunching = useWorkspaceSnapshots((s) => s.relaunching);
  const snapshots = all.filter((snapshot) => snapshot.workspaceId === workspaceId);
  const [expanded, setExpanded] = useState(false);
  const [previewing, setPreviewing] = useState<string | null>(null);
  const [note, setNote] = useState<{ text: string; failed: boolean } | null>(null);
  useEffect(() => {
    if (!note || note.failed) return;
    const timer = window.setTimeout(() => setNote(null), 5000);
    return () => window.clearTimeout(timer);
  }, [note]);

  const save = () => {
    let snapshot: WorkspaceSnapshot | null;
    try {
      snapshot = saveWorkspaceSnapshot(workspaceId, `${workspaceName} · ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`);
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message : "Could not save the snapshot.", failed: true });
      return;
    }
    setNote(snapshot ? { text: `Saved ${snapshot.name}. Click its name to rename it.`, failed: false } : { text: "This workspace has no sessions to save.", failed: true });
  };
  const copy = async (snapshot: WorkspaceSnapshot) => {
    try {
      await navigator.clipboard.writeText(exportWorkspaceSnapshot(snapshot.id));
      setNote({ text: `Copied ${snapshot.name}. Use Paste snapshot in PzzaCode on any device.`, failed: false });
    } catch {
      setNote({ text: "Could not copy the snapshot.", failed: true });
    }
  };
  const paste = async () => {
    try {
      const snapshot = importWorkspaceSnapshot(await navigator.clipboard.readText(), workspaceId);
      setNote({ text: `Added ${snapshot.name} with ${snapshot.sessions.length} session${snapshot.sessions.length === 1 ? "" : "s"}.`, failed: false });
    } catch (error) {
      setNote({ text: error instanceof Error ? error.message.replace("Paste a snapshot copied from PzzaCode.", "Copy a snapshot in PzzaCode first, then paste it here.") : "Could not read the clipboard.", failed: true });
    }
  };

  return (
    <div className="field snap-section">
      <button type="button" className="snap-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <ChevronRight size={13} className="snap-chevron" aria-hidden="true" />
        Snapshots
        {snapshots.length ? <span className="field-hint">{snapshots.length}</span> : null}
      </button>
      {expanded ? (
        <div className="snap-body">
          <div className="snap-actions">
            <button type="button" className="btn btn-sm" onClick={save} disabled={!hasSessions} title={hasSessions ? "Save this workspace's sessions and layout" : "Add sessions to this workspace first"}>
              <Save size={13} strokeWidth={2} />
              Save current
            </button>
            <button type="button" className="btn btn-sm" onClick={() => void paste()} title="Add a snapshot copied in PzzaCode">
              <ClipboardPaste size={13} />
              Paste snapshot
            </button>
          </div>
          {snapshots.length ? (
            <div className="snap-list">
              {snapshots.map((snapshot) => (
                <div key={snapshot.id} className="snap-item">
                  <SnapshotRow snapshot={snapshot} open={previewing === snapshot.id} busy={relaunching !== null} onError={(text) => setNote({ text, failed: true })}
                    onToggle={() => { setNote(null); setPreviewing(previewing === snapshot.id ? null : snapshot.id); }} onCopy={() => void copy(snapshot)} />
                  {previewing === snapshot.id ? (
                    <SnapshotPreview snapshotId={snapshot.id} onCancel={() => setPreviewing(null)}
                      onDone={(result) => { setPreviewing(null); setNote({ text: relaunchSummary(result), failed: result.failed.length > 0 }); }} />
                  ) : null}
                </div>
              ))}
            </div>
          ) : <p className="snap-empty">Save this workspace to bring its sessions and layout back later. One is also kept automatically.</p>}
          {note ? <p className={`snap-note ${note.failed ? "is-error" : ""}`} role="status">{note.text}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
