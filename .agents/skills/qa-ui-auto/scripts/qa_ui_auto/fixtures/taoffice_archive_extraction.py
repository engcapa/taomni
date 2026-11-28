"""Compressible backlog for observing real extraction and its member checkpoints."""
from __future__ import annotations

import hashlib
import io
import zipfile


def archive(first: bytes) -> tuple[bytes, str]:
    large = b"TaOffice archive extraction fixture.\n" * 786_432
    result = io.BytesIO()
    with zipfile.ZipFile(result, "w", compression=zipfile.ZIP_DEFLATED, compresslevel=1) as bundle:
        bundle.writestr("notes/readme.txt", first)
        for index in range(512):
            bundle.writestr(f"series/file-{index:04}.txt", first)
        for index in range(5):
            bundle.writestr(f"payload/chunk-{index:02}.bin", large)
    return result.getvalue(), hashlib.sha256(large).hexdigest()
