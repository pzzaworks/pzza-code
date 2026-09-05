// PzzaCode backend. Runs in one of two roles:
//
//   source   (default, on the devbox): tmux/ports are local; it cannot forward.
//   receiver (PZZA_DEVBOX_HOST set, on the Mac): tmux/ports come from the devbox
//            over ssh, and it OWNS port forwarding (ssh -L), so the UI exposes a
//            global enable/disable - the "receiver controls" only show here.
//
// The frontend asks /capabilities and shows forwarding controls only when the
// connected backend can actually forward.
import http from "node:http";
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
// ws + node-pty are loaded lazily (see startPtyBridge) so the agent still boots
// on a bare Node runtime with no installed modules - the app's terminals go
// through the Rust backend, and only the browser build's WebSocket PTY needs them.

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const MCP_PATH = path.join(REPO_ROOT, "mcp/server.js");

const PORT = Number(process.env.PORT || 5190);
const DEVBOX = process.env.PZZA_DEVBOX_HOST || ""; // e.g. "devbox"; empty = source
const IS_CLIENT = DEVBOX !== ""; // client machine: tmux/ports over ssh, does -L forwarding
const SKIP = new Set([22, 53, 631, 3389]);
const MIN_PORT = 1024;

// Where this device persists saved state and rotating backups (created on boot).
const STATE_DIR = path.join(
  process.env.XDG_CONFIG_HOME || path.join(process.env.HOME || ".", ".config"),
  "pzza-console",
);
try {
  fs.mkdirSync(path.join(STATE_DIR, "backups"), { recursive: true });
} catch {
  /* best effort */
}

