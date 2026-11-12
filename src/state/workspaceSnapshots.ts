import { create } from "zustand";
import { useStore } from "./store";
import { useDetectedAgents, useSessionAgents } from "./sessionAgents";
import { createSessionInApp } from "../sessionActions";
import { runLocalAppCommand } from "../appControl";
import { fetchGitStatus } from "../serverApi";
import { agentCanAutoResume, sessionAgent, sessionAgentCommand, type SessionAgentChoice } from "../../server/lib/session-agents.js";
import { runningAgent, sessionAtShell } from "../ui/LiveSessionIcon";
import { DEFAULT_WORKSPACE_ID, wsKeyOf } from "../workspaces";
import { localSessionWorkRunning } from "./localSessionWork";
import {
  SNAPSHOT_LIMIT_MESSAGE,
  canAddManualSnapshot,
  capSnapshots,
  collectSnapshotSessions,
  exportSnapshot,
  importSnapshot,
  keepKnownDetails,
  parseSnapshots,
  snapshotDevice,
  snapshotLaunchPlan,
  validBranch,
  type SnapshotSession,
  type WorkspaceSnapshot,
} from "../workspaceSnapshots";

const KEY = "pzza.workspaceSnapshots.v1";
// Auto-saved snapshots are refreshed this often when something changed, and
// when the window closes.
const AUTOSAVE_MS = 3 * 60 * 1000;
export const AUTO_SNAPSHOT_NAME = "Auto-saved";
const BEFORE_DELETING = "Before deleting ";

function load(): WorkspaceSnapshot[] {
  try {
    return parseSnapshots(JSON.parse(localStorage.getItem(KEY) ?? "[]"));
  } catch {
    return [];
  }
}

export const useWorkspaceSnapshots = create<{ snapshots: WorkspaceSnapshot[]; relaunching: string | null }>(() => ({ snapshots: load(), relaunching: null }));

function persist(snapshots: WorkspaceSnapshot[]): void {
  useWorkspaceSnapshots.setState({ snapshots });
  try {
    localStorage.setItem(KEY, JSON.stringify(snapshots));
  } catch {
    /* Snapshots stay available for this window when storage is unavailable. */
  }
}

const find = (id: string) => useWorkspaceSnapshots.getState().snapshots.find(snapshot => snapshot.id === id);
const keyOf = (entry: Pick<SnapshotSession, "host" | "session">) => `${entry.host}::${entry.session}`;
const tileOf = (entry: Pick<SnapshotSession, "host" | "session">) => useStore.getState().tiles.find(tile => (tile.host ?? "") === entry.host && (tile.session ?? tile.name) === entry.session);

type AppState = ReturnType<typeof useStore.getState>;

// The agent each tile's session runs: the one it was started with, or the one
// detected running in a local session (its recorded mode when it is the same
// agent, else the agent's default mode).
function tileAgents(state: AppState): Record<string, SessionAgentChoice> {
  const agents = { ...useSessionAgents.getState().agents };
  const detected = useDetectedAgents.getState().agents;
  for (const tile of state.tiles) {
    if (tile.host) continue;
    const agent = sessionAgent(detected[tile.session ?? tile.name] ?? "");
    const recorded = agents[tile.id];
    if (agent && recorded?.id !== agent.id) agents[tile.id] = { id: agent.id, mode: agent.defaultMode };
  }
  return agents;
}

// What a snapshot of the workspace would hold right now: its sessions with
// their layout, and its columns. Null when the workspace has no sessions.
// `listedOnly` names the sessions ("host::session") whose folder came only
// from the device's session list, not from the tile (see keepKnownDetails).
function captureWorkspace(state: AppState, workspaceId: string): (Pick<WorkspaceSnapshot, "sessions" | "columns"> & { listedOnly: Set<string> }) | null {
  const input = {
    tiles: state.tiles,
    workspaceOf: (tile: AppState["tiles"][number]) => state.sessionWs[wsKeyOf(tile)] ?? DEFAULT_WORKSPACE_ID,
    workspaceId,
    devices: state.devices,
    sessionPaths: Object.fromEntries(state.allSessions.map(session => [session.name, session.path])),
    agents: tileAgents(state),
    spans: state.tileSpan,
    titles: state.tileTitles,
    hidden: state.hiddenTiles,
    code: state.tileCode,
  };
  const sessions = collectSnapshotSessions(input);
  if (!sessions.length) return null;
  const ownFolders = new Map(collectSnapshotSessions({ ...input, sessionPaths: {} }).map(entry => [`${entry.host}::${entry.session}`, entry.cwd]));
  const listedOnly = new Set(sessions.flatMap(entry => (entry.cwd && !ownFolders.get(`${entry.host}::${entry.session}`) ? [`${entry.host}::${entry.session}`] : [])));
  const columns = state.workspaceColumns[workspaceId] ?? state.defaultColumns;
  return { sessions, listedOnly, ...(Number.isInteger(columns) && columns >= 1 && columns <= 12 ? { columns } : {}) };
}

