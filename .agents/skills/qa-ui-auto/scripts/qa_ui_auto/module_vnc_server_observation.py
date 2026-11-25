"""Observe the actual local daemon launched by the verified VNC module."""

from contextlib import closing
import hashlib
import json
from pathlib import Path
import socket
import sqlite3
import tempfile
import time
import zipfile

from .fixtures.backup_policy import isolated_data_root
from .fixtures.module_signed_archive import VNC_SERVER_CASE
from .module_backup_observation import wait_manual_job
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .steps import StepError


def run(ctx, phase):
    owner = ctx.fixture_context
    signed = getattr(owner, "signed_vnc_daemon", None)
    if phase not in {"idle", "running", "backup", "stopped", "disabled"} or not signed or owner.case_id != VNC_SERVER_CASE:
        raise StepError("The VNC daemon observation requires its signed native case")

    plugins = isolated_data_root(owner) / "plugins"
    module = plugins / "vnc-server"
    receipt = signed["receipt"]
    pointer = module / "active.json"
    ordinary(pointer)
    if json.loads(pointer.read_text(encoding="utf-8")).get("activeVersion") != receipt["version"]:
        raise StepError("VNC Server selected a different package version")
    executable = module / "versions" / receipt["version"] / signed["host"]
    ordinary(executable)
    with executable.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != receipt["hostSha256"]:
        raise StepError("The installed VNC Server host differs from the signed archive")

    lease = writer_lease(plugins, slug="vnc-server", enabled=phase in {"running", "backup", "stopped"})
    listener = observe_listener(signed["port"], expect_rfb=phase in {"running", "backup"})
    settings = observe_settings(plugins.parent, signed, phase)
    evidence = {"phase": phase, "sourceSha": receipt["sourceSha"], "platform": receipt["platform"],
                "packageSha256": receipt["sha256"], "hostSha256": digest, "writerLease": lease,
                "localPort": signed["port"], "listener": listener, "settings": settings}
    if phase == "backup":
        evidence["backup"] = observe_backup(ctx, plugins.parent, settings["sha256"])
    index = len(list(ctx.case_dir.glob("signed-vnc-daemon-*.json"))) + 1
    (ctx.case_dir / f"signed-vnc-daemon-{index:02}-{phase}.json").write_text(
        json.dumps(evidence, indent=2) + "\n", encoding="utf-8",
    )
    return f"Verified VNC daemon {phase} on the isolated loopback port"


def observe_backup(ctx, profile, digest):
    job_id, job = wait_manual_job(ctx, profile, set())
    path = Path(job.get("localPath") or "")
    ordinary(path)
    if not path.is_relative_to(profile):
        raise StepError("VNC backup archive escaped the native QA profile")
    settings_path = "plugins/vnc-server/data/config.json"
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        datasets = [entry for entry in manifest["pluginDatasets"] if entry["slug"] == "vnc-server"]
        entries = {entry["path"]: entry for entry in manifest["files"]}
        if (len(datasets) != 1 or not datasets[0]["requiresVault"]
                or datasets[0]["files"] != [{"path": "config.json", "kind": "file"}]
                or "databases/vault.db" not in entries):
            raise StepError("Backup did not record the VNC dataset and Vault dependency")
        if hashlib.sha256(archive.read(settings_path)).hexdigest() != digest or entries[settings_path]["sha256"] != digest:
            raise StepError("VNC snapshot does not match the live VNC settings")
        if "databases/taomni.db" not in entries:
            raise StepError("The full manual backup omitted the core database")
        with tempfile.TemporaryDirectory(dir=ctx.case_dir) as work:
            database = Path(work).resolve() / "taomni.db"
            database.write_bytes(archive.read("databases/taomni.db"))
            with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
                rows = db.execute("SELECT server_type, config_json FROM server_configs ORDER BY server_type").fetchall()
        if rows != [("http", '{"port":18080}')]:
            raise StepError("The archive did not retain HTTP separately from the migrated VNC settings")
    return {"job": job_id, "dataset": datasets[0], "archiveSha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def observe_settings(profile, signed, phase):
    data = profile / "plugins/vnc-server/data/config.json"
    ordinary(data)
    settings_data = data.read_bytes()
    record = json.loads(settings_data)
    config = record["settings"]
    if config.get("port") != signed["port"] or config.get("bindAddress") != "127.0.0.1":
        raise StepError("VNC settings did not retain the migrated listener configuration")
    with closing(sqlite3.connect((profile / "taomni.db").as_uri() + "?mode=ro", uri=True)) as db:
        rows = db.execute("SELECT server_type, config_json FROM server_configs ORDER BY server_type").fetchall()
    if rows != [("http", '{"port":18080}'), ("vnc", signed["legacy_settings"])]:
        raise StepError("VNC Settings changed the monolithic rollback rows")
    journal_path = profile / "migration/journal.json"
    ordinary(journal_path)
    journal = json.loads(journal_path.read_text(encoding="utf-8"))
    entries = [entry for entry in journal["entries"] if entry["item"] == "vnc-server-configs"]
    if (len(entries) != 1 or entries[0]["state"] != "committed"
            or entries[0]["target"].replace("\\", "/") != "plugins/vnc-server/data/config.json"
            or entries[0]["source_fingerprint"] != record.get("legacySource")):
        raise StepError("VNC settings have no committed migration receipt")
    legacy_password = json.loads(signed["legacy_settings"])["password"]
    if "password" in config or legacy_password.encode() in settings_data:
        raise StepError("Migrated VNC settings contain the legacy password")
    reference = config.get("passwordRef")
    if phase == "idle":
        if reference or not config.get("credentialMigrationRequired"):
            raise StepError("The old password should await Vault setup")
    else:
        if not isinstance(reference, str) or not reference.startswith("vault:") or config.get("credentialMigrationRequired"):
            raise StepError("VNC settings did not adopt the Vault reference")
        with closing(sqlite3.connect((profile / "vault.db").as_uri() + "?mode=ro", uri=True)) as db:
            row = db.execute(
                "SELECT kind, ciphertext FROM vault_entries WHERE id = ?", (reference.removeprefix("vault:"),)
            ).fetchone()
        if not row or row[0] != "vnc-server-password" or row[1] == legacy_password.encode():
            raise StepError("The saved VNC password did not resolve to an encrypted Vault entry")
    return {"sha256": hashlib.sha256(settings_data).hexdigest(), "port": config["port"],
            "migrationSource": record["legacySource"], "passwordStored": bool(reference)}


def observe_listener(port, *, expect_rfb):
    deadline = time.monotonic() + 10
    while True:
        try:
            with socket.create_connection(("127.0.0.1", port), timeout=1) as peer:
                if expect_rfb:
                    with peer.makefile("rb") as stream:
                        data = stream.readline(32)
                        if data in {b"RFB 003.007\n", b"RFB 003.008\n"}:
                            peer.sendall(data)
                            count = stream.read(1)
                            methods = list(stream.read(count[0])) if count else []
                            if 2 not in methods or 1 in methods:
                                raise StepError("VNC daemon did not require password authentication")
                            return {"banner": data.decode("ascii").strip(), "securityTypes": methods}
        except ConnectionRefusedError:
            if not expect_rfb:
                return None
        except TimeoutError:
            pass
        if time.monotonic() >= deadline:
            raise StepError("VNC daemon did not reach the expected listening state")
        time.sleep(0.15)
