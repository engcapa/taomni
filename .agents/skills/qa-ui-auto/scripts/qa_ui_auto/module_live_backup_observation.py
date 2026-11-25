"""Fixed real-host business input and independent live-backup observations.

The YAML cannot choose paths, IPC methods, slugs or contents. Installation,
lifecycle, backup and restart use the real UI; only this sample plugin's
declared write/read commands provide business input. No app state is seeded.
"""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3
import uuid
import zipfile

from .module_backup_observation import wait_manual_job
from .module_profile_observation import writer_lease
from .module_retained_observation import ordinary
from .module_signed_observation import invoke
from .steps import StepError

VALUES = ["live snapshot committed value one", "live snapshot resumed writer value two"]
PHASES = {"write-first", "first-archive", "write-second", "second-archive", "after-restart"}


def validate(args):
    if not isinstance(args, dict) or set(args) != {"phase"} or args.get("phase") not in PHASES:
        raise StepError("module_live_backup_probe requires one registered phase")
    return args["phase"]


def check_archive(path, work, generation, values):
    payload = "plugins/hello-plugin/data/hello.sqlite"
    with zipfile.ZipFile(path) as archive:
        manifest = json.loads(archive.read("manifest.json"))
        datasets = manifest.get("pluginDatasets", [])
        if manifest.get("formatVersion") != 2 or len(datasets) != 1:
            raise StepError("Live snapshot did not produce exactly one v2 module dataset")
        data = datasets[0]
        expected = {"slug": "hello-plugin", "dataSchemaVersion": 1, "requiresVault": False,
                    "profileGeneration": generation, "files": [{"path": "hello.sqlite", "kind": "sqlite"}]}
        if set(data) != set(expected) | {"job"} or {key: data.get(key) for key in expected} != expected:
            raise StepError("Live snapshot dataset has the wrong owner, generation or file contract")
        if str(uuid.UUID(data["job"])) != data["job"]:
            raise StepError("Live snapshot has no canonical job identity")
        entries = {entry["path"]: entry for entry in manifest["files"]}
        if len(entries) != len(manifest["files"]) or set(archive.namelist()) != set(entries) | {"manifest.json"}:
            raise StepError("Live archive inventory is inconsistent")
        if {name for name in entries if name.startswith("plugins/")} != {payload}:
            raise StepError("Live archive includes sidecars or unexpected module payloads")
        if "databases/vault.db" not in entries:
            raise StepError("Module range lost its required Vault selection")
        for name, metadata in entries.items():
            digest, size = hashlib.sha256(), 0
            with archive.open(name) as stream:
                for chunk in iter(lambda: stream.read(65536), b""):
                    digest.update(chunk)
                    size += len(chunk)
            if digest.hexdigest() != metadata["sha256"] or size != metadata["sizeBytes"]:
                raise StepError("Live archive hash/size differs from its bytes")
        snapshot = Path(work).resolve(strict=True) / (path.stem + "-live.sqlite")
        snapshot.write_bytes(archive.read(payload))
    with closing(sqlite3.connect(snapshot.as_uri() + "?mode=ro", uri=True)) as db:
        if db.execute("PRAGMA quick_check").fetchone() != ("ok",):
            raise StepError("Live SQLite snapshot failed integrity check")
        if db.execute("SELECT value FROM entries ORDER BY id").fetchall() != [(value,) for value in values]:
            raise StepError("Live snapshot lost committed WAL rows or writer did not resume")
    return {"dataset": data, "sha256": hashlib.sha256(path.read_bytes()).hexdigest()}


def source_hashes(data):
    result = {}
    for name in ["hello.sqlite", "hello.sqlite-wal"]:
        path = data / name
        ordinary(path)
        if not path.stat().st_size:
            raise StepError("Real host did not retain committed SQLite WAL input")
        result[name] = hashlib.sha256(path.read_bytes()).hexdigest()
    return result


def run(ctx, args):
    phase = validate(args)
    work = Path(ctx.case_dir).resolve(strict=True)
    fixture = json.loads((work / "official-module-fixture.json").read_text(encoding="utf-8"))
    root = Path(fixture["pluginRoot"])
    if root.resolve(strict=True) != root or not root.is_relative_to(work.parent):
        raise StepError("Live snapshot observation escaped the isolated profile")
    profile, data = root.parent, root / "hello-plugin/data"
    generation = json.loads((profile / ".profile-state.json").read_text())["generation"]
    state_path = work / "module-live-backup-state.json"
    state = json.loads(state_path.read_text()) if state_path.exists() else {"jobs": [], "snapshotJobs": [], "generation": generation}
    observation = {"phase": phase, "passed": False}
    try:
        if state["generation"] != generation:
            raise StepError("Ordinary backup/restart changed profile generation")
        records = invoke(ctx.session, "plugin_list").get("value", [])
        record = next((row for row in records if row.get("manifest", {}).get("slug") == "hello-plugin"), None)
        if record is None or record.get("state") != "enabled" or record.get("reason") is not None:
            raise StepError("Live snapshot requires the real enabled signed host")
        if phase.startswith("write-"):
            expected_count = 1 if phase == "write-first" else 2
            if len(state["jobs"]) != expected_count - 1:
                raise StepError("Live business input was requested out of sequence")
            reply = invoke(ctx.session, "plugin_invoke", {"slug": "hello-plugin", "command": "hello/write",
                           "payload": {"value": VALUES[expected_count - 1]}})
            if reply.get("value") != {"values": VALUES[:expected_count]} or "error" in reply:
                raise StepError("The actual host did not commit the expected business write")
            state["source"] = source_hashes(data)
        else:
            expected_count = 1 if phase == "first-archive" else 2
            reply = invoke(ctx.session, "plugin_invoke", {"slug": "hello-plugin", "command": "hello/read"})
            if reply.get("value") != {"values": VALUES[:expected_count]} or "error" in reply:
                raise StepError("Host business data did not survive snapshot/restart")
            if phase.endswith("-archive"):
                if source_hashes(data) != state["source"]:
                    raise StepError("Live backup mutated its source main/WAL bytes")
                job_id, job = wait_manual_job(ctx, profile, set(state["jobs"]))
                path = Path(job.get("localPath") or "")
                ordinary(path)
                if not path.is_relative_to(profile):
                    raise StepError("Live archive escaped the run-owned profile")
                result = check_archive(path, work, generation, VALUES[:expected_count])
                snapshot_job = result["dataset"]["job"]
                if snapshot_job in state["snapshotJobs"]:
                    raise StepError("A previous live snapshot was reused by a new manual job")
                state["jobs"].append(job_id)
                state["snapshotJobs"].append(snapshot_job)
                observation["archive"] = result
        observation["writerLease"] = writer_lease(root, enabled=True)
        state_path.write_text(json.dumps(state, indent=2), encoding="utf-8")
        observation["passed"] = True
        return "live module snapshot " + phase + " verified"
    finally:
        with (work / "module-live-backup-observations.jsonl").open("a", encoding="utf-8") as output:
            output.write(json.dumps(observation) + "\n")
