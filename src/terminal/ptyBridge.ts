import { Channel, invoke } from "@tauri-apps/api/core";

// Thin wrapper over the Rust PTY commands. Output is streamed over a Tauri
// Channel as base64 chunks (raw bytes are not valid UTF-8, and a JSON array of
// numbers would be far heavier than base64). A later pass can switch this to a
// binary channel; the WebGL renderer is where the real throughput win lives.

export interface SpawnOptions {
  cmd: string;
  args: string[];
  cwd?: string;
  cols: number;
  rows: number;
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export async function spawnPty(
  opts: SpawnOptions,
  onData: (bytes: Uint8Array) => void,
): Promise<number> {
  const channel = new Channel<string>();
  channel.onmessage = (chunk) => onData(base64ToBytes(chunk));
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