// The current Git branch of each session folder, by "host\nfolder" (folders
// that are not repositories, detached or unreachable are left out).
async function currentBranches(sessions: readonly SnapshotSession[]): Promise<Map<string, string>> {
  const byHost = new Map<string, Set<string>>();
  for (const entry of sessions) if (entry.cwd) byHost.set(entry.host, (byHost.get(entry.host) ?? new Set()).add(entry.cwd));
  const branches = new Map<string, string>();
  await Promise.all([...byHost].map(async ([host, paths]) => {
    try {
      const results = await fetchGitStatus(host, [...paths].slice(0, 64));
      for (const [path, status] of Object.entries(results)) {
        if (status && !status.detached && validBranch(status.branch)) branches.set(`${host}\n${path}`, status.branch);
      }
    } catch {
      /* The device is unreachable: those sessions are saved without a branch. */
    }
  }));
  return branches;
}

// Adds each session's branch to a saved snapshot once Git answers.
async function recordBranches(id: string): Promise<void> {
  const saved = find(id);
  if (!saved) return;
  const branches = await currentBranches(saved.sessions);
  const current = find(id);
  if (!current || !branches.size) return;
  const sessions = current.sessions.map(entry => {
    const branch = entry.cwd ? branches.get(`${entry.host}\n${entry.cwd}`) : undefined;
    return branch ? { ...entry, branch } : entry;
  });
  persist(useWorkspaceSnapshots.getState().snapshots.map(snapshot => (snapshot.id === id ? { ...current, sessions } : snapshot)));
}

// Save the workspace's current sessions and layout under a name. Returns null
// when the workspace has no sessions to record; throws when MAX_MANUAL_SNAPSHOTS
// snapshots are already saved by hand (auto-saves never count or make room).
export function saveWorkspaceSnapshot(workspaceId: string, name: string): WorkspaceSnapshot | null {
  const captured = captureWorkspace(useStore.getState(), workspaceId);
  if (!captured) return null;
  const snapshots = useWorkspaceSnapshots.getState().snapshots;
  if (!canAddManualSnapshot(snapshots)) throw new Error(SNAPSHOT_LIMIT_MESSAGE);
  const snapshot: WorkspaceSnapshot = { id: crypto.randomUUID(), workspaceId, name: name.trim().slice(0, 80), createdAt: Date.now(), sessions: captured.sessions, ...(captured.columns !== undefined ? { columns: captured.columns } : {}) };
  persist(capSnapshots([snapshot, ...snapshots]));
  void recordBranches(snapshot.id);
  return snapshot;
}

/**
 * Renames a snapshot; an empty name keeps the old one. A renamed auto
 * snapshot is kept as a normal one, so it counts as saved by hand: throws
 * when those are at their cap.
 */
export function renameWorkspaceSnapshot(id: string, name: string): void {
  const trimmed = name.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 80);
  if (!trimmed) return;
  const snapshots = useWorkspaceSnapshots.getState().snapshots;
  if (snapshots.find(snapshot => snapshot.id === id)?.auto && !canAddManualSnapshot(snapshots)) throw new Error(SNAPSHOT_LIMIT_MESSAGE);
  persist(capSnapshots(snapshots.map(snapshot => (snapshot.id === id ? { ...snapshot, name: trimmed, auto: undefined } : snapshot))));
}

