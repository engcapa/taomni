#!/usr/bin/env python3
"""Focused, unprivileged tests for the Linux Sockscap artifact Gate."""

from __future__ import annotations

from copy import deepcopy
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import unittest
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPT_PATH = Path(__file__).with_name("verify-linux-release.py")
SPEC = importlib.util.spec_from_file_location("verify_linux_release", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
GATE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = GATE
SPEC.loader.exec_module(GATE)
POLICY_PATH = ROOT / "src-tauri" / "platform" / "sockscap" / "linux" / "release-policy.json"
TEMPLATE_PATH = ROOT / "src-tauri" / "platform" / "sockscap" / "linux" / "release-manifest.template.json"
POLKIT_PATH = ROOT / "src-tauri" / "platform" / "sockscap" / "linux" / "com.taomni.sockscap.policy"
FINGERPRINT = "0123456789ABCDEF0123456789ABCDEF01234567"
OTHER_FINGERPRINT = "89ABCDEF0123456789ABCDEF0123456789ABCDEF"
TEST_PACKAGE_SCRIPTS = {
    "require-clean-state": b"#!/bin/sh\nset -eu\nexit 0\n",
    "post-install": b"#!/bin/sh\nset -eu\necho installed >/dev/null\n",
    "post-remove": b"#!/bin/sh\nset -eu\necho removed >/dev/null\n",
}


def sha256_bytes(value: bytes) -> str:
    return hashlib.sha256(value).hexdigest()


def load_json(path: Path) -> dict:
    return json.loads(path.read_text(encoding="utf-8"))


def write_json(path: Path, value: dict) -> None:
    path.write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def configure_package_script_policy(policy: dict) -> None:
    for logical_name, content in TEST_PACKAGE_SCRIPTS.items():
        evidence = GATE.package_script_evidence(content, logical_name, "/bin/sh")
        definition = policy["packageScripts"]["definitions"][logical_name]
        definition["normalizedSha256"] = evidence["normalizedSha256"]
        for kind in ("deb", "rpm"):
            definition["rawSha256"][kind] = evidence["rawSha256"]


def configure_release_identity(policy: dict) -> None:
    policy["configurationState"] = "configured"
    policy["packageDependencyContractState"] = "configured"
    policy["supportedArchitectures"] = ["x86_64"]
    for kind in ("deb", "rpm"):
        policy["packageSignatures"][kind]["signerFingerprint"] = FINGERPRINT


def package_script_evidence_for(policy: dict, kind: str) -> dict:
    return {
        phase: GATE.package_script_evidence(
            TEST_PACKAGE_SCRIPTS[logical_name],
            f"{kind} {phase}",
            "/bin/sh",
        )
        for phase, logical_name in policy["packageScripts"]["mappings"][kind].items()
    }


def package_dependency_evidence_for(policy: dict, kind: str) -> dict:
    requirements = policy["packageDependencies"][kind]
    if kind == "deb":
        return GATE.parse_deb_dependencies(", ".join(requirements))
    return GATE.parse_rpm_dependencies("\n".join([*requirements, "/bin/sh"]))


def payload_entry(path: str, content: bytes, mode: str) -> dict:
    return {
        "path": path,
        "type": "file",
        "mode": mode,
        "owner": "root",
        "group": "root",
        "size": len(content),
        "sha256": sha256_bytes(content),
        "linkTarget": "",
    }


def fixed_noninstalled_payload_entries(policy: dict) -> list[dict]:
    paths = [*policy["packagePayload"]["desktopFiles"], *policy["packagePayload"]["iconFiles"]]
    return [payload_entry(path, f"payload:{path}".encode(), "0644") for path in paths]


def gate_error(test: unittest.TestCase, code: str):
    context = test.assertRaises(GATE.LinuxGateError)

    class ErrorContext:
        def __enter__(self):
            return context.__enter__()

        def __exit__(self, exc_type, exc, traceback):
            result = context.__exit__(exc_type, exc, traceback)
            test.assertEqual(context.exception.code, code)
            return result

    return ErrorContext()


class LinuxReleaseGateTests(unittest.TestCase):
    def test_committed_disabled_template_lints_with_unconfigured_policy(self) -> None:
        receipt = GATE.lint_manifest(TEMPLATE_PATH, policy_path=POLICY_PATH)
        self.assertEqual(receipt["result"], "PASS")
        self.assertEqual(receipt["mode"], "lint")
        self.assertFalse(receipt["captureReleaseEnabled"])
        self.assertEqual(receipt["releasePolicyConfigurationState"], "unconfigured")
        self.assertEqual(receipt["artifactManifestPath"], str(TEMPLATE_PATH))
        self.assertEqual(receipt["artifactManifestSha256"], sha256_bytes(TEMPLATE_PATH.read_bytes()))

    def test_fixed_package_script_hashes_match_reviewed_sources(self) -> None:
        policy = load_json(POLICY_PATH)
        packaging = ROOT / "src-tauri" / "platform" / "sockscap" / "linux" / "packaging"
        for logical_name in GATE.PACKAGE_SCRIPT_NAMES:
            content = (packaging / f"{logical_name}.sh").read_bytes()
            evidence = GATE.package_script_evidence(content, logical_name, "/bin/sh")
            definition = policy["packageScripts"]["definitions"][logical_name]
            self.assertEqual(definition["normalizedSha256"], evidence["normalizedSha256"])
            self.assertEqual(definition["rawSha256"], {"deb": evidence["rawSha256"], "rpm": evidence["rawSha256"]})

    def test_unconfigured_policy_fails_before_artifact_or_tool_access(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            manifest = load_json(TEMPLATE_PATH)
            manifest.update(
                {
                    "captureReleaseEnabled": True,
                    "gitCommit": "a" * 40,
                    "buildId": "candidate-1",
                }
            )
            manifest["package"]["sha256"] = "1" * 64
            manifest["package"]["signature"]["sha256"] = "2" * 64
            manifest["package"]["signature"]["publicKeySha256"] = "3" * 64
            path = Path(directory) / "manifest.json"
            write_json(path, manifest)
            with gate_error(self, "LINUX_RELEASE_POLICY_UNCONFIGURED"):
                GATE.verify_release(path, policy_path=POLICY_PATH)

    def test_manifest_cannot_override_fixed_helper_path_or_add_boolean_proofs(self) -> None:
        policy = load_json(POLICY_PATH)
        manifest = load_json(TEMPLATE_PATH)
        manifest["installedArtifacts"]["helper"] = "/tmp/manifest-controlled-helper"
        with gate_error(self, "LINUX_RELEASE_POLICY_MISMATCH"):
            GATE.validate_manifest(manifest, policy, lint=True)

        manifest = load_json(TEMPLATE_PATH)
        manifest["packageSignatureVerified"] = True
        with gate_error(self, "LINUX_SCHEMA_INVALID"):
            GATE.validate_manifest(manifest, policy, lint=True)

    def test_capture_packaging_is_deb_rpm_only_and_appimage_stays_disabled(self) -> None:
        policy = load_json(POLICY_PATH)
        manifest = load_json(TEMPLATE_PATH)
        manifest["package"]["kind"] = "appimage"
        with gate_error(self, "LINUX_PACKAGE_KIND_INVALID"):
            GATE.validate_manifest(manifest, policy, lint=True)

        policy["appImageCaptureDisabled"] = False
        with gate_error(self, "LINUX_RELEASE_POLICY_INVALID"):
            GATE.validate_policy(policy)

    def test_fixed_package_dependencies_cannot_be_relaxed_and_must_be_direct(self) -> None:
        policy = load_json(POLICY_PATH)
        policy["packageDependencies"]["deb"].remove("nftables")
        with gate_error(self, "LINUX_RELEASE_POLICY_INVALID"):
            GATE.validate_policy(policy)

        policy = load_json(POLICY_PATH)
        deb_dependencies = GATE.parse_deb_dependencies(
            "iproute2 | unsafe-route-provider, nftables, policykit-1"
        )
        with gate_error(self, "LINUX_PACKAGE_DEPENDENCY_INVALID"):
            GATE.verify_package_dependencies(
                {"dependencies": deb_dependencies},
                policy,
                "deb",
            )

        extra_deb_dependencies = GATE.parse_deb_dependencies(
            "iproute2, nftables, policykit-1, curl"
        )
        with gate_error(self, "LINUX_PACKAGE_DEPENDENCY_INVALID"):
            GATE.verify_package_dependencies(
                {"dependencies": extra_deb_dependencies}, policy, "deb"
            )

        rpm_dependencies = GATE.parse_rpm_dependencies("iproute\nnftables\n/bin/sh\n")
        with gate_error(self, "LINUX_PACKAGE_DEPENDENCY_MISSING"):
            GATE.verify_package_dependencies(
                {"dependencies": rpm_dependencies},
                policy,
                "rpm",
            )
        extra_rpm_dependencies = GATE.parse_rpm_dependencies(
            "iproute\nnftables\npolkit\n/bin/sh\ncurl\n"
        )
        with gate_error(self, "LINUX_PACKAGE_DEPENDENCY_INVALID"):
            GATE.verify_package_dependencies(
                {"dependencies": extra_rpm_dependencies}, policy, "rpm"
            )

        for kind in ("deb", "rpm"):
            verified = GATE.verify_package_dependencies(
                {"dependencies": package_dependency_evidence_for(policy, kind)},
                policy,
                kind,
            )
            self.assertEqual(verified["required"], policy["packageDependencies"][kind])

    def test_payload_allowlist_rejects_dangerous_types_modes_owners_and_extra_paths(self) -> None:
        policy = load_json(POLICY_PATH)
        entries = []
        for role in GATE.ROLE_NAMES:
            contract = policy["installedArtifacts"][role]
            entries.append(payload_entry(contract["path"], role.encode(), contract["mode"]))
        entries.extend(fixed_noninstalled_payload_entries(policy))
        entries.append(
            {
                "path": "/usr",
                "type": "directory",
                "mode": "0755",
                "owner": "root",
                "group": "root",
                "size": 0,
                "sha256": "",
                "linkTarget": "",
            }
        )
        GATE.verify_package_payload({"entries": entries}, policy)

        target_index = len(GATE.ROLE_NAMES)
        for forbidden_type in ("symlink", "hardlink", "char_device", "block_device", "fifo", "other"):
            changed = deepcopy(entries)
            changed[target_index]["type"] = forbidden_type
            changed[target_index]["linkTarget"] = "/tmp/redirect" if "link" in forbidden_type else ""
            with self.subTest(forbidden_type=forbidden_type), gate_error(self, "LINUX_PACKAGE_CONTENT_INVALID"):
                GATE.verify_package_payload({"entries": changed}, policy)

        for field, value in (("owner", "1000"), ("group", "users"), ("mode", "4644"), ("mode", "2644"), ("mode", "0666")):
            changed = deepcopy(entries)
            changed[target_index][field] = value
            with self.subTest(field=field, value=value), gate_error(self, "LINUX_PACKAGE_CONTENT_INVALID"):
                GATE.verify_package_payload({"entries": changed}, policy)

        changed = deepcopy(entries)
        changed.append(payload_entry("/usr/bin/unreviewed-tool", b"unsafe", "0755"))
        with gate_error(self, "LINUX_PACKAGE_CONTENT_INVALID"):
            GATE.verify_package_payload({"entries": changed}, policy)

        changed = deepcopy(entries)
        del changed[target_index]
        with gate_error(self, "LINUX_PACKAGE_CONTENT_INVALID"):
            GATE.verify_package_payload({"entries": changed}, policy)

        changed = deepcopy(entries)
        changed[-1]["mode"] = "0777"
        with gate_error(self, "LINUX_PACKAGE_CONTENT_INVALID"):
            GATE.verify_package_payload({"entries": changed}, policy)

    def test_configured_policy_requires_full_fingerprints_and_architecture(self) -> None:
        policy = load_json(POLICY_PATH)
        policy["configurationState"] = "configured"
        policy["packageDependencyContractState"] = "configured"
        policy["supportedArchitectures"] = ["x86_64"]
        policy["packageSignatures"]["deb"]["signerFingerprint"] = "DEADBEEF"
        policy["packageSignatures"]["rpm"]["signerFingerprint"] = FINGERPRINT
        with gate_error(self, "LINUX_SIGNER_FINGERPRINT_INVALID"):
            GATE.validate_policy(policy)

        policy["packageSignatures"]["deb"]["signerFingerprint"] = FINGERPRINT
        policy["supportedArchitectures"] = []
        with gate_error(self, "LINUX_RELEASE_POLICY_INVALID"):
            GATE.validate_policy(policy)

        policy["supportedArchitectures"] = ["x86_64"]
        policy["packageDependencyContractState"] = "unconfigured"
        with gate_error(self, "LINUX_RELEASE_POLICY_INVALID"):
            GATE.validate_policy(policy)

    def test_helper_policy_requires_exact_installed_pins(self) -> None:
        app_hash = sha256_bytes(b"app")
        helper_hash = sha256_bytes(b"helper")
        contract = load_json(POLICY_PATH)["helperPolicy"]
        policy = {
            "schemaVersion": 1,
            "productId": "com.taomni.app",
            "allowedCallerSha256": [app_hash],
            "allowedHelperSha256": [helper_hash],
            "allowedRuntimeSha256": [app_hash],
        }
        GATE.verify_helper_policy(json.dumps(policy).encode(), contract, app_hash, helper_hash)

        policy["allowedRuntimeSha256"].append("f" * 64)
        with gate_error(self, "LINUX_HELPER_POLICY_PIN_MISMATCH"):
            GATE.verify_helper_policy(json.dumps(policy).encode(), contract, app_hash, helper_hash)

    def test_polkit_contract_rejects_retained_or_extra_execution_annotation(self) -> None:
        contract = load_json(POLICY_PATH)["polkit"]
        GATE.verify_polkit_action(POLKIT_PATH.read_bytes(), contract)
        changed = POLKIT_PATH.read_text(encoding="utf-8").replace(
            "</action>",
            '<annotate key="org.freedesktop.policykit.exec.allow_gui">true</annotate></action>',
        )
        with gate_error(self, "LINUX_POLKIT_INVALID"):
            GATE.verify_polkit_action(changed.encode(), contract)
        retained = POLKIT_PATH.read_text(encoding="utf-8").replace("auth_admin", "auth_admin_keep")
        with gate_error(self, "LINUX_POLKIT_INVALID"):
            GATE.verify_polkit_action(retained.encode(), contract)

    def test_installed_metadata_rejects_wrong_owner_mode_and_helper_capabilities(self) -> None:
        contract = load_json(POLICY_PATH)["installedArtifacts"]["helper"]
        path = Path(contract["path"])
        base = GATE.StableFile(
            path, "a" * 64, 10, 0, 0, 0o755, file_capabilities=b""
        )
        with mock.patch.object(GATE, "read_stable_file", return_value=base):
            GATE.inspect_installed_artifact(path, "helper", contract)

        with mock.patch.object(
            GATE,
            "read_stable_file",
            return_value=GATE.StableFile(path, "a" * 64, 10, 1000, 0, 0o755),
        ):
            with gate_error(self, "LINUX_ARTIFACT_OWNER_INVALID"):
                GATE.inspect_installed_artifact(path, "helper", contract)

        with mock.patch.object(
            GATE,
            "read_stable_file",
            return_value=GATE.StableFile(path, "a" * 64, 10, 0, 0, 0o4755),
        ):
            with gate_error(self, "LINUX_ARTIFACT_MODE_INVALID"):
                GATE.inspect_installed_artifact(path, "helper", contract)

        with mock.patch.object(
            GATE,
            "read_stable_file",
            return_value=GATE.StableFile(
                path,
                "a" * 64,
                10,
                0,
                0,
                0o755,
                file_capabilities=b"capability",
            ),
        ):
            with gate_error(self, "LINUX_HELPER_FILE_CAPABILITIES_INVALID"):
                GATE.inspect_installed_artifact(path, "helper", contract)

    def test_installed_helper_capabilities_are_read_from_the_hashed_fd(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            helper = Path(directory) / "sockscap-helper"
            helper.write_bytes(b"helper")
            helper.chmod(0o755)
            contract = deepcopy(
                load_json(POLICY_PATH)["installedArtifacts"]["helper"]
            )
            contract["uid"] = os.getuid()
            contract["gid"] = os.getgid()
            targets: list[object] = []

            def no_capability(target, name):
                targets.append(target)
                self.assertEqual(name, "security.capability")
                return b""

            with mock.patch.object(os, "getxattr", side_effect=no_capability):
                GATE.inspect_installed_artifact(helper, "helper", contract)
            self.assertEqual(len(targets), 1)
            self.assertIsInstance(targets[0], int)

    def test_stable_reader_rejects_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target"
            target.write_bytes(b"target")
            link = root / "link"
            link.symlink_to(target)
            with gate_error(self, "LINUX_ARTIFACT_SYMLINK"):
                GATE.read_stable_file(link, "test artifact")

    def test_snapshot_is_private_and_source_replacement_is_detected(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "candidate.deb"
            source.write_bytes(b"candidate-a")
            snapshot_directory = root / "snapshots"
            snapshot_directory.mkdir(mode=0o700)
            evidence, snapshot = GATE.snapshot_stable_file(
                source,
                "candidate",
                snapshot_directory,
                "package.bin",
            )
            self.assertEqual(snapshot.read_bytes(), b"candidate-a")
            self.assertEqual(stat.S_IMODE(snapshot.stat().st_mode), 0o600)
            replacement = root / "replacement"
            replacement.write_bytes(b"candidate-a")
            replacement.replace(source)
            with gate_error(self, "LINUX_ARTIFACT_CHANGED"):
                GATE.verify_source_unchanged(source, evidence, "candidate")

    def test_external_tools_receive_a_minimal_environment(self) -> None:
        hostile = {
            "LD_PRELOAD": "/tmp/attack.so",
            "LD_AUDIT": "/tmp/audit.so",
            "LD_LIBRARY_PATH": "/tmp/lib",
            "RPM_CONFIGDIR": "/tmp/rpm",
            "GNUPGHOME": "/tmp/gnupg",
            "PYTHONPATH": "/tmp/python",
        }
        with mock.patch.dict(os.environ, hostile, clear=False), mock.patch.object(
            GATE, "resolve_tool", return_value="/usr/bin/fixture-tool"
        ), mock.patch.object(
            GATE.subprocess,
            "run",
            return_value=subprocess.CompletedProcess([], 0, "", ""),
        ) as runner:
            GATE.run_tool("fixture-tool", ["--version"])
        environment = runner.call_args.kwargs["env"]
        for variable in hostile:
            self.assertNotIn(variable, environment)
        self.assertEqual(environment["HOME"], "/nonexistent")
        self.assertEqual(environment["TMPDIR"], "/tmp")
        self.assertEqual(environment["LC_ALL"], "C")

    def test_detached_signature_requires_validsig_from_fixed_full_fingerprint(self) -> None:
        gpgv_arguments: list[str] = []

        def fake_run(name: str, arguments: list[str], check: bool = True):
            if name == "gpgv":
                gpgv_arguments.extend(arguments)
                return subprocess.CompletedProcess(
                    [],
                    0,
                    f"[GNUPG:] VALIDSIG {OTHER_FINGERPRINT} 0 0 0 4 0 1 10 00\n",
                    "",
                )
            return subprocess.CompletedProcess([], 0, "", "")

        with mock.patch.object(GATE, "run_tool", side_effect=fake_run):
            with gate_error(self, "LINUX_PACKAGE_SIGNER_MISMATCH"):
                GATE.verify_deb_signature(
                    Path("/package.deb"),
                    Path("/package.deb.asc"),
                    Path("/key.asc"),
                    FINGERPRINT,
                )
        self.assertIn("--keyring", gpgv_arguments)
        self.assertTrue(gpgv_arguments[gpgv_arguments.index("--keyring") + 1].endswith("release-signing-key.gpg"))

    def test_real_ephemeral_gpg_detached_signature_round_trip(self) -> None:
        try:
            gpg = GATE.resolve_tool("gpg")
            GATE.resolve_tool("gpgv")
        except GATE.LinuxGateError:
            self.skipTest("gpg/gpgv are unavailable")
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            home = root / "signer-home"
            home.mkdir(mode=0o700)
            parameters = root / "key-parameters"
            parameters.write_text(
                "Key-Type: RSA\n"
                "Key-Length: 2048\n"
                "Key-Usage: sign\n"
                "Name-Real: Taomni Linux Gate Test\n"
                "Name-Email: linux-gate-test@invalid.example\n"
                "Expire-Date: 1d\n"
                "%no-protection\n"
                "%commit\n",
                encoding="utf-8",
            )
            generated = subprocess.run(
                [gpg, "--batch", "--no-options", "--homedir", str(home), "--generate-key", str(parameters)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(generated.returncode, 0, generated.stderr)
            exported = subprocess.run(
                [gpg, "--batch", "--no-options", "--homedir", str(home), "--armor", "--export"],
                capture_output=True,
                check=False,
            )
            self.assertEqual(exported.returncode, 0, exported.stderr.decode("utf-8", "replace"))
            public_key = root / "release-key.asc"
            public_key.write_bytes(exported.stdout)
            package = root / "candidate.deb"
            package.write_bytes(b"ephemeral signed package\n")
            signature = root / "candidate.deb.asc"
            signed = subprocess.run(
                [
                    gpg,
                    "--batch",
                    "--no-options",
                    "--homedir",
                    str(home),
                    "--detach-sign",
                    "--output",
                    str(signature),
                    str(package),
                ],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(signed.returncode, 0, signed.stderr)
            fingerprint = GATE.openpgp_primary_fingerprint(public_key)
            self.assertEqual(
                GATE.verify_deb_signature(package, signature, public_key, fingerprint),
                fingerprint,
            )

    def test_rpm_digest_only_output_is_not_signature_evidence(self) -> None:
        def fake_run(name: str, arguments: list[str], check: bool = True):
            if name == "rpmkeys" and "--checksig" in arguments:
                return subprocess.CompletedProcess([], 0, "/package.rpm: digests OK\n", "")
            return subprocess.CompletedProcess([], 0, "", "")

        with mock.patch.object(GATE, "run_tool", side_effect=fake_run):
            with gate_error(self, "LINUX_PACKAGE_SIGNATURE_INVALID"):
                GATE.verify_rpm_signature(Path("/package.rpm"), Path("/key.asc"), FINGERPRINT)

    def test_rpm_payload_query_rejects_hardlink_inode_reuse(self) -> None:
        digest_a = sha256_bytes(b"a")
        digest_b = sha256_bytes(b"b")
        payload = (
            f"/usr/bin/taomni\t0100755\troot\troot\t1\t{digest_a}\t\t42\t1\t(none)\t0\n"
            f"/usr/libexec/taomni/sockscap-helper\t0100755\troot\troot\t1\t{digest_b}\t\t42\t1\t(none)\t0\n"
        )

        def fake_run(_name: str, arguments: list[str], check: bool = True):
            if "--requires" in arguments:
                return subprocess.CompletedProcess([], 0, "iproute\nnftables\npolkit\n", "")
            query_format = arguments[arguments.index("--qf") + 1]
            if query_format.startswith("%{NAME}"):
                return subprocess.CompletedProcess([], 0, "taomni\n1.0.0-1\nx86_64\n8\n", "")
            return subprocess.CompletedProcess([], 0, payload, "")

        with mock.patch.object(GATE, "run_tool", side_effect=fake_run):
            with gate_error(self, "LINUX_PACKAGE_CONTENT_INVALID"):
                GATE.inspect_rpm_package(Path("/candidate.rpm"), "taomni", "x86_64")

        capability_payload = (
            f"/usr/bin/taomni\t0100755\troot\troot\t1\t{digest_a}\t\t0\t0\t"
            "cap_net_admin=ep\t0\n"
        )
        file_flag_payload = (
            f"/usr/bin/taomni\t0100755\troot\troot\t1\t{digest_a}\t\t0\t0\t"
            "(none)\t1\n"
        )
        for payload_value, code in (
            (capability_payload, "LINUX_PACKAGE_CONTENT_INVALID"),
            (file_flag_payload, "LINUX_PACKAGE_SEMANTICS_INVALID"),
        ):

            def fake_metadata_run(
                _name: str,
                arguments: list[str],
                check: bool = True,
                payload_value: str = payload_value,
            ):
                if "--requires" in arguments:
                    return subprocess.CompletedProcess(
                        [], 0, "iproute\nnftables\npolkit\n", ""
                    )
                query_format = arguments[arguments.index("--qf") + 1]
                if query_format.startswith("%{NAME}"):
                    return subprocess.CompletedProcess(
                        [], 0, "taomni\n1.0.0-1\nx86_64\n8\n", ""
                    )
                return subprocess.CompletedProcess([], 0, payload_value, "")

            with self.subTest(code=code), mock.patch.object(
                GATE, "run_tool", side_effect=fake_metadata_run
            ), gate_error(self, code):
                GATE.inspect_rpm_package(
                    Path("/candidate.rpm"), "taomni", "x86_64"
                )

    def test_package_script_verification_rejects_mutation_and_omission(self) -> None:
        policy = load_json(POLICY_PATH)
        configure_release_identity(policy)
        configure_package_script_policy(policy)
        GATE.validate_policy(policy)

        for kind, mutated_phase, omitted_phase in (
            ("deb", "postinst", "postrm"),
            ("rpm", "post", "postun"),
        ):
            scripts = package_script_evidence_for(policy, kind)
            verified = GATE.verify_package_scripts({"scripts": scripts}, policy, kind)
            self.assertEqual(set(verified["phases"]), set(policy["packageScripts"]["mappings"][kind]))

            mutated = deepcopy(scripts)
            mutated[mutated_phase]["rawSha256"] = "f" * 64
            with gate_error(self, "LINUX_PACKAGE_SCRIPT_MISMATCH"):
                GATE.verify_package_scripts({"scripts": mutated}, policy, kind)

            omitted = deepcopy(scripts)
            del omitted[omitted_phase]
            with gate_error(self, "LINUX_PACKAGE_SCRIPT_INVALID"):
                GATE.verify_package_scripts({"scripts": omitted}, policy, kind)

    def test_rpm_scriptlet_queries_reject_mutation_omission_and_extra_code(self) -> None:
        policy = load_json(POLICY_PATH)
        configure_release_identity(policy)
        configure_package_script_policy(policy)
        tags = {
            tag: b"(none)"
            for tag in (
                *GATE.RPM_FORBIDDEN_SCRIPT_TAGS,
                *GATE.RPM_FORBIDDEN_PRIMARY_SCRIPT_FLAGS,
            )
        }
        for phase, (body_tag, interpreter_tag) in GATE.RPM_SCRIPT_QUERY_TAGS.items():
            logical_name = policy["packageScripts"]["mappings"]["rpm"][phase]
            tags[body_tag] = TEST_PACKAGE_SCRIPTS[logical_name]
            tags[interpreter_tag] = b"/bin/sh"

        with mock.patch.object(GATE, "rpm_query_tag", side_effect=lambda _package, tag: tags[tag]):
            scripts = GATE.inspect_rpm_scripts(Path("/candidate.rpm"))
        GATE.verify_package_scripts({"scripts": scripts}, policy, "rpm")

        mutated_tags = deepcopy(tags)
        mutated_tags["POSTIN"] += b"echo mutation >/dev/null\n"
        with mock.patch.object(GATE, "rpm_query_tag", side_effect=lambda _package, tag: mutated_tags[tag]):
            mutated = GATE.inspect_rpm_scripts(Path("/candidate.rpm"))
        with gate_error(self, "LINUX_PACKAGE_SCRIPT_MISMATCH"):
            GATE.verify_package_scripts({"scripts": mutated}, policy, "rpm")

        omitted_tags = deepcopy(tags)
        omitted_tags["POSTUN"] = b"(none)"
        with mock.patch.object(GATE, "rpm_query_tag", side_effect=lambda _package, tag: omitted_tags[tag]):
            with gate_error(self, "LINUX_PACKAGE_SCRIPT_INVALID"):
                GATE.inspect_rpm_scripts(Path("/candidate.rpm"))

        extra_tags = deepcopy(tags)
        extra_tags["POSTTRANS"] = b"#!/bin/sh\necho unpinned\n"
        with mock.patch.object(GATE, "rpm_query_tag", side_effect=lambda _package, tag: extra_tags[tag]):
            with gate_error(self, "LINUX_PACKAGE_SCRIPT_INVALID"):
                GATE.inspect_rpm_scripts(Path("/candidate.rpm"))

        flagged_tags = deepcopy(tags)
        flagged_tags["PREINFLAGS"] = b"1"
        with mock.patch.object(
            GATE,
            "rpm_query_tag",
            side_effect=lambda _package, tag: flagged_tags[tag],
        ):
            with gate_error(self, "LINUX_PACKAGE_SCRIPT_INVALID"):
                GATE.inspect_rpm_scripts(Path("/candidate.rpm"))

    def test_rpm_semantic_tags_reject_conflicts_obsoletes_and_policy_payloads(self) -> None:
        absent = {
            tag: b"(none)" for tag in GATE.RPM_FORBIDDEN_SEMANTIC_TAGS
        }
        for forbidden_tag in ("CONFLICTNAME", "OBSOLETENAME", "POLICIES"):
            tags = deepcopy(absent)
            tags[forbidden_tag] = b"unreviewed"
            with self.subTest(tag=forbidden_tag), mock.patch.object(
                GATE,
                "rpm_query_tag",
                side_effect=lambda _package, tag, tags=tags: tags[tag],
            ), gate_error(self, "LINUX_PACKAGE_SEMANTICS_INVALID"):
                GATE.inspect_rpm_semantics(
                    Path("/candidate.rpm"),
                    "taomni",
                    "1.0.0-1",
                    "x86_64",
                )

    def test_real_deb_control_script_extraction_detects_mutation_and_omission(self) -> None:
        try:
            dpkg_deb = GATE.resolve_tool("dpkg-deb")
        except GATE.LinuxGateError:
            self.skipTest("dpkg-deb is unavailable")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)

            def build(
                name: str,
                scripts: dict[str, bytes],
                *,
                control_extra: str = "",
                extra_control_member: str | None = None,
            ) -> Path:
                package_root = root / name
                control_directory = package_root / "DEBIAN"
                control_directory.mkdir(parents=True)
                (control_directory / "control").write_text(
                    "Package: taomni\n"
                    "Version: 1.0.0-1\n"
                    "Architecture: amd64\n"
                    "Depends: iproute2, nftables, policykit-1\n"
                    "Maintainer: Taomni Test <test@invalid.example>\n"
                    "Description: Linux Gate control script fixture\n"
                    f"{control_extra}",
                    encoding="utf-8",
                )
                for phase, content in scripts.items():
                    path = control_directory / phase
                    path.write_bytes(content)
                    path.chmod(0o755)
                if extra_control_member is not None:
                    extra = control_directory / extra_control_member
                    extra.write_text("/etc/taomni.conf\n", encoding="utf-8")
                    extra.chmod(0o644)
                    conffile = package_root / "etc" / "taomni.conf"
                    conffile.parent.mkdir(parents=True, exist_ok=True)
                    conffile.write_text("unsafe=true\n", encoding="utf-8")
                package = root / f"{name}.deb"
                result = subprocess.run(
                    [dpkg_deb, "--build", str(package_root), str(package)],
                    text=True,
                    capture_output=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)
                return package

            mapped = {
                phase: TEST_PACKAGE_SCRIPTS[logical_name]
                for phase, logical_name in GATE.PACKAGE_SCRIPT_MAPPINGS["deb"].items()
            }
            policy = load_json(POLICY_PATH)
            configure_release_identity(policy)
            configure_package_script_policy(policy)

            baseline = GATE.inspect_deb_package(build("baseline", mapped), "taomni", "x86_64")
            GATE.verify_package_scripts(baseline, policy, "deb")
            GATE.verify_package_dependencies(baseline, policy, "deb")

            mutated = deepcopy(mapped)
            mutated["postinst"] += b"echo mutation >/dev/null\n"
            mutated_package = GATE.inspect_deb_package(build("mutated", mutated), "taomni", "x86_64")
            with gate_error(self, "LINUX_PACKAGE_SCRIPT_MISMATCH"):
                GATE.verify_package_scripts(mutated_package, policy, "deb")

            omitted = deepcopy(mapped)
            del omitted["postrm"]
            with gate_error(self, "LINUX_PACKAGE_SCRIPT_INVALID"):
                GATE.inspect_deb_package(build("omitted", omitted), "taomni", "x86_64")

            with gate_error(self, "LINUX_PACKAGE_SCRIPT_INVALID"):
                GATE.inspect_deb_package(
                    build("conffile", mapped, extra_control_member="conffiles"),
                    "taomni",
                    "x86_64",
                )
            with gate_error(self, "LINUX_PACKAGE_SEMANTICS_INVALID"):
                GATE.inspect_deb_package(
                    build(
                        "conflict",
                        mapped,
                        control_extra="Conflicts: unsafe-package\n",
                    ),
                    "taomni",
                    "x86_64",
                )

    def test_real_deb_payload_and_dependency_metadata_satisfy_fixed_contract(self) -> None:
        try:
            dpkg_deb = GATE.resolve_tool("dpkg-deb")
        except GATE.LinuxGateError:
            self.skipTest("dpkg-deb is unavailable")

        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            package_root = root / "package"
            control_directory = package_root / "DEBIAN"
            control_directory.mkdir(parents=True)
            control_directory.joinpath("control").write_text(
                "Package: taomni\n"
                "Version: 1.0.0-1\n"
                "Architecture: amd64\n"
                "Depends: iproute2, nftables, policykit-1\n"
                "Maintainer: Taomni Test <test@invalid.example>\n"
                "Description: Linux Gate payload fixture\n",
                encoding="utf-8",
            )
            policy = load_json(POLICY_PATH)
            configure_package_script_policy(policy)
            for phase, logical_name in GATE.PACKAGE_SCRIPT_MAPPINGS["deb"].items():
                path = control_directory / phase
                path.write_bytes(TEST_PACKAGE_SCRIPTS[logical_name])
                path.chmod(0o755)

            installed: dict[str, object] = {}
            for role in GATE.ROLE_NAMES:
                contract = policy["installedArtifacts"][role]
                content = f"installed:{role}".encode()
                path = package_root / contract["path"].removeprefix("/")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(content)
                path.chmod(int(contract["mode"], 8))
                installed[role] = GATE.StableFile(
                    Path(contract["path"]),
                    sha256_bytes(content),
                    len(content),
                    0,
                    0,
                    int(contract["mode"], 8),
                )
            for path_text in [
                *policy["packagePayload"]["desktopFiles"],
                *policy["packagePayload"]["iconFiles"],
            ]:
                path = package_root / path_text.removeprefix("/")
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_bytes(f"payload:{path_text}".encode())
                path.chmod(0o644)
            package_root.chmod(0o755)
            for directory_path in package_root.rglob("*"):
                if directory_path.is_dir():
                    directory_path.chmod(0o755)

            package = root / "taomni.deb"
            result = subprocess.run(
                [dpkg_deb, "--root-owner-group", "--build", str(package_root), str(package)],
                text=True,
                capture_output=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)
            details = GATE.inspect_deb_package(package, "taomni", "x86_64")
            GATE.verify_package_dependencies(details, policy, "deb")
            GATE.verify_package_payload(details, policy)
            GATE.verify_package_artifact_binding(details, installed, policy)
            GATE.verify_package_scripts(details, policy, "deb")

    def test_package_binding_rejects_payload_that_differs_from_installed_helper(self) -> None:
        policy = load_json(POLICY_PATH)
        installed = {}
        entries = []
        for role in GATE.ROLE_NAMES:
            contract = policy["installedArtifacts"][role]
            evidence = GATE.StableFile(
                Path(contract["path"]),
                sha256_bytes(role.encode()),
                len(role),
                0,
                0,
                int(contract["mode"], 8),
            )
            installed[role] = evidence
            entries.append(
                {
                    "path": contract["path"],
                    "type": "file",
                    "mode": contract["mode"],
                    "owner": "root",
                    "group": "root",
                    "size": evidence.size,
                    "sha256": evidence.sha256,
                    "linkTarget": "",
                }
            )
        entries[1]["sha256"] = "f" * 64
        with gate_error(self, "LINUX_PACKAGE_CONTENT_MISMATCH"):
            GATE.verify_package_artifact_binding({"entries": entries}, installed, policy)

    def test_package_manifest_output_refuses_symlink(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.json"
            target.write_text("keep", encoding="utf-8")
            link = root / "manifest.json"
            link.symlink_to(target)
            with gate_error(self, "LINUX_PACKAGE_MANIFEST_PATH_INVALID"):
                GATE.write_json_atomic(link, {"schemaVersion": 1})
            self.assertEqual(target.read_text(encoding="utf-8"), "keep")

    def test_mocked_release_writes_package_manifest_and_complete_receipt(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            evidence_dir = root / "evidence"
            staged = root / "staged"
            staged.mkdir()
            files = {
                "application": root / "installed" / "usr" / "bin" / "taomni",
                "helper": root / "installed" / "usr" / "libexec" / "taomni" / "sockscap-helper",
                "helperPolicy": root / "installed" / "etc" / "taomni" / "sockscap-helper-policy.json",
                "polkitAction": root / "installed" / "usr" / "share" / "polkit-1" / "actions" / "com.taomni.sockscap.policy",
            }
            for path in files.values():
                path.parent.mkdir(parents=True, exist_ok=True)
            files["application"].write_bytes(b"final-app")
            files["helper"].write_bytes(b"final-helper")
            app_hash = sha256_bytes(b"final-app")
            helper_hash = sha256_bytes(b"final-helper")
            helper_policy = {
                "schemaVersion": 1,
                "productId": "com.taomni.app",
                "allowedCallerSha256": [app_hash],
                "allowedHelperSha256": [helper_hash],
                "allowedRuntimeSha256": [app_hash],
            }
            files["helperPolicy"].write_text(json.dumps(helper_policy), encoding="utf-8")
            files["polkitAction"].write_text(
                POLKIT_PATH.read_text(encoding="utf-8").replace(
                    "/usr/libexec/taomni/sockscap-helper",
                    str(files["helper"]),
                ),
                encoding="utf-8",
            )

            package = staged / "taomni.deb"
            signature = staged / "taomni.deb.asc"
            public_key = staged / "release-key.asc"
            package.write_bytes(b"signed-package")
            signature.write_bytes(b"detached-signature")
            public_key.write_bytes(b"public-key")

            policy = deepcopy(load_json(POLICY_PATH))
            configure_release_identity(policy)
            configure_package_script_policy(policy)
            for role, path in files.items():
                policy["installedArtifacts"][role]["path"] = str(path)
            policy["polkit"]["execPath"] = str(files["helper"])
            policy_path = root / "policy.json"
            write_json(policy_path, policy)

            manifest = deepcopy(load_json(TEMPLATE_PATH))
            manifest.update(
                {
                    "captureReleaseEnabled": True,
                    "gitCommit": "b" * 40,
                    "buildId": "linux-candidate-1",
                    "packageManifestOutput": "evidence/package-manifest.json",
                }
            )
            manifest["package"] = {
                "kind": "deb",
                "path": "staged/taomni.deb",
                "sha256": sha256_bytes(package.read_bytes()),
                "signature": {
                    "scheme": "detached_openpgp",
                    "path": "staged/taomni.deb.asc",
                    "sha256": sha256_bytes(signature.read_bytes()),
                    "publicKeyPath": "staged/release-key.asc",
                    "publicKeySha256": sha256_bytes(public_key.read_bytes()),
                },
            }
            manifest["installedArtifacts"] = {role: str(path) for role, path in files.items()}
            manifest_path = root / "manifest.json"
            write_json(manifest_path, manifest)

            def installed_inspector(path: Path, role: str, contract: dict):
                content = path.read_bytes()
                return GATE.StableFile(
                    path,
                    sha256_bytes(content),
                    len(content),
                    0,
                    0,
                    int(contract["mode"], 8),
                    content if role in {"helperPolicy", "polkitAction"} else None,
                )

            def package_inspector(_kind: str, _path: Path, name: str, architecture: str):
                self.assertNotEqual(_path, package)
                self.assertEqual(_path.read_bytes(), package.read_bytes())
                entries = []
                for role, path in files.items():
                    contract = policy["installedArtifacts"][role]
                    content = path.read_bytes()
                    entries.append(
                        {
                            "path": str(path),
                            "type": "file",
                            "mode": contract["mode"],
                            "owner": "root",
                            "group": "root",
                            "size": len(content),
                            "sha256": sha256_bytes(content),
                            "linkTarget": "",
                        }
                    )
                entries.extend(fixed_noninstalled_payload_entries(policy))
                return {
                    "packageName": name,
                    "packageVersion": "1.0.0-1",
                    "architecture": architecture,
                    "dependencies": package_dependency_evidence_for(policy, "deb"),
                    "entries": entries,
                    "scripts": package_script_evidence_for(policy, "deb"),
                }

            def signature_verifier(_kind, _package, _signature, _key, expected):
                self.assertNotEqual(_package, package)
                self.assertNotEqual(_signature, signature)
                self.assertNotEqual(_key, public_key)
                self.assertEqual(_package.read_bytes(), package.read_bytes())
                self.assertEqual(_signature.read_bytes(), signature.read_bytes())
                self.assertEqual(_key.read_bytes(), public_key.read_bytes())
                return expected

            with mock.patch.object(GATE, "openpgp_primary_fingerprint", return_value=FINGERPRINT):
                receipt = GATE.verify_release(
                    manifest_path,
                    policy_path=policy_path,
                    signature_verifier=signature_verifier,
                    package_inspector=package_inspector,
                    installed_inspector=installed_inspector,
                )

            self.assertEqual(receipt["result"], "PASS")
            self.assertEqual(receipt["packagePath"], str(package))
            self.assertEqual(receipt["signaturePath"], str(signature))
            self.assertEqual(receipt["artifactManifestPath"], str(manifest_path))
            self.assertEqual(receipt["artifactManifestSha256"], sha256_bytes(manifest_path.read_bytes()))
            self.assertEqual(receipt["polkitAction"], str(files["polkitAction"]))
            self.assertTrue(receipt["packageSignatureVerified"])
            self.assertTrue(receipt["packageDependenciesVerified"])
            self.assertTrue(receipt["packageScriptsVerified"])
            self.assertTrue(receipt["helperPolicyVerified"])
            self.assertTrue(receipt["appImageCaptureDisabled"])
            package_manifest_path = evidence_dir / "package-manifest.json"
            self.assertEqual(receipt["packageManifestPath"], str(package_manifest_path))
            self.assertEqual(
                receipt["packageManifestSha256"],
                sha256_bytes(package_manifest_path.read_bytes()),
            )
            package_manifest = load_json(package_manifest_path)
            self.assertEqual(package_manifest["signerFingerprint"], FINGERPRINT)
            self.assertEqual(len(package_manifest["entries"]), 8)
            self.assertEqual(
                package_manifest["packageDependencies"],
                receipt["packageDependencies"],
            )
            self.assertEqual(
                receipt["packageDependencies"]["required"],
                policy["packageDependencies"]["deb"],
            )
            self.assertEqual(package_manifest["packageScriptsSha256"], receipt["packageScriptsSha256"])
            self.assertEqual(set(package_manifest["packageScripts"]["phases"]), {"preinst", "prerm", "postinst", "postrm"})


if __name__ == "__main__":
    unittest.main()
