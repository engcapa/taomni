#!/usr/bin/env python3
"""Source-level checks for the capture-capable Linux package overlay."""

from __future__ import annotations

import hashlib
import json
import os
import fcntl
from pathlib import Path
import shlex
import shutil
import stat
import subprocess
import tempfile
import time
import unittest


ROOT = Path(__file__).resolve().parents[2]
TAURI_DIR = ROOT / "src-tauri"
OVERLAY = TAURI_DIR / "tauri.sockscap.linux.conf.json"
STAGE = ROOT / "scripts" / "sockscap" / "stage-linux-package.sh"
BUILD_CANDIDATES = (
    ROOT / "scripts" / "sockscap" / "build-linux-capture-candidates.sh"
)
LINUX_ASSETS = TAURI_DIR / "platform" / "sockscap" / "linux"
PACKAGING = LINUX_ASSETS / "packaging"

EXPECTED_FILES = {
    "/usr/libexec/taomni/sockscap-helper": (
        "platform/sockscap/linux/staged/sockscap-helper"
    ),
    "/etc/taomni/sockscap-helper-policy.json": (
        "platform/sockscap/linux/staged/sockscap-helper-policy.json"
    ),
    "/usr/share/polkit-1/actions/com.taomni.sockscap.policy": (
        "platform/sockscap/linux/staged/com.taomni.sockscap.policy"
    ),
}


