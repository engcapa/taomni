"""Observe the installed MFA package, live process and real HOTP data."""
from contextlib import closing, suppress
import hashlib
import json
from pathlib import Path
import sqlite3

from native_qa_bridge import identity

from .fixtures.backup_policy import isolated_data_root
from .module_profile_observation import writer_lease
from .module_qa_versions import MFA_LIFECYCLE_CASE
from .module_retained_observation import assert_code_removed, ordinary
from .module_signed_observation import invoke
from .steps import StepError


ISSUER = "MFA lifecycle HOTP"
STATES = {
    "old-enabled": ("previous", None, "enabled", 1),
    "old-disabled": ("previous", None, "disabled", 1),
    "updated-disabled": ("current", "previous", "disabled", 1),
    "rolled-back-disabled": ("previous", "current", "disabled", 1),
    "old-reenabled": ("previous", "current", "enabled", 1),
    "updated-enabled": ("current", "previous", "enabled", 1),
    "failed-update": ("current", "previous", "enabled", 2),
    "rolled-back-enabled": ("previous", "current", "enabled", 2),
    "uninstalled": (None, "previous", "uninstalled", 3),
    "reinstalled": ("current", None, "enabled", 3),
}


def digest(path: Path) -> str:
    ordinary(path)
    with path.open("rb") as stream:
        return hashlib.file_digest(stream, "sha256").hexdigest()


def account_record(database: Path, counter: int, *, issuer: str = ISSUER) -> dict:
    ordinary(database)
    with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as connection:
        rows = connection.execute(
            "SELECT id, kind, counter, secret_ct, secret_nonce FROM mfa_accounts WHERE issuer = ?", (issuer,),
        ).fetchall()
    if len(rows) != 1 or rows[0][1:3] != ("hotp", counter):
        raise StepError(f"Expected one module HOTP account at counter {counter}")
    identifier, _, _, ciphertext, nonce = rows[0]
    if len(ciphertext) < 16 or not nonce:
        raise StepError("MFA account does not contain an encrypted secret")
    return {"id": identifier, "counter": counter,
            "encryptedSecretSha256": hashlib.sha256(ciphertext + nonce).hexdigest()}


def inspect_process(ctx, expected_host: Path | None, previous: dict | None) -> tuple[dict, dict | None]:
    import psutil

    if previous:
        core = identity(previous["core"]["pid"])
        if core != previous["core"]:
            raise StepError("The original desktop process exited during the module lifecycle")
        last_host = previous["host"]
        if last_host:
            alive = identity(last_host["pid"])
            if alive and alive["started"] == last_host["started"]:
                raise StepError("The previous MFA process remained alive after switching or stopping the module")
    else:
        # The first host runs below this case's exact signed installation path.
        # Its parent is the desktop even when a WebDriver owns the launcher.
        core = None
    candidates = (psutil.Process(core["pid"]).children(recursive=True) if core
                  else psutil.process_iter(["pid"]))
    matches = []
    for child in candidates:
        with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
            child_path = Path(child.exe()).resolve()
            if expected_host and child_path == expected_host:
                matches.append(child)
            elif child_path.name in {"taomni-plugin-mfa", "taomni-plugin-mfa.exe"} and core:
                raise StepError("A second or wrong-version MFA host survived under the desktop")
    if len(matches) != int(expected_host is not None):
        raise StepError(f"Unexpected MFA process count for signed version: {len(matches)}")
    host = None
    if matches:
        process = matches[0]
        host = identity(process.pid)
        desktop = identity(process.ppid())
        if host is None or desktop is None or (core and desktop != core):
            raise StepError("The installed MFA process does not belong to the original desktop")
        core = desktop
    if core is None or Path(core["executable"]) != ctx.session.application.resolve():
        raise StepError("The module was not launched by this case's QA desktop executable")
    return core, host


