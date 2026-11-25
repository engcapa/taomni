"""Exercise persisted Settings/Vault proxy routing in the core on GitHub only."""
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
        parser.error("Native network validation runs only on GitHub; locally compile with --no-run")
    root = args.evidence
    rows = [json.loads(line) for line in (root / "core-build.jsonl").read_text().splitlines()]
    executables = {row["executable"] for row in rows
                   if row.get("reason") == "compiler-artifact"
                   and row.get("target", {}).get("name") == "taomni_lib"
                   and row.get("profile", {}).get("test") is True and row.get("executable")}
    if len(executables) != 1:
        raise SystemExit("Expected exactly one freshly compiled production core harness")
    executable = Path(executables.pop()).resolve(strict=True)
    selected = "plugin::network::tests::native::"
    listing = subprocess.check_output([str(executable), selected, "--ignored", "--list"], text=True)
    (root / "module-network-selected.txt").write_text(listing, encoding="utf-8")
    count = sum(line.endswith(": test") for line in listing.splitlines())
    if count != 2:
        raise SystemExit(f"Expected two native Settings/Vault proxy tests, got {count}")
    environment = dict(os.environ)
    for key in ("HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy"):
        environment[key] = "http://127.0.0.1:9"
    environment.update(NO_PROXY="", no_proxy="")
    try:
        result = subprocess.run([str(executable), selected, "--ignored", "--test-threads=1", "--nocapture"],
                                env=environment, text=True, encoding="utf-8", errors="replace",
                                stdout=subprocess.PIPE, stderr=subprocess.STDOUT, timeout=60)
        output, exit_code = result.stdout, result.returncode
    except subprocess.TimeoutExpired as error:
        output = error.stdout or b""
        if isinstance(output, bytes):
            output = output.decode("utf-8", errors="replace")
        output += "\nNative proxy contracts exceeded the 60-second deadline.\n"
        exit_code = 124
    (root / "module-network-native.log").write_text(output, encoding="utf-8")
    print(output, flush=True)
    summary = re.search(r"test result: ok\. (\d+) passed; (\d+) failed; (\d+) ignored;", output)
    passed = exit_code == 0 and summary is not None and summary.groups() == ("2", "0", "0")
    receipt = {"schema": "taomni.module-network.v1", "selected": count, "filter": selected,
               "head": subprocess.check_output(["git", "rev-parse", "HEAD"], text=True).strip(),
               "coreSha256": digest(executable),
               "exitCode": exit_code, "allSelectedPassed": passed,
               "environmentProxy": "poisoned", "scope": "persisted Settings/Vault and native HTTP transport"}
    (root / "module-network-receipt.json").write_text(json.dumps(receipt, indent=2) + "\n", encoding="utf-8")
    raise SystemExit(0 if passed else (exit_code or 1))


if __name__ == "__main__":
    main()
