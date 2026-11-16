import { create } from "zustand";
import { deviceForHost, deviceHost, deviceNameFor, type Device } from "../devices";
import { isSessionTile, sessionTileById, useStore, type Session } from "./store";
import { useSessionAgents, rememberSessionAgent } from "./sessionAgents";
import { confirmAction } from "./confirmations";
import { createSessionInApp, sessionNameBase, takenSessionNames, uniqueSessionName, useSessionCreation } from "../sessionActions";
import { runningAgent, sessionAtShell } from "../ui/LiveSessionIcon";
import { runLocalAppCommand } from "../appControl";
import { tileGitTarget } from "../tileGit";
import { DEFAULT_WORKSPACE_ID, wsKeyOf } from "../workspaces";
import { sessionAgent, sessionAgentCommand, sessionAgentResumeIdCommand, validAgentAccount } from "../../server/lib/session-agents.js";
import type { AgentSessionRow } from "../../server/lib/agent-sessions.js";

// Past coding-agent conversations (the Agent sessions dialog and its app
// commands): which tile the dialog is open for, the filters it remembers, and
// the two ways back into a conversation, each with the checks that keep it
// safe. A new tile starts the agent on the conversation in its folder; the
// current tile gets the resume command typed at its shell prompt.

// ------------------------------------------------------------------ dialog

interface AgentSessionsUi {
  open: boolean;
  /** The tile the dialog was opened from: its device and folder scope the list, and "Resume here" types into it. */
  tileId: string | null;
  /** Bumped on each open, so a reopened dialog starts from its saved filters again. */
  opened: number;
  show(tileId: string | null): void;
  close(): void;
}

export const useAgentSessionsUi = create<AgentSessionsUi>((set) => ({
  open: false,
  tileId: null,
  opened: 0,
  show: (tileId) => set((state) => ({ open: true, tileId, opened: state.opened + 1 })),
  close: () => set({ open: false }),
}));

// ----------------------------------------------------------------- filters

export type AgentSessionsScope = "folder" | "repo" | "everywhere";
export type AgentSessionsTime = "today" | "week" | "month" | "all";
export type AgentSessionsView = "grouped" | "timeline";
export interface AgentSessionsFilters { scope: AgentSessionsScope; time: AgentSessionsTime; view: AgentSessionsView }

const FILTERS_KEY = "pzza.agentSessions.filters.v1";
const SCOPES: readonly AgentSessionsScope[] = ["folder", "repo", "everywhere"];
const TIMES: readonly AgentSessionsTime[] = ["today", "week", "month", "all"];
const VIEWS: readonly AgentSessionsView[] = ["grouped", "timeline"];
const DEFAULT_FILTERS: AgentSessionsFilters = { scope: "folder", time: "all", view: "grouped" };

const pick = <T extends string>(options: readonly T[], value: unknown, fallback: T): T => options.find((option) => option === value) ?? fallback;

export function loadAgentSessionsFilters(): AgentSessionsFilters {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FILTERS_KEY) ?? "null");
    if (!value || typeof value !== "object") return DEFAULT_FILTERS;
    const stored = value as Record<string, unknown>;
    return { scope: pick(SCOPES, stored.scope, DEFAULT_FILTERS.scope), time: pick(TIMES, stored.time, DEFAULT_FILTERS.time), view: pick(VIEWS, stored.view, DEFAULT_FILTERS.view) };
  } catch {
    return DEFAULT_FILTERS;
  }
}

export function saveAgentSessionsFilters(filters: AgentSessionsFilters): void {
  try {
    localStorage.setItem(FILTERS_KEY, JSON.stringify(filters));
  } catch {
    /* Preferences are optional. */
  }
}

/** Epoch milliseconds a time filter starts at (local midnight for Today), or undefined for all time. */
export function timeFilterSince(time: AgentSessionsTime, now = Date.now()): number | undefined {
  if (time === "today") { const day = new Date(now); day.setHours(0, 0, 0, 0); return day.getTime(); }
  if (time === "week") return now - 7 * 86400000;
  if (time === "month") return now - 30 * 86400000;
  return undefined;
}

