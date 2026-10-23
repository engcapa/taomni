"""Install the fixed QA protoc without enumerating GitHub release history."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import platform
import shutil
import subprocess
import tempfile
import time
from urllib.error import URLError
from urllib.request import urlopen
import zipfile

VERSION = "23.4"
# SHA-256 of the official v23.4 release archives, fetched over HTTPS.
ARCHIVES = {
    ("Linux", "x86_64"): ("linux-x86_64", "0502f286ac9ed860b629a7965a14527b1f2dd131e4283fa23c2d7f184672aa9a"),
    ("Windows", "amd64"): ("win64", "a309c39442fb75f0db343cb22c111a00f91cdf0767f332e170644b9378e2bcc6"),
    ("Darwin", "arm64"): ("osx-aarch_64", "8c7afae8626b6811e7b5897d16d940c2dbf50b1e135ed958a01db6566bdda726"),
    ("Darwin", "x86_64"): ("osx-x86_64", "07e5fdcf1b0708d3367dc5e6eb8d135de7e407d75316c93155cfd8ab362eec80"),
}


def download(url: str, destination: Path) -> None:
    for attempt in range(3):
        try:
            print(f"Downloading {url} (attempt {attempt + 1}/3)", flush=True)
            with urlopen(url, timeout=30) as response, destination.open("wb") as output:
                shutil.copyfileobj(response, output)
            return
        except (OSError, URLError) as error:
            destination.unlink(missing_ok=True)
            if attempt == 2:
                raise
            print(f"Download failed: {error}; retrying", flush=True)
            time.sleep(attempt + 1)


def install(root: Path, system: str, machine: str) -> Path:
    suffix, expected = ARCHIVES[(system, machine.lower())]
    root.mkdir(parents=True, exist_ok=True)
    destination = root / f"taomni-protoc-{VERSION}-{suffix}"
    with tempfile.TemporaryDirectory(prefix="qa-protoc-", dir=root) as temp:
        work = Path(temp)
        archive = work / "protoc.zip"
        download(f"https://github.com/protocolbuffers/protobuf/releases/download/v{VERSION}/"
                 f"protoc-{VERSION}-{suffix}.zip", archive)
        actual = hashlib.sha256(archive.read_bytes()).hexdigest()
        if actual != expected:
            raise RuntimeError(f"protoc archive SHA-256 mismatch: expected {expected}, got {actual}")
        unpacked = work / "unpacked"
        with zipfile.ZipFile(archive) as zipped:
            zipped.extractall(unpacked)
        executable = unpacked / "bin" / ("protoc.exe" if system == "Windows" else "protoc")
        executable.chmod(0o755)
        version = subprocess.check_output([str(executable), "--version"], text=True, timeout=15).strip()
        if version != f"libprotoc {VERSION}":
            raise RuntimeError(f"Unexpected protoc version: {version}")
        if destination.exists():
            shutil.rmtree(destination)
        unpacked.replace(destination)
    return destination / "bin"


def main() -> None:
    installed = install(Path(os.environ["RUNNER_TEMP"]), platform.system(), platform.machine())
    with Path(os.environ["GITHUB_PATH"]).open("a", encoding="utf-8") as output:
        output.write(str(installed) + "\n")
    print(f"Verified protoc {VERSION}: {installed}", flush=True)


if __name__ == "__main__":
    main()
