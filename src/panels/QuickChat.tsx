import { AsyncButton } from "../ui/AsyncButton";
import { useCallback, useEffect, useRef } from "react";
import { MessageSquare, RotateCw, TriangleAlert, X } from "lucide-react";
import { create } from "zustand";
import { deviceHost, THIS_MAC, type Device } from "../devices";
import { attachCommand } from "../connection";
import { openQuickChat, closeQuickChat, fetchSessionActivity } from "../serverApi";
import { rowAgent } from "../ui/LiveSessionIcon";
import { createQuickChatPreparation, type AttachmentStatus } from "../state/quickChatSession";
import { useStore } from "../state/store";
import { Terminal } from "../terminal/Terminal";
import { DeviceIcon } from "../ui/DeviceIcon";
import { Dropdown } from "../ui/Dropdown";
import { IconButton } from "../ui/IconButton";
import { Select } from "../ui/Select";
import { AgentIcon } from "../icons/AgentIcon";
import { sessionAgent, validAgentAccount, type SessionAgentId } from "../../server/lib/session-agents.js";
import { agentSelectOptions } from "../agentChoices";
import "./QuickChat.css";

interface Defaults { deviceId: string; agent: SessionAgentId }
const KEY = "pzza.quickChat.defaults";
const QUICK_CHAT_AGENT_OPTIONS = agentSelectOptions().map(option => ({ ...option, icon: <AgentIcon id={option.value} size={13} /> }));

function readDefaults(): Defaults {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(KEY) ?? "null");
    if (value && typeof value === "object" && "deviceId" in value && typeof value.deviceId === "string" &&
        "agent" in value) {
      // An agent the catalog does not know falls back to Claude Code.
      return { deviceId: value.deviceId, agent: sessionAgent(value.agent)?.id ?? "claude" };
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
    const previous = get().defaults;
    const defaults = { ...previous, ...change };
    let notice = "";
    try { localStorage.setItem(KEY, JSON.stringify(defaults)); }
    catch { notice = "Your choice applies now, but could not be saved on this device."; }
    const previousDeviceId = previous.deviceId;
    const nextDefaults = defaults;
    set({ defaults, notice });
    if (previous.deviceId === defaults.deviceId && previous.agent === defaults.agent) return;
    // Stop attachment retries on the outgoing conversation, then close its
    // fixed-name session before dropping it: otherwise the next launch would
    // reattach to the previous agent and the new profile would never open.
    // Closing is idempotent, and the chat is only cleared after it settles so
    // the relaunch cannot reuse the session being replaced.
    window.dispatchEvent(new Event("pzza:quick-chat-cancel"));
    void (async () => {
      const chat = useQuickChatView.getState().chat;
      const devices = useStore.getState().devices;
      const device = devices.find(item => item.id === previousDeviceId) ?? devices.find(item => item.id === nextDefaults.deviceId);
      const host = chat?.host ?? (device ? deviceHost(device) : "");
      try { await closeQuickChat(host); }
      catch { /* A foreign or unreachable session stays put; opening reports it. */ }
      // The closed conversation must not be reused: drop every cached session
      // so the relaunch below opens the newly selected device/agent instead
      // of reattaching to the previous session.
      prepareChat.evict();
      useQuickChatView.setState({ chat: null, error: "", attachment: null });
    })();
  },
}));

// When the chosen device is disabled, Quick Chat moves back to this device
// (closing the chat on the disabled one) instead of pointing at a hidden device.
export function releaseDisabledQuickChatDevice(devices: Device[]): void {
  const { defaults, update } = useQuickChatPreferences.getState();
  if (devices.some(device => device.id === defaults.deviceId && device.disabled)) update({ deviceId: THIS_MAC.id });
}

// Quick Chat always opens the agent in its default mode. Most agents default to
// one that asks first; an agent with no asking mode at all (Amp) is called out,
// since its chat runs tools in your home folder without asking.
function QuickChatModeNote({ agent }: { agent: SessionAgentId }) {
  const definition = sessionAgent(agent);
  const start = definition?.modes.find(mode => mode.id === definition.defaultMode);
  if (definition && start?.approval === "bypass") {
    return <p className="set-note quick-chat-mode-warning" role="note">
      <TriangleAlert size={12} aria-hidden="true" />
      <span>{definition.label} has no mode that asks first: it runs tools in your home folder without asking, unless its own settings turn permissions on.</span>
    </p>;
  }
  return <p className="set-note">The agent opens directly in its default mode, the one that asks before changes.</p>;
}

