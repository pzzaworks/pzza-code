import { icons as LucideIcons, Folder } from "lucide-react";
import type { IconType } from "./sessionMeta";

// The full lucide set (~1800 icons), keyed by PascalCase name. Casting here so
// the picker can look icons up by name without fighting lucide's strict typing.
const ICONS = LucideIcons as unknown as Record<string, IconType>;

// Back-compat: the original picker stored short keys. Map them to lucide names
// so existing workspaces keep their icon after the switch to the full set.
const ALIAS: Record<string, string> = {
  folder: "Folder",
  git: "FolderGit2",
  server: "Server",
  laptop: "Laptop",
  terminal: "SquareTerminal",
  box: "Box",
  boxes: "Boxes",
  layers: "Layers",
  cloud: "Cloud",
  cpu: "Cpu",
  database: "Database",
  code: "Code",
  globe: "Globe",
  rocket: "Rocket",
  flame: "Flame",
  zap: "Zap",
  star: "Star",
  hexagon: "Hexagon",
  ghost: "Ghost",
  wrench: "Wrench",
};

export const DEFAULT_WORKSPACE_ICON = "Folder";

// Resolve a stored icon key (old short key or lucide name) to a component.
export function workspaceIcon(key?: string): IconType {
  if (!key) return Folder;
  const name = ALIAS[key] ?? key;
  return ICONS[name] ?? Folder;
}

// True if a lucide icon exists for this name.
export function hasIcon(name: string): boolean {
  return !!ICONS[ALIAS[name] ?? name];
}

// All lucide icon names, for search.
export const ALL_ICON_NAMES = Object.keys(ICONS);

// A curated default set shown before the user searches - a broad, useful mix.
export const CURATED_ICONS: string[] = [
  "Folder", "FolderGit2", "FolderOpen", "FolderCode", "Files", "FileCode",
  "Server", "ServerCog", "Database", "HardDrive", "Cpu", "MemoryStick",
  "Laptop", "Monitor", "SquareTerminal", "Terminal", "Container",
  "Cloud", "CloudCog", "Globe", "Network", "Wifi", "Router",
  "Code", "Braces", "Binary", "Bug", "GitBranch", "GitCommitHorizontal",
  "GitMerge", "GitPullRequest", "Boxes", "Box", "Package", "Layers",
  "Component", "Blocks", "Puzzle", "Workflow", "Wrench", "Hammer", "Settings",
  "Cog", "Rocket", "Flame", "Zap", "Sparkles", "Star", "Heart",
  "Bookmark", "Flag", "Pin", "Tag", "Hexagon", "Ghost", "Bot", "BrainCircuit",
  "Shield", "ShieldCheck", "Lock", "Key", "Eye", "Bell",
  "Activity", "Gauge", "ChartLine", "ChartBar", "ChartPie", "TrendingUp",
  "Table", "List", "LayoutGrid", "LayoutDashboard", "Kanban", "Columns3",
  "Inbox", "Mail", "MessageSquare", "MessagesSquare", "Send", "Phone", "Video",
  "Calendar", "Clock", "Timer", "AlarmClock", "Hourglass",
  "User", "Users", "UserCog", "Contact", "Building", "Building2", "House",
  "Briefcase", "Wallet", "CreditCard", "DollarSign", "Banknote", "ShoppingCart",
  "Music", "Headphones", "Mic", "Radio", "Play", "Film", "Camera", "Image",
  "Palette", "Brush", "PenTool", "Wand", "Pencil", "Feather", "Type",
  "Book", "BookOpen", "GraduationCap", "Library", "Newspaper", "FileText",
  "Map", "MapPin", "Compass", "Navigation", "Route", "Plane", "Car", "Truck",
  "Rocket", "Anchor", "Ship", "Bike", "Footprints", "Mountain", "TreePine",
  "Leaf", "Sprout", "Sun", "Moon", "CloudRain", "Snowflake", "Wind", "Droplet",
  "Coffee", "Pizza", "Utensils", "Beer", "Wine", "Apple", "Cherry", "Cookie",
  "Gamepad2", "Dice5", "Trophy", "Medal", "Target", "Crosshair", "Swords",
  "Atom", "FlaskConical", "TestTube", "Microscope", "Dna", "Magnet", "Orbit",
  "Lightbulb", "Plug", "Power", "Battery", "Cable", "Usb", "Bluetooth",
  "Smartphone", "Tablet", "Watch", "Keyboard", "Mouse", "Printer", "Webcam",
  "Cat", "Dog", "Bird", "Fish", "Bug", "Rabbit", "Turtle", "Snail",
  "Crown", "Gem", "Diamond", "Sparkle", "Award", "BadgeCheck",
];
