// Runtime configuration and process-wide constants for the agent.
//
// Roles:
//   source   (default, on the devbox): tmux/ports are local; it cannot forward.
//   receiver (PZZA_SERVER_HOST set, on the Mac): tmux/ports come from the devbox
//            over ssh, and it OWNS port forwarding (ssh -L).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This module lives in server/lib, so the repo root is two levels up. In a
// bundled app that resolves to the resources dir holding server/ and mcp/.
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
export const MCP_PATH = path.join(REPO_ROOT, "mcp/server.js");

export const PORT = Number(process.env.PORT || 5190);
export const DEVBOX = process.env.PZZA_SERVER_HOST || ""; // e.g. "devbox"; empty = source
export const IS_CLIENT = DEVBOX !== ""; // client machine: tmux/ports over ssh, does -L forwarding
export const SKIP = new Set([22, 53, 631, 3389]);
export const MIN_PORT = 1024;

// Where this device persists saved state and rotating backups (created on boot).
export const STATE_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || ".", ".config"),
  "pzzacode",
);
try {
  fs.mkdirSync(path.join(STATE_DIR, "backups"), { recursive: true });
} catch {
  /* best effort */
}
