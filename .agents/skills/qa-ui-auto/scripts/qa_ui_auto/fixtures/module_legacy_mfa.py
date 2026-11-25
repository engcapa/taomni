"""Create the upgrade input through the installed 0.5.10 desktop on Linux."""
from contextlib import ExitStack, contextmanager
import hashlib
import json
import os
from pathlib import Path
import platform
import shutil
import socket
import subprocess

from native_application_restart import close_application_window, uses_x11_window_close
from native_application_shutdown import linux_storage_processes, wait_for_application_shutdown
from tauri_webdriver import NativeSession, TauriDriverProcess, native_binary, native_isolation_env

from ..deadline import Deadline
from ..legacy_install import install
from . import module_mfa_restore
from .backup_policy import isolated_data_root

CASE_ID = "TC-MODULES-039"
PASSWORD = "qa-installed-mfa-039"
ISSUER = "Installed MFA"
SECRET = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
APP_ID = "com.taomni.app"


def element(testid):
    return f'[data-testid="{testid}"]'


@contextmanager
def isolated_desktop(environment):
    saved = {name: os.environ.get(name) for name in environment}
    os.environ.update(environment)
    try:
        yield
    finally:
        for name, value in saved.items():
            if value is None:
                os.environ.pop(name, None)
            else:
                os.environ[name] = value


def legacy_driver(ctx, executable, desktop):
    with socket.socket() as first, socket.socket() as second:
        first.bind(("127.0.0.1", 0))
        second.bind(("127.0.0.1", 0))
        config = {
            "app": {"native_binary": str(executable)},
            "webdriver": {**(ctx.cfg.get("webdriver") or {}), "host": "127.0.0.1",
                          "port": first.getsockname()[1], "native_port": second.getsockname()[1]},
        }
    return TauriDriverProcess(config, desktop)


def desktop_action(steps, verb, args):
    from ..native_steps import run_native_step

    try:
        run_native_step(steps, verb, args)
    except Exception as error:
        selector = args.get("selector") if isinstance(args, dict) else args
        raise RuntimeError(f"Installed desktop {verb} {selector}: {error}") from error


def open_mfa(steps):
    desktop_action(steps, "wait_for", element("welcome-panel"))
    desktop_action(steps, "click", element("side-tab-tools"))
    desktop_action(steps, "wait_for", element("sidebar-tools-panel"))
    desktop_action(steps, "click", element("sidebar-tool-mfa"))


def unlock_vault(ctx, session, evidence):
    from ..native_steps import NativeStepContext

    steps = NativeStepContext(session, evidence, ctx.cfg)
    desktop_action(steps, "wait_for", element("vault-unlock-dialog"))
    desktop_action(steps, "fill", {"selector": element("vault-unlock-pw"), "value": PASSWORD})
    desktop_action(steps, "click", element("vault-unlock-confirm"))
    desktop_action(steps, "wait_for", {
        "selector": element("vault-unlock-dialog"), "state": "detached", "timeout_sec": 30,
    })
    return steps


def open_unlocked_mfa(ctx, session, evidence):
    steps = unlock_vault(ctx, session, evidence)
    open_mfa(steps)
    return steps


def create_account(session, ctx, evidence):
    from ..native_steps import NativeStepContext

    steps = NativeStepContext(session, evidence, ctx.cfg)

    def action(verb, args):
        desktop_action(steps, verb, args)

    def fill(testid, value):
        action("fill", {"selector": element(testid), "value": value})

    def expect_code(code):
        action("assert_text_equals", {"selector": element("mfa-account-code"), "equals": code})

    open_mfa(steps)
    action("wait_for", element("vault-setup-dialog"))
    fill("vault-setup-pw1", PASSWORD)
    fill("vault-setup-pw2", PASSWORD)
    action("click", element("vault-setup-confirm"))
    action("wait_for", element("mfa-empty"))
    action("click", element("mfa-add"))
    fill("mfa-add-issuer", ISSUER)
    fill("mfa-add-secret", SECRET)
    action("click", element("mfa-add-advanced"))
    action("select_option", {"selector": element("mfa-add-kind"), "value": "hotp"})
    action("click", element("mfa-add-submit"))
    expect_code("755 224")
    action("click", element("mfa-account-hotp-next"))
    expect_code("287 082")
    action("assert_no_runtime_errors", None)


