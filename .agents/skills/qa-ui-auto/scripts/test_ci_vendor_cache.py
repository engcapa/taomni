"""Contracts for the opt-in vendored Cargo dependency cache experiment."""
from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
from unittest.mock import patch

import ci_cargo_artifact
import native_build
from ci_cargo_artifact import (
    DEFAULT_VENDOR_MTIME_EPOCH,
    cache_key,
    local_units,
    main,
    normalize_vendor_mtimes,
    pack,
    restore,
    vendor_cache_enabled,
    vendor_manifests,
    vendor_mtime_epoch,
    vendor_packages,
    vendor_tree_digest,
)

# Captured from the implementation before the vendor cache experiment existed.
# The disabled switch must keep producing this exact key for the same inputs.
LEGACY_CACHE_KEY = (
    "qa-cargo-dependencies-v1-ubuntu-24.04-release-"
    "41c389bb563660cd43d657e4027cff22ca481b6993f6c99ba4e62f4b1101f87a"
)
MANIFESTS = [
    "src-tauri/Cargo.toml",
    "src-tauri/vendor/wry/Cargo.toml",
    "src-tauri/vendor/ironrdp-acceptor/Cargo.toml",
    "src-tauri/crates/sockscap-helper/Cargo.toml",
]
FIXED_ENVIRONMENT = {
    "ImageVersion": "runner-image",
    "RUSTFLAGS": "-C target-cpu=native",
    "CARGO_PROFILE_DEV_DEBUG": "0",
    "CMAKE_BUILD_PARALLEL_LEVEL": "4",
    "UNRELATED": "ignored",
}


def write_file(root: Path, name: str, text: str) -> Path:
    path = root / name
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding="utf-8")
    return path


def create_packages(root: Path) -> list[str]:
    """Write local and vendored manifests, returning their repository paths."""
    write_file(root, "src-tauri/Cargo.toml", '[package]\nname = "taomni"\nversion = "0.0.0"\n')
    write_file(root, "src-tauri/vendor/wry/Cargo.toml",
               '[package]\nname = "wry"\nversion = "0.0.0"\n\n[lib]\nname = "wry"\n')
    write_file(root, "src-tauri/vendor/ironrdp-acceptor/Cargo.toml",
               '[package]\nname = "ironrdp-acceptor"\nversion = "0.0.0"\n')
    write_file(root, "src-tauri/crates/sockscap-helper/Cargo.toml",
               '[package]\nname = "sockscap-helper"\nversion = "0.0.0"\n')
    return list(MANIFESTS)


def create_build_unit(target: Path, package: str) -> None:
    """Create a modern Cargo build unit directory for one package."""
    unit = target / "release" / "build" / package / "0123456789abcdef"
    unit.joinpath("fingerprint").mkdir(parents=True)
    unit.joinpath("out").mkdir()
    unit.joinpath("out", "artifact").write_text(package, encoding="utf-8")


def fixed_tool_output(command, **kwargs):
    if command[0] == "rustc":
        return "rustc 1.99.0 (mock)\n"
    if command[0] == "cargo":
        return "cargo 1.99.0 (mock)\n"
    raise subprocess.CalledProcessError(128, command)


@contextlib.contextmanager
def fixed_cache_key_inputs():
    """Freeze every cache key input except the vendor tree."""
    with patch.object(ci_cargo_artifact, "configured_environment", return_value=dict(FIXED_ENVIRONMENT)), \
         patch.object(ci_cargo_artifact.subprocess, "check_output", side_effect=fixed_tool_output), \
         patch.object(ci_cargo_artifact, "fingerprint", return_value="manifest-fingerprint"), \
         patch.object(ci_cargo_artifact, "cargo_manifests", return_value=[]):
        yield


def run_git(root: Path, *args: str) -> None:
    subprocess.run(["git", "-C", str(root), *args], check=True, capture_output=True)


def git_commit(root: Path, message: str) -> None:
    run_git(root, "add", "-A")
    run_git(root, "-c", "user.name=QA", "-c", "user.email=qa@example.com", "commit", "-qm", message)


