import { validateTerminalPaste } from "../appControlTerminal";
import { hasPendingPermission } from "../state/permissionPrompts";

// Per-tile writers for broadcasting text to several terminals. Each terminal
// registers a writer that pastes through its normal guarded paste path and
// then submits Enter, so broadcast input is never a raw byte stream. A writer
// refuses multi-line text unless its terminal is in bracketed paste mode
// (an agent's input box): a plain shell would run each line on its own.
type Writer = (text: string) => Promise<void>;
const writers = new Map<string, Writer>();

export function registerBroadcastTarget(tileId: string, writer: Writer): () => void {
  writers.set(tileId, writer);
  return () => { if (writers.get(tileId) === writer) writers.delete(tileId); };
}

export interface BroadcastResult { tileId: string; error: string | null; skipped?: boolean }

export const BROADCAST_PENDING_APPROVAL = "Waiting on an approval prompt, so nothing was sent. Answer it first.";
export const BROADCAST_APPROVAL_APPEARED = "An approval prompt appeared while sending, so Enter was not pressed. Answer it first, then submit the text in the terminal.";

/**
 * Thrown by a writer that found an approval prompt on its terminal's screen
 * right before it would type or press Enter: the tile is skipped, as one
 * already known to wait on an approval is.
 */
export class PendingApprovalError extends Error {}

// Sends `text` followed by Enter to every tile. The text is validated once
// before anything is sent, so a bad message reaches no terminal; `multiline`
// allows line breaks, which each terminal still accepts only in bracketed
// paste mode. A tile waiting on an approval prompt is skipped: the text and
// its Enter would answer the prompt instead of reaching the agent. Each
// writer checks its screen again right before typing and before Enter, since
// a prompt drawn a moment ago is not flagged yet.
export async function broadcastLine(tileIds: readonly string[], text: string, { multiline = false } = {}): Promise<BroadcastResult[]> {
  if (!text.trim()) throw new Error("Type something to send.");
  validateTerminalPaste(text, multiline, !multiline);
  return Promise.all(tileIds.map(async (tileId) => {
    if (hasPendingPermission(tileId)) return { tileId, error: BROADCAST_PENDING_APPROVAL, skipped: true };
    const writer = writers.get(tileId);
    if (!writer) return { tileId, error: "This terminal is not connected yet." };
    try {
      await writer(text);
      return { tileId, error: null };
    } catch (error) {
      if (error instanceof PendingApprovalError) return { tileId, error: error.message, skipped: true };
      return { tileId, error: error instanceof Error ? error.message : "Sending failed." };
    }
  }));
}

// Sends one saved prompt to a single tile through the same guarded path as a
// broadcast, and reports that tile's failure as an error.
export async function sendPromptToTile(tileId: string, text: string): Promise<void> {
  const [result] = await broadcastLine([tileId], text);
  if (result?.error) throw new Error(result.error);
}
