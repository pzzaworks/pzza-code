import { execFile } from "node:child_process";
import { SSH_TOKEN, shQuote } from "./shell.js";

// Authentication happens inside the destination account; only the response crosses SSH.
async function requestOnDevice() {
  const fs = await import("node:fs");
  const os = await import("node:os");
  const path = await import("node:path");
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  const { endpoint, body } = JSON.parse(input);
  const file = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "pzzacode", "agent-token");
  const fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  let token;
  try {
    const meta = fs.fstatSync(fd);
    if (!meta.isFile() || meta.size > 4096 || (meta.mode & 0o077) || (process.getuid && meta.uid !== process.getuid())) throw new Error("Unsafe token file");
    token = fs.readFileSync(fd, "utf8").trim();
  } finally { fs.closeSync(fd); }
  const response = await fetch(`http://127.0.0.1:5190${endpoint}`, {
    method: body === undefined ? "GET" : "POST", redirect: "error", signal: AbortSignal.timeout(10000),
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    process.stdout.write(JSON.stringify({ deviceAgentError: response.status }));
    return;
  }
  const text = await response.text();
  if (text.length > 2 * 1024 * 1024) throw new Error("Device response is too large");
  process.stdout.write(text);
}

export function deviceAgentRequest(host, endpoint, body) {
  const allowed = body === undefined ? /^\/(?:(?:usage|spend)(?:\?fresh=1)?|bridge\/state)$/.test(endpoint) : ["/bridge/pair-grant", "/bridge/approval-status", "/bridge/approval-cancel"].includes(endpoint);
  if (!SSH_TOKEN.test(host) || !allowed) return Promise.reject(new Error("Invalid device agent request"));
  const script = `(${requestOnDevice.toString()})().catch(() => { process.exitCode = 1; });`;
  const command = `if command -v node >/dev/null 2>&1; then exec node -e ${shQuote(script)}; fi; for runtime in "$HOME/.local/bin/node" /opt/homebrew/bin/node /usr/local/bin/node /usr/bin/node "$HOME"/.nvm/versions/node/*/bin/node; do if test -x "$runtime"; then exec "$runtime" -e ${shQuote(script)}; fi; done; exit 127`;
  return new Promise((resolve, reject) => {
    const child = execFile("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "--", host, command],
      { timeout: 14000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
        if (error) return reject(new Error("Device agent is unavailable. Check trusted SSH access, Node.js and that the app is running on the device."));
        let value;
        try { value = JSON.parse(stdout); } catch { return reject(new Error("Device returned an invalid response")); }
        if (value?.deviceAgentError) {
          const status = value.deviceAgentError;
          return reject(Object.assign(new Error(status === 404 ? "Update the device agent in device settings to enable bridge pairing." : status === 401 ? "The device agent authentication is out of date. Restart its managed agent." : status === 409 ? "Bridge settings changed on the device. Read its identity again and retry." : "The device rejected the bridge setup. Check its project folder and access settings."), { status }));
        }
        resolve(value);
      });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ endpoint, ...(body === undefined ? {} : { body }) }));
  });
}

function createRemoteAccountData(endpoint, markStale, { request = deviceAgentRequest, now = Date.now } = {}) {
  const cache = new Map();
  return async (host, fresh = false) => {
    if (!SSH_TOKEN.test(host)) throw new Error("Invalid device host");
    let entry = cache.get(host);
    if (!entry) { entry = { value: null, pending: null, nextAt: 0, error: null }; cache.set(host, entry); }
    if (entry.pending) return entry.value ?? entry.pending;
    if (!fresh && now() < entry.nextAt) {
      if (entry.value) return entry.value;
      throw entry.error;
    }
    entry.pending = request(host, `${endpoint}${fresh ? "?fresh=1" : ""}`).then(value => {
      if (!Array.isArray(value)) throw new Error("Invalid device account response");
      entry.value = value; entry.error = null; entry.nextAt = now() + 5 * 60 * 1000;
      return value;
    }).catch(error => {
      entry.error = error; entry.nextAt = now() + 30000;
      if (entry.value) {
        entry.value = markStale(entry.value);
        return entry.value;
      }
      throw error;
    }).finally(() => { entry.pending = null; });
    if (entry.value && !fresh) { void entry.pending.catch(() => undefined); return entry.value; }
    return entry.pending;
  };
}

export function createRemoteUsage(options) {
  return createRemoteAccountData("/usage", value => value.map(account => ({ ...account, usage: account.usage ? { ...account.usage, stale: true } : null })), options);
}

export function createRemoteSpend(options) {
  return createRemoteAccountData("/spend", value => value, options);
}
