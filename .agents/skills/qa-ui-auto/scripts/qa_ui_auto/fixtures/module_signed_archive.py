"""Official signed QA artifact; never installs a key or seeds plugin state.

The CI artifact is only an input. The unmodified application's pinned verifier
must accept its signature through the ordinary offline installation form.
Missing/mismatched artifacts are failures, never skips or invented installs.
"""
from __future__ import annotations

import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import zipfile

from native_build import QA_APP_ID
from tauri_webdriver import native_isolation_env

from .module_mfa_restore import CASE_ID as MFA_RESTORE_CASE


def platform_key(system=None, machine=None):
    system, machine = system or platform.system(), (machine or platform.machine()).lower()
    arch = "aarch64" if machine in {"arm64", "aarch64"} else "x86_64" if machine in {"x86_64", "amd64"} else "unsupported"
    name = {"Linux": "linux", "Windows": "windows", "Darwin": "darwin"}.get(system, "unsupported")
    return f"{name}-{arch}"


def load_artifact(root: Path, source_sha: str, expected_platform: str, slug: str = "hello-plugin", *, version="0.1.0"):
    root = root.absolute()
    if root.resolve() != root or not root.is_dir():
        raise RuntimeError("Signed module artifact must be a real directory")
    receipt = json.loads((root / "provenance.json").read_text(encoding="utf-8"))
    expected = {"schema": "taomni.plugin-package.v1", "id": f"taomni-plugin-{slug}",
                "slug": slug, "version": version, "platform": expected_platform,
                "sourceSha": source_sha, "coreApiVersion": "1", "trust": "plugins.updater.pubkey"}
    if any(receipt.get(key) != value for key, value in expected.items()):
        raise RuntimeError("Signed module source/platform/identity differs from current native inputs")
    archive_name = f"taomni-plugin-{slug}-{version}-{expected_platform}.taomni-plugin"
    if receipt.get("archive") != archive_name or receipt.get("signature") != archive_name + ".minisig":
        raise RuntimeError("Unexpected official module artifact filenames")
    archive, signature = root / archive_name, root / (archive_name + ".minisig")
    if any(p.is_symlink() or not p.is_file() for p in (archive, signature)):
        raise RuntimeError("Official module archive/signature must be ordinary files")
    if hashlib.sha256(archive.read_bytes()).hexdigest() != receipt.get("sha256") or archive.stat().st_size != receipt.get("size"):
        raise RuntimeError("Official module artifact digest/size differs from provenance")
    detached = signature.read_text(encoding="utf-8")
    trusted = f"trusted comment: id={receipt['id']} version={version} platform={expected_platform} coreApiVersion=1 sha256={receipt['sha256']}"
    if len(detached.splitlines()) != 4 or detached.splitlines()[2] != trusted:
        raise RuntimeError("Official module signature does not bind the expected metadata")
    frontend = None
    if slug in {"hello-plugin", "vnc-client", "rdp-client"}:
        with zipfile.ZipFile(archive) as zipped:
            frontend = zipped.read("frontend/index.js")
    return receipt, archive, detached, frontend


def setup(ctx):
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("Official signed module fixture requires the native verifier")
    raw = os.environ.get("QA_SIGNED_MODULE_ROOT")
    if not raw:
        raise RuntimeError("QA_SIGNED_MODULE_ROOT is required; build official QA artifacts first")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    receipt, archive, signature, frontend = load_artifact(Path(raw), source, platform_key())
    owned = Path(ctx.case_dir).resolve() / "official-module"
    owned.mkdir(parents=True, exist_ok=False)
    destination = owned / archive.name
    shutil.copyfile(archive, destination)
    (owned / "frontend-index.js.original").write_bytes(frontend)
    isolation = native_isolation_env(Path(ctx.report_root))
    if any(os.environ.get(key) != value for key, value in isolation.items()):
        raise RuntimeError("Signed module case requires its verified isolated QA profile")
    data = Path(isolation.get("NEWMOB_DATA_DIR") or isolation["XDG_DATA_HOME"]) / QA_APP_ID
    receipt.update(pluginRoot=str(data / "plugins"), copiedArchive=str(destination),
                   frontendSha256=hashlib.sha256(frontend).hexdigest())
    (Path(ctx.case_dir) / "official-module-fixture.json").write_text(json.dumps(receipt, indent=2), encoding="utf-8")
    ctx.values.update(module_signed_archive=destination.as_posix(), module_signed_signature=signature)
    if ctx.case_id == "TC-MODULES-042":
        variants = {}
        for directory, version in [("previous", "0.0.9"), ("handshake-failure", "0.1.1")]:
            variant, archive, signature, _ = load_artifact(Path(raw) / directory, source, platform_key(), version=version)
            destination = owned / archive.name
            shutil.copyfile(archive, destination)
            key = directory.replace("-", "_")
            ctx.values.update({f"module_{key}_archive": destination.as_posix(), f"module_{key}_signature": signature})
            variants[version] = variant
        (owned / "variants.json").write_text(json.dumps(variants, indent=2), encoding="utf-8")


