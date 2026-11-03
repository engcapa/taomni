#!/usr/bin/env python3
"""CI-only pinned installation with secret-free progress and failure receipts."""
from __future__ import annotations

import argparse
import errno
import hashlib
import json
import os
import re
import shutil
import subprocess
from pathlib import Path

CATALOG = Path(__file__).resolve().with_name("harness_catalog.json")
APPROVED_ERROR_CODES = frozenset({
    "EACCES", "EPERM", "ENOENT", "ENOSPC", "EINTEGRITY", "ERESOLVE", "EBADENGINE", "ENOTSUP",
    "EUNSUPPORTEDPROTOCOL", "ETARGET", "E404", "E401", "E403", "ENOTFOUND", "EAI_AGAIN",
    "ECONNREFUSED", "ECONNRESET", "ETIMEDOUT", "ELIFECYCLE", "ERR_PNPM_BAD_ENGINE",
    "ERR_PNPM_UNSUPPORTED_ENGINE", "ERR_PNPM_NO_MATCHING_VERSION", "ERR_PNPM_FETCH_401",
    "ERR_PNPM_FETCH_403", "ERR_PNPM_FETCH_404", "ERR_PNPM_FETCH_500", "ERR_PNPM_FETCH_502",
    "ERR_PNPM_FETCH_503", "ERR_PNPM_OUTDATED_LOCKFILE", "ERR_PNPM_LOCKFILE_CONFIG_MISMATCH",
    "ERR_PNPM_TARBALL_INTEGRITY", "ERR_PNPM_PEER_DEP_ISSUES", "ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL",
    "ERR_PNPM_RECURSIVE_EXEC_FIRST_FAIL", "ERR_PNPM_MISSING_SCRIPT", "ERR_PNPM_NO_SCRIPT",
    "ERR_PNPM_IGNORED_BUILDS", "ERR_PNPM_FETCH_FAILED", "ERR_PNPM_WORKSPACE_PKG_NOT_FOUND",
    "ERR_PNPM_NO_MATCHING_VERSION_INSIDE_WORKSPACE", "ERR_PNPM_UNSUPPORTED_PLATFORM", "EBADPLATFORM",
    "ERR_REQUIRE_ESM", "MODULE_NOT_FOUND", "ERR_MODULE_NOT_FOUND", "ERR_DLOPEN_FAILED",
    "ERR_PACKAGE_PATH_NOT_EXPORTED", "ERR_INVALID_PACKAGE_CONFIG", "ERR_SOCKET_TIMEOUT",
    "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
})
ERROR_CODE = re.compile(r"(?<![A-Za-z0-9_])(?:" + "|".join(sorted(APPROVED_ERROR_CODES, key=len, reverse=True))
                        + r")(?![A-Za-z0-9_])")
COMMAND_ERRORS = {
    "lifecycle_script_failed": re.compile(r"(?:npm error command failed|ELIFECYCLE|ERR_PNPM_RECURSIVE_RUN_FIRST_FAIL)", re.I),
    "native_build_failed": re.compile(r"(?:gyp ERR!|node-gyp.*(?:error|failed)|fatal error:)", re.I),
    "git_clone_failed": re.compile(r"(?:fatal:.*(?:could not|unable|not found)|RPC failed)", re.I),
    "typescript_build_failed": re.compile(r"(?:error TS[0-9]{3,5}:|TypeScript.*(?:error|failed))", re.I),
    "disk_exhausted": re.compile(r"(?:ENOSPC|No space left on device)", re.I),
    "certificate_validation_failed": re.compile(r"(?:certificate.*(?:expired|self.signed|unable to verify))", re.I),
}
REASONS = {
    "nonzero_exit": "Installation command exited unsuccessfully",
    "timeout": "Installation command exceeded its deadline",
    "launch_error": "Installation command could not be started",
    "tools_missing": "Required Node, npm or Git executable is missing",
    "node_version": "Node runtime differs from the pinned version",
    "registry_integrity": "Registry integrity differs from the catalog pin",
    "package_identity": "Installed package identity differs from the catalog pin",
    "installed_integrity": "Installed package-lock integrity differs from the catalog pin",
    "source_revision": "Source checkout differs from the catalog commit",
    "entrypoint_missing": "Pinned harness entrypoint is missing after installation",
    "invalid_metadata": "Installation metadata is not valid JSON or UTF-8",
    "filesystem_error": "Installation filesystem operation failed",
}


