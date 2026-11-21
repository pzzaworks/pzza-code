import { DeviceIcon } from "../ui/DeviceIcon";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { CircleStop, Cpu, Eye, EyeOff, ExternalLink, Globe, LoaderCircle, Search, Server, Settings, SquareTerminal } from "lucide-react";
import { create } from "zustand";
import { AsyncButton } from "../ui/AsyncButton";
import { useDelayedLoading } from "../ui/useDelayedLoading";
import { confirmAction } from "../ui/ConfirmDialog";
import { useStore } from "../state/store";
import { THIS_MAC, deviceHost, hasRemoteDevice, type Device } from "../devices";
import { Select } from "../ui/Select";
import { HAS_TAURI } from "../tauriEnv";
import {
  fetchCapabilities,
  fetchForwardState,
  fetchPorts,
  fetchPortDetails,
  killPortProcess,
  stopPortContainer,
  type PortDetails,
  type PortProcess,
  setForwardEnabled,
  type Capabilities,
} from "../serverApi";
import {
  DEFAULT_MIN_PORT,
  DEFAULT_SKIP,
  forwardScan,
  forwardRelease,
  forwardSet,
  openUrl,
  type ForwardStatus,
} from "../forward";
import { visibleInterval, visibleTimeout } from "../visibility";

const POLL_MS = 4000;
// A short list reads at a glance; the filter appears once it no longer does.
const FILTER_FROM = 8;

// Ports whose listeners are never offered a Stop action in the UI. Mirrors
// PROTECTED_PORTS in server/lib/ports.js (the backend enforces the same list,
// so this only controls whether the button renders).
const PROTECTED_PORTS = [22, 53, 631, 3389, 5190];

type PortView = "forwarded" | "local";

// Port-forwarding settings. Forwarding is automatic for every port at
// once; the global enable/disable is a client-side control.
function fwdLoad(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}
function fwdSave(key: string, v: string) {
  try {
    localStorage.setItem(key, v);
  } catch {
    /* ignore */
  }
}

export const useForwardConfig = create<{ serverId: string; clientId: string; enabled: boolean }>(() => ({
  serverId: fwdLoad("pzza.fwd.serverDev", ""),
  clientId: fwdLoad("pzza.fwd.clientDev", "this-mac"),
  enabled: fwdLoad("pzza.fwd.enabled", "1") !== "0",
}));

