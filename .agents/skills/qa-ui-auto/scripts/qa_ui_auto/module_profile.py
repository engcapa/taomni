"""Establish and verify the installation state of hosted crash-regression cases."""
import json
import os
from pathlib import Path
import re
import shutil
import time
from types import SimpleNamespace
from urllib.parse import urlsplit

from .deadline import Deadline


def roster():
    root = Path("src-tauri/plugins")
    modules = {}
    for module_id in json.loads((root / "legacy-upgrade.json").read_bytes()):
        slug = module_id.removeprefix("taomni-plugin-")
        manifest = json.loads((root / slug / "module.json").read_bytes())
        if manifest["id"] != module_id or manifest["slug"] != slug or slug in modules:
            raise ValueError(f"Invalid release manifest in the first-upgrade roster for {slug}")
        modules[slug] = manifest["version"]
    return modules


def configured(cfg):
    return cfg.get("module_profile") or {}


def evidence(profile, records, mode):
    actual = {record["manifest"]["slug"]: record["manifest"]["version"] for record in records}
    if (len(actual) != len(records) or actual != profile["modules"]
            or any(record.get("state", record.get("lifecycle")) != "enabled"
                   or record.get("reason") for record in records)):
        raise RuntimeError(f"{mode} registry differs from {profile['name']} profile: {records!r}")
    return {"name": profile["name"], "modules": actual, "mode": mode}


def prepare_browser(profile, ctx, deadline):
    if not profile:
        return None
    base_url = ctx.cfg["app"]["base_url"]
    if urlsplit(ctx.page.url).netloc != urlsplit(base_url).netloc:
        ctx.page.goto(base_url, wait_until="domcontentloaded", timeout=deadline.remaining() * 1000)
    records = ctx.page.evaluate("""async (roster) => {
      const preview = await import('/src/stubs/modulePreview.ts');
      preview.setCrashRegressionModuleProfile(roster);
      return preview.invokeModulePreview('plugin_list');
    }""", profile["modules"])
    return evidence(profile, records, "browser")


def _native_request(session, *, packages=None):
    # Fixed QA setup, called before YAML steps. Native verifies ordinary offline
    # signatures and persists enabled state through the production IPC.
    session.execute("""
      window.__qaCrashModuleProfile = { done: false };
      (async () => {
        const invoke = (command, args) => window.__TAURI_INTERNALS__.invoke(command, args);
        for (const { slug, archivePath, detachedSignature } of PACKAGES) {
          try {
            await invoke('plugin_install_archive', { archivePath, detachedSignature });
            await invoke('plugin_set_enabled', { slug, enabled: true });
          } catch (error) {
            throw new Error(slug + ': ' + String(error));
          }
        }
        const records = await invoke('plugin_list');
        window.__qaCrashModuleProfile = { done: true, records };
      })().catch(error => {
        window.__qaCrashModuleProfile = { done: true, error: String(error) };
      });
      return true;
    """.replace("PACKAGES", json.dumps(packages or [])))
    try:
        while True:
            session.deadline.remaining()
            result = session.execute("return { result: window.__qaCrashModuleProfile };")["result"]
            if result and result.get("done"):
                if result.get("error"):
                    raise RuntimeError(f"Crash regression module setup failed: {result['error']}")
                return result["records"]
            time.sleep(.1)
    finally:
        if time.monotonic() < session.deadline.expires:
            session.execute("delete window.__qaCrashModuleProfile; return true;")


def _package_inputs(profile):
    from .fixtures.module_first_release import release_inputs
    from .fixtures.module_marketplace import ORIGIN
    from .fixtures.module_signed_archive import platform_key

    run = os.environ["QA_FIRST_RELEASE_RUN"]
    if run != profile["release_run"]:
        raise RuntimeError("Crash regression input differs from the selected release run")
    files, receipts, producer = release_inputs(
        Path(os.environ["QA_FIRST_RELEASE_ROOT"]).resolve(), profile["source"], run, platform_key(), ORIGIN,
    )
    archives = []
    for receipt in receipts.values():
        archive = files["/" + receipt["archive"]]
        signature = archive.with_name(receipt["signature"]).read_text(encoding="utf-8")
        archives.append({"slug": receipt["slug"], "archivePath": archive.as_posix(),
                         "detachedSignature": signature})
    provenance = {"release_run": run, "catalog_sha256": producer["catalogSha256"],
                  "packages": {r["slug"]: r["sha256"] for r in receipts.values()}}
    return archives, provenance


def _module_root(report_root):
    from .fixtures.module_download import plugin_root
    return plugin_root(SimpleNamespace(report_root=report_root, case_dir=report_root / "_bootstrap"))


def prepare_native(profile, harness):
    """Install the full signed roster once per shard and snapshot its fresh registry."""
    if profile.get("name") != "full":
        return None
    archives, provenance = _package_inputs(profile)
    harness.deadline = Deadline(300)
    session = harness.create_session()
    try:
        evidence(profile, _native_request(session, packages=archives), "native")
    finally:
        session.deadline = Deadline(15)
        session.close()
    installed = _module_root(harness.report_root)
    snapshot = harness.report_root / "_workdirs" / "module-profile"
    if any(path.is_symlink() for path in installed.rglob("*")):
        raise RuntimeError("Crash regression module snapshot contains a link")
    shutil.copytree(installed, snapshot)
    return snapshot, provenance


def restore_native(prepared, report_root):
    if prepared:
        snapshot, _ = prepared
        destination = _module_root(report_root)
        if destination.is_dir():
            destination.rmdir()
        shutil.copytree(snapshot, destination)


def observe_native(profile, prepared, session):
    if not profile:
        return None
    receipt = evidence(profile, _native_request(session), "native")
    if prepared:
        _, provenance = prepared
        receipt.update(provenance)
    return receipt


def verify_receipt(profile, mode, receipt):
    if not isinstance(receipt, dict) or any(receipt.get(key) != value for key, value in {
        "name": profile["name"], "modules": profile["modules"], "mode": mode,
    }.items()):
        raise ValueError("case lacks the selected installation profile")
    if mode == "native" and profile["name"] == "full":
        packages = receipt.get("packages")
        if (receipt.get("release_run") != profile["release_run"]
                or not re.fullmatch(r"[0-9a-f]{64}", str(receipt.get("catalog_sha256")))
                or not isinstance(packages, dict) or packages.keys() != profile["modules"].keys()
                or not all(re.fullmatch(r"[0-9a-f]{64}", str(digest)) for digest in packages.values())):
            raise ValueError("full native profile lacks matching signed package provenance")
