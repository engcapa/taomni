"""Disposable Shell files; every path stays below the current report root."""
from pathlib import Path
import hashlib
import tempfile


def setup(ctx):
    base = Path(ctx.report_root).resolve() / "shell-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    root = Path(tempfile.mkdtemp(prefix="shell-", dir=base))
    (root / "README.md").write_bytes(b"alpha\nbeta\ngamma\n")
    (root / "中文 目录").mkdir()
    payload = root / "transfer-16m.bin"
    payload.write_bytes(bytes(range(256)) * 65536)
    ctx.values.update(shell_root=root.as_posix(), shell_dir_name=root.name, shell_readme=(root / "README.md").as_posix(), shell_readme_sha256=hashlib.sha256(b"alpha\nbeta\ngamma\n").hexdigest(), shell_edited_sha256=hashlib.sha256(b"alpha\nbeta\ngamma\nz").hexdigest(), shell_transfer=payload.as_posix(), shell_transfer_sha256=hashlib.sha256(payload.read_bytes()).hexdigest())
