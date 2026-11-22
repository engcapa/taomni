"""Install and start the pinned legacy release before the candidate opens its profile."""
from contextlib import closing
import hashlib
import json
from pathlib import Path
import sqlite3

from .backup_policy import isolated_data_root
from .module_upgrade import input_sessions
from ..legacy_install import install
from ..legacy_process import initialize_profile
from ..legacy_release import FIRST_UPGRADE_VERSION, RELEASE_VERSION


def retained_manifest(data):
    # Only the independent oracle reads these files. The candidate must leave
    # even WAL/SHM bytes untouched; no old chat data is copied into a plugin.
    paths = sorted(path for path in data.iterdir() if path.name.startswith(("lanchat.sqlite", "lanchat.db")))
    if not any(path.name == "lanchat.sqlite" for path in paths):
        raise RuntimeError("The real old app did not create its historical LanChat store")
    if any(path.is_symlink() or not path.is_file() for path in paths):
        raise RuntimeError("Legacy chat observation refuses linked/non-file inputs")
    return {path.name: {"sha256": hashlib.sha256(path.read_bytes()).hexdigest(),
                        "bytes": path.stat().st_size} for path in paths}


def session_rows(data):
    path = data / "taomni.db"
    if path.is_symlink() or not path.is_file():
        raise RuntimeError("Legacy app did not create a regular taomni.db")
    with closing(sqlite3.connect(path.as_uri() + "?mode=ro", uri=True)) as db:
        db.row_factory = sqlite3.Row
        if db.execute("PRAGMA quick_check").fetchall()[0][0] != "ok":
            raise RuntimeError("The old application's session database failed integrity checks")
        tables = {row[0] for row in db.execute("SELECT name FROM sqlite_master WHERE type='table'")}
        if not {"sessions", "server_configs", "rdp_certificate_pins"}.issubset(tables):
            raise RuntimeError("The old app did not initialize its actual legacy tables")
        return [dict(row) for row in db.execute("SELECT * FROM sessions ORDER BY id")]


def insert_business_rows(data, rows):
    # No schema construction here: the release binary must create all tables.
    if session_rows(data):
        raise RuntimeError("Disposable old-version profile unexpectedly contains sessions")
    with closing(sqlite3.connect(data / "taomni.db")) as db, db:
        columns = list(rows[0])
        db.executemany("INSERT INTO sessions (" + ",".join(columns) + ") VALUES (" +
                       ",".join("?" for _ in columns) + ")", [tuple(
                           json.dumps(row[key]) if key == "auth_method" else row[key] for key in columns)
                           for row in rows])


def setup(ctx):
    if ctx.case_id not in {"TC-MODULES-027", "TC-MODULES-040"}:
        raise RuntimeError("Real legacy installation requires its fixed registered native case")
    data = isolated_data_root(ctx)
    if any(data.iterdir()):
        raise RuntimeError("Real legacy upgrade requires an empty run-owned profile")
    work = Path(ctx.report_root).resolve() / "_workdirs" / ctx.case_id / "legacy-install"
    if work.resolve() != work:
        raise RuntimeError("Legacy installation refuses a linked work directory")
    version = FIRST_UPGRADE_VERSION if ctx.case_id == "TC-MODULES-040" else RELEASE_VERSION
    executable, evidence = install(ctx.case_dir, work, version=version, shared_msi_directory=work.parents[1] / "legacy-msi")
    initialize_profile(executable, data, work, evidence, "old-first-start")
    rows = input_sessions(ctx.case_id == "TC-MODULES-027")
    insert_business_rows(data, rows)
    before = session_rows(data)
    initialize_profile(executable, data, work, evidence, "old-reopen")
    if session_rows(data) != before:
        raise RuntimeError("The real old app changed the seeded business records on reopening")
    # The second filename is an inert retained-file boundary in addition to
    # the actual old database. The existing 025 case keeps both invalid files.
    with (data / "lanchat.db").open("xb") as stream:
        stream.write(b"additional historical filename, deliberately not SQLite\n")
    retained = retained_manifest(data)
    ctx.module_upgrade = {"root": data, "sessions": rows, "journal": None,
                          "retained": retained, "full_sessions": before}
    (evidence / "profile-input.json").write_text(json.dumps({
        "scope": f"Installed {version} initialization and reopen with synthetic saved sessions",
        "dataRoot": str(data), "sessionRows": before, "sessionIds": [row["id"] for row in before],
        "sessionTypes": [row["session_type"] for row in before], "retained": retained,
        "notEstablished": ["installer replacement by candidate", "MFA secret export", "trusted staging/activation", "rollback"],
    }, indent=2) + "\n", encoding="utf-8")
