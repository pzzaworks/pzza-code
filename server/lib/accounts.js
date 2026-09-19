// Claude / Codex agent accounts on this device: discovery, identity, OAuth/token
// reading for the selected account.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

export function jwtClaims(token) {
  try {
    const part = String(token).split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// Auto-discover Claude (~/.claude*) and Codex (~/.codex*) config dirs, plus the
// OpenCode config dir (whose Go key lives in the shared auth file).
export function discoverAccounts() {
  const home = os.homedir();
  const accounts = [];
  let entries = [];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return accounts;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const dir = path.join(home, name);
    if (name === ".claude" || name.startsWith(".claude-")) {
      if (fs.existsSync(path.join(dir, ".credentials.json")) || fs.existsSync(path.join(dir, "projects"))) {
        accounts.push({ provider: "claude", dir, label: name === ".claude" ? "Claude" : name.slice(1) });
      }
    } else if (name === ".codex" || name.startsWith(".codex-")) {
      if (fs.existsSync(path.join(dir, "auth.json"))) {
        accounts.push({ provider: "codex", dir, label: name === ".codex" ? "Codex" : name.slice(1) });
      }
    }
  }
  const opencodeDir = opencodeConfigDir();
  if (opencodeDir && hasOpencodeKey()) {
    accounts.push({ provider: "opencode", dir: opencodeDir, label: "OpenCode" });
  }
  return accounts;
}

function configHome() {
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config");
}

function dataHome() {
  return process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
}

// The OpenCode config dir when it exists (opencode.json lives here).
export function opencodeConfigDir() {
  const dir = path.join(configHome(), "opencode");
  try {
    if (fs.statSync(dir).isDirectory()) return dir;
  } catch {
    /* not installed */
  }
  return null;
}

function readOpencodeAuth() {
  for (const dir of [path.join(dataHome(), "opencode"), path.join(os.homedir(), ".opencode")]) {
    try {
      const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
      if (auth && typeof auth === "object") return auth;
    } catch {
      /* try the next location */
    }
  }
  return null;
}

// The Go API key from the shared opencode auth file, or null when OpenCode
// Go is not connected on this device.
export function readOpencodeKey() {
  try {
    const key = readOpencodeAuth()?.opencode?.key;
    return typeof key === "string" && key ? key : null;
  } catch {
    return null;
  }
}

// Masked fingerprint of an API key for display: enough to tell keys apart,
// never enough to reuse. The full secret stays in the backend.
export function maskApiKey(key) {
  const s = String(key ?? "");
  if (s.length > 12) return `${s.slice(0, 4)}…${s.slice(-4)}`;
  if (s.length > 4) return `${s.slice(0, 2)}…${s.slice(-2)}`;
  return "••••";
}

// Extra OpenCode Go keys from the user's shell key file (~/.opencode-keys):
// one `export NAME="key"` per line. Comments, non-export lines and short
// non-key values are ignored. Accepts an explicit path so tests never touch
// the real file.
export function readOpencodeKeysFile(keysPath = path.join(os.homedir(), ".opencode-keys")) {
  let text;
  try {
    text = fs.readFileSync(keysPath, "utf8");
  } catch {
    return [];
  }
  const keys = [];
  for (const line of text.split("\n")) {
    const match = /^\s*export\s+([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s#]+))/.exec(line);
    if (!match) continue;
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (/^[A-Za-z0-9\-_]{20,}$/.test(value) && !keys.includes(value)) keys.push(value);
  }
  return keys;
}

// Every OpenCode Go key on this device: the connected auth.json key first,
// then the shell key file. Callers distinguish cards by fingerprint.
export function readOpencodeKeys(keysFile) {
  const keys = [];
  const authKey = readOpencodeKey();
  if (authKey) keys.push(authKey);
  for (const key of readOpencodeKeysFile(keysFile)) {
    if (!keys.includes(key)) keys.push(key);
  }
  return keys;
}

function hasOpencodeKey() {
  return readOpencodeKey() !== null;
}

export function readClaudeIdentity(dir) {
  const candidates = [`${dir}.json`, path.join(dir, ".claude.json"), path.join(os.homedir(), ".claude.json")];
  for (const f of candidates) {
    try {
      const oa = JSON.parse(fs.readFileSync(f, "utf8")).oauthAccount || {};
      if (oa.emailAddress) {
        return { email: oa.emailAddress, plan: oa.organizationType, tier: oa.userRateLimitTier };
      }
    } catch {
      /* try next */
    }
  }
  return {};
}

// Claude Code keys its login-Keychain entry per config dir: the default
// ~/.claude uses the plain service name, any other dir (CLAUDE_CONFIG_DIR)
// suffixes it with the first 8 hex chars of the dir path's sha256.
function keychainService(dir) {
  const base = "Claude Code-credentials";
  if (path.resolve(dir) === path.join(os.homedir(), ".claude")) return base;
  return `${base}-${crypto.createHash("sha256").update(dir).digest("hex").slice(0, 8)}`;
}

// The Claude OAuth blob for an account. Linux/devbox keeps it in a file; macOS
// (where Claude Code stores it in the login Keychain) has no file, so fall back
// to that account's Keychain entry.
export async function readClaudeOAuth(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"));
    if (j.claudeAiOauth) return j.claudeAiOauth;
  } catch {
    /* no file - try the Keychain below */
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await promisify(execFile)("security", ["find-generic-password", "-s", keychainService(dir), "-w"], {
        encoding: "utf8", timeout: 2000, maxBuffer: 128 * 1024,
      });
      const j = JSON.parse(stdout);
      if (j.claudeAiOauth) return j.claudeAiOauth;
    } catch {
      /* not in Keychain */
    }
  }
  return null;
}

export function readCodexCreds(dir) {
  const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
  const tokens = auth.tokens || {};
  const claims = jwtClaims(tokens.access_token);
  const a = claims["https://api.openai.com/auth"] || {};
  const p = claims["https://api.openai.com/profile"] || {};
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id || a.chatgpt_account_id,
    plan: a.chatgpt_plan_type,
    email: p.email,
  };
}

// The Claude / Codex accounts (config dirs) on this device, with identity only.
// OpenCode is usage-only (its sessions are not bindable), so it stays out of
// this list even though discovery reports it.
export function listAccounts() {
  return discoverAccounts().filter((acc) => acc.provider === "claude" || acc.provider === "codex").map((acc) => {
    let email;
    let plan;
    try {
      if (acc.provider === "claude") {
        const id = readClaudeIdentity(acc.dir);
        email = id.email;
        plan = id.plan;
      } else {
        const c = readCodexCreds(acc.dir);
        email = c.email;
        plan = c.plan;
      }
    } catch {
      /* identity optional */
    }
    return { provider: acc.provider, label: acc.label, dir: acc.dir, email, plan };
  });
}
