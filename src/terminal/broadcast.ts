import { validateTerminalPaste } from "../appControlTerminal";

// Per-tile writers for broadcasting one line to several terminals. Each
// terminal registers a writer that pastes through its normal guarded paste
// path and then submits Enter, so broadcast input is never a raw byte stream.
type Writer = (text: string) => Promise<void>;
const writers = new Map<string, Writer>();

export function registerBroadcastTarget(tileId: string, writer: Writer): () => void {
  writers.set(tileId, writer);
  return () => { if (writers.get(tileId) === writer) writers.delete(tileId); };
}

export interface BroadcastResult { tileId: string; error: string | null }

// Sends `text` followed by Enter to every tile. One line only: the text is
// validated once before anything is sent, so a bad line reaches no terminal.
export async function broadcastLine(tileIds: readonly string[], text: string): Promise<BroadcastResult[]> {
  if (!text.trim()) throw new Error("Type something to send.");
  validateTerminalPaste(text, false, true);
  return Promise.all(tileIds.map(async (tileId) => {
    const writer = writers.get(tileId);
    if (!writer) return { tileId, error: "This terminal is not connected yet." };
    try {
      await writer(text);
      return { tileId, error: null };
    } catch (error) {
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
