import { MessagesSquare } from "lucide-react";
import { lazySurface } from "../lazySurface";
import { useAgentSessionsUi } from "../state/agentSessions";
import { sessionTileById, useStore } from "../state/store";
import { IconButton } from "../ui/IconButton";
import "./AgentSessions.css";

// The list loads on first open from its own chunk.
const AgentSessionsPanel = lazySurface(() => import("./AgentSessionsPanel").then((module) => module.AgentSessionsPanel), null, {
  label: "Agent sessions", variant: "dialog", dismiss: () => useAgentSessionsUi.getState().close(),
});

/**
 * The menu bar's way into past agent conversations, which span every session.
 * The list starts from the focused session's device and folder when there is
 * one (its scope filter widens it), so a conversation can still be resumed
 * right there; without one it lists everything.
 */
export function AgentSessionsButton({ onOpen }: { onOpen?: () => void }) {
  const open = useAgentSessionsUi((ui) => ui.open);
  return <span className="topbar-agent-sessions" onPointerEnter={() => void AgentSessionsPanel.preload()}>
    <IconButton icon={MessagesSquare} title="Agent sessions" active={open} onClick={() => {
      onOpen?.();
      const { activeId, tiles } = useStore.getState();
      useAgentSessionsUi.getState().show(activeId && sessionTileById(tiles, activeId) ? activeId : null);
    }} />
  </span>;
}

/** Hosts the dialog once for the whole canvas, whichever tile (or app command) opened it. */
export function AgentSessionsHost() {
  const open = useAgentSessionsUi((ui) => ui.open);
  const tileId = useAgentSessionsUi((ui) => ui.tileId);
  const opened = useAgentSessionsUi((ui) => ui.opened);
  return open ? <AgentSessionsPanel key={opened} tileId={tileId} onClose={() => useAgentSessionsUi.getState().close()} /> : null;
}