// ------------------------------------------------------------------ errors

export type AgentSessionsErrorKind = "outdated" | "unreachable" | "failed";

/** What went wrong reading a device's list: an agent too old for the route, a device out of reach, or anything else. */
export function agentSessionsErrorKind(error: unknown): AgentSessionsErrorKind {
  const status = error instanceof Error && typeof error.cause === "number" ? error.cause : undefined;
  if (status === 404) return "outdated";
  if (status === undefined || status === 502 || status === 503 || status === 504) return "unreachable";
  return "failed";
}

// -------------------------------------------------------------------- tile

export interface AgentSessionsTile {
  tile: Session;
  /** The device host as the API takes it ("" = this device). */
  host: string;
  device: Device | undefined;
  /** The folder the tile's terminal is in, when known. */
  folder: string | undefined;
  title: string;
}

/** The session tile the dialog works from, with its device and folder; null when it is not an open terminal tile. */
export function agentSessionsTile(tileId: string | null): AgentSessionsTile | null {
  if (!tileId) return null;
  const state = useStore.getState();
  const tile = sessionTileById(state.tiles, tileId);
  if (!tile) return null;
  const host = tile.host ?? state.connection.host ?? "";
  return { tile, host, device: deviceForHost(state.activeDevices, host), folder: tileGitTarget(tileId)?.folder, title: state.tileTitles[tileId] ?? tile.name };
}

// ------------------------------------------------------------------- modes

/** The mode a resumed conversation starts in: the one this agent was last started with, else its default. */
export function rememberedAgentMode(agentId: string): string {
  const agent = sessionAgent(agentId);
  if (!agent) return "";
  const remembered = Object.values(useSessionAgents.getState().agents).filter((choice) => choice.id === agent.id).pop();
  return remembered && agent.modes.some((mode) => mode.id === remembered.mode) ? remembered.mode : agent.defaultMode;
}

const validMode = (agentId: string, mode: string | undefined): string => {
  const agent = sessionAgent(agentId);
  return agent && mode && agent.modes.some((item) => item.id === mode) ? mode : rememberedAgentMode(agentId);
};

export const agentLabelOf = (agentId: string): string => sessionAgent(agentId)?.label ?? agentId;

// ---------------------------------------------------------------- commands

// The account folder a conversation ran with, as the agent is started with it.
// The device names a non-default account by its folder; the agent takes the
// folder's absolute path, so a conversation from another account resumes only
// when the device reports one.
function accountChoice(row: AgentSessionRow): { account?: string } | { reason: string } {
  if (!row.account) return {};
  const agent = sessionAgent(row.agent);
  if (validAgentAccount(agent, row.account)) return { account: row.account };
  return { reason: `This conversation ran with the ${row.account} account, and this device's agent did not report where that account's folder is, so it cannot be resumed with that account yet.` };
}

/**
 * The shell line that resumes a conversation. A conversation reopened by its
 * id gets `cd <cwd> &&` in front when `cwd` is given; an agent that can only
 * continue its newest conversation continues the one of the folder it starts
 * in, so that command never changes folder (see resumeHereBlocker). Throws
 * when the conversation cannot be resumed from a command line.
 */
export function agentSessionCommand(row: AgentSessionRow, mode: string | undefined, cwd?: string): string {
  const agent = sessionAgent(row.agent);
  if (!agent) throw new Error("This agent is not supported by this version of the app.");
  const account = accountChoice(row);
  if ("reason" in account) throw new Error(account.reason);
  const chosen = validMode(row.agent, mode);
  if (row.resume === "id") return sessionAgentResumeIdCommand({ id: agent.id, mode: chosen, session: row.id, ...account }, cwd || undefined);
  if (row.resume === "last") return sessionAgentCommand({ id: agent.id, mode: chosen, resume: true, ...account });
  throw new Error(`${agent.label} cannot reopen a past conversation from the command line.`);
}

// ------------------------------------------------------------------ guards

/**
 * Whether a conversation the device marks as continuable ("last": the agent
 * continues its newest conversation in a folder) is still the newest among the
 * rows on screen; the device's own list may be a little behind.
 */
