// Device agent (server/index.js). In the app (Tauri) the agent runs locally as
// a managed sidecar on 127.0.0.1, so every panel and the MCP talk to the same
// local backend. In the plain browser build the page is served from a device
// port, so the agent is reached on the same hostname at its own port.
import type { RemoteSession } from "./connection";
import type { DeviceOs } from "./devices";
import { HAS_TAURI } from "./tauriEnv";
import { createAgentConnection } from "./agentConnection";

function serverPort(): number {
  try {
    const v = localStorage.getItem("pzza.serverPort");
    if (v) return Number(v);
  } catch {
    /* default */
  }
  return 5190;
}

// 127.0.0.1 is a "potentially trustworthy" origin, so the webview may fetch it
// even from the app's secure custom-scheme origin. location.hostname in the app
// is the internal tauri host, never where the agent listens - so pin the loopback.
const HOST = HAS_TAURI
  ? "127.0.0.1"
  : typeof location !== "undefined"
    ? location.hostname || "localhost"
    : "localhost";

export const SERVER_HTTP = `http://${HOST}:${serverPort()}`;
export const SERVER_WS = `ws://${HOST}:${serverPort()}/pty`;

const connection = createAgentConnection({
  credentials: async () => {
    const { invoke } = await import("@tauri-apps/api/core");
    const [token, instance] = await Promise.all([
      invoke<string>("agent_token"), invoke<string>("agent_instance"),
    ]);
    return { token, instance };
  },
  health: async () => {
    const response = await globalThis.fetch(`${SERVER_HTTP}/health`, { signal: AbortSignal.timeout(1000) });
    if (!response.ok) throw new Error("Agent health check failed");
    return response.json() as Promise<unknown>;
  },
  pause: () => new Promise(resolve => setTimeout(resolve, 300)),
});
function browserToken(): string {
  try { return localStorage.getItem("pzza.agentToken") ?? ""; } catch { return ""; }
}
// Warm synchronous URL builders, but failed verification is retryable.
if (HAS_TAURI) void connection.ready().catch(() => undefined);

async function agentFetch(input: string, init?: RequestInit): Promise<Response> {
  const token = HAS_TAURI ? await connection.ready() : browserToken();
  const headers = new Headers(init?.headers);
  if (token) headers.set("Authorization", `Bearer ${token}`);
  try {
    const response = await globalThis.fetch(input, { ...init, headers });
    if (HAS_TAURI && response.status === 401) connection.invalidate();
    return response;
  } catch (error) {
    if (HAS_TAURI && !init?.signal?.aborted) connection.invalidate();
    throw error;
  }
}

export interface AppControlCommand { id: string; action: string; args: Record<string, unknown>; expiresAt: number }
export interface AppControlOutcome { result?: unknown; error?: string }

async function appControlRequest(path: string, init: RequestInit, signal?: AbortSignal, timeout = 5000): Promise<unknown> {
  const controller = new AbortController();
  const abort = () => controller.abort();
  signal?.addEventListener("abort", abort, { once: true });
  if (signal?.aborted) controller.abort();
  const timer = setTimeout(abort, timeout);
  try {
    const response = await agentFetch(`${SERVER_HTTP}/app/control/${path}`, { ...init, signal: controller.signal });
    if (!response.ok) throw new Error(`App control request failed (${response.status}).`);
    return response.status === 204 ? null : await response.json();
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}
export const registerAppControl = (clientId: string, label: string, signal: AbortSignal) =>
  appControlRequest("register", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, label }) }, signal);

export async function pollAppControl(clientId: string, signal: AbortSignal): Promise<AppControlCommand | null> {
  const value = await appControlRequest(`poll?clientId=${encodeURIComponent(clientId)}`, {}, signal, 18000);
  if (!value || typeof value !== "object" || !("command" in value)) throw new Error("Invalid app control response.");
  if (value.command === null) return null;
  const command = value.command;
  if (!command || typeof command !== "object" || !("id" in command) || typeof command.id !== "string" ||
    !("action" in command) || typeof command.action !== "string" || !("args" in command) ||
    !command.args || typeof command.args !== "object" || Array.isArray(command.args) ||
    !("expiresAt" in command) || typeof command.expiresAt !== "number" || !Number.isFinite(command.expiresAt)) throw new Error("Invalid app control command.");
  return { id: command.id, action: command.action, args: command.args as Record<string, unknown>, expiresAt: command.expiresAt };
}
export const reportAppControl = (clientId: string, id: string, outcome: AppControlOutcome, signal: AbortSignal) =>
  appControlRequest("result", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ clientId, id, ...outcome }) }, signal);

