"""Independent ZIP/SQLite oracle for disabled and retained native module data.

Only seed creates fixed business input under the run-owned inactive hello data
subtree. Backup, lifecycle and inspection always use the real Settings UI.
"""
from __future__ import annotations
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid
import zipfile

from .fixtures.backup_journal import read_journal
from .fixtures.module_backup_data import state as fixture_state
from .deadline import budget_time as time
from .module_retained_observation import ordinary
from .module_signed_observation import invoke
from .steps import StepError

DATABASE = "qa-snapshot.opaque"
BLOB = "qa-snapshot.txt"
PAYLOAD = b"module backup input\n\x00original opaque bytes\n"
MARKER = "committed module WAL"
PHASES = {"seed", "disabled-archive", "retained-archive", "unchanged"}


def validate(args):
    if not isinstance(args, dict) or set(args) != {"phase"} or args.get("phase") not in PHASES:
        raise StepError("module_backup_probe requires one registered phase")
    return args["phase"]


def wait_manual_job(ctx, profile: Path, seen: set[str]):
    """Wait for a distinct UI-started job; an older success never satisfies it."""
    expires = time.monotonic() + 90
    while time.monotonic() < expires:
        job_id = ctx.session.execute('return document.querySelector(\'[data-testid="backup-manual-result"][data-target-id="local"]\')?.getAttribute("data-job-id");')
        if job_id is not None:
            try:
                canonical = isinstance(job_id, str) and str(uuid.UUID(job_id)) == job_id
            except ValueError:
                canonical = False
            if not canonical:
                raise StepError("Current manual backup has no canonical job ID")
            if job_id not in seen:
                try:
                    job = read_journal(profile / "backup-control/jobs" / (job_id + ".json"))
                except FileNotFoundError:
                    job = None
                if job is not None:
                    if job.get("id") != job_id:
                        raise StepError("Manual backup journal has a different job identity")
                    if job.get("phase") in {"failed", "cancelled"}:
                        raise StepError(f"The selected manual backup job {job_id} {job['phase']}")
                    if job.get("phase") == "completed":
                        return job_id, job
        time.sleep(.1)
    raise StepError("A distinct completed manual backup job did not appear")


