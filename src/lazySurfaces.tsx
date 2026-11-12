import { lazySurface, type LazySurface } from "./lazySurface";
import { useStore } from "./state/store";
import { useTasksUi } from "./tasks/taskStore";
import { onboardingPending, setupPending } from "./tour/progress";
import { loadWorkspaceIconSet, needsFullIconSet } from "./workspaceIcons";

// The parts of the window that are not needed to show it, each loaded from its
// own chunk (see lazySurface). Everything that has to exist before they open
// (shortcuts, app-control handlers, window events, store wiring) stays in the
// app shell; only what they render loads later.

// The tile code editor (CodeMirror, the file tree, Changes and diffs). Its
// language packs load separately, with the first file (editorLanguageLoader).
// The fallback is the panel's own empty frame.
export const TileCodePanel = lazySurface(() => import("./grid/TileCodePanel").then((module) => module.TileCodePanel), <div className="tile-code" />, { label: "The editor", className: "tile-code grid-empty" });

// What the Tasks dropdown shows: the list, the new-task form and one task (the large diff loads separately).
export const TasksPanel = lazySurface(() => import("./tasks/TasksPanel").then((module) => module.TasksPanel));
export const TASK_SURFACES: readonly LazySurface<never>[] = [TasksPanel];
// A task's full details, in a window like a tile's Checkpoints (with the diff viewer).
export const TaskWindow = lazySurface(() => import("./tasks/TaskWindow").then((module) => module.TaskWindow), null, { label: "The task window", variant: "dialog", dismiss: () => useTasksUi.getState().closeDetails() });

export const CommandPalette = lazySurface(() => import("./panels/CommandPalette").then((module) => module.CommandPalette), null, { label: "The command palette", variant: "dialog", dismiss: (props) => props.onClose() });
export const TerminalSearch = lazySurface(() => import("./panels/TerminalSearch").then((module) => module.TerminalSearch), null, { label: "Terminal search", variant: "dialog", dismiss: (props) => props.onClose() });

export const SetupScreen = lazySurface(() => import("./tour/SetupScreen").then((module) => module.SetupScreen), null, { label: "Setup", variant: "dialog" });
export const OnboardingTour = lazySurface(() => import("./tour/OnboardingTour").then((module) => module.OnboardingTour), null, { label: "The tour", variant: "dialog", dismiss: (props) => props.onClose() });
/** Setup is always followed by the tour, so both load together. */
export const ONBOARDING: readonly LazySurface<never>[] = [SetupScreen, OnboardingTour];

// Settings pages. The Settings window itself stays in the shell: it registers
// app-control handlers while closed.
export const SettingsMenu = lazySurface(() => import("./panels/SettingsMenu").then((module) => module.SettingsMenu));
export const DevicesMenu = lazySurface(() => import("./panels/DevicesMenu").then((module) => module.DevicesMenu));
export const ProjectsMenu = lazySurface(() => import("./panels/ProjectsMenu").then((module) => module.ProjectsMenu));
export const McpMenu = lazySurface(() => import("./panels/McpMenu").then((module) => module.McpMenu));
export const SetupSettings = lazySurface(() => import("./panels/SetupSettings").then((module) => module.SetupSettings));
export const About = lazySurface(() => import("./panels/About").then((module) => module.About));
export const HelpContent = lazySurface(() => import("./panels/HelpModal").then((module) => module.HelpContent));
export const HelpNav = lazySurface(() => import("./panels/HelpModal").then((module) => module.HelpNav));
/** Settings opens once all of its pages are loaded, so switching pages never waits either. */
export const SETTINGS_PAGES: readonly LazySurface<never>[] = [SettingsMenu, DevicesMenu, ProjectsMenu, McpMenu, SetupSettings, About, HelpContent, HelpNav];

// Workspace settings and the icon picker (with the full lucide icon set).
export const WorkspaceSettings = lazySurface(() => import("./panels/WorkspaceSettings").then((module) => module.WorkspaceSettings));
export const IconPicker = lazySurface(() => import("./ui/IconPicker").then((module) => module.IconPicker));

export function preloadSurfaces(surfaces: readonly LazySurface<never>[]): Promise<void> {
  return Promise.all(surfaces.map((surface) => surface.preload())).then(() => undefined);
}

/**
 * What the first window shows right away: setup or the tour on first launch,
 * open editors, and workspace icons outside the bundled set. The first render
 * waits for these, so it looks exactly as if they had never been split off.
 */
export function preloadForFirstWindow(): Promise<void> {
  const state = useStore.getState();
  const wanted: Promise<void>[] = [];
  if (setupPending() || onboardingPending()) wanted.push(preloadSurfaces(ONBOARDING));
  if (Object.values(state.tileCode).some((code) => code?.open)) wanted.push(TileCodePanel.preload());
  if (needsFullIconSet(state.workspaces)) wanted.push(loadWorkspaceIconSet());
  return Promise.all(wanted).then(() => undefined);
}

// Loaded one at a time once the window has settled, so opening them later
// never waits: Settings, the palette, terminal search and the editor.
const IDLE_PRELOADS: readonly LazySurface<never>[] = [...SETTINGS_PAGES, CommandPalette, TerminalSearch, TileCodePanel, ...TASK_SURFACES];
const IDLE_DELAY_MS = 1500;

/** Starts the idle preloads; returns a cancel. */
export function preloadWhenIdle(): () => void {
  const queue = [...IDLE_PRELOADS];
  let cancelled = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let idle: number | undefined;
  const next = () => {
    idle = undefined;
    const surface = queue.shift();
    if (cancelled || !surface) return;
    void surface.preload().then(schedule);
  };
  // WebKit has no requestIdleCallback; a short timeout yields to pending work there.
  const schedule = () => {
    if (cancelled) return;
    if (typeof window.requestIdleCallback === "function") idle = window.requestIdleCallback(next, { timeout: 2000 });
    else timer = setTimeout(next, 50);
  };
  timer = setTimeout(schedule, IDLE_DELAY_MS);
  return () => {
    cancelled = true;
    clearTimeout(timer);
    if (idle !== undefined) window.cancelIdleCallback(idle);
  };
}
