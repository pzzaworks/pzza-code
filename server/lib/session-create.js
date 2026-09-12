import { execFile } from "node:child_process";
import { SSH_TOKEN, shQuote, deviceEnv } from "./shell.js";
import { tmuxArgs } from "./tmux-client.js";
import { normalizeSessionName } from "./session-name.js";

export const SESSION_CREATE_TARGET = String.raw`
import json, os, re, stat, subprocess, sys
request = json.load(sys.stdin)
def fail(message, status=400):
    json.dump({'error': message, 'status': status}, sys.stdout)
    sys.exit(0)
args = ['tmux', *request['tmuxOptions'], 'new-session', '-d', '-s', request['name']]
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
try:
    result = subprocess.run(args, stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=8)
    if result.returncode != 0:
        fail('Could not create the session. Check the terminal service and choose an unused name.', 503)
except (OSError, subprocess.TimeoutExpired):
    fail('The terminal service is unavailable on the selected device.', 503)
json.dump({'ok': True}, sys.stdout)
`;

export async function createDeviceSession(body, run = execFile) {
  const invalid = message => Promise.reject(Object.assign(new Error(message), { status: 400 }));
  if (!body || typeof body !== "object" || Array.isArray(body) || Object.keys(body).some(key => !["name", "cwd", "account", "host"].includes(key))) return invalid("Invalid session request.");
  let name;
  try { name = normalizeSessionName(body.name); } catch (error) { return invalid(error.message); }
  if (body.host !== undefined && (typeof body.host !== "string" || (body.host && !SSH_TOKEN.test(body.host)))) return invalid("Invalid session device.");
  if (body.cwd !== undefined && (typeof body.cwd !== "string" || body.cwd.length > 4096 || /[\x00-\x1f\x7f]/.test(body.cwd) || (body.cwd && !body.cwd.startsWith("/") && body.cwd !== "~" && !body.cwd.startsWith("~/")))) return invalid("Choose an absolute or home-relative working directory.");
  if (body.account !== undefined && (!body.account || typeof body.account !== "object" || Array.isArray(body.account) || Object.keys(body.account).some(key => !["provider", "dir"].includes(key)) || !["claude", "codex"].includes(body.account.provider) || typeof body.account.dir !== "string" || !body.account.dir.startsWith("/") || body.account.dir.length > 4096 || /[\x00-\x1f\x7f]/.test(body.account.dir))) return invalid("Choose a supported provider and its absolute account directory.");
  const host = body.host ?? "";
  const tmuxOptions = host ? [] : tmuxArgs([]);
  const args = host ? ["-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=3", "-o", "ConnectionAttempts=1", "-o", "StrictHostKeyChecking=yes", "-o", "ForwardAgent=no", "-o", "PermitLocalCommand=no", "--", host, `python3 -c ${shQuote(SESSION_CREATE_TARGET)}`] : ["-c", SESSION_CREATE_TARGET];
  return new Promise((resolve, reject) => {
    const child = run(host ? "ssh" : "python3", args, { timeout: 14000, maxBuffer: 16384, env: deviceEnv(host) }, (error, output) => {
      if (error) return reject(Object.assign(new Error("Cannot reach the selected device. Trusted SSH, Python 3 and tmux are required."), { status: 503 }));
      let result;
      try { result = JSON.parse(output); } catch { return reject(Object.assign(new Error("Invalid session creation response."), { status: 502 })); }
      if (!result || typeof result !== "object" || Array.isArray(result)) return reject(Object.assign(new Error("Invalid session creation response."), { status: 502 }));
      if (result.ok !== true) return reject(Object.assign(new Error(result.status === 400 ? result.error : "Could not create the session on this device. Check the terminal service and choose an unused name."), { status: result.status === 400 ? 400 : 503 }));
      resolve({ ok: true, host, name });
    });
    child.stdin?.on("error", () => {});
    child.stdin?.end(JSON.stringify({ name, cwd: body.cwd, account: body.account, tmuxOptions }));
  });
}
