"""Observe one rejected MFA maintenance invocation on a run-owned executable."""

from pathlib import Path
import subprocess
from tempfile import TemporaryDirectory

from .deadline import remaining_timeout


def observe_foreign_executable(application: Path, profile: Path, evidence: Path) -> dict:
    with TemporaryDirectory(dir=evidence) as directory:
        other = Path(directory) / "other-program"
        other.write_bytes(b"QA fixture")
        result = subprocess.run([
            str(application), "--complete-mfa-upgrade", str(profile),
            str(other), str(other), "unused", str(other),
        ], stdin=subprocess.DEVNULL, capture_output=True, text=True,
           encoding="utf-8", errors="replace", timeout=remaining_timeout(15))
    return {
        "exitCode": result.returncode,
        "stderr": result.stderr.strip(),
        "rejected": result.returncode == 1
        and "MFA upgrade must relaunch its own Taomni executable" in result.stderr,
    }
