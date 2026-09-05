// Workspaces group sessions in the sidebar and each targets a devbox. Today one
// machine, but the list is user-editable (add more from the rail). The active
// workspace decides the connection and which sessions show.
export interface Workspace {
  id: string;
  name: string;
  short: string; // 2-letter mark
  icon?: string; // icon key (see workspaceIcons)
  color?: string; // accent color shown subtly on the workspace's tiles
  system?: boolean; // built-in (e.g. Devbox System): always present, undeletable
}

// Preset workspace colors.
export const WORKSPACE_COLORS = [
  "#7aa2f7",
  "#9ece6a",
  "#e0af68",
  "#f7768e",
  "#bb9af7",
  "#2ac3de",
  "#ff9e64",
  "#73daca",
];

export const DEFAULT_WORKSPACES: Workspace[] = [
  { id: "devbox", name: "Main", short: "M" },
];

export const DEFAULT_WORKSPACE_ID = DEFAULT_WORKSPACES[0].id;

// Pseudo-workspace: shows every workspace's tiles at once.
export const ALL_WORKSPACE_ID = "__all__";

// Two-letter mark from a workspace name, e.g. "Pzzaworks Devbox" -> "PD".
export function markFor(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase();
  return name.slice(0, 2).toUpperCase();
}

// Workspace-assignment key for a tile: the base session name, namespaced by
// host so the same session name on two devices maps independently. Window tiles
// of a session share their base session's key. Every place that reads or
// writes sessionWs must use this, or tiles silently fall back to Main.
export const wsKeyOf = (t: { host?: string; session?: string; name: string }): string =>
  (t.host ? `${t.host}::` : "") + (t.session ?? t.name);
