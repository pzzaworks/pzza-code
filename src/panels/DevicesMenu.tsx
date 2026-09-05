import { useState } from "react";
import {
  ChevronDown,
  ChevronRight,
  Laptop,
  Loader2,
  Plus,
  RefreshCw,
  Server,
  Trash2,
} from "lucide-react";
import { useStore } from "../state/store";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";
import { scanDevice, killSession } from "../serverApi";
import type { RemoteSession } from "../connection";
import { sessionIcon, iconColor, tileTitle } from "../sessionMeta";
import type { Device } from "../devices";

interface ScanState {
  loading: boolean;
  sessions: RemoteSession[];
  error: string | null;
}

// Manage devices, and scan each one for its real tmux sessions (even ones the
// app never opened) to add, move, or terminate them.
export function DevicesMenu() {
  const devices = useStore((s) => s.devices);
  const addDevice = useStore((s) => s.addDevice);
  const removeDevice = useStore((s) => s.removeDevice);
  const workspaces = useStore((s) => s.workspaces);
  const tiles = useStore((s) => s.tiles);
  const sessionWs = useStore((s) => s.sessionWs);
  const openSession = useStore((s) => s.openSession);
  const assignSession = useStore((s) => s.assignSession);
  const closeTile = useStore((s) => s.closeTile);

  const [name, setName] = useState("");
  const [host, setHost] = useState("");
  const [user, setUser] = useState("");
  const [pending, setPending] = useState<{ id: string; name: string } | null>(null);
  const [openDev, setOpenDev] = useState<string | null>(null);
  const [scans, setScans] = useState<Record<string, ScanState>>({});
  const [killing, setKilling] = useState<{
    session: string;
    host: string;
    deviceId: string;
    open: boolean;
  } | null>(null);

  // The local device (this Mac) runs the agent, so its tmux is reached with an
  // empty host; every other device is reached over ssh. This is what decides how
  // we scan and kill - independent of which device is the default for new sessions.
  const isLocalDevice = (d: Device) => d.id === "this-mac";
  const sshTarget = (d: Device) => (d.user ? `${d.user}@${d.host}` : d.host);
  const scanHost = (d: Device) => (isLocalDevice(d) ? "" : sshTarget(d));

  const runScan = (d: Device) => {
    setScans((s) => ({ ...s, [d.id]: { loading: true, sessions: [], error: null } }));
    scanDevice(scanHost(d))
      .then((sessions) =>
        setScans((s) => ({ ...s, [d.id]: { loading: false, sessions, error: null } })),
      )
      .catch((e) =>
        setScans((s) => ({
          ...s,
          [d.id]: { loading: false, sessions: [], error: String(e?.message || e) },
        })),
      );
  };

  const toggleDevice = (d: Device) => {
    if (openDev === d.id) {
      setOpenDev(null);
      return;
    }
    setOpenDev(d.id);
    if (!scans[d.id]) runScan(d);
  };

  const submit = () => {
    if (!name.trim() || !host.trim()) return;
    addDevice(name, host, user);
    setName("");
    setHost("");
    setUser("");
  };

  const wsOptions = [
    { value: "", label: "Add to workspace..." },
    ...workspaces.map((w) => ({ value: w.id, label: w.name })),
  ];

  const terminate = async () => {
    if (!killing) return;
    const { session, host, deviceId } = killing;
    // Drop any tiles pointing at this session first so nothing reattaches to it,
    // then kill it on its device.
    for (const t of tiles) {
      if ((t.session ?? t.name) === session) closeTile(t.id);
    }
    await killSession(session, undefined, host || undefined);
    setKilling(null);
    // Re-scan that device so the list reflects the kill (and surfaces a session
    // that a supervisor immediately respawned, instead of silently doing nothing).
    const dev = devices.find((d) => d.id === deviceId);
    if (dev) runScan(dev);
  };

  return (
    <div className="menu-body">
      <div className="menu-title">Devices</div>

      <div className="device-list">
        {devices.map((d) => {
          const isLocal = isLocalDevice(d);
          const isCurrent = isLocal; // the local device is the one the app drives directly
          const Icon = isLocal ? Laptop : Server;
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
                <Icon size={15} className="muted-icon" />
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
                      const SIcon = sessionIcon(sess.name, sess.command);
                      const col = iconColor(sess.name, sess.command);
                      const isOpen = tiles.some((t) => (t.session ?? t.name) === sess.name);
                      const wsId = sessionWs[sess.name] ?? "";
                      return (
                        <div className="scan-row" key={sess.name}>
                          <span className="scan-icon" style={col ? { color: col } : undefined}>
                            <SIcon size={13} />
                          </span>
                          <span className="scan-main">
                            <span className="scan-name">{tileTitle(sess.name)}</span>
                            <span className="scan-meta">
                              {sess.windows}w{sess.attached ? " · live" : ""}
                              {isOpen ? " · open" : ""}
                            </span>
                          </span>
                          {isCurrent ? (
                            <div className="scan-ws">
                              <Select
                                value={wsId}
                                options={wsOptions}
                                placeholder={isOpen ? "Move..." : "Add..."}
                                onChange={(v) => {
                                  if (!v) return;
                                  openSession(sess.name);
                                  assignSession(sess.name, v);
                                }}
                              />
                            </div>
                          ) : (
                            <span className="scan-remote-note" title="Connect this device to open its sessions">
                              remote
                            </span>
                          )}
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

      <Modal open={!!killing} onClose={() => setKilling(null)} title="Terminate session" size="sm">
        {killing ? (
          <>
            <p className="move-q">
              Terminate <b>{tileTitle(killing.session)}</b>? This kills the tmux session and
              everything running in it - it cannot be undone.
            </p>
            <div className="modal-actions">
              <button className="btn" onClick={() => setKilling(null)}>
                Cancel
              </button>
              <button className="btn btn-danger" onClick={terminate}>
                <Trash2 size={14} strokeWidth={2} />
                Terminate
              </button>
            </div>
          </>
        ) : null}
      </Modal>
    </div>
  );
}