class VendorManifestTests(unittest.TestCase):
    @unittest.skipUnless(shutil.which("git"), "requires git to list repository files")
    def test_vendor_manifests_and_packages_come_from_the_repository_listing(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_git(root, "init", "-q")
            create_packages(root)
            write_file(root, "src-tauri/vendor/wry/src/lib.rs", "pub fn loaded() {}\n")
            self.assertEqual(vendor_manifests(root), [
                "src-tauri/vendor/ironrdp-acceptor/Cargo.toml",
                "src-tauri/vendor/wry/Cargo.toml",
            ])
            self.assertEqual(vendor_packages(root), {"ironrdp-acceptor", "wry"})


class LocalUnitTests(unittest.TestCase):
    def test_default_scope_keeps_vendored_packages_local(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifests = create_packages(root)
            with patch.object(ci_cargo_artifact, "cargo_manifests", return_value=manifests):
                units = local_units(root)
            vendored = {"wry", "libwry", "ironrdp-acceptor", "ironrdp_acceptor",
                        "libironrdp-acceptor", "libironrdp_acceptor"}
            self.assertTrue(vendored <= units)
            self.assertEqual(units, vendored | {
                "taomni", "libtaomni", "sockscap-helper", "sockscap_helper",
                "libsockscap-helper", "libsockscap_helper",
            })

    def test_vendor_cache_scope_archives_vendored_packages_but_not_local_ones(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifests = create_packages(root)
            with patch.object(ci_cargo_artifact, "cargo_manifests", return_value=manifests):
                units = local_units(root, include_vendor=True)
            self.assertEqual(units, {
                "taomni", "libtaomni", "sockscap-helper", "sockscap_helper",
                "libsockscap-helper", "libsockscap_helper",
            })


class CargoArchiveScopeTests(unittest.TestCase):
    def restored_build_units(self, *, include_vendor: bool) -> set[str]:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            manifests = create_packages(root)
            target = root / "target"
            for package in ("wry", "ironrdp-acceptor", "taomni", "serde"):
                create_build_unit(target, package)
            artifact, restored = root / "artifact", root / "restored"
            with patch.object(ci_cargo_artifact, "cargo_manifests", return_value=manifests):
                units = local_units(root, include_vendor=include_vendor)
            pack(artifact, "release", target=target, cargo_home=root / "cargo", units=units)
            with contextlib.redirect_stdout(io.StringIO()):
                restore(artifact, "release", target=restored, cargo_home=root / "cargo")
            return {path.name for path in (restored / "release" / "build").iterdir()}

    def test_disabled_switch_packs_no_vendored_units(self):
        self.assertEqual(self.restored_build_units(include_vendor=False), {"serde"})

    def test_enabled_switch_restores_vendored_units_but_not_local_units(self):
        self.assertEqual(
            self.restored_build_units(include_vendor=True),
            {"ironrdp-acceptor", "serde", "wry"},
        )


class VendorTreeDigestTests(unittest.TestCase):
    def test_fallback_hashes_sorted_vendor_content_only(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            write_file(root, "src-tauri/vendor/wry/Cargo.toml", "[package]\nname = \"wry\"\n")
            write_file(root, "src-tauri/vendor/wry/src/lib.rs", "pub fn a() {}\n")
            write_file(root, "src-tauri/src/main.rs", "fn main() {}\n")
            expected = hashlib.sha256(json.dumps([
                ["src-tauri/vendor/wry/Cargo.toml", hashlib.sha256(b'[package]\nname = "wry"\n').hexdigest()],
                ["src-tauri/vendor/wry/src/lib.rs", hashlib.sha256(b"pub fn a() {}\n").hexdigest()],
            ], separators=(",", ":")).encode()).hexdigest()
            for unavailable in (FileNotFoundError("git"), subprocess.CalledProcessError(128, ["git"])):
                with self.subTest(unavailable=type(unavailable).__name__), \
                     patch.object(ci_cargo_artifact.subprocess, "check_output", side_effect=unavailable):
                    self.assertEqual(vendor_tree_digest(root), expected)
                    write_file(root, "src-tauri/src/main.rs", "fn main() { changed(); }\n")
                    self.assertEqual(vendor_tree_digest(root), expected)
                    write_file(root, "src-tauri/vendor/wry/src/lib.rs", "pub fn b() {}\n")
                    self.assertNotEqual(vendor_tree_digest(root), expected)
                    write_file(root, "src-tauri/vendor/wry/src/lib.rs", "pub fn a() {}\n")

    @unittest.skipUnless(shutil.which("git"), "requires git to read the committed tree")
    def test_git_digest_hashes_the_committed_vendor_tree(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            run_git(root, "init", "-q")
            write_file(root, "src-tauri/vendor/wry/src/lib.rs", "pub fn a() {}\n")
            write_file(root, "src-tauri/src/main.rs", "fn main() {}\n")
            git_commit(root, "initial")
            digest = vendor_tree_digest(root)
            listing = subprocess.check_output(
                ["git", "-C", str(root), "ls-tree", "-r", "HEAD", "--", "src-tauri/vendor"])
            self.assertEqual(digest, hashlib.sha256(listing).hexdigest())
            write_file(root, "src-tauri/src/main.rs", "fn main() { other(); }\n")
            git_commit(root, "unrelated")
            self.assertEqual(vendor_tree_digest(root), digest)
            write_file(root, "src-tauri/vendor/wry/src/lib.rs", "pub fn b() {}\n")
            git_commit(root, "vendor")
            self.assertNotEqual(vendor_tree_digest(root), digest)


class CacheKeyTests(unittest.TestCase):
    def test_disabled_switch_keeps_the_established_archive_key(self):
        with fixed_cache_key_inputs(), patch.dict(os.environ, {"QA_VENDOR_CACHE": ""}):
            self.assertEqual(cache_key("release", "ubuntu-24.04", vendor_cache=False), LEGACY_CACHE_KEY)
            self.assertEqual(cache_key("release", "ubuntu-24.04"), LEGACY_CACHE_KEY)

    def test_enabled_switch_keys_vendored_content(self):
        with tempfile.TemporaryDirectory() as first, tempfile.TemporaryDirectory() as second:
            first_root, second_root = Path(first), Path(second)
            write_file(first_root, "src-tauri/vendor/wry/src/lib.rs", "pub fn a() {}\n")
            write_file(second_root, "src-tauri/vendor/wry/src/lib.rs", "pub fn b() {}\n")
            write_file(second_root, "src-tauri/src/main.rs", "fn main() {}\n")
            with fixed_cache_key_inputs(), patch.dict(os.environ, {"QA_VENDOR_CACHE": "1"}):
                disabled = cache_key("release", "ubuntu-24.04", vendor_cache=False, root=first_root)
                enabled = cache_key("release", "ubuntu-24.04", vendor_cache=True, root=first_root)
                self.assertEqual(disabled, LEGACY_CACHE_KEY)
                self.assertNotEqual(enabled, disabled)
                self.assertEqual(enabled, cache_key("release", "ubuntu-24.04", root=first_root))
                self.assertEqual(enabled, cache_key(
                    "release", "ubuntu-24.04", vendor_cache=True, root=first_root))
                self.assertEqual(disabled, cache_key(
                    "release", "ubuntu-24.04", vendor_cache=False, root=second_root))
                self.assertNotEqual(enabled, cache_key(
                    "release", "ubuntu-24.04", vendor_cache=True, root=second_root))


class VendorCacheSettingTests(unittest.TestCase):
    def test_switch_accepts_only_documented_values(self):
        for value, expected in (("1", True), ("true", True), ("TRUE", True),
                                ("0", False), ("false", False), ("", False), ("yes", False)):
            with self.subTest(value=value), patch.dict(os.environ, {"QA_VENDOR_CACHE": value}):
                self.assertIs(vendor_cache_enabled(), expected)

    def test_mtime_epoch_defaults_to_the_documented_value(self):
        self.assertEqual(DEFAULT_VENDOR_MTIME_EPOCH, 1_600_000_000)
        for value, expected in (("", DEFAULT_VENDOR_MTIME_EPOCH),
                                ("1700000000", 1_700_000_000),
                                ("invalid", DEFAULT_VENDOR_MTIME_EPOCH)):
            with self.subTest(value=value), patch.dict(os.environ, {"QA_VENDOR_MTIME_EPOCH": value}):
                self.assertEqual(vendor_mtime_epoch(), expected)


class NormalizeMtimesTests(unittest.TestCase):
    def test_normalizes_vendor_regular_files_and_preserves_modes(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            source = write_file(root, "src-tauri/vendor/wry/src/lib.rs", "pub fn a() {}\n")
            build = write_file(root, "src-tauri/vendor/wry/build.rs", "fn main() {}\n")
            manifest = write_file(root, "src-tauri/vendor/tauri-utils/Cargo.toml", "[package]\n")
            local = write_file(root, "src-tauri/src/main.rs", "fn main() {}\n")
            outside = write_file(root, "README.md", "# notes\n")
            if os.name == "posix":
                build.chmod(0o755)
            previous = 1_700_000_000
            for path in (source, build, manifest, local, outside):
                os.utime(path, (previous, previous))
            self.assertEqual(normalize_vendor_mtimes(root, 1_600_000_000), 3)
            for path in (source, build, manifest):
                self.assertEqual(int(path.stat().st_mtime), 1_600_000_000)
            for path in (local, outside):
                self.assertEqual(int(path.stat().st_mtime), previous)
            if os.name == "posix":
                self.assertEqual(build.stat().st_mode & 0o777, 0o755)

    @unittest.skipUnless(hasattr(os, "symlink"), "requires symbolic links")
    def test_does_not_follow_symlinked_files(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            outside = write_file(root, "outside/lib.rs", "pub fn outside() {}\n")
            link = root / "src-tauri/vendor/wry/linked.rs"
            link.parent.mkdir(parents=True)
            try:
                link.symlink_to(outside)
            except OSError as error:
                self.skipTest(f"symlinks unavailable: {error}")
            previous = 1_700_000_000
            os.utime(outside, (previous, previous))
            self.assertEqual(normalize_vendor_mtimes(root, 1_600_000_000), 0)
            self.assertEqual(int(outside.stat().st_mtime), previous)


class NormalizeCommandTests(unittest.TestCase):
    def test_normalize_is_a_safe_noop_while_the_switch_is_disabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            vendored = write_file(root, "src-tauri/vendor/wry/src/lib.rs", "pub fn a() {}\n")
            previous = 1_700_000_000
            os.utime(vendored, (previous, previous))
            output = io.StringIO()
            with patch.object(ci_cargo_artifact, "ROOT", root), \
                 patch.dict(os.environ, {"QA_VENDOR_CACHE": "0"}, clear=True), \
                 contextlib.redirect_stdout(output):
                main(["normalize"])
            self.assertEqual(int(vendored.stat().st_mtime), previous)
            self.assertIn("disabled", output.getvalue())

    def test_normalize_pins_vendored_files_while_the_switch_is_enabled(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            first = write_file(root, "src-tauri/vendor/wry/src/lib.rs", "pub fn a() {}\n")
            second = write_file(root, "src-tauri/vendor/tauri-utils/Cargo.toml", "[package]\n")
            for path in (first, second):
                os.utime(path, (1_700_000_000, 1_700_000_000))
            output = io.StringIO()
            with patch.object(ci_cargo_artifact, "ROOT", root), \
                 patch.dict(os.environ, {"QA_VENDOR_CACHE": "true",
                                         "QA_VENDOR_MTIME_EPOCH": "1500000000"}, clear=True), \
                 contextlib.redirect_stdout(output):
                main(["normalize"])
            self.assertEqual(int(first.stat().st_mtime), 1_500_000_000)
            self.assertEqual(int(second.stat().st_mtime), 1_500_000_000)
            self.assertIn("2", output.getvalue())


class NativeBuildIntegrationTests(unittest.TestCase):
    def test_normalize_runs_only_for_the_enabled_experiment(self):
        with patch.object(native_build, "ROOT", Path("/qa-root")), \
             patch.object(ci_cargo_artifact, "normalize_vendor_mtimes", return_value=7) as normalize, \
             patch.dict(os.environ, {"QA_VENDOR_CACHE": "1", "QA_VENDOR_MTIME_EPOCH": "1500000000"}), \
             contextlib.redirect_stdout(io.StringIO()):
            native_build.normalize_vendored_cargo_sources()
        normalize.assert_called_once_with(Path("/qa-root"), 1_500_000_000)
        with patch.object(ci_cargo_artifact, "normalize_vendor_mtimes") as disabled, \
             patch.dict(os.environ, {"QA_VENDOR_CACHE": "0"}, clear=True):
            native_build.normalize_vendored_cargo_sources()
        disabled.assert_not_called()

    def test_build_inputs_track_the_experiment_switches(self):
        with patch.object(native_build, "source_identity", return_value="source"), \
             patch.object(native_build, "recipe_identity", return_value="recipe"), \
             patch.object(native_build, "stable_platform", return_value="platform"), \
             patch.object(native_build.subprocess, "check_output", return_value="version\n"), \
             patch.dict(os.environ, {"QA_VENDOR_CACHE": "1",
                                     "QA_VENDOR_MTIME_EPOCH": "1500000000"}):
            environment = native_build.build_inputs()["environment"]
        self.assertEqual(environment["QA_VENDOR_CACHE"], "1")
        self.assertEqual(environment["QA_VENDOR_MTIME_EPOCH"], "1500000000")

    def test_build_qa_normalizes_vendored_sources_before_compiling(self):
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            binary = root / "src-tauri/target/qa-ui-auto/release" / (
                "taomni.exe" if os.name == "nt" else "taomni")
            events: list[str] = []

            def fake_run(command, cwd, env, check):
                events.append(command[0])
                binary.parent.mkdir(parents=True, exist_ok=True)
                binary.write_bytes(b"binary")

            clean_environment = {key: value for key, value in os.environ.items()
                                 if not key.startswith("QA_VENDOR")}
            with patch.dict(os.environ, clean_environment, clear=True), \
                 patch.object(native_build, "ROOT", root), \
                 patch.object(native_build, "PLATFORM_HELPERS", {}), \
                 patch.object(native_build.shutil, "which", return_value="pnpm"), \
                 patch.object(native_build, "ensure_linux_link_deps"), \
                 patch.object(native_build, "source_identity", return_value="source"), \
                 patch.object(native_build, "recipe_identity", return_value="recipe"), \
                 patch.object(native_build, "normalize_vendored_cargo_sources",
                              side_effect=lambda: events.append("normalize")), \
                 patch.object(native_build.subprocess, "check_output", return_value="version\n"), \
                 patch.object(native_build.subprocess, "run", side_effect=fake_run):
                self.assertEqual(native_build.build_qa(release=True, force=True), binary)
            self.assertEqual(events, ["normalize", "pnpm", "cargo"])


if __name__ == "__main__":
    unittest.main()
