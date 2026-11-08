import { sessionAgent, type SessionAgentChoice } from "../server/lib/session-agents.js";

// A workspace snapshot records what is needed to recreate each of its
// sessions (the device, the tmux session name, the working folder and the
// agent + mode it was started with) and how the workspace looked: tile order
// (the order of `sessions`), sizes, titles, hidden tiles, editors and columns. Pure helpers live here so they can be
// tested without the app store; state/workspaceSnapshots.ts persists them.

export interface SnapshotSession {
  deviceId: string; // empty when the device was not configured at save time
  host: string; // ssh target ("" = the connected device)
  session: string;
  cwd?: string;
  agent?: SessionAgentChoice;
  span?: { c: number; r: number };
  title?: string;
  hidden?: boolean;
  code?: SnapshotCode;
  // The Git branch its folder was on when saved (recorded after saving).
  branch?: string;
}

// The tile's inline editor, without sizes that depend on the window.
export interface SnapshotCode { open: boolean; layout?: "full" | "side-by-side" | "stacked"; root?: string; path?: string }

export interface WorkspaceSnapshot {
  id: string;
  workspaceId: string;
  name: string;
  createdAt: number;
  sessions: SnapshotSession[];
  columns?: number;
  // Kept up to date automatically (one per workspace) rather than saved by hand.
  auto?: boolean;
}

export interface SnapshotTile { id: string; name: string; session?: string; host?: string; cwd?: string; path?: string }
export interface SnapshotDevice { id: string; host: string; user?: string; disabled?: boolean }

export const MAX_SNAPSHOTS = 60;
export const MAX_SNAPSHOT_SESSIONS = 60;
const SESSION_NAME = /^[^\u0000-\u001f\u007f]{1,128}$/;
const HOST = /^$|^[A-Za-z0-9._][A-Za-z0-9._@-]{0,127}$/;

// Same rule as deviceHost(): the local device has no ssh target.
export function snapshotDeviceHost(device: SnapshotDevice): string {
  return device.id === "this-mac" ? "" : device.user ? `${device.user}@${device.host}` : device.host;
}

// Only absolute folders can be passed back to session creation.
function folder(value: string | undefined): string | undefined {
  return value && value.startsWith("/") && value.length <= 4096 && !/[\u0000-\u001f\u007f]/.test(value) ? value : undefined;
}

function validAgent(value: unknown): SessionAgentChoice | undefined {
  if (!value || typeof value !== "object") return undefined;
  const choice = value as Record<string, unknown>;
  const agent = sessionAgent(choice.id);
  return agent && typeof choice.mode === "string" && agent.modes.some(mode => mode.id === choice.mode) ? { id: agent.id, mode: choice.mode } : undefined;
}

// A Git branch name as git accepts it, in short.
const BRANCH = /^(?!.*\.\.)(?!\/)(?!.*\/$)[A-Za-z0-9._/-]{1,200}$/;
export function validBranch(value: unknown): value is string {
  return typeof value === "string" && BRANCH.test(value) && !value.endsWith(".lock");
}

const CODE_LAYOUTS = new Set(["full", "side-by-side", "stacked"]);
const TEXT = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[\u0000-\u001f\u007f]/.test(value);

