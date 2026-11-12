import { create } from "zustand";
import { deliverDesktopAlert } from "../desktopNotifications";
import { sessionAgent, type SessionAgentId } from "../../server/lib/session-agents.js";

export type NotificationCategory = "sync" | "terminal" | "app";
export const NOTIFICATION_EVENTS = {
  "agent-start-failed": "Agent start failed",
  "model-ready": "Voice model downloaded", "model-error": "Voice model download failed",
  "setup-installed": "Requirement installed", "setup-failed": "Requirement install failed",
  "sync-completed": "Sync completed", "sync-error": "Sync errors",
  "terminal-bell": "Terminal attention signal", "terminal-exit": "Terminal process exit",
  "agent-finished": "Agent finished with changes", "agent-permission": "Agent asks for approval",
  "task-start-failed": "Task start failed",
} as const;
export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;
export const NOTIFICATION_EVENT_CATEGORIES: Record<NotificationEvent, NotificationCategory> = {
  "agent-start-failed": "app", "task-start-failed": "app",
  "model-ready": "app", "model-error": "app", "setup-installed": "app", "setup-failed": "app",
  "sync-completed": "sync", "sync-error": "sync", "terminal-bell": "terminal", "terminal-exit": "terminal", "agent-finished": "terminal", "agent-permission": "terminal",
};
export interface NotificationTarget { tileId?: string; section?: "sync" | "mcp" | "devices" | "general" | "quick-chat" }
/** A follow-up a notice offers besides opening its target: the tile's uncommitted changes. */
/**
 * How an approval prompt stopped waiting: answered from the app or in the
 * terminal, its tile closed, an answer from the app was cut short, or its
 * pane could not be confirmed to run that agent.
 */
export type PermissionOutcome = "answered" | "elsewhere" | "closed" | "interrupted" | "unverified";
const PERMISSION_OUTCOMES: readonly string[] = ["answered", "elsewhere", "closed", "interrupted", "unverified"];
/**
 * A follow-up a notice offers besides opening its target: the tile's
 * uncommitted changes, or the choices of an agent's approval prompt.
 */
export type NoticeAction =
  | { kind: "review-changes"; folder: string }
  | { kind: "permission"; promptId: string; agent: SessionAgentId; outcome?: PermissionOutcome; choice?: string };
function savedAction(value: unknown): NoticeAction | undefined {
  if (!value || typeof value !== "object") return undefined;
  const action = value as Record<string, unknown>;
  if (action.kind === "review-changes" && typeof action.folder === "string" && action.folder.startsWith("/") && action.folder.length <= 4096) return { kind: "review-changes", folder: action.folder };
  const agent = action.kind === "permission" ? sessionAgent(action.agent) : undefined;
  if (agent && typeof action.promptId === "string" && action.promptId.length <= 64) {
    // A prompt cannot outlive the app session that saw it.
    const outcome = typeof action.outcome === "string" && PERMISSION_OUTCOMES.includes(action.outcome) ? action.outcome as PermissionOutcome : "closed";
    return { kind: "permission", promptId: action.promptId, agent: agent.id, outcome, choice: typeof action.choice === "string" ? action.choice.slice(0, 80) : undefined };
  }
  return undefined;
}
export interface Notice {
  event?: NotificationEvent;
  id: string; category: NotificationCategory; title: string; body: string;
  source?: string;
  createdAt: number; read: boolean; target?: NotificationTarget; dedupeKey?: string;
  action?: NoticeAction;
}
interface Preferences {
  enabled: boolean; desktop: boolean;
  events: Partial<Record<NotificationEvent, boolean>>;
  categories: Record<NotificationCategory, boolean>; mutedUntil: number;
}
interface NotificationState {
  items: Notice[]; preferences: Preferences;
  read(id?: string): void; readTile(tileId: string): void; clear(): void; remove(id: string): void;
  update(id: string, patch: Partial<Pick<Notice, "title" | "body" | "action">>): void;
  configure(patch: Partial<Preferences>): void;
}
const storeName = "pzza.notifications.v1";
const defaults: Preferences = { enabled: true, desktop: false, events: {}, categories: { sync: true, terminal: true, app: true }, mutedUntil: 0 };
const categories = ["sync", "terminal", "app"];
function initial(): { items: Notice[]; preferences: Preferences } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storeName) || "null");
    if (!saved || typeof saved !== "object") return { items: [], preferences: defaults };
    const raw = saved as Record<string, unknown>;
    const items = Array.isArray(raw.items) ? raw.items.filter((item): item is Notice => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return typeof row.id === "string" && typeof row.category === "string" && categories.includes(row.category) &&
        typeof row.title === "string" && row.title.length <= 160 && typeof row.body === "string" && row.body.length <= 4000 &&
        typeof row.createdAt === "number" && Number.isFinite(row.createdAt) && row.createdAt <= Date.now() && row.createdAt > Date.now() - 30 * 86400000 && typeof row.read === "boolean";
    }).slice(0, 300).map(item => {
      const target: NotificationTarget = {};
      if (item.target && typeof item.target === "object") {
        if (typeof item.target.tileId === "string" && item.target.tileId.length <= 512) target.tileId = item.target.tileId;
        if (item.target.section === "sync" || item.target.section === "mcp" || item.target.section === "devices" || item.target.section === "general" || item.target.section === "quick-chat") target.section = item.target.section;
      }
      const event = item.event && Object.hasOwn(NOTIFICATION_EVENTS, item.event) ? item.event : undefined;
      const action = savedAction(item.action);
      // A prompt still waiting at the last run is rescanned and announced afresh.
      const read = item.read || (action?.kind === "permission" && !(item.action as { outcome?: unknown }).outcome);
      return { ...item, read, event, target, action, dedupeKey: typeof item.dedupeKey === "string" ? item.dedupeKey.slice(0, 512) : undefined, source: typeof item.source === "string" && item.source ? item.source.slice(0, 160) : undefined };
    }) : [];
    const preferences = { ...defaults, categories: { ...defaults.categories } };
    if (raw.preferences && typeof raw.preferences === "object") {
      const value = raw.preferences as Record<string, unknown>;
      for (const field of ["enabled", "desktop"] as const) if (typeof value[field] === "boolean") preferences[field] = value[field];
      if (typeof value.mutedUntil === "number" && Number.isFinite(value.mutedUntil)) preferences.mutedUntil = value.mutedUntil;
      if (value.events && typeof value.events === "object") {
        preferences.events = {};
        for (const event of Object.keys(NOTIFICATION_EVENTS) as NotificationEvent[]) {
          const flag = (value.events as Record<string, unknown>)[event];
          if (typeof flag === "boolean") preferences.events[event] = flag;
        }
      }
      if (value.categories && typeof value.categories === "object") {
        const flags = value.categories as Record<string, unknown>;
        for (const category of ["sync", "terminal", "app"] as const) if (typeof flags[category] === "boolean") preferences.categories[category] = flags[category];
      }
    }
    return { items, preferences };
  } catch { return { items: [], preferences: defaults }; }
}
// Tiles that own an unread notice, sorted. Subscribe through useShallow so a
// new notice for an already waiting tile changes nothing.
export function unreadTileIds(state: Pick<NotificationState, "items">): string[] {
  const ids = new Set<string>();
  for (const item of state.items) {
    if (!item.read && item.target?.tileId) ids.add(item.target.tileId);
  }
  return [...ids].sort();
}

