import { AsyncButton } from "../ui/AsyncButton";
import { DeviceIcon } from "../ui/DeviceIcon";
import { useEffect, useState } from "react";
import { create } from "zustand";
import { Monitor } from "lucide-react";
import { useStore } from "../state/store";
import { notify } from "../state/notifications";
import { THIS_MAC, deviceHost } from "../devices";
import { rdpIsOpen, rdpLaunch } from "../rdp";
import { HAS_TAURI } from "../tauriEnv";
import { Select } from "../ui/Select";

const SERVER_KEY = "pzza.rdp.serverDev";
const RDP_USER = "pzzacode";
function savedServer() {
  try { return localStorage.getItem(SERVER_KEY) ?? ""; } catch { return ""; }
}
export const useRdpConnection = create<{ serverId: string; busy: boolean }>(() => ({ serverId: savedServer(), busy: false }));

export async function openSaved(): Promise<boolean> {
  if (useRdpConnection.getState().busy) return false;
  const { devices, deviceRdp, setDeviceRdp } = useStore.getState();
  const server = devices.find(device => device.id === useRdpConnection.getState().serverId);
  if (!HAS_TAURI || !server || server.id === THIS_MAC.id || !server.host.trim()) {
    notify({ category: "app", title: "Remote desktop unavailable", body: !HAS_TAURI ? "Open the desktop app to launch remote desktop." : "Choose a remote server in Settings → Connections → Remote desktop, then click Remote desktop again." });
    return false;
  }
  useRdpConnection.setState({ busy: true });
  try {
    const config = deviceRdp[server.id];
    const user = config?.user ?? RDP_USER;
    const keychainService = config?.keychainService ?? `pzzacode-rdp-${server.id}`;
    if (await rdpIsOpen(keychainService)) {
      notify({ category: "app", title: "Remote desktop is already open", body: `Switch to the existing desktop window for ${server.name}.` });
      return true;
    }
    const result = await rdpLaunch({ host: deviceHost(server), user, keychainService });
    setDeviceRdp(server.id, { user, keychainService, port: result.port, mode: result.mode });
    return true;
  } catch (error) {
    notify({ category: "app", title: "Could not open remote desktop", body: `Check the server in Settings → Connections → Remote desktop and its SSH connection. ${String(error)}` });
    return false;
  } finally { useRdpConnection.setState({ busy: false }); }
}

export function configureRemoteDesktop(serverId: string, user?: string): void {
  const { devices, deviceRdp, setDeviceRdp } = useStore.getState();
  const server = devices.find(device => device.id === serverId && device.id !== THIS_MAC.id);
  if (!server) throw new Error("Choose a configured remote device.");
  if (user !== undefined) {
    if (!/^[A-Za-z_][A-Za-z0-9_-]{0,63}$/.test(user)) throw new Error("Choose a valid remote desktop account.");
    const current = deviceRdp[serverId];
    setDeviceRdp(serverId, { ...current, user, keychainService: current?.keychainService ?? `pzzacode-rdp-${serverId}` });
  }
  localStorage.setItem(SERVER_KEY, serverId);
  useRdpConnection.setState({ serverId });
}

export function useRemoteDesktop() {
  const busy = useRdpConnection(state => state.busy);
  return { busy, openSaved };
}

export function RdpMenu({ close }: { close: () => void }) {
  const devices = useStore(state => state.devices);
  const deviceRdp = useStore(state => state.deviceRdp);
  const serverId = useRdpConnection(state => state.serverId);
  const { busy, openSaved: launch } = useRemoteDesktop();
  const [alreadyOpen, setAlreadyOpen] = useState(false);
  const server = devices.find(device => device.id === serverId);
  const config = server ? deviceRdp[server.id] : undefined;
  const remote = !!server && server.id !== THIS_MAC.id;
  const keychainService = server ? config?.keychainService ?? `pzzacode-rdp-${server.id}` : "";
  useEffect(() => {
    setAlreadyOpen(false);
    if (!remote || !HAS_TAURI) return;
    let alive = true;
    void rdpIsOpen(keychainService).then(value => { if (alive) setAlreadyOpen(value); }).catch(() => undefined);
    return () => { alive = false; };
  }, [remote, keychainService, busy]);

  const pickServer = (id: string) => {
    configureRemoteDesktop(id);
  };
  return <div className="settings-page remote-settings">
    <section className="settings-section" aria-label="Saved connection">
      <div className="settings-form">
        <div className="settings-field"><span>Remote server</span><Select value={serverId} onChange={pickServer} placeholder="Choose a remote server" options={devices.filter(device => device.id !== THIS_MAC.id).map(device => ({ value: device.id, label: device.name, sub: device.host, icon: <DeviceIcon device={device} /> }))} /><small>Used by the Remote desktop toolbar button.</small></div>
      </div>
      <div className="settings-row"><div className="settings-row-copy"><span>Desktop viewer</span><small>Always opens on this device.</small></div><span>{devices.find(device => device.id === THIS_MAC.id)?.name ?? THIS_MAC.name}</span></div>
      <div className="settings-actions"><AsyncButton className="btn btn-accent btn-sm" loading={busy} icon={Monitor} disabled={!remote || alreadyOpen} onClick={async () => { if (await launch()) close(); }}>{alreadyOpen ? "Desktop open" : "Open desktop"}</AsyncButton><span className="set-hint">SSH-tunneled RDP</span></div>
    </section>
    {!remote ? <p className="settings-empty">{devices.some(device => device.id !== THIS_MAC.id) ? "Choose a remote server to save this connection." : "Add a remote device in Settings → Devices first."}</p> : config?.mode ? <div className="settings-row"><div className="settings-row-copy"><span>{server.name}</span><small>Configured · {config.mode} · Port {config.port}</small></div></div> : null}
  </div>;
}
