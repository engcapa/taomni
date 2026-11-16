"""Inspect real signed feed/cache/archive/active pointer independently of UI."""
import hashlib
import json
from pathlib import Path

from .fixtures.module_download import plugin_root
from .fixtures.module_marketplace import ORIGIN
from .steps import StepError

PHASES = {"source", "no-download", "downloaded", "installed", "rejected"}


def run(ctx, args):
    if not isinstance(args, dict) or set(args) != {"phase"} or args["phase"] not in PHASES:
        raise StepError("module_marketplace_probe requires a registered fixed phase")
    owner = getattr(ctx, "fixture_context", None) or ctx
    origin = getattr(owner, "module_marketplace", None)
    if origin is None:
        raise StepError("module_marketplace fixture is required")
    root = plugin_root(ctx)
    phase = args["phase"]
    record = {"phase": phase, "passed": False}
    try:
        if phase == "source":
            # Only a transport preference, equivalent to the mirror input.
            # No catalog bytes, key, active pointer or install result is seeded.
            ctx.session.execute("localStorage.setItem('taomni.module-catalog-source.v1', " + json.dumps(ORIGIN + "/modules.json") + "); return true;")
        else:
            receipt = json.loads((Path(ctx.case_dir) / "official-module-fixture.json").read_text())
            archive_url = "/" + receipt["archive"]
            requests = list(origin.requests)
            record["requests"] = requests
            archive = root / ".downloads" / (receipt["sha256"] + ".taomni-plugin")
            if phase == "no-download":
                if archive_url in requests or archive.exists() or (root / "hello-plugin" / "active.json").exists():
                    raise StepError("Cancelling download confirmation must not transfer or activate a package")
            else:
                if requests.count(archive_url) != 1 or not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != receipt["sha256"]:
                    raise StepError("Marketplace did not download exactly one matching signed artifact")
                cache = json.loads((root / ".catalog-trust" / "catalog.json").read_text())
                if cache["payload"].encode() != origin.files["/modules.json"]:
                    raise StepError("Catalog rejection replaced the verified working cache")
                if phase in {"installed", "rejected"}:
                    pointer = json.loads((root / "hello-plugin" / "active.json").read_text())
                    if pointer.get("activeVersion") != "0.1.0":
                        raise StepError("Verified marketplace package was not atomically activated")
                    manifest = json.loads((root / "hello-plugin" / "versions" / "0.1.0" / "module.json").read_text())
                    if manifest.get("id") != receipt["id"] or manifest.get("version") != receipt["version"]:
                        raise StepError("Installed module identity differs from the signed selection")
                    record["pointer"] = pointer
                if phase == "rejected":
                    if not {"/modules-bad.json", "/modules-older.json"}.issubset(requests):
                        raise StepError("Both tampered and authenticated older feeds must reach the real verifier")
                    watermark = json.loads((root / ".catalog-trust" / "catalog-sequence.json").read_text())
                    if watermark.get("sequence") != 42:
                        raise StepError("Rejected feeds lowered the durable accepted sequence")
            record["passed"] = True
        record["passed"] = True
        return "module marketplace " + phase + " verified"
    finally:
        with (Path(ctx.case_dir) / "module-marketplace-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")
