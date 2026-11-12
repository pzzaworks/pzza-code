import { useEffect, useRef, useState } from "react";
import { History } from "lucide-react";
import { captureAgentStart, checkpointRevision, fetchCheckpoints, retainCheckpointWatch, useCheckpointsUi, type CheckpointList } from "../checkpoints";
import { lazySurface } from "../lazySurface";
import { activityAgent, useSessionActivity } from "../ui/LiveSessionIcon";
import "./Checkpoints.css";

// The timeline itself carries the diff viewer (CodeMirror), so it loads on
// first open from its own chunk.
const CheckpointsPanel = lazySurface(() => import("./CheckpointsPanel").then((module) => module.CheckpointsPanel));

export interface CheckpointListState {
  status: "idle" | "loading" | "ready" | "error";
  list?: CheckpointList;
  error?: string;
}

// A folder's checkpoints, read while `enabled` and again whenever a capture
// or restore changes that worktree's timeline (from any tile).
export function useCheckpointList(host: string, path: string | undefined, enabled: boolean): CheckpointListState & { reload(): void } {
  const [state, setState] = useState<CheckpointListState>({ status: "idle" });
  const [nonce, setNonce] = useState(0);
  const revision = useCheckpointsUi((ui) => checkpointRevision(ui, host, state.list?.root));
  useEffect(() => {
    if (!enabled || !path) return;
    const controller = new AbortController();
    setState((current) => (current.list ? current : { status: "loading" }));
    fetchCheckpoints(host, path, controller.signal)
      .then((list) => { if (!controller.signal.aborted) setState({ status: "ready", list }); })
      .catch((cause: unknown) => {
        if (controller.signal.aborted) return;
        setState({ status: "error", error: cause instanceof Error ? cause.message : "Checkpoints unavailable" });
      });
    return () => controller.abort();
  }, [host, path, enabled, revision, nonce]);
  return { ...state, reload: () => setNonce((value) => value + 1) };
}

/**
 * The status bar's checkpoints button, the one way into a tile's timeline:
 * shown in every Git folder, with the count once there are any, so a
 * checkpoint can be saved by hand before the first turn.
 */
export function CheckpointsChip({ tileId, host, path, visible }: { tileId: string; host: string; path: string; visible: boolean }) {
  const { list } = useCheckpointList(host, path, visible);
  const count = list?.checkpoints.length ?? 0;
  const label = `${count} ${count === 1 ? "checkpoint" : "checkpoints"}`;
  return <button
    type="button"
    className={`tile-strip-checkpoints ${count ? "" : "is-empty"}`}
    title={count ? `${label} of this folder\nClick to compare or restore them` : "Checkpoints\nNone in this folder yet. Click to save one"}
    aria-label={count ? `Open ${label}` : "Checkpoints"}
    aria-haspopup="dialog"
    onPointerEnter={() => void CheckpointsPanel.preload()}
    onMouseDown={(event) => event.stopPropagation()}
    onClick={() => useCheckpointsUi.getState().open(tileId)}
  >
    <History size={11} aria-hidden="true" />{count ? <span className="tile-strip-checkpoints-count">{count}</span> : null}
  </button>;
}

// Per tile: saves the baseline when a coding agent shows up in it (the state
// its first turn is measured from), keeps the agent tiles' turn watch
// running, and hosts the timeline while it is open. An agent already running
// when the tile is first seen (the app just started) is resumed, not new.
export function TileCheckpoints({ tileId, session, window: windowIndex, host, gitHost, path }: {
  tileId: string; session: string; window?: number; host?: string; gitHost: string; path?: string;
}) {
  const activity = useSessionActivity(session, windowIndex, host);
  const agent = activityAgent(activity);
  const seen = useRef<string | null | undefined>(undefined);
  useEffect(() => retainCheckpointWatch(), []);
  useEffect(() => {
    if (activity === undefined) return;
    const before = seen.current;
    seen.current = agent ?? null;
    if (agent && before !== agent) void captureAgentStart(tileId, agent, before === undefined).catch(() => { /* Not a repository, or the device is away. */ });
  }, [activity, agent, tileId]);
  const open = useCheckpointsUi((ui) => ui.openTileId === tileId);
  return open ? <CheckpointsPanel tileId={tileId} host={gitHost} path={path} onClose={() => useCheckpointsUi.getState().close()} /> : null;
}
