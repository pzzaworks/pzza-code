import { execFile } from "node:child_process";
import { SSH_TOKEN, shQuote, deviceEnv } from "./shell.js";
import { tmuxCommand } from "./tmux-client.js";

export const QUICK_CHAT_SESSION = "pzza-quick-chat";

export function quickChatCommand(agent, host = "") {
  if (agent !== "claude" && agent !== "codex") throw new Error("Choose a supported agent.");
  // A fixed name and atomic tmux creation prevent duplicate sessions, even
  // across concurrent clients. The session environment identifies our session.
  const tmux = tmuxCommand(host);
  return `command -v tmux >/dev/null 2>&1 || exit 41
if ! ${tmux} has-session -t '=pzza-quick-chat' 2>/dev/null; then
  executable=$(command -v ${agent}) || exit 42
  ${tmux} new-session -d -s pzza-quick-chat -x 160 -y 45 -c "$HOME" -e PZZA_QUICK_CHAT_AGENT=${agent} -e "PATH=$PATH" sh -c ${shQuote('exec "$1"')} quick-chat "$executable" 2>/dev/null || ${tmux} has-session -t '=pzza-quick-chat' 2>/dev/null || exit 43
fi
owner=$(${tmux} show-environment -t '=pzza-quick-chat' PZZA_QUICK_CHAT_AGENT 2>/dev/null) || exit 44
case "$owner" in
  PZZA_QUICK_CHAT_AGENT=claude) printf 'claude' ;;
  PZZA_QUICK_CHAT_AGENT=codex) printf 'codex' ;;
  *) exit 44 ;;
esac`;
}

export function openQuickChat(body, run = execFile) {
  return runQuickChat(body, false, run);
}

export function closeQuickChat(body, run = execFile) {
  return runQuickChat(body, true, run);
}

function runQuickChat(body, closing, run) {
  if (!body || typeof body !== "object" || Array.isArray(body) ||
      Object.keys(body).some(key => key !== "host" && (closing || key !== "agent")) ||
      typeof body.host !== "string" || (body.host && !SSH_TOKEN.test(body.host)) ||
      (!closing && body.agent !== "claude" && body.agent !== "codex")) {
    return Promise.reject(Object.assign(new Error("Choose a valid device and agent."), { status: 400 }));
  }
  const tmux = tmuxCommand(body.host);
  const command = closing ? `command -v tmux >/dev/null 2>&1 || exit 41
if ! ${tmux} has-session -t '=pzza-quick-chat' 2>/dev/null; then exit 0; fi
owner=$(${tmux} show-environment -t '=pzza-quick-chat' PZZA_QUICK_CHAT_AGENT 2>/dev/null) || exit 44
case "$owner" in
  PZZA_QUICK_CHAT_AGENT=claude|PZZA_QUICK_CHAT_AGENT=codex) ${tmux} kill-session -t '=pzza-quick-chat' ;;
  *) exit 44 ;;
esac` : quickChatCommand(body.agent, body.host);
  // Explicit empty host always means this device, including receiver mode.
  const args = body.host ? ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
    "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "ClearAllForwardings=yes",
    "-o", "ControlMaster=no", "-o", "ControlPath=none", body.host, command] : ["-c", command];
  return new Promise((resolve, reject) => {
    run(body.host ? "ssh" : "sh", args, { timeout: 15000, maxBuffer: 16384, env: deviceEnv(body.host) }, (error, stdout) => {
      if (error) {
        const message = {
          41: "tmux is not installed or is not on this device's PATH.",
          42: "The selected agent is not installed or is not on this device's PATH.",
          43: "Quick Chat could not start. Check the agent installation and login on this device.",
          44: "A session named pzza-quick-chat already exists but is not a managed Quick Chat session.",
        }[error.code] ?? "Could not reach this device or open Quick Chat. Retry or choose another device. Check SSH access and the trusted host key for remote devices.";
        reject(Object.assign(new Error(message), { status: 503 }));
        return;
      }
      if (closing) { resolve({ closed: true }); return; }
      const agent = String(stdout).trim();
      if (agent !== "claude" && agent !== "codex") {
        reject(Object.assign(new Error("The device returned an invalid Quick Chat response."), { status: 502 }));
        return;
      }
      resolve({ session: QUICK_CHAT_SESSION, host: body.host, agent });
    });
  });
}

export async function quickChatRouter(req, res, url, json) {
  if (url.pathname !== "/quick-chat/open" && url.pathname !== "/quick-chat/close") return false;
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
    json(res, 200, await (url.pathname === "/quick-chat/close" ? closeQuickChat(value) : openQuickChat(value)));
  } catch (error) {
    if (!res.destroyed) json(res, error.status ?? 503, { error: error.message });
  } finally { clearTimeout(timer); }
  return true;
}