export function newerConversation(row: AgentSessionRow, loaded: readonly AgentSessionRow[]): AgentSessionRow | undefined {
  if (row.resume !== "last") return undefined;
  return loaded.find((other) => other.id !== row.id && other.agent === row.agent && other.cwd === row.cwd
    && (other.account ?? "") === (row.account ?? "") && other.lastAt > row.lastAt);
}

/** Why a conversation cannot be resumed at all, or null. `loaded` are the rows of its device on screen. */
export function resumeBlocker(row: AgentSessionRow, loaded: readonly AgentSessionRow[] = []): string | null {
  const agent = sessionAgent(row.agent);
  if (!agent) return "This agent is not supported by this version of the app.";
  if (row.resume === "none") {
    return agent.resume.kind === "continue-last" && agent.resume.scope === "directory"
      ? `${agent.label} can only continue the newest conversation of a folder, and this is an older one.`
      : `${agent.label} cannot reopen a past conversation from the command line.`;
  }
  const newer = newerConversation(row, loaded);
  if (newer) return `${agent.label} can only continue the newest conversation of a folder, and a newer one exists here: "${newer.title || newer.id}".`;
  if (row.resume === "last" && !row.cwd) return "The folder this conversation ran in is not known.";
  try {
    agentSessionCommand(row, undefined, row.cwd || undefined);
  } catch (error) {
    return error instanceof Error ? error.message : "This conversation cannot be resumed.";
  }
  return null;
}

/** Why the conversation cannot start in a new tile on its device, or null. */
export function newTileBlocker(row: AgentSessionRow, host: string, loaded: readonly AgentSessionRow[], creating: boolean): string | null {
  const blocked = resumeBlocker(row, loaded);
  if (blocked) return blocked;
  if (!deviceForHost(useStore.getState().activeDevices, host)) return "Its device is not configured, or it is turned off.";
  if (creating) return "Another session is being created. Wait for it to finish.";
  return null;
}

/**
 * Why the conversation cannot be resumed in this tile, or null: the tile has
 * to be a terminal on the conversation's device, sitting at its shell prompt
 * with no agent running, since the command is typed into it.
 */
export function resumeHereBlocker(tileId: string | null, row: AgentSessionRow, host: string, loaded: readonly AgentSessionRow[] = []): string | null {
  const blocked = resumeBlocker(row, loaded);
  if (blocked) return blocked;
  if (!tileId) return "Focus a session, then open this list to resume a conversation in it.";
  const target = agentSessionsTile(tileId);
  if (!target) return "The tile this list was opened from is closed.";
  const devices = useStore.getState().devices;
  if (target.host !== host) return `This tile runs on ${deviceNameFor(devices, target.host || undefined)}, but the conversation is on ${deviceNameFor(devices, host || undefined)}.`;
  if (row.resume === "last" && target.folder !== row.cwd) {
    return `${agentLabelOf(row.agent)} continues the newest conversation of the folder it starts in, and this tile is in another folder. Resume it in a new PzzaCode session instead.`;
  }
  const { tile } = target;
  const session = tile.session ?? tile.name;
  const running = runningAgent(session, tile.window, tile.host);
  if (running) return `${agentLabelOf(running)} is running in this tile. Exit it first, or resume in a new PzzaCode session.`;
  if (!sessionAtShell(session, tile.window, tile.host)) return "This tile is not at a shell prompt, so the command cannot be typed safely. Resume in a new PzzaCode session instead.";
  return null;
}

// ------------------------------------------------------------------ resume

const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? "";

// Puts a freshly opened tile (appended last) right after `anchorId`.
function placeAfter(tileId: string, anchorId: string): void {
  const { tiles, reorderTile } = useStore.getState();
  const anchor = tiles.findIndex((tile) => tile.id === anchorId);
  const next = tiles[anchor + 1];
  if (anchor >= 0 && next && next.id !== tileId) reorderTile(tileId, next.id);
}

export interface ResumeNewTileInput {
  host: string;
  row: AgentSessionRow;
  mode?: string;
  /** Rows of the same device on screen, to catch a newer conversation the device has not listed yet. */
  loaded?: readonly AgentSessionRow[];
  /** Opens next to this tile, in its workspace. */
  anchorTileId?: string | null;
  workspaceId?: string;
}