def setup_mfa(ctx):
    if ctx.case_id not in {"TC-MODULES-038", "TC-MODULES-039", "TC-MODULES-044", MFA_RESTORE_CASE} or (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("Signed MFA input requires its registered native upgrade case")
    raw = os.environ.get("QA_SIGNED_MFA_ROOT")
    if not raw:
        raise RuntimeError("QA_SIGNED_MFA_ROOT is required; build the signed MFA artifact first")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    receipt, archive, signature, _ = load_artifact(Path(raw), source, platform_key(), "mfa")
    owned = Path(ctx.case_dir).resolve() / "signed-mfa"
    owned.mkdir()
    destination = owned / archive.name
    detached = owned / receipt["signature"]
    shutil.copyfile(archive, destination)
    detached.write_text(signature, encoding="utf-8")
    (owned / "provenance.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    ctx.values.update(mfa_signed_archive=destination.as_posix(), mfa_signed_signature=detached.as_posix(), mfa_signed_signature_text=signature)


def setup_vnc(ctx):
    setup_desktop_client(ctx, "vnc")


def setup_rdp(ctx):
    setup_desktop_client(ctx, "rdp")


def setup_mail(ctx):
    if ctx.case_id != "TC-MODULES-059" or (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("Signed Mail input requires the native package verifier")
    raw = os.environ.get("QA_SIGNED_MAIL_ROOT")
    if not raw:
        raise RuntimeError("QA_SIGNED_MAIL_ROOT is required to locate the signed artifact")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    manifest = Path(__file__).resolve().parents[6] / "src-tauri/plugins/mail/module.json"
    version = json.loads(manifest.read_text(encoding="utf-8"))["version"]
    receipt, archive, signature, _ = load_artifact(Path(raw), source, platform_key(), "mail", version=version)
    host = "taomni-plugin-mail.exe" if platform.system() == "Windows" else "taomni-plugin-mail"
    with zipfile.ZipFile(archive) as package, package.open(host) as binary:
        receipt["hostSha256"] = hashlib.file_digest(binary, "sha256").hexdigest()
    owned = Path(ctx.case_dir).resolve() / "signed-mail"
    owned.mkdir()
    destination = owned / archive.name
    shutil.copyfile(archive, destination)
    (owned / "provenance.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    ctx.signed_mail = {"host": host, "receipt": receipt}
    ctx.values.update(mail_signed_archive=destination.as_posix(), mail_signed_signature=signature)


def setup_desktop_client(ctx, protocol):
    if (ctx.cfg.get("app") or {}).get("mode") != "native":
        raise RuntimeError("The signed desktop client requires the native package verifier")
    setting = f"QA_SIGNED_{protocol.upper()}_ROOT"
    raw = os.environ.get(setting)
    if not raw:
        raise RuntimeError(f"{setting} is required to locate the signed artifact")
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    slug = f"{protocol}-client"
    manifest = Path(__file__).resolve().parents[6] / "src-tauri" / "plugins" / slug / "module.json"
    version = json.loads(manifest.read_text(encoding="utf-8"))["version"]
    receipt, archive, signature, frontend = load_artifact(Path(raw), source, platform_key(), slug, version=version)
    if not frontend:
        raise RuntimeError("The signed package has no renderer bytes")
    receipt["frontendSha256"] = hashlib.sha256(frontend).hexdigest()
    owned = Path(ctx.case_dir).resolve() / f"signed-{protocol}"
    owned.mkdir()
    destination = owned / archive.name
    shutil.copyfile(archive, destination)
    (owned / "provenance.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    ctx.values.update({
        f"{protocol}_signed_archive": destination.as_posix(),
        f"{protocol}_signed_signature": signature,
        f"{protocol}_signed_version": receipt["version"],
    })

