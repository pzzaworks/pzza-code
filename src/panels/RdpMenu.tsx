import { useEffect, useState } from "react";
import { Loader2, Monitor } from "lucide-react";
import { useStore } from "../state/store";
import { rdpIsOpen, rdpLaunch } from "../rdp";
import { HAS_TAURI } from "../tauriEnv";
import { Select } from "../ui/Select";

const SERVER_KEY = "pzza.rdp.serverDev";
const CLIENT_KEY = "pzza.rdp.clientDev";
const RDP_USER = "pzzacode";

function loadKey(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

// RDP dropdown: both ends are picked from the managed device list. Server is
// the device whose desktop opens; client is where the viewer runs. "Open
// desktop" is the only step: the first launch creates the RDP account and its
// Keychain password, and every launch re-syncs the device before connecting.
export function RdpMenu({ close }: { close: () => void }) {
  const devices = useStore((s) => s.devices);
  const deviceRdp = useStore((s) => s.deviceRdp);
  const setDeviceRdp = useStore((s) => s.setDeviceRdp);
  const [serverId, setServerId] = useState(() =>
    loadKey(SERVER_KEY, devices.find((d) => d.id !== "this-mac")?.id ?? devices[0]?.id ?? ""),
  );
  const [clientId, setClientId] = useState(() =>
    loadKey(CLIENT_KEY, devices.find((d) => d.id === "this-mac")?.id ?? devices[0]?.id ?? ""),
  );
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [alreadyOpen, setAlreadyOpen] = useState(false);

  const server = devices.find((d) => d.id === serverId) ?? devices[0];
  const client = devices.find((d) => d.id === clientId);
  const rdp = server ? deviceRdp[server.id] : undefined;
  const remote = !!server && server.id !== "this-mac";
  const keychainService = server ? (rdp?.keychainService ?? `pzzacode-rdp-${server.id}`) : "";

  // Reflect whether this device's desktop is already open, so the button
  // becomes a no-op "Desktop open" instead of stacking a second window.
  useEffect(() => {
    if (!remote || !HAS_TAURI || !keychainService) {
      setAlreadyOpen(false);
      return;
    }
    let alive = true;
    rdpIsOpen(keychainService)
      .then((v) => alive && setAlreadyOpen(v))
      .catch(() => undefined);
    return () => {
      alive = false;
    };
  }, [remote, keychainService]);

  const pick = (setter: (v: string) => void, key: string) => (id: string) => {
    setter(id);
    try {
      localStorage.setItem(key, id);
    } catch {
      /* ignore */
    }
  };

  const launch = async () => {
    if (!server || !remote || busy || alreadyOpen) return;
    setBusy(true);
    setMsg(null);
    try {
      const user = rdp?.user ?? RDP_USER;
      const r = await rdpLaunch({
        host: server.user ? `${server.user}@${server.host}` : server.host,
        user,
        keychainService,
      });
      setDeviceRdp(server.id, { user, keychainService, port: r.port, mode: r.mode });
      close();
    } catch (e) {
      setMsg(HAS_TAURI ? String(e) : "Runs in the native app - it launches FreeRDP on the client.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="menu-body">
      <div className="menu-title">{server?.name ?? "device"} · desktop</div>
      <p className="set-note" style={{ marginTop: 0 }}>
        Opens {server?.name ?? "the server"}'s Linux desktop on {client?.name ?? "the client"} over ssh-tunneled RDP.
      </p>

      <div className="field" style={{ marginTop: 12 }}>
        <span className="field-label">Server</span>
        <Select
          value={serverId}
          onChange={pick(setServerId, SERVER_KEY)}
          options={devices.map((d) => ({ value: d.id, label: d.name, sub: d.host }))}
        />
      </div>
      <div className="field">
        <span className="field-label">Client</span>
        <Select
          value={clientId}
          onChange={pick(setClientId, CLIENT_KEY)}
          options={devices.map((d) => ({ value: d.id, label: d.name, sub: d.host }))}
        />
      </div>

      <button
        className="btn btn-accent rdp-open"
        onClick={launch}
        disabled={!remote || busy || alreadyOpen}
      >
        {busy ? <Loader2 size={14} className="sw-spin" /> : <Monitor size={14} strokeWidth={2} />}
        {busy ? "Opening…" : alreadyOpen ? "Desktop open" : "Open desktop"}
      </button>
      {!remote ? (
        <p className="set-note">Pick a remote device as the server.</p>
      ) : busy ? null : msg ? (
        <p className="set-note">{msg}</p>
      ) : alreadyOpen ? (
        <p className="set-note">The desktop is already open for {server?.name}.</p>
      ) : rdp?.mode ? (
        <p className="set-note">
          Remote desktop ready on {server?.name} ({rdp.mode}, port {rdp.port}).
        </p>
      ) : null}
    </div>
  );
}
