"""Give the desktop and the browser preview the same old SocksCap settings."""

from __future__ import annotations

import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import zipfile

from .backup_policy import isolated_data_root
from .module_signed_archive import load_artifact, platform_key

SIGNED_CASES = {"TC-MODULES-072", "TC-MODULES-073"}


def setup(ctx):
    user_rules = []
    if ctx.case_id == "TC-MODULES-073":
        user_rules.append({"pattern": "route.example.test", "action": "block"})
    serialized = json.dumps({
        "enabled": False,
        "mode": "global",
        "apps": [],
        "upstream": {"kind": "socks5", "host": "127.0.0.1", "port": 19391},
        "ruleMode": "gfwList",
        "gfwlist": {"enabled": False, "autoRefreshHours": 24, "url": ""},
        "userRules": user_rules,
        "bypassCidrs": ["127.0.0.0/8"],
        "defaultAction": "direct",
    })
    ctx.values["sockscap_legacy_config"] = serialized
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        path = isolated_data_root(ctx) / "sockscap" / "config.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(serialized, encoding="utf-8")


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
    (owned / "provenance.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
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
