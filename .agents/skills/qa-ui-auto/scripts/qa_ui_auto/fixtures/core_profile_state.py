"""Read the real core generation; never seed or overwrite profile metadata."""
import json
import uuid

from .backup_policy import isolated_data_root


def setup(ctx):
    path = isolated_data_root(ctx) / ".profile-state.json"
    if path.is_symlink() or not path.is_file() or path.stat().st_size > 4096:
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
    ctx.values.update(core_profile_state_path=str(path), core_profile_generation=generation)