/**
 * Starts the conversation's agent on it in a new session in the folder it ran
 * in, on its device. Resolves to the new tile id.
 */
export async function resumeInNewTile({ host, row, mode, loaded = [], anchorTileId, workspaceId }: ResumeNewTileInput): Promise<string> {
  const state = useStore.getState();
  const blocked = newTileBlocker(row, host, loaded, useSessionCreation.getState().operation?.status === "running");
  if (blocked) throw new Error(blocked);
  const device = deviceForHost(state.activeDevices, host);
  const agent = sessionAgent(row.agent);
  const account = accountChoice(row);
  if (!device || !agent || "reason" in account) throw new Error("This conversation cannot be resumed.");
  const anchor = anchorTileId ? state.tiles.find((tile) => tile.id === anchorTileId) : undefined;
  const destination = workspaceId ?? (anchor ? state.sessionWs[wsKeyOf(anchor)] ?? DEFAULT_WORKSPACE_ID : undefined);
  const name = uniqueSessionName(sessionNameBase(folderName(row.cwd) || agent.id), takenSessionNames(deviceHost(device)));
  const chosen = validMode(row.agent, mode);
  // An agent that reopens by id gets the conversation's id; one that can only
  // continue its newest conversation continues it, in its folder.
  const choice = row.resume === "id" ? { id: agent.id, mode: chosen, session: row.id, ...account } : { id: agent.id, mode: chosen, resume: true, ...account };
  const tileId = await createSessionInApp({ name, deviceId: device.id, workspaceId: destination, cwd: row.cwd || undefined, agent: choice });
  if (anchor) placeAfter(tileId, anchor.id);
  return tileId;
}

export interface ResumeHereInput {
  tileId: string;
  host: string;
  row: AgentSessionRow;
  mode?: string;
  loaded?: readonly AgentSessionRow[];
  /** False when the caller already asked (app control confirms before running a command). */
  confirm?: boolean;
}

/**
 * Types the resume command at the tile's shell prompt and runs it, after
 * asking. Resolves to false when the user declines.
 */
export async function resumeInTile({ tileId, host, row, mode, loaded = [], confirm = true }: ResumeHereInput): Promise<boolean> {
  const blocked = resumeHereBlocker(tileId, row, host, loaded);
  if (blocked) throw new Error(blocked);
  const target = agentSessionsTile(tileId);
  const agent = sessionAgent(row.agent);
  if (!target || !agent) throw new Error("The tile this list was opened from is closed.");
  // The folder is changed first only when the tile is somewhere else.
  const command = agentSessionCommand(row, mode, row.cwd && row.cwd !== target.folder ? row.cwd : undefined);
  if (confirm) {
    const accepted = await confirmAction({
      title: "Resume this conversation here?",
      message: `${agent.label} continues "${row.title || row.id}" in ${target.title}. This runs:\n${command}`,
      confirmLabel: "Resume here",
    });
    if (!accepted) return false;
    // The tile may have changed while the question was open.
    const again = resumeHereBlocker(tileId, row, host, loaded);
    if (again) throw new Error(again);
  }
  await runLocalAppCommand("terminal_input", { tileId, text: command });
  await runLocalAppCommand("terminal_submit", { tileId });
  rememberSessionAgent(tileId, { id: agent.id, mode: validMode(row.agent, mode) });
  return true;
}

/** The device host a configured, enabled device id stands for; throws for an unknown one. */
export function agentSessionsHost(deviceId: string | undefined): string {
  const state = useStore.getState();
  if (!deviceId) return state.connection.host ?? "";
  const device = state.activeDevices.find((item) => item.id === deviceId);
  if (!device) throw new Error("Choose a configured, enabled device.");
  return deviceHost(device);
}

/** Whether a tile id names an open terminal tile. */
export const isAgentSessionsTile = (tileId: unknown): tileId is string => typeof tileId === "string" && useStore.getState().tiles.some((tile) => tile.id === tileId && isSessionTile(tile));
