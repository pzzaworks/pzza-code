const text = (maxLength = 128) => ({ type: "string", minLength: 1, maxLength, pattern: "^[^\\u0000-\\u001f\\u007f]+$" });
const boolean = { type: "boolean" };
const list = (items, maxItems = 64) => ({ type: "array", items, maxItems });
const command = (description, properties = {}, required = []) => ({ description, type: "object", properties, required, additionalProperties: false });
const repo = command("Repository sync choices", { id: text(512), enabled: boolean, env: boolean }, ["id", "enabled", "env"]);
export const DEVICE_APP_COMMANDS = {
  get_sync_preferences: command("Read the saved project root, sync options and excluded devices used by Settings."),
  configure_sync: command("Update explicit saved sync choices and the matching Settings controls. Does not begin a sync.", {
    root: { ...text(4096), pattern: "^~(?:/[^\\u0000-\\u001f\\u007f]*)?$" }, devicesOff: list(text()),
    options: command("Sync options", { cloneMissing: boolean, switchToDefault: boolean, stashDirty: boolean, syncEnvs: boolean, envExclude: list(text(512), 128), repos: list(repo, 2048) }),
  }),
  get_sync_state: command("Read the current scan, sync result and accepted operation status."),
  scan_projects: command("Start a scan using saved Settings and managed devices. Returns accepted/running; poll get_sync_state."),
  sync_projects: command("Start sync with the reviewed scan and saved Settings. May clone repositories, stash edits, switch branches and copy environment files when enabled. Returns accepted/running; poll get_sync_state."),
  cancel_sync: command("Request cancellation of the current sync while preserving the repository operation already in progress."),
  get_forwarding: command("Read saved source/receiver choices and currently forwarded ports."),
  configure_forwarding: command("Set the source, local receiver and enabled state, start reconciling its real SSH forwards. Returns accepted/running; poll get_forwarding.", { serverId: text(), clientId: text(), enabled: boolean }),
  reconcile_forwarding: command("Reconcile the selected source's ports with saved forwarding settings. Returns accepted/running; poll get_forwarding."),
  get_remote_desktop: command("Read the saved remote desktop destination and non-secret connection status."),
  configure_remote_desktop: command("Select an existing remote device and optionally its desktop account. Passwords stay in the system keychain.", { serverId: text(), user: { ...text(64), pattern: "^[A-Za-z_][A-Za-z0-9_-]{0,63}$" } }, ["serverId"]),
  open_remote_desktop: command("Open the saved SSH-tunneled desktop connection using its system keychain credentials. Returns accepted/running; poll get_remote_desktop."),
  get_quick_chat: command("Read Quick Chat defaults, open state and session metadata without terminal output."),
  configure_quick_chat: command("Update the saved device and profile for the next Quick Chat launch. Codex launches through pz.", { deviceId: text(), agent: { type: "string", enum: ["claude", "codex"] } }),
  open_quick_chat: command("Show the existing Quick Chat panel. Returns its current opening or ready state; hiding never terminates it."),
  close_quick_chat: command("Hide Quick Chat while keeping its conversation running."),
  get_updates: command("Read update availability and download/install progress."),
  configure_updates: command("Set automatic updates. Enabling can install an update already waiting, matching Settings behavior.", { autoUpdate: boolean }, ["autoUpdate"]),
  check_updates: command("Check for a signed app update without installing it. Returns running state; poll get_updates."),
  install_update: command("Begin installing the exact previously checked version. Returns running state; poll get_updates. Does not restart the app.", { version: text(80) }, ["version"]),
};
