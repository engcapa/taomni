"""Inspect real signed feed/cache/archive/active pointer independently of UI."""
import hashlib
import json
from pathlib import Path
import time

from modular_bundle_inventory import digest
from .fixtures.module_download import plugin_root
from .fixtures.module_legacy_install import retained_manifest, session_rows
from .fixtures.module_marketplace import BASELINE_CATALOG, LATER_ROSTER_CATALOG, NEW_MODULE_CATALOG, NEW_MODULE_SEQUENCE, ORIGIN
from .module_retained_observation import assert_code_removed
from .module_update_observation import VERSION_STATES, observe as observe_update
from .steps import StepError

NEW_MODULE_PHASES = {"new-available", "new-dismissed", "legacy-new-available"}
PHASES = {"source", "no-download", "downloaded", "installed", "rejected", "legacy-installed", "legacy-uninstalled"} | NEW_MODULE_PHASES


def observe_new_module(root, origin, receipt, phase, archive):
    if archive.exists() or archive.with_suffix(".part").exists() or "/" + receipt["archive"] in origin.requests:
        raise StepError("An optional module transferred data before user consent")
    if (root / receipt["slug"] / "active.json").exists():
        raise StepError("An optional module was activated before user consent")
    catalogs = [LATER_ROSTER_CATALOG] if phase == "legacy-new-available" else [BASELINE_CATALOG, NEW_MODULE_CATALOG]
    if not {"/" + name for name in catalogs}.issubset(origin.requests):
        raise StepError("The signed releases must reach the native verifier")
    release = json.loads((root.parent / ".module-release.json").read_text())
    expected = [] if phase == "new-dismissed" else [receipt["id"]]
    if (
        release["sequence"] != NEW_MODULE_SEQUENCE
        or receipt["id"] not in release["seen"]
        or release["newModules"] != expected
    ):
        raise StepError("The signed catalog change and user choice must be persisted for this profile")
    return release


def observe_legacy_roster(root, origin, removed):
    pointers = {}
    for entry in origin.roster.values():
        slug, version = entry["slug"], entry["version"]
        archive = root / ".downloads" / (entry["sha256"] + ".taomni-plugin")
        if origin.requests.count("/" + entry["archive"]) != 1 or not archive.is_file() or digest(archive) != entry["sha256"]:
            raise StepError(f"First upgrade did not transfer exactly one signed package for {slug}")
        owner = root / slug
        pointer = json.loads((owner / "active.json").read_text(encoding="utf-8"))
        if slug == removed:
            if pointer["activeVersion"] is not None or pointer["previousVersion"] != version:
                raise StepError("Restart reinstalled the module that the user removed")
            assert_code_removed(owner)
        else:
            if pointer["activeVersion"] != version:
                raise StepError(f"First upgrade did not activate the roster's signed version for {slug}")
            proof = owner / "versions" / version / ".taomni-trust/package.taomni-plugin"
            if digest(proof) != entry["sha256"]:
                raise StepError(f"Installed signed package does not match the roster for {slug}")
        pointers[slug] = pointer
    return pointers


