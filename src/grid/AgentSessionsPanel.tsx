import { useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from "react";
import {
  ChevronDown, Copy, Folder, GitBranch, Hash, Info, Loader2, MessagesSquare, Plus, RefreshCw, Search, TriangleAlert, UserRound,
} from "lucide-react";
import { fetchAgentSessions, fetchWorktreeInfo } from "../serverApi";
import { deviceForHost, deviceHost, deviceNameFor } from "../devices";
import { useStore } from "../state/store";
import { useSessionCreation } from "../sessionActions";
import {
  agentLabelOf, agentSessionCommand, agentSessionsErrorKind, agentSessionsTile, loadAgentSessionsFilters, newTileBlocker, rememberedAgentMode,
  resumeBlocker, resumeFolder, resumeInNewTile, saveAgentSessionsFilters, timeFilterSince,
  type AgentSessionsErrorKind, type AgentSessionsFilters, type AgentSessionsScope, type AgentSessionsTime, type AgentSessionsView,
} from "../state/agentSessions";
import { AgentIcon } from "../icons/AgentIcon";
import { iconColor } from "../sessionMeta";
import { Modal } from "../ui/Modal";
import { ScrollMore } from "../ui/ScrollMore";
import { IconButton } from "../ui/IconButton";
import { copyToClipboard } from "../terminal/Terminal";
import { compactPath } from "./compactPath";
import type { AgentSessionRow } from "../../server/lib/agent-sessions.js";

// Past coding-agent conversations on the tile's device (or every device),
// newest first. Filters narrow the list on the device itself (folder, time,
// agent, search), so even hundreds of conversations are a few keystrokes
// away; the list renders at most a window of them, grouped by folder or as a
// timeline. The selected one resumes in a new PzzaCode session (Enter) or in this tile
// (Cmd/Ctrl+Enter), with the reason shown whenever one of the two is not
// possible.

const PAGE = 50;
/** At most this many rows are loaded (and so rendered) at once, across devices. */
const WINDOW = 150;
const SEARCH_DELAY_MS = 220;
const PARTIAL_RETRY_MS = 1500;
const GROUP_PREVIEW = 3;
const SKELETON_ROWS = 7;

// ------------------------------------------------------------------ format

function ago(time: number, now: number): string {
  const seconds = Math.max(0, Math.round((now - time) / 1000));
  if (seconds < 45) return "just now";
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.round(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  const date = new Date(time);
  return date.toLocaleDateString(undefined, { day: "numeric", month: "short", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

function dayLabel(time: number, now: number): string {
  const day = new Date(time).toDateString();
  if (day === new Date(now).toDateString()) return "Today";
  if (day === new Date(now - 86400000).toDateString()) return "Yesterday";
  const date = new Date(time);
  return date.toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short", ...(date.getFullYear() !== new Date(now).getFullYear() ? { year: "numeric" } : {}) });
}

const exact = (time: number) => new Date(time).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(bytes < 10 * 1024 * 1024 ? 1 : 0)} MB`;
}

const plural = (count: number, one: string, many = `${one}s`) => `${count.toLocaleString()} ${count === 1 ? one : many}`;
const folderName = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

// ------------------------------------------------------------------- lists

interface Source { host: string; name: string }

interface DeviceList {
  status: "loading" | "ready" | "error";
  rows: AgentSessionRow[];
  total: number;
  agents: Record<string, number>;
  partial: boolean;
  /** Offset of the first loaded row (moves on with "Show older"). */
  base: number;
  loadingMore: boolean;
  error?: { kind: AgentSessionsErrorKind; message: string };
}

const EMPTY_LIST: DeviceList = { status: "loading", rows: [], total: 0, agents: {}, partial: false, base: 0, loadingMore: false };

interface ListQuery { cwd?: string; under: boolean; since?: number; agent?: string; q?: string }

interface ListOps { more(): void; window(direction: "older" | "newest"): void; retry(host: string): void }

const rowKey = (host: string, row: AgentSessionRow) => `${host}\u0000${row.agent}\u0000${row.id}`;

function mergeRows(current: readonly AgentSessionRow[], next: readonly AgentSessionRow[]): AgentSessionRow[] {
  const seen = new Set(current.map((row) => `${row.agent}\u0000${row.id}`));
  return [...current, ...next.filter((row) => !seen.has(`${row.agent}\u0000${row.id}`))];
}

// One list per device for the current filters: the first page on every
// change, partial (still scanning) pages again until the scan is done, more
// pages on demand up to the window, and the window moved on for older ones.
function useAgentSessionLists(sources: readonly Source[], query: ListQuery, refresh: number) {
  const [lists, setLists] = useState<Record<string, DeviceList>>({});
  const live = useRef(lists);
  live.current = lists;
  const ops = useRef<ListOps>({ more: () => {}, window: () => {}, retry: () => {} });
  // Callers get stable functions that always reach the current filters' requests.
  const stableOps = useMemo<ListOps>(() => ({
    more: () => ops.current.more(), window: (direction) => ops.current.window(direction), retry: (host) => ops.current.retry(host),
  }), []);
  const scannedFor = useRef(refresh);
  const hosts = useMemo(() => sources.map((source) => source.host), [sources]);
  const hostsKey = hosts.join("\n");
  // The window is shared between devices; each asks for pages of at most its share.
  const cap = Math.max(20, Math.floor(WINDOW / Math.max(1, hosts.length)));
  const page = Math.min(PAGE, cap);

  useEffect(() => {
    const controller = new AbortController();
    const timers = new Set<ReturnType<typeof setTimeout>>();
    // Only the first request after "Scan again" asks the device to rescan.
    const fresh = scannedFor.current !== refresh;
    scannedFor.current = refresh;
    const update = (host: string, change: (list: DeviceList) => DeviceList) => setLists((current) => ({ ...current, [host]: change(current[host] ?? EMPTY_LIST) }));
    const request = (host: string, base: number, limit: number, append: boolean, rescan: boolean) => {
      if (append) update(host, (list) => ({ ...list, loadingMore: true }));
      fetchAgentSessions(host, { ...query, offset: base, limit, fresh: rescan }, controller.signal).then((result) => {
        if (controller.signal.aborted) return;
        update(host, (list) => ({
          status: "ready", rows: append ? mergeRows(list.rows, result.sessions) : result.sessions,
          total: result.total, agents: result.agents, partial: result.partial, base, loadingMore: false,
        }));
        // A cold scan is still running: ask again for everything loaded so far.
        if (result.partial) {
          const timer = setTimeout(() => {
            timers.delete(timer);
            const list = live.current[host];
            request(host, list?.base ?? base, Math.min(300, Math.max(page, list?.rows.length ?? 0)), false, false);
          }, PARTIAL_RETRY_MS);
          timers.add(timer);
        }
      }, (error: unknown) => {
        if (controller.signal.aborted) return;
        const message = error instanceof Error ? error.message : "Agent sessions are unavailable.";
        update(host, (list) => (append ? { ...list, loadingMore: false } : { ...EMPTY_LIST, status: "error", error: { kind: agentSessionsErrorKind(error), message } }));
      });
    };
    ops.current = {
      more: () => {
        for (const host of hosts) {
          const list = live.current[host];
          if (list?.status === "ready" && !list.loadingMore && list.rows.length < cap && list.base + list.rows.length < list.total) request(host, list.base + list.rows.length, Math.min(page, cap - list.rows.length), true, false);
        }
      },
      window: (direction) => {
        for (const host of hosts) {
          const list = live.current[host];
          if (!list || list.status !== "ready") continue;
          const base = direction === "newest" ? 0 : list.base + list.rows.length;
          if (direction === "older" && base >= list.total) continue;
          update(host, (current) => ({ ...current, status: "loading", rows: [], base }));
          request(host, base, page, false, false);
        }
      },
      retry: (host) => { update(host, () => EMPTY_LIST); request(host, 0, page, false, false); },
    };
    // Rows of the previous filters stay (dimmed) until the new ones arrive.
    setLists((current) => Object.fromEntries(hosts.map((host) => [host, { ...(current[host] ?? EMPTY_LIST), status: "loading" as const, error: undefined, loadingMore: false }])));
    for (const host of hosts) request(host, 0, page, false, fresh);
    return () => { controller.abort(); timers.forEach(clearTimeout); };
    // hostsKey stands for hosts, so a device list update that keeps the same hosts does not reload; refresh asks again.
  }, [hostsKey, query, refresh, cap, page]);

  return { lists, ops: stableOps, cap };
}

// ----------------------------------------------------------------- display

interface Item { key: string; host: string; row: AgentSessionRow }

type Block =
  | { kind: "group"; key: string; folder: string; host: string; items: Item[]; shown: Item[] }
  | { kind: "day"; key: string; label: string; items: Item[]; shown: Item[] };

function buildBlocks(items: readonly Item[], view: AgentSessionsView, expanded: ReadonlySet<string>, now: number, multiDevice: boolean): Block[] {
  if (view === "timeline") {
    const days: Block[] = [];
    for (const item of items) {
      const label = dayLabel(item.row.lastAt, now);
      const last = days[days.length - 1];
      if (last?.kind === "day" && last.label === label) { last.items.push(item); last.shown.push(item); } else days.push({ kind: "day", key: `day:${label}`, label, items: [item], shown: [item] });
    }
    return days;
  }
  // Newest-first rows make the groups come out by their latest activity.
  const groups = new Map<string, Extract<Block, { kind: "group" }>>();
  for (const item of items) {
    const key = `${multiDevice ? item.host : ""}\u0000${item.row.cwd}`;
    const group = groups.get(key) ?? { kind: "group" as const, key, folder: item.row.cwd, host: item.host, items: [], shown: [] };
    group.items.push(item);
    groups.set(key, group);
  }
  const all = [...groups.values()];
  for (const group of all) group.shown = all.length === 1 || expanded.has(group.key) ? group.items : group.items.slice(0, GROUP_PREVIEW);
  return all;
}

// ------------------------------------------------------------------- panel

type Banner = { tone: "ok" | "error"; text: string };

export function AgentSessionsPanel({ tileId, onClose }: { tileId: string | null; onClose(): void }) {
  const tiles = useStore((state) => state.tiles);
  const activeDevices = useStore((state) => state.activeDevices);
  const devices = useStore((state) => state.devices);
  const connectionHost = useStore((state) => state.connection.host);
  // The tile is read once per change of the tile list: its folder and device scope the list.
  const origin = useMemo(() => agentSessionsTile(tileId), [tileId, tiles]);
  const originHost = origin?.host ?? connectionHost ?? "";
  const folder = origin?.folder;

  // ---- filters
  const [filters, setFilters] = useState<AgentSessionsFilters>(loadAgentSessionsFilters);
  const change = (next: Partial<AgentSessionsFilters>) => setFilters((current) => { const updated = { ...current, ...next }; saveAgentSessionsFilters(updated); return updated; });
  const scope: AgentSessionsScope = folder ? filters.scope : "everywhere";
  const [text, setText] = useState("");
  const [search, setSearch] = useState("");
  useEffect(() => { const timer = setTimeout(() => setSearch(text.trim()), SEARCH_DELAY_MS); return () => clearTimeout(timer); }, [text]);
  const [agent, setAgent] = useState<string | null>(null);
  const [deviceChoice, setDeviceChoice] = useState<string>(() => deviceForHost(useStore.getState().activeDevices, originHost)?.id ?? "");
  const [refresh, setRefresh] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 30000); return () => clearInterval(timer); }, []);

  // "This repo": the repository's main checkout and below. A linked worktree
  // lives beside it, so there the tile's own folder is used instead.
  const [repoRoot, setRepoRoot] = useState<string | undefined>(undefined);
  useEffect(() => {
    if (!folder) return;
    const controller = new AbortController();
    fetchWorktreeInfo(originHost, folder, controller.signal)
      .then((info) => { if (!controller.signal.aborted && !info.linked && info.main?.startsWith("/")) setRepoRoot(info.main); })
      .catch(() => { /* Not a repository: the folder itself. */ });
    return () => controller.abort();
  }, [originHost, folder]);
  const repo = repoRoot ?? folder;

  const sources = useMemo<Source[]>(() => {
    if (deviceChoice === "all") return activeDevices.map((device) => ({ host: deviceHost(device), name: device.name }));
    const device = activeDevices.find((item) => item.id === deviceChoice);
    const host = device ? deviceHost(device) : originHost;
    return [{ host, name: device?.name ?? deviceNameFor(devices, host || undefined) }];
  }, [deviceChoice, activeDevices, devices, originHost]);
  const multiDevice = sources.length > 1;

  const since = useMemo(() => timeFilterSince(filters.time), [filters.time, refresh]);
  const query = useMemo<ListQuery>(() => ({
    cwd: scope === "folder" ? folder : scope === "repo" ? repo : undefined,
    under: scope === "repo",
    since,
    agent: agent ?? undefined,
    q: search || undefined,
  }), [scope, folder, repo, since, agent, search]);
  const { lists, ops, cap } = useAgentSessionLists(sources, query, refresh);

  // ---- merged rows
  const listed = useMemo(() => sources.map((source) => ({ source, list: lists[source.host] ?? EMPTY_LIST })), [sources, lists]);
  const items = useMemo(() => listed.flatMap(({ source, list }) => list.rows.map((row) => ({ key: rowKey(source.host, row), host: source.host, row })))
    .sort((left, right) => right.row.lastAt - left.row.lastAt), [listed]);
  const rowsByHost = useMemo(() => new Map(listed.map(({ source, list }) => [source.host, list.rows])), [listed]);
  const loading = listed.some(({ list }) => list.status === "loading");
  const settled = listed.every(({ list }) => list.status !== "loading");
  const firstLoad = loading && !items.length;
  const partial = listed.some(({ list }) => list.status === "ready" && list.partial);
  const errors = listed.filter(({ list }) => list.status === "error");
  const total = listed.reduce((sum, { list }) => sum + (list.status === "ready" ? list.total : 0), 0);
  const base = listed.reduce((sum, { list }) => sum + list.base, 0);
  const canLoadMore = listed.some(({ list }) => list.status === "ready" && list.rows.length < cap && list.base + list.rows.length < list.total);
  const atWindow = !canLoadMore && listed.some(({ list }) => list.status === "ready" && list.base + list.rows.length < list.total);
  const loadingMore = listed.some(({ list }) => list.loadingMore);

  // Agent facets: matches per agent under every other filter. The last
  // settled counts stay while new ones load, so the chips never jump.
  const [facets, setFacets] = useState<[string, number][]>([]);
  useEffect(() => {
    if (!settled) return;
    const sums = new Map<string, number>();
    for (const { list } of listed) for (const [id, count] of Object.entries(list.agents)) sums.set(id, (sums.get(id) ?? 0) + count);
    setFacets([...sums.entries()].filter(([, count]) => count > 0).sort((left, right) => right[1] - left[1]));
  }, [settled, listed]);
  const facetTotal = facets.reduce((sum, [, count]) => sum + count, 0);
  const shownFacets = agent && !facets.some(([id]) => id === agent) ? [...facets, [agent, 0] as [string, number]] : facets;

  // ---- grouping and selection
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const blocks = useMemo(() => buildBlocks(items, filters.view, expanded, now, multiDevice), [items, filters.view, expanded, now, multiDevice]);
  const visible = useMemo(() => blocks.flatMap((block) => block.shown), [blocks]);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selected = visible.find((item) => item.key === selectedKey) ?? visible[0] ?? null;
  const listId = useId();
  const optionId = (index: number) => `${listId}-row-${index}`;
  const selectedIndex = selected ? visible.indexOf(selected) : -1;
  const scrollOnSelect = useRef(false);
  // Keeps a row moved to with the keyboard in view (clicks never scroll).
  useEffect(() => {
    if (!scrollOnSelect.current || selectedIndex < 0) return;
    scrollOnSelect.current = false;
    document.getElementById(`${listId}-row-${selectedIndex}`)?.scrollIntoView({ block: "nearest" });
  }, [listId, selectedIndex]);

  // ---- actions
  // A conversation resumes in the mode last picked for its agent.
  const modeOf = rememberedAgentMode;
  const creating = useSessionCreation((state) => state.operation?.status === "running");
  const [busy, setBusy] = useState(false);
  const [banner, setBanner] = useState<Banner | null>(null);
  useEffect(() => {
    if (banner?.tone !== "ok") return;
    const timer = setTimeout(() => setBanner(null), 2600);
    return () => clearTimeout(timer);
  }, [banner]);

  const reasons = (item: Item) => {
    const loaded = rowsByHost.get(item.host) ?? [];
    return {
      common: resumeBlocker(item.row, loaded),
      newTile: newTileBlocker(item.row, item.host, loaded, creating),
    };
  };

  // A conversation always resumes in a new PzzaCode session in its own folder:
  // the list belongs to the whole app, not to the tile it was opened from.
  const resume = async (item: Item | null = selected) => {
    if (!item || busy) return;
    const blocked = reasons(item).newTile;
    if (blocked) { setBanner({ tone: "error", text: blocked }); return; }
    setBusy(true);
    setBanner(null);
    const loaded = rowsByHost.get(item.host) ?? [];
    try {
      await resumeInNewTile({ host: item.host, row: item.row, mode: modeOf(item.row.agent), loaded, anchorTileId: tileId });
      onClose();
    } catch (error) {
      setBanner({ tone: "error", text: error instanceof Error ? error.message : "Could not resume the conversation." });
    } finally {
      setBusy(false);
    }
  };

  const copy = async (what: "command" | "id", item: Item | null = selected) => {
    if (!item) return;
    let value = item.row.id;
    if (what === "command") {
      try {
        value = agentSessionCommand(item.row, modeOf(item.row.agent), resumeFolder(item.row) || undefined);
      } catch (error) {
        setBanner({ tone: "error", text: error instanceof Error ? error.message : "This conversation cannot be resumed from a command line." });
        return;
      }
    }
    const done = await copyToClipboard(value);
    setBanner(done ? { tone: "ok", text: what === "command" ? "Copied the resume command." : "Copied the session ID." } : { tone: "error", text: "Could not copy to the clipboard." });
  };

  // ---- keyboard: the search field keeps focus while arrows move the selection.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const target = event.target instanceof HTMLElement ? event.target : null;
    if (target?.closest(".cselect")) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      if (!visible.length) return;
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      const next = visible[Math.min(visible.length - 1, Math.max(0, selectedIndex + step))];
      scrollOnSelect.current = true;
      setSelectedKey(next.key);
    } else if (event.key === "Enter" && !event.shiftKey && !event.altKey && !event.nativeEvent.isComposing) {
      // A focused button answers Enter itself.
      if (target?.closest("button, a, [role=button]")) return;
      event.preventDefault();
      void resume();
    }
  };

  const searchRef = useRef<HTMLInputElement>(null);
  const selectedReasons = selected ? reasons(selected) : null;
  const scopeLabel = scope === "folder" && folder ? `in ${compactPath(folder)}` : scope === "repo" && repo ? `in ${compactPath(repo)} and below` : "everywhere";
  const deviceLabel = multiDevice ? `on ${plural(sources.length, "device")}` : `on ${sources[0]?.name ?? "this device"}`;
  const filtered = Boolean(search || agent || filters.time !== "all" || scope !== "everywhere");

  return <Modal open onClose={onClose} title="Agent sessions" icon={MessagesSquare} size="xl" className="as-modal" pending={busy} initialFocusRef={searchRef}>
    <div className="as" onKeyDown={onKeyDown}>
      <div className="as-bar">
        <label className="as-search">
          <Search size={14} aria-hidden="true" />
          <input
            ref={searchRef} type="search" value={text} onChange={(event) => setText(event.target.value)}
            // Escape clears the search first; the dialog closes on the next one.
            onKeyDown={(event) => { if (event.key === "Escape" && text) { event.preventDefault(); setText(""); } }}
            placeholder="Search titles, folders, branches or an ID"
            role="combobox" aria-label="Search agent sessions" aria-expanded="true" aria-controls={listId} aria-autocomplete="list"
            aria-activedescendant={selectedIndex >= 0 ? optionId(selectedIndex) : undefined}
            autoComplete="off" spellCheck={false}
          />
          {text !== search.trim() || (loading && !firstLoad) ? <Loader2 size={13} className="sw-spin as-search-busy" aria-hidden="true" /> : null}
        </label>
        <Toggle label="Where" value={scope} onChange={(value) => change({ scope: value })} options={[
          { value: "folder", label: "This folder", disabled: !folder, title: folder ? `Conversations that ran in ${folder}` : "This tile's folder is not known" },
          { value: "repo", label: "This repo", disabled: !folder, title: repo ? `Conversations in ${repo} and the folders below it` : "This tile's folder is not known" },
          { value: "everywhere", label: "Everywhere", title: "Conversations in every folder" },
        ]} />
      </div>
      <div className="as-bar as-bar-filters">
        <Toggle label="Last active" value={filters.time} onChange={(value: AgentSessionsTime) => change({ time: value })} options={[
          { value: "today", label: "Today" }, { value: "week", label: "7 days" }, { value: "month", label: "30 days" }, { value: "all", label: "All time" },
        ]} />
        {activeDevices.length > 1 ? <Toggle label="Device" value={deviceChoice} onChange={setDeviceChoice} options={[
          ...activeDevices.map((device) => ({ value: device.id, label: device.name })), { value: "all", label: "All devices" },
        ]} /> : null}
        <span className="as-spacer" />
        <Toggle label="Arrange" value={filters.view} onChange={(value: AgentSessionsView) => change({ view: value })} options={[
          { value: "grouped", label: "By folder", title: "Grouped by folder, most recent first" }, { value: "timeline", label: "Timeline", title: "One list, newest first" },
        ]} />
        <IconButton icon={RefreshCw} title="Scan again" size={14} spin={loading && refresh > 0} onClick={() => setRefresh((value) => value + 1)} />
      </div>
      {shownFacets.length ? <div className="as-agents" role="group" aria-label="Agent">
        <button type="button" className={`as-chip ${agent ? "" : "on"}`} aria-pressed={!agent} onClick={() => setAgent(null)}>
          All agents<span className="as-chip-count">{facetTotal.toLocaleString()}</span>
        </button>
        {shownFacets.map(([id, count]) => <button key={id} type="button" className={`as-chip ${agent === id ? "on" : ""}`} aria-pressed={agent === id}
          onClick={() => setAgent(agent === id ? null : id)} title={agent === id ? "Show every agent" : `Only ${agentLabelOf(id)}`}>
          <span className="as-chip-icon" style={{ color: iconColor(id) }}><AgentIcon id={id} size={12} /></span>
          {agentLabelOf(id)}<span className="as-chip-count">{count.toLocaleString()}</span>
        </button>)}
      </div> : null}

      <div className="as-status" aria-live="polite">
        <span>
          {firstLoad ? "Looking for conversations…" : <>
            <strong>{plural(total, "conversation")}</strong> {scopeLabel} {deviceLabel}
            {base > 0 || atWindow ? <span className="as-status-range"> · showing {(base + 1).toLocaleString()}-{(base + items.length).toLocaleString()}</span> : null}
          </>}
        </span>
        {partial ? <span className="as-partial" title="The device is still reading its agents' conversation files. More appear as it goes.">
          <Loader2 size={12} className="sw-spin" aria-hidden="true" />Still scanning
        </span> : null}
      </div>

      <div className={`as-list${loading && !firstLoad ? " is-stale" : ""}`} id={listId} role="listbox" aria-label="Agent conversations" aria-busy={loading || undefined}>
        {errors.map(({ source, list }) => <DeviceError key={source.host} name={source.name} kind={list.error?.kind ?? "failed"} message={list.error?.message ?? ""} onRetry={() => ops.retry(source.host)} />)}
        {firstLoad ? <Skeleton /> : null}
        {!firstLoad && !items.length && !errors.length ? <Empty
          search={search} scope={scope} time={filters.time} agent={agent} folder={folder}
          onScope={(value) => change({ scope: value })} onTime={() => change({ time: "all" })} onAgent={() => setAgent(null)} onSearch={() => { setText(""); setSearch(""); searchRef.current?.focus(); }}
          filtered={filtered}
        /> : null}
        {blocks.map((block) => <section key={block.key} className={`as-block as-block-${block.kind}`} role="group"
          aria-label={block.kind === "group" ? `${block.folder || "Unknown folder"}, ${plural(block.items.length, "conversation")}` : block.label}>
          {block.kind === "group" ? <GroupHead block={block} now={now} device={multiDevice ? deviceNameFor(devices, block.host || undefined) : undefined} />
            : <div className="as-day" aria-hidden="true">{block.label}</div>}
          {block.shown.map((item) => {
            const index = visible.indexOf(item);
            return <Row
              key={item.key} id={optionId(index)} item={item} now={now} selected={item === selected} showFolder={block.kind === "day"}
              device={item.host ? deviceNameFor(devices, item.host) : undefined} busy={busy}
              reasons={item === selected && selectedReasons ? selectedReasons : reasons(item)}
              onSelect={() => setSelectedKey(item.key)}
              onResume={() => { setSelectedKey(item.key); void resume(item); }}
              onCopy={(what) => { setSelectedKey(item.key); void copy(what, item); }}
            />;
          })}
          {block.kind === "group" && block.items.length > block.shown.length ? <button type="button" className="as-more-rows"
            onClick={() => setExpanded((current) => new Set(current).add(block.key))}>
            <ChevronDown size={12} aria-hidden="true" />{plural(block.items.length - block.shown.length, "more conversation")} in {folderName(block.folder) || "this folder"}
          </button> : null}
        </section>)}
        {!firstLoad && items.length ? <>
          {canLoadMore ? (loadingMore ? <div className="as-loading-more"><Loader2 size={13} className="sw-spin" aria-hidden="true" />Loading more…</div>
            : <ScrollMore hasMore={canLoadMore} loadMore={ops.more} />) : null}
          {atWindow || base > 0 ? <div className="as-window">
            {atWindow ? <span>{`Showing ${items.length.toLocaleString()} of ${total.toLocaleString()} at a time. Search or narrow the filters to reach the one you want faster.`}</span> : null}
            {base > 0 ? <button type="button" className="btn btn-sm" onClick={() => ops.window("newest")}>Back to newest</button> : null}
            {atWindow ? <button type="button" className="btn btn-sm" onClick={() => ops.window("older")}>Show older</button> : null}
          </div> : null}
        </> : null}
      </div>

      <footer className="as-foot">
        <div className="as-foot-info" aria-live="polite">
          {banner ? <span className={`as-banner is-${banner.tone}`} role={banner.tone === "error" ? "alert" : "status"}>
            {banner.tone === "error" ? <TriangleAlert size={13} aria-hidden="true" /> : null}{banner.text}
          </span>
            : selectedReasons?.common ? <span className="as-reason"><Info size={13} aria-hidden="true" />{selectedReasons.common}</span>
              : <span className="as-keys" aria-hidden="true">
                <kbd className="kbd">↑</kbd><kbd className="kbd">↓</kbd> select<span className="as-keys-gap" /><kbd className="kbd">↵</kbd> new PzzaCode session<span className="as-keys-gap" /><kbd className="kbd">esc</kbd> close
              </span>}
        </div>
      </footer>
    </div>
  </Modal>;
}

// ------------------------------------------------------------------- parts

interface ToggleOption<T extends string> { value: T; label: string; title?: string; disabled?: boolean }

// A compact choice of a few options (filters, arrangement), as pressed buttons.
function Toggle<T extends string>({ label, value, options, onChange }: { label: string; value: T; options: readonly ToggleOption<T>[]; onChange(value: T): void }) {
  return <div className="as-seg" role="group" aria-label={label}>
    {options.map((option) => <button key={option.value} type="button" className={option.value === value ? "on" : ""} aria-pressed={option.value === value}
      aria-disabled={option.disabled || undefined} title={option.title}
      onClick={() => { if (!option.disabled) onChange(option.value); }}>
      {option.label}
    </button>)}
  </div>;
}

function GroupHead({ block, now, device }: { block: Extract<Block, { kind: "group" }>; now: number; device?: string }) {
  const latest = block.items[0]?.row.lastAt ?? 0;
  return <div className="as-group-head" aria-hidden="true">
    <Folder size={13} className="as-group-icon" />
    <span className="as-group-name">{block.folder ? folderName(block.folder) : "Unknown folder"}</span>
    {block.folder ? <span className="as-group-path" title={block.folder}>{compactPath(block.folder)}</span> : null}
    {device ? <span className="as-group-device">{device}</span> : null}
    <span className="as-group-count">{block.items.length.toLocaleString()}</span>
    <time className="as-group-time" dateTime={new Date(latest).toISOString()} title={`Last active ${exact(latest)}`}>{ago(latest, now)}</time>
  </div>;
}

function Row({ id, item, now, selected, showFolder, device, busy, reasons, onSelect, onResume, onCopy }: {
  id: string; item: Item; now: number; selected: boolean; showFolder: boolean; device?: string; busy: boolean;
  reasons: { common: string | null; newTile: string | null } | null;
  onSelect(): void; onResume(): void; onCopy(what: "command" | "id"): void;
}) {
  const { row } = item;
  const title = row.title || "Untitled conversation";
  const label = agentLabelOf(row.agent);
  const keepFocus = (event: MouseEvent) => event.preventDefault();
  const stop = (event: MouseEvent, run: () => void) => { event.stopPropagation(); run(); };
  const unavailable = row.resume === "none";
  const meta: ReactNode[] = [];
  if (showFolder && row.cwd) meta.push(<span key="folder" className="as-row-folder" title={row.cwd}><Folder size={10} aria-hidden="true" />{folderName(row.cwd)}</span>);
  if (row.branch) meta.push(<code key="branch" className="as-row-branch" title={`Branch ${row.branch}`}><GitBranch size={10} aria-hidden="true" />{row.branch}</code>);
  if (row.messages) meta.push(<span key="messages">{plural(row.messages, "message")}</span>);
  if (row.bytes) meta.push(<span key="bytes">{size(row.bytes)}</span>);
  if (row.account) meta.push(<span key="account" className="as-badge" title={`Account folder ${row.account}`}><UserRound size={10} aria-hidden="true" />{(row.account.split("/").pop() ?? row.account).replace(/^\./, "")}</span>);
  if (device) meta.push(<span key="device" className="as-badge">{device}</span>);
  if (unavailable) meta.push(<span key="view" className="as-badge as-badge-muted">Cannot resume</span>);
  return <div
    id={id} role="option" aria-selected={selected}
    aria-label={`${title}, ${label}, ${ago(row.lastAt, now)}${row.branch ? `, branch ${row.branch}` : ""}`}
    className={`as-row${selected ? " on" : ""}${unavailable ? " is-unavailable" : ""}`}
    onMouseDown={keepFocus} onClick={onSelect} onDoubleClick={onResume}
  >
    <span className="as-row-agent" style={{ color: iconColor(row.agent) }} title={label}><AgentIcon id={row.agent} size={15} /></span>
    <span className="as-row-main">
      <span className="as-row-title" title={row.title || undefined}>{title}</span>
      <span className="as-row-meta"><span className="as-row-agent-name">{label}</span>{meta}</span>
    </span>
    <time className="as-row-time" dateTime={new Date(row.lastAt).toISOString()} title={`Last active ${exact(row.lastAt)}\nStarted ${exact(row.startedAt)}`}>{ago(row.lastAt, now)}</time>
    <span className="as-row-actions">
      <RowAction icon={Hash} label="Copy session ID" onClick={(event) => stop(event, () => onCopy("id"))} />
      <RowAction icon={Copy} label={row.resume === "last" ? `Copy resume command\nRun it in ${row.cwd}` : "Copy resume command"} reason={reasons?.common ?? null} onClick={(event) => stop(event, () => onCopy("command"))} />
      <RowAction icon={Plus} label="Resume in a new PzzaCode session" text="New PzzaCode session" reason={reasons?.newTile ?? null} busy={busy && selected} onClick={(event) => stop(event, onResume)} />
    </span>
  </div>;
}

function RowAction({ icon: Icon, label, text, reason = null, busy = false, onClick }: {
  icon: typeof Plus; label: string; text?: string; reason?: string | null; busy?: boolean; onClick(event: MouseEvent): void;
}) {
  return <button type="button" tabIndex={-1} className={`as-row-btn${text ? " has-text" : ""}${reason ? " is-blocked" : ""}`}
    aria-disabled={reason ? true : undefined} title={reason ? `${label.split("\n")[0]}\n${reason}` : label} aria-label={label.split("\n")[0]}
    onMouseDown={(event) => event.preventDefault()} onClick={onClick}>
    {busy ? <Loader2 size={12} className="async-spinner" aria-hidden="true" /> : <Icon size={12} aria-hidden="true" />}
    {text ? <span>{text}</span> : null}
  </button>;
}

function DeviceError({ name, kind, message, onRetry }: { name: string; kind: AgentSessionsErrorKind; message: string; onRetry(): void }) {
  const text = kind === "outdated" ? "Its agent is too old to list conversations. Update the agent on this device, then try again."
    : kind === "unreachable" ? "Could not reach this device's agent. Check that the device is on and connected."
      : message ? `Its conversations could not be read (${message}).` : "Its conversations could not be read.";
  return <div className="as-device-error" role="alert">
    <TriangleAlert size={14} aria-hidden="true" />
    <span><strong>{name}</strong>{text}</span>
    <button type="button" className="btn btn-sm" onClick={onRetry}>Try again</button>
  </div>;
}

function Skeleton() {
  return <div className="as-skeleton" aria-hidden="true">
    <div className="as-skel-head" />
    {Array.from({ length: SKELETON_ROWS }, (_, index) => <div key={index} className="as-skel-row" style={{ animationDelay: `${index * 70}ms` }}>
      <span className="as-skel-icon" /><span className="as-skel-lines"><span style={{ width: `${68 - (index % 3) * 14}%` }} /><span /></span><span className="as-skel-time" />
    </div>)}
  </div>;
}

function Empty({ search, scope, time, agent, folder, filtered, onScope, onTime, onAgent, onSearch }: {
  search: string; scope: AgentSessionsScope; time: AgentSessionsTime; agent: string | null; folder?: string; filtered: boolean;
  onScope(scope: AgentSessionsScope): void; onTime(): void; onAgent(): void; onSearch(): void;
}) {
  const where = scope === "folder" && folder ? ` in ${folderName(folder)}` : scope === "repo" ? " in this repository" : "";
  const heading = search ? `Nothing matches "${search}"${where}` : filtered ? `No conversations${where} for these filters` : "No agent conversations yet";
  const text = filtered ? "Widen the search to find it:" : "Conversations of Claude Code, Codex and the other agents on this device show up here once they have run.";
  return <div className="as-empty">
    <span className="as-empty-icon" aria-hidden="true"><MessagesSquare size={20} /></span>
    <strong>{heading}</strong>
    <p>{text}</p>
    {filtered ? <div className="as-empty-actions">
      {scope === "folder" ? <button type="button" className="btn btn-sm" onClick={() => onScope("repo")}>Search this repo</button> : null}
      {scope !== "everywhere" ? <button type="button" className="btn btn-sm" onClick={() => onScope("everywhere")}>Search everywhere</button> : null}
      {time !== "all" ? <button type="button" className="btn btn-sm" onClick={onTime}>Any time</button> : null}
      {agent ? <button type="button" className="btn btn-sm" onClick={onAgent}>All agents</button> : null}
      {search ? <button type="button" className="btn btn-sm" onClick={onSearch}>Clear search</button> : null}
    </div> : null}
  </div>;
}

