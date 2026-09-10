import { registerAppControlHandler, registerAppControlState } from "./appControlRuntime";
import { useStore } from "./state/store";
import { THIS_MAC, deviceHost } from "./devices";
import { useProjectSyncPreferences, updateProjectSyncPreferences, projectSyncSnapshot, startProjectOperation, cancelProjectOperation } from "./state/projectSync";
import { useForwardConfig, updateForwardConfig, reconcileSelectedForwarding } from "./panels/PortsMenu";
import { configureRemoteDesktop, openSaved, useRdpConnection } from "./panels/RdpMenu";
import { useQuickChatPreferences, useQuickChatView } from "./panels/QuickChat";
import { useUpdates } from "./state/updates";
import { DEFAULT_MIN_PORT, DEFAULT_SKIP, forwardScan } from "./forward";
import { fetchForwardState, setForwardEnabled, type SyncOptions } from "./serverApi";
import { HAS_TAURI } from "./tauriEnv";

const tasks = new Map<string, { id: string; status: "running" | "complete" | "failed"; error?: string }>();
function startTask(name: string, work: () => Promise<unknown>) {
  if (tasks.get(name)?.status === "running") throw new Error("This device operation is already running.");
  const id = crypto.randomUUID();
  tasks.set(name, { id, status: "running" });
  void work().then(() => tasks.set(name, { id, status: "complete" })).catch((error: unknown) => tasks.set(name, { id, status: "failed", error: error instanceof Error ? error.message : "Device operation failed." }));
  return { accepted: true, operation: tasks.get(name) };
}

