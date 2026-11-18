import { create } from "zustand";
import { isSessionTile, sessionTileById, useStore, type Session } from "./state/store";
import { deviceForHost, deviceHost } from "./devices";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, wsKeyOf } from "./workspaces";
import { SessionRenameRefused, createSession, fetchPreviousNames, locateWindows, renameSession, scanDevice, type WorktreeSetupReport } from "./serverApi";
import { notify, retargetNotifications } from "./state/notifications";
import { moveSessionAgents, rememberSessionAgent, useSessionAgents } from "./state/sessionAgents";
import { moveRecentFiles } from "./code/recentFiles";
import { moveDiffReview } from "./grid/diffReview";
import { sessionConnection } from "./connection";
import { hasUnsavedEditors, lockEditors } from "./editorChanges";
import { tileTitle } from "./sessionMeta";
import { candidateSettled, useTasks } from "./tasks/taskStore";
import { terminateTarget } from "./windowIdentity";
import { confirmAction } from "./state/confirmations";
import { normalizeSessionName } from "../server/lib/session-name.js";
import { currentSessionName } from "../server/lib/session-follow.js";
import { sessionAgent, type SessionAgentChoice } from "../server/lib/session-agents.js";

export interface SessionCreationInput {
  name: string;
  deviceId: string;
  workspaceId?: string;
  cwd?: string;
  account?: { provider: "claude" | "codex"; dir: string };
  agent?: SessionAgentChoice;
  // Create a git worktree on a new branch for this session (requires cwd in a repository).
  worktree?: boolean;
  // The local branch the new worktree branch starts from (worktree only); the repository's HEAD when absent.
  base?: string;
}
/** What a created session got: its folder (the new worktree, if any) and what the worktree setup copied. */
export interface SessionCreated { tileId: string; cwd?: string; setup?: WorktreeSetupReport }
interface Creation {
  id: string; status: "running" | "completed" | "failed"; name: string; host: string; workspaceId: string; tileId?: string;
}
export const useSessionCreation = create<{ operation: Creation | null; error: string | null }>(() => ({ operation: null, error: null }));

// The regular session creation runs one at a time; a session the user is
// creating meanwhile is waited for instead of failing the caller.
export function creationIdle(): Promise<void> {
  if (useSessionCreation.getState().operation?.status !== "running") return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { stop(); reject(new Error("Another session took too long to start.")); }, 120000);
    const stop = useSessionCreation.subscribe((state) => {
      if (state.operation?.status === "running") return;
      clearTimeout(timer);
      stop();
      resolve();
    });
  });
}

// Programmatic launches (tasks, chains, retries, file tiles opening a terminal)
// run one after another: createSessionInApp refuses a second creation while
// one runs. Any number of launches can wait here; none is dropped.
let launches: Promise<unknown> = Promise.resolve();
export function enqueueLaunch<T>(work: () => Promise<T>): Promise<T> {
  const run = launches.then(work, work);
  launches = run.catch(() => undefined);
  return run;
}

/** A valid session name built from free text (a file or session name), with room left for a suffix. */
export function sessionNameBase(text: string, fallback = "session"): string {
  return text.replace(/[^A-Za-z0-9_ -]+/g, "-").replace(/^[\s-]+|[\s-]+$/g, "").slice(0, 100) || fallback;
}

/** `base`, or the first `base-N` (N from 2) that is not taken. */
export function uniqueSessionName(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix++) {
    const name = `${base}-${suffix}`;
    if (!taken.has(name)) return name;
  }
  return `${base}-${Date.now().toString(36)}`;
}

/** Session names already in use on a device ("" = this device): its open tiles, and this device's listed sessions. */
export function takenSessionNames(host: string): Set<string> {
  const state = useStore.getState();
  return new Set([
    ...state.tiles.filter(isSessionTile).filter(tile => (tile.host ?? "") === host).map(tile => tile.session ?? tile.name),
    ...(host ? [] : state.allSessions.map(item => item.name)),
  ]);
}

