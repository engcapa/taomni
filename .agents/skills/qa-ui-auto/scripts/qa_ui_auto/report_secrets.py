"""Redact disposable service credentials before the runner signs its artifacts."""
from __future__ import annotations
import io
import json
import os
from pathlib import Path
import zipfile


def redact_report(root: Path):
    values = [os.environ[key] for key in ("QA_SSH_PASSWORD", "TAOMNI_TEST_MYSQL_PASSWORD", "QA_MYSQL_ROOT_PASSWORD")
              if os.environ.get(key)]
    if not values:
        return
    replacements = set()
    for value in values:
        replacements.update((value.encode(), json.dumps(value)[1:-1].encode()))

    def redact(data):
        for value in replacements:
            data = data.replace(value, b"<redacted>")
        return data

    for path in root.rglob("*"):
        if not path.is_file() or {"native-appdata", "native-appconfig", "native-appcache"}.intersection(path.parts):
            continue
        if path.suffix == ".zip" and path.name == "trace.zip":
            result = io.BytesIO()
            with zipfile.ZipFile(path) as source, zipfile.ZipFile(result, "w", zipfile.ZIP_DEFLATED) as target:
                for entry in source.infolist():
                    raw = source.read(entry)
                    if not entry.filename.endswith((".png", ".jpeg", ".jpg")):
                        raw = redact(raw)
                    target.writestr(entry, raw)
            path.write_bytes(result.getvalue())
        elif path.suffix in {".json", ".html", ".log", ".txt", ".md", ".xml", ".yaml"}:
            data = path.read_bytes()
            cleaned = redact(data)
            if data != cleaned:
                path.write_bytes(cleaned)
