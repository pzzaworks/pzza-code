import { wsUrl } from "../serverApi";

export interface WsPtyHandle {
  write(data: string): void;
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
  onData: (bytes: Uint8Array) => void,
  onError?: (msg: string) => void,
  onClose?: () => void,
  window?: number,
): WsPtyHandle {
  const ws = new WebSocket(wsUrl());
  ws.binaryType = "arraybuffer";
  let open = false;
  let closed = false;
  const queue: string[] = [];

  const send = (obj: unknown) => {
    const str = JSON.stringify(obj);
    if (open && ws.readyState === WebSocket.OPEN) ws.send(str);
    else queue.push(str);
  };

  ws.onopen = () => {
    open = true;
    ws.send(JSON.stringify({ type: "attach", name, cols, rows, cwd, window }));
    for (const q of queue) ws.send(q);
    queue.length = 0;
  };
  ws.onmessage = (ev) => {
    if (typeof ev.data !== "string") onData(new Uint8Array(ev.data as ArrayBuffer));
  };
  ws.onerror = () => onError?.("connection to devbox server failed");
  ws.onclose = () => {
    if (!closed) onClose?.();
  };

  return {
    write: (data) => send({ type: "input", data }),
    resize: (cols2, rows2) => send({ type: "resize", cols: cols2, rows: rows2 }),
    close: () => {
      closed = true; // intentional detach, not a failure
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    },
  };
}
