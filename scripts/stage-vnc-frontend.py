"""Add a verified module renderer to a validated signing payload."""
import hashlib
import json
from pathlib import Path
import sys


SCREENSHOT_ASSETS = {
    "worker.min.js", "eng.traineddata.gz", "chi_sim.traineddata.gz",
    "Tesseract-LICENSE.txt", "Tesseract-core-LICENSE.txt",
    *(f"tesseract-core{variant}.wasm{extension}"
      for variant in ("", "-simd", "-lstm", "-simd-lstm") for extension in ("", ".js")),
}


def frontend_files(built: Path, slug: str, *, with_receipt: bool) -> dict[str, Path]:
    if slug not in {"rdp-client", "vnc-client", "mail", "screenshot"}:
        raise ValueError("Unexpected module")
    expected = {"index.js"}
    directories = {"screenshot-ocr"} if slug == "screenshot" else set()
    if directories:
        expected.add("recorder.js")
        expected.update(f"screenshot-ocr/{name}" for name in SCREENSHOT_ASSETS)
    if with_receipt:
        expected.add("receipt.json")
    files = {}
    for path in built.rglob("*"):
        name = path.relative_to(built).as_posix()
        if path.is_symlink() or (path.is_dir() and name not in directories):
            raise ValueError("Unexpected path in module frontend artifact")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError("Unexpected file in module frontend artifact")
        files[name] = path
    if set(files) != expected:
        raise ValueError("Unexpected files in module frontend artifact")
    return files


def frontend_receipt(files: dict[str, Path], source: str, tooling: str, slug: str) -> dict:
    digests = {}
    for name, artifact in sorted(files.items()):
        with artifact.open("rb") as stream:
            digests[name] = hashlib.file_digest(stream, "sha256").hexdigest()
        if artifact.stat().st_size == 0:
            raise ValueError("Empty module frontend file")
    receipt = {"sourceSha": source, "toolingSha": tooling, "slug": slug, "sha256": digests["index.js"]}
    if slug == "screenshot":
        receipt["files"] = digests
    return receipt


def stage_frontend(built: Path, payload: Path, source: str, tooling: str, slug: str) -> None:
    files = frontend_files(built, slug, with_receipt=True)
    receipt = json.loads(files.pop("receipt.json").read_text(encoding="utf-8"))
    if receipt != frontend_receipt(files, source, tooling, slug):
        raise ValueError("Frontend receipt does not match the selected source and entry bytes")
    manifest = json.loads((payload / "module.json").read_text(encoding="utf-8"))
    if manifest["slug"] != slug or manifest["entry"]["frontend"] != "frontend/index.js":
        raise ValueError("Frontend path differs from the approved module manifest")
    frontend = payload / "frontend"
    frontend.mkdir()
    for name, artifact in files.items():
        destination = frontend / name
        destination.parent.mkdir(parents=True, exist_ok=True)
        destination.write_bytes(artifact.read_bytes())


if __name__ == "__main__":
    artifact, destination, source_sha, tooling_sha, module = sys.argv[1:]
    root = Path(artifact)
    if destination == "--receipt":
        files = frontend_files(root, module, with_receipt=False)
        (root / "receipt.json").write_text(json.dumps(frontend_receipt(files, source_sha, tooling_sha, module)) + "\n", encoding="utf-8")
    else:
        stage_frontend(root, Path(destination), source_sha, tooling_sha, module)
