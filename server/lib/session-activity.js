import { tmuxArgs } from "./tmux-client.js";

// The probe and classifier run identically in-process and on an SSH device.
// Process arguments and account settings are examined only on that device.
export function normalizeEffectiveModel(value) {
  if (typeof value !== "string") return null;
  const model = value.trim().toLowerCase();
  if (model.length === 0 || model.length > 128 || !/^[a-z0-9.-]+$/.test(model)) return null;
  if (/^claude-(?:opus|sonnet|haiku|fable|mythos)(?:[-.][a-z0-9]+)*$/.test(model)) return { model, provider: "claude" };
  if (/^gpt-(?:\d+(?:\.\d+)?|4o)(?:-(?:mini|nano|pro|turbo|latest|chat-latest|codex(?:-(?:mini|max))?))*$/.test(model)) return { model, provider: "codex" };
  return null;
}

function modelSelection(value) {
  if (typeof value !== "string" || !value.trim()) return { declared: false, metadata: null };
  const model = normalizeEffectiveModel(value);
  return {
    declared: true,
    metadata: model ? { effectiveModel: model.model, effectiveProvider: model.provider, effectiveModelEvidence: "configured" } : null,
  };
}

// `--model` configures the foreground CLI. Keep its final selector so an
// unknown later override cannot accidentally inherit an earlier known model.
export function foregroundModelSelection(argv) {
  let selection = { declared: false, metadata: null };
  for (let index = 1; index < argv.length; index++) {
    const argument = argv[index];
    if (argument === "--") break;
    if (typeof argument !== "string") continue;
    if (argument.startsWith("--model=")) {
      selection = modelSelection(argument.slice("--model=".length));
    } else if (argument === "--model") {
      selection = modelSelection(argv[index + 1]);
      index++;
    }
  }
  return selection;
}

function environmentValue(environmentText, name) {
  if (typeof environmentText !== "string") return "";
  const prefix = `${name}=`;
  let start = 0;
  while (start <= environmentText.length) {
    const end = environmentText.indexOf("\0", start);
    const entry = environmentText.slice(start, end < 0 ? environmentText.length : end);
    if (entry.startsWith(prefix)) return entry.slice(prefix.length);
    if (end < 0) break;
    start = end + 1;
  }
  return "";
}

// Return only the two allowlisted process selectors. A raw argv/environment is
// never attached to a process or returned by the activity API.
export function processModelSelectors(argv, environmentText) {
  const argument = foregroundModelSelection(argv);
  const accountDirectory = environmentValue(environmentText, "CLAUDE_CONFIG_DIR");
  if (argument.declared) return { modelDeclared: true, metadata: argument.metadata, accountDirectory };
  const environment = modelSelection(environmentValue(environmentText, "ANTHROPIC_MODEL"));
  return { modelDeclared: environment.declared, metadata: environment.metadata, accountDirectory };
}

function settingsModelSelection(content) {
  try {
    const settings = JSON.parse(content);
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return { declared: false, metadata: null };
    const environment = settings.env;
    if (environment && typeof environment === "object" && !Array.isArray(environment) && Object.hasOwn(environment, "ANTHROPIC_MODEL")) {
      return modelSelection(environment.ANTHROPIC_MODEL);
    }
    return Object.hasOwn(settings, "model") ? modelSelection(settings.model) : { declared: false, metadata: null };
  } catch {
    return { declared: false, metadata: null };
  }
}

async function settingsFileSelection(fs, path, directory, filename) {
  try {
    const file = path.join(directory, filename);
    const metadata = await fs.lstat(file);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > 256 * 1024) return { declared: false, metadata: null };
    return settingsModelSelection(await fs.readFile(file, "utf8"));
  } catch {
    return { declared: false, metadata: null };
  }
}

async function accountDirectory(value, fs, os, path) {
  if (typeof value !== "string" || !value.startsWith("/")) return "";
  try {
    const directory = await fs.realpath(value);
    const home = await fs.realpath(os.homedir());
    const name = path.basename(directory);
    if (path.dirname(directory) !== home || !/^\.claude(?:-[^/]+)?$/.test(name)) return "";
    return directory;
  } catch {
    return "";
  }
}

// This considers only the exact account selected by the active process. The
// default account is used only after reading that process's environment and
// confirming it has no CLAUDE_CONFIG_DIR override.
export async function configuredModelSelection(sessionEnvironment, selectedAccount, fs, os, path) {
  const fromEnvironment = modelSelection(sessionEnvironment.ANTHROPIC_MODEL);
  if (fromEnvironment.declared) return fromEnvironment.metadata;
  const requestedAccount = selectedAccount || path.join(os.homedir(), ".claude");
  const directory = await accountDirectory(requestedAccount, fs, os, path);
  if (!directory) return null;
  for (const filename of ["settings.local.json", "settings.json"]) {
    const selection = await settingsFileSelection(fs, path, directory, filename);
    if (selection.declared) return selection.metadata;
  }
  return null;
}