class InstallFailure(RuntimeError):
    def __init__(self, harness: str, stage: str, reason: str, **details):
        self.receipt = {"schema_version": 1, "status": "failed", "harness": harness, "stage": stage,
                        "reason": reason, "message": REASONS[reason], "returncode": None, **details}
        super().__init__(f"installation failed: harness={harness} stage={stage} reason={reason}; see install-failure.json")


def private_file(path: Path, data: bytes) -> None:
    with path.open("xb") as output:
        path.chmod(0o600)
        output.write(data)


class Installer:
    def __init__(self, root: Path):
        self.root = root
        # No interpreter/package manager ever runs with cwd inside downloaded
        # source or node_modules. Logs and control state are separate too.
        self.control = root / "control"
        self.control.mkdir(mode=0o700)
        self.logs = self.control / "logs"
        self.logs.mkdir(mode=0o700)
        self.harness, self.stage, self.sequence = "runtime", "tool_discovery", 0

    def progress(self, harness: str, stage: str) -> None:
        self.harness, self.stage = harness, stage
        print(json.dumps({"type": "install_progress", "harness": harness, "stage": stage}), flush=True)

    def require(self, condition: bool, reason: str) -> None:
        if not condition:
            raise InstallFailure(self.harness, self.stage, reason)

    def fail_command(self, reason: str, stdout: bytes | str | None, stderr: bytes | str | None, **details) -> None:
        stdout = stdout.encode() if isinstance(stdout, str) else stdout or b""
        stderr = stderr.encode() if isinstance(stderr, str) else stderr or b""
        self.sequence += 1
        private_file(self.logs / f"{self.sequence:03d}.stdout", stdout)
        private_file(self.logs / f"{self.sequence:03d}.stderr", stderr)
        # Only closed-set codes survive. Never publish upstream lines, argv,
        # URLs, headers, file paths, environment, exception strings or prompts.
        text = (stdout + b"\n" + stderr).decode("utf-8", "replace")
        codes = sorted(set(ERROR_CODE.findall(text)) & APPROVED_ERROR_CODES)
        structured = [{"kind": "package_manager_code", "code": code} for code in codes]
        structured.extend({"kind": "command_error", "category": category}
                          for category, pattern in COMMAND_ERRORS.items() if pattern.search(text))
        raise InstallFailure(self.harness, self.stage, reason, error_codes=codes,
                             structured_errors=structured,
                             stdout_bytes=len(stdout), stderr_bytes=len(stderr), **details)

    def run(self, args: list[str], timeout: int = 1800) -> bytes:
        try:
            result = subprocess.run(args, cwd=self.control, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                                    timeout=timeout, check=False)
        except subprocess.TimeoutExpired as exc:
            self.fail_command("timeout", exc.stdout, exc.stderr, timeout_seconds=timeout)
        except OSError as exc:
            code = errno.errorcode.get(exc.errno, "")
            self.fail_command("launch_error", b"", b"", os_error=code if code in APPROVED_ERROR_CODES else "unclassified")
        if result.returncode:
            self.fail_command("nonzero_exit", result.stdout, result.stderr, returncode=result.returncode)
        return result.stdout

    def record_failure(self, failure: InstallFailure) -> None:
        private_file(self.root / "install-failure.json", (json.dumps(failure.receipt, indent=2) + "\n").encode())


def install(root: Path, harnesses: list[str]) -> dict:
    installer = Installer(root)
    try:
        return install_pinned(installer, harnesses)
    except InstallFailure as failure:
        installer.record_failure(failure)
        raise
    except (ValueError, UnicodeError, TypeError, AttributeError, KeyError, OSError) as exc:
        # Schema/file errors carry package-manager-controlled content in their
        # normal exception text. Persist a fixed category, never str(exc).
        reason = "filesystem_error" if isinstance(exc, OSError) else "invalid_metadata"
        failure = InstallFailure(installer.harness, installer.stage, reason)
        installer.record_failure(failure)
        raise failure from None


