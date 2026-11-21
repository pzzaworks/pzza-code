import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { AlertTriangle, Loader2, RefreshCw, SquareTerminal } from "lucide-react";
import { Modal } from "./Modal";
import { AgentIcon } from "../icons/AgentIcon";
import { rowAgent } from "./LiveSessionIcon";
import { busySessions, closeRefreshSessions, refreshLocalSessions, refreshSelectedSessions, useSessionRefresh, type ProgramRestart } from "../state/sessionRefresh";
import { isSessionTile, useStore } from "../state/store";
import { sessionConnection } from "../connection";
import { DEFAULT_WORKSPACE_ID, wsKeyOf, type Workspace } from "../workspaces";
import { fetchPortDetails, fetchSessionActivity, type PortDetails, type SessionActivity } from "../serverApi";
import { sessionAgent } from "../../server/lib/session-agents.js";

/** A pane's foreground program as the native side read it (pane_programs.rs). */
export interface PaneProgram {
  session: string;
  window: number;
  pane: string;
  index: number;
  /** The line typed to start it again; null when it cannot be (see reason). */
  command: string | null;
  label: string;
  reason: string | null;
  pids: number[];
}

export interface ProgramRow {
  pane: string;
  command: string | null;
  label: string;
  reason: string | null;
  /** Ports its processes listen on: a server, started again by default. */
  ports: number[];
}

export interface SessionRow {
  name: string;
  windows: number;
  /** The agent in its active window, with the launcher it resumes through. */
  agent?: { id: string; label: string; launcher?: string; busy: boolean };
  /** Programs other than agents, each with how it starts again. */
  programs: ProgramRow[];
  /** Refreshing it stops something that runs now. */
  busy: boolean;
}

export interface SessionGroup {
  /** A workspace id, or null for sessions not open in any tile. */
  id: string | null;
  name: string;
  rows: SessionRow[];
}

/**
 * The local sessions as the dialog lists them, from the terminal server's
 * list, the activity of their windows (null when it is unavailable), the
 * programs their panes run and the listening ports. Internal sessions
 * (Quick Chat, previews) are never listed.
 */