export function QuickChatSettings() {
  const devices = useStore(state => state.activeDevices);
  const { defaults, notice, update } = useQuickChatPreferences();
  const deviceAvailable = devices.some(device => device.id === defaults.deviceId);
  return <div className="quick-chat-settings">
    <section className="settings-section">
      <div className="settings-form">
        <label className="settings-field"><span>Profile</span><Select value={defaults.agent} options={QUICK_CHAT_AGENT_OPTIONS}
          onChange={value => { const agent = sessionAgent(value); if (agent) update({ agent: agent.id }); }} /></label>
        <label className="settings-field"><span>Device</span><Select value={defaults.deviceId} placeholder="Choose a device"
          options={devices.map(device => ({ value: device.id, label: device.name, icon: <DeviceIcon device={device} /> }))}
          onChange={deviceId => update({ deviceId })} /></label>
      </div>
      <QuickChatModeNote agent={defaults.agent} />
      {!deviceAvailable && <p className="set-note" role="status">Your saved device is unavailable. Choose another device.</p>}
      {notice && <p className="set-note" role="status">{notice}</p>}
    </section>
    <section className="settings-section">
        <div className="settings-row-copy"><span>Keep your conversation</span><small>Hiding the dropdown keeps your chat running. Reopening the app reuses its existing conversation. Changing the device or agent closes the current conversation and opens the new profile.</small></div>
    </section>
  </div>;
}

type Chat = Awaited<ReturnType<typeof openQuickChat>> & { deviceName: string };

function chatSummary(chat: Chat): string {
  return `${chat.deviceName} · ${sessionAgent(chat.agent)?.label ?? chat.agent}`;
}

// The account folder (CLAUDE_CONFIG_DIR) last seen for each device and agent,
// so Quick Chat keeps it while none of that agent's sessions run.
const ACCOUNTS_KEY = "pzza.quickChat.accounts.v1";

function savedAccounts(): Record<string, string | null> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(ACCOUNTS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    return Object.fromEntries(Object.entries(value).filter(([key, account]) => {
      const agent = sessionAgent(JSON.parse(key)?.[1]);
      return account === null || validAgentAccount(agent, account);
    }));
  } catch { return {}; }
}

/**
 * The account the agent's own sessions on the device run with: the one most
 * of them use right now (a shell function such as
 * `CLAUDE_CONFIG_DIR=~/.claude-work claude` included), else the one seen last.
 * Undefined means the agent's default account.
 */
export async function quickChatAccount(host: string, agent: SessionAgentId): Promise<string | undefined> {
  const definition = sessionAgent(agent);
  if (!definition?.account) return undefined;
  const key = JSON.stringify([host, agent]);
  const saved = savedAccounts();
  const rows = await fetchSessionActivity(host, AbortSignal.timeout(5000)).catch(() => []);
  const counts = new Map<string | null, number>();
  for (const row of rows) {
    if (rowAgent(row) !== agent || row.launch?.accountUnusable) continue;
    const account = validAgentAccount(definition, row.launch?.account) ? row.launch.account : null;
    counts.set(account, (counts.get(account) ?? 0) + 1);
  }
  if (counts.size) {
    const [account] = [...counts].sort((left, right) => right[1] - left[1])[0];
    try { localStorage.setItem(ACCOUNTS_KEY, JSON.stringify({ ...saved, [key]: account })); }
    catch { /* Storage can be unavailable in private browsing. */ }
    return account ?? undefined;
  }
  return saved[key] ?? undefined;
}

const prepareChat = createQuickChatPreparation((host, agent) => quickChatAccount(host, agent).then(account => openQuickChat(host, agent, account)));
// A conversation that ends sooner than this after opening is not reopened on
// its own (the agent keeps exiting): the user opens the next one.
const REOPEN_AFTER_MS = 30_000;
// When this app first saw each conversation (host and identity): reattaching
// to an older one must not make it look new.
const firstSeen = new Map<string, number>();
function seenSince(chat: Pick<Chat, "host" | "identity">): number {
  const key = `${chat.host}\0${chat.identity}`;
  if (!firstSeen.has(key)) firstSeen.set(key, Date.now());
  return firstSeen.get(key) ?? Date.now();
}
export const useQuickChatView = create<{
  open: boolean; busy: boolean; chat: Chat | null; error: string; attachment: AttachmentStatus | null; retryToken: number;
}>(() => ({ open: false, busy: false, chat: null, error: "", attachment: null, retryToken: 0 }));

