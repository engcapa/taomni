"""Read atomically replaced product journals without losing the independent oracle."""

from __future__ import annotations

import json
import os
from pathlib import Path
import time
from typing import Any


def read_journal(path: Path, *, timeout_sec: float = 2.0) -> dict[str, Any]:
    deadline = time.monotonic() + timeout_sec
    while True:
        try:
            value = json.loads(path.read_text(encoding="utf-8"))
            if not isinstance(value, dict):
                raise ValueError(f"Backup journal is not an object: {path}")
            return value
        except OSError as error:
            # NamedTempFile.persist replaces the journal atomically. Windows
            # may briefly deny a reader while the replacement handle is open.
            # Only these lock/access errors retry; permanent denial still
            # escapes and becomes ORACLE_ERROR. Corrupt JSON never retries.
            if (os.name != "nt" or getattr(error, "winerror", None) not in {5, 32, 33}
                    or time.monotonic() >= deadline):
                raise
            time.sleep(0.02)
