import { DeviceIcon } from "../ui/DeviceIcon";
import { useEffect, useRef, useState } from "react";
import { ExternalLink, LoaderCircle, Settings } from "lucide-react";
import { create } from "zustand";
import { AsyncButton } from "../ui/AsyncButton";
import { useDelayedLoading } from "../ui/useDelayedLoading";
import { useStore } from "../state/store";
import { Select } from "../ui/Select";
import { HAS_TAURI } from "../tauriEnv";
import {
  fetchCapabilities,
  fetchForwardState,
  fetchPorts,
  fetchPortDetails,
  type PortDetails,
  setForwardEnabled,
  type Capabilities,
} from "../serverApi";
import {
  DEFAULT_MIN_PORT,
  DEFAULT_SKIP,
  forwardScan,
  forwardSet,
  openUrl,
  type ForwardStatus,
} from "../forward";

const POLL_MS = 4000;

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
let forwardingQueue: Promise<unknown> = Promise.resolve();
export function reconcileSelectedForwarding(host: string, enabled: boolean, isActive: () => boolean = () => true): Promise<ForwardStatus> {
  const operation = forwardingQueue.catch(() => undefined).then(async () => {
    const check = () => { if (!isActive()) throw new Error("Forwarding view changed."); };
    check();
    const scan = await forwardScan(host, DEFAULT_SKIP, DEFAULT_MIN_PORT);
    const ports = enabled ? scan.wanted.filter(port => !scan.forwarded.includes(port)) : scan.forwarded;
    for (const port of ports) { check(); await forwardSet(host, port, enabled); }
    check();
    return ports.length ? forwardScan(host, DEFAULT_SKIP, DEFAULT_MIN_PORT) : scan;
  });
  forwardingQueue = operation;
  return operation;
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
  const devices = useStore((s) => s.devices);

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
  const devices = useStore((s) => s.devices);
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

  return (
    <div className={showControls ? "settings-page ports-settings" : "menu-body"}>
      {showControls ? <ForwardConfig serverId={serverId} clientId={clientId} onServer={onServer} onClient={onClient} /> : <>
        <div className="menu-head-title">Port forwarding</div>
        <p className="ports-menu-route">{server?.name ?? "Source device"} → {devices.find(device => device.id === clientId)?.name ?? "Receiver"}</p>
      </>}
      <section className={showControls ? "settings-section" : "ports-menu-services"} aria-label="Live services">
      {HAS_TAURI ? (
        <TauriPorts pollingActive={active} serverHost={serverHost} clientIsLocal={clientIsLocal} showControls={showControls} onLoadingChange={onLoadingChange} />
      ) : (
        <ServerPorts pollingActive={active} showControls={showControls} onLoadingChange={onLoadingChange} />
      )}
      </section>
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

function usePortDetails(host?: string, enabled = true) {
  const [details, setDetails] = useState<PortDetails[]>([]);
  const [unavailable, setUnavailable] = useState(false);
  const [loading, setLoading] = useState(enabled);
  useEffect(() => {
    setDetails([]); setUnavailable(false); setLoading(enabled);
    if (!enabled) return;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const refresh = async () => {
      try {
        const result = await fetchPortDetails(host, controller.signal);
        if (!controller.signal.aborted) { setDetails(result); setUnavailable(false); }
      } catch {
        if (!controller.signal.aborted) setUnavailable(true);
      } finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(refresh, POLL_MS); }
      }
    };
    void refresh();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [host, enabled]);
  return { details, unavailable, loading };
}

function useLoadingReport(loading: boolean, report?: (loading: boolean) => void) {
  useEffect(() => { report?.(loading); }, [loading, report]);
  useEffect(() => () => report?.(false), [report]);
}

function PortIdentity({ port, details, live }: { port: number; details: PortDetails[]; live: boolean }) {
  const entry = details.find(entry => entry.port === port);
  const processes = entry?.processes ?? [];
  const containers = entry?.containers ?? [];
  const names = [...new Set(containers.length ? containers.map(container => container.name) : processes.map(process => process.name))];
  const info = [...containers.map(container => `${container.runtime} · ${container.container}${container.project ? ` · project ${container.project}` : ""}${container.service ? ` · service ${container.service}` : ""}`), ...processes.map((process) => `${process.name} · ${process.source === "package" ? "project name" : process.source === "folder" ? "working folder" : "process name"} · ${process.process} · PID ${process.pid}`)].join("\n");
  return <div className="port-identity" title={info || "The source device has not provided a readable process identity."}>
    <span className="port-project">{names.join(", ") || "TCP service"}</span>
    <span className="port-num">{port}{live ? <span className="port-state on">live</span> : null}</span>
    <span className="port-process">{[...new Set(containers.length ? containers.map(container => `${container.runtime} · ${container.container}`) : processes.map((process) => process.process))].join(", ")}</span>
  </div>;
}

function OpenLink({ port }: { port: number }) {
  return (
    <a className="btn btn-sm" href={`http://localhost:${port}`} target="_blank" rel="noreferrer">
      <ExternalLink size={13} strokeWidth={2} />
      Open
    </a>
  );
}

function ServerPorts({ pollingActive, showControls, onLoadingChange }: { pollingActive: boolean; showControls: boolean; onLoadingChange?: (loading: boolean) => void }) {
  const { details, unavailable, loading: detailsLoading } = usePortDetails(undefined, pollingActive);
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
    let timer: ReturnType<typeof setTimeout>;
    const tick = async () => {
      const version = mutationVersion.current;
      try {
        const s = await fetchForwardState();
        if (alive && !togglingRef.current && version === mutationVersion.current) {
          setEnabled(s.enabled);
          setActive(s.active);
        }
        if (!caps.forward) {
          const p = await fetchPorts();
          if (alive) setPorts(p.filter((n) => n >= DEFAULT_MIN_PORT && !DEFAULT_SKIP.includes(n)));
        }
        if (alive) setError("");
      } catch { if (alive) setError("Could not refresh ports. Retrying…"); }
      finally { if (alive) { setLoading(false); timer = setTimeout(tick, POLL_MS); } }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [caps, pollingActive]);

  if (!caps) return <p className="settings-empty" role="status">{error || (showLoading ? "Checking ports…" : "\u00a0")}</p>;

  const isClient = caps.forward;
  const rows = isClient ? active : [...new Set([...ports, ...details.map(detail => detail.port).filter(port => port >= DEFAULT_MIN_PORT && !DEFAULT_SKIP.includes(port))])].sort((a, b) => a - b);

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
    } catch { setActionError("Could not change forwarding. Retry after checking the device connection."); }
    finally { togglingRef.current = false; setToggling(false); }
  };

  return (
    <>
      <div className="settings-row ports-status">
        <span className={`dot ${enabled ? "dot-up" : "dot-down"}`} />
        <span className="small muted">
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
      <div className="ports-box">
        {rows.length === 0 ? (
          <p className="settings-empty">
            {loading ? (showLoading ? "Checking ports…" : "\u00a0") : isClient ? (enabled ? "No ports to forward." : "Forwarding is off.") : "No listening ports."}
          </p>
        ) : (
          rows.map((port) => (
            <div key={port} className="settings-row port-row">
              <PortIdentity port={port} details={details} live={isClient} />
              <OpenLink port={port} />
            </div>
          ))
        )}
      </div>
    </>
  );
}

