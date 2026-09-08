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
// process names and project manifests, never process arguments or environments.
export async function inspectPortProcesses(options = {}) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { execFile } = await import("node:child_process");
  const run = options.run || ((command, args) => new Promise((resolve) => {
    execFile(command, args, { timeout: 4000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
  }));
  const platform = options.platform || os.platform();
  const containerFormat = '{{json .ID}}\t{{json .Names}}\t{{json .Ports}}\t{{json (.Label "com.docker.compose.project")}}\t{{json (.Label "com.docker.compose.service")}}';
  // Request selected metadata only; never inspect commands, environment or mounts.
  const containerOutput = (async () => {
    if (options.containers === false) return [];
    let dockerSocket = options.dockerSocket;
    if (dockerSocket === undefined) {
      const isSocket = options.isSocket || (async (candidate) => {
        try { return (await fs.stat(candidate)).isSocket(); } catch { return false; }
      });
      const localEndpoint = async (endpoint) => {
        if (typeof endpoint !== "string" || endpoint.length > 4096 || !endpoint.startsWith("unix:///") || /[\x00-\x1f\x7f]/.test(endpoint)) return null;
        const candidate = endpoint.slice(7);
        return await isSocket(candidate) ? candidate : null;
      };
      dockerSocket = await localEndpoint(options.dockerHost ?? process.env.DOCKER_HOST);
      if (!dockerSocket) {
        // Formatting limits this local config read to the endpoint, excluding TLS material.
        const endpoint = (await run("docker", ["context", "inspect", "--format", "{{.Endpoints.docker.Host}}"])).trim();
        dockerSocket = await localEndpoint(endpoint);
      }
      if (!dockerSocket) {
        const candidates = ["/var/run/docker.sock", path.join(os.homedir(), ".docker/run/docker.sock"), path.join(os.homedir(), ".docker/desktop/docker.sock"), `/run/user/${process.getuid?.()}/docker.sock`];
        for (const candidate of candidates) {
          if (await isSocket(candidate)) { dockerSocket = candidate; break; }
        }
      }
    }
    // Ignore remote CLI contexts: these identities belong to this device only.
    const requests = [{ runtime: "podman", args: ["--remote=false", "ps", "--format", containerFormat] }];
    if (dockerSocket) requests.push({ runtime: "docker", args: ["--host", `unix://${dockerSocket}`, "ps", "--format", containerFormat] });
    return Promise.all(requests.map(async ({ runtime, args }) => ({ runtime, output: await run(runtime, args) })));
  })();
  const listeners = new Map();
  const add = (port, pid, process) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    if (!listeners.has(port)) listeners.set(port, new Map());
    if (pid) listeners.get(port).set(pid, process);
  };
  if (platform === "linux") {
    const output = await run("ss", ["-ltnpH"]);
    for (const line of output.split("\n")) {
      const port = Number(line.trim().split(/\s+/)[3]?.match(/:(\d+)$/)?.[1]);
      add(port);
      for (const match of line.matchAll(/\("([^"]+)",pid=(\d+)/g)) add(port, Number(match[2]), match[1]);
    }
  } else if (platform === "darwin") {
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
  if (platform === "darwin" && pids.length) {
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
      if (platform === "linux") {
        try { cwd = await fs.readlink(`/proc/${pid}/cwd`); } catch { /* Process ownership may hide its directory. */ }
      }
      identities.set(pid, await projectAt(cwd));
    }));
  }
  const containers = new Map();
  let publishedCount = 0;
  for (const { runtime, output } of await containerOutput) {
    for (const line of output.split("\n").slice(0, 2048)) {
      let fields;
      try { fields = line.split("\t").map((field) => JSON.parse(field)); } catch { continue; }
      if (fields.length !== 5) continue;
      const [id, names, ports, projectLabel, serviceLabel] = fields;
      if (typeof id !== "string" || !/^[a-f0-9]{12,64}$/i.test(id) || typeof ports !== "string") continue;
      const container = clean(Array.isArray(names) ? names[0] : names);
      const project = clean(projectLabel);
      const service = clean(serviceLabel);
      const identity = { id, container, runtime, name: [project, service].filter(Boolean).join(" / ") || container || "Container", ...(project ? { project } : {}), ...(service ? { service } : {}) };
      for (const binding of ports.split(",")) {
        // An arrow distinguishes published bindings from container-only exposed ports.
        const match = binding.trim().match(/:(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp$/);
        if (!match) continue;
        const first = Number(match[1]);
        const last = Number(match[2] || match[1]);
        if (first < 1 || last > 65535 || last < first || last - first > 4095) continue;
        for (let port = first; port <= last && publishedCount < 4096; port++) {
          if (!containers.has(port)) containers.set(port, new Map());
          if (containers.get(port).has(id)) continue;
          containers.get(port).set(id, identity);
          publishedCount++;
          add(port);
        }
      }
    }
  }
  return [...listeners].sort(([a], [b]) => a - b).map(([port, entries]) => ({
    port,
    containers: [...(containers.get(port)?.values() || [])],
    processes: [...entries].map(([pid, process]) => {
      const project = identities.get(pid);
      return { pid, process: clean(process), name: project?.name || clean(process) || "TCP service", source: project?.source || "process", folder: project?.folder || null };
    }),
  }));
}

const pendingDetails = new Map();
export async function listPortDetails(host) {
  const { DEVBOX, IS_CLIENT } = await import("./config.js");
  const { SSH_TOKEN, shQuote } = await import("./shell.js");
  const { execFile } = await import("node:child_process");
  if (host && !SSH_TOKEN.test(host)) throw new Error("Invalid device host");
  const target = host === undefined ? (IS_CLIENT ? DEVBOX : "") : host;
  if (pendingDetails.has(target)) return pendingDetails.get(target);
  const pending = (async () => {
    if (!target) return inspectPortProcesses();
    const script = `(${inspectPortProcesses.toString()})().then(result => console.log(JSON.stringify(result))).catch(() => process.exit(1))`;
    return new Promise((resolve, reject) => {
      execFile("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", target, `node -e ${shQuote(script)}`],
        { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, output) => {
          if (error) return reject(new Error("Could not identify services on the source device (Node.js is required)."));
          try { resolve(JSON.parse(output)); } catch { reject(new Error("Invalid process information from source device")); }
        });
    });
  })().finally(() => pendingDetails.delete(target));
  pendingDetails.set(target, pending);
  return pending;
}
