"""Run the production-key installed-MFA process gates on GitHub runners only."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess


def digest(path):
    with path.open("rb") as source:
        return hashlib.file_digest(source, "sha256").hexdigest()


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--evidence", type=Path, required=True)
    args = parser.parse_args()
    if os.environ.get("GITHUB_ACTIONS") != "true":
        parser.error("Actual host processes run only on GitHub; locally compile with --no-run")
    root = args.evidence
    rows = [json.loads(line) for line in (root / "core-build.jsonl").read_text().splitlines()]
    artifacts = {
        row["executable"] for row in rows
        if row.get("reason") == "compiler-artifact"
        and row.get("target", {}).get("name") == "taomni_lib"
        and row.get("profile", {}).get("test") is True
        and row.get("executable")
        and "qa-release-trust-gates" in row.get("features", [])
    }
    if len(artifacts) != 1:
        raise SystemExit(f"Expected one dedicated production-trust harness, got {len(artifacts)}")
    executable = Path(artifacts.pop()).resolve(strict=True)
    source = subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip()
    expected = os.environ["TAOMNI_SIGNED_MFA_SOURCE_SHA"]
    assert source == expected, "Core harness source differs from selected package source"
    artifact = Path(os.environ["TAOMNI_SIGNED_MFA_PACKAGE_DIR"]).resolve(strict=True)
    os.environ["TAOMNI_SIGNED_MFA_PACKAGE_DIR"] = str(artifact)
    package = json.loads((artifact / "provenance.json").read_text())
    assert package["sourceSha"] == source
    assert package["slug"] == "mfa" and package["trust"] == "plugins.updater.pubkey"
    archive_name = package["archive"]
    assert Path(archive_name).name == archive_name, "Unsafe archive name in receipt"
    archive = artifact / archive_name
    assert digest(archive) == package["sha256"], "Signed package artifact hash mismatch"
    selected = "plugin::signed_mfa_host_tests"
    listing = subprocess.check_output([str(executable), selected, "--ignored", "--list"], text=True)
    (root / "selected-tests.txt").write_text(listing, encoding="utf-8")
    count = sum(line.endswith(": test") for line in listing.splitlines())
    assert count == 3, f"Expected three actual signed-install gates, got {count}"
    receipt = {
        "schema": "taomni.signed-mfa-install.v1", "head": source,
        "platform": package["platform"], "filter": selected, "selected": count,
        "coreSha256": digest(executable), "packageSha256": digest(archive),
        "provenanceSha256": digest(artifact / "provenance.json"),
        "trust": "plugins.updater.pubkey",
        "systemTrust": "unverified", "productFacade": "legacy-core",
        "monolithUpgrade": "unverified", "features": ["qa-release-trust-gates"],
    }
    try:
        result = subprocess.run(
            [str(executable), selected, "--ignored", "--test-threads=1", "--nocapture"],
            text=True, encoding="utf-8", errors="replace",
            stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=180,
        )
        output, exit_code = result.stdout, result.returncode
    except subprocess.TimeoutExpired as error:
        output = error.stdout or b""
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        output += "\nInstalled MFA gate exceeded its 180-second process deadline.\n"
        exit_code = 124
    (root / "installed-mfa-process.log").write_text(output, encoding="utf-8")
    print(output, flush=True)
    summary = re.search(
        r"test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;", output,
    )
    passed = exit_code == 0 and summary is not None and summary.groups() == ("3", "0", "0")
    receipt.update({"exitCode": exit_code, "allSelectedPassed": passed,
                    "fixtureKeyRejectionVerified": passed})
    (root / "installed-mfa-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if passed else (exit_code or 1))


if __name__ == "__main__":
    main()
