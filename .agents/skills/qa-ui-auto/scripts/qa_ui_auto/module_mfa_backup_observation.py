"""Observe signed MFA automatic restore across enabled, disabled and retained states."""
from __future__ import annotations

from contextlib import closing, suppress
import hashlib
import json
from pathlib import Path
import sqlite3
import zipfile

from native_qa_bridge import identity

from .fixtures.backup_policy import isolated_data_root
from .fixtures.module_mfa_restore import SIGNED_BACKUP_STATES
from .module_backup_observation import wait_manual_job
from .module_mfa_lifecycle_observation import account_record, digest
from .module_profile_observation import writer_lease
from .module_restore_observation import generation, require_clean
from .module_retained_observation import assert_code_removed, ordinary
from .module_signed_observation import invoke
from .steps import StepError

ISSUER = "Signed MFA Restore"
PHASES = ("initial", "archive", "ready", "restored", "reopened")
EXPECTED_LOCATOR = {
    "formatVersion": 1,
    "slug": "mfa",
    "dataSchemaVersion": 1,
    "files": [{"path": "mfa.db", "kind": "sqlite"}],
}
HOST_NAMES = {"taomni-plugin-mfa", "taomni-plugin-mfa.exe"}


def check_legacy_mfa_absent(profile: Path) -> None:
    legacy = profile / "mfa.db"
    if legacy.exists() or legacy.is_symlink():
        raise StepError("Legacy core mfa.db unexpectedly exists in signed MFA profile")


def check_installed_mfa(module: Path, receipt: dict) -> Path:
    pointer_path = module / "active.json"
    ordinary(pointer_path)
    pointer = json.loads(pointer_path.read_text(encoding="utf-8"))
    version = receipt["version"]
    if pointer.get("activeVersion") != version:
        raise StepError(f"Expected active MFA version {version!r}, got {pointer!r}")
    version_root = module / "versions" / version
    binary = "taomni-plugin-mfa.exe" if receipt["platform"] == "windows-x86_64" else "taomni-plugin-mfa"
    host = version_root / binary
    if digest(version_root / ".taomni-trust/package.taomni-plugin") != receipt["sha256"]:
        raise StepError("Installed MFA package differs from the signed input archive")
    if digest(host) != receipt["hostSha256"]:
        raise StepError("Installed MFA host binary differs from the signed input archive")
    if digest(version_root / "frontend/index.js") != receipt["frontendSha256"]:
        raise StepError("Installed MFA frontend differs from the signed input archive")
    return host


def check_uninstalled_retained(
    plugins: Path,
    module: Path,
    record: dict,
    expected_db_sha256: str | None = None,
) -> dict:
    if record.get("state") != "uninstalled" or record.get("dataRetained") is not True:
        raise StepError(f"Expected uninstalled retained MFA state, got {record!r}")
    assert_code_removed(module)
    if (module / "runtime").exists() or (module / "runtime").is_symlink():
        raise StepError("Uninstall left MFA runtime directory behind")
    locator_path = plugins / ".retained-data/mfa.json"
    ordinary(locator_path)
    locator = json.loads(locator_path.read_text(encoding="utf-8"))
    if locator != EXPECTED_LOCATOR:
        raise StepError(f"Retained MFA locator differs from expected schema: {locator!r}")
    database = module / "data/mfa.db"
    actual_sha = digest(database)
    if expected_db_sha256 and actual_sha != expected_db_sha256:
        raise StepError("Restored retained MFA database bytes differ from the verified archive")
    return {"locator": locator, "mfaDbSha256": actual_sha, "bytes": database.stat().st_size}


