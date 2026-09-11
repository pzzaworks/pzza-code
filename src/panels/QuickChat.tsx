import { AsyncButton } from "../ui/AsyncButton";
import { useCallback, useEffect, useRef } from "react";
import { MessageSquare, RotateCw, X } from "lucide-react";
import { create } from "zustand";
import { deviceHost, THIS_MAC } from "../devices";
import { attachCommand } from "../connection";
import { openQuickChat } from "../serverApi";
import { createQuickChatPreparation, type AttachmentStatus } from "../state/quickChatSession";
import { useStore } from "../state/store";
import { Terminal } from "../terminal/Terminal";
import { DeviceIcon } from "../ui/DeviceIcon";
import { Dropdown } from "../ui/Dropdown";
import { IconButton } from "../ui/IconButton";
import { Select } from "../ui/Select";
import "./QuickChat.css";

interface Defaults { deviceId: string; agent: "claude" | "codex" | "opencode" }
const KEY = "pzza.quickChat.defaults";
function readDefaults(): Defaults {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value && typeof value === "object" && "deviceId" in value && typeof value.deviceId === "string" &&
        "agent" in value && (value.agent === "claude" || value.agent === "codex" || value.agent === "opencode")) {
      return { deviceId: value.deviceId, agent: value.agent };
    }
  } catch { /* Storage can be unavailable in private browsing. */ }
  return { deviceId: THIS_MAC.id, agent: "claude" };
}

interface QuickChatPreferences {
  defaults: Defaults;
  notice: string;
  update: (change: Partial<Defaults>) => void;
}

export const useQuickChatPreferences = create<QuickChatPreferences>((set, get) => ({
  defaults: readDefaults(),
  notice: "",
  update: change => {
    const defaults = { ...get().defaults, ...change };
    let notice = "";
    try { localStorage.setItem(KEY, JSON.stringify(defaults)); }
    catch { notice = "Your choice applies now, but could not be saved on this device."; }
    const previous = get().defaults;
    set({ defaults, notice });
    if (previous.deviceId !== defaults.deviceId || previous.agent !== defaults.agent) window.dispatchEvent(new Event("pzza:quick-chat-cancel"));
  },
}));

export function QuickChatSettings() {
  const devices = useStore(state => state.devices);
  const { defaults, notice, update } = useQuickChatPreferences();
  const deviceAvailable = devices.some(device => device.id === defaults.deviceId);
  return <div className="quick-chat-settings">
    <section className="settings-section">
      <div className="settings-form">
        <label className="settings-field"><span>Profile</span><Select value={defaults.agent} options={[{ value: "claude", label: "Claude" }, { value: "codex", label: "Codex" }, { value: "opencode", label: "OpenCode" }]}
          onChange={value => { if (value === "claude" || value === "codex" || value === "opencode") update({ agent: value }); }} /></label>
        <label className="settings-field"><span>Device</span><Select value={defaults.deviceId} placeholder="Choose a device"
          options={devices.map(device => ({ value: device.id, label: device.name, icon: <DeviceIcon device={device} /> }))}
          onChange={deviceId => update({ deviceId })} /></label>
      </div>
      <p className="set-note">Claude opens Claude directly. Codex opens Codex directly. OpenCode opens OpenCode directly.</p>
      {!deviceAvailable && <p className="set-note" role="status">Your saved device is unavailable. Choose another device.</p>}
      {notice && <p className="set-note" role="status">{notice}</p>}
    </section>
    <section className="settings-section">
      <div className="settings-row-copy"><span>Keep your conversation</span><small>Hiding the dropdown keeps your chat running. Reopening the app reuses its existing conversation. Device and agent choices apply on the next launch; changing them stops current attachment retries.</small></div>
    </section>
  </div>;
}

type Chat = Awaited<ReturnType<typeof openQuickChat>> & { deviceName: string };

function chatSummary(chat: Chat): string {
  return `${chat.deviceName} · ${chat.agent === "claude" ? "Claude" : chat.agent === "codex" ? "Codex" : "OpenCode"}`;
}

