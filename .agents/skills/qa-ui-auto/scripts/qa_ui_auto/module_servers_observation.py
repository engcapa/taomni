"""Verify the independently packaged Local servers host and teardown."""

from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import zipfile

from .fixtures.backup_policy import isolated_data_root
from .fixtures.module_signed_archive import SERVERS_CASE
from .module_backup_observation import wait_manual_job
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .servers_http_observation import run as observe_http
from .steps import StepError


def run(ctx, phase):
    fixture = ctx.fixture_context
    signed = getattr(fixture, "signed_servers", None)
    if fixture.case_id != SERVERS_CASE or not signed or phase not in {"running", "backup", "disabled"}:
        raise StepError("The Local servers observation requires its signed native case")
    plugins = isolated_data_root(fixture) / "plugins"
    module = plugins / "servers"
    receipt = signed["receipt"]
    pointer = module / "active.json"
    ordinary(pointer)
    if json.loads(pointer.read_text(encoding="utf-8")).get("activeVersion") != receipt["version"]:
        raise StepError("Local servers selected a different signed package version")
    executable = module / "versions" / receipt["version"] / signed["host"]
    ordinary(executable)
    with executable.open("rb") as binary:
        digest = hashlib.file_digest(binary, "sha256").hexdigest()
    if digest != receipt["hostSha256"]:
        raise StepError("Installed Local servers host differs from the signed archive")
    running = phase in {"running", "backup"}
    observation = observe_http(ctx, "serving" if running else "stopped")
    lease = writer_lease(plugins, slug="servers", enabled=running)
    data = module / "data" / "config.json"
    ordinary(data)
    raw = data.read_bytes()
    record = json.loads(raw)
    settings = record["settings"]
    if set(settings) != {"http", "ssh"} or settings["http"]["port"] != 28489 or settings["ssh"]["port"] != 28491:
        raise StepError("Local servers did not migrate the two selected legacy rows")
    if "password" in settings["ssh"] or fixture.values["local_servers_ssh_password"].encode() in raw:
        raise StepError("Module data includes the previous plaintext SSH password")
    reference = settings["ssh"].get("passwordRef")
    if not reference or not reference.startswith("vault:") or settings["ssh"].get("credentialMigrationRequired"):
        raise StepError("SSH was not assigned a Vault credential")
    profile = plugins.parent
    with closing(sqlite3.connect((profile / "vault.db").as_uri() + "?mode=ro", uri=True)) as db:
        row = db.execute("SELECT kind FROM vault_entries WHERE id = ?", (reference.removeprefix("vault:"),)).fetchone()
    if row != ("local-ssh-server-password",):
        raise StepError("The migrated SSH password is missing from its Vault namespace")
    with closing(sqlite3.connect((profile / "taomni.db").as_uri() + "?mode=ro", uri=True)) as db:
        legacy = dict(db.execute("SELECT server_type, config_json FROM server_configs"))
    if legacy != signed["legacy_rows"]:
        raise StepError("Local servers changed the previous version's database rows")
    journal = profile / "migration/journal.json"
    ordinary(journal)
    entries = [entry for entry in json.loads(journal.read_bytes())["entries"] if entry["item"] == "server-configs"]
    if (len(entries) != 1 or entries[0]["state"] != "committed"
            or entries[0]["target"].replace("\\", "/") != "plugins/servers/data/config.json"
            or entries[0]["source_fingerprint"] != record.get("legacySource")):
        raise StepError("Local servers lacks its committed configuration receipt")
    evidence = {
        "sourceSha": receipt["sourceSha"], "platform": receipt["platform"], "phase": phase,
        "hostSha256": digest, "packageSha256": receipt["sha256"], "writerLease": lease, "http": observation,
        "settingsSha256": hashlib.sha256(raw).hexdigest(),
    }
    if phase == "backup":
        evidence["backup"] = observe_backup(ctx, profile, raw)
    (ctx.case_dir / f"signed-servers-{phase}.json").write_text(
        json.dumps(evidence, indent=2) + "\n", encoding="utf-8",
    )
    return observation


def observe_backup(ctx, profile, settings):
    job_id, job = wait_manual_job(ctx, profile, set())
    path = Path(job["localPath"])
    ordinary(path)
    if not path.is_relative_to(profile):
        raise StepError("Local servers backup escaped the native QA profile")
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        datasets = [item for item in manifest["pluginDatasets"] if item["slug"] == "servers"]
        if (len(datasets) != 1 or not datasets[0]["requiresVault"]
                or {item["path"] for item in datasets[0]["files"]} != {"config.json", "host_ed25519"}):
            raise StepError("Local servers backup lacks the settings, SSH identity or Vault dependency")
        if archive.read("plugins/servers/data/config.json") != settings or "databases/vault.db" not in archive.namelist():
            raise StepError("Local servers backup does not match the live settings and Vault")
        with tempfile.TemporaryDirectory(dir=ctx.case_dir) as work:
            database = Path(work).resolve() / "taomni.db"
            database.write_bytes(archive.read("databases/taomni.db"))
            with closing(sqlite3.connect(database.as_uri() + "?mode=ro", uri=True)) as conn:
                rows = {row[0] for row in conn.execute("SELECT server_type FROM server_configs")}
        if rows != {"rdp", "vnc"}:
            raise StepError("The backup did not keep RDP and VNC separate from the migrated Local servers settings")
    return {"job": job_id, "dataset": datasets[0]}
