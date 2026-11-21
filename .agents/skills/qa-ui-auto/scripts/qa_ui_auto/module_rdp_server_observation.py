"""Check the real installed RDP Server and record the lifecycle evidence."""

from contextlib import closing
import hashlib
import json
from pathlib import Path
import platform
import socket
import sqlite3
import subprocess
import tempfile
import zipfile

from .fixtures.backup_policy import isolated_data_root
from .fixtures.module_signed_archive import RDP_SERVER_CASE
from .module_backup_observation import wait_manual_job
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .steps import StepError


def run(ctx, phase):
    fixture = ctx.fixture_context
    signed = getattr(fixture, "signed_rdp_server", None)
    if phase not in {"idle", "running", "backup", "disabled"} or not signed or fixture.case_id != RDP_SERVER_CASE:
        raise StepError("The RDP Server observation requires its signed native case")
    plugins = isolated_data_root(fixture) / "plugins"
    module = plugins / "rdp-server"
    receipt = signed["receipt"]
    pointer = module / "active.json"
    ordinary(pointer)
    if json.loads(pointer.read_text(encoding="utf-8")).get("activeVersion") != receipt["version"]:
        raise StepError("RDP Server selected a different signed package version")
    executable = module / "versions" / receipt["version"] / signed["host"]
    ordinary(executable)
    with executable.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != receipt["hostSha256"]:
        raise StepError("RDP Server installed bytes differ from the signed archive")
    port = signed["port"]
    running = phase in {"running", "backup"}
    with socket.socket() as client:
        client.settimeout(1)
        listening = client.connect_ex(("127.0.0.1", port)) == 0
    if listening != running:
        raise StepError(f"Unexpected loopback RDP listener state for {phase}")
    cert = module / "data/cert.pem"
    key = module / "data/key.pem"
    lease = writer_lease(plugins, enabled=running, slug="rdp-server")
    settings = observe_settings(plugins.parent, signed, phase)
    evidence = {
        "phase": phase, "sourceSha": receipt["sourceSha"], "platform": receipt["platform"],
        "hostSha256": digest, "packageSha256": receipt["sha256"], "writerLease": lease,
        "listener": listening, "port": port, "settingsSha256": settings,
    }
    if phase == "idle" and platform.system() == "Darwin":
        evidence["macosSigning"] = observe_macos_signing(ctx, executable)
    if phase != "idle":
        for path in (cert, key):
            ordinary(path)
        evidence["certificateSha256"] = hashlib.sha256(cert.read_bytes()).hexdigest()
    if phase == "backup":
        evidence["backup"] = observe_backup(ctx, plugins.parent, settings)
    (ctx.case_dir / f"signed-rdp-server-{phase}.json").write_text(
        json.dumps(evidence, indent=2) + "\n", encoding="utf-8",
    )
    return f"Verified signed RDP Server {phase}"


def observe_macos_signing(ctx, executable):
    def capture(*argv):
        result = subprocess.run([*argv, str(executable)], capture_output=True, text=True, timeout=15)
        return {"code": result.returncode, "stdout": result.stdout, "stderr": result.stderr}

    details = {
        "verify": capture("/usr/bin/codesign", "--verify", "--strict"),
        "identity": capture("/usr/bin/codesign", "-d", "--verbose=4", "-r-"),
        "gatekeeper": capture("/usr/sbin/spctl", "--assess", "--type", "execute", "--verbose=4"),
    }
    (ctx.case_dir / "signed-rdp-server-macos-signing.json").write_text(
        json.dumps(details, indent=2) + "\n", encoding="utf-8",
    )
    if (details["verify"]["code"] or details["identity"]["code"]
            or "(runtime)" not in details["identity"]["stderr"]):
        raise StepError("The installed macOS RDP Server lacks a verified hardened-runtime signature")
    return details


def observe_settings(profile, signed, phase):
    path = profile / "plugins/rdp-server/data/config.json"
    ordinary(path)
    raw = path.read_bytes()
    record = json.loads(raw)
    settings = record["settings"]
    legacy = json.loads(signed["legacy_settings"])
    for field in ("port", "bindAddress", "username", "clipboardServerToClient", "microphone"):
        if settings.get(field) != legacy[field]:
            raise StepError(f"RDP Server did not retain the legacy {field} setting")
    if phase == "idle" and settings.get("viewOnly") is not True:
        raise StepError("The legacy view-only preference was not imported")
    if phase != "idle" and (settings.get("viewOnly") is not False or settings.get("requireControlApproval") is not False):
        raise StepError("The RDP Server did not save the requested interactive settings")
    with closing(sqlite3.connect((profile / "taomni.db").as_uri() + "?mode=ro", uri=True)) as database:
        rows = database.execute("SELECT server_type, config_json FROM server_configs ORDER BY server_type").fetchall()
    if rows != [("http", '{"port":18080}'), ("rdp", signed["legacy_settings"])]:
        raise StepError("Managed RDP settings changed the legacy rollback rows")
    journal_path = profile / "migration/journal.json"
    ordinary(journal_path)
    entries = [entry for entry in json.loads(journal_path.read_bytes())["entries"]
               if entry["item"] == "rdp-server-configs"]
    if (len(entries) != 1 or entries[0]["state"] != "committed"
            or entries[0]["target"].replace("\\", "/") != "plugins/rdp-server/data/config.json"
            or entries[0]["source_fingerprint"] != record.get("legacySource")):
        raise StepError("RDP Server settings lack a committed migration receipt")
    if "password" in settings or legacy["password"].encode() in raw:
        raise StepError("RDP Server persisted a plaintext password in module data")
    if phase == "idle":
        if settings.get("credentialMigrationRequired") is not True or "passwordRef" in settings:
            raise StepError("The migrated row did not preserve its pending credential")
    elif settings.get("credentialMigrationRequired") or not str(settings.get("passwordRef")).startswith("vault:"):
        raise StepError("RDP Server failed to promote the legacy password to Vault")
    return hashlib.sha256(raw).hexdigest()


def observe_backup(ctx, profile, digest):
    job_id, job = wait_manual_job(ctx, profile, set())
    path = Path(job.get("localPath") or "")
    ordinary(path)
    if not path.is_relative_to(profile):
        raise StepError("RDP Server backup archive escaped the native QA profile")
    settings_path = "plugins/rdp-server/data/config.json"
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        datasets = [item for item in manifest["pluginDatasets"] if item["slug"] == "rdp-server"]
        files = {item["path"]: item for item in manifest["files"]}
        if (len(datasets) != 1 or not datasets[0]["requiresVault"]
                or {file["path"] for file in datasets[0]["files"]} != {"cert.pem", "key.pem", "config.json"}
                or "databases/vault.db" not in files):
            raise StepError("RDP Server backup lacks the settings, TLS identity or Vault")
        if hashlib.sha256(archive.read(settings_path)).hexdigest() != digest or files[settings_path]["sha256"] != digest:
            raise StepError("RDP Server snapshot differs from its live settings")
        with tempfile.TemporaryDirectory(dir=ctx.case_dir) as work:
            database = Path(work).resolve() / "taomni.db"
            database.write_bytes(archive.read("databases/taomni.db"))
            with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as db:
                rows = db.execute("SELECT server_type, config_json FROM server_configs ORDER BY server_type").fetchall()
        if rows != [("http", '{"port":18080}')]:
            raise StepError("The backup did not keep the separate HTTP row and omit the RDP rollback row")
    return {"job": job_id, "dataset": datasets[0], "archiveSha256": hashlib.sha256(path.read_bytes()).hexdigest()}