// Run a command string either locally (source) or on the devbox over ssh.
function sh(remote, cb) {
  if (IS_CLIENT) execFile("ssh", ["-o", "BatchMode=yes", DEVBOX, remote], cb);
  else execFile("sh", ["-c", remote], cb);
}

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "*");
}
function json(res, code, body) {
  cors(res);
  res.writeHead(code, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}

function parsePorts(stdout) {
  const ports = new Set();
  for (const line of stdout.split("\n")) {
    const m = line.trim().match(/:(\d+)$/);
    if (m) ports.add(Number(m[1]));
  }
  return [...ports].sort((a, b) => a - b);
}

function listPorts() {
  return new Promise((resolve) => {
    sh("ss -tlnH 2>/dev/null | awk '{print $4}'", (err, out) =>
      resolve(err ? [] : parsePorts(out)),
    );
  });
}

const SESSIONS_CMD =
  "tmux list-sessions -F '#{session_name}\t#{session_windows}\t#{session_attached}\t#{pane_current_command}\t#{pane_current_path}'";

function parseSessions(out) {
  const sessions = [];
  for (const line of String(out || "").split("\n")) {
    if (!line) continue;
    const [name, windows, attached, command, path] = line.split("\t");
    if (name) {
      sessions.push({
        name,
        windows: Number(windows) || 0,
        attached: attached !== "0",
        command: command || "",
        path: path || "",
      });
    }
  }
  return sessions;
}

function listSessions() {
  return new Promise((resolve) => {
    sh(SESSIONS_CMD, (err, out) => resolve(err ? [] : parseSessions(out)));
  });
}

// Run a command on a specific device: locally/on the connected device when host
// is empty, else over SSH to that host.
function shOn(host, remote, cb) {
  if (!host) return sh(remote, cb);
  execFile(
    "ssh",
    ["-o", "BatchMode=yes", "-o", "ConnectTimeout=8", "-o", "StrictHostKeyChecking=accept-new", host, remote],
    cb,
  );
}

// Scan every tmux session on a device (including ones the app never opened).
function scanSessions(host) {
  return new Promise((resolve) => {
    shOn(host, SESSIONS_CMD, (err, out) => resolve(err ? [] : parseSessions(out)));
  });
}

// ---- Forwarding (client only): the port-mirror loop, in-process ----
let fwdEnabled = true;
const active = new Set();

function shQuote(v) {
  return `'${String(v).replace(/'/g, `'\\''`)}'`;
}
function forwardPort(port, on) {
  const spec = `${port}:127.0.0.1:${port}`;
  execFile("ssh", ["-O", on ? "forward" : "cancel", "-L", spec, DEVBOX], () => {});
}
function ensureMaster(cb) {
  execFile("ssh", ["-O", "check", DEVBOX], (err) => {
    if (!err) return cb(true);
    execFile("ssh", ["-o", "BatchMode=yes", "-N", "-f", DEVBOX], () =>
      execFile("ssh", ["-O", "check", DEVBOX], (e2) => cb(!e2)),
    );
  });
}
async function reconcile() {
  if (!IS_CLIENT) return;
  if (!fwdEnabled) {
    for (const p of active) forwardPort(p, false);
    active.clear();
    return;
  }
  ensureMaster(async (up) => {
    if (!up) return;
    const ports = await listPorts();
    const wanted = ports.filter((p) => p >= MIN_PORT && !SKIP.has(p));
    for (const p of wanted) {
      if (!active.has(p)) {
        forwardPort(p, true);
        active.add(p);
      }
    }
    for (const p of [...active]) {
      if (!wanted.includes(p)) {
        forwardPort(p, false);
        active.delete(p);
      }
    }
  });
}
if (IS_CLIENT) setInterval(reconcile, 4000);

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(data || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

function readRawBody(req) {
  return new Promise((resolve) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks)));
  });
}

// Save a pasted image where the devbox agent can read it. Locally on the source,
// or piped over ssh on a client.
function saveImage(file, buf, cb) {
  if (IS_CLIENT) {
    const p = execFile("ssh", [DEVBOX, `cat > ${file}`], cb);
    p.stdin.write(buf);
    p.stdin.end();
  } else {
    fs.writeFile(file, buf, cb);
  }
}

function listWindows() {
  return new Promise((resolve) => {
    sh(
      "tmux list-windows -a -F '#{session_name}\t#{window_index}\t#{window_name}\t#{window_active}\t#{pane_current_command}\t#{pane_current_path}'",
      (err, out) => {
        if (err) return resolve([]);
        const wins = [];
        for (const line of out.split("\n")) {
          if (!line) continue;
          const [session, index, wname, active, command, path] = line.split("\t");
          if (session) {
            wins.push({
              session,
              window: Number(index) || 0,
              windowName: wname || "",
              active: active === "1",
              command: command || "",
              path: path || "",
            });
          }
        }
        resolve(wins);
      },
    );
  });
}

// Per-framework config snippets for adding the pzzacode-mcp MCP server.
function mcpConfigs(mcpPath) {
  const jsonEntry = { command: "node", args: [mcpPath] };
  const jsonBlock = (root) =>
    JSON.stringify({ [root]: { "pzzacode-mcp": jsonEntry } }, null, 2);
  return {
    frameworks: {
      claude: { label: "Claude Code", cli: true, config: jsonBlock("mcpServers") },
      codex: {
        label: "Codex",
        cli: true,
        config: `[mcp_servers.pzzacode-mcp]\ncommand = "node"\nargs = ["${mcpPath}"]`,
      },
      cursor: { label: "Cursor", cli: false, config: jsonBlock("mcpServers") },
      windsurf: { label: "Windsurf", cli: false, config: jsonBlock("mcpServers") },
      zed: {
        label: "Zed",
        cli: false,
        config: JSON.stringify(
          { context_servers: { "pzzacode-mcp": { command: { path: "node", args: [mcpPath] } } } },
          null,
          2,
        ),
      },
    },
  };
}

function run(cmd, args) {
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
async function mcpInstall(framework, mcpPath) {
  if (framework === "claude") {
    const r = await run("claude", ["mcp", "add", "-s", "user", "pzzacode-mcp", "--", "node", mcpPath]);
    return { framework, ...r, via: "claude mcp add" };
  }
  if (framework === "codex") {
    const r = await run("codex", ["mcp", "add", "pzzacode-mcp", "--", "node", mcpPath]);
    return { framework, ...r, via: "codex mcp add" };
  }
  return { framework, ok: false, manual: true, error: "no CLI - copy the config into your settings" };
}

// Environment diagnostics for the in-app setup wizard.
function runCheck(cmd, args) {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 6000 }, (err, stdout) =>
      resolve(err ? null : String(stdout).trim()),
    );
  });
}
async function doctor() {
  const tmuxVersion = await runCheck("tmux", ["-V"]);
  let stateWritable = false;
  try {
    fs.accessSync(STATE_DIR, fs.constants.W_OK);
    stateWritable = true;
  } catch {
    /* not writable */
  }
  const result = {
    role: IS_CLIENT ? "client" : "source",
    host: DEVBOX || null,
    port: PORT,
    node: process.version,
    tmux: tmuxVersion, // "tmux 3.6" or null when missing
    nodePty: true, // the module imported, so the native binding loaded
    stateDir: STATE_DIR,
    stateWritable,
  };
  if (IS_CLIENT) {
    result.sshReachable = await new Promise((resolve) => {
      execFile(
        "ssh",
        ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5", DEVBOX, "true"],
        (err) => resolve(!err),
      );
    });
  }
  return result;
}

// [user@]host or an ssh-config alias. Kept strict so it is safe to interpolate.
const SSH_TOKEN = /^[A-Za-z0-9._@-]{1,128}$/;

function sshBaseArgs({ port, identity }) {
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

// Install the agent on a remote device the user already has SSH access to. We
// only take their SSH details; the whole install runs over that connection:
// push the agent files, then run install.sh on the device. Progress streams
// back line by line as chunked text.
function installAgent(opts, res) {
  cors(res);
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-cache",
  });
  const say = (line) => res.write(String(line).replace(/\r/g, ""));

  const target = String(opts.target || "").trim();
  if (!SSH_TOKEN.test(target)) {
    say("ERROR: invalid SSH target\n");
    return res.end();
  }
  const port = opts.port ? Number(opts.port) : 0;
  if (opts.port && (!Number.isInteger(port) || port < 1 || port > 65535)) {
    say("ERROR: invalid port\n");
    return res.end();
  }
  const identity = opts.identity ? String(opts.identity) : "";
  const devboxHost = opts.devboxHost ? String(opts.devboxHost) : "";
  if (devboxHost && !SSH_TOKEN.test(devboxHost)) {
    say("ERROR: invalid devbox host\n");
    return res.end();
  }
  const agentPort = Number.isInteger(Number(opts.agentPort)) ? Number(opts.agentPort) : 5190;
  const base = sshBaseArgs({ port, identity });

  const runSsh = (remoteCmd) =>
    new Promise((resolve) => {
      const p = spawn("ssh", [...base, target, remoteCmd]);
      p.stdout.on("data", (d) => say(d.toString()));
      p.stderr.on("data", (d) => say(d.toString()));
      p.on("error", (e) => {
        say(`ERROR: ${e.message}\n`);
        resolve(1);
      });
      p.on("close", (code) => resolve(code ?? 0));
    });

  (async () => {
    say(`==> Connecting to ${target} ...\n`);
    if ((await runSsh("echo pzza-ok")) !== 0) {
      say("ERROR: could not SSH in. Set up key-based access first (e.g. ssh-copy-id).\n");
      return res.end();
    }
    say("Connected.\n\n==> Transferring agent files ...\n");

    const files = [
      "server/index.js",
      "server/package.json",
      "mcp/server.js",
      "mcp/package.json",
      "install.sh",
    ];
    const tar = spawn("tar", ["czf", "-", "-C", REPO_ROOT, ...files]);
    const ssh = spawn("ssh", [
      ...base,
      target,
      "mkdir -p ~/pzza-console-agent && tar xzf - -C ~/pzza-console-agent",
    ]);
    tar.stderr.on("data", (d) => say(d.toString()));
    ssh.stderr.on("data", (d) => say(d.toString()));
    tar.stdout.pipe(ssh.stdin);
    const xfer = await new Promise((r) => ssh.on("close", (c) => r(c ?? 0)));
    if (xfer !== 0) {
      say("ERROR: file transfer failed.\n");
      return res.end();
    }
    say("Files in ~/pzza-console-agent\n\n==> Running installer on the device (may take a minute) ...\n");

    const envPrefix = `PORT=${agentPort} PZZA_DEVBOX_HOST='${devboxHost}'`;
    const code = await runSsh(
      `cd ~/pzza-console-agent && chmod +x install.sh && ${envPrefix} bash install.sh`,
    );
    if (code !== 0) {
      say(`\nERROR: installer exited with code ${code}\n`);
      return res.end();
    }
    say(`\n==> DONE - agent installed and started on ${target}.\n`);
    res.end();
  })();
}

// ---- Agent usage (Claude / Codex accounts on this device) -------------------
// Reads the same OAuth usage the official apps show, from locally-stored creds.
const USAGE_FRESH_MS = 5 * 60 * 1000; // the endpoints 429 if polled harder
let usageCache = { at: 0, data: null };

function jwtClaims(token) {
  try {
    const part = String(token).split(".")[1];
    const json = Buffer.from(part.replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8");
    return JSON.parse(json);
  } catch {
    return {};
  }
}

// Auto-discover Claude (~/.claude*) and Codex (~/.codex*) config dirs.
function discoverAccounts() {
  const home = os.homedir();
  const accounts = [];
  let entries = [];
  try {
    entries = fs.readdirSync(home, { withFileTypes: true });
  } catch {
    return accounts;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const name = e.name;
    const dir = path.join(home, name);
    if (name === ".claude" || name.startsWith(".claude-")) {
      if (fs.existsSync(path.join(dir, ".credentials.json")) || fs.existsSync(path.join(dir, "projects"))) {
        accounts.push({ provider: "claude", dir, label: name === ".claude" ? "Claude" : name.slice(1) });
      }
    } else if (name === ".codex" || name.startsWith(".codex-")) {
      if (fs.existsSync(path.join(dir, "auth.json"))) {
        accounts.push({ provider: "codex", dir, label: name === ".codex" ? "Codex" : name.slice(1) });
      }
    }
  }
  return accounts;
}

function readClaudeIdentity(dir) {
  const candidates = [`${dir}.json`, path.join(dir, ".claude.json"), path.join(os.homedir(), ".claude.json")];
  for (const f of candidates) {
    try {
      const oa = JSON.parse(fs.readFileSync(f, "utf8")).oauthAccount || {};
      if (oa.emailAddress) {
        return { email: oa.emailAddress, plan: oa.organizationType, tier: oa.userRateLimitTier };
      }
    } catch {
      /* try next */
    }
  }
  return {};
}

const winShape = (w) =>
  w && (w.utilization != null || w.used_percent != null)
    ? { utilization: Number(w.utilization ?? w.used_percent), resets_at: w.resets_at ?? null }
    : null;

async function fetchClaudeUsage(accessToken) {
  const res = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "anthropic-beta": "oauth-2025-04-20",
      "User-Agent": "pzza-code/1.0",
    },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`usage ${res.status}`);
  const j = await res.json();
  const scoped = (j.limits || [])
    .filter((l) => l.kind === "weekly_scoped")
    .map((l) => ({
      name: l.scope?.model?.display_name || "weekly",
      percent: Number(l.percent ?? l.utilization ?? 0),
      resets_at: l.resets_at ?? null,
    }));
  return { five_hour: winShape(j.five_hour), seven_day: winShape(j.seven_day), scoped };
}

function readCodexCreds(dir) {
  const auth = JSON.parse(fs.readFileSync(path.join(dir, "auth.json"), "utf8"));
  const tokens = auth.tokens || {};
  const claims = jwtClaims(tokens.access_token);
  const a = claims["https://api.openai.com/auth"] || {};
  const p = claims["https://api.openai.com/profile"] || {};
  return {
    accessToken: tokens.access_token,
    accountId: tokens.account_id || a.chatgpt_account_id,
    plan: a.chatgpt_plan_type,
    email: p.email,
  };
}

async function fetchCodexUsage(creds) {
  const headers = { Authorization: `Bearer ${creds.accessToken}`, "User-Agent": "pzza-code/1.0" };
  if (creds.accountId) headers["ChatGPT-Account-Id"] = creds.accountId;
  const res = await fetch("https://chatgpt.com/backend-api/wham/usage", {
    headers,
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`usage ${res.status}`);
  const j = await res.json();
  const rl = j.rate_limit || j;
  const iso = (unix) => (unix ? new Date(unix * 1000).toISOString() : null);
  let five_hour = null;
  let seven_day = null;
  for (const w of [rl.primary_window, rl.secondary_window].filter(Boolean)) {
    const entry = { utilization: Number(w.used_percent ?? 0), resets_at: iso(w.reset_at) };
    if ((w.limit_window_seconds || 0) <= 6 * 3600) five_hour = entry;
    else seven_day = entry;
  }
  const scoped = (rl.additional_rate_limits || []).map((w) => ({
    name: w.name || "limit",
    percent: Number(w.used_percent ?? 0),
    resets_at: iso(w.reset_at),
  }));
  return { five_hour, seven_day, scoped };
}

// The Claude / Codex accounts (config dirs) on this device, with identity only.
function listAccounts() {
  return discoverAccounts().map((acc) => {
    let email;
    let plan;
    try {
      if (acc.provider === "claude") {
        const id = readClaudeIdentity(acc.dir);
        email = id.email;
        plan = id.plan;
      } else {
        const c = readCodexCreds(acc.dir);
        email = c.email;
        plan = c.plan;
      }
    } catch {
      /* identity optional */
    }
    return { provider: acc.provider, label: acc.label, dir: acc.dir, email, plan };
  });
}

// Env var that points an agent CLI at a specific account's config dir.
function accountEnvArg(account) {
  if (!account || typeof account.dir !== "string") return "";
  const dir = path.resolve(account.dir);
  const home = os.homedir();
  if (!home || !dir.startsWith(home) || !fs.existsSync(dir)) return "";
  const key = account.provider === "codex" ? "CODEX_HOME" : "CLAUDE_CONFIG_DIR";
  return ` -e ${shQuote(`${key}=${dir}`)}`;
}

// ---- Estimated spend (from local Claude/Codex transcripts, ccusage-style) ----
// USD per million (input, output) tokens.
const PRICING = {
  "claude-fable-5": [10.0, 50.0],
  "claude-mythos-5": [10.0, 50.0],
  "claude-opus-5": [5.0, 25.0],
  "claude-opus-4-8": [5.0, 25.0],
  "claude-opus-4-7": [5.0, 25.0],
  "claude-opus-4-6": [5.0, 25.0],
  "claude-opus-4-5": [5.0, 25.0],
  "claude-sonnet-5": [3.0, 15.0],
  "claude-sonnet-4-6": [3.0, 15.0],
  "claude-sonnet-4-5": [3.0, 15.0],
  "claude-haiku-4-5": [1.0, 5.0],
  "gpt-5.6-sol": [4.0, 20.0],
  "gpt-5.6-terra": [2.0, 12.0],
  "gpt-5.6-luna": [0.2, 1.2],
  "gpt-5.5": [5.0, 30.0],
  "gpt-5.4": [2.5, 15.0],
  "gpt-5.4-mini": [0.75, 4.5],
  "gpt-5.4-nano": [0.2, 1.25],
  "gpt-5.3-codex": [1.75, 14.0],
  "gpt-5.2-codex": [1.75, 14.0],
  "gpt-5.2": [1.75, 14.0],
  "gpt-5.1-codex": [1.25, 10.0],
  "gpt-5.1-codex-mini": [0.25, 2.0],
  "gpt-5.1": [1.25, 10.0],
  "gpt-5-codex": [1.25, 10.0],
  "gpt-5": [1.25, 10.0],
  "gpt-5-mini": [0.25, 2.0],
  "gpt-5-nano": [0.05, 0.4],
};
const PROMO_PRICING = { "claude-sonnet-5": [[2.0, 10.0], "2026-08-31"] };
const CACHE_READ_RATE = 0.1;
const CACHE_WRITE_5M_RATE = 1.25;
const CACHE_WRITE_1H_RATE = 2.0;
const CODEX_COUNTERS = ["input_tokens", "cached_input_tokens", "output_tokens"];
const SPEND_WINDOW_DAYS = 30;
const SPEND_FRESH_MS = 10 * 60 * 1000;
let spendCache = { at: 0, data: null };

function modelRates(model, day) {
  const name = String(model || "").split("[")[0];
  const candidates = [name];
  const parts = name.split("-");
  if (parts.length >= 2 && /^\d{8}$/.test(parts[parts.length - 1])) {
    candidates.push(parts.slice(0, -1).join("-"));
  }
  for (const c of candidates) {
    const promo = PROMO_PRICING[c];
    if (promo && day <= promo[1]) return promo[0];
    if (PRICING[c]) return PRICING[c];
  }
  return null;
}

function bucketCost(b, model, day) {
  const rates = modelRates(model, day);
  if (!rates) return 0;
  const [ri, wo] = rates;
  return (
    (b[0] * ri +
      b[1] * wo +
      b[2] * ri * CACHE_READ_RATE +
      b[3] * ri * CACHE_WRITE_5M_RATE +
      b[4] * ri * CACHE_WRITE_1H_RATE) /
    1_000_000
  );
}

function walkJsonl(dir) {
  const out = [];
  const stack = [dir];
  while (stack.length) {
    let entries;
    try {
      entries = fs.readdirSync(stack.pop(), { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const p = path.join(e.parentPath || e.path || dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name.endsWith(".jsonl")) out.push(p);
    }
  }
  return out;
}

function transcriptFiles(provider, dir) {
  const roots = provider === "claude" ? ["projects"] : ["sessions", "archived_sessions"];
  const files = [];
  for (const r of roots) files.push(...walkJsonl(path.join(dir, r)));
  return files;
}

function recordDay(rec) {
  const d = new Date(rec.timestamp);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

function addBuckets(days, day, model, values) {
  const d = (days[day] = days[day] || {});
  const b = (d[model] = d[model] || [0, 0, 0, 0, 0]);
  for (let i = 0; i < values.length; i++) b[i] += values[i];
}

function parseClaudeSpend(file, seen, days) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  for (const line of text.split("\n")) {
    if (!line || !line.includes('"usage"')) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const msg = rec.message;
    if (!msg || typeof msg !== "object") continue;
    const usage = msg.usage;
    const model = msg.model;
    if (!usage || typeof usage !== "object" || !model || String(model).startsWith("<")) continue;
    const key = `${msg.id} ${rec.requestId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const day = recordDay(rec);
    if (!day) continue;
    const created = usage.cache_creation || {};
    let five = created.ephemeral_5m_input_tokens;
    const hour = created.ephemeral_1h_input_tokens;
    if (five == null && hour == null) five = usage.cache_creation_input_tokens;
    addBuckets(days, day, model, [
      usage.input_tokens || 0,
      usage.output_tokens || 0,
      usage.cache_read_input_tokens || 0,
      five || 0,
      hour || 0,
    ]);
  }
}

function parseCodexSpend(file, days) {
  let text;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return;
  }
  let model = null;
  let previous = null;
  for (const line of text.split("\n")) {
    if (!line || (!line.includes('"turn_context"') && !line.includes('"token_count"'))) continue;
    let rec;
    try {
      rec = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = rec.payload;
    if (!payload || typeof payload !== "object") continue;
    if (rec.type === "turn_context") {
      if (typeof payload.model === "string") model = payload.model;
      continue;
    }
    if (rec.type !== "event_msg" || payload.type !== "token_count") continue;
    const total = (payload.info || {}).total_token_usage;
    if (!total || typeof total !== "object") continue;
    const current = CODEX_COUNTERS.map((n) => Number(total[n] || 0));
    const delta =
      previous === null || current.some((now, i) => now < previous[i])
        ? current
        : current.map((now, i) => now - previous[i]);
    previous = current;
    const day = recordDay(rec);
    if (!model || !day || !delta.some((x) => x)) continue;
    const cached = Math.min(delta[1], delta[0]);
    addBuckets(days, day, model, [delta[0] - cached, delta[2], cached, 0, 0]);
  }
}

let spendScan = null;

function computeSpend() {
  const now = Date.now();
  if (spendCache.data && now - spendCache.at < SPEND_FRESH_MS) return Promise.resolve(spendCache.data);
  if (spendScan) return spendScan; // a scan is already running - share it
  spendScan = scanSpend(now).finally(() => {
    spendScan = null;
  });
  return spendScan;
}

// The transcripts can be big; yield to the event loop between files so scanning
// never freezes the terminals/WS for the whole (multi-second) pass.
async function scanSpend(now) {
  const dayStr = (ms) => {
    const d = new Date(ms);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  };
  const dayToday = dayStr(now);
  const dayYesterday = dayStr(now - 86400000);
  const horizon = now - SPEND_WINDOW_DAYS * 86400000;

  const data = [];
  for (const acc of discoverAccounts()) {
    const days = {};
    const seen = new Set();
    for (const file of transcriptFiles(acc.provider, acc.dir)) {
      let st;
      try {
        st = fs.statSync(file);
      } catch {
        continue;
      }
      if (st.mtimeMs < horizon) continue; // too old to touch the 30-day window
      if (acc.provider === "claude") parseClaudeSpend(file, seen, days);
      else parseCodexSpend(file, days);
      await new Promise((r) => setImmediate(r)); // let the event loop breathe
    }
    const win = { today: [0, 0], yesterday: [0, 0], window: [0, 0] };
    for (const [day, models] of Object.entries(days)) {
      const inWindow = new Date(`${day}T00:00:00`).getTime() >= horizon;
      for (const [model, buckets] of Object.entries(models)) {
        const cost = bucketCost(buckets, model, day);
        const tokens = buckets.reduce((a, b) => a + b, 0);
        if (day === dayToday) {
          win.today[0] += cost;
          win.today[1] += tokens;
        }
        if (day === dayYesterday) {
          win.yesterday[0] += cost;
          win.yesterday[1] += tokens;
        }
        if (inWindow) {
          win.window[0] += cost;
          win.window[1] += tokens;
        }
      }
    }
    data.push({
      provider: acc.provider,
      label: acc.label,
      today: { cost: win.today[0], tokens: win.today[1] },
      yesterday: { cost: win.yesterday[0], tokens: win.yesterday[1] },
      window: { cost: win.window[0], tokens: win.window[1] },
    });
  }
  spendCache = { at: now, data };
  return data;
}

async function collectUsage() {
  const now = Date.now();
  if (usageCache.data && now - usageCache.at < USAGE_FRESH_MS) return usageCache.data;
  const accounts = discoverAccounts();
  const data = await Promise.all(
    accounts.map(async (acc) => {
      try {
        if (acc.provider === "claude") {
          const oauth =
            JSON.parse(fs.readFileSync(path.join(acc.dir, ".credentials.json"), "utf8")).claudeAiOauth || {};
          if (!oauth.accessToken) throw new Error("not logged in");
          const identity = readClaudeIdentity(acc.dir);
          const usage = await fetchClaudeUsage(oauth.accessToken);
          return { provider: "claude", label: acc.label, ...identity, usage, error: null };
        }
        const creds = readCodexCreds(acc.dir);
        if (!creds.accessToken) throw new Error("not logged in");
        const usage = await fetchCodexUsage(creds);
        return { provider: "codex", label: acc.label, email: creds.email, plan: creds.plan, usage, error: null };
      } catch (e) {
        return { provider: acc.provider, label: acc.label, usage: null, error: String(e.message || e) };
      }
    }),
  );
  usageCache = { at: now, data };
  return data;
}

// Resolve a client-supplied path, restricted to the user's home tree so the
// code view can never read or write outside it.
function safePath(p) {
  if (typeof p !== "string" || !p) return null;
  const resolved = path.resolve(p);
  const home = os.homedir();
  if (!home || (resolved !== home && !resolved.startsWith(home + path.sep))) return null;
  return resolved;
}

const MIME = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".bmp": "image/bmp",
  ".ico": "image/x-icon",
  ".svg": "image/svg+xml",
  ".pdf": "application/pdf",
};
function mimeType(p) {
  return MIME[path.extname(p).toLowerCase()] || "application/octet-stream";
}

