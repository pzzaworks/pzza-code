// Claude / Codex agent accounts on this device: discovery, identity, OAuth/token
// reading, and the env arg that points an agent CLI at a specific account.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { shQuote } from "./shell.js";

export function jwtClaims(token) {
  try {
    const part = String(token).split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// Auto-discover Claude (~/.claude*) and Codex (~/.codex*) config dirs.
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
  return accounts;
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

// The Claude OAuth blob for an account. Linux/devbox keeps it in a file; macOS
// (where Claude Code stores it in the login Keychain) has no file, so fall back
// to the Keychain entry for the default account.
export function readClaudeOAuth(dir) {
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, ".credentials.json"), "utf8"));
    if (j.claudeAiOauth) return j.claudeAiOauth;
  } catch {
    /* no file - try the Keychain below */
  }
  if (process.platform === "darwin" && path.basename(dir) === ".claude") {
    try {
      const out = execFileSync("security", ["find-generic-password", "-s", "Claude Code-credentials", "-w"], {
        encoding: "utf8",
      });
      const j = JSON.parse(out);
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
export function listAccounts() {
  return discoverAccounts().map((acc) => {
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

// Env var that points an agent CLI at a specific account's config dir.
export function accountEnvArg(account) {
  if (!account || typeof account.dir !== "string") return "";
  const dir = path.resolve(account.dir);
  const home = os.homedir();
  if (!home || !dir.startsWith(home) || !fs.existsSync(dir)) return "";
  const key = account.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  return ` -e ${shQuote(`${key}=${dir}`)}`;
}
