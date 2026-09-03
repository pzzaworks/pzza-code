import type { ComponentType, CSSProperties } from "react";
import { Activity, Archive, Bot, Container, FolderOpen, SquareTerminal } from "lucide-react";
import { ClaudeIcon, CodexIcon } from "./icons/BrandIcons";

export type IconType = ComponentType<{
  size?: number | string;
  className?: string;
  style?: CSSProperties;
}>;

// dataTransfer type used when dragging a tile onto a workspace tab.
export const SESSION_DND = "application/pzza-session";

// Tile display name: drop a leading machine prefix like "Devbox - " so the tile
// reads "80eight Agent", not "Devbox - 80eight Agent". The machine is shown by
// the workspace/device, not repeated in every title.
export function tileTitle(name: string): string {
  const i = name.indexOf(" - ");
  return i >= 0 ? name.slice(i + 3) : name;
}

// Shorten a path for the tile header: home dirs become ~.
export function shortPath(p?: string): string {
  if (!p) return "";
  return p.replace(/^\/home\/[^/]+/, "~").replace(/^\/root/, "~");
}

// idle: at a prompt / no recent output (grey)
// active: producing output right now (blinking green)
// failed: the pty exited (red)
export type TileStatus = "idle" | "active" | "failed";

// Pick an icon for a tile. The active pane's running command is the best signal
// (claude, codex, btop, yazi, lazydocker…); fall back to the session name.
export function sessionIcon(name: string, command?: string): IconType {
  const c = (command || "").toLowerCase();
  if (c.includes("claude")) return ClaudeIcon;
  if (c.includes("codex")) return CodexIcon;
  if (["btop", "htop", "top"].includes(c)) return Activity;
  if (["yazi", "ranger", "nnn", "lf"].includes(c)) return FolderOpen;
  if (c.includes("docker")) return Container;
  if (["bash", "zsh", "sh", "fish"].includes(c)) return SquareTerminal;

  const n = name.toLowerCase();
  if (n.includes("claude")) return ClaudeIcon;
  if (n.includes("codex")) return CodexIcon;
  if (n.includes("monitor")) return Activity;
  if (n.includes("file")) return FolderOpen;
  if (n.includes("backup")) return Archive;
  if (n.includes("docker")) return Container;
  if (n.includes("agent")) return Bot;
  return SquareTerminal;
}

// Brand / semantic color for the tile icon.
export function iconColor(name: string, command?: string): string | undefined {
  const c = (command || "").toLowerCase();
  const n = name.toLowerCase();
  if (c.includes("claude") || n.includes("claude")) return "#D97757"; // Anthropic clay
  if (c.includes("codex") || n.includes("codex")) return "#10A37F"; // OpenAI green
  if (["btop", "htop", "top"].includes(c) || n.includes("monitor")) return "#f9c74f";
  if (["yazi", "ranger", "nnn", "lf"].includes(c) || n.includes("file")) return "#7aa2f7";
  if (c.includes("docker") || n.includes("docker")) return "#2496ED"; // Docker blue
  if (n.includes("backup")) return "#bb9af7";
  return undefined; // muted default
}
