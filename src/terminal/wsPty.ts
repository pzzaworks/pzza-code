import { wsUrl } from "../serverApi";

export interface WsPtyHandle {
  write(data: string): boolean;
  ready(): boolean;
  resize(cols: number, rows: number): void;
  close(): void;
}

// Connects a terminal tile to a tmux session over the devbox WebSocket server.
// Output arrives as binary frames; input/resize go out as JSON text frames. The
// first frame attaches to the named session (created with -A if missing).
export function openWsPty(
  name: string,
  cols: number,
  rows: number,
  cwd: string | undefined,
  onData: (bytes: Uint8Array, consumed: () => void) => void,
  onError?: (msg: string) => void,
  onClose?: () => void,
  window?: number,
  host?: string,
  managedChat?: { agent: "claude" | "codex" | "opencode"; identity: string },
): WsPtyHandle {
  const ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";
  let open = false;
  let closed = false;
  const queue: string[] = [];
  const encoder = new TextEncoder();
  const inputLimit = 1024 * 1024;
  let queuedBytes = 0;

  const fail = (message: string) => {
    onError?.(message);
    queue.length = 0;
    queuedBytes = 0;
    closed = true;
    ws.close();
  };
  const send = (obj: unknown) => {
    if (closed) return false;
    const str = JSON.stringify(obj);
    const bytes = encoder.encode(str).length;
    if (queuedBytes + ws.bufferedAmount + bytes > inputLimit) {
      fail("Terminal input is congested. Reconnect before sending more input.");
      return false;
    }
    if (open && ws.readyState === WebSocket.OPEN) {
      try { ws.send(str); } catch { fail("Terminal connection closed while sending input."); return false; }
    } else {
      queue.push(str);
      queuedBytes += bytes;
    }
    return true;
  };

  ws.onopen = () => {
    if (closed) { ws.close(); return; }
    open = true;
    send({ type: "attach", name, cols, rows, cwd, window, host, managedChat });
    for (const q of queue) {
      if (closed) break;
      try { ws.send(q); } catch { fail("Terminal connection closed while sending input."); }
    }
    queue.length = 0;
    queuedBytes = 0;
  };
  ws.onmessage = (ev) => {
    if (closed || !(ev.data instanceof ArrayBuffer)) return;
    const bytes = new Uint8Array(ev.data);
    let consumed = false;
    onData(bytes, () => {
      if (consumed || closed) return;
      consumed = true;
      if (bytes.byteLength > 0) send({ type: "ack", bytes: bytes.byteLength });
    });
  };
  ws.onerror = () => onError?.("connection to devbox server failed");
  ws.onclose = () => {
    queue.length = 0;
    queuedBytes = 0;
    const intentional = closed;
    closed = true;
    if (!intentional) onClose?.();
  };

  return {
    // Input belongs to this live attachment, never a future socket.
    write: (data) => !closed && open && ws.readyState === WebSocket.OPEN && send({ type: "input", data }),
    ready: () => !closed && open && ws.readyState === WebSocket.OPEN,
    resize: (cols2, rows2) => send({ type: "resize", cols: cols2, rows: rows2 }),
    close: () => {
      closed = true; // intentional detach, not a failure
      queue.length = 0;
      queuedBytes = 0;
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