def check_archive(path: Path, work: Path, generation: str):
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        datasets = manifest.get("pluginDatasets", [])
        if manifest.get("formatVersion") != 2 or len(datasets) != 1:
            raise StepError("Native backup did not publish one modular v2 dataset")
        data = datasets[0]
        expected = {"slug": "hello-plugin", "dataSchemaVersion": 1, "requiresVault": False,
                    "profileGeneration": generation,
                    "files": [{"path": DATABASE, "kind": "sqlite"}, {"path": BLOB, "kind": "file"}]}
        if set(data) != set(expected) | {"job"} or {key: data.get(key) for key in expected} != expected:
            raise StepError(f"Native module dataset differs from actual input: {data!r}")
        if str(uuid.UUID(data.get("job", ""))) != data["job"]:
            raise StepError("Module snapshot job is not a canonical UUID")
        entries = {entry["path"]: entry for entry in manifest["files"]}
        if set(archive.namelist()) != set(entries) | {"manifest.json"}:
            raise StepError("Archive payload differs from the recorded inventory")
        plugin_entries = {name for name in entries if name.startswith("plugins/")}
        prefix = "plugins/hello-plugin/data/"
        if plugin_entries != {prefix + DATABASE, prefix + BLOB}:
            raise StepError("Module archive contains extra files, code, pointers or SQLite sidecars")
        if "databases/vault.db" not in entries:
            raise StepError("Default module data range lost its Vault dependency")
        for name, entry in entries.items():
            digest, size = hashlib.sha256(), 0
            with archive.open(name) as stream:
                for chunk in iter(lambda: stream.read(65536), b""):
                    digest.update(chunk)
                    size += len(chunk)
            if digest.hexdigest() != entry["sha256"] or size != entry["sizeBytes"]:
                raise StepError("Native archive digest/size differs from actual bytes")
        if archive.read(prefix + BLOB) != PAYLOAD:
            raise StepError("Module backup changed opaque business bytes")
        # Native case directories are relative to the runner workspace; SQLite
        # file URIs require an absolute path on every target platform.
        snapshot = work.resolve(strict=True) / (path.stem + "-module.sqlite")
        snapshot.write_bytes(archive.read(prefix + DATABASE))
    with closing(sqlite3.connect(f"{snapshot.as_uri()}?mode=ro", uri=True)) as database:
        if database.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise StepError("Module SQLite snapshot failed integrity check")
        if database.execute("SELECT value FROM qa_snapshot_marker").fetchall() != [(MARKER,)]:
            raise StepError("Module snapshot lost committed WAL data")
    return {"formatVersion": 2, "dataset": data, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def run(ctx, args):
    phase = validate(args)
    source = fixture_state(ctx)
    fixture = json.loads((Path(ctx.case_dir) / "official-module-fixture.json").read_text(encoding="utf-8"))
    root = Path(fixture["pluginRoot"])
    if root.resolve() != root or not root.is_relative_to(Path(ctx.case_dir).resolve().parent):
        raise StepError("Module backup observation escaped the run-owned profile")
    owner = root / "hello-plugin"
    data = owner / "data"
    ordinary(owner, directory=True)
    observation = {"phase": phase, "passed": False}
    try:
        records = invoke(ctx.session, "plugin_list").get("value", [])
        matching = [record for record in records if record.get("manifest", {}).get("slug") == "hello-plugin"]
        expected = {"seed": "installed", "disabled-archive": "disabled", "retained-archive": "uninstalled"}.get(phase)
        if len(matching) != 1 or expected and matching[0].get("state") != expected:
            raise StepError("Native registry state differs from the module backup scenario")
        if phase == "seed":
            if source.connection is not None:
                raise StepError("Module backup input was already seeded")
            data.mkdir(exist_ok=True)
            ordinary(data, directory=True)
            with (data / BLOB).open("xb") as output:
                output.write(PAYLOAD)
            if (data / DATABASE).exists():
                raise StepError("Module SQLite input already exists")
            connection = sqlite3.connect(data / DATABASE)
            source.connection = connection
            connection.executescript("PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE qa_snapshot_marker(value TEXT);")
            connection.execute("INSERT INTO qa_snapshot_marker VALUES (?)", (MARKER,))
            connection.commit()
            before = {name: hashlib.sha256((data / name).read_bytes()).hexdigest() for name in [DATABASE, DATABASE + "-wal", BLOB]}
            (Path(ctx.case_dir) / "module-backup-source.json").write_text(json.dumps(before), encoding="utf-8")
            observation["fixture"] = before
        else:
            for name in ["restore_intent.json", "restore_journal.json", ".pending_restore"]:
                if (root.parent / name).exists():
                    raise StepError("Archive inspection/cancellation unexpectedly staged a restore")
            before = json.loads((Path(ctx.case_dir) / "module-backup-source.json").read_text(encoding="utf-8"))
            for name, digest in before.items():
                ordinary(data / name)
                if hashlib.sha256((data / name).read_bytes()).hexdigest() != digest:
                    raise StepError("Native snapshot mutated the source database, WAL or opaque data")
            if phase.endswith("-archive"):
                seen = source.seen_jobs
                job_id, job = wait_manual_job(ctx, root.parent, seen)
                path = Path(job.get("localPath") or "")
                ordinary(path)
                if not path.is_relative_to(root.parent):
                    raise StepError("Module backup archive escaped the isolated profile")
                generation = json.loads((root.parent / ".profile-state.json").read_text(encoding="utf-8"))["generation"]
                observation["archive"] = check_archive(path, Path(ctx.case_dir), generation)
                seen.add(job_id)
        observation["passed"] = True
        return "module backup " + phase + " verified"
    finally:
        with (Path(ctx.case_dir) / "module-backup-observations.jsonl").open("a", encoding="utf-8") as stream:
            stream.write(json.dumps(observation) + "\n")
