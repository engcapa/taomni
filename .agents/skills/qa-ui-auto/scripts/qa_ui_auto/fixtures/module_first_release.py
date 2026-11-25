"""Read the signed first-release catalog and target packages from the same release build."""
from pathlib import Path
import json

from modular_bundle_inventory import digest
from .module_signed_archive import load_artifact


CATALOG = "modules-first-release.json"
MODULES = Path(__file__).resolve().parents[6] / "src-tauri/plugins"


def release_inputs(root, source, run_id, platform, origin, *, modules=MODULES):
    catalog_path = root / "catalog" / CATALOG
    signature = catalog_path.with_suffix(".json.minisig")
    producer = json.loads((catalog_path.parent / "receipt.json").read_text(encoding="utf-8"))
    if (producer.get("sourceSha") != source or producer.get("runId") != run_id
            or producer.get("catalogSha256") != digest(catalog_path)):
        raise RuntimeError("First-release catalog does not match its release build")
    raw = catalog_path.read_bytes()
    detached = signature.read_bytes()
    if f"trusted comment: file={CATALOG} sourceSha={source}" not in detached.decode().splitlines():
        raise RuntimeError("First-release catalog signature identifies a different source")
    catalog = json.loads(raw)
    frozen = json.loads((modules / "legacy-upgrade.json").read_text(encoding="utf-8"))
    if (not frozen or len(set(frozen)) != len(frozen) or catalog.get("legacyUpgrade") != frozen
            or set(catalog["plugins"]) != set(frozen)):
        raise RuntimeError("Signed first-release catalog differs from the frozen business roster")
    files = {"/" + CATALOG: raw, "/" + signature.name: detached}
    roster = {}
    for module_id in frozen:
        slug = module_id.removeprefix("taomni-plugin-")
        manifest = json.loads((modules / slug / "module.json").read_text(encoding="utf-8"))
        entry = catalog["plugins"][module_id]
        if (manifest["id"] != module_id or entry["id"] != module_id or entry["slug"] != slug
                or entry["version"] != manifest["version"] or set(entry["platforms"]) != set(manifest["platforms"])):
            raise RuntimeError(f"First-release catalog differs from the checked-out manifest for {slug}")
        if platform not in manifest["platforms"]:
            continue
        artifact = f"module-signed-{slug}-{platform}-{run_id}"
        receipt, archive, package_signature, _ = load_artifact(
            root / "packages" / artifact / "signed-module", source, platform, slug, version=manifest["version"],
        )
        asset = entry["platforms"][platform]
        expected = {"url": f"{origin}/{archive.name}", "size": receipt["size"],
                    "sha256": receipt["sha256"], "signature": package_signature.strip()}
        if asset != expected or {"artifact": artifact, "package": receipt} not in producer["packages"]:
            raise RuntimeError(f"First-release package {slug} differs from its signed catalog or build receipt")
        roster[module_id] = receipt
        files["/" + archive.name] = archive
    if not roster:
        raise RuntimeError(f"First-release roster contains no package for {platform}")
    return files, roster, producer