def install_pinned(installer: Installer, harnesses: list[str]) -> dict:
    root = installer.root
    catalog_bytes = CATALOG.read_bytes()
    catalog = json.loads(catalog_bytes)
    installer.progress("runtime", "tool_discovery")
    tools = [shutil.which(name) for name in ("node", "npm", "git")]
    installer.require(all(path and Path(path).is_file() for path in tools), "tools_missing")
    node, npm, git = [Path(path).resolve() for path in tools]
    installer.progress("runtime", "node_version")
    version = installer.run([str(node), "--version"]).decode().strip()
    installer.require(version == "v" + catalog["runtime"]["node"], "node_version")
    installed = {}
    for name in harnesses:
        item = catalog["harnesses"][name]
        target = root / name
        installer.progress(name, "prepare_directory")
        target.mkdir(mode=0o700)
        if "package" in item:
            spec = item["package"] + "@" + item["version"]
            installer.progress(name, "registry_integrity")
            integrity = json.loads(installer.run([str(npm), "view", spec, "dist.integrity", "--json"]))
            installer.require(integrity == item["integrity"], "registry_integrity")
            private_file(target / "package.json", json.dumps({"name": "taomni-qa-" + name,
                "private": True, "dependencies": {item["package"]: item["version"]}}).encode())
            installer.progress(name, "package_install")
            installer.run([str(npm), "install", "--prefix", str(target), "--no-audit", "--no-fund", "--save-exact"])
            installer.progress(name, "package_identity")
            package_root = target / "node_modules" / item["package"]
            package = json.loads((package_root / "package.json").read_text())
            installer.require(package.get("name") == item["package"] and package.get("version") == item["version"], "package_identity")
            installer.progress(name, "installed_integrity")
            lock = json.loads((target / "package-lock.json").read_text())
            locked = lock.get("packages", {}).get("node_modules/" + item["package"], {})
            installer.require(locked.get("integrity") == item["integrity"], "installed_integrity")
            entrypoint = package_root / item["entrypoint"]
            proof = {"package": item["package"], "version": item["version"], "integrity": integrity,
                     "package_lock_sha256": hashlib.sha256((target / "package-lock.json").read_bytes()).hexdigest()}
        else:
            source = target / "source"
            installer.progress(name, "source_clone")
            installer.run([str(git), "clone", "--filter=blob:none", "--no-checkout", item["source_repository"], str(source)])
            installer.progress(name, "source_checkout")
            installer.run([str(git), "-C", str(source), "checkout", "--detach", item["commit"]])
            installer.progress(name, "source_revision")
            actual = installer.run([str(git), "-C", str(source), "rev-parse", "HEAD"]).decode().strip()
            installer.require(actual == item["commit"], "source_revision")
            tool = target / "tools"
            tool.mkdir()
            installer.progress(name, "pnpm_install")
            installer.run([str(npm), "install", "--prefix", str(tool), "--no-audit", "--no-fund", "pnpm@10.33.2"])
            pnpm = tool / "node_modules" / "pnpm" / "bin" / "pnpm.cjs"
            installer.progress(name, "source_dependencies")
            installer.run([str(node), str(pnpm), "--dir", str(source), "install", "--frozen-lockfile"])
            installer.progress(name, "source_build")
            installer.run([str(node), str(pnpm), "--dir", str(source), "--filter", "@zcode/cli...", "build"])
            entrypoint = source / item["entrypoint"]
            proof = {"repository": item["source_repository"], "commit": actual, "pnpm_version": "10.33.2"}
        installer.progress(name, "entrypoint_identity")
        installer.require(entrypoint.is_file(), "entrypoint_missing")
        installed[name] = {"command": [str(node), str(entrypoint)],
                           "entrypoint_sha256": hashlib.sha256(entrypoint.read_bytes()).hexdigest(),
                           "protocol": item["protocol"], "identity": proof}
        installer.progress(name, "completed")
    manifest = {"schema_version": 1, "catalog_sha256": hashlib.sha256(catalog_bytes).hexdigest(),
                "node": str(node), "node_version": version, "harnesses": installed}
    installer.progress("runtime", "manifest_write")
    private_file(root / "installation.json", (json.dumps(manifest, indent=2) + "\n").encode())
    return manifest


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", required=True, type=Path)
    parser.add_argument("--harness", action="append", choices=list(json.loads(CATALOG.read_text())["harnesses"]))
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        parser.error("dependency install is allowed only in GitHub Actions; local work is unit tests only")
    root = args.root.resolve()
    root.mkdir(mode=0o700, parents=True, exist_ok=False)
    try:
        install(root, args.harness or list(json.loads(CATALOG.read_text())["harnesses"]))
    except InstallFailure as failure:
        parser.exit(1, str(failure) + "\n")
    print(json.dumps({"installation": str(root / "installation.json")}))


if __name__ == "__main__":
    main()
