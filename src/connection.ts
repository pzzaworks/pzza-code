import { invoke } from "@tauri-apps/api/core";
import { HAS_TAURI } from "./tauriEnv";

// How the app reaches the devbox. host === null means "run tmux locally" (used
// when the app itself runs on the devbox for testing); a host string means hop
// over ssh with that Host alias (the normal case, from the Mac: "devbox").
export interface Connection {
  host: string | null;
}

const STORAGE_KEY = "pzza.connection";

function defaultHost(): string | null {
  // On the Mac (production) reach the devbox over ssh; on the linux devbox
  // itself talk to tmux directly.
  const platform =
    typeof navigator !== "undefined" ? navigator.platform || "" : "";
  return /mac/i.test(platform) ? "devbox" : null;
}

export function loadConnection(): Connection {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) return JSON.parse(raw) as Connection;
  } catch {
    /* fall through to default */
  }
  return { host: defaultHost() };
}

export function saveConnection(conn: Connection): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(conn));
  } catch {
    /* preview / private mode - not fatal */
  }
}

// Single-quote a value for safe embedding in a remote shell command string.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SpawnCmd {
  cmd: string;
  args: string[];
}

// Command that attaches to (or creates, with -A) a named tmux session. Over ssh
// the whole tmux invocation is one remote-shell string; locally the args are
// passed directly so spaces in a session name need no quoting.
export function attachCommand(
  conn: Connection,
  session: string,
  cwd?: string,
  window?: number,
): SpawnCmd {
  let remote: string;
  if (window !== undefined) {
    // View a specific window through a grouped session (independent view,
    // auto-destroyed on detach).
    const view = `pzza-v-${Date.now().toString(36)}`;
    remote =
      `tmux new-session -d -t ${shQuote(session)} -s ${shQuote(view)} 2>/dev/null; ` +
      `tmux set-option -t ${shQuote(view)} destroy-unattached on 2>/dev/null; ` +
      `tmux select-window -t ${shQuote(view + ":" + window)} 2>/dev/null; ` +
      `exec tmux attach -t ${shQuote(view)}`;
  } else {
    remote = `exec tmux new-session -A -s ${shQuote(session)}${cwd ? ` -c ${shQuote(cwd)}` : ""}`;
  }
  if (conn.host) {
    return { cmd: "ssh", args: ["-tt", conn.host, `sh -lc ${shQuote(remote)}`] };
  }
  return { cmd: "sh", args: ["-lc", remote] };
}

export interface RemoteSession {
  name: string;
  windows: number;
  attached: boolean;
  command?: string; // active pane's current command (for the tile icon)
  path?: string; // active pane's current working directory
}

// Ask the backend for the tmux sessions currently on the devbox.
export async function listRemoteSessions(
  conn: Connection,
): Promise<RemoteSession[]> {
  if (!HAS_TAURI) return [];
  return invoke<RemoteSession[]>("tmux_list_sessions", { host: conn.host });
}
