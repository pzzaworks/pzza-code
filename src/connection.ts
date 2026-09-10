import { invoke } from "@tauri-apps/api/core";
import { HAS_TAURI } from "./tauriEnv";

// How the app reaches the devbox. host === null means "run tmux locally" (used
// when the app itself runs on the devbox for testing); a host string means hop
// over ssh with that Host alias (the normal case, from the Mac: "devbox").
export interface Connection {
  host: string | null;
}

// An empty tile host explicitly selects this device; only an absent host
// inherits the default connection.
export function sessionConnection(host: string | undefined, fallback: Connection): Connection {
  return { host: host === undefined ? fallback.host : host || null };
}

const STORAGE_KEY = "pzza.connection";

function defaultHost(): string | null {
  // The app runs its own agent on the local machine, so a fresh install talks
  // to tmux locally (host === null). A remote box is only reached over ssh once
  // the user adds it as a device and points the connection at it.
  return null;
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

// App-owned ssh connection multiplexing. Every tile to the same host shares one
// real ssh connection through this control socket, so opening several tiles at
// once reuses a single connection instead of firing a burst of independent
// connections (each re-resolving the host - an mDNS storm that can fail). A
// command-line `-o` overrides ~/.ssh/config, so this works whether or not the
// user configured ControlMaster themselves. The ControlPath MUST match the one
// the native side uses (src-tauri/src/sshmux.rs), or they would not share a
// master; the RDP tunnel deliberately opts out.
const SSH_MUX = [
  "-o",
  "ControlMaster=auto",
  "-o",
  "ControlPath=~/.ssh/pzza-mux-%C",
  "-o",
  "ControlPersist=120",
  "-o",
  "ServerAliveInterval=30",
  "-o",
  "ServerAliveCountMax=3",
];

// Single-quote a value for safe embedding in a remote shell command string.
function shQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

export interface SpawnCmd {
  cmd: string;
  args: string[];
}

// Command that attaches to (or creates, with -A) a named tmux session. Over ssh
// the whole tmux invocation is one remote-shell string. Local clients receive
// their service socket from the native process environment. `-u` makes tmux
// write UTF-8 to this client even when the locale env does not advertise it.
export function attachCommand(
  conn: Connection,
  session: string,
  cwd?: string,
  window?: number,
  managedChat?: { agent: "claude" | "codex"; identity: string },
): SpawnCmd {
  const tmux = conn.host ? "tmux" : '"$@"';
  // A server started without a locale (e.g. by an older build) keeps spawning
  // shells that cannot handle multibyte input; give its environment a UTF-8
  // LANG once so every new window/pane gets one.
  const heal = `${tmux} show-environment -g LANG >/dev/null 2>&1 || ${tmux} set-environment -g LANG "\${LANG:-en_US.UTF-8}" 2>/dev/null; `;
  let remote: string;
  if (managedChat) {
    if (session !== "pzza-quick-chat" || window !== undefined ||
        !/^\$[0-9]+:[0-9]+:[0-9]+$/.test(managedChat.identity) ||
        (managedChat.agent !== "claude" && managedChat.agent !== "codex")) throw new Error("Invalid Quick Chat attachment.");
    const target = shQuote("=pzza-quick-chat");
    remote = `${tmux} has-session -t ${target} 2>/dev/null || exit 45; ` +
      `[ "$(${tmux} show-environment -t ${target} PZZA_QUICK_CHAT_AGENT 2>/dev/null)" = ${shQuote(`PZZA_QUICK_CHAT_AGENT=${managedChat.agent}`)} ] || exit 44; ` +
      `[ "$(${tmux} display-message -p -t '=pzza-quick-chat:' '#{session_id}:#{session_created}:#{pid}' 2>/dev/null)" = ${shQuote(managedChat.identity)} ] || exit 45; ` +
      `exec ${tmux} -u attach -t ${shQuote(managedChat.identity.split(":")[0])}`;
  } else if (window !== undefined) {
    // View a specific window through a grouped session (independent view,
    // auto-destroyed on detach).
    const view = `pzza-v-${Date.now().toString(36)}`;
    remote =
      heal +
      `${tmux} new-session -d -t ${shQuote(session)} -s ${shQuote(view)} 2>/dev/null; ` +
      `${tmux} set-option -t ${shQuote(view)} destroy-unattached on 2>/dev/null; ` +
      `${tmux} select-window -t ${shQuote(view + ":" + window)} 2>/dev/null; ` +
      `exec ${tmux} -u attach -t ${shQuote(view)}`;
  } else {
    remote = `${heal}exec ${tmux} -u new-session -A -s ${shQuote(session)}${cwd ? ` -c ${shQuote(cwd)}` : ""}`;
  }
  if (conn.host) {
    const verificationOptions = managedChat ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no"] : [];
    return { cmd: "ssh", args: ["-tt", ...SSH_MUX, ...verificationOptions, conn.host, `sh -lc ${shQuote(remote)}`] };
  }
  const local = 'set -- tmux; if [ "${PZZA_TMUX_SOCKET+x}" = x ]; then ' +
    'case "$PZZA_TMUX_SOCKET" in /*) ;; *) exit 1 ;; esac; ' +
    'set -- tmux -N -S "$PZZA_TMUX_SOCKET"; unset TMUX; fi; ';
  return { cmd: "sh", args: ["-lc", local + remote] };
}

export interface RemoteSession {
  createdAt?: number | null; // Actual tmux creation time in milliseconds.
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
