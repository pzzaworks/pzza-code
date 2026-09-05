import { useEffect, useState } from "react";
import { ChevronRight, CornerDownLeft, SquareTerminal } from "lucide-react";
import { useStore } from "../state/store";
import { tileTitle } from "../sessionMeta";
import { Select } from "../ui/Select";
import { HAS_TAURI } from "../tauriEnv";
import { fetchAccounts, createSession, type Account } from "../serverApi";

const DEVICE_KEY = "pzza.session.device";

// New-session dropdown content: choose the device to open on and the workspace,
// then create a named session or open an existing one.
export function SessionMenu({ close }: { close: () => void }) {
  const allWindows = useStore((s) => s.allWindows);
  const tiles = useStore((s) => s.tiles);
  const openSession = useStore((s) => s.openSession);
  const openWindow = useStore((s) => s.openWindow);
  const loadSessions = useStore((s) => s.loadSessions);
  const setActive = useStore((s) => s.setActive);
  const workspaces = useStore((s) => s.workspaces);
  const activeWorkspaceId = useStore((s) => s.activeWorkspaceId);
  const setWorkspace = useStore((s) => s.setWorkspace);
  const devices = useStore((s) => s.devices);

  const [name, setName] = useState("");
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

  const winDisplay = (w: (typeof allWindows)[number]) =>
    (counts[w.session] ?? 1) > 1
      ? `${tileTitle(w.session)} · ${w.windowName}`
      : tileTitle(w.session);

  const isWindowOpen = (w: (typeof allWindows)[number]) =>
    tiles.some(
      (t) =>
        (t.session === w.session && t.window === w.window) ||
        (t.id === w.session && w.active),
    );
  const available = allWindows.filter((w) => !isWindowOpen(w));

  const createNew = async () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    if (wsId !== activeWorkspaceId) setWorkspace(wsId);
    // Open on the selected device: no host for this Mac, the ssh host otherwise.
    const device = devices.find((d) => d.id === deviceId);
    const host = device && device.id !== "this-mac" ? device.host : undefined;
    // Bind the chosen account by creating the tmux session with its env up
    // front, then attach to it (the lazy attach reuses the existing session).
    // Account binding runs through the local agent, so it only applies locally.
    const acc = accounts.find((a) => a.dir === accDir);
    if (acc && !host) {
      try {
        await createSession(trimmed, undefined, { provider: acc.provider, dir: acc.dir });
      } catch {
        /* fall back to a plain session */
      }
    }
    openSession(trimmed, undefined, host);
    setActive(trimmed);
    // Give tmux a beat to create the session, then re-scan so the new session's
    // current path lands in allSessions (drives the tile header and code editor).
    setTimeout(() => {
      loadSessions().catch(() => {});
    }, 500);
    setName("");
    setAccDir("");
    close();
  };

  return (
    <div className="menu-body">
      <div className="ns-row">
        <span className="ns-row-label">Device</span>
        <div className="ns-row-control">
          <Select
            value={deviceId}
            onChange={pickDevice}
            options={devices.map((d) => ({ value: d.id, label: d.name, sub: d.host }))}
          />
        </div>
      </div>
      {workspaces.length > 1 ? (
        <div className="ns-row">
          <span className="ns-row-label">Workspace</span>
          <div className="ns-row-control">
            <Select
              value={wsId}
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
          autoFocus
          placeholder="Name a new session…"
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && createNew()}
        />
        <button className="btn btn-accent btn-sm" onClick={createNew} disabled={!name.trim()}>
          Create
          <CornerDownLeft size={13} strokeWidth={2.2} />
        </button>
      </div>

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
                  openWindow(w, winDisplay(w));
                  close();
                }}
              >
                <span className="session-pick-icon">
                  <SquareTerminal size={15} />
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
