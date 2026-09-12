import { TERMINAL_APP_COMMANDS } from "./app-control-terminal-schema.js";
import { INTEGRATION_APP_COMMANDS } from "./app-control-integration-schema.js";
import { DEVICE_APP_COMMANDS } from "./app-control-device-schema.js";
import { EDITOR_APP_COMMANDS } from "./app-control-editor-schema.js";
import { RUNTIME_APP_COMMANDS } from "./app-control-runtime-schema.js";
import { SESSION_NAME_SCHEMA } from "./session-name.js";

// Shared bounded schemas drive server validation, frontend validation and tools.
const command = (description, properties = {}, required = []) => ({ description, type: "object", properties, required, additionalProperties: false });
export const APP_COMMANDS = {
  ...TERMINAL_APP_COMMANDS, ...RUNTIME_APP_COMMANDS, ...DEVICE_APP_COMMANDS, ...EDITOR_APP_COMMANDS, ...INTEGRATION_APP_COMMANDS,
  get_state: command("Read the selected app window state, available actions and non-secret preferences.", {}, []),
  open_session: command("Open or reveal a session or tmux window on a selected device. Omitted host means local; use create_session first when the session does not exist.", {
    host: {"type":"string","maxLength":128,"pattern":"^(?:[A-Za-z0-9._][A-Za-z0-9._@-]{0,127})?$"},
    window: {"type":"integer","minimum":0,"maximum":2147483647},
    session: SESSION_NAME_SCHEMA,
    cwd: {"type":"string","minLength":1,"maxLength":4096,"pattern":"^/[^\\u0000-\\u001f\\u007f]*$"},
  }, ["session","cwd"]),
  focus_tile: command("Focus and reveal an existing tile.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["tileId"]),
  open_editor: command("Open a tile editor and select a root or path, protecting unsaved changes.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    path: {"type":"string","minLength":1,"maxLength":4096,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    root: {"type":"string","minLength":1,"maxLength":4096,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    layout: {"type":"string","enum":["full","side-by-side","stacked"]},
  }, ["tileId"]),
  close_editor: command("Close the editor only when it has no unsaved changes.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["tileId"]),
  set_layout: command("Set the layout of an open editor.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    layout: {"type":"string","enum":["full","side-by-side","stacked"]},
  }, ["tileId","layout"]),
  set_columns: command("Set the active workspace grid width.", {
    columns: {"type":"integer","minimum":1,"maximum":8},
  }, ["columns"]),
  set_workspace: command("Activate an existing workspace, including All.", {
    workspaceId: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["workspaceId"]),
  create_workspace: command("Create and activate a workspace.", {
    name: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    icon: {"type":"string","minLength":1,"maxLength":80,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    color: {"type":"string","minLength":1,"maxLength":7,"pattern":"^#[0-9a-fA-F]{6}$"},
  }, ["name"]),
  configure_workspace: command("Rename a workspace or change its icon and color.", {
    workspaceId: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    name: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    icon: {"type":"string","minLength":1,"maxLength":80,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    color: {"type":"string","minLength":1,"maxLength":7,"pattern":"^#[0-9a-fA-F]{6}$"},
  }, ["workspaceId"]),
  delete_workspace: command("Delete a non-default workspace and move its sessions to Main; sessions keep running.", {
    workspaceId: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["workspaceId"]),
  reorder_workspace: command("Move a workspace before or after another; All stays first.", {
    workspaceId: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    targetId: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    placement: {"type":"string","enum":["before","after"]},
  }, ["workspaceId","targetId","placement"]),
  assign_tile: command("Assign a tile and sibling windows of its session to a workspace.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    workspaceId: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["tileId","workspaceId"]),
  rename_tile: command("Change a tile display title; this does not rename its tmux session.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    name: {"type":"string","minLength":1,"maxLength":256,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["tileId","name"]),
  hide_tile: command("Hide a tile while keeping its terminal running.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["tileId"]),
  show_tile: command("Reveal a hidden tile without switching the active workspace.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["tileId"]),
  close_tile: command("Detach a tile without terminating its tmux session. Rejects unsaved editor changes.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["tileId"]),
  reorder_tile: command("Move a tile before another tile.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    targetId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["tileId","targetId"]),
  set_tile_span: command("Set a tile grid span.", {
    tileId: {"type":"string","minLength":1,"maxLength":512,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    columns: {"type":"integer","minimum":1,"maximum":8},
    rows: {"type":"integer","minimum":1,"maximum":8},
  }, ["tileId","columns","rows"]),
  configure_appearance: command("Persist app/terminal appearance and clipboard preferences.", {
    theme: {"type":"string","enum":["dark","light"]},
    fontSize: {"type":"integer","minimum":9,"maximum":20},
    cursorBlink: {"type":"boolean"},
    osc52Clipboard: {"type":"boolean"},
    semiTransparent: {"type":"boolean"},
    opacity: {"type":"integer","minimum":5,"maximum":95},
    blur: {"type":"integer","minimum":0,"maximum":40},
    saturation: {"type":"integer","minimum":50,"maximum":180},
    surfaceOpacity: {"type":"integer","minimum":5,"maximum":100},
    textVisibility: {"type":"integer","minimum":0,"maximum":100},
    desktopBlur: {"type":"boolean"},
    desktopBlurRadius: {"type":"integer","minimum":0,"maximum":64},
  }, []),
  add_device: command("Add a managed SSH device; this does not provision its agent.", {
    name: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
    host: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z0-9._][A-Za-z0-9._@-]{0,127}$"},
    user: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[A-Za-z_][A-Za-z0-9_.-]*$"},
  }, ["name","host"]),
  remove_device: command("Remove a managed remote device from app preferences without changing the remote machine.", {
    deviceId: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["deviceId"]),
  set_connection: command("Select a configured device as the default terminal connection.", {
    deviceId: {"type":"string","minLength":1,"maxLength":128,"pattern":"^[^\\u0000-\\u001f\\u007f]+$"},
  }, ["deviceId"]),
  refresh_sessions: command("Start refreshing the app session inventory; poll sessionsRefreshing for completion.", {}, []),
};

export function validateAppCommand(action, args) {
  if (typeof action !== "string" || !Object.hasOwn(APP_COMMANDS, action)) throw new Error("Unknown app control action.");
  const stableValue = value => Array.isArray(value) ? value.map(stableValue)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stableValue(value[key])])) : value;
  const check = (schema, value, field) => {
    if (schema.type === "object") {
      if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${field} must be an object.`);
      if (Object.keys(value).some(key => !Object.hasOwn(schema.properties, key))) throw new Error(`Unknown ${field} argument.`);
      if (schema.minProperties && Object.keys(value).length < schema.minProperties) throw new Error(`${field} must include a setting.`);
      for (const key of schema.required ?? []) if (!Object.hasOwn(value, key)) throw new Error(`${key} is required.`);
      for (const [key, item] of Object.entries(value)) check(schema.properties[key], item, key);
    } else if (schema.type === "array") {
      if (!Array.isArray(value) || value.length > schema.maxItems || value.length < (schema.minItems ?? 0)) throw new Error(`Invalid ${field}.`);
      for (const item of value) check(schema.items, item, field);
      if (schema.uniqueItems && new Set(value.map(item => JSON.stringify(stableValue(item)))).size !== value.length) throw new Error(`${field} must contain unique items.`);
    } else if (schema.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value) || value < schema.minimum || value > schema.maximum) throw new Error(`Invalid ${field}.`);
    } else if (schema.type === "string") {
      if (typeof value !== "string" || (schema.minLength && value.trim().length < schema.minLength) || value.length > (schema.maxLength ?? Infinity) || (schema.pattern && !new RegExp(schema.pattern).test(value)) || (schema.enum && !schema.enum.includes(value))) throw new Error(`Invalid ${field}.`);
    } else if (schema.type === "integer") {
      if (!Number.isInteger(value) || value < schema.minimum || value > schema.maximum) throw new Error(`Invalid ${field}.`);
    } else if (schema.type === "boolean" && typeof value !== "boolean") throw new Error(`Invalid ${field}.`);
  };
  check(APP_COMMANDS[action], args, "command");
  return { ...args };
}