// A tile's layout, validated: spans in half steps from 0.5 to 6, a short
// title, the hidden flag, and the editor with absolute folders only. Used both
// when saving and when reading stored snapshots, which are never trusted.
function layoutOf(span: unknown, title: unknown, hidden: unknown, code: unknown): Pick<SnapshotSession, "span" | "title" | "hidden" | "code"> {
  const out: Pick<SnapshotSession, "span" | "title" | "hidden" | "code"> = {};
  const size = (value: unknown) => typeof value === "number" && Number.isFinite(value) && value >= 0.5 && value <= 6 && Number.isInteger(value * 2);
  if (span && typeof span === "object") {
    const { c, r } = span as Record<string, unknown>;
    if (size(c) && size(r)) out.span = { c: c as number, r: r as number };
  }
  if (TEXT(title, 80)) out.title = (title as string).trim();
  if (hidden === true) out.hidden = true;
  if (code && typeof code === "object") {
    const editor = code as Record<string, unknown>;
    if (typeof editor.open === "boolean") {
      out.code = {
        open: editor.open,
        ...(typeof editor.layout === "string" && CODE_LAYOUTS.has(editor.layout) ? { layout: editor.layout as SnapshotCode["layout"] } : {}),
        ...(typeof editor.root === "string" && folder(editor.root) ? { root: editor.root } : {}),
        ...(typeof editor.path === "string" && TEXT(editor.path, 4096) ? { path: editor.path } : {}),
      };
    }
  }
  return out;
}

// The sessions of one workspace, one entry per tmux session (window tiles of
// the same session collapse into one). The folder comes from the tile, or from
// the connected device's session list for tiles that live there.
export function collectSnapshotSessions(input: {
  tiles: SnapshotTile[];
  workspaceOf: (tile: SnapshotTile) => string;
  workspaceId: string;
  devices: SnapshotDevice[];
  sessionPaths: Record<string, string | undefined>; // connected device: session name -> cwd
  agents: Record<string, SessionAgentChoice | undefined>;
  // Layout, by tile id (hidden by tile name); optional for callers that only need sessions.
  spans?: Record<string, { c: number; r: number } | undefined>;
  titles?: Record<string, string | undefined>;
  hidden?: readonly string[];
  code?: Record<string, { open: boolean; layout?: SnapshotCode["layout"]; root?: string; path?: string } | undefined>;
}): SnapshotSession[] {
  const seen = new Set<string>();
  const out: SnapshotSession[] = [];
  for (const tile of input.tiles) {
    if (input.workspaceOf(tile) !== input.workspaceId) continue;
    const host = tile.host ?? "";
    const session = tile.session ?? tile.name;
    const key = `${host}::${session}`;
    if (seen.has(key) || !SESSION_NAME.test(session) || !HOST.test(host)) continue;
    seen.add(key);
    const device = input.devices.find(entry => snapshotDeviceHost(entry) === host);
    const cwd = folder(tile.cwd) ?? folder(tile.path) ?? (host ? undefined : folder(input.sessionPaths[session]));
    const agent = validAgent(input.agents[tile.id] ?? input.agents[host ? `${host}::${session}` : session]);
    out.push({
      deviceId: device?.id ?? "", host, session, ...(cwd ? { cwd } : {}), ...(agent ? { agent } : {}),
      ...layoutOf(input.spans?.[tile.id], input.titles?.[tile.id], input.hidden?.includes(tile.name) ?? false, input.code?.[tile.id]),
    });
    if (out.length >= MAX_SNAPSHOT_SESSIONS) break;
  }
  return out;
}

