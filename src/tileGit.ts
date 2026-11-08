import { fetchGitChanges, fetchGitRemote, fetchGitStatus, type GitChanges, type GitFolderStatus } from "./serverApi";
import { openUrl } from "./forward";
import { HAS_TAURI } from "./tauriEnv";
import { useStore } from "./state/store";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID } from "./workspaces";
import { gitFactsSentence, type GitFactsPullRequest } from "./gitFacts";

// Git actions on the folder a tile works in, shared by the tile footer, the
// "agent finished" notification and the app commands.

const GIT_TIMEOUT_MS = 15000;

/** Opens a web page in the default browser (a new window outside the desktop app). */
export function openWebPage(url: string): void {
  if (HAS_TAURI) void openUrl(url).catch(() => { /* Rejected or unsupported addresses are simply not opened. */ });
  else window.open(url, "_blank", "noopener,noreferrer");
}

export interface TileGitTarget { tileId: string; host: string; folder: string }

/** The device and absolute folder a tile works in, resolved as its footer does; null when unknown. */
export function tileGitTarget(tileId: string): TileGitTarget | null {
  const state = useStore.getState();
  const tile = state.tiles.find((candidate) => candidate.id === tileId);
  if (!tile) return null;
  const listed = state.allSessions.find((session) => session.name === (tile.session ?? tile.name));
  const folder = tile.path ?? listed?.path ?? (tile.cwd?.startsWith("/") ? tile.cwd : undefined);
  if (!folder?.startsWith("/")) return null;
  return { tileId, host: tile.host ?? state.connection.host ?? "", folder };
}

/** Brings a tile forward and shows its uncommitted changes in its editor. */
export function openTileChangesView(tileId: string, folder: string): void {
  const state = useStore.getState();
  const tile = state.tiles.find((candidate) => candidate.id === tileId);
  if (!tile) return;
  const workspace = state.sessionWs[(tile.host ? `${tile.host}::` : "") + (tile.session ?? tile.name)] ?? DEFAULT_WORKSPACE_ID;
  if (state.activeWorkspaceId !== ALL_WORKSPACE_ID && state.activeWorkspaceId !== workspace) state.setWorkspace(workspace);
  if (state.hiddenTiles.includes(tileId)) state.unhideTile(tileId);
  state.openTileChanges(tileId, folder);
}

export interface ChangeSummary { files: number; truncated: boolean; names: string[] }

/** How many files changed and the names of the first few, for a notice or a spoken answer. */
export function changeSummary(changes: GitChanges, top = 3): ChangeSummary {
  return { files: changes.files.length, truncated: changes.truncated, names: changes.files.slice(0, top).map((file) => file.path.split("/").pop() || file.path) };
}

/** "1 file changed", "12 files changed", or "500+ files changed" when the list was cut short. */
export function filesChangedLabel(summary: ChangeSummary): string {
  return `${summary.files}${summary.truncated ? "+" : ""} ${summary.files === 1 && !summary.truncated ? "file" : "files"} changed`;
}

function requireTarget(tileId: string): TileGitTarget {
  if (!useStore.getState().tiles.some((tile) => tile.id === tileId)) throw new Error("Unknown open tile.");
  const target = tileGitTarget(tileId);
  if (!target) throw new Error("That tile's folder is not known yet.");
  return target;
}

/** Opens a tile's Changes view and reports what changed there. */
export async function reviewTileChanges(tileId: string): Promise<{ tileId: string; folder: string } & ChangeSummary> {
  const target = requireTarget(tileId);
  let changes: GitChanges;
  try {
    changes = await fetchGitChanges(target.host, target.folder, AbortSignal.timeout(GIT_TIMEOUT_MS));
  } catch {
    throw new Error("That tile's folder is not a Git repository, or its device cannot be reached.");
  }
  openTileChangesView(tileId, target.folder);
  return { tileId, folder: target.folder, ...changeSummary(changes) };
}

const REMOTE_TIMEOUT_MS = 8000;

export interface TileGitStatus extends ChangeSummary {
  tileId: string;
  folder: string;
  branch: string;
  detached: boolean;
  ahead: number | null;
  behind: number | null;
  /** null when the branch has none, or when it cannot be looked up (gh missing or slow). */
  pullRequest: (GitFactsPullRequest & { url: string }) | null;
  /** The facts as one short English sentence, for a spoken answer. */
  summary: string;
}

export interface GitStatusApi {
  status: typeof fetchGitStatus;
  changes: typeof fetchGitChanges;
  remote: typeof fetchGitRemote;
}
const GIT_API: GitStatusApi = { status: fetchGitStatus, changes: fetchGitChanges, remote: fetchGitRemote };

/** Branch, uncommitted changes, ahead/behind and the pull request with its checks, for one folder. */
export async function gitStatusReport(target: TileGitTarget, api: GitStatusApi = GIT_API): Promise<TileGitStatus> {
  const signal = AbortSignal.timeout(GIT_TIMEOUT_MS);
  // The pull request is optional: gh may be missing, unauthenticated or slow.
  const remote = api.remote(target.host, target.folder, AbortSignal.timeout(REMOTE_TIMEOUT_MS)).catch(() => null);
  let status: GitFolderStatus | null;
  let changes: GitChanges;
  try {
    [status, changes] = await Promise.all([api.status(target.host, [target.folder], signal).then((results) => results[target.folder] ?? null), api.changes(target.host, target.folder, signal)]);
  } catch {
    throw new Error("That tile's folder is not a Git repository, or its device cannot be reached.");
  }
  if (!status) throw new Error("That tile's folder is not a Git repository.");
  const info = await remote;
  const pr = info?.pr && !status.detached ? { number: info.pr.number, state: info.pr.state, draft: info.pr.draft, checks: info.pr.checks } : null;
  // "No PR" is only said when gh could have found one.
  const known = pr ?? (info?.ghAvailable && !status.detached ? null : undefined);
  const summary = changeSummary(changes);
  return {
    tileId: target.tileId, folder: target.folder, branch: status.branch, detached: status.detached, ahead: status.ahead, behind: status.behind, ...summary,
    pullRequest: pr && info?.pr ? { ...pr, url: info.pr.url } : null,
    summary: gitFactsSentence({ ...status, files: summary.files, truncated: summary.truncated, pullRequest: known }),
  };
}

/** A tile's Git state, read without changing anything on screen. */
export function tileGitStatus(tileId: string): Promise<TileGitStatus> {
  return gitStatusReport(requireTarget(tileId));
}

/** Opens the pull request of a tile's branch in the browser, or the branch page when there is none. */
export async function openTilePullRequest(tileId: string): Promise<{ opened: "pull_request"; number: number; url: string } | { opened: "branch"; url: string }> {
  const target = requireTarget(tileId);
  let remote;
  try {
    remote = await fetchGitRemote(target.host, target.folder, AbortSignal.timeout(GIT_TIMEOUT_MS));
  } catch {
    throw new Error("That tile's folder is not a Git repository, or its device cannot be reached.");
  }
  // The same choice as the footer branch: a closed pull request falls back to the branch page.
  const pr = remote.pr && remote.pr.state !== "CLOSED" ? remote.pr : null;
  const url = pr?.url ?? remote.web;
  if (!url) throw new Error("This branch has no pull request or web page to open.");
  openWebPage(url);
  return pr ? { opened: "pull_request", number: pr.number, url } : { opened: "branch", url };
}
