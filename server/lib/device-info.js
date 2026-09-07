import { execFile } from "node:child_process";
import { performance } from "node:perf_hooks";
import { isIP } from "node:net";
import { SSH_TOKEN, shQuote } from "./shell.js";

// This read-only probe also runs on SSH devices. It never reads environment
// variables, process arguments, credentials, or terminal content.
export async function collectDeviceInfo() {
  const os = await import("node:os");
  const fs = await import("node:fs/promises");
  const { execFile } = await import("node:child_process");
  const platform = os.platform();
  const normalized = { darwin: "macos", win32: "windows", linux: "linux", freebsd: "freebsd" }[platform] || "unknown";
  let osName = { darwin: "macOS", win32: "Windows", linux: "Linux", freebsd: "FreeBSD" }[platform] || os.type();
  let osVersion = null;
  let availableBytes = null;
  if (platform === "linux") {
    const [release, memory] = await Promise.all([
      fs.readFile("/etc/os-release", "utf8").catch(() => ""),
      fs.readFile("/proc/meminfo", "utf8").catch(() => ""),
    ]);
    const fields = new Map(release.split("\n").map((line) => {
      const match = line.match(/^([A-Z_]+)=(.*)$/);
      if (!match) return ["", ""];
      let value = match[2];
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) value = value.slice(1, -1);
      return [match[1], value];
    }));
    osName = fields.get("NAME") || osName;
    osVersion = fields.get("VERSION_ID") || null;
    const available = memory.match(/^MemAvailable:\s+(\d+)\s+kB$/m);
    if (available) availableBytes = Number(available[1]) * 1024;
  } else if (platform === "darwin") {
    const release = await new Promise((resolve) => execFile("sw_vers", [], { timeout: 1_500, maxBuffer: 4096 }, (error, stdout) => resolve(error ? "" : stdout)));
    osName = release.match(/^ProductName:\s*(.+)$/m)?.[1].trim() || osName;
    osVersion = release.match(/^ProductVersion:\s*(.+)$/m)?.[1].trim() || null;
  } else if (platform === "win32") osVersion = os.release();
  const cpus = os.cpus();
  const addresses = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.internal) continue;
      const family = entry.family === 4 ? "IPv4" : entry.family === 6 ? "IPv6" : entry.family;
      if (family === "IPv4" || family === "IPv6") addresses.push({ interface: name, address: entry.address, family });
    }
  }
  return {
    os: normalized, osName, osVersion, kernelVersion: os.release(), arch: os.arch(), hostname: os.hostname(), addresses,
    uptimeSeconds: os.uptime(),
    cpu: { model: cpus[0]?.model || null, logicalCores: cpus.length, loadAverage: platform === "win32" ? null : os.loadavg() },
    memory: { totalBytes: os.totalmem(), freeBytes: os.freemem(), availableBytes },
  };
}

const PROBE_SCRIPT = `(${collectDeviceInfo.toString()})().then((info) => process.stdout.write(JSON.stringify(info))).catch(() => process.stdout.write(JSON.stringify({error:"Device information probe failed"})));`;
const cachedInfo = new Map();
const pendingInfo = new Map();
const CACHE_MS = 10_000;

function sanitizedInfo(value) {
  if (!value || typeof value !== "object" || !value.cpu || !value.memory || !Array.isArray(value.addresses)) return null;
  const finite = (number) => typeof number === "number" && Number.isFinite(number) && number >= 0;
  if (![value.uptimeSeconds, value.cpu.logicalCores, value.memory.totalBytes, value.memory.freeBytes].every(finite)) return null;
  const text = (input) => typeof input === "string" ? input.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 256) : "";
  const os = ["macos", "windows", "linux", "freebsd", "unknown"].includes(value.os) ? value.os : "unknown";
  return {
    os, osName: text(value.osName), osVersion: text(value.osVersion) || null,
    kernelVersion: text(value.kernelVersion), arch: text(value.arch), hostname: text(value.hostname),
    addresses: value.addresses.filter((entry) => entry && typeof entry.address === "string" && isIP(entry.address) && ["IPv4", "IPv6"].includes(entry.family))
      .slice(0, 128).map((entry) => ({ interface: text(entry.interface), address: entry.address, family: entry.family })),
    uptimeSeconds: value.uptimeSeconds,
    cpu: { model: text(value.cpu.model) || null, logicalCores: value.cpu.logicalCores,
      loadAverage: Array.isArray(value.cpu.loadAverage) && value.cpu.loadAverage.length === 3 && value.cpu.loadAverage.every(finite) ? value.cpu.loadAverage : null },
    memory: { totalBytes: value.memory.totalBytes, freeBytes: value.memory.freeBytes,
      availableBytes: finite(value.memory.availableBytes) ? value.memory.availableBytes : null },
  };
}

export function deviceInfo(host = "", { fresh = false } = {}) {
  if (typeof host !== "string" || (host && !SSH_TOKEN.test(host))) return Promise.reject(new Error("invalid host"));
  const cached = cachedInfo.get(host);
  if (!fresh && cached && cached.expires > Date.now()) return Promise.resolve(cached.result);
  if (pendingInfo.has(host)) return pendingInfo.get(host);
  const started = performance.now();
  const result = (health, info, error) => ({ health, connection: host ? "ssh" : "local", connectionMs: Math.round((performance.now() - started) * 10) / 10, checkedAt: Date.now(), error, info });
  const request = new Promise((resolve) => {
    const command = `if command -v node >/dev/null 2>&1; then node -e ${shQuote(PROBE_SCRIPT)}; else printf '%s' '{"error":"Node.js is required on this device to inspect system details"}'; fi`;
    const args = host ? ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", "-o", "StrictHostKeyChecking=yes",
      "-o", "ControlMaster=auto", "-o", "ControlPath=~/.ssh/pzza-mux-%C", "-o", "ControlPersist=120", host, command] : ["-e", PROBE_SCRIPT];
    execFile(host ? "ssh" : process.execPath, args,
    { timeout: 8_000, maxBuffer: 128 * 1024 }, (error, stdout) => {
      if (error) {
        const unreachable = Boolean(host) && (error.killed || error.code === 255 || typeof error.code === "string");
        return resolve(result(unreachable ? "unreachable" : "reachable", null,
          error.killed ? "Device information probe timed out" : unreachable ? "Could not connect to this device over SSH" : "Device connected, but its system probe could not run"));
      }
      try {
        const payload = JSON.parse(stdout);
        const info = sanitizedInfo(payload);
        return resolve(result("reachable", info, info ? null : payload.error === "Node.js is required on this device to inspect system details"
          ? payload.error : "Device connected, but system information is unavailable"));
      } catch {
        return resolve(result("reachable", null, "Device connected, but returned invalid system information"));
      }
    });
  });
  const pending = request.then((response) => {
    if (response.info && !response.error) {
      if (cachedInfo.size >= 256) cachedInfo.delete(cachedInfo.keys().next().value);
      cachedInfo.set(host, { result: response, expires: Date.now() + CACHE_MS });
    }
    return response;
  }).finally(() => pendingInfo.delete(host));
  pendingInfo.set(host, pending);
  return pending;
}