export const unregisterAppControl = (clientId: string) =>
  appControlRequest(`client?clientId=${encodeURIComponent(clientId)}`, { method: "DELETE", keepalive: true });

const tokenQ = () => {
  const token = HAS_TAURI ? connection.token() : browserToken();
  return token ? `token=${encodeURIComponent(token)}` : "";
};

// WebSocket URL for the browser build's PTY bridge, carrying the token as a
// query parameter since the upgrade request cannot set headers.
export function wsUrl(): string {
  const q = tokenQ();
  return q ? `${SERVER_WS}?${q}` : SERVER_WS;
}

export type EffectiveModelProvider = "claude" | "codex";
export type EffectiveModelEvidence = "reported" | "configured";

export interface SessionActivity {
  session: string;
  window: number;
  active: boolean;
  command: string;
  effectiveModel: string | null;
  effectiveProvider: EffectiveModelProvider | null;
  effectiveModelEvidence: EffectiveModelEvidence | null;
}
export async function fetchSessionActivity(host?: string, signal?: AbortSignal): Promise<SessionActivity[]> {
  const response = await agentFetch(`${SERVER_HTTP}/sessions/activity${host !== undefined ? `?host=${encodeURIComponent(host)}` : ""}`, { signal });
  if (!response.ok) throw new Error("Session activity unavailable");
  return response.json();
}

export async function fetchSessions(): Promise<RemoteSession[]> {
  const res = await agentFetch(`${SERVER_HTTP}/sessions`);
  if (!res.ok) throw new Error(`sessions ${res.status}`);
  return res.json();
}

export interface PortDetails {
  port: number;
  containers?: Array<{ name: string; runtime: "docker" | "podman"; project?: string; service?: string; container: string; id: string }>;
  processes: Array<{ pid: number; process: string; name: string; source: "package" | "folder" | "process"; folder: string | null }>;
}
export async function fetchPortDetails(host?: string, signal?: AbortSignal): Promise<PortDetails[]> {
  const response = await agentFetch(`${SERVER_HTTP}/ports/details${host !== undefined ? `?host=${encodeURIComponent(host)}` : ""}`, { signal });
  if (!response.ok) throw new Error("Service names are unavailable from this device.");
  return response.json();
}

