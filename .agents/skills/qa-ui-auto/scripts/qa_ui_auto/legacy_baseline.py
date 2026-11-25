"""Resolve the public monolith once and carry its four immutable installer identities through QA."""
import json
import os
from pathlib import Path
import re
import subprocess

REPOSITORY = "engcapa/taomni"
VERSION = r"(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)"
TARGETS = {
    "Linux/x64": "amd64.deb",
    "Windows/x64": "x64_en-US.msi",
    "Darwin/arm64": "aarch64.dmg",
    "Darwin/x64": "x64.dmg",
}


def metadata(endpoint):
    return json.loads(subprocess.check_output(["gh", "api", f"repos/{REPOSITORY}/releases{endpoint}"]))


def freeze(release, requested):
    tag = release.get("tag_name", "")
    version = tag.removeprefix("v")
    if (tag != f"v{version}" or not re.fullmatch(VERSION, version) or release.get("draft") is not False
            or release.get("prerelease") is not False or not release.get("published_at")
            or type(release.get("id")) is not int or release["id"] < 1):
        raise ValueError("First-upgrade baseline must be a published stable core release")
    if requested not in ("", "latest", version):
        raise ValueError("Resolved first-upgrade version differs from the requested tag")
    assets = release["assets"]
    if any(a["name"] in ("modules.json", "modules.json.minisig") for a in assets):
        raise ValueError("First-upgrade baseline already ships a modular catalog")
    record = {"repository": REPOSITORY, "tag": tag, "version": version, "releaseId": release["id"],
              "publishedAt": release["published_at"], "installers": {}}
    for target, suffix in TARGETS.items():
        name = f"Taomni_{version}_{suffix}"
        matches = [a for a in assets if a["name"] == name]
        if len(matches) != 1:
            raise ValueError(f"Expected one published installer for {target} in {tag}")
        asset = matches[0]
        if (asset.get("state") != "uploaded" or type(asset.get("id")) is not int or asset["id"] <= 0
                or type(asset.get("size")) is not int or asset["size"] <= 0
                or not re.fullmatch(r"sha256:[a-f0-9]{64}", asset.get("digest") or "")):
            raise ValueError(f"Incomplete public identity for {name}")
        record["installers"][target] = {"name": name, "asset_id": asset["id"],
                                       "size": asset["size"], "sha256": asset["digest"][7:]}
    return record


def monolith(release):
    return (re.fullmatch("v" + VERSION, release.get("tag_name", "")) and not release.get("draft")
            and not release.get("prerelease")
            and all(asset["name"] not in {"modules.json", "modules.json.minisig"} for asset in release["assets"]))


def resolve(requested=""):
    requested = requested.removeprefix("v")
    if requested in ("", "latest"):
        release = metadata("/latest")
        if monolith(release):
            return freeze(release, requested)
        # After the first modular release, keep exercising the last public monolith.
        page = 1
        while releases := metadata(f"?per_page=100&page={page}"):
            for release in releases:
                if monolith(release):
                    return freeze(release, requested)
            page += 1
        raise ValueError("No published monolithic core release was found")
    if not re.fullmatch(VERSION, requested):
        raise ValueError("Expected a stable first-upgrade version or latest")
    return freeze(metadata("/tags/v" + requested), requested)


def current():
    value = os.environ.get("QA_FIRST_UPGRADE_BASELINE")
    if value:
        return json.loads(value)
    receipt = os.environ.get("QA_FIRST_UPGRADE_BASELINE_FILE")
    if receipt:
        return json.loads(Path(receipt).read_text(encoding="utf-8"))
    return resolve(os.environ.get("QA_FIRST_UPGRADE_VERSION", ""))


if __name__ == "__main__":
    record = resolve(os.environ.get("QA_FIRST_UPGRADE_VERSION", ""))
    target = os.environ.get("PACKAGE_VERSION")
    if target and tuple(map(int, record["version"].split("."))) >= tuple(map(int, target.split("."))):
        raise ValueError(f"First-upgrade baseline {record['version']} must precede candidate {target}")
    Path("first-upgrade-baseline.json").write_text(json.dumps(record, indent=2) + "\n", encoding="utf-8")
    with Path(os.environ["GITHUB_OUTPUT"]).open("a", encoding="utf-8") as output:
        output.write("baseline=" + json.dumps(record, separators=(",", ":")) + "\n")
    print(f"Selected {record['tag']} ({record['releaseId']}) with {len(record['installers'])} installer identities")
