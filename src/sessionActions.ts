import { create } from "zustand";
import { useStore } from "./state/store";
import { deviceHost } from "./devices";
import { ALL_WORKSPACE_ID, DEFAULT_WORKSPACE_ID } from "./workspaces";
import { createSession } from "./serverApi";
import { notify } from "./state/notifications";
import { normalizeSessionName } from "../server/lib/session-name.js";

export interface SessionCreationInput {
  name: string;
  deviceId: string;
  workspaceId?: string;
  cwd?: string;
  account?: { provider: "claude" | "codex"; dir: string };
}
interface Creation {
  id: string; status: "running" | "completed" | "failed"; name: string; host: string; workspaceId: string; tileId?: string;
}
export const useSessionCreation = create<{ operation: Creation | null; error: string | null }>(() => ({ operation: null, error: null }));

export function createSessionInApp(input: SessionCreationInput): Promise<string> {
  const state = useStore.getState();
  const name = normalizeSessionName(input.name);
  const device = state.devices.find(item => item.id === input.deviceId);
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
      await createSession(name, input.cwd, input.account, host);
      const current = useStore.getState();
      const destination = current.workspaces.some(item => item.id === workspaceId) ? workspaceId : DEFAULT_WORKSPACE_ID;
      const tileId = host ? `${host}::${name}` : name;
      current.assignSession(tileId, destination); current.setWorkspace(destination);
      current.openSession(name, input.cwd, host);
      notify({ category: "app", event: "session-opened", title: "Session window opened", body: `${name} on ${device.name}.`, target: { tileId } });
      useSessionCreation.setState({ operation: { ...operation, status: "completed", tileId } });
      void current.loadSessions().catch(() => {});
      return tileId;
    } catch (error) {
      useSessionCreation.setState({ operation: { ...operation, status: "failed" }, error: error instanceof Error ? error.message : "Could not create the session." });
      throw error;
    }
  })();
}
