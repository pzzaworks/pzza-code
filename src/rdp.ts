import { invoke } from "@tauri-apps/api/core";

// Open the device's configured Remote Login, or its unlocked desktop-sharing
// session, through a private SSH tunnel and the native desktop viewer.
export interface RdpOptions {
  host: string; // ssh target: alias or user@host
  port?: number;
  identity?: string;
  user: string; // RDP account on the device
  keychainService: string;
}

// What the launch found on the device: desktop service and port.
export interface Launched {
  port: number;
  mode: string;
}

const errorCodes = new Set([
  "RDP_INVALID_OPTIONS", "RDP_CREDENTIALS", "RDP_SETUP_FAILED", "RDP_DESKTOP_LOCKED",
  "RDP_SSH_FAILED", "RDP_VIEWER_MISSING", "RDP_AUTH_FAILED", "RDP_CONNECT_FAILED", "RDP_TASK_FAILED",
]);
const fallbackError = "Check the server in Settings → Connections → Remote desktop and its SSH connection, then try again.";

export function rdpErrorMessage(error: unknown): string {
  if (!error || typeof error !== "object" || !("code" in error) || typeof error.code !== "string" || !errorCodes.has(error.code) ||
    !("message" in error) || typeof error.message !== "string") return fallbackError;
  const message = error.message.trim();
  // Only structured native failures may supply display text; process output stays out of notifications.
  return message && message.length <= 300 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(message) ? message : fallbackError;
}

export function rdpLaunch(opts: RdpOptions): Promise<Launched> {
  return invoke<Launched>("rdp_launch", { opts });
}

// Whether a desktop window is already open for this device (its Keychain key).
export function rdpIsOpen(keychainService: string): Promise<boolean> {
  return invoke<boolean>("rdp_is_open", { keychainService });
}