// Auto-discover SSH targets from ~/.ssh/config (named, non-wildcard hosts) and
// the private-key identity files in ~/.ssh, so the Add-a-device wizard can offer
// them instead of making the user type everything by hand.
function sshHosts() {
  const sshDir = path.join(os.homedir(), ".ssh");
  const hosts = [];
  try {
    const cfg = fs.readFileSync(path.join(sshDir, "config"), "utf8");
    let cur = null;
    for (const raw of cfg.split("\n")) {
      const line = raw.trim();
      if (!line || line.startsWith("#")) continue;
      const m = line.match(/^(\S+)\s+(.+?)\s*$/);
      if (!m) continue;
      const key = m[1].toLowerCase();
      const val = m[2].trim();
      if (key === "host") {
        const pat = val.split(/\s+/).find((p) => !p.includes("*") && !p.includes("?"));
        // Skip a wildcard-only block, and collapse repeated Host blocks with the
        // same alias onto the first one so the wizard shows each target once.
        if (!pat) {
          cur = null;
        } else {
          cur = hosts.find((h) => h.host === pat);
          if (!cur) {
            cur = { host: pat };
            hosts.push(cur);
          }
        }
      } else if (cur) {
        if (key === "hostname") cur.hostname = val;
        else if (key === "user") cur.user = val;
        else if (key === "port" && Number(val)) cur.port = Number(val);
        else if (key === "identityfile") cur.identity = val;
      }
    }
  } catch {
    /* no ssh config */
  }
  const identities = [];
  try {
    const skip = new Set(["config", "known_hosts", "known_hosts_old", "authorized_keys"]);
    for (const name of fs.readdirSync(sshDir).sort()) {
      if (name.endsWith(".pub") || skip.has(name) || name.startsWith(".")) continue;
      const full = path.join(sshDir, name);
      try {
        if (!fs.statSync(full).isFile()) continue;
        const head = fs.readFileSync(full, "utf8").slice(0, 40);
        if (head.includes("PRIVATE KEY") || fs.existsSync(`${full}.pub`) || /^id_/.test(name)) {
          identities.push(full);
        }
      } catch {
        /* unreadable - skip */
      }
    }
  } catch {
    /* no ssh dir */
  }
  return { dir: sshDir, hosts, identities };
}

