// Path guards for file access. The code view can only ever reach the user's
// home tree, and never key material or credential stores, on both the local and
// the ssh-proxied branches. The one way past the home bound is a local file or
// folder the user opened in the app (dropped onto it, or opened from Finder):
// the desktop app grants exactly those paths over a channel only it holds (see
// grantOpenedPath).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_DIR } from "./config.js";
import { shQuote } from "./shell.js";

// Private key material and credential stores are never something the code
// editor legitimately opens, and they are the highest-value exfil targets for
// a caller that has obtained the token (or a prompt-injected MCP client). Refuse
// them outright on both the local and the ssh-proxied branches.
export function sensitivePath(rel) {
  const parts = rel.split("/").filter(Boolean);
  const top = parts[0] || "";
  const base = parts[parts.length - 1] || "";
  if (top === ".ssh" || top === ".gnupg" || top === ".aws") return true;
  if (top === ".config" && parts[1] === "pzzacode" && base === "agent-token") return true;
  if (/^\.claude/.test(top) && base === ".credentials.json") return true;
  if (/^\.codex/.test(top) && base === "auth.json") return true;
  return false;
}

// Shell-side twin of sensitivePath, applied by remoteGuard to the resolved
// $HOME-relative path in "$r".
export const SENSITIVE_CASE =
  `case "$r" in .ssh|.ssh/*|.gnupg|.gnupg/*|.aws|.aws/*|.config/pzzacode/agent-token|.claude*/.credentials.json|.codex*/auth.json) echo PZZA_DENIED; exit 3;; esac; `;

// Resolve a client-supplied path, restricted to the user's home tree so the
// code view can never read or write outside it. `listOnly` lifts the sensitive
// -path refusal: a directory listing exposes file names only, and the file
// browser must be able to pick a key from ~/.ssh even though reading it stays
// forbidden.
export function safePath(p, { listOnly = false } = {}) {
  if (typeof p !== "string" || !p) return null;
  const home = os.homedir();
  const resolved = path.resolve(expandTilde(p, home));
  if (!home || (resolved !== home && !resolved.startsWith(home + path.sep))) return null;
  if (!listOnly && sensitivePath(path.relative(home, resolved))) return null;
  return resolved;
}

// Why safePath/realSafePath refused a local path, worded for the editor that
// shows it: outside home, or refused inside it (a credential store, a link
// that reaches one, a dangling link).
export function refusalReason(p) {
  if (typeof p !== "string" || !p) return "invalid path";
  const home = os.homedir();
  const resolved = path.resolve(expandTilde(p, home));
  return resolved === home || resolved.startsWith(home + path.sep)
    ? "This file is protected and cannot be opened here."
    : "Drop the file onto PzzaCode or open it from Finder to work on it here.";
}

const within = (root, candidate) =>
  candidate === root || candidate.startsWith(root.endsWith(path.sep) ? root : root + path.sep);

// The agent's own token file, wherever XDG_CONFIG_HOME puts it.
function isAgentToken(real) {
  try { return real === fs.realpathSync.native(path.join(STATE_DIR, "agent-token")); } catch { return false; }
}

// safePath for anything that opens a file. The path as given must be inside
// home (safePath); every symlink along it is then resolved and the credential
// denylist is applied to the real target as well, so a link inside home cannot
// reach a key store. The real target itself may sit outside home: a project
// folder linked to another volume (~/Projects -> /Volumes/SSD/Projects) opens
// and saves like any other, as the lexical bound already requires the user to
// have placed that link in their own home. A file that does not exist yet
// resolves through its folder; a dangling link in its place is refused
// (writing through it would create a file wherever it points). Returns the
// real path, or null when refused. A missing folder throws ENOENT for the
// caller to report. A path outside home is answered by grantedPath instead.
export function realSafePath(p) {
  const lexical = safePath(p);
  if (!lexical) return grantedPath(p);
  let real;
  try {
    real = fs.realpathSync.native(lexical);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    real = path.join(fs.realpathSync.native(path.dirname(lexical)), path.basename(lexical));
    try {
      fs.lstatSync(real);
      return null;
    } catch (missing) {
      if (missing.code !== "ENOENT") throw missing;
    }
  }
  return deniedReal(real) ? null : real;
}

// Whether a resolved real path is credential material: a key store in home
// (by its real path) or the agent's own token. Applies to every path the
// editor opens, granted ones included.
function deniedReal(real) {
  const home = os.homedir();
  let realHome;
  try { realHome = fs.realpathSync.native(home); } catch { return true; }
  const root = within(realHome, real) ? realHome : within(home, real) ? home : null;
  if (root && sensitivePath(path.relative(root, real))) return true;
  return isAgentToken(real);
}

