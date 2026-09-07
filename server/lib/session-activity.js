// The probe and classifier run identically in-process and on an SSH device.
// Process arguments are examined on that device and never leave this module.
export function detectSessionActivity(panes, processes) {
  const known = new Set(["claude", "codex", "bash", "zsh", "fish", "sh", "dash", "node", "nodejs", "bun", "deno", "python", "python3", "git", "vim", "nvim", "less", "ssh", "tmux", "btop", "htop", "top", "yazi", "ranger", "nnn", "lf", "docker", "lazydocker"]);
  const basename = (value) => String(value || "").split("/").pop().replace(/^-/, "");
  const label = (value) => known.has(basename(value)) ? basename(value) : "";
  const tty = (value) => String(value || "").replace(/^\/dev\//, "").replace(/^tty/, "");
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const ancestry = (process, panePid) => {
    let depth = 0;
    const seen = new Set();
    while (process && !seen.has(process.pid)) {
      if (process.pid === panePid) return depth;
      seen.add(process.pid);
      process = byPid.get(process.ppid);
      depth++;
    }
    return -1;
  };
  const agent = (process) => {
    const executable = process.executable || process.command;
    const direct = basename(executable);
    if (direct === "claude" || direct === "codex") return direct;
    if (/\/.local\/share\/claude\/versions\/\d+\.\d+\.\d+(?:[-.][A-Za-z0-9]+)*$/.test(executable || "")) return "claude";
    if (!["node", "nodejs", "bun", "deno"].includes(direct)) return "";
    const entry = process.entrypoint || "";
    if (/\/node_modules\/@anthropic-ai\/claude-code\/cli\.js$/.test(entry)) return "claude";
    if (/\/node_modules\/@openai\/codex\/bin\/codex\.js$/.test(entry)) return "codex";
    if (["claude", "codex"].includes(basename(entry))) return basename(entry);
    return "";
  };
  return panes.filter((pane) => pane.paneActive).map((pane) => {
    const root = byPid.get(pane.pid);
    let best = null;
    for (const process of processes) {
      if (!root || root.tpgid <= 0 || process.pgid !== root.tpgid || tty(process.tty) !== tty(pane.tty)) continue;
      const depth = ancestry(process, pane.pid);
      if (depth < 0) continue;
      const command = agent(process);
      if (command && (!best || depth > best.depth)) best = { command, depth };
    }
    // Once a process snapshot exists, never infer an agent from a pane title
    // or stale current-command label if the foreground process disagrees.
    const fallback = label(pane.command);
    return { session: pane.session, window: pane.window, active: pane.active, command: best?.command || (["claude", "codex"].includes(fallback) && root ? "" : fallback) };
  });
}

export function interpreterEntrypoint(argv) {
  const valueFlags = new Set(["-r", "--require", "--import", "--loader", "--experimental-loader", "--conditions", "-C", "--inspect-port", "--title", "--max-old-space-size"]);
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (/^-(?:e|p)/.test(argument) || /^(?:--eval|--print)(?:=|$)/.test(argument)) return "";
    if (argument === "--") return argv[index + 1] || "";
    if (valueFlags.has(argument)) { index++; continue; }
    if (argument.startsWith("-")) continue;
    return argument;
  }
  return "";
}

export async function probeSessionActivity() {
  const { execFile } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const path = await import("node:path");
  const execute = (command, args) => new Promise((resolve) => {
    execFile(command, args, { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout));
  });
  const format = "#{session_name}\t#{window_index}\t#{window_active}\t#{pane_active}\t#{pane_pid}\t#{pane_tty}\t#{pane_current_command}";
  const [paneText, processText] = await Promise.all([
    execute("tmux", ["list-panes", "-a", "-F", format]),
    execute("ps", ["-ax", "-o", "pid=,ppid=,pgid=,tpgid=,tty=,comm="]),
  ]);
  const panes = paneText.split("\n").filter(Boolean).map((line) => {
    const [session, window, active, paneActive, pid, tty, command] = line.split("\t");
    return { session, window: Number(window), active: active === "1", paneActive: paneActive === "1", pid: Number(pid), tty, command };
  }).filter((pane) => pane.session && Number.isInteger(pane.window) && pane.pid > 0);
  const processes = processText.split("\n").map((line) => {
    const fields = line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(-?\d+)\s+(\S+)\s+(.+)$/);
    return fields ? { pid: Number(fields[1]), ppid: Number(fields[2]), pgid: Number(fields[3]), tpgid: Number(fields[4]), tty: fields[5], command: fields[6] } : null;
  }).filter(Boolean);
  const paneGroups = new Set(panes.filter((pane) => pane.paneActive).map((pane) => processes.find((process) => process.pid === pane.pid)?.tpgid).filter((group) => group > 0));
  const candidates = processes.filter((process) => paneGroups.has(process.pgid));
  // Linux exposes exact argv boundaries without terminal text. Other Unix
  // devices use ps only for interpreter candidates, never for shell matching.
  const macCandidates = [];
  for (const process of candidates) {
    if (globalThis.process.platform === "linux") {
      try {
        process.executable = await fs.readlink(`/proc/${process.pid}/exe`);
        if (["node", "nodejs", "bun", "deno"].includes(path.basename(process.executable))) {
          const argv = (await fs.readFile(`/proc/${process.pid}/cmdline`, "utf8")).split("\0");
          const entry = interpreterEntrypoint(argv);
          if (entry) {
            const cwd = await fs.readlink(`/proc/${process.pid}/cwd`);
            process.entrypoint = await fs.realpath(path.resolve(cwd, entry)).catch(() => "");
          }
        }
      } catch { /* A process may exit during the snapshot. */ }
    } else if (["node", "nodejs", "bun", "deno"].includes(path.basename(process.command))) macCandidates.push(process);
  }
  if (macCandidates.length) {
    const argumentsText = await execute("ps", ["-ww", "-p", macCandidates.map((process) => process.pid).join(","), "-o", "pid=,args="]);
    for (const line of argumentsText.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      const process = match && macCandidates.find((candidate) => candidate.pid === Number(match[1]));
      if (!process) continue;
      // ps does not preserve argv boundaries on macOS. Accept only a simple,
      // explicit interpreter + absolute entrypoint, never arbitrary shell text.
      const argv = match[2].trim().split(/\s+/);
      if (!["node", "nodejs", "bun", "deno"].includes(path.basename(argv[0]))) continue;
      const entry = interpreterEntrypoint(argv);
      if (entry?.startsWith("/")) process.entrypoint = await fs.realpath(entry).catch(() => "");
    }
  }
  return detectSessionActivity(panes, processes);
}

export const ACTIVITY_PROBE_SCRIPT = `const detectSessionActivity = ${detectSessionActivity.toString()};\nconst interpreterEntrypoint = ${interpreterEntrypoint.toString()};\n(${probeSessionActivity.toString()})().then((rows) => process.stdout.write(JSON.stringify(rows))).catch(() => process.stdout.write("[]"));`;