def write_json(evidence, name, value):
    (evidence / name).write_text(json.dumps(value, indent=2) + "\n", encoding="utf-8")


def desktop_environment(desktop):
    environment = native_isolation_env(desktop)
    if any(Path(value).resolve() != Path(value) or not Path(value).is_relative_to(desktop)
           for value in environment.values()):
        raise RuntimeError("The legacy GUI requires isolated XDG paths")
    return environment, Path(environment["XDG_DATA_HOME"]) / APP_ID


@contextmanager
def installed_desktop(ctx, executable, desktop, evidence, label, *, environment=None, timeout=120):
    if platform.system() == "Windows":
        from installed_windows_webview import installed_webview
        with installed_webview(executable, environment["WEBVIEW2_USER_DATA_FOLDER"], evidence / label, timeout) as attached:
            yield attached
        return
    if environment is None:
        environment, _ = desktop_environment(desktop)
    driver = legacy_driver(ctx, executable, evidence / label)
    with isolated_desktop(environment), ExitStack() as cleanup:
        session = NativeSession(driver.url, executable)
        session.deadline = Deadline(timeout)
        session.pointer_observations_path = evidence / f"{label}-pointer-clicks.jsonl"
        cleanup.callback(driver.stop)
        cleanup.callback(session.close)
        driver.start()
        session.start()
        yield driver, session


def close_installed_desktop(driver, session, executable, *, open_tabs=1):
    system = platform.system()
    windows_owner = None
    if system == "Windows":
        windows_owner = driver.application_process
    processes = linux_storage_processes(driver, executable) if system == "Linux" else {}
    message = ("There is 1 open tab. Exit Taomni and close it?" if open_tabs == 1 else
               f"There are {open_tabs} open tabs. Exit Taomni and close them?")
    close = close_application_window(session, processes=processes, expect_exit_confirmation={
        "title": "Exit", "message": message,
        "confirm_label": "Exit",
    })
    session.session_id = None
    if windows_owner is not None:
        exit_code = windows_owner.wait(timeout=20)
        if exit_code != 0:
            raise RuntimeError(f"The installed Windows app exited with {exit_code}")
        shutdown = {"pid": windows_owner.pid, "exitCode": exit_code}
        close = {"transport": "Windows application close control", "pid": windows_owner.pid}
    else:
        expected = processes if system == "Linux" else {driver.proc.pid}
        if not close or close.get("pid") not in expected:
            raise RuntimeError("The closed window does not belong to the installed desktop")
        shutdown = wait_for_application_shutdown(driver, session, processes)
    return {"close": close, "shutdown": shutdown,
            "confirmation": session.application_restart_observation["exit_confirmation"]}


def seed_legacy_desktop(ctx, executable, desktop, evidence, profile, *,
                        catalog_source=None, environment=None, after_seed=None, open_tabs=1):
    with installed_desktop(ctx, executable, desktop, evidence, "legacy-window", environment=environment) as (driver, session):
        create_account(session, ctx, evidence)
        if after_seed is not None:
            after_seed(session)
        if catalog_source:
            session.execute("localStorage.setItem('taomni.module-catalog-source.v1', "
                            + json.dumps(catalog_source) + "); return true;")
        close = close_installed_desktop(driver, session, executable, open_tabs=open_tabs)
        write_json(evidence, "legacy-desktop.json", {
            "appId": APP_ID, "profile": str(profile), "executable": str(executable),
            "uiHotpCodes": ["755 224", "287 082"], "catalogSource": catalog_source, **close,
        })


