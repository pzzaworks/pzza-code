// Listening TCP ports on the connected device.
import { sh } from "./shell.js";

// Ports whose listeners are never terminated through the port manager: local
// system services plus this agent itself (killing it would sever the app).
export const PROTECTED_PORTS = [22, 53, 631, 3389, 5190];

// Returns the offending protected port from a list, or null when safe.
export function protectedListenerPort(ports) {
  for (const port of ports) {
    if (PROTECTED_PORTS.includes(port)) return port;
  }
  return null;
}

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

// Terminate the process behind a listening port. Self-contained on purpose:
// the same source runs locally and, serialized, on the SSH source device (see
// listPortDetails above). Only dependency-free Node builtins are used, and the
// protected list travels as an argument so nothing leaks in from outer scope.
//
// Safety contract, enforced on both sides:
// - the pid must be a positive integer, never 1 and never the caller itself;
// - the pid must currently own at least one listening TCP port (this closes
//   the stale-PID race: a reused pid that no longer listens is refused);
// - none of its listening ports may be protected (system services, the agent).
// Only SIGTERM is sent; processes that ignore it are left alone rather than
// escalated to SIGKILL.
export async function terminateRemoteListener(pid, protectedPorts) {
  const { execFileSync } = await import("node:child_process");
  const os = await import("node:os");
  if (!Number.isInteger(pid) || pid <= 1 || pid === process.pid) throw new Error("Enter a valid process ID.");
  const platform = os.platform();
  const owned = new Set();
  if (platform === "linux") {
    let output = "";
    try {
      output = execFileSync("ss", ["-ltnpH"], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 }).toString();
    } catch {
      throw new Error("Could not list listening ports on this device.");
    }
    for (const line of output.split("\n")) {
      const port = Number(line.trim().split(/\s+/)[3]?.match(/:(\d+)$/)?.[1]);
      if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
      for (const match of line.matchAll(/\("([^"]+)",pid=(\d+)/g)) {
        if (Number(match[2]) === pid) owned.add(port);
      }
    }
  } else if (platform === "darwin") {
    let output = "";
    try {
      output = execFileSync("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpn"], { timeout: 4000, maxBuffer: 2 * 1024 * 1024 }).toString();
    } catch {
      throw new Error("Could not list listening ports on this device.");
    }
    let current = null;
    for (const line of output.split("\n")) {
      if (line.startsWith("p")) current = Number(line.slice(1));
      if (line.startsWith("n") && current === pid) {
        const port = Number(line.match(/:(\d+)$/)?.[1]);
        if (Number.isInteger(port) && port >= 1 && port <= 65535) owned.add(port);
      }
    }
  } else {
    throw new Error("Process termination is not available on this operating system.");
  }
  if (owned.size === 0) throw new Error(`Process ${pid} is not listening on any port.`);
  for (const port of owned) {
    if (protectedPorts.includes(port)) throw new Error(`Refusing to stop a system service on port ${port}.`);
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (error) {
    if (error?.code === "ESRCH") throw new Error(`Process ${pid} already exited.`);
    if (error?.code === "EPERM") throw new Error(`Permission denied - process ${pid} belongs to another user.`);
    throw new Error(`Could not stop process ${pid}.`);
  }
  return { pid, ports: [...owned].sort((a, b) => a - b) };
}

// Stop a process listener on this device (host "") or over SSH. The remote
// path reuses the serialized probe pattern: the target only needs Node.js.
export async function terminateListener({ host = "", pid }, deps = {}) {
  const { SSH_TOKEN } = await import("./shell.js");
  if (host && !SSH_TOKEN.test(host)) throw new Error("Invalid device host");
  if (!Number.isInteger(pid) || pid <= 1) throw new Error("Enter a valid process ID.");
  if (!host) {
    if (pid === process.pid) throw new Error("Enter a valid process ID.");
    const inspect = deps.inspect || inspectPortProcesses;
    const listeners = await inspect({ containers: false });
    const owned = listeners.filter((entry) => entry.processes.some((item) => item.pid === pid)).map((entry) => entry.port);
    if (owned.length === 0) throw new Error(`Process ${pid} is not listening on any port.`);
    const blocked = protectedListenerPort(owned);
    if (blocked !== null) throw new Error(`Refusing to stop a system service on port ${blocked}.`);
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code === "ESRCH") throw new Error(`Process ${pid} already exited.`);
      if (error?.code === "EPERM") throw new Error(`Permission denied - process ${pid} belongs to another user.`);
      throw new Error(`Could not stop process ${pid}.`);
    }
    return { pid, ports: [...owned].sort((a, b) => a - b) };
  }
  const { execFile } = await import("node:child_process");
  const { shQuote } = await import("./shell.js");
  const script = `(${terminateRemoteListener.toString()})(${JSON.stringify(pid)}, ${JSON.stringify(PROTECTED_PORTS)}).then(result => console.log(JSON.stringify({ ok: true, result }))).catch((error) => { console.log(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : "Could not stop the process." })); process.exit(1); })`;
  const runSsh = deps.runSsh || ((args) => new Promise((resolve, reject) => {
    execFile("ssh", args, { timeout: 15000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => (error ? reject(error) : resolve(stdout)));
  }));
  let output = "";
  try {
    output = await runSsh(["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, `node -e ${shQuote(script)}`]);
  } catch {
    throw new Error("Could not reach the device. Check trusted SSH access and that Node.js is installed.");
  }
  let parsed = null;
  try { parsed = JSON.parse(String(output).trim().split("\n").at(-1)); } catch { /* fall through */ }
  if (!parsed || typeof parsed !== "object") throw new Error("Invalid response from the device.");
  if (!parsed.ok) throw new Error(typeof parsed.error === "string" && parsed.error ? parsed.error : "Could not stop the process.");
  return parsed.result;
}

// Stop a published container on this device or over SSH. Container IDs are
// content hashes validated strictly; only `stop` is ever invoked, never
// `rm`, `exec`, or anything that runs code inside the container.
export async function stopPortContainer({ host = "", id, runtime }, deps = {}) {
  const { SSH_TOKEN } = await import("./shell.js");
  const { execFile } = await import("node:child_process");
  if (host && !SSH_TOKEN.test(host)) throw new Error("Invalid device host");
  if (typeof id !== "string" || !/^[a-f0-9]{12,64}$/i.test(id)) throw new Error("Container ID is invalid.");
  if (runtime !== "docker" && runtime !== "podman") throw new Error("Container runtime is invalid.");
  const runExec = deps.runExec || ((command, args) => new Promise((resolve, reject) => {
    execFile(command, args, { timeout: 30000, maxBuffer: 512 * 1024 }, (error, stdout, stderr) =>
      (error ? reject(error) : resolve(`${stdout || ""}${stderr || ""}`.trim())));
  }));
  try {
    await (host ? runExec("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", host, runtime, "stop", id])
      : runExec(runtime, ["stop", id]));
  } catch {
    throw new Error(host ? "Could not stop the container. Check trusted SSH access and the container runtime." : "Could not stop the container. Is the container runtime available?");
  }
  return { id, runtime };
}
