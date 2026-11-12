import { execFile } from "node:child_process";
import { SSH_TOKEN, shQuote, deviceEnv } from "./shell.js";
import { tmuxArgs } from "./tmux-client.js";
import { normalizeSessionName } from "./session-name.js";
import { sessionAgentCommand } from "./session-agents.js";
import {
  COPY_SETUP_SCRIPT, DEFAULT_COPY_PATTERNS, MAIN_CONFIG_SH, WORKTREE_SETUP_LIMITS,
  parseCopyOutput, readSetupSections, scriptSections, setupApproved, setupCommandLine,
} from "./worktree-setup.js";
import { validBranchName } from "./worktree-land.js";

export const SESSION_CREATE_TARGET = String.raw`
import json, os, re, stat, subprocess, sys
request = json.load(sys.stdin)
def fail(message, status=400):
    json.dump({'error': message, 'status': status}, sys.stdout)
    sys.exit(0)
args = ['tmux', *request['tmuxOptions'], 'new-session', '-d', '-P', '-F', '#{session_id}:#{window_id}', '-s', request['name'], '-e', 'OPENTUI_NOTIFICATION_PROTOCOL=osc777']
cwd = os.path.expanduser(request.get('cwd') or '~')
if not os.path.isabs(cwd) or not os.path.isdir(cwd):
    fail('Choose an existing absolute working directory on the selected device.')
args += ['-c', cwd]
account = request.get('account')
if account:
    home = os.path.realpath(os.path.expanduser('~'))
    directory = os.path.expanduser(account['dir'])
    try:
        metadata = os.lstat(directory)
        canonical = os.path.realpath(directory)
        name = os.path.basename(canonical)
        provider = account['provider']
        if not stat.S_ISDIR(metadata.st_mode) or metadata.st_uid != os.getuid() or os.path.dirname(canonical) != home:
            fail('Choose an existing account owned by the selected device user.')
        if not re.fullmatch(r'\.' + provider + r'(?:-[^/]+)?', name):
            fail('Account directory does not match the selected provider.')
        available = os.path.isfile(os.path.join(canonical, 'auth.json')) if provider == 'codex' else (os.path.isfile(os.path.join(canonical, '.credentials.json')) or os.path.isdir(os.path.join(canonical, 'projects')))
        if not available:
            fail('The selected account is not configured on this device.')
        key = 'CODEX_HOME' if provider == 'codex' else 'CLAUDE_CONFIG_DIR'
        args += ['-e', key + '=' + canonical]
    except OSError:
        fail('The selected account is unavailable on this device.')
created_session = None
try:
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.DEVNULL, text=True, timeout=8)
    if result.returncode != 0:
        fail('Could not create the session. Check the terminal service and choose an unused name.', 503)
    identity = re.fullmatch(r'(\$[0-9]+):(@[0-9]+)', result.stdout.strip())
    if not identity:
        fail('Invalid terminal session response.', 503)
    created_session, window = identity.groups()
    # Native notifications pass through only the newly created terminal window.
    subprocess.run(['tmux', *request['tmuxOptions'], 'set-option', '-w', '-t', window, 'allow-passthrough', 'on'], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=3, check=True)
except (OSError, subprocess.TimeoutExpired, subprocess.CalledProcessError):
    if created_session:
        try:
            subprocess.run(['tmux', *request['tmuxOptions'], 'kill-session', '-t', created_session], stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=2)
        except (OSError, subprocess.TimeoutExpired):
            pass
    fail('The terminal service is unavailable on the selected device.', 503)
json.dump({'ok': True}, sys.stdout)
`;

// Types the agent's command into the new session's shell and presses Enter.
// tmux buffers the keys until the login shell reads them, so the agent starts in
// the session's working directory with the user's own PATH and environment, and
// the shell stays open there after the agent exits.
function startSessionAgent(host, name, command, tmuxOptions, run) {
  const target = `=${name}:`;
  const tmux = [...tmuxOptions, "send-keys", "-t", target, "-l", command, ";", "send-keys", "-t", target, "Enter"];
  const [file, args] = host
    ? ["ssh", [...SSH_OPTIONS, host, ["tmux", "-u", ...tmux].map(shQuote).join(" ")]]
    : ["tmux", tmux];
  return new Promise(resolve => {
    run(file, args, { timeout: 8000, maxBuffer: 16384, env: deviceEnv(host) }, error => resolve(!error));
  });
}

const SSH_OPTIONS = ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "--"];

