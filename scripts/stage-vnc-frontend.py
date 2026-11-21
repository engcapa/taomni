"""Add the independently built VNC renderer to a validated signing payload."""
import hashlib
import json
from pathlib import Path
import sys


def stage_frontend(built: Path, payload: Path, source: str, tooling: str) -> None:
    files = {path.name: path for path in built.iterdir()}
    if set(files) != {"index.js", "receipt.json"} or any(
        path.is_symlink() or not path.is_file() for path in files.values()
    ):
        raise ValueError("Unexpected files in VNC frontend artifact")
    javascript = files["index.js"].read_bytes()
    expected = {"sourceSha": source, "toolingSha": tooling, "sha256": hashlib.sha256(javascript).hexdigest()}
    if not javascript or json.loads(files["receipt.json"].read_text(encoding="utf-8")) != expected:
        raise ValueError("VNC frontend receipt does not match the selected source and entry bytes")
    manifest = json.loads((payload / "module.json").read_text(encoding="utf-8"))
    if manifest["slug"] != "vnc-client" or manifest["entry"]["frontend"] != "frontend/index.js":
        raise ValueError("VNC frontend path differs from the approved manifest")
    frontend = payload / "frontend"
    frontend.mkdir()
    (frontend / "index.js").write_bytes(javascript)


if __name__ == "__main__":
    artifact, destination, source_sha, tooling_sha = sys.argv[1:]
    stage_frontend(Path(artifact), Path(destination), source_sha, tooling_sha)
