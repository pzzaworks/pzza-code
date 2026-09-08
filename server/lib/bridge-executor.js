import fs from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";

export const BRIDGE_ACTION_CAPABILITIES = Object.freeze({
  "terminal.list": "terminal.read", "terminal.read": "terminal.read",
  "terminal.write": "terminal.write", "terminal.create": "terminal.write", "terminal.terminate": "terminal.write",
  "files.list": "files.read", "files.read": "files.read", "files.write": "files.write",
  "app.list_clients": "app.open_editor", "app.get_state": "app.open_editor", "app.open_editor": "app.open_editor", "app.open_session": "app.open_editor",
  "ios.build": "ios.build", "ios.submit": "ios.submit",
  "simulator.list": "simulator.control", "simulator.boot": "simulator.control", "simulator.install": "simulator.control",
  "simulator.launch": "simulator.control", "simulator.screenshot": "simulator.control", "maestro.run": "maestro.run",
});
export const BRIDGE_CAPABILITIES = Object.freeze([...new Set(Object.values(BRIDGE_ACTION_CAPABILITIES))]);
const runFile = promisify(execFile);
const LIMIT = 1024 * 1024;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const hash = (data) => createHash("sha256").update(data).digest("hex");
const inside = (root, target) => target === root || target.startsWith(root + path.sep);
const fail = (message, status = 400) => Object.assign(new Error(message), { status });
function text(value, name, max = 4096) {
  if (typeof value !== "string" || !value || value.length > max || /[\x00-\x1f\x7f]/.test(value)) throw fail(`Invalid ${name}`);
  return value;
}
function keys(args, allowed) {
  if (!args || typeof args !== "object" || Array.isArray(args) || Object.keys(args).some((key) => !["projectId", ...allowed].includes(key))) throw fail("Unexpected action arguments");
}
async function scoped(root, relative = ".", missing = false) {
  text(relative, "path");
  if (path.isAbsolute(relative)) throw fail("Paths must be relative to the granted project");
  const candidate = path.resolve(root, relative);
  if (!inside(root, candidate)) throw fail("Path is outside the granted project", 403);
  let resolved;
  try { resolved = await fs.realpath(candidate); }
  catch (error) {
    if (!missing || error.code !== "ENOENT") throw fail("Path is unavailable");
    resolved = path.join(await fs.realpath(path.dirname(candidate)), path.basename(candidate));
  }
  if (!inside(root, resolved)) throw fail("Symlink leaves the granted project", 403);
  return resolved;
}
async function readBounded(file, limit = LIMIT) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw fail("File exceeds the allowed size or is not a regular file");
    const data = await handle.readFile();
    if (data.length > limit) throw fail("File exceeds the allowed size");
    return data;
  } finally { await handle.close(); }
}
async function digestFile(file) {
  const handle = await fs.open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024 * 1024) throw fail("Invalid build artifact");
    const digest = createHash("sha256");
    for await (const chunk of handle.createReadStream({ autoClose: false })) digest.update(chunk);
    return digest.digest("hex");
  } finally { await handle.close(); }
}

