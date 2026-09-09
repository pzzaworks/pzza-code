export const MCP_REPAIR_TARGET = String.raw`
import copy, glob, hashlib, json, os, re, shlex, stat, sys, tempfile
try:
    import tomllib
except ImportError:
    tomllib = None

request = json.load(sys.stdin)
home = os.path.realpath(os.path.expanduser('~'))
results = []
apply = request.get('apply') is True

def trusted_directory(directory):
    try:
        directory = os.path.realpath(directory)
        while True:
            meta = os.stat(directory)
            if meta.st_uid not in (0, os.getuid()) or meta.st_mode & 0o022:
                return False
            parent = os.path.dirname(directory)
            if parent == directory:
                return True
            directory = parent
    except OSError:
        return False

def node_version(directory):
    version = os.path.basename(os.path.dirname(directory))
    match = re.fullmatch(r'v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(-[^+]+)?(?:\+.+)?', version)
    if not match:
        return (-1, -1, -1, False)
    return (*[int(part or 0) for part in match.groups()[:3]], match.group(4) is None)

directories = [os.path.join(home, '.local/bin'), '/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', os.path.join(home, '.bun/bin'), os.path.join(home, '.cargo/bin')]
directories += sorted(glob.glob(os.path.join(home, '.nvm/versions/node/*/bin')), key=node_version, reverse=True)
directories += sorted(glob.glob(os.path.join(home, '.local/share/mise/installs/node/*/bin')), key=node_version, reverse=True)
directories += [value for value in os.environ.get('PATH', '').split(os.pathsep) if os.path.isabs(value)]
directories = list(dict.fromkeys(directory for directory in directories if trusted_directory(directory)))

def executable(candidate):
    try:
        resolved = os.path.realpath(candidate)
        meta = os.stat(resolved)
        return stat.S_ISREG(meta.st_mode) and os.access(resolved, os.X_OK) and meta.st_uid in (0, os.getuid()) and not meta.st_mode & 0o022 and trusted_directory(os.path.dirname(resolved))
    except OSError:
        return False

def resolve_command(command):
    expanded = os.path.expanduser(command)
    if os.path.isabs(expanded) and executable(expanded):
        return expanded
    name = os.path.basename(command)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*', name):
        return None
    for directory in directories:
        candidate = os.path.join(directory, name)
        if executable(candidate):
            return candidate
    return None

def repair_entry(entry):
    command = entry.get('command')
    if entry.get('enabled') is False or entry.get('disabled') is True:
        return None, 'disabled', 'Disabled by configuration.'
    if not isinstance(command, str):
        return None, 'remote', 'Network transport has no local executable to repair.'
    prefix = []
    found = resolve_command(command)
    if not found and not re.search(r'[\n\r$\x60|&;<>]', command):
        try:
            pieces = shlex.split(command)
            if len(pieces) > 1:
                found = resolve_command(pieces[0])
                prefix = pieces[1:]
        except ValueError:
            pass
    if not found:
        return None, 'unresolved', 'Executable is unavailable. Install the server from its trusted source or correct its command in the client settings.'
    candidate = copy.deepcopy(entry)
    candidate['command'] = found
    args = entry.get('args', [])
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
        return None, 'unresolved', 'Server arguments must be a list of strings.'
    if prefix:
        candidate['args'] = [*prefix, *args]
    try:
        with open(found, 'rb') as source:
            shebang = source.read(160).split(b'\n', 1)[0]
        if re.fullmatch(rb'#!/usr/bin/env\s+(?:-S\s+)?node\s*', shebang):
            node = resolve_command('node')
            if not node:
                return None, 'unresolved', 'This server needs Node.js, which is unavailable on this device.'
            candidate['command'] = node
            candidate['args'] = [found, *prefix, *args]
    except OSError:
        return None, 'unresolved', 'Cannot read the configured executable.'
    return candidate, 'healthy' if candidate == entry else 'repairable', 'Executable is available.' if candidate == entry else 'Use the installed executable and its runtime through absolute paths.'

def read_private(file):
    if not os.path.realpath(file).startswith(home + os.sep):
        raise ValueError('Configuration must stay inside the account home folder.')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > 4 * 1024 * 1024 or info.st_mode & 0o022:
            raise ValueError('Configuration must be a user-owned file that others cannot modify.')
        return os.read(fd, info.st_size + 1).decode('utf-8'), info
    finally:
        os.close(fd)

def persist(file, original, content, info):
    current, current_info = read_private(file)
    if current != original or (current_info.st_dev, current_info.st_ino) != (info.st_dev, info.st_ino):
        raise ValueError('Configuration changed during repair. Retry after the client finishes writing it.')
    parent = os.path.dirname(file)
    if not trusted_directory(parent):
        raise ValueError('Configuration directory permissions do not allow a safe repair.')
    backup = file + '.pzza-backup-' + hashlib.sha256(original.encode()).hexdigest()[:16]
    try:
        fd = os.open(backup, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, 0o600)
        with os.fdopen(fd, 'w') as handle:
            handle.write(original)
            handle.flush()
            os.fsync(handle.fileno())
    except FileExistsError:
        existing, backup_info = read_private(backup)
        if existing != original or backup_info.st_mode & 0o077:
            raise ValueError('Existing repair backup is unsafe.')
    fd, temporary = tempfile.mkstemp(prefix='.pzza-mcp-', dir=parent)
    try:
        with os.fdopen(fd, 'w') as handle:
            handle.write(content)
            handle.flush()
            os.fsync(handle.fileno())
        if read_private(file)[0] != original:
            raise ValueError('Configuration changed during repair.')
        os.replace(temporary, file)
    finally:
        if os.path.exists(temporary):
            os.unlink(temporary)
    return backup

def patch_toml(text, name, key, value):
    lines = text.splitlines(keepends=True)
    start = None
    end = len(lines)
    for index, line in enumerate(lines):
        if not line.lstrip().startswith('['):
            continue
        if start is not None:
            end = index
            break
        try:
            table = tomllib.loads(line + '\n__pzza_probe__ = true\n')
            if table.get('mcp_servers', {}).get(name, {}).get('__pzza_probe__') is True:
                start = index + 1
        except Exception:
            continue
    if start is None:
        raise ValueError('Use an explicit server table before repairing this configuration.')
    for index in range(start, end):
        if not re.match(r'^\s*' + re.escape(key) + r'\s*=', lines[index]):
            continue
        for last in range(index + 1, end + 1):
            try:
                parsed = tomllib.loads(''.join(lines[index:last]))
                if set(parsed) != {key}:
                    continue
                lines[index:last] = [key + ' = ' + json.dumps(value, ensure_ascii=True) + '\n']
                return ''.join(lines)
            except Exception:
                continue
        raise ValueError('Cannot safely update the server setting. Review it in the client settings.')
    lines.insert(end, key + ' = ' + json.dumps(value, ensure_ascii=True) + '\n')
    return ''.join(lines)

files = []
for directory in glob.glob(os.path.join(home, '.codex*'))[:100]:
    if os.path.isdir(directory):
        files.append((os.path.join(directory, 'config.toml'), 'codex'))
for file in glob.glob(os.path.join(home, '.claude*.json'))[:100]:
    files.append((file, 'claude'))
for directory in glob.glob(os.path.join(home, '.claude*'))[:100]:
    if os.path.isdir(directory):
        files.append((os.path.join(directory, '.claude.json'), 'claude'))

pending = list(dict.fromkeys(files))
seen = set()
for file, framework in pending:
    if file in seen:
        continue
    seen.add(file)
    if not os.path.lexists(file):
        continue
    relative = os.path.relpath(file, home)
    try:
        original, info = read_private(file)
        if framework == 'codex' and tomllib is None:
            raise ValueError('Python 3.11 or newer is required to validate this TOML configuration safely.')
        config = tomllib.loads(original) if framework == 'codex' else json.loads(original)
        desired = copy.deepcopy(config)
        groups = [(desired.get('mcp_servers' if framework == 'codex' else 'mcpServers', {}), '')]
        if framework == 'claude':
            for project_path in list(desired.get('projects', {}))[:100]:
                if isinstance(project_path, str) and os.path.isabs(project_path) and os.path.realpath(project_path).startswith(home + os.sep) and len(pending) < 300:
                    pending.extend([(os.path.join(project_path, '.mcp.json'), 'claude'), (os.path.join(project_path, '.codex/config.toml'), 'codex')])
            groups += [(project.get('mcpServers', {}), project_path) for project_path, project in desired.get('projects', {}).items() if isinstance(project, dict)]
        text = original
        repaired = []
        for servers, scope in groups:
            if not isinstance(servers, dict):
                continue
            for name, entry in servers.items():
                if not isinstance(entry, dict):
                    continue
                candidate, status, message = repair_entry(entry)
                result = {'framework': framework, 'server': name, 'file': relative, 'status': status, 'message': message}
                if scope:
                    result['scope'] = scope
                results.append(result)
                if candidate is not None and candidate != entry:
                    if framework == 'codex':
                        try:
                            changed = patch_toml(text, name, 'command', candidate['command'])
                            if candidate.get('args') != entry.get('args'):
                                changed = patch_toml(changed, name, 'args', candidate['args'])
                            text = changed
                        except ValueError as error:
                            result.update(status='unresolved', message=str(error))
                            continue
                    servers[name] = candidate
                    repaired.append(result)
        if repaired and apply:
            content = text if framework == 'codex' else json.dumps(desired, indent=2, ensure_ascii=False) + '\n'
            actual = tomllib.loads(content) if framework == 'codex' else json.loads(content)
            if actual != desired:
                raise ValueError('Repair could not preserve the configuration exactly.')
            backup = persist(file, original, content, info)
            for result in repaired:
                result.update(status='repaired', backup=os.path.relpath(backup, home), message='Updated the installed executable path. Restart the affected client to reload its configuration.')
    except Exception as error:
        # Parser errors may contain credential-bearing source lines.
        message = str(error) if type(error) is ValueError else 'Cannot safely read or parse this configuration. Review its syntax and permissions.'
        results.append({'framework': framework, 'file': relative, 'server': '', 'status': 'unresolved', 'message': message})

json.dump({'results': results}, sys.stdout)
`;
