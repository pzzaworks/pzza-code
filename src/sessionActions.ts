import { create } from "zustand";
import { useStore } from "./state/store";
import { deviceForHost, deviceHost } from "./devices";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID, wsKeyOf } from "./workspaces";
import { createSession, type WorktreeSetupReport } from "./serverApi";
import { notify } from "./state/notifications";
import { rememberSessionAgent, useSessionAgents } from "./state/sessionAgents";
import { confirmAction } from "./state/confirmations";
import { normalizeSessionName } from "../server/lib/session-name.js";
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
}
interface Creation {
  id: string; status: "running" | "completed" | "failed"; name: string; host: string; workspaceId: string; tileId?: string;
}
export const useSessionCreation = create<{ operation: Creation | null; error: string | null }>(() => ({ operation: null, error: null }));

export function createSessionInApp(input: SessionCreationInput): Promise<string> {
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
      const result = await createSession(name, input.cwd, input.account, host, input.agent, input.worktree);
      const cwd = result.cwd ?? input.cwd;
      const current = useStore.getState();
      const destination = current.workspaces.some(item => item.id === workspaceId) ? workspaceId : DEFAULT_WORKSPACE_ID;
      const tileId = host ? `${host}::${name}` : name;
      rememberSessionAgent(tileId, input.agent && { id: input.agent.id, mode: input.agent.mode });
      current.assignSession(tileId, destination); current.setWorkspace(destination);
      current.openSession(name, cwd, host);
      notify({ category: "app", event: "session-opened", title: "Session window opened", body: `${name} on ${device.name}.`, target: { tileId } });
      if (result.setup) notifyWorktreeSetup(result.setup, result.setupStarted, name, tileId);
      if (input.agent && result.agentStarted === false) notify({ category: "app", event: "agent-start-failed", title: "Agent did not start", body: `${sessionAgent(input.agent.id)?.label ?? "The agent"} could not be started in ${name}. The terminal is open; start it manually.`, target: { tileId } });
      useSessionCreation.setState({ operation: { ...operation, status: "completed", tileId } });
      void current.loadSessions().catch(() => {});
      return tileId;
    } catch (error) {
      useSessionCreation.setState({ operation: { ...operation, status: "failed" }, error: error instanceof Error ? error.message : "Could not create the session." });
      throw error;
    }
  })();
}

// Says what a new worktree's repository setup did: files copied from the main
// checkout and commands started before the agent, or why commands were held
// back (not approved yet, an unreadable setup file, keys that did not reach
// the terminal).
function notifyWorktreeSetup(setup: WorktreeSetupReport, started: boolean | undefined, name: string, tileId: string): void {
  const parts: string[] = [];
  if (setup.copied.length) parts.push(`Copied ${setup.copied.length === 1 ? setup.copied[0] : `${setup.copied.length} files`} from the main checkout.`);
  if (setup.run.length) parts.push(started === false ? "The setup commands could not be typed into the terminal." : `Running ${setup.run.length === 1 ? setup.run[0] : `${setup.run.length} setup commands`} before the agent.`);
  if (setup.unapproved) parts.push("Its setup commands are not approved on this device yet; review them in Workspace settings → Worktrees.");
  if (setup.error) parts.push(setup.error);
  if (!parts.length) return;
  const problem = setup.unapproved || setup.error !== null || started === false;
  notify({ category: "app", title: problem ? "Worktree setup needs attention" : "Worktree set up", body: `${name}: ${parts.join(" ")}`, target: { tileId } });
}

const WORKTREE_COLLISION =/worktree for this session name already exists|may already exist/i;

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
  const mode = remembered?.id === definition.id && definition.modes.some(item => item.id === remembered.mode) ? remembered.mode : definition.modes[0].id;
  const modeLabel = definition.modes.find(item => item.id === mode)?.label ?? mode;
  const accepted = await confirmAction({
    title: "Move this session to its own worktree?",
    message: `Starts ${definition.label} (${modeLabel}) in a new tile next to this one, in a fresh worktree of this repository on a new pzza/ branch. This session keeps running; close it when you no longer need it.`,
    confirmLabel: "Start in worktree",
  });
  if (!accepted) return null;

  const base = input.session.replace(/[^A-Za-z0-9_ -]+/g, "-").replace(/^[\s-]+|[\s-]+$/g, "").slice(0, 100) || "session";
  const host = deviceHost(device);
  const taken = new Set([
    ...useStore.getState().tiles.filter(tile => (tile.host ?? "") === (input.host ?? "")).map(tile => tile.session ?? tile.name),
    ...(host ? [] : useStore.getState().allSessions.map(item => item.name)),
  ]);
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