class LinuxPackageContractTests(unittest.TestCase):
    def render_maintainer_scripts(self, root: Path) -> tuple[dict[str, Path], dict[str, Path]]:
        runtime = root / "run" / "taomni"
        fake_bin = root / "fake-bin"
        fake_bin.mkdir(parents=True)
        fake_nft = fake_bin / "nft"
        fake_nft.write_text("#!/bin/sh\nexit 0\n", encoding="utf-8")
        fake_ip = fake_bin / "ip"
        fake_ip.write_text(
            "#!/bin/sh\n"
            'if [ -n "${SOCKSCAP_TEST_READY:-}" ]; then\n'
            '  : >"$SOCKSCAP_TEST_READY"\n'
            '  while [ ! -e "$SOCKSCAP_TEST_GO" ]; do sleep 0.01; done\n'
            "fi\n"
            "exit 0\n",
            encoding="utf-8",
        )
        fake_nft.chmod(0o755)
        fake_ip.chmod(0o755)

        installed = {
            "application": root / "installed" / "usr" / "bin" / "taomni",
            "helper": root
            / "installed"
            / "usr"
            / "libexec"
            / "taomni"
            / "sockscap-helper",
            "helper_policy": root
            / "installed"
            / "etc"
            / "taomni"
            / "sockscap-helper-policy.json",
            "polkit_action": root
            / "installed"
            / "usr"
            / "share"
            / "polkit-1"
            / "actions"
            / "com.taomni.sockscap.policy",
        }
        for path in installed.values():
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_bytes(b"fixture")

        uid = os.getuid()
        gid = os.getgid()
        scripts: dict[str, Path] = {}
        for name in ("require-clean-state", "post-install", "post-remove"):
            content = (PACKAGING / f"{name}.sh").read_text(encoding="utf-8")
            content = content.replace(
                "PATH=/usr/sbin:/usr/bin:/sbin:/bin",
                f"PATH={shlex.quote(str(fake_bin))}:/usr/sbin:/usr/bin:/sbin:/bin",
            )
            content = content.replace(
                "runtime_dir=/run/taomni",
                f"runtime_dir={shlex.quote(str(runtime))}",
            )
            content = content.replace(
                "/sys/fs/cgroup/taomni.sockscap",
                str(root / "absent-cgroup"),
            )
            content = content.replace(
                "/usr/bin/taomni", str(installed["application"])
            )
            content = content.replace(
                "/usr/libexec/taomni/sockscap-helper", str(installed["helper"])
            )
            content = content.replace(
                "/etc/taomni/sockscap-helper-policy.json",
                str(installed["helper_policy"]),
            )
            content = content.replace(
                "/usr/share/polkit-1/actions/com.taomni.sockscap.policy",
                str(installed["polkit_action"]),
            )
            content = content.replace("'0:0:755'", f"'{uid}:{gid}:755'")
            content = content.replace("'0:0:600'", f"'{uid}:{gid}:600'")
            content = content.replace("'0:0:600:1'", f"'{uid}:{gid}:600:1'")
            content = content.replace("-o root -g root", f"-o {uid} -g {gid}")
            content = content.replace("chown root:root", f"chown {uid}:{gid}")
            destination = root / f"{name}.sh"
            destination.write_text(content, encoding="utf-8")
            destination.chmod(0o755)
            scripts[name] = destination
        return scripts, installed

    def test_overlay_is_deb_rpm_only_and_installs_fixed_assets(self) -> None:
        overlay = json.loads(OVERLAY.read_text(encoding="utf-8"))
        bundle = overlay["bundle"]
        self.assertEqual(bundle["targets"], ["deb", "rpm"])
        self.assertFalse(bundle["createUpdaterArtifacts"])
        self.assertNotIn("appimage", bundle["linux"])
        self.assertEqual(
            bundle["icon"],
            [
                "platform/sockscap/linux/staged/icons/32x32.png",
                "platform/sockscap/linux/staged/icons/128x128.png",
                "platform/sockscap/linux/staged/icons/128x128@2x.png",
            ],
        )
        for kind in ("deb", "rpm"):
            package = bundle["linux"][kind]
            self.assertEqual(package["files"], EXPECTED_FILES)
            self.assertEqual(
                package["preInstallScript"],
                "platform/sockscap/linux/packaging/require-clean-state.sh",
            )
            self.assertEqual(package["preRemoveScript"], package["preInstallScript"])

    def test_maintainer_scripts_are_executable_and_do_not_delete_evidence(self) -> None:
        packaging = LINUX_ASSETS / "packaging"
        for name in ("require-clean-state.sh", "post-install.sh", "post-remove.sh"):
            path = packaging / name
            self.assertTrue(path.is_file())
            self.assertTrue(path.stat().st_mode & stat.S_IXUSR)
            subprocess.run(["sh", "-n", str(path)], check=True)
        post_remove = (packaging / "post-remove.sh").read_text(encoding="utf-8")
        self.assertNotRegex(post_remove, r"(?m)^\s*rm(?:\s|$)")
        self.assertNotIn("find ", post_remove)
        self.assertIn('rmdir "$runtime_dir"', post_remove)
        self.assertIn("remove|purge|0)", post_remove)
        self.assertIn("upgrade|failed-upgrade", post_remove)

        clean_guard = (packaging / "require-clean-state.sh").read_text(
            encoding="utf-8"
        )
        self.assertIn('"$runtime_dir"/.[!.]*', clean_guard)
        self.assertIn('"$runtime_dir"/..?*', clean_guard)
        self.assertIn('[ -e "$runtime_dir" ] && [ ! -d "$runtime_dir" ]', clean_guard)
        self.assertIn("if ! nft_tables=$(nft list tables 2>&1)", clean_guard)
        self.assertIn("if ! link_state=$(ip -o link show 2>&1)", clean_guard)
        self.assertIn("ip -o -4 route show table all", clean_guard)
        self.assertIn("ip -o -6 route show table all", clean_guard)
        self.assertIn("table 42[0-9]{3}", clean_guard)
        self.assertGreaterEqual(clean_guard.count("audit_runtime_entries"), 3)
        self.assertIn("flock -n -x 9", clean_guard)
        self.assertIn("sockscap-package-operation", clean_guard)

        post_install = (packaging / "post-install.sh").read_text(encoding="utf-8")
        self.assertIn('case "${1:-}"', post_install)
        self.assertIn("2)", post_install)
        self.assertIn("completed package-operation sentinel", post_install)

    def test_canonical_candidate_build_is_explicit_and_policy_gated(self) -> None:
        self.assertTrue(BUILD_CANDIDATES.is_file())
        self.assertTrue(BUILD_CANDIDATES.stat().st_mode & stat.S_IXUSR)
        subprocess.run(["bash", "-n", str(BUILD_CANDIDATES)], check=True)
        subprocess.run(["bash", str(BUILD_CANDIDATES), "--lint"], check=True)
        source = BUILD_CANDIDATES.read_text(encoding="utf-8")
        self.assertIn("tauri.sockscap.linux.conf.json", source)
        self.assertIn("--bundles deb,rpm", source)
        self.assertIn('.configurationState == "configured"', source)
        self.assertIn('.packageDependencyContractState == "configured"', source)
        self.assertIn("reviewed_fingerprint", source)
        self.assertNotIn("appimage", source.split("exec pnpm", 1)[-1].lower())

    def test_stage_uses_final_elfs_and_generates_matching_policy(self) -> None:
        true_binary = shutil.which("true")
        false_binary = shutil.which("false")
        if true_binary is None or false_binary is None:
            self.skipTest("system ELF fixtures are unavailable")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            application = root / "taomni"
            helper = root / "sockscap-helper"
            stage = root / "staged"
            shutil.copy2(true_binary, application)
            shutil.copy2(false_binary, helper)
            application.chmod(0o755)
            helper.chmod(0o755)
            environment = os.environ.copy()
            environment.update(
                TAURI_ENV_PLATFORM="linux",
                TAURI_ENV_DEBUG="false",
                SOCKSCAP_LINUX_STAGE_TEST="1",
                SOCKSCAP_LINUX_STAGE_DIR=str(stage),
                SOCKSCAP_LINUX_APPLICATION_BIN=str(application),
                SOCKSCAP_LINUX_HELPER_BIN=str(helper),
            )
            subprocess.run(["bash", str(STAGE)], env=environment, check=True)

            policy = json.loads(
                (stage / "sockscap-helper-policy.json").read_text(encoding="utf-8")
            )
            self.assertEqual(
                policy["allowedCallerSha256"],
                [hashlib.sha256(application.read_bytes()).hexdigest()],
            )
            self.assertEqual(
                policy["allowedHelperSha256"],
                [hashlib.sha256(helper.read_bytes()).hexdigest()],
            )
            self.assertEqual(stat.S_IMODE((stage / "sockscap-helper").stat().st_mode), 0o755)
            self.assertEqual(
                stat.S_IMODE((stage / "sockscap-helper-policy.json").stat().st_mode),
                0o644,
            )
            self.assertEqual(
                (stage / "com.taomni.sockscap.policy").read_bytes(),
                (LINUX_ASSETS / "com.taomni.sockscap.policy").read_bytes(),
            )

    def test_stage_test_mode_requires_all_isolated_overrides(self) -> None:
        environment = os.environ.copy()
        environment.update(
            TAURI_ENV_PLATFORM="linux",
            TAURI_ENV_DEBUG="false",
            SOCKSCAP_LINUX_STAGE_TEST="1",
        )
        result = subprocess.run(
            ["bash", str(STAGE)],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("requires stage, application, and helper overrides", result.stderr)

        environment.update(
            SOCKSCAP_LINUX_STAGE_DIR=str(
                TAURI_DIR / "platform" / "sockscap" / "linux" / "staged"
            ),
            SOCKSCAP_LINUX_APPLICATION_BIN="/bin/true",
            SOCKSCAP_LINUX_HELPER_BIN="/bin/false",
        )
        result = subprocess.run(
            ["bash", str(STAGE)],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must not target the committed package stage", result.stderr)

    def test_stage_refuses_non_release_or_non_linux_invocation(self) -> None:
        for platform, debug in (("windows", "false"), ("linux", "true")):
            environment = os.environ.copy()
            environment.update(TAURI_ENV_PLATFORM=platform, TAURI_ENV_DEBUG=debug)
            result = subprocess.run(
                ["bash", str(STAGE)],
                env=environment,
                stdout=subprocess.PIPE,
                stderr=subprocess.PIPE,
                text=True,
                check=False,
            )
            self.assertNotEqual(result.returncode, 0)

    def test_stage_refuses_binary_override_outside_explicit_test_mode(self) -> None:
        environment = os.environ.copy()
        environment.update(
            TAURI_ENV_PLATFORM="linux",
            TAURI_ENV_DEBUG="false",
            SOCKSCAP_LINUX_APPLICATION_BIN="/bin/true",
        )
        environment.pop("SOCKSCAP_LINUX_STAGE_TEST", None)
        result = subprocess.run(
            ["bash", str(STAGE)],
            env=environment,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("binary overrides are test-only", result.stderr)

    def test_direct_real_stage_fails_closed_on_unconfigured_release_policy(self) -> None:
        environment = os.environ.copy()
        environment.update(TAURI_ENV_PLATFORM="linux", TAURI_ENV_DEBUG="false")
        for variable in (
            "SOCKSCAP_LINUX_STAGE_TEST",
            "SOCKSCAP_LINUX_STAGE_DIR",
            "SOCKSCAP_LINUX_APPLICATION_BIN",
            "SOCKSCAP_LINUX_HELPER_BIN",
        ):
            environment.pop(variable, None)
        result = subprocess.run(
            [
                "bash",
                "-c",
                f"umask 022; exec bash {shlex.quote(str(STAGE))}",
            ],
            env=environment,
            text=True,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("signer identities are not configured", result.stderr)

    def test_package_lifecycle_lock_and_crash_sentinel_fail_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts, _installed = self.render_maintainer_scripts(root)
            runtime = root / "run" / "taomni"
            environment = os.environ.copy()

            runtime.mkdir(parents=True)
            runtime.chmod(0o777)
            unsafe = subprocess.run(
                ["sh", str(scripts["require-clean-state"])],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(unsafe.returncode, 0)
            self.assertIn("mode 0755", unsafe.stderr)
            runtime.chmod(0o755)

            uid = os.getuid()
            gid = os.getgid()
            for label, expected in (
                ("uid", f"'{uid + 1}:{gid}:755'"),
                ("gid", f"'{uid}:{gid + 1}:755'"),
            ):
                wrong_owner_script = root / f"wrong-{label}.sh"
                wrong_owner_script.write_text(
                    scripts["require-clean-state"]
                    .read_text(encoding="utf-8")
                    .replace(f"'{uid}:{gid}:755'", expected),
                    encoding="utf-8",
                )
                wrong_owner_script.chmod(0o755)
                wrong_owner = subprocess.run(
                    ["sh", str(wrong_owner_script)],
                    env=environment,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertNotEqual(wrong_owner.returncode, 0)
                self.assertIn("root:root with mode 0755", wrong_owner.stderr)

            started = subprocess.run(
                ["sh", str(scripts["require-clean-state"])],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(started.returncode, 0, started.stderr)
            sentinel = runtime / "sockscap-package-operation"
            lifecycle_lock = runtime / "sockscap-lifecycle.lock"
            self.assertTrue(sentinel.is_file())
            self.assertEqual(stat.S_IMODE(sentinel.stat().st_mode), 0o600)

            # A failed/crashed transaction remains blocked for a new identity.
            sentinel.write_text("v1 foreign transaction\n", encoding="utf-8")
            refused = subprocess.run(
                ["sh", str(scripts["require-clean-state"])],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertNotEqual(refused.returncode, 0)
            self.assertTrue(sentinel.exists())
            sentinel.unlink()

            with lifecycle_lock.open("r+") as lock_file:
                fcntl.flock(lock_file.fileno(), fcntl.LOCK_SH | fcntl.LOCK_NB)
                concurrent = subprocess.run(
                    ["sh", str(scripts["require-clean-state"])],
                    env=environment,
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertNotEqual(concurrent.returncode, 0)
                self.assertIn("helper is active", concurrent.stderr)

            restarted = subprocess.run(
                ["sh", str(scripts["require-clean-state"])],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(restarted.returncode, 0, restarted.stderr)
            rpm_new_post = subprocess.run(
                ["sh", str(scripts["post-install"]), "2"],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(rpm_new_post.returncode, 0, rpm_new_post.stderr)
            self.assertTrue(sentinel.exists())
            rpm_old_postun = subprocess.run(
                ["sh", str(scripts["post-remove"]), "1"],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(rpm_old_postun.returncode, 0, rpm_old_postun.stderr)
            self.assertFalse(sentinel.exists())

            deb_remove_start = subprocess.run(
                ["sh", str(scripts["require-clean-state"]), "remove"],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(deb_remove_start.returncode, 0, deb_remove_start.stderr)
            deb_remove = subprocess.run(
                ["sh", str(scripts["post-remove"]), "remove"],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(deb_remove.returncode, 0, deb_remove.stderr)
            deb_purge = subprocess.run(
                ["sh", str(scripts["post-remove"]), "purge"],
                env=environment,
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(deb_purge.returncode, 0, deb_purge.stderr)

    def test_package_runtime_mutation_and_directory_replacement_are_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            scripts, _installed = self.render_maintainer_scripts(root)
            runtime = root / "run" / "taomni"
            runtime.mkdir(parents=True)
            runtime.chmod(0o755)
            lock = runtime / "sockscap-lifecycle.lock"
            lock.write_bytes(b"")
            lock.chmod(0o600)

            def launch_and_mutate(mutation) -> subprocess.CompletedProcess[str]:
                ready = root / "ready"
                go = root / "go"
                ready.unlink(missing_ok=True)
                go.unlink(missing_ok=True)
                environment = os.environ.copy()
                environment.update(
                    SOCKSCAP_TEST_READY=str(ready),
                    SOCKSCAP_TEST_GO=str(go),
                )
                process = subprocess.Popen(
                    ["sh", str(scripts["require-clean-state"])],
                    env=environment,
                    text=True,
                    stdout=subprocess.PIPE,
                    stderr=subprocess.PIPE,
                )
                deadline = time.monotonic() + 5
                while not ready.exists() and process.poll() is None:
                    self.assertLess(time.monotonic(), deadline)
                    time.sleep(0.01)
                mutation()
                go.touch()
                stdout, stderr = process.communicate(timeout=5)
                return subprocess.CompletedProcess(
                    process.args, process.returncode, stdout, stderr
                )

            mutated = launch_and_mutate(
                lambda: (runtime / "sockscap-active-generation").write_text(
                    "active", encoding="utf-8"
                )
            )
            self.assertNotEqual(mutated.returncode, 0)
            self.assertIn("unrecognized runtime state", mutated.stderr)
            (runtime / "sockscap-active-generation").unlink()

            original = root / "run" / "taomni-original"

            def replace_directory() -> None:
                runtime.rename(original)
                runtime.mkdir(mode=0o755)
                replacement_lock = runtime / "sockscap-lifecycle.lock"
                replacement_lock.write_bytes(b"")
                replacement_lock.chmod(0o600)

            replaced = launch_and_mutate(replace_directory)
            self.assertNotEqual(replaced.returncode, 0)
            self.assertIn("changed while cleanup state was audited", replaced.stderr)


if __name__ == "__main__":
    unittest.main()
