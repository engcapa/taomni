"""Read the real core generation; never seed or overwrite profile metadata."""
import json
from pathlib import Path
import uuid

from .backup_policy import isolated_data_root


def setup(ctx):
    path = isolated_data_root(ctx) / ".profile-state.json"
    # Fixtures run before NativeSession starts the app. Register only the
    # owned path; the asserting step reads metadata after core bootstrap.
    ctx.values["core_profile_state_path"] = str(path)


def read_generation(path: Path) -> str:
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("Missing or unsafe core profile state")
    metadata = path.stat()
    if metadata.st_size > 4096 or getattr(metadata, "st_file_attributes", 0) & 0x400:
        raise RuntimeError("Missing or unsafe core profile state")
    raw = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        raise RuntimeError("Invalid core profile state")
    generation = raw.get("generation")
    if type(raw.get("formatVersion")) is not int or raw["formatVersion"] != 1 or set(raw) != {"formatVersion", "generation"}:
        raise RuntimeError("Unsupported core profile state")
    try:
        value = uuid.UUID(generation)
        if value.int == 0 or str(value) != generation:
            raise ValueError("noncanonical generation")
    except (ValueError, TypeError, AttributeError) as error:
        raise RuntimeError("Invalid core profile generation") from error
    return generation
