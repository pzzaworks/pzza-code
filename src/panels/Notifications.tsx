import { registerAppControlHandler, registerAppControlState } from "../appControlRuntime";
import { ArrowUpRight, Bell, FileDiff, ShieldQuestion, X } from "lucide-react";
import { PermissionNoticeActions, useNoticeWaiting } from "../ui/PermissionPrompt";
import { pendingForNotice, usePermissionPrompts } from "../state/permissionPrompts";
import { requestDesktopAlerts } from "../desktopNotifications";
import { Select } from "../ui/Select";
import { ScrollMore } from "../ui/ScrollMore";
import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import { useNotifications, NOTIFICATION_EVENTS, NOTIFICATION_EVENT_CATEGORIES, type NotificationEvent, type Notice, type NotificationCategory } from "../state/notifications";
import { useStore } from "../state/store";
import { DEFAULT_WORKSPACE_ID, wsKeyOf } from "../workspaces";
import { Dropdown } from "../ui/Dropdown";
import { openTileChangesView } from "../tileGit";

export function openNotice(item: Notice) {
  const notifications = useNotifications.getState();
  notifications.read(item.id);
  if (item.target?.tileId) notifications.readTile(item.target.tileId);
  if (item.target?.section) window.dispatchEvent(new CustomEvent("pzza-notification-section", { detail: item.target.section }));
  if (item.target?.tileId) {
    const state = useStore.getState();
    const tile = state.tiles.find(entry => entry.id === item.target?.tileId);
    if (!tile) return;
    const key = wsKeyOf(tile);
    state.setWorkspace(state.sessionWs[key] ?? DEFAULT_WORKSPACE_ID);
    state.unhideTile(tile.id); state.setActive(tile.id);
    window.dispatchEvent(new Event("pzza-notification-terminal"));
  }
}
// A notice's follow-up: opens its tile like the notice itself, then the
// tile's Changes view on the folder the notice was about.
export function runNoticeAction(item: Notice) {
  if (item.action?.kind !== "review-changes" || !item.target?.tileId) return;
  openNotice(item);
  openTileChangesView(item.target.tileId, item.action.folder);
}

