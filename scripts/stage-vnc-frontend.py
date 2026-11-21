"""Add a verified module renderer to a validated signing payload."""
import hashlib
import json
from pathlib import Path
import sys


def stage_frontend(built: Path, payload: Path, source: str, tooling: str, slug: str) -> None:
    if slug not in {"rdp-client", "vnc-client", "mail"}:
        raise ValueError("Unexpected module")
    files = {path.name: path for path in built.iterdir()}
    if set(files) != {"index.js", "receipt.json"} or any(
        path.is_symlink() or not path.is_file() for path in files.values()
    ):
        raise ValueError("Unexpected files in module frontend artifact")
    javascript = files["index.js"].read_bytes()
    expected = {"sourceSha": source, "toolingSha": tooling, "slug": slug,
                "sha256": hashlib.sha256(javascript).hexdigest()}
    if not javascript or json.loads(files["receipt.json"].read_text(encoding="utf-8")) != expected:
        raise ValueError("Frontend receipt does not match the selected source and entry bytes")
    manifest = json.loads((payload / "module.json").read_text(encoding="utf-8"))
    if manifest["slug"] != slug or manifest["entry"]["frontend"] != "frontend/index.js":
        raise ValueError("Frontend path differs from the approved module manifest")
    frontend = payload / "frontend"
    frontend.mkdir()
    (frontend / "index.js").write_bytes(javascript)


if __name__ == "__main__":
    artifact, destination, source_sha, tooling_sha, module = sys.argv[1:]
    stage_frontend(Path(artifact), Path(destination), source_sha, tooling_sha, module)
