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
SIGNED_CASES = {XRAY_CASE_ID, "TC-MODULES-072", "TC-MODULES-073", sockscap_redirector.CASE_ID, sockscap_redirector.INSTALLER_CASE}


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
    serialized = json.dumps(config)
    ctx.values["sockscap_legacy_config"] = serialized
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        path = isolated_data_root(ctx) / "sockscap" / "config.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(serialized, encoding="utf-8")
        ctx.values.update(sockscap_original_file=path.as_posix(),
                          sockscap_original_sha256=hashlib.sha256(path.read_bytes()).hexdigest(),
                          sockscap_module_config=(isolated_data_root(ctx) / "plugins/sockscap/data/config.json").as_posix())


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

    if ctx.case_id == XRAY_CASE_ID:
        name = "xray.exe" if platform.startswith("windows-") else "xray"
        resource = f"resources/xray/{name}"
        with zipfile.ZipFile(archive) as package, package.open(resource) as packed:
            receipt["xraySha256"] = hashlib.file_digest(packed, "sha256").hexdigest()
        ctx.sockscap_xray_restore = (destination, resource)
        ctx.sockscap_xray_resource = installed / resource
        ctx.values.update(
            sockscap_xray_sha256=receipt["xraySha256"],
            sockscap_xray_staged=(isolated_data_root(ctx) / f"plugins/sockscap/data/xray/{name}").as_posix(),
        )

    (owned / "provenance.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")

    if ctx.case_id in (sockscap_redirector.CASE_ID, sockscap_redirector.INSTALLER_CASE):
        sockscap_redirector.prepare(ctx, destination, installed)