export function createSessionInApp(input: SessionCreationInput, created?: (details: SessionCreated) => void): Promise<string> {
  const state = useStore.getState();
  const name = normalizeSessionName(input.name);
  const device = state.activeDevices.find(item => item.id === input.deviceId);
  if (!device) throw new Error("Choose a configured device.");
  const host = deviceHost(device);
  if (host && !/^[A-Za-z0-9._][A-Za-z0-9._@-]{0,127}$/.test(host)) throw new Error("This device has an unsupported SSH host.");
  const selected = input.workspaceId ?? state.activeWorkspaceId;
  const workspaceId = selected === ALL_WORKSPACE_ID ? DEFAULT_WORKSPACE_ID : selected;
  if (!state.workspaces.some(item => item.id === workspaceId)) throw new Error("Choose an existing workspace.");
  if (input.cwd !== undefined && (!input.cwd.startsWith("/") || input.cwd.length > 4096 || /[\u0000-\u001f\u007f]/.test(input.cwd))) throw new Error("Choose an absolute working directory.");
  if (useSessionCreation.getState().operation?.status === "running") throw new Error("A session is already being created. Wait for its result.");
  const operation: Creation = { id: crypto.randomUUID(), status: "running", name, host, workspaceId };
  useSessionCreation.setState({ operation, error: null });
  return (async () => {
    try {
      const result = await createSession(name, input.cwd, input.account, host, input.agent, input.worktree, input.worktree ? input.base : undefined);
      const cwd = result.cwd ?? input.cwd;
      const current = useStore.getState();
      const destination = current.workspaces.some(item => item.id === workspaceId) ? workspaceId : DEFAULT_WORKSPACE_ID;
      const tileId = host ? `${host}::${name}` : name;
      // The device just created this name, so anything kept for an earlier,
      // closed tile of a session with the same name is not this one's.
      current.forgetTileState([tileId]);
      rememberSessionAgent(tileId, input.agent && { id: input.agent.id, mode: input.agent.mode });
      current.assignSession(tileId, destination); current.setWorkspace(destination);
      current.openSession(name, cwd, host);
      if (result.setup) notifyWorktreeSetup(result.setup, result.setupStarted, name, tileId);
      if (input.agent && result.agentStarted === false) notify({ category: "app", event: "agent-start-failed", title: "Agent did not start", body: `${sessionAgent(input.agent.id)?.label ?? "The agent"} could not be started in ${name}. The terminal is open; start it manually.`, target: { tileId } });
      useSessionCreation.setState({ operation: { ...operation, status: "completed", tileId } });
      created?.({ tileId, cwd, setup: result.setup });
      void current.loadSessions().catch(() => {});
      return tileId;
    } catch (error) {
      useSessionCreation.setState({ operation: { ...operation, status: "failed" }, error: error instanceof Error ? error.message : "Could not create the session." });
      throw error;
    }
  })();
}

// Says when a new worktree's repository setup needs attention: why commands
// were held back (not approved yet, an unreadable setup file, keys that did
// not reach the terminal), with what it did copy and run for context. A setup
// that went through is visible in the new tile, so it adds no notice.
function notifyWorktreeSetup(setup: WorktreeSetupReport, started: boolean | undefined, name: string, tileId: string): void {
  const problem = setup.unapproved || setup.error !== null || started === false;
  if (!problem) return;
  const parts: string[] = [];
  if (setup.copied.length) parts.push(`Copied ${setup.copied.length === 1 ? setup.copied[0] : `${setup.copied.length} files`} from the main checkout.`);
  if (setup.run.length) parts.push(started === false ? "The setup commands could not be typed into the terminal." : `Running ${setup.run.length === 1 ? setup.run[0] : `${setup.run.length} setup commands`} before the agent.`);
  if (setup.unapproved) parts.push("Its setup commands are not approved on this device yet; review them under Setup in the session's Worktrees (its top bar).");
  if (setup.error) parts.push(setup.error);
  if (!parts.length) return;
  notify({ category: "app", title: "Worktree setup needs attention", body: `${name}: ${parts.join(" ")}`, target: { tileId } });
}

export const WORKTREE_COLLISION =/worktree for this session name already exists|may already exist/i;

