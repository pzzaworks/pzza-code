import { createElement, type ComponentType, type CSSProperties } from "react";
import { Activity, Container, FolderOpen, SquareTerminal } from "lucide-react";
import type { EffectiveModelEvidence, EffectiveModelProvider } from "./serverApi";
import { AgentIcon } from "./icons/AgentIcon";
import { agentForProgram, sessionAgent, type SessionAgentId } from "../server/lib/session-agents.js";

export type IconType = ComponentType<{
  size?: number | string;
  className?: string;
  style?: CSSProperties;
}>;

// dataTransfer type used when dragging a tile onto a workspace tab.
export const SESSION_DND = "application/pzza-session";
export const SESSION_TILE_DND = "application/pzza-tile";
export const QUICK_CHAT_SESSION = "pzza-quick-chat";

// Tile display name: drop a leading machine prefix like "Devbox - " so the tile
// reads "Work Agent", not "Devbox - Work Agent". The machine is shown by
// the workspace/device, not repeated in every title.
export function tileTitle(name: string): string {
  const i = name.indexOf(" - ");
  return i >= 0 ? name.slice(i + 3) : name;
}

// Keep display names separate from the stable tmux target used to attach,
// terminate, and assign sessions. Window overrides take precedence over the
// parent session's name.
export function sessionDisplayName(
  tile: { kind?: "file"; id: string; name: string; session?: string; host?: string; window?: number },
  titles: Readonly<Record<string, string>>,
): string {
  if (titles[tile.id]) return titles[tile.id];
  // A file tile is named by its file, exactly as written.
  if (tile.kind === "file") return tile.name;
  const fallback = tileTitle(tile.name);
  if (tile.session && tile.window !== undefined) {
    const parentId = (tile.host ? `${tile.host}::` : "") + tile.session;
    const parentTitle = titles[parentId];
    if (parentTitle) {
      if (fallback === tileTitle(tile.session)) return parentTitle;
      const prefix = `${tileTitle(tile.session)} · `;
      return `${parentTitle} · ${fallback.startsWith(prefix) ? fallback.slice(prefix.length) : fallback}`;
    }
  }
  return fallback;
}

// idle: grey, no unread notifications
// active: producing output right now (blinking green, legacy activity signal)
// notify: unread terminal notification (solid green)
// failed: the pty exited (red)
export type TileStatus = "idle" | "active" | "notify" | "failed";

// Model attribution is allowed to override the launcher only when the
// foreground probe supplied a normalized provider and the launcher is one of
// that provider's own CLIs (or not a known agent). Any other agent keeps its
// own branding whatever model it runs.
const PROVIDER_LAUNCHERS = new Set(["claude", "codex"]);

/** The catalog agent a launcher or pane command names, if any. */
export function launcherAgent(command?: string | null): SessionAgentId | undefined {
  const value = (command || "").toLowerCase().replace(/^-/, "").split("/").pop() || "";
  return sessionAgent(value)?.id ?? agentForProgram(value);
}

function brandedAgent(command?: string, effectiveProvider?: EffectiveModelProvider | null): SessionAgentId | undefined {
  const launcher = launcherAgent(command);
  if (launcher && !PROVIDER_LAUNCHERS.has(launcher)) return launcher;
  return sessionAgent(effectiveProvider)?.id ?? launcher;
}

const agentIcons = new Map<string, IconType>();

/** An icon component for one catalog agent, stable per id. */
export function agentIconType(id: SessionAgentId): IconType {
  const existing = agentIcons.get(id);
  if (existing) return existing;
  const Icon: IconType = ({ size, className, style }) => style
    ? createElement("span", { style: { display: "inline-flex", ...style } }, createElement(AgentIcon, { id, size, className }))
    : createElement(AgentIcon, { id, size, className });
  Icon.displayName = `AgentIcon(${id})`;
  agentIcons.set(id, Icon);
  return Icon;
}

export function sessionIcon(command?: string, effectiveProvider?: EffectiveModelProvider | null): IconType {
  const agent = brandedAgent(command, effectiveProvider);
  if (agent) return agentIconType(agent);
  const value = (command || "").toLowerCase().split("/").pop() || "";
  if (["btop", "htop", "top"].includes(value)) return Activity;
  if (["yazi", "ranger", "nnn", "lf"].includes(value)) return FolderOpen;
  if (["docker", "lazydocker"].includes(value)) return Container;
  return SquareTerminal;
}

// Brand colors where the app has always tinted the mark; other agents use the
// surrounding text color.
const AGENT_COLORS: Partial<Record<SessionAgentId, string>> = { claude: "#D97757", codex: "#10A37F", opencode: "#94A3B8" };

export function iconColor(command?: string, effectiveProvider?: EffectiveModelProvider | null): string | undefined {
  const agent = brandedAgent(command, effectiveProvider);
  if (agent) return AGENT_COLORS[agent];
  const Icon = sessionIcon(command, effectiveProvider);
  if (Icon === Activity) return "#f9c74f";
  if (Icon === FolderOpen) return "#7aa2f7";
  if (Icon === Container) return "#2496ED";
  return undefined;
}

function launcherLabel(command?: string): string {
  const agent = launcherAgent(command);
  return agent ? sessionAgent(agent)?.label ?? agent : command || "process";
}

export function sessionIconTooltip(
  command?: string,
  effectiveModel?: string | null,
  effectiveProvider?: EffectiveModelProvider | null,
  effectiveModelEvidence?: EffectiveModelEvidence | null,
): string {
  if (!command) return "Running process unavailable";
  if (!effectiveModel || !effectiveProvider || !effectiveModelEvidence) return `Launcher: ${launcherLabel(command)}. Effective model unavailable.`;
  const provider = sessionAgent(effectiveProvider)?.label ?? effectiveProvider;
  const evidence = effectiveModelEvidence === "reported"
    ? "reported by the foreground process"
    : "configured by the foreground process or selected account";
  return `Effective model: ${effectiveModel} (${provider}, ${evidence}). Launcher: ${launcherLabel(command)}.`;
}

export function sessionAge(createdAt: number | null | undefined, now: number): string {
  if (createdAt == null || !Number.isFinite(createdAt) || createdAt <= 0) return "Age unavailable";
  const minutes = Math.max(0, Math.floor((now - createdAt) / 60_000));
  if (minutes < 1) return "<1m";
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  const days = Math.floor(hours / 24);
  return days < 7 ? `${days}d` : `${Math.floor(days / 7)}w`;
}