export function updateForwardConfig(patch: Partial<ReturnType<typeof useForwardConfig.getState>>): void {
  const next = { ...useForwardConfig.getState(), ...patch };
  fwdSave("pzza.fwd.serverDev", next.serverId); fwdSave("pzza.fwd.clientDev", next.clientId); fwdSave("pzza.fwd.enabled", next.enabled ? "1" : "0");
  useForwardConfig.setState(next);
}
// A disabled source falls back to the next enabled remote (the empty default),
// and a disabled receiver falls back to this device. Forwards already open from
// a disabled source are cancelled too, whether it was chosen explicitly or was
// the implicit default, so disabling a device really stops its tunnels.
export function releaseDisabledForwardDevices(devices: Device[]): void {
  const off = (id: string) => devices.some(device => device.id === id && device.disabled);
  const { serverId, clientId } = useForwardConfig.getState();
  if (off(serverId) || off(clientId)) updateForwardConfig({ serverId: off(serverId) ? "" : serverId, clientId: off(clientId) ? THIS_MAC.id : clientId });
  const host = forwardingHost;
  if (host && devices.some(device => device.disabled && deviceHost(device) === host)) {
    forwardingHost = "";
    queueForwarding(() => forwardRelease(host)).then(() => useForwardedPorts.setState({ count: 0 })).catch(() => undefined);
  }
}
// How many ports are forwarded right now, for the top bar chip; null until the
// first observation. Native builds publish it from every forwarding reconcile
// (the panel's polling and app control both go through it), since they own the
// tunnels and a background scan would open SSH connections on its own. The
// agent build reads the agent's in-memory forward state (see useForwardedCount).
export const useForwardedPorts = create<{ count: number | null }>(() => ({ count: null }));
const FORWARD_COUNT_POLL_MS = 60_000;
export function useForwardedCount(enabled: boolean): number | null {
  const count = useForwardedPorts(state => state.count);
  useEffect(() => {
    if (HAS_TAURI || !enabled) return;
    let alive = true;
    let caps: Capabilities | null = null;
    const tick = async () => {
      if (document.visibilityState !== "visible") return;
      try {
        caps ??= await fetchCapabilities();
        // A source device mirrors nothing itself, so there is no count to show.
        if (!caps.forward) return;
        const state = await fetchForwardState();
        if (alive) useForwardedPorts.setState({ count: state.enabled ? state.active.length : 0 });
      } catch {
        if (alive) useForwardedPorts.setState({ count: null });
      }
    };
    const onVisibility = () => { if (document.visibilityState === "visible") void tick(); };
    void tick();
    // Returning to the window refreshes already (onVisibility).
    const stop = visibleInterval(() => void tick(), FORWARD_COUNT_POLL_MS, { catchUp: false });
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      alive = false;
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [enabled]);
  return count;
}
let forwardingQueue: Promise<unknown> = Promise.resolve();
// The host whose ports this app is currently forwarding, if any.
let forwardingHost = "";
function queueForwarding<T>(task: () => Promise<T>): Promise<T> {
  const operation = forwardingQueue.catch(() => undefined).then(task);
  forwardingQueue = operation;
  return operation;
}
export function reconcileSelectedForwarding(host: string, enabled: boolean, isActive: () => boolean = () => true): Promise<ForwardStatus> {
  return queueForwarding(async () => {
    const check = () => { if (!isActive()) throw new Error("Forwarding view changed."); };
    check();
    if (enabled) forwardingHost = host;
    else if (forwardingHost === host) forwardingHost = "";
    const scan = await forwardScan(host, DEFAULT_SKIP, DEFAULT_MIN_PORT);
    const ports = enabled ? scan.wanted.filter(port => !scan.forwarded.includes(port)) : scan.forwarded;
    for (const port of ports) { check(); await forwardSet(host, port, enabled); }
    check();
    const status = ports.length ? await forwardScan(host, DEFAULT_SKIP, DEFAULT_MIN_PORT) : scan;
    // Same number the panel shows: nothing counts as forwarded while disabled.
    useForwardedPorts.setState({ count: enabled ? status.forwarded.length : 0 });
    return status;
  });
}

function ForwardConfig({
  serverId,
  clientId,
  onServer,
  onClient,
}: {
  serverId: string;
  clientId: string;
  onServer: (id: string) => void;
  onClient: (id: string) => void;
}) {
  const devices = useStore((s) => s.activeDevices);

  const server = devices.find((d) => d.id === serverId);

  return (
    <section className="settings-section" aria-label="Forwarding connection">
      <div className="settings-form">
        <div className="settings-field"><span>Source device</span><Select value={serverId} onChange={onServer} options={devices.map(device => ({ value: device.id, label: device.name, sub: device.host, icon: <DeviceIcon device={device} /> }))} /><small>Services listen on this device.</small></div>
        <div className="settings-field"><span>Receiver</span><Select value={clientId} onChange={onClient} options={devices.map(device => ({ value: device.id, label: device.name, sub: device.host, icon: <DeviceIcon device={device} /> }))} /><small>Forwarded services open on localhost.</small></div>
      </div>
      <p className="set-note">This device mirrors listening ports from {server?.name ?? "the source"} through SSH.</p>
    </section>
  );
}

export function PortsMenu({ active = true, onLoadingChange, onOpenSettings }: {
  active?: boolean;
  onLoadingChange?: (loading: boolean) => void;
  onOpenSettings?: () => void;
}) {
  const devices = useStore((s) => s.activeDevices);
  const configuredServer = useForwardConfig((state) => state.serverId);
  const serverId = configuredServer || devices.find((device) => device.id !== "this-mac")?.id || devices[0]?.id || "";
  const clientId = useForwardConfig((state) => state.clientId);
  const onServer = (v: string) => {
    updateForwardConfig({ serverId: v });
  };
  const onClient = (v: string) => {
    updateForwardConfig({ clientId: v });
  };

  const server = devices.find((d) => d.id === serverId);
  // The app runs the tunnel on this Mac, so it can only forward a remote server's
  // ports here. A local server (this Mac) has nothing to tunnel.
  const serverHost =
    server && server.id !== "this-mac"
      ? server.user
        ? `${server.user}@${server.host}`
        : server.host
      : null;
  const clientIsLocal = clientId === "this-mac";
  const showControls = !onOpenSettings;
  const routeLabel = `${server?.name ?? "Source device"} → ${devices.find(device => device.id === clientId)?.name ?? "Receiver"}`;
  const [selectedView, setView] = useState<PortView>("forwarded");
  // Forwarding needs an enabled remote source; without one only local ports remain.
  const canForward = hasRemoteDevice(devices);
  const view: PortView = canForward ? selectedView : "local";
  const [refreshToken, setRefreshToken] = useState(0);
  const refresh = () => setRefreshToken(value => value + 1);

  return (
    <div className={showControls ? "settings-page ports-settings" : "menu-body"}>
      {showControls ? (canForward ? <ForwardConfig serverId={serverId} clientId={clientId} onServer={onServer} onClient={onClient} /> : null) : <>
        <div className="menu-head-title">Port manager</div>
      </>}
      {canForward ? <div className="ports-tabs" role="tablist" aria-label="Port views">
        <div className="usage-seg" role="group">
          <button type="button" role="tab" aria-selected={view === "forwarded"} className={view === "forwarded" ? "on" : ""} onClick={() => setView("forwarded")}>Forwarded</button>
          <button type="button" role="tab" aria-selected={view === "local"} className={view === "local" ? "on" : ""} onClick={() => setView("local")}>This device</button>
        </div>
      </div> : null}
      {view === "forwarded" ? <>
        <section className={showControls ? "settings-section" : "ports-menu-services"} aria-label="Forwarded services">
        {HAS_TAURI ? (
          <TauriPorts pollingActive={active} serverHost={serverHost} hostName={server?.name ?? "Source device"} clientIsLocal={clientIsLocal} showControls={showControls} onLoadingChange={onLoadingChange} route={showControls ? undefined : routeLabel} refreshToken={refreshToken} onChanged={refresh} />
        ) : (
          <ServerPorts pollingActive={active} showControls={showControls} onLoadingChange={onLoadingChange} route={showControls ? undefined : routeLabel} refreshToken={refreshToken} onChanged={refresh} />
        )}
        </section>
      </> : (
        <section className={showControls ? "settings-section" : "ports-menu-services"} aria-label="This device services">
          <LocalPorts pollingActive={active} onLoadingChange={onLoadingChange} refreshToken={refreshToken} onChanged={refresh} native={HAS_TAURI} />
        </section>
      )}
      {onOpenSettings ? <button type="button" className="menu-item" onClick={onOpenSettings}>
        <Settings size={16} strokeWidth={1.9} />
        Settings
      </button> : null}
    </div>
  );
}

function ForwardSwitch({ enabled, onToggle, loading = false }: { enabled: boolean; onToggle: () => void; loading?: boolean }) {
  const showLoading = useDelayedLoading(loading);
  return (
    <button
      type="button"
      className={`switch ${enabled ? "switch-on" : ""}`}
      onClick={onToggle}
      role="switch"
      aria-checked={enabled}
      aria-busy={loading}
      disabled={loading}
      title={enabled ? "Disable forwarding" : "Enable forwarding"}
      aria-label={enabled ? "Disable forwarding" : "Enable forwarding"}
    >
      <span className="switch-knob async-switch-knob">{showLoading ? <LoaderCircle size={12} className="async-spinner" /> : null}</span>
    </button>
  );
}

function usePortDetails(host?: string, enabled = true, revision = 0) {
  const [details, setDetails] = useState<PortDetails[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(enabled);
  useEffect(() => {
    setDetails([]); setUnavailable(false); setLoading(enabled);
    if (!enabled) return;
    const controller = new AbortController();
    let cancelTimer: (() => void) | undefined;
    const refresh = async () => {
      try {
        const result = await fetchPortDetails(host, controller.signal);
        if (!controller.signal.aborted) { setDetails(result); setUnavailable(false); }
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      } finally {
        if (!controller.signal.aborted) { setLoading(false); cancelTimer = visibleTimeout(refresh, POLL_MS); }
      }
    };
    void refresh();
    return () => { controller.abort(); cancelTimer?.(); };
  }, [host, enabled, revision]);
  return { details, unavailable, loading };
}

function useLoadingReport(loading: boolean, report?: (loading: boolean) => void) {
  useEffect(() => { report?.(loading); }, [loading, report]);
  useEffect(() => () => report?.(false), [report]);
}

// "12m", "3h 5m", "2d 4h": how long a service has been up, two units at most.
export function formatUptime(seconds: number): string {
  if (seconds < 60) return "just started";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return minutes % 60 ? `${hours}h ${minutes % 60}m` : `${hours}h`;
  const days = Math.floor(hours / 24);
  return hours % 24 ? `${days}d ${hours % 24}h` : `${days}d`;
}

const sameText = (a: string, b: string): boolean => a.trim().toLowerCase() === b.trim().toLowerCase();

// Each fact once, in its first spelling: "Shop" and "shop" are the same name.
export function uniqueText(values: ReadonlyArray<string | null | undefined>): string[] {
  const seen = new Set<string>();
  return values.filter((value): value is string => {
    const key = value?.trim().toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// The agent classifies ports (see inspectPortProcesses); a protected port
// counts as a system one even when an older agent does not say so.
export function isSystemPort(entry: PortDetails): boolean {
  return entry.system ?? PROTECTED_PORTS.includes(entry.port);
}

// A coding agent's own bridge, or a port of the app's own sessions.
export function isAgentPort(entry: PortDetails): boolean {
  return entry.internal === true && !isSystemPort(entry);
}

// What the list leaves out until asked: system services and agent ports.
export function isHiddenPort(entry: PortDetails): boolean {
  return isSystemPort(entry) || isAgentPort(entry);
}

// "Show 8 system and 9 agent services": what the toggle reveals, by kind.
export function hiddenPortsLabel(entries: ReadonlyArray<PortDetails>, shown: boolean): string {
  const system = entries.filter(isSystemPort).length;
  const agent = entries.filter(isAgentPort).length;
  const total = system + agent;
  const kinds = [system ? `${shown ? "" : `${system} `}system` : null, agent ? `${shown ? "" : `${agent} `}agent` : null].filter(Boolean).join(" and ");
  return `${shown ? "Hide" : "Show"} ${kinds} service${total === 1 && !shown ? "" : "s"}`;
}

export interface PortSummary {
  title: string;
  kinds: string[];
  sessions: string[];
  uptime: number | null;
  /** How it runs (process, folder, container runtime), minus what the title and kinds already say. */
  runs: string[];
  /** Every identity in full, for the row's tooltip. */
  info: string;
}

// Everything a row says about a port, each fact once; also what the filter searches.
export function describePort(entry: PortDetails): PortSummary {
  const containers = entry.containers ?? [];
  // A developer's process names the port before a system helper or an agent's bridge sharing it,
  // such as a container runtime's proxy.
  const owners = entry.processes.filter(process => !process.system && !process.agent);
  const processes: PortProcess[] = owners.length ? owners : entry.processes;
  const uptimes = processes.map(process => process.uptime).filter((value): value is number => typeof value === "number");
  const names = uniqueText(containers.length ? containers.map(container => container.name) : processes.map(process => process.name));
  const kinds = uniqueText(containers.length ? [] : processes.map(process => process.kind)).filter(kind => !names.some(name => sameText(name, kind)));
  const said = [...names, ...kinds];
  const fresh = (parts: Array<string | null | undefined>) => uniqueText(parts).filter(part => !said.some(text => sameText(text, part))).join(" · ");
  const reach = entry.scope === "network" ? "Reachable from other devices" : entry.scope === "local" ? "This device only" : null;
  const info = [
    ...containers.map(container => `${container.runtime} · ${container.container}${container.project ? ` · project ${container.project}` : ""}${container.service ? ` · service ${container.service}` : ""}`),
    ...entry.processes.map(process => `${process.name} · ${process.source === "package" ? "project name" : process.source === "folder" ? "working folder" : "process name"} · ${process.process} · PID ${process.pid}${process.system ? " · system service" : ""}`),
  ];
  return {
    title: names.join(", ") || "TCP service",
    kinds,
    sessions: uniqueText(entry.processes.map(process => process.session)),
    // Several processes on one port: the service is as old as its oldest.
    uptime: uptimes.length ? Math.max(...uptimes) : null,
    runs: uniqueText(containers.length
      ? containers.map(container => fresh([container.runtime, container.container]))
      : processes.map(process => fresh([process.process, process.folder]))),
    info: info.length ? [...info, ...(reach ? [reach] : [])].join("\n") : "The source device has not provided a readable process identity.",
  };
}

export function portMatches(entry: PortDetails, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  const { title, kinds, sessions, runs } = describePort(entry);
  return [String(entry.port), title, ...kinds, ...sessions, ...runs].some(text => text.toLowerCase().includes(needle));
}

// Local-only is the default reach, so Network is the reach worth a filter;
// the four chips also fit the popover's width on one line.
export type PortFilter = "all" | "sessions" | "network" | "containers";
const PORT_FILTERS: ReadonlyArray<{ id: PortFilter; label: string; hint: string; test: (entry: PortDetails) => boolean }> = [
  { id: "all", label: "All", hint: "Every service", test: () => true },
  { id: "sessions", label: "Sessions", hint: "Started from a terminal session", test: entry => entry.processes.some(process => !!process.session) },
  { id: "network", label: "Network", hint: "Reachable from other devices", test: entry => entry.scope === "network" },
  { id: "containers", label: "Containers", hint: "Published by a container", test: entry => !!entry.containers?.length },
];
export function portInFilter(entry: PortDetails, filter: PortFilter): boolean {
  return PORT_FILTERS.find(item => item.id === filter)?.test(entry) ?? true;
}

export interface PortGroup {
  key: string;
  label: string;
  /** The session every port in the group was started from. */
  session: string | null;
  system: boolean;
  entries: PortDetails[];
}

// Ports a session started come first, one group per session, then the other
// services, then system ones. Sessions running a recognized service (a
// framework, a database) lead, so dev servers come before helper sockets. A
// port belongs to exactly one group: one started from two sessions sits under
// the first and names the other on its row.
export function groupPorts(entries: ReadonlyArray<PortDetails>): PortGroup[] {
  const bySession = new Map<string, PortDetails[]>();
  const services: PortDetails[] = [];
  const system: PortDetails[] = [];
  for (const entry of [...entries].sort((a, b) => a.port - b.port)) {
    const [session] = describePort(entry).sessions;
    if (session) bySession.set(session, [...(bySession.get(session) ?? []), entry]);
    else (isSystemPort(entry) ? system : services).push(entry);
  }
  const serves = (list: PortDetails[]) => list.some(entry => describePort(entry).kinds.length > 0 || !!entry.containers?.length);
  const groups: PortGroup[] = [...bySession]
    .sort(([a, first], [b, second]) => Number(serves(second)) - Number(serves(first)) || a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" }))
    .map(([session, list]) => ({ key: `session:${session}`, label: session, session, system: false, entries: list }));
  if (services.length) groups.push({ key: "services", label: "Other services", session: null, system: false, entries: services });
  if (system.length) groups.push({ key: "system", label: "System", session: null, system: true, entries: system });
  return groups;
}

// One port in at most two short lines: the port, what it is, and how it runs.
// The session is the group's header, so a row names only another one.
function PortRow({ entry, session, actions }: { entry: PortDetails; session: string | null; actions: ReactNode }) {
  const summary = describePort(entry);
  const { kinds, sessions, uptime, info } = summary;
  // Under a session header, a title that only repeats the session's name
  // (a folder named like its session) gives way to how the port runs.
  const repeats = !!session && sameText(summary.title, session) && summary.runs.length > 0;
  const title = repeats ? summary.runs[0] : summary.title;
  const runs = repeats ? summary.runs.slice(1) : summary.runs;
  const elsewhere = sessions.filter(name => !session || !sameText(name, session));
  const network = entry.scope === "network";
  return <div className="port-row" title={info}>
    <span className="port-num">{entry.port}</span>
    <div className="port-main">
      <div className="port-line">
        <span className="port-title">{title}</span>
        {kinds.map(kind => <span key={kind} className="port-kind">{kind}</span>)}
      </div>
      {network || elsewhere.length || runs.length || uptime !== null ? <div className="port-meta">
        {network ? <span className="port-net" title="Listens on every network interface: other devices on this network can reach it.">
          <Globe size={10} aria-hidden="true" />Network
        </span> : null}
        {elsewhere.map(name => <span key={name} className="port-meta-session" title={`Also started in the session “${name}”`}>
          <SquareTerminal size={10} aria-hidden="true" />{name}
        </span>)}
        {runs.map(run => <span key={run}>{run}</span>)}
        {uptime !== null ? <span title="How long it has been running">{formatUptime(uptime)}</span> : null}
      </div> : null}
    </div>
    <div className="port-actions">{actions}</div>
  </div>;
}

// The list every view shares: search, filter chips, session groups and the
// system services and agent ports, which stay hidden until asked for.
function PortList({ entries, renderActions, onlySystemText }: {
  entries: ReadonlyArray<PortDetails>;
  renderActions: (entry: PortDetails) => ReactNode;
  /** Shown when only hidden services are left; null when a status line says so already. */
  onlySystemText: string | null;
}) {
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<PortFilter>("all");
  const [showHidden, setShowHidden] = useState(false);
  const hidden = entries.filter(isHiddenPort).length;
  const pool = showHidden ? [...entries] : entries.filter(entry => !isHiddenPort(entry));
  const counts = new Map(PORT_FILTERS.map(item => [item.id, pool.filter(item.test).length]));
  // Only filters that narrow the list are offered; when the chosen one stops
  // narrowing it (its ports went away), the list falls back to All.
  const offered = PORT_FILTERS.filter(item => {
    const count = counts.get(item.id) ?? 0;
    return item.id === "all" || (count > 0 && count < pool.length);
  });
  const filter = offered.some(item => item.id === selected) ? selected : "all";
  const shown = pool.filter(entry => portInFilter(entry, filter) && portMatches(entry, query));
  const groups = groupPorts(shown);
  // A lone group of other services needs no header.
  const headed = groups.length > 1 || groups.some(group => group.session);
  return <>
    {pool.length > FILTER_FROM ? <label className="ports-filter">
      <Search size={13} aria-hidden="true" />
      <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Filter by name, port or session" aria-label="Filter ports" spellCheck={false} />
    </label> : null}
    {offered.length > 1 ? <div className="ports-chips" role="group" aria-label="Show ports">
      {offered.map(item => <button key={item.id} type="button" className={`ports-chip${filter === item.id ? " on" : ""}`} aria-pressed={filter === item.id} title={item.hint} onClick={() => setSelected(item.id)}>
        {/* All counts what the status line already says. */}
        {item.label}{item.id === "all" ? null : <span className="ports-chip-count">{counts.get(item.id)}</span>}
      </button>)}
    </div> : null}
    <div className="ports-box">
      {pool.length === 0 ? (onlySystemText ? <p className="settings-empty">{onlySystemText}</p> : null)
        : shown.length === 0 ? <p className="settings-empty">No port matches “{query.trim()}”.</p>
        : groups.map(group => <section key={group.key} className="ports-group" aria-label={group.session ? `Session ${group.label}` : group.label}>
          {headed ? <div className={`ports-group-head${group.session ? " is-session" : ""}`}>
            {group.session ? <SquareTerminal size={12} aria-hidden="true" /> : group.system ? <Cpu size={12} aria-hidden="true" /> : <Server size={12} aria-hidden="true" />}
            <span className="ports-group-name">{group.label}</span>
            <span className="ports-group-count">{group.entries.length}</span>
          </div> : null}
          {group.entries.map(entry => <PortRow key={entry.port} entry={entry} session={group.session} actions={renderActions(entry)} />)}
        </section>)}
    </div>
    {hidden ? <button type="button" className="ports-system-toggle" aria-pressed={showHidden} onClick={() => setShowHidden(value => !value)}>
      {showHidden ? <EyeOff size={12} aria-hidden="true" /> : <Eye size={12} aria-hidden="true" />}
      {hiddenPortsLabel(entries, showHidden)}
    </button> : null}
  </>;
}

function OpenLink({ port }: { port: number }) {
  return (
    <a className="tile-btn" href={`http://localhost:${port}`} target="_blank" rel="noreferrer" title={`Open localhost:${port}`} aria-label={`Open localhost:${port}`}>
      <ExternalLink size={13} strokeWidth={2} />
    </a>
  );
}

// Stop the service behind one port row: published containers are stopped,
// otherwise the owning processes are terminated. Containers take precedence
// because a bare process kill would only take down the container's proxy.
// host follows the ports API convention: undefined (or "") addresses the
// agent's own machine, anything else goes over SSH to that device.
function StopServiceButton({ port, host, hostName, containers, processes, onStopped, onError }: {
  port: number;
  host: string | undefined;
  hostName: string;
  containers: NonNullable<PortDetails["containers"]>;
  processes: PortDetails["processes"];
  onStopped: () => void;
  onError: (message: string) => void;
}) {
  const [stopping, setStopping] = useState(false);
  const showSpinner = useDelayedLoading(stopping);
  if (PROTECTED_PORTS.includes(port) || (!containers.length && !processes.length)) return null;
  const names = [...containers.map(container => `${container.name} (container)`),
    ...processes.map(item => `PID ${item.pid}${item.process ? ` (${item.process})` : ""}`)];
  const title = containers.length ? `Stop ${containers.map(c => c.name).join(", ")}` : `Stop ${processes.map(p => `PID ${p.pid}`).join(", ")}`;
  return (
    <button
      type="button"
      className="tile-btn tile-btn-danger"
      title={title}
      aria-label={`${title} on port ${port}`}
      disabled={stopping}
      onClick={async () => {
        if (!await confirmAction({
          title: `Stop service on port ${port}?`,
          message: `This ${containers.length ? "stops" : "terminates"} ${names.join(", ")} on ${hostName}. The service stays down until it is started again.`,
          confirmLabel: "Stop service",
          danger: true,
        })) return;
        setStopping(true);
        try {
          for (const container of containers) await stopPortContainer(container.id, container.runtime, host);
          if (!containers.length) for (const item of processes) await killPortProcess(item.pid, host);
          onStopped();
        } catch (error) {
          onError(error instanceof Error ? error.message : "Could not stop the service.");
        } finally {
          setStopping(false);
        }
      }}
    >
      {showSpinner ? <LoaderCircle size={13} className="async-spinner" /> : <CircleStop size={13} />}
    </button>
  );
}

function ServerPorts({ pollingActive, showControls, onLoadingChange, route, refreshToken, onChanged }: {
  pollingActive: boolean; showControls: boolean; onLoadingChange?: (loading: boolean) => void; route?: string;
  refreshToken: number; onChanged: () => void;
}) {
  const { details, unavailable, loading: detailsLoading } = usePortDetails(undefined, pollingActive, refreshToken);
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [ports, setPorts] = useState<number[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [active, setActive] = useState<number[]>([]);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const togglingRef = useRef(false);
  const mutationVersion = useRef(0);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const showLoading = useDelayedLoading(loading);
  useLoadingReport(pollingActive && (loading || detailsLoading || toggling), onLoadingChange);

  useEffect(() => {
    if (!pollingActive) return;
    fetchCapabilities()
      .then(setCaps)
      .catch(() => { setError("Could not load port forwarding. Close this panel and retry."); setLoading(false); });
  }, [pollingActive]);

  useEffect(() => {
    if (!caps || !pollingActive) return;
    let alive = true;
    let cancelTimer: (() => void) | undefined;
    const tick = async () => {
      const version = mutationVersion.current;
      try {
        const s = await fetchForwardState();
        if (alive && !togglingRef.current && version === mutationVersion.current) {
          setEnabled(s.enabled);
          setActive(s.active);
          if (caps.forward) useForwardedPorts.setState({ count: s.enabled ? s.active.length : 0 });
        }
        if (!caps.forward) {
          const p = await fetchPorts();
          if (alive) setPorts(p.filter((n) => n >= DEFAULT_MIN_PORT && !DEFAULT_SKIP.includes(n)));
        }
        if (alive) setError("");
      } catch { if (alive) setError("Could not refresh ports. Retrying…"); }
      finally { if (alive) { setLoading(false); cancelTimer = visibleTimeout(tick, POLL_MS); } }
    };
    void tick();
    return () => {
      alive = false;
      cancelTimer?.();
    };
  }, [caps, pollingActive, refreshToken]);

  if (!caps) return <p className="settings-empty" role="status">{error || (showLoading ? "Checking ports…" : "\u00a0")}</p>;

  const isClient = caps.forward;
  const rows = isClient ? active : [...new Set([...ports, ...details.map(detail => detail.port).filter(port => port >= DEFAULT_MIN_PORT && !DEFAULT_SKIP.includes(port))])].sort((a, b) => a - b);
  // Stopping needs a confirmed identity, which only exists for the agent's
  // own machine - forwarded rows on a client stay read-only.
  const stoppable = !isClient;
  const rowDetail = (port: number) => details.find(entry => entry.port === port);

  const toggle = async () => {
    if (togglingRef.current) return;
    mutationVersion.current++;
    togglingRef.current = true; setToggling(true); setActionError("");
    const next = !enabled;
    try {
      await setForwardEnabled(next);
      const s = await fetchForwardState();
      setEnabled(s.enabled);
      setActive(s.active);
      useForwardedPorts.setState({ count: s.enabled ? s.active.length : 0 });
    } catch { setActionError("Could not change forwarding. Retry after checking the device connection."); }
    finally { togglingRef.current = false; setToggling(false); }
  };

  return (
    <>
      <div className="settings-row ports-status">
        {route ? <span className="ports-route-inline">{route}</span> : null}
        <span className={`dot ${enabled ? "dot-up" : "dot-down"}`} />
        <span className="small muted ports-status-text">
          {isClient
            ? enabled
              ? `forwarding ${active.length} port${active.length === 1 ? "" : "s"}`
              : "forwarding off"
            : `source · ${caps.host ?? "server"}`}
        </span>
        <div className="ports-status-spacer" />
        {isClient && showControls ? <ForwardSwitch enabled={enabled} onToggle={toggle} loading={toggling || loading} /> : null}
      </div>
      {error ? <p className="small pad" role="alert">{error}</p> : null}
      {actionError ? <p className="small pad" role="alert">{actionError}</p> : null}
      {unavailable ? <p className="small muted pad">Could not refresh service details. Showing last known names.</p> : null}
      {rows.length === 0 ? <div className="ports-box">
        <p className="settings-empty">
          {loading ? (showLoading ? "Checking ports…" : "\u00a0") : isClient ? (enabled ? "No ports to forward." : "Forwarding is off.") : "No listening ports."}
        </p>
      </div> : <PortList
        entries={rows.map(port => rowDetail(port) ?? { port, processes: [] })}
        onlySystemText={isClient ? "Only system and agent services are forwarded." : "Only system and agent services are listening."}
        renderActions={entry => <>
          <OpenLink port={entry.port} />
          {stoppable ? <StopServiceButton
            port={entry.port} host={undefined} hostName="this device"
            containers={entry.containers ?? []} processes={entry.processes}
            onStopped={onChanged} onError={setActionError}
          /> : null}
        </>}
      />}
    </>
  );
}

// The native browser hand-off; a failure is reported in the list's alert line
// so the row keeps its height.
function NativeOpenLink({ port, onError }: { port: number; onError: (message: string) => void }) {
  const [loading, setLoading] = useState(false);
  const pending = useRef(false);
  const open = async () => {
    if (pending.current) return;
    pending.current = true; setLoading(true); onError("");
    try { await openUrl(`http://localhost:${port}`); }
    catch { onError("Could not open the browser. Retry."); }
    finally { pending.current = false; setLoading(false); }
  };
  return <AsyncButton className="tile-btn" iconSize={13} loading={loading} icon={ExternalLink} title={`Open localhost:${port}`} aria-label={`Open localhost:${port}`} onClick={() => void open()} />;
}

function TauriPorts({ serverHost, hostName, clientIsLocal, pollingActive, showControls, onLoadingChange, route, refreshToken, onChanged }: {
  serverHost: string | null; hostName: string; clientIsLocal: boolean; pollingActive: boolean; showControls: boolean; onLoadingChange?: (loading: boolean) => void; route?: string;
  refreshToken: number; onChanged: () => void;
}) {
  const host = serverHost;
  const { details, unavailable, loading: detailsLoading } = usePortDetails(host ?? undefined, !!host && clientIsLocal && pollingActive, refreshToken);
  const [status, setStatus] = useState<ForwardStatus | null>(null);
  const enabled = useForwardConfig((state) => state.enabled);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [actionError, setActionError] = useState("");
  const showLoading = useDelayedLoading(loading);
  const scanQueue = useRef<Promise<void>>(Promise.resolve());
  useLoadingReport(pollingActive && !!host && clientIsLocal && (loading || detailsLoading), onLoadingChange);

  useEffect(() => { setStatus(null); }, [host, clientIsLocal]);
  useEffect(() => {
    if (!host || !clientIsLocal || !pollingActive) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setError("");    const tick = () => {
      const task = scanQueue.current.then(async () => {
        if (!alive) return;
        try {
          const next = await reconcileSelectedForwarding(host, enabled, () => alive);
          if (alive) { setStatus(next); setError(""); }
        } catch {
          if (alive) setError("Could not update forwarding. Check the source device and SSH connection. Retrying…");
        } finally {
          if (alive) { setLoading(false); timer = setTimeout(tick, POLL_MS); }
        }
      });
      scanQueue.current = task;
      return task;
    };
    void tick();
    return () => { alive = false; clearTimeout(timer); };
  }, [host, enabled, clientIsLocal, pollingActive, refreshToken]);

  if (!clientIsLocal) return <p className="settings-empty">Forwarding runs on this device - select it as the client.</p>;
  if (!host) return <p className="settings-empty">Pick a remote device as the server to mirror its ports here.</p>;

  const forwarded = [...(status?.forwarded ?? [])].sort((a, b) => a - b);
  const up = status?.masterUp;
  return <>
    <div className="settings-row ports-status">
      {route ? <span className="ports-route-inline">{route}</span> : null}
      <span className={`dot ${up && enabled ? "dot-up" : "dot-down"}`} />
      <span className="small muted ports-status-text" role="status">
        {!status ? (showLoading ? "Checking ports…" : "\u00a0") : !up ? "SSH connection unavailable" : enabled ? `forwarding ${forwarded.length} ports` : "forwarding off"}
      </span>
      <div className="ports-status-spacer" />
      {showControls ? <ForwardSwitch enabled={enabled} loading={loading} onToggle={() => {
        setLoading(true);
        updateForwardConfig({ enabled: !enabled });
      }} /> : null}
    </div>
    {error ? <p className="small pad" role="alert">{error}</p> : null}
    {actionError ? <p className="small pad" role="alert">{actionError}</p> : null}
    {unavailable ? <p className="small muted pad">Could not refresh service details. Showing last known names.</p> : null}
    {forwarded.length === 0 ? <div className="ports-box">
      <p className="settings-empty">
        {!status && loading ? (showLoading ? "Checking ports…" : "\u00a0") : !enabled ? "Forwarding is off." : up ? "No ports to forward." : "Waiting for the source device."}
      </p>
    </div> : <PortList
      entries={forwarded.map(port => details.find(detail => detail.port === port) ?? { port, processes: [] })}
      onlySystemText="Only system and agent services are forwarded."
      renderActions={entry => <>
        <NativeOpenLink port={entry.port} onError={setActionError} />
        <StopServiceButton
          port={entry.port} host={host ?? undefined} hostName={hostName}
          containers={entry.containers ?? []} processes={entry.processes}
          onStopped={onChanged} onError={setActionError}
        />
      </>}
    />}
  </>;
}

// This device's own listeners with per-service Stop actions. An explicit
// empty host addresses the agent's own machine even when it otherwise
// proxies to a source device (receiver mode).
function LocalPorts({ pollingActive, onLoadingChange, refreshToken, onChanged, native }: {
  pollingActive: boolean; onLoadingChange?: (loading: boolean) => void;
  refreshToken: number; onChanged: () => void; native: boolean;
}) {
  const { details, unavailable, loading } = usePortDetails("", pollingActive, refreshToken);
  const [actionError, setActionError] = useState("");
  const showLoading = useDelayedLoading(loading);
  useLoadingReport(pollingActive && loading, onLoadingChange);
  const rows = details.flatMap(entry => {
    // SSH client TCP listeners are tunnels; sshd is a service on this device.
    const processes = entry.processes.filter(item => item.process !== "ssh");
    if (entry.processes.length && !processes.length && !entry.containers?.length) return [];
    return [{ ...entry, processes }];
  }).sort((a, b) => a.port - b.port);
  // The summary counts what the list shows by default; hidden services are
  // counted on their own toggle below the list.
  const services = rows.filter(entry => !isHiddenPort(entry));
  const open = services.filter(entry => entry.scope === "network").length;

  return <>
    <div className="settings-row ports-status">
      <span className="small muted ports-status-text" role="status">
        {loading ? (showLoading ? "Checking ports…" : "\u00a0")
          : unavailable && rows.length === 0 ? "Port details unavailable"
          : rows.length === 0 ? "No listening ports."
          : services.length === 0 ? "Only system and agent services are listening."
          : `${services.length} listening port${services.length === 1 ? "" : "s"}${open ? `, ${open} open to the network` : ""}`}
      </span>
      <div className="ports-status-spacer" />
    </div>
    {actionError ? <p className="small pad" role="alert">{actionError}</p> : null}
    {unavailable && rows.length > 0 ? <p className="small muted pad">Could not refresh service details. Showing last known names.</p> : null}
    {rows.length === 0 ? (loading ? null : <div className="ports-box"><p className="settings-empty">Nothing is listening on this device.</p></div>)
      : <PortList
        entries={rows}
        onlySystemText={null}
        renderActions={entry => <>
          {native ? <NativeOpenLink port={entry.port} onError={setActionError} /> : <OpenLink port={entry.port} />}
          <StopServiceButton
            port={entry.port} host={undefined} hostName="this device"
            containers={entry.containers ?? []} processes={entry.processes}
            onStopped={() => { setActionError(""); onChanged(); }} onError={setActionError}
          />
        </>}
      />}
  </>;
}
