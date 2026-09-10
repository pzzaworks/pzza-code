import { registerAppControlHandler, registerAppControlState, setAppControlMenu, afterAppControlReport } from "./appControlRuntime";
import { DICTATION_SUPPORTED, useDictation } from "./state/dictation";
import { redactTerminalOutput } from "./appControlTerminal";
import { isDictationLanguage } from "./dictationLanguages";
import { useNotifications, NOTIFICATION_EVENTS, type NotificationCategory, type NotificationEvent } from "./state/notifications";
import { requestDesktopAlerts } from "./desktopNotifications";
import { openNotice } from "./panels/Notifications";
import { confirmAction, type ConfirmationOptions } from "./ui/ConfirmDialog";
import { hasUnsavedWork } from "./state/unsavedWork";
import { useStore } from "./state/store";
import { createSessionInApp, useSessionCreation, type SessionCreationInput } from "./sessionActions";
import { HAS_TAURI } from "./tauriEnv";
import { relaunchApp } from "./updater";
import { DEFAULT_WORKSPACE_ID } from "./workspaces";

function dictationState() {
  const state = useDictation.getState();
  const recording = state.recording;
  return { supported: DICTATION_SUPPORTED, enabled: state.enabled, language: state.language, inputDevice: state.inputDevice,
    inputDevices: state.inputDevices, inputDevicesLoading: state.inputDevicesLoading, inputDevicesFailed: Boolean(state.inputDevicesError),
    model: state.model, downloadedBytes: state.downloadedBytes, totalBytes: state.totalBytes, warming: state.warming, failed: Boolean(state.error),
    recording: recording ? { tileId: recording.tileId, phase: recording.phase, level: recording.level, processing: recording.processing, failed: Boolean(recording.error) } : null };
}
function notificationState() {
  const state = useNotifications.getState();
  return { total: state.items.length, unread: state.items.filter(item => !item.read).length, preferences: state.preferences, events: NOTIFICATION_EVENTS };
}
function requireDictation() {
  if (!DICTATION_SUPPORTED) throw new Error("Voice input requires the macOS desktop app.");
  return useDictation.getState();
}

// The transport calls this before the synchronous command reducer. These
// actions must not bypass the same local decisions required by the visible UI.
export async function confirmAppControlAction(action: string, args: Readonly<Record<string, unknown>>): Promise<boolean> {
  const state = useStore.getState();
  let options: ConfirmationOptions | undefined;
  if (action === "delete_workspace") {
    const workspace = state.workspaces.find(item => item.id === args.workspaceId);
    if (workspace) options = { title: "Delete workspace?", message: `Delete ${workspace.name}? Its sessions will move to Main and keep running.`, confirmLabel: "Delete workspace", danger: true };
  } else if (action === "remove_device") {
    const device = state.devices.find(item => item.id === args.deviceId);
    if (device) options = { title: "Remove device?", message: `Remove ${device.name} from this app? The remote machine and its sessions are not deleted.`, confirmLabel: "Remove device", danger: true };
  } else if (action === "terminate_tile") {
    const tile = state.tiles.find(item => item.id === args.tileId);
    if (tile) options = { title: "Terminate session?", message: `Stop ${state.tileTitles[tile.id] ?? tile.name} and remove its affected tiles? Running processes will be terminated.`, confirmLabel: "Terminate", danger: true };
  } else if (action === "editor_delete_file") {
    options = { title: "Delete file or folder?", message: `Permanently delete ${String(args.path)}? A folder and everything inside it will be removed. This cannot be undone.`, confirmLabel: "Delete", danger: true };
  } else if (action === "editor_discard") {
    options = { title: "Discard editor changes?", message: "Reload this editor from disk and discard the requested unsaved buffer revision? This cannot be undone.", confirmLabel: "Discard changes", danger: true };
  } else if (action === "close_app" || action === "relaunch_app") {
    if (hasUnsavedWork()) throw new Error("Save or explicitly discard all editor and settings drafts before closing or restarting the app.");
    options = { title: action === "close_app" ? "Close the app?" : "Restart the app?", message: "This closes the current app window. Your terminal sessions continue running.", confirmLabel: action === "close_app" ? "Close app" : "Restart app" };
  } else if (action === "clear_notifications" && useNotifications.getState().items.length) {
    options = { title: "Clear notification history?", message: "Permanently remove all notification history on this device? This cannot be undone.", confirmLabel: "Clear history", danger: true };
  } else if (action === "configure_appearance" && args.osc52Clipboard === true && !state.osc52Clipboard) {
    options = { title: "Allow terminal clipboard writes?", message: "Programs running in your terminals will be able to replace your clipboard using OSC 52. Enable this only for programs you trust.", confirmLabel: "Allow clipboard writes" };
  }
  return !options || await confirmAction(options);
}

