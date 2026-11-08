import { LiveSessionIcon } from "../ui/LiveSessionIcon";
import { DeviceIcon } from "../ui/DeviceIcon";
import { useEffect, useId, useRef, useState } from "react";
import { ChevronRight, CornerDownLeft, Eye, FilePen, GitBranch, History, LayoutGrid, ListChecks, ShieldCheck, ShieldOff, Sparkles, SquareTerminal, UserRound, X, type LucideIcon } from "lucide-react";
import { useStore } from "../state/store";
import { tileTitle, sessionDisplayName } from "../sessionMeta";
import { Select } from "../ui/Select";
import { HAS_TAURI } from "../tauriEnv";
import { createSessionInApp, useSessionCreation } from "../sessionActions";
import { fetchAccounts, type Account } from "../serverApi";
import { SESSION_NAME_MAX_LENGTH } from "../../server/lib/session-name.js";
import { SESSION_AGENTS, SESSION_PROMPT_MAX_LENGTH, sessionAgent, type SessionAgentChoice } from "../../server/lib/session-agents.js";
import { consumeNewSessionRequest, useNewSessionRequest } from "../state/newSession";
import { deviceHost } from "../devices";
import { PathField } from "../ui/PathField";
import { compactPath } from "../grid/compactPath";
import { ClaudeIcon, CodexIcon, OpenCodeIcon } from "../icons/BrandIcons";

const DEVICE_KEY = "pzza.session.device";
// The name length is only worth showing when it gets close to the limit.
const SESSION_NAME_COUNTER_FROM = 100;

const AGENT_ICONS: Record<SessionAgentChoice["id"], typeof ClaudeIcon> = { claude: ClaudeIcon, codex: CodexIcon, opencode: OpenCodeIcon };
const MODE_ICONS: Record<string, LucideIcon> = { default: ShieldCheck, acceptEdits: FilePen, plan: ListChecks, auto: Sparkles, readOnly: Eye, bypass: ShieldOff };

const RECENT_FOLDERS_KEY = "pzza.session.recentFolders.v1";
const RECENT_FOLDERS_MAX = 5;

export function readRecentFolders(): Record<string, string[]> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(RECENT_FOLDERS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, string[]> = {};
    for (const [device, paths] of Object.entries(value)) {
      if (Array.isArray(paths)) out[device] = paths.filter((p): p is string => typeof p === "string" && p.startsWith("/") && p.length <= 4096).slice(0, RECENT_FOLDERS_MAX);
    }
    return out;
  } catch {
    return {};
  }
}

// Folders are remembered per device, since a path only means something there.
function recentFolders(deviceId: string): string[] {
  return readRecentFolders()[deviceId] ?? [];
}

function rememberFolder(deviceId: string, path: string) {
  const all = readRecentFolders();
  all[deviceId] = [path, ...(all[deviceId] ?? []).filter((p) => p !== path)].slice(0, RECENT_FOLDERS_MAX);
  try {
    localStorage.setItem(RECENT_FOLDERS_KEY, JSON.stringify(all));
  } catch {
    /* ignore */
  }
}

const FOLDER_AGENTS_KEY = "pzza.session.folderAgents.v1";
const FOLDER_AGENTS_MAX = 100;

// Agent and mode last used per device folder; null records "plain terminal".
function readFolderAgents(): Record<string, SessionAgentChoice | null> {
  try {
    const value: unknown = JSON.parse(localStorage.getItem(FOLDER_AGENTS_KEY) ?? "{}");
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const out: Record<string, SessionAgentChoice | null> = {};
    for (const [key, choice] of Object.entries(value)) {
      if (choice === null) { out[key] = null; continue; }
      if (!choice || typeof choice !== "object" || !("id" in choice) || !("mode" in choice)) continue;
      const agent = sessionAgent(choice.id);
      if (agent && agent.modes.some((mode) => mode.id === choice.mode)) out[key] = { id: agent.id, mode: String(choice.mode) };
    }
    return out;
  } catch {
    return {};
  }
}

function folderAgent(deviceId: string, folder: string): SessionAgentChoice | null | undefined {
  return readFolderAgents()[`${deviceId}\n${folder}`];
}

function rememberFolderAgent(deviceId: string, folder: string, agent: SessionAgentChoice | null) {
  const all = readFolderAgents();
  const key = `${deviceId}\n${folder}`;
  delete all[key];
  all[key] = agent ? { id: agent.id, mode: agent.mode } : null;
  const entries = Object.entries(all);
  try {
    localStorage.setItem(FOLDER_AGENTS_KEY, JSON.stringify(Object.fromEntries(entries.slice(Math.max(0, entries.length - FOLDER_AGENTS_MAX)))));
  } catch {
    /* ignore */
  }
}