export async function fetchPorts(): Promise<number[]> {
  const res = await agentFetch(`${SERVER_HTTP}/ports`);
  if (!res.ok) throw new Error(`ports ${res.status}`);
  return res.json();
}
export async function killPortProcess(pid: number, host?: string): Promise<{ pid: number; ports: number[] }> {
  const res = await agentFetch(`${SERVER_HTTP}/ports/kill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(host === undefined ? { pid } : { pid, host }),
    signal: AbortSignal.timeout(30000),
  });
  if (!res.ok) {
    const value: unknown = await res.json().catch(() => null);
    throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Could not stop the process.");
  }
  return res.json();
}
export async function stopPortContainer(id: string, runtime: "docker" | "podman", host?: string): Promise<{ id: string; runtime: string }> {
  const res = await agentFetch(`${SERVER_HTTP}/ports/stop-container`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(host === undefined ? { id, runtime } : { id, runtime, host }),
    signal: AbortSignal.timeout(45000),
  });
  if (!res.ok) {
    const value: unknown = await res.json().catch(() => null);
    throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Could not stop the container.");
  }
  return res.json();
}

// The live working directory of a session's active pane (empty string if it
// cannot be resolved). Used to root the code editor at the terminal's real cwd.
export async function fetchSessionPath(
  name: string,
  host?: string,
  window?: string | number,
): Promise<string> {
  const params = new URLSearchParams({ name });
  if (host) params.set("host", host);
  if (window !== undefined && window !== null && `${window}` !== "") {
    params.set("window", `${window}`);
  }
  try {
    const res = await agentFetch(`${SERVER_HTTP}/session/path?${params.toString()}`);
    if (!res.ok) return "";
    const data = (await res.json()) as { path?: string };
    return data.path || "";
  } catch {
    return "";
  }
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
  const res = await agentFetch(`${SERVER_HTTP}/windows`);
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
export async function fetchMcpConfig(agentHost = "", mcpPath = ""): Promise<McpConfig> {
  const params = new URLSearchParams({ agentHost, mcpPath });
  const res = await agentFetch(`${SERVER_HTTP}/mcp/config?${params}`);
  if (!res.ok) throw new Error(`mcp config ${res.status}`);
  const value: unknown = await res.json();
  if (!value || typeof value !== "object" || !("path" in value) || typeof value.path !== "string" ||
    !("frameworks" in value) || !value.frameworks || typeof value.frameworks !== "object" || Array.isArray(value.frameworks)) throw new Error("Invalid MCP configuration response");
  const frameworks: Record<string, McpFramework> = {};
  for (const [id, entry] of Object.entries(value.frameworks as Record<string, unknown>)) {
    if (!entry || typeof entry !== "object" || !("label" in entry) || typeof entry.label !== "string" ||
      !("cli" in entry) || typeof entry.cli !== "boolean" || !("config" in entry) || typeof entry.config !== "string") throw new Error("Invalid MCP framework response");
    frameworks[id] = { label: entry.label, cli: entry.cli, config: entry.config };
  }
  return { path: value.path, frameworks };
}
export interface McpInstallResult {
  ok: boolean;
  via?: string;
  output?: string;
  error?: string | null;
  manual?: boolean;
  unchanged?: boolean;
}
export async function mcpInstall(framework: string): Promise<McpInstallResult> {
  const res = await agentFetch(`${SERVER_HTTP}/mcp/install`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ framework }),
  });
  return res.json();
}

// Upload a pasted image to the devbox and get back a path the agent can read.
export async function uploadPasteImage(blob: Blob, host?: string, signal?: AbortSignal): Promise<string> {
  const res = await agentFetch(`${SERVER_HTTP}/paste-image${host !== undefined ? `?host=${encodeURIComponent(host)}` : ""}`, {
    method: "POST",
    headers: { "Content-Type": blob.type || "image/png" },
    body: blob,
    signal,
  });
  const data = (await res.json()) as { path?: string; error?: string };
  if (!res.ok) throw new Error(data.error || `Image upload failed (${res.status})`);
  if (!data.path) throw new Error("paste-image: no path");
  return data.path;
}

async function withRequestDeadline<T>(timeout: number, signal: AbortSignal | undefined, run: (boundedSignal: AbortSignal) => Promise<T>): Promise<T> {
  const controller = new AbortController();
  const abort = () => controller.abort(signal?.reason);
  if (signal?.aborted) abort();
  else signal?.addEventListener("abort", abort, { once: true });
  const timer = setTimeout(() => controller.abort(new DOMException("Device request timed out", "TimeoutError")), timeout);
  try { return await run(controller.signal); }
  finally { clearTimeout(timer); signal?.removeEventListener("abort", abort); }
}

export async function uploadTerminalDrop(files: File[], host: string | undefined, signal: AbortSignal): Promise<{ id: string; paths: string[] }> {
  if (!files.length || files.length > 8 || files.some(file => file.size > 16 * 1024 * 1024) || files.reduce((total, file) => total + file.size, 0) > 32 * 1024 * 1024) {
    throw new Error("Drop at most eight files, up to 16 MB each and 32 MB total.");
  }
  const query = new URLSearchParams({ files: JSON.stringify(files.map(file => ({ name: file.name, size: file.size }))) });
  if (host !== undefined) query.set("host", host);
  return withRequestDeadline(35000, signal, async boundedSignal => {
    const response = await agentFetch(`${SERVER_HTTP}/terminal-drop?${query}`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream" }, body: new Blob(files), signal: boundedSignal,
    });
    const value: unknown = await response.json();
    if (!response.ok) throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `File upload failed (${response.status})`);
    if (!value || typeof value !== "object" || !("id" in value) || typeof value.id !== "string" || !/^[a-f0-9]{32}$/.test(value.id)) throw new Error("The device returned an invalid upload receipt.");
    if (!("paths" in value) || !Array.isArray(value.paths) || value.paths.length !== files.length ||
        !value.paths.every((path: unknown): path is string => typeof path === "string" && path.startsWith("/") && path.length <= 4096 && !/[\x00-\x1f\x7f]/.test(path))) {
      await discardTerminalDrop(value.id);
      throw new Error("The device returned invalid uploaded file paths.");
    }
    return { id: value.id, paths: value.paths };
  });
}

export async function discardTerminalDrop(id: string): Promise<void> {
  if (!/^[a-f0-9]{32}$/.test(id)) throw new Error("Invalid upload receipt.");
  const response = await agentFetch(`${SERVER_HTTP}/terminal-drop?id=${encodeURIComponent(id)}`, { method: "DELETE", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Could not clean up the uploaded files.");
}

// Kill a tmux session (or a single window). Pass host to kill on another device.
export async function killSession(name: string, window?: number, host?: string): Promise<void> {
  const targetHost = HAS_TAURI ? host ?? "" : host;
  const res = await agentFetch(`${SERVER_HTTP}/kill`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, window, host: targetHost }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `kill ${res.status}`);
  globalThis.window.dispatchEvent(new CustomEvent("pzza:sessions-changed", { detail: { name, host: targetHost ?? "", window } }));
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
  const res = await agentFetch(`${SERVER_HTTP}/accounts`);
  if (!res.ok) throw new Error(`accounts ${res.status}`);
  return res.json();
}

// Start an independent shell at the source pane's live working directory.
export async function duplicateSession(name: string, window?: number, host?: string): Promise<{ name: string; cwd: string }> {
  const res = await agentFetch(`${SERVER_HTTP}/sessions/duplicate`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, window, host: HAS_TAURI ? host ?? "" : host }),
  });
  const data: unknown = await res.json();
  if (!res.ok) throw new Error(data && typeof data === "object" && "error" in data && typeof data.error === "string"
    ? data.error : "Could not duplicate the session");
  if (!data || typeof data !== "object" || !("name" in data) || typeof data.name !== "string" || !data.name ||
      !("cwd" in data) || typeof data.cwd !== "string" || !data.cwd) throw new Error("Invalid duplicate session response");
  return { name: data.name, cwd: data.cwd };
}

// Create a tmux session up front, optionally bound to a specific agent account.
export async function createSession(
  name: string,
  cwd?: string,
  account?: { provider: string; dir: string },
  host?: string,
): Promise<void> {
  const response = await agentFetch(`${SERVER_HTTP}/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, cwd, account, host }),
    signal: AbortSignal.timeout(20000),
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Could not create the session.");
  }
}