def check_mfa_v2_archive(path: Path, work: Path, profile_generation: str, expected_account: dict) -> dict:
    ordinary(path)
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        datasets = manifest.get("pluginDatasets", [])
        if manifest.get("formatVersion") != 2 or len(datasets) != 1:
            raise StepError("Signed MFA backup did not produce one v2 plugin dataset")
        dataset = datasets[0]
        expected_dataset = {
            "slug": "mfa",
            "dataSchemaVersion": 1,
            "requiresVault": True,
            "profileGeneration": profile_generation,
            "files": [{"path": "mfa.db", "kind": "sqlite"}],
        }
        if set(dataset) != set(expected_dataset) | {"job"} or any(
            dataset.get(k) != v for k, v in expected_dataset.items()
        ):
            raise StepError(f"Signed MFA backup dataset mismatch: {dataset!r}")
        entries = {entry["path"]: entry for entry in manifest["files"]}
        if len(entries) != len(manifest["files"]) or set(archive.namelist()) != set(entries) | {"manifest.json"}:
            raise StepError("Backup archive inventory disagrees with manifest files")
        if {n for n in entries if n.startswith("plugins/")} != {"plugins/mfa/data/mfa.db"}:
            raise StepError(f"Unexpected plugin payload entries in backup: {sorted(entries)}")
        if "databases/vault.db" not in entries or "databases/mfa.db" in entries:
            raise StepError("Signed MFA backup must pair Vault without legacy databases/mfa.db")
        for name, meta in entries.items():
            hasher, size = hashlib.sha256(), 0
            with archive.open(name) as stream:
                for chunk in iter(lambda: stream.read(65536), b""):
                    hasher.update(chunk)
                    size += len(chunk)
            if hasher.hexdigest() != meta["sha256"] or size != meta["sizeBytes"]:
                raise StepError(f"Archived file {name} digest or size differs from manifest")
        vault_copy = work / f"{path.stem}-vault.sqlite"
        mfa_copy = work / f"{path.stem}-mfa.sqlite"
        vault_copy.write_bytes(archive.read("databases/vault.db"))
        mfa_copy.write_bytes(archive.read("plugins/mfa/data/mfa.db"))
    for db_path in (vault_copy, mfa_copy):
        with closing(sqlite3.connect(db_path.as_uri() + "?mode=ro", uri=True)) as conn:
            if conn.execute("PRAGMA quick_check").fetchone() != ("ok",):
                raise StepError(f"Archived SQLite snapshot failed integrity check: {db_path.name}")
    archived_account = account_record(mfa_copy, 0, issuer=ISSUER)
    if archived_account != expected_account:
        raise StepError("Archived MFA SQLite snapshot lost the original encrypted HOTP account")
    return {
        "sha256": digest(path),
        "dataset": dataset,
        "vaultSha256": entries["databases/vault.db"]["sha256"],
        "mfaDbSha256": entries["plugins/mfa/data/mfa.db"]["sha256"],
        "mfaDbBytes": entries["plugins/mfa/data/mfa.db"]["sizeBytes"],
    }


def _check_exited(proc: dict | None, label: str) -> None:
    if proc is None:
        return
    live = identity(proc["pid"])
    if live is not None and live == proc:
        raise StepError(f"Previous {label} process remained alive after stop or relaunch")


def observe_mfa_processes(
    ctx,
    expected_host: Path | None,
    *,
    expected_core: dict | None,
    must_exit_core: dict | None = None,
    must_exit_host: dict | None = None,
    explicit_core_pid: int | None = None,
    allow_lazy: bool = False,
) -> tuple[dict, dict | None]:
    import psutil

    app_exe = ctx.session.application.resolve()
    _check_exited(must_exit_core, "desktop")
    _check_exited(must_exit_host, "MFA host")

    core = expected_core
    if core is not None:
        live = identity(core["pid"])
        if live != core or Path(live["executable"]) != app_exe:
            raise StepError("The expected desktop process exited or changed identity")
    elif explicit_core_pid is not None:
        live = identity(explicit_core_pid)
        if live is None or Path(live["executable"]) != app_exe:
            raise StepError("Relaunched QA desktop process identity is missing or wrong executable")
        core = live

    if core is not None:
        children = psutil.Process(core["pid"]).children(recursive=True)
        matches = []
        for child in children:
            with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
                exe = Path(child.exe()).resolve()
                if expected_host and exe == expected_host:
                    matches.append(child)
                elif exe.name in HOST_NAMES:
                    raise StepError("Unexpected or wrong-version MFA host survived under desktop")
        expected_count = int(expected_host is not None)
        if allow_lazy and expected_host is not None:
            if len(matches) not in (0, 1):
                raise StepError(f"Expected 0 or 1 MFA host child, found {len(matches)}")
        elif len(matches) != expected_count:
            raise StepError(f"Expected {expected_count} MFA host child, found {len(matches)}")
        host = identity(matches[0].pid) if matches else None
        if matches and host is None:
            raise StepError("Matched MFA host exited during inspection")
        return core, host

    if expected_host is None:
        raise StepError("Initial MFA process observation requires an active signed host")
    matches = []
    for proc in psutil.process_iter(["pid"]):
        with suppress(psutil.NoSuchProcess, psutil.AccessDenied):
            if Path(proc.exe()).resolve() == expected_host:
                parent = identity(proc.ppid())
                if parent is not None and Path(parent["executable"]) == app_exe:
                    matches.append((proc, parent))
    if len(matches) != 1:
        raise StepError(f"Expected one initial signed MFA host under QA desktop, found {len(matches)}")
    proc, core = matches[0]
    host = identity(proc.pid)
    if host is None:
        raise StepError("Initial MFA host exited during inspection")
    return core, host


