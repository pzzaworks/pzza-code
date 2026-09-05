import { useEffect, useState } from "react";
import { ChevronDown, ExternalLink } from "lucide-react";
import { useStore } from "../state/store";
import { Select } from "../ui/Select";
import { HAS_TAURI } from "../tauriEnv";
import {
  fetchCapabilities,
  fetchForwardState,
  fetchPorts,
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

// Port-forwarding dropdown content. Forwarding is automatic for every port at
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
  const [openCfg, setOpenCfg] = useState(false);

  const server = devices.find((d) => d.id === serverId);
  const client = devices.find((d) => d.id === clientId);

  return (
    <div className="fwd-config">
      <button className="fwd-config-head" onClick={() => setOpenCfg((v) => !v)}>
        <span className="small muted">
          {server?.name ?? "?"} → {client?.name ?? "?"}
        </span>
        <ChevronDown size={14} className={`muted-icon ${openCfg ? "flip" : ""}`} />
      </button>
      {openCfg ? (
        <div className="fwd-config-body">
          <div className="field">
            <span className="field-label">
              Server<span className="field-hint">source (ports listen here)</span>
            </span>
            <Select
              value={serverId}
              onChange={onServer}
              options={devices.map((d) => ({ value: d.id, label: d.name, sub: d.host }))}
            />
          </div>
          <div className="field">
            <span className="field-label">
              Client<span className="field-hint">receiver (forwarded to here)</span>
            </span>
            <Select
              value={clientId}
              onChange={onClient}
              options={devices.map((d) => ({ value: d.id, label: d.name, sub: d.host }))}
            />
          </div>
          <p className="set-note" style={{ margin: 0 }}>
            This Mac opens an ssh tunnel to {server?.name ?? "the server"} and mirrors its
            listening ports here, so you can open them on localhost.
          </p>
        </div>
      ) : null}
    </div>
  );
}