// Validate stored snapshots; malformed entries are dropped, never repaired.
export function parseSnapshots(raw: unknown): WorkspaceSnapshot[] {
  if (!Array.isArray(raw)) return [];
  const out: WorkspaceSnapshot[] = [];
  for (const value of raw.slice(0, MAX_SNAPSHOTS)) {
    if (!value || typeof value !== "object") continue;
    const row = value as Record<string, unknown>;
    if (typeof row.id !== "string" || !row.id || row.id.length > 64) continue;
    if (typeof row.workspaceId !== "string" || !row.workspaceId || row.workspaceId.length > 128) continue;
    if (typeof row.name !== "string" || !row.name.trim() || row.name.length > 80) continue;
    if (typeof row.createdAt !== "number" || !Number.isFinite(row.createdAt) || row.createdAt <= 0) continue;
    if (!Array.isArray(row.sessions)) continue;
    const sessions: SnapshotSession[] = [];
    for (const entry of row.sessions.slice(0, MAX_SNAPSHOT_SESSIONS)) {
      if (!entry || typeof entry !== "object") continue;
      const item = entry as Record<string, unknown>;
      if (typeof item.session !== "string" || !SESSION_NAME.test(item.session)) continue;
      if (typeof item.host !== "string" || !HOST.test(item.host)) continue;
      if (typeof item.deviceId !== "string" || item.deviceId.length > 128) continue;
      if (item.cwd !== undefined && (typeof item.cwd !== "string" || !folder(item.cwd))) continue;
      const agent = validAgent(item.agent);
      if (item.agent !== undefined && !agent) continue;
      sessions.push({
        deviceId: item.deviceId, host: item.host, session: item.session, ...(typeof item.cwd === "string" ? { cwd: item.cwd } : {}), ...(agent ? { agent } : {}),
        ...layoutOf(item.span, item.title, item.hidden, item.code),
        ...(validBranch(item.branch) ? { branch: item.branch } : {}),
      });
    }
    const columns = typeof row.columns === "number" && Number.isInteger(row.columns) && row.columns >= 1 && row.columns <= 12 ? row.columns : undefined;
    if (sessions.length) out.push({ id: row.id, workspaceId: row.workspaceId, name: row.name, createdAt: row.createdAt, sessions, ...(columns ? { columns } : {}), ...(row.auto === true ? { auto: true } : {}) });
  }
  return out;
}

// Split a snapshot into sessions to create and sessions already running: open
// as a tile, or listed by the connected device for sessions that live there.
export function snapshotLaunchPlan(snapshot: WorkspaceSnapshot, tiles: SnapshotTile[], connectedSessions: string[]): { launch: SnapshotSession[]; running: SnapshotSession[] } {
  const open = new Set(tiles.map(tile => `${tile.host ?? ""}::${tile.session ?? tile.name}`));
  const listed = new Set(connectedSessions);
  const launch: SnapshotSession[] = [];
  const running: SnapshotSession[] = [];
  for (const entry of snapshot.sessions) {
    if (open.has(`${entry.host}::${entry.session}`) || (!entry.host && listed.has(entry.session))) running.push(entry);
    else launch.push(entry);
  }
  return { launch, running };
}

// The configured, enabled device a snapshot session belongs to: by id first,
// then by ssh target in case the device was re-added under a new id.
export function snapshotDevice<T extends SnapshotDevice>(entry: SnapshotSession, devices: T[]): T | undefined {
  return devices.find(device => !device.disabled && entry.deviceId && device.id === entry.deviceId)
    ?? devices.find(device => !device.disabled && snapshotDeviceHost(device) === entry.host);
}

// Shared snapshots: a versioned JSON text without the local id, workspace or
// auto flag. Importing validates it like stored snapshots and gives it a new
// id in the workspace it is imported into.
const EXPORT_FORMAT = "pzzacode.workspace-snapshot";
const MAX_IMPORT_LENGTH = 256 * 1024;

export function exportSnapshot(snapshot: WorkspaceSnapshot): string {
  const { name, createdAt, sessions, columns } = snapshot;
  return JSON.stringify({ format: EXPORT_FORMAT, version: 1, name, createdAt, sessions, ...(columns !== undefined ? { columns } : {}) }, null, 2);
}

export function importSnapshot(text: string, workspaceId: string, id: string, now: number): WorkspaceSnapshot {
  if (text.length > MAX_IMPORT_LENGTH) throw new Error("That snapshot is too large.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("Paste a snapshot copied from PzzaCode.");
  }
  const shared = value && typeof value === "object" ? value as Record<string, unknown> : {};
  if (shared.format !== EXPORT_FORMAT || shared.version !== 1) throw new Error("Paste a snapshot copied from PzzaCode.");
  const [snapshot] = parseSnapshots([{ ...shared, id, workspaceId, createdAt: typeof shared.createdAt === "number" ? shared.createdAt : now, auto: undefined }]);
  if (!snapshot) throw new Error("That snapshot has no valid sessions.");
  return snapshot;
}