def run(ctx, phase):
    owner = ctx.fixture_context
    receipt = getattr(owner, "signed_mfa_backup", None)
    expected_state = SIGNED_BACKUP_STATES.get(getattr(owner, "case_id", None))
    if not receipt or not expected_state or phase not in PHASES:
        raise StepError("assert_signed_mfa_backup requires a registered signed MFA backup case and valid phase")
    work = Path(ctx.case_dir).resolve(strict=True)
    plugins = isolated_data_root(owner) / "plugins"
    profile = plugins.parent
    module = plugins / "mfa"
    mfa_db = module / "data/mfa.db"
    state_path = work / "signed-mfa-backup-state.json"
    state = json.loads(state_path.read_text(encoding="utf-8")) if state_path.exists() else None
    current_gen = generation(profile)
    evidence = {
        "phase": phase,
        "expectedState": expected_state,
        "sourceSha": receipt["sourceSha"],
        "platform": receipt["platform"],
        "generation": current_gen,
        "passed": False,
    }
    try:
        check_legacy_mfa_absent(profile)
        registry = invoke(ctx.session, "plugin_list").get("value") or []
        record = next((item for item in registry if item.get("manifest", {}).get("slug") == "mfa"), None)
        if not record or record.get("reason"):
            raise StepError(f"Signed MFA registry record missing or unhealthy: {record!r}")
        evidence["registryState"] = record.get("state")

        if phase == "initial":
            if state is not None or record.get("state") != "enabled":
                raise StepError("Initial MFA backup check requires a fresh enabled signed module")
            require_clean(profile)
            host_path = check_installed_mfa(module, receipt)
            evidence["writerLease"] = writer_lease(plugins, enabled=True, slug="mfa")
            core, host = observe_mfa_processes(ctx, host_path, expected_core=None)
            account = account_record(mfa_db, 0, issuer=ISSUER)
            state = {
                "step": "initial",
                "expectedState": expected_state,
                "generation": current_gen,
                "account": account,
                "core": core,
                "host": host,
            }
            evidence.update(core=core, host=host, account=account)
        elif phase == "archive":
            if not state or state.get("step") != "initial" or current_gen != state["generation"]:
                raise StepError("Archive check must follow initial setup on the same profile generation")
            if record.get("state") != expected_state:
                raise StepError(f"Expected MFA state {expected_state!r}, got {record.get('state')!r}")
            require_clean(profile)
            running = expected_state == "enabled"
            if expected_state == "uninstalled":
                evidence["retainedData"] = check_uninstalled_retained(plugins, module, record)
                host_path = None
            else:
                host_path = check_installed_mfa(module, receipt) if running else None
                if not running:
                    check_installed_mfa(module, receipt)
            evidence["writerLease"] = writer_lease(plugins, enabled=running, slug="mfa")
            core, host = observe_mfa_processes(
                ctx,
                host_path,
                expected_core=state["core"],
                must_exit_host=None if running else state["host"],
            )
            job_id, job = wait_manual_job(ctx, profile, set())
            archive_path = Path(job.get("localPath") or "")
            ordinary(archive_path)
            if not archive_path.is_relative_to(profile):
                raise StepError("Manual backup archive escaped the isolated QA profile")
            archive_info = check_mfa_v2_archive(archive_path, work, current_gen, state["account"])
            owner.values["signed_mfa_restore_job_id"] = job_id
            state.update(
                step="archived",
                jobId=job_id,
                archive=str(archive_path),
                archiveSha256=archive_info["sha256"],
                archiveMfaSha256=archive_info["mfaDbSha256"],
                archiveVaultSha256=archive_info["vaultSha256"],
                host=host,
            )
            evidence.update(core=core, host=host, archive=archive_info)
        elif phase == "ready":
            if not state or state.get("step") != "archived" or current_gen != state["generation"]:
                raise StepError("Ready check requires a verified backup archive and unchanged generation")
            if record.get("state") != expected_state:
                raise StepError(f"Expected MFA state {expected_state!r} before restore, got {record.get('state')!r}")
            require_clean(profile)
            if digest(Path(state["archive"])) != state["archiveSha256"]:
                raise StepError("Original verified MFA backup archive changed before restore")
            running = expected_state == "enabled"
            if expected_state == "uninstalled":
                evidence["retainedData"] = check_uninstalled_retained(plugins, module, record)
                host_path = None
            else:
                installed = check_installed_mfa(module, receipt)
                host_path = installed if running else None
            mutated = account_record(mfa_db, 1, issuer=ISSUER)
            if mutated["id"] != state["account"]["id"]:
                raise StepError("Mutated HOTP account lost the original account ID")
            evidence["writerLease"] = writer_lease(plugins, enabled=running, slug="mfa")
            core, host = observe_mfa_processes(
                ctx,
                host_path,
                expected_core=state["core"],
                must_exit_host=None if running else state.get("host"),
            )
            state["activePointerSha256"] = digest(module / "active.json")
            state.update(step="ready", host=host)
            evidence.update(core=core, host=host, mutatedAccount=mutated)
        elif phase == "restored":
            if not state or state.get("step") != "ready":
                raise StepError("Restored check must follow ready state and automatic relaunch")
            relaunch = getattr(ctx.session, "restore_relaunch_observation", {})
            if (
                relaunch.get("passed") is not True
                or relaunch.get("manual_launch") is not False
                or relaunch.get("original_exit_code") != 0
                or (relaunch.get("before") or {}).get("pid") != state["core"]["pid"]
            ):
                raise StepError("Restored MFA check requires an observed UI-triggered automatic relaunch")
            after_pid = (relaunch.get("after") or {}).get("pid")
            if not isinstance(after_pid, int) or after_pid == state["core"]["pid"]:
                raise StepError("Relaunch did not produce a distinct desktop PID")
            require_clean(profile)
            if current_gen == state["generation"]:
                raise StepError("Applied MFA restore did not advance profile generation")
            if digest(Path(state["archive"])) != state["archiveSha256"]:
                raise StepError("Backup archive changed during automatic restore")
            if digest(module / "active.json") != state["activePointerSha256"]:
                raise StepError("Data restore unexpectedly altered MFA active.json")
            if record.get("state") != expected_state:
                raise StepError(f"Restored MFA state mismatch: expected {expected_state!r}, got {record.get('state')!r}")
            running = expected_state == "enabled"
            if expected_state == "uninstalled":
                evidence["retainedData"] = check_uninstalled_retained(
                    plugins, module, record, expected_db_sha256=state["archiveMfaSha256"],
                )
                host_path = None
            else:
                installed = check_installed_mfa(module, receipt)
                host_path = installed if running else None
            evidence["writerLease"] = None
            new_core, new_host = observe_mfa_processes(
                ctx,
                host_path,
                expected_core=None,
                must_exit_core=state["core"],
                must_exit_host=state.get("host"),
                explicit_core_pid=after_pid,
                allow_lazy=running,
            )
            evidence["writerLease"] = writer_lease(plugins, enabled=new_host is not None, slug="mfa")
            restored_account = account_record(mfa_db, 0, issuer=ISSUER)
            if restored_account != state["account"]:
                raise StepError("Restored MFA SQLite differs from the original encrypted account")
            state.update(
                step="restored",
                restoredGeneration=current_gen,
                relaunchedCore=new_core,
                host=new_host,
            )
            evidence.update(core=new_core, host=new_host, account=restored_account)
        elif phase == "reopened":
            if not state or state.get("step") != "restored":
                raise StepError("Reopened check must follow restored verification")
            if current_gen != state["restoredGeneration"] or record.get("state") != "enabled":
                raise StepError("Reopened MFA must stay on restored generation with MFA enabled")
            require_clean(profile)
            host_path = check_installed_mfa(module, receipt)
            evidence["writerLease"] = writer_lease(plugins, enabled=True, slug="mfa")
            core, host = observe_mfa_processes(ctx, host_path, expected_core=state["relaunchedCore"])
            advanced = account_record(mfa_db, 1, issuer=ISSUER)
            if (advanced["id"], advanced["encryptedSecretSha256"]) != (
                state["account"]["id"],
                state["account"]["encryptedSecretSha256"],
            ):
                raise StepError("Reopened MFA replaced the original restored account key or row")
            state.update(step="reopened", host=host)
            evidence.update(core=core, host=host, account=advanced)

        state_path.write_text(json.dumps(state, indent=2) + "\n", encoding="utf-8")
        evidence["passed"] = True
        return f"Signed MFA backup {phase} ({expected_state}) verified"
    finally:
        with (work / "signed-mfa-backup.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(evidence) + "\n")
