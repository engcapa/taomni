"""Real signed macOS release bytes served from a run-owned loopback fixture."""
from __future__ import annotations

import hashlib
import json
from pathlib import Path
import plistlib
import shutil
import subprocess
import tarfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.request import urlopen

TAG = "v0.4.29"
ASSETS = {
    "aarch64": ("Taomni_aarch64.app.tar.gz", "5d3081a8cb576e0599054076527175b7374495b25bc091d9c63c4e3793fd9b57", "1fd91c5e0f55c5dcc9c74f19f52a9385bf621adb55a1452da5203cd5a091a23b"),
    "x86_64": ("Taomni_x64.app.tar.gz", "c536d3580dc1e1852e834cb781414e3c9e1f3a1d7de7da3c06ee2e4427c2149d", "f0cb7711d297786e4f447c366a19c33bfcb626933529c5a5d6d03da4f4f7250c"),
}
ACTIVE = None


def digest(path: Path) -> str:
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def download_asset(root: Path, name: str, expected: str) -> Path:
    path = root / name
    if path.exists() and digest(path) == expected:
        return path
    url = f"https://github.com/engcapa/taomni/releases/download/{TAG}/{name}"
    for attempt in range(3):
        try:
            with urlopen(url, timeout=60) as response, path.open("wb") as output:
                shutil.copyfileobj(response, output)
            if digest(path) != expected:
                raise ValueError(f"Release asset SHA256 mismatch: {name}")
            return path
        except Exception:
            path.unlink(missing_ok=True)
            if attempt == 2:
                raise
            time.sleep(2 ** attempt)
    raise RuntimeError("unreachable")


