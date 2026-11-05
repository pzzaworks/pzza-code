import { invoke } from "@tauri-apps/api/core";
import { HAS_TAURI } from "../tauriEnv";

// macOS privacy permissions. Terminals (and the tmux server behind them) run
// as PzzaCode, so these grants cover every shell and tool started in the app.
export const PERMISSIONS_SUPPORTED = HAS_TAURI && /mac/i.test(navigator.platform || navigator.userAgent);

export type PermissionId = "fullDiskAccess" | "microphone" | "screenRecording" | "accessibility" | "automation";
export type PermissionStatus = "granted" | "notGranted" | "denied" | "unknown";

export interface PermissionInfo {
  id: PermissionId;
  label: string;
  reason: string;
  /** macOS applies the grant to running processes only after a relaunch. */
  needsRestart: boolean;
}

export const PERMISSIONS: readonly PermissionInfo[] = [
  { id: "fullDiskAccess", label: "Full Disk Access", reason: "Lets terminals and agents read protected folders such as Desktop, Documents, Downloads, Mail and iCloud Drive without repeated prompts.", needsRestart: true },
  { id: "microphone", label: "Microphone", reason: "On-device dictation and command-line tools that record audio.", needsRestart: false },
  { id: "screenRecording", label: "Screen Recording", reason: "Screenshots and screen capture from terminal tools and agents.", needsRestart: true },
  { id: "accessibility", label: "Accessibility", reason: "Tools that drive the keyboard, mouse or other app windows.", needsRestart: false },
  { id: "automation", label: "Automation", reason: "AppleScript and osascript controlling System Events and other apps.", needsRestart: false },
];

export async function permissionStatuses(): Promise<Partial<Record<PermissionId, PermissionStatus>>> {
  const states = await invoke<{ id: PermissionId; status: PermissionStatus }[]>("permissions_status");
  return Object.fromEntries(states.map(state => [state.id, state.status]));
}

export function requestPermission(id: PermissionId): Promise<PermissionStatus> {
  return invoke<PermissionStatus>("permission_request", { id });
}

export function openPermissionSettings(id: PermissionId): Promise<void> {
  return invoke("permission_open_settings", { id });
}

/** Installs tmux with Homebrew on this Mac when missing, then starts local terminals. */
export function installTmux(): Promise<void> {
  return invoke("tmux_install");
}
