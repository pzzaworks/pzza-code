// Listening TCP ports on the connected device.
import { sh } from "./shell.js";

export function parsePorts(stdout) {
  const ports = new Set();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/:(\d+)$/);
    if (m) ports.add(Number(m[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

export function listPorts() {
  return new Promise((resolve) => {
    sh("ss -tlnH 2>/dev/null | awk '{print $4}'", (err, out) =>
      resolve(err ? [] : parsePorts(out)),
    );
  });
}