export const useNotifications = create<NotificationState>((set) => ({
  ...initial(),
  read: (id) => set(state => ({ items: state.items.map(item => !id || item.id === id ? { ...item, read: true } : item) })),
  readTile: (tileId) => set(state => {
    if (!state.items.some(item => !item.read && item.target?.tileId === tileId)) return state;
    return { items: state.items.map(item => item.target?.tileId === tileId ? { ...item, read: true } : item) };
  }),
  clear: () => set({ items: [] }),
  remove: (id) => set(state => ({ items: state.items.filter(item => item.id !== id) })),
  update: (id, patch) => set(state => ({ items: state.items.map(item => item.id !== id ? item : {
    ...item, ...patch, title: (patch.title ?? item.title).slice(0, 160), body: (patch.body ?? item.body).slice(0, 4000),
  }) })),
  configure: (patch) => set(state => ({ preferences: { ...state.preferences, ...patch } })),
}));
function persistNotifications({ items, preferences }: Pick<NotificationState, "items" | "preferences">): void {
  try { localStorage.setItem(storeName, JSON.stringify({ items, preferences })); } catch { /* Keep the in-memory history when storage is full or unavailable. */ }
}
useNotifications.subscribe(persistNotifications);
persistNotifications(useNotifications.getState());
// History keeps the full body; cards and desktop alerts show a bounded preview
// so a long terminal response does not take over the panel.
export const NOTICE_PREVIEW_CHARS = 280;
export function noticePreview(text: string, max = NOTICE_PREVIEW_CHARS): string {
  const chars = Array.from(text.trim());
  return chars.length > max ? `${chars.slice(0, max - 1).join("").trimEnd()}…` : chars.join("");
}
/** Whether the master, category and event switches let this kind of notice into the history. */
export function noticeAllowed(category: NotificationCategory, event?: NotificationEvent): boolean {
  const { preferences } = useNotifications.getState();
  return preferences.enabled && preferences.categories[category] && (!event || preferences.events[event] !== false);
}
/** Records a notice; returns its id, or undefined when preferences or dedupe dropped it. */
export function notify(input: Omit<Notice, "id" | "createdAt" | "read">): string | undefined {
  const { items, preferences } = useNotifications.getState();
  if (!noticeAllowed(input.category, input.event)) return undefined;
  const now = Date.now();
  if (input.dedupeKey && items.some(item => item.dedupeKey === input.dedupeKey && now - item.createdAt < 30000)) return undefined;
  const notice: Notice = { ...input, title: input.title.slice(0, 160), body: input.body.slice(0, 4000), source: input.source?.slice(0, 160) || undefined, id: crypto.randomUUID(), createdAt: now, read: false };
  useNotifications.setState({ items: [notice, ...items.filter(item => now - item.createdAt < 30 * 86400000)].slice(0, 300) });
  if (preferences.mutedUntil > now) return notice.id;
  const canDeliver = () => {
    const current = useNotifications.getState().preferences;
    return current.enabled && current.desktop && current.categories[input.category] && (!input.event || current.events[input.event] !== false) && current.mutedUntil <= Date.now() && !document.hasFocus();
  };
  if (canDeliver()) void deliverDesktopAlert({ ...notice, title: notice.source ? `${notice.source} - ${notice.title}` : notice.title, body: noticePreview(notice.body) }, canDeliver).catch(() => { /* Activity history remains available when the OS rejects an alert. */ });
  return notice.id;
}
