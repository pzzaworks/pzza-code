// Environment diagnostics for the setup wizard, and SSH-target discovery for the
// add-a-device flow.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { DEVBOX, IS_CLIENT, PORT, STATE_DIR } from "./config.js";
import { SSH_TOKEN, runCheck } from "./shell.js";
import { tmuxArgs } from "./tmux-client.js";
import { SESSION_AGENTS, agentBinaryAllowed } from "./session-agents.js";

// Lists every executable of each catalog binary on PATH, in PATH order, then
// in its per-user install folders, so a same-named tool earlier on PATH does
// not hide the agent. One shell runs every lookup; names arrive as arguments,
// never as code.
const AGENT_LOOKUP_SCRIPT = `set -f
while [ "$#" -ge 3 ]; do
  id=$1; binary=$2; folders=$3; shift 3
  saved=$IFS; IFS=:
  for folder in $PATH; do
    case "$folder" in /*) if [ -f "$folder/$binary" ] && [ -x "$folder/$binary" ]; then printf '%s\\t%s\\n' "$id" "$folder/$binary"; fi ;; esac
  done
  for folder in $folders; do
    if [ -n "$folder" ] && [ -f "$HOME/$folder/$binary" ] && [ -x "$HOME/$folder/$binary" ]; then printf '%s\\t%s\\n' "$id" "$HOME/$folder/$binary"; fi
  done
  IFS=$saved
done`;

/** Which catalog agents are installed on this device: each id with its binary's path, or null. */
export function installedAgents(run = execFile) {
  const lookups = SESSION_AGENTS.flatMap(agent => agent.binaries.flatMap(binary => [agent.id, binary, agent.installDirs.join(":")]));
  return new Promise((resolve) => {
    run("sh", ["-c", AGENT_LOOKUP_SCRIPT, "agent-lookup", ...lookups], { timeout: 5_000, maxBuffer: 256 * 1024 }, (error, stdout) => {
      const paths = new Map();
      for (const line of error ? [] : String(stdout).split("\n")) {
        const [id, found] = line.split("\t");
        const agent = SESSION_AGENTS.find(item => item.id === id);
        if (!agent || !found?.startsWith("/") || paths.has(id)) continue;
        // A same-named tool (Foundry's forge, the goose migration tool) is not the agent.
        let real = found;
        try { real = fs.realpathSync(found); } catch { /* a dangling link still reports its own path */ }
        if (agentBinaryAllowed(agent, [found, real])) paths.set(id, found);
      }
      resolve(SESSION_AGENTS.map(agent => ({ id: agent.id, path: paths.get(agent.id) ?? null })));
    });
  });
}

export async function doctor() {
  const tmuxVersion = await runCheck("tmux", tmuxArgs(["-V"]));
  let stateWritable = false;
  try {
    fs.accessSync(STATE_DIR, fs.constants.W_OK);
    stateWritable = true;
  } catch {
    /* not writable */
  }
  const result = {
    role: IS_CLIENT ? "client" : "source",
    host: DEVBOX || null,
    port: PORT,
    node: process.version,
    tmux: tmuxVersion, // "tmux 3.6" or null when missing
    nodePty: true, // the module imported, so the native binding loaded
    stateDir: STATE_DIR,
    stateWritable,
    // Optional coding agents; nothing is installed from here.
    agents: await installedAgents(),
  };
  if (IS_CLIENT) {
    result.sshReachable = await new Promise((resolve) => {
      execFile(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", DEVBOX, "true"],
        (err) => resolve(!err),
      );
    });
  }
  return result;
}

// Auto-discover SSH targets from ~/.ssh/config (named, non-wildcard hosts) and
// the private-key identity files in ~/.ssh, so the Add-a-device wizard can offer
// them instead of making the user type everything by hand.
export function sshHosts() {
  const sshDir = path.join(os.homedir(), ".ssh");
  const hosts = [];
  try {
    const cfg = fs.readFileSync(path.join(sshDir, "config"), "utf8");
    let cur = null;
    for (const raw of cfg.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(\S+)\s+(.+?)\s*$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === "host") {
        const pat = val.split(/\s+/).find((p) => !p.includes("*") && !p.includes("?"));
        // Skip a wildcard-only block, and collapse repeated Host blocks with the
        // same alias onto the first one so the wizard shows each target once.
        if (!pat) {
          cur = null;
        } else {
          cur = hosts.find((h) => h.host === pat);
          if (!cur) {
            cur = { host: pat };
            hosts.push(cur);
          }
        }
      } else if (cur) {
        if (key === "hostname") cur.hostname = val;
        else if (key === "user") cur.user = val;
        else if (key === "port" && Number(val)) cur.port = Number(val);
        else if (key === "identityfile") cur.identity = val;
      }
    }
  } catch {
    /* no ssh config */
  }
  const identities = [];
  try {
    const skip = new Set(["config", "known_hosts", "known_hosts_old", "authorized_keys"]);
    for (const name of fs.readdirSync(sshDir).sort()) {
      if (name.endsWith(".pub") || skip.has(name) || name.startsWith(".")) continue;
      const full = path.join(sshDir, name);
      try {
        if (!fs.statSync(full).isFile()) continue;
        const head = fs.readFileSync(full, "utf8").slice(0, 40);
        if (head.includes("PRIVATE KEY") || fs.existsSync(`${full}.pub`) || /^id_/.test(name)) {
          identities.push(full);
        }
      } catch {
        /* unreadable - skip */
      }
    }
  } catch {
    /* no ssh dir */
  }
  return { dir: sshDir, hosts, identities };
}

const deviceOsCache = new Map();
const deviceOsPending = new Map();

export function normalizeDeviceOs(value) {
  const system = String(value).trim().toLowerCase();
  if (system === "darwin") return "macos";
  if (system === "linux") return "linux";
  if (/windows|^(mingw|msys|cygwin)/.test(system)) return "windows";
  if (system === "freebsd") return "freebsd";
  return "unknown";
}

export async function deviceOs(host = "") {
  if (!host) return { os: normalizeDeviceOs(os.type()) };
  if (!SSH_TOKEN.test(host)) return { os: "unknown" };
  const cached = deviceOsCache.get(host);
  if (cached && cached.expires > Date.now()) return cached.result;
  if (deviceOsPending.has(host)) return deviceOsPending.get(host);
  const pending = new Promise((resolve) => {
    execFile("ssh", [
      "-o", "BatchMode=yes", "-o", "ConnectTimeout=5",
      "-o", "StrictHostKeyChecking=yes", host, "uname -s || ver",
    ], { timeout: 7000, maxBuffer: 4096 }, (error, stdout) => {
      const result = { os: error ? "unknown" : normalizeDeviceOs(stdout) };
      if (deviceOsCache.size >= 256) deviceOsCache.delete(deviceOsCache.keys().next().value);
      deviceOsCache.set(host, { result, expires: Date.now() + (result.os === "unknown" ? 30000 : 3600000) });
      deviceOsPending.delete(host);
      resolve(result);
    });
  });
  deviceOsPending.set(host, pending);
  return pending;
}
