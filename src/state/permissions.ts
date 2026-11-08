import { invoke } from "@tauri-apps/api/core";
import { HAS_TAURI } from "../tauriEnv";

// macOS privacy permissions. Terminals (and the tmux server behind them) run
// as PzzaCode, so these grants cover every shell and tool started in the app.
export const PERMISSIONS_SUPPORTED = HAS_TAURI && /mac/i.test(navigator.platform || navigator.userAgent);

export type PermissionId = "fullDiskAccess" | "microphone" | "screenRecording" | "accessibility" | "automation"
  | "tmuxFullDiskAccess" | "tmuxAccessibility" | "tmuxScreenRecording";
export type PermissionStatus = "granted" | "notGranted" | "denied" | "unknown";

export interface PermissionInfo {
  id: PermissionId;
  /** Who receives the grant: the app, or the tmux binary itself. */
  subject: "app" | "tmux";
  label: string;
  reason: string;
  /** One line for onboarding. */
  short: string;
  /** macOS applies the grant to running processes only after a relaunch. */
  needsRestart: boolean;
}

export const PERMISSIONS: readonly PermissionInfo[] = [
  { id: "fullDiskAccess", subject: "app", label: "Full Disk Access", reason: "Lets terminals and agents read protected folders such as Desktop, Documents, Downloads, Mail and iCloud Drive without repeated prompts.", short: "Read Desktop, Documents, Downloads and iCloud Drive", needsRestart: true },
  { id: "microphone", subject: "app", label: "Microphone", reason: "On-device dictation and command-line tools that record audio.", short: "Dictation and tools that record audio", needsRestart: false },
  { id: "screenRecording", subject: "app", label: "Screen Recording", reason: "Screenshots and screen capture from terminal tools and agents.", short: "Screenshots and screen capture from tools", needsRestart: true },
  { id: "accessibility", subject: "app", label: "Accessibility", reason: "Tools that drive the keyboard, mouse or other app windows.", short: "Tools that drive the keyboard, mouse and windows", needsRestart: false },
  { id: "automation", subject: "app", label: "Automation", reason: "AppleScript and osascript controlling System Events and other apps.", short: "AppleScript control of other apps", needsRestart: false },
  { id: "tmuxFullDiskAccess", subject: "tmux", label: "Full Disk Access", reason: "Drag tmux from the Finder window into the list.", short: "Drag tmux into the list", needsRestart: false },
  { id: "tmuxAccessibility", subject: "tmux", label: "Accessibility", reason: "Drag tmux from the Finder window into the list.", short: "Drag tmux into the list", needsRestart: false },
  { id: "tmuxScreenRecording", subject: "tmux", label: "Screen Recording", reason: "Drag tmux from the Finder window into the list.", short: "Drag tmux into the list", needsRestart: false },
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

export interface SetupStatus {
  homebrew: string | null;
  node: string | null;
  tmux: string | null;
  agentRunning: boolean;
  agents: { id: "claude" | "codex" | "opencode"; path: string | null }[];
}
export type SetupItem = "homebrew" | "node" | "tmux";

/** What onboarding needs on this Mac, resolved against the login PATH. */
export function setupStatus(): Promise<SetupStatus> {
  return invoke("setup_status");
}

/** Installs one requirement: Node.js and tmux through Homebrew, Homebrew itself in Terminal. */
export function setupInstall(item: SetupItem): Promise<void> {
  return invoke("setup_install", { item });
}