function device(id: string) {
  const found = useStore.getState().devices.find(value => value.id === id);
  if (!found) throw new Error("The selected device is not configured in this window.");
  return found;
}
function syncPreferences() {
  const value = useProjectSyncPreferences.getState();
  return { ...value, options: { ...value.options, repos: Object.entries(value.options.repos).map(([id, option]) => ({ id, ...option })) } };
}
function configureSync(args: Readonly<Record<string, unknown>>) {
  const current = useProjectSyncPreferences.getState();
  const devicesOff = args.devicesOff === undefined ? current.devicesOff : args.devicesOff as string[];
  for (const id of devicesOff) device(id);
  const raw = args.options as (Partial<Omit<SyncOptions, "repos">> & { repos?: { id: string; enabled: boolean; env: boolean }[] }) | undefined;
  const options: SyncOptions = { ...current.options, ...raw, repos: raw?.repos ? Object.fromEntries(raw.repos.map(({ id, ...value }) => [id, value])) : current.options.repos };
  const activity = projectSyncSnapshot();
  if (activity.syncing || activity.operation?.status === "running") throw new Error("Wait for the current project operation before changing sync preferences.");
  updateProjectSyncPreferences({ root: typeof args.root === "string" ? args.root : current.root, options, devicesOff });
  return syncPreferences();
}
function forwardingConfig() {
  const config = useForwardConfig.getState();
  const serverId = config.serverId || useStore.getState().devices.find(value => value.id !== THIS_MAC.id)?.id || THIS_MAC.id;
  return { ...config, serverId };
}
async function forwarding(reconcile = false) {
  const config = forwardingConfig();
  if (!HAS_TAURI) return { ...config, operation: tasks.get("forwarding"), status: await fetchForwardState() };
  if (config.clientId !== THIS_MAC.id) throw new Error("Forwarding can only be received by this app's device.");
  const host = deviceHost(device(config.serverId));
  if (!host) return { ...config, operation: tasks.get("forwarding"), status: null };
  return { ...config, operation: tasks.get("forwarding"), status: reconcile ? await reconcileSelectedForwarding(host, config.enabled) : await forwardScan(host, DEFAULT_SKIP, DEFAULT_MIN_PORT) };
}
async function configureForwarding(args: Readonly<Record<string, unknown>>) {
  const previous = forwardingConfig();
  const next = { ...previous, ...args } as typeof previous;
  device(next.serverId); device(next.clientId);
  if (next.clientId !== THIS_MAC.id || next.serverId === THIS_MAC.id) throw new Error("Choose a remote source and this device as receiver.");
  if (!HAS_TAURI) {
    if (next.serverId !== previous.serverId || next.clientId !== previous.clientId) throw new Error("Choose forwarding devices in the desktop app.");
    await setForwardEnabled(next.enabled);
  } else {
    let oldHost = "";
    if (previous.serverId !== next.serverId && previous.clientId === THIS_MAC.id) {
      const oldDevice = useStore.getState().devices.find(value => value.id === previous.serverId);
      oldHost = oldDevice ? deviceHost(oldDevice) : "";
      if (oldHost) await reconcileSelectedForwarding(oldHost, false);
    }
    try {
      const status = await reconcileSelectedForwarding(deviceHost(device(next.serverId)), next.enabled);
      updateForwardConfig(next);
      return { ...next, status };
    } catch (error) {
      if (oldHost && previous.enabled) {
        try { await reconcileSelectedForwarding(oldHost, true); }
        catch { throw new Error("The new forwarding source failed and the previous connection could not be restored. Reconcile forwarding after checking SSH access."); }
      }
      throw error;
    }
  }
  updateForwardConfig(next);
  return forwarding();
}
function remoteDesktop() {
  const { serverId, busy } = useRdpConnection.getState();
  const config = useStore.getState().deviceRdp[serverId];
  return { serverId, busy, operation: tasks.get("remoteDesktop"), supported: HAS_TAURI, user: config?.user, port: config?.port, mode: config?.mode };
}
function quickChat() {
  const { defaults, notice } = useQuickChatPreferences.getState();
  return { defaults, notice, ...useQuickChatView.getState() };
}
function updates() {
  const { status, autoUpdate } = useUpdates.getState();
  return { supported: HAS_TAURI, autoUpdate, status: status.kind, ...("update" in status ? { version: status.update.version, currentVersion: status.update.currentVersion, date: status.update.date } : {}), ...("pct" in status ? { progress: status.pct } : {}), ...("msg" in status ? { error: status.msg } : {}) };
}
function desktopUpdates() { if (!HAS_TAURI) throw new Error("App updates are available in the desktop app."); }
export function initDeviceAppControlHandlers(): () => void {
  const handlers: Record<string, (args: Readonly<Record<string, unknown>>) => unknown | Promise<unknown>> = {
    get_sync_preferences: syncPreferences, configure_sync: configureSync, get_sync_state: projectSyncSnapshot,
    scan_projects: () => startProjectOperation("scan"), sync_projects: () => startProjectOperation("sync"), cancel_sync: cancelProjectOperation,
    get_forwarding: () => forwarding(), configure_forwarding: args => startTask("forwarding", () => configureForwarding(args)), reconcile_forwarding: () => startTask("forwarding", () => forwarding(true)),
    get_remote_desktop: remoteDesktop,
    configure_remote_desktop: args => { configureRemoteDesktop(String(args.serverId), typeof args.user === "string" ? args.user : undefined); return remoteDesktop(); },
    open_remote_desktop: () => startTask("remoteDesktop", async () => { if (!await openSaved()) throw new Error("Remote desktop could not be opened. Check the saved device and SSH connection."); }),
    get_quick_chat: quickChat,
    configure_quick_chat: args => { if (typeof args.deviceId === "string") device(args.deviceId); useQuickChatPreferences.getState().update(args as Partial<ReturnType<typeof useQuickChatPreferences.getState>["defaults"]>); return quickChat(); },
    open_quick_chat: () => { useQuickChatView.setState({ open: true }); return quickChat(); },
    close_quick_chat: () => { useQuickChatView.setState({ open: false }); return quickChat(); },
    get_updates: updates,
    configure_updates: args => { desktopUpdates(); useUpdates.getState().setAutoUpdate(args.autoUpdate === true); return updates(); },
    check_updates: () => { desktopUpdates(); void useUpdates.getState().check(true, false); return updates(); },
    install_update: args => { desktopUpdates(); const status = useUpdates.getState().status; if (status.kind !== "available" || status.update.version !== args.version) throw new Error("Check updates and select the exact available version before installing."); void useUpdates.getState().install(); return updates(); },
  };
  const cleanups = Object.entries(handlers).map(([action, handler]) => registerAppControlHandler(action, handler));
  cleanups.push(registerAppControlState("devices", () => ({ sync: syncPreferences(), syncActivity: projectSyncSnapshot(), forwarding: forwardingConfig(), remoteDesktop: remoteDesktop(), quickChat: quickChat(), updates: updates() })));
  return () => { for (const cleanup of cleanups) cleanup(); };
}
