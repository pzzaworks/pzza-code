import { ScrollMore } from "../ui/ScrollMore";
import { useEffect, useState } from "react";
import { useNotifications, NOTIFICATION_EVENTS, type NotificationEvent, type Notice, type NotificationCategory } from "../state/notifications";
import { useStore } from "../state/store";
import { DEFAULT_WORKSPACE_ID } from "../workspaces";

function openNotice(item: Notice) {
  useNotifications.getState().read(item.id);
  if (item.target?.section) window.dispatchEvent(new CustomEvent("pzza-notification-section", { detail: item.target.section }));
  if (item.target?.tileId) {
    const state = useStore.getState();
    const tile = state.tiles.find(entry => entry.id === item.target?.tileId);
    if (!tile) return;
    const key = (tile.host ? `${tile.host}::` : "") + (tile.session ?? tile.name);
    state.setWorkspace(state.sessionWs[key] ?? DEFAULT_WORKSPACE_ID);
    state.unhideTile(tile.id); state.setActive(tile.id);
    window.dispatchEvent(new Event("pzza-notification-terminal"));
  }
}
function Rows({ items }: { items: Notice[] }) {
  const remove = useNotifications(state => state.remove);
  return <div className="notification-list">{items.length ? items.map(item => <article key={item.id} className={`notification-row ${item.read ? "" : "unread"}`}>
    <button className="notification-content" onClick={() => openNotice(item)}>
      <strong>{item.title}</strong><span>{item.body}</span>
      <small>{item.category} · <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time></small>
    </button>
    <button className="tile-btn" aria-label={`Dismiss ${item.title}`} onClick={() => remove(item.id)}>×</button>
  </article>) : <p className="set-note">You’re all caught up. New activity will appear here.</p>}</div>;
}
export function LatestNotifications({ viewAll }: { viewAll(): void }) {
  const items = useNotifications(state => state.items);
  return <div className="menu-body"><div className="notification-actions"><strong>Notifications</strong><button className="btn btn-sm" onClick={() => useNotifications.getState().read()}>Mark all read</button></div>
    <Rows items={items.slice(0, 5)} /><button className="btn" onClick={viewAll}>View all notifications</button></div>;
}
export function NotificationsSettings() {
  const { items, preferences, configure, read, clear } = useNotifications();
  const [filter, setFilter] = useState<NotificationCategory | "all" | "unread">("all");
  const [limit, setLimit] = useState(15);
  const [permissionError, setPermissionError] = useState("");
  const filtered = items.filter(item => filter === "all" || (filter === "unread" ? !item.read : item.category === filter));
  return <div className="notification-settings">
    <div className="notification-preferences">
      {([ ["enabled", "Enable notifications"], ["banners", "Show in-app banners"] ] as const).map(([key, label]) => <label key={key}><input type="checkbox" checked={preferences[key]} onChange={event => configure({ [key]: event.target.checked })} />{label}</label>)}
      <label><input type="checkbox" checked={preferences.desktop} onChange={event => {
        if (!event.target.checked) { configure({ desktop: false }); return; }
        if (typeof Notification === "undefined") { setPermissionError("System notifications are unavailable in this runtime. In-app notifications still work."); return; }
        void Notification.requestPermission().then(permission => { configure({ desktop: permission === "granted" }); setPermissionError(permission === "granted" ? "" : "Allow notifications in your browser or system settings first."); }).catch(() => setPermissionError("System notification permission could not be requested."));
      }} />System alerts while the app is unfocused</label>
      {(["sync", "terminal", "bridge", "devices", "app"] as const).map(category => <label key={category}><input type="checkbox" checked={preferences.categories[category]} onChange={event => configure({ categories: { ...preferences.categories, [category]: event.target.checked } })} />{category === "sync" ? "Sync results and errors" : category === "terminal" ? "Terminal attention and completion signals" : category === "bridge" ? "Bridge job results and approval requests" : category === "devices" ? "Device changes" : "App activity"}</label>)}
      <details><summary>Choose individual events</summary><div className="notification-preferences">
        {(Object.entries(NOTIFICATION_EVENTS) as [NotificationEvent, string][]).map(([event, label]) => <label key={event}><input type="checkbox" checked={preferences.events[event] !== false} onChange={change => configure({ events: { ...preferences.events, [event]: change.target.checked } })} />{label}</label>)}
      </div></details>
      <p className="set-note">Terminal silence does not mean a task has finished. Only explicit terminal signals and process exits generate events. History stays on this device, up to 300 entries for 30 days. System alerts hide activity details.</p>
      {permissionError ? <p role="alert">{permissionError}</p> : null}
      <button className="btn btn-sm" onClick={() => configure({ mutedUntil: preferences.mutedUntil > Date.now() ? 0 : Date.now() + 3600000 })}>{preferences.mutedUntil > Date.now() ? "Resume alerts" : "Pause alerts for 1 hour"}</button>
    </div>
    <div className="notification-actions">{(["all", "unread", "sync", "terminal", "bridge", "devices", "app"] as const).map(value => <button className={`btn btn-sm ${filter === value ? "btn-on" : ""}`} key={value} onClick={() => { setFilter(value); setLimit(15); }}>{value}</button>)}</div>
    <div className="notification-actions"><span>{filtered.length} notifications</span><button className="btn btn-sm" onClick={() => read()}>Mark all read</button><button className="btn btn-sm" disabled={!items.length} onClick={clear}>Clear history</button></div>
    <Rows items={filtered.slice(0, limit)} />
    <ScrollMore hasMore={limit < filtered.length} loadMore={() => setLimit(value => value + 15)} />
  </div>;
}
export function NotificationBanners() {
  const [items, setItems] = useState<Notice[]>([]);
  useEffect(() => {
    const timers = new Set<ReturnType<typeof setTimeout>>();
    const onNotice = (event: Event) => {
      const item = (event as CustomEvent<Notice>).detail;
      setItems(current => [item, ...current].slice(0, 3));
      const timer = setTimeout(() => { setItems(current => current.filter(entry => entry.id !== item.id)); timers.delete(timer); }, 7000);
      timers.add(timer);
    };
    window.addEventListener("pzza-notification", onNotice);
    return () => { window.removeEventListener("pzza-notification", onNotice); timers.forEach(clearTimeout); };
  }, []);
  return <div className="notification-banners" aria-live="polite">{items.map(item => <div className="notification-banner" key={item.id}><button onClick={() => { openNotice(item); setItems(current => current.filter(entry => entry.id !== item.id)); }}><strong>{item.title}</strong><span>{item.body}</span></button><button aria-label="Dismiss notification banner" onClick={() => setItems(current => current.filter(entry => entry.id !== item.id))}>×</button></div>)}</div>;
}
