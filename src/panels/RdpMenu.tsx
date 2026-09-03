import { useState } from "react";
import { Monitor } from "lucide-react";
import { useStore } from "../state/store";
import { RDP_DEFAULTS, rdpLaunch } from "../rdp";
import { HAS_TAURI } from "../tauriEnv";
import { Select } from "../ui/Select";

const SERVER_KEY = "pzza.rdp.serverDev";
const CLIENT_KEY = "pzza.rdp.clientDev";

function loadKey(key: string, fallback: string) {
  try {
    return localStorage.getItem(key) ?? fallback;
  } catch {
    return fallback;
  }
}

// RDP dropdown: both ends are picked from the managed device list. Server is
// the device whose desktop opens; client is where the viewer runs.
export function RdpMenu({ close }: { close: () => void }) {
  const devices = useStore((s) => s.devices);
  const [serverId, setServerId] = useState(() => loadKey(SERVER_KEY, devices[0]?.id ?? ""));
  const [clientId, setClientId] = useState(() =>
    loadKey(CLIENT_KEY, devices.find((d) => d.id === "this-mac")?.id ?? devices[0]?.id ?? ""),
  );
  const [msg, setMsg] = useState<string | null>(null);

  const server = devices.find((d) => d.id === serverId) ?? devices[0];
  const client = devices.find((d) => d.id === clientId);

  const pickServer = (id: string) => {
    setServerId(id);
    try {
      localStorage.setItem(SERVER_KEY, id);
    } catch {
      /* ignore */
    }
  };
  const pickClient = (id: string) => {
    setClientId(id);
    try {
      localStorage.setItem(CLIENT_KEY, id);
    } catch {
      /* ignore */
    }
  };

  const launch = async () => {
    if (!server) return;
    setMsg("opening…");
    try {
      await rdpLaunch({ ...RDP_DEFAULTS, host: server.host, user: server.user ?? RDP_DEFAULTS.user });
      setMsg(null);
      close();
    } catch (e) {
      setMsg(
        HAS_TAURI
          ? String(e)
          : "Runs in the native app - it launches FreeRDP on the client machine.",
      );
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
          onChange={pickServer}
          options={devices.map((d) => ({ value: d.id, label: d.name, sub: d.host }))}
        />
      </div>
      <div className="field">
        <span className="field-label">Client</span>
        <Select
          value={clientId}
          onChange={pickClient}
          options={devices.map((d) => ({ value: d.id, label: d.name, sub: d.host }))}
        />
      </div>

      <button className="btn btn-accent rdp-open" onClick={launch} disabled={!server}>
        <Monitor size={14} strokeWidth={2} />
        Open desktop
      </button>
      {msg ? <p className="set-note">{msg}</p> : null}
    </div>
  );
}
