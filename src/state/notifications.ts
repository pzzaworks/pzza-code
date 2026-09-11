import { create } from "zustand";
import { deliverDesktopAlert } from "../desktopNotifications";

export type NotificationCategory = "sync" | "terminal" | "bridge" | "devices" | "app";
export const NOTIFICATION_EVENTS = {
  "device-added": "Device added", "device-removed": "Device removed", "session-opened": "Session window opened",
  "model-ready": "Voice model downloaded", "model-error": "Voice model download failed",
  "sync-completed": "Sync completed", "sync-error": "Sync errors",
  "terminal-bell": "Terminal attention signal", "terminal-command": "Terminal command result", "terminal-exit": "Terminal process exit",
  "bridge-approval": "Bridge approval required", "bridge-result": "Bridge job result",
} as const;
export type NotificationEvent = keyof typeof NOTIFICATION_EVENTS;
export const NOTIFICATION_EVENT_CATEGORIES: Record<NotificationEvent, NotificationCategory> = {
  "session-opened": "app",
  "model-ready": "app", "model-error": "app", "device-added": "devices", "device-removed": "devices",
  "sync-completed": "sync", "sync-error": "sync", "terminal-bell": "terminal", "terminal-command": "terminal", "terminal-exit": "terminal",
  "bridge-approval": "bridge", "bridge-result": "bridge",
};
export interface NotificationTarget { tileId?: string; section?: "sync" | "mcp" | "devices" | "general" | "quick-chat" }
export interface Notice {
  event?: NotificationEvent;
  id: string; category: NotificationCategory; title: string; body: string;
  createdAt: number; read: boolean; target?: NotificationTarget; dedupeKey?: string;
}
interface Preferences {
  enabled: boolean; desktop: boolean;
  events: Partial<Record<NotificationEvent, boolean>>;
  categories: Record<NotificationCategory, boolean>; mutedUntil: number;
}
interface NotificationState {
  items: Notice[]; preferences: Preferences;
  read(id?: string): void; clear(): void; remove(id: string): void;
  configure(patch: Partial<Preferences>): void;
}
const storeName = "pzza.notifications.v1";
const defaults: Preferences = { enabled: true, desktop: false, events: {}, categories: { sync: true, terminal: true, bridge: true, devices: true, app: true }, mutedUntil: 0 };
const categories = ["sync", "terminal", "bridge", "devices", "app"];
function initial(): { items: Notice[]; preferences: Preferences } {
  try {
    const saved: unknown = JSON.parse(localStorage.getItem(storeName) || "null");
    if (!saved || typeof saved !== "object") return { items: [], preferences: defaults };
    const raw = saved as Record<string, unknown>;
    const items = Array.isArray(raw.items) ? raw.items.filter((item): item is Notice => {
      if (!item || typeof item !== "object") return false;
      const row = item as Record<string, unknown>;
      return typeof row.id === "string" && typeof row.category === "string" && categories.includes(row.category) &&
        typeof row.title === "string" && row.title.length <= 160 && typeof row.body === "string" && row.body.length <= 400 &&
        typeof row.createdAt === "number" && Number.isFinite(row.createdAt) && row.createdAt <= Date.now() && row.createdAt > Date.now() - 30 * 86400000 && typeof row.read === "boolean";
    }).slice(0, 300).map(item => {
      const target: NotificationTarget = {};
      if (item.target && typeof item.target === "object") {
        if (typeof item.target.tileId === "string" && item.target.tileId.length <= 512) target.tileId = item.target.tileId;
        if (item.target.section === "sync" || item.target.section === "mcp" || item.target.section === "devices" || item.target.section === "general" || item.target.section === "quick-chat") target.section = item.target.section;
      }
      const event = item.event && Object.hasOwn(NOTIFICATION_EVENTS, item.event) ? item.event : undefined;
      return { ...item, event, target, dedupeKey: typeof item.dedupeKey === "string" ? item.dedupeKey.slice(0, 512) : undefined };
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
        for (const category of ["sync", "terminal", "bridge", "devices", "app"] as const) if (typeof flags[category] === "boolean") preferences.categories[category] = flags[category];
      }
    }
    return { items, preferences };
  } catch { return { items: [], preferences: defaults }; }
}
export const useNotifications = create<NotificationState>((set) => ({
  ...initial(),
  read: (id) => set(state => ({ items: state.items.map(item => !id || item.id === id ? { ...item, read: true } : item) })),
  clear: () => set({ items: [] }),
  remove: (id) => set(state => ({ items: state.items.filter(item => item.id !== id) })),
  configure: (patch) => set(state => ({ preferences: { ...state.preferences, ...patch } })),
}));
useNotifications.subscribe(({ items, preferences }) => {
  try { localStorage.setItem(storeName, JSON.stringify({ items, preferences })); } catch { /* Keep the in-memory history when storage is full or unavailable. */ }
});
export function notify(input: Omit<Notice, "id" | "createdAt" | "read">): void {
  const { items, preferences } = useNotifications.getState();
  if (!preferences.enabled || !preferences.categories[input.category] || (input.event && preferences.events[input.event] === false)) return;
  const now = Date.now();
  if (input.dedupeKey && items.some(item => item.dedupeKey === input.dedupeKey && now - item.createdAt < 30000)) return;
  const notice: Notice = { ...input, title: input.title.slice(0, 160), body: input.body.slice(0, 400), id: crypto.randomUUID(), createdAt: now, read: false };
  useNotifications.setState({ items: [notice, ...items.filter(item => now - item.createdAt < 30 * 86400000)].slice(0, 300) });
  if (preferences.mutedUntil > now) return;
  const canDeliver = () => {
    const current = useNotifications.getState().preferences;
    return current.enabled && current.desktop && current.categories[input.category] && (!input.event || current.events[input.event] !== false) && current.mutedUntil <= Date.now() && !document.hasFocus();
  };
  if (canDeliver()) void deliverDesktopAlert(input.category, canDeliver).catch(() => { /* Activity history remains available when the OS rejects an alert. */ });
}
