import { DICTATION_SUPPORTED } from "../state/dictation";
import { POWER_SUPPORTED } from "../state/power";
import { PERMISSIONS_SUPPORTED } from "../state/permissions";

// The General settings pages. The pages themselves (SettingsMenu) load with
// Settings; Settings' navigation, the command palette and app control only
// need the list.
export const generalSections = [
  { id: "appearance", label: "Appearance" },
  { id: "bars", label: "Menu buttons" },
  { id: "terminal", label: "Terminal" },
  { id: "prompts", label: "Saved prompts" },
  ...(DICTATION_SUPPORTED ? [{ id: "dictation" as const, label: "Dictation" }] : []),
  ...(POWER_SUPPORTED ? [{ id: "power" as const, label: "Power" }] : []),
] as const;
export type GeneralSection = "appearance" | "bars" | "terminal" | "prompts" | "dictation" | "power";

// The Security settings pages: what PzzaCode needs on this machine, one page
// per group. The permission pages exist only where macOS permissions do; the
// default editor page only where the app can change default apps, which
// Settings checks when Security opens.
export const securitySections = [
  { id: "tools", label: "Tools" },
  ...(PERMISSIONS_SUPPORTED ? [{ id: "permissions" as const, label: "Permissions" }, { id: "tmux" as const, label: "tmux permissions" }] : []),
  ...(PERMISSIONS_SUPPORTED ? [{ id: "editor" as const, label: "Default editor" }] : []),
  { id: "device", label: "This device" },
] as const;
export type SecuritySection = "tools" | "permissions" | "tmux" | "editor" | "device";
