import { Blocks, BookOpen, Bot, GitBranch, LayoutGrid, Lightbulb, Mic, Rocket, SquareTerminal, type LucideIcon } from "lucide-react";
import { DOCS_PAGES, DOCS_SECTIONS, type DocSlug } from "../help/generated/docs";

// The Help catalog: the website's docs pages (src/help/generated, written by
// `npm run sync:help`), by topic id. The topic ids are what open_help, the
// app menu and the command palette name a page by, so they stay as they are:
// a page's docs slug, except where the app named the page first. The pages
// themselves (HelpModal) load with Settings; the app shell, Settings'
// navigation and app control only need to know which topics exist.
const SECTIONS = [
  { id: "getting-started", icon: Rocket, topics: ["start", "setup", "permissions", "topbar", "new-session", "agents", "palette", "settings"] },
  { id: "guides", icon: BookOpen, topics: ["run-multiple-claude-code-sessions", "claude-code-git-worktrees", "compare-claude-code-and-codex", "send-one-prompt-to-multiple-agents", "run-claude-code-over-ssh", "keep-claude-code-running", "claude-code-permission-prompts", "track-claude-code-usage-limits"] },
  { id: "workspace", icon: LayoutGrid, topics: ["tiles", "controls", "focus", "layout", "spacing", "workspaces", "snapshots", "restore", "broadcast"] },
  { id: "git", icon: GitBranch, topics: ["git", "ci", "shared-branch", "worktrees", "land", "changes", "review"] },
  { id: "terminal", icon: SquareTerminal, topics: ["links", "paths", "paste", "drop", "find", "search", "prompts", "code"] },
  { id: "agents", icon: Bot, topics: ["tasks", "best-of-n", "quick-chat", "agent-tools", "notifications", "usage", "multiaccount"] },
  { id: "voice", icon: Mic, topics: ["dictation", "languages"] },
  { id: "connections", icon: Blocks, topics: ["devices", "sync", "ports", "rdp", "mcp"] },
  { id: "tips", icon: Lightbulb, topics: ["shortcuts", "terminal-keys", "tips"] },
] as const;
export type HelpTopic = typeof SECTIONS[number]["topics"][number];
export type HelpSection = typeof SECTIONS[number]["id"];
export interface HelpRequest { topic: string; serial: number }

/** The topics whose id differs from their docs slug. */
const SLUG_OF_TOPIC = { start: "index", "quick-chat": "quickchat", code: "editor" } as const satisfies Partial<Record<HelpTopic, DocSlug>>;
const renamed = (topic: HelpTopic): topic is keyof typeof SLUG_OF_TOPIC => Object.hasOwn(SLUG_OF_TOPIC, topic);
/** The docs page a topic shows. Every other topic is its own slug, which the compiler checks against the synced pages. */
export const helpSlug = (topic: HelpTopic): DocSlug => (renamed(topic) ? SLUG_OF_TOPIC[topic] : topic);
type SlugOf<T extends HelpTopic> = T extends keyof typeof SLUG_OF_TOPIC ? typeof SLUG_OF_TOPIC[T] : T;
type MissingDocPages = Exclude<DocSlug, SlugOf<HelpTopic>>;
/** Checked by the compiler: every synced docs page has a topic above (an error here names the pages to add). */
export const HELP_COVERS_THE_DOCS: [MissingDocPages] extends [never] ? true : MissingDocPages = true;

/** A section's name, as the docs' navigation titles it. */
function sectionTitle(id: HelpSection): string {
  const section = DOCS_SECTIONS.find((item) => item.id === id);
  if (!section) throw new Error(`Help section "${id}" is not a docs section; run npm run sync:help`);
  return section.title;
}

export interface HelpSectionInfo { id: HelpSection; label: string; icon: LucideIcon; topics: readonly HelpTopic[] }
export const HELP_SECTIONS: readonly HelpSectionInfo[] = SECTIONS.map((section) => ({ ...section, label: sectionTitle(section.id) }));

// Every page in reading order, for previous / next.
export const HELP_ORDER: readonly HelpTopic[] = HELP_SECTIONS.flatMap((section) => section.topics);
export const isHelpTopic = (value: string): value is HelpTopic => HELP_ORDER.some((topic) => topic === value);
export const sectionOf = (topic: HelpTopic) => HELP_SECTIONS.find((section) => section.topics.some((id) => id === topic)) ?? HELP_SECTIONS[0];

/** A page's heading and the line under it, from its docs frontmatter. */
export const helpPage = (topic: HelpTopic) => DOCS_PAGES[helpSlug(topic)];
/** A page's name in lists (navigation, previous / next, the palette): the docs' shorter label where it has one. */
export const helpLabel = (topic: HelpTopic): string => helpPage(topic).nav ?? helpPage(topic).title;

const TOPIC_OF_SLUG = new Map<string, HelpTopic>(HELP_ORDER.map((topic) => [helpSlug(topic), topic]));
/** The topic that shows a docs slug (a `/docs/<slug>` link), if Help has it. */
export const topicOfSlug = (slug: string): HelpTopic | undefined => TOPIC_OF_SLUG.get(slug);
