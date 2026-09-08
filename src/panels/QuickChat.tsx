import { AsyncButton } from "../ui/AsyncButton";
import { useRef, useState } from "react";
import { ChevronDown, MessageSquare } from "lucide-react";
import { deviceHost } from "../devices";
import { openQuickChat } from "../serverApi";
import { useStore } from "../state/store";
import { DEFAULT_WORKSPACE_ID } from "../workspaces";
import { DeviceIcon } from "../ui/DeviceIcon";
import { IconButton } from "../ui/IconButton";
import { Modal } from "../ui/Modal";
import { Select } from "../ui/Select";

interface Defaults { deviceId: string; agent: "claude" | "codex" }
const KEY = "pzza.quickChat.defaults";
function readDefaults(): Defaults | null {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value && typeof value === "object" && "deviceId" in value && typeof value.deviceId === "string" &&
        "agent" in value && (value.agent === "claude" || value.agent === "codex")) {
      return { deviceId: value.deviceId, agent: value.agent };
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  return null;
}

export function QuickChat() {
  const devices = useStore(state => state.devices);
  const [defaults, setDefaults] = useState(readDefaults);
  const [deviceId, setDeviceId] = useState(defaults?.deviceId ?? devices[0]?.id ?? "");
  const [agent, setAgent] = useState<Defaults["agent"]>(defaults?.agent ?? "claude");
  const [remember, setRemember] = useState(true);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const inflight = useRef(false);

  const launch = async (choice: Defaults, save: boolean) => {
    if (inflight.current) return;
    setDeviceId(choice.deviceId);
    setAgent(choice.agent);
    const device = devices.find(item => item.id === choice.deviceId);
    if (!device) {
      setMessage("Your saved device is no longer available. Choose another device.");
      setOpen(true);
      return;
    }
    inflight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await openQuickChat(deviceHost(device), choice.agent);
      const store = useStore.getState();
      const id = result.host ? `${result.host}::${result.session}` : result.session;
      store.unhideTile(id);
      store.setWorkspace(store.sessionWs[id] ?? DEFAULT_WORKSPACE_ID);
      store.openSession(result.session, undefined, result.host);
      if (save) {
        setDefaults(choice);
        try { localStorage.setItem(KEY, JSON.stringify(choice)); }
        catch { setMessage("Quick Chat opened, but your default could not be saved in browser storage."); setOpen(true); return; }
      }
      if (result.agent !== choice.agent) {
        setMessage(`Reopened the existing ${result.agent === "claude" ? "Claude" : "Codex"} session. Terminate that session before starting a different agent on this device.`);
        setOpen(true);
      } else setOpen(false);
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open Quick Chat. Choose another device or retry.");
      setRemember(false);
      setOpen(true);
    } finally { inflight.current = false; setBusy(false); }
  };

  return <>
    <div style={{ display: "flex", alignItems: "center", gap: 0 }}>
      <IconButton icon={MessageSquare} title="Quick Chat" loading={busy}
        onClick={() => {
          if (defaults) void launch(defaults, false);
          else { setMessage(""); setRemember(true); setOpen(true); }
        }} />
      <IconButton icon={ChevronDown} size={12} title="Quick Chat settings" disabled={busy}
        onClick={() => { setMessage(""); setRemember(true); setOpen(true); }} />
    </div>
    <Modal open={open} onClose={() => setOpen(false)} title="Quick Chat" icon={MessageSquare} size="sm">
      <div className="menu-body">
        <p className="muted">One reusable terminal per device. Choose your default for one-click access.</p>
        <div className="ns-row">
          <span className="ns-row-label">Agent</span>
          <div className="ns-row-control"><Select value={agent} options={[{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }]}
            onChange={value => { if (!inflight.current && (value === "claude" || value === "codex")) setAgent(value); }} /></div>
        </div>
        <div className="ns-row">
          <span className="ns-row-label">Device</span>
          <div className="ns-row-control"><Select value={deviceId} placeholder="Choose a device"
            options={devices.map(device => ({ value: device.id, label: device.name, icon: <DeviceIcon device={device} /> }))}
            onChange={value => { if (!inflight.current) setDeviceId(value); }} /></div>
        </div>
        <label style={{ display: "flex", alignItems: "center", gap: 8, margin: "12px 0" }}>
          <input type="checkbox" checked={remember} disabled={busy} onChange={event => setRemember(event.target.checked)} />
          Use this agent and device by default
        </label>
        <p className="muted">Starts in the device’s home folder using its installed agent and login. Closing the terminal window keeps the session running.</p>
        <p className="muted">Switching devices does not transfer the conversation or stop a session on an unreachable device. An existing session keeps its current agent until terminated.</p>
        {message && <p role="status">{message}</p>}
        <AsyncButton className="btn btn-accent" loading={busy} icon={MessageSquare} disabled={!devices.some(device => device.id === deviceId)}
          onClick={() => void launch({ deviceId, agent }, remember)}>Open Quick Chat</AsyncButton>
      </div>
    </Modal>
  </>;
}
