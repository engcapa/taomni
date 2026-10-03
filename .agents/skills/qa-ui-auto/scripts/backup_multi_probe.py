#!/usr/bin/env python3
"""Linux native backup contention probe using two verified QA app processes.

Run on X11/Xvfb with the same QA config as TC-BACKUP-001. The two instances
share only this probe's isolated profile; all owned processes are cleaned up.
"""

from __future__ import annotations

import argparse
from contextlib import suppress
import hashlib
import json
import os
from pathlib import Path
import platform
import signal
import sqlite3
import subprocess
import time
from types import SimpleNamespace
import zipfile

import yaml

from qa_ui_auto.fixtures.backup_policy import isolated_data_root
from qa_ui_auto.provenance import source_identity
from tauri_webdriver import NativeHarness, WebDriverError


def wait_until(check, message: str, timeout: float = 30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError(message)


def has_lock_handle(pid: int, lock_path: Path) -> bool:
    for fd in Path(f"/proc/{pid}/fd").glob("*"):
        with suppress(FileNotFoundError, PermissionError):
            if fd.resolve() == lock_path:
                return True
    return False


def matching_app_pids(binary: Path) -> set[int]:
    result = set()
    for process in Path("/proc").iterdir():
        if process.name.isdigit():
            with suppress(FileNotFoundError, PermissionError):
                if (process / "exe").resolve() == binary:
                    result.add(int(process.name))
    return result


def run(cfg: dict, report: Path) -> None:
    import fcntl

    source = source_identity(Path.cwd())
    probe_hash = hashlib.sha256(Path(__file__).read_bytes()).hexdigest()
    started = time.time()
    assertions = []
    cfg["webdriver"].update({"port": 4494, "native_port": 4495})
    with NativeHarness(cfg, report) as harness:
        data = isolated_data_root(SimpleNamespace(cfg=cfg, report_root=report))
        policy_path = data / "backup_policy.json"
        lock_path = data / ".backup-operation.lock"
        backup_dir = data / "backups"
        policy = {"autoBackupEnabled": True, "frequency": "daily", "maxRetainedCopies": 10,
                  "defaultScope": "core", "customBackupDir": None, "lastBackupAt": None}
        policy_path.write_text(json.dumps(policy), encoding="utf-8")
        binary = harness.application.resolve()
        baseline = matching_app_pids(binary)
        primary_pid = None
        paused = False
        peer = None
        session = None
        with lock_path.open("a+b") as lock, (report / "peer.log").open("w") as log:
            fcntl.flock(lock, fcntl.LOCK_EX)
            try:
                peer = subprocess.Popen([str(binary)], env=dict(os.environ), stdout=log, stderr=log)
                wait_until(lambda: has_lock_handle(peer.pid, lock_path), "peer never entered backup lock")
                session = harness.create_session()
                session.find('[data-testid="welcome-panel"]', timeout=60)
                candidates = matching_app_pids(binary) - baseline - {peer.pid}
                assert len(candidates) == 1, f"expected one primary process, got {candidates}"
                primary_pid = candidates.pop()
                wait_until(lambda: has_lock_handle(primary_pid, lock_path), "primary never entered backup lock")
                assert peer.poll() is None
                assert not list(backup_dir.glob("*.taobak"))
                assert json.loads(policy_path.read_text())["lastBackupAt"] is None
                assertions.append("both real instance schedulers wait for the shared OS lock")
                fcntl.flock(lock, fcntl.LOCK_UN)

                def archives_at_least(count):
                    archives = list(backup_dir.glob("*.taobak"))
                    current = json.loads(policy_path.read_text())
                    success = current.get("lastBackupAt")
                    return archives if len(archives) >= count and success is not None and success >= int(started * 1000) else None

                wait_until(lambda: archives_at_least(1), "contending instances did not complete a backup")
                # Both contenders must have left their locked operation. The
                # loser rereads lastBackupAt, so there is exactly one archive.
                wait_until(lambda: not has_lock_handle(peer.pid, lock_path)
                           and not has_lock_handle(primary_pid, lock_path), "contenders did not release lock")
                assert len(list(backup_dir.glob("*.taobak"))) == 1
                assert peer.poll() is None
                os.kill(primary_pid, 0)
                assertions.append("simultaneous due checks generate exactly one archive")

                session.click('[data-testid="ribbon-settings"]')
                session.find('[data-testid="settings-panel"]', timeout=30)
                session.click('[data-testid="settings-group-toggle-backup"]')
                session.find('[data-testid="backup-history-row"]', timeout=30)
                assert session.count('[data-testid="backup-history-row"]') == 1

                # Only the peer can produce this backup. The primary backend
                # is paused; after resume no local completion event can help
                # its open panel, so the shared-history refresh owns the result.
                os.kill(primary_pid, signal.SIGSTOP)
                paused = True
                current = json.loads(policy_path.read_text())
                current["lastBackupAt"] = int(time.time() * 1000) - 2 * 24 * 60 * 60 * 1000
                pending = policy_path.with_suffix(".probe.tmp")
                pending.write_text(json.dumps(current), encoding="utf-8")
                pending.replace(policy_path)
                wait_until(lambda: archives_at_least(2), "peer did not back up the expired policy", timeout=90)
                assert len(list(backup_dir.glob("*.taobak"))) == 2
                assert peer.poll() is None
                os.kill(primary_pid, signal.SIGCONT)
                paused = False
                wait_until(lambda: session.count('[data-testid="backup-history-row"]') == 2,
                           "primary Settings did not observe a foreign backup", timeout=30)
                success = json.loads(policy_path.read_text())["lastBackupAt"]
                wait_until(lambda: session.execute(
                    "return document.querySelector('[data-testid=\"backup-last-success\"]').textContent === "
                    f"new Date({success}).toLocaleString();"
                ), "primary Settings did not observe the peer success timestamp", timeout=30)
                assertions.append("open Settings observes peer history and success time without a local completion event")

                # Manual Backup Now must wait for the same OS lock, leaving
                # the two existing archives intact until ownership is released.
                fcntl.flock(lock, fcntl.LOCK_EX)
                session.click('[data-testid="backup-create-now"]')
                wait_until(lambda: has_lock_handle(primary_pid, lock_path), "manual backup bypassed shared lock")
                assert len(list(backup_dir.glob("*.taobak"))) == 2
                fcntl.flock(lock, fcntl.LOCK_UN)
                wait_until(lambda: archives_at_least(3), "queued manual backup did not finish")
                session.find('[data-testid="backup-action-success"]', timeout=30)
                assert len(list(backup_dir.glob("*.taobak"))) == 3
                assertions.append("manual backup queues behind the shared lock and completes after release")
                latest = 0
                required = {"databases/taomni.db", "databases/notes.db", "databases/vault.db"}
                for path in backup_dir.glob("*.taobak"):
                    with zipfile.ZipFile(path) as archive:
                        manifest = json.loads(archive.read("manifest.json"))
                        assert required <= {entry["path"] for entry in manifest["files"]}
                        latest = max(latest, manifest["createdAt"])
                        for entry in manifest["files"]:
                            raw = archive.read(entry["path"])
                            assert hashlib.sha256(raw).hexdigest() == entry["sha256"]
                            if entry["path"] in required:
                                conn = sqlite3.connect(":memory:")
                                try:
                                    conn.deserialize(raw)
                                    assert conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
                                finally:
                                    conn.close()
                assert json.loads(policy_path.read_text())["lastBackupAt"] == latest
                assertions.append("all three archives pass checksums and SQLite integrity checks; policy keeps latest success")
                session.screenshot(report / "multi-instance-settings.png")
                assert source == source_identity(Path.cwd()), "source changed during native probe"
                assert probe_hash == hashlib.sha256(Path(__file__).read_bytes()).hexdigest(), "probe changed during execution"
                result = {"status": "passed", "platform": "Linux", "source_sha256": source,
                          "probe_sha256": probe_hash,
                          "primary_pid": primary_pid, "peer_pid": peer.pid, "shared_data_root": str(data),
                          "duration_sec": time.time() - started, "assertions": assertions}
                (report / "multi-instance-result.json").write_text(json.dumps(result, indent=2) + "\n")
                print(json.dumps(result), flush=True)
            finally:
                fcntl.flock(lock, fcntl.LOCK_UN)
                if paused and primary_pid is not None:
                    with suppress(ProcessLookupError):
                        os.kill(primary_pid, signal.SIGCONT)
                if session is not None:
                    with suppress(WebDriverError):
                        session.close()
                if peer is not None and peer.poll() is None:
                    peer.terminate()
                    try:
                        peer.wait(timeout=10)
                    except subprocess.TimeoutExpired:
                        peer.kill()
                        peer.wait(timeout=10)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--config", required=True)
    parser.add_argument("--report-dir", required=True)
    args = parser.parse_args()
    if platform.system() != "Linux":
        parser.error("this probe uses Linux /proc and flock; other native hosts remain unverified")
    report = Path(args.report_dir).resolve()
    if report.exists():
        parser.error("report-dir must be a fresh isolated directory")
    cfg = yaml.safe_load(Path(args.config).read_text())
    run(cfg, report)


if __name__ == "__main__":
    main()
