"""Copy the persistent inputs of the owned Linux deb upgrade profile."""
from pathlib import Path
import shutil

from modular_bundle_inventory import digest


def copy_profile(source: Path, destination: Path) -> dict[str, str]:
    if source.resolve(strict=True) != source or destination.resolve() != destination:
        raise RuntimeError("Installed upgrade profile paths must be ordinary directories")
    if not source.is_dir() or destination.exists():
        raise RuntimeError("Copy requires an existing source and an unused profile destination")

    required = [
        ".profile-state.json", "taomni.db", "vault.db", "mfa.db", "migration/journal.json",
        "plugins/state.json", "plugins/mfa/active.json",
    ]
    candidates = [source / name for name in required]
    for name in (".module-release.json", "taomni.db-wal", "vault.db-wal", "mfa.db-wal"):
        file = source / name
        if file.exists() or file.is_symlink():
            candidates.append(file)
    for name in ("plugins/mfa/versions", "plugins/mfa/data"):
        directory = source / name
        if not directory.is_dir() or directory.resolve() != directory:
            raise RuntimeError(f"Missing ordinary module directory {name}")
        candidates.extend(path for path in directory.rglob("*") if path.is_symlink() or not path.is_dir())
    transient = source / "plugins/mfa/data/mfa.db-shm"

    checksums = {}
    for source_file in sorted(candidates):
        if source_file == transient:
            continue
        relative = source_file.relative_to(source)
        if not source_file.is_file() or source_file.resolve() != source_file:
            raise RuntimeError(f"Expected ordinary profile file {relative}")
        checksums[relative.as_posix()] = digest(source_file)
    for name, checksum in checksums.items():
        target = destination / name
        target.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source / name, target)
        if digest(target) != checksum:
            raise RuntimeError(f"Copied profile changed {name}")
    return checksums
