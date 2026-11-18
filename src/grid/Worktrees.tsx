import { FolderGit2 } from "lucide-react";
import { create } from "zustand";
import { lazySurface } from "../lazySurface";
import "./AgentSessions.css";
import "./Worktrees.css";

// A session's Worktrees dialog: the extra Git worktrees of the repository the
// session works in, or of every repository directly inside its folder of
// projects. Opened from the session's top bar; one dialog for the whole canvas.

interface WorktreesUi {
  /** The tile the dialog was opened for; null while it is closed. */
  tileId: string | null;
  /** Bumped on each open, so a reopened dialog reads everything again. */
  opened: number;
  show(tileId: string): void;
  close(): void;
}

export const useWorktreesUi = create<WorktreesUi>((set) => ({
  tileId: null,
  opened: 0,
  show: (tileId) => set((state) => ({ tileId, opened: state.opened + 1 })),
  close: () => set({ tileId: null }),
}));

// The list loads on first open from its own chunk.
const WorktreesPanel = lazySurface(() => import("./WorktreesPanel").then((module) => module.WorktreesPanel), null, {
  label: "Worktrees", variant: "dialog", dismiss: () => useWorktreesUi.getState().close(),
});

/** The session top bar's Worktrees button. */
export function WorktreesButton({ tileId }: { tileId: string }) {
  const open = useWorktreesUi((ui) => ui.tileId === tileId);
  return <button
    type="button"
    className={`tile-btn ${open ? "tile-btn-on" : ""}`}
    title={"Worktrees\nThe Git worktrees of this session's repository, or of the repositories in its folder"}
    aria-label="Worktrees"
    aria-haspopup="dialog"
    onMouseDown={(event) => event.stopPropagation()}
    onPointerEnter={() => void WorktreesPanel.preload()}
    onClick={(event) => {
      event.stopPropagation();
      useWorktreesUi.getState().show(tileId);
    }}
  >
    <FolderGit2 size={13} aria-hidden="true" />
  </button>;
}

/** Hosts the dialog once for the whole canvas, whichever tile opened it. */
export function WorktreesHost() {
  const tileId = useWorktreesUi((ui) => ui.tileId);
  const opened = useWorktreesUi((ui) => ui.opened);
  return tileId ? <WorktreesPanel key={opened} tileId={tileId} onClose={() => useWorktreesUi.getState().close()} /> : null;
}
