import { activityAgent, LiveSessionIcon, runningAgent, useSessionActivity } from "../ui/LiveSessionIcon";
import { useDelayedLoading } from "../ui/useDelayedLoading";
import { DeviceIcon } from "../ui/DeviceIcon";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { useShallow } from "zustand/react/shallow";
import { createPortal } from "react-dom";
import { MotionConfig, motion } from "framer-motion";
import {
  Copy,
  EyeOff,
  FileCode,
  FolderInput,
  FolderPlus,
  ArrowDown,
  ArrowUp,
  CircleCheck,
  CircleDashed,
  CircleX,
  GitBranch,
  GitMerge,
  GitPullRequest,
  GitPullRequestCreateArrow,
  GitPullRequestDraft,
  Loader2,
  Maximize2,
  Minimize2,
  Mic,
  Plus,
  Send,
  TriangleAlert,
  X,
  type LucideIcon,
} from "lucide-react";
import { useStore } from "../state/store";
import { deviceForHost, deviceNameFor } from "../devices";
import { Modal } from "../ui/Modal";
import { copyToClipboard, Terminal } from "../terminal/Terminal";
import { TileCodePanel } from "../lazySurfaces";
import { CodeSplitHandle } from "./CodeSplitHandle";
import { duplicateSession, fetchSessionPath, killSession, type GitFolderStatus, type GitRemoteInfo } from "../serverApi";
import { openWebPage } from "../tileGit";
import { registerAppControlHandler, registerAppControlState } from "../appControlRuntime";
import { confirmEditorDiscard, hasUnsavedEditors } from "../editorChanges";
import { confirmAction } from "../ui/ConfirmDialog";
import { attachCommand, sessionConnection } from "../connection";
import {
  sessionDisplayName,
  sessionIcon,
  SESSION_DND,
  SESSION_TILE_DND,
  type TileStatus,
} from "../sessionMeta";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, wsKeyOf } from "../workspaces";
import { ctrlBadge, digitFromCode, IS_MAC } from "../shortcuts";
import { useDictation } from "../state/dictation";
import { DictationButton } from "../ui/Dictation";
import { useExclusiveMenu } from "../ui/menuBus";
import { unreadTileIds, useNotifications } from "../state/notifications";
import { useSessionRefresh } from "../state/sessionRefresh";
import { STATUS_BAR_ID, type BarItemId } from "../barItems";
import { MAX_TILE_ROWS, TileResizeHandles } from "./TileResizeHandles";
import { useGitStatus } from "./gitStatus";
import { sendFailingChecks, useGitRemote, useSharedBranch } from "./gitRemote";
import { useTileEdges } from "./tileEdges";
import { arrangeTiles, useCanvasSize } from "./autoLayout";
import { setLayoutPreview } from "./layoutPreview";
import { compactPath } from "./compactPath";
import { BroadcastBar, useBroadcastPresence } from "./BroadcastBar";
import { CheckpointsChip, TileCheckpoints } from "./Checkpoints";
import { moveAgentToWorktree } from "../sessionActions";
import { landWorktree, useWorktreeInfo, useWorktreeTaskTitle, type LandKind, type LandResult } from "../worktreeLand";
import { installFolderDrops, useFolderDrag } from "../terminal/folderDrop";

const HEADER_ACTIONS = [
  { id: "mic", Icon: Mic },
  { id: "code", Icon: FileCode },
  { id: "move", Icon: FolderInput },
  { id: "duplicate", Icon: Copy },
  { id: "fullscreen", Icon: Maximize2 },
  { id: "hide", Icon: EyeOff },
  { id: "close", Icon: X },
] as const satisfies ReadonlyArray<{ id: string; Icon: LucideIcon }>;
type HeaderAction = typeof HEADER_ACTIONS[number]["id"];
const PreviewSessionIcon = sessionIcon();

// Every header button stays visible: narrow tiles make them compact, group
// them, and move the whole row under the title (container queries on .tile).
function SessionHeader({ status, icon, title, shortcut, device, actions, ...events }: Omit<HTMLAttributes<HTMLDivElement>, "title"> & {
  status: TileStatus;
  icon: ReactNode;
  title: ReactNode;
  shortcut?: number;
  device: { host?: string; name: string };
  actions?: Record<HeaderAction, ReactNode>;
}) {
  // Items can be turned off in Settings; the title and Close always stay.
  const hidden: readonly string[] = useStore((s) => s.hiddenBarItems);
  const shown = (id: HeaderAction | "device" | "shortcut") => id === "close" || !hidden.includes(`header:${id}`);
  return <div className="tile-head" {...events}>
    <span className={`stat stat-${status}`} title={status} />
    <span className="tile-icon">{icon}</span>
    {title}
    {shortcut && shown("shortcut") ? <kbd className="kbd tile-kbd" title="Activate">{ctrlBadge(shortcut)}</kbd> : null}
    {shown("device") ? <span className="tile-device" title={`Running on ${device.name}`}>
      <DeviceIcon host={device.host} size={11} /><span className="tile-device-name">{device.name}</span>
    </span> : null}
    <div className="tile-head-spacer" />
    <div className="tile-actions">
      {HEADER_ACTIONS.filter(({ id }) => shown(id)).map(({ id, Icon }) => <span key={id} className={`tile-action tile-action-${id}`}>
        {actions ? actions[id] : <span className={`tile-btn ${id === "close" ? "tile-btn-danger" : ""}`}><Icon size={id === "close" ? 14 : 13} /></span>}
      </span>)}
    </div>
  </div>;
}

// "16:33" for a session started today, "16:33 06 Nov" otherwise.
function startedLabel(createdAt: number): string {
  const date = new Date(createdAt);
  const pad = (value: number) => String(value).padStart(2, "0");
  const time = `${pad(date.getHours())}:${pad(date.getMinutes())}`;
  return date.toDateString() === new Date().toDateString()
    ? time
    : `${time} ${pad(date.getDate())} ${date.toLocaleString(undefined, { month: "short" })}`;
}

function gitTitle(git: GitFolderStatus): string {
  const parts = [git.detached ? `Detached at ${git.branch}` : `Branch ${git.branch}`, git.dirty ? "uncommitted changes" : "clean"];
  if (git.ahead !== null && git.behind !== null) parts.push(`${git.ahead} to push, ${git.behind} to pull`);
  return parts.join(" · ");
}

const CHECKS: Record<"passing" | "failing" | "pending", { icon: LucideIcon; label: string }> = {
  passing: { icon: CircleCheck, label: "checks passing" },
  failing: { icon: CircleX, label: "checks failing" },
  pending: { icon: CircleDashed, label: "checks running" },
};

