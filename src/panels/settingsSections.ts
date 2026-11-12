import { DICTATION_SUPPORTED } from "../state/dictation";

// The General settings pages. The pages themselves (SettingsMenu) load with
// Settings; Settings' navigation, the command palette and app control only
// need the list.
export const generalSections = [
  { id: "appearance", label: "Appearance" },
  { id: "bars", label: "Menu buttons" },
  { id: "terminal", label: "Terminal" },
  { id: "prompts", label: "Saved prompts" },
  ...(DICTATION_SUPPORTED ? [{ id: "dictation" as const, label: "Dictation" }] : []),
] as const;
export type GeneralSection = "appearance" | "bars" | "terminal" | "prompts" | "dictation";
