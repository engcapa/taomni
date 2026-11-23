"""Provision pinned OCR language data for hosted native screenshot cases."""
from __future__ import annotations

import hashlib
import os
from pathlib import Path
import shutil
import subprocess
import time
from urllib.error import HTTPError, URLError
import urllib.request

REVISION = "65727574dfcd264acbb0c3e07860e4e9e9b22185"
LANGUAGES = {
    "eng": "7d4322bd2a7749724879683fc3912cb542f19906c83bcc1a52132556427170b2",
    "chi_sim": "a5fcb6f0db1e1d6d8522f39db4e848f05984669172e584e8d76b6b3141e1f730",
}

def download_language(language: str, directory: Path, expected: str) -> None:
    url = f"https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/{REVISION}/{language}.traineddata"
    for delay in (2, 4, None):
        try:
            with urllib.request.urlopen(url, timeout=45) as response:
                data = response.read()
        except (URLError, TimeoutError, ConnectionError) as error:
            if delay is None or isinstance(error, HTTPError) and error.code not in {429, 500, 502, 503, 504}:
                raise
            print(f"Retrying OCR language {language} after {error}", flush=True)
            time.sleep(delay)
        else:
            if hashlib.sha256(data).hexdigest() != expected:
                raise RuntimeError(f"OCR language data checksum mismatch: {language}")
            (directory / f"{language}.traineddata").write_bytes(data)
            return


def provision(directory: Path) -> None:
    executable = shutil.which("tesseract")
    if not executable:
        raise RuntimeError("Tesseract executable missing after platform installation")
    directory.mkdir(parents=True, exist_ok=True)
    for language, expected in LANGUAGES.items():
        download_language(language, directory, expected)
    env = {**os.environ, "TESSDATA_PREFIX": str(directory.resolve())}
    result = subprocess.check_output([executable, "--list-langs"], text=True, env=env)
    if not set(LANGUAGES) <= set(result.splitlines()):
        raise RuntimeError(f"OCR language readiness failed: {result}")
    with Path(os.environ["GITHUB_ENV"]).open("a", encoding="utf-8") as output:
        output.write(f"TESSDATA_PREFIX={directory.resolve()}\n")
    print(result.strip())


if __name__ == "__main__":
    provision(Path(os.environ["RUNNER_TEMP"]) / "taomni-qa-tessdata")