const server = http.createServer(async (req, res) => {
  if (req.method === "OPTIONS") {
    cors(res);
    res.writeHead(204);
    return res.end();
  }
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/capabilities") {
    return json(res, 200, {
      role: IS_CLIENT ? "client" : "source",
      forward: IS_CLIENT,
      host: DEVBOX || null,
    });
  }
  if (url.pathname === "/doctor") {
    return json(res, 200, await doctor());
  }
  if (url.pathname === "/usage") {
    return json(res, 200, await collectUsage());
  }
  if (url.pathname === "/accounts") {
    return json(res, 200, listAccounts());
  }
  if (url.pathname === "/spend") {
    return json(res, 200, await computeSpend());
  }
  if (url.pathname === "/file/read") {
    const p = safePath(url.searchParams.get("path"));
    if (!p) return json(res, 400, { error: "invalid path" });
    try {
      const st = fs.statSync(p);
      if (!st.isFile()) return json(res, 400, { error: "not a file" });
      if (st.size > 2 * 1024 * 1024) return json(res, 200, { path: p, content: "", tooLarge: true });
      return json(res, 200, { path: p, content: fs.readFileSync(p, "utf8") });
    } catch (e) {
      return json(res, 404, { error: String(e.message || e) });
    }
  }
  if (url.pathname === "/file/write" && req.method === "POST") {
    const body = await readBody(req);
    const p = safePath(body.path);
    if (!p) return json(res, 400, { error: "invalid path" });
    try {
      fs.writeFileSync(p, String(body.content ?? ""));
      return json(res, 200, { ok: true });
    } catch (e) {
      return json(res, 500, { error: String(e.message || e) });
    }
  }
  // Stream a file's raw bytes with its media type, so the code view can preview
  // images and PDFs instead of loading them as text.
  if (url.pathname === "/file/raw") {
    const p = safePath(url.searchParams.get("path"));
    if (!p) return json(res, 400, { error: "invalid path" });
    let st;
    try {
      st = fs.statSync(p);
    } catch (e) {
      return json(res, 404, { error: String(e.message || e) });
    }
    if (!st.isFile()) return json(res, 400, { error: "not a file" });
    if (st.size > 50 * 1024 * 1024) return json(res, 413, { error: "file too large" });
    cors(res);
    res.writeHead(200, {
      "Content-Type": mimeType(p),
      "Content-Length": st.size,
      "Cache-Control": "no-store",
    });
    fs.createReadStream(p)
      .on("error", () => res.destroyed || res.end())
      .pipe(res);
    return;
  }
  if (url.pathname === "/fs/list") {
    const p = safePath(url.searchParams.get("path")) || os.homedir();
    try {
      const entries = fs
        .readdirSync(p, { withFileTypes: true })
        .map((e) => ({ name: e.name, dir: e.isDirectory() }))
        .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1));
      return json(res, 200, { path: p, parent: path.dirname(p), entries });
    } catch (e) {
      return json(res, 404, { error: String(e.message || e) });
    }
  }
  if (url.pathname === "/agent/install" && req.method === "POST") {
    const body = await readBody(req);
    return installAgent(body, res);
  }
  if (url.pathname === "/sessions") return json(res, 200, await listSessions());
  // Live current directory of a session's active pane, so the code editor can
  // root at wherever the terminal actually is right now (a fresh session, or one
  // that has cd'd since the last scan).
  if (url.pathname === "/session/path") {
    const name = String(url.searchParams.get("name") || "").trim();
    if (!name) return json(res, 400, { error: "name required" });
    const win = url.searchParams.get("window");
    const target = win !== null && win !== "" ? `${name}:${win}` : name;
    const host = SSH_TOKEN.test(url.searchParams.get("host") || "")
      ? url.searchParams.get("host")
      : "";
    const cmd = `tmux display-message -p -t ${shQuote(target)} '#{pane_current_path}'`;
    const out = await new Promise((resolve) =>
      shOn(host, cmd, (err, o) => resolve(err ? "" : String(o || "").trim())),
    );
    return json(res, 200, { path: out });
  }
  if (url.pathname === "/scan") {
    const host = SSH_TOKEN.test(url.searchParams.get("host") || "")
      ? url.searchParams.get("host")
      : "";
    return json(res, 200, await scanSessions(host));
  }
  if (url.pathname === "/ssh/hosts") return json(res, 200, sshHosts());
  if (url.pathname === "/windows") return json(res, 200, await listWindows());
  if (url.pathname === "/ports") return json(res, 200, await listPorts());
  if (url.pathname === "/health") return json(res, 200, { ok: true });

  if (url.pathname === "/forward/status") {
    return json(res, 200, {
      enabled: fwdEnabled,
      active: [...active].sort((a, b) => a - b),
    });
  }
  if (url.pathname === "/paste-image" && req.method === "POST") {
    const buf = await readRawBody(req);
    if (!buf.length) return json(res, 400, { error: "empty" });
    const ct = String(req.headers["content-type"] || "image/png");
    const ext = ct.includes("jpeg") || ct.includes("jpg")
      ? "jpg"
      : ct.includes("gif")
        ? "gif"
        : ct.includes("webp")
          ? "webp"
          : "png";
    const file = `/tmp/pzza-paste-${Date.now().toString(36)}.${ext}`;
    return saveImage(file, buf, (err) =>
      err ? json(res, 500, { error: String(err.message || err) }) : json(res, 200, { path: file }),
    );
  }
  if (url.pathname === "/kill" && req.method === "POST") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (name) {
      const hasWin = body.window !== undefined && body.window !== null;
      const cmd = hasWin
        ? `tmux kill-window -t ${shQuote(name + ":" + body.window)}`
        : `tmux kill-session -t ${shQuote(name)}`;
      const host = SSH_TOKEN.test(String(body.host || "")) ? String(body.host) : "";
      shOn(host, cmd, () => {});
    }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/forward/toggle" && req.method === "POST") {
    const body = await readBody(req);
    fwdEnabled = body.enabled !== false;
    reconcile();
    return json(res, 200, { enabled: fwdEnabled });
  }
  if (url.pathname === "/create" && req.method === "POST") {
    const body = await readBody(req);
    const name = String(body.name || "").trim();
    if (name) {
      const cwd = body.cwd ? ` -c ${shQuote(body.cwd)}` : "";
      const env = accountEnvArg(body.account); // binds a Claude/Codex account
      sh(`tmux new-session -d -s ${shQuote(name)}${cwd}${env}`, () => {});
    }
    return json(res, 200, { ok: true });
  }
  if (url.pathname === "/mcp/config") {
    return json(res, 200, { path: MCP_PATH, ...mcpConfigs(MCP_PATH) });
  }
  if (url.pathname === "/mcp/install" && req.method === "POST") {
    const body = await readBody(req);
    return json(res, 200, await mcpInstall(String(body.framework || ""), MCP_PATH));
  }

  json(res, 404, { error: "not found" });
});

