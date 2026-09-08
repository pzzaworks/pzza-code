// Descriptor-relative target operations run identically locally and on an explicit SSH host.
export const AGENTS_HUB_TARGET = String.raw`
import base64, fcntl, hashlib, json, os, shlex, shutil, stat, subprocess, sys, uuid

LIMIT = 64 * 1024 * 1024
FILE_LIMIT = 5 * 1024 * 1024
MARKER = '.pzza-agents-hub.json'
class Refused(Exception):
    def __init__(self, message, status=409):
        self.status = status
        super().__init__(message)

def parts(value):
    if not isinstance(value, str) or not value or len(value) > 2048 or value.startswith('/') or any(ord(c) < 32 for c in value):
        raise Refused('Invalid relative deployment path', 400)
    result = value.split('/')
    if any(p.casefold() in ('', '.', '..', '.git') for p in result):
        raise Refused('Invalid deployment path component', 400)
    return result

def directory(parent, name, create=False):
    if create:
        try: os.mkdir(name, 0o700, dir_fd=parent)
        except FileExistsError: pass
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)

def parent_for(root, relative, create=False):
    segments = parts(relative)
    fd = os.dup(root)
    try:
        for segment in segments[:-1]:
            following = directory(fd, segment, create)
            os.close(fd)
            fd = following
        return fd, segments[-1]
    except:
        os.close(fd)
        raise

def read_file(root, relative):
    parent = None
    try:
        parent, name = parent_for(root, relative)
        fd = os.open(name, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
        try:
            meta = os.fstat(fd)
            if not stat.S_ISREG(meta.st_mode) or meta.st_nlink != 1 or meta.st_size > FILE_LIMIT:
                raise Refused('Deployment target is not a bounded regular file')
            chunks, length = [], 0
            while True:
                data = os.read(fd, 65536)
                if not data: break
                length += len(data)
                if length > FILE_LIMIT: raise Refused('Deployment file is too large')
                chunks.append(data)
            return b''.join(chunks)
        finally: os.close(fd)
    except FileNotFoundError: return None
    finally:
        if parent is not None: os.close(parent)

def digest(data): return None if data is None else hashlib.sha256(data).hexdigest()

def file_mode(root, relative):
    parent = None
    try:
        parent, name = parent_for(root, relative)
        return stat.S_IMODE(os.stat(name, dir_fd=parent, follow_symlinks=False).st_mode)
    except FileNotFoundError: return None
    finally:
        if parent is not None: os.close(parent)

def atomic_file(root, relative, content, expected, mode=0o600, expected_mode=None):
    parent, name = parent_for(root, relative, content is not None)
    backup = '.hub-backup-' + uuid.uuid4().hex
    staged = '.hub-write-' + uuid.uuid4().hex
    moved = False
    try:
        if digest(read_file(root, relative)) != expected or file_mode(root, relative) != expected_mode:
            raise Refused('A deployment target changed after preview')
        if expected is not None:
            # Preserve the original before replacement and verify what was moved.
            os.rename(name, backup, src_dir_fd=parent, dst_dir_fd=parent)
            moved = True
            fd = os.open(backup, os.O_RDONLY | os.O_NOFOLLOW, dir_fd=parent)
            try:
                old = b''
                while True:
                    chunk = os.read(fd, 65536)
                    if not chunk: break
                    old += chunk
                    if len(old) > FILE_LIMIT: raise Refused('Deployment file grew during update')
                if digest(old) != expected or stat.S_IMODE(os.fstat(fd).st_mode) != expected_mode: raise Refused('A deployment target changed during update')
            finally: os.close(fd)
        if content is not None:
            fd = os.open(staged, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode, dir_fd=parent)
            try:
                with os.fdopen(fd, 'wb', closefd=False) as output:
                    output.write(content)
                    output.flush()
                    os.fsync(fd)
            finally: os.close(fd)
            # link is create-only: never overwrite a file created while staging.
            os.link(staged, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            os.unlink(staged, dir_fd=parent)
        if moved: os.unlink(backup, dir_fd=parent)
        os.fsync(parent)
    except:
        if moved:
            try: os.link(backup, name, src_dir_fd=parent, dst_dir_fd=parent, follow_symlinks=False)
            except FileExistsError: pass
            # Keep the backup if another writer owns the destination now.
            else: os.unlink(backup, dir_fd=parent)
        raise
    finally:
        try: os.unlink(staged, dir_fd=parent)
        except FileNotFoundError: pass
        os.close(parent)

def backup_files(home, cwd, profile_id, records):
    if not records: return None
    if sum(len(content) for content, mode in records.values()) > 32 * 1024 * 1024:
        raise Refused('Existing files exceed the 32 MiB safety-backup limit')
    root = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for segment in ['.local', 'state', 'pzzacode', 'agents-hub-backups']:
            following = directory(root, segment, True)
            os.close(root)
            root = following
            info = os.fstat(root)
            if info.st_uid != os.getuid() or stat.S_IMODE(info.st_mode) & 0o022:
                raise Refused('Safety backup directory must be privately writable')
        backup_id = uuid.uuid4().hex
        backup = directory(root, backup_id, True)
        try:
            for name, (content, mode) in records.items():
                atomic_file(backup, 'files/' + name, content, None)
            metadata = {'cwd': cwd, 'profileId': profile_id, 'files': {name: {'sha256': digest(content), 'mode': mode} for name, (content, mode) in records.items()}}
            atomic_file(backup, 'metadata.json', json.dumps(metadata, sort_keys=True).encode(), None)
        finally: os.close(backup)
        location = os.path.join(home, '.local', 'state', 'pzzacode', 'agents-hub-backups')
        retained = []
        for name in os.listdir(root):
            if len(name) == 32 and all(c in '0123456789abcdef' for c in name):
                info = os.stat(name, dir_fd=root, follow_symlinks=False)
                if stat.S_ISDIR(info.st_mode): retained.append((info.st_mtime_ns, name))
        for _, name in sorted(retained)[:-10]:
            shutil.rmtree(os.path.join(location, name))
        return os.path.join(location, backup_id)
    finally: os.close(root)

def run(request):
    home = os.path.realpath(os.path.expanduser('~'))
    cwd = request.get('cwd')
    if not isinstance(cwd, str) or not os.path.isabs(cwd) or any(ord(c) < 32 for c in cwd):
        raise Refused('An absolute project directory is required', 400)
    cwd = os.path.normpath(cwd)
    if cwd == home or not cwd.startswith(home + os.sep) or os.path.realpath(cwd) != cwd:
        raise Refused('Choose a real project directory below this device home directory', 403)
    relative = os.path.relpath(cwd, home)
    first = relative.split(os.sep)[0].casefold()
    if first in ('.ssh', '.gnupg', '.aws', '.config', '.claude', '.codex', '.agents', '.cursor', '.windsurf', '.codeium', '.devin'):
        raise Refused('Credential and personal configuration directories cannot be deployment roots', 403)
    root = os.open(home, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    try:
        for segment in parts(relative):
            following = directory(root, segment)
            os.close(root)
            root = following
        # Cooperative cross-process lock without leaving preview files in the project.
        fcntl.flock(root, fcntl.LOCK_EX | fcntl.LOCK_NB)
        identity = {'device': str(os.fstat(root).st_dev), 'inode': str(os.fstat(root).st_ino)}
        if request['operation'] != 'preview' and request.get('projectIdentity') != identity:
            raise Refused('The project directory was replaced after preview')
        marker_bytes = read_file(root, MARKER)
        marker = json.loads(marker_bytes) if marker_bytes else None
        if marker is not None and (not isinstance(marker, dict) or marker.get('version') != 1 or not isinstance(marker.get('files'), dict)):
            raise Refused('Project has an invalid Agents Hub ownership marker')
        desired = request['files']
        current_paths = set(item['path'] for item in desired)
        if marker:
            current_paths.update(marker['files'])
        baselines = {name: digest(read_file(root, name)) for name in current_paths}
        baseline_modes = {name: file_mode(root, name) for name in current_paths}
        conflicts = []
        if marker and marker.get('profileId') != request['profileId']:
            conflicts.append('This directory belongs to another profile. Use a separate work directory to prevent shared instruction and skill contamination.')
        for name, baseline in baselines.items():
            expected = marker['files'].get(name) if marker else None
            generated = next((digest(base64.b64decode(item['contentBase64'], validate=True)) for item in desired if item['path'] == name), None)
            if not request.get('adoptExisting') and expected is not None and (baseline != expected or (name in marker.get('modes', {}) and baseline_modes[name] != marker['modes'][name])):
                conflicts.append(name + ': managed file changed outside Agents Hub')
            elif not request.get('adoptExisting') and expected is None and baseline is not None and baseline != generated:
                conflicts.append(name + ': existing file is not owned by this profile')
        for blocker in request.get('blockers', []):
            if file_mode(root, blocker) is not None:
                conflicts.append(blocker + ': takes precedence over the generated instruction file')
        previous = {}
        previous_bytes = 0
        for name, baseline in baselines.items():
            desired_item = next((item for item in desired if item['path'] == name), None)
            desired_hash = digest(base64.b64decode(desired_item['contentBase64'], validate=True)) if desired_item else None
            desired_mode = (0o700 if desired_item.get('executable') else 0o600) if desired_item else None
            if baseline is not None and (baseline != desired_hash or baseline_modes[name] != desired_mode):
                content = read_file(root, name)
                if digest(content) != baseline: raise Refused('Target files changed while creating preview')
                previous_bytes += len(content)
                if previous_bytes > 32 * 1024 * 1024: raise Refused('Existing preview files exceed the 32 MiB review limit')
                previous[name] = {'contentBase64': base64.b64encode(content).decode(), 'mode': baseline_modes[name]}
        if request['operation'] == 'preview':
            return {'cwd': cwd, 'projectIdentity': identity, 'baselines': baselines, 'markerSha256': digest(marker_bytes), 'baselineModes': baseline_modes, 'conflicts': conflicts, 'previous': previous}
        if conflicts: raise Refused('Deployment conflicts must be resolved before applying')
        if digest(marker_bytes) != request['markerSha256'] or baselines != request['baselines'] or baseline_modes != request['baselineModes']:
            raise Refused('Project files changed after preview; create a new preview')
        executable = None
        if request['operation'] == 'deploy':
            cli = request.get('command')
            if cli not in ('claude', 'codex'): raise Refused('This framework supports file synchronization only', 400)
            executable = shutil.which(cli)
            if not executable or not shutil.which('tmux'): raise Refused('The selected agent CLI and tmux must already be installed on the target device', 503)
        backup_path = backup_files(home, cwd, request['profileId'], {name: (base64.b64decode(item['contentBase64']), item['mode']) for name, item in previous.items()})
        changed, originals = [], {}
        try:
            for item in desired:
                name = item['path']
                content = base64.b64decode(item['contentBase64'], validate=True)
                originals[name] = (read_file(root, name), baseline_modes.get(name))
                mode = 0o700 if item.get('executable') else 0o600
                if digest(content) != baselines.get(name) or baseline_modes.get(name) != mode:
                    atomic_file(root, name, content, baselines.get(name), mode, baseline_modes.get(name))
                    changed.append((name, digest(content), mode))
            for name in sorted(set(baselines) - set(item['path'] for item in desired)):
                originals[name] = (read_file(root, name), baseline_modes.get(name))
                if originals[name][0] is not None:
                    atomic_file(root, name, None, baselines[name], 0o600, baseline_modes.get(name))
                    changed.append((name, None, None))
            updated = {'version': 1, 'profileId': request['profileId'], 'framework': request['framework'], 'revision': request['revision'], 'files': {item['path']: digest(base64.b64decode(item['contentBase64'], validate=True)) for item in desired}, 'modes': {item['path']: 0o700 if item.get('executable') else 0o600 for item in desired}}
            atomic_file(root, MARKER, json.dumps(updated, sort_keys=True).encode(), request['markerSha256'], 0o600, file_mode(root, MARKER))
        except:
            for name, expected, current_mode in reversed(changed):
                try: atomic_file(root, name, originals[name][0], expected, originals[name][1] or 0o600, current_mode)
                except Exception: pass
            raise Refused('Deployment could not apply every file. Check target files and any .hub-backup files before previewing again')
        if executable:
            launched = subprocess.run(['tmux', 'new-session', '-d', '-s', request['session'], '-c', cwd, shlex.quote(executable)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=10)
            if launched.returncode != 0:
                return {'ok': False, 'filesApplied': True, 'backupPath': backup_path, 'error': 'Files were synchronized, but the terminal session could not start'}
            return {'ok': True, 'filesApplied': True, 'session': request['session'], 'backupPath': backup_path}
        return {'ok': True, 'filesApplied': True, 'backupPath': backup_path}
    finally: os.close(root)

try:
    raw = sys.stdin.buffer.read(LIMIT + 1)
    if len(raw) > LIMIT: raise Refused('Deployment payload is too large', 413)
    result = run(json.loads(raw))
    print(json.dumps(result))
except Refused as error:
    print(json.dumps({'ok': False, 'error': str(error), 'status': error.status}))
except Exception:
    print(json.dumps({'ok': False, 'error': 'Target operation failed; check Python 3, directory permissions and symlink-free project paths', 'status': 500}))
`;
