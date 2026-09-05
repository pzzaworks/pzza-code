import { useState } from "react";
import { Monitor, ServerCog } from "lucide-react";
import { useStore } from "../state/store";
import { RDP_DEFAULTS, rdpLaunch, rdpProvision, keychainSet, randomSecret } from "../rdp";
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
// the device whose desktop opens; client is where the viewer runs. A server the
// wizard has not provisioned yet shows a one-click "Enable remote desktop" that
// configures GNOME Remote Desktop over SSH and stores its password in Keychain.
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

  const server = devices.find((d) => d.id === serverId) ?? devices[0];
  const client = devices.find((d) => d.id === clientId);
  const rdp = server ? deviceRdp[server.id] : undefined;
  const sshTarget = server ? (server.user ? `${server.user}@${server.host}` : server.host) : "";

  const pick = (setter: (v: string) => void, key: string) => (id: string) => {
    setter(id);
    try {
      localStorage.setItem(key, id);
    } catch {
      /* ignore */
    }
  };

  const provision = async () => {
    if (!server || busy) return;
    setBusy(true);
    setMsg("Setting up remote desktop over SSH…");
    try {
      const user = "pzzacode";
      const password = randomSecret();
      const service = `pzzacode-rdp-${server.id}`;
      const certFingerprint = await rdpProvision({ target: sshTarget, user, password });
      await keychainSet(service, user, password);
      setDeviceRdp(server.id, { user, certFingerprint, keychainService: service });
      setMsg("Remote desktop enabled.");
    } catch (e) {
      setMsg(String(e));
    } finally {
      setBusy(false);
    }
  };

  const launch = async () => {
    if (!server || !rdp) return;
    setBusy(true);
    setMsg("Opening…");
    try {
      await rdpLaunch({
        ...RDP_DEFAULTS,
        host: server.host,
        user: rdp.user,
        certFingerprint: rdp.certFingerprint,
        keychainService: rdp.keychainService,
      });
      setMsg(null);
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

      {rdp ? (
        <button className="btn btn-accent rdp-open" onClick={launch} disabled={!server || busy}>
          <Monitor size={14} strokeWidth={2} />
          Open desktop
        </button>
      ) : (
        <button
          className="btn btn-accent rdp-open"
          onClick={provision}
          disabled={!server || server.id === "this-mac" || busy}
        >
          <ServerCog size={14} strokeWidth={2} />
          {busy ? "Enabling…" : "Enable remote desktop"}
        </button>
      )}
      {server?.id === "this-mac" && !rdp ? (
        <p className="set-note">Pick a remote device as the server.</p>
      ) : null}
      {msg ? <p className="set-note">{msg}</p> : null}
    </div>
  );
}