// WebSocket PTY: attaches to a tmux session. On a receiver the tmux server is on
// the devbox, so the client is ssh; on the source it runs tmux directly. ws and
// node-pty are optional: if they are not installed the agent runs without the
// WebSocket terminal (the app uses the Rust PTY instead), so the import failure
// is logged and swallowed rather than crashing the whole agent.
async function startPtyBridge() {
  let WebSocketServer;
  let pty;
  try {
    ({ WebSocketServer } = await import("ws"));
    pty = (await import("node-pty")).default;
  } catch (e) {
    console.warn(`PzzaCode agent: WebSocket PTY disabled (${e?.message || e}).`);
    return;
  }
  const wss = new WebSocketServer({ server, path: "/pty" });

  wss.on("connection", (ws) => {
  let term = null;
  let viewSession = null; // grouped view session to clean up on close

  ws.on("message", (raw, isBinary) => {
    if (isBinary) return;
    let msg;
    try {
      msg = JSON.parse(raw.toString());
    } catch {
      return;
    }

    if (msg.type === "attach" && !term) {
      const name = String(msg.name || "").trim();
      if (!name || name === "undefined") {
        ws.close();
        return;
      }
      const cols = msg.cols || 80;
      const rows = msg.rows || 24;

      const hasWin = msg.window !== undefined && msg.window !== null;
      let attach;
      if (hasWin) {
        // A specific window: view it through a grouped session so it can show a
        // different window than other clients. Cleaned up explicitly on close
        // (destroy-unattached would kill it before we manage to attach).
        const view = `pzza-v-${Date.now().toString(36)}-${Math.floor(Math.random() * 46656).toString(36)}`;
        viewSession = view;
        attach =
          `tmux new-session -d -t ${shQuote(name)} -s ${shQuote(view)} 2>/dev/null; ` +
          `tmux set-option -t ${shQuote(view)} window-size latest 2>/dev/null; ` +
          `tmux select-window -t ${shQuote(view + ":" + msg.window)} 2>/dev/null; ` +
          `exec tmux attach -t ${shQuote(view)}`;
      } else {
        // Never shrink a session another client (cmux) is viewing.
        const prep = `tmux set-option -t ${shQuote(name)} window-size latest 2>/dev/null; tmux set-option -t ${shQuote(name)} aggressive-resize on 2>/dev/null`;
        attach = `${prep}; exec tmux new-session -A -s ${shQuote(name)}${
          msg.cwd ? ` -c ${shQuote(msg.cwd)}` : ""
        }`;
      }

      // Advertise truecolor so apps inside tmux (yazi, ratatui TUIs) emit 24-bit
      // colors instead of quantizing to 256 and washing out.
      const ptyEnv = { ...process.env, COLORTERM: "truecolor" };
      if (IS_CLIENT) {
        term = pty.spawn("ssh", ["-tt", DEVBOX, `sh -lc ${shQuote(attach)}`], {
          name: "xterm-256color",
          cols,
          rows,
          env: ptyEnv,
        });
      } else {
        term = pty.spawn("sh", ["-lc", attach], {
          name: "xterm-256color",
          cols,
          rows,
          cwd: process.env.HOME,
          env: ptyEnv,
        });
      }

      term.onData((d) => {
        if (ws.readyState === ws.OPEN) ws.send(Buffer.from(d, "utf8"));
      });
      term.onExit(() => {
        if (ws.readyState === ws.OPEN) ws.close();
      });
    } else if (msg.type === "input" && term) {
      term.write(msg.data);
    } else if (msg.type === "resize" && term) {
      term.resize(msg.cols || 80, msg.rows || 24);
    }
  });

  ws.on("close", () => {
    if (term) {
      try {
        term.kill();
      } catch {
        /* gone */
      }
      term = null;
    }
    if (viewSession) {
      sh(`tmux kill-session -t ${shQuote(viewSession)} 2>/dev/null`, () => {});
      viewSession = null;
    }
  });
  });
}

// Clean up leftover internal window-view sessions that are no longer attached.
function sweepOrphanViews() {
  sh("tmux list-sessions -F '#{session_name} #{session_attached}' 2>/dev/null", (err, out) => {
    if (err) return;
    for (const line of String(out || "").split("\n")) {
      const [name, attached] = line.split(" ");
      if (name && name.startsWith("pzza-v-") && attached === "0") {
        sh(`tmux kill-session -t ${shQuote(name)} 2>/dev/null`, () => {});
      }
    }
  });
}

server.listen(PORT, "127.0.0.1", () => {
  console.log(
    `PzzaCode agent on 127.0.0.1:${PORT} · role=${IS_CLIENT ? `client (ssh ${DEVBOX})` : "source"}`,
  );
  sweepOrphanViews();
  startPtyBridge();
});
