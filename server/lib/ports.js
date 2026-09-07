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

// This self-contained probe also runs on the selected SSH source. It reads
// process names and project manifests, never command arguments or environment.
export async function inspectPortProcesses() {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { execFile } = await import("node:child_process");
  const run = (command, args) => new Promise((resolve) => {
    execFile(command, args, { timeout: 4000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
  });
  const listeners = new Map();
  const add = (port, pid, process) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    if (!listeners.has(port)) listeners.set(port, new Map());
    if (pid) listeners.get(port).set(pid, process);
  };
  if (os.platform() === "linux") {
    const output = await run("ss", ["-ltnpH"]);
    for (const line of output.split("\n")) {
      const port = Number(line.trim().split(/\s+/)[3]?.match(/:(\d+)$/)?.[1]);
      add(port);
      for (const match of line.matchAll(/\("([^"]+)",pid=(\d+)/g)) add(port, Number(match[2]), match[1]);
    }
  } else if (os.platform() === "darwin") {
    let pid;
    let process;
    for (const line of (await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])).split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (line.startsWith("c")) process = line.slice(1);
      if (line.startsWith("n")) add(Number(line.match(/:(\d+)$/)?.[1]), pid, process);
    }
  } else {
    throw new Error("Process identification is not available on this operating system.");
  }
  const pids = [...new Set([...listeners.values()].flatMap((entries) => [...entries.keys()]))];
  const directories = new Map();
  if (os.platform() === "darwin" && pids.length) {
    let pid;
    for (const line of (await run("lsof", ["-a", "-p", pids.join(","), "-d", "cwd", "-Fn"])).split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (line.startsWith("n")) directories.set(pid, line.slice(1));
    }
  }
  const home = os.homedir();
  const clean = (text) => typeof text === "string" ? text.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 120) : "";
  const projects = new Map();
  const projectAt = async (cwd) => {
    if (!cwd || (cwd !== home && !cwd.startsWith(home + path.sep))) return null;
    if (projects.has(cwd)) return projects.get(cwd);
    const pending = (async () => {
      let directory = cwd;
      for (let depth = 0; depth < 5 && directory !== home; depth++, directory = path.dirname(directory)) {
        try {
          const file = path.join(directory, "package.json");
          const stat = await fs.lstat(file);
          if (stat.isFile() && stat.size <= 65536) {
            const manifest = JSON.parse(await fs.readFile(file, "utf8"));
            const name = clean(manifest.name);
            if (name) return { name, source: "package", folder: path.basename(directory) };
          }
        } catch { /* A folder without a readable manifest can still identify the project. */ }
      }
      return cwd === home ? null : { name: clean(path.basename(cwd)), source: "folder", folder: clean(path.basename(cwd)) };
    })();
    projects.set(cwd, pending);
    return pending;
  };
  const identities = new Map();
  // Bound concurrent filesystem reads, even when a device has many listeners.
  for (let offset = 0; offset < pids.length; offset += 8) {
    await Promise.all(pids.slice(offset, offset + 8).map(async (pid) => {
      let cwd = directories.get(pid);
      if (os.platform() === "linux") {
        try { cwd = await fs.readlink(`/proc/${pid}/cwd`); } catch { /* Process ownership may hide its directory. */ }
      }
      identities.set(pid, await projectAt(cwd));
    }));
  }
  return [...listeners].sort(([a], [b]) => a - b).map(([port, entries]) => ({
    port,
    processes: [...entries].map(([pid, process]) => {
      const project = identities.get(pid);
      const runtime = /^(node|nodejs|bun|deno|python[0-9.]*|ruby|java|dotnet)$/i.test(process || "");
      return { pid, process: clean(process), name: project?.name || (runtime ? "Project name unavailable" : clean(process)) || "Unidentified service", source: project?.source || "process", folder: project?.folder || null };
    }),
  }));
}

const pendingDetails = new Map();
export async function listPortDetails(host = "") {
  const { DEVBOX, IS_CLIENT } = await import("./config.js");
  const { SSH_TOKEN, shQuote } = await import("./shell.js");
  const { execFile } = await import("node:child_process");
  if (host && !SSH_TOKEN.test(host)) throw new Error("Invalid device host");
  const target = host || (IS_CLIENT ? DEVBOX : "");
  if (pendingDetails.has(target)) return pendingDetails.get(target);
  const pending = (async () => {
    if (!target) return inspectPortProcesses();
    const script = `(${inspectPortProcesses.toString()})().then(result => console.log(JSON.stringify(result))).catch(() => process.exit(1))`;
    return new Promise((resolve, reject) => {
      execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, `node -e ${shQuote(script)}`],
        { timeout: 10000, maxBuffer: 2 * 1024 * 1024 }, (error, output) => {
          if (error) return reject(new Error("Could not identify services on the source device (Node.js is required)."));
          try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid process information from source device")); }
        });
    });
  })().finally(() => pendingDetails.delete(target));
  pendingDetails.set(target, pending);
  return pending;
}