const folderLabel = (path: string) => path.replace(/\/+$/, "").split("/").pop() || path;


// New-session dropdown content: choose the device, workspace, working folder
// and an optional coding agent, then create a named session or open an
// existing one.
export function SessionMenu({ close }: { close: () => void }) {
  const allWindows = useStore((s) => s.allWindows);
  const tiles = useStore((s) => s.tiles);
  const tileTitles = useStore((s) => s.tileTitles);
  const openWindow = useStore((s) => s.openWindow);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const devices = useStore((s) => s.activeDevices);
  const activeId = useStore((s) => s.activeId);
  const allSessions = useStore((s) => s.allSessions);

  const [name, setName] = useState("");
  const nameLimitId = useId();
  const creating = useSessionCreation(state => state.operation?.status === "running");
  const [creationError, setCreationError] = useState<string | null>(null);
  const [wsId, setWsId] = useState(activeWorkspaceId);
  const [savedDeviceId, setDeviceId] = useState(() => {
    try {
      return localStorage.getItem(DEVICE_KEY) ?? devices[0]?.id ?? "";
    } catch {
      return devices[0]?.id ?? "";
    }
  });
  // A saved device that was disabled or removed falls back to this device.
  const deviceId = devices.some((d) => d.id === savedDeviceId) ? savedDeviceId : (devices[0]?.id ?? "");

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accDir, setAccDir] = useState("");
  // The folder belongs to the selected device; empty means the device's home.
  const [folder, setFolder] = useState("");
  // A new session starts as a plain terminal; a folder can bring back the agent last used there.
  const [agent, setAgent] = useState<SessionAgentChoice | null>(null);
  const device = devices.find((d) => d.id === deviceId);
  const host = device ? deviceHost(device) : "";
  const agentDefinition = agent ? sessionAgent(agent.id) : undefined;

  const [prompt, setPrompt] = useState("");
  const [resume, setResume] = useState(false);
  const [worktree, setWorktree] = useState(false);
  // A folder chosen together with its device (a canvas drop) survives the
  // device switch that would otherwise reset the folder.
  const pendingFolder = useRef<string | null>(null);

  useEffect(() => setWsId(activeWorkspaceId), [activeWorkspaceId]);
  useEffect(() => {
    setFolder(pendingFolder.current ?? "");
    pendingFolder.current = null;
  }, [deviceId]);
  useEffect(() => { if (!folder) setWorktree(false); }, [folder]);

  // One-click folders: the active tile's folder when it lives on the selected
  // device, then this device's recent session folders.
  const activeTile = tiles.find((t) => t.id === activeId);
  const activeFolder = activeTile && (activeTile.host ?? "") === host
    ? activeTile.path ?? allSessions.find((s) => s.name === (activeTile.session ?? activeTile.name))?.path ?? activeTile.cwd
    : undefined;
  const folderShortcuts = [
    ...(activeFolder?.startsWith("/") ? [{ path: activeFolder, label: "This tile's folder", current: true }] : []),
    ...recentFolders(deviceId).filter((path) => path !== activeFolder).map((path) => ({ path, label: folderLabel(path), current: false })),
  ].slice(0, 4);

  useEffect(() => {
    if (HAS_TAURI) return;
    fetchAccounts()
      .then(setAccounts)
      .catch(() => setAccounts([]));
  }, []);

  const pickDevice = (id: string) => {
    setDeviceId(id);
    try {
      localStorage.setItem(DEVICE_KEY, id);
    } catch {
      /* ignore */
    }
  };

  const chooseAgent = (next: SessionAgentChoice | null) => setAgent(next);

  // A folder brings back the agent and mode last used there, without changing
  // the global default.
  const chooseFolder = (path: string) => {
    setFolder(path);
    const remembered = folderAgent(deviceId, path);
    if (remembered !== undefined) setAgent(remembered);
  };

  // A folder dropped on the canvas opens this form with that folder chosen.
  const newSessionRequest = useNewSessionRequest((s) => s.request);
  useEffect(() => {
    if (!newSessionRequest) return;
    const request = consumeNewSessionRequest();
    if (!request) return;
    const target = devices.find((d) => deviceHost(d) === request.host);
    if (target && target.id !== deviceId) {
      pendingFolder.current = request.folder;
      pickDevice(target.id);
    } else if (target) chooseFolder(request.folder);
  }, [newSessionRequest]);

  const counts: Record<string, number> = {};
  for (const w of allWindows) counts[w.session] = (counts[w.session] ?? 0) + 1;

  const winDefaultName = (w: (typeof allWindows)[number]) =>
    (counts[w.session] ?? 1) > 1
      ? `${tileTitle(w.session)} · ${w.windowName}`
      : tileTitle(w.session);

  const winDisplay = (w: (typeof allWindows)[number]) =>
    sessionDisplayName({
      id: `${w.session}::w::${w.window}`,
      name: winDefaultName(w),
      session: w.session,
      window: w.window,
    }, tileTitles);

  const isWindowOpen = (w: (typeof allWindows)[number]) =>
    tiles.some(
      (t) =>
        !t.host && ((t.session === w.session && t.window === w.window) ||
        (t.id === w.session && w.active)),
    );
  const available = allWindows.filter((w) => !isWindowOpen(w));

  const createNew = async () => {
    if (!name.trim() || creating) return;
    setCreationError(null);
    const account = accounts.find(item => item.dir === accDir);
    try {
      const launch = agent ? { ...agent, ...(resume ? { resume: true } : {}), ...(prompt.trim() ? { prompt: prompt.trim() } : {}) } : undefined;
      await createSessionInApp({ name, deviceId, workspaceId: wsId, cwd: folder || undefined, worktree: worktree && !!folder, agent: launch, account: account ? { provider: account.provider, dir: account.dir } : undefined });
      if (folder) { rememberFolder(deviceId, folder); rememberFolderAgent(deviceId, folder, agent); }
      setName(""); setAccDir(""); setFolder(""); setPrompt(""); setResume(false); setWorktree(false); close();
    } catch (error) { setCreationError(error instanceof Error ? error.message : "Could not create the session."); }
  };

  const nameTooLong = name.length >= SESSION_NAME_COUNTER_FROM;
  const bypass = agent?.mode === "bypass";

  return (
    <div className="menu-body new-session-form">
      {/* Command bar: one composer box for the name and, with an agent, its first prompt. */}
      <div className={`ns-composer ${agent ? "has-prompt" : ""}`}>
        <div className="ns-composer-line">
          <SquareTerminal size={16} className="muted-icon" />
          <input
            className="ns-input"
            disabled={creating}
            aria-label="New session name"
            aria-describedby={nameTooLong ? nameLimitId : undefined}
            maxLength={SESSION_NAME_MAX_LENGTH}
            autoFocus
            placeholder="Name your session…"
            value={name}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") void createNew(); }}
          />
          {nameTooLong ? <span className="ns-name-limit" id={nameLimitId}>{name.length}/{SESSION_NAME_MAX_LENGTH}</span> : null}
          <button className="btn btn-accent ns-create" onClick={() => void createNew()} disabled={!name.trim() || creating}>
            {creating ? "Creating…" : "Create"}
            <CornerDownLeft size={12} strokeWidth={2.2} />
          </button>
        </div>
        {agent ? (
          <textarea
            className="ns-prompt"
            rows={1}
            disabled={creating}
            aria-label="Starting prompt"
            maxLength={SESSION_PROMPT_MAX_LENGTH}
            placeholder={`First prompt for ${agentDefinition?.label ?? "the agent"} (optional)…`}
            value={prompt}
            // One line only: a newline would submit the agent command early,
            // so Enter creates the session and pasted line breaks become spaces.
            onChange={(e) => setPrompt(e.target.value.replace(/[\r\n]+/g, " "))}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void createNew(); } }}
          />
        ) : null}
      </div>

      {/* Where and what, as one segmented bar: device, folder, terminal or agent. */}
      <div className="ns-seg" role="group" aria-label="Session device, folder and agent">
        <Select
          value={deviceId}
          disabled={creating}
          ariaLabel="Session device"
          className="ns-pill"
          onChange={pickDevice}
          options={devices.map((d) => ({ value: d.id, label: d.name, sub: d.host, icon: <DeviceIcon device={d} /> }))}
        />
        <span className={`ns-pill-path ${folder ? "has-value" : ""}`}>
          <PathField
            key={deviceId}
            value={folder ? compactPath(folder) : ""}
            mode="folder"
            host={host}
            fixedHost
            disabled={creating}
            placeholder="Home folder"
            title={folder || "Choose a folder"}
            pickerTitle={`Choose a folder on ${device?.name ?? "this device"}`}
            className="ns-pill"
            start={folder || undefined}
            onChange={(path) => chooseFolder(path)}
          />
          {folder ? (
            <button type="button" className="ns-clear" title="Use the home folder" aria-label="Use the home folder" disabled={creating} onClick={() => setFolder("")}>
              <X size={11} />
            </button>
          ) : null}
        </span>
        <Select
          value={agent?.id ?? ""}
          disabled={creating}
          ariaLabel="Agent to start"
          className="ns-pill"
          onChange={(id) => {
            const next = sessionAgent(id);
            chooseAgent(next ? { id: next.id, mode: agent?.id === next.id ? agent.mode : next.modes[0].id } : null);
          }}
          options={[
            { value: "", label: "Terminal", icon: <SquareTerminal size={13} /> },
            ...SESSION_AGENTS.map((a) => {
              const Icon = AGENT_ICONS[a.id];
              return { value: a.id, label: a.label, icon: <Icon size={13} /> };
            }),
          ]}
        />
      </div>

      {/* Options that apply only sometimes: the agent's mode, continuing its last
          conversation, a worktree, and workspace or account when there is a choice. */}
      {agent || folder || workspaces.length > 1 || accounts.length > 0 ? (
        <div className="ns-seg ns-seg-extra" role="group" aria-label="Session options">
          {agent && agentDefinition ? (
            <Select
              value={agent.mode}
              disabled={creating}
              className={`ns-pill ns-mode ${bypass ? "ns-mode-danger" : ""}`}
              ariaLabel={`${agentDefinition.label} mode`}
              title={`${agentDefinition.label} mode: ${agentDefinition.modes.find((m) => m.id === agent.mode)?.description ?? ""}`}
              onChange={(mode) => chooseAgent({ id: agent.id, mode })}
              options={agentDefinition.modes.map((m) => {
                const Icon = MODE_ICONS[m.id] ?? ShieldCheck;
                return { value: m.id, label: m.label, sub: m.description, icon: <Icon size={13} /> };
              })}
            />
          ) : null}
          {agent ? (
            <button type="button" className={`ns-toggle ${resume ? "on" : ""}`} aria-pressed={resume} aria-label="Continue last" disabled={creating} onClick={() => setResume(!resume)}
              title="Continue the most recent conversation in this folder instead of starting a new one">
              <History size={12} /> Continue
            </button>
          ) : null}
          {folder ? (
            <button type="button" className={`ns-toggle ${worktree ? "on" : ""}`} aria-pressed={worktree} aria-label="New worktree" disabled={creating} onClick={() => setWorktree(!worktree)}
              title="New worktree: a git worktree on a new pzza/<name> branch next to the repository, so parallel agents never share a checkout">
              <GitBranch size={12} /> Worktree
            </button>
          ) : null}
          {workspaces.length > 1 ? (
            <Select
              value={wsId}
              disabled={creating}
              ariaLabel="Session workspace"
              className="ns-pill"
              onChange={setWsId}
              options={workspaces.map((w) => ({ value: w.id, label: w.name, icon: <LayoutGrid size={13} /> }))}
            />
          ) : null}
          {accounts.length > 0 ? (
            <Select
              value={accDir}
              disabled={creating}
              ariaLabel="Session account"
              className="ns-pill"
              onChange={setAccDir}
              options={[
                { value: "", label: "Default account", icon: <UserRound size={13} /> },
                ...accounts.map((a) => ({
                  value: a.dir,
                  label: `${a.provider === "codex" ? "Codex" : "Claude"} · ${a.label}`,
                  sub: a.email,
                  icon: <UserRound size={13} />,
                })),
              ]}
            />
          ) : null}
        </div>
      ) : null}

      {bypass ? <p className="ns-warning" role="note"><ShieldOff size={11} /> Bypass runs every command without asking</p> : null}

      {/* Errors, else recent folders: one quiet line, only when there is one. */}
      {creationError || folderShortcuts.length > 0 ? <div className="ns-actions">
        {creationError ? <p className="ns-error" role="alert">{creationError}</p>
          : (
            <div className="ns-suggest" aria-label="Quick folders">
              <span className="ns-suggest-label">Recent</span>
              {folderShortcuts.map((item) => (
                <button
                  key={item.path}
                  type="button"
                  className={`ns-suggest-item ${item.path === folder ? "on" : ""}`}
                  title={item.path}
                  disabled={creating}
                  onClick={() => chooseFolder(item.path)}
                >
                  {item.label}
                </button>
              ))}
            </div>
          )}
      </div> : null}
      {available.length > 0 ? (
        <>
          <div className="ns-divider">
            <span>open a terminal</span>
          </div>
          <div className="session-picker">
            {available.map((w) => (
              <button
                key={`${w.session}::w::${w.window}`}
                className="session-pick"
                onClick={() => {
                  openWindow(w, winDefaultName(w));
                  close();
                }}
              >
                <span className="session-pick-icon">
                  <LiveSessionIcon session={w.session} window={w.window} size={15} />
                </span>
                <span className="session-pick-main">
                  <span className="session-pick-name">{winDisplay(w)}</span>
                  <span className="session-pick-sub">
                    {w.command || w.windowName}
                    {w.active ? " · active" : ""}
                  </span>
                </span>
                <ChevronRight size={16} className="session-pick-arrow" />
              </button>
            ))}
          </div>
        </>
      ) : null}
    </div>
  );
}
