#!/usr/bin/env python3
"""Preflight environment check for qa-ui-auto.

Browser mode verifies / installs:
  - node >= 18, pnpm
  - project node_modules (pnpm install if missing)
  - playwright-cli (npm i -g @playwright/cli@latest if absent)
  - chromium browser (playwright-cli install chromium)
  - python yaml package

Native mode verifies only:
  - cargo
  - tauri-driver
  - platform WebDriver (msedgedriver on Windows)
  - Tauri debug binary

Exits 0 on success, non-zero on unrecoverable error.
"""
from __future__ import annotations

import argparse
import os
import platform
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[3].parent if False else Path.cwd()
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

from tauri_webdriver import native_binary  # noqa: E402


def run(cmd: list[str], check: bool = True, capture: bool = False) -> subprocess.CompletedProcess:
    resolved = cmd[:]
    resolved_bin = shutil.which(resolved[0])
    if resolved_bin:
        resolved[0] = resolved_bin
    print(f"$ {' '.join(cmd)}", flush=True)
    return subprocess.run(resolved, check=check, text=True,
                          stdout=subprocess.PIPE if capture else None,
                          stderr=subprocess.PIPE if capture else None)


def have(bin_name: str) -> bool:
    return shutil.which(bin_name) is not None


def ensure_node() -> None:
    if not have("node"):
        sys.exit("node is not installed. Install Node.js >= 18 and retry.")
    out = run(["node", "--version"], capture=True).stdout.strip()
    major = int(out.lstrip("v").split(".")[0])
    if major < 18:
        sys.exit(f"node >= 18 required, found {out}")


def ensure_pnpm() -> None:
    if not have("pnpm"):
        # Try corepack
        if have("corepack"):
            run(["corepack", "enable"])
        else:
            run(["npm", "install", "-g", "pnpm"])


def ensure_project_deps() -> None:
    if not (Path.cwd() / "node_modules").exists():
        run(["pnpm", "install"])


def ensure_playwright_cli() -> None:
    try:
        run(["playwright-cli", "--version"], capture=True)
    except (subprocess.CalledProcessError, FileNotFoundError):
        run(["npm", "install", "-g", "@playwright/cli@latest"])
    # Install chromium browser (idempotent)
    try:
        run(["playwright-cli", "install", "chromium"])
    except subprocess.CalledProcessError:
        # Some versions use `npx playwright install`; fall back.
        run(["npx", "--yes", "playwright", "install", "chromium"])


def ensure_python_deps() -> None:
    try:
        import yaml  # noqa: F401
    except ImportError:
        run([sys.executable, "-m", "pip", "install", "--quiet", "pyyaml"])


def native_issues() -> list[str]:
    issues: list[str] = []
    if not have("cargo"):
        issues += [
            "cargo is not installed or not on PATH.",
            "Install Rust/Cargo and retry.",
        ]
    if not have("tauri-driver"):
        issues += [
            "tauri-driver is not installed.",
            "Run: cargo install tauri-driver --locked",
        ]
    if platform.system() == "Windows" and not have("msedgedriver"):
        issues += [
            "msedgedriver is not on PATH.",
            "Download the Microsoft Edge Driver matching Edge/WebView2,",
            "then put msedgedriver.exe on PATH or set webdriver.native_driver.",
        ]
    binary = native_binary({})
    if not binary.exists():
        issues += [
            f"Tauri debug binary not found: {binary}",
            "Build it first:",
            "  cargo tauri build --debug --no-bundle",
            "or:",
            "  pnpm tauri build --debug --no-bundle",
        ]
    return issues


def ensure_native() -> int:
    issues = native_issues()
    if issues:
        print("qa-ui-auto native environment is not ready.\n")
        for issue in issues:
            print(issue)
        return 2
    print("qa-ui-auto: native environment OK")
    return 0


def ensure_browser() -> int:
    ensure_node()
    ensure_pnpm()
    ensure_project_deps()
    ensure_playwright_cli()
    ensure_python_deps()
    print("qa-ui-auto: browser environment OK")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--mode", choices=["browser", "native"], default="browser")
    args = ap.parse_args()
    if args.mode == "native":
        return ensure_native()
    return ensure_browser()


if __name__ == "__main__":
    sys.exit(main())