def run(ctx, phase):
    owner = ctx.fixture_context
    packages = getattr(owner, "mfa_lifecycle", None)
    if not packages or owner.case_id != MFA_LIFECYCLE_CASE or phase not in STATES:
        raise StepError("assert_signed_mfa_lifecycle requires its registered native case and signed inputs")
    label, previous_label, state, counter = STATES[phase]
    selected = packages[label] if label else None
    version = selected["version"] if selected else None
    previous_version = packages[previous_label]["version"] if previous_label else None
    plugins = isolated_data_root(owner) / "plugins"
    module = plugins / "mfa"
    evidence = {"phase": phase, "sourceSha": packages["current"]["sourceSha"],
                "platform": packages["current"]["platform"], "passed": False}
    try:
        pointer_file = module / "active.json"
        ordinary(pointer_file)
        pointer = json.loads(pointer_file.read_text(encoding="utf-8"))
        evidence["pointer"] = pointer
        if (pointer["activeVersion"], pointer["previousVersion"]) != (version, previous_version):
            raise StepError(f"Unexpected active and rollback versions: {pointer!r}")
        if version and previous_version and not isinstance(pointer.get("rollbackUntil"), int):
            raise StepError("The active version has no protected rollback window")

        registry = invoke(ctx.session, "plugin_list").get("value") or []
        record = next((item for item in registry if item["manifest"]["slug"] == "mfa"), None)
        if not record or record["state"] != state or record.get("reason") or (
            selected and record["manifest"]["version"] != version
        ):
            raise StepError(f"The native registry did not publish the expected MFA state: {record!r}")
        evidence["state"] = record["state"]

        host = None
        if selected:
            directory = module / "versions" / version
            binary = "taomni-plugin-mfa.exe" if selected["platform"] == "windows-x86_64" else "taomni-plugin-mfa"
            host = directory / binary
            observed = {"packageSha256": digest(directory / ".taomni-trust/package.taomni-plugin"),
                        "hostSha256": digest(host), "frontendSha256": digest(directory / "frontend/index.js")}
            expected = {"packageSha256": selected["sha256"], "hostSha256": selected["hostSha256"],
                        "frontendSha256": selected["frontendSha256"]}
            if observed != expected:
                raise StepError("Installed package, host or frontend differs from the signed version")
            evidence.update(observed)
        else:
            assert_code_removed(module)
            if (module / "runtime").exists() or not record.get("dataRetained"):
                raise StepError("MFA uninstall must remove code and retain the account store")
            locator_path = plugins / ".retained-data/mfa.json"
            ordinary(locator_path)
            locator = json.loads(locator_path.read_text(encoding="utf-8"))
            if locator.get("slug") != "mfa" or {"path": "mfa.db", "kind": "sqlite"} not in locator.get("files", []):
                raise StepError("The retained locator no longer owns the MFA account database")
            evidence["retainedData"] = locator

        if phase == "failed-update":
            failed = packages["failed"]
            staged = module / "versions" / failed["version"] / ".taomni-trust/package.taomni-plugin"
            if digest(staged) != failed["sha256"]:
                raise StepError("The failed candidate never reached verified staging and real handshake")
            evidence["failedPackageSha256"] = failed["sha256"]
        if phase in {"updated-disabled", "updated-enabled"}:
            release = packages["current"]
            cached = plugins / ".downloads" / (release["sha256"] + ".taomni-plugin")
            transfers = list(owner.module_marketplace.requests).count("/" + release["archive"])
            if transfers != 1 or digest(cached) != release["sha256"]:
                raise StepError("Both updates must use the one verified marketplace download")
            evidence["marketplaceTransfers"] = transfers

        running = state == "enabled"
        evidence["writerLease"] = writer_lease(plugins, enabled=running, slug="mfa")
        previous = getattr(owner, "mfa_lifecycle_last", None)
        core, active_host = inspect_process(ctx, host if running else None, previous)
        evidence.update(core=core, host=active_host)
        account = account_record(module / "data/mfa.db", counter)
        baseline = getattr(owner, "mfa_lifecycle_account", None)
        if baseline and (account["id"], account["encryptedSecretSha256"]) != baseline:
            raise StepError("The MFA lifecycle replaced the original account or encrypted secret")
        owner.mfa_lifecycle_account = (account["id"], account["encryptedSecretSha256"])
        owner.mfa_lifecycle_last = {"core": core, "host": active_host}
        evidence.update(account=account, passed=True)
        return f"Signed MFA lifecycle {phase} verified"
    finally:
        with (Path(ctx.case_dir) / "signed-mfa-lifecycle.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(evidence) + "\n")
