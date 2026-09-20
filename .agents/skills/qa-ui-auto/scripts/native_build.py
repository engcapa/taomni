#!/usr/bin/env python3
"""Build an isolated QA app and bind its identifier to the produced binary."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
import shutil
import subprocess
import sys
import time

from qa_ui_auto.provenance import fingerprint, source_identity

ROOT = Path(__file__).resolve().parents[4]
QA_APP_ID = "com.taomni.app.qa"
QA_CONFIG = Path(__file__).resolve().parent.parent / "assets" / "tauri.qa.conf.json"
BUILD_RECIPE = "python .agents/skills/qa-ui-auto/scripts/native_build.py"
REPLIT_NATIVE_SETUP = ROOT / "scripts" / "setup-replit-native-qa.sh"


def add_target_bindgen_args(env: dict[str, str]) -> dict[str, str]:
    """Mirror bindgen flags to Cargo's target-specific environment names."""
    args = env.get("BINDGEN_EXTRA_CLANG_ARGS")
    if args:
        env["BINDGEN_EXTRA_CLANG_ARGS_x86_64-unknown-linux-gnu"] = args
        env["BINDGEN_EXTRA_CLANG_ARGS_x86_64_unknown_linux_gnu"] = args
    return env


def binary_digest(binary: Path) -> str:
    digest = hashlib.sha256()
    with binary.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def identity_path(binary: Path) -> Path:
    return binary.with_name(binary.name + ".qa-identity.json")


def verify_identity(binary: Path) -> dict:
    """Reject unrecorded, production, or replaced binaries without launching them."""
    try:
        record = json.loads(identity_path(binary).read_text(encoding="utf-8"))
        if not isinstance(record, dict) or record.get("identifier") != QA_APP_ID:
            raise ValueError("expected the independent QA application ID")
        if record.get("binary_sha256") != binary_digest(binary):
            raise ValueError("binary differs from its QA build record")
    except (OSError, ValueError) as exc:
        raise ValueError(f"Native QA identity check failed: {exc}. Build with: {BUILD_RECIPE}") from exc
    return record


def configured_environment(base: dict[str, str] | None = None) -> dict[str, str]:
    """Return the environment used for a Replit Linux native build.

    The shell helper is also sourced by the workflow and runbook. Keeping this
    direct-call path here prevents `python native_build.py` from silently
    bypassing the Replit toolchain fixes.
    """
    env = dict(os.environ if base is None else base)
    # Replit's runtime audit loader can be reintroduced between the shell
    # helper and Python subprocesses; rustc's bundled driver then fails with a
    # static-TLS allocation error. Native QA does not need that audit hook.
    env.pop("LD_AUDIT", None)
    if env.get("TAOMNI_REPLIT_NATIVE_QA") != "1" or not REPLIT_NATIVE_SETUP.is_file():
        return add_target_bindgen_args(env)
    if env.get("TAOMNI_NATIVE_QA_TOOLCHAIN_READY") == "1":
        return add_target_bindgen_args(env)

    command = [
        "bash",
        "-c",
        'set -e; source "$1"; env -0',
        "replit-native-qa-env",
        str(REPLIT_NATIVE_SETUP),
    ]
    try:
        output = subprocess.check_output(command, cwd=ROOT, env=env)
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ValueError(f"Replit native QA environment setup failed: {exc}") from exc
    for item in output.split(b"\0"):
        if not item:
            continue
        key, value = item.split(b"=", 1)
        env[key.decode()] = value.decode()
    return add_target_bindgen_args(env)


def build_inputs(*, release: bool = False, env: dict[str, str] | None = None) -> dict:
    effective_env = configured_environment(env)
    return {
        "source_sha256": source_identity(ROOT),
        "recipe_sha256": fingerprint(ROOT, [str(QA_CONFIG.relative_to(ROOT)).replace("\\", "/"),
                                             ".agents/skills/qa-ui-auto/scripts/native_build.py"]),
        "platform": platform.platform(),
        "profile": "release" if release else "debug",
        "cargo": subprocess.check_output(["cargo", "--version"], text=True, env=effective_env).strip(),
        "rustc": subprocess.check_output(["rustc", "--version"], text=True, env=effective_env).strip(),
        "node": subprocess.check_output(["node", "--version"], text=True, env=effective_env).strip(),
        "environment": {key: effective_env.get(key) for key in (
            "RUSTFLAGS", "CARGO_ENCODED_RUSTFLAGS", "CARGO_BUILD_TARGET", "RUSTUP_TOOLCHAIN",
            "CARGO_BUILD_JOBS", "CARGO_PROFILE_DEV_DEBUG", "CC", "CXX", "CFLAGS",
            "CARGO_PROFILE_DEV_INCREMENTAL", "CXXFLAGS", "BINDGEN_EXTRA_CLANG_ARGS",
            "BINDGEN_EXTRA_CLANG_ARGS_x86_64-unknown-linux-gnu",
            "BINDGEN_EXTRA_CLANG_ARGS_x86_64_unknown_linux_gnu",
            "LIBCLANG_PATH", "LIBRARY_PATH", "PKG_CONFIG_PATH", "LIBGSSAPI_IMPL",
            "TAOMNI_REPLIT_NATIVE_QA", "TAOMNI_NATIVE_QA_TOOLCHAIN",
                                             "RUSTC", "OPENSSL_SRC_PERL", "PERL",
            "VITE_DEV_PROXY", "TAURI_ENV_PLATFORM", "NODE_ENV")},
    }


