import type { ComponentType, CSSProperties } from "react";
import { Activity, Container, FolderOpen, SquareTerminal } from "lucide-react";
import { ClaudeIcon, CodexIcon } from "./icons/BrandIcons";

export type IconType = ComponentType<{
  size?: number | string;
  className?: string;
  style?: CSSProperties;
}>;

// dataTransfer type used when dragging a tile onto a workspace tab.
export const SESSION_DND = "application/pzza-session";
export const SESSION_TILE_DND = "application/pzza-tile";

// Tile display name: drop a leading machine prefix like "Devbox - " so the tile
// reads "80eight Agent", not "Devbox - 80eight Agent". The machine is shown by
// the workspace/device, not repeated in every title.
export function tileTitle(name: string): string {
  const i = name.indexOf(" - ");
  return i >= 0 ? name.slice(i + 3) : name;
}

// Keep display names separate from the stable tmux target used to attach,
// terminate, and assign sessions. Window overrides take precedence over the
// parent session's name.
export function sessionDisplayName(
  tile: { id: string; name: string; session?: string; host?: string; window?: number },
  titles: Readonly<Record<string, string>>,
): string {
  if (titles[tile.id]) return titles[tile.id];
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

// Shorten a path for the tile header: home dirs become ~.
export function shortPath(p?: string): string {
  if (!p) return "";
  return p.replace(/^\/home\/[^/]+/, "~").replace(/^\/root/, "~");
}

// idle: at a prompt / no recent output (grey)
// active: producing output right now (blinking green)
// failed: the pty exited (red)
export type TileStatus = "idle" | "active" | "failed";

// Icons reflect the live foreground command, never a manually assigned title.
export function sessionIcon(command?: string): IconType {
  const value = (command || "").toLowerCase().split("/").pop() || "";
  if (value === "claude") return ClaudeIcon;
  if (value === "codex") return CodexIcon;
  if (["btop", "htop", "top"].includes(value)) return Activity;
  if (["yazi", "ranger", "nnn", "lf"].includes(value)) return FolderOpen;
  if (["docker", "lazydocker"].includes(value)) return Container;
  return SquareTerminal;
}

export function iconColor(command?: string): string | undefined {
  const Icon = sessionIcon(command);
  if (Icon === ClaudeIcon) return "#D97757";
  if (Icon === CodexIcon) return "#10A37F";
  if (Icon === Activity) return "#f9c74f";
  if (Icon === FolderOpen) return "#7aa2f7";
  if (Icon === Container) return "#2496ED";
  return undefined;
}
