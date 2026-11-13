import { Channel, invoke } from "@tauri-apps/api/core";

// Thin wrapper over the Rust PTY commands. Output is streamed over a Tauri
// Channel as raw bytes: the Rust side coalesces each output burst into one
// message and the runtime delivers it as an ArrayBuffer, so nothing is
// base64-encoded or decoded on either side of the bridge.

// Must stay well below the Rust side's OUTPUT_CREDIT (256 KiB), which also
// has to fit one in-flight batch of up to ~72 KiB.
const CREDIT_RETURN_BYTES = 64 * 1024;
const CREDIT_RETURN_DELAY_MS = 50;

export interface SpawnOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  cols: number;
  rows: number;
}

export async function spawnPty(
  opts: SpawnOptions,
  onData: (bytes: Uint8Array, consumed: () => void) => void,
  onExit: (code: number) => void,
): Promise<number> {
  const channel = new Channel<ArrayBuffer>();
  let ptyId: number | undefined;
  // Consumed output is acknowledged cumulatively instead of once per batch:
  // credit goes back once enough has piled up to matter for the 256 KiB
  // window on the Rust side, or after a short delay so the tail of a burst
  // (and the credit the exit report waits for) is never held back.
  let pendingCredit = 0;
  let creditTimer: ReturnType<typeof setTimeout> | undefined;
  const returnCredit = () => {
    if (creditTimer !== undefined) {
      clearTimeout(creditTimer);
      creditTimer = undefined;
    }
    // Credit consumed before spawn resolved is returned once the id is known.
    if (ptyId === undefined || !pendingCredit) return;
    const bytes = pendingCredit;
    pendingCredit = 0;
    void invoke("pty_ack", { id: ptyId, bytes }).catch(() => {});
  };
  const acknowledge = (bytes: number) => {
    pendingCredit += bytes;
    if (pendingCredit >= CREDIT_RETURN_BYTES) returnCredit();
    else if (creditTimer === undefined) creditTimer = setTimeout(returnCredit, CREDIT_RETURN_DELAY_MS);
  };
  channel.onmessage = (chunk) => {
    let consumed = false;
    onData(new Uint8Array(chunk), () => {
      if (consumed) return;
      consumed = true;
      acknowledge(chunk.byteLength);
    });
  };
  const exitChannel = new Channel<number>();
  exitChannel.onmessage = onExit;
  const id = await invoke<number>("pty_spawn", {
    cmd: opts.cmd,
    args: opts.args,
    cwd: opts.cwd ?? null,
    cols: opts.cols,
    rows: opts.rows,
    onData: channel,
    onExit: exitChannel,
  });
  ptyId = id;
  returnCredit();
  return id;
}

interface InputQueue {
  tail: Promise<void>;
  bytes: number;
  cancelled: boolean;
}
const inputQueues = new Map<number, InputQueue>();

export function writePty(id: number, data: string): Promise<void> {
  const bytes = new TextEncoder().encode(data).byteLength;
  const queue = inputQueues.get(id) ?? { tail: Promise.resolve(), bytes: 0, cancelled: false };
  if (queue.bytes + bytes > 4 * 1024 * 1024) return Promise.reject(new Error("Terminal input is backed up. Wait before pasting more text."));
  inputQueues.set(id, queue);
  queue.bytes += bytes;
  const write = queue.tail.then(async () => {
    for (let offset = 0; offset < data.length;) {
      if (queue.cancelled) throw new Error("Terminal closed before input completed.");
      let end = Math.min(data.length, offset + 64 * 1024);
      const last = data.charCodeAt(end - 1);
      if (end < data.length && last >= 0xd800 && last <= 0xdbff) end--;
      await invoke("pty_write", { id, data: data.slice(offset, end) });
      offset = end;
    }
  });
  const settled = write.catch(() => {}).finally(() => {
    queue.bytes -= bytes;
    if (queue.tail === settled && inputQueues.get(id) === queue) inputQueues.delete(id);
  });
  queue.tail = settled;
  return write;
}

export function resizePty(id: number, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

// Detach only closes the local reader; the remote tmux session keeps running
// so work survives the window closing. kill actually terminates the PTY.
export function killPty(id: number): Promise<void> {
  const queue = inputQueues.get(id);
  if (queue) queue.cancelled = true;
  inputQueues.delete(id);
  return invoke("pty_kill", { id });
}