def run_legacy_desktop(ctx, executable, work, evidence, *, catalog_source=None, after_seed=None, open_tabs=1):
    desktop = work / "desktop"
    _, profile = desktop_environment(desktop)
    if profile.exists() or profile.is_symlink():
        raise RuntimeError("The installed desktop requires a fresh isolated profile")
    seed_legacy_desktop(ctx, executable, desktop, evidence, profile,
                        catalog_source=catalog_source, after_seed=after_seed, open_tabs=open_tabs)
    return profile


def transfer_databases(source, destination):
    if source.resolve() != source or not source.is_dir():
        raise RuntimeError("The installed desktop profile is missing or linked")
    paths = []
    for name in ("mfa.db", "vault.db"):
        main = source / name
        wal = source / (name + "-wal")
        paths.append(main)
        if wal.exists() or wal.is_symlink():
            paths.append(wal)
    if any(path.is_symlink() or not path.is_file() for path in paths):
        raise RuntimeError("The installed desktop did not create ordinary MFA and Vault databases")
    if any((destination / path.name).exists() or (destination / path.name).is_symlink() for path in paths):
        raise RuntimeError("The candidate profile already contains MFA or Vault data")
    checksums = {}
    for path in paths:
        with path.open("rb") as original, (destination / path.name).open("xb") as copied:
            shutil.copyfileobj(original, copied)
        checksums[path.name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return checksums


def commit_mfa_upgrade(executable, profile, archive, signature, evidence):
    maintenance = subprocess.run(
        [str(executable), "--migrate-mfa", str(profile), str(archive), str(signature)],
        input=PASSWORD.encode(), capture_output=True, timeout=90,
    )
    (evidence / "candidate-maintenance.stdout.txt").write_bytes(maintenance.stdout)
    (evidence / "candidate-maintenance.stderr.txt").write_bytes(maintenance.stderr)
    if maintenance.returncode != 0 or maintenance.stdout.strip() != b"MFA data migrated":
        raise RuntimeError("The candidate's signed MFA maintenance did not commit the old database")
    journal = json.loads((profile / "migration/journal.json").read_text(encoding="utf-8"))
    records = [row for row in journal["entries"] if row["item"] == "mfa"]
    enabled = json.loads((profile / "plugins/state.json").read_text(encoding="utf-8"))
    if (len(records) != 1 or records[0]["state"] != "committed"
            or records[0]["target"] != "plugins/mfa/data/mfa.db" or enabled.get("mfa") is not True):
        raise RuntimeError("The candidate did not commit and enable the signed MFA module")
    write_json(evidence, "candidate-activation.json", {"record": records[0], "enabled": True})


def setup(ctx):
    if (ctx.case_id not in {CASE_ID, module_mfa_restore.CASE_ID}
            or platform.system() != "Linux" or not uses_x11_window_close()
            or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("GITHUB_REPOSITORY") != "engcapa/taomni"):
        raise RuntimeError("The installed MFA desktop fixture requires its Linux X11 GitHub case")
    profile = isolated_data_root(ctx)
    if any(profile.iterdir()):
        raise RuntimeError("MFA upgrade requires an empty isolated candidate profile")
    work = Path(ctx.report_root).resolve() / "_workdirs" / "legacy-mfa"
    if work.resolve() != work:
        raise RuntimeError("The installed MFA desktop requires an unlinked work directory")
    executable, evidence = install(ctx.case_dir, work)
    source = run_legacy_desktop(ctx, executable, work, evidence)
    if ctx.case_id == module_mfa_restore.CASE_ID:
        checksum = module_mfa_restore.stage(profile, source, evidence)
        ctx.values.update(
            restored_mfa_path=(profile / module_mfa_restore.MODULE_DB).as_posix(),
            restored_mfa_sha256=checksum,
        )
        return
    write_json(evidence, "candidate-input.json", {
        "profile": str(profile), "copiedDatabases": transfer_databases(source, profile),
    })
    commit_mfa_upgrade(native_binary(ctx.cfg).resolve(), profile, ctx.values["mfa_signed_archive"],
                       ctx.values["mfa_signed_signature"], evidence)