export type QuickChatAgent = "claude" | "codex" | "opencode";
export type QuickChatLauncher = "claude" | "codex" | "opencode";
export interface QuickChatSession {
  session: string;
  host: string;
  // The profile that owns the managed conversation. It is not a claim about
  // the process currently running behind a proxy launcher.
  agent: QuickChatAgent;
  launcher: QuickChatLauncher;
  identity: string;
}

function isQuickChatResponse(value: unknown, host: string): value is QuickChatSession {
  return Boolean(value && typeof value === "object" &&
    "session" in value && value.session === "pzza-quick-chat" &&
    "host" in value && value.host === host &&
    "agent" in value && (value.agent === "claude" || value.agent === "codex" || value.agent === "opencode") &&
    "launcher" in value && value.launcher === value.agent &&
    "identity" in value && typeof value.identity === "string" && /^\$[0-9]+:[0-9]+:[0-9]+$/.test(value.identity));
}

export async function openQuickChat(host: string, agent: QuickChatAgent): Promise<QuickChatSession> {
  const response = await agentFetch(`${SERVER_HTTP}/quick-chat/open`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host, agent }),
    signal: AbortSignal.timeout(20000),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Could not open Quick Chat.");
  if (!isQuickChatResponse(value, host)) throw new Error("Invalid Quick Chat response.");
  return value;
}

