import { execFile } from "node:child_process";
import { SSH_TOKEN, shQuote, deviceEnv } from "./shell.js";
import { tmuxCommand } from "./tmux-client.js";

export const QUICK_CHAT_SESSION = "pzza-quick-chat";

export function quickChatCommand(agent, host = "") {
  if (agent !== "claude" && agent !== "codex") throw new Error("Choose a supported agent.");
  // A fixed name and atomic tmux creation prevent duplicate sessions, even
  // across concurrent clients. The session environment identifies our session.
  // Both profiles launch their CLI directly (claude / codex).
  const tmux = tmuxCommand(host);
  const launcher = agent;
  const create = `
  executable=$(command -v ${agent}) || exit 42
  ${tmux} new-session -d -s pzza-quick-chat -x 160 -y 45 -c "$HOME" -e PZZA_QUICK_CHAT_AGENT=${agent} -e PZZA_QUICK_CHAT_LAUNCHER=${launcher} -e "PATH=$PATH" sh -c ${shQuote('exec "$1"')} quick-chat "$executable" 2>/dev/null || ${tmux} has-session -t '=pzza-quick-chat' 2>/dev/null || exit 43`;
  return `command -v tmux >/dev/null 2>&1 || exit 41
if ! ${tmux} has-session -t '=pzza-quick-chat' 2>/dev/null; then${create}
fi
owner=$(${tmux} show-environment -t '=pzza-quick-chat' PZZA_QUICK_CHAT_AGENT 2>/dev/null) || exit 44
launcher=$(${tmux} show-environment -t '=pzza-quick-chat' PZZA_QUICK_CHAT_LAUNCHER 2>/dev/null || true)
case "$owner:$launcher" in
  PZZA_QUICK_CHAT_AGENT=claude:PZZA_QUICK_CHAT_LAUNCHER=claude|PZZA_QUICK_CHAT_AGENT=codex:PZZA_QUICK_CHAT_LAUNCHER=codex) ;;
  PZZA_QUICK_CHAT_AGENT=claude:|PZZA_QUICK_CHAT_AGENT=codex:) launcher="PZZA_QUICK_CHAT_LAUNCHER=\${owner#*=}" ;;
  *) exit 44 ;;
esac
identity=$(${tmux} display-message -p -t '=pzza-quick-chat:' '#{session_id}:#{session_created}:#{pid}') || exit 45
printf '%s\\n%s\\n%s' "\${owner#*=}" "\${launcher#*=}" "$identity"`;
}

export function openQuickChat(body, run = execFile) {
  return runQuickChat(body, "open", run);
}

export function closeQuickChat(body, run = execFile) {
  return runQuickChat(body, "close", run);
}

// This probe never starts a process. Identity guards against attaching to a
// different conversation that reused the fixed name after termination.
export function verifyQuickChat(body, run = execFile) {
  return runQuickChat(body, "verify", run);
}

export function quickChatAttachmentGuard(agent, identity, tmux = "tmux") {
  if ((agent !== "claude" && agent !== "codex") || !/^\$[0-9]+:[0-9]+:[0-9]+$/.test(identity)) throw new Error("Invalid Quick Chat identity.");
  return `${tmux} has-session -t '=pzza-quick-chat' 2>/dev/null || exit 45; ` +
    `[ "$(${tmux} show-environment -t '=pzza-quick-chat' PZZA_QUICK_CHAT_AGENT 2>/dev/null)" = ${shQuote(`PZZA_QUICK_CHAT_AGENT=${agent}`)} ] || exit 44; ` +
    `[ "$(${tmux} display-message -p -t '=pzza-quick-chat:' '#{session_id}:#{session_created}:#{pid}' 2>/dev/null)" = ${shQuote(identity)} ] || exit 45; `;
}

