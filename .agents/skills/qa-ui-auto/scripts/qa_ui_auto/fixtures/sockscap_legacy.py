"""Give the desktop and the browser preview the same old SocksCap settings."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

from . import sockscap_redirector
from .backup_policy import isolated_data_root
from .module_signed_archive import load_artifact, platform_key

XRAY_CASE_ID = "TC-MODULES-084"
WINDOWS_CAPTURE_CASE_ID = "TC-MODULES-085"
SIGNED_CASES = {XRAY_CASE_ID, WINDOWS_CAPTURE_CASE_ID, "TC-MODULES-072", "TC-MODULES-073", sockscap_redirector.CASE_ID, sockscap_redirector.INSTALLER_CASE}


def setup(ctx):
    user_rules = []
    if ctx.case_id == "TC-MODULES-073":
        user_rules.append({"pattern": "route.example.test", "action": "block"})
    config = {
        "enabled": False,
        "mode": "global",
        "apps": [],
        "upstream": {"kind": "socks5", "host": "127.0.0.1", "port": 19391},
        "ruleMode": "gfwList",
        "gfwlist": {"enabled": False, "autoRefreshHours": 24, "url": ""},
        "userRules": user_rules,
        "bypassCidrs": ["127.0.0.0/8"],
        "defaultAction": "direct",
    }
    if ctx.case_id == sockscap_redirector.CASE_ID:
        config.update(mode="apps", apps=[{"path": "/usr/bin/true", "name": "true"}], ruleMode="off")
    if ctx.case_id == XRAY_CASE_ID:
        config["upstream"].update(kind="shadowsocks", passwordRef="fixture-password",
                                  params={"method": "invalid-fixture-cipher"})
    if ctx.case_id == WINDOWS_CAPTURE_CASE_ID:
        config.update(
            mode="apps",
            apps=[{"path": str(Path(os.environ["SystemRoot"]) / "System32/where.exe"), "name": "where.exe"}],
            ruleMode="off",
        )
    if ctx.case_id == "TC-MODULES-073":
        config["gfwlist"]["enabled"] = True
    serialized = json.dumps(config)
    ctx.values["sockscap_legacy_config"] = serialized
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        path = isolated_data_root(ctx) / "sockscap" / "config.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(serialized, encoding="utf-8")
        ctx.values.update(sockscap_original_file=path.as_posix(),
                          sockscap_original_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                          sockscap_module_config=(isolated_data_root(ctx) / "plugins/sockscap/data/config.json").as_posix())
        if ctx.case_id == "TC-MODULES-073":
            raw_rules = path.parent / "rules/gfwlist.raw"
            raw_rules.parent.mkdir()
            raw_rules.write_bytes(b"[AutoProxy 0.2.9]\n||proxied.example.test\n")
            raw_rules.with_name("gfwlist.meta.json").write_text(json.dumps({
                "source": "file:qa-legacy-rules", "ruleCount": 1, "skipped": 1,
                "lastRefresh": "2026-01-01T00:00:00Z",
            }), encoding="utf-8")
            ctx.values.update(sockscap_legacy_rules=raw_rules.as_posix(),
                              sockscap_legacy_rules_sha256=hashlib.sha256(raw_rules.read_bytes()).hexdigest(),
                              sockscap_module_rules=(isolated_data_root(ctx) / "plugins/sockscap/data/rules.json").as_posix())


def setup_signed(ctx):
    if ctx.case_id not in SIGNED_CASES or (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("Signed SocksCap input requires its native case")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    manifest = Path(__file__).resolve().parents[6] / "src-tauri/plugins/sockscap/module.json"
    expected = json.loads(manifest.read_text(encoding="utf-8"))
    version, frontend = expected["version"], expected["entry"]["frontend"]
    platform = platform_key()
    receipt, archive, signature, _ = load_artifact(
        Path(os.environ["QA_SIGNED_SOCKSCAP_ROOT"]), source, platform, "sockscap", version=version,
    )
    host = "taomni-plugin-sockscap.exe" if platform.startswith("windows") else "taomni-plugin-sockscap"
    with zipfile.ZipFile(archive) as package:
        with package.open(host) as binary:
            receipt["hostSha256"] = hashlib.file_digest(binary, "sha256").hexdigest()
        with package.open(frontend) as entry:
            receipt["frontendSha256"] = hashlib.file_digest(entry, "sha256").hexdigest()
    owned = Path(ctx.case_dir).resolve() / "signed-sockscap"
    owned.mkdir()
    destination = owned / archive.name
    shutil.copyfile(archive, destination)
    installed = isolated_data_root(ctx) / "plugins" / "sockscap" / "versions" / version
    ctx.signed_sockscap = receipt
    ctx.values.update(
        sockscap_signed_archive=destination.as_posix(),
        sockscap_signed_signature=signature,
        sockscap_signed_host=(installed / host).as_posix(),
        sockscap_signed_host_sha256=receipt["hostSha256"],
        sockscap_signed_frontend=(installed / frontend).as_posix(),
        sockscap_signed_frontend_sha256=receipt["frontendSha256"],
    )

    if ctx.case_id in {XRAY_CASE_ID, WINDOWS_CAPTURE_CASE_ID}:
        if ctx.case_id == XRAY_CASE_ID:
            name = "xray.exe" if platform.startswith("windows-") else "xray"
            resource = f"resources/xray/{name}"
            run_file = f"xray/{name}"
        else:
            resource = "resources/windows/WinDivert.dll"
            run_file = f"windows-capture/{version}/sockscap-helper.exe"
        with zipfile.ZipFile(archive) as package, package.open(resource) as packed:
            receipt["resourceSha256"] = hashlib.file_digest(packed, "sha256").hexdigest()
        ctx.sockscap_resource_restore = (destination, resource)
        ctx.sockscap_resource = installed / resource
        ctx.sockscap_staged_resource = isolated_data_root(ctx) / "plugins/sockscap/runtime" / run_file
        if ctx.case_id == XRAY_CASE_ID:
            ctx.values.update(
                sockscap_xray_sha256=receipt["resourceSha256"],
                sockscap_xray_staged=ctx.sockscap_staged_resource.as_posix(),
            )

    (owned / "provenance.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")

    if ctx.case_id in (sockscap_redirector.CASE_ID, sockscap_redirector.INSTALLER_CASE):
        sockscap_redirector.prepare(ctx, destination, installed)


def setup_pending_recovery(ctx):
    if ctx.case_id != "TC-MODULES-094":
        raise RuntimeError("The SocksCap recovery error fixture is reserved for its native case")
    root = isolated_data_root(ctx)
    # An unreadable journal type forces startup to report the condition before
    # attempting OS cleanup. The case never changes any network settings.
    path = root / "sockscap/recovery.json"
    path.mkdir(parents=True)
    marker = path / "keep.txt"
    contents = b"QA retained recovery input"
    marker.write_bytes(contents)
    ctx.values.update(sockscap_recovery_marker=marker.as_posix(),
                      sockscap_recovery_marker_sha256=hashlib.sha256(contents).hexdigest())