export async function verifyQuickChat(host: string, agent: "claude" | "codex" | "opencode", identity: string, signal?: AbortSignal): Promise<void> {
  if (!/^\$[0-9]+:[0-9]+:[0-9]+$/.test(identity)) throw new Error("Quick Chat session identity is unavailable.");
  await withRequestDeadline(15000, signal, async boundedSignal => {
    const response = await agentFetch(`${SERVER_HTTP}/quick-chat/verify`, {
      method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ host, agent, identity }), signal: boundedSignal,
    });
    const value: unknown = await response.json();
    if (!response.ok) {
      const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Quick Chat connection is unavailable.";
      throw Object.assign(new Error(message), { status: response.status });
    }
    if (!value || typeof value !== "object" || !("verified" in value) || value.verified !== true) throw new Error("Could not verify the existing Quick Chat session.");
  });
}

export async function closeQuickChat(host: string): Promise<void> {
  const response = await agentFetch(`${SERVER_HTTP}/quick-chat/close`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host }),
    signal: AbortSignal.timeout(20000),
  });
  const value: unknown = await response.json();
  if (!response.ok) throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Could not close Quick Chat.");
  if (!value || typeof value !== "object" || !("closed" in value) || value.closed !== true) throw new Error("Invalid Quick Chat response.");
}

// Scan every tmux session on a device (host empty = the connected device).
export async function scanDevice(host: string): Promise<RemoteSession[]> {
  const res = await agentFetch(`${SERVER_HTTP}/scan?host=${encodeURIComponent(host)}`);
  if (!res.ok) throw new Error(`scan ${res.status}`);
  return res.json();
}

export interface Capabilities {
  role: "receiver" | "source";
  forward: boolean;
  host: string | null;
}
export async function fetchCapabilities(): Promise<Capabilities> {
  const res = await agentFetch(`${SERVER_HTTP}/capabilities`);
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
  sourceHost?: string;
  sourceName?: string;
  provider: "claude" | "codex" | "opencode";
  label: string;
  email?: string;
  plan?: string;
  tier?: string | null;
  usage: {
    five_hour: UsageWindow | null;
    seven_day: UsageWindow | null;
    scoped: UsageScoped[];
    updatedAt?: number;
    stale?: boolean;
    retryAt?: number | null;
  } | null;
  error: string | null;
}
// Claude/Codex account usage on the connected device (5h + weekly windows).
// `fresh` re-reads accounts; provider cooldowns still apply.
export async function fetchUsage(fresh = false, host = ""): Promise<AccountUsage[]> {
  const params = new URLSearchParams({ host, ...(fresh ? { fresh: "1" } : {}) });
  const res = await agentFetch(`${SERVER_HTTP}/usage?${params}`, { signal: AbortSignal.timeout(15000) });
  if (!res.ok) throw new Error(`usage ${res.status}`);
  return res.json();
}
export async function fixUsage(provider: string): Promise<void> {
  const res = await agentFetch(`${SERVER_HTTP}/usage/fix`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ provider }),
    signal: AbortSignal.timeout(120000),
  });
  if (!res.ok) {
    const value: unknown = await res.json().catch(() => null);
    throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `usage fix ${res.status}`);
  }
}

export interface DirEntry {
  name: string;
  dir: boolean;
}
// File access runs on the connected device by default; pass `host` (an added
// device's ssh target) to read/write that device's files over ssh instead.
const hostQ = (host?: string) => (host ? `&host=${encodeURIComponent(host)}` : "");

