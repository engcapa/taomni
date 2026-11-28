"""Stage the locked MPP reader source and verify it before signing Project packages."""
import argparse
import hashlib
import os
from pathlib import Path
import re
import shutil
import tarfile
import tomllib
import urllib.request

DIRECTORY = Path(__file__).resolve().parent
LOCK = DIRECTORY.parents[2] / "Cargo.lock"
NOTICE = Path("licenses/mpxj-rs")


def locked_source():
    packages = tomllib.loads(LOCK.read_text(encoding="utf-8"))["package"]
    reader, = (package for package in packages if package["name"] == "mpxj-rs")
    return f"mpxj-rs-{reader['version']}", reader["checksum"]


def checked_material(payload, source_sha):
    if not re.fullmatch(r"[0-9a-f]{40}", source_sha):
        raise ValueError("Project relink instructions require a full Git commit ID")
    library, expected = locked_source()
    archive = payload / NOTICE / (library + ".crate")
    if archive.is_symlink() or archive.stat().st_size > 16 * 1024 * 1024:
        raise ValueError("Invalid Project reader source archive")
    with archive.open("rb") as source:
        if hashlib.file_digest(source, "sha256").hexdigest() != expected:
            raise ValueError("Project reader source differs from Cargo.lock")
        source.seek(0)
        with tarfile.open(fileobj=source, mode="r:gz") as bundle:
            license_text = bundle.extractfile(f"{library}/LICENSE").read()
    recipe = (DIRECTORY / "RELINK.md").read_text(encoding="utf-8")
    recipe = recipe.replace("@SOURCE_SHA@", source_sha).replace("@LIBRARY@", library).replace("@ARCHIVE@", archive.name)
    return {"LICENSE": license_text, "RELINK.md": recipe.encode("utf-8")}


def stage(payload, source_sha):
    library, _ = locked_source()
    archive = payload / NOTICE / (library + ".crate")
    archive.parent.mkdir(parents=True, exist_ok=True)
    cache = Path(os.environ.get("CARGO_HOME", Path.home() / ".cargo")) / "registry/cache"
    cached = next(cache.glob(f"*/{archive.name}"), None)
    if cached:
        shutil.copyfile(cached, archive)
    else:
        with urllib.request.urlopen(f"https://static.crates.io/crates/mpxj-rs/{archive.name}", timeout=60) as response:
            with archive.open("wb") as output:
                shutil.copyfileobj(response, output)
    for name, content in checked_material(payload, source_sha).items():
        (archive.parent / name).write_bytes(content)


def verify(payload, source_sha):
    library, _ = locked_source()
    for name, content in checked_material(payload, source_sha).items():
        path = payload / NOTICE / name
        if path.is_symlink() or path.stat().st_size != len(content) or path.read_bytes() != content:
            raise ValueError(f"Project {name} differs from the trusted source")
    return {(NOTICE / name).as_posix() for name in (library + ".crate", "LICENSE", "RELINK.md")}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("command", choices=["stage", "verify"])
    parser.add_argument("payload", type=Path)
    parser.add_argument("source_sha")
    args = parser.parse_args()
    if args.command == "stage":
        stage(args.payload, args.source_sha)
    verify(args.payload, args.source_sha)
