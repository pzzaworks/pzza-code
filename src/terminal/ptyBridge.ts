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
  onData: (bytes: Uint8Array) => void,
): Promise<number> {
  const channel = new Channel<ArrayBuffer>();
  channel.onmessage = (chunk) => onData(new Uint8Array(chunk));
  const id = await invoke<number>("pty_spawn", {
    cmd: opts.cmd,
    args: opts.args,
    cwd: opts.cwd ?? null,
    cols: opts.cols,
    rows: opts.rows,
    onData: channel,
  });
  return id;
}

export function writePty(id: number, data: string): Promise<void> {
  return invoke("pty_write", { id, data });
}

export function resizePty(id: number, cols: number, rows: number): Promise<void> {
  return invoke("pty_resize", { id, cols, rows });
}

// Detach only closes the local reader; the remote tmux session keeps running
// so work survives the window closing. kill actually terminates the PTY.
export function killPty(id: number): Promise<void> {
  return invoke("pty_kill", { id });
}