class UpdaterFixture:
    def __init__(self, case_dir: Path, cache: Path, profile: Path, *, mode: str):
        self.case_dir, self.profile = case_dir.resolve(), profile
        self.install_root = self.case_dir / "Disposable.app"
        self.install_root.joinpath("Contents/MacOS").mkdir(parents=True)
        self.executable = self.install_root / "Contents/MacOS/taomni"
        self.executable.write_bytes(b"#!/bin/sh\nexit 0\n")
        self.executable.chmod(0o755)
        self.baseline = digest(self.executable)
        self.events = self.case_dir / "updater-http.jsonl"
        self.expected = {}
        artifacts = self.case_dir / "artifacts"
        cache.mkdir(parents=True, exist_ok=True)
        for arch, (name, bundle_hash, sig_hash) in ASSETS.items():
            bundle = download_asset(cache, name, bundle_hash)
            sig = download_asset(cache, name + ".sig", sig_hash)
            destination = artifacts / f"taomni-{TAG[1:]}-macos-{arch}" / "Taomni.app.tar.gz"
            destination.parent.mkdir(parents=True)
            shutil.copyfile(bundle, destination)
            shutil.copyfile(sig, str(destination) + ".sig")
            with tarfile.open(bundle) as archive:
                binary = archive.extractfile("Taomni.app/Contents/MacOS/taomni")
                plist = archive.extractfile("Taomni.app/Contents/Info.plist")
                if binary is None or plist is None:
                    raise ValueError("Release lacks its real executable or Info.plist")
                self.expected[arch] = {"bundle_sha256": bundle_hash, "binary_sha256": hashlib.file_digest(binary, "sha256").hexdigest(), "version": plistlib.loads(plist.read())["CFBundleShortVersionString"]}
        self.staged = self.case_dir / "staged"
        script = (Path.cwd() / "scripts/compose-updater-manifest.mjs").resolve()
        command = ["node", "--input-type=module", "-e",
                   "const {composeUpdaterManifest} = await import(process.argv[1]); "
                   "composeUpdaterManifest(JSON.parse(process.argv[2]));", script.as_uri(),
                   json.dumps({"artifactsDir": str(artifacts), "outputDir": str(self.staged), "tag": TAG,
                               "repository": "engcapa/taomni", "requiredPlatforms": ["darwin-aarch64", "darwin-x86_64"]})]
        subprocess.run(command, check=True, capture_output=True, text=True)
        self.manifest = json.loads((self.staged / "latest.json").read_text())
        self.lock = threading.Lock()
        self.slow_count = 0
        self.gates = [threading.Event(), threading.Event()]
        self.done = [threading.Event(), threading.Event()]
        owner = self

        class Handler(BaseHTTPRequestHandler):
            def do_GET(self):
                owner.serve(self)

            def log_message(self, *args):
                pass

        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)
        self.thread.start()
        self.set_mode(mode)
        (self.case_dir / "updater-source.json").write_text(json.dumps({"release": TAG, "assets": self.expected, "manifest_generator": str(script)}, indent=2))

    def log(self, **event):
        with self.lock, self.events.open("a") as output:
            output.write(json.dumps(event) + "\n")

    def set_mode(self, mode: str):
        if mode not in {"correct", "broken", "slow"}:
            raise ValueError(f"Unsupported updater fixture mode: {mode}")
        self.profile.mkdir(parents=True, exist_ok=True)
        self.profile.joinpath("updater-qa.json").write_text(json.dumps({
            "endpoint": f"http://127.0.0.1:{self.server.server_port}/{mode}/latest.json",
            "installRoot": str(self.install_root),
        }))

    def serve(self, handler):
        parts = handler.path.split("/")
        if len(parts) != 3 or parts[1] not in {"correct", "broken", "slow"}:
            handler.send_error(404)
            return
        mode, name = parts[1:]
        if name == "latest.json":
            manifest = json.loads(json.dumps(self.manifest))
            for target, entry in manifest["platforms"].items():
                asset = entry["url"].rsplit("/", 1)[-1]
                if mode == "broken":
                    asset = "Taomni_0.4.29_x86_64.app.tar.gz"
                entry["url"] = f"http://127.0.0.1:{self.server.server_port}/{mode}/{asset}"
            body = json.dumps(manifest).encode()
            handler.send_response(200)
            handler.send_header("Content-Type", "application/json")
            handler.send_header("Content-Length", str(len(body)))
            handler.end_headers()
            handler.wfile.write(body)
            self.log(kind="manifest", mode=mode)
            return
        path = self.staged / name
        if name not in {"Taomni_0.4.29_aarch64.app.tar.gz", "Taomni_0.4.29_x86_64.app.tar.gz"} or not path.is_file():
            handler.send_error(404)
            return
        size = path.stat().st_size
        index = None
        if mode == "slow":
            with self.lock:
                index = self.slow_count
                self.slow_count += 1
            if index >= 2:
                handler.send_error(409, "Only two controlled transfers are expected")
                return
        handler.send_response(200)
        handler.send_header("Content-Length", str(size))
        handler.end_headers()
        sent = 0
        threshold = int(size * (0.2 if index == 0 else 0.6)) if index is not None else size
        try:
            with path.open("rb") as stream:
                while chunk := stream.read(65536):
                    handler.wfile.write(chunk)
                    sent += len(chunk)
                    if index is not None and sent >= threshold:
                        self.log(kind="paused", transfer=index + 1, bytes=sent, total=size)
                        if not self.gates[index].wait(120):
                            raise TimeoutError("Controlled transfer was never released")
                        threshold = size + 1
            self.log(kind="complete", mode=mode, transfer=index + 1 if index is not None else None, bytes=sent)
        except (BrokenPipeError, ConnectionResetError):
            self.log(kind="disconnected", mode=mode, transfer=index + 1 if index is not None else None, bytes=sent)
        finally:
            if index is not None:
                self.done[index].set()

    def stop(self):
        for gate in self.gates:
            gate.set()
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)
        self.profile.joinpath("updater-qa.json").unlink(missing_ok=True)


def stop_active():
    global ACTIVE
    if ACTIVE is not None:
        ACTIVE.stop()
        ACTIVE = None
