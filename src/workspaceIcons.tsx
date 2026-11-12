import { useSyncExternalStore } from "react";
import {
  Folder, FolderGit2, FolderOpen, FolderCode, Files, FileCode, Server, ServerCog, Database,
  HardDrive, Cpu, MemoryStick, Laptop, Monitor, SquareTerminal, Terminal, Container, Cloud, CloudCog,
  Globe, Network, Wifi, Router, Code, Braces, Binary, Bug, GitBranch, GitCommitHorizontal, GitMerge,
  GitPullRequest, Boxes, Box, Package, Layers, Component, Blocks, Puzzle, Workflow, Wrench, Hammer,
  Settings, Cog, Rocket, Flame, Zap, Sparkles, Star, Heart, Bookmark, Flag, Pin, Tag, Hexagon, Ghost,
  Bot, BrainCircuit, Shield, ShieldCheck, Lock, Key, Eye, Bell, Activity, Gauge, ChartLine, ChartBar,
  ChartPie, TrendingUp, Table, List, LayoutGrid, LayoutDashboard, Kanban, Columns3, Inbox, Mail,
  MessageSquare, MessagesSquare, Send, Phone, Video, Calendar, Clock, Timer, AlarmClock, Hourglass,
  User, Users, UserCog, Contact, Building, Building2, House, Briefcase, Wallet, CreditCard,
  DollarSign, Banknote, ShoppingCart, Music, Headphones, Mic, Radio, Play, Film, Camera, Image as ImageIcon,
  Palette, Brush, PenTool, Wand, Pencil, Feather, Type, Book, BookOpen, GraduationCap, Library,
  Newspaper, FileText, Map as MapIcon, MapPin, Compass, Navigation, Route, Plane, Car, Truck, Anchor, Ship,
  Bike, Footprints, Mountain, TreePine, Leaf, Sprout, Sun, Moon, CloudRain, Snowflake, Wind, Droplet,
  Coffee, Pizza, Utensils, Beer, Wine, Apple, Cherry, Cookie, Gamepad2, Dice5, Trophy, Medal, Target,
  Crosshair, Swords, Atom, FlaskConical, TestTube, Microscope, Dna, Magnet, Orbit, Lightbulb, Plug,
  Power, Battery, Cable, Usb, Bluetooth, Smartphone, Tablet, Watch, Keyboard, Mouse, Printer, Webcam,
  Cat, Dog, Bird, Fish, Rabbit, Turtle, Snail, Crown, Gem, Diamond, Sparkle, Award, BadgeCheck
} from "lucide-react";
import type { IconType } from "./sessionMeta";

// The curated icons ship with the app. The full lucide set (~1800 icons, about
// 1 MB of code) is its own chunk (workspaceIconSet), loaded at startup only when
// a saved workspace uses an icon outside the curated set, and otherwise when
// the icon picker opens or an app command names such an icon.
const CURATED: Record<string, IconType> = {
  Folder, FolderGit2, FolderOpen, FolderCode, Files, FileCode, Server, ServerCog, Database,
  HardDrive, Cpu, MemoryStick, Laptop, Monitor, SquareTerminal, Terminal, Container, Cloud, CloudCog,
  Globe, Network, Wifi, Router, Code, Braces, Binary, Bug, GitBranch, GitCommitHorizontal, GitMerge,
  GitPullRequest, Boxes, Box, Package, Layers, Component, Blocks, Puzzle, Workflow, Wrench, Hammer,
  Settings, Cog, Rocket, Flame, Zap, Sparkles, Star, Heart, Bookmark, Flag, Pin, Tag, Hexagon, Ghost,
  Bot, BrainCircuit, Shield, ShieldCheck, Lock, Key, Eye, Bell, Activity, Gauge, ChartLine, ChartBar,
  ChartPie, TrendingUp, Table, List, LayoutGrid, LayoutDashboard, Kanban, Columns3, Inbox, Mail,
  MessageSquare, MessagesSquare, Send, Phone, Video, Calendar, Clock, Timer, AlarmClock, Hourglass,
  User, Users, UserCog, Contact, Building, Building2, House, Briefcase, Wallet, CreditCard,
  DollarSign, Banknote, ShoppingCart, Music, Headphones, Mic, Radio, Play, Film, Camera, Image: ImageIcon,
  Palette, Brush, PenTool, Wand, Pencil, Feather, Type, Book, BookOpen, GraduationCap, Library,
  Newspaper, FileText, Map: MapIcon, MapPin, Compass, Navigation, Route, Plane, Car, Truck, Anchor, Ship,
  Bike, Footprints, Mountain, TreePine, Leaf, Sprout, Sun, Moon, CloudRain, Snowflake, Wind, Droplet,
  Coffee, Pizza, Utensils, Beer, Wine, Apple, Cherry, Cookie, Gamepad2, Dice5, Trophy, Medal, Target,
  Crosshair, Swords, Atom, FlaskConical, TestTube, Microscope, Dna, Magnet, Orbit, Lightbulb, Plug,
  Power, Battery, Cable, Usb, Bluetooth, Smartphone, Tablet, Watch, Keyboard, Mouse, Printer, Webcam,
  Cat, Dog, Bird, Fish, Rabbit, Turtle, Snail, Crown, Gem, Diamond, Sparkle, Award, BadgeCheck
};
let fullSet: Record<string, IconType> | null = null;
let loading: Promise<void> | null = null;
const listeners = new Set<() => void>();

/** Called by workspaceIconSet when it loads. */
export function registerFullIconSet(icons: Record<string, IconType>): void {
  fullSet = icons;
  for (const listener of listeners) listener();
}

/** Loads the full icon set; never rejects (a failed load can be retried). */
export function loadWorkspaceIconSet(): Promise<void> {
  return (loading ??= import("./workspaceIconSet").then(() => undefined, () => { loading = null; }));
}

/** Whether the full icon set has loaded; re-renders the caller when it does. */
export function useWorkspaceIconSet(): boolean {
  return useSyncExternalStore(subscribe, () => fullSet !== null);
}
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

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
// An icon outside the curated set shows the default until the full set loads
// (callers re-render through useWorkspaceIconSet).
export function workspaceIcon(key?: string): IconType {
  if (!key) return Folder;
  const name = ALIAS[key] ?? key;
  const icon = CURATED[name] ?? fullSet?.[name];
  if (icon) return icon;
  if (!fullSet) void loadWorkspaceIconSet();
  return Folder;
}

// True if a lucide icon exists for this name. Outside the curated set the
// answer needs the full set (see ensureWorkspaceIcon).
export function hasIcon(name: string): boolean {
  const key = ALIAS[name] ?? name;
  return !!(CURATED[key] ?? fullSet?.[key]);
}

/** Resolves once hasIcon and workspaceIcon can answer for this name. */
export function ensureWorkspaceIcon(name: string): Promise<void> {
  return CURATED[ALIAS[name] ?? name] || fullSet ? Promise.resolve() : loadWorkspaceIconSet();
}

/** True when one of these workspaces shows an icon outside the curated set. */
export function needsFullIconSet(workspaces: readonly { icon?: string }[]): boolean {
  return !fullSet && workspaces.some((workspace) => !!workspace.icon && !CURATED[ALIAS[workspace.icon] ?? workspace.icon]);
}

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
