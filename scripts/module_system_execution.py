"""Evidence helpers shared by the hosted system execution experiments."""
from __future__ import annotations

import json
from pathlib import Path
import subprocess

ROOT = Path(__file__).resolve().parent.parent


def select_harness(output, target="system_execution"):
    matches = set()
    for line in output.splitlines():
        try:
            row = json.loads(line)
        except ValueError:
            continue
        if (row.get("reason") == "compiler-artifact" and row.get("profile", {}).get("test") is True
                and row.get("target", {}).get("name") == target and row.get("executable")):
            matches.add(row["executable"])
    if len(matches) != 1:
        raise RuntimeError("Expected exactly one current-source system execution test executable")
    return Path(matches.pop()).resolve(strict=True)


def run_command(command, evidence, name, *, environment=None, check=True, timeout=60):
    try:
        result = subprocess.run(command, cwd=ROOT, env=environment, capture_output=True,
                                text=True, encoding="utf-8", errors="replace", timeout=timeout)
        output, code = result.stdout + result.stderr, result.returncode
    except subprocess.TimeoutExpired as error:
        chunks = [error.stdout or b"", error.stderr or b""]
        output = "\n".join(value.decode("utf-8", errors="replace") if isinstance(value, bytes)
                           else value for value in chunks) + "\nProcess deadline exceeded.\n"
        code = 124
    (evidence / (name + ".log")).write_text(output, encoding="utf-8")
    if check and code:
        raise RuntimeError(f"{name} failed (exit {code}); see its preserved log")
    return code, output