export function deleteWorkspaceSnapshot(id: string): void {
  persist(useWorkspaceSnapshots.getState().snapshots.filter(snapshot => snapshot.id !== id));
}

/** The snapshot as shareable text (see exportSnapshot). */
export function exportWorkspaceSnapshot(id: string): string {
  const snapshot = find(id);
  if (!snapshot) throw new Error("This snapshot no longer exists.");
  return exportSnapshot(snapshot);
}

/** Adds a snapshot copied from PzzaCode to this workspace; throws when the text is not one, or at the cap. */
export function importWorkspaceSnapshot(text: string, workspaceId: string): WorkspaceSnapshot {
  const snapshots = useWorkspaceSnapshots.getState().snapshots;
  if (!canAddManualSnapshot(snapshots)) throw new Error(SNAPSHOT_LIMIT_MESSAGE);
  const snapshot = importSnapshot(text, workspaceId, crypto.randomUUID(), Date.now());
  persist(capSnapshots([snapshot, ...snapshots]));
  return snapshot;
}

// One auto-saved snapshot per workspace, replaced when the workspace changed
// (branches, recorded afterwards, are not a change). It never forgets a
// session's folder or agent that the live state lost (see keepKnownDetails),
// and it only ever pushes out older auto-saves.
function autoSave(state: AppState, workspaceId: string, name = AUTO_SNAPSHOT_NAME, branches = true): void {
  const captured = captureWorkspace(state, workspaceId);
  if (!captured) return;
  const snapshots = useWorkspaceSnapshots.getState().snapshots;
  const previous = snapshots.find(snapshot => snapshot.auto && snapshot.workspaceId === workspaceId && snapshot.name === name);
  const sessions = keepKnownDetails(captured.sessions, previous?.sessions, captured.listedOnly);
  const next = { sessions, ...(captured.columns !== undefined ? { columns: captured.columns } : {}) };
  const comparable = (snapshot: Pick<WorkspaceSnapshot, "sessions" | "columns">) => JSON.stringify({ sessions: snapshot.sessions.map(({ branch: _branch, ...entry }) => entry), columns: snapshot.columns });
  if (previous && comparable(previous) === comparable(next)) return;
  const snapshot: WorkspaceSnapshot = { id: previous?.id ?? crypto.randomUUID(), workspaceId, name, createdAt: Date.now(), auto: true, ...next };
  persist(capSnapshots([snapshot, ...snapshots.filter(entry => entry !== previous)]));
  if (branches) void recordBranches(snapshot.id);
}

// The state a snapshot is captured from (see captureWorkspace).
const CAPTURED = ["tiles", "workspaces", "sessionWs", "devices", "allSessions", "tileSpan", "tileTitles", "hiddenTiles", "tileCode", "workspaceColumns", "defaultColumns"] as const satisfies readonly (keyof AppState)[];

/**
 * Keeps an auto-saved snapshot of every workspace: within a few minutes of a
 * change, when the window hides or closes, and of a workspace about to be
 * deleted (taken from the state just before, as "Before deleting"). Saving is
 * driven by changes, so an idle window never wakes up for it. Returns a stop.
 */
export function startSnapshotAutosave(): () => void {
  // One save AUTOSAVE_MS after the first change since the last save.
  let timer: number | undefined;
  const saveAll = (branches: boolean) => {
    window.clearTimeout(timer);
    timer = undefined;
    // While local sessions are refreshed or restored they come and go, and
    // their agents are not running yet: save once that settles.
    if (localSessionWorkRunning()) { changed(); return; }
    const state = useStore.getState();
    for (const workspace of state.workspaces) autoSave(state, workspace.id, AUTO_SNAPSHOT_NAME, branches);
  };
  const changed = () => { timer ??= window.setTimeout(() => saveAll(true), AUTOSAVE_MS); };
  // The window is going away: no time to ask Git for branches.
  const onClose = () => saveAll(false);
  // Hidden, timers may be held back: save a pending change right away.
  const onVisibility = () => { if (document.visibilityState === "hidden" && timer !== undefined) saveAll(true); };
  window.addEventListener("pagehide", onClose);
  document.addEventListener("visibilitychange", onVisibility);
  const unsubscribe = useStore.subscribe((state, previous) => {
    if (CAPTURED.some(key => state[key] !== previous[key])) changed();
    if (state.workspaces.length >= previous.workspaces.length) return;
    for (const workspace of previous.workspaces) {
      if (!state.workspaces.some(entry => entry.id === workspace.id)) autoSave(previous, workspace.id, `${BEFORE_DELETING}${workspace.name}`.slice(0, 80));
    }
  });
  const unsubscribeAgents = useSessionAgents.subscribe(changed);
  // An agent starting or quitting in a session is a change too.
  const unsubscribeDetected = useDetectedAgents.subscribe(changed);
  // Whatever loaded before autosave started counts as a change too.
  changed();
  return () => {
    window.clearTimeout(timer);
    window.removeEventListener("pagehide", onClose);
    document.removeEventListener("visibilitychange", onVisibility);
    unsubscribe();
    unsubscribeAgents();
    unsubscribeDetected();
  };
}

