"""Require independently observed OS outputs; never convert fixture gaps into passes."""
import json
import os
from pathlib import Path


def setup(ctx):
    path = os.environ.get("QA_MULTI_DISPLAY_FIXTURE")
    if not path or not Path(path).is_file():
        raise RuntimeError("dual-display native case needs an owned OS display fixture (QA_MULTI_DISPLAY_FIXTURE)")
    facts = json.loads(Path(path).read_text(encoding="utf-8"))
    if facts.get("kind") != "OS virtual outputs" or len(facts.get("monitors", [])) != 2:
        raise RuntimeError("OS did not establish two display outputs")
    if os.environ.get("XDG_SESSION_TYPE") == "wayland" and not facts.get("mixedDpi"):
        raise RuntimeError("Wayland OS outputs must have distinct 100% and 200% scales")
