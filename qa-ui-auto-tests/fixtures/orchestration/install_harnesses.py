#!/usr/bin/env python3
"""CI-only dependency installation. Research/local unit tests must not invoke this."""
from __future__ import annotations

import argparse
import hashlib
import json
import os
import shutil
import subprocess
from pathlib import Path

CATALOG = Path(__file__).resolve().with_name("harness_catalog.json")


def run(args: list[str], cwd: Path, env: dict | None = None, timeout: int = 1800) -> bytes:
    result = subprocess.run(args, cwd=cwd, env=env, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                            timeout=timeout, check=False)
    if result.returncode:
        # Upstream logs may contain URLs/credentials; keep them private to the
        # installation directory, not the published validation receipt/stdout.
        (cwd / "install-error.stdout").write_bytes(result.stdout)
        (cwd / "install-error.stderr").write_bytes(result.stderr)
        raise RuntimeError(f"installation command failed with exit {result.returncode}; inspect private install logs")
    return result.stdout


def install(root: Path, harnesses: list[str]) -> dict:
    catalog_bytes = CATALOG.read_bytes()
    catalog = json.loads(catalog_bytes)
    node = Path(shutil.which("node") or "").resolve()
    npm = Path(shutil.which("npm") or "").resolve()
    git = Path(shutil.which("git") or "").resolve()
    if not all(path.is_file() for path in (node, npm, git)):
        raise RuntimeError("node, npm and git must be installed before harness dependencies")
    version = run([str(node), "--version"], root).decode().strip()
    if version != "v" + catalog["runtime"]["node"]:
        raise RuntimeError("harness installation requires the catalog's exact Node runtime version")
    installed = {}
    for name in harnesses:
        item = catalog["harnesses"][name]
        target = root / name
        target.mkdir(mode=0o700)
        if "package" in item:
            # Registry metadata and npm's package-lock integrity both must match
            # the researched pin. A mutable dist-tag is never installed.
            spec = item["package"] + "@" + item["version"]
            integrity = json.loads(run([str(npm), "view", spec, "dist.integrity", "--json"], target))
            if integrity != item["integrity"]:
                raise RuntimeError(f"upstream integrity changed for pinned {name}")
            (target / "package.json").write_text(json.dumps({"name": "taomni-qa-" + name,
                "private": True, "dependencies": {item["package"]: item["version"]}}), encoding="utf-8")
            run([str(npm), "install", "--no-audit", "--no-fund", "--save-exact"], target)
            package_root = target / "node_modules" / item["package"]
            package = json.loads((package_root / "package.json").read_text())
            if package.get("name") != item["package"] or package.get("version") != item["version"]:
                raise RuntimeError("installed harness package identity does not match catalog")
            lock = json.loads((target / "package-lock.json").read_text())
            locked = lock.get("packages", {}).get("node_modules/" + item["package"], {})
            if locked.get("integrity") != item["integrity"]:
                raise RuntimeError("installed harness archive integrity does not match catalog")
            entrypoint = package_root / item["entrypoint"]
            command = [str(node), str(entrypoint)]
            proof = {"package": item["package"], "version": item["version"], "integrity": integrity,
                     "package_lock_sha256": hashlib.sha256((target / "package-lock.json").read_bytes()).hexdigest()}
        else:
            source = target / "source"
            run([str(git), "clone", "--filter=blob:none", "--no-checkout", item["source_repository"], str(source)], target)
            run([str(git), "-C", str(source), "checkout", "--detach", item["commit"]], target)
            actual = run([str(git), "-C", str(source), "rev-parse", "HEAD"], target).decode().strip()
            if actual != item["commit"]:
                raise RuntimeError("source checkout does not match the catalog commit")
            # Use a dedicated pnpm version inside this installation, never
            # replace the application's pnpm or write to global configuration.
            tool = target / "tools"
            tool.mkdir()
            run([str(npm), "install", "--prefix", str(tool), "--no-audit", "--no-fund", "pnpm@10.33.2"], target)
            pnpm = tool / "node_modules" / "pnpm" / "bin" / "pnpm.cjs"
            run([str(node), str(pnpm), "install", "--frozen-lockfile"], source)
            run([str(node), str(pnpm), "--filter", "@zcode/cli...", "build"], source)
            entrypoint = source / item["entrypoint"]
            command = [str(node), str(entrypoint)]
            proof = {"repository": item["source_repository"], "commit": actual,
                     "pnpm_version": "10.33.2"}
        if not entrypoint.is_file():
            raise RuntimeError(f"pinned {name} entrypoint is missing after installation")
        installed[name] = {"command": command, "entrypoint_sha256": hashlib.sha256(entrypoint.read_bytes()).hexdigest(),
                           "protocol": item["protocol"], "identity": proof}
    manifest = {"schema_version": 1, "catalog_sha256": hashlib.sha256(catalog_bytes).hexdigest(),
                "node": str(node), "node_version": version, "harnesses": installed}
    (root / "installation.json").write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
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
    except (RuntimeError, subprocess.TimeoutExpired) as exc:
        parser.exit(1, str(exc) + "\n")
    print(json.dumps({"installation": str(root / "installation.json")}))


if __name__ == "__main__":
    main()
