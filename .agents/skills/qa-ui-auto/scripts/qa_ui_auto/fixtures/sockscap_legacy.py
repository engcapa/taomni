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


def setup(ctx):
    serialized = json.dumps({
        "enabled": False,
        "mode": "global",
        "apps": [],
        "upstream": {"kind": "socks5", "host": "127.0.0.1", "port": 19391},
        "ruleMode": "gfwList",
        "gfwlist": {"enabled": False, "autoRefreshHours": 24, "url": ""},
        "userRules": [],
        "bypassCidrs": ["127.0.0.0/8"],
        "defaultAction": "direct",
    })
    ctx.values["sockscap_legacy_config"] = serialized
    if (ctx.cfg.get("app") or {}).get("mode") == "native":
        path = isolated_data_root(ctx) / "sockscap" / "config.json"
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(serialized, encoding="utf-8")


def setup_signed(ctx):
    if ctx.case_id != "TC-MODULES-072" or (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("Signed SocksCap input requires its native case")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    manifest = Path(__file__).resolve().parents[6] / "src-tauri/plugins/sockscap/module.json"
    version = json.loads(manifest.read_text(encoding="utf-8"))["version"]
    platform = platform_key()
    receipt, archive, signature, _ = load_artifact(
        Path(os.environ["QA_SIGNED_SOCKSCAP_ROOT"]), source, platform, "sockscap", version=version,
    )
    host = "taomni-plugin-sockscap.exe" if platform.startswith("windows") else "taomni-plugin-sockscap"
    with zipfile.ZipFile(archive) as package, package.open(host) as binary:
        receipt["hostSha256"] = hashlib.file_digest(binary, "sha256").hexdigest()
    owned = Path(ctx.case_dir).resolve() / "signed-sockscap"
    owned.mkdir()
    destination = owned / archive.name
    shutil.copyfile(archive, destination)
    (owned / "provenance.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    host_path = isolated_data_root(ctx) / "plugins" / "sockscap" / "versions" / version / host
    ctx.signed_sockscap = receipt
    ctx.values.update(
        sockscap_signed_archive=destination.as_posix(),
        sockscap_signed_signature=signature,
        sockscap_signed_host=host_path.as_posix(),
        sockscap_signed_host_sha256=receipt["hostSha256"],
    )