function processMetadata(process) {
  const argument = Array.isArray(process.argv) ? foregroundModelSelection(process.argv) : { declared: false, metadata: null };
  if (argument.declared) return argument.metadata;
  const normalized = normalizeEffectiveModel(process.effectiveModel);
  if (normalized && process.effectiveProvider === normalized.provider && ["reported", "configured"].includes(process.effectiveModelEvidence)) {
    return { effectiveModel: normalized.model, effectiveProvider: normalized.provider, effectiveModelEvidence: process.effectiveModelEvidence };
  }
  return null;
}

export function processAgentCommand(process) {
  const basename = (value) => String(value || "").split("/").pop().replace(/^-/, "");
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
}

function activityMetadata(row) {
  const normalized = normalizeEffectiveModel(row.effectiveModel);
  if (!normalized || row.effectiveProvider !== normalized.provider || !["reported", "configured"].includes(row.effectiveModelEvidence)) return null;
  return { effectiveModel: normalized.model, effectiveProvider: normalized.provider, effectiveModelEvidence: row.effectiveModelEvidence };
}

export function detectSessionActivity(panes, processes) {
  const known = new Set(["claude", "codex", "bash", "zsh", "fish", "sh", "dash", "node", "nodejs", "bun", "deno", "python", "python3", "git", "vim", "nvim", "less", "ssh", "tmux", "btop", "htop", "top", "yazi", "ranger", "nnn", "lf", "docker", "lazydocker"]);
  const basename = (value) => String(value || "").split("/").pop().replace(/^-/, "");
  const label = (value) => known.has(basename(value)) ? basename(value) : "";
  const tty = (value) => String(value || "").replace(/^\/dev\//, "").replace(/^tty/, "");
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const byGroup = new Map();
  for (const process of processes) {
    const key = `${process.pgid}:${tty(process.tty)}`;
    if (!byGroup.has(key)) byGroup.set(key, []);
    byGroup.get(key).push(process);
  }
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
  return panes.filter((pane) => pane.paneActive).map((pane) => {
    const root = byPid.get(pane.pid);
    let best = null;
    const candidates = root?.tpgid > 0 ? byGroup.get(`${root.tpgid}:${tty(pane.tty)}`) || [] : [];
    for (const process of candidates) {
      const depth = ancestry(process, pane.pid);
      if (depth < 0) continue;
      const command = processAgentCommand(process);
      if (command && (!best || depth > best.depth)) best = { command, metadata: processMetadata(process), depth };
    }
    // Once a process snapshot exists, never infer an agent or preserve stale
    // model evidence from a pane title/current-command label.
    const fallback = label(pane.command);
    const metadata = best?.metadata || (!root && ["claude", "codex"].includes(fallback) ? activityMetadata(pane) : null);
    return {
      session: pane.session,
      window: pane.window,
      active: pane.active,
      command: best?.command || (["claude", "codex"].includes(fallback) && root ? "" : fallback),
      effectiveModel: metadata?.effectiveModel ?? null,
      effectiveProvider: metadata?.effectiveProvider ?? null,
      effectiveModelEvidence: metadata?.effectiveModelEvidence ?? null,
    };
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

const MAC_PROCESS_SELECTORS_SCRIPT = String.raw`import ctypes, json, re, sys

CLAUDE = re.compile(r"^claude-(?:opus|sonnet|haiku|fable|mythos)(?:[-.][a-z0-9]+)*$")
GPT = re.compile(r"^gpt-(?:\d+(?:\.\d+)?|4o)(?:-(?:mini|nano|pro|turbo|latest|chat-latest|codex(?:-(?:mini|max))?))*$")

def model(value):
    value = value.strip().lower()
    if len(value) > 128 or not re.fullmatch(r"[a-z0-9.-]+", value):
        return None, None
    if CLAUDE.fullmatch(value):
        return value, "claude"
    if GPT.fullmatch(value):
        return value, "codex"
    return None, None

def selector(argv):
    declared = False
    value = ""
    index = 1
    while index < len(argv):
        argument = argv[index]
        if argument == "--":
            break
        if argument.startswith("--model="):
            declared = True
            value = argument[len("--model="):]
        elif argument == "--model":
            declared = True
            index += 1
            value = argv[index] if index < len(argv) else ""
        index += 1
    selected, provider = model(value) if declared else (None, None)
    return declared, selected, provider

def process_data(pid):
    libc = ctypes.CDLL(None)
    mib = (ctypes.c_int * 3)(1, 49, pid) # CTL_KERN, KERN_PROCARGS2, pid
    size = ctypes.c_size_t()
    if libc.sysctl(mib, 3, None, ctypes.byref(size), None, 0) != 0 or not size.value:
        return None
    buffer = ctypes.create_string_buffer(size.value)
    if libc.sysctl(mib, 3, buffer, ctypes.byref(size), None, 0) != 0:
        return None
    data = buffer.raw[:size.value]
    width = ctypes.sizeof(ctypes.c_int)
    if len(data) < width:
        return None
    argc = ctypes.c_int.from_buffer_copy(data[:width]).value
    if argc < 0 or argc > 4096:
        return None
    offset = width
    end = data.find(b"\0", offset)
    if end < 0:
        return None
    offset = end + 1
    while offset < len(data) and data[offset] == 0:
        offset += 1
    argv = []
    for _ in range(argc):
        end = data.find(b"\0", offset)
        if end < 0:
            return None
        argv.append(data[offset:end].decode("utf-8", "ignore"))
        offset = end + 1
    environment_model = ""
    account_directory = ""
    for entry in data[offset:].split(b"\0"):
        if entry.startswith(b"ANTHROPIC_MODEL="):
            environment_model = entry[len(b"ANTHROPIC_MODEL="):].decode("utf-8", "ignore")
        elif entry.startswith(b"CLAUDE_CONFIG_DIR="):
            account_directory = entry[len(b"CLAUDE_CONFIG_DIR="):].decode("utf-8", "ignore")
    declared, selected, provider = selector(argv)
    if not declared and environment_model:
        declared = True
        selected, provider = model(environment_model)
    return {"pid": pid, "modelDeclared": declared, "effectiveModel": selected, "effectiveProvider": provider, "accountDirectory": account_directory}

result = []
for raw_pid in sys.argv[1].split(",")[:64]:
    try:
        entry = process_data(int(raw_pid))
        if entry is not None:
            result.append(entry)
    except (ValueError, OSError):
        pass
json.dump(result, sys.stdout)`;

function applyProcessSelectors(process, selectors) {
  process.selectorsAvailable = true;
  process.modelDeclared = selectors.modelDeclared;
  process.accountDirectory = selectors.accountDirectory;
  if (selectors.metadata) Object.assign(process, selectors.metadata);
}

async function macProcessSelectors(execute, pids) {
  const uniquePids = [...new Set(pids)].filter((pid) => Number.isInteger(pid) && pid > 0).slice(0, 64);
  if (!uniquePids.length) return new Map();
  const output = await execute("python3", ["-c", MAC_PROCESS_SELECTORS_SCRIPT, uniquePids.join(",")]);
  try {
    const rows = JSON.parse(output);
    if (!Array.isArray(rows)) return new Map();
    return new Map(rows.flatMap((row) => {
      if (!row || typeof row !== "object" || !Number.isInteger(row.pid) || !uniquePids.includes(row.pid)) return [];
      const normalized = normalizeEffectiveModel(row.effectiveModel);
      const metadata = normalized && normalized.provider === row.effectiveProvider
        ? { effectiveModel: normalized.model, effectiveProvider: normalized.provider, effectiveModelEvidence: "configured" }
        : null;
      return [[row.pid, {
        modelDeclared: row.modelDeclared === true,
        metadata,
        accountDirectory: typeof row.accountDirectory === "string" ? row.accountDirectory : "",
      }]];
    }));
  } catch {
    return new Map();
  }
}

export async function probeSessionActivity(tmuxOptions = tmuxArgs([])) {
  const { execFile } = await import("node:child_process");
  const fs = await import("node:fs/promises");
  const os = await import("node:os");
  const path = await import("node:path");
  const execute = (command, args) => new Promise((resolve) => {
    execFile(command, args, { timeout: 3_000, maxBuffer: 4 * 1024 * 1024 }, (error, stdout) => resolve(error ? "" : stdout || ""));
  });
  const format = "#{session_name}\t#{window_index}\t#{window_active}\t#{pane_active}\t#{pane_pid}\t#{pane_tty}\t#{pane_current_command}";
  const [paneText, processText] = await Promise.all([
    execute("tmux", [...tmuxOptions, "list-panes", "-a", "-F", format]),
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
  const tty = (value) => String(value || "").replace(/^\/dev\//, "").replace(/^tty/, "");
  const byPid = new Map(processes.map((process) => [process.pid, process]));
  const paneGroups = new Set(panes.filter((pane) => pane.paneActive).flatMap((pane) => {
    const group = byPid.get(pane.pid)?.tpgid;
    return group > 0 ? [`${group}:${tty(pane.tty)}`] : [];
  }));
  const candidates = processes.filter((process) => paneGroups.has(`${process.pgid}:${tty(process.tty)}`));
  const macCandidates = [];
  for (const process of candidates) {
    if (globalThis.process.platform === "linux") {
      try {
        process.executable = await fs.readlink(`/proc/${process.pid}/exe`);
        const direct = processAgentCommand(process);
        const interpreter = ["node", "nodejs", "bun", "deno"].includes(path.basename(process.executable));
        if (!direct && !interpreter) continue;
        const argv = (await fs.readFile(`/proc/${process.pid}/cmdline`, "utf8")).split("\0");
        if (interpreter) {
          const entry = interpreterEntrypoint(argv);
          if (entry) {
            const cwd = await fs.readlink(`/proc/${process.pid}/cwd`);
            process.entrypoint = await fs.realpath(path.resolve(cwd, entry)).catch(() => "");
          }
        }
        if (processAgentCommand(process)) {
          const argument = foregroundModelSelection(argv);
          if (argument.declared) {
            applyProcessSelectors(process, { modelDeclared: true, metadata: argument.metadata, accountDirectory: "" });
          } else {
            const environment = await fs.readFile(`/proc/${process.pid}/environ`, "utf8");
            applyProcessSelectors(process, processModelSelectors(argv, environment));
          }
        }
      } catch { /* A process may exit or deny a selector read during the snapshot. */ }
    } else {
      const direct = processAgentCommand(process);
      if (direct || ["node", "nodejs", "bun", "deno"].includes(path.basename(process.command))) macCandidates.push(process);
    }
  }
  if (macCandidates.length) {
    const selectorsByPid = await macProcessSelectors(execute, macCandidates.map((process) => process.pid));
    const argumentsText = await execute("ps", ["-ww", "-p", macCandidates.map((process) => process.pid).join(","), "-o", "pid=,args="]);
    const byCandidatePid = new Map(macCandidates.map((process) => [process.pid, process]));
    for (const process of macCandidates) {
      const selectors = selectorsByPid.get(process.pid);
      if (selectors) applyProcessSelectors(process, selectors);
    }
    for (const line of argumentsText.split("\n")) {
      const match = line.trim().match(/^(\d+)\s+(.*)$/);
      const process = match && byCandidatePid.get(Number(match[1]));
      if (!process) continue;
      // ps does not preserve model arguments. It is retained only to identify a
      // simple absolute Node entrypoint, never to attribute a model.
      const argv = match[2].trim().split(/\s+/);
      if (!["node", "nodejs", "bun", "deno"].includes(path.basename(argv[0]))) continue;
      const entry = interpreterEntrypoint(argv);
      if (entry?.startsWith("/")) process.entrypoint = await fs.realpath(entry).catch(() => "");
    }
  }
  await Promise.all(candidates.map(async (process) => {
    if (!process.selectorsAvailable || process.modelDeclared || processMetadata(process) || processAgentCommand(process) !== "claude") return;
    const metadata = await configuredModelSelection({}, process.accountDirectory, fs, os, path);
    if (metadata) Object.assign(process, metadata);
  }));
  return detectSessionActivity(panes, processes);
}

export const ACTIVITY_PROBE_SCRIPT = `const normalizeEffectiveModel = ${normalizeEffectiveModel.toString()};\nconst modelSelection = ${modelSelection.toString()};\nconst foregroundModelSelection = ${foregroundModelSelection.toString()};\nconst environmentValue = ${environmentValue.toString()};\nconst processModelSelectors = ${processModelSelectors.toString()};\nconst settingsModelSelection = ${settingsModelSelection.toString()};\nconst settingsFileSelection = ${settingsFileSelection.toString()};\nconst accountDirectory = ${accountDirectory.toString()};\nconst configuredModelSelection = ${configuredModelSelection.toString()};\nconst processMetadata = ${processMetadata.toString()};\nconst processAgentCommand = ${processAgentCommand.toString()};\nconst activityMetadata = ${activityMetadata.toString()};\nconst detectSessionActivity = ${detectSessionActivity.toString()};\nconst interpreterEntrypoint = ${interpreterEntrypoint.toString()};\nconst MAC_PROCESS_SELECTORS_SCRIPT = ${JSON.stringify(MAC_PROCESS_SELECTORS_SCRIPT)};\nconst applyProcessSelectors = ${applyProcessSelectors.toString()};\nconst macProcessSelectors = ${macProcessSelectors.toString()};\n(${probeSessionActivity.toString()})([]).then((rows) => process.stdout.write(JSON.stringify(rows))).catch(() => process.stdout.write("[]"));`;
