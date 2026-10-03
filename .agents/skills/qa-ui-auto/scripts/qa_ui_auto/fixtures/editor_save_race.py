"""ED-PARITY-002 isolated one-file save-race fixture (native only).

Creates a fresh host directory whose `edit.txt` is exactly the reference
fixture B0 bytes (UTF-8, no BOM, LF, 39 bytes):

    alpha Alpha ALPHA
    tree tree
    line three

and exposes the root as `${fixture.workspace_root}` so the case enters it
through persisted recents. The file is written as raw bytes so Windows text
translation can never alter the declared LF/UTF-8 identity.

Cases that need the BOM+CRLF variant derive it from these exact bytes inside
the case (encoding switch + EOL switch), never from a pre-baked copy.
"""

from __future__ import annotations

import hashlib
import json
import tempfile
from pathlib import Path
from typing import Any

B0_TEXT = "alpha Alpha ALPHA\ntree tree\nline three\n"
B0_BYTES = B0_TEXT.encode("utf-8")
B0_SHA256 = "2b7edc22ece15ead9636ecf67c54fa5e48bb7c4325409a7651fda976073ae88d"
B1_SHA256 = "77e11801e1006d4d36d0abb43cf57a9964954445acea8c6d017689796fa38172"
B2_SHA256 = "75699982db826f8191ba939313abc59ee80b767b1e2a51776a17f81585317900"
E1_TEXT = "EXTERNAL\n"
E1_SHA256 = "c0cd94660e03e9ce34eccf2ebff469c2ee8b1d331e557ddfe9f473781f6c3ea9"

# Each race branch starts from its own independent B0 copy (the design requires
# per-branch restarts; one shared file cannot keep B0/B1/B2 baselines apart).
SEED_FILES = (
    "edit.txt",            # S0/S1 normal save + S3 stable-base undo
    "edit-w0.txt",         # S2-W0 prepare hold, cancelled with disk still B0
    "edit-w1.txt",         # S2-W1 ack hold, disk B1
    "edit-w2.txt",         # S2-W2 watcher hold, disk B1
    "edit-conflict.txt",   # S4 Esc/Decide Later on a real external rewrite
    "edit-conflict2.txt",  # S5 Load Disk explicit restore
    "edit-encoding.txt",   # S6 encoding failure + BOM/CRLF variant
    "edit-unknown.txt",    # S7 intended: controlled response loss -> committed
    "edit-unknown-old.txt",        # S7 old: delayed response + old bytes restored
    "edit-unknown-foreign.txt",    # S7 foreign: delayed response + foreign bytes
    "edit-close.txt",      # S8 owner invalidation during the ack hold
)


def setup(ctx: Any) -> None:
    from . import FixtureSkip  # lazy: avoid package-init circular import

    cfg = getattr(ctx, "cfg", {}) or {}
    mode = (cfg.get("app") or {}).get("mode", "browser")
    if mode != "native":
        raise FixtureSkip(
            "editor_save_race provisions a host file; browser VFS cannot observe real bytes"
        )
    payload = B0_BYTES
    if hashlib.sha256(payload).hexdigest() != B0_SHA256:
        raise RuntimeError("editor_save_race: fixture text no longer matches the reference B0 hash")
    report_root = Path(getattr(ctx, "report_root", Path("qa-ui-auto-report"))).resolve()
    base = report_root / "native-workspaces"
    base.mkdir(parents=True, exist_ok=True)
    case_id = str(getattr(ctx, "case_id", "case"))
    worker = int(getattr(ctx, "worker_id", 0))
    root = Path(tempfile.mkdtemp(prefix=f"{case_id}-w{worker}-", dir=str(base)))
    for name in SEED_FILES:
        (root / name).write_bytes(payload)
    target = root / "edit.txt"
    observed = hashlib.sha256(target.read_bytes()).hexdigest()
    if observed != B0_SHA256:
        raise RuntimeError(f"editor_save_race: seeded edit.txt hash {observed} != {B0_SHA256}")
    manifest = {
        "case": case_id,
        "files": [name for name in SEED_FILES],
        "path": target.as_posix(),
        "sha256": observed,
        "bytes": len(payload),
        "text": B0_TEXT,
        "referenceHashes": {"B1": B1_SHA256, "B2": B2_SHA256, "E1": E1_SHA256},
        "e1Text": E1_TEXT,
    }
    (root / "fixture-manifest.json").write_text(
        json.dumps(manifest, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    values: dict[str, str] = getattr(ctx, "values")
    values["workspace_root"] = root.as_posix()
    values["save_race_file"] = target.as_posix()


def teardown(ctx: Any) -> None:
    # Keep the tree as evidence until report rotation prunes it.
    return None