def qa_binary(*, release: bool = False) -> Path:
    name = "taomni.exe" if platform.system() == "Windows" else "taomni"
    return ROOT / "src-tauri" / "target" / "qa-ui-auto" / ("release" if release else "debug") / name


def check_build(*, release: bool = False, inputs: dict | None = None) -> dict:
    """Inspect reuse without compiling, launching, or changing the identity record."""
    binary = qa_binary(release=release)
    result = {"binary": str(binary), "reusable": False, "reason": "binary missing"}
    if not binary.is_file():
        return result
    try:
        previous = verify_identity(binary)
    except ValueError as exc:
        return dict(result, reason=str(exc))
    expected = inputs if inputs is not None else build_inputs(release=release)
    recorded = previous.get("build_inputs")
    recorded = recorded if isinstance(recorded, dict) else {}
    changed = sorted(key for key in set(expected) | set(recorded)
                     if key not in expected or key not in recorded or expected[key] != recorded[key])
    return dict(result, reusable=not changed, changed_inputs=changed,
                reason="inputs match" if not changed else "build inputs changed",
                recorded_build_duration_sec=previous.get("build_duration_sec"))


def build_qa(*, release: bool = False, force: bool = False) -> Path:
    overlay = json.loads(QA_CONFIG.read_text(encoding="utf-8"))
    if overlay.get("identifier") != QA_APP_ID or overlay.get("mainBinaryName") != "taomni":
        raise ValueError("QA overlay must declare the independent QA ID and taomni binary name")
    pnpm = shutil.which("pnpm")
    if not pnpm:
        raise ValueError("pnpm not found on PATH")
    target = ROOT / "src-tauri" / "target" / "qa-ui-auto"
    binary = qa_binary(release=release)
    record_path = identity_path(binary)
    env = configured_environment()
    inputs = build_inputs(release=release, env=env)
    if not force:
        reuse = check_build(release=release, inputs=inputs)
        if reuse["reusable"]:
            print("qa-ui-auto: reusing verified QA build (source, recipe, toolchain and environment match)")
            return binary
        print(f"qa-ui-auto: build needed: {reuse['reason']}; changed inputs: {reuse.get('changed_inputs', [])}")
    # A failed rebuild must not leave an old record authorizing a stale binary.
    record_path.unlink(missing_ok=True)
    env = dict(env)
    env["CARGO_TARGET_DIR"] = str(target)
    env.pop("TAURI_CONFIG", None)
    # The workspace dependency lock can declare a newer rust-version than the
    # Rust toolchain available in the verification container. Cargo's
    # ignore-rust-version flag lets the build reach actual compiler/system
    # compatibility checks instead of stopping on metadata alone.
    command = [
        pnpm,
        "tauri",
        "build",
        "--no-bundle",
        "--config",
        str(QA_CONFIG),
        "--ignore-version-mismatches",
    ]
    if not release:
        command.append("--debug")
    started = time.monotonic()
    subprocess.run(command, cwd=ROOT, env=env, check=True)
    if inputs != build_inputs(release=release, env=env):
        raise ValueError("Build inputs changed during compilation; rebuild before collecting evidence")
    record = {
        "identifier": QA_APP_ID,
        "binary_sha256": binary_digest(binary),
        "platform": platform.system(),
        "profile": "release" if release else "debug",
        "command": command,
        "source_sha256": inputs["source_sha256"],
        "build_inputs": inputs,
        "build_duration_sec": time.monotonic() - started,
    }
    record_path.write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    return binary


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--release", action="store_true", help="use release profile for measurements")
    parser.add_argument("--force", action="store_true", help="rebuild even when verified inputs match")
    parser.add_argument("--check", action="store_true", help="inspect build reuse only: exit 0 reusable, 1 build needed, 2 check error")
    args = parser.parse_args(argv)
    if args.check and args.force:
        parser.error("--check cannot be combined with --force")
    try:
        if args.check:
            result = check_build(release=args.release)
            print(json.dumps(result, indent=2))
            return 0 if result["reusable"] else 1
        binary = build_qa(release=args.release, force=args.force)
    except (OSError, ValueError, subprocess.CalledProcessError) as exc:
        print(f"qa-ui-auto: QA build failed: {exc}", file=sys.stderr)
        return 2
    print(f"QA application: {binary}\nApplication ID: {QA_APP_ID}\nIdentity record: {identity_path(binary)}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