const prepareChat = createQuickChatPreparation(openQuickChat);
export const useQuickChatView = create<{
  open: boolean; busy: boolean; chat: Chat | null; error: string; attachment: AttachmentStatus | null; retryToken: number;
}>(() => ({ open: false, busy: false, chat: null, error: "", attachment: null, retryToken: 0 }));

export function QuickChat({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const devices = useStore(state => state.devices);
  const { chat, busy, error: message, open: panelOpen, attachment, retryToken } = useQuickChatView();
  const setChat = (value: Chat) => useQuickChatView.setState({ chat: value });
  const setBusy = (value: boolean) => useQuickChatView.setState({ busy: value });
  const setMessage = (value: string) => useQuickChatView.setState({ error: value });
  const inflight = useRef(false);

  const launch = useCallback(async () => {
    const choice = useQuickChatPreferences.getState().defaults;
    if (inflight.current || chat) return;
    const device = devices.find(item => item.id === choice.deviceId);
    if (!device) {
      setMessage("Choose an available device to open your chat.");
      return;
    }
    inflight.current = true;
    setBusy(true);
    setMessage("");
    try {
      const result = await prepareChat(deviceHost(device), choice.agent);
      const id = result.host ? `${result.host}::${result.session}` : result.session;
      useStore.getState().hideTile(id);
      setChat({ ...result, deviceName: device.name });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open Quick Chat. Retry or choose another device.");
    } finally { inflight.current = false; setBusy(false); }
  }, [chat, devices]);

  useEffect(() => { void launch(); }, [launch]);
  useEffect(() => { if (panelOpen) void launch(); }, [panelOpen, launch]);

  const command = chat ? attachCommand({ host: chat.host || null }, chat.session, undefined, undefined, chat) : null;
  return <Dropdown controlId="quick_chat" icon={MessageSquare} title="Quick Chat" width={620} keepMounted preload={Boolean(chat)} loading={busy}
    panelClassName="quick-chat-panel" controlledOpen={panelOpen} onOpenChange={value => useQuickChatView.setState({ open: value })} onOpen={() => {
      if (!chat) void launch();
    }}>
    {(dismiss, open) => <>
      <div className="quick-chat-header">
        <div><strong>Quick Chat</strong><span className="muted">{chat ? chatSummary(chat) : busy ? "Opening your chat…" : "Your conversation"}</span></div>
        <div className="quick-chat-actions">
          <IconButton icon={X} title="Hide chat" onClick={dismiss} />
        </div>
      </div>
      {!chat && <div className="quick-chat-empty">
        {busy ? <p className="muted" role="status">Connecting to your agent…</p> : <div className="quick-chat-actions">
          <AsyncButton loading={busy} icon={RotateCw} onClick={() => void launch()}>{message ? "Retry" : "Open chat"}</AsyncButton>
          {onOpenSettings && <button type="button" className="btn" onClick={() => { dismiss(); onOpenSettings(); }}>Open settings</button>}
        </div>}
      </div>}
      {message && <p className="quick-chat-message" role="status">{message}</p>}
      {chat && command && <div className="quick-chat-terminal">
        <Terminal key={`${chat.host}::${chat.session}`} tileId={`quick-chat:${chat.host}`} name={chat.session} host={chat.host}
          cmd={command.cmd} args={command.args} active={open} managedChat={chat} retryToken={retryToken}
          onAttachment={value => useQuickChatView.setState({ attachment: value })} />
      </div>}
      {chat && <div className="quick-chat-footer">
        <span className="muted" role="status" aria-live="polite">{attachment?.phase === "retrying"
          ? `Reconnecting (${attachment.attempt}/6)${attachment.delayMs ? ` in ${(attachment.delayMs / 1000).toFixed(1)}s` : ""}. ${attachment.message}`
          : attachment?.phase === "disconnected" || attachment?.phase === "connecting" ? attachment.message : "Connected. Hiding keeps your chat running."}</span>
        {attachment?.phase === "disconnected" && <button type="button" className="btn" onClick={() => useQuickChatView.setState(state => ({ retryToken: state.retryToken + 1 }))}>Retry attachment</button>}
      </div>}
    </>}
  </Dropdown>;
}