// One notice. Its text is three lines in the panel, where a click opens it in
// Settings; there it is six lines with Show more when there is more (measured,
// so short notices never offer it). The arrow opens the related terminal or
// page in both.
function NoticeRow({ item, readOnly, openDetails }: { item: Notice; readOnly: boolean; openDetails?: () => void }) {
  const remove = useNotifications(state => state.remove);
  const body = useRef<HTMLSpanElement>(null);
  const [expanded, setExpanded] = useState(false);
  const [overflows, setOverflows] = useState(false);
  const waiting = useNoticeWaiting(item);
  useLayoutEffect(() => {
    const element = body.current;
    if (!element || !readOnly) return;
    const measure = () => setOverflows(element.scrollHeight > element.clientHeight + 1);
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [readOnly, item.body, waiting]);
  const review = item.action?.kind === "review-changes" && !!item.target?.tileId;
  const related = !!(item.target?.section || item.target?.tileId);
  const actions = 1 + (review ? 1 : 0) + (related ? 1 : 0);
  const permission = item.action?.kind === "permission";
  return <article className={`notification-row ${item.read ? "" : "unread"} ${permission ? "notification-row-permission" : ""}`} style={{ "--notification-actions": actions } as CSSProperties}>
    <button className="notification-content" onClick={() => { useNotifications.getState().read(item.id); if (!readOnly) openDetails?.(); }}>
      <span className="notification-title"><strong>{item.source ? <><span className="notification-source">{item.source}</span> - </> : null}{item.title}</strong>{!item.read ? <span className="notification-new">New</span> : null}</span>
      {waiting ? null : <span ref={body} className={`notification-body ${expanded ? "" : readOnly ? "is-clamped-long" : "is-clamped"}`}>{expanded ? item.body.trim() : item.body.trim().replace(/\s*\n\s*/g, " ")}</span>}
      <small>{item.category} · <time dateTime={new Date(item.createdAt).toISOString()}>{new Date(item.createdAt).toLocaleString()}</time></small>
    </button>
    {readOnly && !waiting && (overflows || expanded) ? <button type="button" className="notification-more" aria-expanded={expanded} onClick={() => setExpanded(!expanded)}>{expanded ? "Show less" : "Show more"}</button> : null}
    <div className="notification-row-actions">
      {review ? <button type="button" className="icon-btn notification-action" aria-label="Review changes" title="Review changes" onClick={() => runNoticeAction(item)}><FileDiff size={15} /></button> : null}
      {related ? <button type="button" className="icon-btn notification-open" aria-label={`Open target for ${item.title}`} title="Open related activity" onClick={() => openNotice(item)}><ArrowUpRight size={15} /></button> : null}
      <button type="button" className="dismiss-btn notification-dismiss" aria-label={`Dismiss ${item.title}`} onClick={() => remove(item.id)}><X size={16} /></button>
    </div>
    {permission ? <PermissionNoticeActions notice={item} /> : null}
  </article>;
}

function Rows({ items, readOnly = false, openDetails }: { items: Notice[]; readOnly?: boolean; openDetails?: () => void }) {
  return <div className="notification-list">{items.length
    ? items.map(item => <NoticeRow key={item.id} item={item} readOnly={readOnly} openDetails={openDetails} />)
    : <p className="set-note">You’re all caught up. New activity will appear here.</p>}</div>;
}

export function LatestNotifications({ viewAll }: { viewAll(): void }) {
  const items = useNotifications(state => state.items);
  const pending = usePermissionPrompts(state => state.pending);
  // Prompts still waiting stay on top, however much activity came after them.
  const waiting = items.filter(item => item.action?.kind === "permission" && pendingForNotice({ pending }, item.target?.tileId, item.action.promptId));
  const shown = [...waiting, ...items.filter(item => !waiting.includes(item))].slice(0, Math.max(5, waiting.length));
  return <div className="menu-body latest-notifications"><div className="notification-actions menu-head"><span className="menu-head-title">Notifications</span>
    {waiting.length ? <span className="perm-waiting-count" role="status"><ShieldQuestion size={12} aria-hidden="true" />{waiting.length} waiting for approval</span> : null}
    <button className="btn btn-sm" onClick={() => useNotifications.getState().read()}>Mark all read</button></div>
    <Rows items={shown} openDetails={viewAll} /><button className="btn" onClick={viewAll}>View all notifications</button></div>;
}
// Compact count for badges: exact up to nine, then "9+" so the chip keeps its width.
export function countLabel(count: number): string {
  return count > 9 ? "9+" : String(count);
}
// Top bar trigger for the notifications panel: the bell plus the unread count,
// so pending activity is readable without opening the panel.
export function NotificationsTool({ viewAll }: { viewAll(): void }) {
  const unread = useNotifications(state => state.items.filter(item => !item.read).length);
  return <Dropdown icon={Bell} title="Notifications" controlId="notifications" width={380} panelClassName="notifications-panel" tourId="notifications"
    badgeLabel={unread ? `Notifications: ${unread} unread` : undefined}
    cornerBadge={unread ? countLabel(unread) : null}>
    {(close) => <LatestNotifications viewAll={() => { close(); viewAll(); }} />}
  </Dropdown>;
}
function NotificationToggle({ label, hint, checked, onChange, disabled = false }: { label: string; hint?: string; checked: boolean; onChange: (checked: boolean) => void; disabled?: boolean }) {
  return <div className="settings-row">
    <div className="settings-row-copy"><span>{label}</span>{hint ? <small>{hint}</small> : null}</div>
    <button type="button" className={`switch ${checked ? "switch-on" : ""}`} role="switch" aria-label={label} aria-checked={checked} disabled={disabled} onClick={() => onChange(!checked)}><span className="switch-knob" /></button>
  </div>;
}

const categoryLabels: Record<NotificationCategory, string> = { sync: "Sync", terminal: "Terminals", app: "App activity" };

export function NotificationsSettings({ page }: { page: "activity" | "preferences" }) {
  const { items, preferences, configure, read } = useNotifications();
  const [unreadOnly, setUnreadOnly] = useState(false);
  const [category, setCategory] = useState<NotificationCategory | "all">("all");
  const [limit, setLimit] = useState(15);
  const [eventsExpanded, setEventsExpanded] = useState(false);
  const viewRef = useRef({ page, unreadOnly, category, limit, eventsExpanded });
  viewRef.current = { page, unreadOnly, category, limit, eventsExpanded };
  useEffect(() => {
    const snapshot = () => ({ ...viewRef.current });
    const cleanups = [registerAppControlState("notificationView", snapshot), registerAppControlHandler("get_notification_view", snapshot),
      registerAppControlHandler("set_notification_view", args => {
        const current = viewRef.current;
        if (args.eventsExpanded !== undefined && current.page !== "preferences") throw new Error("Open notification preferences to expand individual events.");
        if ((args.unreadOnly !== undefined || args.category !== undefined || args.limit !== undefined) && current.page !== "activity") throw new Error("Open notification activity to set history filters.");
        if (typeof args.unreadOnly === "boolean") setUnreadOnly(args.unreadOnly);
        if (typeof args.category === "string") setCategory(args.category as NotificationCategory | "all");
        if (args.unreadOnly !== undefined || args.category !== undefined) setLimit(15);
        if (typeof args.limit === "number") setLimit(args.limit);
        if (typeof args.eventsExpanded === "boolean") setEventsExpanded(args.eventsExpanded);
        return { configured: true };
      })];
    return () => cleanups.forEach(cleanup => cleanup());
  }, []);
  const [permissionError, setPermissionError] = useState("");
  const [permissionPending, setPermissionPending] = useState(false);
  const permissionRequest = useRef(0);
  const [, refreshMute] = useState(0);
  useEffect(() => {
    const remaining = preferences.mutedUntil - Date.now();
    if (remaining <= 0) return;
    const timer = setTimeout(() => refreshMute(value => value + 1), Math.min(remaining + 10, 2_147_483_647));
    return () => clearTimeout(timer);
  }, [preferences.mutedUntil]);
  useEffect(() => () => { permissionRequest.current++; }, []);
  const filtered = items.filter(item => (!unreadOnly || !item.read) && (category === "all" || item.category === category));
  const unread = items.filter(item => !item.read).length;
  const setDesktop = (enabled: boolean) => {
    const request = ++permissionRequest.current;
    if (!enabled) { configure({ desktop: false }); setPermissionError(""); setPermissionPending(false); return; }
    setPermissionPending(true);
    void requestDesktopAlerts().then(granted => {
      if (request !== permissionRequest.current) return;
      configure({ desktop: granted });
      setPermissionError(granted ? "" : "Allow notifications in your browser or system settings first.");
    }).catch(() => { if (request === permissionRequest.current) setPermissionError("System notification permission could not be requested."); }).finally(() => { if (request === permissionRequest.current) setPermissionPending(false); });
  };
  return <div className="settings-page notification-settings">
    {page === "preferences" ? <>
      <section className="settings-section" aria-label="Delivery">
        <NotificationToggle label="Enable notifications" hint="Keep a history of activity on this device." checked={preferences.enabled} onChange={enabled => configure({ enabled })} />
        <NotificationToggle label="System alerts" hint="Notify you while the app is unfocused. Activity details stay private." checked={preferences.desktop} disabled={permissionPending} onChange={setDesktop} />
        {permissionError ? <p className="settings-feedback" role="alert">{permissionError}</p> : null}
        <div className="settings-row"><div className="settings-row-copy"><span>Pause alerts</span><small>Activity continues to appear in your history.</small></div><button className="btn btn-sm" onClick={() => configure({ mutedUntil: preferences.mutedUntil > Date.now() ? 0 : Date.now() + 3600000 })}>{preferences.mutedUntil > Date.now() ? "Resume alerts" : "Pause for 1 hour"}</button></div>
      </section>
      <section className="settings-section" aria-label="Activity categories">
        <h3 className="set-title">Include in activity</h3>
        {(Object.keys(categoryLabels) as NotificationCategory[]).map(key => <NotificationToggle key={key} label={categoryLabels[key]} checked={preferences.categories[key]} onChange={checked => configure({ categories: { ...preferences.categories, [key]: checked } })} />)}
        <details className="settings-disclosure notification-events" open={eventsExpanded} onToggle={event => setEventsExpanded(event.currentTarget.open)}><summary>Individual events</summary><div className="notification-event-groups settings-disclosure-body">
          {(Object.keys(categoryLabels) as NotificationCategory[]).map(category => <fieldset className="notification-event-group" key={category}>
            <legend>{categoryLabels[category]}{!preferences.categories[category] ? <span>Category disabled</span> : null}</legend>
            {(Object.entries(NOTIFICATION_EVENTS) as [NotificationEvent, string][]).filter(([event]) => NOTIFICATION_EVENT_CATEGORIES[event] === category).map(([event, label]) => <NotificationToggle key={event} label={label} checked={preferences.events[event] !== false} disabled={!preferences.categories[category]} onChange={checked => configure({ events: { ...preferences.events, [event]: checked } })} />)}
          </fieldset>)}
        </div></details>
        <p className="set-note">History stays on this device for 30 days, up to 300 entries. Terminal events come from a bell or notification signal, an approval prompt, an agent going quiet in a hidden tile, or a process exit.</p>
      </section>
    </> : <section className="settings-section notification-history" aria-label="History">
      <div className="notification-filterbar">
        <div className="settings-segment" role="group" aria-label="Notification status">
          <button type="button" aria-pressed={!unreadOnly} onClick={() => { setUnreadOnly(false); setLimit(15); }}>All activity</button>
          <button type="button" aria-pressed={unreadOnly} onClick={() => { setUnreadOnly(true); setLimit(15); }}>Unread <span>{unread}</span></button>
        </div>
        <div className="notification-category" role="group" aria-label="Notification category"><Select value={category} options={[{ value: "all", label: "All categories" }, ...Object.entries(categoryLabels).map(([value, label]) => ({ value, label }))]} onChange={value => { if (value === "all" || value in categoryLabels) { setCategory(value as NotificationCategory | "all"); setLimit(15); } }} /></div>
      </div>
      <div className="notification-history-actions"><span>{filtered.length} {filtered.length === 1 ? "notification" : "notifications"}</span><div><button className="btn btn-sm" disabled={!unread} onClick={() => read()}>Mark all read</button><button className="btn btn-sm" disabled={!items.length} onClick={() => useNotifications.getState().clear()}>Clear history</button></div></div>
      {filtered.length ? <Rows items={filtered.slice(0, limit)} readOnly /> : <div className="settings-empty"><Bell size={22} /><strong>{unreadOnly ? "No unread activity" : "No activity here yet"}</strong><p>{category === "all" ? "New notifications will appear here." : "Try another category to see more activity."}</p></div>}
      <ScrollMore hasMore={limit < filtered.length} loadMore={() => setLimit(value => value + 15)} />
    </section>}
  </div>;
}