// Files and folders the user opened in the app (dropped onto it, opened from
// Finder or File > Open): real path -> whether it is a folder (granting its
// whole tree) or a file (granting that path only). They matter only for paths
// outside home. Held in memory only, for this agent's lifetime, oldest first;
// the desktop app keeps its own copy and sends it again to an agent it
// respawns.
const opened = new Map();
export const OPENED_PATH_LIMIT = 256;
const PATH_LIMIT = 4096;

// Records a path the user opened. Called only for messages the desktop app
// writes to the agent's stdin (agent-lifecycle.js): a pipe whose write end
// only the app's native side holds, fed from the OS drop and open-document
// events. No HTTP route, webview call or token holder can reach it. The path
// is resolved again here; a path that cannot be resolved is kept as sent (the
// app already resolved it), so a file deleted since can be saved again.
// Granting a path again makes it the newest; past the limit the oldest grant
// is forgotten.
export function grantOpenedPath(p, folder) {
  if (typeof p !== "string" || !p.startsWith("/") || p.length > PATH_LIMIT || p.includes("\0")) return false;
  let real = path.resolve(p);
  try { real = fs.realpathSync.native(real); } catch { /* Kept as the app resolved it. */ }
  opened.delete(real);
  opened.set(real, folder === true);
  while (opened.size > OPENED_PATH_LIMIT) opened.delete(opened.keys().next().value);
  return true;
}

// Applies one message from the desktop app (see grantOpenedPath).
export function desktopMessage(message) {
  if (message && typeof message === "object" && message.type === "grant") grantOpenedPath(message.path, message.folder);
}

// The opened paths, oldest first (for tests and diagnostics).
export function openedPaths() {
  return [...opened].map(([p, folder]) => ({ path: p, folder }));
}

export function forgetOpenedPaths() {
  opened.clear();
}

function isOpened(real) {
  for (const [root, folder] of opened) if (folder ? within(root, real) : real === root) return true;
  return false;
}

// realSafePath for a path outside home: its real path when that is a file the
// user opened or lies in a folder they opened, else null. Every link along the
// path is resolved first, so a link inside an opened folder that leads out of
// it is refused, and the credential denylist applies as it does in home. A new
// file resolves through its folder; a dangling link in its place is refused.
// Nothing here throws: an ungranted path answers null whether it exists or not.
export function grantedPath(p) {
  if (!opened.size || typeof p !== "string" || !p.startsWith("/") || p.includes("\0")) return null;
  const resolved = path.resolve(p);
  const home = os.homedir();
  // In home the home rules alone decide, so no grant can reopen a key store.
  if (!home || within(home, resolved)) return null;
  let real;
  try {
    real = fs.realpathSync.native(resolved);
  } catch (error) {
    if (error.code !== "ENOENT") return null;
    try { real = path.join(fs.realpathSync.native(path.dirname(resolved)), path.basename(resolved)); }
    catch { return null; }
    try {
      fs.lstatSync(real);
      return null;
    } catch (missing) {
      if (missing.code !== "ENOENT") return null;
    }
  }
  if (!isOpened(real) || deniedReal(real)) return null;
  return real;
}

// "~" or "~/x" -> the given home; anything else is returned as is.
export function expandTilde(p, home) {
  if (p === "~") return home;
  if (p.startsWith("~/")) return home + p.slice(1);
  return p;
}

// A remote path must be absolute (or ~-relative) and free of ".."; the remote
// guard bounds the rest to the remote user's home.
export function remotePath(p) {
  if (typeof p !== "string" || p.split("/").includes("..")) return null;
  if (p === "~" || p.startsWith("~/") || p.startsWith("/")) return p;
  return null;
}

// Shell expression for a client path: "~" expands against the remote home,
// everything else is passed quoted.
function remoteExpr(p) {
  if (p === "~") return '"$h"';
  if (p.startsWith("~/")) return `"$h"/${shQuote(p.slice(2))}`;
  return shQuote(p);
}

// Shell prelude: sets $p to the resolved path if it is inside $HOME, else prints
// a marker and exits, so every remote command after it can trust "$p".
export function remoteGuard(p, { listOnly = false } = {}) {
  const e = remoteExpr(p);
  return (
    `h=$(cd ~ && pwd -P); p=$(realpath -m -- ${e} 2>/dev/null || readlink -f -- ${e} 2>/dev/null); ` +
    `case "$p" in "$h"|"$h"/*) ;; *) echo PZZA_DENIED; exit 3;; esac; ` +
    `r="\${p#"$h"/}"; ` +
    (listOnly ? "" : SENSITIVE_CASE)
  );
}

export function denied(out) {
  return String(out || "").startsWith("PZZA_DENIED");
}

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};
export function mimeType(p) {
  return MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
}