export function initCoreAppControlHandlers(): () => void {
  const operations = new Map<string, { status: "running" | "completed" | "failed" }>();
  function begin(name: string, operation: () => Promise<void>) {
    if (operations.get(name)?.status === "running") throw new Error("This operation is already running. Read the app state for progress.");
    const entry = { status: "running" as "running" | "completed" | "failed" };
    operations.set(name, entry);
    void operation().then(() => { entry.status = "completed"; }, () => { entry.status = "failed"; });
    return { accepted: true, operation: name, status: entry.status };
  }
  async function nativeWindow() {
    if (!HAS_TAURI) throw new Error("Native window controls require the desktop app.");
    return (await import("@tauri-apps/api/window")).getCurrentWindow();
  }
  const handlers: Record<string, (args: Readonly<Record<string, unknown>>) => unknown> = {
    create_session: args => {
      const pending = createSessionInApp({ name: args.name as string, deviceId: args.deviceId as string, workspaceId: args.workspaceId as string | undefined, cwd: args.cwd as string | undefined, account: args.account as SessionCreationInput["account"] });
      void pending.catch(() => {});
      return { accepted: true, operation: useSessionCreation.getState().operation };
    },
    get_window: async () => {
      if (!HAS_TAURI) return { supported: false };
      const window = await nativeWindow();
      const [visible, minimized, maximized, fullscreen] = await Promise.all([window.isVisible(), window.isMinimized(), window.isMaximized(), window.isFullscreen()]);
      return { supported: true, visible, minimized, maximized, fullscreen };
    },
    configure_window: async args => {
      const window = await nativeWindow();
      if (typeof args.visible === "boolean") await (args.visible ? window.show() : window.hide());
      if (typeof args.minimized === "boolean") await (args.minimized ? window.minimize() : window.unminimize());
      if (typeof args.maximized === "boolean" && await window.isMaximized() !== args.maximized) await window.toggleMaximize();
      if (typeof args.fullscreen === "boolean") await window.setFullscreen(args.fullscreen);
      return { configured: true };
    },
    close_app: () => {
      if (!HAS_TAURI) throw new Error("Closing the app requires the desktop app.");
      if (hasUnsavedWork()) throw new Error("Save or explicitly discard all editor and settings drafts before closing the app.");
      afterAppControlReport(async () => {
        const window = await nativeWindow();
        if (!hasUnsavedWork()) { globalThis.window.dispatchEvent(new Event("pzza:quick-chat-cancel")); await window.close(); }
      });
      return { accepted: true, closing: true };
    },
    relaunch_app: () => {
      if (!HAS_TAURI) throw new Error("Relaunch requires the desktop app.");
      if (hasUnsavedWork()) throw new Error("Save or explicitly discard all editor and settings drafts before relaunching the app.");
      afterAppControlReport(async () => { if (!hasUnsavedWork()) { window.dispatchEvent(new Event("pzza:quick-chat-cancel")); await relaunchApp(); } });
      return { accepted: true, relaunching: true };
    },
    open_menu: args => { setAppControlMenu(args.menu as string, args.open as boolean); return { menu: args.menu, open: args.open }; },
    get_dictation: dictationState,
    configure_dictation: args => {
      const state = requireDictation();
      if (args.language !== undefined && !isDictationLanguage(args.language)) throw new Error("Unsupported voice input language.");
      if (args.inputDeviceId !== undefined && state.recording) throw new Error("Stop recording before changing microphone input.");
      if (args.inputDeviceId && !state.inputDevices.some(device => device.id === args.inputDeviceId)) throw new Error("Refresh microphone inputs and choose an available input ID.");
      if (isDictationLanguage(args.language)) state.setLanguage(args.language);
      if (typeof args.inputDeviceId === "string") state.setInputDevice(args.inputDeviceId || null);
      if (typeof args.enabled === "boolean") state.setEnabled(args.enabled);
      return dictationState();
    },
    refresh_dictation_inputs: () => {
      const state = requireDictation();
      return begin("dictation_inputs", async () => { await state.refreshInputDevices(); if (useDictation.getState().inputDevicesError) throw new Error("Microphone discovery failed."); });
    },
    download_dictation_model: args => {
      const state = requireDictation();
      if (state.recording) throw new Error("Stop recording before replacing the voice model.");
      return begin("dictation_download", async () => { await state.download(args.replace === true); if (useDictation.getState().model === "error") throw new Error("Voice model download failed."); });
    },
    start_dictation: args => {
      const state = requireDictation();
      const store = useStore.getState();
      const tile = store.tiles.find(value => value.id === args.tileId);
      if (!tile) throw new Error("The requested session tile is not open.");
      if (!state.enabled || state.model !== "ready") throw new Error("Enable voice input and install its model before recording.");
      if (state.recording) throw new Error("Stop or cancel the current recording before starting another.");
      store.setWorkspace(store.sessionWs[(tile.host ? `${tile.host}::` : "") + (tile.session ?? tile.name)] ?? DEFAULT_WORKSPACE_ID);
      store.unhideTile(tile.id); store.setActive(tile.id);
      return begin("dictation_start", async () => { await state.start(tile.id); if (useDictation.getState().recording?.phase === "error") throw new Error("Voice input could not start."); });
    },
    stop_dictation: () => { const state = requireDictation(); return begin("dictation_stop", () => state.stop()); },
    cancel_dictation: () => { const state = requireDictation(); return begin("dictation_cancel", () => state.cancel()); },
    get_notifications: args => {
      const state = useNotifications.getState();
      const items = state.items.filter(item => (!args.unreadOnly || !item.read) && (!args.category || item.category === args.category));
      return { ...notificationState(), items: items.slice(0, args.limit as number | undefined ?? 30).map(({ id, category, event, title, body, createdAt, read, target }) => ({ id, category, event, title: redactTerminalOutput(title).text, body: redactTerminalOutput(body).text, createdAt, read, target })) };
    },
    configure_notifications: args => {
      const state = useNotifications.getState();
      const patch: Partial<typeof state.preferences> = {};
      if (typeof args.enabled === "boolean") patch.enabled = args.enabled;
      if (typeof args.desktop === "boolean") patch.desktop = args.desktop;
      if (typeof args.mutedUntil === "number") patch.mutedUntil = args.mutedUntil;
      if (Array.isArray(args.categories)) {
        const rows = args.categories as { category: NotificationCategory; enabled: boolean }[];
        if (new Set(rows.map(row => row.category)).size !== rows.length) throw new Error("Notification categories must be unique.");
        patch.categories = { ...state.preferences.categories, ...Object.fromEntries(rows.map(row => [row.category, row.enabled])) };
      }
      if (Array.isArray(args.events)) {
        const rows = args.events as { event: string; enabled: boolean }[];
        if (rows.some(row => !Object.hasOwn(NOTIFICATION_EVENTS, row.event)) || new Set(rows.map(row => row.event)).size !== rows.length) throw new Error("Choose unique, supported notification event names.");
        patch.events = { ...state.preferences.events, ...Object.fromEntries(rows.map(row => [row.event as NotificationEvent, row.enabled])) };
      }
      if (operations.get("notification_permission")?.status === "running") throw new Error("Wait for the pending notification permission request.");
      if (patch.desktop === true && !state.preferences.desktop) return begin("notification_permission", async () => {
        if (!await requestDesktopAlerts()) throw new Error("System notification permission was not granted.");
        useNotifications.getState().configure(patch);
      });
      state.configure(patch);
      return notificationState();
    },
    mark_notifications_read: args => { useNotifications.getState().read(args.id as string | undefined); return notificationState(); },
    remove_notification: args => { useNotifications.getState().remove(args.id as string); return notificationState(); },
    clear_notifications: () => { useNotifications.getState().clear(); return notificationState(); },
    open_notification: args => {
      const item = useNotifications.getState().items.find(value => value.id === args.id);
      if (!item) throw new Error("This notification is no longer available.");
      openNotice(item);
      return { id: item.id, opened: Boolean(item.target?.section || item.target?.tileId) };
    },
  };
  const cleanups = [
    registerAppControlState("sessionCreation", () => ({ operation: useSessionCreation.getState().operation, failed: Boolean(useSessionCreation.getState().error) })), registerAppControlState("platform", () => ({ desktop: HAS_TAURI, dictation: DICTATION_SUPPORTED, nativeWindow: HAS_TAURI, consent: "App control must be enabled locally." })), registerAppControlState("dictation", dictationState), registerAppControlState("notifications", notificationState),
    registerAppControlState("operations", () => Object.fromEntries(operations)),
    ...Object.entries(handlers).map(([action, handler]) => registerAppControlHandler(action, handler)),
  ];
  return () => cleanups.forEach(cleanup => cleanup());
}
