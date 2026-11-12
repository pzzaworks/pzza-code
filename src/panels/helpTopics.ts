import { Blocks, Bot, GitBranch, LayoutGrid, Lightbulb, Mic, Rocket, SquareTerminal } from "lucide-react";

// The Help catalog's sections and topics. The pages themselves (HelpModal)
// load with Settings; the app shell, Settings' navigation and app control
// only need to know which topics exist.
export const HELP_SECTIONS = [
  { id: "getting-started", label: "Getting started", icon: Rocket, topics: ["start", "setup", "permissions", "topbar", "new-session", "agents", "palette", "settings"] },
  { id: "workspace", label: "Workspace", icon: LayoutGrid, topics: ["tiles", "controls", "focus", "layout", "spacing", "workspaces", "snapshots", "restore", "broadcast"] },
  { id: "git", label: "Git & review", icon: GitBranch, topics: ["git", "ci", "shared-branch", "worktrees", "land", "changes", "review"] },
  { id: "terminal", label: "Terminal & editor", icon: SquareTerminal, topics: ["links", "paths", "paste", "drop", "find", "search", "prompts", "code"] },
  { id: "agents", label: "Agents & activity", icon: Bot, topics: ["tasks", "best-of-n", "quick-chat", "agent-tools", "notifications", "usage", "multiaccount"] },
  { id: "voice", label: "Voice dictation", icon: Mic, topics: ["dictation", "languages"] },
  { id: "connections", label: "Connections", icon: Blocks, topics: ["devices", "sync", "ports", "rdp", "mcp"] },
  { id: "tips", label: "Shortcuts & tips", icon: Lightbulb, topics: ["shortcuts", "terminal-keys", "tips"] },
] as const;
export type HelpTopic = typeof HELP_SECTIONS[number]["topics"][number];
export type HelpSection = typeof HELP_SECTIONS[number]["id"];
export interface HelpRequest { topic: string; serial: number }

// Every page in reading order, for previous / next.
export const HELP_ORDER: readonly HelpTopic[] = HELP_SECTIONS.flatMap((section): readonly HelpTopic[] => section.topics);
export const isHelpTopic = (value: string): value is HelpTopic => HELP_ORDER.some((topic) => topic === value);
export const sectionOf = (topic: HelpTopic) => HELP_SECTIONS.find((section) => section.topics.some((id) => id === topic)) ?? HELP_SECTIONS[0];