// Offers to start a tile's running agent again in a fresh git worktree of the
// same repository, through the regular worktree session flow (new branch
// pzza/<name>). The original session keeps running; the new tile opens right
// after it in the same workspace. Resolves to the new tile id, or null when
// the user cancels.
export async function moveAgentToWorktree(input: { tileId: string; session: string; host?: string; cwd: string; provider: SessionAgentChoice["id"] }): Promise<string | null> {
  const state = useStore.getState();
  const source = state.tiles.find(tile => tile.id === input.tileId);
  const definition = sessionAgent(input.provider);
  if (!source || !definition) throw new Error("This tile has no coding agent to move.");
  const device = deviceForHost(state.activeDevices, input.host);
  if (!device) throw new Error("This tile's device is not configured or is turned off.");
  // Keep the mode the session was started with when it is the same agent.
  const remembered = useSessionAgents.getState().agents[input.tileId];
  const mode = remembered?.id === definition.id && definition.modes.some(item => item.id === remembered.mode) ? remembered.mode : definition.defaultMode;
  const modeLabel = definition.modes.find(item => item.id === mode)?.label ?? mode;
  const accepted = await confirmAction({
    title: "Move this session to its own worktree?",
    message: `Starts ${definition.label} (${modeLabel}) in a new tile next to this one, in a fresh worktree of this repository on a new pzza/ branch. This session keeps running; close it when you no longer need it.`,
    confirmLabel: "Start in worktree",
  });
  if (!accepted) return null;

  const base = sessionNameBase(input.session);
  const taken = takenSessionNames(deviceHost(device));
  const workspaceId = useStore.getState().sessionWs[wsKeyOf(source)] ?? DEFAULT_WORKSPACE_ID;
  // A worktree left behind by an earlier session keeps its name; the next free suffix is tried instead.
  for (let attempt = 1, tried = 0; tried < 5; attempt++) {
    const name = `${base}-wt${attempt > 1 ? `-${attempt}` : ""}`;
    if (taken.has(name)) continue;
    tried++;
    try {
      const tileId = await createSessionInApp({ name, deviceId: device.id, workspaceId, cwd: input.cwd, worktree: true, agent: { id: definition.id, mode } });
      placeAfter(tileId, input.tileId);
      return tileId;
    } catch (error) {
      if (!(error instanceof Error && WORKTREE_COLLISION.test(error.message)) || tried === 5) throw error;
    }
  }
  throw new Error("Could not find a free worktree name.");
}

// Moves a freshly opened tile (appended last) to sit right after `anchorId`.
function placeAfter(tileId: string, anchorId: string): void {
  const { tiles, reorderTile } = useStore.getState();
  const anchor = tiles.findIndex(tile => tile.id === anchorId);
  const next = tiles[anchor + 1];
  if (anchor >= 0 && next && next.id !== tileId) reorderTile(tileId, next.id);
}

// Renames a terminal tile for real: its tmux session on the device (and with
// it every tile of that session), or, for a window tile, that one tmux window.
// The footer, new attaches and the device all use the new name, and the old
// one is free for a new session. Resolves to the name the device applied.
export async function renameSessionTile(tileId: string, input: string): Promise<string> {
  const state = useStore.getState();
  const tile = sessionTileById(state.tiles, tileId);
  if (!tile) throw new Error("This tile is no longer open.");
  const name = normalizeSessionName(input);
  const session = tile.session ?? tile.name;
  const host = sessionConnection(tile.host, state.connection).host ?? "";

  if (tile.window !== undefined) {
    // The exact window the tile shows, never whatever holds its index now.
    const current = (await locateWindows(host)).find(window => window.session === session && window.window === tile.window);
    const target = terminateTarget(tile, current);
    if (target.kind === "gone") throw new Error("That window is no longer open on this device.");
    if (target.kind === "moved") throw new Error("Another window has taken this window's place in the session, so nothing was renamed.");
    const applied = await renameSession(session, name, host, tile.window, target.windowId);
    useStore.getState().renameWindowTile(tileId, applied);
    return applied;
  }

  if (name === session) {
    // Already the tmux name: only an earlier display override goes (see renameSessionTiles).
    state.renameTile(tileId, tileTitle(name) !== name ? name : "");
    return name;
  }
  const affected = state.tiles.filter(isSessionTile).filter(item =>
    (sessionConnection(item.host, state.connection).host ?? "") === host && (item.session ?? item.name) === session).map(item => item.id);
  // Every tile of the session reopens under its new id, which would drop an editor's unsaved buffer.
  if (hasUnsavedEditors(affected)) throw new Error("Save or discard the open editor changes in this session before renaming it.");
  // A task finds its sessions, worktree and branch by the session name it started.
  const ids = new Set(affected);
  const task = useTasks.getState().tasks.find(item =>
    item.candidates.some(candidate => !candidateSettled(candidate) && ids.has(candidate.tileId)) ||
    (item.chain && item.chain.state !== "done" && item.chain.state !== "stopped" && item.chain.steps.some(step => step.tileId !== undefined && ids.has(step.tileId))));
  if (task) throw new Error(`This session belongs to the task "${task.title}", which tracks it by name. Finish or discard the task before renaming it.`);

  // A tile still open under the new name (its session has ended, or the
  // device would refuse the name) would be replaced, editor and all.
  const prefix = (item: Session) => (item.host ? `${item.host}::` : "");
  const targets = new Set(state.tiles.filter(isSessionTile).filter(item => ids.has(item.id))
    .map(item => item.window === undefined ? prefix(item) + name : `${prefix(item)}${name}::w::${item.window}`));
  if (state.tiles.some(item => targets.has(item.id))) throw new Error(`A tile named "${name}" is already open. Close it first, or choose another name.`);

  // The editors stay read-only until the tiles reopen under the new name:
  // an edit typed while the device renames would be lost with them.
  const unlock = lockEditors(affected);
  try {
    let applied: string;
    try {
      applied = await renameSession(session, name, host);
    } catch (error) {
      // A failure that is not a refusal can come after tmux renamed the session
      // (a slow device, a lost answer). The tiles must follow it then, or the
      // next attach would recreate an empty session under the old name.
      if (error instanceof SessionRenameRefused) throw error;
      const live = await scanDevice(host).catch(() => null);
      if (!live || !live.some(item => item.name === name) || live.some(item => item.name === session)) throw error;
      applied = name;
    }
    // Right away, before anything reattaches under the old name. By device and
    // name, not by tile: the tile may have been closed meanwhile.
    applySessionRename(host, session, applied);
    void useStore.getState().loadSessions().catch(() => {});
    return applied;
  } finally {
    unlock();
  }
}