// The footer's Git item: the branch with commits to push (↑) and pull (↓),
// its pull request and checks when gh knows them, and a warning when another
// tile's agent works on the same branch of the same checkout (a click on it
// offers to start this tile's agent in its own worktree). The dirty dot
// opens the changed files in the tile's editor; the branch opens its pull
// request, or the branch page, in the browser. Failing checks get a button
// that sends their logs to the tile's agent (disabled without one).
function FooterGit({ git, remote, shared, onReview, onIsolate, isolating, onSendChecks, sendingChecks }: {
  git: GitFolderStatus; remote: GitRemoteInfo | null | undefined; shared: string[]; onReview: () => void;
  onIsolate?: () => void; isolating: boolean; onSendChecks?: () => void; sendingChecks: boolean;
}) {
  const pr = remote?.pr && remote.pr.state !== "CLOSED" ? remote.pr : null;
  const target = pr?.url ?? remote?.web ?? null;
  const check = pr && pr.state === "OPEN" && pr.checks !== "none" ? CHECKS[pr.checks] : null;
  const PrIcon = pr?.state === "MERGED" ? GitMerge : pr?.draft ? GitPullRequestDraft : GitPullRequest;
  const prLabel = pr ? `Pull request #${pr.number}${pr.state === "MERGED" ? " · merged" : pr.draft ? " · draft" : ""}${check ? ` · ${check.label}` : ""}` : "";
  const title = [gitTitle(git), prLabel, target ? (pr ? "Click to open the pull request" : "Click to open the branch in the browser") : ""].filter(Boolean).join("\n");
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  return <span className="tile-strip-git">
    {git.dirty
      ? <button type="button" className="tile-strip-git-icon tile-strip-review" title="Uncommitted changes · click to review them" aria-label="Review uncommitted changes" onMouseDown={stop} onClick={onReview}>
        <GitBranch size={11} aria-hidden="true" /><span className="tile-strip-dirty" />
      </button>
      : <span className="tile-strip-git-icon"><GitBranch size={11} aria-hidden="true" /></span>}
    <button type="button" className="tile-strip-branch-btn" title={title} disabled={!target} onMouseDown={stop} onClick={() => { if (target) openWebPage(target); }}>
      <code className="tile-strip-branch">{git.branch}</code>
      {git.ahead ? <span className="tile-strip-ab" aria-label={`${git.ahead} to push`}><ArrowUp size={9} strokeWidth={2.4} aria-hidden="true" />{git.ahead}</span> : null}
      {git.behind ? <span className="tile-strip-ab" aria-label={`${git.behind} to pull`}><ArrowDown size={9} strokeWidth={2.4} aria-hidden="true" />{git.behind}</span> : null}
      {pr ? <span className={`tile-strip-pr ${pr.state === "MERGED" ? "is-merged" : ""}`} aria-label={prLabel}>
        <PrIcon size={10} aria-hidden="true" />{pr.number}
        {check ? <check.icon size={10} className={`tile-strip-check is-${pr.checks}`} aria-hidden="true" /> : null}
      </span> : null}
    </button>
    {pr && check && pr.checks === "failing" ? <button type="button" className="tile-strip-ci-send" aria-label="Send failing checks to agent"
      title={onSendChecks ? "Send failing checks to agent\nSaves the failed CI logs to a file and asks this tile's agent to fix them" : "Send failing checks to agent\nNo agent running in this tile"}
      disabled={!onSendChecks || sendingChecks} aria-busy={sendingChecks || undefined} onMouseDown={stop} onClick={onSendChecks}>
      {sendingChecks ? <Loader2 size={11} className="async-spinner" aria-hidden="true" /> : <Send size={10} aria-hidden="true" />}
    </button> : null}
    {shared.length ? <button type="button" className="tile-strip-shared" aria-label="Another agent is on this branch. Move this session to its own worktree"
      title={`Also on ${git.branch}: ${shared.join(", ")}.\nTwo agents on one branch can overwrite each other's work. Click to start this tile's agent in its own worktree; this session keeps running.`}
      disabled={!onIsolate || isolating} aria-busy={isolating || undefined} onMouseDown={stop} onClick={onIsolate}>
      {isolating ? <Loader2 size={11} className="async-spinner" aria-hidden="true" /> : <TriangleAlert size={11} aria-hidden="true" />}
    </button> : null}
  </span>;
}

// Footer actions for a tile working in a linked worktree (not the main
// checkout): open a pull request while it has none, and merge it into the
// base in the main checkout. Both take the shared landing path: a task's
// worktree opens that task's land checks, any other passes the generic
// checks (agent idle, no approval waiting, nothing uncommitted) first.
// Success shows in place, as the folder's Copied does: the button turns into
// a check for a moment, and a new pull request appears in the branch chip.
// Only a failure opens a dialog.
const LANDED_MS = 1400;
function FooterWorktree({ host, path, git, hasPullRequest }: { host: string; path: string; git: GitFolderStatus; hasPullRequest: boolean }) {
  const info = useWorktreeInfo(host, path, git.detached ? undefined : git.branch);
  const task = useWorktreeTaskTitle(host, path);
  const [busy, setBusy] = useState<LandKind | null>(null);
  const [landed, setLanded] = useState<LandKind | null>(null);
  const [failure, setFailure] = useState<{ kind: LandKind; outcome: LandResult } | null>(null);
  useEffect(() => {
    if (!landed) return;
    const timer = setTimeout(() => setLanded(null), LANDED_MS);
    return () => clearTimeout(timer);
  }, [landed]);
  if (!info?.linked || !info.branch || info.branch !== git.branch) return null;
  const { branch, base } = info;
  const start = (kind: LandKind) => {
    if (busy) return;
    setBusy(kind);
    setLanded(null);
    void landWorktree({ kind, host, path, branch, base }, { interactive: true })
      .then((outcome) => {
        if (!outcome) return;
        if (outcome.failed) setFailure({ kind, outcome });
        else setLanded(kind);
      })
      .finally(() => setBusy(null));
  };
  const stop = (event: { stopPropagation(): void }) => event.stopPropagation();
  const icon = (kind: LandKind, Icon: LucideIcon) => busy === kind ? <Loader2 size={11} className="async-spinner" aria-hidden="true" />
    : landed === kind ? <CircleCheck size={11} className="tile-strip-check is-passing" aria-hidden="true" />
      : <Icon size={11} aria-hidden="true" />;
  // A task's worktree lands from its task, behind the task's own checks.
  const viaTask = task ? `\nPart of the task "${task}": opens its land checks` : "";
  const prLabel = landed === "pr" ? "Pull request opened" : "Open pull request";
  const mergeLabel = landed === "merge" ? `Merged into ${base}` : `Merge into ${base}`;
  const url = failure?.outcome.url;
  return <span className="tile-strip-wt">
    {hasPullRequest ? null : <button type="button" className="tile-strip-wt-action" aria-label={prLabel} disabled={busy !== null} aria-busy={busy === "pr" || undefined}
      title={`${prLabel}${viaTask || `\nPushes ${branch} and runs gh pr create --fill`}`} onMouseDown={stop} onClick={() => start("pr")}>
      {icon("pr", GitPullRequestCreateArrow)}
    </button>}
    {base ? <button type="button" className="tile-strip-wt-action" aria-label={mergeLabel} disabled={(git.dirty && !task) || busy !== null} aria-busy={busy === "merge" || undefined}
      title={viaTask ? `${mergeLabel}${viaTask}` : git.dirty ? `${mergeLabel}\nCommit or discard this worktree's changes first` : `${mergeLabel}\nMerges ${branch} in the main checkout after a confirmation`}
      onMouseDown={stop} onClick={() => start("merge")}>
      {icon("merge", GitMerge)}
    </button> : null}
    <Modal open={failure !== null} onClose={() => setFailure(null)} title={failure?.kind === "merge" ? "Merge worktree" : "Pull request"} size="sm">
      <p role="alert" className="tile-strip-wt-result">
        {failure?.outcome.text}
        {url ? <>{" "}<button type="button" className="wt-link" onClick={() => openWebPage(url)}>{url}</button></> : null}
      </p>
    </Modal>
  </span>;
}

// The footer folder: shortened ("~/…/parent/folder"), full path on hover, and
// a click (or Enter/Space) copies the full path, confirmed in place.
function FooterPath({ path }: { path: string }) {
  const [copied, setCopied] = useState<"done" | "failed" | null>(null);
  useEffect(() => {
    if (!copied) return;
    const timer = setTimeout(() => setCopied(null), 1400);
    return () => clearTimeout(timer);
  }, [copied]);
  return <button
    type="button"
    className={`tile-strip-path ${copied ? "is-copied" : ""}`}
    title={`${path}\nClick to copy`}
    aria-label={`Copy folder path ${path}`}
    onMouseDown={(event) => event.stopPropagation()}
    onClick={() => void copyToClipboard(path).then((ok) => setCopied(ok ? "done" : "failed"))}
  >
    <span aria-live="polite">{copied === "done" ? "Copied" : copied === "failed" ? "Copy failed" : compactPath(path)}</span>
  </button>;
}

