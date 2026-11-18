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
from ..native_steps import NativeStepContext, run_native_step
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


def create_account(session, ctx, evidence):
    steps = NativeStepContext(session, evidence, ctx.cfg)

    def action(verb, args):
        try:
            run_native_step(steps, verb, args)
        except Exception as error:
            selector = args.get("selector") if isinstance(args, dict) else args
            raise RuntimeError(f"Installed desktop {verb} {selector}: {error}") from error

    def fill(testid, value):
        action("fill", {"selector": element(testid), "value": value})

    def expect_code(code):
        action("assert_text_equals", {"selector": element("mfa-account-code"), "equals": code})

    action("wait_for", element("welcome-panel"))
    action("click", element("side-tab-tools"))
    action("wait_for", element("sidebar-tools-panel"))
    action("click", element("sidebar-tool-mfa"))
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


def run_legacy_desktop(ctx, executable, work, evidence):
    desktop = work / "desktop"
    environment = native_isolation_env(desktop)
    if any(Path(value).resolve() != Path(value) or not Path(value).is_relative_to(desktop)
           for value in environment.values()):
        raise RuntimeError("The legacy GUI requires isolated XDG paths")
    profile = Path(environment["XDG_DATA_HOME"]) / APP_ID
    if profile.exists() or profile.is_symlink():
        raise RuntimeError("The installed desktop requires a fresh isolated profile")
    driver = legacy_driver(ctx, executable, desktop)
    with isolated_desktop(environment), ExitStack() as cleanup:
        session = NativeSession(driver.url, executable)
        session.deadline = Deadline(120)
        session.pointer_observations_path = evidence / "legacy-pointer-clicks.jsonl"
        cleanup.callback(driver.stop)
        cleanup.callback(session.close)
        driver.start()
        session.start()
        create_account(session, ctx, evidence)
        processes = linux_storage_processes(driver, executable)
        close = close_application_window(session, processes=processes, expect_exit_confirmation={
            "title": "Exit", "message": "There is 1 open tab. Exit Taomni and close it?",
            "confirm_label": "Exit",
        })
        if close is None or close.get("pid") not in processes:
            raise RuntimeError("The closed window does not belong to the installed desktop")
        session.session_id = None
        shutdown = wait_for_application_shutdown(driver, session, processes)
        write_json(evidence, "legacy-desktop.json", {
            "appId": APP_ID, "profile": str(profile), "executable": str(executable),
            "uiHotpCodes": ["755 224", "287 082"], "close": close, "shutdown": shutdown,
            "confirmation": session.application_restart_observation["exit_confirmation"],
        })
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


def setup(ctx):
    if (ctx.case_id != CASE_ID or platform.system() != "Linux" or not uses_x11_window_close()
            or os.environ.get("GITHUB_ACTIONS") != "true"
            or os.environ.get("GITHUB_REPOSITORY") != "engcapa/taomni"):
        raise RuntimeError("The installed MFA desktop fixture requires its Linux X11 GitHub case")
    profile = isolated_data_root(ctx)
    if any(profile.iterdir()):
        raise RuntimeError("MFA upgrade requires an empty isolated candidate profile")
    work = Path(ctx.report_root).resolve() / "_workdirs" / "legacy-mfa"
    if work.resolve() != work:
        raise RuntimeError("The installed MFA desktop requires an unlinked work directory")
    archive = ctx.values["mfa_signed_archive"]
    signature = ctx.values["mfa_signed_signature"]
    executable, evidence = install(ctx.case_dir, work)
    try:
        source = run_legacy_desktop(ctx, executable, work, evidence)
    finally:
        for path in (work / "desktop").glob("tauri-driver.*.log"):
            shutil.copyfile(path, evidence / path.name)
    write_json(evidence, "candidate-input.json", {
        "profile": str(profile), "copiedDatabases": transfer_databases(source, profile),
    })
    maintenance = subprocess.run(
        [str(native_binary(ctx.cfg).resolve()), "--migrate-mfa", str(profile), archive, signature],
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
