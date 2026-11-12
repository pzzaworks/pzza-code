// Path guards for file access. The code view can only ever reach the user's
// home tree, and never key material or credential stores, on both the local and
// the ssh-proxied branches.
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

const within = (root, candidate) => candidate === root || candidate.startsWith(root + path.sep);

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
// caller to report.
export function realSafePath(p) {
  const lexical = safePath(p);
  if (!lexical) return null;
  const home = os.homedir();
  let realHome;
  try { realHome = fs.realpathSync.native(home); } catch { return null; }
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
  const root = within(realHome, real) ? realHome : within(home, real) ? home : null;
  if (root && sensitivePath(path.relative(root, real))) return null;
  if (isAgentToken(real)) return null;
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
