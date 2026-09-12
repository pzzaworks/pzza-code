import { LiveSessionIcon } from "../ui/LiveSessionIcon";
import { DeviceIcon } from "../ui/DeviceIcon";
import { useEffect, useId, useState } from "react";
import { ChevronRight, CornerDownLeft, SquareTerminal } from "lucide-react";
import { useStore } from "../state/store";
import { tileTitle, sessionDisplayName } from "../sessionMeta";
import { Select } from "../ui/Select";
import { HAS_TAURI } from "../tauriEnv";
import { createSessionInApp, useSessionCreation } from "../sessionActions";
import { fetchAccounts, type Account } from "../serverApi";
import { SESSION_NAME_MAX_LENGTH } from "../../server/lib/session-name.js";

const DEVICE_KEY = "pzza.session.device";

// New-session dropdown content: choose the device to open on and the workspace,
// then create a named session or open an existing one.
export function SessionMenu({ close }: { close: () => void }) {
  const allWindows = useStore((s) => s.allWindows);
  const tiles = useStore((s) => s.tiles);
  const tileTitles = useStore((s) => s.tileTitles);
  const openWindow = useStore((s) => s.openWindow);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const devices = useStore((s) => s.devices);

  const [name, setName] = useState("");
  const nameLimitId = useId();
  const creating = useSessionCreation(state => state.operation?.status === "running");
  const [creationError, setCreationError] = useState<string | null>(null);
  const [wsId, setWsId] = useState(activeWorkspaceId);
  const [deviceId, setDeviceId] = useState(() => {
    try {
      return localStorage.getItem(DEVICE_KEY) ?? devices[0]?.id ?? "";
    } catch {
      return devices[0]?.id ?? "";
    }
  });

  const [accounts, setAccounts] = useState<Account[]>([]);
  const [accDir, setAccDir] = useState("");

  useEffect(() => setWsId(activeWorkspaceId), [activeWorkspaceId]);

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
      await createSessionInApp({ name, deviceId, workspaceId: wsId, account: account ? { provider: account.provider, dir: account.dir } : undefined });
      setName(""); setAccDir(""); close();
    } catch (error) { setCreationError(error instanceof Error ? error.message : "Could not create the session."); }
  };

  return (
    <div className="menu-body new-session-form">
      <div className="ns-row">
        <span className="ns-row-label">Device</span>
        <div className="ns-row-control">
          <Select
            value={deviceId}
            disabled={creating}
            ariaLabel="Session device"
            onChange={pickDevice}
            options={devices.map((d) => ({ value: d.id, label: d.name, sub: d.host, icon: <DeviceIcon device={d} /> }))}
          />
        </div>
      </div>
      {workspaces.length > 1 ? (
        <div className="ns-row">
          <span className="ns-row-label">Workspace</span>
          <div className="ns-row-control">
            <Select
              value={wsId}
              disabled={creating}
              ariaLabel="Session workspace"
              onChange={setWsId}
              options={workspaces.map((w) => ({ value: w.id, label: w.name }))}
            />
          </div>
        </div>
      ) : null}

      {accounts.length > 0 ? (
        <div className="ns-row">
          <span className="ns-row-label">Account</span>
          <div className="ns-row-control">
            <Select
              value={accDir}
              disabled={creating}
              ariaLabel="Session account"
              onChange={setAccDir}
              options={[
                { value: "", label: "Default account" },
                ...accounts.map((a) => ({
                  value: a.dir,
                  label: `${a.provider === "codex" ? "Codex" : "Claude"} · ${a.label}`,
                  sub: a.email,
                })),
              ]}
            />
          </div>
        </div>
      ) : null}

      <div className="ns-bar">
        <SquareTerminal size={16} className="muted-icon" />
        <input
          className="ns-input"
          disabled={creating}
          aria-label="New session name"
          aria-describedby={nameLimitId}
          maxLength={SESSION_NAME_MAX_LENGTH}
          autoFocus
          placeholder="Name a new session…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter") void createNew(); }}
        />
        <button className="btn btn-accent btn-sm" onClick={() => void createNew()} disabled={!name.trim() || creating}>
          {creating ? "Creating…" : "Create"}
          <CornerDownLeft size={13} strokeWidth={2.2} />
        </button>
      </div>

      <p className="set-note" id={nameLimitId}>{name.length}/{SESSION_NAME_MAX_LENGTH} characters · Spaces allowed</p>
      {creationError ? <p className="set-note" role="alert">{creationError}</p> : null}
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
