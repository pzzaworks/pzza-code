// Port forwarding (client/receiver only): mirror the devbox's listening ports
// onto this machine over the ssh master, in-process. The receiver owns the
// ssh -L forwards, so the global enable/disable lives here.
import { execFile } from "node:child_process";
import { DEVBOX, IS_CLIENT, MIN_PORT, SKIP } from "./config.js";
import { listPorts } from "./ports.js";

let fwdEnabled = true;
const active = new Set();

function forwardPort(port, on) {
  const spec = `${port}:127.0.0.1:${port}`;
  execFile("ssh", ["-O", on ? "forward" : "cancel", "-L", spec, DEVBOX], () => {});
}

function ensureMaster(cb) {
  execFile("ssh", ["-O", "check", DEVBOX], (err) => {
    if (!err) return cb(true);
    execFile("ssh", ["-o", "BatchMode=yes", "-N", "-f", DEVBOX], () =>
      execFile("ssh", ["-O", "check", DEVBOX], (e2) => cb(!e2)),
    );
  });
}

export async function reconcile() {
  if (!IS_CLIENT) return;
  if (!fwdEnabled) {
    for (const p of active) forwardPort(p, false);
    active.clear();
    return;
  }
  ensureMaster(async (up) => {
    if (!up) return;
    const ports = await listPorts();
    const wanted = ports.filter((p) => p >= MIN_PORT && !SKIP.has(p));
    for (const p of wanted) {
      if (!active.has(p)) {
        forwardPort(p, true);
        active.add(p);
      }
    }
    for (const p of [...active]) {
      if (!wanted.includes(p)) {
        forwardPort(p, false);
        active.delete(p);
      }
    }
  });
}

// Start the periodic reconcile loop (no-op on a source device).
export function startForwardLoop() {
  if (IS_CLIENT) setInterval(reconcile, 4000);
}

export function forwardStatus() {
  return { enabled: fwdEnabled, active: [...active].sort((a, b) => a - b) };
}

export function setForwardEnabled(enabled) {
  fwdEnabled = enabled !== false;
  reconcile();
  return fwdEnabled;
}