// One-line footer carrying what tmux's status line used to show. Left: what is
// running now (command, agent and mode), the tmux session and its Git branch;
// right: the folder and when the session started. Every value comes from live
// data; missing ones are omitted. Git is polled while the tile is visible, and
// at a slow background rate while a hidden tile runs an agent, so its branch
// claim still reaches the shared-branch warning of tiles in other workspaces.
function TileStatusStrip({ tileId, session, window: windowIndex, host, gitHost, visible, path, createdAt, workspaceId, workspace }: {
  tileId: string; session: string; window?: number; host?: string; gitHost: string; visible: boolean; path?: string; createdAt?: number | null;
  workspaceId: string; workspace: string;
}) {
  const activity = useSessionActivity(session, windowIndex, host);
  // Only tiles running a coding agent claim their branch; a plain shell in
  // the same folder is not a conflict.
  const runningAgent = activityAgent(activity);
  const git = useGitStatus(gitHost, path, visible ? "visible" : runningAgent ? "background" : "off");
  const branch = git && !git.detached ? git.branch : undefined;
  const remote = useGitRemote(gitHost, path, branch, visible);
  const label = windowIndex === undefined ? session : `${session}:${windowIndex}`;
  const shared = useSharedBranch(tileId, runningAgent && branch && path ? { host: gitHost, path, branch, label, workspaceId, workspace } : null);
  const [isolating, setIsolating] = useState(false);
  const [isolateError, setIsolateError] = useState<string | null>(null);
  const isolate = runningAgent && path ? () => {
    if (isolating) return;
    setIsolating(true);
    setIsolateError(null);
    moveAgentToWorktree({ tileId, session, host, cwd: path, provider: runningAgent })
      .catch((error: unknown) => setIsolateError(error instanceof Error ? error.message : "Could not start the worktree session."))
      .finally(() => setIsolating(false));
  } : undefined;
  const [sendingChecks, setSendingChecks] = useState(false);
  const [checksError, setChecksError] = useState<string | null>(null);
  const sendChecks = runningAgent && path ? () => {
    if (sendingChecks) return;
    setSendingChecks(true);
    setChecksError(null);
    sendFailingChecks(tileId, gitHost, path)
      .catch((error: unknown) => setChecksError(error instanceof Error ? error.message : "Could not send the failing checks."))
      .finally(() => setSendingChecks(false));
  } : undefined;
  // Status bar items can be turned off in Settings > Appearance.
  const hiddenBarItems = useStore((s) => s.hiddenBarItems);
  const shown = (id: BarItemId) => !hiddenBarItems.includes(id);
  return <div className="tile-strip">
    {shown("status:session") ? <span className="tile-strip-target" title="tmux session">{windowIndex === undefined ? session : `${session}:${windowIndex}`}</span> : null}
    {git && shown("status:git") ? <FooterGit git={git} remote={remote} shared={shared} onReview={() => { if (path) useStore.getState().openTileChanges(tileId, path); }} onIsolate={isolate} isolating={isolating}
      onSendChecks={sendChecks} sendingChecks={sendingChecks} /> : null}
    {git && path && shown("status:git") ? <CheckpointsChip tileId={tileId} host={gitHost} path={path} visible={visible} /> : null}
    {git && path && shown("status:worktree") ? <FooterWorktree host={gitHost} path={path} git={git} hasPullRequest={!!remote?.pr && remote.pr.state !== "CLOSED"} /> : null}
    {path && shown("status:path") ? <FooterPath path={path} /> : null}
    {createdAt && shown("status:started") ? <time className="tile-strip-time" dateTime={new Date(createdAt).toISOString()} title={`Session started ${new Date(createdAt).toLocaleString()}`}>
      started {startedLabel(createdAt)}
    </time> : null}
    <Modal open={isolateError !== null} onClose={() => setIsolateError(null)} title="Move to a worktree" size="sm">
      <p role="alert">{isolateError}</p>
    </Modal>
    <Modal open={checksError !== null} onClose={() => setChecksError(null)} title="Send failing checks" size="sm">
      <p role="alert">{checksError}</p>
    </Modal>
  </div>;
}

// A tile dragged by its header from slot `from` of the visible order, shown at slot `to`.
interface TileDrag { id: string; from: number; to: number }
// Layout boxes of the visible tiles when the drag started, relative to the
// grid; the pointer picks a slot from these, so the reflowing preview never
// moves the target out from under it.
type Slot = { left: number; top: number; right: number; bottom: number };

