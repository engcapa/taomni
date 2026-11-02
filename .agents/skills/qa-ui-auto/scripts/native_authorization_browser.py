"""Real-browser launcher for the isolated hosted authorization fixture only."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from urllib.parse import urlsplit


def command(browser: Path, profile: Path, url: str) -> list[str]:
    parsed = urlsplit(url)
    if (parsed.scheme != "https" or parsed.username or parsed.password
            or parsed.port or parsed.fragment
            or (parsed.hostname, parsed.path) not in {
                ("accounts.feishu.cn", "/oauth/v1/device/verify"),
                ("open.feishu.cn", "/page/cli"),
            }):
        raise ValueError("Unexpected authorization browser destination")
    if browser.name in {"firefox", "firefox-bin"}:
        return [str(browser), "--no-remote", "--profile", str(profile), url]
    if browser.name in {"google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "chrome"}:
        return [str(browser), "--user-data-dir=" + str(profile), "--no-first-run",
                "--no-default-browser-check", url]
    raise ValueError("Unsupported real authorization browser")


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--browser", type=Path, required=True)
    parser.add_argument("--profile", type=Path, required=True)
    parser.add_argument("--record", type=Path, required=True)
    parser.add_argument("--cache-root", type=Path, required=True)
    parser.add_argument("url")
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        raise RuntimeError("Authorization browser launcher is hosted-QA only")
    profile = args.profile.resolve()
    # Desktop activation may sanitize the inherited XDG environment. This
    # exact fixture-owned root is passed by the run-local desktop launcher.
    cache = args.cache_root.resolve()
    record = args.record.resolve()
    if (not profile.is_dir() or not (profile / ".taomni-qa-browser").is_file()
            or not profile.is_relative_to(cache) or not record.parent.is_dir()
            or record.name != "launch.json"):
        raise RuntimeError("Authorization browser profile is not fixture-owned")
    argv = command(args.browser, profile, args.url)
    # Never retain authorization URLs, codes, cookies or browser environment.
    args.record.write_text(json.dumps({"browser": str(args.browser), "profile": str(profile),
                                       "pid": os.getpid(), "launched": True}) + "\n", encoding="utf-8")
    os.execv(str(args.browser), argv)


if __name__ == "__main__":
    main()