function NativeOpenLink({ port }: { port: number }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const pending = useRef(false);
  const open = async () => {
    if (pending.current) return;
    pending.current = true; setLoading(true); setError("");
    try { await openUrl(`http://localhost:${port}`); }
    catch { setError("Could not open the browser. Retry."); }
    finally { pending.current = false; setLoading(false); }
  };
  return <div>
    <AsyncButton className="btn btn-sm" loading={loading} icon={ExternalLink} onClick={() => void open()}>Open</AsyncButton>
    {error ? <p className="small" role="alert">{error}</p> : null}
  </div>;
}

function TauriPorts({ serverHost, clientIsLocal, pollingActive, showControls, onLoadingChange }: {
  serverHost: string | null; clientIsLocal: boolean; pollingActive: boolean; showControls: boolean; onLoadingChange?: (loading: boolean) => void;
}) {
  const host = serverHost;
  const { details, unavailable, loading: detailsLoading } = usePortDetails(host ?? undefined, !!host && clientIsLocal && pollingActive);
  const [status, setStatus] = useState<ForwardStatus | null>(null);
  const enabled = useForwardConfig((state) => state.enabled);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const showLoading = useDelayedLoading(loading);
  const scanQueue = useRef<Promise<void>>(Promise.resolve());
  useLoadingReport(pollingActive && !!host && clientIsLocal && (loading || detailsLoading), onLoadingChange);

  useEffect(() => { setStatus(null); }, [host, clientIsLocal]);
  useEffect(() => {
    if (!host || !clientIsLocal || !pollingActive) return;
    let alive = true;
    let timer: ReturnType<typeof setTimeout>;
    setLoading(true); setError("");
    const tick = () => {
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
  }, [host, enabled, clientIsLocal, pollingActive]);

  if (!clientIsLocal) return <p className="settings-empty">Forwarding runs on this device - select it as the client.</p>;
  if (!host) return <p className="settings-empty">Pick a remote device as the server to mirror its ports here.</p>;

  const forwarded = [...(status?.forwarded ?? [])].sort((a, b) => a - b);
  const up = status?.masterUp;
  return <>
    <div className="settings-row ports-status">
      <span className={`dot ${up && enabled ? "dot-up" : "dot-down"}`} />
      <span className="small muted" role="status">
        {!status ? (showLoading ? "Checking ports…" : "\u00a0") : !up ? "SSH connection unavailable" : enabled ? `forwarding ${forwarded.length} ports` : "forwarding off"}
      </span>
      <div className="ports-status-spacer" />
      {showControls ? <ForwardSwitch enabled={enabled} loading={loading} onToggle={() => {
        setLoading(true);
        updateForwardConfig({ enabled: !enabled });
      }} /> : null}
    </div>
    {error ? <p className="small pad" role="alert">{error}</p> : null}
    {unavailable ? <p className="small muted pad">Could not refresh service details. Showing last known names.</p> : null}
    <div className="ports-box">
      {forwarded.length === 0 ? <p className="settings-empty">
        {!status && loading ? (showLoading ? "Checking ports…" : "\u00a0") : !enabled ? "Forwarding is off." : up ? "No ports to forward." : "Waiting for the source device."}
      </p> : forwarded.map(port => <div key={port} className="settings-row port-row">
        <PortIdentity port={port} details={details} live />
        <NativeOpenLink port={port} />
      </div>)}
    </div>
  </>;
}