export function createBridgeExecutor({ stateDir, appControl, authorize = () => {}, platform = process.platform,
  run = (command, args, options = {}) => runFile(command, args, { timeout: 15_000, maxBuffer: LIMIT, ...options }),
  startProcess = spawn, killProcess = (pid, signal) => process.kill(pid, signal),
  resolveTool = async (name, root) => {
    for (const directory of (process.env.PATH || "").split(path.delimiter)) {
      if (!path.isAbsolute(directory) || inside(root, directory)) continue;
      const candidate = await fs.realpath(path.join(directory, name)).catch(() => null);
      if (!candidate || inside(root, candidate)) continue;
      try { await fs.access(candidate, constants.X_OK); return candidate; } catch { /* Try next installed location. */ }
    }
    throw fail(`Required local tool is not installed: ${name}`, 503);
  } } = {}) {
  if (!stateDir) throw fail("Bridge state directory is required");
  const directory = path.resolve(stateDir, "bridge-jobs");
  const isBuildDirectory = (target) => typeof target === "string" && path.dirname(target) === directory &&
    path.basename(target).startsWith("build-") && uuid.test(path.basename(target).slice(6));
  const jobs = new Map();
  const active = new Map();
  const leases = new Map();
  const writes = new Map();
  const terminalWrites = new Map();
  const generations = new Map();
  let persistTail = Promise.resolve();
  let closed = false;
  const ready = (async () => {
    await fs.mkdir(directory, { recursive: true, mode: 0o700 });
    try {
      const stored = JSON.parse(await fs.readFile(path.join(directory, "jobs.json"), "utf8"));
      if (Array.isArray(stored)) for (const job of stored.slice(-100)) {
        if (!uuid.test(job.id) || typeof job.peerId !== "string") continue;
        if (job.outputDirectory && !isBuildDirectory(job.outputDirectory)) delete job.outputDirectory;
        if (["running", "queued", "waiting_approval"].includes(job.status)) { job.status = "interrupted"; job.finishedAt = Date.now(); }
        jobs.set(job.id, job);
      }
    } catch { /* Missing metadata means there are no retained jobs. */ }
  })();
  const persist = () => {
    persistTail = persistTail.catch(() => {}).then(async () => {
      const temporary = path.join(directory, "jobs.json.tmp");
      await fs.writeFile(temporary, JSON.stringify([...jobs.values()]), { mode: 0o600 });
      await fs.rename(temporary, path.join(directory, "jobs.json"));
    });
    return persistTail;
  };
  const view = (job, cursor = 0) => {
    if (!Number.isInteger(cursor) || cursor < 0) throw fail("Invalid log cursor");
    const publicJob = { ...job };
    return { ...publicJob, jobId: job.id, logs: job.logs.filter((entry) => entry.cursor > cursor), nextCursor: job.logs.at(-1)?.cursor || 0 };
  };
  const log = (job, message) => {
    job.logs.push({ cursor: (job.logs.at(-1)?.cursor || 0) + 1, at: Date.now(), message });
    if (job.logs.length > 100) job.logs.shift();
  };
  const checked = async (context, action, projectId) => {
    if (closed) throw fail("Bridge executor is shutting down", 503);
    if (context.generation !== (generations.get(context.peerId) || 0)) throw fail("Peer grant was revoked", 403);
    const current = await authorize(context.peerId, action, projectId);
    const grant = current || context;
    if (!grant.capabilities?.includes(BRIDGE_ACTION_CAPABILITIES[action])) throw fail("Action is not granted", 403);
    const configured = grant.projectRoots?.[text(projectId, "projectId", 160)];
    if (typeof configured !== "string") throw fail("Project is not granted", 403);
    const root = await fs.realpath(configured);
    if (context.generation !== (generations.get(context.peerId) || 0)) throw fail("Peer grant was revoked", 403);
    return root;
  };
  const owned = (id, peerId) => {
    const job = jobs.get(id);
    if (!job || (peerId !== undefined && job.peerId !== peerId)) throw fail("Job not found", 404);
    return job;
  };
  async function finish(job, status, message) {
    job.status = status;
    job.finishedAt = Date.now();
    log(job, message);
    if (status === "completed" && job.action === "ios.build" && job.outputDirectory) {
      const artifacts = [];
      const scan = async (directory, depth) => {
        if (depth > 5 || artifacts.length >= 100) return;
        const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => []);
        for (const entry of entries) {
          if (!entry.isDirectory()) continue;
          const target = path.join(directory, entry.name);
          if (entry.name.endsWith(".app")) artifacts.push(path.relative(job.outputDirectory, target));
          else await scan(target, depth + 1);
        }
      };
      await scan(path.join(job.outputDirectory, "Build", "Products"), 0);
      job.artifacts = artifacts;
    }
    const runtime = active.get(job.id);
    if (runtime?.lease && leases.get(runtime.lease) === job.id) leases.delete(runtime.lease);
    active.delete(job.id);
    await persist();
  }
  async function launch(job, specification, context) {
    await checked(context, job.action, job.projectId);
    if (job.status !== "queued") throw fail("Job cannot start", 409);
    const runtime = active.get(job.id);
    if (!runtime) throw fail("Job is no longer active", 409);
    if (specification.lease) {
      if (leases.has(specification.lease)) throw fail("Simulator is busy with another job", 409);
      leases.set(specification.lease, job.id);
      runtime.lease = specification.lease;
    }
    job.status = "running";
    log(job, "Started. Process output is discarded to avoid retaining secrets.");
    await persist();
    const steps = specification.steps || [specification];
    const runStep = async (index) => {
      try {
        await checked(context, job.action, job.projectId);
        if (job.status !== "running" || active.get(job.id) !== runtime) return;
        const step = steps[index];
        const child = startProcess(step.command, step.args, { cwd: specification.cwd,
          ...(specification.env ? { env: specification.env } : {}),
          detached: true, shell: false, stdio: ["ignore", "ignore", "ignore"] });
        runtime.child = child;
        if (child.pid) job.processId = child.pid;
        void persist().catch(() => {});
        child.once("error", () => {
          if (job.status === "running") void finish(job, "failed", "The required local tool could not start.");
        });
        child.once("close", (code) => {
          if (job.status !== "running") return;
          runtime.child = null;
          delete job.processId;
          job.exitCode = Number.isInteger(code) ? code : null;
          if (code === 0 && index + 1 < steps.length) {
            log(job, `Step ${index + 1} completed.`);
            void runStep(index + 1);
          } else void finish(job, code === 0 ? "completed" : "failed", code === 0 ? "Completed." : `Process exited with code ${Number.isInteger(code) ? code : "unknown"}.`);
        });
      } catch {
        if (job.status === "running") await finish(job, "failed", "Job authorization changed or the required local tool could not start.");
      }
    };
    await runStep(0);
  }

  async function createJob(action, args, context, specification, approval) {
    await ready;
    if ([...jobs.values()].filter((job) => ["running", "queued", "waiting_approval"].includes(job.status)).length >= 8) throw fail("Too many active jobs", 429);
    while (jobs.size >= 100) {
      const old = [...jobs.values()].find((job) => !active.has(job.id));
      if (!old) break;
      jobs.delete(old.id);
      await fs.rm(path.join(directory, old.id), { recursive: true, force: true });
      if (isBuildDirectory(old.outputDirectory)) await fs.rm(old.outputDirectory, { recursive: true, force: true });
    }
    const job = { id: randomUUID(), peerId: context.peerId, projectId: args.projectId, action,
      status: approval ? "waiting_approval" : "queued", createdAt: Date.now(), logs: [], ...(approval ? { approval: approval.summary } : {}), ...(specification?.outputDirectory ? { outputDirectory: specification.outputDirectory } : {}) };
    jobs.set(job.id, job);
    active.set(job.id, { specification, context, approval });
    log(job, approval ? "Waiting for approval on this device." : "Queued.");
    await persist();
    if (!approval) {
      try { await launch(job, specification, context); }
      catch (error) { if (job.status !== "cancelled") await finish(job, "failed", "Job could not start."); throw error; }
    }
    return view(job);
  }
  async function panes(root) {
    let output;
    try { output = (await run("tmux", ["list-panes", "-a", "-F", "#{session_name}\t#{window_index}\t#{pane_id}\t#{pane_current_path}"])).stdout; }
    catch { return []; }
    const rows = [];
    for (const line of output.trim().split("\n")) {
      const [session, window, paneId, cwd] = line.split("\t");
      if (!session || !/^%\d+$/.test(paneId || "")) continue;
      const actual = await fs.realpath(cwd || "").catch(() => "");
      if (inside(root, actual)) rows.push({ session, window: Number(window), paneId, cwd: path.relative(root, actual) || "." });
    }
    return rows;
  }
  async function targetPane(root, session) {
    text(session, "session", 160);
    const found = (await panes(root)).filter((row) => row.session === session);
    if (found.length !== 1) throw fail("Session must have exactly one pane in the granted project", 403);
    // Reject multi-pane sessions: a session-wide termination must not affect
    // a window outside the project, even when another pane is in scope.
    const result = await run("tmux", ["list-panes", "-s", "-t", `=${session}:`, "-F", "#{pane_id}"]);
    if (result.stdout.trim() !== found[0].paneId) throw fail("Multi-pane sessions require local control", 403);
    return found[0];
  }
  async function appState(root, clientId) {
    if (!appControl) throw fail("App control is unavailable", 503);
    const result = await appControl.command(text(clientId, "clientId", 160), "get_state", {});
    const sessions = new Set((await panes(root)).map((row) => row.session));
    const tiles = (result?.tiles || []).filter((tile) => !tile.host && sessions.has(tile.session)).map((tile) => ({ id: tile.id, session: tile.session, hidden: Boolean(tile.hidden), window: tile.window }));
    return { clientId, tiles };
  }
  async function executeAction(action, args, context) {
    await ready;
    if (!Object.hasOwn(BRIDGE_ACTION_CAPABILITIES, action)) throw fail("Unknown bridge action");
    context = { ...context, generation: generations.get(context.peerId) || 0 };
    const root = await checked(context, action, args?.projectId);
    if (action === "files.list") {
      keys(args, ["path"]);
      const target = await scoped(root, args.path || ".");
      const entries = await fs.readdir(target, { withFileTypes: true });
      return { entries: entries.slice(0, 1000).map((entry) => ({ name: entry.name, type: entry.isSymbolicLink() ? "symlink" : entry.isDirectory() ? "directory" : "file" })), truncated: entries.length > 1000 };
    }
    if (action === "files.read") {
      keys(args, ["path"]);
      const data = await readBounded(await scoped(root, args.path));
      return { content: data.toString("base64"), encoding: "base64", sha256: hash(data), bytes: data.length };
    }
    if (action === "files.write") {
      keys(args, ["path", "content", "expectedSha256"]);
      if (typeof args.content !== "string" || Buffer.byteLength(args.content) > LIMIT) throw fail("Content must be UTF-8 text of at most 1 MiB");
      if (args.expectedSha256 !== null && !/^[a-f0-9]{64}$/.test(args.expectedSha256 || "")) throw fail("expectedSha256 is required; use null only to create a new file");
      const target = await scoped(root, args.path, true);
      if (target === root) throw fail("Cannot replace project root");
      const previous = writes.get(target) || Promise.resolve();
      const operation = previous.catch(() => {}).then(async () => {
        await checked(context, action, args.projectId);
        let existing = null;
        try { existing = await readBounded(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
        if ((existing === null ? null : hash(existing)) !== args.expectedSha256) throw fail("File changed; read it again before writing", 409);
        const temporary = path.join(path.dirname(target), `.bridge-${randomUUID()}`);
        try {
          const mode = existing === null ? 0o600 : (await fs.stat(target)).mode & 0o777;
          if (await fs.realpath(path.dirname(target)) !== path.dirname(target)) throw fail("Parent directory changed", 409);
          await fs.writeFile(temporary, args.content, { mode, flag: "wx" });
          if (await scoped(root, args.path, true) !== target) throw fail("Path changed during write", 409);
          await checked(context, action, args.projectId);
          let latest = null;
          try { latest = await readBounded(target); } catch (error) { if (error.code !== "ENOENT") throw error; }
          if ((latest === null ? null : hash(latest)) !== args.expectedSha256) throw fail("File changed during write", 409);
          if (existing === null) { await fs.link(temporary, target); await fs.unlink(temporary); }
          else await fs.rename(temporary, target);
          return { sha256: hash(Buffer.from(args.content)), bytes: Buffer.byteLength(args.content) };
        } finally { await fs.rm(temporary, { force: true }); }
      });
      writes.set(target, operation);
      try { return await operation; } finally { if (writes.get(target) === operation) writes.delete(target); }
    }
    if (action === "terminal.list") { keys(args, []); return { terminals: await panes(root) }; }
    if (action === "terminal.create") {
      keys(args, ["cwd", "name"]);
      const cwd = await scoped(root, args.cwd || ".");
      if (!(await fs.stat(cwd)).isDirectory()) throw fail("cwd must be a directory");
      const prefix = args.name === undefined ? "bridge" : text(args.name, "name", 60);
      if (!/^[a-zA-Z0-9_-]+$/.test(prefix)) throw fail("Session name may contain only letters, numbers, hyphens and underscores");
      const session = `${prefix}-${randomUUID()}`;
      await checked(context, action, args.projectId);
      await run("tmux", ["new-session", "-d", "-s", session, "-c", cwd]);
      return { session };
    }
    if (action.startsWith("terminal.")) {
      keys(args, action === "terminal.read" ? ["session", "lines"] : action === "terminal.write" ? ["session", "text", "enter"] : ["session"]);
      const pane = await targetPane(root, args.session);
      if (action === "terminal.read") {
        const lines = args.lines ?? 200;
        if (!Number.isInteger(lines) || lines < 1 || lines > 2000) throw fail("lines must be between 1 and 2000");
        return { text: (await run("tmux", ["capture-pane", "-p", "-t", pane.paneId, "-S", `-${lines}`])).stdout };
      }
      if (action === "terminal.write") {
        if (typeof args.text !== "string" || Buffer.byteLength(args.text) > 64 * 1024 || /\0/.test(args.text) || (args.enter !== undefined && typeof args.enter !== "boolean")) throw fail("Invalid terminal input");
        const previous = terminalWrites.get(pane.paneId) || Promise.resolve();
        const operation = previous.catch(() => {}).then(async () => {
          const live = await targetPane(root, args.session);
          if (live.paneId !== pane.paneId) throw fail("Terminal changed before writing", 409);
          await checked(context, action, args.projectId);
          await run("tmux", ["send-keys", "-t", pane.paneId, "-l", "--", args.text]);
          if (args.enter) {
            await checked(context, action, args.projectId);
            await run("tmux", ["send-keys", "-t", pane.paneId, "Enter"]);
          }
          return { ok: true };
        });
        terminalWrites.set(pane.paneId, operation);
        try { return await operation; } finally { if (terminalWrites.get(pane.paneId) === operation) terminalWrites.delete(pane.paneId); }
      }
      await checked(context, action, args.projectId);
      await run("tmux", ["kill-pane", "-t", pane.paneId]);
      return { ok: true };
    }
    if (action === "app.list_clients") {
      keys(args, []);
      if (!appControl) throw fail("App control is unavailable", 503);
      return { clients: appControl.list().map((client) => ({ clientId: client.clientId, label: client.label })) };
    }
    if (action === "app.open_session") {
      keys(args, ["clientId", "session"]);
      if (!appControl) throw fail("App control is unavailable", 503);
      const pane = await targetPane(root, args.session);
      const cwd = await scoped(root, pane.cwd);
      await checked(context, action, args.projectId);
      await appControl.command(text(args.clientId, "clientId", 160), "open_session", { session: pane.session, cwd });
      return appState(root, args.clientId);
    }

    if (action === "app.get_state") { keys(args, ["clientId"]); return appState(root, args.clientId); }
    if (action === "app.open_editor") {
      keys(args, ["clientId", "tileId", "path"]);
      const state = await appState(root, args.clientId);
      if (!state.tiles.some((tile) => tile.id === args.tileId)) throw fail("Tile is not in the granted local project", 403);
      const file = await scoped(root, args.path);
      await checked(context, action, args.projectId);
      await appControl.command(args.clientId, "open_editor", { tileId: args.tileId, path: file, root, layout: "side-by-side" });
      return { ok: true };
    }
    if (platform !== "darwin") throw fail("This action requires macOS", 400);
    const simulatorId = () => {
      if (!uuid.test(args.simulatorId || "")) throw fail("An explicit simulator UUID is required");
      return args.simulatorId;
    };
    if (action === "simulator.list") {
      keys(args, []);
      const result = JSON.parse((await run("/usr/bin/xcrun", ["simctl", "list", "devices", "available", "--json"])).stdout);
      return { devices: Object.entries(result.devices || {}).flatMap(([runtime, devices]) => devices.map((device) => ({ runtime, id: device.udid, name: device.name, state: device.state, available: device.isAvailable }))) };
    }
    if (action === "ios.build") {
      keys(args, ["project", "scheme", "configuration", "simulatorId"]);
      const project = await scoped(root, args.project);
      if (!/\.(xcworkspace|xcodeproj)$/.test(project)) throw fail("project must be an Xcode workspace or project");
      const scheme = text(args.scheme, "scheme", 160);
      if (scheme.startsWith("-")) throw fail("Invalid scheme");
      const configuration = args.configuration || "Debug";
      if (!["Debug", "Release"].includes(configuration)) throw fail("configuration must be Debug or Release");
      const destination = args.simulatorId ? `platform=iOS Simulator,id=${simulatorId()}` : "generic/platform=iOS Simulator";
      const output = path.join(directory, `build-${randomUUID()}`);
      return createJob(action, args, context, { command: "/usr/bin/xcodebuild", args: [project.endsWith(".xcworkspace") ? "-workspace" : "-project", project,
        "-scheme", scheme, "-configuration", configuration, "-destination", destination, "-derivedDataPath", output, "CODE_SIGNING_ALLOWED=NO", "build"], cwd: root, outputDirectory: output });
    }
    if (action === "maestro.run") {
      keys(args, ["flow", "simulatorId"]);
      const flow = await scoped(root, args.flow);
      if (!/\.ya?ml$/.test(flow)) throw fail("flow must be a YAML file");
      return createJob(action, args, context, { command: await resolveTool("maestro", root), args: ["--device", simulatorId(), "test", flow], cwd: root, lease: args.simulatorId });
    }
    if (action.startsWith("simulator.")) {
      keys(args, action === "simulator.install" ? ["simulatorId", "path", "buildJobId"] : action === "simulator.launch" ? ["simulatorId", "bundleId"] : ["simulatorId"]);
      const id = simulatorId();
      let commandArgs;
      if (action === "simulator.boot") {
        return createJob(action, args, context, { cwd: root, lease: id, steps: [
          { command: "/usr/bin/xcrun", args: ["simctl", "bootstatus", id, "-b"] },
          { command: "/usr/bin/open", args: ["-a", "Simulator", "--args", "-CurrentDeviceUDID", id] },
        ] });
      }
      if (action === "simulator.install") {
        let artifactRoot = root;
        if (args.buildJobId !== undefined) {
          const build = owned(args.buildJobId, context.peerId);
          if (build.action !== "ios.build" || build.status !== "completed" || build.projectId !== args.projectId || !build.outputDirectory) throw fail("Build artifact is unavailable", 403);
          artifactRoot = await fs.realpath(build.outputDirectory);
          if (!inside(await fs.realpath(directory), artifactRoot)) throw fail("Build output is outside private job storage", 403);
        }
        const app = await scoped(artifactRoot, args.path);
        if (!app.endsWith(".app")) throw fail("path must be an app bundle");
        commandArgs = ["simctl", "install", id, app];
      }
      if (action === "simulator.launch") {
        if (!/^[a-zA-Z0-9][a-zA-Z0-9.-]{1,200}$/.test(args.bundleId || "")) throw fail("Invalid bundleId");
        commandArgs = ["simctl", "launch", id, args.bundleId];
      }
      if (action === "simulator.screenshot") {
        if (leases.has(id)) throw fail("Simulator is busy", 409);
        const lease = randomUUID();
        const file = path.join(directory, `${lease}.png`);
        leases.set(id, lease);
        try {
          await run("/usr/bin/xcrun", ["simctl", "io", id, "screenshot", "--type=png", file]);
          const data = await readBounded(file, 8 * LIMIT);
          return { content: data.toString("base64"), encoding: "base64", mimeType: "image/png", sha256: hash(data) };
        } finally { leases.delete(id); await fs.rm(file, { force: true }); }
      }
      return createJob(action, args, context, { command: "/usr/bin/xcrun", args: commandArgs, cwd: root, lease: id });
    }
    if (action === "ios.submit") {
      keys(args, ["artifact", "destination"]);
      if (!/^[0-9]{5,20}$/.test(args.destination || "")) throw fail("destination must be the numeric App Store app ID");
      const artifact = await scoped(root, args.artifact);
      if (!artifact.endsWith(".ipa")) throw fail("artifact must be an IPA file");
      const app = JSON.parse((await readBounded(await scoped(root, "app.json"))).toString("utf8"));
      const projectId = app?.expo?.extra?.eas?.projectId;
      if (!uuid.test(projectId || "")) throw fail("A static app.json with a linked project ID is required");
      const slug = text(app.expo.slug, "static app slug", 160);
      const name = text(app.expo.name, "static app name", 160);
      const owner = app.expo.owner === undefined ? undefined : text(app.expo.owner, "static app owner", 160);
      const bundleIdentifier = app.expo.ios?.bundleIdentifier;
      if (bundleIdentifier !== undefined && !/^[A-Za-z0-9][A-Za-z0-9.-]{1,200}$/.test(bundleIdentifier)) throw fail("Invalid bundle identifier");
      const staticApp = { name, slug, ...(owner ? { owner } : {}), ...(bundleIdentifier ? { ios: { bundleIdentifier } } : {}), extra: { eas: { projectId } } };
      const digest = await digestFile(artifact);
      const summary = { artifact: args.artifact, sha256: digest, destination: args.destination, serviceProjectId: projectId };
      return createJob(action, args, context, null, { summary, root, artifact, projectId, staticApp });
    }
    throw fail("Unknown action");
  }
  return {
    async execute(action, args, context) {
      try { return await executeAction(action, args, context); }
      catch (error) {
        if (Number.isInteger(error.status)) throw error;
        throw fail("Local action failed. Check the selected path and installed tools on this device.", 500);
      }
    },
    async listJobs(peerId) { await ready; return [...jobs.values()].filter((job) => peerId === undefined || job.peerId === peerId).map((job) => view(job)); },
    async getJob(id, peerId, cursor = 0) { await ready; return view(owned(id, peerId), cursor); },
    async approve(id, approved) {
      await ready;
      if (typeof approved !== "boolean") throw fail("Approval must be explicit");
      const job = owned(id);
      const runtime = active.get(id);
      if (job.status !== "waiting_approval" || !runtime?.approval) throw fail("Approval is unavailable or already consumed", 409);
      if (!approved) { await finish(job, "cancelled", "Approval declined."); return view(job); }
      // Consume approval before awaiting file I/O, preventing concurrent use.
      job.status = "queued";
      await persist();
      try {
        const root = await checked(runtime.context, job.action, job.projectId);
        const approval = runtime.approval;
        if (root !== approval.root || await scoped(root, approval.summary.artifact) !== approval.artifact || await digestFile(approval.artifact) !== approval.summary.sha256) throw fail("Approved artifact changed", 409);
        const jobDir = path.join(directory, id);
        await fs.mkdir(jobDir, { mode: 0o700 });
        const artifact = path.join(jobDir, "artifact.ipa");
        await fs.copyFile(approval.artifact, artifact, constants.COPYFILE_EXCL);
        if (await digestFile(artifact) !== approval.summary.sha256) throw fail("Artifact changed while staging", 409);
        await fs.chmod(artifact, 0o400);
        await fs.writeFile(path.join(jobDir, "eas.json"), JSON.stringify({ submit: { bridge: { ios: { ascAppId: approval.summary.destination } } } }), { mode: 0o600 });
        await fs.writeFile(path.join(jobDir, "app.json"), JSON.stringify({ expo: approval.staticApp }), { mode: 0o600 });
        await fs.writeFile(path.join(jobDir, "package.json"), JSON.stringify({ name: "bridge-submission", private: true, version: "1.0.0" }), { mode: 0o600 });
        await checked(runtime.context, job.action, job.projectId);
        const environment = { ...process.env, EAS_NO_VCS: "1", EXPO_NO_DOTENV: "1" };
        delete environment.NODE_OPTIONS;
        delete environment.NODE_PATH;
        delete environment.BASH_ENV;
        delete environment.ENV;
        environment.PATH = (environment.PATH || "").split(path.delimiter).filter((entry) => path.isAbsolute(entry) && !inside(root, entry)).join(path.delimiter);
        await launch(job, { command: await resolveTool("eas", root), args: ["submit", "--platform", "ios", "--path", artifact, "--profile", "bridge", "--non-interactive", "--wait"], cwd: jobDir, env: environment }, runtime.context);
      } catch (error) { if (job.status !== "cancelled") await finish(job, "failed", "Submission approval validation or startup failed."); throw error; }
      return view(job);
    },
    async cancel(id, peerId) {
      await ready;
      const job = owned(id, peerId);
      const runtime = active.get(id);
      if (!runtime) return view(job);
      job.status = "cancelled";
      if (runtime.child?.pid) {
        const child = runtime.child;
        await new Promise((resolve) => {
          let timer;
          const done = () => { clearTimeout(timer); child.removeListener("close", done); resolve(); };
          child.once("close", done);
          try { killProcess(-child.pid, "SIGTERM"); } catch { done(); return; }
          timer = setTimeout(() => {
            try { killProcess(-child.pid, "SIGKILL"); } catch { /* Already exited. */ }
            done();
          }, 2000);
        });
      }
      await finish(job, "cancelled", "Cancelled. External operations already accepted by a service may continue.");
      return view(job);
    },
    async close() {
      closed = true;
      for (const peerId of new Set([...active.values()].map((runtime) => runtime.context.peerId))) generations.set(peerId, (generations.get(peerId) || 0) + 1);
      await ready;
      await Promise.all([...active.keys()].map((id) => this.cancel(id)));
      await persistTail;
    },
    async revokePeer(peerId) {
      generations.set(peerId, (generations.get(peerId) || 0) + 1);
      await ready;
      await Promise.all([...jobs.values()].filter((job) => job.peerId === peerId && active.has(job.id)).map((job) => this.cancel(job.id, peerId)));
    },
  };
}