// Read a text file (restricted to the home tree).
export async function readFile(
  path: string,
  host?: string,
): Promise<{ content: string; tooLarge?: boolean }> {
  const res = await agentFetch(`${SERVER_HTTP}/file/read?path=${encodeURIComponent(path)}${hostQ(host)}`);
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `read ${res.status}`);
  return res.json();
}
// Direct URL to a file's raw bytes (served with its media type) - use it as the
// src of an <img> or PDF viewer to preview binary files in the code view.
export function fileRawUrl(path: string, host?: string): string {
  const q = tokenQ();
  return `${SERVER_HTTP}/file/raw?path=${encodeURIComponent(path)}${hostQ(host)}${q ? `&${q}` : ""}`;
}
export async function writeFile(path: string, content: string, host?: string): Promise<void> {
  const res = await agentFetch(`${SERVER_HTTP}/file/write`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path, content, host }),
  });
  if (!res.ok) throw new Error(`write ${res.status}`);
}
export async function moveFile(root: string, path: string, destination: string, host?: string): Promise<{ path: string }> {
  const res = await agentFetch(`${SERVER_HTTP}/fs/move`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, path, destination, host }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `move ${res.status}`);
  return res.json();
}

export async function deleteFile(root: string, path: string, host?: string): Promise<{ ok: true }> {
  const res = await agentFetch(`${SERVER_HTTP}/fs/delete`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, path, host }),
  });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || `delete ${res.status}`);
  return res.json();
}

export async function listDir(
  path?: string,
  host?: string,
  signal?: AbortSignal,
): Promise<{ path: string; parent: string; entries: DirEntry[] }> {
  const params = new URLSearchParams();
  if (path) params.set("path", path);
  if (host !== undefined) params.set("host", host);
  const q = params.toString();
  const res = await agentFetch(`${SERVER_HTTP}/fs/list${q ? `?${q}` : ""}`, { signal });
  if (!res.ok) {
    const value: unknown = await res.json().catch(() => null);
    const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `Folder listing failed (${res.status})`;
    throw Object.assign(new Error(message), { status: res.status });
  }
  return res.json();
}

export interface SpendWindow {
  cost: number | null; // null when any tokens lack verified rates
  pricedCost: number; // known subtotal, not a complete estimate when cost is null
  tokens: number;
  unpricedTokens: number;
  unpricedModels: string[];
}
export interface SpendDay extends SpendWindow {
  day: string; // YYYY-MM-DD
}
export interface AccountSpend {
  sourceHost?: string;
  provider: "claude" | "codex" | "opencode";
  label: string;
  pricingBasis: "standard-api-short-context" | "opencode-billed";
  today: SpendWindow;
  yesterday: SpendWindow;
  window: SpendWindow;
  days: SpendDay[]; // per-day series for the trailing window (oldest first)
}
// Estimated spend per account (today / yesterday / trailing 30 days), computed
// from transcripts on the requested device. First call can take a few seconds; the agent caches it.
export async function fetchSpend(fresh = false, host = ""): Promise<AccountSpend[]> {
  const params = new URLSearchParams({ host, ...(fresh ? { fresh: "1" } : {}) });
  const res = await agentFetch(`${SERVER_HTTP}/spend?${params}`, { signal: host ? AbortSignal.timeout(15000) : undefined });
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
  const res = await agentFetch(`${SERVER_HTTP}/doctor`);
  if (!res.ok) throw new Error(`doctor ${res.status}`);
  return res.json();
}

export interface SshHost {
  host: string; // Host alias from ~/.ssh/config
  hostname?: string;
  user?: string;
  port?: number;
  identity?: string;
}
export interface SshHosts {
  dir: string; // the ~/.ssh directory (for rooting a file picker)
  hosts: SshHost[];
  identities: string[]; // private-key files found in ~/.ssh
}
// Auto-discovered SSH targets + identity files, to prefill the Add-a-device form.
export async function fetchSshHosts(): Promise<SshHosts> {
  const res = await agentFetch(`${SERVER_HTTP}/ssh/hosts`);
  if (!res.ok) throw new Error(`ssh hosts ${res.status}`);
  return res.json();
}

