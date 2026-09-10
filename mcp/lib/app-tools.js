import { get, post } from "./agent.js";
import { APP_COMMANDS } from "../../server/lib/app-control-schema.js";

const READ_ONLY = new Set(["get_agents_hub_view", "get_notification_view", "get_sync_view", "terminal_read_output", "terminal_read_selection", "terminal_get_state", "get_integrations", "get_window", "get_state", "get_dictation", "get_notifications", "get_sync_preferences", "get_sync_state", "get_forwarding", "get_remote_desktop", "get_quick_chat", "get_updates", "editor_get_state", "editor_read_buffer", "editor_list_directory"]);
const DESTRUCTIVE = new Set(["terminal_submit", "terminal_key", "terminal_clear", "terminal_input", "terminal_paste", "install_integration", "check_integrations", "close_app", "relaunch_app", "delete_workspace", "remove_device", "close_tile", "terminate_tile", "cancel_dictation", "clear_notifications", "remove_notification", "sync_projects", "configure_forwarding", "configure_updates", "install_update", "editor_save", "editor_discard", "editor_move_file", "editor_delete_file"]);

export const APP_TOOLS = [
  { name: "app_list_clients", description: "List live app windows with app control enabled. Every UI command requires an explicit clientId.",
    annotations: { readOnlyHint: true, destructiveHint: false, openWorldHint: false },
    inputSchema: { type: "object", properties: {}, additionalProperties: false }, run: () => get("/app/control/clients") },
  ...Object.entries(APP_COMMANDS).map(([action, schema]) => ({
    name: `app_${action}`, description: schema.description,
    annotations: { readOnlyHint: READ_ONLY.has(action), destructiveHint: DESTRUCTIVE.has(action), openWorldHint: !READ_ONLY.has(action) },
    inputSchema: { ...schema, properties: { clientId: { type: "string", minLength: 1, maxLength: 128, description: "Explicit app client ID from app_list_clients" }, ...schema.properties }, required: ["clientId", ...schema.required] },
    run: ({ clientId, ...args }) => post("/app/control/command", { clientId, action, args }),
  })),
];
