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
// process names, start times, parent ids, controlling terminals, program
// paths, project manifests and tmux session names, never process arguments or
// environments. Its rules come as plain data in `options` (see portProbeRules).
export async function inspectPortProcesses(options = {}) {
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const os = await import("node:os");
  const { execFile } = await import("node:child_process");
  const run = options.run || ((command, args) => new Promise((resolve) => {
    execFile(command, args, { timeout: 4000, maxBuffer: 2 * 1024 * 1024 }, (error, stdout) => {
      // A process can disappear between the listener and directory scans.
      // lsof then exits with 1 while still returning valid rows for other PIDs.
      const partial = command === "lsof" && error?.code === 1 && !error.killed && !error.signal;
      resolve(!error || partial ? stdout : "");
    });
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
  // Whether anything listens beyond this device, per port: a wildcard or LAN
  // address is reachable from the network, a loopback one is not.
  const reach = new Map();
  const loopback = (address) => /^(127\.|\[?::1\]?$|localhost$)/.test(address);
  const add = (port, pid, process, address) => {
    if (!Number.isInteger(port) || port < 1 || port > 65535) return;
    if (!listeners.has(port)) listeners.set(port, new Map());
    if (pid) listeners.get(port).set(pid, process);
    if (typeof address === "string" && address) reach.set(port, reach.get(port) === "network" || !loopback(address) ? "network" : "local");
  };
  const bound = (endpoint) => {
    const match = typeof endpoint === "string" ? endpoint.match(/^(.*):(\d+)$/) : null;
    return match ? { address: match[1], port: Number(match[2]) } : { address: "", port: NaN };
  };
  if (platform === "linux") {
    const output = await run("ss", ["-ltnpH"]);
    for (const line of output.split("\n")) {
      const { address, port } = bound(line.trim().split(/\s+/)[3]);
      add(port, undefined, undefined, address);
      for (const match of line.matchAll(/\("([^"]+)",pid=(\d+)/g)) add(port, Number(match[2]), match[1]);
    }
  } else if (platform === "darwin") {
    let pid;
    let process;
    for (const line of (await run("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-Fpcn"])).split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      if (line.startsWith("c")) process = line.slice(1);
      if (line.startsWith("n")) {
        const { address, port } = bound(line.slice(1));
        add(port, pid, process, address);
      }
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
  // The app's own tmux sessions (Quick Chat, tile views), named by
  // `options.internalSessions` as { names, prefixes }.
  const internalNames = Array.isArray(options.internalSessions?.names) ? options.internalSessions.names.filter((name) => typeof name === "string" && name) : [];
  const internalPrefixes = Array.isArray(options.internalSessions?.prefixes) ? options.internalSessions.prefixes.filter((prefix) => typeof prefix === "string" && prefix) : [];
  const internalSession = (session) => typeof session === "string" && (internalNames.includes(session) || internalPrefixes.some((prefix) => session.startsWith(prefix)));
  // Coding agents' own programs (`options.agentPrograms`), plus agents whose
  // native binary is named after its version, like "2.1.330"
  // (`options.versionNamedAgents`). Their listeners are the agent's IDE or MCP
  // bridge, not a service. Linux reports at most 15 characters of a name.
  const agentPrograms = Array.isArray(options.agentPrograms) ? options.agentPrograms.filter((name) => typeof name === "string" && name) : [];
  const agentProgram = (name) => !!name && ((options.versionNamedAgents === true && /^\d+\.\d+\.\d+$/.test(name))
    || agentPrograms.some((program) => program === name || (name.length >= 15 && program.startsWith(name))));
  // "/dev/ttys012" (tmux) and "ttys012" (ps) name the same terminal.
  const terminal = (name) => typeof name === "string" ? name.trim().replace(/^\/dev\//, "") : "";
  // One process table read gives every listener its parent, its age and its
  // controlling terminal. etime is "[[dd-]hh:]mm:ss" on both macOS and Linux;
  // a process without a terminal shows "??" (macOS) or "?" (Linux).
  const parents = new Map();
  const ages = new Map();
  const terminals = new Map();
  if (pids.length) {
    for (const line of (await run("ps", ["-axo", "pid=,ppid=,etime=,tty="])).split("\n")) {
      const [pid, ppid, etime, tty] = line.trim().split(/\s+/);
      // The parent link matters most, so an unexpected age never drops it.
      if (!/^\d+$/.test(pid) || !/^\d+$/.test(ppid)) continue;
      parents.set(Number(pid), Number(ppid));
      const age = typeof etime === "string" ? etime.match(/^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+)$/) : null;
      if (age) ages.set(Number(pid), Number(age[1] || 0) * 86400 + Number(age[2] || 0) * 3600 + Number(age[3]) * 60 + Number(age[4]));
      if (tty && !/^[?-]+$/.test(tty)) terminals.set(Number(pid), terminal(tty));
    }
  }
  // The terminal session a listener was started from: the tmux pane among its
  // ancestors. `options.tmux` names this device's tmux (PzzaCode runs its own
  // server locally); the default is the plain one a remote source has.
  const panes = new Map();
  const paneTerminals = new Map();
  if (pids.length && options.sessions !== false) {
    const [tmux, ...tmuxOptions] = Array.isArray(options.tmux) && options.tmux.length ? options.tmux : ["tmux"];
    // The session name goes last: it is the only field that may hold a tab.
    for (const line of (await run(tmux, [...tmuxOptions, "-u", "list-panes", "-a", "-F", "#{pane_pid}\t#{pane_tty}\t#{session_name}"])).split("\n")) {
      const [panePid, paneTty, ...name] = line.split("\t");
      if (!/^\d+$/.test(panePid) || !name.length) continue;
      const session = clean(name.join("\t"));
      // A grouped view session lists the same panes as the session it shows;
      // the pane belongs to that session, never to the app's view of it.
      if (panes.has(Number(panePid)) && internalSession(session)) continue;
      panes.set(Number(panePid), session);
      if (terminal(paneTty)) paneTerminals.set(terminal(paneTty), session);
    }
  }
  const sessionOf = (pid) => {
    const chain = [];
    for (let current = pid; current > 1 && chain.length < 64 && !chain.includes(current); current = parents.get(current)) {
      // A pane's shell is an ancestor of everything started in it, however deep.
      if (panes.has(current)) return panes.get(current) || null;
      chain.push(current);
      if (!parents.has(current)) break;
    }
    // A job whose parent exited (a subshell, a `&` job) is adopted by init and
    // loses the pane from its ancestors, but keeps the pane's terminal.
    for (const current of chain) {
      const session = paneTerminals.get(terminals.get(current));
      if (session) return session;
    }
    return null;
  };
  // What kind of service a project is, from the packages it depends on; the
  // first match wins, so a framework is named before the bundler under it.
  const FRAMEWORKS = [
    ["next", "Next.js"], ["nuxt", "Nuxt"], ["@remix-run/dev", "Remix"], ["astro", "Astro"], ["@sveltejs/kit", "SvelteKit"],
    ["expo", "Expo"], ["@nestjs/core", "NestJS"], ["@angular/core", "Angular"], ["gatsby", "Gatsby"], ["@docusaurus/core", "Docusaurus"],
    ["@storybook/react", "Storybook"], ["storybook", "Storybook"], ["vite", "Vite"], ["webpack-dev-server", "webpack"],
    ["fastify", "Fastify"], ["hono", "Hono"], ["koa", "Koa"], ["express", "Express"],
  ];
  const kindOf = (manifest) => {
    const packages = { ...(manifest.dependencies && typeof manifest.dependencies === "object" ? manifest.dependencies : {}), ...(manifest.devDependencies && typeof manifest.devDependencies === "object" ? manifest.devDependencies : {}) };
    return FRAMEWORKS.find(([name]) => Object.hasOwn(packages, name))?.[1] || null;
  };
  // Well-known services by process name, for listeners without a project.
  const SERVICES = [
    [/^postgres/i, "PostgreSQL"], [/^redis/i, "Redis"], [/^mongo[ds]/i, "MongoDB"], [/^mysqld|^mariadbd/i, "MySQL"], [/^nginx/i, "nginx"],
    [/^(httpd|apache2)/i, "Apache"], [/^caddy/i, "Caddy"], [/^ollama/i, "Ollama"], [/^(com\.docker|docker)/i, "Docker"],
    [/^(rapportd|ControlCe|AirPlayXPC|sharingd)/i, "macOS"], [/^sshd/i, "SSH server"], [/^OrbStack/i, "OrbStack"],
  ];
  // Services that belong to the platform or a container runtime, not to a
  // project; the rest of SERVICES are servers a developer runs on purpose.
  const PLATFORM_SERVICES = ["macOS", "SSH server", "Docker", "OrbStack"];
  const JS_RUNTIME = /^(node|bun|deno|next-server|tsx|vite|expo|npm|pnpm|yarn)/i;
  const serviceOf = (process) => SERVICES.find(([pattern]) => pattern.test(process))?.[1] || null;
  // Programs installed with the operating system, and programs shipped inside
  // a desktop app bundle (menu bar helpers, sync agents, app runtimes).
  const OS_PROGRAM = /^\/(System|sbin|usr\/(libexec|sbin)|Library\/Apple|usr\/lib\/systemd|lib\/systemd)\//;
  const APP_PROGRAM = /\.app\/Contents\//;
  // Whether a listener is a background service of the device rather than
  // something a developer started: never when a session started it; a
  // well-known server stays visible wherever it is installed; otherwise an OS
  // or app-bundle program, a platform service, or a daemon running outside
  // any project folder (a device bridge, this agent).
  const systemOf = ({ session, kind, project, program }) => {
    if (session) return false;
    if (kind && !PLATFORM_SERVICES.includes(kind)) return false;
    if (OS_PROGRAM.test(program) || APP_PROGRAM.test(program) || kind) return true;
    return !project;
  };
  const protectedPorts = Array.isArray(options.protectedPorts) ? options.protectedPorts : [];
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
            if (name) return { name, source: "package", folder: path.basename(directory), kind: kindOf(manifest) };
          }
        } catch { /* A folder without a readable manifest can still identify the project. */ }
      }
      return cwd === home ? null : { name: clean(path.basename(cwd)), source: "folder", folder: clean(path.basename(cwd)) };
    })();
    projects.set(cwd, pending);
    return pending;
  };
  const sessions = new Map(pids.map((pid) => [pid, sessionOf(pid)]));
  // The program file of each listener no session started, to recognize OS and
  // desktop app services. Only the executable's path is read, never arguments.
  const programs = new Map();
  const unattached = pids.filter((pid) => !sessions.get(pid));
  if (platform === "darwin" && unattached.length) {
    let pid;
    for (const line of (await run("lsof", ["-a", "-p", unattached.join(","), "-d", "txt", "-Fn"])).split("\n")) {
      if (line.startsWith("p")) pid = Number(line.slice(1));
      // The program is the first text file lsof lists for a process.
      if (line.startsWith("n") && pid && !programs.has(pid)) programs.set(pid, line.slice(1));
    }
  }
  const identities = new Map();
  // Bound concurrent filesystem reads, even when a device has many listeners.
  for (let offset = 0; offset < pids.length; offset += 8) {
    await Promise.all(pids.slice(offset, offset + 8).map(async (pid) => {
      let cwd = directories.get(pid);
      if (platform === "linux") {
        try { cwd = await fs.readlink(`/proc/${pid}/cwd`); } catch { /* Process ownership may hide its directory. */ }
        if (!sessions.get(pid)) {
          try { programs.set(pid, await fs.readlink(`/proc/${pid}/exe`)); } catch { /* Same as above. */ }
        }
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
        const match = binding.trim().match(/^(.*):(\d+)(?:-(\d+))?->\d+(?:-\d+)?\/tcp$/);
        if (!match) continue;
        const first = Number(match[2]);
        const last = Number(match[3] || match[2]);
        if (first < 1 || last > 65535 || last < first || last - first > 4095) continue;
        for (let port = first; port <= last && publishedCount < 4096; port++) {
          if (!containers.has(port)) containers.set(port, new Map());
          if (containers.get(port).has(id)) { add(port, undefined, undefined, match[1]); continue; }
          containers.get(port).set(id, identity);
          publishedCount++;
          add(port, undefined, undefined, match[1]);
        }
      }
    }
  }
  // One entry per port: every address (IPv4, IPv6, loopback, wildcard) and
  // every socket of the same process were merged into it while collecting.
  return [...listeners].sort(([a], [b]) => a - b).map(([port, entries]) => {
    const published = [...(containers.get(port)?.values() || [])];
    const processes = [...entries].map(([pid, process]) => {
      const project = identities.get(pid);
      const session = sessions.get(pid) || null;
      // A database started from a project folder is still a database: the
      // process decides first, the project only for a JavaScript runtime.
      const kind = serviceOf(clean(process)) || (JS_RUNTIME.test(clean(process)) ? project?.kind || null : null);
      return {
        pid, process: clean(process), name: project?.name || clean(process) || "TCP service", source: project?.source || "process", folder: project?.folder || null,
        kind, session, uptime: ages.has(pid) ? ages.get(pid) : null,
        system: systemOf({ session, kind, project, program: programs.get(pid) || "" }),
        agent: agentProgram(clean(process)),
      };
    });
    return {
      port,
      // "network": reachable from other devices; "local": this device only.
      scope: reach.get(port) || null,
      // A protected port, or one held only by system services. A port whose
      // owner is hidden (another user's process) counts too, while a published
      // container never does.
      system: protectedPorts.includes(port) || (!published.length && processes.every((item) => item.system)),
      // Held only by coding agents' own bridges or by the app's own sessions;
      // a dev server an agent started is its own process and stays visible.
      internal: !published.length && processes.length > 0 && processes.every((item) => item.agent || internalSession(item.session)),
      containers: published,
      processes,
    };
  });
}

// The app's own tmux sessions; session-name.js reserves the same names.
export const INTERNAL_SESSIONS = { names: ["pzza-quick-chat"], prefixes: ["pzza-v-"] };
// Interpreters an agent may run under, which also run ordinary dev servers:
// a listener named after one is never taken for an agent's own bridge.
const SHARED_RUNTIMES = /^(python\d*|node|nodejs|bun|deno|ruby|java)$/i;

// Plain-data rules for inspectPortProcesses, safe to serialize to a remote probe.
export async function portProbeRules() {
  const { SESSION_AGENTS } = await import("./session-agents.js");
  return {
    protectedPorts: PROTECTED_PORTS,
    internalSessions: INTERNAL_SESSIONS,
    agentPrograms: [...new Set(SESSION_AGENTS.flatMap((agent) => agent.detect.programs))].filter((name) => !SHARED_RUNTIMES.test(name)),
    versionNamedAgents: SESSION_AGENTS.some((agent) => agent.detect.versionProgram === true),
  };
}

const pendingDetails = new Map();
export async function listPortDetails(host) {
  const { DEVBOX, IS_CLIENT } = await import("./config.js");
  const { SSH_TOKEN, shQuote } = await import("./shell.js");
  const { tmuxArgs } = await import("./tmux-client.js");
  const { execFile } = await import("node:child_process");
  if (host && !SSH_TOKEN.test(host)) throw new Error("Invalid device host");
  const target = host === undefined ? (IS_CLIENT ? DEVBOX : "") : host;
  if (pendingDetails.has(target)) return pendingDetails.get(target);
  const pending = (async () => {
    // Locally the sessions live in PzzaCode's own tmux server.
    const rules = await portProbeRules();
    if (!target) return inspectPortProcesses({ tmux: ["tmux", ...tmuxArgs([])], ...rules });
    // The rules travel as plain JSON: the probe stays self-contained remotely.
    const script = `(${inspectPortProcesses.toString()})(${JSON.stringify(rules)}).then(result => console.log(JSON.stringify(result))).catch(() => process.exit(1))`;
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