// Gives a session its own git worktree next to the repository
// (<repo>.worktrees/<slug>) on a new branch pzza/<slug>, so parallel agents in
// one repository never edit the same checkout. Paths and the slug are
// positional arguments, never part of the script text. An optional third
// argument names a local base branch to start from (refs/heads/ is spelled
// out so a tag of the same name never wins); it is recorded as
// branch.pzza/<slug>.pzzabase, which pull requests and merges then target.
// After the path it prints the main checkout and its worktree setup file (see
// worktree-setup.js).
export const WORKTREE_SCRIPT = String.raw`top=$(git -C "$1" rev-parse --show-toplevel 2>/dev/null) || exit 3
dir="$(dirname "$top")/$(basename "$top").worktrees/$2"
[ -e "$dir" ] && exit 4
if [ -n "$3" ]; then
  git -C "$top" show-ref --verify -q "refs/heads/$3" 2>/dev/null || exit 6
  git -C "$top" worktree add -q -b "pzza/$2" "$dir" "refs/heads/$3" >/dev/null 2>&1 || exit 5
  git -C "$top" config "branch.pzza/$2.pzzabase" "$3" >/dev/null 2>&1
else
  git -C "$top" worktree add -q -b "pzza/$2" "$dir" >/dev/null 2>&1 || exit 5
fi
printf '%s\n' "$dir"
` + MAIN_CONFIG_SH;

export function worktreeSlug(name) {
  return name.toLowerCase().replace(/\s+/g, "-").replace(/[^a-z0-9_-]/g, "").replace(/^-+|-+$/g, "").slice(0, 60);
}

function createWorktree(host, cwd, slug, base, run) {
  const scriptArgs = [cwd, slug, ...(base ? [base] : [])];
  const [file, args] = host
    ? ["ssh", [...SSH_OPTIONS, host, ["sh", "-c", WORKTREE_SCRIPT, "pzza-worktree", ...scriptArgs].map(shQuote).join(" ")]]
    : ["/bin/sh", ["-c", WORKTREE_SCRIPT, "pzza-worktree", ...scriptArgs]];
  const failures = {
    3: ["The chosen folder is not inside a git repository.", 400],
    4: ["A worktree for this session name already exists. Choose another name.", 400],
    5: [`git could not create the worktree. The branch pzza/${slug} may already exist.`, 400],
    6: [`The base branch ${base} does not exist in this repository.`, 400],
  };
  return new Promise((resolve, reject) => {
    run(file, args, { timeout: 20000, maxBuffer: WORKTREE_SETUP_LIMITS.configBytes + 16384, env: deviceEnv(host) }, (error, output) => {
      const [message, status] = error ? failures[error.code] ?? ["Cannot reach the selected device to create the worktree.", 503] : [];
      if (message) return reject(Object.assign(new Error(message), { status }));
      const text = String(output);
      const records = text.indexOf("\u001e");
      const dir = (records < 0 ? text : text.slice(0, records)).trim();
      if (!dir.startsWith("/") || dir.length > 4096 || /[\x00-\x1f\x7f]/.test(dir)) return reject(Object.assign(new Error("Invalid worktree response."), { status: 502 }));
      // Without the main checkout there is nothing to set up from.
      resolve({ dir, setup: records < 0 ? null : readSetupSections(scriptSections(text.slice(records))) });
    });
  });
}

// Copies the configured files from the main checkout into the new worktree
// and decides which setup commands may run. Never rejects: the worktree
// already exists, so a setup problem is reported with the session instead.
async function prepareWorktree(host, dir, setup, run, approvals) {
  if (!setup) return null;
  if (!setup.config) return { copied: [], skipped: [], run: [], unapproved: false, error: setup.error };
  const { copy, run: commands } = setup.config;
  const patterns = copy ?? DEFAULT_COPY_PATTERNS;
  let copied = { copied: [], skipped: [] }, error = null;
  if (patterns.length) {
    const scriptArgs = [setup.main, dir, copy === null ? "ignored" : "untracked", ...patterns];
    const [file, args] = host
      ? ["ssh", [...SSH_OPTIONS, host, ["sh", "-c", COPY_SETUP_SCRIPT, "pzza-worktree-setup", ...scriptArgs].map(shQuote).join(" ")]]
      : ["/bin/sh", ["-c", COPY_SETUP_SCRIPT, "pzza-worktree-setup", ...scriptArgs]];
    copied = await new Promise(resolve => {
      run(file, args, { timeout: WORKTREE_SETUP_LIMITS.copyMs, maxBuffer: WORKTREE_SETUP_LIMITS.buffer, env: deviceEnv(host) }, (failure, output) => {
        if (failure) { error = "Could not copy the setup files into the worktree."; resolve({ copied: [], skipped: [] }); }
        else resolve(parseCopyOutput(String(output)));
      });
    });
  }
  const approved = await setupApproved(host, setup.main, commands, approvals).catch(() => false);
  return { copied: copied.copied, skipped: copied.skipped, run: approved ? commands : [], unapproved: !approved, error };
}