export function refreshRows(
  sessions: readonly { name: string; windows: number }[],
  activity: readonly SessionActivity[] | null,
  programs: readonly PaneProgram[],
  ports: readonly PortDetails[],
): SessionRow[] {
  const busy = new Set(activity ? busySessions(activity) : []);
  const listening = new Map<number, number[]>();
  for (const port of ports) for (const process of port.processes) listening.set(process.pid, [...(listening.get(process.pid) ?? []), port.port]);
  return sessions
    .filter(session => !session.name.startsWith("pzza-v-") && session.name !== "pzza-quick-chat")
    .map(session => {
      const rows = activity?.filter(row => row.session === session.name) ?? [];
      const active = rows.find(row => row.active) ?? rows[0];
      const id = active ? rowAgent(active) : undefined;
      const agent = id ? {
        id,
        label: sessionAgent(id)?.label ?? id,
        ...(active?.launch?.launcher ? { launcher: active.launch.launcher.name } : {}),
        busy: active?.launch?.status !== "idle",
      } : undefined;
      const own = programs.filter(program => program.session === session.name).map(program => ({
        pane: program.pane,
        command: program.command,
        label: program.label,
        reason: program.reason,
        ports: [...new Set(program.pids.flatMap(pid => listening.get(pid) ?? []))].sort((a, b) => a - b),
      }));
      return { name: session.name, windows: session.windows, ...(agent ? { agent } : {}), programs: own, busy: activity === null || busy.has(session.name) || own.length > 0 };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * Sessions by the workspace their tile is on, in the workspaces' order;
 * sessions without a tile come last. Empty groups are left out.
 */
export function groupByWorkspace(rows: readonly SessionRow[], workspaces: readonly Pick<Workspace, "id" | "name">[], workspaceOf: (session: string) => string | null): SessionGroup[] {
  const groups: SessionGroup[] = workspaces.map(workspace => ({ id: workspace.id, name: workspace.name, rows: [] }));
  const loose: SessionGroup = { id: null, name: "Not open in a tile", rows: [] };
  for (const row of rows) {
    const id = workspaceOf(row.name);
    (groups.find(group => group.id === id) ?? loose).rows.push(row);
  }
  return [...groups, loose].filter(group => group.rows.length > 0);
}

/** Programs that start again by default: servers, which listen on a port. */
export function defaultRestarts(rows: readonly SessionRow[]): Set<string> {
  return new Set(rows.flatMap(row => row.programs.filter(program => program.command && program.ports.length).map(program => program.pane)));
}

function AgentStatus({ agent }: { agent: NonNullable<SessionRow["agent"]> }) {
  return <span className="rs-status" title={agent.launcher ? `Resumes through ${agent.launcher}, the way it was started` : `Resumes ${agent.label}`}>
    <AgentIcon id={agent.id} size={12} />
    {agent.launcher ? <code className="rs-launcher">{agent.launcher}</code> : <span>{agent.label}</span>}
    <span className="rs-state">{agent.busy ? "working" : "idle"}</span>
  </span>;
}

// A local session's workspace, from its tile; null when no tile shows it.
function useWorkspaceOf(): (session: string) => string | null {
  const tiles = useStore(state => state.tiles);
  const connection = useStore(state => state.connection);
  const sessionWs = useStore(state => state.sessionWs);
  return useMemo(() => {
    const byName = new Map<string, string>();
    for (const tile of tiles.filter(isSessionTile)) {
      if (sessionConnection(tile.host, connection).host) continue;
      const name = tile.session ?? tile.name;
      if (!byName.has(name)) byName.set(name, sessionWs[wsKeyOf(tile)] ?? DEFAULT_WORKSPACE_ID);
    }
    return (session: string) => byName.get(session) ?? null;
  }, [tiles, connection, sessionWs]);
}

// A checkbox that shows "some" for a partly chosen group.
function GroupCheck({ chosen, total, label, onChange }: { chosen: number; total: number; label: string; onChange: () => void }) {
  const box = useRef<HTMLInputElement>(null);
  useEffect(() => { if (box.current) box.current.indeterminate = chosen > 0 && chosen < total; }, [chosen, total]);
  return <input ref={box} type="checkbox" checked={total > 0 && chosen === total} aria-label={label} onChange={onChange} />;
}

/**
 * Refresh sessions: every local session (the terminal server restarts, so
 * new permissions reach all of them) or only the chosen ones (they restart
 * in place). Output, folders and agents come back, agents typed the way they
 * were started; other programs start again where the user leaves them ticked.
 */
export function RefreshSessionsDialog() {
  const open = useSessionRefresh(state => state.dialogOpen);
  const running = useSessionRefresh(state => state.running);
  const workspaces = useStore(state => state.workspaces);
  const workspaceOf = useWorkspaceOf();
  const [rows, setRows] = useState<SessionRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(() => new Set());
  const [restarts, setRestarts] = useState<Set<string>>(() => new Set());

  useEffect(() => {
    if (!open) return;
    let alive = true;
    setRows(null);
    setFailed(false);
    setChosen(new Set());
    void Promise.all([
      invoke<{ name: string; windows: number }[]>("tmux_list_sessions", { host: null }),
      fetchSessionActivity("").catch(() => null),
      invoke<PaneProgram[]>("local_tmux_pane_programs").catch(() => []),
      fetchPortDetails("").catch(() => []),
    ]).then(([sessions, activity, programs, ports]) => {
      if (!alive) return;
      const next = refreshRows(sessions, activity, programs, ports);
      setRows(next);
      setRestarts(defaultRestarts(next));
    }, () => {
      if (alive) { setRows([]); setFailed(true); }
    });
    return () => { alive = false; };
  }, [open]);

  const groups = useMemo(() => groupByWorkspace(rows ?? [], workspaces, workspaceOf), [rows, workspaces, workspaceOf]);
  const names = useMemo(() => rows?.map(row => row.name) ?? [], [rows]);
  const picked = names.filter(name => chosen.has(name));
  // What a refresh of `sessions` stops for good: programs not started again, and agents mid-turn.
  const stops = (sessions: readonly string[]) => (rows ?? []).filter(row => sessions.includes(row.name)).flatMap(row => [
    ...row.programs.filter(program => !program.command || !restarts.has(program.pane)).map(program => program.label),
    ...(row.agent?.busy ? [`${row.agent.label} in ${row.name}`] : []),
  ]);
  const stopping = stops(picked);
  const restartsOf = (sessions: readonly string[]): ProgramRestart[] => (rows ?? [])
    .filter(row => sessions.includes(row.name))
    .flatMap(row => row.programs.flatMap(program => program.command && restarts.has(program.pane) ? [{ pane: program.pane, command: program.command }] : []));

  const toggleAll = (sessions: readonly string[]) => setChosen(current => {
    const next = new Set(current);
    const all = sessions.every(name => next.has(name));
    for (const name of sessions) { if (all) next.delete(name); else next.add(name); }
    return next;
  });
  const toggleRestart = (pane: string) => setRestarts(current => {
    const next = new Set(current);
    if (next.has(pane)) next.delete(pane); else next.add(pane);
    return next;
  });
  const refreshPicked = () => {
    const programs = restartsOf(picked);
    closeRefreshSessions();
    void refreshSelectedSessions(picked, programs).catch(() => undefined);
  };
  const refreshEvery = () => {
    const programs = restartsOf(names);
    closeRefreshSessions();
    void refreshLocalSessions({ programs }).catch(() => undefined);
  };

  return <Modal open={open} onClose={closeRefreshSessions} title="Refresh sessions" icon={RefreshCw} size="md" className="rs-dialog">
    <p className="rs-intro">
      Output, folders and agent chats come back, and agents start again the way you started them. Ticked programs are typed again in their pane.
    </p>
    {rows === null ? <div className="rs-empty" role="status"><Loader2 size={14} className="sw-spin" aria-hidden="true" /> Reading sessions…</div>
      : failed ? <div className="rs-empty" role="alert">The terminal server could not be read.</div>
      : !rows.length ? <div className="rs-empty">No sessions are running on this Mac.</div>
      : <div className="rs-list" role="group" aria-label="Sessions to refresh">
        <label className="rs-row rs-row-head">
          <GroupCheck chosen={picked.length} total={names.length} label="Choose every session" onChange={() => toggleAll(names)} />
          <span className="rs-name">{picked.length ? `${picked.length} of ${names.length} chosen` : `${names.length} session${names.length === 1 ? "" : "s"}`}</span>
        </label>
        <div className="rs-rows">
          {groups.map(group => {
            const members = group.rows.map(row => row.name);
            return <section key={group.id ?? "loose"} className="rs-group" aria-label={group.name}>
              <label className="rs-group-head">
                <GroupCheck chosen={members.filter(name => chosen.has(name)).length} total={members.length} label={`Choose every session in ${group.name}`} onChange={() => toggleAll(members)} />
                <span className="rs-group-name">{group.name}</span>
                <span className="rs-group-count">{members.length}</span>
              </label>
              {group.rows.map(row => <div key={row.name} className={`rs-session ${chosen.has(row.name) ? "is-on" : ""}`}>
                <label className="rs-row">
                  <input type="checkbox" checked={chosen.has(row.name)} onChange={() => toggleAll([row.name])} />
                  <span className="rs-name" title={row.name}>{row.name}</span>
                  {row.windows > 1 ? <span className="rs-windows">{row.windows} windows</span> : null}
                  {row.agent ? <AgentStatus agent={row.agent} /> : !row.programs.length ? <span className="rs-status"><SquareTerminal size={12} aria-hidden="true" />shell</span> : null}
                </label>
                {row.programs.map(program => program.command
                  ? <label key={program.pane} className="rs-program" title={`Typed again after the refresh: ${program.command}`}>
                    <input type="checkbox" checked={restarts.has(program.pane)} onChange={() => toggleRestart(program.pane)} aria-label={`Start ${program.label} again`} />
                    <code className="rs-program-line">{program.label}</code>
                    {program.ports.length ? <span className="rs-ports">{program.ports.map(port => `:${port}`).join(" ")}</span> : null}
                  </label>
                  : <div key={program.pane} className="rs-program is-fixed" title={program.reason ?? undefined}>
                    <AlertTriangle size={12} aria-hidden="true" />
                    <code className="rs-program-line">{program.label}</code>
                    <span className="rs-reason">{program.reason}</span>
                  </div>)}
              </div>)}
            </section>;
          })}
        </div>
      </div>}
    {stopping.length ? <p className="rs-warning" role="status">
      <AlertTriangle size={13} aria-hidden="true" /> Stops without starting again: {stopping.join(", ")}.
    </p> : null}
    <div className="modal-actions rs-actions">
      <button type="button" className="btn" disabled={running || rows === null || failed}
        title="Restarts the terminal server, so every session comes back with the permissions granted since it started"
        onClick={refreshEvery}>
        Refresh all
      </button>
      <span className="rs-spacer" />
      <button type="button" className="btn" onClick={closeRefreshSessions}>Cancel</button>
      <button type="button" className="btn btn-accent" disabled={running || !picked.length}
        title="Restarts only these sessions, in place. They keep the permissions the terminal server has now."
        onClick={refreshPicked}>
        {picked.length ? `Refresh ${picked.length}` : "Refresh selected"}
      </button>
    </div>
    <p className="rs-note">Refresh all also restarts the terminal server, so newly granted permissions reach every terminal. Variables set only for a command (PORT=3001 npm run dev) are not typed again.</p>
  </Modal>;
}
