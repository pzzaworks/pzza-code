// Environment diagnostics for the setup wizard, and SSH-target discovery for the
// add-a-device flow.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { DEVBOX, IS_CLIENT, PORT, STATE_DIR } from "./config.js";
import { runCheck } from "./shell.js";

export async function doctor() {
  const tmuxVersion = await runCheck("tmux", ["-V"]);
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
