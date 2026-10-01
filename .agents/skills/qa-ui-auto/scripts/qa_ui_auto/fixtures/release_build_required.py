"""release_build_required: the native app under test is a release QA build.

Performance cases compare against budgets and reference servers, which is
meaningless for an unoptimised debug binary. CI maps this fixture to the
``release`` capability (ci.py), which makes ci_execute build with
``native_build.py --release`` and point ``app.native_binary`` at it.

Locally: run ``python .agents/skills/qa-ui-auto/scripts/native_build.py
--release`` and set ``app.native_binary`` to the release binary. A debug or
unrecorded binary skips the case with the reason instead of measuring it.
"""

from __future__ import annotations

import sys
from pathlib import Path
from typing import Any


def setup(ctx: Any) -> None:
    from . import FixtureSkip

    cfg = getattr(ctx, "cfg", {}) or {}
    app = cfg.get("app") or {}
    if app.get("mode", "browser") != "native":
        raise FixtureSkip("release builds only apply to native cases")
    scripts = Path(__file__).resolve().parents[2]
    sys.path.insert(0, str(scripts))
    from native_build import qa_binary, verify_identity  # type: ignore[import-not-found]

    binary = Path(str(app.get("native_binary") or qa_binary())).expanduser()
    try:
        record = verify_identity(binary)
    except ValueError as exc:
        raise FixtureSkip(f"no verified QA build at {binary}: {exc}") from exc
    if record.get("profile") != "release":
        raise FixtureSkip(
            f"performance case needs a release QA build; {binary.name} is a "
            f"{record.get('profile')} build (native_build.py --release)"
        )