export function QuickChat({ onOpenSettings }: { onOpenSettings?: () => void }) {
  const devices = useStore(state => state.activeDevices);
  const { chat, busy, error: message, open: panelOpen, attachment, retryToken } = useQuickChatView();
  const setChat = (value: Chat) => useQuickChatView.setState({ chat: value });
  const setBusy = (value: boolean) => useQuickChatView.setState({ busy: value });
  const setMessage = (value: string) => useQuickChatView.setState({ error: value });
  const inflight = useRef(false);
  // Set when a conversation ended right after opening, or while the panel was
  // closed: only opening the panel (or the button) starts the next one.
  const reopenPaused = useRef(false);
  const wasOpen = useRef(panelOpen);

  const launch = useCallback(async (manual = false) => {
    const choice = useQuickChatPreferences.getState().defaults;
    if (inflight.current || chat || (reopenPaused.current && !manual)) return;
    reopenPaused.current = false;
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
      seenSince(result);
      setChat({ ...result, deviceName: device.name });
    } catch (error) {
      setMessage(error instanceof Error ? error.message : "Could not open Quick Chat. Retry or choose another device.");
    } finally { inflight.current = false; setBusy(false); }
  }, [chat, devices]);

  useEffect(() => { void launch(); }, [launch]);
  useEffect(() => {
    // Opening the panel (the toolbar, a shortcut or app control) asks for a
    // chat, even after a paused reopen; staying open does not ask again.
    const opened = panelOpen && !wasOpen.current;
    wasOpen.current = panelOpen;
    if (panelOpen) void launch(opened);
  }, [panelOpen, launch]);
  // The conversation is gone (the terminal server restarted, or the agent
  // exited): drop it. In view, a new one opens right away, as Quick Chat
  // does on demand; out of view, it opens the next time the panel does, so
  // an agent the user exited is not started again behind their back.
  useEffect(() => {
    if (attachment?.phase !== "ended" || !chat) return;
    prepareChat.evict(chat.host, chat.agent);
    const quick = Date.now() - seenSince(chat) < REOPEN_AFTER_MS;
    reopenPaused.current = quick || !useQuickChatView.getState().open;
    useQuickChatView.setState({ chat: null, attachment: null, error: quick ? "Your chat ended right after it opened. Open a new chat to try again." : "" });
  }, [attachment, chat]);

  const command = chat ? attachCommand({ host: chat.host || null }, chat.session, undefined, undefined, chat) : null;
  return <Dropdown controlId="quick_chat" icon={MessageSquare} title="Quick Chat" width={620} keepMounted preload={Boolean(chat)} loading={busy}
    panelClassName="quick-chat-panel" tourId="quick-chat" controlledOpen={panelOpen} onOpenChange={value => useQuickChatView.setState({ open: value })} onOpen={() => {
      if (!chat) void launch(true);
    }}>
    {(dismiss, open) => <>
      <div className="quick-chat-header">
        <div><span className="menu-head-title">Quick Chat</span><span className="muted">{chat ? chatSummary(chat) : busy ? "Opening your chat…" : "Your conversation"}</span></div>
        <div className="quick-chat-actions">
          <IconButton icon={X} title="Hide chat" onClick={dismiss} />
        </div>
      </div>
      {!chat && <div className="quick-chat-empty">
        {busy ? <p className="muted" role="status">Connecting to your agent…</p> : <div className="quick-chat-actions">
          <AsyncButton loading={busy} icon={RotateCw} onClick={() => void launch(true)}>{message ? "Retry" : "Open chat"}</AsyncButton>
          {onOpenSettings && <button type="button" className="btn" onClick={() => { dismiss(); onOpenSettings(); }}>Open settings</button>}
        </div>}
      </div>}
      {message && <p className="quick-chat-message" role="status">{message}</p>}
      {chat && command && <div className="quick-chat-terminal">
        <Terminal key={`${chat.host}::${chat.session}::${chat.agent}::${chat.identity}`} tileId={`quick-chat:${chat.host}`} name={chat.session} host={chat.host}
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
