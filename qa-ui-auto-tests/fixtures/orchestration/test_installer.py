"""Pure mocked installer diagnostics; never downloads, installs or runs a CLI."""
from __future__ import annotations

import contextlib
import errno
import io
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parent))

import install_harnesses as installer

ROOT = Path(__file__).resolve().parents[3]
SECRET = "should-never-be-published-credential"


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.catalog = json.loads(installer.CATALOG.read_text())
        self.tools = self.root / "trusted-tools"
        self.tools.mkdir()
        for name in ("node", "npm", "git"):
            (self.tools / name).write_bytes(b"offline mock identity; never executed")
        self.calls = []
        self.progress = io.StringIO()

    def invoke(self, harness, handler):
        self.install_root = self.root / "fresh-install"
        self.install_root.mkdir()

        def command(args, **kwargs):
            self.calls.append((args, kwargs))
            self.assertEqual(kwargs["cwd"], self.install_root / "control")
            self.assertNotIn("source", kwargs["cwd"].parts)
            self.assertNotIn("node_modules", kwargs["cwd"].parts)
            self.assertEqual(kwargs["stdout"], subprocess.PIPE)
            self.assertEqual(kwargs["stderr"], subprocess.PIPE)
            self.assertFalse(kwargs["check"])
            return handler(args)

        with patch.object(installer.shutil, "which", side_effect=lambda name: str(self.tools / name)), \
                patch.object(installer.subprocess, "run", side_effect=command), contextlib.redirect_stdout(self.progress):
            return installer.install(self.install_root, [harness])

    def ok(self, args, output=b""):
        return subprocess.CompletedProcess(args, 0, stdout=output, stderr=b"")

    def npm_handler(self, name, fail=None, integrity_override=None):
        item = self.catalog["harnesses"][name]

        def handler(args):
            if "--version" in args:
                return self.ok(args, b"v24.14.0\n")
            if "view" in args:
                return self.ok(args, json.dumps(item["integrity"]).encode())
            self.assertIn("--prefix", args)
            target = Path(args[args.index("--prefix") + 1])
            self.assertEqual(target, self.install_root / name)
            if fail:
                return fail(args)
            package_root = target / "node_modules" / item["package"]
            package_root.mkdir(parents=True)
            (package_root / "package.json").write_text(json.dumps({"name": item["package"], "version": item["version"]}))
            (target / "package-lock.json").write_text(json.dumps({"packages": {
                "node_modules/" + item["package"]: {"integrity": integrity_override or item["integrity"]}}}))
            entrypoint = package_root / item["entrypoint"]
            entrypoint.parent.mkdir(parents=True, exist_ok=True)
            entrypoint.write_bytes(b"offline package fixture; never executed")
            return self.ok(args)
        return handler

    def failure(self, harness, handler, expected_stage, reason, returncode=None):
        with self.assertRaises(installer.InstallFailure) as caught:
            self.invoke(harness, handler)
        receipt_path = self.install_root / "install-failure.json"
        receipt = json.loads(receipt_path.read_text())
        self.assertEqual(receipt["harness"], harness if expected_stage != "node_version" else "runtime")
        self.assertEqual(receipt["stage"], expected_stage)
        self.assertEqual(receipt["reason"], reason)
        self.assertEqual(receipt["returncode"], returncode)
        self.assertEqual(receipt["status"], "failed")
        self.assertEqual(receipt_path.stat().st_mode & 0o777, 0o600)
        published = receipt_path.read_text() + self.progress.getvalue() + str(caught.exception)
        for private in (SECRET, "https://", "Authorization", str(self.root), "api_key", "prompt=", "Bearer"):
            self.assertNotIn(private, published)
        self.assertIn("harness=" + receipt["harness"], str(caught.exception))
        self.assertIn("stage=" + expected_stage, str(caught.exception))
        self.assertFalse((self.install_root / "installation.json").exists())
        return receipt

    def test_npm_failure_names_harness_stage_and_only_closed_set_structured_error_codes(self):
        raw = (f"npm error code ERESOLVE\nnpm error request https://user:{SECRET}@private.invalid/model?api_key={SECRET}\n"
               f"Authorization: Bearer {SECRET}\nprompt={SECRET}\nERR_PNPM_{SECRET}\nENOENT {SECRET}\n").encode()
        def fail(args):
            return subprocess.CompletedProcess(args, 1, stdout=b"private stdout " + SECRET.encode(), stderr=raw)
        receipt = self.failure("claude-code", self.npm_handler("claude-code", fail), "package_install", "nonzero_exit", 1)
        self.assertEqual(receipt["error_codes"], ["ENOENT", "ERESOLVE"])
        self.assertEqual(receipt["structured_errors"], [
            {"kind": "package_manager_code", "code": "ENOENT"}, {"kind": "package_manager_code", "code": "ERESOLVE"}])
        self.assertEqual(receipt["stderr_bytes"], len(raw))
        logs = list((self.install_root / "control" / "logs").glob("*"))
        self.assertEqual(len(logs), 2)
        self.assertTrue(all(path.stat().st_mode & 0o777 == 0o600 for path in logs))
        self.assertTrue(any(SECRET.encode() in path.read_bytes() for path in logs))
        rows = [json.loads(line) for line in self.progress.getvalue().splitlines()]
        self.assertEqual(rows[-1], {"type": "install_progress", "harness": "claude-code", "stage": "package_install"})

    def test_upstream_command_diagnostics_become_closed_set_categories_not_raw_lines(self):
        def fail(args):
            return subprocess.CompletedProcess(args, 1, stdout=b"", stderr=(
                "npm error command failed\nError [ERR_REQUIRE_ESM]: " + SECRET
                + "\ngyp ERR! build error https://" + SECRET + "\nerror TS2307: " + SECRET).encode())
        receipt = self.failure("pi", self.npm_handler("pi", fail), "package_install", "nonzero_exit", 1)
        self.assertEqual(receipt["error_codes"], ["ERR_REQUIRE_ESM"])
        self.assertEqual([row["category"] for row in receipt["structured_errors"] if row["kind"] == "command_error"],
                         ["lifecycle_script_failed", "native_build_failed", "typescript_build_failed"])

    def test_timeout_preserves_safe_partial_error_codes_without_exposing_exception_command(self):
        def fail(args):
            raise subprocess.TimeoutExpired(["secret-command", SECRET], 1800,
                                            output=b"private " + SECRET.encode(), stderr=b"npm error ETIMEDOUT")
        receipt = self.failure("pi", self.npm_handler("pi", fail), "package_install", "timeout")
        self.assertEqual(receipt["timeout_seconds"], 1800)
        self.assertEqual(receipt["error_codes"], ["ETIMEDOUT"])

    def test_os_error_publishes_only_approved_errno_not_its_secret_filename(self):
        def fail(args):
            raise OSError(errno.EACCES, SECRET, "https://" + SECRET)
        receipt = self.failure("opencode", self.npm_handler("opencode", fail), "package_install", "launch_error")
        self.assertEqual(receipt["os_error"], "EACCES")

    def test_registry_integrity_mismatch_still_blocks_before_any_install(self):
        def handler(args):
            return self.ok(args, b"v24.14.0\n" if "--version" in args else json.dumps(SECRET).encode())
        self.failure("codex", handler, "registry_integrity", "registry_integrity")
        self.assertEqual(len(self.calls), 2)

    def test_installed_archive_integrity_mismatch_still_blocks(self):
        self.failure("deepseek-harness", self.npm_handler("deepseek-harness", integrity_override=SECRET),
                     "installed_integrity", "installed_integrity")

    def test_malformed_registry_metadata_is_fixed_safe_category(self):
        def handler(args):
            return self.ok(args, b"v24.14.0\n" if "--version" in args else ("invalid-json " + SECRET).encode())
        self.failure("pi", handler, "registry_integrity", "invalid_metadata")

    def test_wrong_shaped_installed_metadata_is_classified_without_traceback_leak(self):
        original = self.npm_handler("pi")
        def handler(args):
            result = original(args)
            if "install" in args:
                (self.install_root / "pi" / "package-lock.json").write_text(json.dumps([SECRET]))
            return result
        self.failure("pi", handler, "installed_integrity", "invalid_metadata")

    def test_wrong_runtime_version_never_reaches_package_manager(self):
        self.failure("pi", lambda args: self.ok(args, ("v22 " + SECRET).encode()), "node_version", "node_version")
        self.assertEqual(len(self.calls), 1)

    def test_success_preserves_manifest_identity_without_failure_receipt(self):
        result = self.invoke("pi", self.npm_handler("pi"))
        self.assertEqual(result["harnesses"]["pi"]["identity"]["version"], self.catalog["harnesses"]["pi"]["version"])
        self.assertEqual(json.loads((self.install_root / "installation.json").read_text()), result)
        self.assertFalse((self.install_root / "install-failure.json").exists())
        self.assertEqual(json.loads(self.progress.getvalue().splitlines()[-1])["stage"], "manifest_write")

    def zcode_handler(self, fail_build=False):
        item = self.catalog["harnesses"]["zcode"]
        def handler(args):
            source = self.install_root / "zcode" / "source"
            if "--version" in args:
                return self.ok(args, b"v24.14.0\n")
            if "clone" in args:
                source.mkdir()
            elif "-C" in args:
                self.assertEqual(args[args.index("-C") + 1], str(source))
                if "rev-parse" in args:
                    return self.ok(args, (item["commit"] + "\n").encode())
            elif "pnpm@10.33.2" in args:
                self.assertIn("--prefix", args)
            else:
                self.assertIn("--dir", args)
                self.assertEqual(args[args.index("--dir") + 1], str(source))
                if "build" in args:
                    if fail_build:
                        return subprocess.CompletedProcess(args, 7, stdout=b"",
                            stderr=("ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL https://" + SECRET).encode())
                    entrypoint = source / item["entrypoint"]
                    entrypoint.parent.mkdir(parents=True)
                    entrypoint.write_bytes(b"mock built source; never executed")
            return self.ok(args)
        return handler

    def test_source_build_passes_explicit_source_paths_with_control_cwd_for_every_command(self):
        result = self.invoke("zcode", self.zcode_handler())
        self.assertEqual(result["harnesses"]["zcode"]["identity"]["commit"], self.catalog["harnesses"]["zcode"]["commit"])
        self.assertEqual(len(self.calls), 7)
        commands = [args for args, _ in self.calls]
        self.assertEqual(sum("--dir" in args for args in commands), 2)
        self.assertEqual(sum("-C" in args for args in commands), 2)

    def test_source_build_failure_names_zcode_and_build_stage_without_raw_output(self):
        receipt = self.failure("zcode", self.zcode_handler(fail_build=True), "source_build", "nonzero_exit", 7)
        self.assertEqual(receipt["error_codes"], ["ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL"])
        self.assertIn({"kind": "command_error", "category": "lifecycle_script_failed"}, receipt["structured_errors"])

    def test_error_code_output_is_bounded_even_for_repeated_upstream_messages(self):
        def fail(args):
            raw = ("npm error EACCES https://" + SECRET + "\n") * 10000
            return subprocess.CompletedProcess(args, 1, stdout=b"", stderr=raw.encode())
        receipt = self.failure("pi", self.npm_handler("pi", fail), "package_install", "nonzero_exit", 1)
        self.assertEqual(receipt["error_codes"], ["EACCES"])
        self.assertLess(len(json.dumps(receipt)), 1500)

    def test_workflows_upload_only_sanitized_installer_diagnostic_not_private_control_logs(self):
        for workflow, directory in (("qa-ui-auto-platforms.yml", "orchestration-harnesses"),
                                    ("qa-ui-auto-entry.yml", "orchestration-native-harnesses")):
            text = (ROOT / ".github" / "workflows" / workflow).read_text()
            self.assertIn("${{ runner.temp }}/" + directory + "/install-failure.json", text)
            self.assertNotIn("${{ runner.temp }}/" + directory + "/control", text)
            self.assertNotIn("${{ runner.temp }}/" + directory + "/**", text)


if __name__ == "__main__":
    unittest.main()