export interface InstallOpts {
  target: string; // [user@]host or ssh-config alias
  port?: number;
  identity?: string;
  serverHost?: string; // set for a client-role device (forwards to this source)
  agentPort?: number;
}
// Install the agent on a remote device over SSH; progress streams back as text.
export async function installAgent(
  opts: InstallOpts,
  onLog: (text: string) => void,
): Promise<void> {
  const res = await agentFetch(`${SERVER_HTTP}/agent/install`, {
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
  const res = await agentFetch(`${SERVER_HTTP}/forward/status`);
  if (!res.ok) throw new Error(`forward status ${res.status}`);
  return res.json();
}
export async function setForwardEnabled(enabled: boolean): Promise<void> {
  const response = await agentFetch(`${SERVER_HTTP}/forward/toggle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ enabled }),
  });
  if (!response.ok) throw new Error("Could not change port forwarding.");
}

// --- Project sync ------------------------------------------------------------
// A project is a git repo under the projects root (same ~-relative folder on
// every device). The agent scans/syncs every device itself (local + ssh).

export interface ProjectDeviceRef {
  id: string;
  name: string;
  host: string; // "" = this Mac (the agent's own machine), else [user@]host
}

export interface EnvFile {
  name: string;
  hash: string; // sha256, compared across devices
  mtime: number; // unix seconds; the newest copy wins when syncing
}

export interface ProjectRepo {
  projectId: string;
  originalProjectId?: string;
  canonicalOrigin?: string;
  rel: string; // path below the root, e.g. "Personal/pzza-code"
  origin: string | null;
  defaultBranch: string | null; // remote development when present, otherwise remote main
  branch: string | null; // checked-out branch (or "HEAD" when detached)
  head: string | null; // short sha
  modified: number; // staged + unstaged changes
  untracked: number;
  ahead: number | null; // vs upstream; null when there is no upstream
  behind: number | null;
  stashes: number;
  lastCommitTs: number; // unix seconds, 0 if unknown
  envs: EnvFile[];
}

export interface ProjectScanDevice extends ProjectDeviceRef {
  error: string | null;
  root: string | null; // where the projects root resolved on this device (case-insensitive match)
  repos: ProjectRepo[];
}

export interface ProjectScan {
  root: string;
  devices: ProjectScanDevice[];
}

export type ProjectSyncStatus = "cloned" | "updated" | "stashed" | "current" | "dirty" | "skipped" | "failed";

// What a sync is allowed to do. Per-repo overrides are keyed by projectId.
export interface RepoSyncOptions {
  enabled: boolean; // false = leave this project alone everywhere
  env: boolean; // false = never copy its env files
}
export interface SyncOptions {
  cloneMissing: boolean;
  switchToDefault: boolean; // false = leave this checkout untouched
  stashDirty: boolean; // false = dirty repos are reported and skipped
  syncEnvs: boolean;
  envExclude: string[]; // env file name patterns, * wildcard
  repos: Record<string, RepoSyncOptions>;
}
export const DEFAULT_SYNC_OPTIONS: SyncOptions = {
  cloneMissing: true,
  switchToDefault: true,
  stashDirty: true,
  syncEnvs: true,
  envExclude: [],
  repos: {},
};

export interface ProjectSyncResult {
  projectId: string;
  rel: string;
  status: ProjectSyncStatus;
  detail: string;
}

// An env file copied onto this device from the device holding the newest copy.
export interface EnvSyncResult {
  projectId: string;
  rel: string;
  name: string;
  from: string; // source device name
  status: "copied" | "failed";
  detail: string;
}

export interface ProjectSyncDevice extends ProjectDeviceRef {
  error: string | null;
  results: ProjectSyncResult[];
  envs: EnvSyncResult[];
}

export interface ProjectSync {
  cancelled?: boolean;
  root: string;
  devices: ProjectSyncDevice[];
}

async function projectsPost<T>(
  path: string,
  root: string,
  devices: ProjectDeviceRef[],
  options?: SyncOptions,
  operationId?: string,
): Promise<T> {
  const res = await agentFetch(`${SERVER_HTTP}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ root, devices, options, operationId }),
  });
  const data = (await res.json()) as T & { error?: string };
  if (!res.ok) throw new Error(data.error || `${path} ${res.status}`);
  return data;
}

export interface ProjectScanProgress {
  completed: number;
  total: number;
  repos: number;
  finished: Array<{ id: string; error: boolean }>;
}

type ProjectScanEvent =
  | { type: "progress"; progress: ProjectScanProgress }
  | { type: "result"; result: ProjectScan }
  | { type: "error"; error: string };

