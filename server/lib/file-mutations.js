// Run the same guarded filesystem operations locally and over SSH.
export const FILE_MUTATION_SCRIPT = String.raw`"""Descriptor-relative file mutations, shared by local and SSH requests."""
import ctypes
import errno
import json
import os
import stat
import sys


class Refused(Exception):
    def __init__(self, message, status=403):
        super().__init__(message)
        self.status = status


def inside(root, target):
    return target == root or target.startswith(root + os.sep)


def absolute(value):
    if not isinstance(value, str) or not value or "\0" in value:
        raise Refused("Invalid path", 400)
    if ".." in value.split("/"):
        raise Refused("Path traversal is not allowed", 400)
    value = os.path.expanduser(value)
    if not os.path.isabs(value):
        raise Refused("Paths must be absolute or home-relative", 400)
    return os.path.normpath(value)


def protected(home, target):
    parts = os.path.relpath(target, home).split(os.sep)
    folded = [part.casefold() for part in parts]
    if ".git" in folded:
        raise Refused("Git metadata cannot be moved or deleted")
    if folded[0] in (".ssh", ".gnupg", ".aws") or folded[:2] == ["library", "keychains"]:
        raise Refused("Protected user data cannot be moved or deleted")
    if (folded[:2] == [".config", "pzzacode"] and folded[-1] == "agent-token") or (
        folded[0].startswith(".claude") and folded[-1] == ".credentials.json"
    ) or (folded[0].startswith(".codex") and folded[-1] == "auth.json"):
        raise Refused("Protected user data cannot be moved or deleted")


def open_directory(parent, name):
    return os.open(name, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW, dir_fd=parent)


def parent_descriptor(root_fd, relative):
    parts = relative.split(os.sep)
    fd = os.dup(root_fd)
    try:
        for part in parts[:-1]:
            following = open_directory(fd, part)
            os.close(fd)
            fd = following
        return fd, parts[-1]
    except BaseException:
        os.close(fd)
        raise


def inspect_tree(parent, name, home, location, device):
    protected(home, location)
    metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if stat.S_ISDIR(metadata.st_mode):
        fd = open_directory(parent, name)
        try:
            if os.fstat(fd).st_dev != device:
                raise Refused("Cross-filesystem directory operations are not supported", 409)
            for child in os.listdir(fd):
                inspect_tree(fd, child, home, os.path.join(location, child), device)
        finally:
            os.close(fd)


def remove_tree(parent, name, home, location, device):
    protected(home, location)
    metadata = os.stat(name, dir_fd=parent, follow_symlinks=False)
    if not stat.S_ISDIR(metadata.st_mode):
        os.unlink(name, dir_fd=parent)
        return
    fd = open_directory(parent, name)
    try:
        if os.fstat(fd).st_dev != device:
            raise Refused("Cross-filesystem directory operations are not supported", 409)
        for child in os.listdir(fd):
            remove_tree(fd, child, home, os.path.join(location, child), device)
    finally:
        os.close(fd)
    os.rmdir(name, dir_fd=parent)


def exclusive_rename(source_fd, source_name, target_fd, target_name):
    # An existence check followed by rename can overwrite a racing creator.
    # Native exclusive rename keeps the collision check and mutation atomic.
    library = ctypes.CDLL(None, use_errno=True)
    if sys.platform == "linux":
        rename = getattr(library, "renameat2", None)
        flags = 1
    elif sys.platform == "darwin":
        rename = getattr(library, "renameatx_np", None)
        flags = 4
    else:
        rename = None
    if rename is None:
        raise Refused("Atomic non-overwriting moves are unavailable on this device", 501)
    rename.argtypes = [ctypes.c_int, ctypes.c_char_p, ctypes.c_int, ctypes.c_char_p, ctypes.c_uint]
    rename.restype = ctypes.c_int
    if rename(source_fd, os.fsencode(source_name), target_fd, os.fsencode(target_name), flags) != 0:
        code = ctypes.get_errno()
        if code in (errno.ENOSYS, errno.ENOTSUP, errno.EINVAL):
            raise Refused("This filesystem does not support atomic non-overwriting moves", 501)
        raise OSError(code, os.strerror(code))


def mutate(body):
    home = os.path.realpath(os.path.expanduser("~"))
    requested_root = absolute(body.get("root"))
    root = os.path.realpath(requested_root)
    if not inside(home, root):
        raise Refused("Selected root is outside home")
    protected(home, root)
    operation = body.get("operation")
    if operation not in ("move", "delete"):
        raise Refused("Invalid operation", 400)

    def resolve(value):
        requested = absolute(value)
        if inside(requested_root, requested):
            target = os.path.join(root, os.path.relpath(requested, requested_root))
            target = os.path.normpath(target)
        else:
            target = requested
        if target == root or not inside(root, target):
            raise Refused("The selected root cannot be changed and paths must remain inside it")
        protected(home, target)
        return target, os.path.relpath(target, root)

    source, relative = resolve(body.get("path"))
    destination = resolve(body.get("destination")) if operation == "move" else None
    # Resolve the selected root once, then refuse symlink traversal in all
    # descendant directories. Final symlinks are unlinked, never followed.
    root_fd = os.open(os.sep, os.O_RDONLY | os.O_DIRECTORY)
    try:
        for part in root.split(os.sep):
            if part:
                following = open_directory(root_fd, part)
                os.close(root_fd)
                root_fd = following
    except BaseException:
        os.close(root_fd)
        raise
    try:
        source_fd, source_name = parent_descriptor(root_fd, relative)
        try:
            device = os.fstat(root_fd).st_dev
            inspect_tree(source_fd, source_name, home, source, device)
            if operation == "delete":
                remove_tree(source_fd, source_name, home, source, device)
                return {"ok": True}
            target, target_relative = destination
            if inside(source, target):
                raise Refused("A directory cannot be moved into itself", 409)
            if stat.S_ISLNK(os.stat(source_name, dir_fd=source_fd, follow_symlinks=False).st_mode):
                raise Refused("Moving symbolic links is not supported")
            target_fd, target_name = parent_descriptor(root_fd, target_relative)
            try:
                exclusive_rename(source_fd, source_name, target_fd, target_name)
            finally:
                os.close(target_fd)
            return {"path": target}
        finally:
            os.close(source_fd)
    finally:
        os.close(root_fd)


def main():
    try:
        body = json.load(sys.stdin)
        if not isinstance(body, dict):
            raise Refused("Invalid request", 400)
        result = mutate(body)
        print(json.dumps({"status": 200, "result": result}))
    except Refused as error:
        print(json.dumps({"status": error.status, "error": str(error)}))
    except OSError as error:
        status = {
            errno.ENOENT: 404, errno.EEXIST: 409, errno.ENOTEMPTY: 409,
            errno.EXDEV: 409, errno.ELOOP: 403, errno.ENOTDIR: 403,
            errno.EACCES: 403, errno.EPERM: 403,
        }.get(error.errno, 500)
        message = "Destination already exists" if error.errno in (errno.EEXIST, errno.ENOTEMPTY) else os.strerror(error.errno)
        print(json.dumps({"status": status, "error": message}))
    except (ValueError, TypeError):
        print(json.dumps({"status": 400, "error": "Invalid request"}))


if __name__ == "__main__":
    main()
`;
