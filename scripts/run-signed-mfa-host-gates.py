"""Run the production-key installed module process gates on GitHub runners."""
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
    parser.add_argument("--suite", choices=("installed", "legacy-migration", "legacy-mail"), default="installed")
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
    slug = "mail" if args.suite == "legacy-mail" else "mfa"
    prefix = f"TAOMNI_SIGNED_{slug.upper()}"
    expected = os.environ[f"{prefix}_SOURCE_SHA"]
    assert source == expected, "Core harness source differs from selected package source"
    artifact = Path(os.environ[f"{prefix}_PACKAGE_DIR"]).resolve(strict=True)
    os.environ[f"{prefix}_PACKAGE_DIR"] = str(artifact)
    package = json.loads((artifact / "provenance.json").read_text())
    assert package["sourceSha"] == source
    assert package["slug"] == slug and package["trust"] == "plugins.updater.pubkey"
    archive_name = package["archive"]
    assert Path(archive_name).name == archive_name, "Unsafe archive name in receipt"
    archive = artifact / archive_name
    assert digest(archive) == package["sha256"], "Signed package artifact hash mismatch"
    if args.suite == "installed":
        selected, evidence_name = "plugin::signed_mfa_host_tests", "installed-mfa"
        expected_tests = 3
        listing_name = "selected-tests.txt"
    elif args.suite == "legacy-migration":
        selected, evidence_name = "plugin::migration_commit::tests::signed_legacy_mfa_", "legacy-mfa-migration"
        expected_tests = 11
        listing_name = "legacy-mfa-selected-tests.txt"
    else:
        selected, evidence_name = "plugin::migration_mail::tests::signed::signed_mail_upgrade", "legacy-mail-migration"
        expected_tests = 2
        listing_name = "legacy-mail-selected-tests.txt"
    listing = subprocess.check_output([str(executable), selected, "--ignored", "--list"], text=True)
    (root / listing_name).write_text(listing, encoding="utf-8")
    count = sum(line.endswith(": test") for line in listing.splitlines())
    assert count == expected_tests, f"Expected {expected_tests} actual {args.suite} gates, got {count}"
    receipt = {
        "schema": f"taomni.signed-{slug}-legacy-migration.v1"
                  if args.suite != "installed" else "taomni.signed-mfa-install.v1", "head": source,
        "platform": package["platform"], "filter": selected, "selected": count,
        "coreSha256": digest(executable), "packageSha256": digest(archive),
        "provenanceSha256": digest(artifact / "provenance.json"),
        "runner": os.environ.get("QA_RUNNER_LABEL"),
        "runnerImage": os.environ.get("ImageVersion"),
        "runnerArchitecture": os.environ.get("RUNNER_ARCH"),
        "caseSelectionSha256": digest(root / listing_name),
        "artifactLog": f"{evidence_name}-process.log",
        "trust": "plugins.updater.pubkey",
        "systemTrust": "unverified",
        "productFacade": "direct-registry" if args.suite == "installed" else f"committed-{slug}",
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
        output += f"\nInstalled {slug} gate exceeded its 180-second process deadline.\n"
        exit_code = 124
    (root / f"{evidence_name}-process.log").write_text(output, encoding="utf-8")
    print(output, flush=True)
    summary = re.search(
        r"test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;", output,
    )
    passed = exit_code == 0 and summary is not None and summary.groups() == (str(expected_tests), "0", "0")
    receipt.update({"exitCode": exit_code, "allSelectedPassed": passed})
    if args.suite == "installed":
        receipt["fixtureKeyRejectionVerified"] = passed
    else:
        receipt["legacyProfileSeed"] = "synthetic-v0.5-style"
    (root / f"{evidence_name}-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if passed else (exit_code or 1))


if __name__ == "__main__":
    main()