export async function scanProjects(
  root: string,
  devices: ProjectDeviceRef[],
  onProgress: (progress: ProjectScanProgress) => void,
  signal?: AbortSignal,
): Promise<ProjectScan> {
  const res = await agentFetch(`${SERVER_HTTP}/projects/scan`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson" },
    body: JSON.stringify({ root, devices }),
    signal,
  });
  if (!res.ok || !res.body) throw new Error(`Project scan failed (${res.status})`);
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";
      if (done && buffer.trim()) lines.push(buffer);
      for (const line of lines) {
        if (!line.trim()) continue;
        const event = JSON.parse(line) as ProjectScanEvent;
        if (event.type === "error") throw new Error(event.error);
        if (event.type === "result") return event.result;
        if (event.type === "progress") onProgress(event.progress);
      }
      if (done) throw new Error("Project scan ended before its results arrived.");
    }
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

// Long-running: clones, stashes, pulls and copies env files on every device,
// then returns the full report.
export const syncProjects = (root: string, devices: ProjectDeviceRef[], options: SyncOptions, operationId: string): Promise<ProjectSync> =>
  projectsPost<ProjectSync>("/projects/sync", root, devices, options, operationId);
export async function cancelProjectSync(operationId: string): Promise<void> {
  const response = await agentFetch(`${SERVER_HTTP}/projects/sync/cancel`, {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ operationId }),
  });
  if (!response.ok) throw new Error("Could not cancel sync");
}

export interface DeviceInfo {
  health: "reachable" | "unreachable";
  connection: "local" | "ssh";
  /** Elapsed system-probe round trip, including SSH and collection; not ICMP ping. */
  connectionMs: number;
  checkedAt: number;
  error: string | null;
  info: {
    os: DeviceOs;
    osName: string;
    osVersion: string | null;
    kernelVersion: string;
    arch: string;
    hostname: string;
    addresses: Array<{ interface: string; address: string; family: "IPv4" | "IPv6" }>;
    uptimeSeconds: number;
    cpu: { model: string | null; logicalCores: number; loadAverage: [number, number, number] | null };
    memory: { totalBytes: number; freeBytes: number; availableBytes: number | null };
  } | null;
}

export async function fetchDeviceInfo(host: string, signal?: AbortSignal, fresh = false): Promise<DeviceInfo> {
  const response = await agentFetch(`${SERVER_HTTP}/device/info?host=${encodeURIComponent(host)}${fresh ? "&fresh=1" : ""}`, { signal });
  if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error || `device info ${response.status}`);
  return response.json();
}

export async function fetchDeviceOs(host: string): Promise<DeviceOs> {
  const response = await agentFetch(`${SERVER_HTTP}/device/os?host=${encodeURIComponent(host)}`, {
    signal: AbortSignal.timeout(10000),
  });
  if (!response.ok) throw new Error("Device OS detection failed");
  const value: unknown = await response.json();
  if (typeof value === "object" && value !== null && "os" in value) {
    const os = value.os;
    if (os === "macos" || os === "linux" || os === "windows" || os === "freebsd") return os;
  }
  return "unknown";
}

export async function bridgeRequest<T>(path: string, body?: unknown): Promise<T> {
  const response = await agentFetch(`${SERVER_HTTP}/bridge/${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: body === undefined ? undefined : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    const message = value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : `Bridge request failed (${response.status})`;
    throw Object.assign(new Error(message), { status: response.status });
  }
  return response.json();
}

export interface McpRepairResult {
  framework: string;
  server: string;
  file: string;
  scope?: string;
  status: "healthy" | "repaired" | "repairable" | "unresolved" | "remote" | "disabled";
  message: string;
  backup?: string;
}
export async function repairMcp(host = "", fresh = false): Promise<{ results: McpRepairResult[] }> {
  const response = await agentFetch(`${SERVER_HTTP}/mcp/repair`, {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ host, fresh }), signal: AbortSignal.timeout(50000),
  });
  if (!response.ok) {
    const value: unknown = await response.json().catch(() => null);
    throw new Error(value && typeof value === "object" && "error" in value && typeof value.error === "string" ? value.error : "Integration check failed");
  }
  return response.json();
}