def run(ctx, args):
    if not isinstance(args, dict) or set(args) != {"phase"} or args["phase"] not in PHASES | VERSION_STATES.keys():
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
            source = f"{ORIGIN}/{origin.start_catalog}"
            ctx.session.execute("localStorage.setItem('taomni.module-catalog-source.v1', " + json.dumps(source) + "); return true;")
        elif phase in VERSION_STATES:
            record.update(observe_update(ctx, root, phase, origin))
        else:
            first_input = Path(ctx.case_dir) / "first-upgrade-input.json"
            first_upgrade = json.loads(first_input.read_text(encoding="utf-8")) if first_input.exists() else None
            if phase in {"legacy-installed", "legacy-new-available"}:
                enrollment_path = root.parent / ".module-release.json"
                deadline = time.monotonic() + (180 if first_upgrade and first_upgrade.get("releaseRun") else 45)
                while time.monotonic() < deadline:
                    if enrollment_path.is_file() and json.loads(enrollment_path.read_text()).get("legacyPending") == []:
                        break
                    time.sleep(0.1)
            if first_upgrade:
                receipt = origin.roster["taomni-plugin-" + first_upgrade["removed"]]
                record.update(sourceSha=first_upgrade["sourceSha"], platform=first_upgrade["platform"],
                              catalog=first_upgrade["catalog"], releaseRun=first_upgrade.get("releaseRun"))
            else:
                receipt = json.loads((Path(ctx.case_dir) / "official-module-fixture.json").read_text())
            archive_url = "/" + receipt["archive"]
            requests = list(origin.requests)
            record["requests"] = requests
            archive = root / ".downloads" / (receipt["sha256"] + ".taomni-plugin")
            if phase == "no-download":
                if archive_url in requests or archive.exists() or (root / "hello-plugin" / "active.json").exists():
                    raise StepError("Cancelling download confirmation must not transfer or activate a package")
            elif phase in NEW_MODULE_PHASES:
                record["release"] = observe_new_module(root, origin, receipt, phase, archive)
                if phase == "legacy-new-available":
                    release = record["release"]
                    if release["origin"] != "legacy" or release["legacyPending"] != []:
                        raise StepError("First installation did not finish for the legacy profile")
                    if set(release["seen"]) != {*origin.roster, receipt["id"]}:
                        raise StepError("The profile must remember both modules in the signed release")
                    record["rosterPointers"] = observe_legacy_roster(root, origin, None)
            else:
                if requests.count(archive_url) != 1 or not archive.is_file() or hashlib.sha256(archive.read_bytes()).hexdigest() != receipt["sha256"]:
                    raise StepError("Marketplace did not download exactly one matching signed artifact")
                cache = json.loads((root / ".catalog-trust" / "catalog.json").read_text())
                if cache["payload"].encode() != origin.current_catalog:
                    raise StepError("Catalog rejection replaced the verified working cache")
                if phase in {"installed", "rejected", "legacy-installed", "legacy-uninstalled"}:
                    module = root / receipt["slug"]
                    pointer = json.loads((module / "active.json").read_text())
                    if phase == "legacy-uninstalled":
                        if pointer["activeVersion"] is not None or pointer["previousVersion"] != receipt["version"]:
                            raise StepError("Restart reinstalled a module that the user removed")
                        assert_code_removed(module)
                        record["codeAbsent"] = True
                    else:
                        if pointer.get("activeVersion") != receipt["version"]:
                            raise StepError("Verified marketplace package was not atomically activated")
                        manifest = json.loads((module / "versions" / receipt["version"] / "module.json").read_text())
                        if manifest.get("id") != receipt["id"] or manifest.get("version") != receipt["version"]:
                            raise StepError("Installed module identity differs from the signed selection")
                    record["pointer"] = pointer
                if phase.startswith("legacy-"):
                    enrollment = json.loads((root.parent / ".module-release.json").read_text())
                    if enrollment.get("origin") != "legacy" or enrollment.get("legacyPending") != []:
                        raise StepError("First installation was not recorded as complete for the legacy profile")
                    record["enrollment"] = enrollment
                    if first_upgrade and (set(enrollment["seen"]) != set(origin.roster) or enrollment["newModules"]):
                        raise StepError("First installation did not acknowledge exactly the compatible roster")
                    if first_upgrade and phase == "legacy-uninstalled":
                        current = ctx.session.execute("""
                          return Array.from(document.querySelectorAll('[data-testid="module-marketplace-current"]'),
                            node => node.closest('[data-module-id]').getAttribute('data-module-id')).sort();
                        """)
                        if current != sorted(set(origin.roster) - {receipt["id"]}):
                            raise StepError("Restart did not restore exactly the remaining modules in the store")
                        legacy = owner.module_upgrade
                        if (session_rows(legacy["root"]) != legacy["full_sessions"]
                                or retained_manifest(legacy["root"]) != legacy["retained"]):
                            raise StepError("First upgrade changed the original sessions or historical chat files")
                        record["remainingModules"] = current
                        record["legacySessionIds"] = [row["id"] for row in legacy["full_sessions"]]
                    if getattr(origin, "roster", None):
                        removed = receipt["slug"] if phase == "legacy-uninstalled" else None
                        record["rosterPointers"] = observe_legacy_roster(root, origin, removed)
                if phase == "rejected":
                    if not {"/modules-bad.json", "/modules-older.json"}.issubset(requests):
                        raise StepError("Both tampered and authenticated older feeds must reach the real verifier")
                    watermark = json.loads((root / ".catalog-trust" / "catalog-sequence.json").read_text())
                    if watermark.get("sequence") != 42:
                        raise StepError("Rejected feeds lowered the durable accepted sequence")
        record["passed"] = True
        return "module marketplace " + phase + " verified"
    finally:
        with (Path(ctx.case_dir) / "module-marketplace-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(record) + "\n")
