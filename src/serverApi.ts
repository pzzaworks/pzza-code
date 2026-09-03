// Browser backend (server/index.js on the devbox). Used only in the plain
// browser build; the Tauri build talks to Rust instead. The page is served from
// a devbox port (mirrored to the Mac by autoforward), so the server is reached
// on the same hostname at its own port.
import type { RemoteSession } from "./connection";

function serverPort(): number {
  try {
    const v = localStorage.getItem("pzza.serverPort");
    if (v) return Number(v);
  } catch {
    /* default */
  }
  return 5190;
}

const HOST =
  typeof location !== "undefined" ? location.hostname || "localhost" : "localhost";

export const SERVER_HTTP = `http://${HOST}:${serverPort()}`;
export const SERVER_WS = `ws://${HOST}:${serverPort()}/pty`;

export async function fetchSessions(): Promise<RemoteSession[]> {
  const res = await fetch(`${SERVER_HTTP}/sessions`);
  if (!res.ok) throw new Error(`sessions ${res.status}`);
  return res.json();
}

export async function fetchPorts(): Promise<number[]> {
  const res = await fetch(`${SERVER_HTTP}/ports`);
  if (!res.ok) throw new Error(`ports ${res.status}`);
  return res.json();
}

export interface RemoteWindow {
  session: string;
  window: number;
  windowName: string;
  active: boolean;
  command: string;
  path: string;
}
export async function fetchWindows(): Promise<RemoteWindow[]> {
  const res = await fetch(`${SERVER_HTTP}/windows`);
  if (!res.ok) throw new Error(`windows ${res.status}`);
  return res.json();
}

export interface McpFramework {
  label: string;
  cli: boolean;
  config: string;
}
export interface McpConfig {
  path: string;
  frameworks: Record<string, McpFramework>;
}
export async function fetchMcpConfig(): Promise<McpConfig> {
  const res = await fetch(`${SERVER_HTTP}/mcp/config`);
  if (!res.ok) throw new Error(`mcp config ${res.status}`);
  return res.json();
}
export interface McpInstallResult {
  ok: boolean;
  via?: string;
  output?: string;
  error?: string | null;
  manual?: boolean;
}
export async function mcpInstall(framework: string): Promise<McpInstallResult> {
  const res = await fetch(`${SERVER_HTTP}/mcp/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ framework }),
  });
  return res.json();
}

// Upload a pasted image to the devbox and get back a path the agent can read.
export async function uploadPasteImage(blob: Blob): Promise<string> {
  const res = await fetch(`${SERVER_HTTP}/paste-image`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "image/png" },
    body: blob,
  });
  if (!res.ok) throw new Error(`paste-image ${res.status}`);
  const data = (await res.json()) as { path?: string };
  if (!data.path) throw new Error("paste-image: no path");
  return data.path;
}

// Kill a tmux session (or a single window). Pass host to kill on another device.
export async function killSession(name: string, window?: number, host?: string): Promise<void> {
  await fetch(`${SERVER_HTTP}/kill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, window, host }),
  });
}

export interface Account {
  provider: "claude" | "codex";
  label: string;
  dir: string;
  email?: string;
  plan?: string;
}
// Claude / Codex accounts (config dirs) on the connected device.
export async function fetchAccounts(): Promise<Account[]> {
  const res = await fetch(`${SERVER_HTTP}/accounts`);
  if (!res.ok) throw new Error(`accounts ${res.status}`);
  return res.json();
}

// Create a tmux session up front, optionally bound to a specific agent account.
export async function createSession(
  name: string,
  cwd?: string,
  account?: { provider: string; dir: string },
): Promise<void> {
  await fetch(`${SERVER_HTTP}/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, cwd, account }),
  });
}

// Scan every tmux session on a device (host empty = the connected device).
export async function scanDevice(host: string): Promise<RemoteSession[]> {
  const res = await fetch(`${SERVER_HTTP}/scan?host=${encodeURIComponent(host)}`);
  if (!res.ok) throw new Error(`scan ${res.status}`);
  return res.json();
}

export interface Capabilities {
  role: "receiver" | "source";
  forward: boolean;
  host: string | null;
}
export async function fetchCapabilities(): Promise<Capabilities> {
  const res = await fetch(`${SERVER_HTTP}/capabilities`);
  if (!res.ok) throw new Error(`capabilities ${res.status}`);
  return res.json();
}

export interface UsageWindow {
  utilization: number;
  resets_at: string | null;
}
export interface UsageScoped {
  name: string;
  percent: number;
  resets_at: string | null;
}
export interface AccountUsage {
  provider: "claude" | "codex";
  label: string;
  email?: string;
  plan?: string;
  tier?: string | null;
  usage: {
    five_hour: UsageWindow | null;
    seven_day: UsageWindow | null;
    scoped: UsageScoped[];
  } | null;
  error: string | null;
}
// Claude/Codex account usage on the connected device (5h + weekly windows).
export async function fetchUsage(): Promise<AccountUsage[]> {
  const res = await fetch(`${SERVER_HTTP}/usage`);
  if (!res.ok) throw new Error(`usage ${res.status}`);
  return res.json();
}

export interface SpendWindow {
  cost: number;
  tokens: number;
}
export interface AccountSpend {
  provider: "claude" | "codex";
  label: string;
  today: SpendWindow;
  yesterday: SpendWindow;
  window: SpendWindow;
}
// Estimated spend per account (today / yesterday / trailing 30 days), computed
// from local transcripts. First call can take a few seconds; the agent caches it.
export async function fetchSpend(): Promise<AccountSpend[]> {
  const res = await fetch(`${SERVER_HTTP}/spend`);
  if (!res.ok) throw new Error(`spend ${res.status}`);
  return res.json();
}

export interface Doctor {
  role: "source" | "client";
  host: string | null;
  port: number;
  node: string;
  tmux: string | null;
  nodePty: boolean;
  stateDir: string;
  stateWritable: boolean;
  sshReachable?: boolean;
}
// Environment diagnostics for the setup wizard. Throws if the agent is unreachable.
export async function fetchDoctor(): Promise<Doctor> {
  const res = await fetch(`${SERVER_HTTP}/doctor`);
  if (!res.ok) throw new Error(`doctor ${res.status}`);
  return res.json();
}

export interface InstallOpts {
  target: string; // [user@]host or ssh-config alias
  port?: number;
  identity?: string;
  devboxHost?: string; // set for a client-role device (forwards to this source)
  agentPort?: number;
}
// Install the agent on a remote device over SSH; progress streams back as text.
export async function installAgent(
  opts: InstallOpts,
  onLog: (text: string) => void,
): Promise<void> {
  const res = await fetch(`${SERVER_HTTP}/agent/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  if (!res.body) {
    onLog(await res.text());
    return;
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    onLog(dec.decode(value, { stream: true }));
  }
}

export interface ForwardState {
  enabled: boolean;
  active: number[];
}
export async function fetchForwardState(): Promise<ForwardState> {
  const res = await fetch(`${SERVER_HTTP}/forward/status`);
  if (!res.ok) throw new Error(`forward status ${res.status}`);
  return res.json();
}
export async function setForwardEnabled(enabled: boolean): Promise<void> {
  await fetch(`${SERVER_HTTP}/forward/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
}
