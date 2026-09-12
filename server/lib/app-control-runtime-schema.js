import { SESSION_NAME_SCHEMA } from "./session-name.js";

const string = (maxLength = 512) => ({ type: "string", minLength: 1, maxLength, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const enumeration = (...values) => ({ type: "string", enum: values });
const boolean = { type: "boolean" };
const integer = (minimum, maximum) => ({ type: "integer", minimum, maximum });
const command = (description, properties = {}, required = []) => ({ description, type: "object", properties, required, additionalProperties: false });
const rows = (properties, required, maxItems) => ({ type: "array", maxItems, uniqueItems: true, items: { type: "object", properties, required, additionalProperties: false } });
const tileId = string();
export const RUNTIME_APP_COMMANDS = {
  get_notification_view: command("Read the open notification page's history filters and event disclosure."),
  set_notification_view: command("Set filters, visible item count or event disclosure in the open Notifications settings page.", { unreadOnly: boolean, category: enumeration("all", "sync", "terminal", "devices", "app"), limit: integer(1, 300), eventsExpanded: boolean }),
  get_sync_view: command("Read the mounted Sync repository filter, folder paths and expanded project IDs."),
  set_sync_view: command("Set the attention filter and expanded folders/projects in the open Sync repositories page.", { filter: enumeration("all", "attention"), expandedFolders: { type: "array", maxItems: 1000, uniqueItems: true, items: string(4096) }, expandedProjects: { type: "array", maxItems: 1000, uniqueItems: true, items: string(4096) } }),
  create_session: command("Create a session on a configured device and open it in the chosen workspace. Returns accepted operation state; poll get_state runtime.sessionCreation for completion.", {
    name: SESSION_NAME_SCHEMA, deviceId: string(128), workspaceId: string(128),
    cwd: { type: "string", minLength: 1, maxLength: 4096, pattern: "^/[^\\u0000-\\u001f\\u007f]*$" },
    account: { type: "object", properties: { provider: enumeration("claude", "codex"), dir: { type: "string", minLength: 1, maxLength: 4096, pattern: "^/[^\\u0000-\\u001f\\u007f]*$" } }, required: ["provider", "dir"], additionalProperties: false },
  }, ["name", "deviceId"]),
  get_window: command("Read native window state and platform availability."),
  configure_window: command("Set native window visibility, minimization, maximization or fullscreen state.", { visible: boolean, minimized: boolean, maximized: boolean, fullscreen: boolean }),
  close_app: command("Close the desktop app after acknowledging this request. Refuses any unsaved or saving editor."),
  relaunch_app: command("Relaunch the desktop app after acknowledging this request. Refuses any unsaved or saving editor."),
  navigate: command("Open the existing session/workspace form, setup wizard, or return to the terminal canvas.", { target: enumeration("terminal", "new_session", "new_workspace", "setup") }, ["target"]),
  open_settings: command("Open an app settings section, optionally selecting its subpage.", { section: enumeration("general", "notifications", "quick-chat", "devices", "sync", "mcp", "remote", "ports", "help", "about"), page: string(80) }, ["section"]),
  open_help: command("Open a specific existing help topic.", { topic: string(80) }, ["topic"]),
  open_menu: command("Open or close a named toolbar dropdown using its actual control.", { menu: enumeration("layout", "remote_desktop", "port_forwarding", "usage", "notifications", "new_session", "quick_chat"), open: boolean }, ["menu", "open"]),
  set_focus_mode: command("Enable or disable the tile focus mode that dims other sessions.", { tileId, enabled: boolean }, ["tileId", "enabled"]),
  set_fullscreen: command("Maximize or restore a session tile in its workspace.", { tileId, enabled: boolean }, ["tileId", "enabled"]),
  duplicate_tile: command("Duplicate an existing session using the same device and workspace.", { tileId }, ["tileId"]),
  terminate_tile: command("Terminate the tile's tmux window or session and remove its affected tiles. Rejects unsaved editors.", { tileId }, ["tileId"]),
  get_dictation: command("Read dictation status and microphone devices without returning recorded speech."),
  configure_dictation: command("Persist dictation preferences. An empty inputDeviceId selects the default microphone.", { enabled: boolean, language: string(32), inputDeviceId: { type: "string", maxLength: 4096 } }),
  refresh_dictation_inputs: command("Refresh the available input-device list."),
  download_dictation_model: command("Start the model download and read progress through get_dictation; does not wait for completion.", { replace: boolean }),
  start_dictation: command("Start microphone dictation in a ready, connected tile.", { tileId }, ["tileId"]),
  stop_dictation: command("Stop recording and finalize pending speech."),
  cancel_dictation: command("Cancel capture or pending recognition."),
  get_notifications: command("Read a bounded notification history and preferences.", { limit: integer(1, 100), unreadOnly: boolean, category: enumeration("sync", "terminal", "devices", "app") }),
  configure_notifications: command("Persist notification preferences. System alerts request the normal platform permission.", { enabled: boolean, desktop: boolean, mutedUntil: integer(0, 8640000000000000), categories: rows({ category: enumeration("sync", "terminal", "devices", "app"), enabled: boolean }, ["category", "enabled"], 4), events: rows({ event: string(80), enabled: boolean }, ["event", "enabled"], 64) }),
  mark_notifications_read: command("Mark a notification read, or all notifications when id is omitted.", { id: string(128) }),
  remove_notification: command("Remove a specific notification from history.", { id: string(128) }, ["id"]),
  clear_notifications: command("Clear notification history on this app client."),
  open_notification: command("Open a notification's existing target and mark it read.", { id: string(128) }, ["id"]),
};
