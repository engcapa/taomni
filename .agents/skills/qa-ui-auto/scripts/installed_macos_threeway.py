"""Compare stable, frozen and experimental cores with equal system grants in one job."""

from contextlib import contextmanager
from itertools import permutations
import json
import os
from pathlib import Path
from statistics import median

from installed_core_resources_desktop import compile_macos_probe, fresh_profiles
from installed_macos_memory import app_version, sample
from installed_macos_host_signature import observe_signature
from installed_macos_permissions import compare_permissions, observe_permissions
from modular_bundle_inventory import digest, write_json
from qa_ui_auto.legacy_install import macos_install

LABELS = ("stable", "frozen", "experiment")


def validate_experiment(directory, certificate, frozen):
    producer = json.loads((directory / "producer.json").read_bytes())
    identity = json.loads((directory / "macos-build-identity.json").read_bytes())
    if (
        producer["head_sha"] == frozen
        or identity["sourceSha"] != producer["head_sha"]
        or identity["certificateSha1"].upper() != certificate
        or identity["arch"] != "aarch64"
        or identity["staticKerberos"]
        or identity["signingMode"] not in ("self-signed", "developer-id")
    ):
        raise RuntimeError(
            "The experiment requires a distinct product SHA and the production ARM64 signature"
        )
    return producer, identity


@contextmanager
def activate(label, target, work):
    if label not in LABELS:
        raise ValueError(label)
    saved = work / ("original.app" if label == "stable" else "experimental.app")
    with app_version(
        "candidate" if label == "frozen" else label,
        target,
        saved,
        work / "parked-frozen.app",
    ):
        yield


def compare(executable, profile, work, report, stages, identity):
    folder = report / "three-core-memory"
    folder.mkdir()
    directory = Path("experiment-input").resolve(strict=True)
    cert = os.environ["MACOS_SIGNING_CERT_SHA1"].strip().upper()
    producer, build = validate_experiment(directory, cert, identity["producerSource"])
    (artifact,) = directory.glob("*.dmg")
    slot = work / "experimental-install"
    slot.mkdir()
    installation = folder / "experimental-install"
    installation.mkdir()
    exp, details = macos_install(
        artifact, slot, installation, version=identity["version"]
    )
    details["fixedSignature"] = observe_signature(
        exp.parents[2], installation, "experimental", cert, require_hardened=False
    )
    exp.parents[2].rename(work / "experimental.app")
    target = executable.parents[2]
    with activate("experiment", target, work):
        exp_permissions = observe_permissions(
            executable, report, "experiment", work=work
        )
    permissions = {
        "stable": stages["originalPermissions"],
        "frozen": stages["candidatePermissions"],
        "experiment": exp_permissions,
    }
    for label in LABELS[1:]:
        if not compare_permissions(permissions["stable"], permissions[label])[
            "retainedBothGrants"
        ]:
            raise RuntimeError(
                f"{label} must report the stable app's two grants under the same designated requirement"
            )
    result = {
        "stableInstaller": json.loads(
            (Path("legacy-input") / "first-upgrade-baseline.json").read_bytes()
        ),
        "frozenProducer": identity,
        "experimentProducer": producer,
        "experimentBuild": build,
        "experimentInstallation": details,
        "experimentInstallerSha256": digest(artifact),
        "verificationSha": os.environ["GITHUB_SHA"],
        "run": os.environ["GITHUB_RUN_ID"],
        "runnerImage": os.environ["ImageVersion"],
        "permissions": permissions,
        "samples": [],
    }
    index = folder / "three-core-memory.json"
    write_json(index, result)
    driver = compile_macos_probe(work, folder)
    with fresh_profiles(profile) as staging:
        for trial, labels in enumerate(permutations(LABELS), 1):
            for label in labels:
                name = f"{trial}-{label}"
                with activate(label, target, work):
                    if digest(executable) != permissions[label]["binarySha256"]:
                        raise RuntimeError(f"Unexpected installed binary for {label}")
                    profile.mkdir()
                    row = sample(
                        driver, executable, folder / name, work, maps=trial == 1
                    )
                    if not (profile / "taomni.db").is_file() or any(
                        (profile / "plugins").glob("*/active.json")
                    ):
                        raise RuntimeError("Expected initialized core-only profile")
                    profile.rename(staging / name)
                    result["samples"].append({"label": label, "trial": trial, **row})
                    write_json(index, result)
    for label in LABELS:
        rows = [r for r in result["samples"] if r["label"] == label]
        result[label] = {
            "readyRssBytes": median(median(r["rssBytes"]) for r in rows),
            "readyFootprintBytes": median(
                r["readyMemory"]["physicalFootprintBytes"] for r in rows
            ),
            "idle30RssBytes": median(
                median(r["idleMemory"][-1]["rssBytes"]) for r in rows
            ),
            "idle30FootprintBytes": median(
                r["idleMemory"][-1]["physicalFootprintBytes"] for r in rows
            ),
        }
    write_json(index, result)
    return {
        "path": str(index.relative_to(report)),
        **{label: result[label] for label in LABELS},
    }