export function PortsMenu() {
  const devices = useStore((s) => s.devices);
  const [serverId, setServerId] = useState(() =>
    fwdLoad("pzza.fwd.serverDev", devices.find((d) => d.id !== "this-mac")?.id ?? devices[0]?.id ?? ""),
  );
  const [clientId, setClientId] = useState(() => fwdLoad("pzza.fwd.clientDev", "this-mac"));
  const onServer = (v: string) => {
    setServerId(v);
    fwdSave("pzza.fwd.serverDev", v);
  };
  const onClient = (v: string) => {
    setClientId(v);
    fwdSave("pzza.fwd.clientDev", v);
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

  return (
    <div className="menu-body">
      <div className="menu-title">Port forwarding</div>
      <ForwardConfig serverId={serverId} clientId={clientId} onServer={onServer} onClient={onClient} />
      {HAS_TAURI ? (
        <TauriPorts serverHost={serverHost} clientIsLocal={clientIsLocal} />
      ) : (
        <ServerPorts />
      )}
    </div>
  );
}

function ForwardSwitch({ enabled, onToggle }: { enabled: boolean; onToggle: () => void }) {
  return (
    <button
      className={`switch ${enabled ? "switch-on" : ""}`}
      onClick={onToggle}
      role="switch"
      aria-checked={enabled}
      title={enabled ? "Disable forwarding" : "Enable forwarding"}
    >
      <span className="switch-knob" />
    </button>
  );
}

function OpenLink({ port }: { port: number }) {
  return (
    <a className="btn btn-sm" href={`http://localhost:${port}`} target="_blank" rel="noreferrer">
      <ExternalLink size={13} strokeWidth={2} />
      Open
    </a>
  );
}

function ServerPorts() {
  const [caps, setCaps] = useState<Capabilities | null>(null);
  const [ports, setPorts] = useState<number[]>([]);
  const [enabled, setEnabled] = useState(true);
  const [active, setActive] = useState<number[]>([]);

  useEffect(() => {
    fetchCapabilities()
      .then(setCaps)
      .catch(() => setCaps({ role: "source", forward: false, host: null }));
  }, []);

  useEffect(() => {
    if (!caps) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await fetchForwardState();
        if (alive) {
          setEnabled(s.enabled);
          setActive(s.active);
        }
        if (!caps.forward) {
          const p = await fetchPorts();
          if (alive) setPorts(p.filter((n) => n >= DEFAULT_MIN_PORT && !DEFAULT_SKIP.includes(n)));
        }
      } catch {
        /* retry */
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [caps]);

  if (!caps) return <p className="muted small pad">…</p>;

  const isClient = caps.forward;
  const rows = isClient ? active : ports;

  const toggle = async () => {
    const next = !enabled;
    setEnabled(next);
    try {
      await setForwardEnabled(next);
      const s = await fetchForwardState();
      setEnabled(s.enabled);
      setActive(s.active);
    } catch {
      /* revert */
    }
  };

  return (
    <>
      <div className="ports-status">
        <span className={`dot ${enabled ? "dot-up" : "dot-down"}`} />
        <span className="small muted">
          {isClient
            ? enabled
              ? `forwarding ${active.length} port${active.length === 1 ? "" : "s"}`
              : "forwarding off"
            : `source · ${caps.host ?? "server"}`}
        </span>
        <div className="ports-status-spacer" />
        <ForwardSwitch enabled={enabled} onToggle={toggle} />
      </div>
      <div className="ports-box">
        {rows.length === 0 ? (
          <p className="muted small pad">
            {isClient ? (enabled ? "No ports to forward." : "Forwarding is off.") : "No listening ports."}
          </p>
        ) : (
          rows.map((port) => (
            <div key={port} className="port-row">
              <span className="port-num">
                {port}
                {isClient ? <span className="port-state on">live</span> : null}
              </span>
              <OpenLink port={port} />
            </div>
          ))
        )}
      </div>
    </>
  );
}

function TauriPorts({ serverHost, clientIsLocal }: { serverHost: string | null; clientIsLocal: boolean }) {
  const host = serverHost;
  const [status, setStatus] = useState<ForwardStatus | null>(null);
  const [enabled, setEnabled] = useState(true);

  useEffect(() => {
    if (!host) return;
    let alive = true;
    const tick = async () => {
      try {
        const s = await forwardScan(host, DEFAULT_SKIP, DEFAULT_MIN_PORT);
        if (enabled) {
          for (const p of s.wanted) if (!s.forwarded.includes(p)) await forwardSet(host, p, true);
        } else {
          for (const p of s.forwarded) await forwardSet(host, p, false);
        }
        const s2 = await forwardScan(host, DEFAULT_SKIP, DEFAULT_MIN_PORT);
        if (alive) setStatus(s2);
      } catch {
        /* master down */
      }
    };
    void tick();
    const id = setInterval(tick, POLL_MS);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [host, enabled]);

  if (!clientIsLocal)
    return (
      <p className="muted small pad">
        Forwarding runs on this Mac - set the client to This Mac.
      </p>
    );
  if (!host)
    return (
      <p className="muted small pad">
        Pick a remote device as the server to mirror its ports here.
      </p>
    );

  const forwarded = [...(status?.forwarded ?? [])].sort((a, b) => a - b);
  const up = status?.masterUp;

  return (
    <>
      <div className="ports-status">
        <span className={`dot ${up && enabled ? "dot-up" : "dot-down"}`} />
        <span className="small muted">
          {!up ? "ssh master down" : enabled ? `forwarding ${forwarded.length} ports` : "forwarding off"}
        </span>
        <div className="ports-status-spacer" />
        <ForwardSwitch enabled={enabled} onToggle={() => setEnabled((v) => !v)} />
      </div>
      <div className="ports-box">
        {forwarded.length === 0 ? (
          <p className="muted small pad">
            {!enabled ? "Forwarding is off." : up ? "No ports to forward." : "ssh master is down."}
          </p>
        ) : (
          forwarded.map((port) => (
            <div key={port} className="port-row">
              <span className="port-num">
                {port}
                <span className="port-state on">live</span>
              </span>
              <button className="btn btn-sm" onClick={() => openUrl(`http://localhost:${port}`)}>
                <ExternalLink size={13} strokeWidth={2} />
                Open
              </button>
            </div>
          ))
        )}
      </div>
    </>
  );
}
