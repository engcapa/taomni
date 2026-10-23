# Executed remotely by python3. JSON framing preserves spaces/newlines in names;
# no user path is interpreted by the shell or interpolated into source code.
import json
import os
import shutil
import stat
import sys


def kind(mode):
    return "dir" if stat.S_ISDIR(mode) else "file" if stat.S_ISREG(mode) else "symlink" if stat.S_ISLNK(mode) else "unknown"


def entry(path):
    attrs = os.lstat(path)
    name = os.path.basename(path.rstrip("/"))
    target = None
    target_type = None
    if stat.S_ISLNK(attrs.st_mode):
        target = os.readlink(path)
        try:
            target_type = kind(os.stat(path).st_mode)
        except OSError:
            pass
    return dict(name=name, path=path, size=attrs.st_size, mtime=int(attrs.st_mtime),
                mode=attrs.st_mode, fileType=kind(attrs.st_mode), targetFileType=target_type,
                isHidden=name.startswith("."), symlinkTarget=target,
                owner=str(attrs.st_uid), group=str(attrs.st_gid))


try:
    op, args = json.loads(sys.argv[1])
    path = args[0]
    if op == "list":
        result = sorted([entry(os.path.join(path, name)) for name in os.listdir(path)], key=lambda item: item["name"].lower())
    elif op == "stat":
        result = entry(path)
    elif op == "realpath":
        result = os.path.realpath(path, strict=True)
    elif op == "readlink":
        result = os.readlink(path)
    elif op == "mkdir":
        os.mkdir(path)
        result = None
    elif op == "mkdirs":
        os.makedirs(path, exist_ok=True)
        result = None
    elif op == "remove":
        if os.path.isdir(path) and not os.path.islink(path):
            shutil.rmtree(path) if args[1] else os.rmdir(path)
        else:
            os.unlink(path)
        result = None
    elif op == "rename":
        os.rename(path, args[1])
        result = None
    elif op == "chmod":
        os.chmod(path, args[1])
        result = None
    else:
        raise ValueError("Unknown file operation")
    print(json.dumps({"ok": result}, ensure_ascii=True))
except Exception as error:
    print(json.dumps({"error": str(error)}, ensure_ascii=True))
    sys.exit(1)
