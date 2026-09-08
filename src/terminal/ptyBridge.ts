import { Channel, invoke } from "@tauri-apps/api/core";

// Thin wrapper over the Rust PTY commands. Output is streamed over a Tauri
// Channel as raw bytes: the Rust side coalesces each output burst into one
// message and the runtime delivers it as an ArrayBuffer, so nothing is
// base64-encoded or decoded on either side of the bridge.

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
  let earlyCredit = 0;
  const acknowledge = (bytes: number) => {
    if (ptyId === undefined) earlyCredit += bytes;
    else void invoke("pty_ack", { id: ptyId, bytes }).catch(() => {});
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
  if (earlyCredit) acknowledge(earlyCredit);
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
