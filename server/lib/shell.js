// Subprocess helpers. Every shell-out the agent does goes through here, so the
// source/receiver split (run locally vs hop over ssh to the devbox) lives in
// one place.
import { execFile } from "node:child_process";
import { DEVBOX, IS_CLIENT } from "./config.js";

// [user@]host or an ssh-config alias. Kept strict so it is safe to interpolate.
export const SSH_TOKEN = /^[A-Za-z0-9._@-]{1,128}$/;

// Single-quote a value for safe embedding in a remote shell command string.
export function shQuote(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}

// Run a command string either locally (source) or on the devbox over ssh.
export function sh(remote, cb) {
  if (IS_CLIENT) execFile("ssh", ["-o", "BatchMode=yes", DEVBOX, remote], cb);
  else execFile("sh", ["-c", remote], cb);
}

// Run a command on a specific device: locally/on the connected device when host
// is empty, else over SSH to that host.
export function shOn(host, remote, cb) {
  if (!host) return sh(remote, cb);
  execFile(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", host, remote],
    cb,
  );
}

export function sshBaseArgs({ port, identity }) {
  const args = [
    "-o",
    "BatchMode=yes",
    "-o",
    "ConnectTimeout=8",
    "-o",
    "StrictHostKeyChecking=accept-new",
  ];
  if (port) args.push("-p", String(port));
  if (identity) args.push("-i", identity);
  return args;
}

// Run a command and collect its result as { ok, output, error }.
export function run(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, (err, stdout, stderr) => {
      resolve({
        ok: !err,
        output: `${stdout || ""}${stderr || ""}`.trim(),
        error: err ? err.message : null,
      });
    });
  });
}

// Run a diagnostic command, returning trimmed stdout or null on failure/timeout.
export function runCheck(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 6000 }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim()),
    );
  });
}
