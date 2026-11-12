import { invoke } from "@tauri-apps/api/core";
import { HAS_TAURI } from "../tauriEnv";
import { fetchPaneLines, fetchPaneMode } from "../serverApi";

// The tmux pane a tile's keys reach: the active pane of its session's
// current window, or of its window.
export interface PaneTarget {
  host?: string;
  session: string;
  window?: number;
}

// Typed input waits on a leave, so both calls are bounded.
const TIMEOUT_MS = 4000;

// The app asks tmux directly (over its shared ssh master for a remote
// device); the browser build asks the device agent.
function paneMode(target: PaneTarget, leave: boolean): Promise<boolean> {
  if (HAS_TAURI) {
    return invoke<boolean>("tmux_pane_mode", { host: target.host || null, session: target.session, window: target.window ?? null, leave });
  }
  return fetchPaneMode(target.session, target.window, target.host, leave, AbortSignal.timeout(TIMEOUT_MS));
}

export const paneInMode = (target: PaneTarget): Promise<boolean> => paneMode(target, false);

export async function leavePaneMode(target: PaneTarget): Promise<void> {
  await paneMode(target, true);
}

// The pane's recent history and visible rows in one capture, oldest first,
// wrapped as on screen (the device bounds how far back it reads).
export function paneLines(target: PaneTarget): Promise<string[]> {
  if (HAS_TAURI) return invoke<string[]>("tmux_pane_lines", { host: target.host || null, session: target.session, window: target.window ?? null });
  return fetchPaneLines(target.session, target.window, target.host, AbortSignal.timeout(TIMEOUT_MS));
}