export type PreviewStatus = "start" | "running" | "resume" | "no-device";
export interface PreviewEntry { key: string; session: string; host: string; status: PreviewStatus; agent?: string; branch?: string }

/**
 * What relaunching would do to each session, before it runs: start it, leave
 * it running, start its agent again in place (with continueChats, for a
 * session back at its shell), or nothing for a device that is gone.
 */
export function snapshotPreview(id: string, continueChats: boolean): PreviewEntry[] {
  const snapshot = find(id);
  if (!snapshot) return [];
  const state = useStore.getState();
  const { launch } = snapshotLaunchPlan(snapshot, state.tiles, state.allSessions.map(session => session.name));
  const missing = new Set(launch.map(keyOf));
  return snapshot.sessions.map(entry => {
    const tile = tileOf(entry);
    const status: PreviewStatus = missing.has(keyOf(entry))
      ? snapshotDevice(entry, state.activeDevices) ? "start" : "no-device"
      : continueChats && entry.agent && tile && !runningAgent(entry.session, tile.window, tile.host) && sessionAtShell(entry.session, tile.window, tile.host) ? "resume" : "running";
    return { key: keyOf(entry), session: entry.session, host: entry.host, status, ...(entry.agent ? { agent: sessionAgent(entry.agent.id)?.label ?? entry.agent.id } : {}), ...(entry.branch ? { branch: entry.branch } : {}) };
  });
}

export interface RelaunchResult {
  started: string[];
  running: string[];
  // Open sessions whose agent had stopped (a restart): started again in place.
  resumed: string[];
  failed: { session: string; error: string }[];
  // Sessions whose folder is now on another branch than when saved.
  branches: { session: string; saved: string; now: string }[];
  // A workspace created for a snapshot whose workspace was deleted.
  createdWorkspace?: string;
}

