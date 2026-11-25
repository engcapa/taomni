"""Check glibc requirements in staged Linux module binaries before signing."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


# Core Linux installers support Ubuntu 22.04.
BASELINE = (2, 35)


def glibc_requirements(version_info):
    """Read version needs only. A shared library can also define symbol versions."""
    needed = set()
    in_needs = False
    for line in version_info.splitlines():
        if line.startswith("Version "):
            in_needs = line.startswith("Version needs section ")
        elif in_needs:
            match = re.search(r"\bName: (GLIBC_\S+)\s+Flags:", line)
            if match:
                needed.add(match.group(1))
    return sorted(needed)


def supports(requirement):
    version = re.fullmatch(r"GLIBC_(\d+(?:\.\d+)+)", requirement)
    return bool(version and tuple(map(int, version[1].split("."))) <= BASELINE)


def inspect_payload(manifest_file):
    root = manifest_file.parent
    manifest = json.loads(manifest_file.read_text(encoding="utf-8"))
    host = manifest["entry"].get("host")
    binaries = []
    errors = []
    for path in sorted(root.rglob("*")):
        if not path.is_file():
            continue
        name = path.relative_to(root).as_posix()
        with path.open("rb") as stream:
            header = stream.read(20)
            if not header.startswith(b"\x7fELF"):
                if name == host or re.search(r"\.so(?:\.|$)", path.name):
                    errors.append(f"{name} is not an ELF binary")
                continue
            digest = hashlib.sha256(header)
            for block in iter(lambda: stream.read(1024 * 1024), b""):
                digest.update(block)
        if header[4:6] != b"\x02\x01" or header[18:20] != b"\x3e\x00":
            errors.append(f"{name} is not a little-endian x86-64 ELF binary")
            continue
        result = subprocess.run(
            ["readelf", "--version-info", "--wide", path],
            env=dict(os.environ, LC_ALL="C"), text=True, capture_output=True, check=True,
        )
        requires = glibc_requirements(result.stdout)
        binaries.append({"path": name, "sha256": digest.hexdigest(), "requires": requires})
        errors.extend(f"{name} requires {symbol}" for symbol in requires if not supports(symbol))
    if host and not any(item["path"] == host for item in binaries):
        errors.append(f"missing x86-64 host {host}")
    return {"payload": root.name, "module": manifest["id"], "version": manifest["version"],
            "binaries": binaries, "errors": errors}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--source", required=True)
    parser.add_argument("--output", required=True, type=Path)
    parser.add_argument("manifests", nargs="+", type=Path)
    args = parser.parse_args()
    payloads = [inspect_payload(path) for path in args.manifests]
    receipt = {"sourceSha": args.source, "platform": "linux-x86_64", "maximumGlibc": "2.35",
               "runnerImage": os.environ.get("ImageVersion"), "payloads": payloads}
    args.output.write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    for item in payloads:
        for error in item["errors"]:
            print(f"{item['payload']}: {error}")
    return int(any(item["errors"] for item in payloads))


if __name__ == "__main__":
    raise SystemExit(main())