function moveItem<T>(items: readonly T[], from: number, to: number): T[] {
  const next = [...items];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

function tileSlots(grid: HTMLElement, ids: readonly string[]): Slot[] {
  return ids.map((id) => {
    const tile = grid.querySelector<HTMLElement>(`:scope > [data-tile-id="${CSS.escape(id)}"]`);
    if (!tile) return { left: 0, top: 0, right: 0, bottom: 0 };
    const left = tile.offsetLeft - (tile.offsetParent === grid ? 0 : grid.offsetLeft);
    const top = tile.offsetTop - (tile.offsetParent === grid ? 0 : grid.offsetTop);
    return { left, top, right: left + tile.offsetWidth, bottom: top + tile.offsetHeight };
  });
}

// The slot under a grid point; past the last tile counts as the last slot,
// and the gaps between tiles keep the current choice (null).
function slotAt(slots: readonly Slot[], x: number, y: number): number | null {
  const hit = slots.findIndex((slot) => x >= slot.left && x < slot.right && y >= slot.top && y < slot.bottom);
  if (hit >= 0) return hit;
  const last = slots.at(-1);
  if (last && (y >= last.bottom || (y >= last.top && x >= last.right))) return slots.length - 1;
  return null;
}

const ARROW_STEPS: Record<string, readonly [number, number]> = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
// Pixels from the canvas edge where a drag starts scrolling, and the top speed.
const AUTO_SCROLL_EDGE = 56;
const AUTO_SCROLL_SPEED = 18;
// Tiles glide to new places on one spring (transform only, never their size).
const TILE_SPRING = { type: "spring", stiffness: 420, damping: 38, mass: 0.9 } as const;

function canvasBox(): CSSProperties {
  const rect = document.querySelector(".canvas")?.getBoundingClientRect();
  return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : { inset: 0 };
}

// Esc restores a maximized tile only when nothing else owns the key: a
// terminal, an editor, a text field, an open dialog or an open menu.
function escapeIsFree(event: KeyboardEvent): boolean {
  if (event.key !== "Escape" || event.defaultPrevented || event.isComposing || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  const target = event.target instanceof Element ? event.target : null;
  if (target?.closest(".xterm, .cm-editor, input, textarea, select, [contenteditable='true'], [role='dialog'], [role='alertdialog'], [role='menu']")) return false;
  // Dropdown panels stay mounted while closed, so only a rendered menu counts.
  return !document.querySelector(".pzza-portal, .modal") && ![...document.querySelectorAll(".menu")].some((menu) => menu.getClientRects().length > 0);
}

// Uniform N-column grid, filtered to the active workspace. One tile can be
// maximized (animated). Tiles reorder by dragging their header onto another
// tile, or move to a workspace by dragging onto a top-bar tab.
export function Canvas({ onNewSession }: { onNewSession: () => void }) {
  const tiles = useStore((s) => s.tiles);
  const allSessions = useStore((s) => s.allSessions);
  const workspaceColumns = useStore((s) => s.workspaceColumns);
  const defaultColumns = useStore((s) => s.defaultColumns);
  const activeId = useStore((s) => s.activeId);
  const closeTile = useStore((s) => s.closeTile);
  const connection = useStore((s) => s.connection);
  // Local terminals step aside while their tmux server restarts or lost
  // sessions are restored, then attach again (a new key per refresh). At
  // launch they wait for the check for lost sessions, so attaching cannot
  // create empty sessions under their names first.
  const refreshingLocal = useSessionRefresh((s) => s.running);
  const restoringLocal = useSessionRefresh((s) => s.restoring);
  const launchCheckLocal = useSessionRefresh((s) => s.pending);
  const localGeneration = useSessionRefresh((s) => s.generation);
  const sessionWs = useStore((s) => s.sessionWs);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const workspaces = useStore((s) => s.workspaces);
  const statusBarShown = useStore((s) => !s.hiddenBarItems.includes(STATUS_BAR_ID));
  const hiddenTiles = useStore((s) => s.hiddenTiles);
  const hideTile = useStore((s) => s.hideTile);
  const tileSpan = useStore((s) => s.tileSpan);
  const setTileSpan = useStore((s) => s.setTileSpan);
  const clearTileSpan = useStore((s) => s.clearTileSpan);
  const tileTitles = useStore((s) => s.tileTitles);
  const renameTile = useStore((s) => s.renameTile);
  const devices = useStore((s) => s.devices);
  const tileCode = useStore((s) => s.tileCode);
  const toggleTileCode = useStore((s) => s.toggleTileCode);
  const setTileCodeRoot = useStore((s) => s.setTileCodeRoot);
  const recordingTileId = useDictation((state) => state.recording?.tileId);
  // Tiles with unread terminal notifications get a solid green dot; everything
  // else stays grey. Viewing the tile marks its notifications read, which also
  // clears the workspace tab dot when no other unread remains there.
  const unreadTiles = useNotifications(useShallow(unreadTileIds));
  const unreadTileSet = useMemo(() => new Set(unreadTiles), [unreadTiles]);
  const activateTile = useCallback((id: string) => {
    useStore.getState().setActive(id);
    useNotifications.getState().readTile(id);
  }, []);
  useEffect(() => {
    if (activeId) useNotifications.getState().readTile(activeId);
  }, [activeId]);
  useEffect(() => {
    if (!recordingTileId) return;
    const source = tiles.find((entry) => entry.id === recordingTileId);
    // Dictation into something that is not a tile (the broadcast composer, Quick
    // Chat) is that surface's own; a closed tile already cancels it by
    // unregistering its target.
    if (!source) return;
    if (activeId !== recordingTileId || hiddenTiles.includes(recordingTileId) ||
        (activeWorkspaceId !== ALL_WORKSPACE_ID && (sessionWs[wsKeyOf(source)] ?? DEFAULT_WORKSPACE_ID) !== activeWorkspaceId)) {
      void useDictation.getState().cancel();
    }
  }, [recordingTileId, activeId, hiddenTiles, activeWorkspaceId, sessionWs, tiles]);

  // Columns are per-workspace; the active workspace decides the grid.
  const columns = workspaceColumns[activeWorkspaceId] ?? defaultColumns;

  // A tile's badge names the device it actually runs on.
  const tileDevice = (host?: string): string => deviceNameFor(devices, host);

  const [closing, setClosing] = useState<string | null>(null);
  const [terminating, setTerminating] = useState(false);
  const [closeError, setCloseError] = useState<string | null>(null);
  const [duplicating, setDuplicating] = useState<string | null>(null);
  const showDuplicateSpinner = useDelayedLoading(duplicating !== null);
  const duplicationPending = useRef(false);
  // Spacing 0: tiles drop their borders where they meet the window edges.
  const gridRef = useRef<HTMLDivElement>(null);
  const tight = useStore((s) => s.spacing === 0);
  useTileEdges(gridRef, tight);
  const [duplicateError, setDuplicateError] = useState<string | null>(null);
  // "Move to workspace" popup, opened from a tile's toolbar button.
  const assignSession = useStore((s) => s.assignSession);
  const [moveFor, setMoveFor] = useState<{ id: string; x: number; y: number } | null>(null);
  const closeTileMenus = useCallback(() => setMoveFor(null), []);
  const tileMenuOpen = moveFor !== null;
  useExclusiveMenu("tile-menu", tileMenuOpen, closeTileMenus);
  useEffect(() => {
    if (!tileMenuOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape") closeTileMenus(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [tileMenuOpen, closeTileMenus]);

  // Only a failure shows on the dot (output activity does not), so the
  // active/idle flips of every output burst are folded to "idle" here and
  // never re-render the grid.
  const [statuses, setStatuses] = useState<Record<string, TileStatus>>({});
  const shownStatuses = useRef(statuses);
  const setStatus = useCallback((id: string, s: TileStatus) => {
    const shown: TileStatus = s === "failed" ? "failed" : "idle";
    if ((shownStatuses.current[id] ?? "idle") === shown) return;
    shownStatuses.current = { ...shownStatuses.current, [id]: shown };
    setStatuses(shownStatuses.current);
  }, []);

  // One maximized tile fills the canvas; the rest stay mounted but hidden.
  const [fullId, setFullId] = useState<string | null>(null);
  useEffect(() => {
    // Programmatic tile focus must reveal the target even if another tile was
    // maximized locally in the canvas.
    if (activeId && fullId && activeId !== fullId) setFullId(null);
  }, [activeId, fullId]);
  const [renaming, setRenaming] = useState<{ id: string; val: string } | null>(null);
  // A header drag previews the drop: the dragged tile moves to slot `to` of
  // the visible order and the rest reflow around it until the drop commits.
  const [drag, setDrag] = useState<TileDrag | null>(null);
  const dragRef = useRef<TileDrag | null>(null);
  const updateDrag = useCallback((next: TileDrag | null) => {
    dragRef.current = next;
    setDrag((current) => (current?.id === next?.id && current?.to === next?.to ? current : next));
  }, []);
  const dragId = drag?.id ?? null;

  const wsTiles = tiles.filter(
    (t) =>
      (activeWorkspaceId === ALL_WORKSPACE_ID ||
        (sessionWs[wsKeyOf(t)] ?? DEFAULT_WORKSPACE_ID) === activeWorkspaceId) &&
      !hiddenTiles.includes(t.id) &&
      // Sessions on a disabled device stay running there but leave the grid.
      !(t.host && deviceForHost(devices, t.host)?.disabled),
  );

  // The grid runs at half resolution: every column unit is at least two CSS
  // grid tracks and every row unit two row tracks, so a tile can span half a
  // column or half a row. Saved spans stay in column/row units (0.5 steps).
  // Without saved spans the arrangement picks the columns (Auto) and shares
  // each row evenly; see autoLayout. A drag preview arranges the previewed
  // order, so the tiles show where the dragged one will land.
  const spacing = useStore((s) => s.spacing);
  const canvasSize = useCanvasSize(gridRef, wsTiles.length, Math.max(0, spacing), true);
  const previewTiles = drag && drag.to !== drag.from && wsTiles[drag.from]?.id === drag.id && drag.to < wsTiles.length ? moveItem(wsTiles, drag.from, drag.to) : wsTiles;
  const arrangement = arrangeTiles({ ids: previewTiles.map((entry) => entry.id), saved: tileSpan, setting: columns, size: canvasSize, maxRows: MAX_TILE_ROWS });
  const { tracks } = arrangement;
  const columnTracks = tracks / arrangement.columns;

  const pointerIntent = useRef<{ id: string; pointer: number; x: number; y: number; started: number; cancelled: boolean } | null>(null);
  const scrollToTile = useCallback((id: string) => {
    if (fullId) return;
    const element = document.querySelector(`[data-tile-id="${CSS.escape(id)}"]`);
    if (!(element instanceof HTMLElement) || !element.getClientRects().length) return;
    const rect = element.getBoundingClientRect();
    if (rect.top < 84 || rect.bottom > window.innerHeight - 8) {
      element.scrollIntoView({ block: "center", inline: "nearest", behavior: "smooth" });
    }
  }, [fullId]);
  useEffect(() => {
    const move = (event: PointerEvent) => {
      const intent = pointerIntent.current;
      if (intent && event.pointerId === intent.pointer && Math.hypot(event.clientX - intent.x, event.clientY - intent.y) > 6) intent.cancelled = true;
    };
    const cancel = () => { if (pointerIntent.current) pointerIntent.current.cancelled = true; };
    const release = (event: PointerEvent) => {
      const intent = pointerIntent.current;
      if (!intent || event.pointerId !== intent.pointer) return;
      pointerIntent.current = null;
      const target = event.target instanceof Element ? event.target.closest("[data-tile-id]") : null;
      if (!intent.cancelled && performance.now() - intent.started < 250 &&
          target?.getAttribute("data-tile-id") === intent.id && useStore.getState().activeId === intent.id) {
        scrollToTile(intent.id);
      }
    };
    const abandon = () => { pointerIntent.current = null; };
    window.addEventListener("pointermove", move, true);
    window.addEventListener("pointerup", release, true);
    window.addEventListener("pointercancel", abandon, true);
    window.addEventListener("dragstart", cancel, true);
    window.addEventListener("wheel", cancel, true);
    window.addEventListener("blur", abandon);
    return () => {
      window.removeEventListener("pointermove", move, true);
      window.removeEventListener("pointerup", release, true);
      window.removeEventListener("pointercancel", abandon, true);
      window.removeEventListener("dragstart", cancel, true);
      window.removeEventListener("wheel", cancel, true);
      window.removeEventListener("blur", abandon);
    };
  }, [scrollToTile]);

  // Ctrl + number activates the Nth visible tile. Read the current order from a
  // ref so the handler stays valid as tiles come and go.
  const wsTilesRef = useRef(wsTiles);
  useEffect(() => {
    wsTilesRef.current = wsTiles;
  });
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.metaKey || e.altKey || e.shiftKey || !e.ctrlKey) return;
      const n = digitFromCode(e.code);
      if (n === null || n < 1) return;
      const t = wsTilesRef.current[n - 1];
      if (!t) return;
      e.preventDefault();
      e.stopPropagation();
      pointerIntent.current = null;
      activateTile(t.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activateTile]);

  // Cmd+J (Ctrl+J elsewhere) jumps to the next tile waiting on you: one with
  // an unread terminal notification, after the active tile in tile order and
  // wrapping around, across workspaces. With nothing waiting the key passes
  // through untouched (Ctrl+J is a newline in a terminal).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const modifier = IS_MAC ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey;
      if (!modifier || e.altKey || e.shiftKey || e.code !== "KeyJ" || e.isComposing) return;
      const state = useStore.getState();
      const waiting = new Set<string>();
      for (const item of useNotifications.getState().items) {
        if (!item.read && item.category === "terminal" && item.target?.tileId) waiting.add(item.target.tileId);
      }
      const candidates = state.tiles.filter((tile) => waiting.has(tile.id) && !(tile.host && deviceForHost(state.devices, tile.host)?.disabled));
      if (!candidates.length) return;
      e.preventDefault();
      e.stopPropagation();
      const from = state.tiles.findIndex((tile) => tile.id === state.activeId);
      const next = candidates.find((tile) => state.tiles.indexOf(tile) > from) ?? candidates[0];
      if (state.activeWorkspaceId !== ALL_WORKSPACE_ID) state.setWorkspace(state.sessionWs[wsKeyOf(next)] ?? DEFAULT_WORKSPACE_ID);
      state.unhideTile(next.id);
      pointerIntent.current = null;
      activateTile(next.id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [activateTile]);

  // Header drags: the pointer picks a slot of the layout as it was when the
  // drag started, the grid previews the move, and a drop on the canvas
  // commits it. Near the canvas top or bottom the canvas scrolls. Esc or a
  // drop anywhere else ends the drag without moving (onDragEnd).
  const dragSlots = useRef<Slot[]>([]);
  const endDrag = useCallback(() => {
    updateDrag(null);
    setLayoutPreview(false);
  }, [updateDrag]);
  const dragging = drag !== null;
  useEffect(() => {
    const grid = gridRef.current;
    const canvas = grid?.parentElement;
    if (!dragging || !grid || !canvas) return;
    let pointer: { x: number; y: number } | null = null;
    let frame = 0;
    const over = (event: DragEvent) => {
      const current = dragRef.current;
      if (!current) return;
      pointer = { x: event.clientX, y: event.clientY };
      if (!(event.target instanceof Node) || !canvas.contains(event.target)) {
        // Over a workspace tab or the top bar: the grid shows its real order.
        updateDrag({ ...current, to: current.from });
        return;
      }
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
      const box = grid.getBoundingClientRect();
      const slot = slotAt(dragSlots.current, event.clientX - box.left, event.clientY - box.top);
      if (slot !== null) updateDrag({ ...current, to: slot });
    };
    const drop = (event: DragEvent) => {
      const current = dragRef.current;
      if (!current) return;
      event.preventDefault();
      const target = wsTilesRef.current[current.to];
      if (target && current.to !== current.from) useStore.getState().reorderTile(current.id, target.id);
      endDrag();
    };
    const speed = (depth: number) => Math.ceil(AUTO_SCROLL_SPEED * Math.min(1, depth / AUTO_SCROLL_EDGE));
    const scroll = () => {
      frame = requestAnimationFrame(scroll);
      if (!pointer) return;
      const box = canvas.getBoundingClientRect();
      if (pointer.x < box.left || pointer.x > box.right || pointer.y < box.top || pointer.y > box.bottom) return;
      const up = box.top + AUTO_SCROLL_EDGE - pointer.y;
      const down = pointer.y - (box.bottom - AUTO_SCROLL_EDGE);
      if (up > 0) canvas.scrollTop -= speed(up);
      else if (down > 0) canvas.scrollTop += speed(down);
    };
    frame = requestAnimationFrame(scroll);
    document.addEventListener("dragover", over);
    canvas.addEventListener("drop", drop);
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener("dragover", over);
      canvas.removeEventListener("drop", drop);
    };
  }, [dragging, updateDrag, endDrag]);
  // The preview pauses terminal fits; never leave it paused.
  useEffect(() => () => setLayoutPreview(false), []);

  // Ctrl+Option (Ctrl+Alt) + arrows move the active tile: left and right
  // through the tile order, up and down to the tile above or below it. With
  // Shift they resize it by half a column or row. Off macOS a focused code
  // editor keeps the keys (Ctrl+Alt+Up/Down add cursors there).
  const layoutRef = useRef({ arrangement, full: false });
  useEffect(() => {
    layoutRef.current = { arrangement, full: !!effFull };
  });
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const step = ARROW_STEPS[event.key];
      if (!step || !event.ctrlKey || !event.altKey || event.metaKey || event.isComposing) return;
      if (!IS_MAC && event.target instanceof Element && event.target.closest(".cm-editor")) return;
      const state = useStore.getState();
      const order = wsTilesRef.current;
      const index = order.findIndex((entry) => entry.id === state.activeId);
      const { arrangement: current, full } = layoutRef.current;
      const grid = gridRef.current;
      if (index < 0 || full || !grid) return;
      event.preventDefault();
      event.stopPropagation();
      const id = order[index].id;
      if (event.shiftKey) {
        const span = current.spans.get(id);
        if (!span) return;
        const half = (value: number) => Math.round(value * 2) / 2;
        const c = Math.max(0.5, Math.min(current.columns, half(span.c / (current.tracks / current.columns) + step[0] / 2)));
        const r = Math.max(0.5, Math.min(MAX_TILE_ROWS, half(span.r / 2 + step[1] / 2)));
        state.setTileSpan(id, c, r);
        return;
      }
      let target = -1;
      if (step[0]) target = index + step[0];
      else {
        const slots = tileSlots(grid, order.map((entry) => entry.id));
        const from = slots[index];
        const middle = (from.left + from.right) / 2;
        let best = Infinity;
        slots.forEach((slot, candidate) => {
          if (candidate === index || middle < slot.left || middle >= slot.right) return;
          const distance = step[1] < 0 ? from.top - slot.bottom : slot.top - from.bottom;
          if (distance >= -1 && distance < best) {
            best = distance;
            target = candidate;
          }
        });
      }
      if (target >= 0 && target < order.length) state.reorderTile(id, order[target].id);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  // Folder drops from Finder open the new-session form for that folder.
  useEffect(() => installFolderDrops(), []);
  const folderDrag = useFolderDrag();

  // Shift+click headers to select tiles for broadcast; Esc or a click on the
  // empty canvas clears the selection.
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((current) => current.includes(id) ? current.filter((item) => item !== id) : [...current, id]);
  }, []);
  const clearSelection = useCallback(() => setSelectedIds([]), []);
  // Tiles in this workspace with a coding agent in the foreground, read from
  // the activity rows the tiles already poll.
  const agentTileIds = useCallback(() => wsTilesRef.current
    .filter((tile) => runningAgent(tile.session ?? tile.name, tile.window, tile.host) !== undefined)
    .map((tile) => tile.id), []);
  const selectAgents = useCallback(() => setSelectedIds((current) => [...new Set([...current, ...agentTileIds()])]), [agentTileIds]);
  // The command palette selects every visible tile, or every agent tile, for a broadcast.
  useEffect(() => {
    const selectVisible = () => setSelectedIds(wsTilesRef.current.map((tile) => tile.id));
    const selectAgentTiles = () => setSelectedIds(agentTileIds());
    window.addEventListener("pzza:broadcast-visible", selectVisible);
    window.addEventListener("pzza:broadcast-agents", selectAgentTiles);
    return () => {
      window.removeEventListener("pzza:broadcast-visible", selectVisible);
      window.removeEventListener("pzza:broadcast-agents", selectAgentTiles);
    };
  }, [agentTileIds]);
  useEffect(() => {
    if (!selectedIds.length) return;
    const onKey = (event: KeyboardEvent) => { if (escapeIsFree(event)) clearSelection(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedIds.length, clearSelection]);
  // Keyboard/programmatic selection still scrolls immediately. Pointer
  // selection waits for release so holding or dragging never moves the canvas.
  useEffect(() => {
    if (activeId && !pointerIntent.current) scrollToTile(activeId);
  }, [activeId, scrollToTile]);

  // Every tile stays mounted for the life of the session - switching workspaces,
  // hiding, or maximizing only toggles CSS visibility. Re-mounting would
  // re-attach the terminal to tmux, renegotiate its size, and paint garbage
  // until a reload; keeping it alive avoids that entirely.
  const noneVisible = wsTiles.length === 0;

  // A maximized tile only maximizes within its own workspace. Switching to a
  // different workspace must show that workspace normally, not a blank grid
  // (the maximized tile lives elsewhere and the maximize gate would otherwise
  // hide every tile here); returning to its workspace restores the maximize.
  const fullTile = fullId ? tiles.find((t) => t.id === fullId) : undefined;
  const fullInActiveWs =
    !!fullTile &&
    (activeWorkspaceId === ALL_WORKSPACE_ID ||
      (sessionWs[wsKeyOf(fullTile)] ?? DEFAULT_WORKSPACE_ID) === activeWorkspaceId);
  const effFull = fullInActiveWs ? fullId : null;
  // Only tiles currently on screen take part in a broadcast.
  const selectedTiles = wsTiles.filter((tile) => selectedIds.includes(tile.id) && (!effFull || tile.id === effFull));
  // The composer slides away with its last chips once fewer than two tiles are selected.
  const broadcast = useBroadcastPresence(selectedTiles.length >= 2
    ? selectedTiles.map((entry) => ({ id: entry.id, name: sessionDisplayName(entry, tileTitles), agent: runningAgent(entry.session ?? entry.name, entry.window, entry.host) }))
    : null);
  // Everything that can move a tile: the (previewed) order and spans, the
  // columns, the visible set, the maximized tile, the workspace, the spacing
  // and the broadcast bar. Tiles measure for their move animation only when
  // this changes, never on an unrelated render of the grid.
  const layoutDependency = [
    activeWorkspaceId, effFull ?? "", arrangement.columns, tracks, spacing, selectedTiles.length >= 2 ? "broadcast" : "",
    previewTiles.map((entry) => {
      const span = arrangement.spans.get(entry.id);
      return `${entry.id}:${span?.c ?? ""}x${span?.r ?? ""}`;
    }).join("\0"),
  ].join("\n");

  const duplicate = async (source: (typeof tiles)[number]) => {
    if (duplicationPending.current) throw new Error("A session duplication is already running.");
    duplicationPending.current = true;
    setDuplicating(source.id);
    setDuplicateError(null);
    const host = source.host ?? connection.host ?? undefined;
    const workspace = sessionWs[wsKeyOf(source)] ?? DEFAULT_WORKSPACE_ID;
    const label = `${sessionDisplayName(source, tileTitles)} copy`;
    try {
      const copy = await duplicateSession(source.session ?? source.name, source.window, host);
      const store = useStore.getState();
      const id = host ? `${host}::${copy.name}` : copy.name;
      store.assignSession(id, store.workspaces.some((entry) => entry.id === workspace) ? workspace : DEFAULT_WORKSPACE_ID);
      store.renameTile(id, label);
      store.openSession(copy.name, copy.cwd, host);
      return id;
    } catch (error) {
      setDuplicateError(error instanceof Error ? error.message : "Could not duplicate the session");
      throw error;
    } finally {
      duplicationPending.current = false;
      setDuplicating(null);
    }
  };

  // Esc restores the maximized tile when nothing focused consumes the key.
  useEffect(() => {
    if (!effFull) return;
    const onKey = (event: KeyboardEvent) => {
      if (!escapeIsFree(event)) return;
      event.preventDefault();
      setFullId(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [effFull]);

  const canvasControl = useRef({ fullId, duplicate });
  canvasControl.current = { fullId, duplicate };
  useEffect(() => {
    const requireTile = (id: unknown) => {
      const state = useStore.getState();
      const target = state.tiles.find(item => item.id === id);
      if (!target) throw new Error("The requested session tile is not open.");
      return target;
    };
    const reveal = (id: unknown) => {
      const target = requireTile(id);
      const state = useStore.getState();
      state.setWorkspace(state.sessionWs[wsKeyOf(target)] ?? DEFAULT_WORKSPACE_ID);
      state.unhideTile(target.id); state.setActive(target.id);
      return target;
    };
    const maximize = (args: { tileId?: unknown; enabled?: unknown }) => {
      const target = args.enabled ? reveal(args.tileId) : requireTile(args.tileId);
      if (args.enabled || canvasControl.current.fullId === target.id) setFullId(args.enabled ? target.id : null);
      return { tileId: target.id, enabled: args.enabled };
    };
    const cleanups = [
      registerAppControlState("canvas", () => ({ fullTileId: canvasControl.current.fullId, focusTileId: canvasControl.current.fullId, duplicating: duplicationPending.current })),
      // Focus mode is the maximize: the focused tile fills the canvas.
      registerAppControlHandler("set_focus_mode", maximize),
      registerAppControlHandler("set_fullscreen", maximize),
      registerAppControlHandler("duplicate_tile", async args => ({ tileId: await canvasControl.current.duplicate(requireTile(args.tileId)) })),
      registerAppControlHandler("terminate_tile", async args => {
        const current = requireTile(args.tileId);
        const state = useStore.getState();
        const affected = state.tiles.filter(item => (item.host ?? state.connection.host ?? "") === (current.host ?? state.connection.host ?? "") &&
          (item.session ?? item.name) === (current.session ?? current.name) && (current.window === undefined || item.window === current.window));
        if (hasUnsavedEditors(affected.map(item => item.id))) throw new Error("Save or explicitly discard affected editor buffers before terminating this session.");
        await killSession(current.session ?? current.name, current.window, sessionConnection(current.host, state.connection).host ?? "");
        for (const item of affected) {
          if (canvasControl.current.fullId === item.id) setFullId(null);
          useStore.getState().closeTile(item.id);
        }
        return { terminated: affected.map(item => item.id) };
      }),
    ];
    return () => cleanups.forEach(cleanup => cleanup());
  }, []);

  const tile = (t: (typeof tiles)[number]) => {
    const base = t.session ?? t.name;
    const { cmd, args } = attachCommand(sessionConnection(t.host, connection), base, t.cwd, t.window);
    const isLocal = !sessionConnection(t.host, connection).host;
    const rs = allSessions.find((s) => s.name === base);
    const fullPath = t.path ?? rs?.path;
    const codeOpen = tileCode[t.id]?.open ?? false;
    const wsColor = workspaces.find(
      (w) => w.id === (sessionWs[wsKeyOf(t)] ?? DEFAULT_WORKSPACE_ID),
    )?.color;
    const status = statuses[t.id] ?? "idle";
    // Grey by default; solid green only while this tile owns unread
    // notifications. Output activity no longer blinks the dot.
    const hasUnread = unreadTileSet.has(t.id);
    const displayStatus = hasUnread ? "notify" : status === "failed" ? "failed" : "idle";
    const displayName = sessionDisplayName(t, tileTitles);
    const isRenaming = renaming?.id === t.id;
    const shortcutIdx = wsTiles.findIndex((x) => x.id === t.id);
    const isFull = fullId === t.id;
    const toggleFull = () => {
      activateTile(t.id);
      setFullId(isFull ? null : t.id);
    };
    // Header actions, shared by the inline buttons and the narrow-tile More menu.
    const toggleCode = () => {
      if (codeOpen) {
        void confirmEditorDiscard([t.id]).then((confirmed) => { if (confirmed) toggleTileCode(t.id); });
        return;
      }
      // Open immediately at the best known path; a remote tile's live
      // cwd lookup is an ssh round trip and must not delay the panel.
      const hadRoot = !!tileCode[t.id]?.root;
      toggleTileCode(t.id, fullPath);
      if (hadRoot) return;
      // Then re-root at the terminal's live cwd (a fresh session has
      // no scanned path yet), unless a folder or file was picked meanwhile.
      void fetchSessionPath(base, t.host, t.window).then((live) => {
        const current = useStore.getState().tileCode[t.id];
        if (live && live !== fullPath && current?.open && !current.path && current.root === fullPath) {
          setTileCodeRoot(t.id, live);
        }
      });
    };
    const toggleMove = (anchor: DOMRect) => setMoveFor(moveFor?.id === t.id ? null : { id: t.id, x: anchor.right, y: anchor.bottom });
    const hide = () => {
      if (fullId === t.id) setFullId(null);
      hideTile(t.id);
    };
    const codeLabel = codeOpen ? "Back to terminal" : "Code editor";
    const borderBg = wsColor
      ? `linear-gradient(140deg, ${wsColor} 0%, var(--border) 22%)`
      : undefined;
    // Spans in grid tracks from the arrangement: saved sizes win, the other
    // tiles share their rows (see arrangeTiles). Tiles outside the grid
    // (hidden, other workspaces) keep a placeholder span.
    const trackSpan = arrangement.spans.get(t.id) ?? { c: columnTracks, r: 2 };
    const previewOrder = drag ? previewTiles.indexOf(t) : -1;
    const spanStyle = effFull
      ? undefined
      : {
          gridColumn: `span ${trackSpan.c}`,
          gridRow: `span ${trackSpan.r}`,
          // The drag preview reorders with CSS order, so no terminal is moved in the DOM.
          ...(previewOrder >= 0 ? { order: previewOrder } : {}),
        };
    const isActive = activeId === t.id;
    // Visible only when in the active workspace, not hidden, and (if a tile is
    // maximized) the maximized one. Everything else is display:none but stays
    // mounted.
    const tileWs = sessionWs[wsKeyOf(t)] ?? DEFAULT_WORKSPACE_ID;
    const inWorkspace =
      activeWorkspaceId === ALL_WORKSPACE_ID || tileWs === activeWorkspaceId;
    const visible = inWorkspace && !hiddenTiles.includes(t.id) && (!effFull || isFull);
    const isSelected = visible && selectedIds.includes(t.id);
    const cls = [
      "tile",
      visible ? "" : "tile-off",
      isActive ? "tile-active" : "",
      dragId === t.id ? "tile-dragging" : "",
      // The tile you haven't clicked gets a very light grey wash so the active
      // one stands out. Skipped while maximized.
      !isActive && !isFull ? "tile-inactive" : "",
      isSelected ? "tile-selected" : "",
    ]
      .filter(Boolean)
      .join(" ");
    return (
      <motion.div
        key={t.id}
        data-tile-id={t.id}
        className={cls}
        style={{
          ...(spanStyle ?? {}),
          ...(borderBg
            ? { border: "1px solid transparent" }
            : {}),
        }}
        layout={visible && !effFull ? "position" : false}
        layoutDependency={layoutDependency}
        // Fullscreen fades in without scaling: zooming the tile stretches the
        // terminal text and always reads as broken. Opacity alone is smooth.
        initial={isFull ? { opacity: 0 } : false}
        animate={isFull ? { opacity: 1 } : {}}
        transition={TILE_SPRING}
        onPointerDownCapture={(event) => {
          pointerIntent.current = {
            id: t.id, pointer: event.pointerId, x: event.clientX, y: event.clientY,
            started: performance.now(),
            cancelled: event.button !== 0 || !!(event.target instanceof Element && event.target.closest("button, input, select, a")),
          };
        }}
        onMouseDown={() => activateTile(t.id)}
      >
        <SessionHeader
          draggable={!effFull && !isRenaming}
          onDragStart={(e) => {
            const from = wsTiles.indexOf(t);
            const grid = gridRef.current;
            if (from < 0 || !grid) return;
            dragSlots.current = tileSlots(grid, wsTiles.map((entry) => entry.id));
            // The placeholder look waits a frame so the drag image is the tile as it was.
            const next = { id: t.id, from, to: from };
            dragRef.current = next;
            requestAnimationFrame(() => { if (dragRef.current === next) setDrag(next); });
            setLayoutPreview(true);
            e.dataTransfer.effectAllowed = "move";
            // Carry the workspace key (host-namespaced), so dropping on a tab
            // assigns exactly the key the grid filters by.
            e.dataTransfer.setData(SESSION_DND, wsKeyOf(t));
            e.dataTransfer.setData(SESSION_TILE_DND, t.id);
            // Drag a snapshot of the whole tile, not just the header.
            const tileEl = (e.currentTarget as HTMLElement).closest(".tile");
            if (tileEl) {
              const r = tileEl.getBoundingClientRect();
              e.dataTransfer.setDragImage(tileEl, e.clientX - r.left, e.clientY - r.top);
            }
          }}
          // Esc, a drop outside the canvas or on a workspace tab: the preview goes away.
          onDragEnd={endDrag}
          onMouseDownCapture={(e) => {
            // Shift+click selects; keep the browser from extending a text selection.
            if (e.shiftKey && !(e.target instanceof Element && e.target.closest("button, input"))) e.preventDefault();
          }}
          onClickCapture={(e) => {
            // Shift+click anywhere on the header (title included, buttons
            // excluded) toggles this tile in the broadcast selection.
            if (!e.shiftKey || (e.target instanceof Element && e.target.closest("button, input"))) return;
            e.preventDefault();
            e.stopPropagation();
            toggleSelected(t.id);
          }}
          onDoubleClick={(e) => {
            // Double-clicking the header background maximizes or restores.
            // Controls and the title (click to rename) keep their own behavior.
            if (e.target instanceof Element && e.target.closest("button, input, select, textarea, a, [contenteditable='true'], .tile-title")) return;
            e.preventDefault();
            toggleFull();
          }}
          status={displayStatus}
          icon={<LiveSessionIcon session={base} window={t.window} host={t.host} />}
          title={isRenaming ? (
            <input
              className="tile-title-input"
              autoFocus
              value={renaming.val}
              spellCheck={false}
              onMouseDown={(e) => e.stopPropagation()}
              onChange={(e) => setRenaming({ id: t.id, val: e.target.value })}
              onFocus={(e) => e.currentTarget.select()}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  renameTile(t.id, renaming.val);
                  setRenaming(null);
                } else if (e.key === "Escape") {
                  setRenaming(null);
                }
              }}
              onBlur={() => {
                renameTile(t.id, renaming.val);
                setRenaming(null);
              }}
            />
          ) : (
            <span
              className="tile-title"
              title={`${displayName}\nClick to rename`}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setRenaming({ id: t.id, val: displayName });
              }}
            >
              {displayName}
            </span>
          )}
          shortcut={shortcutIdx >= 0 && shortcutIdx < 9 ? shortcutIdx + 1 : undefined}
          device={{ host: t.host, name: tileDevice(t.host) }}
          actions={{
            mic: (<DictationButton tileId={t.id} activate={() => activateTile(t.id)} />),
            code: (<button
              className={`tile-btn ${codeOpen ? "tile-btn-on" : ""}`}
              title={codeLabel}
              aria-label={codeLabel}
              onMouseDown={(e) => e.stopPropagation()}
              onPointerEnter={() => void TileCodePanel.preload()}
              onClick={(e) => {
                e.stopPropagation();
                toggleCode();
              }}
            >
              <FileCode size={13} />
            </button>),
            move: (<button
              className="tile-btn"
              title="Move to workspace"
              aria-label="Move to workspace"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                toggleMove((e.currentTarget as HTMLElement).getBoundingClientRect());
              }}
            >
              <FolderInput size={13} />
            </button>),
            duplicate: (<button
              className="tile-btn"
              title="Duplicate session"
              aria-label="Duplicate session"
              disabled={duplicating !== null}
              aria-busy={duplicating === t.id}
              onMouseDown={(event) => event.stopPropagation()}
              onClick={(event) => { event.stopPropagation(); void duplicate(t).catch(() => {}); }}
            >
              {showDuplicateSpinner && duplicating === t.id ? <Loader2 size={13} className="async-spinner" /> : <Copy size={13} />}
            </button>),
            fullscreen: (<button
              className={`tile-btn ${isFull ? "tile-btn-on" : ""}`}
              title={isFull ? "Restore (Esc)" : "Maximize (double-click the header)"}
              aria-label={isFull ? "Restore" : "Maximize"}
              aria-pressed={isFull}
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                toggleFull();
              }}
            >
              {isFull ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
            </button>),
            hide: (<button
              className="tile-btn"
              title="Hide (keeps running)"
              aria-label="Hide (keeps running)"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                hide();
              }}
            >
              <EyeOff size={13} />
            </button>),
            close: (<button
              className="tile-btn tile-btn-danger"
              title="Terminate"
              aria-label="Terminate"
              onMouseDown={(e) => e.stopPropagation()}
              onClick={(e) => {
                e.stopPropagation();
                setCloseError(null);
                setClosing(t.id);
              }}
            >
              <X size={14} />
            </button>),
          }}
        />
        {borderBg ? <div className="tile-color-border" aria-hidden="true" style={{ background: borderBg }} /> : null}
        <div className={`tile-body ${codeOpen ? `tile-body-code-${tileCode[t.id]?.layout ?? "side-by-side"}` : ""}`}>
          {(refreshingLocal || launchCheckLocal) && isLocal ? <div className="term-surface term-refreshing" role="status">
            {refreshingLocal && !launchCheckLocal ? <><Loader2 size={14} className="sw-spin" aria-hidden="true" /> {restoringLocal ? "Restoring session…" : "Refreshing session…"}</> : null}
          </div> : <Terminal
            key={isLocal ? `${t.id}:${localGeneration}` : t.id}
            tileId={t.id}
            name={base}
            host={t.host ?? connection.host ?? undefined}
            cmd={cmd}
            args={args}
            cwd={t.cwd}
            window={t.window}
            active={activeId === t.id}
            onStatus={(s) => setStatus(t.id, s)}
          />}
          {codeOpen ? <TileCodePanel tileId={t.id} /> : null}
          {codeOpen ? <CodeSplitHandle tileId={t.id} /> : null}
        </div>
        <TileCheckpoints tileId={t.id} session={base} window={t.window} host={t.host} gitHost={t.host ?? connection.host ?? ""} path={fullPath ?? (t.cwd?.startsWith("/") ? t.cwd : undefined)} />
        {statusBarShown ? <>
        <TileStatusStrip tileId={t.id} session={base} window={t.window} host={t.host} gitHost={t.host ?? connection.host ?? ""} visible={visible} path={fullPath ?? (t.cwd?.startsWith("/") ? t.cwd : undefined)} createdAt={rs?.createdAt}
          workspaceId={tileWs} workspace={workspaces.find((w) => w.id === tileWs)?.name ?? tileWs} />
        </> : null}
        {visible && !effFull ? (
          <TileResizeHandles
            span={{ c: trackSpan.c / columnTracks, r: trackSpan.r / 2 }}
            columns={arrangement.columns}
            onCommit={(c, r) => setTileSpan(t.id, c, r)}
            onReset={() => clearTileSpan(t.id)}
          />
        ) : null}
      </motion.div>
    );
  };

  return (
    <>
      <Modal open={duplicateError !== null} onClose={() => setDuplicateError(null)} title="Duplicate session" size="sm">
        <p role="alert">{duplicateError}</p>
        <div className="modal-actions"><button className="btn" onClick={() => setDuplicateError(null)}>Dismiss</button></div>
      </Modal>
      <div
        ref={gridRef}
        className={`grid ${effFull ? "grid-full" : ""} ${broadcast.shown ? "grid-with-broadcast" : ""}`}
        style={{
          gridTemplateColumns: effFull
            ? "minmax(0, 1fr)"
            : `repeat(${tracks}, minmax(0, 1fr))`,
        }}
        onMouseDown={(e) => { if (e.target === e.currentTarget && selectedIds.length) clearSelection(); }}
      >
        {/* Reduced motion: tiles jump to their new places instead of gliding. */}
        <MotionConfig reducedMotion="user">{tiles.map(tile)}</MotionConfig>
      </div>
      {broadcast.shown ? (
        <BroadcastBar
          tiles={broadcast.shown} leaving={broadcast.leaving}
          agentTiles={agentTileIds()} onSelectAgents={selectAgents} onRemove={toggleSelected} onClear={clearSelection}
        />
      ) : null}
      {folderDrag.folder ? (
        // Fixed to the canvas's visible box so a scrolled canvas is still fully covered.
        <div className={`canvas-drop-overlay ${folderDrag.over ? "canvas-drop-overlay-on" : ""}`} aria-hidden="true" style={canvasBox()}>
          <div className="canvas-drop-label">
            <FolderPlus size={18} />
            <span>{folderDrag.over ? "Drop to start a session in" : "Drop on the canvas to start a session in"}</span>
            <code>{folderDrag.folder.split("/").pop() || folderDrag.folder}</code>
          </div>
        </div>
      ) : null}
      {noneVisible ? (
        <div className="grid-empty grid-empty-overlay">
          <section className="tile empty-session-window" aria-label="Empty workspace session preview">
            <SessionHeader
              aria-hidden="true"
              status="idle"
              icon={<PreviewSessionIcon size={14} />}
              title={<span className="tile-title">Session</span>}
              shortcut={1}
              device={{ name: tileDevice(undefined) }}
            />
            <div className="empty-session-body">
              <div className="empty-session-prompt" aria-hidden="true"><span>›</span><span className="empty-session-cursor" /></div>
              <p>Start a session in this workspace.</p>
              <button type="button" className="btn btn-accent empty-session-create" onClick={onNewSession}>
                <Plus size={16} />
                New Session
              </button>
            </div>
          </section>
        </div>
      ) : null}

      <Modal open={!!closing} onClose={() => { if (!terminating) setClosing(null); }} title="Terminate session" size="sm">
        <p className="move-q">
          Terminate ends {tiles.find((tile) => tile.id === closing)?.window !== undefined ? "this window" : "the session"} and everything running in it. This cannot be undone.
        </p>
        {closeError ? <p className="pj-error" role="alert">{closeError}</p> : null}
        <div className="modal-actions">
          <button className="btn" disabled={terminating} onClick={() => setClosing(null)}>Cancel</button>
          <button
            className="btn btn-danger"
            disabled={terminating}
            onClick={async () => {
              const current = tiles.find((tile) => tile.id === closing);
              if (!current || terminating) return;
              setTerminating(true);
              setCloseError(null);
              try {
                const affected = tiles.filter((tile) => (tile.host ?? connection.host ?? "") === (current.host ?? connection.host ?? "") &&
                  (tile.session ?? tile.name) === (current.session ?? current.name) &&
                  (current.window === undefined || tile.window === current.window));
                if (!await confirmEditorDiscard(affected.map((tile) => tile.id))) return;
                const close = () => {
                  for (const tile of affected) {
                    if (fullId === tile.id) setFullId(null);
                    closeTile(tile.id);
                  }
                };
                try {
                  await killSession(current.session ?? current.name, current.window, sessionConnection(current.host, connection).host ?? "");
                } catch (error) {
                  // An unreachable device cannot terminate anything. Offer to
                  // close the windows here instead, leaving the session as is.
                  setClosing(null);
                  if (await confirmAction({
                    title: "Close without terminating?",
                    message: `Terminating on ${tileDevice(current.host)} failed: ${error instanceof Error ? error.message : String(error)}. Close ${affected.length > 1 ? "these windows" : "this window"} in the app anyway? Anything still running on the device keeps running.`,
                    confirmLabel: "Close anyway",
                    danger: true,
                  })) close();
                  return;
                }
                close();
                setClosing(null);
              } catch (error) {
                setCloseError(error instanceof Error ? error.message : String(error));
              } finally {
                setTerminating(false);
              }
            }}
          >
            {terminating ? "Terminating…" : "Terminate"}
          </button>
        </div>
      </Modal>

      {moveFor
        ? createPortal(
            <div className="layout-pop-backdrop pzza-portal" onMouseDown={() => setMoveFor(null)}>
              <div
                className="menu layout-pop"
                style={{ right: window.innerWidth - moveFor.x, top: moveFor.y + 6 }}
                onMouseDown={(e) => e.stopPropagation()}
              >
                {(() => {
                  const target = tiles.find((x) => x.id === moveFor.id);
                  const key = target ? wsKeyOf(target) : "";
                  const current = sessionWs[key] ?? DEFAULT_WORKSPACE_ID;
                  return workspaces.map((w) => (
                    <button
                      key={w.id}
                      className={`menu-item ${current === w.id ? "menu-item-on" : ""}`}
                      onClick={() => {
                        if (key) assignSession(key, w.id);
                        setMoveFor(null);
                      }}
                    >
                      {w.name}
                    </button>
                  ));
                })()}
              </div>
            </div>,
            document.body,
          )
        : null}
    </>
  );
}
