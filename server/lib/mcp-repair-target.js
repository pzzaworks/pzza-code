export const MCP_REPAIR_TARGET = String.raw`
import copy, glob, grp, hashlib, io, json, os, platform, re, shlex, stat, sys, tarfile, tempfile, time, urllib.request
try:
    import tomllib
except ImportError:
    tomllib = None

request = json.load(sys.stdin)
home = os.path.realpath(os.path.expanduser('~'))
results = []
apply = request.get('apply') is True

def trusted_directory_mode(directory, meta):
    # macOS intentionally lets administrators install applications here. Every
    # directory inside the selected app must still pass the normal owner check.
    system_applications = (sys.platform == 'darwin' and directory == '/Applications'
        and meta.st_uid == 0 and grp.getgrgid(meta.st_gid).gr_name == 'admin'
        and not meta.st_mode & 0o002)
    return meta.st_uid in (0, os.getuid()) and (not meta.st_mode & 0o022 or system_applications)

def trusted_directory(directory):
    try:
        directory = os.path.realpath(directory)
        while True:
            meta = os.stat(directory)
            if not trusted_directory_mode(directory, meta):
                return False
            parent = os.path.dirname(directory)
            if parent == directory:
                return True
            directory = parent
    except (OSError, KeyError):
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

def resolve_command(command, cwd=None):
    expanded = os.path.expanduser(command)
    if os.path.isabs(expanded) and executable(expanded):
        return expanded
    if not os.path.isabs(expanded) and '/' in expanded:
        candidate = os.path.abspath(os.path.join(cwd, expanded)) if cwd else None
        return candidate if candidate and executable(candidate) else None
    name = os.path.basename(command)
    if not re.fullmatch(r'[A-Za-z0-9][A-Za-z0-9._+-]*', name):
        return None
    for directory in directories:
        candidate = os.path.join(directory, name)
        if executable(candidate):
            return candidate
    return None

RAILWAY_VERSION = '5.51.0'
RAILWAY_ASSETS = {
    ('Darwin', 'arm64'): ('aarch64-apple-darwin', '523ac60fd8589bef4496262a831df518226cab172b3c27645024239c98e2c34f'),
    ('Darwin', 'x86_64'): ('x86_64-apple-darwin', '79a79e72be45f8f00cb9ded35aed9de90b77e42d5b12824e74154c092bcd0bd3'),
    ('Linux', 'aarch64'): ('aarch64-unknown-linux-musl', '641a21a49ec6eebe39e64ddb859cdcef17e12f5ca25d050f7c23a80edb957c97'),
    ('Linux', 'x86_64'): ('x86_64-unknown-linux-musl', '5185bf60ab9534da42c5f75315abd158d1e942034eee811f46983c7cb08bb553'),
}
provisioned = {}

def railway_binary(archive, digest):
    if hashlib.sha256(archive).hexdigest() != digest:
        raise ValueError('Official executable checksum verification failed.')
    with tarfile.open(fileobj=io.BytesIO(archive), mode='r:gz') as bundle:
        members = bundle.getmembers()
        if len(members) != 1 or members[0].name not in ('railway', './railway') or not members[0].isfile() or not 0 < members[0].size <= 192 * 1024 * 1024:
            raise ValueError('Official executable archive has an unexpected structure.')
        with bundle.extractfile(members[0]) as source:
            binary = source.read(192 * 1024 * 1024 + 1)
        if len(binary) != members[0].size:
            raise ValueError('Official executable archive is incomplete.')
        return binary

def private_cache_directory(directory):
    relative = os.path.relpath(directory, home)
    if relative == '..' or relative.startswith('../') or not trusted_directory(home):
        raise ValueError('Executable cache must stay in the private account home.')
    current = home
    for part in relative.split(os.sep):
        current = os.path.join(current, part)
        try:
            os.mkdir(current, 0o700)
        except FileExistsError:
            pass
        fd = os.open(current, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
        try:
            info = os.fstat(fd)
            if info.st_uid != os.getuid() or info.st_mode & 0o022:
                raise ValueError('Executable cache permissions do not allow a safe installation.')
        finally:
            os.close(fd)

def provision_railway():
    asset = RAILWAY_ASSETS.get((platform.system(), platform.machine()))
    if not asset:
        raise ValueError('Automatic Railway installation is unavailable on this platform.')
    target, digest = asset
    directory = os.path.join(home, '.pzzacode-mcp-tools/railway', RAILWAY_VERSION, target)
    binary_path = os.path.join(directory, 'railway')
    manifest_path = os.path.join(directory, 'checksum.json')
    parent = os.path.dirname(directory)
    private_cache_directory(parent)
    if not os.path.realpath(parent).startswith(home + os.sep) or not trusted_directory(parent):
        raise ValueError('Executable cache permissions do not allow a safe installation.')
    if os.path.lexists(directory):
        try:
            if os.path.islink(directory) or not trusted_directory(directory):
                raise ValueError('Unsafe executable cache.')
            manifest = json.loads(read_private(manifest_path)[0])
            if os.path.islink(binary_path) or not executable(binary_path) or os.path.getsize(binary_path) > 192 * 1024 * 1024:
                raise ValueError('Unsafe executable cache.')
            with open(binary_path, 'rb') as source:
                valid = hashlib.sha256(source.read()).hexdigest() == manifest.get('binary')
            if valid and manifest.get('archive') == digest:
                return binary_path
        except (OSError, ValueError):
            pass
        raise ValueError('Cached Railway executable failed integrity checks. Remove its private cache directory before retrying.')
    # Only this explicitly configured, pinned dependency is provisioned. Other
    # unknown executable names never become package download instructions.
    url = 'https://github.com/railwayapp/cli/releases/download/v' + RAILWAY_VERSION + '/railway-v' + RAILWAY_VERSION + '-' + target + '.tar.gz'
    deadline = time.monotonic() + 30
    chunks = []
    size = 0
    with urllib.request.urlopen(url, timeout=8) as response:
        while True:
            if time.monotonic() > deadline:
                raise ValueError('Official executable download timed out. Retry when this device is online.')
            chunk = response.read(1024 * 1024)
            if not chunk:
                break
            size += len(chunk)
            if size > 64 * 1024 * 1024:
                raise ValueError('Official executable download exceeded its size limit.')
            chunks.append(chunk)
    binary = railway_binary(b''.join(chunks), digest)
    # Publish a complete verified installation; interrupted downloads leave no
    # executable behind and configured launchers never point at temporary files.
    with tempfile.TemporaryDirectory(prefix='.install-', dir=parent) as staging:
        for filename, content, mode in [('railway', binary, 0o700), ('checksum.json', json.dumps({'archive': digest, 'binary': hashlib.sha256(binary).hexdigest()}).encode(), 0o600)]:
            temporary = os.path.join(staging, filename)
            fd = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
            with os.fdopen(fd, 'wb') as output:
                output.write(content)
                output.flush()
                os.fsync(output.fileno())
        os.rename(staging, directory)
    return binary_path

def repair_entry(entry, project=None):
    command = entry.get('command')
    if entry.get('enabled') is False or entry.get('disabled') is True:
        return None, 'disabled', 'Disabled by configuration.'
    if not isinstance(command, str):
        return None, 'remote', 'Network transport has no local executable to repair.'
    cwd = project
    configured_cwd = entry.get('cwd')
    if isinstance(configured_cwd, str):
        expanded = os.path.expanduser(configured_cwd)
        cwd = expanded if os.path.isabs(expanded) else os.path.join(project, expanded) if project else None
    args = entry.get('args', [])
    if not isinstance(args, list) or not all(isinstance(arg, str) for arg in args):
        return None, 'unresolved', 'Server arguments must be a list of strings.'
    prefix = []
    executable_name = command
    found = resolve_command(command, cwd)
    if not found and not re.search(r'[\n\r$\x60|&;<>]', command):
        try:
            pieces = shlex.split(command)
            if len(pieces) > 1:
                executable_name = pieces[0]
                found = resolve_command(pieces[0], cwd)
                prefix = pieces[1:]
        except ValueError:
            pass
    if not found and os.path.basename(executable_name) == 'railway' and [*prefix, *args][:1] == ['mcp']:
        if not apply:
            return None, 'repairable', 'Install the pinned official Railway CLI and use its private absolute path.'
        if 'railway' not in provisioned:
            try:
                provisioned['railway'] = (provision_railway(), None)
            except Exception:
                provisioned['railway'] = (None, 'Cannot safely install the official Railway CLI. Check this device network and private cache permissions, then retry.')
        found, failure = provisioned['railway']
        if failure:
            return None, 'unresolved', failure
    if not found:
        return None, 'unresolved', 'Executable is unavailable. Install the server from its trusted source or correct its command in the client settings.'
    candidate = copy.deepcopy(entry)
    candidate['command'] = found
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

def read_private(file, harden=False):
    if not os.path.realpath(file).startswith(home + os.sep):
        raise ValueError('Configuration must stay inside the account home folder.')
    fd = os.open(file, os.O_RDONLY | os.O_NOFOLLOW)
    try:
        info = os.fstat(fd)
        if not stat.S_ISREG(info.st_mode) or info.st_uid != os.getuid() or info.st_nlink != 1 or info.st_size > 4 * 1024 * 1024:
            raise ValueError('Configuration must be a user-owned regular file with a single link.')
        if harden and apply and info.st_mode & 0o022 and trusted_directory(os.path.dirname(file)):
            os.fchmod(fd, 0o600)
            info = os.fstat(fd)
            results.append({'framework': 'integration', 'file': os.path.relpath(file, home), 'server': '', 'status': 'repaired', 'message': 'Restricted private client configuration to its owner.'})
        if info.st_mode & 0o022:
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

private_files = {file for file, _ in files}
pending = [(file, framework, None) for file, framework in dict.fromkeys(files)]
seen = set()
for file, framework, private_owner in pending:
    identity = (file, private_owner)
    if identity in seen:
        continue
    seen.add(identity)
    if not os.path.lexists(file):
        continue
    relative = os.path.relpath(file, home)
    try:
        parent = os.path.dirname(file)
        if apply and file in private_files and parent != home and os.path.dirname(parent) == home:
            fd = os.open(parent, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
            try:
                info = os.fstat(fd)
                if info.st_uid == os.getuid() and info.st_mode & 0o022 and trusted_directory(home):
                    os.fchmod(fd, 0o700)
                    results.append({'framework': 'integration', 'file': os.path.relpath(parent, home), 'server': '', 'status': 'repaired', 'message': 'Restricted the private client configuration directory to its owner.'})
            finally:
                os.close(fd)
        original, info = read_private(file, harden=file in private_files)
        if framework == 'codex' and tomllib is None:
            raise ValueError('Python 3.11 or newer is required to validate this TOML configuration safely.')
        config = tomllib.loads(original) if framework == 'codex' else json.loads(original)
        desired = copy.deepcopy(config)
        private_project = os.path.dirname(file) if private_owner else None
        private_overrides = {}
        if private_owner:
            owner_original, owner_info = read_private(private_owner)
            owner_config = json.loads(owner_original)
            private_overrides = owner_config.get('projects', {}).get(private_project, {}).get('mcpServers', {})
            if not isinstance(private_overrides, dict):
                raise ValueError('Private project server settings must be an object.')
        groups = [(desired.get('mcp_servers' if framework == 'codex' else 'mcpServers', {}), '')]
        if framework == 'claude':
            for project_path in list(desired.get('projects', {}))[:100]:
                if isinstance(project_path, str) and os.path.isabs(project_path) and os.path.realpath(project_path).startswith(home + os.sep) and len(pending) < 300:
                    pending.extend([(os.path.join(project_path, '.mcp.json'), 'claude', file), (os.path.join(project_path, '.codex/config.toml'), 'codex', None)])
            groups += [(project.get('mcpServers', {}), project_path) for project_path, project in desired.get('projects', {}).items() if isinstance(project, dict)]
        text = original
        repaired = []
        for servers, scope in groups:
            if not isinstance(servers, dict):
                continue
            for name, entry in servers.items():
                if not isinstance(entry, dict):
                    continue
                if private_owner and name in private_overrides:
                    results.append({'framework': framework, 'server': name, 'file': relative, 'status': 'healthy', 'message': 'Private project settings override this entry and are checked separately.'})
                    continue
                project = scope if os.path.isabs(scope) else None
                if not project and os.path.basename(file) == '.mcp.json':
                    project = os.path.dirname(file)
                if not project and framework == 'codex' and os.path.basename(os.path.dirname(file)) == '.codex' and os.path.dirname(os.path.dirname(file)) != home:
                    project = os.path.dirname(os.path.dirname(file))
                candidate, status, message = repair_entry(entry, project)
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
            if private_owner:
                # Keep shared project files portable. A personal project-level
                # override has precedence and keeps machine paths out of Git.
                private_servers = owner_config.setdefault('projects', {}).setdefault(private_project, {}).setdefault('mcpServers', {})
                for result in repaired:
                    private_servers[result['server']] = desired['mcpServers'][result['server']]
                backup = persist(private_owner, owner_original, json.dumps(owner_config, indent=2, ensure_ascii=False) + '\n', owner_info)
            else:
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