export async function createDeviceSession(body, run = execFile, approvals = {}) {
  const invalid = message => Promise.reject(Object.assign(new Error(message), { status: 400 }));
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["name", "cwd", "account", "host", "agent", "worktree", "base"].includes(key))) return invalid("Invalid session request.");
  if (body.worktree !== undefined && typeof body.worktree !== "boolean") return invalid("Invalid worktree choice.");
  if (body.base !== undefined && (body.worktree !== true || !validBranchName(body.base))) return invalid("Choose an existing local branch as the base of a new worktree.");
  if (body.worktree && (typeof body.cwd !== "string" || !body.cwd.startsWith("/"))) return invalid("Choose a folder inside a git repository to create a worktree.");
  let name;
  try { name = normalizeSessionName(body.name); } catch (error) { return invalid(error.message); }
  let agentCommand;
  if (body.agent !== undefined) {
    try { agentCommand = sessionAgentCommand(body.agent); } catch (error) { return invalid(error.message); }
  }
  if (body.host !== undefined && (typeof body.host !== "string" || (body.host && !SSH_TOKEN.test(body.host)))) return invalid("Invalid session device.");
  if (body.cwd !== undefined && (typeof body.cwd !== "string" || body.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(body.cwd) || (body.cwd && !body.cwd.startsWith("/") && body.cwd !== "~" && !body.cwd.startsWith("~/")))) return invalid("Choose an absolute or home-relative working directory.");
  if (body.account !== undefined && (!body.account || typeof body.account !== "object" || Array.isArray(body.account) || Object.keys(body.account).some(key => !["provider", "dir"].includes(key)) || !["claude", "codex"].includes(body.account.provider) || typeof body.account.dir !== "string" || !body.account.dir.startsWith("/") || body.account.dir.length > 4096 || /[\x00-\x1f\x7f]/.test(body.account.dir))) return invalid("Choose a supported provider and its absolute account directory.");
  const host = body.host ?? "";
  const slug = body.worktree ? worktreeSlug(name) : "";
  if (body.worktree && !slug) return invalid("Use letters or numbers in the session name to name its worktree.");
  const worktree = body.worktree ? await createWorktree(host, body.cwd, slug, body.base, run) : null;
  const cwd = worktree ? worktree.dir : body.cwd;
  const setup = worktree ? await prepareWorktree(host, worktree.dir, worktree.setup, run, approvals) : null;
  // Approved setup commands run first, in the terminal, and the agent after them.
  const startCommand = setup?.run.length ? setupCommandLine(setup.run, agentCommand) : agentCommand;
  const tmuxOptions = host ? [] : tmuxArgs([]);
  const args = host ? [...SSH_OPTIONS, host, `python3 -c ${shQuote(SESSION_CREATE_TARGET)}`] : ["-c", SESSION_CREATE_TARGET];
  const created = worktree ? { ok: true, host, name, cwd, ...(setup ? { setup } : {}) } : { ok: true, host, name };
  return new Promise((resolve, reject) => {
    const child = run(host ? "ssh" : "python3", args, { timeout: 14000, maxBuffer: 16384, env: deviceEnv(host) }, (error, output) => {
      if (error) return reject(Object.assign(new Error("Cannot reach the selected device. Trusted SSH, Python 3 and tmux are required."), { status: 503 }));
      let result;
      try { result = JSON.parse(output); } catch { return reject(Object.assign(new Error("Invalid session creation response."), { status: 502 })); }
      if (!result || typeof result !== "object" || Array.isArray(result)) return reject(Object.assign(new Error("Invalid session creation response."), { status: 502 }));
      if (result.ok !== true) return reject(Object.assign(new Error(result.status === 400 ? result.error : "Could not create the session on this device. Check the terminal service and choose an unused name."), { status: result.status === 400 ? 400 : 503 }));
      if (!startCommand) return resolve(created);
      // The session already exists, so a failed launch is reported, not thrown.
      void startSessionAgent(host, name, startCommand, tmuxOptions, run).then(started => resolve({
        ...created, ...(agentCommand ? { agentStarted: started } : {}), ...(setup?.run.length ? { setupStarted: started } : {}),
      }));
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ name, cwd, account: body.account, tmuxOptions }));
  });
}