function runQuickChat(body, operation, run) {
  const closing = operation === "close";
  const verifying = operation === "verify";
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => !["host", ...(!closing ? ["agent"] : []), ...(verifying ? ["identity"] : [])].includes(key)) ||
      typeof body.host !== "string" || (body.host && !SSH_TOKEN.test(body.host)) ||
      (!closing && body.agent !== "claude" && body.agent !== "codex") ||
      (verifying && (typeof body.identity !== "string" || !/^\$[0-9]+:[0-9]+:[0-9]+$/.test(body.identity)))) {
    return Promise.reject(Object.assign(new Error("Choose a valid device and agent."), { status: 400 }));
  }
  const tmux = tmuxCommand(body.host);
  const command = closing ? `command -v tmux >/dev/null 2>&1 || exit 41
if ! ${tmux} has-session -t '=pzza-quick-chat' 2>/dev/null; then exit 0; fi
owner=$(${tmux} show-environment -t '=pzza-quick-chat' PZZA_QUICK_CHAT_AGENT 2>/dev/null) || exit 44
launcher=$(${tmux} show-environment -t '=pzza-quick-chat' PZZA_QUICK_CHAT_LAUNCHER 2>/dev/null || true)
case "$owner:$launcher" in
  PZZA_QUICK_CHAT_AGENT=claude:PZZA_QUICK_CHAT_LAUNCHER=claude|PZZA_QUICK_CHAT_AGENT=codex:PZZA_QUICK_CHAT_LAUNCHER=codex|PZZA_QUICK_CHAT_AGENT=claude:|PZZA_QUICK_CHAT_AGENT=codex:) ${tmux} kill-session -t '=pzza-quick-chat' ;;
  *) exit 44 ;;
esac` : verifying ? quickChatAttachmentGuard(body.agent, body.identity, tmux) : quickChatCommand(body.agent, body.host);
  // Explicit empty host always means this device, including receiver mode.
  const args = body.host ? ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
    "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", body.host, command] : ["-c", command];
  return new Promise((resolve, reject) => {
    run(body.host ? "ssh" : "sh", args, { timeout: 15000, maxBuffer: 16384, env: deviceEnv(body.host) }, (error, stdout) => {
      if (error) {
        const message = {
          41: "tmux is not installed or is not on this device's PATH.",
          42: body.agent === "codex"
            ? "Codex is not installed or is not on this device's PATH."
            : "Claude is not installed or is not on this device's PATH.",
          43: "Quick Chat could not start. Check the launcher installation and login on this device.",
          44: "A session named pzza-quick-chat already exists but is not the expected managed Quick Chat session.",
          45: "This Quick Chat conversation ended or was replaced. It cannot be reattached.",
        }[error.code] ?? "Could not reach this device or open Quick Chat. Retry or choose another device. Check SSH access and the trusted host key for remote devices.";
        reject(Object.assign(new Error(message), { status: 503 }));
        return;
      }
      if (closing) { resolve({ closed: true }); return; }
      if (verifying) { resolve({ verified: true }); return; }
      const [agent, launcher, identity, extra] = String(stdout).trim().split("\n");
      const validLauncher = (agent === "claude" && launcher === "claude") ||
        (agent === "codex" && launcher === "codex");
      if ((agent !== "claude" && agent !== "codex") || !validLauncher ||
          !/^\$[0-9]+:[0-9]+:[0-9]+$/.test(identity ?? "") || extra !== undefined) {
        reject(Object.assign(new Error("The device returned an invalid Quick Chat response."), { status: 502 }));
        return;
      }
      resolve({ session: QUICK_CHAT_SESSION, host: body.host, agent, launcher, identity });
    });
  });
}

export async function quickChatRouter(req, res, url, json) {
  if (!["/quick-chat/open", "/quick-chat/close", "/quick-chat/verify"].includes(url.pathname)) return false;
  if (req.method !== "POST") { json(res, 405, { error: "Use POST." }); return true; }
  const timer = setTimeout(() => req.destroy(), 5000);
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 2048) {
        json(res, 413, { error: "Request too large." });
        return true;
      }
    }
    clearTimeout(timer);
    let value;
    try { value = JSON.parse(body); }
    catch { json(res, 400, { error: "Invalid request." }); return true; }
    const execute = url.pathname === "/quick-chat/close" ? closeQuickChat : url.pathname === "/quick-chat/verify" ? verifyQuickChat : openQuickChat;
    json(res, 200, await execute(value));
  } catch (error) {
    if (!res.destroyed) json(res, error.status ?? 503, { error: error.message });
  } finally { clearTimeout(timer); }
  return true;
}