/** Old tile id → new id, for each tile a session rename moved. */
export type MovedTiles = Readonly<Record<string, string>>;
// Dispatched with MovedTiles as detail, in the same tick as the store moves
// the tiles, so per-tile view state elsewhere (maximized tile, broadcast
// selection) moves along.
export const TILES_RENAMED_EVENT = "pzza:tiles-renamed";
/** The moved tiles a TILES_RENAMED_EVENT carries; null for any other event. */
export function movedTilesOf(event: Event): MovedTiles | null {
  if (!(event instanceof CustomEvent)) return null;
  const detail: unknown = event.detail;
  if (!detail || typeof detail !== "object" || Array.isArray(detail)) return null;
  const moved: Record<string, string> = {};
  for (const [from, to] of Object.entries(detail)) {
    if (typeof to !== "string") return null;
    moved[from] = to;
  }
  return moved;
}

// Moves the tiles of session `oldName` on `host` (see renameSessionTiles) and
// everything kept by tile id outside the store to the new name.
function applySessionRename(host: string, oldName: string, newName: string): MovedTiles {
  const moved = useStore.getState().renameSessionTiles(host, oldName, newName);
  if (!Object.keys(moved).length) return moved;
  moveSessionAgents(moved);
  moveRecentFiles(moved);
  moveDiffReview(moved);
  retargetNotifications(moved);
  window.dispatchEvent(new CustomEvent<MovedTiles>(TILES_RENAMED_EVENT, { detail: moved }));
  return moved;
}

// Tiles that still know a session by a name it no longer has (renamed in
// another app window, on another Mac, or while the tile was closed) move to
// its current name, read from the device. Called when an attach followed a
// rename and when a listing misses a tile's session. One lookup per device
// at a time.
const following = new Map<string, Promise<void>>();
export function followRenamedSessions(host: string): Promise<void> {
  const running = following.get(host);
  if (running) return running;
  const run = (async () => {
    const state = useStore.getState();
    const names = new Set(state.tiles.filter(isSessionTile)
      .filter(tile => (sessionConnection(tile.host, state.connection).host ?? "") === host)
      .map(tile => tile.session ?? tile.name));
    if (!names.size) return;
    const sessions = await fetchPreviousNames(host);
    for (const name of names) {
      const current = currentSessionName(sessions, name);
      if (current && current !== name) applySessionRename(host, name, current);
    }
  })().catch(() => { /* Unreachable device: the next attach or listing tries again. */ }).finally(() => following.delete(host));
  following.set(host, run);
  return run;
}
