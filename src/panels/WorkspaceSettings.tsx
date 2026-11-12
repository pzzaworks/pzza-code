import { LiveSessionIcon } from "../ui/LiveSessionIcon";
import { DeviceIcon } from "../ui/DeviceIcon";
import { useEffect, useId, useRef, useState } from "react";
import { Check, ChevronRight, ClipboardPaste, Copy, Eye, EyeOff, GitMerge, GitPullRequestCreateArrow, Loader2, RotateCcw, Save, ShieldCheck, Trash2 } from "lucide-react";
import { approveWorktreeSetup, fetchGitWorktrees, fetchWorktreeSetup, removeGitWorktree, saveWorktreeSetup, type GitMergeKind, type GitWorktree, type WorktreeSetup } from "../serverApi";
import { landWorktree, worktreeTask, type LandRequest, type LandResult } from "../worktreeLand";
import { useTasks } from "../tasks/taskStore";
import { openWebPage } from "../tileGit";
import { confirmAction } from "../ui/ConfirmDialog";
import { compactPath } from "../grid/compactPath";
import { AsyncButton } from "../ui/AsyncButton";
import { deleteWorkspaceSnapshot, exportWorkspaceSnapshot, importWorkspaceSnapshot, relaunchWorkspaceSnapshot, renameWorkspaceSnapshot, saveWorkspaceSnapshot, snapshotPreview, useWorkspaceSnapshots, type PreviewStatus, type RelaunchResult } from "../state/workspaceSnapshots";
import type { WorkspaceSnapshot } from "../workspaceSnapshots";
import { useStore } from "../state/store";
import { Modal } from "../ui/Modal";
import { sessionDisplayName } from "../sessionMeta";
import { DEFAULT_WORKSPACE_ID, WORKSPACE_COLORS, wsKeyOf } from "../workspaces";
import { deviceNameFor } from "../devices";
import { workspaceIcon } from "../workspaceIcons";
import { IconPicker } from "../ui/IconPicker";
import { AUTO_COLUMNS } from "../grid/autoLayout";
import { useAutoGrow } from "../ui/useAutoGrow";

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
              const base = t.session ?? t.name;
              const isHidden = hiddenTiles.includes(t.id);
              return (
                <div key={t.id} className={`ws-sess-row ${isHidden ? "hidden" : ""}`}>
                  <span className="ws-sess-icon">
                    <LiveSessionIcon session={base} window={t.window} host={t.host} />
                  </span>
                  <span className="ws-sess-name">{sessionDisplayName(t, tileTitles)}</span>
                  <span className="ws-sess-device" title="Running on">
                    <DeviceIcon host={t.host} size={11} />{deviceNameFor(devices, t.host)}
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
      <WorktreeSection workspaceId={id} onHandOff={close} />

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

// The folder a tile works in: its own absolute cwd, or the connected device's
// session list for tiles that live there.
function tileFolder(tile: { host?: string; cwd?: string; session?: string; name: string }, sessionPaths: ReadonlyMap<string, string>): string | undefined {
  if (tile.cwd?.startsWith("/")) return tile.cwd;
  return tile.host ? undefined : sessionPaths.get(tile.session ?? tile.name);
}

const inside = (folder: string, root: string) => folder === root || folder.startsWith(root.endsWith("/") ? root : `${root}/`);

interface WorktreeRepo { host: string; root: string; base: string | null; worktrees: GitWorktree[] }

// Extra Git worktrees of the repositories this workspace's tiles work in
// (New session → Worktree creates them), folded away like snapshots and only
// read when opened. A worktree can be removed when it is clean, unlocked and
// no tile works in it; a merged branch is deleted with it. Squash- and
// rebase-merged branches count as merged; the server re-proves that right
// before deleting them, and nothing unmerged is ever forced. A worktree's
// branch can be brought back as a pull request or merged into the base in the
// main checkout, and each repository's setup for new worktrees (files to copy,
// commands to run before the agent) is edited here.
const MERGE_LABELS: Record<GitMergeKind, string> = { ancestor: "Merged", squash: "Squash-merged", patch: "Rebase-merged" };

function WorktreeSection({ workspaceId, onHandOff }: { workspaceId: string; onHandOff: () => void }) {
  const tiles = useStore((s) => s.tiles);
  const sessionWs = useStore((s) => s.sessionWs);
  const allSessions = useStore((s) => s.allSessions);
  const connectionHost = useStore((s) => s.connection.host) ?? "";
  // Read so a row's task, and so its landing path, follows Tasks.
  useTasks((s) => s.tasks);
  const [expanded, setExpanded] = useState(false);
  const [repos, setRepos] = useState<WorktreeRepo[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [note, setNote] = useState<LandResult | null>(null);
  const [revision, setRevision] = useState(0);
  const [setupOpen, setSetupOpen] = useState<string | null>(null);

  const sessionPaths = new Map(allSessions.flatMap((session) => (session.path ? [[session.name, session.path] as const] : [])));
  const folderOf = (tile: (typeof tiles)[number]) => {
    const folder = tileFolder(tile, sessionPaths);
    return folder ? { host: tile.host ?? connectionHost, folder } : null;
  };
  const sources = [...new Map(tiles
    .filter((tile) => (sessionWs[wsKeyOf(tile)] ?? DEFAULT_WORKSPACE_ID) === workspaceId)
    .map(folderOf)
    .filter((entry): entry is { host: string; folder: string } => entry !== null)
    .map((entry) => [JSON.stringify([entry.host, entry.folder]), entry])).values()];
  const sourceKey = JSON.stringify(sources);
  // Read through a ref so the effect reruns only when the folders change.
  const sourcesRef = useRef(sources);
  sourcesRef.current = sources;
  // Every open tile, in any workspace, keeps its worktree from being removed.
  const openFolders = tiles.map(folderOf).filter((entry): entry is { host: string; folder: string } => entry !== null);

  useEffect(() => {
    if (!expanded) return;
    const controller = new AbortController();
    const list = sourcesRef.current;
    setLoading(true);
    void Promise.all(list.map(({ host, folder }) => fetchGitWorktrees(host, folder, controller.signal).then((result) => ({ host, result }), () => null)))
      .then((results) => {
        if (controller.signal.aborted) return;
        const byRepo = new Map<string, WorktreeRepo>();
        for (const entry of results) {
          const main = entry?.result.worktrees.find((worktree) => worktree.main);
          if (!entry || !main) continue;
          byRepo.set(JSON.stringify([entry.host, main.path]), { host: entry.host, root: main.path, base: entry.result.base, worktrees: entry.result.worktrees.filter((worktree) => !worktree.main) });
        }
        setRepos([...byRepo.values()]);
        setLoading(false);
      });
    return () => controller.abort();
  }, [expanded, sourceKey, revision]);
  useEffect(() => {
    // A pull request link stays until the next action.
    if (!note || note.failed || note.url) return;
    const timer = window.setTimeout(() => setNote(null), 5000);
    return () => window.clearTimeout(timer);
  }, [note]);

  if (!sources.length) return null;
  const blocker = (repo: WorktreeRepo, worktree: GitWorktree): string | null => {
    if (openFolders.some((open) => open.host === repo.host && inside(open.folder, worktree.path))) return "A tile is working in it";
    if (worktree.locked) return "Locked";
    if (worktree.dirty) return "Has uncommitted changes";
    return null;
  };
  const removable = (repos ?? []).flatMap((repo) => repo.worktrees.filter((worktree) => worktree.merged && !blocker(repo, worktree)).map((worktree) => ({ repo, worktree })));
  const remove = async (targets: Array<{ repo: WorktreeRepo; worktree: GitWorktree }>, confirmMessage: string) => {
    if (!targets.length || !(await confirmAction({ title: targets.length > 1 ? `Remove ${targets.length} worktrees?` : "Remove worktree?", message: confirmMessage, confirmLabel: "Remove", danger: true }))) return;
    setNote(null);
    const failures: string[] = [];
    let deleted = 0;
    for (const { repo, worktree } of targets) {
      setBusy(worktree.path);
      try {
        const result = await removeGitWorktree(repo.host, repo.root, worktree.path, worktree.merged && worktree.branch !== null);
        if (result.branchDeleted) deleted += 1;
      } catch (error) {
        failures.push(`${worktree.branch ?? compactPath(worktree.path)}: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    setBusy(null);
    const done = targets.length - failures.length;
    setNote(failures.length
      ? { text: failures.join(" · "), failed: true }
      : { text: `Removed ${done} worktree${done === 1 ? "" : "s"}${deleted ? ` and ${deleted} merged branch${deleted === 1 ? "" : "es"}` : ""}.`, failed: false });
    setRevision((value) => value + 1);
  };
  // Open PR and Merge: one at a time through the shared landing path, then the
  // list is read again. A task's worktree hands over to its task window.
  const land = async (key: string, request: LandRequest) => {
    setNote(null);
    setBusy(key);
    const handOff = worktreeTask(request.host, request.path) !== null;
    const result = await landWorktree(request, { interactive: true });
    setBusy(null);
    if (handOff) { onHandOff(); return; }
    if (!result) return;
    setNote(result);
    if (!result.failed) setRevision((value) => value + 1);
  };
  const count = repos?.reduce((sum, repo) => sum + repo.worktrees.length, 0);

  return (
    <div className="field snap-section">
      <button type="button" className="snap-head" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>
        <ChevronRight size={13} className="snap-chevron" aria-hidden="true" />
        Worktrees
        {count ? <span className="field-hint">{count}</span> : null}
      </button>
      {expanded ? (
        <div className="snap-body">
          {removable.length ? (
            <div className="snap-actions">
              <button type="button" className="btn btn-sm" disabled={busy !== null}
                onClick={() => void remove(removable, `Removes ${removable.length} merged worktree folder${removable.length === 1 ? "" : "s"} and their merged branches. Git refuses anything with uncommitted or unmerged work.`)}>
                <Trash2 size={13} />
                Clean up {removable.length} merged
              </button>
            </div>
          ) : null}
          {repos === null || (loading && !repos.length) ? <p className="snap-empty"><Loader2 size={12} className="sw-spin" /> Reading worktrees…</p> : <>
            {!repos.some((repo) => repo.worktrees.length) ? <p className="snap-empty">No extra worktrees. Sessions started with Worktree in New session show up here.</p> : null}
            {repos.map((repo) => {
              const repoKey = JSON.stringify([repo.host, repo.root]);
              return (
              <div key={repoKey} className="snap-list">
                {repos.length > 1 ? <span className="wt-repo" title={repo.root}>{compactPath(repo.root)}</span> : null}
                <button type="button" className="wt-setup-head" aria-expanded={setupOpen === repoKey} onClick={() => setSetupOpen(setupOpen === repoKey ? null : repoKey)}>
                  <ChevronRight size={12} className="snap-chevron" aria-hidden="true" />
                  Setup for new worktrees
                </button>
                {setupOpen === repoKey ? <WorktreeSetupEditor host={repo.host} root={repo.root} /> : null}
                {repo.worktrees.map((worktree) => {
                  const why = blocker(repo, worktree);
                  const merge = worktree.merged ? `${MERGE_LABELS[worktree.mergedBy ?? "ancestor"]} into ${repo.base ?? "the main branch"}` : "Not merged";
                  const label = worktree.branch ?? worktree.path;
                  // A task's worktree lands from its task window, which also offers to commit.
                  const task = worktreeTask(repo.host, worktree.path)?.task.title;
                  const viaTask = task ? `Part of the task "${task}": opens its land checks` : null;
                  const mergeWhy = !worktree.branch ? "it is on a detached HEAD" : !repo.base ? "the base branch is unknown"
                    : worktree.merged ? `it is already in ${repo.base}` : worktree.dirty && !task ? "it has uncommitted changes" : null;
                  const request = (kind: LandRequest["kind"]): LandRequest | null => (worktree.branch ? { kind, host: repo.host, path: worktree.path, branch: worktree.branch, base: repo.base } : null);
                  const start = (kind: LandRequest["kind"]) => {
                    const next = request(kind);
                    if (next) void land(`${kind}:${worktree.path}`, next);
                  };
                  return (
                    <div key={worktree.path} className="snap-row">
                      <div className="snap-row-copy">
                        <span className="snap-name wt-branch" title={worktree.branch ?? worktree.head}>{worktree.branch ?? `detached ${worktree.head.slice(0, 7)}`}</span>
                        <span className="snap-meta" title={[merge, why, worktree.path].filter(Boolean).join(" · ")}>
                          <span className={worktree.merged ? "wt-merged" : undefined}>{merge}</span>{why ? ` · ${why}` : ""} · {compactPath(worktree.path)}
                        </span>
                      </div>
                      <button type="button" className="snap-icon" disabled={!worktree.branch || busy !== null}
                        title={!worktree.branch ? "Can't open a pull request: it is on a detached HEAD" : viaTask ?? `Push ${worktree.branch} and open a pull request`}
                        aria-label={`Open pull request for ${label}`}
                        onClick={() => start("pr")}>
                        {busy === `pr:${worktree.path}` ? <Loader2 size={14} className="sw-spin" /> : <GitPullRequestCreateArrow size={14} />}
                      </button>
                      <button type="button" className="snap-icon" disabled={mergeWhy !== null || busy !== null}
                        title={mergeWhy ? `Can't merge: ${mergeWhy}` : viaTask ?? `Merge into ${repo.base} in the main checkout`}
                        aria-label={`Merge ${label} into ${repo.base ?? "the base branch"}`}
                        onClick={() => start("merge")}>
                        {busy === `merge:${worktree.path}` ? <Loader2 size={14} className="sw-spin" /> : <GitMerge size={14} />}
                      </button>
                      <button type="button" className="snap-icon" disabled={why !== null || busy !== null}
                        title={why ? `Can't remove: ${why.toLowerCase()}` : worktree.merged ? "Remove the folder and its merged branch" : "Remove the folder (the unmerged branch is kept)"}
                        aria-label={`Remove worktree ${worktree.branch ?? worktree.path}`}
                        onClick={() => void remove([{ repo, worktree }], `Removes the folder ${worktree.path}${worktree.merged && worktree.branch ? ` and deletes the merged branch ${worktree.branch}` : worktree.branch ? `. The branch ${worktree.branch} is not merged and is kept` : ""}.`)}>
                        {busy === worktree.path ? <Loader2 size={14} className="sw-spin" /> : <Trash2 size={14} />}
                      </button>
                    </div>
                  );
                })}
              </div>
              );
            })}
          </>}
          {note ? <p className={`snap-note ${note.failed ? "is-error" : ""}`} role="status">{note.text}{note.url ? <>{" "}<button type="button" className="wt-link" onClick={() => { if (note.url) openWebPage(note.url); }}>{note.url}</button></> : null}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

const setupLines = (text: string) => text.split("\n").map((line) => line.trim()).filter(Boolean);

// A repository's .pzzacode/worktree.json, kept in its main checkout: untracked
// files to copy into each new worktree and commands typed into its terminal
// before the agent starts. Saving approves the commands on this device; a
// file changed elsewhere (a pull, a teammate) needs an explicit approval first.
function WorktreeSetupEditor({ host, root }: { host: string; root: string }) {
  const [setup, setSetup] = useState<WorktreeSetup | null>(null);
  const [copyText, setCopyText] = useState("");
  const [runText, setRunText] = useState("");
  const copyRef = useRef<HTMLTextAreaElement>(null);
  const runRef = useRef<HTMLTextAreaElement>(null);
  useAutoGrow(copyRef, copyText, { minLines: 3, maxLines: 8 });
  useAutoGrow(runRef, runText, { minLines: 2, maxLines: 8 });
  const [status, setStatus] = useState<{ text: string; failed: boolean } | null>(null);
  const [saving, setSaving] = useState(false);
  const id = useId();
  const show = (value: WorktreeSetup) => { setSetup(value); setCopyText(value.copy.join("\n")); setRunText(value.run.join("\n")); };
  const fail = (error: unknown, fallback: string) => setStatus({ text: error instanceof Error ? error.message : fallback, failed: true });

  useEffect(() => {
    const controller = new AbortController();
    fetchWorktreeSetup(host, root, controller.signal).then(show, (error: unknown) => { if (!controller.signal.aborted) fail(error, "Worktree setup unavailable"); });
    return () => controller.abort();
  }, [host, root]);

  if (!setup) {
    return status ? <p className="snap-note is-error" role="status">{status.text}</p>
      : <p className="snap-empty"><Loader2 size={12} className="sw-spin" /> Reading setup…</p>;
  }
  const copy = setupLines(copyText);
  const run = setupLines(runText);
  const changed = copy.join("\n") !== setup.copy.join("\n") || run.join("\n") !== setup.run.join("\n");
  const pending = setup.run.length > 0 && !setup.approved && !setup.error && !changed;
  const save = async () => {
    setSaving(true);
    setStatus(null);
    try {
      // Untouched default patterns stay implicit, so the file only lists what was chosen.
      const saved = await saveWorktreeSetup(host, root, setup.defaultCopy && copy.join("\n") === setup.copy.join("\n") ? null : copy, run);
      show(saved);
      setStatus({ text: `Saved ${saved.file} in the main checkout. Commit it to share this setup.`, failed: false });
    } catch (error) {
      fail(error, "Could not save the worktree setup");
    } finally {
      setSaving(false);
    }
  };
  const approve = async () => {
    setSaving(true);
    setStatus(null);
    try {
      show(await approveWorktreeSetup(host, root, setup.run));
      setStatus({ text: "Approved. New worktrees run these commands before the agent.", failed: false });
    } catch (error) {
      fail(error, "Could not approve the setup commands");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="wt-setup" role="group" aria-label="Setup for new worktrees">
      <p className="snap-empty">
        {setup.exists ? <>From <code>{setup.file}</code> in the main checkout.</> : <>No <code>{setup.file}</code> yet: ignored <code>.env*</code> files at the repository root are copied.</>}
      </p>
      {setup.error ? <p className="snap-note is-error">{setup.error}</p> : null}
      <label className="wt-setup-label" htmlFor={`${id}-copy`}>Copy from the main checkout <span className="field-hint">untracked files, one glob per line</span></label>
      <textarea ref={copyRef} id={`${id}-copy`} className="field-input wt-setup-input" rows={3} spellCheck={false} value={copyText} onChange={(event) => setCopyText(event.target.value)} />
      <label className="wt-setup-label" htmlFor={`${id}-run`}>Run before the agent <span className="field-hint">one command per line, shown in the terminal</span></label>
      <textarea ref={runRef} id={`${id}-run`} className="field-input wt-setup-input" rows={2} spellCheck={false} placeholder="npm install" value={runText} onChange={(event) => setRunText(event.target.value)} />
      {pending ? <p className="snap-note wt-setup-pending">These commands are not approved on this device yet, so new worktrees skip them.</p> : null}
      <div className="snap-actions">
        {pending ? (
          <button type="button" className="btn btn-sm" disabled={saving} onClick={() => void approve()}>
            <ShieldCheck size={13} />
            Approve commands
          </button>
        ) : null}
        <button type="button" className="btn btn-sm" disabled={!changed || saving} onClick={() => void save()}>
          {saving ? <Loader2 size={13} className="sw-spin" /> : <Save size={13} />}
          Save setup
        </button>
      </div>
      {status ? <p className={`snap-note ${status.failed ? "is-error" : ""}`} role="status">{status.text}</p> : null}
    </div>
  );
}