// Recreate a snapshot's sessions that are not running, one at a time (session
// creation is serialized app-wide), into the snapshot's workspace, or a new
// one with its name when that was deleted. With continueChats, agents
// continue their last conversation, and open sessions back at their shell (a
// reboot recreated them empty) get their agent started again. `only` limits
// it to some sessions (host::session keys). Then the saved layout is put back
// and branches that changed since are reported (never switched).
export async function relaunchWorkspaceSnapshot(id: string, options: { continueChats?: boolean; only?: readonly string[] } = {}): Promise<RelaunchResult> {
  const snapshot = find(id);
  if (!snapshot) throw new Error("This snapshot no longer exists.");
  if (useWorkspaceSnapshots.getState().relaunching) throw new Error("Another snapshot is relaunching. Wait for it to finish.");
  useWorkspaceSnapshots.setState({ relaunching: id });
  try {
    const chosen = options.only ? new Set(options.only) : null;
    const sessions = chosen ? snapshot.sessions.filter(entry => chosen.has(keyOf(entry))) : snapshot.sessions;
    const state = useStore.getState();
    const { launch, running } = snapshotLaunchPlan({ ...snapshot, sessions }, state.tiles, state.allSessions.map(session => session.name));
    const result: RelaunchResult = { started: [], running: running.map(entry => entry.session), resumed: [], failed: [], branches: [] };
    let workspaceId: string | undefined = snapshot.workspaceId;
    if (!state.workspaces.some(workspace => workspace.id === snapshot.workspaceId)) {
      const name = (snapshot.name.startsWith(BEFORE_DELETING) ? snapshot.name.slice(BEFORE_DELETING.length) : snapshot.name).trim() || "Restored";
      state.addWorkspace(name);
      workspaceId = useStore.getState().activeWorkspaceId;
      result.createdWorkspace = name;
    }
    // Only an agent whose "last conversation" is per folder continues; one whose
    // last conversation may come from another folder (or that cannot continue
    // from the command line) starts fresh in its recorded mode.
    const agentOf = (entry: SnapshotSession) => (entry.agent && options.continueChats && agentCanAutoResume(sessionAgent(entry.agent.id)) ? { ...entry.agent, resume: true } : entry.agent);
    for (const entry of launch) {
      const device = snapshotDevice(entry, useStore.getState().activeDevices);
      if (!device) {
        result.failed.push({ session: entry.session, error: "Its device is not configured or is disabled." });
        continue;
      }
      try {
        await createSessionInApp({ name: entry.session, deviceId: device.id, workspaceId, cwd: entry.cwd, agent: agentOf(entry) });
        result.started.push(entry.session);
      } catch (error) {
        result.failed.push({ session: entry.session, error: error instanceof Error ? error.message : "Could not create the session." });
      }
    }
    if (options.continueChats) {
      for (const entry of running) {
        const agent = agentOf(entry);
        const tile = tileOf(entry);
        // Only a session known to sit at its shell: typing into a running
        // agent would send the command to it as a prompt.
        if (!agent || !tile || runningAgent(entry.session, tile.window, tile.host) || !sessionAtShell(entry.session, tile.window, tile.host)) continue;
        try {
          await runLocalAppCommand("terminal_input", { tileId: tile.id, text: sessionAgentCommand(agent) });
          await runLocalAppCommand("terminal_submit", { tileId: tile.id });
          result.resumed.push(entry.session);
        } catch (error) {
          result.failed.push({ session: entry.session, error: error instanceof Error ? error.message : "Could not start its agent again." });
        }
      }
    }
    // The layout covers every session of the snapshot that has a tile, chosen
    // or not: it is how the workspace looked. Snapshots saved before layouts
    // were recorded carry no columns: the current layout stays for them.
    if (snapshot.columns !== undefined && workspaceId) {
      useStore.getState().applyWorkspaceLayout(workspaceId, {
        columns: snapshot.columns,
        tiles: snapshot.sessions.flatMap(entry => {
          const tile = tileOf(entry);
          return tile ? [{ id: tile.id, name: tile.name, span: entry.span, title: entry.title, hidden: entry.hidden, code: entry.code }] : [];
        }),
      });
    }
    const saved = sessions.filter(entry => entry.branch && entry.cwd);
    if (saved.length) {
      const now = await currentBranches(saved);
      for (const entry of saved) {
        const branch = now.get(`${entry.host}\n${entry.cwd}`);
        if (branch && branch !== entry.branch) result.branches.push({ session: entry.session, saved: entry.branch!, now: branch });
      }
    }
    return result;
  } finally {
    useWorkspaceSnapshots.setState({ relaunching: null });
  }
}

/** The agent each local session has in the auto-saved snapshots, newest first, by session name. */
export function autoSavedLocalAgents(): Map<string, SessionAgentChoice> {
  const agents = new Map<string, SessionAgentChoice>();
  const snapshots = useWorkspaceSnapshots.getState().snapshots.filter(snapshot => snapshot.auto).sort((left, right) => right.createdAt - left.createdAt);
  for (const snapshot of snapshots) {
    for (const entry of snapshot.sessions) if (!entry.host && entry.agent && !agents.has(entry.session)) agents.set(entry.session, entry.agent);
  }
  return agents;
}

/** A short list of a workspace's snapshots, for app control. */
export function snapshotSummaries(workspaceId?: string) {
  return useWorkspaceSnapshots.getState().snapshots
    .filter(snapshot => !workspaceId || snapshot.workspaceId === workspaceId)
    .map(snapshot => ({ id: snapshot.id, name: snapshot.name, workspaceId: snapshot.workspaceId, sessions: snapshot.sessions.length, createdAt: snapshot.createdAt, auto: snapshot.auto === true }));
}
