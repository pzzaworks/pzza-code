import { DeviceInfo } from "./DeviceInfo";
import { LiveSessionIcon } from "../ui/LiveSessionIcon";
import { confirmEditorDiscard } from "../editorChanges";
import { DeviceIcon } from "../ui/DeviceIcon";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
import { useStore } from "../state/store";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { scanDevice, killSession, fetchSshHosts, type SshHost } from "../serverApi";
import type { RemoteSession } from "../connection";
import { sessionDisplayName } from "../sessionMeta";
import { deviceHost, type Device } from "../devices";

interface ScanState {
  loading: boolean;
  sessions: RemoteSession[];
  error: string | null;
}

// Manage devices, and scan each one for its real tmux sessions (even ones the
// app never opened) to add, move, or terminate them.
export function DevicesMenu() {
  const devices = useStore((s) => s.devices);
  const connectionHost = useStore((s) => s.connection.host);
  const addDevice = useStore((s) => s.addDevice);
  const removeDevice = useStore((s) => s.removeDevice);
  const workspaces = useStore((s) => s.workspaces);
  const tiles = useStore((s) => s.tiles);
  const tileTitles = useStore((s) => s.tileTitles);
  const sessionWs = useStore((s) => s.sessionWs);
  const openSession = useStore((s) => s.openSession);
  const assignSession = useStore((s) => s.assignSession);
  const closeTile = useStore((s) => s.closeTile);

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [detected, setDetected] = useState<SshHost[]>([]);
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);
  const [openDev, setOpenDev] = useState<string | null>(null);
  const [scans, setScans] = useState<Record<string, ScanState>>({});
  const [terminating, setTerminating] = useState(false);
  const [killError, setKillError] = useState<string | null>(null);
  const [killing, setKilling] = useState<{
    session: string;
    host: string;
    deviceId: string;
    open: boolean;
  } | null>(null);

  const scanRequests = useRef(new Map<string, symbol>());
  const mounted = useRef(true);
  const isLocalDevice = (device: Device) => device.id === "this-mac";
  const scanHost = deviceHost;

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      scanRequests.current.clear();
    };
  }, []);

  const runScan = useCallback((device: Device) => {
    const request = Symbol();
    scanRequests.current.set(device.id, request);
    const current = () => mounted.current && scanRequests.current.get(device.id) === request;
    setScans((scans) => ({ ...scans, [device.id]: { loading: true, sessions: [], error: null } }));
    void scanDevice(deviceHost(device)).then((sessions) => {
      if (current()) setScans((scans) => ({ ...scans, [device.id]: { loading: false, sessions, error: null } }));
    }).catch((error: unknown) => {
      if (current()) setScans((scans) => ({
        ...scans,
        [device.id]: { loading: false, sessions: [], error: error instanceof Error ? error.message : String(error) },
      }));
    });
  }, []);

  useEffect(() => {
    const refresh = (event: Event) => {
      if (!(event instanceof CustomEvent)) return;
      const detail: unknown = event.detail;
      if (typeof detail !== "object" || detail === null || !("host" in detail)) return;
      const host = typeof detail.host === "string" ? detail.host : "";
      const changed = devices.filter((device) => deviceHost(device) === host);
      for (const device of changed) {
        scanRequests.current.set(device.id, Symbol());
      }
      setScans((current) => {
        const next = { ...current };
        for (const device of changed) delete next[device.id];
        return next;
      });
      const expanded = changed.find((device) => device.id === openDev);
      if (expanded) runScan(expanded);
    };
    window.addEventListener("pzza:sessions-changed", refresh);
    return () => window.removeEventListener("pzza:sessions-changed", refresh);
  }, [devices, openDev, runScan]);

  const toggleDevice = (d: Device) => {
    if (openDev === d.id) {
      setOpenDev(null);
      return;
    }
    setOpenDev(d.id);
    runScan(d);
  };

  // Auto-discover SSH targets from ~/.ssh/config that are not added yet, to
  // offer as one-click fill chips in the add form.
  useEffect(() => {
    fetchSshHosts()
      .then((r) =>
        setDetected(
          r.hosts.filter((h) => !devices.some((d) => d.host === h.host || d.host === h.hostname)),
        ),
      )
      .catch(() => setDetected([]));
  }, [devices]);

  const submit = () => {
    if (!name.trim() || !host.trim()) return;
    addDevice(name, host, user);
    setName("");
    setHost("");
    setUser("");
  };

  const useDetected = (h: SshHost) => {
    setName(h.host);
    setHost(h.host);
    setUser(h.user ?? "");
  };

  const wsOptions = [
    { value: "", label: "Add to workspace..." },
    ...workspaces.map((w) => ({ value: w.id, label: w.name })),
  ];

  const terminate = async () => {
    if (!killing || terminating) return;
    const { session, host } = killing;
    setTerminating(true);
    setKillError(null);
    try {
      const affected = tiles.filter((tile) => (tile.host ?? connectionHost ?? "") === host && (tile.session ?? tile.name) === session);
      if (!await confirmEditorDiscard(affected.map((tile) => tile.id))) return;
      await killSession(session, undefined, host);
      for (const tile of affected) closeTile(tile.id);
      setKilling(null);

    } catch (error) {
      setKillError(error instanceof Error ? error.message : String(error));
    } finally {
      setTerminating(false);
    }
  };

  return (
    <div className="menu-body device-info-panel">
      <div className="menu-title">Devices</div>

      <div className="device-list">
        {devices.map((d) => {
          const isLocal = isLocalDevice(d);
          const isCurrent = isLocal; // the local device is the one the app drives directly
          const expanded = openDev === d.id;
          const scan = scans[d.id];
          return (
            <div key={d.id} className={`device-block ${expanded ? "on" : ""}`}>
              <div className="device-row device-row-click" onClick={() => toggleDevice(d)}>
                {expanded ? (
                  <ChevronDown size={14} className="muted-icon" />
                ) : (
                  <ChevronRight size={14} className="muted-icon" />
                )}
                <DeviceIcon device={d} size={15} />
                <span className="device-main">
                  <span className="device-name">
                    {d.name}
                    {isLocal ? <span className="device-tag">current</span> : null}
                  </span>
                  <span className="device-sub">
                    {d.user ? `${d.user}@` : ""}
                    {d.host}
                  </span>
                </span>
                {!isCurrent && !isLocal && devices.length > 1 ? (
                  <button
                    className="icon-btn icon-btn-danger"
                    title="Remove device"
                    onClick={(e) => {
                      e.stopPropagation();
                      setPending({ id: d.id, name: d.name });
                    }}
                  >
                    <Trash2 size={14} />
                  </button>
                ) : null}
              </div>

              {expanded ? (
                <div className="device-scan">
                  <DeviceInfo key={scanHost(d)} device={d} />
                  <div className="device-scan-head">
                    <span className="device-scan-title">
                      Sessions
                      {(() => {
                        const n = (scan?.sessions ?? []).filter(
                          (s) => !s.name.startsWith("pzza-v-"),
                        ).length;
                        return n ? <span className="field-hint">{n}</span> : null;
                      })()}
                    </span>
                    <button
                      className="usage-refresh"
                      title="Re-scan"
                      onClick={() => runScan(d)}
                      disabled={scan?.loading}
                    >
                      <RefreshCw size={12} className={scan?.loading ? "sw-spin" : ""} />
                    </button>
                  </div>

                  {scan?.loading ? (
                    <div className="scan-empty">
                      <Loader2 size={14} className="sw-spin" /> Scanning...
                    </div>
                  ) : scan?.error ? (
                    <div className="scan-empty scan-err">Could not scan: {scan.error}</div>
                  ) : !scan ||
                    scan.sessions.filter((s) => !s.name.startsWith("pzza-v-")).length === 0 ? (
                    <div className="scan-empty muted">No tmux sessions on this device.</div>
                  ) : (
                    scan.sessions
                      // Hide the app's internal window-view sessions.
                      .filter((s) => !s.name.startsWith("pzza-v-"))
                      .map((sess) => {
                      // A remote session opens over ssh; its tile id and workspace
                      // key are namespaced by host so devices never collide.
                      const host = scanHost(d);
                      const tileId = host ? `${host}::${sess.name}` : sess.name;
                      const isOpen = tiles.some((t) => t.id === tileId);
                      const wsId = sessionWs[tileId] ?? "";
                      return (
                        <div className="scan-row" key={sess.name}>
                          <span className="scan-icon">
                            <LiveSessionIcon session={sess.name} host={host} size={13} />
                          </span>
                          <span className="scan-main">
                            <span className="scan-name">{sessionDisplayName({ id: tileId, name: sess.name }, tileTitles)}</span>
                            <span className="scan-meta">
                              {sess.windows}w{sess.attached ? " · live" : ""}
                              {isOpen ? " · open" : ""}
                            </span>
                          </span>
                          <div className="scan-ws">
                            <Select
                              value={wsId}
                              options={wsOptions}
                              placeholder={isOpen ? "Move..." : "Add..."}
                              onChange={(v) => {
                                if (!v) return;
                                openSession(sess.name, undefined, host);
                                assignSession(tileId, v);
                              }}
                            />
                          </div>
                          <button
                            className="icon-btn icon-btn-danger"
                            title="Terminate"
                            onClick={() =>
                              setKilling({
                                session: sess.name,
                                host: scanHost(d),
                                deviceId: d.id,
                                open: isOpen,
                              })
                            }
                          >
                            <Trash2 size={13} />
                          </button>
                        </div>
                      );
                    })
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </div>

      <div className="device-add">
        {detected.length > 0 ? (
          <div className="sw-detected" style={{ marginBottom: 10 }}>
            <span className="sw-detected-label">From ~/.ssh/config</span>
            <div className="sw-chips">
              {detected.map((h) => (
                <button
                  key={h.host}
                  type="button"
                  className={`sw-chip ${host === h.host ? "on" : ""}`}
                  title={`${h.user ? `${h.user}@` : ""}${h.hostname ?? h.host}`}
                  onClick={() => useDetected(h)}
                >
                  {h.host}
                </button>
              ))}
            </div>
          </div>
        ) : null}
        <input
          className="field-input"
          placeholder="Name"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <div className="device-add-row">
          <input
            className="field-input"
            placeholder="host / IP"
            value={host}
            onChange={(e) => setHost(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
          <input
            className="field-input device-user"
            placeholder="user"
            value={user}
            onChange={(e) => setUser(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && submit()}
          />
        </div>
        <button
          className="btn btn-accent device-add-btn"
          onClick={submit}
          disabled={!name.trim() || !host.trim()}
        >
          <Plus size={14} strokeWidth={2.2} />
          Add device
        </button>
      </div>

      <Modal open={!!pending} onClose={() => setPending(null)} title="Remove device" size="sm">
        {pending ? (
          <>
            <p className="move-q">
              Remove <b>{pending.name}</b>? RDP / forwarding configs pointing at it fall back to
              another device.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setPending(null)}>
                Cancel
              </button>
              <button
                className="btn btn-danger"
                onClick={() => {
                  removeDevice(pending.id);
                  setPending(null);
                }}
              >
                Remove
              </button>
            </div>
          </>
        ) : null}
      </Modal>

      <Modal open={!!killing} onClose={() => { if (!terminating) { setKilling(null); setKillError(null); } }} title="Terminate session" size="sm">
        {killing ? (
          <>
            <p className="move-q">
              Terminate <b>{sessionDisplayName({ id: killing.host ? `${killing.host}::${killing.session}` : killing.session, name: killing.session }, tileTitles)}</b>? This kills the tmux session and
              everything running in it - it cannot be undone.
            </p>
            {killError ? <p className="pj-error" role="alert">{killError}</p> : null}
            <div className="modal-actions">
              <button className="btn" disabled={terminating} onClick={() => { setKilling(null); setKillError(null); }}>
                Cancel
              </button>
              <button className="btn btn-danger" disabled={terminating} onClick={() => void terminate()}>
                <Trash2 size={14} strokeWidth={2} />
                {terminating ? "Terminating…" : "Terminate"}
              </button>
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
